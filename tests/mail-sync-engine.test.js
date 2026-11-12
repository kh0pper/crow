// Crow Mail's sync engine (Task 14 of plan 1) against a scratch DB built from MAIL_DDL and the
// in-memory fake adapter, plus one end-to-end pass over the fake IMAP server and the real adapter.
//
// Everything here is about the watermark: a first sync reads the account's window and then advances
// `highest_uid` to the listing's `uidNext - 1`, every later sync lists only `afterUid`, and no pass
// ever steps over a UID it did not receive. The rest is the behaviour that keeps a hostile mailbox
// and an interrupted pass from taking the folder with them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import { createAccount, getAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
import {
  getFolder,
  listFolders,
  searchLocal,
  setFolderSyncState,
  storedUids,
  upsertFolders,
  upsertMessage,
} from "../servers/gateway/mail/store/messages.js";
import { parseRawMessage } from "../servers/gateway/mail/parse.js";
import {
  SKIP_SPECIAL_USE,
  SYNC_BATCH_BYTES,
  SYNC_BATCH_MAX,
  resetSyncLivenessForTests,
  syncAccount,
  syncFolder,
} from "../servers/gateway/mail/sync/engine.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import { createFakeMailAdapter } from "./fixtures/fake-mail-adapter.mjs";
import {
  FAKE_PASSWORD, FAKE_USER, createFakeImapServer, makeRaw,
} from "./fixtures/fake-mail-server.mjs";
import { createImapSmtpAdapter } from "../servers/gateway/mail/adapter/imap-smtp.js";

const ALEX = "alex@example.com";
const MAIL_HOST = "mail.example.test";
const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-sync-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  return db;
}

/** A scratch DB with one account and one fake adapter whose clock is the test's. */
async function setup(accountPatch = {}) {
  // The omitted-UID liveness count is module state keyed by folder id, and every scratch DB numbers
  // its folders from 1: one test's stuck count must never reach the next test's folder.
  resetSyncLivenessForTests();
  const db = await freshDb();
  const account = await createAccount(db, {
    address: ALEX,
    label: "Alex",
    imap: { host: MAIL_HOST, port: 993, security: "ssl" },
    smtp: { host: MAIL_HOST, port: 587, security: "starttls" },
  });
  if (Object.keys(accountPatch).length > 0) await updateAccount(db, account.id, accountPatch);
  const adapter = createFakeMailAdapter({ now: () => T0 });
  return { db, accountId: account.id, adapter };
}

const ctxFor = (db, adapter, extra = {}) => ({ db, adapter, now: () => T0, ...extra });

const getCalls = (adapter) => adapter.calls.filter((call) => call.method === "get");
const listCalls = (adapter) => adapter.calls.filter((call) => call.method === "list");

/** The stored folder row for one path, created by a folder listing the way syncAccount does it. */
async function prepareFolder(db, adapter, accountId, path) {
  await upsertFolders(db, accountId, await adapter.listFolders());
  const folder = (await listFolders(db, accountId)).find((candidate) => candidate.path === path);
  assert.ok(folder, `folder ${path} was stored`);
  return folder;
}

/** Sync one folder the way the account pass would, and answer what the store holds afterwards. */
async function syncOne(db, adapter, accountId, path = "INBOX", extra = {}) {
  const folder = await prepareFolder(db, adapter, accountId, path);
  const result = await syncFolder(ctxFor(db, adapter, extra), accountId, folder);
  return { result, folder: await getFolder(db, folder.id) };
}

async function messageRows(db, folderId) {
  const { rows } = await db.execute({
    sql: `SELECT uid, flags_json, is_read, parse_error, subject FROM mail_messages
           WHERE folder_id = ? ORDER BY uid ASC`,
    args: [folderId],
  });
  return rows.map((row) => ({
    uid: Number(row.uid),
    flags: JSON.parse(row.flags_json ?? "[]"),
    isRead: Boolean(row.is_read),
    parseError: row.parse_error ?? null,
    subject: row.subject,
  }));
}

/** Put one message on the fake server, with the internal date the window tests need. */
function deliver(adapter, mailbox, options, internalDate = T0) {
  return adapter.deliver(mailbox, makeRaw(options), { internalDate });
}

/**
 * A db identical to the real one, with every statement shown to `onStatement` first — the hook the
 * yield and mid-pass tests use to watch (or interrupt) a write while a pass is running.
 */
function watchedDb(db, onStatement) {
  const see = (statement) => onStatement(typeof statement === "string" ? null : statement);
  return {
    execute: (statement) => { see(statement); return db.execute(statement); },
    batch: (statements) => db.batch(statements),
    executeMultiple: (sql) => db.executeMultiple(sql),
    runTransaction: (work) => db.runTransaction((run) => work((statement) => {
      see(statement);
      return run(statement);
    })),
  };
}

const isMessageInsert = (statement) => Boolean(statement) && /INSERT INTO mail_messages/.test(statement.sql);

/* --------------------------------------------------------------- first sync */

test("a first sync stores the account's 90-day window and moves the watermark to uidNext - 1", async () => {
  const { db, accountId, adapter } = await setup();
  for (const days of [10, 80, 100, 200]) {
    deliver(adapter, "INBOX", { subject: `day ${days}` }, T0 - days * DAY);
  }

  const { result, folder } = await syncOne(db, adapter, accountId);

  assert.equal(result.added, 2);
  assert.equal(result.reset, false);
  assert.deepEqual(await storedUids(db, folder.id), [1, 2]);
  // The listing's UIDNEXT, never the newest stored UID: mail outside the window must not pin the
  // watermark to a UID the next pass would then walk past.
  assert.equal(folder.highestUid, 4);
  assert.equal(folder.floorUid, 1);
  assert.equal(folder.uidValidity, 71);
});

test("window_days narrows what a first sync stores", async () => {
  const { db, accountId, adapter } = await setup({ windowDays: 30 });
  deliver(adapter, "INBOX", { subject: "ten days" }, T0 - 10 * DAY);
  deliver(adapter, "INBOX", { subject: "eighty days" }, T0 - 80 * DAY);

  const { result, folder } = await syncOne(db, adapter, accountId);

  assert.equal(result.added, 1);
  assert.deepEqual(await storedUids(db, folder.id), [1]);
  assert.equal(folder.highestUid, 2);
});

