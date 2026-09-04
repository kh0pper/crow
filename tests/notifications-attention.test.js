/**
 * Track 3, Task 8 — the "attention" notification type, end to end.
 *
 * Four independent surfaces, four sections below:
 *
 *   1. The back-fill migration (notification-attention-migration.js):
 *      appends "attention" to an existing explicit
 *      notification_prefs.types_enabled array exactly once across two runs,
 *      and createNotification's gate (servers/shared/notifications.js) drops
 *      an "attention" notification before the back-fill and passes it after.
 *   2. email.js's shouldEmail regression: "attention" is excluded even at
 *      priority=high (the drawer/ntfy/web-push already surface it live);
 *      "system" at priority=high is unaffected. Exercised through the only
 *      observable effect (sendEmailNotification's fetch call), since
 *      shouldEmail itself is a private, unexported predicate — same idiom as
 *      tests/notification-timeouts.test.js's Resend fetch redirection.
 *   3. The perch-interactive engine: a turn-end "<bot> replied" push fires
 *      only when the turn ran >= PERCH_NOTIFY_MIN_RUN_S and no subscriber is
 *      attached; an ask card ALWAYS pushes (blocking event, priority high).
 *      Harness shape mirrors tests/perch-interactive.test.js: real init-db'd
 *      scratch crow.db + injected bridge seam + injected clock/timers.
 *   4. result-service.js: a gated card's result_report always pushes
 *      (blocking event) regardless of outcome. Fixture mirrors
 *      tests/board-plan-result-service.test.js's Task 3 fixture, with
 *      `notifications`/`dashboard_settings` added to cdb so the push is
 *      actually observable instead of silently swallowed.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { createNotification } from "../servers/shared/notifications.js";
import { backfillAttentionNotificationType } from "../servers/gateway/dashboard/settings/migrations/notification-attention-migration.js";
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { createCard } from "../servers/gateway/board/card-service.js";
import { reportResult } from "../servers/gateway/board/result-service.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/* ===========================================================================
 * 1. Back-fill migration + createNotification gate
 * ========================================================================= */

function freshScratchDb(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix + "-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_HOME: dir, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  const db = createDbClient(join(dir, "crow.db"));
  return {
    dir,
    db,
    cleanup() {
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function readNotificationPrefs(db) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'notification_prefs'",
    args: [],
  });
  return rows.length ? JSON.parse(rows[0].value) : null;
}

test("backfillAttentionNotificationType appends 'attention' to an existing types_enabled array exactly once across two runs", async () => {
  const { db, cleanup } = freshScratchDb("notif-attn-backfill");
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value) VALUES ('notification_prefs', ?)",
      args: [JSON.stringify({ types_enabled: ["reminder", "media", "peer", "system"] })],
    });

    const first = await backfillAttentionNotificationType(db);
    assert.equal(first.appended, true, "first run must actually append");

    const afterFirst = await readNotificationPrefs(db);
    assert.deepEqual(afterFirst.types_enabled, ["reminder", "media", "peer", "system", "attention"]);

    const second = await backfillAttentionNotificationType(db);
    assert.equal(second.skipped, "already_migrated", "guard flag must short-circuit the second run");

    const afterSecond = await readNotificationPrefs(db);
    const count = afterSecond.types_enabled.filter((t) => t === "attention").length;
    assert.equal(count, 1, "exactly one 'attention' entry after two runs");
  } finally {
    cleanup();
  }
});

test("backfillAttentionNotificationType is a no-op on a fresh install with no notification_prefs row", async () => {
  const { db, cleanup } = freshScratchDb("notif-attn-fresh");
  try {
    const result = await backfillAttentionNotificationType(db);
    assert.equal(result.appended, false);
    const prefs = await readNotificationPrefs(db);
    assert.equal(prefs, null, "no row was created — the gate's own default already allows every type");
  } finally {
    cleanup();
  }
});

