import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import Database from "better-sqlite3";
import * as cmStore from "../scripts/pi-bots/gateways/crow-messages-store.mjs";

let dir, db;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "crowmsg-store-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
});
after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test("bot_message_acl + bot_message_invites tables exist with expected columns", async () => {
  const acl = (await db.execute("PRAGMA table_info(bot_message_acl)")).rows.map(r => r.name);
  for (const c of ["id","bot_id","sender_pubkey","crow_id","display_name","added_via","created_at"]) {
    assert.ok(acl.includes(c), "acl missing " + c);
  }
  const inv = (await db.execute("PRAGMA table_info(bot_message_invites)")).rows.map(r => r.name);
  for (const c of ["id","bot_id","token","expires_at","max_uses","uses","revoked","created_at"]) {
    assert.ok(inv.includes(c), "invites missing " + c);
  }
  const aclIdx = (await db.execute("PRAGMA index_list(bot_message_acl)")).rows.some(r => Number(r.unique) === 1);
  assert.ok(aclIdx, "expected UNIQUE(bot_id,sender_pubkey)");
});

function bdb() { return new Database(join(dir, "crow.db")); } // same file init-db built

test("upsertAclFromAccept + authorizeSender (default-deny)", async () => {
  const d = bdb();
  try {
    const pk = "a".repeat(64);
    assert.equal(cmStore.authorizeSender(d, "bot1", pk), false, "deny before add");
    cmStore.upsertAclFromAccept(d, "bot1", pk, "crow:zzz", "Alice");
    assert.equal(cmStore.authorizeSender(d, "bot1", pk), true, "allow after add");
    assert.equal(cmStore.authorizeSender(d, "bot1", "b".repeat(64)), false, "other sender denied");
    // x-only normalization: a 66-hex compressed form authorizes the stored 64-hex
    assert.equal(cmStore.authorizeSender(d, "bot1", "02" + pk), true, "compressed key normalized");
  } finally { d.close(); }
});

test("consumeInvite validates token, respects max_uses + revoked + expiry", async () => {
  const d = bdb();
  try {
    d.prepare("INSERT INTO bot_message_invites (bot_id, token, max_uses, uses) VALUES (?,?,?,0)").run("bot1", "tok-A", 1);
    assert.equal(cmStore.consumeInvite(d, "bot1", "tok-A"), true, "first use ok");
    assert.equal(cmStore.consumeInvite(d, "bot1", "tok-A"), false, "exhausted");
    assert.equal(cmStore.consumeInvite(d, "bot1", "nope"), false, "unknown token");
    d.prepare("INSERT INTO bot_message_invites (bot_id, token, revoked) VALUES (?,?,1)").run("bot1", "tok-R");
    assert.equal(cmStore.consumeInvite(d, "bot1", "tok-R"), false, "revoked");
    d.prepare("INSERT INTO bot_message_invites (bot_id, token, expires_at) VALUES (?,?,datetime('now','-1 day'))").run("bot1", "tok-E");
    assert.equal(cmStore.consumeInvite(d, "bot1", "tok-E"), false, "expired");
  } finally { d.close(); }
});

test("markEventSeen dedups per (bot,event) and survives across handles; pruneSeen ages out", async () => {
  const d = bdb();
  try {
    assert.equal(cmStore.markEventSeen(d, "bot1", "evt-1"), true, "first sight");
    assert.equal(cmStore.markEventSeen(d, "bot1", "evt-1"), false, "repeat");
    assert.equal(cmStore.markEventSeen(d, "bot1", "evt-2"), true, "distinct event");
    assert.equal(cmStore.markEventSeen(d, "bot2", "evt-1"), true, "distinct bot");
    assert.equal(cmStore.markEventSeen(d, "bot1", null), false, "null id");
  } finally { d.close(); }
  // A fresh handle (simulating a restart) still sees the persisted ids.
  const d2 = bdb();
  try {
    assert.equal(cmStore.markEventSeen(d2, "bot1", "evt-1"), false, "persisted across handles");
    d2.prepare("UPDATE bot_message_seen SET created_at = datetime('now','-5 day') WHERE event_id='evt-2'").run();
    cmStore.pruneSeen(d2, 2);
    assert.equal(cmStore.markEventSeen(d2, "bot1", "evt-2"), true, "pruned old row → seen-as-new again");
  } finally { d2.close(); }
});