test("an empty window still advances the watermark, and the next pass fetches nothing", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "ancient" }, T0 - 300 * DAY);

  const { result, folder } = await syncOne(db, adapter, accountId);
  assert.equal(result.added, 0);
  assert.deepEqual(await storedUids(db, folder.id), []);
  assert.equal(folder.highestUid, 1, "uidNext (2) - 1");
  assert.equal(folder.floorUid, 2, "nothing stored, so the floor is uidNext");

  const getsBefore = getCalls(adapter).length;
  const second = await syncOne(db, adapter, accountId);
  assert.equal(second.result.added, 0);
  assert.equal(getCalls(adapter).length, getsBefore, "no new UID means no body fetch");
  assert.equal(second.folder.highestUid, 1);
});

/* --------------------------------------------------------------- later syncs */

test("a later sync lists from the watermark and fetches only the new UIDs", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  deliver(adapter, "INBOX", { subject: "two" });
  await syncOne(db, adapter, accountId);

  deliver(adapter, "INBOX", { subject: "three" });
  const { result, folder } = await syncOne(db, adapter, accountId);

  assert.equal(result.added, 1);
  assert.deepEqual(getCalls(adapter).at(-1).args[1], [3]);
  assert.deepEqual(await storedUids(db, folder.id), [1, 2, 3]);
  assert.equal(folder.highestUid, 3);
});

test("an afterUid above the mailbox (the n:* quirk) stores nothing and duplicates nothing", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  deliver(adapter, "INBOX", { subject: "two" });
  const { folder } = await syncOne(db, adapter, accountId);
  await setFolderSyncState(db, folder.id, { highestUid: 999 });

  const { result, folder: after } = await syncOne(db, adapter, accountId);

  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.deepEqual(await storedUids(db, after.id), [1, 2]);
  assert.equal(after.highestUid, 999, "the watermark never goes backwards");
});

test("a flag change on the server reaches the stored row", async () => {
  const { db, accountId, adapter } = await setup();
  const uid = deliver(adapter, "INBOX", { subject: "flag me" });
  await syncOne(db, adapter, accountId);
  assert.deepEqual((await messageRows(db, (await prepareFolder(db, adapter, accountId, "INBOX")).id))[0].flags, []);

  let seen = false;
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    const listing = await realList(path, options);
    if (!seen) return listing;
    return { ...listing, items: listing.items.map((item) => (item.uid === uid ? { ...item, flags: ["\\Seen"] } : item)) };
  };
  seen = true;

  const folder = await prepareFolder(db, adapter, accountId, "INBOX");
  await syncFolder(ctxFor(db, adapter), accountId, folder);
  const [row] = await messageRows(db, folder.id);
  assert.deepEqual(row.flags, ["\\Seen"]);
  assert.equal(row.isRead, true);
});

test("an expunge removes the row and its full-text entry", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "kept message about sparrows" });
  deliver(adapter, "INBOX", { subject: "gone message about kingfishers" });
  const { folder } = await syncOne(db, adapter, accountId);
  assert.equal((await searchLocal(db, { q: "kingfishers" })).length, 1);

  adapter.expunge("INBOX", 2);
  const { result } = await syncOne(db, adapter, accountId);

  assert.equal(result.removed, 1);
  assert.deepEqual(await storedUids(db, folder.id), [1]);
  assert.equal((await searchLocal(db, { q: "kingfishers" })).length, 0);
});

test("a message moved in with an old date arrives as a new high UID and survives the next pass", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  await syncOne(db, adapter, accountId);

  const uid = adapter.moveIn("INBOX", makeRaw({ subject: "moved in" }), { internalDate: T0 - 200 * DAY });
  assert.equal(uid, 2);
  const { result, folder } = await syncOne(db, adapter, accountId);
  assert.equal(result.added, 1);
  assert.deepEqual(await storedUids(db, folder.id), [1, 2]);

  const again = await syncOne(db, adapter, accountId);
  assert.equal(again.result.removed, 0);
  assert.deepEqual(await storedUids(db, again.folder.id), [1, 2]);
});

test("an older message fetched on demand is removed when it is expunged on the server", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "very old" }, T0 - 200 * DAY);
  deliver(adapter, "INBOX", { subject: "older window" }, T0 - 20 * DAY);
  deliver(adapter, "INBOX", { subject: "newest window" }, T0 - 10 * DAY);
  const { folder } = await syncOne(db, adapter, accountId);
  assert.deepEqual(await storedUids(db, folder.id), [2, 3]);
  assert.equal(folder.floorUid, 2);

  // What plan 2's on-demand read does: one row below the floor, from a UID the window never asked for.
  const parsed = await parseRawMessage(makeRaw({ subject: "fetched on demand" }));
  await upsertMessage(db, {
    ...parsed, accountId, folderId: folder.id, uid: 1, flags: [], internalDate: T0 - 200 * DAY,
  });
  assert.deepEqual(await storedUids(db, folder.id), [1, 2, 3]);

  adapter.expunge("INBOX", 1);
  const { result } = await syncOne(db, adapter, accountId);

  assert.equal(result.removed, 1);
  assert.deepEqual(await storedUids(db, folder.id), [2, 3]);
});

test("a UIDVALIDITY change empties the folder and re-runs the first sync", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  deliver(adapter, "INBOX", { subject: "two" });
  await syncOne(db, adapter, accountId);

  const validity = adapter.bumpUidValidity("INBOX");
  const { result, folder } = await syncOne(db, adapter, accountId);

  assert.equal(result.reset, true);
  assert.equal(result.added, 2, "every row was re-created under the new validity");
  assert.equal(folder.uidValidity, validity);
  assert.deepEqual(await storedUids(db, folder.id), [1, 2], "no duplicates");
  assert.equal(folder.highestUid, 2);
});

test("a listing with no UIDVALIDITY never empties the folder", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  deliver(adapter, "INBOX", { subject: "two" });
  const { folder } = await syncOne(db, adapter, accountId);
  assert.equal(folder.uidValidity, 71);

  // A server that answers without UIDVALIDITY. `Number(null)` is 0, which is not a validity: an
  // unknown on either side is never a change.
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    const listing = await realList(path, options);
    return path === "INBOX" ? { ...listing, uidValidity: null } : listing;
  };
  deliver(adapter, "INBOX", { subject: "three" });
  const { result, folder: after } = await syncOne(db, adapter, accountId);

  assert.equal(result.reset, false, "a value nobody reported is not a change");
  assert.deepEqual(await storedUids(db, after.id), [1, 2, 3], "the rows it held were not emptied");
  assert.equal(after.uidValidity, 71, "the stored validity is left exactly as it was");
  assert.equal(after.highestUid, 3);
});