test("createNotification: type 'attention' is dropped by the gate before the back-fill and passes after", async () => {
  const { db, cleanup } = freshScratchDb("notif-attn-gate");
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value) VALUES ('notification_prefs', ?)",
      args: [JSON.stringify({ types_enabled: ["reminder", "media", "peer", "system"] })],
    });

    const before = await createNotification(db, { title: "bot replied", type: "attention" });
    assert.equal(before, null, "an explicit prefs array lacking 'attention' drops the notification");

    await backfillAttentionNotificationType(db);

    const after = await createNotification(db, { title: "bot replied again", type: "attention" });
    assert.ok(after && Number.isInteger(after.id), "after the back-fill, 'attention' passes the gate");

    const { rows } = await db.execute({
      sql: "SELECT type, title FROM notifications WHERE id = ?",
      args: [after.id],
    });
    assert.equal(rows[0].type, "attention");
  } finally {
    cleanup();
  }
});

/* ===========================================================================
 * 2. email.js shouldEmail regression (through sendEmailNotification's fetch)
 * ========================================================================= */

test("shouldEmail: 'attention' at priority=high is excluded; 'system' at priority=high still emails (regression)", async () => {
  const { sendEmailNotification } = await import("../servers/gateway/push/email.js");
  const savedEnv = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    MPA_EMAIL_FROM: process.env.MPA_EMAIL_FROM,
    MPA_EMAIL_TO: process.env.MPA_EMAIL_TO,
  };
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.MPA_EMAIL_FROM = "crow@test.invalid";
  process.env.MPA_EMAIL_TO = "kevin@test.invalid";

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return new Response("{}", { status: 200 });
  };
  try {
    await sendEmailNotification({ title: "bot replied", body: "hi", priority: "high", type: "attention" });
    assert.equal(calls.length, 0, "attention at priority=high must NOT email");

    await sendEmailNotification({ title: "disk full", body: "disk", priority: "high", type: "system" });
    assert.equal(calls.length, 1, "system at priority=high must still email (regression)");
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/* ===========================================================================
 * 3. perch-interactive engine — turn-end threshold gate + ask-card push
 * ========================================================================= */

const engineDir = mkdtempSync(join(tmpdir(), "notif-attn-engine-"));
process.env.CROW_DATA_DIR = engineDir;
process.env.CROW_HOME = join(engineDir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(engineDir, "models.json");

const ENGINE_CROW_HOME = process.env.CROW_HOME;
const ENGINE_DB_FILE = join(engineDir, "crow.db");

let createInteractiveEngine, _resetInteractiveEngineForTest;

function rawEngineDb() {
  return new Database(ENGINE_DB_FILE);
}

function notificationRows() {
  const c = rawEngineDb();
  const rows = c.prepare("SELECT * FROM notifications WHERE type='attention' ORDER BY id ASC").all();
  c.close();
  return rows;
}

function makeClock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    setTimer(fn, ms) { return setTimeout(() => {}, 0) && { fn, at: t + Number(ms) }; },
    clearTimer() {},
    advance(ms) { t += ms; },
  };
}

/** Let queued microtasks + the engine's own async continuations settle. */
const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

let pidSeq = 800000;

function makeBridge() {
  const state = { instances: [] };

  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.turns = [];
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.statsSeq = 0;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() {
      this.statsSeq += 1;
      return { data: { tokens: { input: 10, output: 5, cacheRead: 0 } } };
    }
    promptTurn(message, ms) {
      const rec = { message, ms };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() {}
    async abortSince() { return null; }
    send() {}
    async close() { this.exit(0); }
    exit(code = 0) {
      if (this._exitCode != null) return;
      this._exitCode = code;
      this._done(code);
    }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ") before responding"); }
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
  }

  return {
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { maxPi: 4 },
    countLivePi: () => 0,
    async buildBotWorld(args) {
      return {
        def: { session_dir: join(engineDir, "bots", args.botId), permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId },
        crowHome: ENGINE_CROW_HOME,
        projectId: 7,
        projectSpace: null,
        projectMembers: [],
        sessionDir: join(engineDir, "bots", args.botId),
        tasksDbPath: join(engineDir, "tasks.db"),
        remoteEnabled: false,
        peerGatewayUrls: {},
        session: null,
        narrowedTools: null,
        gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
      const resolved = {
        provider: "crow-local", model: "qwen3.6-35b-a3b", key: "crow-local/qwen3.6-35b-a3b",
        escalated: false, source: "default", escalationRequestedButUnavailable: false,
      };
      return {
        sysFile: join(engineDir, "sys.md"),
        selfAuthoringDir: null,
        resolved,
        piRpcOpts: {
          def: world.def, sessionDir: world.sessionDir, resolved, selfAuthoringDir: null,
          remoteEnabled: world.remoteEnabled, narrowedTools: world.narrowedTools,
          appendSystemPromptFile: join(engineDir, "sys.md"),
        },
      };
    },
    async warmModel() {},
    async meterTurn() { return { recorded: true }; },
    appendAudit() {},
  };
}

