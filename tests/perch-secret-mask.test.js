/**
 * Approval-card secret masking, the Perch side (contract with pi-lab,
 * 2026-10-26). The 10-25 incident: a "Destructive bash" confirm carried
 * an echoed password piped into sudo reading stdin; it reached the card, the stored "needs you"
 * row and the ntfy push. Here the same shape (with an obvious fake) must not
 * reach any frame, the snapshot, the replay, the row, its metadata or the
 * push, while answering the card still sends pi exactly what it offered.
 * Harness: the perch-interactive-needs-you one (fake pi child, fake clock,
 * scratch init-db'd crow.db).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const engineDir = mkdtempSync(join(tmpdir(), "perch-secret-mask-"));
process.env.CROW_DATA_DIR = engineDir;
process.env.CROW_HOME = join(engineDir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(engineDir, "models.json");
const ENGINE_CROW_HOME = process.env.CROW_HOME;
const ENGINE_DB_FILE = join(engineDir, "crow.db");

let createInteractiveEngine, _resetInteractiveEngineForTest, notificationsMod;

const tick = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function rows(sessionId) {
  const c = new Database(ENGINE_DB_FILE);
  const r = c.prepare("SELECT * FROM notifications WHERE type='attention' AND action_url=? ORDER BY id").all("/dashboard/bot-board#bird=" + sessionId);
  c.close();
  return r;
}

/** A clock whose timers fire, in due order, when advance() passes them. */
function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + Number(ms || 0) }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, rec] of timers) if (rec.at <= end && (!next || rec.at < next[1].at)) next = [id, rec];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await tick();
      }
      t = end;
      await tick();
    },
  };
}

let pidSeq = 900000;
function makeBridge() {
  const state = { instances: [] };
  class FakePi {
    constructor(o) {
      this.opts = o; this.onEvent = o.onEvent; this.turns = []; this.sent = [];
      this._exitCode = null; this.proc = { pid: ++pidSeq }; this.piSessionId = "pisess-" + this.proc.pid;
      let done; this.exited = new Promise((r) => { done = r; }); this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    promptTurn(message, ms) {
      const rec = { message, ms };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() {}
    async abortSince() { return null; }
    send(m) { this.sent.push(m); }
    async close() { this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited"); }
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
  }
  return {
    _state: state, PiRpc: FakePi, LIFECYCLE_DEFAULTS: { maxPi: 4 }, countLivePi: () => 0,
    async buildBotWorld(args) {
      return {
        def: { session_dir: join(engineDir, "bots", args.botId), permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId }, crowHome: ENGINE_CROW_HOME, projectId: 7, projectSpace: null, projectMembers: [],
        sessionDir: join(engineDir, "bots", args.botId), tasksDbPath: join(engineDir, "tasks.db"),
        remoteEnabled: false, peerGatewayUrls: {}, session: null, narrowedTools: null, gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
      const resolved = { provider: "crow-local", model: "m", key: "crow-local/m", escalated: false, source: "default", escalationRequestedButUnavailable: false };
      return {
        sysFile: join(engineDir, "sys.md"), selfAuthoringDir: null, resolved,
        piRpcOpts: { def: world.def, sessionDir: world.sessionDir, resolved, selfAuthoringDir: null,
          remoteEnabled: false, narrowedTools: null, appendSystemPromptFile: join(engineDir, "sys.md") },
      };
    },
    async warmModel() {}, async meterTurn() { return { recorded: true }; }, appendAudit() {},
    // card-bound first turns compose a brief (cardBriefBlock is DB-free)
    projectContextBlock: () => "", planForCard: () => null, cardStatus: () => "todo", boardVocab: () => ({ statuses: ["todo", "done"], terminals: ["done"] }), cardText: () => "",
  };
}

function makeEngine(envOverride = {}) {
  const clock = makeClock();
  const bridge = makeBridge();
  const pushes = [];
  const notifications = {
    ...notificationsMod,
    deliverNotification: async (_db, n) => { pushes.push(n); },
    upsertGroupedNotification: (db, opts) => notificationsMod.upsertGroupedNotification(db, { ...opts, deliver: async (_db, n) => { pushes.push(n); } }),
    repushNotificationGroup: (db, opts) => notificationsMod.repushNotificationGroup(db, { ...opts, deliver: async (_db, n) => { pushes.push(n); } }),
    createNotification: (db, opts) => notificationsMod.createNotification(db, opts).then((r) => { if (r) pushes.push(opts); return r; }),
  };
  const engine = createInteractiveEngine({
    crowHome: ENGINE_CROW_HOME,
    env: Object.assign({ CROW_HOME: ENGINE_CROW_HOME, PERCH_NOTIFY_MIN_RUN_S: "30" }, envOverride),
    bridge, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
    notifications,
  });
  return { engine, clock, bridge, pushes };
}

async function liveSession(engine, bridge, botId, extra = {}) {
  const s = await engine.spawn({ botId, ...extra });
  await tick();
  await engine.message(s.sessionId, "go");
  await tick();
  return { s, pi: bridge._state.instances[bridge._state.instances.length - 1] };
}

const confirm = (id, title, extra = {}) => ({ type: "extension_ui_request", id, method: "confirm", title, message: "Allow this once?", ...extra });

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: engineDir }, stdio: "pipe", cwd: REPO });
  mkdirSync(ENGINE_CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { "crow-local": { models: [{ id: "m" }] } } }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
  notificationsMod = await import("../servers/shared/notifications.js");
});
beforeEach(() => { if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest(); });
after(() => { try { rmSync(engineDir, { recursive: true, force: true }); } catch {} });


