/**
 * PR 2.1 Task 7: the opt-in, in-memory voice transcript buffer (servers/gateway/voice/transcript-buffer.js), its
 * setting (voice.transcript_buffer, normalizeVoiceSettings) and the turn's recording (turn.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTranscriptBuffer, transcriptBufferOn, reloadTranscriptSetting, TRANSCRIPT_BUFFER_MAX, TRANSCRIPT_BUFFER_TTL_MS,
} from "../servers/gateway/voice/transcript-buffer.js";
import { normalizeVoiceSettings, voiceBotDefinition } from "../servers/shared/voice-bot.js";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const VOICE = { bot_id: "crow.voice", kind: "voice", display_name: "Crow", fast_voice_model: "crow-voice/qwen3.5-4b" };
const ON = { ...VOICE, voice: { transcript_buffer: true } };
const row = (def) => ({ bot_id: def.bot_id, enabled: 1, definition: JSON.stringify(def) });

function fakeClock(t = 1_000_000) { return { now: () => t, advance: (ms) => { t += ms; } }; }

test("the setting: off by default, survives normalizeVoiceSettings only as an explicit true", () => {
  const d = voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b" });
  assert.equal(d.voice.transcript_buffer, false, "the default def carries it, off");
  assert.equal(normalizeVoiceSettings(d).transcript_buffer, false);
  assert.equal(normalizeVoiceSettings({ kind: "voice", voice: { transcript_buffer: true } }).transcript_buffer, true);
  for (const v of ["true", 1, "on", null, undefined, {}]) assert.equal(normalizeVoiceSettings({ kind: "voice", voice: { transcript_buffer: v } }).transcript_buffer, false, String(v));
  assert.equal(transcriptBufferOn(ON), true);
  assert.equal(transcriptBufferOn({ ...ON, kind: "pi" }), false, "only the voice bot's def turns it on");
  assert.equal(transcriptBufferOn(VOICE), false);
  assert.equal(transcriptBufferOn(null), false);
});

test("the buffer: per device, capped at 20, entries expire at 15 minutes", () => {
  const c = fakeClock();
  const b = createTranscriptBuffer({ now: c.now });
  assert.equal(TRANSCRIPT_BUFFER_MAX, 20);
  assert.equal(TRANSCRIPT_BUFFER_TTL_MS, 15 * 60_000);
  for (let i = 0; i < 25; i++) { b.record("kiosk-a", { transcript: `turn ${i}`, spoken: `reply ${i}`, tools_called: ["x"], codes: ["x:ok"] }); c.advance(1000); }
  b.record("phone-b", { transcript: "other" });
  const a = b.list("kiosk-a");
  assert.equal(a.length, 20);
  assert.equal(a[0].transcript, "turn 5");
  assert.equal(a.at(-1).transcript, "turn 24");
  assert.deepEqual(Object.keys(a[0]).sort(), ["at", "codes", "spoken", "stt_rewrite", "tools_called", "transcript"]);
  assert.equal(a[0].stt_rewrite, null);
  assert.equal(b.list("phone-b").length, 1);
  // The clock is 1 s past the newest kiosk entry: just inside 15 minutes it is still there; at 15 minutes, gone.
  c.advance(TRANSCRIPT_BUFFER_TTL_MS - 2000);
  assert.deepEqual(b.list("kiosk-a").map((e) => e.transcript), ["turn 24"]);
  c.advance(1000);
  assert.deepEqual(b.list("kiosk-a"), []);
  assert.equal(b.size(), 1, "phone-b's entry is 1 s younger");
  c.advance(1000);
  assert.equal(b.size(), 0);
  b.record("kiosk-a", { transcript: "x" });
  b.clear();
  assert.equal(b.size(), 0);
});

test("a defs-changed reload clears the whole buffer unless the voice def has it on", async () => {
  const b = createTranscriptBuffer();
  b.record("kiosk-a", { transcript: "a" });
  b.record("phone-b", { transcript: "b" });
  await reloadTranscriptSetting(b, async () => ON);
  assert.equal(b.size(), 2, "still on: kept");
  await reloadTranscriptSetting(b, async () => { throw new Error("db"); });
  assert.equal(b.size(), 0, "a read that fails counts as off");
  b.record("kiosk-a", { transcript: "a" });
  await reloadTranscriptSetting(b, async () => VOICE);
  assert.equal(b.size(), 0, "off: cleared");
  let reads = 0;
  await reloadTranscriptSetting(b, async () => { reads++; return VOICE; });
  assert.equal(reads, 0, "an empty buffer reads nothing");
});

/** The shared harness answering as the voice bot, with a transcript buffer on its own fake clock. */
function voiceHarness(def) {
  const h = harness({ bot: VOICE });
  const rows = { "crow.voice": def };
  let gen = 0;
  h.rows = rows;
  h.bump = () => { gen++; };
  h.deps.voiceBotId = "crow.voice";
  h.deps.botDefsGeneration = () => gen;
  h.deps.loadBotRow = async (db, id) => (rows[id] ? row(rows[id]) : null);
  h.buffer = createTranscriptBuffer({ now: h.c.now });
  h.deps.transcripts = h.buffer;
  return h;
}
const turn = (h, opts = {}) => h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "What is the capital of Portugal?", sink: h.sink, ...opts });

