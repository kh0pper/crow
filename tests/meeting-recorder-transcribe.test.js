// tests/meeting-recorder-transcribe.test.js
//
// The meeting recorder's worker sent four-minute slices to faster-whisper-server, which keeps
// condition_on_previous_text on and takes one float temperature, so a slice could decode into a
// repetition loop and never fall back. These tests pin the fix: audio is cut at the quietest
// point inside [min, max] seconds, each chunk is one request at temperature 0, a chunk whose
// segments compress too well (or that an engine-agnostic loop guard flags) climbs a temperature
// ladder, a chunk no endpoint can read becomes a gap, and --retranscribe keeps every old file.
// A fake STT endpoint on loopback stands in for the real server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const HOME = mkdtempSync(join(tmpdir(), "mr-test-"));
process.env.CROW_HOME = HOME;

const audio = await import("../bundles/meeting-recorder/server/audio.js");
const guard = await import("../bundles/meeting-recorder/server/loop-guard.js");
const client = await import("../bundles/meeting-recorder/server/stt-client.js");
const worker = await import("../bundles/meeting-recorder/server/transcribe.js");
const store = await import("../bundles/meeting-recorder/server/store.js");

const RATE = 16000;

// ---------------------------------------------------------------- synthetic audio

/** Build mono s16 samples from [seconds, amplitude] pieces (amplitude 0 = silence). */
function pcm(pieces) {
  const total = pieces.reduce((n, [s]) => n + Math.round(s * RATE), 0);
  const out = new Int16Array(total);
  let i = 0;
  for (const [s, amp] of pieces) {
    const n = Math.round(s * RATE);
    for (let k = 0; k < n; k++, i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / RATE));
  }
  return out;
}

/** A WAV with an extra LIST chunk before data, the way ffmpeg writes one. */
function wavWithList(samples) {
  const plain = audio.encodeWav(samples, RATE);
  const list = Buffer.alloc(8 + 26);
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(26, 4);
  list.write("INFOISFT", 8, "ascii");
  const head = plain.subarray(0, 36);
  const rest = plain.subarray(36);
  const out = Buffer.concat([head, list, rest]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

function tmpWav(samples, withList = false) {
  const dir = mkdtempSync(join(tmpdir(), "mr-wav-"));
  const path = join(dir, "a.wav");
  writeFileSync(path, withList ? wavWithList(samples) : audio.encodeWav(samples, RATE));
  return path;
}

// ---------------------------------------------------------------- fake STT endpoint

/** Minimal multipart reader: returns {fields, fileBytes}. */
function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1].replace(/^"|"$/g, "");
  const parts = body.toString("latin1").split(`--${boundary}`);
  const fields = {};
  let fileBytes = 0;
  for (const part of parts) {
    const m = /name="([^"]+)"(?:; filename="[^"]*")?/.exec(part);
    if (!m) continue;
    const value = part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
    if (/filename=/.test(part)) fileBytes = Buffer.byteLength(value, "latin1");
    else fields[m[1]] = value;
  }
  return { fields, fileBytes };
}

/**
 * Start a fake endpoint. `respond(req)` gets {fields, seconds, n} and returns
 * {status, json} | {hang: true} | {delayMs, json}.
 */