function makeEngine(envOverride = {}) {
  const clock = makeClock();
  const bridge = makeBridge();
  const env = Object.assign({ CROW_HOME: ENGINE_CROW_HOME }, envOverride);
  const engine = createInteractiveEngine({
    crowHome: ENGINE_CROW_HOME,
    env,
    bridge,
    now: clock.now,
    setTimer: (fn) => { void fn; return 0; }, // no timer ever fires — irrelevant to these tests
    clearTimer: () => {},
    log: () => {},
  });
  return { engine, clock, bridge };
}

async function spawned(engine, botId) {
  const r = await engine.spawn({ botId });
  await tick();
  return r;
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: engineDir },
    stdio: "pipe",
    cwd: REPO,
  });
  mkdirSync(ENGINE_CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
    providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } },
  }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
});

beforeEach(() => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
});

after(() => {
  try { rmSync(engineDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("turn end: a turn that ran >= PERCH_NOTIFY_MIN_RUN_S with no live subscriber pushes an attention notification with the bird deep link", async () => {
  const { engine, clock, bridge } = makeEngine({ PERCH_NOTIFY_MIN_RUN_S: "30" });
  const s = await spawned(engine, "botty-long");
  await engine.message(s.sessionId, "do it");
  const pi = bridge._state.instances[0];

  clock.advance(35_000); // >= 30s threshold
  pi.lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "all done, boss" }] }],
  });
  await tick();

  const rows = notificationRows();
  const mine = rows.filter((r) => r.action_url === "/dashboard/bot-board#bird=" + s.sessionId);
  assert.equal(mine.length, 1, "exactly one attention push for this session");
  assert.equal(mine[0].priority, "normal");
  assert.equal(mine[0].title, "botty-long replied");
  assert.equal(mine[0].body, "all done, boss");
});

test("turn end: a turn that ran BELOW PERCH_NOTIFY_MIN_RUN_S pushes nothing", async () => {
  const { engine, bridge } = makeEngine({ PERCH_NOTIFY_MIN_RUN_S: "30" });
  const s = await spawned(engine, "botty-quick");
  await engine.message(s.sessionId, "do it fast");
  const pi = bridge._state.instances[0];

  // No clock.advance() — the turn "ran" 0ms, well under the 30s threshold.
  pi.lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "done already" }] }],
  });
  await tick();

  const rows = notificationRows().filter((r) => r.action_url === "/dashboard/bot-board#bird=" + s.sessionId);
  assert.equal(rows.length, 0, "a fast turn must not push");
});

test("turn end: a live subscriber suppresses the push even past the threshold", async () => {
  const { engine, clock, bridge } = makeEngine({ PERCH_NOTIFY_MIN_RUN_S: "30" });
  const s = await spawned(engine, "botty-watched");
  const off = await engine.subscribe(s.sessionId, () => {});
  await engine.message(s.sessionId, "do it");
  const pi = bridge._state.instances[0];

  clock.advance(60_000);
  pi.lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "watched completion" }] }],
  });
  await tick();
  off();

  const rows = notificationRows().filter((r) => r.action_url === "/dashboard/bot-board#bird=" + s.sessionId);
  assert.equal(rows.length, 0, "an operator watching the drawer live is not away — no push");
});

test("ask card: an extension_ui_request ALWAYS pushes high-priority attention with the bird deep link, regardless of a live subscriber", async () => {
  const { engine, bridge } = makeEngine({ PERCH_NOTIFY_MIN_RUN_S: "30" });
  const s = await spawned(engine, "botty-asks");
  await engine.subscribe(s.sessionId, () => {}); // even watched, a blocking event still pushes
  await engine.message(s.sessionId, "ask me something");
  const pi = bridge._state.instances[0];

  pi.emit({ type: "extension_ui_request", id: "req-1", method: "confirm", title: "Delete the file?", message: "This can't be undone." });
  await tick();

  const rows = notificationRows().filter((r) => r.action_url === "/dashboard/bot-board#bird=" + s.sessionId);
  assert.equal(rows.length, 1, "exactly one attention push for the ask card");
  assert.equal(rows[0].priority, "high");
  assert.equal(rows[0].title, "botty-asks needs you");
});

