/**
 * Spec 2026-09-08 §4.4: peer_display_name / peer_avatar ride contact-sync's
 * full-row emits (EXCLUDED_COLUMNS.contacts unchanged) and the apply door
 * copies them — sanitized/validated once, at apply, like display_name (so a
 * redelivery never mismatches the stored row). Both doors, real init-db
 * schema, stub outbound feed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager, EXCLUDED_COLUMNS } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-peer-wire-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
});
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0x5a);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-0000000009a1";
const PNG = "data:image/png;base64," + "A".repeat(64);
let seq = 0;

function makeManager() {
  const db = createDbClient(DB_PATH);
  const mgr = new InstanceSyncManager(IDENTITY, db, `peer-wire-${++seq}`);
  mgr.feedsDisabled = false;
  const entries = [];
  mgr.outFeeds = new Map([["peer-1", { append: async (e) => { entries.push(e); } }]]);
  return { mgr, db, entries };
}
function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}
const secp = (n) => String(n).padStart(64, "0");
const byCrow = async (db, id) => (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [id] })).rows[0];

test("emit door: peer_display_name / peer_avatar ride the wire (not in EXCLUDED_COLUMNS)", async () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.contacts].sort(), ["created_at", "id", "last_seen", "origin", "verified"], "unchanged");
  const { mgr, entries } = makeManager();
  const ts = await mgr.emitChange("contacts", "update", {
    crow_id: "crow:pw-emit", ed25519_pubkey: "e", secp256k1_pubkey: secp(901), display_name: "Typed",
    peer_display_name: "Kevin", peer_avatar: PNG,
  });
  assert.ok(typeof ts === "number");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].row.peer_display_name, "Kevin");
  assert.equal(entries[0].row.peer_avatar, PNG);
});

test("apply door: insert + update copy the peer fields; a hostile name is sanitized and a URL avatar becomes NULL; the typed fields ride as sent", async () => {
  const { mgr, db } = makeManager();
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", {
    crow_id: "crow:pw-ins", ed25519_pubkey: "e", secp256k1_pubkey: secp(902), display_name: "Typed",
    avatar_url: "https://example.com/local.png", peer_display_name: "Kevin", peer_avatar: PNG,
  }, 50));
  let row = await byCrow(db, "crow:pw-ins");
  assert.ok(row, "inserted");
  assert.equal(row.peer_display_name, "Kevin");
  assert.equal(row.peer_avatar, PNG);
  assert.equal(row.display_name, "Typed");
  assert.equal(row.avatar_url, "https://example.com/local.png");

  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:pw-ins", ed25519_pubkey: "e", secp256k1_pubkey: secp(902), display_name: "Typed",
    peer_display_name: "crow:impostor", peer_avatar: "https://example.com/not-inline.png",
  }, 51));
  row = await byCrow(db, "crow:pw-ins");
  assert.equal(row.peer_display_name, null, "an identity-string peer name is rejected at apply");
  assert.equal(row.peer_avatar, null, "a URL is not a picture at apply either");

  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:pw-ins", ed25519_pubkey: "e", secp256k1_pubkey: secp(902), display_name: "Typed",
    peer_display_name: "Bad Name\u202e", peer_avatar: "data:image/png;base64," + "A".repeat(40000),
  }, 52));
  row = await byCrow(db, "crow:pw-ins");
  assert.equal(row.peer_display_name, "Bad Name", "bidi override stripped");
  assert.equal(row.peer_avatar, null, "over the cap is NULL");
  assert.equal(row.avatar_url, "https://example.com/local.png", "a legacy URL in the LOCAL field survives apply (R2-S5)");

  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:pw-ins", ed25519_pubkey: "e", secp256k1_pubkey: secp(902), display_name: "Typed",
    avatar_url: "data:image/png;base64," + "A".repeat(40000),
  }, 53));
  row = await byCrow(db, "crow:pw-ins");
  assert.equal(row.avatar_url, null, "an oversize inline value in the local field is NULL at apply (R2-S5)");
});

test("apply door: an entry WITHOUT the peer keys (an older sender) leaves the stored peer fields alone", async () => {
  const { mgr, db } = makeManager();
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", {
    crow_id: "crow:pw-old", ed25519_pubkey: "e", secp256k1_pubkey: secp(903), display_name: "T", peer_display_name: "Kevin", peer_avatar: PNG,
  }, 60));
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:pw-old", ed25519_pubkey: "e", secp256k1_pubkey: secp(903), display_name: "T2",
  }, 61));
  const row = await byCrow(db, "crow:pw-old");
  assert.equal(row.display_name, "T2");
  assert.equal(row.peer_display_name, "Kevin", "absent key = not on the wire = untouched");
  assert.equal(row.peer_avatar, PNG);
});