async function fakeStt(respond) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const { fields, fileBytes } = parseMultipart(Buffer.concat(chunks), req.headers["content-type"]);
      const seconds = Math.max(0, fileBytes - 44) / (RATE * 2);
      const r = { fields, seconds, n: requests.length };
      requests.push(r);
      const out = await respond(r);
      if (out.hang) return; // never answer
      if (out.delayMs) await new Promise((ok) => setTimeout(ok, out.delayMs));
      res.writeHead(out.status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json || {}));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`;
  return {
    url,
    requests,
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }),
  };
}

const seg = (start, end, text, compression_ratio = 1.4) => ({ start, end, text, compression_ratio });
const words = (n, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const okBody = (seconds, text = words(Math.round(seconds * 2.5)), ratio = 1.4) => ({
  text,
  segments: [seg(0, seconds, text, ratio)],
});

const fast = { backoffMs: 1 };

// ---------------------------------------------------------------- audio.js

test("planChunks cuts at the quietest frame inside [min, max]", () => {
  // 100 ms frames. Loud everywhere except one quiet frame at 23.4 s and another at 47.0 s.
  const e = new Float64Array(700).fill(1);
  e[234] = 0.001;
  e[470] = 0.002;
  const chunks = audio.planChunks(e, { frameMs: 100, minS: 20, maxS: 30, totalS: 70 });
  assert.deepEqual(chunks, [[0, 23.4], [23.4, 47], [47, 70]]);
});

test("planChunks with no silence cuts at max", () => {
  const e = new Float64Array(1000).fill(1);
  assert.deepEqual(audio.planChunks(e, { frameMs: 100, minS: 20, maxS: 30, totalS: 100 }),
    [[0, 30], [30, 60], [60, 90], [90, 100]]);
});

test("planChunks: a short file is one chunk, a short tail stays, an empty file is none", () => {
  assert.deepEqual(audio.planChunks(new Float64Array(120).fill(1), { frameMs: 100, minS: 20, maxS: 30, totalS: 12 }),
    [[0, 12]]);
  const e = new Float64Array(320).fill(1);
  e[290] = 0;
  assert.deepEqual(audio.planChunks(e, { frameMs: 100, minS: 20, maxS: 30, totalS: 32 }), [[0, 29], [29, 32]]);
  assert.deepEqual(audio.planChunks(new Float64Array(0), { frameMs: 100, minS: 20, maxS: 30, totalS: 0 }), []);
});

test("a WAV with a LIST chunk parses, and energies find the silent gap", () => {
  const samples = pcm([[5, 8000], [0.5, 0], [5, 8000]]);
  const path = tmpWav(samples, true);
  const h = audio.readWavHeader(path);
  assert.equal(h.sampleRate, RATE);
  assert.equal(h.channels, 1);
  assert.equal(h.bitsPerSample, 16);
  assert.equal(h.dataBytes, samples.length * 2);
  const e = audio.frameEnergies(path, h, 100);
  assert.equal(e.length, 105);
  assert.ok(e[52] < 1 && e[10] > 1000, "silent frames read as quiet, tone as loud");
  const span = audio.wavSpan(path, h, 5, 5.5);
  assert.equal(span.length, 44 + 0.5 * RATE * 2);
  assert.equal(audio.readWavHeader(span).dataBytes, 0.5 * RATE * 2);
});

test("a WAV whose header says 0 data bytes is read by what is on disk", () => {
  const w = audio.encodeWav(new Int16Array(RATE), RATE);
  w.writeUInt32LE(0, 40);
  assert.equal(audio.readWavHeader(w).dataBytes, RATE * 2);
});

test("readWavHeader refuses anything that is not 16-bit PCM mono", () => {
  const bad = audio.encodeWav(new Int16Array(100), RATE);
  bad.writeUInt16LE(2, 22); // stereo
  const dir = mkdtempSync(join(tmpdir(), "mr-wav-"));
  writeFileSync(join(dir, "b.wav"), bad);
  assert.throws(() => audio.readWavHeader(join(dir, "b.wav")), /mono/);
});

// ---------------------------------------------------------------- loop-guard.js

test("compressionRatio follows Whisper's definition and separates loops from speech", () => {
  const loop = Array(30).fill("thank you so much").join(" ");
  assert.ok(guard.compressionRatio(loop) > 2.4);
  assert.ok(guard.compressionRatio("we moved the review to thursday because the budget numbers were late") < 2.4);
  assert.equal(guard.compressionRatio(""), 0);
});

test("loopCheck flags a repeated 5-gram that a low compression ratio would miss, and a fast talker", () => {
  const rep = Array(9).fill("alpha beta gamma delta epsilon").join(" ");
  const r = guard.loopCheck(rep, 30);
  assert.equal(r.loop, true);
  assert.equal(r.maxRepeats, 9);
  assert.equal(guard.loopCheck(words(150), 30).loop, true, "5 words/s");
  assert.equal(guard.loopCheck(words(75), 30).loop, false, "2.5 words/s is speech");
  assert.equal(guard.loopCheck(words(12), 2).loop, false, "a 2 s tail is judged over 5 s");
});

// ---------------------------------------------------------------- stt-client.js

test("the ladder accepts the first temperature that passes and records the climb", async () => {
  const stt = await fakeStt(({ fields, seconds }) =>
    Number(fields.temperature) < 0.6 ? { json: okBody(seconds, undefined, 9.0) } : { json: okBody(seconds, undefined, 1.5) });
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 5000 });
    assert.equal(out.record.temperature, 0.6);
    assert.equal(out.record.suspect, false);
    assert.deepEqual(stt.requests.map((r) => Number(r.fields.temperature)), [0, 0.2, 0.4, 0.6]);
    assert.equal(out.record.tried.length, 4);
    assert.equal(out.record.max_compression_ratio, 1.5);
  } finally {
    await stt.close();
  }
});

test("when every temperature fails, the lowest-ratio result is kept and the chunk is suspect", async () => {
  const ratios = { 0: 9, 0.2: 6, 0.4: 3.1, 0.6: 4, 0.8: 5, 1: 7 };
  const stt = await fakeStt(({ fields, seconds }) =>
    ({ json: okBody(seconds, `t${fields.temperature} ` + words(40), ratios[Number(fields.temperature)]) }));
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 5000 });
    assert.equal(stt.requests.length, 6);
    assert.equal(out.record.suspect, true);
    assert.equal(out.record.temperature, 0.4);
    assert.equal(out.record.max_compression_ratio, 3.1);
  } finally {
    await stt.close();
  }
});

test("a fast but steady speaker keeps the temperature-0 text when every rung trips only the speed check", async () => {
  const stt = await fakeStt(({ fields, seconds }) => ({ json: okBody(seconds, `t${fields.temperature} ` + words(130), 1.3) }));
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 5000 });
    assert.equal(stt.requests.length, 6);
    assert.equal(out.record.suspect, true);
    assert.equal(out.record.temperature, 0);
  } finally {
    await stt.close();
  }
});

test("a malformed answer is a transport error, not a crash", async () => {
  const stt = await fakeStt(({ n, seconds }) => (n === 0 ? { json: null } : n === 1 ? { json: { segments: [null] } }
    : { json: okBody(seconds) }));
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 5000 });
    assert.equal(out.record.gap, false);
    assert.equal(out.record.temperature, 0);
  } finally {
    await stt.close();
  }
});

test("a repeated 5-gram climbs the ladder even when the server reports a low ratio", async () => {
  const rep = Array(10).fill("alpha beta gamma delta epsilon").join(" ");
  const stt = await fakeStt(({ fields, seconds }) =>
    Number(fields.temperature) === 0 ? { json: okBody(seconds, rep, 1.2) } : { json: okBody(seconds, undefined, 1.2) });
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 5000 });
    assert.equal(out.record.temperature, 0.2);
    assert.deepEqual(out.record.tried[0].slice(0, 2), ["primary", 0]);
    assert.equal(out.record.tried[0][3], "loop");
  } finally {
    await stt.close();
  }
});

test("segments without compression_ratio get one computed client-side", async () => {
  const loop = Array(30).fill("thank you so much").join(" ");
  const stt = await fakeStt(({ fields, seconds }) => ({
    json: { text: "", segments: [{ start: 0, end: seconds, text: Number(fields.temperature) === 0 ? loop : words(60) }] },
  }));
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 5000 });
    assert.equal(out.record.temperature, 0.2);
  } finally {
    await stt.close();
  }
});

test("a timeout advances the ladder instead of re-sending the same temperature", async () => {
  const stt = await fakeStt(({ fields, seconds }) =>
    Number(fields.temperature) === 0 && seconds > 2 ? { hang: true } : { json: okBody(seconds) });
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 1000 });
    assert.deepEqual(stt.requests.map((r) => [Number(r.fields.temperature), r.seconds]), [[0, 25], [0, 1], [0.2, 25]],
      "a 1 s drain request sits between the timed-out rung and the next");
    assert.equal(stt.requests[1].fields.vad_filter, "false");
    assert.equal(out.record.tried[0][3], "timeout");
    assert.equal(out.record.temperature, 0.2);
  } finally {
    await stt.close();
  }
});

test("transport errors retry the same rung, then the fallback endpoint takes the chunk", async () => {
  const down = await fakeStt(() => ({ status: 500 }));
  const up = await fakeStt(({ seconds }) => ({ json: okBody(seconds) }));
  try {
    const one = await client.transcribeChunk(
      [{ engine: "primary", url: down.url, model: "a" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 5000, attempts: 3 });
    assert.equal(one.result, null, "no fallback configured: nothing to keep");
    assert.equal(down.requests.length, 3, "three attempts at T=0, then the endpoint is down for this chunk");
    assert.match(one.error, /500/);

    const two = await client.transcribeChunk(
      [{ engine: "primary", url: down.url, model: "a" }, { engine: "fallback", url: up.url, model: "b" }],
      audio.encodeWav(new Int16Array(RATE * 25), RATE), 25, { ...fast, timeoutMs: 5000, attempts: 3 });
    assert.equal(two.record.engine, "fallback");
    assert.equal(two.record.model, "b");
    assert.equal(up.requests.length, 1);
  } finally {
    await down.close();
    await up.close();
  }
});

test("a suspect primary chunk is re-run on the fallback, which wins when it passes", async () => {
  const loopy = await fakeStt(({ seconds }) => ({ json: okBody(seconds, undefined, 9) }));
  const good = await fakeStt(({ seconds }) => ({ json: okBody(seconds, undefined, 1.3) }));
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: loopy.url, model: "a" }, { engine: "fallback", url: good.url, model: "b" }],
      audio.encodeWav(new Int16Array(RATE * 25), RATE), 25, { ...fast, timeoutMs: 5000 });
    assert.equal(loopy.requests.length, 6);
    assert.equal(out.record.engine, "fallback");
    assert.equal(out.record.suspect, false);
  } finally {
    await loopy.close();
    await good.close();
  }
});

test("requests never carry a prompt, always carry a temperature, and VAD is on by default", async () => {
  const stt = await fakeStt(({ seconds }) => ({ json: okBody(seconds) }));
  try {
    await client.transcribeChunk([{ engine: "primary", url: stt.url, model: "m" }],
      audio.encodeWav(new Int16Array(RATE * 25), RATE), 25, { ...fast, timeoutMs: 5000 });
    await client.transcribeChunk([{ engine: "primary", url: stt.url, model: "m" }],
      audio.encodeWav(new Int16Array(RATE * 25), RATE), 25, { ...fast, timeoutMs: 5000, vad: false });
    for (const r of stt.requests) {
      assert.equal("prompt" in r.fields, false);
      assert.equal(r.fields.temperature, "0");
      assert.equal(r.fields.response_format, "verbose_json");
      assert.equal(r.fields.model, "m");
    }
    assert.equal(stt.requests[0].fields.vad_filter, "true");
    assert.equal(stt.requests[1].fields.vad_filter, "false");
  } finally {
    await stt.close();
  }
});

/**
 * A one-worker server like faster-whisper-server: requests run one at a time, and a request the
 * client gave up on keeps running. `cost(r)` is how long a request takes, in ms.
 */
async function serialStt(cost, body = ({ seconds }) => okBody(seconds)) {
  let free = Promise.resolve();
  const log = [];
  const stt = await fakeStt(async (r) => {
    const arrived = Date.now();
    const turn = free.then(async () => {
      const began = Date.now();
      await new Promise((ok) => setTimeout(ok, cost(r)));
      log.push({ n: r.n, seconds: r.seconds, t: Number(r.fields.temperature), arrived, began, done: Date.now() });
    });
    free = turn;
    await turn;
    return { json: body(r) };
  });
  return { ...stt, log };
}

test("after a timeout the next rung waits until the server has finished the abandoned decode", async () => {
  const stt = await serialStt((r) => (r.seconds > 2 && r.n === 0 ? 2500 : 10));
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 1000 });
    assert.equal(out.record.temperature, 0.2);
    const first = stt.log.find((x) => x.n === 0);
    const next = stt.log.find((x) => x.t === 0.2);
    assert.ok(next.arrived >= first.done, "the 0.2 rung was sent only after the wedged request finished");
  } finally {
    await stt.close();
  }
});

test("two timeouts on one chunk stop its ladder", async () => {
  const stt = await fakeStt(({ seconds }) => (seconds > 2 ? { hang: true } : { json: okBody(seconds) }));
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: stt.url, model: "m" }], audio.encodeWav(new Int16Array(RATE * 25), RATE), 25,
      { ...fast, timeoutMs: 1000 });
    assert.equal(out.result, null);
    assert.equal(out.record.gap, true);
    assert.deepEqual(out.record.tried.map((t) => t[3]), ["timeout", "timeout"]);
    assert.equal(stt.requests.length, 4, "two chunk requests, two drains");
  } finally {
    await stt.close();
  }
});

test("a body that stalls after the headers counts as a timeout, so the ladder drains and moves on", async () => {
  const server = createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const { fields, fileBytes } = parseMultipart(Buffer.concat(parts), req.headers["content-type"]);
      const seconds = Math.max(0, fileBytes - 44) / (RATE * 2);
      res.writeHead(200, { "content-type": "application/json" });
      if (Number(fields.temperature) === 0 && seconds > 2) res.write("{\"text\": "); // and never finish
      else res.end(JSON.stringify(okBody(seconds)));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const out = await client.transcribeChunk(
      [{ engine: "primary", url: `http://127.0.0.1:${server.address().port}/x`, model: "m" }],
      audio.encodeWav(new Int16Array(RATE * 25), RATE), 25, { ...fast, timeoutMs: 1000 });
    assert.equal(out.record.tried[0][3], "timeout");
    assert.equal(out.record.temperature, 0.2);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
});

