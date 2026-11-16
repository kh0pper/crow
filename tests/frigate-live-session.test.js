/**
 * The Frigate bundle's live-view manager (server/live-session.js).
 *
 * Why these assertions: a battery doorbell allows one call at a time, so every rule that keeps
 * ffmpeg from becoming a continuous stream is enforced here, not in the browser — one process per
 * camera however many tabs watch, a hard cap timed from the session's start, a kill when the last
 * viewer leaves, no restart after a failure, and a cooldown that a page reload cannot clear. The
 * pictures are framed MJPEG parts, so the tests feed real parts (and split ones) and check that a
 * viewer — however slow — only ever receives whole frames. The URL of the camera's stream is a
 * credential, so the same tests check that no refusal message, error tail or console call ever
 * carries it.
 *
 * Everything runs on fakes — a clone clock with hand-fired timers, a spawner that hands back an
 * EventEmitter, and an injected killGroup — so no process is started and no signal is sent.
 */
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCooldownStore, createLiveManager, scrubUrl } from "../bundles/frigate/server/live-session.js";

const URL = "rtsp://user:pass@example.invalid:8557/front_door_live";
const OTHER_URL = "rtsp://user:pass@example.invalid:8557/side_gate_live";

// Every manager that starts a process installs one process-exit hook and keeps it; this file
// builds a manager per case, so the default warning limit would fire.
process.setMaxListeners(0);

/** A test that cannot finish is a failure, not a stuck suite. */
const test = (name, fn) => nodeTest(name, { timeout: 15_000 }, fn);

// ─── harness ──────────────────────────────────────────────────────────────

/** A clock whose timers only fire when the test advances it. */
function makeClock(start = 1_700_000_000_000) {
  let current = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(fn, ms) {
      const handle = { id: ++seq, fn, at: current + Math.max(0, Number(ms) || 0) };
      timers.set(handle.id, handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle && handle.id != null) timers.delete(handle.id);
    },
    /** Fire every timer due within `ms`, in order, moving the clock as each one comes due. */
    advance(ms) {
      const target = current + Math.max(0, Number(ms) || 0);
      for (let fired = 0; ; fired++) {
        if (fired > 1000) throw new Error("the clock did not settle: timers keep re-arming");
        let next = null;
        for (const handle of timers.values()) {
          if (handle.at > target) continue;
          if (!next || handle.at < next.at || (handle.at === next.at && handle.id < next.id)) next = handle;
        }
        if (!next) break;
        timers.delete(next.id);
        current = next.at;
        next.fn();
      }
      current = target;
    },
    pending: () => [...timers.values()],
  };
}

/** A response shaped the way the manager reads and writes one. */
function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headWritten = null;
  res.headers = {};
  res.chunks = [];
  res.ended = false;
  res.writeOk = true;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headWritten = headers;
  };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.write = (chunk) => {
    res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "latin1"));
    return res.writeOk;
  };
  res.end = () => {
    if (res.ended) return;
    res.ended = true;
    res.emit("close");
    return res;
  };
  /** What a browser tab does when it goes away. */
  res.close = () => res.emit("close");
  return res;
}

/**
 * A stand-in for node's spawn: every call hands back an EventEmitter child and is recorded. The
 * `-version` probe answers on its own; `behavior` says how each kind behaves.
 */
function fakeSpawner() {
  const calls = [];
  const kills = [];
  const behavior = {
    version: "run", // "run" | "missing" | "throw"
    session: "run", // "run" | "missing" | "throw"
  };
  function spawn(cmd, args, opts) {
    const isVersion = Array.isArray(args) && args[0] === "-version";
    const mode = isVersion ? behavior.version : behavior.session;
    const call = { cmd, args, opts, isVersion, child: null };
    calls.push(call);
    if (mode === "throw") throw new Error(`could not run ${cmd}`);
    const child = new EventEmitter();
    child.pid = 5000 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      kills.push({ signal, pid: child.pid, via: "child.kill" });
    };
    call.child = child;
    if (mode === "missing") {
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" })));
    } else if (isVersion) {
      setImmediate(() => child.emit("exit", 0));
    }
    return child;
  }
  return {
    calls,
    kills,
    behavior,
    spawn,
    /** The camera processes, leaving out the `-version` probe. */
    sessions: () => calls.filter((call) => !call.isVersion),
  };
}

function makeManager({ clock = makeClock(), spawner = fakeSpawner(), options = {} } = {}) {
  const manager = createLiveManager({
    sources: { front_door: URL, side_gate: OTHER_URL },
    spawn: spawner.spawn,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    killGroup: (signal, child) => {
      spawner.kills.push({ signal, pid: child ? child.pid : null, via: "group" });
    },
    ...options,
  });
  return { manager, clock, spawner };
}

