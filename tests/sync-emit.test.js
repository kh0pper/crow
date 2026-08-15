/**
 * Tests for servers/shared/sync-emit.js — emitOrQueue (stdio-sync-outbox
 * Task 2). Scope: the module's own behavior against a real scratch db —
 * pass-through vs. queue routing, the syncability + eligibility gates, the
 * atomic-batch lamport-equality observable, the cap eviction, and the
 * never-throws contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { ensureSyncTables } from "../servers/shared/sync-stamp.js";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";

// getOrCreateLocalInstanceId() (called internally by emitOrQueue/readSetting)
// reads process.env.CROW_DATA_DIR directly — point it at a scratch dir for
// the whole file so it never touches the real ~/.crow instance-id file.
const instanceIdDir = mkdtempSync(join(tmpdir(), "crow-sync-emit-instanceid-"));
const prevDataDir = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = instanceIdDir;

/** Build a fresh, fully-migrated scratch crow.db and return a client for it. */
function freshDb(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-sync-emit-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  });
  const db = createDbClient(join(dir, "crow.db"));
  return { db, dir };
}

function setGate(db, value) {
  if (value === undefined) {
    return db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: ["sync_deployment_enabled"] });
  }
  return db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: ["sync_deployment_enabled", value],
  });
}

function insertMemory(db, id, lamportTs = 0) {
  return db.execute({
    sql: "INSERT INTO memories (id, content, lamport_ts) VALUES (?, ?, ?)",
    args: [id, `content-${id}`, lamportTs],
  });
}

async function withWarnSpy(fn) {
  const calls = [];
  const orig = console.warn;
  console.warn = (...args) => calls.push(args);
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return calls;
}

// A single shared db for the tests that don't need bulk-row isolation.
const shared = freshDb("shared");
await ensureSyncTables(shared.db); // so even the pass-through test can assert on sync_outbox

test.after(() => {
  shared.db.close();
  rmSync(shared.dir, { recursive: true, force: true });
  if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = prevDataDir;
  rmSync(instanceIdDir, { recursive: true, force: true });
  _setEligibilityForTest(null);
});

// ── live manager pass-through ───────────────────────────────────────────

test("live manager (feedsDisabled === false): pass-through verbatim, no queue side effects", async () => {
  const calls = [];
  const manager = {
    feedsDisabled: false,
    async emitChange(table, op, row, opts) {
      calls.push({ table, op, row, opts });
      return 4242;
    },
  };
  const row = { id: 1, content: "x" };
  const result = await emitOrQueue(manager, shared.db, "memories", "update", row, { foo: "bar" });

  assert.equal(result, 4242, "must return the manager's result verbatim");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { table: "memories", op: "update", row, opts: { foo: "bar" } });

  const { rows } = await shared.db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
  assert.equal(Number(rows[0]?.n ?? 0), 0, "live-manager pass-through must not touch the outbox");
});

// ── feedsDisabled manager and no-manager both route to the queue door ──

test("a feedsDisabled manager COUNTS AS NO MANAGER — routes to queue, never calls its emitChange", async () => {
  await ensureSyncTables(shared.db);
  _setEligibilityForTest(() => true);
  const spy = { calls: 0 };
  const manager = {
    feedsDisabled: true,
    async emitChange() {
      spy.calls += 1;
      return null; // what the real feedsDisabled emitChange would return
    },
  };
  await insertMemory(shared.db, 101);
  const result = await emitOrQueue(manager, shared.db, "memories", "update", { id: 101, content: "y" });

  assert.equal(spy.calls, 0, "the feedsDisabled manager's own emitChange must never be called");
  assert.ok(result && result.queued === true, "must have queued instead of silently dropping");
  _setEligibilityForTest(null);
});

// ── queue path: atomicity observable + exactly one batch call ──────────

