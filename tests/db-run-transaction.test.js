/**
 * servers/db.js `runTransaction` — ONE synchronous transaction on the handle.
 *
 * The History API's restore depends on this contract: a read → compare → write →
 * version-id must be uninterruptible on a SHARED connection. A better-sqlite3
 * handle is one connection, so a statement another caller issues while a
 * transaction is open does not queue behind it — it joins it, and then commits or
 * rolls back with it. `runTransaction` runs the whole callback inside a single
 * `db.transaction(...).immediate()`, so there is no await for that to happen in.
 *
 * The second test states the hazard deliberately (the shape `execute` +
 * BEGIN/COMMIT across awaits has): it is the reason `runTransaction` exists, and
 * the shape the restore used before it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDbClient } from "../servers/db.js";
import { run as migrate } from "../scripts/migrations/0024-item-versions.mjs";
import { withWriteContext } from "../servers/shared/history/write-context.js";

const REPO = new URL("..", import.meta.url).pathname;

/** A bare scratch store with one table: enough for the transaction contract. */
function bareFixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    async open() {
      const db = createDbClient(join(dir, "scratch.db"));
      await db.executeMultiple("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
      return db;
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A real crow.db (init-db.js) with migration 0024, for the attribution test. */
function historyFixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
    cwd: REPO,
    stdio: "pipe",
  });
  const dbPath = join(dir, "crow.db");
  migrate({ dbPath, log: () => {} });
  return {
    async open() {
      return createDbClient(dbPath);
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const count = async (db, value) =>
  Number(
    (
      await db.execute({
        sql: "SELECT COUNT(*) AS n FROM t WHERE v = ?",
        args: [value],
      })
    ).rows[0].n,
  );

test("runTransaction runs a read → compare → write as one step and returns the callback's value", async () => {
  const fx = bareFixture("db-txn-");
  const db = await fx.open();
  try {
    await db.execute({ sql: "INSERT INTO t (v) VALUES ('before')", args: [] });

    const outcome = await db.runTransaction((run) => {
      const { rows } = run({ sql: "SELECT id, v FROM t ORDER BY id LIMIT 1", args: [] });
      assert.equal(rows[0].v, "before", "the read sees the committed row");
      const written = run({ sql: "UPDATE t SET v = 'after' WHERE id = ?", args: [rows[0].id] });
      assert.equal(written.rowsAffected, 1, "a write comes back libsql-shaped");
      return run({ sql: "SELECT v FROM t WHERE id = ?", args: [rows[0].id] }).rows[0].v;
    });

    assert.equal(outcome, "after", "the read inside the callback sees the write");
    assert.equal((await count(db, "after")), 1, "and the transaction committed");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a throw inside runTransaction rolls the whole transaction back", async () => {
  const fx = bareFixture("db-txn-rollback-");
  const db = await fx.open();
  try {
    await assert.rejects(
      () =>
        db.runTransaction((run) => {
          run({ sql: "INSERT INTO t (v) VALUES ('inside')", args: [] });
          throw new Error("the caller gave up");
        }),
      /the caller gave up/,
    );
    assert.equal(await count(db, "inside"), 0, "the write in the failed transaction is gone");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a write from another caller cannot join a runTransaction's transaction", async () => {
  const fx = bareFixture("db-txn-join-");
  const db = await fx.open();
  try {
    // Issued in the SAME tick, before the transaction's promise is awaited: the
    // transaction undoes everything it wrote, and this write must not be part of
    // it. (With a transaction held across an await it would be — see the next
    // test.)
    const rolledBack = db
      .runTransaction((run) => {
        run({ sql: "INSERT INTO t (v) VALUES ('inside')", args: [] });
        throw new Error("the caller changed its mind");
      })
      .catch(() => "rolled back");
    const concurrent = db.execute({ sql: "INSERT INTO t (v) VALUES ('concurrent')", args: [] });

    assert.equal(await rolledBack, "rolled back");
    await concurrent;
    assert.equal(await count(db, "inside"), 0, "the transaction's own write was rolled back");
    assert.equal(await count(db, "concurrent"), 1, "the other caller's write committed on its own");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a transaction held across an await lets another write join it (the hazard runTransaction removes)", async () => {
  const fx = bareFixture("db-txn-hazard-");
  const db = await fx.open();
  try {
    await db.execute("BEGIN IMMEDIATE");
    await db.execute({ sql: "INSERT INTO t (v) VALUES ('inside')", args: [] });
    const concurrent = db.execute({ sql: "INSERT INTO t (v) VALUES ('joined')", args: [] });
    await db.execute("ROLLBACK");
    await concurrent;

    assert.equal(await count(db, "inside"), 0);
    assert.equal(
      await count(db, "joined"),
      0,
      "the unrelated write was executed INSIDE the open transaction and rolled back with it",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a write context stamps the versions a runTransaction's writes create", async () => {
  const fx = historyFixture("db-txn-stamp-");
  const db = await fx.open();
  try {
    const bot = { authorKind: "bot", authorId: "hank", jobId: "card:9" };
    const id = await withWriteContext(bot, () =>
      db.runTransaction((run) => Number(run({ sql: "INSERT INTO memories (content) VALUES ('stamped')", args: [] }).lastInsertRowid)),
    );

    const { rows } = await db.execute({
      sql: `SELECT author_kind, author_id, job_id FROM item_versions
             WHERE item_type = 'memory' AND item_id = ?`,
      args: [String(id)],
    });
    assert.equal(rows.length, 1, "the capture trigger recorded the write");
    assert.equal(rows[0].author_kind, "bot");
    assert.equal(rows[0].author_id, "hank");
    assert.equal(rows[0].job_id, "card:9", "attribution follows execute, inside the transaction");

    // And with no context the write stays unattributed, exactly as a plain
    // execute would leave it.
    const plain = await db.runTransaction((run) => Number(run({ sql: "INSERT INTO memories (content) VALUES ('plain')", args: [] }).lastInsertRowid));
    const plainVersion = await db.execute({
      sql: `SELECT author_kind FROM item_versions WHERE item_type = 'memory' AND item_id = ?`,
      args: [String(plain)],
    });
    assert.equal(plainVersion.rows[0].author_kind, "unattributed");
  } finally {
    db.close();
    fx.dispose();
  }
});