test("a 4xx is a configuration error: no retries, the run stops", async () => {
  const stt = await fakeStt(() => ({ status: 404, json: { detail: "model not found" } }));
  try {
    await assert.rejects(client.transcribeChunk([{ engine: "primary", url: stt.url, model: "m" }],
      audio.encodeWav(new Int16Array(RATE * 25), RATE), 25, { ...fast, timeoutMs: 5000 }),
      (err) => err.kind === "config" && /404/.test(err.message));
    assert.equal(stt.requests.length, 1);
  } finally {
    await stt.close();
  }
});

test("WHISPER_LANGUAGE is sent only when set, and the detected language is recorded", async () => {
  const stt = await fakeStt(({ seconds }) => ({ json: { ...okBody(seconds), language: "en" } }));
  try {
    const a = await client.transcribeChunk([{ engine: "primary", url: stt.url, model: "m" }],
      audio.encodeWav(new Int16Array(RATE * 25), RATE), 25, { ...fast, timeoutMs: 5000 });
    await client.transcribeChunk([{ engine: "primary", url: stt.url, model: "m" }],
      audio.encodeWav(new Int16Array(RATE * 25), RATE), 25, { ...fast, timeoutMs: 5000, language: "en" });
    assert.equal("language" in stt.requests[0].fields, false);
    assert.equal(stt.requests[1].fields.language, "en");
    assert.equal(a.record.language, "en");
  } finally {
    await stt.close();
  }
});

