/**
 * Item 2b (group tombstones design §3.2/§3.3) — Task 1.
 *
 * Task 1: schema — group_tombstones table (SCHEMA_GENERATION 8) — and the
 * import-free primitives in servers/sharing/group-delete.js:
 * groupTombstoneStatement / writeGroupTombstone / readGroupTombstone /
 * isGroupTombstoned.
 *
 * Harness mirrors tests/contact-tombstones.test.js: real init-db into a
 * tmpdir, the async createDbClient handle for the primitives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import {
  groupTombstoneStatement,
  writeGroupTombstone,
  readGroupTombstone,
  isGroupTombstoned,
} from "../servers/sharing/group-delete.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-group-tombstone-test-"));
function initDb() {
  // CROW_DB_PATH outranks CROW_DATA_DIR in init-db (init-db.js:11) — blank it, or a
  // shell exporting it (grackle's .env did exactly this, PR #180) misroutes the
  // migration onto the REAL DB.
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir, CROW_DB_PATH: "" }, stdio: "pipe" });
}
initDb();
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const db = createDbClient(DB_PATH);

// A db stub whose every call throws — the un-migrated-DB / missing-table case
// the fail-open guarantees (spec G2) are about.
const throwingDb = { execute() { throw new Error("x"); } };

// ── Task 1: schema ──────────────────────────────────────────────────────────

test("group_tombstones table exists after init-db with the exact columns", async () => {
  const { rows } = await db.execute("PRAGMA table_info(group_tombstones)");
  assert.deepEqual(rows.map((r) => r.name).sort(), ["deleted_at", "group_uid", "lamport_ts"],
    "exactly group_uid + lamport_ts + deleted_at — deliberately NO kind column (single writer class, spec §3.2)");
  const pk = rows.find((r) => r.name === "group_uid");
  assert.equal(pk.pk, 1, "group_uid is the PRIMARY KEY");
});

test("init-db stamps PRAGMA user_version with the current SCHEMA_GENERATION (>= 8)", async () => {
  const { rows } = await db.execute("PRAGMA user_version");
  assert.equal(Number(rows[0].user_version), SCHEMA_GENERATION);
  assert.ok(SCHEMA_GENERATION >= 8, "Item 2b bumped the generation to 8");
});

test("init-db is idempotent — re-run preserves group_tombstones rows and does not throw", async () => {
  await db.execute({ sql: "INSERT OR REPLACE INTO group_tombstones (group_uid, lamport_ts, deleted_at) VALUES (?,?,?)", args: ["uid-idem", 7, 1000] });
  initDb(); // must not throw
  const fresh = createDbClient(DB_PATH);
  const { rows } = await fresh.execute({ sql: "SELECT lamport_ts, deleted_at FROM group_tombstones WHERE group_uid = ?", args: ["uid-idem"] });
  assert.equal(rows[0].lamport_ts, 7);
  assert.equal(rows[0].deleted_at, 1000);
});

// ── UPSERT semantics (groupTombstoneStatement via writeGroupTombstone) ──────

test("first write sets deleted_at and lamport_ts", async () => {
  await writeGroupTombstone(db, "uid-first", 100);
  const t = await readGroupTombstone(db, "uid-first");
  assert.equal(t.group_uid, "uid-first");
  assert.equal(t.lamport_ts, 100);
  assert.ok(t.deleted_at > 0, "deleted_at stamped (unix seconds) on first write");
});

test("second write with HIGHER lamport keeps deleted_at (first write wins) but raises lamport_ts to the MAX", async () => {
  // Seed a row with a deleted_at that CANNOT equal "now" — a same-second re-write
  // would make the preservation assertion vacuous (a mutant that overwrites
  // deleted_at with excluded.deleted_at would still pass). 1234 is unambiguous.
  await db.execute({ sql: "INSERT INTO group_tombstones (group_uid, lamport_ts, deleted_at) VALUES (?,?,?)", args: ["uid-max", 100, 1234] });
  await writeGroupTombstone(db, "uid-max", 150);
  const t = await readGroupTombstone(db, "uid-max");
  assert.equal(t.lamport_ts, 150, "MAX(100, 150) = 150");
  assert.equal(t.deleted_at, 1234, "deleted_at preserved on conflict — first write wins");
});

test("second write with LOWER lamport changes NOTHING", async () => {
  await db.execute({ sql: "INSERT INTO group_tombstones (group_uid, lamport_ts, deleted_at) VALUES (?,?,?)", args: ["uid-low", 100, 1234] });
  await writeGroupTombstone(db, "uid-low", 50);
  const t = await readGroupTombstone(db, "uid-low");
  assert.equal(t.lamport_ts, 100, "MAX(100, 50) = 100 — the lower lamport must not lower the recorded value");
  assert.equal(t.deleted_at, 1234);
});

test("groupTombstoneStatement returns a {sql, args} statement usable in db.batch()", async () => {
  const stmt = groupTombstoneStatement("uid-batch", 42);
  assert.equal(typeof stmt.sql, "string");
  assert.ok(Array.isArray(stmt.args));
  await db.batch([
    stmt,
    { sql: "INSERT OR REPLACE INTO group_tombstones (group_uid, lamport_ts, deleted_at) VALUES (?,?,?)", args: ["uid-batch2", 1, 1] },
  ]);
  assert.equal((await readGroupTombstone(db, "uid-batch")).lamport_ts, 42);
});

// ── Guards: falsy args ──────────────────────────────────────────────────────

test("writeGroupTombstone no-ops on falsy db / falsy uid (never throws)", async () => {
  await writeGroupTombstone(null, "uid-x", 1);   // must not throw
  await writeGroupTombstone(db, "", 1);          // must not throw
  await writeGroupTombstone(db, null, 1);        // must not throw
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM group_tombstones WHERE group_uid IN ('', 'null')", args: [] });
  assert.equal(rows[0].n, 0);
});

// ── isGroupTombstoned ───────────────────────────────────────────────────────

test("isGroupTombstoned returns true for a tombstoned uid, false for a live one", async () => {
  await writeGroupTombstone(db, "uid-tomb", 5);
  assert.equal(await isGroupTombstoned(db, "uid-tomb"), true);
  assert.equal(await isGroupTombstoned(db, "uid-never-deleted"), false);
});

test("isGroupTombstoned is FAIL-OPEN: a throwing db handle returns false, never throws (spec G2)", async () => {
  // A read failure (e.g. missing table under a stale server) must mean "not
  // tombstoned" — never swallow the caller's work.
  assert.equal(await isGroupTombstoned(throwingDb, "uid-any"), false);
});

test("isGroupTombstoned no-ops on falsy args", async () => {
  assert.equal(await isGroupTombstoned(null, "uid-x"), false);
  assert.equal(await isGroupTombstoned(db, ""), false);
  assert.equal(await isGroupTombstoned(db, null), false);
});

// ── readGroupTombstone ──────────────────────────────────────────────────────

test("readGroupTombstone returns the row for a tombstoned uid", async () => {
  await writeGroupTombstone(db, "uid-read", 9);
  const t = await readGroupTombstone(db, "uid-read");
  assert.equal(t.group_uid, "uid-read");
  assert.equal(t.lamport_ts, 9);
  assert.ok(t.deleted_at > 0);
});

test("readGroupTombstone returns null on a missing row", async () => {
  assert.equal(await readGroupTombstone(db, "uid-missing"), null);
});

test("readGroupTombstone returns null on error and on falsy args (guarded)", async () => {
  assert.equal(await readGroupTombstone(throwingDb, "uid-any"), null);
  assert.equal(await readGroupTombstone(null, "uid-x"), null);
  assert.equal(await readGroupTombstone(db, ""), null);
});
