// Crow Mail's on-demand reads (Task 15 of plan 1): `fetchOlder` pages a folder's history backwards
// from its floor, and `searchRemote` stores a server-side search's hits. Both run against a scratch DB
// built from MAIL_DDL and the in-memory fake adapter, with a first `syncFolder` setting up the window.
//
// The rules under test are the ones a date-based pager gets wrong: INTERNALDATE has one-second
// resolution, so paging is by UID and a run of messages sharing one date is walked exactly once; a
// page that stops — an omitted UID after its one retry, or a message that cannot be written — leaves
// the floor exactly where it was, because batches store ascending and stop at the hole, so the UIDs
// above it were never stored and a higher floor would claim them; only three consecutive stuck passes
// on one UID (the liveness escape) let a page finish and move the floor. A hit a search stored far
// below the window does not make the range between contiguous; and neither read moves `highest_uid`,
// `uid_validity` or anything already stored.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import { createAccount } from "../servers/gateway/mail/store/accounts.js";
import {
  getFolder,
  listFolders,
  setFolderSyncState,
  storedUids,
  upsertFolders,
} from "../servers/gateway/mail/store/messages.js";
import {
  SEARCH_BATCH_MAX,
  fetchOlder,
  resetSyncLivenessForTests,
  searchRemote,
  syncFolder,
} from "../servers/gateway/mail/sync/engine.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import { createFakeMailAdapter } from "./fixtures/fake-mail-adapter.mjs";
import { makeRaw } from "./fixtures/fake-mail-server.mjs";

const ALEX = "alex@example.com";
const MAIL_HOST = "mail.example.test";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
/** Older than the account's 90-day window, so only a backfill or a search can reach it. */
const OLD = T0 - 200 * DAY;

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-older-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  return db;
}

/** A scratch DB with one account and one fake adapter whose clock is the test's. */
async function setup() {
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
  const adapter = createFakeMailAdapter({ now: () => T0 });
  return { db, accountId: account.id, adapter };
}

const ctxFor = (db, adapter, extra = {}) => ({ db, adapter, now: () => T0, ...extra });

const getCalls = (adapter) => adapter.calls.filter((call) => call.method === "get");
const listCalls = (adapter) => adapter.calls.filter((call) => call.method === "list");

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** Deliver `count` messages into one mailbox, all under one internal date and one Date header. */
function seed(adapter, mailbox, count, { internalDate = OLD, subject = "archive" } = {}) {
  const uids = [];
  for (let i = 1; i <= count; i += 1) {
    const raw = makeRaw({ subject: `${subject} ${i}`, date: new Date(internalDate) });
    uids.push(adapter.deliver(mailbox, raw, { internalDate }));
  }
  return uids;
}

/** The stored folder row for one path, created by a folder listing the way syncAccount does it. */
async function prepareFolder(db, adapter, accountId, path) {
  await upsertFolders(db, accountId, await adapter.listFolders());
  const folder = (await listFolders(db, accountId)).find((candidate) => candidate.path === path);
  assert.ok(folder, `folder ${path} was stored`);
  return folder;
}

/** One folder's regular sync, answered as the folder row the store holds afterwards. */
async function firstSync(db, adapter, accountId, path = "INBOX") {
  const folder = await prepareFolder(db, adapter, accountId, path);
  await syncFolder(ctxFor(db, adapter), accountId, folder);
  return getFolder(db, folder.id);
}

/**
 * The invariant a backfill must never break: every UID between the folder's floor and the lowest UID
 * the regular sync put in its window is on disk, or was given up on by the liveness escape.
 */
async function assertNoHole(db, folderId, windowLowUid, given = []) {
  const folder = await getFolder(db, folderId);
  const stored = new Set(await storedUids(db, folderId));
  for (let uid = folder.floorUid; uid <= windowLowUid; uid += 1) {
    assert.ok(
      stored.has(uid) || given.includes(uid),
      `uid ${uid} sits between the floor ${folder.floorUid} and the window ${windowLowUid}`,
    );
  }
}

/* ------------------------------------------------------- going further back */

