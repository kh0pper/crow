// D19 (Artifacts spec §4.3, plan Task 3.2 / R-L5): a deleted contact's words
// go with them — every one of the THREE contact-delete paths soft-deletes the
// contact's artifact comments (text blanked, deleted_at stamped; owner and
// bot comments untouched), and a missing artifact_comments table (bundle not
// installed) is a no-op on all of them.
//   1. deleteContactLocal   — the user deletes on this instance
//   2. pruneAdvertisedContact — the durability prune
//   3. instance-sync _applyContact — a paired instance's delete arrives
// Harness mirrors tests/contacts-sync.test.js: real init-db into a tmpdir,
// signed entries through _applyEntry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { deleteContactLocal } from "../servers/sharing/contact-delete.js";
import { pruneAdvertisedContact } from "../servers/sharing/contact-prune.js";
import { deleteContactArtifactComments } from "../servers/shared/artifact-comment-delete.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-d19-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));
const db = createDbClient(DB_PATH);

let cid = 0;
async function seedContact(crowId) {
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, advertised_by_instance_id, lamport_ts)
          VALUES (?, ?, 'ed', ?, 'peer-x', 1)`,
    args: [crowId, crowId, String(++cid).padStart(64, "0")],
  });
  return (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id=?", args: [crowId] })).rows[0];
}

/** One artifact thread with one contact comment + one owner comment. */
async function seedComments(crowId) {
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  await initArtifactsTables(db);
  await db.execute({ sql: "INSERT INTO artifact_threads (artifact_id, version_n, anchor_json, author_kind, author_id) VALUES ('art_d19', 1, '{}', 'contact', ?)", args: [crowId] });
  const tid = (await db.execute({ sql: "SELECT last_insert_rowid() AS id" })).rows[0].id;
  await db.execute({ sql: "INSERT INTO artifact_comments (thread_id, author_kind, author_id, text, ts) VALUES (?, 'contact', ?, 'CONTACT-SECRET-WORDS', 1)", args: [tid, crowId] });
  await db.execute({ sql: "INSERT INTO artifact_comments (thread_id, author_kind, author_id, text, ts) VALUES (?, 'owner', NULL, 'OWNER-WORDS', 1)", args: [tid] });
  return tid;
}
async function commentStates(crowId) {
  const rows = (await db.execute({ sql: "SELECT author_kind, text, deleted_at FROM artifact_comments ORDER BY id" })).rows;
  return {
    contact: rows.find((r) => r.author_kind === "contact"),
    owner: rows.find((r) => r.author_kind === "owner"),
  };
}
async function clearComments() {
  await db.execute({ sql: "DELETE FROM artifact_comments" });
  await db.execute({ sql: "DELETE FROM artifact_threads" });
}

test("path 1 — deleteContactLocal soft-deletes the contact's comments, keeps the owner's", async () => {
  const row = await seedContact("crow:d19-local");
  await seedComments("crow:d19-local");
  const out = await deleteContactLocal(db, {}, row);
  assert.equal(out.ok, true);
  const s = await commentStates();
  assert.equal(s.contact.text, "", "the contact's words are gone");
  assert.ok(s.contact.deleted_at, "soft-deleted, the row stays for thread integrity");
  assert.equal(s.owner.text, "OWNER-WORDS", "the owner's comment is untouched");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:d19-local'" })).rows[0].c, 0);
  await clearComments();
});

test("path 2 — pruneAdvertisedContact soft-deletes the contact's comments", async () => {
  const row = await seedContact("crow:d19-prune");
  await seedComments("crow:d19-prune");
  const out = await pruneAdvertisedContact(db, {}, row);
  assert.equal(out.ok, true, JSON.stringify(out));
  const s = await commentStates();
  assert.equal(s.contact.text, "");
  assert.ok(s.contact.deleted_at);
  assert.equal(s.owner.text, "OWNER-WORDS");
  await clearComments();
});

test("path 3 — a paired instance's delete (_applyContact) soft-deletes the contact's comments before the row goes", async () => {
  const TEST_PRIV = Buffer.alloc(32, 0xAB);
  const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex") };
  const m = new InstanceSyncManager(IDENTITY, db, "aaaaaaaa-0000-0000-0000-000000000001");
  await seedContact("crow:d19-sync");
  await seedComments("crow:d19-sync");
  const e = { table: "contacts", op: "delete", row: { crow_id: "crow:d19-sync" }, lamport_ts: 9, instance_id: "bbbbbbbb-0000-0000-0000-000000000002" };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  await m._applyEntry("bbbbbbbb-0000-0000-0000-000000000002", e);
  const s = await commentStates();
  assert.equal(s.contact.text, "");
  assert.ok(s.contact.deleted_at);
  assert.equal(s.owner.text, "OWNER-WORDS");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:d19-sync'" })).rows[0].c, 0);
  await clearComments();
});

test("a stale synced delete keeps the contact AND its words", async () => {
  const TEST_PRIV = Buffer.alloc(32, 0xAB);
  const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex") };
  const m = new InstanceSyncManager(IDENTITY, db, "aaaaaaaa-0000-0000-0000-000000000001");
  const row = await seedContact("crow:d19-stale");
  await db.execute({ sql: "UPDATE contacts SET lamport_ts=50 WHERE id=?", args: [row.id] });
  await seedComments("crow:d19-stale");
  const e = { table: "contacts", op: "delete", row: { crow_id: "crow:d19-stale" }, lamport_ts: 9, instance_id: "bbbbbbbb-0000-0000-0000-000000000002" };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  await m._applyEntry("bbbbbbbb-0000-0000-0000-000000000002", e);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:d19-stale'" })).rows[0].c, 1, "the row survived");
  const s = await commentStates();
  assert.equal(s.contact.text, "CONTACT-SECRET-WORDS", "a delete that did not happen deletes nothing");
  await clearComments();
});

test("missing artifact tables (bundle not installed): every path is a no-op, never an error", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "crow-d19-notables-"));
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir2 }, stdio: "pipe" });
    const db2 = createDbClient(join(dir2, "crow.db"));
    try {
      assert.equal(await deleteContactArtifactComments(db2, "crow:x"), 0);
      await db2.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, lamport_ts) VALUES ('crow:nb','nb','ed','secp',1)" });
      const row = (await db2.execute({ sql: "SELECT * FROM contacts WHERE crow_id='crow:nb'" })).rows[0];
      const out = await deleteContactLocal(db2, {}, row);
      assert.equal(out.ok, true, "the user delete works without the bundle");
    } finally { try { db2.close(); } catch {} }
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

test("the core helper and the bundle's deleteContactComments agree (no drift)", async () => {
  const { deleteContactComments } = await import("../bundles/artifacts/server/comments.js");
  await seedComments("crow:d19-drift");
  assert.equal(await deleteContactComments(db, "crow:d19-drift"), 1, "bundle side blanks exactly the contact's live comments");
  const s = await commentStates();
  assert.equal(s.contact.text, "");
  assert.equal(s.owner.text, "OWNER-WORDS");
  assert.equal(await deleteContactArtifactComments(db, "crow:d19-drift"), 0, "second pass is a no-op (already deleted)");
  await clearComments();
});