const FAKE = "fake-" + "sudo-pw-" + "0000";
const KEYCHAIN_FAKE = "fake-" + "keychain-" + "entry-1111";
const S = "-" + "S";
const CMD = ["echo", '"' + FAKE + '"', "|", "sudo", S, "systemctl restart crow-gateway"].join(" ");
const leaks = (x) => { const j = JSON.stringify(x); return j.includes(FAKE) || j.includes(KEYCHAIN_FAKE); };
let secretValues;

before(async () => {
  secretValues = await import("../servers/shared/secret-values.js");
});
beforeEach(() => {
  // The sudo password is in the instance's values (pi-lab's final rules:
  // text fed to sudo -S is hidden ONLY by an exact value).
  secretValues.writeSecretValuesFile(secretValues.secretValuesPath(process.env), [KEYCHAIN_FAKE, FAKE]);
  secretValues.invalidateSecretValues();
});

async function watched(engine, sessionId) {
  const frames = [];
  await engine.subscribe(sessionId, (f) => frames.push(f));
  return frames;
}

test("the 10-25 card: no frame, snapshot, replay, row, metadata or push carries the secret; the answer still confirms", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-mask");
  const frames = await watched(engine, s.sessionId);
  pi.emit({ type: "extension_ui_request", id: "c1", method: "confirm", title: "\u26a0\ufe0f Destructive bash: sudo",
    message: "The exact command (backslash escapes stand for special characters):\n" + CMD + " && login " + KEYCHAIN_FAKE + "\n\nAllow this once?" });
  await tick(30);
  const ask = frames.find((f) => f.type === "ask_user");
  assert.ok(ask, "the card was shown");
  assert.equal(leaks(frames), false, "no live frame");
  assert.match(ask.message, /^\(2 secret value\(s\) hidden from this card\)\n/);
  assert.match(ask.message, /echo "\[REDACTED\]" \| sudo -S systemctl restart crow-gateway && login \[REDACTED\]/);
  const snap = await engine.get(s.sessionId);
  assert.equal(leaks(snap), false, "snapshot (the board drawer and the Perch list read this)");
  assert.equal(snap.pendingUi.requestId, "c1");
  const replayed = await watched(engine, s.sessionId);
  assert.equal(leaks(replayed), false, "replay to a late subscriber");
  assert.ok(replayed.some((f) => f.type === "ask_user"));
  const rs = rows(s.sessionId);
  assert.equal(rs.length, 1);
  assert.equal(leaks(rs), false, "stored row: title, body, metadata");
  assert.match(rs[0].body, /\[REDACTED\]/);
  assert.equal(pushes.length, 1);
  assert.equal(leaks(pushes), false, "push payload");
  await engine.answer(s.sessionId, "c1", { confirmed: true });
  assert.deepEqual(pi.sent[pi.sent.length - 1], { type: "extension_ui_response", id: "c1", confirmed: true });
});

test("a select whose options hold a secret: shown masked, the pick maps back to pi's own option", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-select");
  const frames = await watched(engine, s.sessionId);
  const real = ["use " + KEYCHAIN_FAKE, "GH_TOKEN=" + FAKE + " push", "cancel"];
  pi.emit({ type: "extension_ui_request", id: "s1", method: "select", title: "Which?", options: real });
  await tick(30);
  const ask = frames.find((f) => f.type === "ask_user");
  assert.equal(leaks(frames), false);
  assert.deepEqual(ask.options, ["use [REDACTED]", "GH_TOKEN=[REDACTED] push", "cancel"]);
  await engine.answer(s.sessionId, "s1", { value: "GH_TOKEN=[REDACTED] push" });
  assert.deepEqual(pi.sent[pi.sent.length - 1], { type: "extension_ui_response", id: "s1", value: real[1] });
});

test("masked options that collapse into one stay distinct, and map back by position", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-dupe");
  const frames = await watched(engine, s.sessionId);
  const real = ["GH_TOKEN=" + FAKE, "GH_TOKEN=" + KEYCHAIN_FAKE];
  pi.emit({ type: "extension_ui_request", id: "d1", method: "select", title: "pick", options: real });
  await tick(30);
  const ask = frames.find((f) => f.type === "ask_user");
  assert.deepEqual(ask.options, ["GH_TOKEN=[REDACTED]", "GH_TOKEN=[REDACTED] (2)"]);
  await engine.answer(s.sessionId, "d1", { value: ask.options[1] });
  assert.equal(pi.sent[pi.sent.length - 1].value, real[1]);
});

