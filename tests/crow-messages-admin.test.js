import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cm-admin-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let admin = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  // init-db does NOT create identity.json (the instance seed). Seed it now so
  // loadInstanceSeed(dirname(botsDbPath())) can derive bot keys. With CROW_DATA_DIR
  // set and no CROW_DB_PATH, botsDbPath() = <dir>/crow.db, so dirname == <dir>.
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  loadOrCreateIdentity(); // writes <dir>/identity.json (unencrypted)
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

test("mintInvite creates a non-revoked token; getActiveInvite returns the latest", async () => {
  const tok = await admin.mintInvite(db, "bot1", {});
  assert.ok(tok && typeof tok === "string" && tok.length >= 16, "token returned");
  const active = await admin.getActiveInvite(db, "bot1");
  assert.equal(active.token, tok);
  assert.equal(Number(active.revoked), 0);
});

test("rotateInvite revokes all prior tokens and mints a fresh one", async () => {
  const before = (await admin.getActiveInvite(db, "bot1")).token;
  const fresh = await admin.rotateInvite(db, "bot1", {});
  assert.notEqual(fresh, before, "new token differs");
  const active = await admin.getActiveInvite(db, "bot1");
  assert.equal(active.token, fresh, "active is the fresh one");
  // The prior token must now be revoked.
  const { rows } = await db.execute({
    sql: "SELECT revoked FROM bot_message_invites WHERE token=?", args: [before],
  });
  assert.equal(Number(rows[0].revoked), 1, "prior token revoked");
});

test("listAcl / addManualAcl / removeAcl round-trip", async () => {
  const pk = "a".repeat(64);
  await admin.addManualAcl(db, "bot1", "02" + pk, "crow:zzz", "Alice"); // compressed in → normalized
  let acl = await admin.listAcl(db, "bot1");
  assert.equal(acl.length, 1);
  assert.equal(acl[0].sender_pubkey, pk, "stored x-only (64-hex)");
  assert.equal(acl[0].display_name, "Alice");
  assert.equal(acl[0].added_via, "manual");
  await admin.removeAcl(db, "bot1", pk);
  acl = await admin.listAcl(db, "bot1");
  assert.equal(acl.length, 0, "removed");
});

test("buildInviteCode produces a code parseable by parseBotInviteCode with the active token", async () => {
  const { parseBotInviteCode } = await import("../servers/sharing/identity.js");
  const tok = (await admin.getActiveInvite(db, "bot1")).token;
  const code = await admin.buildInviteCode(db, "bot1", tok);
  const parsed = parseBotInviteCode(code);
  assert.equal(parsed.token, tok);
  assert.ok(parsed.secp256k1Pubkey && parsed.secp256k1Pubkey.length >= 64, "carries the bot secp key");
  assert.ok(Array.isArray(parsed.relays), "carries relays");
});

test("botIdentityFor matches the key the pi-bots adapter would subscribe under (parity)", async () => {
  // The adapter derives via loadInstanceSeed(dirname(botsDbPath())); the admin
  // helper MUST produce the identical crow_id, or shared invites are dead.
  const { loadInstanceSeed, deriveBotIdentity } = await import("../servers/sharing/identity.js");
  const { botsDbPath } = await import("../scripts/pi-bots/instance-paths.mjs");
  const { dirname } = await import("node:path");
  const adapterId = deriveBotIdentity(loadInstanceSeed(dirname(botsDbPath())), "bot1");
  const adminId = admin.botIdentityFor("bot1");
  assert.equal(adminId.crowId, adapterId.crowId, "crow_id parity admin vs adapter");
  assert.equal(adminId.secp256k1Pubkey, adapterId.secp256k1Pubkey, "secp key parity");
});