test("a first sync stores UIDVALIDITY only when the listing reported a positive integer", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "Archive", { subject: "archived" });
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    const listing = await realList(path, options);
    return path === "Archive" ? { ...listing, uidValidity: null } : listing;
  };

  const { folder } = await syncOne(db, adapter, accountId, "Archive");

  assert.equal(folder.uidValidity, null, "the column stays null, not 0");
  assert.equal(folder.highestUid, 1);
  assert.deepEqual(await storedUids(db, folder.id), [1]);
});

test("a later pass fills in a UIDVALIDITY the first sync could not report, and a change after that resets", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  deliver(adapter, "INBOX", { subject: "two" });

  // The first sync runs against a server that says nothing about UIDVALIDITY: unknown, never a 0.
  const realList = adapter.list;
  let quiet = true;
  adapter.list = async (path, options) => {
    const listing = await realList(path, options);
    return quiet && path === "INBOX" ? { ...listing, uidValidity: null } : listing;
  };

  const { folder } = await syncOne(db, adapter, accountId);
  assert.equal(folder.uidValidity, null, "nothing was reported, so nothing was stored");
  assert.equal(folder.highestUid, 2);

  // A later pass whose listing DOES report one writes it, and only then can a change be compared.
  quiet = false;
  deliver(adapter, "INBOX", { subject: "three" });
  const { result, folder: filled } = await syncOne(db, adapter, accountId);
  assert.equal(result.reset, false, "unknown is still not a change");
  assert.equal(filled.uidValidity, 71, "the value the listing reported is now stored");
  assert.equal(filled.highestUid, 3);
  assert.deepEqual(await storedUids(db, filled.id), [1, 2, 3]);

  const validity = adapter.bumpUidValidity("INBOX");
  const { result: reset, folder: after } = await syncOne(db, adapter, accountId);
  assert.equal(reset.reset, true, "from here a change IS a change");
  assert.equal(after.uidValidity, validity);
  assert.deepEqual(await storedUids(db, after.id), [1, 2, 3], "re-created, not duplicated");
});

/* ----------------------------------------------------------------- failures */

test("a failed listing deletes nothing and leaves the watermark where it was", async () => {
  const { db, accountId, adapter } = await setup();
  for (const subject of ["one", "two", "three"]) deliver(adapter, "INBOX", { subject });
  const { folder } = await syncOne(db, adapter, accountId);
  assert.equal(folder.highestUid, 3);

  adapter.failNext("list", new MailError("NETWORK", "ECONNRESET"));
  await assert.rejects(
    syncFolder(ctxFor(db, adapter), accountId, folder),
    (err) => err instanceof MailError && err.code === "NETWORK",
  );

  const after = await getFolder(db, folder.id);
  assert.deepEqual(await storedUids(db, folder.id), [1, 2, 3]);
  assert.equal(after.highestUid, 3);
  assert.equal(after.uidValidity, folder.uidValidity);
});

test("a failure mid-download keeps the rows it stored and the next pass finishes without duplicates", async () => {
  const { db, accountId, adapter } = await setup();
  for (let i = 1; i <= 5; i += 1) deliver(adapter, "INBOX", { subject: `seed ${i}` });
  const { folder } = await syncOne(db, adapter, accountId);
  for (let i = 6; i <= 35; i += 1) deliver(adapter, "INBOX", { subject: `arrival ${i}` });

  const realGet = adapter.get;
  let gets = 0;
  adapter.get = async (path, uids) => {
    gets += 1;
    if (gets === 2) throw new MailError("NETWORK", "ECONNRESET");
    return realGet(path, uids);
  };

  await assert.rejects(
    syncFolder(ctxFor(db, adapter), accountId, folder),
    (err) => err instanceof MailError && err.code === "NETWORK",
  );
  const interrupted = await getFolder(db, folder.id);
  assert.equal(interrupted.highestUid, 30, "progress at the first completed batch (uids 6..30)");
  assert.equal((await storedUids(db, folder.id)).length, 30);

  adapter.get = realGet;
  const { result, folder: finished } = await syncOne(db, adapter, accountId);

  assert.equal(result.added, 5);
  const uids = await storedUids(db, finished.id);
  assert.equal(uids.length, 35);
  assert.equal(new Set(uids).size, 35, "no duplicates");
  assert.equal(finished.highestUid, 35);
});

test("a UID get() leaves out holds the watermark, stores nothing for it, and the next pass gets it", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "seed" });
  const { folder } = await syncOne(db, adapter, accountId);
  deliver(adapter, "INBOX", { subject: "omitted" });
  deliver(adapter, "INBOX", { subject: "after the omission" });

  const realGet = adapter.get;
  let omitting = true;
  let omittedCalls = 0;
  adapter.get = async (path, uids) => {
    const messages = await realGet(path, uids);
    if (!omitting) return messages;
    omittedCalls += 1;
    return messages.filter((message) => message.uid !== 2);
  };

  const { result, folder: stopped } = await syncOne(db, adapter, accountId);
  assert.equal(result.added, 0);
  assert.equal(omittedCalls, 2, "one batch call and one retry on its own, never a loop");
  assert.equal(stopped.highestUid, 1, "lowest omitted UID (2) - 1");
  assert.deepEqual(await storedUids(db, stopped.id), [1], "nothing was stored for the UID not delivered");

  omitting = false;
  const { result: recovered, folder: finished } = await syncOne(db, adapter, accountId);
  assert.equal(recovered.added, 2);
  assert.deepEqual(await storedUids(db, finished.id), [1, 2, 3]);
  assert.equal(finished.highestUid, 3);
});