/** Let the pending setImmediate callbacks (the fake probe, a fake spawn error) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ─── mpjpeg framing ───────────────────────────────────────────────────────

const PART_BOUNDARY = Buffer.from("--ffmpeg\r\n", "latin1");
const PART_HEADER_END = Buffer.from("\r\n\r\n", "latin1");

/** A JPEG-shaped frame: FFD8, filler bytes (never a marker), FFD9. */
function jpegFrame(size = 24) {
  const length = Math.max(4, size);
  const body = Buffer.alloc(length, 0x41);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[length - 2] = 0xff;
  body[length - 1] = 0xd9;
  return body;
}

/** One whole part, framed the way ffmpeg's `-f mpjpeg` muxer frames it. */
function mpjpegPart(jpeg = jpegFrame()) {
  const head = Buffer.from(
    `--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${jpeg.length}\r\n\r\n`,
    "latin1",
  );
  return Buffer.concat([head, jpeg, Buffer.from("\r\n", "latin1")]);
}

/**
 * Read one delivered chunk back as a multipart part and return its JPEG body, failing the test
 * unless the chunk is exactly one whole part: that a viewer never sees a piece of a frame is the
 * whole point of the framing tests below.
 */
function readPart(chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "latin1");
  assert.ok(buffer.subarray(0, PART_BOUNDARY.length).equals(PART_BOUNDARY), "the part starts at a boundary");
  const headerEnd = buffer.indexOf(PART_HEADER_END);
  assert.ok(headerEnd > 0, "the part has a header block");
  const declared = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("latin1"));
  assert.ok(declared, "the part declares its length");
  const length = Number(declared[1]);
  const bodyStart = headerEnd + PART_HEADER_END.length;
  assert.equal(buffer.length, bodyStart + length + 2, "the part holds exactly its body plus a CRLF");
  assert.equal(buffer[bodyStart + length], 0x0d, "the part ends with CRLF");
  assert.equal(buffer[bodyStart + length + 1], 0x0a, "the part ends with CRLF");
  assert.equal(buffer[bodyStart], 0xff, "the frame starts with a JPEG SOI");
  assert.equal(buffer[bodyStart + 1], 0xd8, "the frame starts with a JPEG SOI");
  assert.equal(buffer[bodyStart + length - 2], 0xff, "the frame ends with a JPEG EOI");
  assert.equal(buffer[bodyStart + length - 1], 0xd9, "the frame ends with a JPEG EOI");
  return buffer.subarray(bodyStart, bodyStart + length);
}

/** Record every console call made while `fn` runs, so a leak into the log can be caught. */
function spyConsole() {
  const levels = ["log", "error", "warn", "info", "debug", "trace"];
  const originals = {};
  const calls = [];
  for (const level of levels) {
    originals[level] = console[level];
    console[level] = (...args) => {
      calls.push({ level, args: args.map((arg) => (typeof arg === "string" ? arg : String(arg))) });
    };
  }
  return {
    calls,
    restore() {
      for (const level of levels) console[level] = originals[level];
    },
  };
}

// ─── refusals ─────────────────────────────────────────────────────────────

test("an unknown camera is a 404 and starts nothing at all", async () => {
  const { manager, spawner } = makeManager();
  const res = fakeResponse();
  const result = await manager.attach("back_gate", res);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.match(result.message, /unknown/i);
  assert.equal(spawner.calls.length, 0, "not even the ffmpeg probe");
  assert.equal(res.statusCode, 0, "the response is untouched");
  assert.equal(res.ended, false);
});

test("only own, non-empty, valid-name sources are usable", async () => {
  const { manager } = makeManager({
    options: { sources: { front_door: URL, empty: "", number: 5, "Bad Name": URL } },
  });
  assert.equal(manager.has("front_door"), true);
  for (const name of ["empty", "number", "Bad Name", "missing", "__proto__", "constructor", "", null, undefined, 42]) {
    assert.equal(manager.has(name), false, String(name));
  }
});

test("ffmpeg missing is a 503 every time, the probe is remembered, and nothing crashes", async () => {
  const { manager, spawner } = makeManager();
  spawner.behavior.version = "missing";
  const res = fakeResponse();
  const first = await manager.attach("front_door", res);
  assert.equal(first.ok, false);
  assert.equal(first.status, 503);
  assert.match(first.message, /ffmpeg/);
  assert.equal(res.statusCode, 0, "the response is untouched");
  assert.equal(await manager.available(), false);
  const second = await manager.attach("front_door", fakeResponse());
  assert.equal(second.status, 503);
  assert.equal(spawner.calls.length, 1, "the probe answered once and is kept");
  assert.equal(spawner.sessions().length, 0, "no stream process was started");
});

test("a probe that cannot even be spawned is a 503 too", async () => {
  const { manager, spawner } = makeManager();
  spawner.behavior.version = "throw";
  assert.equal(await manager.available(), false);
  const result = await manager.attach("front_door", fakeResponse());
  assert.equal(result.status, 503);
  assert.equal(spawner.sessions().length, 0);
});

// ─── one process, many viewers ────────────────────────────────────────────

