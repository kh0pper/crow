/**
 * The one-week voice transcript log (servers/gateway/voice/transcript-log.js): opt-in (voice.transcript_log, off by
 * default), text only, on this instance's disk outside crow.db, expired at every write and by a daily sweep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTranscriptLog, transcriptLogOn, transcriptLogDir, sweepTranscriptLog, startTranscriptLogSweep,
  TRANSCRIPT_LOG_TTL_MS, TRANSCRIPT_LOG_DAYS, DAY_MAX_BYTES,
} from "../servers/gateway/voice/transcript-log.js";
import { normalizeVoiceSettings, voiceBotDefinition } from "../servers/shared/voice-bot.js";
import { SYNCED_TABLES } from "../servers/sharing/instance-sync.js";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const VOICE = { bot_id: "crow.voice", kind: "voice", display_name: "Crow", fast_voice_model: "crow-voice/qwen3.5-4b" };
const ON = { ...VOICE, voice: { transcript_log: true } };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-26T12:00:00Z");
const fresh = () => mkdtempSync(join(tmpdir(), "crow-vtlog-"));
const clock = (t = T0) => ({ now: () => t, advance: (ms) => { t += ms; } });

test("the setting: off by default, on only as an explicit true; the log lives under CROW_HOME, outside the database", () => {
  const d = voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b" });
  assert.equal(d.voice.transcript_log, false, "the default def carries it, off");
  assert.equal(normalizeVoiceSettings(d).transcript_log, false);
  assert.equal(normalizeVoiceSettings({ kind: "voice", voice: { transcript_log: true } }).transcript_log, true);
  for (const v of ["true", 1, "on", null, undefined, {}]) assert.equal(normalizeVoiceSettings({ kind: "voice", voice: { transcript_log: v } }).transcript_log, false, String(v));
  assert.equal(transcriptLogOn(ON), true);
  assert.equal(transcriptLogOn({ ...ON, kind: "pi" }), false, "only the voice bot's def turns it on");
  assert.equal(transcriptLogOn(VOICE), false);
  assert.equal(transcriptLogOn(null), false);
  assert.equal(transcriptLogDir({ CROW_HOME: "/srv/crow-home" }), "/srv/crow-home/voice-transcripts");
  assert.equal(TRANSCRIPT_LOG_DAYS, 7);
  assert.equal(TRANSCRIPT_LOG_TTL_MS, 7 * DAY);
  // Not a table, so instance sync cannot carry it; the backups copy crow.db only.
  assert.ok(!SYNCED_TABLES.some((t) => /transcript/i.test(t)));
  const src = readFileSync(new URL("../servers/gateway/voice/transcript-log.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "\.\.\/\.\.\/db\.js"|createDbClient|sqlite/i, "the log never touches the database");
  assert.doesNotMatch(src, /console\.|\blog\(/, "nothing in the module logs");
});

test("record: one JSON line a turn in the UTC day's file, text only (device, time, transcript, what was heard), 0700 directory and 0600 files", async () => {
  const dir = join(fresh(), "voice-transcripts");
  const c = clock();
  const log = createTranscriptLog({ dir, now: c.now });
  assert.equal(await log.record({ device: { id: "kiosk-a", name: "Kitchen" }, transcript: "add coffee Tuesday at 9", heard: "Had coffee Tuesday at 9" }), true);
  c.advance(1000);
  await log.record({ device: { id: "phone-b" }, transcript: "play K T P F", heard: "play K T P F" });
  assert.deepEqual(readdirSync(dir), ["2026-10-26.jsonl"]);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "2026-10-26.jsonl")).mode & 0o777, 0o600);
  const all = await log.list();
  assert.deepEqual(all, [
    { at: "2026-10-26T12:00:00.000Z", device_id: "kiosk-a", device_name: "Kitchen", transcript: "add coffee Tuesday at 9", heard: "Had coffee Tuesday at 9" },
    { at: "2026-10-26T12:00:01.000Z", device_id: "phone-b", device_name: null, transcript: "play K T P F", heard: null },
  ]);
  // Nothing without a device or words; fields are capped.
  assert.equal(await log.record({ device: {}, transcript: "x" }), false);
  assert.equal(await log.record({ device: { id: "kiosk-a" }, transcript: "" }), false);
  await log.record({ device: { id: "kiosk-a" }, transcript: "y".repeat(5000) });
  assert.equal((await log.list()).at(-1).transcript.length, 2000);
});

test("expiry at write time: whole days past the week are deleted and the boundary day keeps only its lines inside the week", async () => {
  const dir = fresh();
  const c = clock();
  const log = createTranscriptLog({ dir, now: c.now });
  await log.record({ device: { id: "d" }, transcript: "first" });        // 10-26 12:00
  c.advance(6 * 60 * 60 * 1000);
  await log.record({ device: { id: "d" }, transcript: "second" });       // 10-26 18:00
  c.advance(DAY);
  await log.record({ device: { id: "d" }, transcript: "third" });        // 10-27 18:00
  // A week after "first", plus a minute: "first" goes, "second" (6 h younger) stays.
  c.advance(7 * DAY - DAY - 6 * 60 * 60 * 1000 + 60_000);                // 11-02 12:01
  await log.record({ device: { id: "d" }, transcript: "fourth" });
  assert.deepEqual((await log.list()).map((e) => e.transcript), ["second", "third", "fourth"]);
  c.advance(DAY);                                                        // 11-03 12:01: second (10-26 18:00) expired, its file gone
  await log.record({ device: { id: "d" }, transcript: "fifth" });
  assert.deepEqual((await log.list()).map((e) => e.transcript), ["third", "fourth", "fifth"]);
  assert.ok(!readdirSync(dir).includes("2026-10-26.jsonl"));
  assert.ok(readdirSync(dir).every((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)), "no temporary file is left");
});

test("the hourly sweep empties a log nobody writes to; with the setting off it deletes the log; only day files are touched", async () => {
  const dir = fresh();
  const c = clock();
  const log = createTranscriptLog({ dir, now: c.now });
  await log.record({ device: { id: "d" }, transcript: "old" });
  writeFileSync(join(dir, "notes.txt"), "not ours");
  c.advance(8 * DAY);
  await sweepTranscriptLog(log, async () => ON);
  assert.deepEqual(await log.list(), []);
  assert.deepEqual(readdirSync(dir), ["notes.txt"]);
  c.advance(-8 * DAY);
  await log.record({ device: { id: "d" }, transcript: "today" });
  await sweepTranscriptLog(log, async () => VOICE);
  assert.deepEqual(await log.list(), [], "off: deleted");
  await log.record({ device: { id: "d" }, transcript: "today" });
  await sweepTranscriptLog(log, async () => { throw new Error("db"); });
  assert.equal((await log.list()).length, 1, "a read that fails only expires: a passing db error never deletes the week");
  c.advance(8 * DAY);
  await sweepTranscriptLog(log, async () => { throw new Error("db"); });
  assert.deepEqual(await log.list(), [], "and the expiry still runs");
  c.advance(-8 * DAY);
  // The timers: first run soon after boot, then hourly, never keeping the process alive.
  const timers = [];
  const fake = (kind) => (fn, ms) => { const t = { kind, fn, ms, unref() { t.unrefd = true; return t; } }; timers.push(t); return t; };
  startTranscriptLogSweep(log, async () => ON, { setTimeout: fake("timeout"), setInterval: fake("interval") });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].unrefd, true);
  timers[0].fn();
  assert.equal(timers[1].kind, "interval");
  assert.equal(timers[1].ms, 60 * 60 * 1000);
  assert.equal(timers[1].unrefd, true);
});

test("a day file is bounded: past DAY_MAX_BYTES further turns that day are not kept", async () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-26.jsonl"), `${JSON.stringify({ at: "2026-10-26T11:00:00.000Z", device_id: "d", transcript: "x" })}\n`.padEnd(DAY_MAX_BYTES - 10, " "));
  const log = createTranscriptLog({ dir, now: clock().now });
  assert.equal(await log.record({ device: { id: "d" }, transcript: "one more turn" }), false);
  assert.ok(statSync(join(dir, "2026-10-26.jsonl")).size <= DAY_MAX_BYTES);
});

test("review: leftovers, existing permissions, symlinks, torn lines and a clock that went back", async () => {
  const dir = fresh();
  const c = clock();
  const log = createTranscriptLog({ dir, now: c.now });
  // An existing directory and day file with loose modes are tightened.
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "2026-10-26.jsonl"), '{"at":"2026-10-26T11:00:00.000Z","device_id":"d","transcript":"torn');
  chmodSync(join(dir, "2026-10-26.jsonl"), 0o644);
  // A temporary file left by an interrupted rewrite, and a day file dated far ahead.
  writeFileSync(join(dir, "2026-10-19.jsonl.0123456789ab.tmp"), "old words");
  writeFileSync(join(dir, "2027-10-26.jsonl"), `${JSON.stringify({ at: "2027-10-26T11:00:00.000Z", device_id: "d", transcript: "future" })}\n`);
  assert.equal(await log.record({ device: { id: "d" }, transcript: "after the tear" }), true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "2026-10-26.jsonl")).mode & 0o777, 0o600);
  assert.deepEqual((await log.list()).map((e) => e.transcript), ["after the tear"], "the torn line is ended, never joined to the next");
  assert.deepEqual(readdirSync(dir).sort(), ["2026-10-26.jsonl"], "the leftover and the future file are gone");
  writeFileSync(join(dir, "2026-10-25.jsonl.0123456789ab.tmp"), "x");
  await log.clear();
  assert.deepEqual(readdirSync(dir), [], "clear removes leftovers too");
  // A day file that is a symlink is never written through.
  const target = join(fresh(), "elsewhere.txt");
  writeFileSync(target, "");
  symlinkSync(target, join(dir, "2026-10-26.jsonl"));
  assert.equal(await log.record({ device: { id: "d" }, transcript: "secret" }), false);
  assert.equal(readFileSync(target, "utf8"), "");
});

// ── the turn ──
const row = (def) => ({ bot_id: def.bot_id, enabled: 1, definition: JSON.stringify(def) });
function voiceHarness(def) {
  const h = harness({ bot: VOICE });
  const rows = { "crow.voice": def };
  let gen = 0;
  h.rows = rows;
  h.bump = () => { gen++; };
  h.deps.voiceBotId = "crow.voice";
  h.deps.botDefsGeneration = () => gen;
  h.deps.loadBotRow = async (db, id) => (rows[id] ? row(rows[id]) : null);
  h.dir = fresh();
  h.log = createTranscriptLog({ dir: h.dir, now: () => T0 });
  h.deps.transcriptLog = h.log;
  return h;
}
const turn = (h, opts = {}) => h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "What is the capital of Portugal?", sink: h.sink, ...opts });

test("a voice turn: off by default records nothing; on, the final transcript and what was heard are kept, never logged", async () => {
  const off = voiceHarness(VOICE);
  await turn(off);
  assert.deepEqual(await off.log.list(), []);
  assert.equal(existsSync(join(off.dir, "2026-10-26.jsonl")), false);
  const h = voiceHarness(ON);
  await turn(h);
  await turn(h, { transcript: "Had coffee Tuesday at 9", lang: "en", tz: "America/Chicago" });
  const [a, b] = await h.log.list();
  assert.equal(a.transcript, "What is the capital of Portugal?");
  assert.equal(a.heard, null);
  assert.equal(a.device_id, h.device.id);
  assert.equal(b.heard, "Had coffee Tuesday at 9");
  assert.match(b.transcript, /^add coffee/i);
  assert.equal(h.calls.logs.some((m) => /Portugal|coffee/.test(m)), false, "never logged");
  // The kiosk's turn check (noTranscript) is never kept.
  await turn(h, { noTranscript: true, transcript: "a check" });
  assert.equal((await h.log.list()).length, 2);
});

test("a turn answered by a bot that is not a voice bot is not kept", async () => {
  const h = voiceHarness(ON);
  const PI = { bot_id: "helper", kind: "pi", display_name: "Helper" };
  h.rows.helper = PI;
  h.device = { ...h.device, bound_bot_id: "helper" };
  delete h.deps.voiceBotId;   // the turn answers as the device's own bot
  await turn(h);
  assert.deepEqual(await h.log.list(), []);
});

test("turning it off deletes the log on the next turn", async () => {
  const h = voiceHarness(ON);
  await turn(h);
  assert.equal((await h.log.list()).length, 1);
  h.rows["crow.voice"] = VOICE;
  h.bump();
  await turn(h);
  assert.deepEqual(await h.log.list(), []);
});