test("fetchOlder stores the 50 UIDs below the floor and reports the start at the last page", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 100, { internalDate: OLD });
  seed(adapter, "INBOX", 50, { internalDate: T0 }); // uids 101..150: the window
  const folder = await firstSync(db, adapter, accountId);
  assert.equal(folder.floorUid, 101);
  assert.deepEqual(await storedUids(db, folder.id), range(101, 150));

  const first = await fetchOlder(ctxFor(db, adapter), accountId, folder.id);
  assert.equal(first.added, 50);
  assert.equal(first.reachedStart, false);
  assert.equal((await getFolder(db, folder.id)).floorUid, 51);
  assert.deepEqual(listCalls(adapter).at(-1).args[1].beforeUid, 101);

  const second = await fetchOlder(ctxFor(db, adapter), accountId, folder.id);
  assert.equal(second.added, 50);
  assert.equal(second.reachedStart, true, "the new floor is the first message");

  const after = await getFolder(db, folder.id);
  assert.equal(after.floorUid, 1);
  assert.equal(after.highestUid, 150, "a backfill never moves the watermark");
  assert.equal(after.uidValidity, folder.uidValidity);
  assert.deepEqual(await storedUids(db, after.id), range(1, 150));
});

test("fetchOlder on a folder whose window is the whole mailbox adds nothing and stops at once", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 30, { internalDate: T0 });
  const folder = await firstSync(db, adapter, accountId);
  assert.equal(folder.floorUid, 1);

  const getsBefore = getCalls(adapter).length;
  const result = await fetchOlder(ctxFor(db, adapter), accountId, folder.id);

  assert.deepEqual(result, { added: 0, reachedStart: true });
  assert.equal(getCalls(adapter).length, getsBefore, "no body was asked for");
  const after = await getFolder(db, folder.id);
  assert.equal(after.floorUid, 1);
  assert.equal(after.highestUid, 30);
});

test("fetchOlder never duplicates a row it stored on an earlier call", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 20, { internalDate: OLD });
  seed(adapter, "INBOX", 10, { internalDate: T0 });
  const folder = await firstSync(db, adapter, accountId);

  const first = await fetchOlder(ctxFor(db, adapter), accountId, folder.id, { limit: 20 });
  assert.equal(first.added, 20, "the whole page below the window");
  assert.equal((await getFolder(db, folder.id)).floorUid, 1);

  // The same page again, the way a run interrupted before its floor write would ask for it.
  await setFolderSyncState(db, folder.id, { floorUid: 11 });
  const again = await fetchOlder(ctxFor(db, adapter), accountId, folder.id, { limit: 20 });
  assert.equal(again.added, 0, "every row was already there");

  const uids = await storedUids(db, folder.id);
  assert.deepEqual(uids, range(1, 30));
  assert.equal(new Set(uids).size, uids.length, "no duplicate row");
});

test("fetchOlder pages by UID, so 30 messages sharing one date are walked without a skip", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 30, { internalDate: OLD });
  seed(adapter, "INBOX", 1, { internalDate: T0 }); // uid 31 anchors the window
  const folder = await firstSync(db, adapter, accountId);
  assert.deepEqual(await storedUids(db, folder.id), [31]);
  assert.equal(folder.floorUid, 31);

  const added = [];
  const reached = [];
  for (let call = 0; call < 3; call += 1) {
    const result = await fetchOlder(ctxFor(db, adapter), accountId, folder.id, { limit: 10 });
    added.push(result.added);
    reached.push(result.reachedStart);
  }

  assert.deepEqual(added, [10, 10, 10]);
  assert.deepEqual(reached, [false, false, true]);
  assert.deepEqual(await storedUids(db, folder.id), range(1, 31));
  const { rows } = await db.execute({
    sql: "SELECT COUNT(DISTINCT date) AS dates FROM mail_messages WHERE folder_id = ? AND uid < 31",
    args: [folder.id],
  });
  assert.equal(Number(rows[0].dates), 1, "the thirty share one stored date");
});

test("fetchOlder on a folder with no local range returns at once and calls no adapter", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 5, { internalDate: OLD });
  const folder = await prepareFolder(db, adapter, accountId, "INBOX");
  assert.equal(folder.floorUid, null);

  const callsBefore = adapter.calls.length;
  const result = await fetchOlder(ctxFor(db, adapter), accountId, folder.id);

  assert.deepEqual(result, { added: 0, reachedStart: true });
  assert.equal(adapter.calls.length, callsBefore, "not even a listing");
  assert.deepEqual(await storedUids(db, folder.id), []);
});