test("the first viewer starts exactly one ffmpeg with the agreed arguments and headers", async () => {
  const { manager, spawner } = makeManager();
  const res = fakeResponse();
  assert.deepEqual(await manager.attach("front_door", res), { ok: true });

  const [probe] = spawner.calls;
  assert.equal(probe.isVersion, true);
  assert.equal(probe.args[0], "-version");

  assert.equal(spawner.sessions().length, 1);
  const call = spawner.sessions()[0];
  assert.equal(call.cmd, "ffmpeg");
  assert.equal(call.opts.detached, true);
  assert.deepEqual(call.opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(call.args, [
    "-hide_banner",
    "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-i", URL,
    "-an",
    "-vf", "fps=5,scale=640:-2",
    "-q:v", "7",
    "-t", "120",
    "-f", "mpjpeg",
    "-boundary_tag", "ffmpeg",
    "pipe:1",
  ]);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.headWritten, {
    "content-type": "multipart/x-mixed-replace; boundary=ffmpeg",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    "x-live-remaining-seconds": "120",
  });

  const frame = jpegFrame(40);
  const part = mpjpegPart(frame);
  call.child.stdout.emit("data", part);
  assert.equal(res.chunks.length, 1, "ffmpeg's pictures reach the viewer");
  assert.ok(readPart(res.chunks[0]).equals(frame), "as one whole, unchanged frame");
});

test("the second and third viewer share the one process, and the fourth is a 429", async () => {
  const { manager, spawner } = makeManager();
  const [first, second, third, fourth] = [fakeResponse(), fakeResponse(), fakeResponse(), fakeResponse()];
  assert.deepEqual(await manager.attach("front_door", first), { ok: true });
  assert.deepEqual(await manager.attach("front_door", second), { ok: true });
  assert.deepEqual(await manager.attach("front_door", third), { ok: true });
  assert.equal(spawner.sessions().length, 1, "one process for all three");

  const refused = await manager.attach("front_door", fourth);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 429);
  assert.equal(fourth.statusCode, 0, "the refused response is untouched");

  const part = mpjpegPart(jpegFrame(30));
  spawner.sessions()[0].child.stdout.emit("data", part);
  for (const res of [first, second, third]) {
    assert.equal(res.chunks.length, 1);
    assert.ok(res.chunks[0].equals(part), "every viewer gets the same whole frame");
  }
  assert.deepEqual(fourth.chunks, []);
});

// ─── whole frames, never pieces of one ───────────────────────────────────

test("a frame split across two chunks reaches the viewer whole", async () => {
  const { manager, spawner } = makeManager();
  const res = fakeResponse();
  await manager.attach("front_door", res);
  const { child } = spawner.sessions()[0];

  const part = mpjpegPart(jpegFrame(40));
  const cut = Math.floor(part.length / 2);
  child.stdout.emit("data", part.subarray(0, cut));
  assert.deepEqual(res.chunks, [], "half a frame is held back, not forwarded");
  child.stdout.emit("data", part.subarray(cut));
  assert.equal(res.chunks.length, 1, "the frame arrives as one write");
  assert.ok(res.chunks[0].equals(part), "and it is exactly the part ffmpeg wrote");
  readPart(res.chunks[0]);

  // Two frames arriving in one read are still handed over one whole frame at a time.
  const firstFrame = mpjpegPart(jpegFrame(20));
  const secondFrame = mpjpegPart(jpegFrame(24));
  child.stdout.emit("data", Buffer.concat([firstFrame, secondFrame]));
  assert.equal(res.chunks.length, 3);
  assert.ok(res.chunks[1].equals(firstFrame));
  assert.ok(res.chunks[2].equals(secondFrame));
});

test("a slow viewer receives whole frames only, and loses frames instead of buffering them", async () => {
  const { manager, spawner } = makeManager();
  const slow = fakeResponse();
  const fast = fakeResponse();
  await manager.attach("front_door", slow);
  await manager.attach("front_door", fast);
  const { child } = spawner.sessions()[0];

  slow.writeOk = false; // "do not send me more until I have drained"
  for (let i = 0; i < 8; i++) {
    const part = mpjpegPart(jpegFrame(30 + i));
    // ffmpeg's pipe hands a frame over in whatever pieces it happened to read.
    const cut = 9 + i;
    child.stdout.emit("data", part.subarray(0, cut));
    child.stdout.emit("data", part.subarray(cut));
  }

  assert.equal(fast.chunks.length, 8, "the fast viewer kept every frame");
  for (const chunk of fast.chunks) readPart(chunk);
  assert.ok(slow.chunks.length >= 1, "the slow viewer got the frame that was in flight");
  assert.ok(slow.chunks.length < 8, "and it did not buffer the rest");
  for (const chunk of slow.chunks) readPart(chunk);

  slow.writeOk = true;
  slow.emit("drain");
  assert.ok(slow.chunks.length > 1, "the frames it had queued arrive once it drains");
  for (const chunk of slow.chunks) readPart(chunk);
});

