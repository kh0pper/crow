// Crow Mail's reader queries (servers/gateway/mail/store/reader-queries.js) against a scratch DB built
// from MAIL_DDL: which row a link means — a row hint that is checked rather than trusted, and a
// Message-ID lookup grouped by sender and date — what one conversation holds, and the per-account
// remote-image allow list.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import { addImageAllow } from "../servers/gateway/mail/store/accounts.js";
import {
  copyRows,
  getMessage,
  resetFolder,
  upsertFolders,
  upsertMessage,
} from "../servers/gateway/mail/store/messages.js";
import {
  listImageAllow,
  listThreadMessages,
  resolveMessageRef,
} from "../servers/gateway/mail/store/reader-queries.js";

const ACCOUNT = "ma-0123456789abcdef";
const OTHER = "ma-fedcba9876543210";
const ALEX = "alex@example.com";
const SAM = "sam@example.com";

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-reader-"));
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

/** An account with an INBOX and a Gmail-style label folder, by id. */
async function twoFolders(db, accountId = ACCOUNT) {
  const folders = await addFolders(db, accountId, [
    { path: "INBOX", name: "Inbox" },
    { path: "Label", name: "Label" },
  ]);
  return {
    inboxId: folders.find((f) => f.path === "INBOX").id,
    labelId: folders.find((f) => f.path === "Label").id,
  };
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
    to: [{ name: "Sam", address: SAM }],
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

/* ---------------------------------------------------- a link to one message */

test("resolveMessageRef finds ids containing < > % + & # space unicode and a 900-char id", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const odd = [
    "<a<b@mail.example.test>",
    "<a>b@mail.example.test>",
    "<100%+&@mail.example.test>",
    "<tag#1@mail.example.test>",
    "<spaced id@mail.example.test>",
    "<üñî-🙂@mail.example.test>",
    `<${"x".repeat(880)}@mail.example.test>`,
  ];

  const written = [];
  for (const messageId of odd) {
    written.push({ messageId, row: await upsertMessage(db, msg({ folderId: inboxId, messageId })) });
  }

  for (const { messageId, row } of written) {
    const found = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId });
    assert.ok(found, `a reference to ${messageId.slice(0, 24)} resolves`);
    assert.equal(found.id, row.id);
    assert.equal(found.messageId, messageId);
    assert.equal(found.accountId, ACCOUNT);
  }
});

test("resolveMessageRef after resetFolder and re-sync still finds the message by Message-ID", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const messageId = "<kept-through-reset@mail.example.test>";
  const before = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId, subject: "before" }));

  await resetFolder(db, inboxId, 99);
  const after = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId, subject: "after" }));
  assert.notEqual(after.id, before.id);
  assert.equal(await getMessage(db, before.id), null);

  const byMid = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId });
  assert.equal(byMid.id, after.id);
  assert.equal(byMid.subject, "after");

  // The link still carries the row id from before the reset: the Message-ID wins over the hint.
  const byStaleRow = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId, row: before.id });
  assert.equal(byStaleRow.id, after.id);

  // A row-only link to the row the reset removed finds nothing.
  assert.equal(await resolveMessageRef(db, { accountId: ACCOUNT, row: before.id }), null);
});

test("a row from another account is ignored", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const { inboxId: otherInboxId } = await twoFolders(db, OTHER);
  const messageId = "<other-account@mail.example.test>";

  const foreign = await upsertMessage(db, msg({
    accountId: OTHER, folderId: otherInboxId, uid: 1, messageId, subject: "not mine",
  }));
  assert.equal(await resolveMessageRef(db, { accountId: ACCOUNT, row: foreign.id }), null);
  assert.equal(await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId, row: foreign.id }), null);

  const mine = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId, subject: "mine" }));
  const found = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId, row: foreign.id });
  assert.equal(found.id, mine.id, "the account's own row is the one that answers, never the other account's");
});

test("a row whose message_id equals mid is used (so a label-folder click opens that folder's copy)", async () => {
  const db = await freshDb();
  const { inboxId, labelId } = await twoFolders(db);
  const messageId = "<copy-in-label@mail.example.test>";
  const inboxRow = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId, date: T0, subject: "copy" }));
  const labelRow = await upsertMessage(db, msg({ folderId: labelId, uid: 1, messageId, date: T0, subject: "copy" }));

  const opened = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId, row: labelRow.id });
  assert.equal(opened.id, labelRow.id);
  assert.equal(opened.folderId, labelId);
  assert.notEqual(opened.id, inboxRow.id);

  const byMid = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId });
  assert.equal(byMid.id, inboxRow.id, "without a hint the inbox copy is the one the Message-ID means");
});