// ---------------------------------------------------------------- transcribe.js (end to end)

/** A session dir with audio.wav and meta, as the panel leaves it on finish. */
function makeSession(id, samples, meta = {}) {
  const dir = store.sessionDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "audio.wav"), audio.encodeWav(samples, RATE));
  writeFileSync(join(dir, "audio.webm"), "source"); // the recording; the stand-in converter leaves audio.wav as is
  store.writeMeta(id, { id, title: "Test meeting", started_at: "2026-01-02T10:00:00.000Z", state: "transcribing", ...meta });
  return dir;
}

// ffmpeg is not on every CI runner; audio.wav is already in place, so conversion is a no-op.
const convert = async (_src, dest) => dest;

// 70 s: tone with short silences at 22 s and 48 s.
const meetingSamples = () => pcm([[22, 8000], [0.4, 0], [25.6, 8000], [0.4, 0], [21.6, 8000]]);

function envFor(url, extra = {}) {
  return {
    WHISPER_URL: url, WHISPER_MODEL: "Systran/faster-whisper-large-v3",
    WHISPER_BACKOFF_MS: "1", WHISPER_CHUNK_TIMEOUT_MS: "5000", ...extra,
  };
}

test("a session is chunked at silences, offset into meeting time, and the header says what ran", async () => {
  const stt = await fakeStt(({ seconds }) => ({ json: okBody(seconds, words(10)) }));
  try {
    const id = "t-chunked";
    const dir = makeSession(id, meetingSamples());
    await worker.transcribeSession(id, { env: envFor(stt.url), convert });
    const segs = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8"));
    assert.ok(Array.isArray(segs), "transcript.json stays an array of segments");
    assert.equal(stt.requests.length, 3);
    for (const r of stt.requests) assert.ok(r.seconds <= 30 + 1e-6);
    assert.deepEqual(segs.map((s) => s.start), [0, 22.3, 48.3]);
    assert.deepEqual(segs.map((s) => s.chunk), [0, 1, 2]);
    const meta = store.readMeta(id);
    assert.equal(meta.state, "done");
    assert.equal(meta.word_count, 30);
    assert.equal(meta.transcriber.chunks, 3);
    assert.equal(meta.worker_pid ?? null, null, "worker_pid cleared at the end");
    const chunks = JSON.parse(readFileSync(join(dir, "chunks.json"), "utf8"));
    assert.equal(chunks.length, 3);
    assert.equal(chunks[1].engine, "primary");
    const md = readFileSync(join(dir, "transcript.md"), "utf8");
    assert.match(md, /Transcribed with faster-whisper-large-v3/);
    assert.doesNotMatch(md, /locally/);
    assert.equal(existsSync(join(dir, "chunks")), false, "cache removed after a clean run");
  } finally {
    await stt.close();
  }
});