test("a stuck viewer loses its OLDEST whole frame, never half of one", async () => {
  const { manager, spawner } = makeManager();
  const res = fakeResponse();
  await manager.attach("front_door", res);
  const { child } = spawner.sessions()[0];

  res.writeOk = false;
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const part = mpjpegPart(jpegFrame(20 + i));
    parts.push(part);
    child.stdout.emit("data", part);
  }
  assert.equal(res.chunks.length, 1, "the first frame went into the response and stopped it");

  res.writeOk = true;
  res.emit("drain");
  const queued = res.chunks.slice(1);
  assert.equal(queued.length, 3, "three whole frames were queued while it was stuck");
  for (const chunk of res.chunks) readPart(chunk);
  assert.ok(queued[0].equals(parts[2]), "the oldest queued frame was dropped");
  assert.ok(queued[queued.length - 1].equals(parts[4]), "the newest frame survived");
});

test("a viewer that falls a megabyte behind is disconnected while a fast one carries on", async () => {
  const { manager, spawner } = makeManager();
  const stuck = fakeResponse();
  const fast = fakeResponse();
  await manager.attach("front_door", stuck);
  await manager.attach("front_door", fast);
  const { child } = spawner.sessions()[0];
  assert.equal(manager.remainingMs("front_door"), 120_000, "the session is running to begin with");

  stuck.writeOk = false;
  for (let i = 0; i < 4; i++) child.stdout.emit("data", mpjpegPart(jpegFrame(400 * 1024)));

  assert.equal(stuck.ended, true, "the stuck viewer was hung up");
  assert.equal(stuck.chunks.length, 1, "it only ever got the frame that was in flight");
  readPart(stuck.chunks[0]);

  child.stdout.emit("data", mpjpegPart(jpegFrame(64)));
  assert.equal(fast.chunks.length, 5, "the fast viewer is unaffected");
  for (const chunk of fast.chunks) readPart(chunk);
  assert.ok(manager.remainingMs("front_door") > 0, "the session itself is still running");
});

test("a part larger than the cap ends the session instead of being forwarded", async () => {
  const { manager, spawner } = makeManager();
  const res = fakeResponse();
  await manager.attach("front_door", res);
  const { child } = spawner.sessions()[0];

  const head = Buffer.from("--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: 3000000\r\n\r\n", "latin1");
  child.stdout.emit("data", Buffer.concat([head, jpegFrame(32)]));

  assert.equal(res.ended, true, "the viewer is hung up");
  assert.deepEqual(res.chunks, [], "nothing partial was forwarded");
  assert.match(manager.lastError("front_door"), /larger than/);
  assert.equal((await manager.attach("front_door", fakeResponse())).status, 503, "and it cools down");
});

test("a stream that never yields a whole frame ends the session too", async () => {
  const { manager, spawner } = makeManager();
  const res = fakeResponse();
  await manager.attach("front_door", res);
  const { child } = spawner.sessions()[0];

  const junk = Buffer.alloc(1024 * 1024, 0x41);
  for (let i = 0; i < 5; i++) child.stdout.emit("data", junk);

  assert.equal(res.ended, true);
  assert.deepEqual(res.chunks, []);
  assert.match(manager.lastError("front_door"), /whole frame/);
  assert.deepEqual(spawner.kills.map((kill) => kill.signal), ["SIGTERM"], "the group was killed");
});

test("the session body runs through runDetached, so the host can leave the request's context", async () => {
  const opened = [];
  const { manager, spawner } = makeManager({
    options: {
      runDetached: (fn) => {
        opened.push("detached");
        return fn();
      },
    },
  });
  const res = fakeResponse();
  assert.deepEqual(await manager.attach("front_door", res), { ok: true });
  assert.deepEqual(opened, ["detached"], "startSession's body ran through the hook, once");
  assert.equal(spawner.sessions().length, 1);
  assert.equal(res.statusCode, 200);

  // A second viewer joins the same session; no second body is started.
  assert.deepEqual(await manager.attach("front_door", fakeResponse()), { ok: true });
  assert.equal(opened.length, 1);
  assert.equal(spawner.sessions().length, 1);

  // A camera that is not ours never reaches the hook at all.
  assert.equal((await manager.attach("back_gate", fakeResponse())).status, 404);
  assert.equal(opened.length, 1);
});

// ─── ending a session ─────────────────────────────────────────────────────

test("the last viewer leaving kills the whole group at once, and starts the cooldown", async () => {
  const { manager, spawner } = makeManager();
  const first = fakeResponse();
  const second = fakeResponse();
  await manager.attach("front_door", first);
  await manager.attach("front_door", second);
  const child = spawner.sessions()[0].child;

  first.close();
  assert.deepEqual(spawner.kills, [], "one viewer is still watching");

  second.close();
  assert.deepEqual(spawner.kills.map((kill) => [kill.signal, kill.pid]), [["SIGTERM", child.pid]]);
  const refused = await manager.attach("front_door", fakeResponse());
  assert.equal(refused.status, 503);
  assert.equal(refused.retryAfterSec, 60);
});

