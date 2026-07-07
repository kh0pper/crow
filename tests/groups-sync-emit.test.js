import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  emitGroupUpsert,
  emitGroupDelete,
  __setEmitSinkForTest,
} from "../servers/sharing/group-sync.js";
import {
  shouldSyncRowForTest,
  EXCLUDED_COLUMNS,
  SYNCED_TABLES,
} from "../servers/sharing/instance-sync.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3g-emit-"));
execFileSync(process.execPath, ["scripts/init-db.js"],
  { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const db = createDbClient(join(tmpDir, "crow.db"));
after(() => rmSync(tmpDir, { recursive: true, force: true }));
const SECP = "a".repeat(64);

test("contact_groups is a synced table", () => {
  assert.ok(SYNCED_TABLES.includes("contact_groups"));
});

test("EXCLUDED_COLUMNS.contact_groups strips only id + created_at", () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.contact_groups].sort(), ["created_at", "id"]);
});

test("shouldSyncRow: plain group with group_uid syncs; rooms + keyless drop", () => {
  const ok = (r) => shouldSyncRowForTest("contact_groups", r);
  assert.equal(ok({ group_uid: "g1", name: "Family" }), true);
  assert.equal(ok({ group_uid: "g1", room_uid: "r1", name: "Room" }), false, "room drops");
  assert.equal(ok({ name: "no uid" }), false, "keyless drops");
  assert.equal(ok({ group_uid: "g2" }), true, "delete-shaped {group_uid} passes (room_uid absent)");
  assert.equal(ok(null), false);
});

test("emitGroupUpsert: attaches ONLY syncable members (I2: local-bot + pending excluded) and forwards to the sink", async () => {
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (1,'crow:m1','', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (2,'crow:m2','', ?)", args: [SECP] });
  // A local-bot member and a pending member must NOT ride the wire (I2).
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (3,'crow:bot','', ?, 'local-bot')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES (4,'crow:pending','', ?, 'pending')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (10,'Family','g10')" });
  await db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (10,1),(10,2),(10,3),(10,4)" });
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push([t, op, row.group_uid, [...(row.members || [])].sort(), row.id]) });
  await emitGroupUpsert(db, 10);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["contact_groups", "update", "g10", ["crow:m1", "crow:m2"], 10], "local-bot + pending members excluded from the wire-map");
  __setEmitSinkForTest(null);
});

test("emitGroupUpsert: a ROOM group is never emitted", async () => {
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid, room_uid) VALUES (11,'Room','g11','room-uid-1')" });
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (...a) => seen.push(a) });
  await emitGroupUpsert(db, 11);
  assert.equal(seen.length, 0, "room_uid != null → helper skips");
  __setEmitSinkForTest(null);
});

test("emitGroupDelete + missing-row + null-sink are all no-throw", async () => {
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push([t, op, row.group_uid]) });
  await emitGroupDelete("g10");
  assert.deepEqual(seen[0], ["contact_groups", "delete", "g10"]);
  __setEmitSinkForTest(null);
  await emitGroupUpsert(db, 9999); // no such group → no throw
  await emitGroupDelete("");       // empty uid → no-op, no throw
  await emitGroupUpsert(db, 10);   // null sink → no throw
});