test("a chunk no endpoint can read becomes a gap with its real span, and the run carries on", async () => {
  const stt = await fakeStt(({ n, seconds }) => (n < 3 ? { status: 503 } : { json: okBody(seconds, words(10)) }));
  try {
    const id = "t-gap";
    const dir = makeSession(id, meetingSamples());
    await worker.transcribeSession(id, { env: envFor(stt.url), convert });
    const meta = store.readMeta(id);
    assert.equal(meta.state, "done");
    assert.equal(meta.gaps.length, 1);
    assert.equal(meta.gaps[0].start, 0);
    assert.equal(meta.gaps[0].seconds, 22.3);
    assert.deepEqual(Object.keys(meta.gaps[0]).sort(), ["error", "seconds", "start"]);
    const segs = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8"));
    assert.match(segs[0].text, /^\[transcription gap: 0:00 to 0:22\]$/);
    assert.equal(segs[0].gap, true);
    assert.equal(meta.word_count, 20, "gap marker words are not counted");
    assert.ok(existsSync(join(dir, "chunks")), "cache kept so a re-run retries only the gap");

    // Resume: the re-run asks only for the gap chunk.
    const before = stt.requests.length;
    await worker.transcribeSession(id, { env: envFor(stt.url), convert });
    assert.equal(stt.requests.length - before, 1);
    assert.equal(store.readMeta(id).gaps.length, 0);
  } finally {
    await stt.close();
  }
});

test("suspect chunks are marked in meta, transcript.json and the markdown", async () => {
  const stt = await fakeStt(({ n, seconds }) => ({ json: okBody(seconds, words(10), n < 6 ? 5 : 1.4) }));
  try {
    const id = "t-suspect";
    const dir = makeSession(id, meetingSamples());
    await worker.transcribeSession(id, { env: envFor(stt.url), convert });
    const meta = store.readMeta(id);
    assert.equal(meta.suspect_chunks.length, 1);
    assert.equal(meta.transcriber.suspect, 1);
    const segs = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8"));
    assert.equal(segs[0].suspect, true);
    const md = readFileSync(join(dir, "transcript.md"), "utf8");
    assert.match(md, /\[possible repetition: 0:00 to 0:22\]/);
    assert.match(md, /1 flagged as possible repetition/);
  } finally {
    await stt.close();
  }
});