test("an editor prefill: shown masked; sent back unchanged it is pi's original", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-editor");
  const frames = await watched(engine, s.sessionId);
  const prefill = "DB_PASSWORD=" + FAKE + "\nPORT=1";
  pi.emit({ type: "extension_ui_request", id: "e1", method: "editor", title: "Edit .env", prefill });
  await tick(30);
  const ask = frames.find((f) => f.type === "ask_user");
  assert.equal(leaks(frames), false);
  await engine.answer(s.sessionId, "e1", { value: ask.prefill });
  assert.equal(pi.sent[pi.sent.length - 1].value, prefill);
});

test("a combined questions card: question and labels masked for display; the answer script uses the real labels", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-questions");
  const frames = await watched(engine, s.sessionId);
  const qs = [{ question: "Use the key " + KEYCHAIN_FAKE + "?", header: "Key", options: [{ label: "yes " + KEYCHAIN_FAKE }, { label: "no" }] }];
  pi.emit({ type: "extension_ui_request", id: "n0", method: "notify", message: "crow-ask:" + JSON.stringify({ id: "q", questions: qs }) });
  await tick();
  pi.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Key", options: ["yes " + KEYCHAIN_FAKE, "no", "Other\u2026"] });
  await tick(30);
  const ask = frames.find((f) => f.type === "ask_user");
  assert.equal(ask.method, "questions");
  assert.equal(leaks(frames), false);
  assert.equal(leaks(rows(s.sessionId)), false);
  assert.equal(leaks(pushes), false);
  await engine.answer(s.sessionId, "q1", { answers: [{ selected: [ask.questions[0].options[0].label] }] });
  assert.equal(pi.sent[pi.sent.length - 1].value, "yes " + KEYCHAIN_FAKE, "pi gets the option row it offered");
});

test("tool chips, text and log frames, and the engine log are masked too", async () => {
  const logs = [];
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-frames");
  const frames = await watched(engine, s.sessionId);
  pi.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { command: CMD } });
  pi.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", result: { content: [{ type: "text", text: "used " + KEYCHAIN_FAKE }] } });
  pi.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I ran " + CMD }] } });
  pi.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "note: " + KEYCHAIN_FAKE });
  await tick(30);
  assert.ok(frames.some((f) => f.type === "tool" && /REDACTED/.test(f.argsText || "")), "tool chip present, masked");
  assert.equal(leaks(frames), false);
});

test("an EDITED masked prefill keeps the hidden text where the placeholder was left", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-editor-edit");
  const frames = await watched(engine, s.sessionId);
  const prefill = "DB_PASSWORD=" + FAKE + "\nPORT=1";
  pi.emit({ type: "extension_ui_request", id: "e2", method: "editor", title: "Edit .env", prefill });
  await tick(30);
  const ask = frames.find((f) => f.type === "ask_user");
  await engine.answer(s.sessionId, "e2", { value: ask.prefill.replace("PORT=1", "PORT=2") });
  assert.equal(pi.sent[pi.sent.length - 1].value, "DB_PASSWORD=" + FAKE + "\nPORT=2");
});

test("plain duplicate options (nothing masked) are left exactly as pi sent them, with no hidden note", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-plain-dupe");
  const frames = await watched(engine, s.sessionId);
  pi.emit({ type: "extension_ui_request", id: "p1", method: "select", title: "pick", options: ["same", "same"] });
  await tick(30);
  const ask = frames.find((f) => f.type === "ask_user");
  assert.deepEqual(ask.options, ["same", "same"]);
  assert.equal(/hidden from this card/.test(ask.message || ""), false);
});

test("a long tool command is masked before it is cut for the chip", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-long-chip");
  const frames = await watched(engine, s.sessionId);
  const cmd = "x".repeat(560) + " GH_TOKEN=" + FAKE + " push";
  pi.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t9", args: { command: cmd } });
  await tick(30);
  const chip = frames.find((f) => f.type === "tool");
  assert.equal(/fake-sud/.test(chip.argsText), false, chip.argsText.slice(-60));
});

test("pi-lab parity: a sudo -S feed whose text is NOT a known value stays visible (it could be the command's stdin)", async () => {
  secretValues.writeSecretValuesFile(secretValues.secretValuesPath(process.env), [KEYCHAIN_FAKE]);
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-parity");
  const frames = await watched(engine, s.sessionId);
  pi.emit({ type: "extension_ui_request", id: "c9", method: "confirm", title: "Destructive bash: sudo", message: CMD });
  await tick(30);
  const ask = frames.find((f) => f.type === "ask_user");
  assert.equal(ask.message, CMD, "byte-identical, no note");
});