/* ===========================================================================
 * 4. result-service.js — gated card result always pushes
 * ========================================================================= */

const RESULT_MIGRATIONS_DIR = join(REPO, "scripts", "migrations");

function markPriorDone(c) {
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
}

function seedPost0003TasksDb(t) {
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT, stage TEXT,
    board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

function resultFixture() {
  const root = mkdtempSync(join(tmpdir(), "notif-attn-result-"));
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");

  const c = new Database(dbPath);
  markPriorDone(c);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT);
    CREATE TABLE bot_jobs (job_id TEXT PRIMARY KEY, bot_id TEXT, card_id INTEGER, card_action TEXT,
      status TEXT, worker_pid INTEGER, started_at TEXT);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, card_id INTEGER, status TEXT,
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')));
    -- Trimmed notifications + dashboard_settings — just enough for
    -- createNotification's gate + INSERT to be observable in this fixture
    -- (the real schema lives in scripts/init-db.js; the engine tests above
    -- already exercise a full init-db'd DB).
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL DEFAULT 'system', source TEXT,
      title TEXT NOT NULL, body TEXT, priority TEXT DEFAULT 'normal', action_url TEXT, metadata TEXT,
      is_read INTEGER DEFAULT 0, is_dismissed INTEGER DEFAULT 0, snoozed_until TEXT, schedule_id INTEGER,
      expires_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));`);
  c.close();

  const t = new Database(tasksDbPath);
  seedPost0003TasksDb(t);
  t.close();

  return { root, dbPath, tasksDbPath };
}

async function withResultStore(fn) {
  const f = resultFixture();
  try {
    await runMigrations({ migrationsDir: RESULT_MIGRATIONS_DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, sha: "test", log: () => {} });
    const tdb = createDbClient(f.tasksDbPath);
    const cdb = createDbClient(f.dbPath);
    await tdb.execute({
      sql: "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (1,'HasDone',?,?,'[]')",
      args: ['["pending","in_progress","done"]', '["done"]'],
    });
    try {
      await fn({ tdb, cdb });
    } finally {
      tdb.close();
      cdb.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

test("reportResult: a gated card's result ALWAYS pushes a high-priority attention notification with the card deep link", async () => {
  await withResultStore(async ({ tdb, cdb }) => {
    const HUMAN = { kind: "human", id: "kevin", jobId: null };
    const { id: itemId } = await createCard(
      tdb,
      { title: "Ship the thing", status: "pending", project_id: 1, autonomy: "gated" },
      HUMAN,
    );
    const BOT = { kind: "bot", id: "bot-1", jobId: "job-abc" };

    await reportResult(tdb, cdb, itemId, { outcome: "success", summaryMd: "all done" }, BOT);

    const { rows } = await cdb.execute({
      sql: "SELECT * FROM notifications WHERE type='attention'",
      args: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].priority, "high");
    assert.equal(rows[0].action_url, "/dashboard/bot-board#card=" + itemId);
    assert.match(rows[0].title, /Ship the thing/);
  });
});

test("reportResult: an 'auto' card's approved result does NOT push (only 'gated' cards do)", async () => {
  await withResultStore(async ({ tdb, cdb }) => {
    const HUMAN = { kind: "human", id: "kevin", jobId: null };
    const { id: itemId } = await createCard(
      tdb,
      { title: "Auto card", status: "pending", project_id: 1, autonomy: "auto" },
      HUMAN,
    );
    const BOT = { kind: "bot", id: "bot-1", jobId: "job-abc" };

    const result = await reportResult(tdb, cdb, itemId, { outcome: "success" }, BOT);
    assert.equal(result.status, "approved");

    const { rows } = await cdb.execute({ sql: "SELECT * FROM notifications WHERE type='attention'", args: [] });
    assert.equal(rows.length, 0);
  });
});
