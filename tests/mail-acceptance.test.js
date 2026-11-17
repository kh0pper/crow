// Crow Mail's acceptance script (plan 3, Task 14): one draft card driven from the reply seam to a
// delivered message, then a scheduled send across a restart, then a schedule left past its grace
// window.
//
// The harness is the send and schedule tests': a scratch DB built from MAIL_DDL, the account send
// columns, MAIL_DRAFTS_DDL, the settings and contacts tables init-db.js gives an instance, an
// injected clock and an injected timer. Mail leaves over the wire: the real IMAP/SMTP adapter talks
// to the in-process fake SMTP server (tests/fixtures/fake-mail-server.mjs) on 127.0.0.1, so the bytes a
// person's tap produces are read back from that server's own record of the DATA command.
//
// The state machine, the hash, the seal, the hold, the claim and the tick are the shipped modules.
// The bot is a mock: it writes its revisions through `addRevision` with `author: 'bot'`, which is what
// a drafting turn's `mail_draft_propose` does. The receipt is read through the real owner route
// (`GET /dashboard/mail/api/drafts/:id`), mounted on a bare express app with the draft router's own
// handlers, because the reader link is a route answer.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } from "../servers/shared/mail-schema.js";
import { createAccount, updateAccount, getAccount } from "../servers/gateway/mail/store/accounts.js";
import { getMessage } from "../servers/gateway/mail/store/messages.js";
import {
  addComment, addRevision, createDraft, getDraft, listComments, listRevisions,
} from "../servers/gateway/mail/drafts/store.js";
import { deriveReply } from "../servers/gateway/mail/drafts/recipients.js";
import {
  HOLD_MS, SEND_FAIL_REASONS, _resetInFlightForTests, requestSend,
} from "../servers/gateway/mail/send/send-service.js";
import {
  _drainForTests, _resetSweepForTests, scheduleDraft, sweepMailSends,
} from "../servers/gateway/mail/send/schedule-service.js";
import { createImapSmtpAdapter } from "../servers/gateway/mail/adapter/imap-smtp.js";
import { MAIL_API_PREFIX } from "../servers/gateway/routes/mail-api.js";
import { registerDraftRoutes } from "../servers/gateway/routes/mail-drafts-api.js";
import { createFakeSmtpServer } from "./fixtures/fake-mail-server.mjs";

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const REPLY_TO = "desk@example.com";
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const SEED = Buffer.alloc(32, 19);
const ZONE = "America/Chicago";
const PARENT_MID = "<tuesday-1@mail.example.test>";
const DRAFTS = `${MAIL_API_PREFIX}/drafts`;
const FAST = { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 4000 };

const dirs = [];
const servers = [];
const smtpServers = [];