test("a stopped page leaves the floor exactly where it was, and the next call re-reads it whole", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 100, { internalDate: OLD });
  seed(adapter, "INBOX", 50, { internalDate: T0 }); // uids 101..150: the window
  const folder = await firstSync(db, adapter, accountId);
  assert.equal(folder.floorUid, 101);

  const realGet = adapter.get;
  const omit = 95;
  const asked = [];
  const omitting = new Set([omit]);
  adapter.get = async (path, uids) => {
    asked.push([...uids]);
    const messages = await realGet(path, uids);
    return messages.filter((message) => !omitting.has(message.uid));
  };

  // The page is 51..100, batched [51..75] and [76..100]. The second batch stores ascending and stops
  // at 95, so 96..100 are NOT stored — a floor of 96 would claim four rows nothing ever wrote.
  const stopped = await fetchOlder(ctxFor(db, adapter), accountId, folder.id);
  assert.equal(stopped.added, 44, "uids 51..94: the page stops at the hole");
  assert.equal(stopped.reachedStart, false, "a stopped pass is never the start of the folder");
  assert.deepEqual(asked.at(-1), [omit], "the hole was retried once on its own, never in a loop");

  let after = await getFolder(db, folder.id);
  assert.equal(after.floorUid, 101, "the floor does not move over a page that stopped");
  assert.equal(after.highestUid, 150);
  assert.deepEqual(await storedUids(db, folder.id), [...range(51, 94), ...range(101, 150)]);
  await assertNoHole(db, folder.id, 101);

  // The hole closes: the next call re-reads the same page below the untouched floor, stores it whole,
  // and only then lowers the floor to its lowest UID.
  omitting.clear();
  const next = await fetchOlder(ctxFor(db, adapter), accountId, folder.id);
  assert.equal(next.added, 6, "only 95..100 were new; the rows below the hole were already stored");
  assert.equal(next.reachedStart, false);
  assert.equal(listCalls(adapter).at(-1).args[1].beforeUid, 101, "the page still starts under the floor");

  after = await getFolder(db, folder.id);
  assert.equal(after.floorUid, 51, "the whole page is stored now, so the floor follows it");
  assert.equal(after.highestUid, 150, "a backfill never moves the watermark");
  assert.deepEqual(await storedUids(db, folder.id), range(51, 150));
  await assertNoHole(db, folder.id, 101);
});

test("three stuck passes on one UID skip it, and only then does the floor move below it", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 100, { internalDate: OLD });
  seed(adapter, "INBOX", 50, { internalDate: T0 });
  const folder = await firstSync(db, adapter, accountId);

  const realGet = adapter.get;
  const omit = 95;
  adapter.get = async (path, uids) => (await realGet(path, uids))
    .filter((message) => message.uid !== omit);

  const logs = [];
  const log = (entry) => logs.push(entry);

  const first = await fetchOlder(ctxFor(db, adapter, { log }), accountId, folder.id);
  assert.equal(first.added, 44);
  assert.equal(first.reachedStart, false);
  assert.equal((await getFolder(db, folder.id)).floorUid, 101, "pass 1 stops below the hole");

  const second = await fetchOlder(ctxFor(db, adapter, { log }), accountId, folder.id);
  assert.equal(second.added, 0, "nothing below the hole was new");
  assert.equal(second.reachedStart, false);
  assert.equal((await getFolder(db, folder.id)).floorUid, 101, "pass 2 is stuck at the same UID");
  assert.equal(logs.filter((entry) => entry.event === "uid_skipped").length, 0);

  const third = await fetchOlder(ctxFor(db, adapter, { log }), accountId, folder.id);
  assert.equal(third.added, 5, "96..100: the page finishes past the UID nobody ever delivers");
  assert.equal(third.reachedStart, false);

  const after = await getFolder(db, folder.id);
  assert.equal(after.floorUid, 51, "the skipped page is the one the floor follows");
  assert.equal(after.highestUid, 150);
  assert.deepEqual(await storedUids(db, folder.id),
    [...range(51, 94), ...range(96, 150)], "nothing is stored for the skipped UID");
  await assertNoHole(db, folder.id, 101, [omit]);

  const skipped = logs.filter((entry) => entry.event === "uid_skipped");
  assert.deepEqual(skipped, [{ event: "uid_skipped", folderId: folder.id, uid: omit, code: "omitted" }]);
});

