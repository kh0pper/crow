import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3g-apply-"));
execFileSync(process.execPath, ["scripts/init-db.js"],
  { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const SECP = "a".repeat(64);

function mgr(id = "aaaaaaaa-0000-0000-0000-000000000001") {
  return new InstanceSyncManager(IDENTITY, createDbClient(DB_PATH), id);
}
function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}
async function members(db, gUid) {
  const { rows } = await db.execute({
    sql: `SELECT c.crow_id FROM contact_group_members gm
            JOIN contacts c ON c.id = gm.contact_id
            JOIN contact_groups g ON g.id = gm.group_id
           WHERE g.group_uid = ? ORDER BY c.crow_id`, args: [gUid],
  });
  return rows.map((r) => r.crow_id);
}

test("_applyGroup: inserts a plain group keyed on group_uid + resolves members to LOCAL ids", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (50,'crow:a','', ?),(51,'crow:b','', ?)", args: [SECP, SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { id: 999, group_uid: "gg1", name: "Family", color: "#f00", members: ["crow:a", "crow:b"] }, 10));
  const { rows } = await db.execute({ sql: "SELECT id, name, color FROM contact_groups WHERE group_uid='gg1'" });
  assert.equal(rows.length, 1);
  assert.notEqual(Number(rows[0].id), 999, "stored under a LOCAL id, not the wire 999");
  assert.equal(rows[0].name, "Family");
  assert.deepEqual(await members(db, "gg1"), ["crow:a", "crow:b"]);
});

test("_applyGroup: a ROOM entry (room_uid set) is rejected by shouldSyncRow", async () => {
  const m = mgr(); const db = m.db;
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { group_uid: "gg-room", room_uid: "R1", name: "Should not land", members: [] }, 11));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contact_groups WHERE group_uid='gg-room'" })).rows[0].c, 0);
});

test("_applyGroup: an unresolvable member is skipped (never creates a contact)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (52,'crow:known','', ?)", args: [SECP] });
  const before = (await db.execute("SELECT COUNT(*) c FROM contacts")).rows[0].c;
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { group_uid: "gg2", name: "Mix", members: ["crow:known", "crow:ghost"] }, 12));
  assert.deepEqual(await members(db, "gg2"), ["crow:known"], "only the resolvable member joined");
  assert.equal((await db.execute("SELECT COUNT(*) c FROM contacts")).rows[0].c, before, "no phantom contact");
});

test("_applyGroup: LWW — a newer entry updates name + reconciles membership; a stale entry is skipped", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (60,'crow:x','', ?),(61,'crow:y','', ?)", args: [SECP, SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg3", name: "V1", members: ["crow:x"] }, 5));
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg3", name: "V2", members: ["crow:x", "crow:y"] }, 9));
  assert.equal((await db.execute({ sql: "SELECT name FROM contact_groups WHERE group_uid='gg3'" })).rows[0].name, "V2");
  assert.deepEqual(await members(db, "gg3"), ["crow:x", "crow:y"]);
  // Stale replay (lower lamport) must not revert.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg3", name: "STALE", members: ["crow:x"] }, 3));
  assert.equal((await db.execute({ sql: "SELECT name FROM contact_groups WHERE group_uid='gg3'" })).rows[0].name, "V2", "stale entry ignored");
  assert.deepEqual(await members(db, "gg3"), ["crow:x", "crow:y"], "stale membership ignored");
});

test("_applyGroup: reconcile REMOVES a syncable member absent from the wire-map", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (70,'crow:p','', ?),(71,'crow:q','', ?)", args: [SECP, SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg4", name: "G", members: ["crow:p", "crow:q"] }, 5));
  assert.deepEqual(await members(db, "gg4"), ["crow:p", "crow:q"]);
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg4", name: "G", members: ["crow:p"] }, 9));
  assert.deepEqual(await members(db, "gg4"), ["crow:p"], "crow:q removed by full-replace");
});

test("_applyGroup: reconcile does NOT remove a LOCAL-BOT member the peer can't know about", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (80,'crow:human','', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (81,'crow:localbot','', ?, 'local-bot')", args: [SECP] });
  // Group exists locally with a human + a local-bot member.
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid, lamport_ts) VALUES (200,'G','gg5',5)" });
  await db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (200,80),(200,81)" });
  // A peer that only knows the human re-emits {crow:human}.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg5", name: "G", members: ["crow:human"] }, 9));
  assert.deepEqual(await members(db, "gg5"), ["crow:human", "crow:localbot"], "local-bot membership preserved (not wiped by peer full-replace)");
});