after(async () => {
  for (const server of smtpServers) await server.close();
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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

const CONTACTS_DDL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crow_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    ed25519_pubkey TEXT NOT NULL,
    secp256k1_pubkey TEXT NOT NULL,
    email TEXT
  );
`;

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-acceptance-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  await db.executeMultiple(SETTINGS_DDL);
  await db.executeMultiple(CONTACTS_DDL);
  return db;
}

/** The account the draft is written from, its SMTP endpoint on the fake server. */
async function makeAccount(db, smtp) {
  const account = await createAccount(db, {
    label: "Alex",
    address: ALEX,
    imap: { host: "127.0.0.1", port: 1, security: "none" },
    smtp: { host: smtp.host, port: smtp.port, security: "none" },
  });
  return updateAccount(db, account.id, { displayName: "Alex" });
}

async function seedFolder(db, accountId, { path, name, specialUse }) {
  const result = await db.execute({
    sql: `INSERT INTO mail_folders (account_id, path, name, special_use, delimiter)
          VALUES (?, ?, ?, ?, '/')`,
    args: [accountId, path, name, specialUse],
  });
  return Number(result.lastInsertRowid);
}

/** One stored message row: the columns the reply derivation and the receipt read. */
async function seedMessage(db, accountId, folderId, {
  uid = 1, messageId, fromAddr = SAM, fromName = "Sam", subject = "Tuesday",
  to = [{ name: "Alex", address: ALEX }], cc = [], replyTo = [], body = "Does Tuesday work?",
  date = T0 - MIN,
}) {
  const result = await db.execute({
    sql: `INSERT INTO mail_messages
            (account_id, folder_id, uid, message_id, subject, from_name, from_addr, from_text,
             to_json, cc_json, reply_to_json, to_text, date, has_attachments, attachments_json,
             body_text, snippet)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, '[]', ?, ?)`,
    args: [
      accountId, folderId, uid, messageId, subject, fromName, fromAddr, `${fromName} ${fromAddr}`,
      JSON.stringify(to), JSON.stringify(cc), JSON.stringify(replyTo), date, body, body,
    ],
  });
  return Number(result.lastInsertRowid);
}

/**
 * The seam one service call gets, over one clock. A "restart" is a second call with its own clock and
 * its own maps: the same DB, no in-flight state.
 */
function makeDeps(adapter, clock, overrides = {}) {
  let ids = 0;
  const timers = [];
  const syncs = [];
  const notifications = [];
  const deps = {
    withAdapter: (accountId, fn) => fn(adapter),
    isClaimedElsewhere: async () => ({ claimed: false, instanceName: null }),
    requestSync: async (accountId) => { syncs.push(accountId); },
    loadKey: () => SEED,
    readMessageRaw: null,
    readStorageFile: null,
    now: () => clock(),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    newId: () => `acceptance-${++ids}`,
    zone: () => ZONE,
    createNotification: async (db, options) => {
      notifications.push(options);
      return { id: notifications.length };
    },
    ...overrides,
  };
  return { deps, timers, syncs, notifications };
}

/** The head revision of a draft, as a revision row. */
async function headOf(db, draftId) {
  const row = await getDraft(db, draftId);
  const revisions = await listRevisions(db, draftId);
  return revisions.find((revision) => revision.rev === row.headRev) ?? null;
}

/** One revision of a draft in the head's own words, with `patch` applied. */
async function revise(db, draftId, patch, { author, at, appliedCommentIds = [] }) {
  const row = await getDraft(db, draftId);
  const head = await headOf(db, draftId);
  return addRevision(db, draftId, {
    to: head.to,
    cc: head.cc,
    bcc: head.bcc,
    subject: head.subject,
    body: head.body,
    inReplyTo: head.inReplyTo,
    references: head.references,
    attachments: head.attachments,
    ...patch,
  }, {
    author,
    expectHash: row.headHash,
    appliedCommentIds,
    now: () => at,
  });
}

/** The real adapter, its SMTP endpoint on the fake server. */
function adapterFor(account) {
  return createImapSmtpAdapter({
    account,
    credentials: { getSecrets: async () => ({ MAIL_PASSWORD: "fake-app-pass" }) },
    timeouts: FAST,
  });
}

/** A server whose only route is the draft router's, over the test's own DB client. */
async function draftServer(db) {
  const { default: express } = await import("express");
  const router = express.Router();
  registerDraftRoutes(router, {
    route: (label, handler) => async (req, res) => {
      try {
        await handler(db, req, res);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: "internal" });
      }
    },
    sendError: (res, status, code, message) => {
      if (res.headersSent) return;
      res.status(status).json(message ? { error: code, message } : { error: code });
    },
    supervisor: () => null,
  });
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function readDraft(port, draftId) {
  const response = await fetch(`http://127.0.0.1:${port}${DRAFTS}/${draftId}`);
  return { status: response.status, json: await response.json() };
}

