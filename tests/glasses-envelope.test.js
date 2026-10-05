/** Which tool results may start or steer audio on a glasses session, the small limiter, and the scheduler hook registry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readEnvelope, STREAM_TOOLS, CONTROL_TOOLS, NOT_STARTED, MAX_QUEUE } from "../bundles/meta-glasses/server/envelope.js";
import { createLimiter } from "../bundles/meta-glasses/server/limits.js";
import { registerSchedulerHook, unregisterSchedulerHook, runSchedulerHooks } from "../servers/gateway/scheduler-hooks.js";

const URL1 = "https://music.example.invalid/api/v1/listen/11111111-2222-3333-4444-555555555555/?to=mp3";
const env = (over = {}, top = {}) => JSON.stringify({ ok: true, title: "Blue Hour", artist: "The Example Band", _audio_stream: { url: URL1, codec: "mp3", auth: "funkwhale", ...over }, prose: "Playing Blue Hour by The Example Band.", ...top });

test("a stream envelope from a music tool is read; the model's sentence is the tool's own prose", () => {
  const e = readEnvelope("fw_play", env());
  assert.equal(e.kind, "stream");
  assert.deepEqual(e.item, { url: URL1, codec: "mp3", auth: "funkwhale", sample_rate: null, channels: null, title: "Blue Hour", artist: "The Example Band", artworkUrl: null });
  assert.deepEqual(e.queue, []);
  assert.equal(e.say, "Playing Blue Hour by The Example Band.");
  const album = readEnvelope("fw_play_album", env({ queue: [{ url: URL1, codec: "mp3", auth: "funkwhale", title: "Two" }, { url: URL1, codec: "ogg", auth: "funkwhale" }] }));
  assert.deepEqual(album.queue.map((q) => [q.codec, q.title]), [["mp3", "Two"], ["ogg", null]]);
});

test("the same envelope from ANY other tool is refused: the model reads one fixed sentence, never the address", () => {
  for (const name of ["crow_tools", "crow_media", "fetch", "brave_web_search", "crow_projects", "fw_search", "", undefined]) {
    const e = readEnvelope(name, env());
    assert.deepEqual(e, { kind: "refused", say: NOT_STARTED }, String(name));
  }
  for (const name of [...STREAM_TOOLS, "fetch"]) assert.equal(readEnvelope(name, JSON.stringify({ _audio_stream_control: { action: "stop" } })).kind, "refused", "a play tool cannot send a control envelope");
});

test("malformed envelopes from a music tool are refused: no address, an unknown codec or credential rule, a bad queue", () => {
  const bad = [env({ url: undefined }), env({ url: 5 }), env({ codec: "exe" }), env({ auth: undefined }), env({ auth: "other" }), env({ auth: "crow-peer:" }), env({ auth: "crow-peer:a b" }),
    env({ queue: "x" }), env({ queue: [{ url: URL1, codec: "mp3" }] }), env({ queue: Array.from({ length: MAX_QUEUE + 1 }, () => ({ url: URL1, codec: "mp3", auth: "funkwhale" })) }),
    JSON.stringify({ _audio_stream: null }), JSON.stringify({ _audio_stream: "x" })];
  for (const b of bad) assert.equal(readEnvelope("fw_play", b).kind, "refused", b.slice(0, 80));
  assert.equal(readEnvelope("fw_play", env({ auth: "crow-peer:abc123" })).kind, "stream", "the paired-instance form the gateway itself writes is accepted");
});

test("control envelopes: only from a control tool, only the four actions", () => {
  for (const [tool, action] of [["fw_stop_playback", "stop"], ["fw_pause", "pause"], ["fw_resume", "resume"], ["fw_next_track", "next"]]) {
    assert.deepEqual(readEnvelope(tool, JSON.stringify({ _audio_stream_control: { action }, prose: "Okay." })), { kind: "control", action, say: "Okay." });
  }
  assert.equal(readEnvelope("fw_pause", JSON.stringify({ _audio_stream_control: { action: "format_disk" } })).kind, "refused");
  assert.deepEqual(CONTROL_TOOLS.length, 4);
});

test("everything else passes through untouched: plain text, JSON with no envelope, broken JSON, an oversized result, a non-string", () => {
  for (const r of ["ok", '{"a":1}', '{"_audio_stream":', "x".repeat(70_000) + '"_audio_stream"', 42, null, undefined, '["_audio_stream"]', '{"note":"the word \\"_audio_stream is only mentioned"}']) {
    assert.equal(readEnvelope("fw_play", r), null);
  }
});

test("limiter: counts per key inside a window, forgets after it, and stays bounded", () => {
  let t = 0;
  const l = createLimiter({ max: 3, windowMs: 1000, now: () => t, maxKeys: 4 });
  assert.deepEqual([l.take("a"), l.take("a"), l.take("a"), l.take("a")], [true, true, true, false]);
  assert.equal(l.blocked("a"), true);
  assert.equal(l.blocked("b"), false);
  assert.equal(l.take("b"), true);
  t = 1000;
  assert.equal(l.blocked("a"), false);
  assert.equal(l.take("a"), true);
  for (const k of ["c", "d", "e", "f", "g"]) l.take(k);
  assert.equal(l.size(), 4);
});

test("scheduler hooks: each registered bundle is called; a failing hook is logged and does not stop the others; the scheduler imports no bundle file", async (t) => {
  const warned = [];
  const orig = console.warn;
  console.warn = (m) => warned.push(String(m));
  t.after(() => { console.warn = orig; unregisterSchedulerHook("t-one"); unregisterSchedulerHook("t-two"); });
  const got = [];
  registerSchedulerHook("t-one", { tick: async () => { throw new Error("boom"); }, reminder: async (db, r) => got.push(["one", r.text]) });
  registerSchedulerHook("t-two", { tick: async (db) => got.push(["two-tick", db]) });
  await runSchedulerHooks("tick", "DB");
  await runSchedulerHooks("reminder", "DB", { type: "reminder", text: "Water the plants" });
  assert.deepEqual(got, [["two-tick", "DB"], ["one", "Water the plants"]]);
  assert.equal(warned.filter((w) => w.includes("t-one tick hook failed: boom")).length, 1);
  assert.throws(() => registerSchedulerHook("", {}));
  const src = readFileSync(new URL("../servers/gateway/scheduler.js", import.meta.url), "utf8");
  assert.ok(!src.includes("bundles/"), "servers/gateway/scheduler.js reaches bundles only through the hook registry");
  assert.ok(!src.includes("CROW_GATEWAY_PORT"), "and no hook is tied to a port number");
});