test("a pass that stops on an omitted UID still applies flags and expunges below it", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "flag me" });
  deliver(adapter, "INBOX", { subject: "gone from the server" });
  const { folder } = await syncOne(db, adapter, accountId);
  assert.deepEqual(await storedUids(db, folder.id), [1, 2]);

  // The stop path must not lose rule 3: an expunge below the watermark and a flag on the row the
  // folder keeps are both settled below the hole, so the same pass applies them.
  adapter.expunge("INBOX", 2);
  deliver(adapter, "INBOX", { subject: "never delivered" }); // uid 3
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    const listing = await realList(path, options);
    if (path !== "INBOX") return listing;
    return {
      ...listing,
      items: listing.items.map((item) => (item.uid === 1 ? { ...item, flags: ["\\Seen"] } : item)),
    };
  };
  const realGet = adapter.get;
  adapter.get = async (path, uids) => (await realGet(path, uids)).filter((message) => message.uid !== 3);

  const logs = [];
  const folderRow = await prepareFolder(db, adapter, accountId, "INBOX");
  const result = await syncFolder(ctxFor(db, adapter, { log: (entry) => logs.push(entry) }), accountId, folderRow);

  assert.equal(result.added, 0);
  assert.equal(result.removed, 1, "the expunge below the hole was applied in the same pass");
  const rows = await messageRows(db, folderRow.id);
  assert.deepEqual(rows.map((row) => row.uid), [1]);
  assert.deepEqual(rows[0].flags, ["\\Seen"], "the flag change was applied in the same pass");
  assert.equal((await getFolder(db, folderRow.id)).highestUid, 2, "the watermark stops below the hole");
  assert.ok(logs.some((entry) => entry.event === "uid_omitted" && entry.uid === 3 && entry.code === "omitted"));
});

test("a get() that answers with a string uid is still matched to its message", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  deliver(adapter, "INBOX", { subject: "two" });
  const realGet = adapter.get;
  adapter.get = async (path, uids) => [
    ...(await realGet(path, uids)).map((message) => ({ ...message, uid: String(message.uid) })),
    // A result naming no UID at all is not a message and is dropped, never stored under NaN.
    { uid: "seven", flags: [], internalDate: T0, raw: Buffer.from(makeRaw({ subject: "ghost" })) },
  ];

  const { result, folder } = await syncOne(db, adapter, accountId);

  assert.equal(result.added, 2, "both messages were delivered, not read as omissions");
  assert.deepEqual(await storedUids(db, folder.id), [1, 2]);
  assert.equal(folder.highestUid, 2);
});

test("a get() answer without raw bytes is an omission, and an empty body is a too_large row", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  deliver(adapter, "INBOX", { subject: "no bytes came back" }); // uid 2
  adapter.deliver("INBOX", Buffer.alloc(0)); // uid 3: a body the adapter reported as empty

  const realGet = adapter.get;
  const withoutBytes = (message) => {
    if (message.uid !== 2) return message;
    const { raw, ...rest } = message;
    return rest;
  };
  let stripped = true;
  adapter.get = async (path, uids) => (await realGet(path, uids))
    .map((message) => (stripped ? withoutBytes(message) : message));

  const logs = [];
  const { folder: stopped } = await syncOne(db, adapter, accountId, "INBOX", { log: (entry) => logs.push(entry) });
  assert.equal(stopped.highestUid, 1, "a message with no bytes is missing, not too large");
  assert.deepEqual(await storedUids(db, stopped.id), [1]);
  assert.ok(logs.some((entry) => entry.event === "uid_omitted" && entry.uid === 2));

  stripped = false;
  const { folder: finished } = await syncOne(db, adapter, accountId, "INBOX");
  assert.deepEqual(await storedUids(db, finished.id), [1, 2, 3]);
  const rows = await messageRows(db, finished.id);
  assert.equal(rows[1].parseError, null, "the message the adapter did deliver was parsed");
  assert.equal(rows[2].parseError, "too_large", "only a zero-length body is a too_large row");
});

/* --------------------------------------------------- a UID nothing ever delivers */

test("a UID no pass ever receives is skipped on the third stuck pass and the folder advances", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  await syncOne(db, adapter, accountId);
  deliver(adapter, "INBOX", { subject: "never delivered" }); // uid 2
  deliver(adapter, "INBOX", { subject: "three" }); // uid 3

  const realGet = adapter.get;
  adapter.get = async (path, uids) => (await realGet(path, uids)).filter((message) => message.uid !== 2);

  const first = await syncOne(db, adapter, accountId);
  assert.equal(first.folder.highestUid, 1, "pass 1 stops below the UID it never got");
  assert.equal(first.result.added, 0);

  const second = await syncOne(db, adapter, accountId);
  assert.equal(second.folder.highestUid, 1, "pass 2 is stuck at the same UID");
  assert.deepEqual(await storedUids(db, second.folder.id), [1]);

  const logs = [];
  const folderRow = await prepareFolder(db, adapter, accountId, "INBOX");
  const third = await syncFolder(ctxFor(db, adapter, { log: (entry) => logs.push(entry) }), accountId, folderRow);

  assert.equal(third.added, 1, "the messages after the stuck UID are stored");
  const after = await getFolder(db, folderRow.id);
  assert.equal(after.highestUid, 3, "the watermark moves past it");
  assert.deepEqual(await storedUids(db, folderRow.id), [1, 3], "nothing is stored for the skipped UID");
  const skipped = logs.find((entry) => entry.event === "uid_skipped");
  assert.ok(skipped, "the give-up is a log line, not a silent hole");
  assert.deepEqual(skipped, { event: "uid_skipped", folderId: folderRow.id, uid: 2, code: "omitted" });
});

test("a delivered UID clears its stuck count, so a later omission starts again from one", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  await syncOne(db, adapter, accountId);
  deliver(adapter, "INBOX", { subject: "sometimes delivered" }); // uid 2
  deliver(adapter, "INBOX", { subject: "fine" }); // uid 3

  const realGet = adapter.get;
  let omitting = new Set([2]);
  adapter.get = async (path, uids) => (await realGet(path, uids))
    .filter((message) => !omitting.has(message.uid));

  assert.equal((await syncOne(db, adapter, accountId)).folder.highestUid, 1, "pass 1 stops");
  assert.equal((await syncOne(db, adapter, accountId)).folder.highestUid, 1, "pass 2 stops too");

  // uid 2 arrives, but the pass stops on uid 3 — so the delivery itself is what clears uid 2's
  // count; the clearing a completed pass does for the whole folder never runs here.
  omitting = new Set([3]);
  const delivered = await syncOne(db, adapter, accountId);
  assert.deepEqual(await storedUids(db, delivered.folder.id), [1, 2]);
  assert.equal(delivered.folder.highestUid, 2);

  // uid 2 missing again, from a watermark wound back (what an interrupted run leaves behind): the
  // count starts from one, so this pass STOPS at it instead of skipping it on the third go.
  await setFolderSyncState(db, delivered.folder.id, { highestUid: 1 });
  omitting = new Set([2]);
  const stuckAgain = await syncOne(db, adapter, accountId);
  assert.equal(stuckAgain.folder.highestUid, 1, "the delivery cleared the count");
  assert.deepEqual(await storedUids(db, stuckAgain.folder.id), [1, 2], "nothing past the stop was stored");
});