test("queue path: row-stamp and outbox row carry the SAME lamport, minted inside exactly ONE db.batch() call", async () => {
  await ensureSyncTables(shared.db);
  _setEligibilityForTest(() => true);
  await insertMemory(shared.db, 202);

  const rawBatch = shared.db.batch.bind(shared.db);
  const batchCalls = [];
  shared.db.batch = async (stmts) => {
    batchCalls.push(stmts);
    return rawBatch(stmts);
  };
  try {
    const result = await emitOrQueue(null, shared.db, "memories", "update", { id: 202, content: "z" });
    assert.ok(result && result.queued === true);
    assert.equal(typeof result.lamport, "number");

    // Fault-injection observable: a crash between logical steps is
    // unobservable because it's one batch — assert exactly one call, and
    // that it carried every statement (seed, bump, stamp, insert = 4).
    assert.equal(batchCalls.length, 1, "emitOrQueue must issue exactly one db.batch() call");
    assert.equal(batchCalls[0].length, 4, "the single batch call must carry all four statements");

    const { rows: memRows } = await shared.db.execute({
      sql: "SELECT lamport_ts FROM memories WHERE id = ?",
      args: [202],
    });
    const { rows: outboxRows } = await shared.db.execute(
      "SELECT lamport_ts, row_json FROM sync_outbox ORDER BY id DESC LIMIT 1",
    );

    assert.equal(Number(memRows[0].lamport_ts), result.lamport, "stamped row lamport must equal the returned lamport");
    assert.equal(
      Number(outboxRows[0].lamport_ts),
      result.lamport,
      "outbox row lamport must equal the returned lamport (atomicity observable)",
    );
    assert.deepEqual(JSON.parse(outboxRows[0].row_json), { id: 202, content: "z" });
  } finally {
    shared.db.batch = rawBatch;
    _setEligibilityForTest(null);
  }
});

test("queue path: delete op skips the row-stamp statement — batch carries 3, not 4", async () => {
  await ensureSyncTables(shared.db);
  _setEligibilityForTest(() => true);

  const rawBatch = shared.db.batch.bind(shared.db);
  const batchCalls = [];
  shared.db.batch = async (stmts) => {
    batchCalls.push(stmts);
    return rawBatch(stmts);
  };
  try {
    const result = await emitOrQueue(null, shared.db, "memories", "delete", { id: 606 });
    assert.ok(result && result.queued === true);
    assert.equal(batchCalls.length, 1);
    assert.equal(batchCalls[0].length, 3, "delete must skip the row-stamp statement (seed, bump, insert)");

    const { rows: outboxRows } = await shared.db.execute(
      "SELECT op, row_json, lamport_ts FROM sync_outbox ORDER BY id DESC LIMIT 1",
    );
    assert.equal(outboxRows[0].op, "delete");
    assert.deepEqual(JSON.parse(outboxRows[0].row_json), { id: 606 });
    assert.equal(Number(outboxRows[0].lamport_ts), result.lamport);
  } finally {
    shared.db.batch = rawBatch;
    _setEligibilityForTest(null);
  }
});

// ── syncability parity gate ─────────────────────────────────────────────

test("not-syncable: a table outside SYNCED_TABLES returns null and never touches the outbox", async () => {
  await ensureSyncTables(shared.db);
  _setEligibilityForTest(() => true);
  const { rows: before } = await shared.db.execute("SELECT COUNT(*) AS n FROM sync_outbox");

  const result = await emitOrQueue(null, shared.db, "mcp_sessions", "insert", { id: 999 });

  assert.equal(result, null);
  const { rows: after } = await shared.db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
  assert.equal(Number(after[0].n), Number(before[0].n), "no outbox row must have been added");
  _setEligibilityForTest(null);
});

// ── eligibility gate ─────────────────────────────────────────────────────

test("eligibility gate: setting '0' drops — no row, no stamp, no outbox insert", async () => {
  await ensureSyncTables(shared.db);
  await setGate(shared.db, "0");
  await insertMemory(shared.db, 303, 0);
  const { rows: before } = await shared.db.execute("SELECT COUNT(*) AS n FROM sync_outbox");

  const result = await emitOrQueue(null, shared.db, "memories", "update", { id: 303, content: "w" });

  assert.equal(result, null);
  const { rows: memRows } = await shared.db.execute({
    sql: "SELECT lamport_ts FROM memories WHERE id = ?",
    args: [303],
  });
  assert.equal(Number(memRows[0].lamport_ts), 0, "row must not have been stamped");
  const { rows: after } = await shared.db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
  assert.equal(Number(after[0].n), Number(before[0].n), "no outbox row must have been added");
});

