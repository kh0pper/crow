/**
 * "A bot that needs you waits for you, and pings you once" (2026-10-20).
 *
 * The perch-interactive engine end to end against a scratch init-db'd crow.db,
 * an injected bridge seam (a fake pi child) and a fake clock whose timers DO
 * fire on advance():
 *
 *   - grouped "needs you": N ask cards in one session make ONE row (count N)
 *     and ONE push; a trailing re-push at most once per window, only while a
 *     card is still pending; a new session or a read row starts a new group;
 *   - expiry from the request's own `timeout` (an older pi-lab that hands the
 *     model a "no" when it fires): the card stops being answerable, the stall
 *     watchdog re-arms, and a late answer is refused as request_expired with
 *     nothing sent to pi;
 *   - the park signal (`crow-state:{"kind":"ask-parked"}`, a newer pi-lab):
 *     the card expires and the turn's aborted end is "parked", not a failure;
 *   - Perch children carry PI_BOT_INTERACTIVE_ASK_TIMEOUT_MS=2147483647;
 *   - waitingOnCard() reports a card whose session is waiting on the operator.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const engineDir = mkdtempSync(join(tmpdir(), "perch-needs-you-"));
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

// ---- grouping -------------------------------------------------------------------

test("the flood: unanswered asks that keep expiring fold into ONE row with the count and every question, one push", async () => {
  const { engine, bridge, clock, pushes } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-group");
  for (let i = 1; i <= 5; i++) {
    // An older pi-lab: every dialog carries its 2-minute timeout and the bot
    // moves on to the next command when it fires.
    pi.emit(confirm("r" + i, "Crow bot wants to run a command", { message: "cmd " + i, timeout: 120000 }));
    await tick();
    await clock.advance(120_000);
  }
  const rs = rows(s.sessionId);
  assert.equal(rs.length, 1, "one in-app row for the session");
  assert.equal(rs[0].title, "bot-group needs you (5)");
  assert.equal(rs[0].priority, "high");
  const meta = JSON.parse(rs[0].metadata);
  assert.equal(meta.group.count, 5);
  assert.deepEqual(meta.group.items.map((x) => x.title), [1, 2, 3, 4, 5].map((i) => "Crow bot wants to run a command: cmd " + i), "no question dropped");
  await clock.advance(600_000);
  assert.equal(pushes.length, 1, "one push for five asks (nothing pending when the window ends)");
});

test("answering closes the group: the next question pushes again", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-answer");
  pi.emit(confirm("a1", "one")); await tick();
  await engine.answer(s.sessionId, "a1", { confirmed: true }); await tick();
  assert.equal(rows(s.sessionId)[0].is_read, 1, "the answered group's row is marked read");
  pi.emit(confirm("a2", "two")); await tick();
  assert.equal(rows(s.sessionId).length, 2);
  assert.equal(pushes.length, 2);
});

test("asks arriving together are serialised: still one row", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-burst");
  pi.emit(confirm("b1", "first"));
  pi.emit(confirm("b2", "second"));
  pi.emit(confirm("b3", "third"));
  await tick(30);
  assert.equal(rows(s.sessionId).length, 1);
  assert.equal(JSON.parse(rows(s.sessionId)[0].metadata).group.count, 3);
  assert.equal(pushes.length, 1);
});

test("trailing re-push: at most once per window, only while a card is still pending", async () => {
  const { engine, bridge, clock, pushes } = makeEngine({ PERCH_ATTENTION_REPUSH_MS: "600000" });
  const { s, pi } = await liveSession(engine, bridge, "bot-repush");
  pi.emit(confirm("p1", "one")); await tick();
  await clock.advance(60_000);
  pi.emit(confirm("p2", "two")); await tick();
  pi.emit(confirm("p3", "three")); await tick();
  assert.equal(pushes.length, 1);
  await clock.advance(540_000);                            // the window ends
  assert.equal(pushes.length, 2, "one trailing push for two more questions");
  assert.match(pushes[1].title, /needs you \(3\)/);
  await clock.advance(600_000);
  assert.equal(pushes.length, 2, "nothing new since: no push");
  pi.emit(confirm("p4", "four")); await tick();             // grows again; window timed from the last push
  await engine.answer(s.sessionId, "p4", { confirmed: true }); await tick();
  await clock.advance(600_000);
  assert.equal(pushes.length, 2, "answered before the window ended: no reminder");
});

test("a read row closes the group: the next ask pushes again", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-read");
  pi.emit(confirm("q1", "one")); await tick();
  const c = new Database(ENGINE_DB_FILE);
  c.prepare("UPDATE notifications SET is_read=1 WHERE action_url=?").run("/dashboard/bot-board#bird=" + s.sessionId);
  c.close();
  await engine.answer(s.sessionId, "q1", { confirmed: true }); await tick();
  pi.emit(confirm("q2", "two")); await tick();
  assert.equal(rows(s.sessionId).length, 2);
  assert.equal(pushes.length, 2);
});

test("two sessions are two groups", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const a = await liveSession(engine, bridge, "bot-two-a");
  const b = await liveSession(engine, bridge, "bot-two-b");
  a.pi.emit(confirm("x", "a")); b.pi.emit(confirm("y", "b")); await tick(30);
  assert.equal(rows(a.s.sessionId).length, 1);
  assert.equal(rows(b.s.sessionId).length, 1);
  assert.equal(pushes.length, 2);
});

// ---- expiry, late answers, parking ----------------------------------------------

test("Perch children get the never-say-no ask timeout", async () => {
  const { engine, bridge } = makeEngine();
  const { pi } = await liveSession(engine, bridge, "bot-env");
  assert.equal(pi.opts.extraEnv.PI_BOT_INTERACTIVE, "1");
  assert.equal(pi.opts.extraEnv.PI_BOT_INTERACTIVE_ASK_TIMEOUT_MS, "2147483647");
});

test("a request's own timeout expires the card; a late answer is refused and sends nothing", async () => {
  const { engine, bridge, clock } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-expire");
  const frames = [];
  await engine.subscribe(s.sessionId, (f) => frames.push(f));
  pi.emit(confirm("e1", "Crow bot wants to run a command", { timeout: 120000 }));
  await tick();
  assert.equal((await engine.get(s.sessionId)).pendingUi.requestId, "e1");
  await clock.advance(120_000);
  const snap = await engine.get(s.sessionId);
  assert.equal(snap.pendingUi.requestId, "e1", "still shown, so the operator sees what was asked");
  assert.equal(snap.pendingUi.expired, true);
  assert.ok(frames.some((f) => f.type === "ask_expired" && f.requestId === "e1"));
  const sentBefore = pi.sent.length;
  await assert.rejects(() => engine.answer(s.sessionId, "e1", { confirmed: true }), (e) => e.code === "request_expired");
  assert.equal(pi.sent.length, sentBefore, "nothing reaches pi for an expired request");
});

test("after expiry the stall watchdog re-arms (a stale card no longer pauses it)", async () => {
  const { engine, bridge, clock } = makeEngine({ PERCH_TURN_STALL_MS: "1000000" });
  const { s, pi } = await liveSession(engine, bridge, "bot-stall");
  pi.emit(confirm("st1", "x", { timeout: 5000 })); await tick();
  const before = clock.pending();
  await clock.advance(5000);
  assert.ok(clock.pending() >= before, "a stall timer is armed again");
  const frames = [];
  await engine.subscribe(s.sessionId, (f) => frames.push(f));
  await clock.advance(1_000_000);
  assert.ok(frames.some((f) => f.type === "error" && /stalled/.test(f.text || "")), "the stall watchdog fired");
});

test("a new message clears the expired card", async () => {
  const { engine, bridge, clock } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-clear");
  pi.emit(confirm("c1", "x", { timeout: 1000 })); await tick();
  await clock.advance(1000);
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
  assert.equal((await engine.get(s.sessionId)).pendingUi.expired, true);
  await engine.message(s.sessionId, "carry on");
  await tick();
  assert.equal((await engine.get(s.sessionId)).pendingUi, null);
});

test("park signal: the card expires and the aborted end is parked, not a failure", async () => {
  const { engine, bridge, clock, pushes } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-park");
  const frames = [];
  await engine.subscribe(s.sessionId, (f) => frames.push(f));
  pi.emit(confirm("k1", "Crow bot wants to run a command")); await tick();
  pi.emit({ type: "extension_ui_request", id: "n1", method: "notify",
    message: 'crow-state:{"kind":"ask-parked","reason":"timeout","title":"Crow bot wants to run a command"}' });
  await tick();
  await clock.advance(60_000);
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" }] });
  await tick();
  assert.ok(!frames.some((f) => f.type === "error"), "no turn-error frame for a parked turn");
  assert.ok(!frames.some((f) => f.type === "reply"), "no reply frame: silent like an abort");
  assert.ok(!pushes.some((p) => /replied/.test(p.title)), "no 'replied' push after a long wait");
  assert.ok(frames.some((f) => f.type === "parked"), "a parked frame tells the clients");
  assert.ok(!pushes.some((p) => /turn failed/.test(p.title)), "no 'turn failed' push");
  const snap = await engine.get(s.sessionId);
  assert.equal(snap.pendingUi.expired, true, "still waiting for you");
  assert.equal(snap.turnInFlight, false);
  await assert.rejects(() => engine.answer(s.sessionId, "k1", { confirmed: true }), (e) => e.code === "request_expired");
});

test("a park signal with no card pending changes nothing", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-park-none");
  pi.emit({ type: "extension_ui_request", id: "n2", method: "notify", message: 'crow-state:{"kind":"ask-parked","reason":"aborted"}' });
  await tick();
  assert.equal((await engine.get(s.sessionId)).pendingUi, null);
});

// ---- the board: a waiting session holds its card ---------------------------------

test("waitingOnCard: true while a card's session has a live or expired question, false otherwise", async () => {
  const { engine, bridge, clock } = makeEngine();
  const s = await engine.spawn({ botId: "bot-card", cardId: 42 });
  await tick();
  const pi = bridge._state.instances[bridge._state.instances.length - 1];
  assert.equal(engine.waitingOnCard(42), false);
  pi.emit(confirm("w1", "x", { timeout: 1000 })); await tick();
  assert.equal(engine.waitingOnCard(42), true);
  assert.equal(engine.waitingOnCard(43), false);
  await clock.advance(1000);
  assert.equal(engine.waitingOnCard(42), true, "an expired question on an awake child still waits for the operator");
  await engine.stop(s.sessionId);
  assert.equal(engine.waitingOnCard(42), false, "a stopped session holds nothing");
});

test("a reconnecting client is replayed the expired card, marked expired", async () => {
  const { engine, bridge, clock } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-replay");
  pi.emit(confirm("rp1", "x", { timeout: 3000 })); await tick();
  await clock.advance(3000);
  const frames = [];
  await engine.subscribe(s.sessionId, (f) => frames.push(f));
  const ask = frames.find((f) => f.type === "ask_user");
  assert.ok(ask && ask.requestId === "rp1" && ask.expired === true);
});

test("abort clears an expired card (and is not refused as no_turn)", async () => {
  const { engine, bridge, clock } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-abort");
  pi.emit(confirm("ab1", "x", { timeout: 3000 })); await tick();
  await clock.advance(3000);
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "moved on" }] }] });
  await tick();
  await engine.abort(s.sessionId);
  await tick();
  assert.equal((await engine.get(s.sessionId)).pendingUi, null);
});

test("a park during a combined-question replay drops the replay", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-dance");
  pi.emit({ type: "extension_ui_request", id: "nq", method: "notify",
    message: "crow-ask:" + JSON.stringify({ id: "q", questions: [{ question: "A?", options: [{ label: "x" }] }, { question: "B?", options: [{ label: "y" }] }] }) });
  await tick();
  pi.emit({ type: "extension_ui_request", id: "sel1", method: "select", title: "A?", options: ["x", "Other\u2026"] });
  await tick();
  await engine.answer(s.sessionId, "sel1", { answers: [{ selected: ["x"] }, { selected: ["y"] }] });
  await tick();
  pi.emit({ type: "extension_ui_request", id: "pk", method: "notify", message: 'crow-state:{"kind":"ask-parked","reason":"aborted"}' });
  await tick();
  const sent = pi.sent.length;
  pi.emit({ type: "extension_ui_request", id: "sel2", method: "select", title: "unrelated", options: ["y", "z"] });
  await tick();
  assert.equal(pi.sent.length, sent, "the dropped replay never auto-answers a later dialog");
  assert.equal((await engine.get(s.sessionId)).pendingUi.requestId, "sel2", "it renders as an ordinary card");
});

test("a park outside a turn is safe", async () => {
  const { engine, bridge } = makeEngine();
  const s = await engine.spawn({ botId: "bot-park-idle" });
  await tick();
  const pi = bridge._state.instances.at(-1);
  pi.emit(confirm("pi1", "x")); await tick();
  pi.emit({ type: "extension_ui_request", id: "pk2", method: "notify", message: 'crow-state:{"kind":"ask-parked","reason":"timeout"}' });
  await tick();
  assert.equal((await engine.get(s.sessionId)).pendingUi.expired, true);
});

test("a turn pi aborted with NO park signal (the operator aborted first) stays silent: no error, no reply, no expired card", async () => {
  const { engine, bridge, pushes } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-abort-nopark");
  const frames = [];
  await engine.subscribe(s.sessionId, (f) => frames.push(f));
  pi.emit(confirm("np1", "Crow bot wants to run a command")); await tick();
  await engine.abort(s.sessionId); await tick();
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Operation aborted" }] });
  await tick();
  assert.ok(!frames.some((f) => f.type === "error" || f.type === "reply"));
  assert.ok(!pushes.some((p) => /failed|replied/.test(p.title)));
  assert.equal((await engine.get(s.sessionId)).pendingUi, null, "an operator abort leaves nothing waiting");
  assert.equal(rows(s.sessionId)[0].is_read, 1, "the abort closes the session's needs-you group");
});

test("an ask_user question aborted by the operator (pi answers 'Question cancelled', no park signal) clears as before", async () => {
  const { engine, bridge } = makeEngine();
  const { s, pi } = await liveSession(engine, bridge, "bot-askuser-abort");
  pi.emit({ type: "extension_ui_request", id: "au1", method: "select", title: "Which file?", options: ["a", "b"] });
  await tick();
  assert.equal((await engine.get(s.sessionId)).pendingUi.requestId, "au1");
  await engine.abort(s.sessionId); await tick();
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Question cancelled" }] }] });
  await tick();
  const snap = await engine.get(s.sessionId);
  assert.equal(snap.pendingUi, null, "no live and no expired card");
  await assert.rejects(() => engine.answer(s.sessionId, "au1", { value: "a" }), (e) => e.code === "no_such_request", "a late answer is refused (not expired: it was cancelled)");
});