test("a UIDVALIDITY reset drops the old epoch's stuck count, so the new epoch stops instead of skipping", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  await syncOne(db, adapter, accountId);
  deliver(adapter, "INBOX", { subject: "never delivered" }); // uid 2
  deliver(adapter, "INBOX", { subject: "three" }); // uid 3

  const realGet = adapter.get;
  adapter.get = async (path, uids) => (await realGet(path, uids)).filter((message) => message.uid !== 2);

  // Two passes in the old epoch leave uid 2 stuck at count 2.
  assert.equal((await syncOne(db, adapter, accountId)).folder.highestUid, 1, "pass 1 stops");
  assert.equal((await syncOne(db, adapter, accountId)).folder.highestUid, 1, "pass 2 is stuck at count 2");

  // The mailbox's UIDs all mean something else now. The new epoch omits uid 2 once too: that first
  // pass must STOP at it, because the old epoch's count said nothing about these UIDs.
  const validity = adapter.bumpUidValidity("INBOX");
  const logs = [];
  const { result, folder } = await syncOne(db, adapter, accountId, "INBOX", { log: (entry) => logs.push(entry) });

  assert.equal(result.reset, true);
  assert.equal(folder.uidValidity, validity);
  assert.equal(result.added, 1, "the row below the hole was re-created");
  assert.equal(folder.highestUid, 1, "the new epoch's first pass stops at uid 2 instead of skipping it");
  assert.deepEqual(await storedUids(db, folder.id), [1], "nothing past the stop was stored");
  assert.ok(!logs.some((entry) => entry.event === "uid_skipped"),
    "the old epoch's count did not carry into the new one");
});

/* -------------------------------------------------------- the account pass */

test("a removed folder goes and a listing without INBOX deletes nothing", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  await syncAccount(ctxFor(db, adapter), accountId);
  assert.deepEqual((await listFolders(db, accountId)).map((folder) => folder.path).sort(),
    ["Archive", "Drafts", "INBOX", "Sent"]);

  const realListFolders = adapter.listFolders;
  adapter.listFolders = async () => (await realListFolders()).filter((entry) => entry.path !== "Archive");
  const deleteLogs = [];
  await syncAccount(ctxFor(db, adapter, { log: (entry) => deleteLogs.push(entry) }), accountId);
  assert.ok(deleteLogs.some((entry) => entry.event === "folders_deleted" && entry.count === 1));
  assert.deepEqual((await listFolders(db, accountId)).map((folder) => folder.path).sort(),
    ["Drafts", "INBOX", "Sent"]);

  // A listing with no inbox is a listing Crow does not trust: nothing is deleted on it. It offers the
  // two folders it does list, so the deleted Archive is not handed back to the store.
  adapter.listFolders = async () => (await realListFolders())
    .filter((entry) => entry.path === "Sent" || entry.path === "Drafts");
  const logs = [];
  await syncAccount(ctxFor(db, adapter, { log: (entry) => logs.push(entry) }), accountId);
  assert.deepEqual((await listFolders(db, accountId)).map((folder) => folder.path).sort(),
    ["Drafts", "INBOX", "Sent"]);
  assert.ok(logs.some((entry) => entry.event === "deletes_refused"));
});

test("the three virtual folders are skipped, case-insensitively, and SKIP_SPECIAL_USE is exactly them", async () => {
  assert.deepEqual([...SKIP_SPECIAL_USE], ["\\All", "\\Flagged", "\\Important"]);

  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  const virtual = [
    { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
    { path: "[Gmail]/Starred", name: "Starred", specialUse: "\\Flagged" },
    { path: "[Gmail]/Important", name: "Important", specialUse: "\\Important" },
    { path: "custom view", name: "custom view", specialUse: "\\all" },
  ];
  const realListFolders = adapter.listFolders;
  adapter.listFolders = async () => [
    ...(await realListFolders()),
    ...virtual.map((entry) => ({ ...entry, delimiter: "/", selectable: true })),
  ];

  const result = await syncAccount(ctxFor(db, adapter), accountId);

  assert.equal(result.folders, 4, "only the four real folders were synced");
  const listed = listCalls(adapter).map((call) => call.args[0]);
  for (const entry of virtual) assert.ok(!listed.includes(entry.path), `${entry.path} was never listed`);
});

test("a selectable:false folder is never synced and an odd path is passed through untouched", async () => {
  const { db, accountId, adapter } = await setup();
  const oddPath = "Projekte/Ünïcode & Sonder zeichen/Ärger 2026";
  const raw = makeRaw({ subject: "odd folder message" });
  const realListFolders = adapter.listFolders;
  adapter.listFolders = async () => [
    ...(await realListFolders()),
    { path: oddPath, name: "Ärger 2026", specialUse: null, delimiter: "/", selectable: true },
    { path: "Not Selectable", name: "Not Selectable", specialUse: null, delimiter: "/", selectable: false },
  ];
  const realList = adapter.list;
  const served = [];
  adapter.list = async (path, options) => {
    if (path !== oddPath) return realList(path, options);
    served.push(path);
    return { uidValidity: 99, uidNext: 2, items: [{ uid: 1, flags: [], internalDate: T0, size: raw.length }] };
  };
  const realGet = adapter.get;
  adapter.get = async (path, uids) => (path === oddPath
    ? [{ uid: 1, flags: [], internalDate: T0, raw: Buffer.from(raw) }]
    : realGet(path, uids));

  await syncAccount(ctxFor(db, adapter), accountId);

  assert.deepEqual(served, [oddPath], "the path reaches the adapter byte for byte");
  const odd = (await listFolders(db, accountId)).find((folder) => folder.path === oddPath);
  assert.deepEqual(await storedUids(db, odd.id), [1]);
  const listed = listCalls(adapter).map((call) => call.args[0]);
  assert.ok(!listed.includes("Not Selectable"), "a noselect folder is never listed");
});

test("one failing folder does not stop the others", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "inbox one" });
  deliver(adapter, "Drafts", { subject: "draft one" }, T0);
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    if (path === "Sent") throw new MailError("PROTOCOL", "list");
    return realList(path, options);
  };

  const logs = [];
  const result = await syncAccount(ctxFor(db, adapter, { log: (entry) => logs.push(entry) }), accountId);

  assert.equal(result.folders, 3);
  assert.equal(result.added, 2);
  const inbox = (await listFolders(db, accountId)).find((folder) => folder.path === "INBOX");
  assert.deepEqual(await storedUids(db, inbox.id), [1]);
  // A folder's own failure is a log line and the pass carries on: only the connection codes and the
  // pass's own deadline travel further.
  assert.ok(logs.some((entry) => entry.event === "folder_failed" && entry.code === "PROTOCOL"));
});