test("the cap runs from the session's start, not from the newest viewer", async () => {
  const { manager, clock, spawner } = makeManager();
  const first = fakeResponse();
  await manager.attach("front_door", first);
  const child = spawner.sessions()[0].child;

  clock.advance(60_000);
  const late = fakeResponse();
  assert.deepEqual(await manager.attach("front_door", late), { ok: true });
  assert.equal(spawner.sessions().length, 1, "still the same session");

  clock.advance(59_000);
  assert.deepEqual(spawner.kills, [], "119 s in, the session is still running");
  assert.equal(first.ended, false);
  assert.equal(late.ended, false);

  clock.advance(1_000);
  assert.deepEqual(spawner.kills.map((kill) => kill.signal), ["SIGTERM"], "the cap kills at 120 s from the start");
  assert.equal(first.ended, true, "every viewer response is ended");
  assert.equal(late.ended, true);
  assert.equal(child.pid, spawner.kills[0].pid);
});

test("remainingMs and the stream header report what is left of the cap", async () => {
  const { manager, clock } = makeManager();
  assert.equal(manager.remainingMs("front_door"), 0, "no session, nothing left");
  assert.equal(manager.remainingMs("nobody"), 0);
  assert.equal(manager.remainingMs(null), 0);

  const first = fakeResponse();
  await manager.attach("front_door", first);
  assert.equal(manager.remainingMs("front_door"), 120_000);
  assert.equal(first.headWritten["x-live-remaining-seconds"], "120");

  // A viewer joining in the middle is told what the stream really has left, rounded up.
  clock.advance(90_200);
  assert.equal(manager.remainingMs("front_door"), 29_800);
  const late = fakeResponse();
  assert.deepEqual(await manager.attach("front_door", late), { ok: true });
  assert.equal(late.headWritten["x-live-remaining-seconds"], "30", "a late viewer sees 30 s of a 120 s cap");
  assert.equal(first.headWritten["x-live-remaining-seconds"], "120", "the first viewer was told the full cap");

  clock.advance(29_800);
  assert.equal(manager.remainingMs("front_door"), 0, "the cap ended the session");
});

test("after the end a new attach is refused for the cooldown, then starts a fresh process", async () => {
  const { manager, clock, spawner } = makeManager();
  await manager.attach("front_door", fakeResponse());
  clock.advance(120_000); // the cap fires

  const refused = await manager.attach("front_door", fakeResponse());
  assert.equal(refused.status, 503);
  assert.equal(refused.retryAfterSec, 60);
  assert.match(refused.message, /cool/i);
  assert.equal(spawner.sessions().length, 1);

  clock.advance(59_000);
  const stillRefused = await manager.attach("front_door", fakeResponse());
  assert.equal(stillRefused.status, 503);
  assert.equal(stillRefused.retryAfterSec, 1);

  clock.advance(1_000);
  assert.deepEqual(await manager.attach("front_door", fakeResponse()), { ok: true });
  assert.equal(spawner.sessions().length, 2, "the cooldown expired and a new session started");
});

test("the cooldown survives a reload: a new manager sharing the store refuses the same camera", async () => {
  const clock = makeClock();
  const backing = new Map();
  const store = {
    get: (name) => backing.get(name),
    set: (name, until) => backing.set(name, until),
  };
  const before = makeManager({ clock, options: { cooldownStore: store } });
  const res = fakeResponse();
  await before.manager.attach("front_door", res);
  res.close(); // the last viewer leaves

  const after = makeManager({ clock, options: { cooldownStore: store } });
  const refused = await after.manager.attach("front_door", fakeResponse());
  assert.equal(refused.status, 503);
  assert.equal(refused.retryAfterSec, 60);
  assert.equal(after.spawner.sessions().length, 0, "the fresh manager starts nothing");

  clock.advance(60_000);
  assert.deepEqual(await after.manager.attach("front_door", fakeResponse()), { ok: true });
});

test("a session records its cooldown at START, so a gateway that dies mid-view still cools down", async () => {
  const clock = makeClock();
  const backing = new Map();
  const store = {
    get: (name) => backing.get(name),
    set: (name, until) => backing.set(name, until),
  };
  const running = makeManager({ clock, options: { cooldownStore: store } });
  // A second viewer of the SAME manager still shares the session: the guard is not for this one.
  assert.deepEqual(await running.manager.attach("front_door", fakeResponse()), { ok: true });
  assert.deepEqual(await running.manager.attach("front_door", fakeResponse()), { ok: true });
  assert.equal(running.spawner.sessions().length, 1);
  // The gateway is killed here: the session is never ended, so only the START could have written
  // the cooldown.

  const restarted = makeManager({ clock, options: { cooldownStore: store } });
  const refused = await restarted.manager.attach("front_door", fakeResponse());
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 503);
  assert.match(refused.message, /cool/i);
  assert.equal(refused.retryAfterSec, 180, "the cap plus the cooldown, counted from the start");
  assert.equal(restarted.spawner.sessions().length, 0, "the restarted gateway starts nothing");

  clock.advance(120_000);
  const afterCap = await restarted.manager.attach("front_door", fakeResponse());
  assert.equal(afterCap.status, 503);
  assert.equal(afterCap.retryAfterSec, 60, "and then the ordinary cooldown is left");

  clock.advance(60_000);
  assert.deepEqual(await restarted.manager.attach("front_door", fakeResponse()), { ok: true });
});

