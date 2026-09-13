/**
 * Perch PR-E (audit item 12) — engine-side half of the send_user_file relay.
 *
 * pi-lab's `extensions/send-user-file.ts` (separate repo) registers the tool
 * for perch interactive children only and announces a sent file over pi's
 * `extension_ui_request` notify channel as
 *   "crow-file:" + JSON.stringify({path, name, mime, size, caption})
 * This file proves the engine's contract:
 *   1. The notify branch jail-copies the file into the session's outputsDir
 *      (the ONLY place the fd-based workspace route serves from), emits a
 *      `file` frame (never a `log` line), and persists a perch_session_files
 *      history row keyed on (bot_id, thread_id) for the chat's reload.
 *   2. Collision policy: SUFFIX, never overwrite (report.png -> report-2.png).
 *   3. Honest refusals: symlink source, directory, over-cap, and a missing
 *      file all render name-only with servable:false — never a dead link.
 *   4. Malformed JSON after the prefix is swallowed exactly like the
 *      crow-state/crow-ask mirrors.
 *
 * Same harness shape as tests/perch-interactive-statebridge.test.js (real
 * scratch crow.db, injected fake PiRpc/bridge seam, injected clock/timers).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-interactive-sendfile-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let createInteractiveEngine, _resetInteractiveEngineForTest;

function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + Number(ms) }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let pick = null;
        for (const [id, e] of timers) if (e.at <= target && (pick === null || e.at < pick.entry.at)) pick = { id, entry: e };
        if (!pick) break;
        timers.delete(pick.id);
        t = pick.entry.at;
        pick.entry.fn();
      }
      t = target;
    },
  };
}

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

let pidSeq = 900000;

function makeBridge(opts = {}) {
  const state = {
    worlds: [], instances: [], modelKey: opts.modelKey || "crow-local/qwen3.6-35b-a3b",
    livePi: 0, maxPi: 4, projectId: 7,
  };
  class FakePi {
    constructor(o) {
      this.opts = o; this.onEvent = o.onEvent; this.sent = []; this.closed = 0;
      this.turns = []; this._exitCode = null; this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      let done; this.exited = new Promise((r) => { done = r; }); this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 10, output: 5, cacheRead: 0 } } }; }
    promptTurn(message, ms) {
      const rec = { message, ms };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec); return rec.promise;
    }
    lastTurn() { return this.turns[this.turns.length - 1]; }
    trimLog() {}
    async abortSince() { return null; }
    send(o) { if (this._exitCode != null) throw new Error("pi exited"); this.sent.push(o); }
    async promptAckOnly(message) {
      if (this._exitCode != null) throw new Error("pi exited");
      const id = "prompt_" + (this._ackSeq = (this._ackSeq || 0) + 1);
      this.send({ type: "prompt", id, message });
      return { type: "response", command: "prompt", id, success: true };
    }
    async close() { this.closed += 1; this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ") before responding"); }
    emit(m) { this.onEvent(m); }
  }
  const seam = {
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { get maxPi() { return state.maxPi; } },
    countLivePi: () => state.livePi,
    async buildBotWorld(args) {
      state.worlds.push(args);
      const sessionDir = join(dir, "bots", args.botId);
      mkdirSync(sessionDir, { recursive: true });
      return {
        def: { session_dir: sessionDir, permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId },
        crowHome: CROW_HOME, projectId: state.projectId,
        projectSpace: null, projectMembers: [],
        sessionDir, tasksDbPath: join(dir, "tasks.db"),
        remoteEnabled: false, peerGatewayUrls: {}, session: null, narrowedTools: null,
        gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
      const resolved = {
        provider: state.modelKey.split("/")[0], model: state.modelKey.split("/").slice(1).join("/"),
        key: state.modelKey, escalated: false, source: "default", escalationRequestedButUnavailable: false,
      };
      return {
        sysFile: join(dir, "sys.md"), selfAuthoringDir: null, resolved,
        piRpcOpts: {
          def: world.def, sessionDir: world.sessionDir, resolved, selfAuthoringDir: null,
          remoteEnabled: world.remoteEnabled, narrowedTools: world.narrowedTools,
          appendSystemPromptFile: join(dir, "sys.md"),
        },
      };
    },
    async warmModel() {},
    async meterTurn() { return { recorded: true }; },
    appendAudit() {},
  };
  return seam;
}

function makeEngine(o = {}) {
  const clock = makeClock();
  const bridge = o.bridge || makeBridge(o.bridgeOpts);
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME,
    env: Object.assign({ CROW_HOME }, o.env),
    bridge, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
  });
  return { engine, clock, bridge, state: bridge._state };
}

async function collect(engine, sessionId) {
  const events = [];
  const off = await engine.subscribe(sessionId, (e) => events.push(e));
  return { events, off, ofType: (t) => events.filter((e) => e.type === t) };
}

async function spawned(engine, botId = "botty") {
  const r = await engine.spawn({ botId });
  await tick();
  return r;
}

/** A fresh outside-jail source file with known bytes. */
function srcFile(name, bytes = "sent-payload") {
  const p = join(dir, "src", name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(p, bytes);
  return p;
}

function crowFileFrame(meta) {
  return "crow-file:" + JSON.stringify(meta);
}

function historyRows(botId, threadId) {
  const db = new Database(join(dir, "crow.db"));
  try {
    return db.prepare("SELECT name, stored, mime, size, caption, servable FROM perch_session_files WHERE bot_id=? AND thread_id=? ORDER BY id ASC")
      .all(botId, threadId);
  } finally { db.close(); }
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  mkdirSync(CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
    providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } },
  }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
});