/** Every file under dir with its sha256. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

test("--retranscribe archives the old set, re-exports where the session says, and changes nothing else", async () => {
  const stt = await fakeStt(({ seconds }) => ({ json: okBody(seconds, words(10)) }));
  const exportDir = mkdtempSync(join(tmpdir(), "mr-export-"));
  try {
    const id = "t-retx";
    const exp = join(exportDir, "2026-01-02-a-renamed-title");
    mkdirSync(exp);
    writeFileSync(join(exp, "transcript.md"), "old export");
    writeFileSync(join(exp, "meta.json"), JSON.stringify({ id: "t-retx" }));
    // The session's own export_path is the target, even with the env unset and a title that no
    // longer slugs to that folder.
    const dir = makeSession(id, meetingSamples(), {
      state: "done", kb_key: "meeting-x", notes: "n", audio_seconds: 70, word_count: 999,
      export_path: join(exp, "transcript.md"),
      gaps: [{ start: 2640, seconds: 240, error: "old" }],
    });
    writeFileSync(join(dir, "transcript.md"), "old md");
    writeFileSync(join(dir, "transcript.json"), "[]");
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "part-011.wav"), "old slice");
    const oldMeta = readFileSync(join(dir, "meta.json"));
    const before = { ...snapshot(dir), ...snapshot(exportDir) };

    const out = await worker.retranscribeSession(id, { env: envFor(stt.url), convert });
    assert.deepEqual(out, { committed: true, gaps: 0 });

    // Archives are byte-identical to what was there before.
    assert.equal(readFileSync(join(dir, "transcript.v1-loop.md"), "utf8"), "old md");
    assert.equal(readFileSync(join(dir, "transcript.v1-loop.json"), "utf8"), "[]");
    assert.deepEqual(readFileSync(join(dir, "meta.v1-loop.json")), oldMeta);
    assert.equal(readFileSync(join(exp, "transcript.v1-loop.md"), "utf8"), "old export");
    assert.equal(JSON.parse(readFileSync(join(exp, "meta.v1-loop.json"), "utf8")).id, "t-retx");
    // Every pre-existing file outside the rewrite set is untouched; nothing is gone.
    const rewritten = new Set([join(dir, "transcript.md"), join(dir, "transcript.json"), join(dir, "meta.json"),
      join(exp, "transcript.md"), join(exp, "meta.json")]);
    const after = { ...snapshot(dir), ...snapshot(exportDir) };
    for (const [p, h] of Object.entries(before)) {
      assert.ok(p in after, `${p} still exists`);
      if (!rewritten.has(p)) assert.equal(after[p], h, `${p} unchanged`);
    }
    assert.match(readFileSync(join(exp, "transcript.md"), "utf8"), /Transcribed with/);
    assert.equal(readdirSync(exportDir).length, 1, "no second export folder");
    const meta = store.readMeta(id);
    assert.equal(meta.kb_key, "meeting-x");
    assert.equal(meta.notes, "n");
    assert.equal(meta.state, "done");
    assert.equal(meta.export_path, join(exp, "transcript.md"));
    assert.deepEqual(meta.gaps, [], "stale gaps from the old run are gone");
    assert.equal(meta.retranscribe, undefined, "progress lives in retranscribe.json, not meta");
    assert.equal(JSON.parse(readFileSync(join(dir, "retranscribe.json"), "utf8")).state, "done");
    assert.equal(meta.previous_transcript.md, join(dir, "transcript.v1-loop.md"));
    assert.equal(meta.previous_transcript.word_count, 999);
    assert.equal(existsSync(join(dir, "retranscribe.lock")), false);

    // A second retranscribe never overwrites v1-loop; the whole set (now with chunks.json) gets one prev label.
    await worker.retranscribeSession(id, { env: envFor(stt.url), convert });
    assert.equal(readFileSync(join(dir, "transcript.v1-loop.md"), "utf8"), "old md");
    const prev = readdirSync(dir).filter((f) => /\.prev-\d{8}T\d{6}Z(-\d+)?\./.test(f));
    const labels = new Set(prev.map((f) => f.split(".")[1]));
    assert.equal(labels.size, 1);
    assert.deepEqual(prev.map((f) => f.split(".")[0]).sort(), ["chunks", "meta", "transcript", "transcript"]);
    assert.ok(readdirSync(exp).some((f) => /^transcript\.prev-.*\.md$/.test(f)));
  } finally {
    await stt.close();
    rmSync(exportDir, { recursive: true, force: true });
  }
});

test("--retranscribe with a gap replaces nothing, and a re-run resumes and commits", async () => {
  let healthy = false;
  const stt = await fakeStt(({ n, seconds }) =>
    (!healthy && n < 3 ? { status: 503 } : { json: okBody(seconds, words(10)) }));
  try {
    const id = "t-retx-gap";
    const dir = makeSession(id, meetingSamples(), { state: "done", word_count: 5 });
    writeFileSync(join(dir, "transcript.md"), "old md");
    writeFileSync(join(dir, "transcript.json"), "[]");
    const metaBefore = readFileSync(join(dir, "meta.json"));
    const out = await worker.retranscribeSession(id, { env: envFor(stt.url), convert });
    assert.deepEqual(out, { committed: false, gaps: 1 });
    assert.equal(readFileSync(join(dir, "transcript.md"), "utf8"), "old md");
    assert.equal(existsSync(join(dir, "transcript.v1-loop.md")), false);
    const meta = store.readMeta(id);
    assert.equal(meta.state, "done", "state is never driven by a retranscribe");
    assert.equal(meta.word_count, 5);
    assert.deepEqual(readFileSync(join(dir, "meta.json")), metaBefore, "meta.json is not touched by an uncommitted run");
    assert.equal(JSON.parse(readFileSync(join(dir, "retranscribe.json"), "utf8")).state, "incomplete");
    assert.ok(existsSync(join(dir, "chunks")));

    healthy = true;
    const before = stt.requests.length;
    const again = await worker.retranscribeSession(id, { env: envFor(stt.url), convert });
    assert.equal(again.committed, true);
    assert.equal(stt.requests.length - before, 1, "only the gap chunk is asked for again");
    assert.equal(readFileSync(join(dir, "transcript.v1-loop.md"), "utf8"), "old md");
    assert.deepEqual(readFileSync(join(dir, "meta.v1-loop.json")), metaBefore, "the archived meta is the original");
  } finally {
    await stt.close();
  }
});

test("a cache made under other settings is moved aside, not reused or deleted", async () => {
  const stt = await fakeStt(({ n, seconds }) => (n < 3 ? { status: 503 } : { json: okBody(seconds, words(10)) }));
  try {
    const id = "t-stale";
    const dir = makeSession(id, meetingSamples());
    await worker.transcribeSession(id, { env: envFor(stt.url), convert });
    assert.ok(existsSync(join(dir, "chunks")));
    const before = stt.requests.length;
    await worker.transcribeSession(id, { env: envFor(stt.url, { WHISPER_VAD_FILTER: "false" }), convert });
    assert.equal(stt.requests.length - before, 3, "every chunk asked again under the new settings");
    assert.ok(readdirSync(dir).some((f) => /^chunks\.stale-/.test(f)));
  } finally {
    await stt.close();
  }
});

test("a session where most chunks fail is failed, not done", async () => {
  const stt = await fakeStt(({ n, seconds }) => (n < 6 ? { status: 503 } : { json: okBody(seconds, words(10)) }));
  try {
    const id = "t-mostly-gaps";
    const dir = makeSession(id, meetingSamples());
    await assert.rejects(worker.transcribeSession(id, { env: envFor(stt.url), convert }), /2 of 3 chunks/);
    const meta = store.readMeta(id);
    assert.equal(meta.state, "failed");
    assert.equal(meta.worker_pid, null);
    assert.equal(existsSync(join(dir, "transcript.md")), false);
    assert.ok(existsSync(join(dir, "chunks")), "the good chunk is kept for a re-run");
  } finally {
    await stt.close();
  }
});

test("an endpoint that never answers stops the run after five chunks", async () => {
  const stt = await fakeStt(() => ({ status: 503 }));
  try {
    const id = "t-dead";
    makeSession(id, pcm([[200, 8000]]));
    await assert.rejects(worker.transcribeSession(id, { env: envFor(stt.url), convert }), /5 chunks in a row/);
    assert.equal(stt.requests.length, 15, "5 chunks x 3 attempts, then stop");
    assert.equal(store.readMeta(id).state, "failed");
  } finally {
    await stt.close();
  }
});

test("a 4xx stops the whole run at once", async () => {
  const stt = await fakeStt(() => ({ status: 404 }));
  try {
    const id = "t-4xx";
    makeSession(id, meetingSamples());
    await assert.rejects(worker.transcribeSession(id, { env: envFor(stt.url), convert }), /404/);
    assert.equal(stt.requests.length, 1);
    assert.equal(store.readMeta(id).state, "failed");
  } finally {
    await stt.close();
  }
});

test("with the primary down, chunks go straight to the fallback and the primary is re-probed", async () => {
  const down = await fakeStt(() => ({ status: 503 }));
  const up = await fakeStt(({ seconds }) => ({ json: okBody(seconds, words(10)) }));
  try {
    const id = "t-breaker";
    makeSession(id, pcm([[400, 8000]])); // 14 chunks of 30 s, the last 10 s
    await worker.transcribeSession(id, {
      env: envFor(down.url, { WHISPER_FALLBACK_URL: up.url, WHISPER_FALLBACK_MODEL: "other/model-b" }), convert });
    const chunks = JSON.parse(readFileSync(join(store.sessionDir(id), "chunks.json"), "utf8"));
    assert.equal(chunks.length, 14);
    assert.ok(chunks.every((c) => c.engine === "fallback"));
    // Chunks 0 and 1 try the primary (3 attempts each); then it is skipped, except one re-probe 10 chunks on.
    assert.equal(down.requests.length, 9);
    assert.equal(up.requests.length, 14);
    const md = readFileSync(join(store.sessionDir(id), "transcript.md"), "utf8");
    assert.match(md, /Transcribed with model-b/);
  } finally {
    await down.close();
    await up.close();
  }
});

test("segment times are clamped to their chunk", async () => {
  const stt = await fakeStt(({ seconds }) => ({ json: { text: "a b", segments: [seg(-1, seconds + 5, "a b")] } }));
  try {
    const id = "t-clamp";
    const dir = makeSession(id, meetingSamples());
    await worker.transcribeSession(id, { env: envFor(stt.url), convert });
    const segs = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8"));
    assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 22.3], [22.3, 48.3], [48.3, 70]]);
  } finally {
    await stt.close();
  }
});

test("config validates the chunk window and keeps today's defaults", () => {
  const c = worker.config({});
  assert.equal(c.endpoints.length, 1);
  assert.equal(c.endpoints[0].url, "http://localhost:8004/v1/audio/transcriptions");
  assert.equal(c.endpoints[0].model, "Systran/faster-whisper-large-v3");
  assert.equal(c.minS, 20);
  assert.equal(c.maxS, 30);
  assert.equal(c.vad, true);
  assert.equal(c.language, "");
  assert.equal(c.timeoutMs, 90000);
  assert.equal(c.attempts, 3);
  const old = worker.config({ WHISPER_SLICE_TIMEOUT_MS: "120000", WHISPER_SLICE_ATTEMPTS: "2" });
  assert.equal(old.timeoutMs, 120000, "the 1.0.0 patch's timeout name still works");
  assert.equal(old.attempts, 2);
  assert.equal(worker.config({ WHISPER_CHUNK_TIMEOUT_MS: "600000" }).timeoutMs, 290000, "kept under undici's 300 s");
  const fb = worker.config({ WHISPER_FALLBACK_URL: "http://127.0.0.1:1/x" });
  assert.equal(fb.endpoints[1].model, "Systran/faster-whisper-large-v3", "fallback model defaults to primary's");
  assert.throws(() => worker.config({ WHISPER_CHUNK_MIN_S: "30", WHISPER_CHUNK_MAX_S: "20" }), /CHUNK/);
  assert.throws(() => worker.config({ WHISPER_CHUNK_TIMEOUT_MS: "soon" }), /WHISPER_CHUNK_TIMEOUT_MS/);
});

// Last: these leave sessions that look busy, which would make other retranscribes refuse.
/** A live process whose command line names transcribe.js, the way a real worker's does. */
function standInWorker() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "transcribe.js"], { stdio: "ignore" });
  child.unref(); // never holds the test runner open, even if an assertion fails before kill()
  return child;
}

