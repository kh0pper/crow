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
import { readTombstone, writeTombstone } from "../servers/sharing/contact-delete.js";
import { sanitizeDisplayName } from "../servers/sharing/display-name.js";
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

// ── Task 6: the tombstone gate in _applyContact (design §D3.1) ───────────────
// All tests share ONE db file, so each uses a UNIQUE crow_id + secp key.

// guard #1 — resurrection-by-update: a concurrent rename must not resurrect a
// deleted contact. tombstone{X:100}, no row; update(X)@150 → still no row.
test("Task6 guard #1: tombstone drops a resurrecting update (no row appears)", async () => {
  const m = mgr(); const db = m.db;
  await writeTombstone(db, "crow:t1", 100);
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update",
    { crow_id: "crow:t1", ed25519_pubkey: "", secp256k1_pubkey: secp(101), display_name: "Zombie" }, 150));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:t1'" })).rows[0].c, 0,
    "update against a standing tombstone must not resurrect the contact");
});

// guard #2 — delete-before-insert: delete arrives before the insert it deletes.
// no row, no tombstone; delete(X)@100 → tombstone; then insert(X)@50 → still gone.
test("Task6 guard #2: delete-before-insert writes a tombstone that blocks a lower insert", async () => {
  const m = mgr(); const db = m.db;
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "delete", { crow_id: "crow:t2" }, 100));
  const tomb = await readTombstone(db, "crow:t2");
  assert.ok(tomb, "a delete with no local row records a tombstone");
  assert.equal(tomb.lamport_ts, 100, "tombstone carries the delete's lamport");
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert",
    { crow_id: "crow:t2", ed25519_pubkey: "", secp256k1_pubkey: secp(102) }, 50));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:t2'" })).rows[0].c, 0,
    "a stale insert below the tombstone stays gone");
});

// guard #3 — legitimate re-add: tombstone{X:100}; insert(X)@150 → row present AND
// tombstone cleared (apply-then-clear; the row must exist first, §D3.1(c)).
test("Task6 guard #3: a higher insert legitimately re-adds and clears the tombstone", async () => {
  const m = mgr(); const db = m.db;
  await writeTombstone(db, "crow:t3", 100);
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert",
    { crow_id: "crow:t3", ed25519_pubkey: "", secp256k1_pubkey: secp(103), display_name: "Reborn" }, 150));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:t3'" })).rows[0].c, 1,
    "an insert above the tombstone re-adds the contact");
  assert.equal(await readTombstone(db, "crow:t3"), null, "tombstone cleared once the row exists");
});

// guard #5 — a STALE delete must not wipe a live contact or (via FK CASCADE) its
// DM history. Live row @200 with 3 messages; delete@100 loses LWW → everything
// survives, a conflict is logged, and NO tombstone is written (the row won).
test("Task6 guard #5: a stale delete cannot wipe a live contact or its messages", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, lamport_ts) VALUES ('crow:t5','', ?, 200)", args: [secp(105)] });
  const cid = (await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id='crow:t5'" })).rows[0].id;
  for (let i = 0; i < 3; i++) {
    await db.execute({ sql: "INSERT INTO messages (contact_id, content, direction) VALUES (?, ?, 'received')", args: [cid, "m" + i] });
  }
  const before = (await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts" })).rows[0].c;
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "delete", { crow_id: "crow:t5" }, 100));
  // message-count first: it makes the data loss the reported failure under the mutation.
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE contact_id=?", args: [cid] })).rows[0].c, 3,
    "all 3 messages survive — an unconditional delete would CASCADE them away");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:t5'" })).rows[0].c, 1,
    "the live row survives a stale delete");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts" })).rows[0].c, before + 1,
    "the losing delete is conflict-logged");
  assert.equal(await readTombstone(db, "crow:t5"), null, "a losing delete writes NO tombstone");
});

// guard #6 — a stale local tombstone must not freeze a live row. Both coexist
// (the state deleteContactLocal-then-re-insert produces); update(X)@150 → the
// update lands and rule (a) clears the tombstone.
test("Task6 guard #6: a stale local tombstone does not freeze a live row", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:t6','', ?, 'Old', 50)", args: [secp(106)] });
  await writeTombstone(db, "crow:t6", 100);
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update",
    { crow_id: "crow:t6", ed25519_pubkey: "", secp256k1_pubkey: secp(106), display_name: "New" }, 150));
  assert.equal((await db.execute({ sql: "SELECT display_name FROM contacts WHERE crow_id='crow:t6'" })).rows[0].display_name, "New",
    "the update lands over the stale tombstone (rule (a) unblocks it)");
  assert.equal(await readTombstone(db, "crow:t6"), null, "rule (a) cleared the stale tombstone");
});

// guard (b) winning-delete fires the onContactDeleted hook with the doomed row.
test("Task6: a winning remote delete fires onContactDeleted then removes the row", async () => {
  const m = mgr(); const db = m.db; const seen = [];
  m.onContactDeleted = (r) => seen.push(r);
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, lamport_ts) VALUES ('crow:t7','', ?, 10)", args: [secp(107)] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "delete", { crow_id: "crow:t7" }, 20));
  assert.equal(seen.length, 1, "hook fired once for the winning delete");
  assert.equal(seen[0].crow_id, "crow:t7", "hook received the row about to be deleted");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:t7'" })).rows[0].c, 0, "row removed");
  assert.ok(await readTombstone(db, "crow:t7"), "winning delete wrote a tombstone");
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "delete", { crow_id: "crow:tnone" }, 5)); // no row → no throw
});

// ── Task 9: sanitize the sync ingress (design §D5) ───────────────────────────
// A peer entry's display_name is remote-controlled; sanitize it the moment
// `filtered` is built, BEFORE the equivalence check — else every redelivery of a
// name that needs sanitizing mismatches the stored row and spams the conflict log.
test("Task9: sync ingress sanitizes display_name; redelivery logs no new conflict", async () => {
  const m = mgr(); const db = m.db;
  const hostile = "‮" + "A".repeat(10000) + "\n\r" + "B";
  const clean = sanitizeDisplayName(hostile);
  assert.ok(clean && clean.length <= 64, "sanitizer produced a bounded value");
  const entry = signedEntry("contacts", "insert",
    { crow_id: "crow:t9", ed25519_pubkey: "", secp256k1_pubkey: secp(109), display_name: hostile }, 10);
  await m._applyEntry(REMOTE_ID, entry);
  assert.equal((await db.execute({ sql: "SELECT display_name FROM contacts WHERE crow_id='crow:t9'" })).rows[0].display_name, clean,
    "sync ingress stored the SANITIZED value, not the hostile raw string");
  const before = (await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts" })).rows[0].c;
  await m._applyEntry(REMOTE_ID, entry); // the exact same entry, same lamport
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts" })).rows[0].c, before,
    "redelivering the identical entry is equivalent → NO new conflict (sanitize BEFORE the equivalence check)");
});
