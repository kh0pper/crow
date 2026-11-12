// Crow Mail thread assignment (servers/gateway/mail/thread-key.js) against a scratch DB built from
// MAIL_DDL. The rules, in the order assignThread applies them: the same message already stored, a
// known parent, a known child, ids with no known relative, and (finally) subject plus time plus a
// shared participant. Rule 4 never joins on a subject alone: a same-day key collision between
// people with nothing in common, or an empty subject, starts a new thread. Merges are one
// transaction: messages move to the lowest thread id, emptied mail_threads rows go, counts are
// recomputed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import {
  normalizeSubject,
  assignThread,
  refreshThreadCounts,
} from "../servers/gateway/mail/thread-key.js";

const ACCOUNT = "ma-0123456789abcdef";
const OTHER_ACCOUNT = "ma-fedcba9876543210";
const INBOX = 1;
const LABEL = 2;

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const KIM = "kim@example.com";
const LEE = "lee@example.com";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-thread-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  return db;
}

/** folder_id/uid are plain integers here: mail_messages carries no foreign key to mail_folders. */
let nextUid = 1;

/** A stored message row — what the sync engine would have written before the next one arrives. */
async function store(db, fields = {}) {
  const {
    accountId = ACCOUNT,
    folderId = INBOX,
    threadId = null,
    messageId = null,
    inReplyTo = null,
    references = null,
    subject = "",
    from = ALEX,
    to = [SAM],
    cc = [],
    date = T0,
    isRead = 0,
  } = fields;
  const uid = nextUid++;
  const res = await db.execute({
    sql: `INSERT INTO mail_messages
      (account_id, folder_id, uid, thread_id, message_id, in_reply_to, references_json, subject,
       from_addr, from_text, to_json, cc_json, to_text, date, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      accountId, folderId, uid, threadId, messageId, inReplyTo,
      references == null ? null : JSON.stringify(references), subject,
      from, from, JSON.stringify(to.map((a) => ({ name: null, address: a }))),
      cc.length ? JSON.stringify(cc.map((a) => ({ name: null, address: a }))) : null,
      to.join(", "), date, isRead,
    ],
  });
  return Number(res.lastInsertRowid);
}

function assign(db, fields = {}) {
  return assignThread(db, fields.accountId || ACCOUNT, {
    messageId: null,
    inReplyTo: null,
    references: [],
    subject: "",
    date: T0,
    participants: [ALEX, SAM],
    ...fields,
  });
}

async function thread(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM mail_threads WHERE id = ?", args: [id] });
  return rows[0] ?? null;
}

async function threadCount(db) {
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM mail_threads", args: [] });
  return Number(rows[0].n);
}

async function threadIdsOfMessages(db) {
  const { rows } = await db.execute({ sql: "SELECT thread_id FROM mail_messages ORDER BY id", args: [] });
  return rows.map((r) => r.thread_id);
}

/* ------------------------------------------------------------ normalizeSubject */

test("normalizeSubject strips repeated prefixes and the tags after them", () => {
  assert.equal(normalizeSubject("Re: Re: Fwd: [list] Hello  World"), "hello world");
  assert.equal(normalizeSubject("AW: Fw: Lunch"), "lunch");
  assert.equal(normalizeSubject("FWD : Lunch"), "lunch");
  assert.equal(normalizeSubject("  Re:Re:Lunch "), "lunch");
  assert.equal(normalizeSubject("[list] Re: Lunch"), "lunch", "a list tag with the prefix behind it");
  assert.equal(normalizeSubject("Lunch [list]"), "lunch [list]", "a tag that follows no prefix stays");
  assert.equal(normalizeSubject("Remember: lunch"), "remember: lunch", "a word starting with re is not a prefix");
  assert.equal(normalizeSubject("Re: [tag] Re: [tag]  Hello"), "hello");
  assert.equal(normalizeSubject(""), "");
  assert.equal(normalizeSubject(null), "");
  assert.equal(normalizeSubject(undefined), "");
});

/* ------------------------------------------------------------------- rule 1 */

test("a reply to a stored parent joins the parent's thread", async () => {
  const db = await freshDb();
  const parent = await assign(db, { messageId: "<a@example.test>", subject: "Lunch", date: T0 });
  await store(db, { threadId: parent, messageId: "<a@example.test>", subject: "Lunch", date: T0 });

  const reply = await assign(db, {
    messageId: "<b@example.test>",
    inReplyTo: "<a@example.test>",
    references: ["<a@example.test>"],
    subject: "Re: Lunch",
    date: T0 + 5 * MINUTE,
  });
  assert.equal(reply, parent);
  assert.equal(await threadCount(db), 1);
});

/* ------------------------------------------------------------------- rule 2 */

test("a parent that arrives after its child joins the child's thread", async () => {
  const db = await freshDb();
  const child = await assign(db, {
    messageId: "<b@example.test>",
    inReplyTo: "<a@example.test>",
    references: ["<a@example.test>"],
    subject: "Re: Lunch",
    date: T0 + 5 * MINUTE,
  });
  await store(db, {
    threadId: child,
    messageId: "<b@example.test>",
    inReplyTo: "<a@example.test>",
    references: ["<a@example.test>"],
    subject: "Re: Lunch",
    date: T0 + 5 * MINUTE,
  });

  const parent = await assign(db, { messageId: "<a@example.test>", subject: "Lunch", date: T0 });
  assert.equal(parent, child);
  await store(db, { threadId: parent, messageId: "<a@example.test>", subject: "Lunch", date: T0 });
  await refreshThreadCounts(db, parent);

  assert.equal(await threadCount(db), 1);
  assert.equal((await thread(db, parent)).message_count, 2);
});

test("a parent found only in a stored child's references_json joins that child's thread", async () => {
  const db = await freshDb();
  const refs = ["<root@example.test>", "<p@example.test>"];
  // The child names the parent in references only: its in_reply_to is a different id.
  const child = await assign(db, {
    messageId: "<c@example.test>",
    inReplyTo: "<root@example.test>",
    references: refs,
    subject: "Re: Re: Topic",
    date: T0 + DAY,
  });
  await store(db, {
    threadId: child,
    messageId: "<c@example.test>",
    inReplyTo: "<root@example.test>",
    references: refs,
    subject: "Re: Re: Topic",
    date: T0 + DAY,
  });

  const parent = await assign(db, { messageId: "<p@example.test>", subject: "Topic", date: T0 });
  assert.equal(parent, child);
  assert.equal(await threadCount(db), 1);
});

test("a child dated more than two days before the parent is outside the references_json window, so the parent starts its own thread", async () => {
  const db = await freshDb();
  const refs = ["<root@example.test>", "<p@example.test>"];
  // Stored three days BEFORE the parent it references: past the two-day clock-skew bound the
  // references scan is restricted to, so the parent cannot find it and starts afresh.
  const child = await assign(db, {
    messageId: "<c@example.test>",
    inReplyTo: "<root@example.test>",
    references: refs,
    subject: "Re: Re: Topic",
    date: T0 - 3 * DAY,
  });
  await store(db, {
    threadId: child,
    messageId: "<c@example.test>",
    inReplyTo: "<root@example.test>",
    references: refs,
    subject: "Re: Re: Topic",
    date: T0 - 3 * DAY,
  });

  const parent = await assign(db, { messageId: "<p@example.test>", subject: "Topic", date: T0 });
  assert.notEqual(parent, child);
  assert.equal(await threadCount(db), 2);
});

/* ------------------------------------------------------------------- merge */

test("a reply that references two threads merges them into the lowest thread id", async () => {
  const db = await freshDb();
  const first = await assign(db, { messageId: "<a@example.test>", subject: "One", date: T0 });
  await store(db, { threadId: first, messageId: "<a@example.test>", subject: "One", date: T0 });
  const second = await assign(db, {
    messageId: "<b@example.test>",
    subject: "Two",
    date: T0 + MINUTE,
    participants: [KIM, LEE],
  });
  await store(db, {
    threadId: second, messageId: "<b@example.test>", subject: "Two", date: T0 + MINUTE, from: KIM, to: [LEE],
  });
  const lowest = Math.min(first, second);

  const merged = await assign(db, {
    messageId: "<c@example.test>",
    references: ["<a@example.test>", "<b@example.test>"],
    subject: "Re: One",
    date: T0 + 2 * MINUTE,
  });

  assert.equal(merged, lowest);
  assert.equal(await threadCount(db), 1);
  assert.equal(await thread(db, Math.max(first, second)), null, "the emptied thread row is gone");
  assert.deepEqual(await threadIdsOfMessages(db), [lowest, lowest], "both messages moved to the lowest id");
});

test("a merge recomputes message_count, unread_count and last_date", async () => {
  const db = await freshDb();
  const first = await assign(db, { messageId: "<a@example.test>", subject: "One", date: T0 });
  await store(db, { threadId: first, messageId: "<a@example.test>", date: T0, isRead: 1 });
  await store(db, { threadId: first, messageId: "<a2@example.test>", date: T0 + MINUTE, isRead: 0 });
  const second = await assign(db, {
    messageId: "<b@example.test>",
    subject: "Two",
    date: T0 + 2 * MINUTE,
    participants: [KIM, LEE],
  });
  await store(db, {
    threadId: second, messageId: "<b@example.test>", date: T0 + 2 * MINUTE, isRead: 0, from: KIM, to: [LEE],
  });

  const merged = await assign(db, {
    messageId: "<c@example.test>",
    references: ["<a@example.test>", "<b@example.test>"],
    subject: "Re: One",
    date: T0 + 3 * MINUTE,
  });
  assert.equal(merged, first);

  const row = await thread(db, first);
  assert.equal(row.message_count, 3);
  assert.equal(row.unread_count, 2);
  assert.equal(row.last_date, T0 + 3 * MINUTE, "the arriving message's date is reflected immediately");
});

/* ------------------------------------------------------------------- rule 0 */

test("the same message in INBOX and a label folder is one thread with message_count 1", async () => {
  const db = await freshDb();
  const messageId = "<same@example.test>";
  const inboxThread = await assign(db, { messageId, subject: "Shared", date: T0 });
  await store(db, { threadId: inboxThread, folderId: INBOX, messageId, subject: "Shared", date: T0 });

  const labelThread = await assign(db, { messageId, subject: "Shared", date: T0 });
  assert.equal(labelThread, inboxThread, "rule 0: the same message already stored keeps its thread");
  await store(db, { threadId: labelThread, folderId: LABEL, messageId, subject: "Shared", date: T0 });

  await refreshThreadCounts(db, inboxThread);
  const row = await thread(db, inboxThread);
  assert.equal(row.message_count, 1, "the two copies are one logical message");
  assert.equal(row.unread_count, 1);
  assert.equal(await threadCount(db), 1);
});

test("the same message id in another account is a different thread", async () => {
  const db = await freshDb();
  const mine = await assign(db, { messageId: "<a@example.test>", subject: "Lunch", date: T0 });
  await store(db, { threadId: mine, messageId: "<a@example.test>", subject: "Lunch", date: T0 });

  const theirs = await assign(db, {
    accountId: OTHER_ACCOUNT,
    messageId: "<a@example.test>",
    subject: "Lunch",
    date: T0,
  });
  assert.notEqual(theirs, mine);
  assert.equal(await threadCount(db), 2);
});

/* ------------------------------------------------------------------- rule 3 */

test("a message with its own id and no references starts its own thread", async () => {
  const db = await freshDb();
  const one = await assign(db, { messageId: "<one@example.test>", subject: "Same subject", date: T0 });
  const two = await assign(db, { messageId: "<two@example.test>", subject: "Same subject", date: T0 });

  assert.notEqual(one, two);
  assert.equal(await threadCount(db), 2);
  assert.equal((await thread(db, one)).thread_key, "mid:<one@example.test>");
});

test("two messages with no stored relative join on the id in the first reference", async () => {
  const db = await freshDb();
  const one = await assign(db, {
    messageId: "<m1@example.test>",
    references: ["<root@example.test>", "<x@example.test>"],
    subject: "Topic",
    date: T0,
  });
  const two = await assign(db, {
    messageId: "<m2@example.test>",
    inReplyTo: "<root@example.test>",
    references: ["<root@example.test>", "<y@example.test>"],
    subject: "Re: Topic",
    date: T0 + MINUTE,
  });

  assert.equal(two, one);
  assert.equal((await thread(db, one)).thread_key, "mid:<root@example.test>");
  assert.equal(await threadCount(db), 1);
});

/* ------------------------------------------------------------------- rule 4 */

test("an id-less message joins a same-subject thread two days old when a participant is shared", async () => {
  const db = await freshDb();
  const first = await assign(db, { subject: "Lunch", date: T0 });
  await store(db, { threadId: first, subject: "Lunch", date: T0, from: ALEX, to: [SAM] });

  const second = await assign(db, {
    subject: "Re: Lunch",
    date: T0 + 2 * DAY,
    participants: [SAM, ALEX],
  });
  assert.equal(second, first);
  assert.equal((await thread(db, first)).thread_key, `subj:lunch:${new Date(T0).toISOString().slice(0, 10)}`,
    "the thread keeps the key of the message that started it");
});

test("the same subject and participants thirty days apart are two threads", async () => {
  const db = await freshDb();
  const first = await assign(db, { subject: "Lunch", date: T0 });
  await store(db, { threadId: first, subject: "Lunch", date: T0, from: ALEX, to: [SAM] });

  const second = await assign(db, { subject: "Re: Lunch", date: T0 + 30 * DAY, participants: [SAM, ALEX] });
  assert.notEqual(second, first);
  assert.equal(await threadCount(db), 2);
});

test("the same subject with no shared participant is two threads", async () => {
  const db = await freshDb();
  const first = await assign(db, { subject: "Hello", date: T0 });
  await store(db, { threadId: first, subject: "Hello", date: T0, from: ALEX, to: [SAM] });

  const second = await assign(db, {
    subject: "Re: Hello",
    date: T0 + 3 * DAY,
    participants: [KIM, LEE],
  });
  assert.notEqual(second, first);
  assert.equal(await threadCount(db), 2);
});

test("a same-day subject key collision with no shared participant starts a second thread, no UNIQUE error", async () => {
  const db = await freshDb();
  // Same normalized subject and same UTC day, no shared participant: rule 4 refuses the join, so
  // the day's key already taken gets a participant suffix rather than being joined or duplicated.
  const day = new Date(T0).toISOString().slice(0, 10);
  const first = await assign(db, { subject: "Hello", date: T0, participants: [ALEX, SAM] });
  await store(db, { threadId: first, subject: "Hello", date: T0, from: ALEX, to: [SAM] });

  const second = await assign(db, { subject: "Re: Hello", date: T0 + MINUTE, participants: [KIM, LEE] });
  assert.notEqual(second, first);
  assert.equal(await threadCount(db), 2);
  assert.equal((await thread(db, second)).thread_key, `subj:hello:${day}:${KIM}`);
  await store(db, { threadId: second, subject: "Re: Hello", date: T0 + MINUTE, from: KIM, to: [LEE] });

  const third = await assign(db, { subject: "Hello", date: T0 + 2 * MINUTE, participants: [LEE, KIM] });
  assert.equal(third, second, "the same pair lands on the suffixed key it already owns");
  assert.equal(await threadCount(db), 2);
});

test("a thread keyed on 'Meeting: agenda' is never reused for 'Meeting'", async () => {
  const db = await freshDb();
  // Both keys share the prefix `subj:meeting:`; only a whole normalized subject matches, so the
  // shorter subject starts its own thread even on the same day with the same people.
  const agenda = await assign(db, { subject: "Meeting: agenda", date: T0 });
  await store(db, { threadId: agenda, subject: "Meeting: agenda", date: T0, from: ALEX, to: [SAM] });

  const plain = await assign(db, { subject: "Meeting", date: T0 + MINUTE, participants: [ALEX, SAM] });
  assert.notEqual(plain, agenda);
  assert.equal(await threadCount(db), 2);
});

test("an id-less message with no subject always starts a new anon thread", async () => {
  const db = await freshDb();
  const first = await assign(db, { subject: "", date: T0, participants: [] });
  await store(db, { threadId: first, subject: "", date: T0 });
  const firstKey = (await thread(db, first)).thread_key;
  assert.match(firstKey, /^anon:[0-9a-f]+$/);

  // Even the same people on the same day: an empty subject is never a join key.
  const second = await assign(db, { subject: "Re:", date: T0 + MINUTE, participants: [ALEX, SAM] });
  assert.notEqual(second, first);
  assert.match((await thread(db, second)).thread_key, /^anon:[0-9a-f]+$/);
  assert.equal(await threadCount(db), 2);
});

test("a finite out-of-range date cannot throw: the day falls back to the epoch", async () => {
  const db = await freshDb();
  let id;
  await assert.doesNotReject(async () => {
    id = await assign(db, { subject: "Hello", date: 8.7e15, participants: [ALEX] });
  });
  assert.equal((await thread(db, id)).thread_key, "subj:hello:1970-01-01");
});

/* ------------------------------------------------------- refreshThreadCounts */

test("refreshThreadCounts counts each null-message-id row separately and deletes nothing", async () => {
  const db = await freshDb();
  const id = await assign(db, { subject: "No ids", date: T0 });
  await store(db, { threadId: id, messageId: null, date: T0 });
  await store(db, { threadId: id, messageId: null, date: T0 + MINUTE });
  await store(db, { threadId: id, messageId: null, date: T0 + 2 * MINUTE, isRead: 1 });

  await refreshThreadCounts(db, id);
  let row = await thread(db, id);
  assert.equal(row.message_count, 3);
  assert.equal(row.unread_count, 2);
  assert.equal(row.last_date, T0 + 2 * MINUTE);

  const empty = await assign(db, { messageId: "<empty@example.test>", subject: "Empty", date: T0 });
  await refreshThreadCounts(db, empty);
  row = await thread(db, empty);
  assert.notEqual(row, null, "an empty thread keeps its row");
  assert.equal(row.message_count, 0);
  assert.equal(row.unread_count, 0);
  assert.equal(row.last_date, null);
});