test("a stale row id whose message_id differs from mid is ignored and mid wins", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const older = await upsertMessage(db, msg({
    folderId: inboxId, uid: 1, messageId: "<old@mail.example.test>", date: T0, subject: "old",
  }));
  const newer = await upsertMessage(db, msg({
    folderId: inboxId, uid: 2, messageId: "<new@mail.example.test>", date: T0 + 1000, subject: "new",
  }));

  const found = await resolveMessageRef(db, {
    accountId: ACCOUNT, mid: "<new@mail.example.test>", row: older.id,
  });
  assert.equal(found.id, newer.id);

  // The same hint without a Message-ID is a plain row link.
  assert.equal((await resolveMessageRef(db, { accountId: ACCOUNT, row: older.id })).id, older.id);
});

test("a forged message reusing a known Message-ID with another From does not answer for it", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const messageId = "<reused@mail.example.test>";
  const real = await upsertMessage(db, msg({
    folderId: inboxId, uid: 1, messageId, date: T0, from: { name: "", address: ALEX }, subject: "real",
  }));
  const forged = await upsertMessage(db, msg({
    folderId: inboxId, uid: 2, messageId, date: T0 + 1000, from: { name: "", address: SAM }, subject: "forged",
  }));

  const byMid = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId });
  assert.equal(byMid.id, real.id, "the group that arrived first is the one the id means");
  assert.equal(byMid.fromAddr, ALEX);

  // A link that names the forged row opens the forged message, as itself and nothing else.
  const byForgedRow = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId, row: forged.id });
  assert.equal(byForgedRow.id, forged.id);
  assert.equal(byForgedRow.fromAddr, SAM);

  const byRealRow = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId, row: real.id });
  assert.equal(byRealRow.id, real.id);
});

test("a null-Message-ID message resolves by row only", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const idless = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId: null, subject: "no id" }));

  const byRow = await resolveMessageRef(db, { accountId: ACCOUNT, row: idless.id });
  assert.equal(byRow.id, idless.id);
  assert.equal(byRow.messageId, null);
  assert.equal((await resolveMessageRef(db, { accountId: ACCOUNT, row: idless.id, mid: null })).id, idless.id);

  assert.equal(await resolveMessageRef(db, { accountId: ACCOUNT, mid: null }), null);
  assert.equal(await resolveMessageRef(db, { accountId: ACCOUNT }), null);
  assert.equal(await resolveMessageRef(db, { accountId: ACCOUNT, row: 9999 }), null);
  assert.equal(await resolveMessageRef(db, { accountId: "ma-not-a-real-account", row: idless.id }), null);
});

test("a message in INBOX and a label folder resolves to the INBOX row", async () => {
  const db = await freshDb();
  const { inboxId, labelId } = await twoFolders(db);
  const messageId = "<both-folders@mail.example.test>";

  // The label copy is written first, so the inbox row is not the lowest id of the group.
  const labelRow = await upsertMessage(db, msg({ folderId: labelId, uid: 1, messageId, date: T0, subject: "copy" }));
  const inboxRow = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId, date: T0, subject: "copy" }));

  const found = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId });
  assert.equal(found.id, inboxRow.id);
  assert.notEqual(found.id, labelRow.id);
  assert.equal(found.folderId, inboxId);
});

/* --------------------------------------------------------------- a conversation */

test("listThreadMessages collapses copyRows to one entry, oldest first", async () => {
  const db = await freshDb();
  const { inboxId, labelId } = await twoFolders(db);
  const first = await upsertMessage(db, msg({
    folderId: inboxId, uid: 1, messageId: "<t1@mail.example.test>", date: T0, subject: "Thread",
  }));
  const second = await upsertMessage(db, msg({
    folderId: inboxId,
    uid: 2,
    messageId: "<t2@mail.example.test>",
    inReplyTo: "<t1@mail.example.test>",
    references: ["<t1@mail.example.test>"],
    date: T0 + 1000,
    subject: "Re: Thread",
  }));
  const labelCopy = await upsertMessage(db, msg({
    folderId: labelId, uid: 9, messageId: "<t1@mail.example.test>", date: T0, subject: "Thread",
  }));
  assert.equal(first.threadId, second.threadId);
  assert.equal(labelCopy.threadId, first.threadId);

  const thread = await listThreadMessages(db, ACCOUNT, first.threadId);
  assert.deepEqual(thread.map((item) => item.id), [first.id, second.id]);
  assert.equal(thread[0].folderId, inboxId, "the inbox row stands for the copy group");
  assert.equal(thread[0].messageId, "<t1@mail.example.test>");
  assert.equal(thread[1].messageId, "<t2@mail.example.test>");
  assert.equal(thread[0].accountId, ACCOUNT);
  assert.equal(thread[0].threadId, first.threadId);
  assert.equal("bodyText" in thread[0], false, "an entry is a summary, never a whole message");
});

