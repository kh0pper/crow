/**
 * Phase 3 PR-A — contacts follow the user.
 * Task 1: carve-out gates (shouldSyncRow contacts branch + EXCLUDED_COLUMNS).
 * Task 2: _applyContact crow_id-keyed inbound apply (LWW, secp-rebind, hook).
 *
 * Harness mirrors tests/instance-sync.test.js: real init-db into a tmpdir, plain
 * signed entries fed through _applyEntry, shared single identity so verify passes.
 * NOTE: all tests share ONE db file (rows persist across tests) — so each test
 * uses a UNIQUE secp key via secp(n) to avoid cross-test secp-rebind collisions.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager, shouldSyncRowForTest, EXCLUDED_COLUMNS } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const LOCAL_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-000000000002";

function mgr(id = LOCAL_ID) { return new InstanceSyncManager(IDENTITY, createDbClient(DB_PATH), id); }
function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}
// Unique 64-hex secp per test (digits are valid hex; padded to 64).
const secp = (n) => String(n).padStart(64, "0");
const bySecp = (db, s) => db.execute({ sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64))=?", args: [s.toLowerCase()] });

// ── Task 1: carve-out gates ────────────────────────────────────────────────
test("shouldSyncRow: contacts carve-outs", () => {
  const ok = (row) => shouldSyncRowForTest("contacts", row);
  assert.equal(ok({ crow_id: "crow:a", request_status: null }), true, "full contact syncs");
  assert.equal(ok({ crow_id: "crow:a", request_status: "accepted" }), true, "accepted syncs");
  assert.equal(ok({ crow_id: "manual:x", contact_type: "manual" }), true, "manual address-book syncs");
  assert.equal(ok({ crow_id: "crow:a", is_blocked: 1 }), true, "blocked still syncs (block follows user)");
  assert.equal(ok({ crow_id: "crow:a", request_status: "pending" }), false, "pending stays local");
  assert.equal(ok({ crow_id: "crow:a", origin: "local-bot" }), false, "local-bot never syncs");
});

test("EXCLUDED_COLUMNS.contacts strips id + created_at + verified + last_seen", () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.contacts].sort(), ["created_at", "id", "last_seen", "verified"]);
});

// ── Task 2: _applyContact ──────────────────────────────────────────────────
test("_applyContact: insert keys on crow_id, not per-instance id", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (7,'crow:local','', ?)", args: [secp(1)] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert",
    { id: 7, crow_id: "crow:remote", ed25519_pubkey: "", secp256k1_pubkey: secp(2), display_name: "Remote" }, 10));
  const local = (await db.execute({ sql: "SELECT crow_id FROM contacts WHERE crow_id='crow:local'" })).rows;
  const remote = (await db.execute({ sql: "SELECT crow_id, display_name FROM contacts WHERE crow_id='crow:remote'" })).rows;
  assert.equal(local.length, 1, "local row untouched (id collision did NOT clobber)");
  assert.equal(remote.length, 1, "remote contact created under its own crow_id");
  assert.equal(remote[0].display_name, "Remote");
});

test("_applyContact: LWW update — newer applies, stale skips + logs conflict", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:lww','', ?, 'Old', 5)", args: [secp(3)] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:lww", display_name: "New", secp256k1_pubkey: secp(3) }, 9));
  assert.equal((await db.execute({ sql: "SELECT display_name FROM contacts WHERE crow_id='crow:lww'" })).rows[0].display_name, "New");
  const before = (await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts" })).rows[0].c;
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:lww", display_name: "Stale", secp256k1_pubkey: secp(3) }, 3));
  assert.equal((await db.execute({ sql: "SELECT display_name FROM contacts WHERE crow_id='crow:lww'" })).rows[0].display_name, "New", "stale ignored");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts" })).rows[0].c, before + 1, "conflict logged");
});

test("_applyContact: delete is lamport-gated by crow_id", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, lamport_ts) VALUES ('crow:del','', ?, 5)", args: [secp(4)] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "delete", { crow_id: "crow:del" }, 3)); // stale
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:del'" })).rows[0].c, 1, "stale delete kept local");
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "delete", { crow_id: "crow:del" }, 9)); // newer
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:del'" })).rows[0].c, 0, "newer delete applied");
});

test("_applyContact: a synced key-rebind resets verified to 0 (PR3 parity)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, verified, lamport_ts) VALUES ('crow:rebind','e', ?, 1, 5)", args: [secp(5)] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:rebind", secp256k1_pubkey: secp(6) }, 9));
  const row = (await db.execute({ sql: "SELECT secp256k1_pubkey, verified FROM contacts WHERE crow_id='crow:rebind'" })).rows[0];
  assert.equal(row.secp256k1_pubkey, secp(6), "key rebound");
  assert.equal(row.verified, 0, "verified reset on key change");
});

test("_applyContact: a same-key update preserves verified", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, verified, lamport_ts) VALUES ('crow:keep','e', ?, 'X', 1, 5)", args: [secp(7)] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:keep", secp256k1_pubkey: secp(7), display_name: "Y" }, 9));
  const row = (await db.execute({ sql: "SELECT display_name, verified FROM contacts WHERE crow_id='crow:keep'" })).rows[0];
  assert.equal(row.display_name, "Y", "display updated");
  assert.equal(row.verified, 1, "verified preserved when key unchanged");
});

test("_applyContact: req:→crow: rebind by secp does not split the contact (R2)", async () => {
  const m = mgr(); const db = m.db; const s = secp(8);
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update",
    { crow_id: "req:" + s, ed25519_pubkey: "", secp256k1_pubkey: s, request_status: "accepted", display_name: "Stranger" }, 5));
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update",
    { crow_id: "crow:real", ed25519_pubkey: "e", secp256k1_pubkey: s, request_status: null, display_name: "Alice" }, 9));
  const rows = (await bySecp(db, s)).rows;
  assert.equal(rows.length, 1, "exactly one row for the secp (rebound, not split)");
  assert.equal(rows[0].crow_id, "crow:real");
  assert.equal(rows[0].display_name, "Alice");
});

test("_applyContact: rebind converges an independently-formed local req: row", async () => {
  const m = mgr(); const db = m.db; const s = secp(9);
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, request_status, lamport_ts) VALUES (?, '', ?, 'accepted', 4)", args: ["req:" + s, s] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:b", ed25519_pubkey: "e", secp256k1_pubkey: s }, 9));
  const rows = (await bySecp(db, s)).rows;
  assert.equal(rows.length, 1, "local req: row rebound to crow:b, not duplicated");
  assert.equal(rows[0].crow_id, "crow:b");
});

test("_applyContact: rebind never un-promotes a real crow: id to a req: placeholder (R2b)", async () => {
  const m = mgr(); const db = m.db; const s = secp(10);
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, request_status, lamport_ts) VALUES ('crow:promoted','e', ?, NULL, 5)", args: [s] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "req:" + s, secp256k1_pubkey: s, request_status: "accepted" }, 99));
  const rows = (await bySecp(db, s)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].crow_id, "crow:promoted", "stayed promoted");
});

test("_applyContact: apply drops verified/last_seen and honors carve-outs", async () => {
  const m = mgr(); const db = m.db;
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert",
    { crow_id: "crow:carve", ed25519_pubkey: "", secp256k1_pubkey: secp(11), verified: 1, last_seen: "2020-01-01" }, 4));
  const row = (await db.execute({ sql: "SELECT verified, last_seen FROM contacts WHERE crow_id='crow:carve'" })).rows[0];
  assert.equal(row.verified, 0, "verified not set from wire (local default)");
  assert.equal(row.last_seen, null, "last_seen not set from wire");
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", { crow_id: "crow:reqx", secp256k1_pubkey: secp(12), ed25519_pubkey: "", request_status: "pending" }, 4));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:reqx'" })).rows[0].c, 0, "pending not applied");
});

test("_applyContact: a bad-signature contacts entry is dropped before apply", async () => {
  const m = mgr(); const db = m.db;
  const e = { table: "contacts", op: "insert", row: { crow_id: "crow:badsig", ed25519_pubkey: "", secp256k1_pubkey: secp(14) }, lamport_ts: 4, instance_id: REMOTE_ID };
  e.signature = "00".repeat(64); // invalid signature
  await m._applyEntry(REMOTE_ID, e);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:badsig'" })).rows[0].c, 0, "unverified entry not applied");
});

test("_applyContact: fires onContactSynced with the local row; never throws on junk", async () => {
  const m = mgr(); const seen = [];
  m.onContactSynced = (r) => seen.push(r);
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", { crow_id: "crow:hook", ed25519_pubkey: "", secp256k1_pubkey: secp(13) }, 4));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].crow_id, "crow:hook");
  assert.equal(typeof seen[0].id, "number", "hook receives the local row with a local id");
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", { nonsense: true }, 4)); // no crow_id → no throw
});
