/**
 * Voice hand-off (PR 5, Task 5.5): a handed-off bot that asks the operator a question mid-task sends exactly the
 * existing Perch "needs you" push, and the hand-off rail neither suppresses nor duplicates it. Nothing new is
 * built here; these tests pin the reuse. The real perch-interactive engine against a scratch init-db'd crow.db,
 * a fake pi child and a fake clock, with the hand-off card claimed the way a voice-started session claims it.
 *
 *   - the push is the grouped "<bot id> needs you" attention row, high priority, linking to #bird=<session>;
 *   - the hand-off's turn-end suppression (suppressTurnEndPush) is scoped to the turn whose completion notice
 *     was sent: it never touches a mid-task needs-you, and a later turn pushes as usual;
 *   - a session waiting on the operator is reported as waiting on its card (the 5.3 reconcile reads this and
 *     never calls it quiet; that half is pinned in voice-handoff-status.test.js).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const engineDir = mkdtempSync(join(tmpdir(), "vh-needs-input-"));
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

const confirm = (id, title, extra = {}) => ({ type: "extension_ui_request", id, method: "confirm", title, message: "Allow this once?", ...extra });

let cardSeq = 700;   // the card claim outlives an engine (it is a DB row), so each test gets its own card

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

/** A hand-off session: spawned on its card, its first turn running. */
async function handedOff(engine, bridge) {
  const CARD = ++cardSeq;
  const s = await engine.spawn({ botId: "writer", cardId: CARD });
  await tick();
  await engine.message(s.sessionId, "go");
  await tick();
  const pi = bridge._state.instances[bridge._state.instances.length - 1];
  return { s, pi, CARD };
}

test("a handed-off bot that asks mid-task sends the one grouped needs-you push, linking to the session", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const { s, pi, CARD } = await handedOff(engine, bridge);
  pi.emit(confirm("h1", "Which outline?", { message: "Short or long?" })); await tick();
  const rs = rows(s.sessionId);
  assert.equal(rs.length, 1, "one in-app row");
  assert.equal(rs[0].title, "writer needs you");
  assert.equal(rs[0].priority, "high");
  assert.equal(rs[0].action_url, "/dashboard/bot-board#bird=" + s.sessionId);
  assert.equal(pushes.length, 1, "one push, not a second from the hand-off rail");
  assert.equal(pushes[0].type, "attention");
  assert.equal(pushes[0].action_url, "/dashboard/bot-board#bird=" + s.sessionId);
  assert.equal(engine.waitingOnCard(CARD), true, "the session is waiting on the operator");
});

test("the hand-off's turn-end suppression never suppresses a mid-task needs-you", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const { s, pi, CARD } = await handedOff(engine, bridge);
  // The hand-off rail has marked the running turn (as it does once its completion notice is sent) ...
  assert.equal(engine.suppressTurnEndPush(CARD), true, "a running turn was marked");
  // ... and the bot still asks mid-task: the needs-you push is exactly today's.
  pi.emit(confirm("h2", "Which outline?", { message: "Short or long?" })); await tick();
  assert.equal(rows(s.sessionId).length, 1);
  assert.equal(rows(s.sessionId)[0].title, "writer needs you");
  assert.equal(pushes.length, 1, "the needs-you push went out");
  assert.equal(pushes[0].type, "attention");
});

test("a later question in a suppressed session still pushes, and the suppression does not outlive its turn", async () => {
  const { engine, bridge, clock, pushes } = makeEngine();
  const { s, pi, CARD } = await handedOff(engine, bridge);
  engine.suppressTurnEndPush(CARD);
  await clock.advance(60_000);
  pi.lastTurn().resolve({ text: "done for now" }); await tick();   // the marked turn ends: no "replied" push
  assert.equal(pushes.filter((p) => /replied/.test(p.title)).length, 0, "the marked turn's own replied push is suppressed");
  assert.equal(engine.suppressTurnEndPush(CARD), false, "no running turn: nothing to mark");
  await engine.message(s.sessionId, "carry on"); await tick();
  pi.emit(confirm("h3", "One more thing", { message: "Which tone?" })); await tick();
  assert.equal(rows(s.sessionId).length, 1);
  assert.equal(pushes.length, 1, "the next turn's question pushed");
  await clock.advance(60_000);
  pi.lastTurn().resolve({ text: "second reply" }); await tick();
  assert.equal(pushes.filter((p) => /writer replied/.test(String(p.title))).length, 1, "the next turn pushes its replied as usual");
});
