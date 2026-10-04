import { test } from "node:test";
import assert from "node:assert/strict";
import * as H from "../servers/gateway/voice/turn-helpers.js";

test("think gate (glasses :994-1025): leading <think> never reaches speech; partial tag is held; plain text passes", () => {
  const g = H.createThinkGate();
  assert.equal(g.feed("<thi"), "");
  assert.equal(g.feed("nk>plan the answer"), "");
  assert.equal(g.feed("</think>Hello"), "Hello");
  assert.equal(g.feed(" there."), " there.");
  const p = H.createThinkGate();
  assert.equal(p.feed("  Sure"), "  Sure");
  assert.equal(p.feed("<think>not a lead"), "<think>not a lead", "only a LEADING block is gated");
});

test("sentence chunker (glasses SENTENCE_END): splits on terminal punctuation + space or newline; flush sends the tail", async () => {
  const out = [];
  const c = H.createSentenceChunker(async (s) => { out.push(s); });
  await c.push("Hi there. How are");
  await c.push(" you? Fine");
  assert.deepEqual(out, ["Hi there. ", "How are you? "]);
  await c.flush();
  assert.deepEqual(out, ["Hi there. ", "How are you? ", "Fine"]);
  await c.flush();
  assert.equal(out.length, 3, "second flush is a no-op");
});

test("confirm gate (glasses :186-225): first call confirms; same tool+args+affirmative within 60 s allows; anything else re-arms", () => {
  let t = 0;
  const g = H.createConfirmGate({ now: () => t });
  const call = { deviceId: "d", eff: "crow_delete_post", args: { id: 3 } };
  assert.equal(g.check({ ...call, transcript: "delete post 3" }), "confirm");
  t = 10_000;
  assert.equal(g.check({ ...call, transcript: "yes do it" }), "allow");
  assert.equal(g.check({ ...call, transcript: "yes" }), "confirm", "consumed; re-armed");
  t = 80_000;
  assert.equal(g.check({ ...call, transcript: "yes" }), "confirm", "expired after 60 s");
  assert.equal(g.check({ ...call, args: { id: 4 }, transcript: "yes" }), "confirm", "args changed");
  assert.equal(g.check({ deviceId: "other", eff: "crow_delete_post", args: { id: 4 }, transcript: "yes" }), "confirm", "per device");
});

test("isDestructiveTool matches the glasses list + regex", () => {
  for (const n of ["crow_delete_post", "crow_unpublish_post", "crow_remove_backend", "crow_dismiss_all_notifications", "crow_destroy_x"]) assert.ok(H.isDestructiveTool(n), n);
  for (const n of ["crow_create_post", "crow_wm", "", null]) assert.ok(!H.isDestructiveTool(n), String(n));
});

test("conversation store: 24-message cap, 15-min idle reset, system dropped, never starts on an orphan tool/assistant", () => {
  let t = 0;
  const s = H.createConvoStore({ now: () => t });
  const msgs = [{ role: "system", content: "x" }];
  for (let i = 0; i < 20; i++) msgs.push({ role: "user", content: "u" + i }, { role: "assistant", content: "", tool_calls: "[]" }, { role: "tool", content: "r" });
  msgs.push({ role: "user", content: "last" }, { role: "assistant", content: "ok" });
  // 62 non-system messages: the plain last-24 window would START on a tool result (index 38 = tool).
  s.save("d", msgs);
  const kept = s.get("d");
  assert.equal(kept.length, 23, "the orphan tool result at the window's head is trimmed");
  assert.equal(kept[0].role, "user");
  assert.equal(kept.at(-1).content, "ok");
  assert.ok(!kept.some((m) => m.role === "system"));
  t = 15 * 60 * 1000 + 1;
  assert.deepEqual(s.get("d"), []);
});

