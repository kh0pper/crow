// Crow Mail's message store (servers/gateway/mail/store/messages.js) against a scratch DB built from
// MAIL_DDL: folders and their role, the upsert that must never REPLACE a row (that would corrupt the
// FTS index), the Gmail-label duplicate rule, FTS search, keyset paging, expunge reconciliation and
// the resetFolder path a UIDVALIDITY change takes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import {
  applyFlags,
  copyRows,
  deleteMessageRow,
  deleteMissing,
  folderRole,
  getFolder,
  getMessage,
  listFolders,
  listMessages,
  minUid,
  resetFolder,
  searchLocal,
  setFolderSyncState,
  setReadForCopies,
  storedDate,
  storedUids,
  toFtsQuery,
  upsertFolders,
  upsertMessage,
} from "../servers/gateway/mail/store/messages.js";

const ACCOUNT = "ma-0123456789abcdef";
const OTHER = "ma-fedcba9876543210";
const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const KIM = "kim@example.com";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-store-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  return db;
}

/** Add folders for an account and return the stored rows (in path order). */
async function addFolders(db, accountId, list) {
  const result = await upsertFolders(db, accountId, list.map((f) => ({ delimiter: "/", ...f })));
  return result.folders;
}

async function folderIdOf(db, accountId, path) {
  const folder = (await listFolders(db, accountId)).find((f) => f.path === path);
  assert.ok(folder, `folder ${path} exists`);
  return folder.id;
}

let nextUid = 1;

/** A StoredMessage: a ParsedMessage plus where it came from. */
function msg(overrides = {}) {
  return {
    accountId: ACCOUNT,
    folderId: 1,
    uid: nextUid++,
    flags: [],
    internalDate: T0,
    messageId: null,
    inReplyTo: null,
    references: [],
    subject: "",
    from: { name: "", address: ALEX },
    to: [{ name: "", address: SAM }],
    cc: [],
    replyTo: [],
    date: T0,
    text: "",
    html: null,
    snippet: "",
    attachments: [],
    truncated: false,
    parseError: null,
    ...overrides,
  };
}

async function row(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM mail_messages WHERE id = ?", args: [id] });
  return rows[0] ?? null;
}