test("--retranscribe refuses while anything could be writing the session", async () => {
  const child = standInWorker();
  await new Promise((ok) => child.once("spawn", ok));
  assert.equal(worker.pidAlive(child.pid), true);
  assert.equal(worker.pidAlive(process.pid), false, "a live pid that is not a worker does not count");
  const env = envFor("http://127.0.0.1:9/v1/audio/transcriptions");
  makeSession("t-rec", meetingSamples(), { state: "recording" });
  await assert.rejects(worker.retranscribeSession("t-rec", { env, convert }), /recording/);
  const none = makeSession("t-nopid", meetingSamples(), { state: "transcribing" });
  writeFileSync(join(none, "transcript.md"), "x");
  await assert.rejects(worker.retranscribeSession("t-nopid", { env, convert }), /already running/,
    "transcribing with no pid (a worker that never records one) is treated as running");
  makeSession("t-none", meetingSamples(), { state: "failed" });
  await assert.rejects(worker.retranscribeSession("t-none", { env, convert }), /no transcript/);
  const locked = makeSession("t-locked", meetingSamples(), { state: "done" });
  writeFileSync(join(locked, "transcript.md"), "x");
  writeFileSync(join(locked, "retranscribe.lock"), String(child.pid));
  await assert.rejects(worker.retranscribeSession("t-locked", { env, convert }), /already running/);
  await assert.rejects(worker.transcribeSession("t-locked", { env, convert }), /retranscribe of t-locked is running/,
    "the panel's worker does not start under a live retranscribe");
  assert.equal(store.readMeta("t-locked").state, "done", "and it does not leave the session stuck in transcribing");
  rmSync(join(locked, "retranscribe.lock"));
  const missing = makeSession("t-noexport", meetingSamples(), { state: "done", export_path: "/nonexistent/x/transcript.md" });
  writeFileSync(join(missing, "transcript.md"), "x");
  await assert.rejects(worker.retranscribeSession("t-noexport", { env, convert }), /export folder/);
  // Another session with a live worker blocks it too.
  const otherExp = mkdtempSync(join(tmpdir(), "mr-export-"));
  writeFileSync(join(otherExp, "meta.json"), JSON.stringify({ id: "someone-else" }));
  const theirs = makeSession("t-theirs", meetingSamples(), { state: "done", export_path: join(otherExp, "transcript.md") });
  writeFileSync(join(theirs, "transcript.md"), "x");
  await assert.rejects(worker.retranscribeSession("t-theirs", { env, convert }), /belongs to another session/);
  writeFileSync(join(otherExp, "meta.json"), JSON.stringify({ title: "no id" }));
  await assert.rejects(worker.retranscribeSession("t-theirs", { env, convert }), /belongs to another session/,
    "an export folder that cannot show it is ours is refused");
  rmSync(otherExp, { recursive: true, force: true });
  const run = makeSession("t-run", meetingSamples(), { state: "transcribing", worker_pid: child.pid });
  writeFileSync(join(run, "transcript.md"), "x");
  await assert.rejects(worker.retranscribeSession("t-locked", { env, convert }), /t-run has a live worker/);
  assert.equal(store.readMeta("t-run").state, "transcribing", "a refusal changes nothing");
  assert.equal(existsSync(join(locked, "retranscribe.json")), false, "a refusal writes nothing");
  child.kill();
  for (const id of ["t-rec", "t-nopid", "t-none", "t-locked", "t-noexport", "t-theirs", "t-run"]) {
    rmSync(store.sessionDir(id), { recursive: true, force: true });
  }
});