test("cooldownLeftMs reports the cooldown in milliseconds", async () => {
  const { manager, clock } = makeManager();
  assert.equal(manager.cooldownLeftMs("front_door"), 0, "no cooldown yet");
  assert.equal(manager.cooldownLeftMs("nobody"), 0);
  assert.equal(manager.cooldownLeftMs(null), 0);

  const res = fakeResponse();
  await manager.attach("front_door", res);
  assert.equal(manager.cooldownLeftMs("front_door"), 180_000, "a running session holds its own guard");

  res.close();
  assert.equal(manager.cooldownLeftMs("front_door"), 60_000);
  clock.advance(20_000);
  assert.equal(manager.cooldownLeftMs("front_door"), 40_000);
  clock.advance(40_000);
  assert.equal(manager.cooldownLeftMs("front_door"), 0, "an expired cooldown is 0, never negative");
});

test("ffmpeg exiting ends every viewer, records a cooldown and never restarts", async () => {
  const { manager, clock, spawner } = makeManager();
  const first = fakeResponse();
  const second = fakeResponse();
  await manager.attach("front_door", first);
  await manager.attach("front_door", second);

  spawner.sessions()[0].child.emit("exit", 1);
  assert.equal(first.ended, true);
  assert.equal(second.ended, true);
  assert.equal(spawner.sessions().length, 1, "no restart");

  clock.advance(1_000);
  const refused = await manager.attach("front_door", fakeResponse());
  assert.equal(refused.status, 503);
  assert.equal(spawner.sessions().length, 1, "still no restart an hour of page reloads later");
});

test("a spawn error after the fact ends the viewers and leaves a readable, scrubbed error", async () => {
  const { manager, spawner } = makeManager();
  spawner.behavior.session = "missing";
  const res = fakeResponse();
  assert.deepEqual(await manager.attach("front_door", res), { ok: true });
  await settle();

  assert.equal(res.ended, true, "the viewer is hung up when the process cannot run");
  assert.match(manager.lastError("front_door"), /ENOENT/);
  assert.equal(manager.lastError("front_door").includes(URL), false);
  assert.equal(spawner.sessions().length, 1, "no retry");
});

test("a spawn that throws starts no session, leaves the response untouched, and cools down", async () => {
  const { manager, spawner } = makeManager();
  spawner.behavior.session = "throw";
  const res = fakeResponse();
  const result = await manager.attach("front_door", res);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(res.statusCode, 0, "the response was never taken over");
  assert.equal(res.ended, false);
  assert.equal(manager.lastError("front_door").includes("rtsp"), false);

  const again = await manager.attach("front_door", fakeResponse());
  assert.equal(again.status, 503);
  assert.equal(again.retryAfterSec, 60);
});

test("a kill is SIGTERM, then SIGKILL two seconds later if the group is still there", async () => {
  const { manager, clock, spawner } = makeManager();
  const res = fakeResponse();
  await manager.attach("front_door", res);
  const child = spawner.sessions()[0].child;
  res.close();
  assert.deepEqual(spawner.kills.map((kill) => kill.signal), ["SIGTERM"]);

  clock.advance(1_999);
  assert.deepEqual(spawner.kills.map((kill) => kill.signal), ["SIGTERM"]);
  clock.advance(1);
  assert.deepEqual(spawner.kills.map((kill) => [kill.signal, kill.pid]), [
    ["SIGTERM", child.pid],
    ["SIGKILL", child.pid],
  ]);
});

test("a group that leaves on SIGTERM is not signalled again", async () => {
  const { manager, clock, spawner } = makeManager();
  const res = fakeResponse();
  await manager.attach("front_door", res);
  const child = spawner.sessions()[0].child;
  res.close();
  child.emit("exit", 0);
  clock.advance(2_000);
  assert.deepEqual(spawner.kills.map((kill) => kill.signal), ["SIGTERM"]);
});

test("stopAll hangs up every viewer of every camera now", async () => {
  const { manager, spawner } = makeManager();
  const first = fakeResponse();
  const second = fakeResponse();
  await manager.attach("front_door", first);
  await manager.attach("side_gate", second);
  assert.equal(spawner.sessions().length, 2);

  manager.stopAll();
  assert.equal(first.ended, true);
  assert.equal(second.ended, true);
  assert.deepEqual(spawner.kills.map((kill) => kill.signal), ["SIGTERM", "SIGTERM"]);

  const refused = await manager.attach("front_door", fakeResponse());
  assert.equal(refused.status, 503);
  assert.equal(refused.retryAfterSec, 60);
});