test("the card's draft is commented, edited, sent once, receipted, scheduled across a restart, and left missed past grace", async () => {
  const db = await freshDb();
  const smtp = await createFakeSmtpServer();
  smtpServers.push(smtp);
  const account = await makeAccount(db, smtp);
  const adapter = adapterFor(await getAccount(db, account.id));
  let clock = T0;
  const first = makeDeps(adapter, () => clock);

  /* ---------------------------------------------------------------- 1. the reply draft */
  // The message the person answers, and the reply the seam starts from it.
  const inbox = await seedFolder(db, account.id, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
  const parentId = await seedMessage(db, account.id, inbox, {
    messageId: PARENT_MID, subject: "Tuesday", replyTo: [{ name: "Desk", address: REPLY_TO }],
  });
  const parent = await getMessage(db, parentId);
  const derived = deriveReply(parent, account);

  const draft = await createDraft(db, {
    accountId: account.id,
    mode: "reply",
    replyToMid: PARENT_MID,
    threadKey: `mid:${PARENT_MID}`,
    chatThreadId: "chat-mail-1",
    first: {
      to: derived.to,
      cc: derived.cc,
      bcc: [],
      subject: derived.subject,
      body: "",
      inReplyTo: derived.inReplyTo,
      references: derived.references,
      attachments: [],
    },
    author: "user",
  }, { now: () => T0 });
  assert.equal(draft.state, "draft");
  assert.equal(draft.headRev, 1);

  const firstHead = await headOf(db, draft.id);
  assert.equal(firstHead.subject, "Re: Tuesday", "Re: is added once");
  assert.deepEqual(firstHead.to.map((entry) => entry.address), [REPLY_TO],
    "the reply follows the message's Reply-To");
  assert.equal(derived.replyToDiffers, REPLY_TO);

  /* ----------------------------------------------------- 2. the bot revises twice */
  const second = await revise(db, draft.id, { body: "Hello Sam,\n\nTuesday works for me." }, {
    author: "bot", at: T0 + MIN,
  });
  assert.equal(second.rev, 2);
  const third = await revise(db, draft.id, { body: "Hello Sam,\n\nTuesday works for me.\n\nAlex" }, {
    author: "bot", at: T0 + 2 * MIN,
  });
  assert.equal(third.rev, 3);
  assert.equal((await getDraft(db, draft.id)).headHash, third.hash);

  /* ------------------------------------------------------ 3. the person comments */
  const comment = await addComment(db, draft.id, {
    rev: 3,
    lineIndex: 1,
    quote: "Tuesday works for me.",
    text: "Offer Thursday instead.",
  }, { now: () => T0 + 3 * MIN });
  assert.equal(comment.state, "queued");

  /* -------------------------------------------------------- 4. the hand edit: Draft 4 */
  const fourth = await revise(db, draft.id, {
    body: "Hello Sam,\n\nThursday works for me.\n\nAlex",
  }, { author: "user", at: T0 + 4 * MIN });
  assert.equal(fourth.rev, 4);
  const edited = await getDraft(db, draft.id);
  assert.equal(edited.headRev, 4);
  assert.equal(edited.headHash, fourth.hash);
  const fourthHead = await headOf(db, draft.id);
  assert.equal(fourthHead.author, "user");
  // A hand edit changes the words; the comment waits for the next bot revision.
  assert.deepEqual((await listComments(db, draft.id, { state: "queued" })).map((entry) => entry.id),
    [comment.id]);

  /* ------------------------------------- 5. the tap, the hold not undone, the send */
  clock = T0 + 5 * MIN;
  const tap = await requestSend(db, first.deps, { draftId: draft.id, hash: fourth.hash, now: clock });
  assert.equal(tap.ok, true);
  assert.equal(tap.holdUntil, clock + HOLD_MS);
  assert.equal((await getDraft(db, draft.id)).state, "holding");
  assert.equal(smtp.messages.length, 0, "nothing is on the wire during the hold");
  assert.equal(first.timers.length, 1);
  assert.equal(first.timers[0].ms, HOLD_MS);

  // Undo is not pressed: the hold's own timer fires at the end of the window.
  clock = tap.holdUntil;
  await first.timers[0].fn();

  const sentRow = await getDraft(db, draft.id);
  assert.equal(sentRow.state, "sent");
  assert.equal(sentRow.sentAt, clock);
  assert.ok(sentRow.messageId);

  assert.equal(smtp.messages.length, 1, "the message reached the SMTP server exactly once");
  const delivered = smtp.messages[0];
  assert.deepEqual(delivered.rcpt, [REPLY_TO]);
  assert.equal(delivered.from, ALEX);
  assert.match(delivered.raw, /^Subject: Re: Tuesday$/m);
  assert.ok(delivered.raw.includes("Thursday works for me."));
  assert.ok(delivered.raw.includes(`Message-ID: ${sentRow.messageId}`));

  /* ------------------------------------------------ 6. the receipt, before and after a sync */
  const port = await draftServer(db);
  const syncing = await readDraft(port, draft.id);
  assert.equal(syncing.status, 200);
  assert.equal(syncing.json.receipt.sentAt, sentRow.sentAt);
  assert.equal(syncing.json.receipt.messageId, sentRow.messageId);
  assert.equal(syncing.json.receipt.accountLabel, "Alex");
  assert.equal(syncing.json.receipt.readerLink, null, "the Sent copy is not in the store yet");

  // The Sent copy arrives with the next sync of the account's Sent folder.
  const sentFolder = await seedFolder(db, account.id, { path: "Sent", name: "Sent", specialUse: "\\Sent" });
  await seedMessage(db, account.id, sentFolder, {
    uid: 1, messageId: sentRow.messageId, fromAddr: ALEX, fromName: "Alex",
    subject: "Re: Tuesday", to: [{ name: "Desk", address: REPLY_TO }], date: clock,
  });
  const linked = await readDraft(port, draft.id);
  assert.equal(linked.json.receipt.readerLink,
    `/dashboard/mail?view=message&a=${account.id}&mid=${encodeURIComponent(sentRow.messageId)}`);

  /* ------------------------------- 7. a scheduled draft across a gateway restart */
  const scheduledDraft = await createDraft(db, {
    accountId: account.id,
    mode: "reply",
    replyToMid: PARENT_MID,
    threadKey: `mid:${PARENT_MID}`,
    chatThreadId: "chat-mail-1",
    first: { to: [{ address: SAM }], cc: [], bcc: [], subject: "Re: Tuesday", body: "Scheduled body.", attachments: [] },
    author: "user",
  }, { now: () => clock });
  const dueAt = clock + 5 * MIN;
  const scheduled = await scheduleDraft(db, first.deps, {
    draftId: scheduledDraft.id, hash: scheduledDraft.headHash, dueAt, now: clock,
  });
  assert.equal(scheduled.ok, true);
  assert.equal((await getDraft(db, scheduledDraft.id)).state, "scheduled");

  // A restart: the same DB, new service objects, no in-flight map of its own.
  _resetInFlightForTests();
  _resetSweepForTests();
  const afterRestart = makeDeps(adapter, () => clock);
  const beforeTick = smtp.messages.length;

  // A tick before the due time sends nothing; the first tick at or after it delivers once.
  const early = await sweepMailSends(db, afterRestart.deps, { now: dueAt - MIN });
  assert.equal(early.delivered, 0);
  assert.equal(smtp.messages.length, beforeTick);

  const tick = await sweepMailSends(db, afterRestart.deps, { now: dueAt + 30_000 });
  assert.equal(tick.delivered, 1, "the tick starts the delivery of a schedule made before the restart");
  await _drainForTests();
  assert.equal((await getDraft(db, scheduledDraft.id)).state, "sent");
  assert.equal(smtp.messages.length, beforeTick + 1);
  assert.ok(smtp.messages[smtp.messages.length - 1].raw.includes("Scheduled body."));

  /* --------------------------- 8. a schedule left past the grace window is missed */
  const lateDraft = await createDraft(db, {
    accountId: account.id,
    mode: "reply",
    replyToMid: PARENT_MID,
    threadKey: `mid:${PARENT_MID}`,
    chatThreadId: "chat-mail-1",
    first: { to: [{ address: SAM }], cc: [], bcc: [], subject: "Re: Tuesday", body: "Too late body.", attachments: [] },
    author: "user",
  }, { now: () => clock });
  const lateDue = clock + 60 * MIN;
  const lateScheduled = await scheduleDraft(db, afterRestart.deps, {
    draftId: lateDraft.id, hash: lateDraft.headHash, dueAt: lateDue, now: clock,
  });
  assert.equal(lateScheduled.ok, true);
  const beforeMissed = smtp.messages.length;

  // Eleven minutes past the due time: past the ten-minute grace window.
  const missedTick = await sweepMailSends(db, afterRestart.deps, { now: lateDue + 11 * MIN });
  assert.equal(missedTick.missed, 1);
  assert.equal(missedTick.delivered, 0);
  await _drainForTests();

  const missedRow = await getDraft(db, lateDraft.id);
  assert.equal(missedRow.state, "missed");
  assert.equal(missedRow.failReason, SEND_FAIL_REASONS.missed);
  assert.equal(smtp.messages.length, beforeMissed, "a missed send never goes out by itself");
  assert.equal(afterRestart.notifications.length, 1, "one bell, for the missed send");
  assert.equal(afterRestart.notifications[0].source, "mail");

  // The next tick finds a terminal row: no second bell and still nothing on the wire.
  const again = await sweepMailSends(db, afterRestart.deps, { now: lateDue + 20 * MIN });
  assert.equal(again.missed, 0);
  assert.equal(again.delivered, 0);
  assert.equal(smtp.messages.length, beforeMissed);
  assert.equal(afterRestart.notifications.length, 1);
});