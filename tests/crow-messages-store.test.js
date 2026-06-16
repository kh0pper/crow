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