test("one process-exit handler SIGKILLs every live group and a later spawn adds no second one", async () => {
  const { manager, spawner } = makeManager();
  const handlers = [];
  const realOnce = process.once;
  process.once = function once(event, handler) {
    if (event === "exit") {
      handlers.push(handler);
      return this;
    }
    return realOnce.call(this, event, handler);
  };
  try {
    assert.deepEqual(await manager.attach("front_door", fakeResponse()), { ok: true });
    assert.deepEqual(await manager.attach("side_gate", fakeResponse()), { ok: true });
  } finally {
    delete process.once; // restores the prototype method
  }
  assert.equal(handlers.length, 1, "one handler for the manager's whole life");

  const pids = spawner.sessions().map((call) => call.child.pid);
  handlers[0]();
  assert.deepEqual(spawner.kills.map((kill) => [kill.signal, kill.pid]), [
    ["SIGKILL", pids[0]],
    ["SIGKILL", pids[1]],
  ]);
});

// ─── the URL never leaves ─────────────────────────────────────────────────

test("scrubUrl removes the exact URL, a credentialed URL and a bare user:pass@ fragment", () => {
  assert.equal(scrubUrl(`cannot open ${URL}`, URL), "cannot open <stream-url>");
  assert.equal(scrubUrl(`${URL}: Connection refused`, URL), "<stream-url>: Connection refused");
  assert.equal(scrubUrl("rtsp://someone:secret@example.invalid/x failed", ""), "<stream-url> failed");
  assert.equal(scrubUrl("login user:pass@host:8557 refused", undefined), "login <stream-url> refused");
  assert.equal(scrubUrl("nothing to hide here", URL), "nothing to hide here");
  assert.equal(scrubUrl("", URL), "");
  assert.equal(scrubUrl(null, URL), "");
  assert.equal(scrubUrl(undefined, URL), "");
  assert.equal(scrubUrl(42, URL), "42");
  assert.equal(scrubUrl(`${URL} ${URL}`, URL), "<stream-url> <stream-url>", "every occurrence");
  const awkward = "rtsp://user:p.ss@example.invalid/a?b=1&c=[2]";
  assert.equal(scrubUrl(`see ${awkward} now`, awkward), "see <stream-url> now");

  // The URL's own username and password, on their own, raw and percent-decoded.
  const encoded = "rtsp://ali%40ce:p%40ssw0rd@example.invalid/live";
  assert.equal(scrubUrl("login ali%40ce refused", encoded), "login <stream-url> refused");
  assert.equal(scrubUrl("login ali@ce refused", encoded), "login <stream-url> refused");
  assert.equal(scrubUrl("login p%40ssw0rd refused", encoded), "login <stream-url> refused");
  assert.equal(scrubUrl("login p@ssw0rd refused", encoded), "login <stream-url> refused");

  // A credential shorter than three characters is left alone, so ordinary words survive.
  assert.equal(scrubUrl("ab and cd are short", "rtsp://ab:cd@example.invalid/live"), "ab and cd are short");
  // A url `new URL` cannot parse is still covered by the pattern replacements.
  assert.equal(scrubUrl(`see ${URL} now`, "not a url"), "see <stream-url> now");
});

test("a password straddling the reported window's cut point never survives in lastError", async () => {
  const SECRET_URL = "rtsp://admin:S3cretPassw0rd@example.invalid:8557/front_door_live";
  const password = "S3cretPassw0rd";
  const passwordAt = SECRET_URL.indexOf(password);
  const noise = "just another harmless line of words\n";
  const filler = (length) => {
    let out = "";
    while (out.length < length) out += noise;
    return out.slice(0, Math.max(0, length));
  };

  // The kept raw buffer is 8000 bytes and the reported window is its last 500. By fixing the text
  // that follows the URL, `k` moves the raw buffer's cut point to `k` bytes into the URL, so k from
  // passwordAt walks it through the credential one byte at a time. (The old bug: the window was
  // taken first, so the fragment left at the cut landed inside the reported tail.)
  for (let k = passwordAt; k <= passwordAt + password.length + 1; k++) {
    const { manager, spawner } = makeManager({ options: { sources: { front_door: SECRET_URL } } });
    await manager.attach("front_door", fakeResponse());
    const { child } = spawner.sessions()[0];

    const tailLength = 8000 + k - SECRET_URL.length;
    assert.ok(tailLength > 0, "the layout puts the cut inside the URL");
    child.stderr.emit("data", Buffer.from(filler(4000) + SECRET_URL));
    child.stderr.emit("data", Buffer.from(filler(tailLength)));

    const text = manager.lastError("front_door");
    assert.match(text, /harmless/, `cut ${k}: the window has content`);
    assert.equal(text.includes(SECRET_URL), false, `cut ${k}: the URL leaked`);
    assert.equal(text.includes("@"), false, `cut ${k}: a credential fragment leaked`);
    for (let at = 0; at + 3 <= password.length; at++) {
      const fragment = password.slice(at, at + 3);
      assert.equal(text.includes(fragment), false, `cut ${k}: the fragment "${fragment}" lost`);
    }
  }
});

