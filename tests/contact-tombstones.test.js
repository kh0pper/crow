/**
 * F-CONTACT-1 (design §D3, §4.1, §4.6) — Tasks 1 & 2.
 *
 * Task 1: schema — contact_tombstones + processed_control_events, user_version 6,
 *   idempotent re-init.
 * Task 2: tombstone primitives (writeTombstone/readTombstone/clearTombstone),
 *   emitChange return contract, emitContactDelete co-writing the local tombstone.
 *
 * Harness mirrors tests/contacts-sync.test.js: real init-db into a tmpdir, the
 * async createDbClient handle for the primitives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import { writeTombstone, readTombstone, clearTombstone } from "../servers/sharing/contact-delete.js";
import { emitContactDelete, __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-tombstone-test-"));
function initDb() {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
}
initDb();
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const db = createDbClient(DB_PATH);

const TEST_PRIV = Buffer.alloc(32, 0xC7);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

// ── Task 1: schema ──────────────────────────────────────────────────────────

test("contact_tombstones + processed_control_events tables exist after init-db", async () => {
  const { rows } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contact_tombstones','processed_control_events') ORDER BY name",
    args: [],
  });
  assert.deepEqual(rows.map((r) => r.name), ["contact_tombstones", "processed_control_events"]);
});

test("contact_tombstones has the expected columns", async () => {
  const { rows } = await db.execute("PRAGMA table_info(contact_tombstones)");
  assert.deepEqual(rows.map((r) => r.name).sort(), ["crow_id", "deleted_at", "lamport_ts"]);
});

test("processed_control_events has the expected columns", async () => {
  const { rows } = await db.execute("PRAGMA table_info(processed_control_events)");
  assert.deepEqual(rows.map((r) => r.name).sort(), ["event_id", "kind", "seen_at"]);
});

test("init-db stamps PRAGMA user_version with the current SCHEMA_GENERATION", async () => {
  const { rows } = await db.execute("PRAGMA user_version");
  assert.equal(Number(rows[0].user_version), SCHEMA_GENERATION);
});

test("init-db is idempotent — re-run preserves rows and does not throw", async () => {
  await db.execute({ sql: "INSERT OR REPLACE INTO contact_tombstones (crow_id, lamport_ts, deleted_at) VALUES (?,?,?)", args: ["crow:idem", 7, 1000] });
  initDb(); // must not throw
  const fresh = createDbClient(DB_PATH);
  const { rows } = await fresh.execute({ sql: "SELECT lamport_ts FROM contact_tombstones WHERE crow_id = ?", args: ["crow:idem"] });
  assert.equal(rows[0].lamport_ts, 7);
  const { rows: uv } = await fresh.execute("PRAGMA user_version");
  assert.equal(Number(uv[0].user_version), SCHEMA_GENERATION);
});

// ── Task 2: tombstone primitives ────────────────────────────────────────────

test("writeTombstone/readTombstone/clearTombstone round-trip", async () => {
  await writeTombstone(db, "crow:rt1", 100);
  const t = await readTombstone(db, "crow:rt1");
  assert.equal(t.crow_id, "crow:rt1");
  assert.equal(t.lamport_ts, 100);
  assert.ok(t.deleted_at > 0);
  await clearTombstone(db, "crow:rt1");
  assert.equal(await readTombstone(db, "crow:rt1"), null);
});

test("req: ids are ignored by all three primitives", async () => {
  await writeTombstone(db, "req:abc", 100);
  // read is a no-op → null even if a row somehow existed
  assert.equal(await readTombstone(db, "req:abc"), null);
  // prove no row was written by querying directly
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contact_tombstones WHERE crow_id = ?", args: ["req:abc"] });
  assert.equal(rows[0].n, 0);
  await clearTombstone(db, "req:abc"); // must not throw
});

test("writeTombstone keeps the MAX lamport on conflict", async () => {
  await writeTombstone(db, "crow:max", 100);
  await writeTombstone(db, "crow:max", 50); // lower — must be ignored
  assert.equal((await readTombstone(db, "crow:max")).lamport_ts, 100);
  await writeTombstone(db, "crow:max", 150); // higher — must win
  assert.equal((await readTombstone(db, "crow:max")).lamport_ts, 150);
  await clearTombstone(db, "crow:max");
});

test("writeTombstone sets deleted_at on first write and preserves it on conflict", async () => {
  await writeTombstone(db, "crow:da", 10);
  const first = (await readTombstone(db, "crow:da")).deleted_at;
  await writeTombstone(db, "crow:da", 20);
  assert.equal((await readTombstone(db, "crow:da")).deleted_at, first);
  await clearTombstone(db, "crow:da");
});

// ── Task 2: emitContactDelete co-writes the local tombstone ─────────────────

test("emitContactDelete with a null sink still writes a tombstone at the fallback lamport", async () => {
  __setEmitSinkForTest(null); // no manager → emit suppressed, nullish return
  await emitContactDelete(db, "crow:fallback", 42);
  assert.equal((await readTombstone(db, "crow:fallback")).lamport_ts, 42);
  await clearTombstone(db, "crow:fallback");
});

test("emitContactDelete writes the tombstone at the emitted lamport when the emit succeeds", async () => {
  __setEmitSinkForTest({ emitChange: async () => 999 });
  await emitContactDelete(db, "crow:emit", 42); // fallback 42 must be overridden by 999
  assert.equal((await readTombstone(db, "crow:emit")).lamport_ts, 999);
  __setEmitSinkForTest(null);
  await clearTombstone(db, "crow:emit");
});

test("emitContactDelete skips req: ids entirely (no emit, no tombstone)", async () => {
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (...a) => { seen.push(a); return 5; } });
  await emitContactDelete(db, "req:xyz", 5);
  assert.equal(seen.length, 0);
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contact_tombstones WHERE crow_id = ?", args: ["req:xyz"] });
  assert.equal(rows[0].n, 0);
  __setEmitSinkForTest(null);
});

// ── Task 2: emitChange return contract ──────────────────────────────────────

test("emitChange returns its lamport on success and null on each early-return path", async () => {
  const m = new InstanceSyncManager(IDENTITY, createDbClient(DB_PATH), "aaaaaaaa-0000-0000-0000-000000000009");
  m.feedsDisabled = false;

  // success path — a full contact row synced; returns a numeric lamport
  const ok = await m.emitChange("contacts", "update", { crow_id: "crow:emitok", request_status: null });
  assert.equal(typeof ok, "number");

  // early return: feedsDisabled
  m.feedsDisabled = true;
  assert.equal(await m.emitChange("contacts", "update", { crow_id: "crow:emitok", request_status: null }), null);
  m.feedsDisabled = false;

  // early return: non-synced table
  assert.equal(await m.emitChange("not_a_synced_table", "update", { id: 1 }), null);

  // early return: !shouldSyncRow (a pending request row is local-only)
  assert.equal(await m.emitChange("contacts", "update", { crow_id: "crow:pending", request_status: "pending" }), null);
});