test("authorizeSender: allow_paired_instances lets a paired-instance contact through without an ACL row", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "cm-store-paired-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: tmp }, stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const d = new Database(join(tmp, "crow.db"));
  // contacts.secp256k1_pubkey is stored as the 66-hex COMPRESSED key (02/03 prefix),
  // but events authorize on the 64-hex x-only pubkey. Test BOTH parity prefixes.
  const xonly02 = "c".repeat(64);          // a 02-prefixed contact
  const xonly03 = "f".repeat(64);          // a 03-prefixed contact (the half a naive "02"+pk match misses)
  d.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)")
    .run("crow:paired01", "Laptop", "ed".repeat(16), "02" + xonly02);
  d.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)")
    .run("crow:paired03", "Phone", "ee".repeat(16), "03" + xonly03);
  d.prepare("INSERT INTO crow_instances (id, name, crow_id) VALUES (?,?,?)").run("inst-1", "Laptop", "crow:paired01");
  d.prepare("INSERT INTO crow_instances (id, name, crow_id) VALUES (?,?,?)").run("inst-2", "Phone", "crow:paired03");
  // Off → denied (default-deny, no ACL row).
  assert.equal(cmStore.authorizeSender(d, "botX", xonly02, false), false, "denied with toggle off");
  // On → allowed via the paired-instance join, for BOTH 02 and 03 contacts.
  assert.equal(cmStore.authorizeSender(d, "botX", xonly02, true), true, "02-prefixed paired contact allowed");
  assert.equal(cmStore.authorizeSender(d, "botX", xonly03, true), true, "03-prefixed paired contact allowed");
  // A contact who is NOT a registered instance → denied even with toggle on.
  d.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)")
    .run("crow:friend01", "Friend", "ab".repeat(16), "02" + "a".repeat(64));
  assert.equal(cmStore.authorizeSender(d, "botX", "a".repeat(64), true), false, "non-instance contact denied");
  // Unknown sender → denied.
  assert.equal(cmStore.authorizeSender(d, "botX", "d".repeat(64), true), false, "unknown sender denied");
  d.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("authorizeSender: paired-instance path denied when instance is revoked", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "cm-store-revoked-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: tmp }, stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const d = new Database(join(tmp, "crow.db"));
  const xonly = "5".repeat(64);
  d.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)")
    .run("crow:revoked01", "Revoked Box", "51".repeat(16), "02" + xonly);
  d.prepare("INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?,?,?,?)")
    .run("inst-rev", "Revoked Box", "crow:revoked01", "revoked");
  // allowPaired=true but instance is revoked → must deny
  assert.equal(cmStore.authorizeSender(d, "botR", xonly, true), false, "revoked instance denied");
  // Sanity: if status were 'active' it would be allowed
  d.prepare("UPDATE crow_instances SET status='active' WHERE id='inst-rev'").run();
  assert.equal(cmStore.authorizeSender(d, "botR", xonly, true), true, "active instance allowed (sanity)");
  d.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("authorizeSender: paired-instance path denied when contact is blocked", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "cm-store-blocked-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: tmp }, stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const d = new Database(join(tmp, "crow.db"));
  const xonly = "7".repeat(64);
  d.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, is_blocked) VALUES (?,?,?,?,?)")
    .run("crow:blocked01", "Blocked Box", "71".repeat(16), "02" + xonly, 1);
  d.prepare("INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?,?,?,?)")
    .run("inst-blk", "Blocked Box", "crow:blocked01", "active");
  // allowPaired=true, instance active, but contact is blocked → must deny
  assert.equal(cmStore.authorizeSender(d, "botB", xonly, true), false, "blocked contact denied");
  // Sanity: unblock → allowed
  d.prepare("UPDATE contacts SET is_blocked=0 WHERE crow_id='crow:blocked01'").run();
  assert.equal(cmStore.authorizeSender(d, "botB", xonly, true), true, "unblocked contact allowed (sanity)");
  d.close();
  rmSync(tmp, { recursive: true, force: true });
});