test("the URL is never echoed in lastError, in a refusal message or in a console call", async () => {
  const { manager, spawner } = makeManager();
  const spy = spyConsole();
  const messages = [];
  try {
    const res = fakeResponse();
    assert.deepEqual(await manager.attach("front_door", res), { ok: true });
    const { child } = spawner.sessions()[0];
    child.stderr.emit("data", Buffer.from(`[rtsp @ 0x1] Could not connect to ${URL}: Connection refused`));
    child.stderr.emit("data", Buffer.from(`retry ${URL} once`));
    child.stderr.emit("data", Buffer.from("then rtsp://someone:secret@example.invalid:8557/x failed"));

    const lastError = manager.lastError("front_door");
    assert.ok(lastError.length > 0, "the failure is readable");
    assert.equal(lastError.includes(URL), false, "the URL is not in lastError");
    assert.equal(lastError.includes("user:pass@"), false, "nor the credential");
    assert.equal(lastError.includes("someone:secret@"), false);
    assert.match(lastError, /<stream-url>/);

    res.close(); // leaves a cooldown behind, whose refusal carries a message
    messages.push(await manager.attach("front_door", fakeResponse()));
    messages.push(await manager.attach("back_gate", fakeResponse()));
    messages.push(await manager.attach("front_door", fakeResponse()));
    for (const result of messages) {
      if (!result.message) continue;
      assert.equal(result.message.includes(URL), false);
      assert.equal(result.message.includes("rtsp://"), false);
      assert.equal(result.message.includes("user:pass@"), false);
    }
  } finally {
    spy.restore();
  }
  for (const call of spy.calls) {
    for (const arg of call.args) {
      assert.equal(arg.includes(URL), false, `console.${call.level} carried the URL`);
      assert.equal(arg.includes("user:pass@"), false, `console.${call.level} carried a credential`);
    }
  }
  assert.equal(manager.lastError("nobody"), "");
});

// ─── the file-backed cooldown store ───────────────────────────────────────

test("a file-backed cooldown store carries a cooldown across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-frigate-live-"));
  try {
    const file = join(dir, "live-cooldown.json");
    const clock = makeClock();
    const store = createFileCooldownStore(file, { now: clock.now });
    const before = makeManager({ clock, options: { cooldownStore: store } });
    const res = fakeResponse();
    await before.manager.attach("front_door", res);
    res.close();

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(typeof onDisk.front_door, "number");
    assert.equal(statSync(file).mode & 0o777, 0o600, "the cooldown file is private");

    // A restarted gateway builds a new store object over the same file.
    const restarted = createFileCooldownStore(file, { now: clock.now });
    assert.ok(restarted.get("front_door") > clock.now());
    const after = makeManager({ clock, options: { cooldownStore: restarted } });
    const refused = await after.manager.attach("front_door", fakeResponse());
    assert.equal(refused.status, 503);
    assert.equal(after.spawner.sessions().length, 0);

    clock.advance(60_000);
    assert.deepEqual(await after.manager.attach("front_door", fakeResponse()), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the file-backed store ignores a corrupt file, an expired entry and a missing path", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-frigate-live-store-"));
  try {
    const file = join(dir, "cooldown.json");
    const clock = makeClock();
    assert.equal(createFileCooldownStore(file, { now: clock.now }).get("front_door"), undefined, "no file, no cooldown");

    writeFileSync(file, "{ this is not json");
    assert.equal(createFileCooldownStore(file, { now: clock.now }).get("front_door"), undefined);

    writeFileSync(file, JSON.stringify({ front_door: clock.now() - 1, side_gate: clock.now() + 30_000, "Bad Name": clock.now() + 30_000 }));
    const store = createFileCooldownStore(file, { now: clock.now });
    assert.equal(store.get("front_door"), undefined, "an expired entry is no cooldown");
    assert.equal(store.get("side_gate"), clock.now() + 30_000);
    assert.equal(store.get("Bad Name"), undefined, "a name that could never be attached is ignored");
    assert.equal(store.get(42), undefined);

    // A write lands next to it atomically and keeps only the live entries.
    store.set("front_door", clock.now() + 10_000);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.front_door, clock.now() + 10_000);
    assert.equal(written.side_gate, clock.now() + 30_000);
    store.set("nope", NaN);
    assert.equal(createFileCooldownStore(file, { now: clock.now }).get("nope"), undefined);

    // A path whose directory does not exist yet is created, and an impossible path never throws.
    const nested = createFileCooldownStore(join(dir, "a", "b", "cooldown.json"), { now: clock.now });
    nested.set("front_door", clock.now() + 5_000);
    assert.equal(nested.get("front_door"), clock.now() + 5_000);

    // A path that cannot be written (its parent is a file) never throws; the in-memory answer
    // survives so the cooldown still holds for this process.
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "a file, not a folder");
    const nowhere = createFileCooldownStore(join(blocked, "cooldown.json"), { now: clock.now });
    assert.doesNotThrow(() => nowhere.set("front_door", clock.now() + 5_000));
    assert.equal(nowhere.get("front_door"), clock.now() + 5_000, "the in-memory answer survives a failed write");

    const disabled = createFileCooldownStore(null, { now: clock.now });
    assert.equal(disabled.get("front_door"), undefined);
    assert.doesNotThrow(() => disabled.set("front_door", 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});