test("_applyGroup: I2 — a wire-map naming a LOCAL-BOT contact does NOT add it (add-branch bounded to syncable)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (85,'crow:h2','', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (86,'crow:bot2','', ?, 'local-bot')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES (87,'crow:pend','', ?, 'pending')", args: [SECP] });
  // Peer's wire-map names a human, a local-bot, and a pending contact — only the human joins.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { group_uid: "gg5b", name: "G", members: ["crow:h2", "crow:bot2", "crow:pend"] }, 5));
  assert.deepEqual(await members(db, "gg5b"), ["crow:h2"], "resolved-but-non-syncable members (local-bot, pending) skipped on add");
});

test("_applyGroup: STRICT delete-wins (2b spec §3.1) — even a LOWER-lamport delete removes the row, cascades membership, stands a tombstone, logs ONE delete-won conflict; a later higher-lamport upsert is silently dropped", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (90,'crow:z','', ?)", args: [SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg6", name: "Doomed", members: ["crow:z"] }, 5));
  // Delete at lamport 3 vs local row at lamport 5: NO lamport gate — the delete wins
  // (a lamport-gated delete provably loses the mutual case, spec §1.1).
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "delete", { group_uid: "gg6" }, 3));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contact_groups WHERE group_uid='gg6'" })).rows[0].c, 0, "row GONE despite its newer lamport (strict delete-wins)");
  assert.deepEqual(await members(db, "gg6"), [], "membership cascade-reaped on delete");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM group_tombstones WHERE group_uid='gg6'" })).rows[0].c, 1, "tombstone standing");
  // Exactly ONE conflict row for this uid, labeled truthfully (spec R2 F6): delete = WINNER,
  // the discarded local row = LOSER.
  const rowId = JSON.stringify({ group_uid: "gg6" });
  const { rows: cr } = await db.execute({ sql: "SELECT * FROM sync_conflicts WHERE row_id = ?", args: [rowId] });
  assert.equal(cr.length, 1, "exactly one delete-won conflict row");
  assert.equal(cr[0].op, "delete");
  assert.equal(cr[0].winning_instance_id, REMOTE_ID, "winner = the deleting (remote) instance");
  assert.equal(Number(cr[0].winning_lamport_ts), 3, "winning lamport = the delete's");
  assert.equal(Number(cr[0].losing_lamport_ts), 5, "losing lamport = the discarded local row's");
  // A HIGHER-lamport upsert for the tombstoned uid: silently dropped (G1 statement guard).
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg6", name: "Zombie", members: ["crow:z"] }, 99));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contact_groups WHERE group_uid='gg6'" })).rows[0].c, 0, "higher-lamport upsert dropped");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts WHERE row_id = ?", args: [rowId] })).rows[0].c, 1, "no new conflict row (silent drop)");
});

test("_applyGroup: a forged wire id/room_uid cannot hijack — id ignored, room dropped, never throws", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (300,'Existing','gg7')" });
  // Attacker copies an existing local id + tries to inject room_uid.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { id: 300, group_uid: "gg-new", room_uid: "HIJACK", name: "evil", members: [] }, 20));
  // room_uid present → shouldSyncRow drops the whole entry (nothing lands).
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contact_groups WHERE group_uid='gg-new'" })).rows[0].c, 0);
  assert.equal((await db.execute({ sql: "SELECT name FROM contact_groups WHERE id=300" })).rows[0].name, "Existing", "existing row untouched (wire id ignored)");
});

test("_applyGroup: members ABSENT (no key) skips reconcile — a metadata-only emit cannot wipe members; explicit [] still empties (R2 F3)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (95,'crow:keep','', ?)", args: [SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg8", name: "G", members: ["crow:keep"] }, 5));
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg8", name: "G2" }, 9)); // no members key
  assert.equal((await db.execute({ sql: "SELECT name FROM contact_groups WHERE group_uid='gg8'" })).rows[0].name, "G2", "metadata applied");
  assert.deepEqual(await members(db, "gg8"), ["crow:keep"], "absent members key → membership untouched");
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg8", name: "G3", members: [] }, 12));
  assert.deepEqual(await members(db, "gg8"), [], "explicit [] honored — legit empty group");
});