test("a dead holder's lock is taken over", async () => {
  const stt = await fakeStt(({ seconds }) => ({ json: okBody(seconds, words(10)) }));
  try {
    const dir = makeSession("t-stale-lock", meetingSamples(), { state: "done" });
    writeFileSync(join(dir, "transcript.md"), "x");
    writeFileSync(join(dir, "retranscribe.lock"), "999999999");
    const out = await worker.retranscribeSession("t-stale-lock", { env: envFor(stt.url), convert });
    assert.equal(out.committed, true);
    assert.equal(existsSync(join(dir, "retranscribe.lock")), false);
  } finally {
    await stt.close();
  }
});

test("the CLI runs when reached through a symlink, and rejects bad arguments", () => {
  const real = join(REPO, "bundles", "meeting-recorder", "server");
  const linkDir = mkdtempSync(join(tmpdir(), "mr-link-"));
  symlinkSync(real, join(linkDir, "server"));
  for (const [args, code] of [[[], 2], [["--retranscribe"], 2], [["--allow-gaps", "x"], 2], [["-x"], 2]]) {
    const r = spawnSync(process.execPath, [join(linkDir, "server", "transcribe.js"), ...args], { encoding: "utf8" });
    assert.equal(r.status, code, `exit ${code} for ${JSON.stringify(args)}`);
    assert.match(r.stderr, /usage:/);
  }
  rmSync(linkDir, { recursive: true, force: true });
});

test("a truncated cache file is redone, not fatal", async () => {
  const stt = await fakeStt(({ n, seconds }) => (n < 3 ? { status: 503 } : { json: okBody(seconds, words(10)) }));
  try {
    const id = "t-trunc";
    const dir = makeSession(id, meetingSamples());
    await worker.transcribeSession(id, { env: envFor(stt.url), convert });
    const cached = readdirSync(join(dir, "chunks")).filter((f) => /^c\d{4}-/.test(f));
    assert.equal(cached.length, 2);
    writeFileSync(join(dir, "chunks", cached[0]), "{\"result\": {\"text\": ");
    const before = stt.requests.length;
    await worker.transcribeSession(id, { env: envFor(stt.url), convert });
    assert.equal(stt.requests.length - before, 2, "the gap and the unreadable chunk are asked for again");
    assert.equal(store.readMeta(id).state, "done");
  } finally {
    await stt.close();
  }
});

test("a session exported by the legacy tool (repo_path) is re-exported there", async () => {
  const stt = await fakeStt(({ seconds }) => ({ json: okBody(seconds, words(10)) }));
  const exp = mkdtempSync(join(tmpdir(), "mr-export-"));
  try {
    writeFileSync(join(exp, "transcript.md"), "legacy");
    const dir = makeSession("t-legacy", meetingSamples(), { state: "done", repo_path: join(exp, "transcript.md") });
    writeFileSync(join(dir, "transcript.md"), "x");
    await worker.retranscribeSession("t-legacy", { env: envFor(stt.url), convert });
    assert.equal(readFileSync(join(exp, "transcript.v1-loop.md"), "utf8"), "legacy");
    assert.match(readFileSync(join(exp, "transcript.md"), "utf8"), /Transcribed with/);
  } finally {
    await stt.close();
    rmSync(exp, { recursive: true, force: true });
  }
});

after(() => rmSync(HOME, { recursive: true, force: true }));