test("a folder path with spaces and unicode reaches the adapter byte for byte", async () => {
  const { db, accountId, adapter } = await setup();
  const oddPath = "Projekte/Ünïcode & Sonder zeichen/Ärger 2026";
  const raws = [
    makeRaw({ subject: "old one", date: new Date(OLD) }),
    makeRaw({ subject: "old two", date: new Date(OLD) }),
    makeRaw({ subject: "in the window", date: new Date(T0) }),
  ];
  const items = raws.map((raw, index) => ({
    uid: index + 1,
    flags: [],
    internalDate: index === 2 ? T0 : OLD,
    size: raw.length,
  }));

  const realListFolders = adapter.listFolders;
  adapter.listFolders = async () => [
    ...(await realListFolders()),
    { path: oddPath, name: "Ärger 2026", specialUse: null, delimiter: "/", selectable: true },
  ];

  const listed = [];
  const realList = adapter.list;
  adapter.list = async (path, options) => {
    if (path !== oddPath) return realList(path, options);
    listed.push({ path, options });
    const filtered = items
      .filter((item) => (options.afterUid == null || item.uid > options.afterUid)
        && (options.beforeUid == null || item.uid < options.beforeUid)
        && (options.sinceDate == null || item.internalDate >= options.sinceDate))
      .sort((left, right) => (options.newestFirst ? right.uid - left.uid : left.uid - right.uid));
    const page = options.limit == null ? filtered : filtered.slice(0, options.limit);
    return { uidValidity: 42, uidNext: 4, items: page };
  };

  const fetchedFrom = [];
  const realGet = adapter.get;
  adapter.get = async (path, uids) => {
    if (path !== oddPath) return realGet(path, uids);
    fetchedFrom.push(path);
    return items
      .filter((item) => uids.includes(item.uid))
      .map((item) => ({ uid: item.uid, flags: [], internalDate: item.internalDate, raw: Buffer.from(raws[item.uid - 1]) }));
  };

  const folder = await prepareFolder(db, adapter, accountId, oddPath);
  await syncFolder(ctxFor(db, adapter), accountId, folder);
  const synced = await getFolder(db, folder.id);

  assert.equal(synced.path, oddPath);
  assert.deepEqual(await storedUids(db, folder.id), [3]);
  assert.equal(synced.floorUid, 3);

  const result = await fetchOlder(ctxFor(db, adapter), accountId, folder.id);

  assert.equal(result.added, 2);
  assert.equal(result.reachedStart, true);
  assert.deepEqual(await storedUids(db, folder.id), [1, 2, 3]);
  assert.equal((await getFolder(db, folder.id)).floorUid, 1);
  assert.ok(listed.every((call) => call.path === oddPath), "every listing kept the path exactly");
  assert.ok(listed.some((call) => call.options.beforeUid === 3 && call.options.newestFirst === true));
  assert.ok(fetchedFrom.length > 0);
  assert.ok(fetchedFrom.every((path) => path === oddPath), "every fetch kept the path exactly");
});

test("a UIDVALIDITY change makes fetchOlder throw before a single body is stored", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 30, { internalDate: OLD });
  seed(adapter, "INBOX", 10, { internalDate: T0 });
  const folder = await firstSync(db, adapter, accountId);
  const before = await getFolder(db, folder.id);
  const uidsBefore = await storedUids(db, folder.id);

  adapter.bumpUidValidity("INBOX");
  const getsBefore = getCalls(adapter).length;
  await assert.rejects(
    fetchOlder(ctxFor(db, adapter), accountId, folder.id),
    (err) => err instanceof MailError && err.code === "PROTOCOL" && err.detail === "uidvalidity_changed",
  );

  assert.deepEqual(await storedUids(db, folder.id), uidsBefore, "nothing was stored");
  assert.equal(getCalls(adapter).length, getsBefore, "no body was fetched");
  assert.deepEqual(await getFolder(db, folder.id), before);
});

/* ------------------------------------------------------------- remote search */