test("negotiatePcm: kokoro/openai 24 kHz raw; piper strips 44 bytes; edge has no PCM path", () => {
  assert.deepEqual(H.negotiatePcm("kokoro"), { synthFormat: "pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 });
  assert.equal(H.negotiatePcm("piper").stripHeaderBytes, 44);
  assert.equal(H.negotiatePcm("edge"), null);
});

test("pcmStream strips a header, passes the abort signal to synth, and yields nothing once aborted", async () => {
  const seen = [];
  const adapter = { async *synthesize(text, voice, opts) { seen.push(opts); yield Buffer.alloc(40, 1); yield Buffer.alloc(10, 2); yield Buffer.alloc(6, 3); } };
  const out = [];
  for await (const c of H.pcmStream(adapter, "hi", "v", { synthFormat: undefined, stripHeaderBytes: 44 })) out.push(c);
  assert.equal(Buffer.concat(out).length, 12);
  const live = new AbortController();
  for await (const c of H.pcmStream(adapter, "hi", "v", H.negotiatePcm("kokoro"), { signal: live.signal })) out.push(c);
  assert.equal(seen.at(-1).signal, live.signal, "the abort signal reaches the provider call");
  assert.equal(seen.at(-1).format, "pcm");
  const ac = new AbortController(); ac.abort();
  const calls = seen.length;
  const none = [];
  for await (const c of H.pcmStream(adapter, "hi", "v", H.negotiatePcm("kokoro"), { signal: ac.signal })) none.push(c);
  assert.equal(none.length, 0);
  assert.equal(seen.length, calls, "an already-aborted turn never calls the provider");
});

test("wrapPcmAsWav writes a 44-byte RIFF header for 16 kHz mono s16", () => {
  const w = H.wrapPcmAsWav(Buffer.alloc(320), 16000);
  assert.equal(w.length, 364);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(40), 320);
});

test("smoke 2026-10-04 lever 3: firstClauseEnd — a clause of 3+ words, a sentence, or 8 complete words; never inside 1,000 or 3:30", () => {
  const cut = (s) => { const e = H.firstClauseEnd(s); return e < 0 ? null : s.slice(0, e); };
  assert.equal(cut("Lisbon is the capital, and "), "Lisbon is the capital, ");
  assert.equal(cut("Sure, "), null, "a 1-word clause waits (no lone 'Sure,' with a falling tone)");
  assert.equal(cut("Sure, Lisbon is the capital. It"), "Sure, Lisbon is the capital. ", "then the sentence end wins");
  assert.equal(cut("It costs 1,000 dollars and "), null, "a number comma is not a clause");
  assert.equal(cut("The meeting is at 3:30 today and it will "), "The meeting is at 3:30 today and it ", "8 complete words");
  assert.equal(cut("one two three four five six seven eight"), null, "the 8th word may still be growing");
  assert.equal(cut("The answer is simple — it is "), "The answer is simple — ");
  assert.equal(cut("First of all; the "), "First of all; ");
  assert.equal(cut("A leap year has 366 days. It "), "A leap year has 366 days. ");
  assert.equal(cut("Hi."), null, "no trailing space: the sentence may continue (3.5)");
});

test("smoke 2026-10-04 lever 3: chunker with firstClause splits once, then sentences; the default (glasses) is unchanged", async () => {
  const out = [];
  const c = H.createSentenceChunker(async (s) => { out.push(s); }, { firstClause: true });
  for (const t of ["Lisbon", " is", " the", " capital", " of", " Portugal,", " a", " city", " by", " the", " sea.", " It", " is", " old,", " and", " lovely"]) await c.push(t);
  await c.flush();
  assert.deepEqual(out, ["Lisbon is the capital of Portugal, ", "a city by the sea. ", "It is old, and lovely"]);
  const g = [];
  const d = H.createSentenceChunker(async (s) => { g.push(s); });
  await d.push("Lisbon is the capital, a city. It");
  await d.flush();
  assert.deepEqual(g, ["Lisbon is the capital, a city. ", "It"]);
});

test("review I2/M8/M9: leading whitespace never uses up the first-clause split; a dash is not a word; CLAUSE_END has no shared /g state", async () => {
  const out = [];
  const c = H.createSentenceChunker(async (s) => { out.push(s); }, { firstClause: true });
  await c.push("\n\n");
  await c.push("Lisbon is the capital, and a city by the sea. It is old.");
  await c.flush();
  assert.deepEqual(out.map((s) => s.trim()), ["Lisbon is the capital,", "and a city by the sea.", "It is old."]);
  assert.equal(H.firstClauseEnd("Okay — sure, "), -1, "'Okay — sure,' is two words: wait");
  assert.equal(H.firstClauseEnd("The ratio is 3 - 2 and "), -1, "a spaced hyphen is not a clause break");
  assert.equal(H.CLAUSE_END.global, false);
});