async function count(db, where = "", args = []) {
  const { rows } = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM mail_messages ${where}`,
    args,
  });
  return Number(rows[0].n);
}

/** fts5's own full check for an external-content index: it re-reads mail_messages and throws when
 *  the index disagrees with it. */
async function assertFtsIntegrity(db) {
  await db.execute({ sql: "INSERT INTO mail_messages_fts(mail_messages_fts) VALUES('integrity-check')", args: [] });
}

/* ------------------------------------------------------------------ folders */

test("folderRole names the well-known folders and calls everything else other", () => {
  assert.equal(folderRole({ path: "INBOX" }), "inbox");
  assert.equal(folderRole({ path: "inbox" }), "inbox");
  assert.equal(folderRole({ path: "INBOX/Sub" }), "other");
  assert.equal(folderRole({ path: "Gesendet", specialUse: "\\Sent" }), "sent");
  assert.equal(folderRole({ path: "Sent Items" }), "sent");
  assert.equal(folderRole({ path: "INBOX.Sent", name: "Sent", delimiter: "." }), "sent");
  assert.equal(folderRole({ path: "INBOX.Trash", delimiter: "." }), "trash");
  assert.equal(folderRole({ path: "Drafts" }), "drafts");
  assert.equal(folderRole({ path: "Wastebasket", specialUse: "\\Trash" }), "trash");
  assert.equal(folderRole({ path: "Junk Email" }), "spam");
  assert.equal(folderRole({ path: "Bulk", specialUse: "\\Junk" }), "spam");
  assert.equal(folderRole({ path: "Archives", specialUse: "\\Archive" }), "archive");
  assert.equal(folderRole({ path: "[Gmail]/All Mail", specialUse: "\\All" }), "other");
  assert.equal(folderRole({ path: "Projects" }), "other");
  assert.equal(folderRole(null), "other");
});

test("upsertFolders adds folders, keeps their sync state, and lists counts", async () => {
  const db = await freshDb();
  const first = await addFolders(db, ACCOUNT, [
    { path: "INBOX", name: "Inbox" },
    { path: "Archive", name: "Archive" },
  ]);
  assert.deepEqual(first.map((f) => f.path), ["Archive", "INBOX"]);
  assert.equal(first.find((f) => f.path === "INBOX").role, "inbox");

  const inboxId = await folderIdOf(db, ACCOUNT, "INBOX");
  await setFolderSyncState(db, inboxId, { uidValidity: 77, highestUid: 120, floorUid: 4, lastSyncedAt: T0 });
  await upsertMessage(db, msg({ folderId: inboxId, uid: 5, subject: "kept" }));

  // A second listing refreshes names but must not touch uid_validity / highest_uid / floor_uid.
  const again = await addFolders(db, ACCOUNT, [
    { path: "INBOX", name: "Inbox", specialUse: "\\Inbox" },
    { path: "Archive", name: "Old mail" },
  ]);
  const inbox = again.find((f) => f.path === "INBOX");
  assert.equal(inbox.uidValidity, 77);
  assert.equal(inbox.highestUid, 120);
  assert.equal(inbox.floorUid, 4);
  assert.equal(inbox.lastSyncedAt, T0);
  assert.equal(again.find((f) => f.path === "Archive").name, "Old mail");

  const listed = await listFolders(db, ACCOUNT);
  assert.equal(listed.find((f) => f.path === "INBOX").totalCount, 1);
  assert.equal(listed.find((f) => f.path === "Archive").totalCount, 0);

  const folder = await getFolder(db, inboxId);
  assert.equal(folder.path, "INBOX");
  assert.equal(folder.role, "inbox");
  assert.equal(await getFolder(db, 9999), null);
});

test("an unlisted folder and its messages and FTS entries go when the listing allows it", async () => {
  const db = await freshDb();
  await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }, { path: "Archive", name: "Archive" }]);
  const archiveId = await folderIdOf(db, ACCOUNT, "Archive");
  await upsertMessage(db, msg({ folderId: archiveId, uid: 5, subject: "archivedsubject", text: "archivedbody" }));
  assert.equal((await searchLocal(db, { q: "archivedbody" })).length, 1);

  const result = await upsertFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  assert.equal(result.deleted, 1);
  assert.equal(result.deletesRefused, false);
  assert.deepEqual(result.folders.map((f) => f.path), ["INBOX"]);
  assert.equal(await count(db, "WHERE folder_id = ?", [archiveId]), 0);
  assert.deepEqual(await searchLocal(db, { q: "archivedbody" }), []);
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM mail_threads", args: [] });
  assert.equal(Number(rows[0].n), 0, "the emptied thread went with the folder");
  await assertFtsIntegrity(db);
});

test("a listing with no INBOX-role folder refuses deletions but still adds folders", async () => {
  const db = await freshDb();
  await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }, { path: "Archive", name: "Archive" }]);
  const result = await upsertFolders(db, ACCOUNT, [{ path: "Sent", name: "Sent" }]);
  assert.equal(result.deleted, 0);
  assert.equal(result.deletesRefused, true);
  assert.deepEqual(result.folders.map((f) => f.path), ["Archive", "INBOX", "Sent"]);
});

test("a listing that covers less than half the local folders refuses deletions", async () => {
  const db = await freshDb();
  const many = [{ path: "INBOX", name: "Inbox" }];
  for (let i = 1; i <= 9; i += 1) many.push({ path: `Folder ${i}`, name: `Folder ${i}` });
  await addFolders(db, ACCOUNT, many);

  const refused = await upsertFolders(db, ACCOUNT, [
    { path: "INBOX", name: "Inbox" },
    { path: "Folder 1", name: "Folder 1" },
    { path: "Folder 2", name: "Folder 2" },
  ]);
  assert.equal(refused.deletesRefused, true);
  assert.equal(refused.deleted, 0);
  assert.equal(refused.folders.length, 10, "nothing was removed");

  // A new folder still arrives even when deletions are refused.
  const grown = await upsertFolders(db, ACCOUNT, [{ path: "Extra", name: "Extra" }]);
  assert.equal(grown.folders.length, 11);
  assert.ok(grown.folders.some((f) => f.path === "Extra"));

  // 6 of 11 listed is over half, and the listing carries INBOX: the 5 unlisted go.
  const listed = [{ path: "INBOX", name: "Inbox" }];
  for (let i = 1; i <= 5; i += 1) listed.push({ path: `Folder ${i}`, name: `Folder ${i}` });
  const allowed = await upsertFolders(db, ACCOUNT, listed);
  assert.equal(allowed.deletesRefused, false);
  assert.equal(allowed.deleted, 5);
  assert.equal(allowed.folders.length, 6);
});

/* ---------------------------------------------------------------- messages */

test("upsertMessage writes one row per (folder, uid) and reports created only once", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);

  const first = await upsertMessage(db, msg({
    folderId: inbox.id, uid: 10, messageId: "<m1@mail.example.test>", subject: "Hello", text: "first body",
  }));
  assert.equal(first.created, true);
  assert.ok(Number.isInteger(first.threadId) && first.threadId > 0);

  const second = await upsertMessage(db, msg({
    folderId: inbox.id, uid: 10, messageId: "<m1@mail.example.test>", subject: "Hello again", text: "second body",
  }));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(second.threadId, first.threadId);
  assert.equal(await count(db), 1);

  const stored = await row(db, first.id);
  assert.equal(stored.subject, "Hello again");
  assert.equal(stored.body_text, "second body");
  assert.equal(await getMessage(db, first.id).then((m) => m.subject), "Hello again");
  assert.equal(await getMessage(db, 123456), null);
});

test("re-upserting a row keeps the FTS index consistent and re-indexes the changed columns", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  const at = { folderId: inbox.id, uid: 21, messageId: "<m21@mail.example.test>" };

  const written = await upsertMessage(db, msg({
    ...at, subject: "firstsubject", text: "firstbodytoken", from: { name: "Alex", address: ALEX },
  }));
  await upsertMessage(db, msg({
    ...at, subject: "secondsubject", text: "secondbodytoken", from: { name: "Alex", address: ALEX },
  }));
  const last = await upsertMessage(db, msg({
    ...at, subject: "thirdsubject", text: "thirdbodytoken", from: { name: "Alex", address: ALEX },
  }));
  assert.equal(await count(db), 1);
  await assertFtsIntegrity(db);

  assert.deepEqual(await searchLocal(db, { q: "firstsubject" }), []);
  assert.deepEqual(await searchLocal(db, { q: "firstbodytoken" }), []);
  const hits = await searchLocal(db, { q: "thirdbodytoken" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, written.id);
  assert.equal(hits[0].id, last.id);

  await deleteMessageRow(db, written.id);
  await assertFtsIntegrity(db);
  assert.deepEqual(await searchLocal(db, { q: "thirdbodytoken" }), []);
  assert.deepEqual(await searchLocal(db, { q: "thirdsubject" }), []);
  assert.equal(await count(db), 0);
});

test("storedDate keeps a parsed date within two days and falls back to internalDate outside", async () => {
  assert.equal(storedDate(T0 - DAY, T0), T0 - DAY, "inside the window the parsed date wins");
  assert.equal(storedDate(T0 + 2 * DAY, T0), T0 + 2 * DAY, "the window is inclusive");
  assert.equal(storedDate(T0 - 3 * DAY, T0), T0, "too far in the past falls back");
  assert.equal(storedDate(T0 + 3 * DAY, T0), T0, "too far in the future falls back");
  assert.equal(storedDate(null, T0), T0, "no parsed date at all");

  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  const inside = await upsertMessage(db, msg({ folderId: inbox.id, uid: 1, date: T0 - DAY, internalDate: T0 }));
  const outside = await upsertMessage(db, msg({ folderId: inbox.id, uid: 2, date: T0 - 3 * DAY, internalDate: T0 }));
  assert.equal((await row(db, inside.id)).date, storedDate(T0 - DAY, T0));
  assert.equal((await row(db, outside.id)).date, storedDate(T0 - 3 * DAY, T0));
});

test("a hostile message (no Message-ID, Date, From or Subject) stores placeholders", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);

  const bare = await upsertMessage(db, msg({
    folderId: inbox.id, uid: 1, messageId: null, subject: "", from: null, to: [], cc: [], replyTo: [],
    date: null, internalDate: T0, text: "", snippet: "",
  }));
  let stored = await getMessage(db, bare.id);
  assert.equal(stored.subject, "");
  assert.equal(stored.fromAddr, null);
  assert.equal(stored.fromText, "");
  assert.equal(stored.toText, "");
  assert.equal(stored.messageId, null);
  assert.deepEqual(stored.to, []);
  assert.deepEqual(stored.cc, []);
  assert.equal(stored.bodyText, "");
  assert.equal(stored.bodyHtml, null);
  assert.equal(stored.date, T0, "the internal date is the fallback");
  assert.equal(stored.parseError, null);
  assert.equal(stored.hasAttachments, false);

  const refused = await upsertMessage(db, msg({
    folderId: inbox.id, uid: 2, subject: "", text: "", snippet: "", parseError: "too_large",
  }));
  stored = await getMessage(db, refused.id);
  assert.equal(stored.parseError, "too_large");
});

test("a message keeps its text forms, flags, read state and attachments", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  const written = await upsertMessage(db, msg({
    folderId: inbox.id,
    uid: 3,
    messageId: "<m3@mail.example.test>",
    inReplyTo: "<m2@mail.example.test>",
    references: ["<m1@mail.example.test>", "<m2@mail.example.test>"],
    subject: "Lunch",
    from: { name: "Alex Example", address: ALEX },
    to: [{ name: "Sam", address: SAM }],
    cc: [{ name: "", address: KIM }],
    replyTo: [{ name: "Alex", address: ALEX }],
    flags: ["\\Seen", "\\Answered"],
    text: "See you at noon.",
    html: "<p>See you at noon.</p>",
    snippet: "See you at noon.",
    attachments: [{ filename: "menu.pdf", contentType: "application/pdf", size: 42, contentId: null, disposition: "attachment" }],
    truncated: true,
  }));

  const stored = await getMessage(db, written.id);
  assert.equal(stored.fromName, "Alex Example");
  assert.equal(stored.fromAddr, ALEX);
  assert.equal(stored.fromText, `Alex Example ${ALEX}`);
  assert.equal(stored.toText, `Sam ${SAM} ${KIM}`);
  assert.deepEqual(stored.to, [{ name: "Sam", address: SAM }]);
  assert.deepEqual(stored.cc, [{ name: "", address: KIM }]);
  assert.deepEqual(stored.replyTo, [{ name: "Alex", address: ALEX }]);
  assert.deepEqual(stored.references, ["<m1@mail.example.test>", "<m2@mail.example.test>"]);
  assert.deepEqual(stored.flags, ["\\Seen", "\\Answered"]);
  assert.equal(stored.isRead, true);
  assert.equal(stored.truncated, true);
  assert.equal(stored.hasAttachments, true);
  assert.equal(stored.attachments[0].filename, "menu.pdf");
  assert.equal(stored.bodyText, "See you at noon.");
  assert.equal(stored.bodyHtml, "<p>See you at noon.</p>");
});

/* ------------------------------------------------------------ search & paging */

test("toFtsQuery quotes terms as prefixes and refuses nothing", () => {
  assert.equal(toFtsQuery(""), null);
  assert.equal(toFtsQuery("   "), null);
  assert.equal(toFtsQuery(null), null);
  assert.equal(toFtsQuery(42), null);
  assert.equal(toFtsQuery("Hello, world!"), '"Hello"* "world"*');
  assert.equal(toFtsQuery("Re: the [list] lunch").split(" ").length, 4);

  const capped = toFtsQuery(Array.from({ length: 20 }, (_, i) => `term${i}`).join(" "));
  assert.equal(capped.split(" ").length, 8, "at most eight tokens");
  const long = "a".repeat(10000);
  assert.ok(toFtsQuery(long).length <= 67, "a token is cut to 64 characters");
});

test("hostile search input never throws", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  await upsertMessage(db, msg({ folderId: inbox.id, uid: 1, subject: "Quarterly report", text: "the lighthouse keeper" }));

  const hostile = ['"', "NEAR(", "*", "AND", "", "   ", "a".repeat(10000), '"unclosed', "a AND b OR c",
    "NEAR(a b, 5)", "subject:foo", "^1", "()", "{subject}", "a*b", "-", "\u0000", "🙂"];
  for (const q of hostile) {
    const answer = await searchLocal(db, { q });
    assert.ok(Array.isArray(answer), `${JSON.stringify(q).slice(0, 20)} answers with an array`);
  }
  const stillWorks = await searchLocal(db, { q: "lighthouse" });
  assert.equal(stillWorks.length, 1);
});

test("searchLocal finds a message by subject, sender, recipient and body, per account", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  const [otherInbox] = await addFolders(db, OTHER, [{ path: "INBOX", name: "Inbox" }]);

  const mine = await upsertMessage(db, msg({
    folderId: inbox.id,
    uid: 1,
    subject: "Quarterly report",
    from: { name: "Alex", address: ALEX },
    to: [{ name: "Sam", address: SAM }],
    text: "The lighthouse keeper replied.",
  }));
  await upsertMessage(db, msg({
    accountId: OTHER,
    folderId: otherInbox.id,
    uid: 1,
    subject: "Other mailbox",
    from: { name: "Kim", address: KIM },
    to: [{ name: "Lee", address: "lee@example.com" }],
    text: "Nothing to see.",
  }));

  for (const q of ["quarterly", "alex", "sam", "lighthouse"]) {
    const hits = await searchLocal(db, { q });
    assert.equal(hits.length, 1, `${q} finds exactly the one message`);
    assert.equal(hits[0].id, mine.id);
    assert.equal(hits[0].accountId, ACCOUNT);
    assert.equal(hits[0].subject, "Quarterly report");
    assert.equal(hits[0].fromAddr, ALEX);
    assert.equal(hits[0].isRead, false);
    assert.equal(hits[0].hasAttachments, false);
  }
  assert.deepEqual(await searchLocal(db, { q: "lighthouse", accountId: OTHER }), []);
  assert.equal((await searchLocal(db, { q: "lighthouse", accountId: ACCOUNT })).length, 1);
});

test("the same message in two folders counts once and searches once", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }, { path: "Label", name: "Label" }]);
  const labelId = await folderIdOf(db, ACCOUNT, "Label");
  const messageId = "<copy@mail.example.test>";

  // A re-delivered message in one folder: two uids, one logical message.
  await upsertMessage(db, msg({ folderId: inbox.id, uid: 1, messageId, date: T0, flags: ["\\Seen"], subject: "One copy", text: "duplicatedbody" }));
  await upsertMessage(db, msg({ folderId: inbox.id, uid: 2, messageId, date: T0 + 1000, subject: "One copy", text: "duplicatedbody" }));

  let folders = await listFolders(db, ACCOUNT);
  let listed = folders.find((f) => f.path === "INBOX");
  assert.equal(listed.totalCount, 1, "one logical message, not two rows");
  assert.equal(listed.unreadCount, 1, "the newest row decides unread");

  // Mark the newest copy read: still one message, now read.
  await upsertMessage(db, msg({ folderId: inbox.id, uid: 2, messageId, date: T0 + 2000, flags: ["\\Seen"], subject: "One copy", text: "duplicatedbody" }));
  folders = await listFolders(db, ACCOUNT);
  listed = folders.find((f) => f.path === "INBOX");
  assert.equal(listed.totalCount, 1);
  assert.equal(listed.unreadCount, 0);

  // The same message under a Gmail label is a second row but still one logical message.
  await upsertMessage(db, msg({ folderId: labelId, uid: 7, messageId, date: T0 + 2000, flags: ["\\Seen"], subject: "One copy", text: "duplicatedbody" }));
  const hits = await searchLocal(db, { q: "duplicatedbody" });
  assert.equal(hits.length, 1, "the label copy is the same message");
  assert.equal(hits[0].folderId, labelId, "the newest row stands for the group");

  // Counted once across the whole mailbox, in the folder holding the newest row.
  folders = await listFolders(db, ACCOUNT);
  assert.equal(folders.reduce((sum, f) => sum + f.totalCount, 0), 1);
  assert.equal(folders.reduce((sum, f) => sum + f.unreadCount, 0), 0);

  // A folder list still shows every row it holds; only the counts dedupe.
  const messageIds = (await listMessages(db, { folderId: inbox.id })).items.map((i) => i.id);
  assert.equal(messageIds.length, 2);
});

test("listMessages pages by date and id with no repeat and no gap", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  for (let i = 1; i <= 50; i += 1) {
    await upsertMessage(db, msg({ folderId: inbox.id, uid: i, date: T0, subject: `same day ${i}` }));
  }

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await listMessages(db, { folderId: inbox.id, limit: 20, cursor });
    assert.ok(page.items.length <= 20);
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    pages += 1;
    if (pages === 1) {
      // A message arriving between pages must not shift the older pages.
      await upsertMessage(db, msg({ folderId: inbox.id, uid: 901, date: T0 + 5000, subject: "arrived later" }));
    }
  } while (cursor && pages < 10);

  assert.equal(pages, 3, "50 messages at 20 per page");
  assert.equal(seen.length, 50);
  assert.equal(new Set(seen).size, 50, "no repeat and no gap");
});

test("listMessages clamps the limit and refuses a broken cursor", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  for (let i = 1; i <= 105; i += 1) {
    await upsertMessage(db, msg({ folderId: inbox.id, uid: i, date: T0 + i, subject: `message ${i}` }));
  }
  assert.equal((await listMessages(db, { folderId: inbox.id })).items.length, 30, "default 30");
  assert.equal((await listMessages(db, { folderId: inbox.id, limit: 0 })).items.length, 1, "minimum 1");
  assert.equal((await listMessages(db, { folderId: inbox.id, limit: 1000 })).items.length, 100, "maximum 100");
  assert.equal((await listMessages(db, { folderId: inbox.id, limit: 5 })).items.length, 5);

  await assert.rejects(() => listMessages(db, { folderId: inbox.id, cursor: "not-a-cursor" }), /not valid/);
  await assert.rejects(() => listMessages(db, { role: "nowhere" }), /not valid/);
});

test("a role view without an account is the unified view across accounts", async () => {
  const db = await freshDb();
  const accountFolders = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }, { path: "Sent", name: "Sent" }]);
  const otherFolders = await addFolders(db, OTHER, [{ path: "INBOX", name: "Inbox" }]);
  const inboxId = accountFolders.find((f) => f.path === "INBOX").id;
  const sentId = accountFolders.find((f) => f.path === "Sent").id;
  const otherInboxId = otherFolders[0].id;

  const older = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, date: T0, subject: "older inbox" }));
  const newer = await upsertMessage(db, msg({ accountId: OTHER, folderId: otherInboxId, uid: 1, date: T0 + 1000, subject: "newer inbox" }));
  await upsertMessage(db, msg({ folderId: sentId, uid: 2, date: T0 + 2000, subject: "sent mail" }));

  const unified = await listMessages(db, { role: "inbox" });
  assert.deepEqual(unified.items.map((i) => i.id), [newer.id, older.id]);
  assert.deepEqual(unified.items.map((i) => i.accountId), [OTHER, ACCOUNT]);
  assert.equal(unified.nextCursor, null);

  const mineOnly = await listMessages(db, { accountId: ACCOUNT, role: "inbox" });
  assert.deepEqual(mineOnly.items.map((i) => i.id), [older.id]);
  assert.equal((await listMessages(db, { role: "sent" })).items.length, 1);
  assert.equal((await listMessages(db, { accountId: ACCOUNT })).items.length, 2, "an account view spans its folders");
});

test("summaries carry messageId, null when the message has none", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  const withId = await upsertMessage(db, msg({
    folderId: inbox.id, uid: 1, messageId: "<with-id@mail.example.test>", date: T0 + 1000, subject: "topicone",
  }));
  const withoutId = await upsertMessage(db, msg({
    folderId: inbox.id, uid: 2, messageId: null, date: T0, subject: "topictwo",
  }));

  const listed = (await listMessages(db, { folderId: inbox.id })).items;
  assert.equal(listed.find((i) => i.id === withId.id).messageId, "<with-id@mail.example.test>");
  assert.equal(listed.find((i) => i.id === withoutId.id).messageId, null);

  const found = await searchLocal(db, { q: "topicone" });
  assert.equal(found[0].messageId, "<with-id@mail.example.test>");
  assert.equal(found[0].threadId, withId.threadId);
  assert.equal(found[0].folderId, inbox.id);
  assert.equal(found[0].snippet, "");

  const second = await searchLocal(db, { q: "topictwo" });
  assert.equal(second[0].messageId, null);
});

/* ---------------------------------------------------------- copies and deletes */

test("copyRows returns the row plus its other-folder copies, by Message-ID, sender and date", async () => {
  const db = await freshDb();
  const folders = await addFolders(db, ACCOUNT, [
    { path: "INBOX", name: "Inbox" },
    { path: "Label", name: "Label" },
    { path: "Other", name: "Other" },
  ]);
  const inboxId = folders.find((f) => f.path === "INBOX").id;
  const labelId = folders.find((f) => f.path === "Label").id;
  const otherId = folders.find((f) => f.path === "Other").id;
  const messageId = "<copy@mail.example.test>";

  const original = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId, date: T0, subject: "copy" }));
  const copy = await upsertMessage(db, msg({ folderId: labelId, uid: 1, messageId, date: T0, subject: "copy" }));
  await upsertMessage(db, msg({ folderId: otherId, uid: 1, messageId, date: T0 + 1000, subject: "later" }));
  await upsertMessage(db, msg({
    folderId: otherId, uid: 2, messageId, date: T0, from: { name: "", address: KIM }, subject: "other sender",
  }));
  await upsertMessage(db, msg({ folderId: inboxId, uid: 3, messageId, date: T0, subject: "same folder" }));

  const found = await copyRows(db, await getMessage(db, original.id));
  assert.deepEqual(found.map((r) => r.id).sort(), [original.id, copy.id].sort());
  assert.equal(found[0].accountId, ACCOUNT);

  // A message with no Message-ID has no copies: the id is sender-controlled and can be reused.
  const lonely = await upsertMessage(db, msg({ folderId: labelId, uid: 9, messageId: null, date: T0, subject: "lonely" }));
  const alone = await copyRows(db, { id: lonely.id });
  assert.deepEqual(alone.map((r) => r.id), [lonely.id]);
  assert.deepEqual(await copyRows(db, { id: 9999 }), []);
});

test("deleteMessageRow removes the row, its FTS entry and an emptied thread", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);

  const parent = await upsertMessage(db, msg({
    folderId: inbox.id, uid: 1, messageId: "<p@mail.example.test>", subject: "Thread", text: "parentbody",
  }));
  const child = await upsertMessage(db, msg({
    folderId: inbox.id,
    uid: 2,
    messageId: "<c@mail.example.test>",
    inReplyTo: "<p@mail.example.test>",
    references: ["<p@mail.example.test>"],
    subject: "Re: Thread",
    text: "childbody",
    date: T0 + 1000,
  }));
  const alone = await upsertMessage(db, msg({
    folderId: inbox.id, uid: 3, messageId: "<a@mail.example.test>", subject: "Alone", text: "alonebody",
  }));
  assert.equal(parent.threadId, child.threadId);

  await deleteMessageRow(db, child.id);
  assert.equal(await row(db, child.id), null);
  assert.deepEqual(await searchLocal(db, { q: "childbody" }), []);
  const { rows: kept } = await db.execute({ sql: "SELECT * FROM mail_threads WHERE id = ?", args: [parent.threadId] });
  assert.equal(kept.length, 1, "the thread still has the parent");
  assert.equal(Number(kept[0].message_count), 1, "and its count followed");
  assert.equal((await listFolders(db, ACCOUNT))[0].totalCount, 2);

  await deleteMessageRow(db, alone.id);
  const { rows: gone } = await db.execute({ sql: "SELECT id FROM mail_threads WHERE id = ?", args: [alone.threadId] });
  assert.equal(gone.length, 0, "an emptied thread row goes");

  await deleteMessageRow(db, parent.id);
  const { rows: threads } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM mail_threads", args: [] });
  assert.equal(Number(threads[0].n), 0);
  await assertFtsIntegrity(db);
});

test("setReadForCopies flips every copy and the unread counts follow", async () => {
  const db = await freshDb();
  const folders = await addFolders(db, ACCOUNT, [
    { path: "INBOX", name: "Inbox" },
    { path: "Label", name: "Label" },
  ]);
  const inboxId = folders.find((f) => f.path === "INBOX").id;
  const labelId = folders.find((f) => f.path === "Label").id;
  const messageId = "<copy@mail.example.test>";

  // Copies share Message-ID, sender and date; the later-inserted inbox row is the newest of the group,
  // so it is the one the counts read.
  const labelCopy = await upsertMessage(db, msg({ folderId: labelId, uid: 1, messageId, date: T0, subject: "copy" }));
  const inboxCopy = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId, date: T0, subject: "copy" }));

  const changed = await setReadForCopies(db, await getMessage(db, inboxCopy.id), true);
  assert.equal(changed, 2, "both copies changed");
  assert.equal((await getMessage(db, inboxCopy.id)).isRead, true);
  assert.equal((await getMessage(db, labelCopy.id)).isRead, true);

  let listed = await listFolders(db, ACCOUNT);
  assert.equal(listed.reduce((sum, f) => sum + f.unreadCount, 0), 0);
  assert.equal(listed.reduce((sum, f) => sum + f.totalCount, 0), 1, "still one logical message");

  assert.equal(await setReadForCopies(db, await getMessage(db, inboxCopy.id), false), 2);
  listed = await listFolders(db, ACCOUNT);
  assert.equal(listed.find((f) => f.path === "INBOX").unreadCount, 1, "the newest copy is unread again");
  assert.equal(listed.reduce((sum, f) => sum + f.totalCount, 0), 1);
});

/* --------------------------------------------------------------- reconciliation */

test("applyFlags rewrites flags and read state without touching the search index", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  const written = await upsertMessage(db, msg({ folderId: inbox.id, uid: 4, subject: "flagsubject", text: "flagbodytoken" }));
  assert.equal((await getMessage(db, written.id)).isRead, false);

  const updated = await applyFlags(db, inbox.id, [{ uid: 4, flags: ["\\Seen", "\\Flagged"] }, { uid: 99, flags: ["\\Seen"] }]);
  assert.equal(updated, 1, "only the stored uid changed");
  const stored = await getMessage(db, written.id);
  assert.deepEqual(stored.flags, ["\\Seen", "\\Flagged"]);
  assert.equal(stored.isRead, true);

  const thread = (await db.execute({ sql: "SELECT unread_count FROM mail_threads WHERE id = ?", args: [written.threadId] })).rows[0];
  assert.equal(Number(thread.unread_count), 0);

  assert.equal((await searchLocal(db, { q: "flagbodytoken" })).length, 1, "the index still finds it");
  await assertFtsIntegrity(db);

  await applyFlags(db, inbox.id, [{ uid: 4, flags: [] }]);
  assert.equal((await getMessage(db, written.id)).isRead, false);
});

test("storedUids and minUid follow the folder's rows", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  assert.deepEqual(await storedUids(db, inbox.id), []);
  assert.equal(await minUid(db, inbox.id), null);

  for (const uid of [9, 3, 41]) await upsertMessage(db, msg({ folderId: inbox.id, uid, subject: `uid ${uid}` }));
  assert.deepEqual(await storedUids(db, inbox.id), [3, 9, 41]);
  assert.equal(await minUid(db, inbox.id), 3);
});

test("deleteMissing removes only absent uids at or above minUid and drops emptied threads", async () => {
  const db = await freshDb();
  const [inbox] = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }]);
  for (const uid of [1, 2, 3, 4, 5]) {
    await upsertMessage(db, msg({ folderId: inbox.id, uid, subject: `expunge subject ${uid}`, text: `expungebody${uid}` }));
  }

  assert.equal(await deleteMissing(db, inbox.id, [1, 2, 3, 4, 5], { minUid: 1 }), 0);
  assert.equal(await deleteMissing(db, inbox.id, [1, 2, 3, 4, 5], { minUid: 3 }), 0);

  // uid 2 is gone from the server; uid 1 is below minUid and stays even though it is not listed.
  assert.equal(await deleteMissing(db, inbox.id, [1, 3, 4, 5], { minUid: 2 }), 1);
  assert.deepEqual(await storedUids(db, inbox.id), [1, 3, 4, 5]);
  assert.deepEqual(await searchLocal(db, { q: "expungebody2" }), []);

  assert.equal(await deleteMissing(db, inbox.id, [1, 3], { minUid: 1 }), 2);
  assert.deepEqual(await storedUids(db, inbox.id), [1, 3]);
  await assertFtsIntegrity(db);
});

test("resetFolder clears messages, FTS, UID bookkeeping and emptied threads", async () => {
  const db = await freshDb();
  const folders = await addFolders(db, ACCOUNT, [{ path: "INBOX", name: "Inbox" }, { path: "Label", name: "Label" }]);
  const inboxId = folders.find((f) => f.path === "INBOX").id;
  const labelId = folders.find((f) => f.path === "Label").id;

  const kept = await upsertMessage(db, msg({
    folderId: inboxId, uid: 1, messageId: "<kept@mail.example.test>", subject: "kept subject", text: "keptbodytoken",
  }));
  await upsertMessage(db, msg({
    folderId: labelId, uid: 1, messageId: "<kept@mail.example.test>", subject: "kept subject", text: "keptbodytoken",
  }));
  const doomed = await upsertMessage(db, msg({
    folderId: inboxId, uid: 2, messageId: "<doomed@mail.example.test>", subject: "doomed subject", text: "doomedbodytoken",
  }));
  await setFolderSyncState(db, inboxId, { uidValidity: 11, highestUid: 500, floorUid: 1 });

  const result = await resetFolder(db, inboxId, 42);
  assert.equal(result.messages, 2);
  const stored = await getFolder(db, inboxId);
  assert.equal(stored.uidValidity, 42);
  assert.equal(stored.highestUid, 0);
  assert.equal(stored.floorUid, null);
  assert.deepEqual(await storedUids(db, inboxId), []);

  assert.deepEqual(await searchLocal(db, { q: "doomedbodytoken" }), []);
  assert.equal((await searchLocal(db, { q: "keptbodytoken" })).length, 1, "the label copy keeps its index entry");
  await assertFtsIntegrity(db);

  const { rows: threads } = await db.execute({ sql: "SELECT id, message_count FROM mail_threads ORDER BY id", args: [] });
  assert.equal(threads.length, 1, "the emptied thread went, the shared one stayed");
  assert.equal(Number(threads[0].id), kept.threadId);
  assert.equal(Number(threads[0].message_count), 1);
  assert.equal((await getMessage(db, doomed.id)), null);
});