test("a NETWORK failure in a later folder ends the whole pass and stamps no lastSyncAt", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "inbox one" });
  const realList = adapter.list;
  // Folders are synced in path order: Archive, Drafts, INBOX, Sent. Drafts is the second one.
  adapter.list = async (path, options) => {
    if (path === "Drafts") throw new MailError("NETWORK", "ECONNRESET");
    return realList(path, options);
  };

  const logs = [];
  await assert.rejects(
    syncAccount(ctxFor(db, adapter, { log: (entry) => logs.push(entry) }), accountId),
    (err) => err instanceof MailError && err.code === "NETWORK",
  );

  assert.equal((await getAccount(db, accountId)).lastSyncAt, null, "a pass that ended early is not stamped");
  const inbox = (await listFolders(db, accountId)).find((folder) => folder.path === "INBOX");
  assert.equal(inbox.highestUid, 0, "the folders after the failing one never ran");
  assert.deepEqual(await storedUids(db, inbox.id), []);
  assert.ok(!logs.some((entry) => entry.event === "folder_failed"), "the failure was not swallowed");
});

test("the pass's own deadline inside a folder ends the whole pass too", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "inbox one" });

  // The clock jumps past the deadline at the first stored row, so it is a folder pass that meets it.
  let expired = false;
  const watched = watchedDb(db, (statement) => {
    if (isMessageInsert(statement)) expired = true;
  });
  const ctx = { db: watched, adapter, now: () => (expired ? T0 + 60_000 : T0), deadlineAt: T0 + 1000 };

  await assert.rejects(
    syncAccount(ctx, accountId),
    (err) => err instanceof MailError && err.code === "TIMEOUT" && err.detail === "sync_deadline",
  );
  assert.equal((await getAccount(db, accountId)).lastSyncAt, null);
});

/* ------------------------------------------------------- hostile and large */

test("RF1: an oversized message, a message the parser cannot read and a normal one all get stored", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "ordinary message" });
  deliver(adapter, "INBOX", { subject: "too large to keep" });
  // Bytes no parser can make sense of: a single header line thirty times over the header budget.
  // (Random bytes are not a failure — postal-mime recovers from malformed content — so the hostile
  // message here is one of the shapes that actually reaches the parser's limits.)
  deliver(adapter, "INBOX", {
    subject: "header bomb",
    extraHeaders: { "X-Pad": "a".repeat(1_500_000) },
  });

  // The listing's reported size is what the engine batches and skips on, so the fake reports the
  // size the server would: 30 MiB for the second message.
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    const listing = await realList(path, options);
    return { ...listing, items: listing.items.map((item) => (item.uid === 2 ? { ...item, size: 30 * MB } : item)) };
  };

  const { result, folder } = await syncOne(db, adapter, accountId);

  assert.equal(result.added, 3);
  const rows = await messageRows(db, folder.id);
  assert.deepEqual(rows.map((row) => row.uid), [1, 2, 3]);
  assert.equal(rows[0].parseError, null);
  assert.equal(rows[1].parseError, "too_large");
  assert.equal(rows[2].parseError, "unparseable");
  assert.equal(folder.highestUid, 3, "a hostile message does not stop the watermark");
  const fetched = getCalls(adapter).flatMap((call) => call.args[1]);
  assert.ok(!fetched.includes(2), "a message above MAX_RAW_BYTES is never downloaded");
});

test("batches stay inside 25 UIDs and 16 MiB, and a message over the budget goes alone", async () => {
  const { db, accountId, adapter } = await setup();
  const sizes = new Map();
  for (let i = 1; i <= 60; i += 1) {
    const uid = deliver(adapter, "INBOX", { subject: `small ${i}` });
    sizes.set(uid, 1 * MB);
  }
  const huge = deliver(adapter, "INBOX", { subject: "one big message" });
  sizes.set(huge, 20 * MB);

  // The listing's sizes drive the batching; the bodies stay small so the test is about the budget.
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    const listing = await realList(path, options);
    return { ...listing, items: listing.items.map((item) => ({ ...item, size: sizes.get(item.uid) ?? item.size })) };
  };

  const { folder } = await syncOne(db, adapter, accountId);

  const calls = getCalls(adapter);
  assert.ok(calls.length > 1, "the listing was split into several calls");
  for (const call of calls) {
    const uids = call.args[1];
    assert.ok(uids.length <= SYNC_BATCH_MAX, `a call asked for ${uids.length} UIDs`);
    const bytes = uids.reduce((total, uid) => total + (sizes.get(uid) ?? 0), 0);
    if (uids.length > 1) assert.ok(bytes <= SYNC_BATCH_BYTES, `a call asked for ${bytes} bytes`);
    assert.deepEqual([...uids].sort((a, b) => a - b), uids, "a call is in ascending UID order");
  }
  const bigCall = calls.find((call) => call.args[1].includes(huge));
  assert.deepEqual(bigCall.args[1], [huge], "a 20 MiB message is a batch of its own");
  assert.equal((await storedUids(db, folder.id)).length, 61);
});

/* ----------------------------------------------------- yielding & deadlines */

/**
 * Watch one 25-message batch being stored, answering how many rows were written after a real yield.
 * The probe is scheduled while the batch is being downloaded and RESET after every stored row, so a
 * single early yield cannot satisfy it: every row needs a yield of its own.
 */
async function probeYields(extra) {
  const { db, accountId, adapter } = await setup();
  for (let i = 1; i <= 25; i += 1) deliver(adapter, "INBOX", { subject: `yield ${i}` });
  const folder = await prepareFolder(db, adapter, accountId, "INBOX");

  let probeRan = false;
  const arm = () => { setImmediate(() => { probeRan = true; }); };
  const realGet = adapter.get;
  adapter.get = async (path, uids) => {
    const messages = await realGet(path, uids);
    arm();
    return messages;
  };
  const probeAtStore = [];
  const watched = watchedDb(db, (statement) => {
    if (!isMessageInsert(statement)) return;
    probeAtStore.push(probeRan);
    probeRan = false;
    // Re-armed for the NEXT row, so one early yield cannot satisfy every later read: each row needs
    // a yield of its own between the previous row and itself.
    arm();
  });

  const result = await syncFolder({ db: watched, adapter, now: () => T0, ...extra }, accountId, folder);
  return { result, probeAtStore };
}