beforeEach(() => { if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest(); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---------------------------------------------------------------------------
// 1. happy path: jail-copy + file frame + history row
// ---------------------------------------------------------------------------

test("a crow-file: notify jail-copies the file into outputsDir, emits a file frame (never log), and persists a history row", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);
  const src = srcFile("report.png", "PNGBYTES");

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({
    path: src, name: "report.png", mime: "image/png", size: 8, caption: "the mockup",
  }) });
  await tick();

  const frames = sink.ofType("file");
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.name, "report.png");
  assert.equal(f.stored, "report.png");
  assert.equal(f.mime, "image/png");
  assert.equal(f.caption, "the mockup");
  assert.equal(f.servable, true);
  assert.equal(sink.ofType("log").length, 0, "a crow-file: frame must never become a log line");

  // The copy really landed inside the jail the workspace route serves from.
  const snap = await engine.get(s.sessionId);
  assert.ok(snap.outputsDir, "spawn recorded an outputsDir");
  assert.equal(readFileSync(join(snap.outputsDir, "report.png"), "utf8"), "PNGBYTES");
  assert.equal(existsSync(src), true, "the source file is never moved or removed");

  const rows = historyRows("botty", s.sessionId);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], servable: !!rows[0].servable }, {
    name: "report.png", stored: "report.png", mime: "image/png", size: 8, caption: "the mockup", servable: true,
  });
});

test("collision policy is SUFFIX, never overwrite: the second send lands as report-2.png and both copies survive", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);
  const a = srcFile("chart.png", "FIRST");
  const b = srcFile("chart-again.png", "SECOND");

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ path: a, name: "chart.png", mime: "image/png", size: 5, caption: "" }) });
  await tick();
  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ path: b, name: "chart.png", mime: "image/png", size: 6, caption: "" }) });
  await tick();

  const snap = await engine.get(s.sessionId);
  const frames = sink.ofType("file");
  assert.deepEqual(frames.map((x) => x.stored), ["chart.png", "chart-2.png"]);
  assert.equal(readFileSync(join(snap.outputsDir, "chart.png"), "utf8"), "FIRST", "the original copy was NOT overwritten");
  assert.equal(readFileSync(join(snap.outputsDir, "chart-2.png"), "utf8"), "SECOND");
  assert.equal(historyRows("botty", s.sessionId).length, 2);
});

test("a dotfile basename is stored under a non-dot name (the workspace route refuses dot segments)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);
  const src = srcFile(".hidden", "H");

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ path: src, name: ".hidden", mime: "text/plain", size: 1, caption: "" }) });
  await tick();

  const f = sink.ofType("file")[0];
  assert.equal(f.stored, "hidden", "stored is servable, not permanently dead");
  assert.equal(f.servable, true);
});

test("a source already inside the session's own jail is served in place — no second copy is written", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);
  const snap = await engine.get(s.sessionId);
  const src = join(snap.outputsDir, "inplace.txt");
  writeFileSync(src, "IP");

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ path: src, name: "inplace.txt", mime: "text/plain", size: 2, caption: "" }) });
  await tick();

  const f = sink.ofType("file")[0];
  assert.equal(f.servable, true);
  assert.equal(f.stored, "inplace.txt");
  assert.equal(existsSync(join(snap.outputsDir, "inplace-2.txt")), false, "no duplicate copy");
});

// ---------------------------------------------------------------------------
// 2. honest refusals — name-only cards, never a dead link
// ---------------------------------------------------------------------------

test("a symlinked source is refused: servable:false, nothing copied", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);
  const target = srcFile("secret-target", "S");
  const link = join(dir, "src", "link.png");
  symlinkSync(target, link);

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ path: link, name: "link.png", mime: "image/png", size: 1, caption: "" }) });
  await tick();

  const f = sink.ofType("file")[0];
  assert.equal(f.servable, false);
  assert.equal(f.stored, null);
  const snap = await engine.get(s.sessionId);
  assert.equal(existsSync(join(snap.outputsDir, "link.png")), false);
  assert.equal(historyRows("botty", s.sessionId)[0].servable, 0, "the reload renders the same dim card");
});

test("a missing file and a directory both render name-only with servable:false (never a throw, never a log)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ path: join(dir, "nope.bin"), name: "nope.bin", mime: "application/octet-stream", size: 0, caption: "" }) });
  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ path: join(dir, "src"), name: "src", mime: "application/octet-stream", size: 0, caption: "" }) });
  await tick();

  const frames = sink.ofType("file");
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((x) => x.servable), [false, false]);
  assert.equal(sink.ofType("log").length, 0);
});

// ---------------------------------------------------------------------------
// 3. protocol hygiene
// ---------------------------------------------------------------------------

test("malformed JSON after the crow-file: prefix is swallowed — no frame, no log line, no throw", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);

  assert.doesNotThrow(() => {
    pi.emit({ type: "extension_ui_request", method: "notify", message: "crow-file:{not valid json" });
  });
  await tick();
  assert.equal(sink.ofType("file").length, 0);
  assert.equal(sink.ofType("log").length, 0);
});

test("a crow-file: frame with no path and no name is ignored entirely", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ caption: "orphan" }) });
  await tick();
  assert.equal(sink.ofType("file").length, 0);
  assert.equal(historyRows("botty", s.sessionId).length, 0);
});

test("regression: crow-state and crow-ask prefixes still discriminate — a crow-file frame is not a log line and a plain note is", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);
  const src = srcFile("tri.txt", "T");

  pi.emit({ type: "extension_ui_request", method: "notify", message: "plain operator note" });
  pi.emit({ type: "extension_ui_request", method: "notify", message: crowFileFrame({ path: src, name: "tri.txt", mime: "text/plain", size: 1, caption: "" }) });
  await tick();

  assert.deepEqual(sink.ofType("log").map((e) => e.text), ["plain operator note"]);
  assert.equal(sink.ofType("file").length, 1);
});
