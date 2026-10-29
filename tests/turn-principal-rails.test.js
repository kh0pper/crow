/**
 * Who started the turn (project services, Task 16; plan decision 1, "only my own turns").
 *
 * The rails that decide it, end to end against lane B's ONE predicate (isOwnerTurnScope in
 * servers/shared/turn-principal.js, fed by resolveSignedScope's resolved scope):
 *  - jobs: bot_jobs.principal = 'owner' from exactly the dashboard card dispatch, the dashboard
 *    "Run now" and crow_delegate from an executor created with principal "owner"; the cron and
 *    everything else leave it NULL;
 *  - give-service: dispatchCard / startAfterGive take a REQUIRED principal and pass it to the
 *    engine's spawn and message;
 *  - the Perch engine: spawn/message record the principal with NO default ("other"), only an owner
 *    child is offered service blocks, a turn from anyone else cycles a child holding blocks off them
 *    first, the next owner turn cycles back, and new connections reach a live session (M12);
 *  - channels: Crow messages, Discord and Gmail session turns are never the owner's.
 *
 * Harness: a real init-db'd scratch crow.db (CROW_DATA_DIR), a scratch tasks.db, a fake bridge seam
 * for the engine (the same shape as tests/perch-interactive-dispatch.test.js) with a stub
 * `withServiceBlocks` (Task 18's seam), injected timers. No pi child, gateway or ~/.crow is touched.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "turn-principal-rails-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.PI_MODELS_JSON = join(dir, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const DB_FILE = join(dir, "crow.db");
const TASKS = process.env.CROW_TASKS_DB_PATH;
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PROJECT = 7;
const BOT = "helper";

let createInteractiveEngine, _resetInteractiveEngineForTest, createDbClient, resolveSignedScope, isOwnerTurnScope;
let createToolExecutor, runScheduleNow, tickBotSchedules, give, setStatus;
let server, port;

function raw() { return new Database(DB_FILE); }
function q(sql, ...args) { const c = raw(); try { return c.prepare(sql).all(...args); } finally { c.close(); } }
function run(sql, ...args) { const c = raw(); try { return c.prepare(sql).run(...args); } finally { c.close(); } }
const rowFor = (threadId) => q("SELECT * FROM bot_sessions WHERE gateway_thread_id=? ORDER BY id DESC LIMIT 1", threadId)[0] || null;

let connSeq = 0;
function addConnection(projectId = PROJECT, serviceId = "github") {
  const uuid = "00000000-0000-4000-8000-" + String(++connSeq).padStart(12, "0");
  run("INSERT INTO service_connections (uuid, project_id, service_id, method, account_label, label_slug, status) VALUES (?,?,?,?,?,?, 'active')",
    uuid, projectId, serviceId, "paste_key", "Account " + connSeq, "acct-" + connSeq);
  return uuid;
}

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ---------------------------------------------------------------------------
// fake bridge seam (tests/perch-interactive-dispatch.test.js shape) + Task 18's blocks seam
// ---------------------------------------------------------------------------

let pidSeq = 900000;
function makeBridge({ blocks = true } = {}) {
  const state = { instances: [], blockCalls: [], blocksGate: null };
  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.sent = [];
      this.turns = [];
      this.closed = 0;
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.toolsCsv = "read";
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    promptTurn(message, ms, images) {
      const rec = { message, ms, images };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() {}
    async abortSince() { return null; }
    send(o) { this.sent.push(o); }
    async close() { this.closed += 1; this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited"); }
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
    /** The service block names this child was spawned with (none: []). */
    blockNames() { return Object.keys((this.opts.mcpConfig && this.opts.mcpConfig.mcpServers) || {}); }
  }
  const seam = {
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { maxPi: 8 },
    countLivePi: () => 0,
    async buildBotWorld(args) {
      return {
        def: { session_dir: join(dir, "bots", args.botId), permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId }, crowHome: CROW_HOME, projectId: PROJECT, projectSpace: null, projectMembers: [],
        sessionDir: join(dir, "bots", args.botId), tasksDbPath: TASKS, remoteEnabled: false, peerGatewayUrls: {},
        session: null, narrowedTools: null, gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
      const resolved = { provider: "crow-local", model: "qwen3.6-35b-a3b", key: "crow-local/qwen3.6-35b-a3b", escalated: false, source: "default", escalationRequestedButUnavailable: false };
      return { sysFile: join(dir, "sys.md"), selfAuthoringDir: null, resolved,
        piRpcOpts: { def: world.def, sessionDir: world.sessionDir, resolved, selfAuthoringDir: null, remoteEnabled: false, narrowedTools: world.narrowedTools, appendSystemPromptFile: join(dir, "sys.md") } };
    },
    async warmModel() {},
    async meterTurn() { return { recorded: true }; },
    appendAudit() {},
    planForCard: () => null,
    projectContextBlock: () => "",
    cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo", "done"], terminals: ["done"] }),
    cardText: () => ({ title: "T", description: null }),
  };
  if (blocks) {
    // Task 18's seam, stubbed: one block per active connection of the world's project, only on an owner turn.
    seam.withServiceBlocks = async (world, prep, { scopeRef, ownerTurn }) => {
      state.blockCalls.push({ scopeRef, ownerTurn });
      if (state.blocksGate) await state.blocksGate;
      if (ownerTurn !== true) return { mcpConfig: prep.piRpcOpts.mcpConfig || null, serviceBlocks: {} };
      const conns = q("SELECT uuid FROM service_connections WHERE project_id=? AND status='active' ORDER BY id", world.projectId);
      const mcpServers = {};
      for (const c of conns) mcpServers["github-" + c.uuid.slice(-4)] = { url: "http://127.0.0.1:1/services-tools/" + c.uuid + "/mcp" };
      return { mcpConfig: { mcpServers }, serviceBlocks: conns.length ? { github: Object.keys(mcpServers) } : {} };
    };
  }
  return seam;
}