test("two rows of one folder with the same Message-ID, From and Date both stay", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const messageId = "<delivered-twice@mail.example.test>";
  const first = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, messageId, date: T0, subject: "twice" }));
  const second = await upsertMessage(db, msg({ folderId: inboxId, uid: 2, messageId, date: T0, subject: "twice" }));
  assert.equal(first.threadId, second.threadId);

  // copyRows' rule: a copy lives in another folder, so these two are two deliveries, not copies.
  assert.equal((await copyRows(db, { id: first.id })).length, 1);
  assert.equal((await copyRows(db, { id: second.id })).length, 1);

  const thread = await listThreadMessages(db, ACCOUNT, first.threadId);
  assert.deepEqual(thread.map((item) => item.id), [first.id, second.id],
    "two rows in one folder are never collapsed into one");
  assert.deepEqual(thread.map((item) => item.folderId), [inboxId, inboxId]);
});

test("two messages in one thread sharing a Message-ID but not From both appear", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const messageId = "<shared@mail.example.test>";
  const real = await upsertMessage(db, msg({
    folderId: inboxId, uid: 1, messageId, date: T0, from: { name: "", address: ALEX }, subject: "shared",
  }));
  const forged = await upsertMessage(db, msg({
    folderId: inboxId, uid: 2, messageId, date: T0 + 1000, from: { name: "", address: SAM }, subject: "shared",
  }));
  assert.equal(real.threadId, forged.threadId);

  const thread = await listThreadMessages(db, ACCOUNT, real.threadId);
  assert.deepEqual(thread.map((item) => item.id), [real.id, forged.id]);
  assert.deepEqual(thread.map((item) => item.fromAddr), [ALEX, SAM]);
});

test("RF8: a reuse of a known Message-ID from the same sender with a later Date is its own entry", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  const messageId = "<reused-same-sender@mail.example.test>";
  const real = await upsertMessage(db, msg({
    folderId: inboxId, uid: 1, messageId, date: T0, internalDate: T0, subject: "reused",
  }));
  const later = await upsertMessage(db, msg({
    folderId: inboxId,
    uid: 2,
    messageId,
    date: T0 + 60_000,
    internalDate: T0 + 60_000,
    subject: "reused",
  }));
  assert.equal(real.threadId, later.threadId, "the reuse lands in the same conversation");

  const byMid = await resolveMessageRef(db, { accountId: ACCOUNT, mid: messageId });
  assert.equal(byMid.id, real.id, "the group that arrived first is the one the id means");
  assert.equal(byMid.date, T0, "the earlier date, not the later reuse");

  const thread = await listThreadMessages(db, ACCOUNT, real.threadId);
  assert.deepEqual(thread.map((item) => item.id), [real.id, later.id],
    "the later reuse is its own entry in the conversation");
  assert.deepEqual(thread.map((item) => item.date), [T0, T0 + 60_000]);
});

test("listThreadMessages of an unknown thread is []", async () => {
  const db = await freshDb();
  const { inboxId } = await twoFolders(db);
  await twoFolders(db, OTHER);
  const written = await upsertMessage(db, msg({ folderId: inboxId, uid: 1, subject: "alone" }));

  assert.deepEqual(await listThreadMessages(db, ACCOUNT, 999999), []);
  assert.deepEqual(await listThreadMessages(db, OTHER, written.threadId), []);
  assert.deepEqual(await listThreadMessages(db, ACCOUNT, 0), []);
  assert.deepEqual(await listThreadMessages(db, ACCOUNT, null), []);
});

/* ------------------------------------------------------- remote-image allow */

test("listImageAllow is lower-cased, sorted, per account", async () => {
  const db = await freshDb();
  await addImageAllow(db, ACCOUNT, "Zoe@Example.com");
  await addImageAllow(db, ACCOUNT, "alex@example.com");
  // addImageAllow lower-cases on the way in; a row written any other way must still read lower-cased.
  await db.execute({
    sql: "INSERT INTO mail_image_allow (account_id, sender, created_at) VALUES (?, ?, ?)",
    args: [ACCOUNT, "Mixed@Example.COM", T0],
  });
  await addImageAllow(db, OTHER, "sam@example.com");

  assert.deepEqual(await listImageAllow(db, ACCOUNT), ["alex@example.com", "mixed@example.com", "zoe@example.com"]);
  assert.deepEqual(await listImageAllow(db, OTHER), ["sam@example.com"]);
  assert.deepEqual(await listImageAllow(db, "ma-unknown"), []);
});