test("searchRemote stores only the hits the store does not hold yet", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 100, { internalDate: OLD, subject: "sparrow log" });
  seed(adapter, "INBOX", 50, { internalDate: T0, subject: "sparrow log" });
  const folder = await firstSync(db, adapter, accountId);

  const getsBefore = getCalls(adapter).length;
  const result = await searchRemote(ctxFor(db, adapter), accountId, "sparrow");

  assert.equal(result.added, 100, "the fifty local hits were not created again");
  assert.deepEqual(await storedUids(db, folder.id), range(1, 150));
  const batches = getCalls(adapter).slice(getsBefore).map((call) => call.args[1]);
  const asked = batches.flat();
  assert.equal(asked.length, 100);
  assert.ok(batches.every((uids) => uids.length <= SEARCH_BATCH_MAX),
    `a sizeless hit set is batched by SEARCH_BATCH_MAX (${SEARCH_BATCH_MAX}) UIDs, never 25`);
  for (const uid of asked) assert.ok(uid < 101, `uid ${uid} was already local and must not be fetched`);

  const after = await getFolder(db, folder.id);
  assert.equal(after.floorUid, 101, "a search never moves the floor");
  assert.equal(after.highestUid, 150, "a search never moves the watermark");
});

test("a search hit the adapter never delivers is skipped, and the other hits are still stored", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 10, { internalDate: OLD, subject: "heron log" });
  seed(adapter, "INBOX", 1, { internalDate: T0, subject: "in the window" }); // uid 11
  const folder = await firstSync(db, adapter, accountId);
  assert.equal(folder.floorUid, 11);
  assert.deepEqual(await storedUids(db, folder.id), [11]);

  const realGet = adapter.get;
  const omit = 5;
  adapter.get = async (path, uids) => (await realGet(path, uids))
    .filter((message) => message.uid !== omit);

  const logs = [];
  const result = await searchRemote(
    ctxFor(db, adapter, { log: (entry) => logs.push(entry) }),
    accountId,
    "heron",
  );

  // A hit is not a watermark: one the adapter never delivers costs one row, not the other nine.
  assert.equal(result.added, 9);
  assert.deepEqual(await storedUids(db, folder.id), [1, 2, 3, 4, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(logs.filter((entry) => entry.event === "search_hit_omitted"),
    [{ event: "search_hit_omitted", folderId: folder.id, count: 1 }],
    "the give-up is a count and an id, nothing a message or a path could ride on");

  const after = await getFolder(db, folder.id);
  assert.equal(after.floorUid, 11, "a skipped hit moves neither watermark");
  assert.equal(after.highestUid, 11);
});

test("a search hit far below the window does not move the floor, and fetchOlder pages from it", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 99, { internalDate: OLD, subject: "archive" });
  // uid 100, far below the window, findable by one word nothing else carries.
  adapter.deliver("INBOX", makeRaw({ subject: "phoenix memo", date: new Date(OLD) }), { internalDate: OLD });
  seed(adapter, "INBOX", 50, { internalDate: T0, subject: "recent" }); // uids 101..150
  const folder = await firstSync(db, adapter, accountId);
  assert.equal(folder.floorUid, 101);

  const found = await searchRemote(ctxFor(db, adapter), accountId, "phoenix");
  assert.equal(found.added, 1);
  assert.deepEqual(await storedUids(db, folder.id), [100, ...range(101, 150)]);
  const searched = await getFolder(db, folder.id);
  assert.equal(searched.floorUid, 101, "one far row is not a contiguous range");
  assert.equal(searched.highestUid, 150);

  const older = await fetchOlder(ctxFor(db, adapter), accountId, folder.id);
  assert.equal(older.added, 49, "uid 100 was already stored by the search");
  assert.equal(older.reachedStart, false);
  assert.equal(listCalls(adapter).at(-1).args[1].beforeUid, 101, "paging starts under the window");

  const after = await getFolder(db, folder.id);
  assert.equal(after.floorUid, 51, "the floor follows the page, not the search hit");
  assert.deepEqual(await storedUids(db, after.id), range(51, 150));
});

test("a search error leaves the local store exactly as it was", async () => {
  const { db, accountId, adapter } = await setup();
  seed(adapter, "INBOX", 30, { internalDate: OLD });
  seed(adapter, "INBOX", 10, { internalDate: T0 });
  const folder = await firstSync(db, adapter, accountId);
  const before = await getFolder(db, folder.id);
  const uidsBefore = await storedUids(db, folder.id);

  adapter.failNext("search", new MailError("NETWORK", "ECONNRESET"));
  const getsBefore = getCalls(adapter).length;
  await assert.rejects(
    searchRemote(ctxFor(db, adapter), accountId, "archive"),
    (err) => err instanceof MailError && err.code === "NETWORK",
  );

  assert.deepEqual(await storedUids(db, folder.id), uidsBefore);
  assert.equal(getCalls(adapter).length, getsBefore, "no body was asked for");
  assert.deepEqual(await getFolder(db, folder.id), before);
});