test("eligibility gate: setting unset + process env disabled → real fallback drops", async () => {
  await ensureSyncTables(shared.db);
  await setGate(shared.db, undefined); // ensure unset
  const prevEnv = process.env.CROW_DISABLE_INSTANCE_SYNC;
  process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
  await insertMemory(shared.db, 404, 0);
  const { rows: before } = await shared.db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
  try {
    const result = await emitOrQueue(null, shared.db, "memories", "update", { id: 404, content: "v" });
    assert.equal(result, null);
  } finally {
    if (prevEnv === undefined) delete process.env.CROW_DISABLE_INSTANCE_SYNC;
    else process.env.CROW_DISABLE_INSTANCE_SYNC = prevEnv;
  }
  const { rows: after } = await shared.db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
  assert.equal(Number(after[0].n), Number(before[0].n), "no outbox row must have been added");
});

// ── never throws ─────────────────────────────────────────────────────────

test("a throwing db never throws out of emitOrQueue — returns null", async () => {
  _setEligibilityForTest(() => true);
  const throwingDb = {
    async execute() { throw new Error("db unavailable"); },
    async batch() { throw new Error("db unavailable"); },
    async executeMultiple() { throw new Error("db unavailable"); },
  };
  const result = await emitOrQueue(null, throwingDb, "memories", "update", { id: 1, content: "x" });
  assert.equal(result, null);
  _setEligibilityForTest(null);
});

// ── cap eviction ─────────────────────────────────────────────────────────

test("cap: at >= 10000 queued rows, drop-oldest NULLs the evicted source row's lamport_ts and warns", async () => {
  const { db, dir } = freshDb("cap");
  try {
    await ensureSyncTables(db);
    _setEligibilityForTest(() => true);

    // Bulk-seed exactly 10000 dummy outbox rows via a single recursive-CTE
    // INSERT (fast) — row n=1 (oldest by id ASC) references memories.id=1.
    await db.execute(`
      WITH RECURSIVE seq(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM seq WHERE n < 10000
      )
      INSERT INTO sync_outbox (table_name, op, row_json, lamport_ts)
      SELECT 'memories', 'update', json_object('id', n), n FROM seq;
    `);
    const { rows: seeded } = await db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
    assert.equal(Number(seeded[0].n), 10000);

    await insertMemory(db, 1, 555); // the victim's source row — nonzero so NULL is observable
    await insertMemory(db, 2, 0); // the row we're about to actually queue

    const warnCalls = await withWarnSpy(async () => {
      const result = await emitOrQueue(null, db, "memories", "update", { id: 2, content: "new" });
      assert.ok(result && result.queued === true);
    });

    assert.ok(
      warnCalls.some((args) => String(args[0]).includes("sync_outbox cap") && String(args[0]).includes("10000")),
      "must warn loudly about the cap drop",
    );

    const { rows: countRows } = await db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
    assert.equal(Number(countRows[0].n), 10000, "one evicted + one inserted nets back to the cap");

    const { rows: oldestAfter } = await db.execute(
      "SELECT row_json FROM sync_outbox ORDER BY id ASC LIMIT 1",
    );
    assert.notDeepEqual(
      JSON.parse(oldestAfter[0].row_json),
      { id: 1 },
      "the id=1 dummy row (oldest) must have been evicted",
    );

    const { rows: victimRow } = await db.execute({
      sql: "SELECT lamport_ts FROM memories WHERE id = ?",
      args: [1],
    });
    assert.equal(victimRow[0].lamport_ts, null, "the evicted row's source lamport_ts must be NULLed");
  } finally {
    _setEligibilityForTest(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