test("RF8: the loop yields to the event loop between the messages of one batch", async () => {
  const { result, probeAtStore } = await probeYields({});

  assert.equal(result.added, 25);
  assert.equal(probeAtStore.length, 25);
  assert.ok(probeAtStore.every(Boolean), "every message was stored after a yield of its own");
});

test("RF8: the same probe fails with a no-op yieldFn, so it really is testing the yield", async () => {
  const { result, probeAtStore } = await probeYields({ yieldFn: () => Promise.resolve() });

  assert.equal(result.added, 25);
  assert.equal(probeAtStore.length, 25);
  assert.ok(!probeAtStore.every(Boolean), "without a yield the probe never gets to run");
});

test("a deadline that has passed aborts with a TIMEOUT and changes nothing", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  const folder = await prepareFolder(db, adapter, accountId, "INBOX");
  const ctx = ctxFor(db, adapter, { deadlineAt: T0 - 1 });

  const timedOut = (err) => {
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "TIMEOUT");
    assert.equal(err.detail, "sync_deadline");
    return true;
  };
  await assert.rejects(syncFolder(ctx, accountId, folder), timedOut);
  await assert.rejects(syncAccount(ctx, accountId), timedOut);

  assert.deepEqual(await storedUids(db, folder.id), []);
  const unchanged = await getFolder(db, folder.id);
  assert.equal(unchanged.highestUid, 0);
  assert.equal(unchanged.floorUid, null);
  assert.equal(unchanged.uidValidity, null);
});

test("a deadline that passes mid-pass keeps the progress the completed batches made", async () => {
  const { db, accountId, adapter } = await setup();
  for (let i = 1; i <= 5; i += 1) deliver(adapter, "INBOX", { subject: `seed ${i}` });
  const { folder } = await syncOne(db, adapter, accountId);
  assert.equal(folder.highestUid, 5);
  for (let i = 6; i <= 35; i += 1) deliver(adapter, "INBOX", { subject: `arrival ${i}` });

  // The clock jumps past the deadline as soon as the first batch's watermark is persisted, so the
  // SECOND batch's own checkDeadline is what ends the pass.
  let expired = false;
  const watched = watchedDb(db, (statement) => {
    if (statement && /UPDATE mail_folders SET highest_uid = \?/.test(statement.sql)) expired = true;
  });

  await assert.rejects(
    syncFolder({ db: watched, adapter, now: () => (expired ? T0 + 60_000 : T0), deadlineAt: T0 + 1000 },
      accountId, folder),
    (err) => err instanceof MailError && err.code === "TIMEOUT" && err.detail === "sync_deadline",
  );

  const interrupted = await getFolder(db, folder.id);
  assert.equal(interrupted.highestUid, 30, "the watermark of the batch that finished (uids 6..30)");
  assert.equal((await storedUids(db, folder.id)).length, 30);
});

test("a deadline that passes during a first sync stores rows and writes no state at all", async () => {
  const { db, accountId, adapter } = await setup();
  for (let i = 1; i <= 30; i += 1) deliver(adapter, "INBOX", { subject: `arrival ${i}` });
  const folder = await prepareFolder(db, adapter, accountId, "INBOX");

  let expired = false;
  let inserted = 0;
  const watched = watchedDb(db, (statement) => {
    if (!isMessageInsert(statement)) return;
    inserted += 1;
    if (inserted === 25) expired = true; // the first batch is done: the pass runs out of time
  });

  await assert.rejects(
    syncFolder({ db: watched, adapter, now: () => (expired ? T0 + 60_000 : T0), deadlineAt: T0 + 1000 },
      accountId, folder),
    (err) => err instanceof MailError && err.code === "TIMEOUT" && err.detail === "sync_deadline",
  );

  assert.equal((await storedUids(db, folder.id)).length, 25, "the rows of the batch that finished");
  const after = await getFolder(db, folder.id);
  assert.equal(after.highestUid, 0, "a first sync writes its state once, at the end");
  assert.equal(after.floorUid, null);
  assert.equal(after.uidValidity, null);
  assert.equal(after.lastSyncedAt, null);
});

test("a first sync that stops on an omitted UID writes the state it reached, below the hole", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "one" });
  deliver(adapter, "INBOX", { subject: "never delivered" }); // uid 2
  deliver(adapter, "INBOX", { subject: "three" });
  const realGet = adapter.get;
  adapter.get = async (path, uids) => (await realGet(path, uids)).filter((message) => message.uid !== 2);

  const logs = [];
  const { result, folder } = await syncOne(db, adapter, accountId, "INBOX", { log: (entry) => logs.push(entry) });

  assert.equal(result.added, 1);
  assert.equal(folder.highestUid, 1, "lowest omitted UID (2) - 1");
  assert.equal(folder.floorUid, 1, "the lowest UID the window did store");
  assert.equal(folder.uidValidity, 71);
  assert.equal(folder.lastSyncedAt, T0, "what it reached is written, so the window is not fetched again");
  assert.deepEqual(await storedUids(db, folder.id), [1]);
  assert.ok(logs.some((entry) => entry.event === "uid_omitted" && entry.uid === 2));
});

test("a message that cannot be stored holds the watermark instead of being stepped over", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "seed" });
  const { folder } = await syncOne(db, adapter, accountId);
  deliver(adapter, "INBOX", { subject: "cannot be stored" }); // uid 2
  deliver(adapter, "INBOX", { subject: "after it" }); // uid 3

  // The store refuses the row for uid 2: the pass must stop there, never close the hole over it.
  const poisoned = watchedDb(db, (statement) => {
    if (isMessageInsert(statement) && Number(statement.args?.[2]) === 2) {
      throw new MailError("TOO_LARGE", "store");
    }
  });
  const logs = [];
  const folderRow = await prepareFolder(db, adapter, accountId, "INBOX");
  const result = await syncFolder(
    { db: poisoned, adapter, now: () => T0, log: (entry) => logs.push(entry) },
    accountId,
    folderRow,
  );

  assert.equal(result.added, 0);
  assert.equal((await getFolder(db, folderRow.id)).highestUid, 1, "the watermark stops below the failed row");
  assert.deepEqual(await storedUids(db, folderRow.id), [1]);
  assert.ok(logs.some((entry) => entry.event === "message_failed" && entry.uid === 2));
  assert.ok(!logs.some((entry) => entry.event === "uid_omitted"), "a store failure is not an omission");
});