test("off by default: a voice-bot turn records nothing", async () => {
  const h = voiceHarness(VOICE);
  await turn(h);
  assert.equal(h.buffer.size(), 0);
  assert.ok(h.runner.transcripts === h.buffer, "the runner hands its buffer to the admin route (deps.voice.transcripts)");
});

test("on: the turn records the final transcript and the text that was heard", async () => {
  const h = voiceHarness(ON);
  await turn(h);
  const [e] = h.buffer.list("kiosk-a");
  assert.equal(e.transcript, "What is the capital of Portugal?");
  assert.equal(e.spoken, h.calls.spoken.join(" "));
  assert.match(e.spoken, /Lisbon/);
  assert.deepEqual(e.tools_called, []);
  assert.equal(e.stt_rewrite, null);
  assert.equal(h.calls.logs.some((m) => /Portugal|Lisbon/.test(m)), false, "never logged");
});

test("on: a rewritten transcript keeps what was heard as stt_rewrite", async () => {
  const h = voiceHarness(ON);
  await turn(h, { transcript: "Had coffee Tuesday at 9", lang: "en", tz: "America/Chicago" });
  const [e] = h.buffer.list("kiosk-a");
  assert.ok(e, "recorded");
  assert.equal(e.stt_rewrite, "Had coffee Tuesday at 9");
  assert.match(e.transcript, /^add coffee/i);
});

test("turning it off clears the buffer on the next turn", async () => {
  const h = voiceHarness(ON);
  await turn(h);
  h.device = { ...h.device, id: "phone-b" };
  await turn(h);
  assert.equal(h.buffer.size(), 2);
  h.rows["crow.voice"] = VOICE;
  h.bump();
  await turn(h);
  assert.equal(h.buffer.size(), 0, "every device's entries are gone");
});

test("a turn whose voice bot is disabled or missing reads the setting as off", async () => {
  const h = voiceHarness(ON);
  await turn(h);
  assert.equal(h.buffer.size(), 1);
  delete h.rows["crow.voice"];
  h.bump();
  await turn(h);
  assert.equal(h.buffer.size(), 0);
});

// ── fix round 1: nothing outlives 15 minutes in the heap ──
test("a quiet device's entries leave memory at the TTL: the sweep (injected timer) drops them with no further access", () => {
  const c = fakeClock();
  const timers = [];
  const b = createTranscriptBuffer({ now: c.now, sweepMs: 60_000, setInterval: (fn, ms) => { const t = { fn, ms, unref() { t.unrefd = true; return t; }, cleared: false }; timers.push(t); return t; }, clearInterval: (t) => { t.cleared = true; } });
  assert.equal(timers.length, 0, "no timer before anything is recorded");
  b.record("kiosk-a", { transcript: "quiet display" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  assert.equal(timers[0].unrefd, true, "the sweep never keeps the process alive");
  assert.equal(b._rawCount(), 1);
  c.advance(TRANSCRIPT_BUFFER_TTL_MS);
  assert.equal(b._rawCount(), 1, "still held until something prunes it");
  timers[0].fn();
  assert.equal(b._rawCount(), 0, "the sweep emptied the map");
  assert.equal(b._deviceCount(), 0, "and dropped the empty device");
  assert.equal(timers[0].cleared, true, "an empty buffer stops its sweep");
});

test("record() prunes every device, not only the one recording", () => {
  const c = fakeClock();
  const b = createTranscriptBuffer({ now: c.now });
  b.record("kiosk-a", { transcript: "old" });
  c.advance(TRANSCRIPT_BUFFER_TTL_MS);
  b.record("phone-b", { transcript: "new" });
  assert.equal(b._rawCount(), 1);
  assert.equal(b._deviceCount(), 1);
});

test("a turn with noTranscript (the kiosk's turn check) is never recorded", async () => {
  const h = voiceHarness(ON);
  await turn(h, { noTranscript: true });
  assert.equal(h.buffer.size(), 0);
  await turn(h);
  assert.equal(h.buffer.size(), 1);
});
