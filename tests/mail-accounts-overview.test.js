// Crow Mail's accounts overview (plan 1, Task 19): the body of GET /dashboard/mail/api/accounts, built
// from the account store, the unread counts and the per-instance claims. A scratch DB from MAIL_DDL
// plus the settings and registry tables the claim code reads; no HTTP, no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import { accountsOverview } from "../servers/gateway/mail/accounts-overview.js";
import { addressHash, releaseClaim, writeClaim } from "../servers/gateway/mail/claims.js";
import { createAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
import { upsertFolders, upsertMessage } from "../servers/gateway/mail/store/messages.js";

const SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS dashboard_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    lamport_ts INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dashboard_settings_overrides (
    key TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    lamport_ts INTEGER DEFAULT 0,
    PRIMARY KEY (key, instance_id)
  );
  CREATE TABLE IF NOT EXISTS crow_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    crow_id TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    trusted INTEGER DEFAULT 1,
    last_seen_at TEXT
  );
`;

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-overview-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL + SETTINGS_DDL);
  return db;
}

const LOCAL = "instA";
const PEER = "instB";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15, 12);

async function addInstance(db, id, name) {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, 'crow:mail', 'active')",
    args: [id, name],
  });
}

const account = (db, over = {}) => createAccount(db, {
  label: "Personal",
  address: "alex@example.com",
  username: "alexuser",
  authKind: "password",
  imap: { host: "mail.example.test", port: 993, security: "ssl" },
  smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  ...over,
});

async function folder(db, accountId, path, specialUse = null) {
  const { folders } = await upsertFolders(db, accountId, [
    { path, name: path, specialUse, delimiter: "/", selectable: true },
  ]);
  return folders.find((f) => f.path === path);
}

const message = (db, { accountId, folderId, uid, messageId, isRead = false, from = "sam@example.com" }) =>
  upsertMessage(db, {
    accountId,
    folderId,
    uid,
    messageId,
    subject: "Hello",
    from: { name: "Sam", address: from },
    to: [],
    cc: [],
    text: "hi",
    snippet: "hi",
    date: NOW,
    internalDate: NOW,
    flags: isRead ? ["\\Seen"] : [],
  });

test("the shape is exactly the plan's: no host, port, username, secret, claim key or hash", async () => {
  const db = await freshDb();
  const row = await account(db);
  await updateAccount(db, row.id, { localModelsOnly: true, digestOptIn: true, lastSyncAt: NOW });
  const inbox = await folder(db, row.id, "INBOX", "\\Inbox");
  await message(db, { accountId: row.id, folderId: inbox.id, uid: 1, messageId: "<m1@mail.example.test>" });

  const overview = await accountsOverview(db, { localInstanceId: LOCAL });
  assert.deepEqual(Object.keys(overview).sort(), ["accounts", "elsewhere"]);
  assert.deepEqual(Object.keys(overview.accounts[0]).sort(), [
    "address", "digestOptIn", "heldBy", "id", "label", "lastSyncAt", "localModelsOnly", "status",
    "statusDetail", "unreadCount",
  ]);
  const view = overview.accounts[0];
  assert.equal(view.id, row.id);
  assert.equal(view.label, "Personal");
  assert.equal(view.address, "alex@example.com", "the address is shown: it is what the owner connected");
  assert.equal(view.status, "active");
  assert.equal(view.statusDetail, null);
  assert.equal(view.heldBy, null);
  assert.equal(view.localModelsOnly, true);
  assert.equal(view.digestOptIn, true);
  assert.equal(view.lastSyncAt, NOW);
  assert.equal(view.unreadCount, 1);

  const text = JSON.stringify(overview);
  for (const needle of ["mail.example.test", "993", "465", "alexuser", "imap", "smtp", "MAIL_PASSWORD",
    addressHash("alex@example.com"), "mail_claim"]) {
    assert.equal(text.includes(needle), false, `the overview holds ${needle}`);
  }
});

test("unreadCount counts across folders, once per logical message", async () => {
  const db = await freshDb();
  const row = await account(db);
  const inbox = await folder(db, row.id, "INBOX", "\\Inbox");
  const archive = await folder(db, row.id, "Archive", "\\Archive");

  // A Gmail label copy: the same message in two folders, unread in both. One message.
  await message(db, { accountId: row.id, folderId: inbox.id, uid: 1, messageId: "<m1@mail.example.test>" });
  await message(db, { accountId: row.id, folderId: archive.id, uid: 7, messageId: "<m1@mail.example.test>" });
  // A read message is not counted, wherever it sits.
  const read = await message(db, { accountId: row.id, folderId: inbox.id, uid: 2, messageId: "<m2@mail.example.test>" });
  assert.ok(read.id);
  await db.execute({ sql: "UPDATE mail_messages SET is_read = 1 WHERE id = ?", args: [read.id] });
  // A message with no Message-ID groups alone.
  await message(db, { accountId: row.id, folderId: archive.id, uid: 8, messageId: null });

  const overview = await accountsOverview(db, { localInstanceId: LOCAL });
  assert.equal(overview.accounts[0].unreadCount, 2);

  // A second account's mail never counts towards the first.
  const other = await account(db, { label: "Work", address: "sam@example.com" });
  const otherInbox = await folder(db, other.id, "INBOX", "\\Inbox");
  await message(db, { accountId: other.id, folderId: otherInbox.id, uid: 1, messageId: "<m3@mail.example.test>" });
  const both = await accountsOverview(db, { localInstanceId: LOCAL });
  assert.deepEqual(both.accounts.map((a) => [a.address, a.unreadCount]), [
    ["alex@example.com", 2],
    ["sam@example.com", 1],
  ]);
});

test("heldBy names the winning instance for a claimed_elsewhere account; elsewhere carries names and times", async () => {
  const db = await freshDb();
  await addInstance(db, PEER, "Studio");
  const row = await account(db, { label: "Shared", address: "shared@example.com" });
  await writeClaim(db, "shared@example.com", { localInstanceId: PEER, instanceName: "Studio", now: 1_000 });
  await updateAccount(db, row.id, { status: "claimed_elsewhere" });

  const overview = await accountsOverview(db, { localInstanceId: LOCAL });
  assert.equal(overview.accounts[0].heldBy, "Studio");
  assert.deepEqual(overview.elsewhere, [{ instanceName: "Studio", claimedAt: 1_000 }]);
  const text = JSON.stringify(overview);
  assert.equal(text.includes(addressHash("shared@example.com")), false);
  assert.equal(text.includes("mail_claim"), false);
  assert.equal(text.includes("@example.com"), true, "the row's own address is its own field");

  // The holder released it: the status is stale until the supervisor re-evaluates, and heldBy says so.
  await releaseClaim(db, "shared@example.com", { localInstanceId: PEER });
  const cleared = await accountsOverview(db, { localInstanceId: LOCAL });
  assert.equal(cleared.accounts[0].heldBy, null);
  assert.deepEqual(cleared.elsewhere, []);
});

test("a claim this instance already won leaves heldBy null; no claim at all lists nothing elsewhere", async () => {
  const db = await freshDb();
  const row = await account(db);
  await writeClaim(db, row.address, { localInstanceId: LOCAL, instanceName: "Delta", now: 2_000 });
  const overview = await accountsOverview(db, { localInstanceId: LOCAL });
  assert.equal(overview.accounts[0].heldBy, null, "our own claim is not 'elsewhere'");
  assert.deepEqual(overview.elsewhere, []);
});

test("an empty mailbox answers an empty list, not an error", async () => {
  const db = await freshDb();
  assert.deepEqual(await accountsOverview(db, { localInstanceId: LOCAL }), { accounts: [], elsewhere: [] });
});