function makeEngine(o = {}) {
  const bridge = makeBridge(o);
  let seq = 0;
  const timers = new Map();
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME, env: { CROW_HOME }, bridge, log: () => {},
    now: () => 1_700_000_000_000,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  return { engine, state: bridge._state };
}

const endTurn = async (pi) => {
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
};
const live = (st) => st.instances.filter((p) => p._exitCode == null);

/** The resolved session scope the loopback mount would judge, through lane B's resolver. */
async function sessionScope(row) {
  const db = createDbClient();
  try { return await resolveSignedScope(db, { botId: row.bot_id, scopeRef: "s:" + row.id, threadId: row.gateway_thread_id, gatewayType: row.gateway_type }); }
  finally { db.close(); }
}
/** The resolved job scope for a job this process "claimed". */
async function jobScope(jobId, { threadId, gatewayType }) {
  run("UPDATE bot_jobs SET status='running', worker_pid=? WHERE job_id=?", process.pid, jobId);
  const bot = q("SELECT bot_id FROM bot_jobs WHERE job_id=?", jobId)[0].bot_id;
  const db = createDbClient();
  try { return await resolveSignedScope(db, { botId: bot, scopeRef: `j:${jobId}@${process.pid}`, threadId, gatewayType }); }
  finally { db.close(); }
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  mkdirSync(CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } } }));
  run("INSERT INTO project_spaces (id, slug, name) VALUES (?, 'svc-p', 'Services P')", PROJECT);
  const def = JSON.stringify({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } });
  run("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)", BOT, "Helper", def, PROJECT);
  const t = new Database(TASKS);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.prepare("INSERT INTO tasks_items (id, title, project_id, status, assigned_bot) VALUES (501, 'dispatch me', ?, 'pending', ?)").run(PROJECT, BOT);
  t.close();

  ({ createDbClient } = await import("../servers/db.js"));
  ({ resolveSignedScope } = await import("../servers/shared/signed-session.js"));
  ({ isOwnerTurnScope } = await import("../servers/shared/turn-principal.js"));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
  ({ createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js"));
  ({ runScheduleNow } = await import("../servers/gateway/schedule-actions.js"));
  ({ tickBotSchedules } = await import("../scripts/pi-bots/bot_scheduler.mjs"));
  give = await import("../servers/gateway/board/give-service.js");
  ({ _setEngineStatusForTest: setStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));

  const { default: express } = await import("express");
  const { default: boardRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(boardRouter((req, res, next) => next())); // the dashboard's session auth, stubbed
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;
});

beforeEach(() => { if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest(); });

after(() => {
  try { setStatus && setStatus(null); } catch {}
  try { server.closeAllConnections?.(); server.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// owner jobs (rev 4 H2: a job is the owner's exactly when principal = 'owner')
// ---------------------------------------------------------------------------

test("owner jobs: dashboard card dispatch stamps 'owner' and the job's turn is the owner's", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/dashboard/bot-board-api/card/501/execute`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(res.status, 200);
  const { jobId } = await res.json();
  assert.equal(q("SELECT principal FROM bot_jobs WHERE job_id=?", jobId)[0].principal, "owner");
  const actor = await jobScope(jobId, { threadId: "board-card-501", gatewayType: "board" });
  assert.ok(actor, "the running card job resolves");
  assert.equal(isOwnerTurnScope(actor), true);
  run("UPDATE bot_jobs SET status='completed' WHERE job_id=?", jobId);
});

test("owner jobs: dashboard Run now stamps 'owner'; the cron's own job stays NULL and is not the owner's", async () => {
  const goal = JSON.stringify({ goal: "triage", deliver_to: { kind: "poll" } });
  const sid = Number(run("INSERT INTO schedules (task, cron_expression, next_run, enabled, description) VALUES (?, '0 9 * * *', '2000-01-01T00:00:00.000Z', 1, ?)",
    "pipeline:botcron:" + BOT, goal).lastInsertRowid);

  // The cron fires first (the schedule is due): NULL.
  const fired = tickBotSchedules({ log: () => {} });
  assert.ok(fired, "the bot cron ticked");
  const cron = q("SELECT job_id, principal FROM bot_jobs WHERE schedule_id=? ORDER BY rowid", sid);
  assert.equal(cron.length, 1);
  assert.equal(cron[0].principal, null, "a schedule records no creator: never the owner's");
  const cronActor = await jobScope(cron[0].job_id, { threadId: "job-" + cron[0].job_id, gatewayType: "job" });
  assert.ok(cronActor);
  assert.equal(isOwnerTurnScope(cronActor), false);
  run("UPDATE bot_jobs SET status='completed' WHERE job_id=?", cron[0].job_id);

  // The owner presses Run now.
  const db = createDbClient();
  try {
    const r = await runScheduleNow(db, sid, { now: Date.now() });
    assert.equal(r.ok, true);
    assert.ok(r.jobId);
    assert.equal(q("SELECT principal FROM bot_jobs WHERE job_id=?", r.jobId)[0].principal, "owner");
    const actor = await jobScope(r.jobId, { threadId: "job-" + r.jobId, gatewayType: "job" });
    assert.equal(isOwnerTurnScope(actor), true);
    run("UPDATE bot_jobs SET status='completed' WHERE job_id=?", r.jobId);
  } finally { db.close(); }
});

test("owner jobs: crow_delegate stamps 'owner' only from an executor created with principal \"owner\"", async () => {
  const cases = [[{}, null], [{ principal: "other" }, null], [{ principal: "OWNER" }, null], [{ principal: true }, null], [{ principal: "owner" }, "owner"]];
  for (const [opts, want] of cases) {
    const ex = createToolExecutor(opts);
    const { result, isError } = await ex.executeTool("crow_delegate", { goal: "look into it", bot: BOT });
    assert.equal(isError, false, result);
    const { jobId } = JSON.parse(result);
    assert.equal(q("SELECT principal FROM bot_jobs WHERE job_id=?", jobId)[0].principal, want, JSON.stringify(opts));
    run("UPDATE bot_jobs SET status='completed' WHERE job_id=?", jobId);
  }
  // A bound bot's executor (voice, a bot's own turn) never stamps it either.
  const bound = createToolExecutor({ botDef: { bot_id: BOT, display_name: "Helper" } });
  const { jobId } = JSON.parse((await bound.executeTool("crow_delegate", { goal: "again" })).result);
  assert.equal(q("SELECT principal FROM bot_jobs WHERE job_id=?", jobId)[0].principal, null);
  run("UPDATE bot_jobs SET status='completed' WHERE job_id=?", jobId);
});

// ---------------------------------------------------------------------------
// give-service (rev 4 H3)
// ---------------------------------------------------------------------------

test("dispatchCard requires a principal; the given one reaches the engine's spawn and message", async () => {
  const calls = { spawn: [], message: [] };
  const eng = {
    checkCardFree: async () => {},
    spawn: async (a) => { calls.spawn.push(a); return { sessionId: "s1", threadId: "t-1", state: "awake" }; },
    message: async (...a) => { calls.message.push(a); },
  };
  const row = q("SELECT * FROM pi_bot_defs WHERE bot_id=?", BOT)[0];
  const db = createDbClient();
  const ctx = { db, tdb: null };
  try {
    for (const bad of [undefined, null, "", "Owner", "admin"]) {
      await assert.rejects(give.dispatchCard(ctx, { row, getEng: async () => eng, botId: BOT, cardId: 501, note: "", principal: bad }), { code: "principal_required" });
      await assert.rejects(give.startAfterGive(ctx, { row, getEng: async () => eng, botId: BOT, cardId: 501, start: true, note: "", principal: bad }), { code: "principal_required" });
    }
    assert.equal(calls.spawn.length, 0, "a missing principal refuses before any spawn");

    setStatus({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
    for (const principal of ["owner", "other"]) {
      calls.spawn.length = 0; calls.message.length = 0;
      const out = await give.startAfterGive(ctx, { row, getEng: async () => eng, botId: BOT, cardId: 501, start: true, note: "go", principal });
      assert.equal(out.started, true, JSON.stringify(out));
      assert.equal(calls.spawn[0].principal, principal);
      await tick();
      assert.deepEqual(calls.message[0][3], { principal }, "turn 1 carries the same principal");
    }
  } finally {
    setStatus(null);
    db.close();
    if (ctx.tdb) ctx.tdb.close();
  }
});

// ---------------------------------------------------------------------------
// the Perch engine
// ---------------------------------------------------------------------------

test("spawn without a principal records other: no blocks offered, the session is not the owner's", async () => {
  addConnection();
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: BOT });
  await tick();
  assert.equal(state.blockCalls.length, 0, "a non-owner child never asks for blocks");
  assert.deepEqual(state.instances[0].blockNames(), []);
  const row = rowFor(r.threadId);
  assert.equal(engine.sessionServicesLive(row.id), false);
  const actor = await sessionScope(row);
  assert.ok(actor, "the live Perch session resolves");
  assert.equal(isOwnerTurnScope(actor, { engine }), false);
  // An unknown principal is the same as none.
  const r2 = await engine.spawn({ botId: BOT, principal: "Owner" });
  await tick();
  assert.equal(state.blockCalls.length, 0);
  assert.equal(engine.sessionServicesLive(rowFor(r2.threadId).id), false);
  await engine.stop(r.sessionId); await engine.stop(r2.sessionId);
});

test("an owner spawn gets the blocks and the mount sees the owner's turn", async () => {
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: BOT, principal: "owner" });
  await tick();
  assert.equal(state.blockCalls.length, 1);
  assert.equal(state.blockCalls[0].ownerTurn, true);
  assert.ok(state.instances[0].blockNames().length >= 1);
  const row = rowFor(r.threadId);
  assert.equal(engine.sessionServicesLive(row.id), true);
  assert.equal(isOwnerTurnScope(await sessionScope(row), { engine }), true);
  // Fail closed on junk ids.
  for (const bad of [null, undefined, 0, -1, "x", row.id + 100000]) assert.equal(engine.sessionServicesLive(bad), false);
  // A dead child is not live.
  state.instances[0].exit(1);
  await tick();
  assert.equal(engine.sessionServicesLive(row.id), false);
});

test("injected text drops the owner's turn", async () => {
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: BOT, principal: "owner" });
  await tick();
  const row = rowFor(r.threadId);
  assert.equal(engine.sessionServicesLive(row.id), true);
  const first = state.instances[0];

  // Text a bundle injects (artifacts, phone): "other". The child holding blocks is cycled off them first.
  await engine.message(r.sessionId, "x", [], { principal: "other" });
  await tick();
  assert.ok(first._exitCode != null, "the child holding blocks was stopped");
  assert.equal(first.turns.length, 0, "nothing was delivered into the child holding blocks");
  const second = live(state)[0];
  assert.notEqual(second, first);
  assert.deepEqual(second.blockNames(), [], "respawned without blocks");
  assert.equal(second.turns.length, 1, "then the message was delivered");
  assert.equal(engine.sessionServicesLive(row.id), false);
  assert.equal(isOwnerTurnScope(await sessionScope(row), { engine }), false);
  await endTurn(second);

  // The owner's next message cycles back with blocks (the project has active connections).
  await engine.message(r.sessionId, "mine", [], { principal: "owner" });
  await tick();
  const third = live(state)[0];
  assert.notEqual(third, second);
  assert.ok(third.blockNames().length >= 1, "respawned with blocks");
  assert.equal(third.turns.length, 1);
  assert.equal(engine.sessionServicesLive(row.id), true);
  await endTurn(third);

  // No principal at all is "other" too (lane B: no default), the ruling's own case.
  await engine.message(r.sessionId, "x");
  await tick();
  const fourth = live(state)[0];
  assert.notEqual(fourth, third);
  assert.deepEqual(fourth.blockNames(), []);
  assert.equal(engine.sessionServicesLive(row.id), false);
  await endTurn(fourth);

  // An owner turn on a child started for someone else is still not live until it cycles: a cycle
  // that cannot happen leaves the owner without blocks, never anyone else with them.
  await engine.stop(r.sessionId);
});

test("a non-owner message is refused, never delivered, when the child holding blocks cannot be cycled", async () => {
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: BOT, principal: "owner" });
  await tick();
  const pi = state.instances[0];
  // A question card pending without a turn: cycle() refuses (cycle_busy).
  pi.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Go?", message: "Go?" });
  await tick();
  await assert.rejects(engine.message(r.sessionId, "x", [], { principal: "other" }), { code: "cycle_busy" });
  assert.equal(pi._exitCode, null);
  assert.equal(pi.turns.length, 0, "nothing reached the child holding blocks");
  assert.equal(engine.sessionServicesLive(rowFor(r.threadId).id), false, "the session no longer counts as the owner's");
  await engine.stop(r.sessionId);
});

test("new connection reaches a live session", async () => {
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: BOT, principal: "owner" });
  await tick();
  const first = state.instances[0];
  const before = first.blockNames().length;

  // Same connections: an owner message does not cycle.
  await engine.message(r.sessionId, "a", [], { principal: "owner" });
  await tick();
  assert.equal(state.instances.length, 1);
  assert.equal(first.turns.length, 1);
  await endTurn(first);

  // A new active connection: the next owner message cycles exactly once, with the new block.
  addConnection();
  await engine.message(r.sessionId, "b", [], { principal: "owner" });
  await tick();
  assert.equal(state.instances.length, 2, "one cycle");
  const second = state.instances[1];
  assert.equal(second.blockNames().length, before + 1);
  assert.equal(second.turns.length, 1);
  assert.equal(engine.sessionServicesLive(rowFor(r.threadId).id), true);
  await endTurn(second);

  // And no further cycle while nothing changes.
  await engine.message(r.sessionId, "c", [], { principal: "owner" });
  await tick();
  assert.equal(state.instances.length, 2);
  await engine.stop(r.sessionId);
});

test("without the blocks seam nothing cycles and no session is ever live", async () => {
  const { engine, state } = makeEngine({ blocks: false });
  const r = await engine.spawn({ botId: BOT, principal: "owner" });
  await tick();
  const row = rowFor(r.threadId);
  assert.equal(engine.sessionServicesLive(row.id), false);
  await engine.message(r.sessionId, "x", [], { principal: "other" });
  await tick();
  await endTurn(state.instances[0]);
  await engine.message(r.sessionId, "y", [], { principal: "owner" });
  await tick();
  assert.equal(state.instances.length, 1, "no cycle without blocks to give or take");
  await engine.stop(r.sessionId);
});

// ---------------------------------------------------------------------------
// channels (decision 1, decision 9)
// ---------------------------------------------------------------------------

test("channel turns are never the owner's", async () => {
  const { engine } = makeEngine();
  // Even an engine that (wrongly) said yes for every row cannot make a channel session the owner's.
  const yes = { sessionServicesLive: () => true };
  for (const gw of ["crow-messages", "discord", "gmail"]) {
    const thread = gw + "-thread-" + Math.random().toString(36).slice(2);
    const id = Number(run("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, control) VALUES (?,?,?, 'active', 'run')", BOT, gw, thread).lastInsertRowid);
    const row = q("SELECT * FROM bot_sessions WHERE id=?", id)[0];
    const actor = await sessionScope(row);
    assert.ok(actor, gw + " row resolves as a session scope");
    assert.equal(actor.principal, undefined, gw + ": a session scope carries no owner principal");
    assert.equal(engine.sessionServicesLive(id), false, gw + ": the engine never holds it");
    assert.equal(isOwnerTurnScope(actor, { engine }), false, gw);
    assert.equal(isOwnerTurnScope(actor, { engine: yes }), false, gw + " (forged engine answer)");
    assert.equal(isOwnerTurnScope({ ...actor, gatewayType: gw }, { engine: yes }), false);
  }
  // The channels insert no bot_jobs of their own; no job in this database is the owner's unless a
  // dashboard rail above stamped it.
  const owners = q("SELECT source FROM bot_jobs WHERE principal = 'owner'").map((r) => r.source).sort();
  assert.ok(owners.every((s) => ["card", "chat", "schedule"].includes(s)), JSON.stringify(owners));
});
