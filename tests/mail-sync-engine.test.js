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
import { createAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
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
    if (path === "Sent") throw new MailError("NETWORK", "ECONNRESET");
    return realList(path, options);
  };

  const result = await syncAccount(ctxFor(db, adapter), accountId);

  assert.equal(result.folders, 3);
  assert.equal(result.added, 2);
  const inbox = (await listFolders(db, accountId)).find((folder) => folder.path === "INBOX");
  assert.deepEqual(await storedUids(db, inbox.id), [1]);
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

test("RF8: the loop yields to the event loop between the messages of one batch", async () => {
  const { db, accountId, adapter } = await setup();
  for (let i = 1; i <= 25; i += 1) deliver(adapter, "INBOX", { subject: `yield ${i}` });
  const folder = await prepareFolder(db, adapter, accountId, "INBOX");

  // A probe scheduled while the batch is being downloaded, read again at every row the engine writes:
  // a loop that never yielded would never let the probe run, so every read would still be false.
  let probeRan = false;
  const realGet = adapter.get;
  adapter.get = async (path, uids) => {
    const messages = await realGet(path, uids);
    setImmediate(() => { probeRan = true; });
    return messages;
  };
  const probeAtStore = [];
  const watchedDb = {
    execute: (statement) => db.execute(statement),
    batch: (statements) => db.batch(statements),
    executeMultiple: (sql) => db.executeMultiple(sql),
    runTransaction: (work) => db.runTransaction((run) => work((statement) => {
      if (/INSERT INTO mail_messages/.test(statement.sql)) probeAtStore.push(probeRan);
      return run(statement);
    })),
  };

  const result = await syncFolder({ db: watchedDb, adapter, now: () => T0 }, accountId, folder);

  assert.equal(result.added, 25);
  assert.equal(probeAtStore.length, 25);
  assert.ok(probeAtStore.every(Boolean), "every message was stored after a yield");
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

/* -------------------------------------------------------------------- logs */

test("logs carry only codes, counts and folder ids", async () => {
  const logs = [];
  const { db, accountId, adapter } = await setup();
  deliver(adapter, "INBOX", { subject: "Salary review", body: `Ask ${ALEX} about the numbers.` });
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    if (path === "Sent") throw new MailError("NETWORK", "ECONNRESET");
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
  assert.ok(logs.some((entry) => entry.event === "folder_failed" && entry.code === "NETWORK"));
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