test("a store_failed stop below an omitted UID of the same batch loses nothing", async () => {
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "seed" });
  const { folder } = await syncOne(db, adapter, accountId);
  deliver(adapter, "INBOX", { subject: "cannot be stored" }); // uid 2 = X
  deliver(adapter, "INBOX", { subject: "never delivered" }); // uid 3 = Y > X

  // One batch (2 and 3) with two different holes: uid 2 comes back but the store refuses it, uid 3
  // never comes back at all. The lower UID is the stop, so the pass counts a store_failed stop at 2,
  // never closes over 3, and writes a watermark below 2.
  const realGet = adapter.get;
  adapter.get = async (path, uids) => (await realGet(path, uids)).filter((message) => message.uid !== 3);
  const poisoned = watchedDb(db, (statement) => {
    if (isMessageInsert(statement) && Number(statement.args?.[2]) === 2) {
      throw new MailError("TOO_LARGE", "store");
    }
  });
  const logs = [];
  const folderRow = await prepareFolder(db, adapter, accountId, "INBOX");
  const result = await syncFolder(
    { db: poisoned, adapter, now: () => T0, log: (entry) => logs.push(entry) },
    accountId,
    folderRow,
  );

  assert.equal(result.added, 0, "neither hole is closed by a row");
  assert.equal((await getFolder(db, folderRow.id)).highestUid, 2 - 1, "the watermark stops below X");
  assert.deepEqual(await storedUids(db, folderRow.id), [1], "nothing was stored at or above the stop");
  assert.ok(logs.some((entry) => entry.event === "message_failed" && entry.uid === 2),
    "the lower hole is the one the pass stopped on");
  assert.ok(!logs.some((entry) => entry.event === "uid_omitted"),
    "the store failure is the stop, not the omission above it");

  // Nothing is lost: the next pass re-lists from the untouched watermark and stores both.
  adapter.get = realGet;
  const { result: recovered, folder: finished } = await syncOne(db, adapter, accountId);
  assert.equal(recovered.added, 2);
  assert.deepEqual(await storedUids(db, finished.id), [1, 2, 3]);
  assert.equal(finished.highestUid, 3);
});

test("a UIDVALIDITY change between the two listings aborts the folder and deletes nothing", async () => {
  const { db, accountId, adapter } = await setup();
  for (const subject of ["one", "two", "three"]) deliver(adapter, "INBOX", { subject });
  const { folder } = await syncOne(db, adapter, accountId);
  // uid 2 is gone on the server, so rule 3 would drop its row — if rule 3 ever got to run.
  adapter.expunge("INBOX", 2);

  const realList = adapter.list;
  adapter.list = async (path, options) => {
    // The mailbox moves between the rule-2 listing and the rule-3 one.
    if (path === "INBOX" && options?.fromUid != null) adapter.bumpUidValidity("INBOX");
    return realList(path, options);
  };

  await assert.rejects(
    syncFolder(ctxFor(db, adapter), accountId, folder),
    (err) => err instanceof MailError && err.code === "PROTOCOL" && err.detail === "uidvalidity_changed",
  );

  assert.deepEqual(await storedUids(db, folder.id), [1, 2, 3], "nothing was deleted");
});

/* -------------------------------------------------------------------- logs */

test("logs carry only codes, counts and folder ids", async () => {
  const logs = [];
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "Salary review", body: `Ask ${ALEX} about the numbers.` });
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    if (path === "Sent") throw new MailError("PROTOCOL", "list");
    return realList(path, options);
  };

  await syncAccount(ctxFor(db, adapter, { log: (entry) => logs.push(entry) }), accountId);

  assert.ok(logs.length > 0);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes("Salary"), "no subject text");
  assert.ok(!text.includes("example.com"), "no address text");
  for (const path of ["INBOX", "Sent", "Drafts", "Archive"]) {
    assert.ok(!text.includes(path), `no folder path (${path})`);
  }
  const allowed = new Set(["event", "code", "count", "folderId", "uid", "added", "removed", "reset",
    "folders"]);
  for (const entry of logs) {
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `unexpected log field ${key}`);
  }
  assert.ok(logs.some((entry) => entry.event === "folder_failed" && entry.code === "PROTOCOL"));
});

/* ------------------------------------------------------------- end to end */

test("an end-to-end pass over the fake IMAP server syncs, and a second pass applies a flag change", async () => {
  const fake = await createFakeImapServer({ mailboxes: ["INBOX", "Sent"] });
  try {
    const db = await freshDb();
    const account = await createAccount(db, {
      address: FAKE_USER,
      label: "Alex",
      imap: { host: fake.host, port: fake.port, security: "none" },
      smtp: { host: fake.host, port: fake.port, security: "none" },
    });
    fake.deliver("INBOX", makeRaw({ subject: "first", messageId: "one@mail.example.test" }));
    fake.deliver("INBOX", makeRaw({ subject: "second", messageId: "two@mail.example.test" }));

    const adapter = createImapSmtpAdapter({
      account,
      credentials: { getSecrets: async () => ({ MAIL_PASSWORD: FAKE_PASSWORD }) },
      timeouts: { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 8000 },
    });
    await adapter.connect();
    try {
      const first = await syncAccount({ db, adapter }, account.id);
      assert.equal(first.folders, 2);
      assert.equal(first.added, 2);

      const inbox = (await listFolders(db, account.id)).find((folder) => folder.path === "INBOX");
      const synced = await getFolder(db, inbox.id);
      assert.equal(synced.highestUid, 2);
      assert.equal(synced.uidValidity, 1);
      assert.deepEqual(await storedUids(db, inbox.id), [1, 2]);

      assert.equal(fake.setFlags("INBOX", 2, ["\\Seen"]), true);
      const second = await syncAccount({ db, adapter }, account.id);
      assert.equal(second.added, 0);
      assert.equal(second.folders, 2);

      const rows = await messageRows(db, inbox.id);
      assert.deepEqual(rows.map((row) => row.isRead), [false, true]);
      assert.equal(rows[0].subject, "first");
      assert.equal(rows[1].subject, "second");
    } finally {
      await adapter.close();
    }
  } finally {
    await fake.close();
  }
});