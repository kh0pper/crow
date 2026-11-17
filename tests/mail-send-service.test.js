// Crow Mail's send service (plan 3, Task 5): the ten-second hold, the one claim, the delivery and the
// settle. Every test builds the mail tables, the account send columns, the draft tables and the
// contacts table in a scratch DB, injects a clock, a fake adapter and a fake scheduler, and drives the
// real draft store and the real preflight.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } from "../servers/shared/mail-schema.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import { claimedElsewhereSentence } from "../servers/gateway/mail/claims.js";
import { createAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
import {
  addRevision, createDraft, discardDraft, getDraft, transition,
} from "../servers/gateway/mail/drafts/store.js";
import {
  ALREADY_WENT_OUT_SENTENCE, CHANGED_SENTENCE, GRACE_MS, HOLD_MS, KEYCHAIN_KEY_MISSING_SENTENCE,
  RECONCILE_WINDOW_MS, SEND_FAIL_REASONS, STALE_SENDING_MS, UNKNOWN_STATE_SENTENCE,
  _resetInFlightForTests, deliver, inFlight, isStaleSending, reconcileUnknown, requestSend, settle,
  undoSend,
} from "../servers/gateway/mail/send/send-service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEND_SOURCE = readFileSync(join(HERE, "..", "servers/gateway/mail/send/send-service.js"), "utf8");
const SEAL_SOURCE = readFileSync(join(HERE, "..", "servers/gateway/mail/drafts/seal.js"), "utf8");

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const JO = "jo@example.com";
const HIDDEN = "hidden@example.com";
const HOST = "mail.example.test";
const T0 = 1_700_000_000_000;
const SEED = Buffer.alloc(32, 11);
/** The instant a hold taken at T0 falls due. */
const DUE = T0 + HOLD_MS;

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { _resetInFlightForTests(); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-send-service-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crow_id TEXT NOT NULL UNIQUE,
      display_name TEXT,
      ed25519_pubkey TEXT NOT NULL,
      secp256k1_pubkey TEXT NOT NULL,
      email TEXT
    );
  `);
  return db;
}

async function makeAccount(db, overrides = {}) {
  const account = await createAccount(db, {
    label: "Alex",
    address: ALEX,
    imap: { host: HOST, port: 993, security: "ssl" },
    smtp: { host: HOST, port: 465, security: "ssl" },
    ...overrides,
  });
  return updateAccount(db, account.id, {
    displayName: "Alex",
    ...(overrides.sentCopy ? { sentCopy: overrides.sentCopy } : {}),
  });
}

function revInput(overrides = {}) {
  return {
    to: [{ address: SAM }],
    cc: [],
    bcc: [],
    subject: "Re: Tuesday",
    body: "Hello Sam,\n\nTuesday works for me.\n",
    inReplyTo: "<m1@mail.example.test>",
    references: [],
    attachments: [],
    ...overrides,
  };
}

async function makeDraft(db, account, overrides = {}) {
  return createDraft(db, {
    accountId: account.id,
    mode: "reply",
    replyToMid: null,
    threadKey: "thread-1",
    chatThreadId: "chat-1",
    first: revInput(overrides.first),
    author: "bot",
  }, { now: () => T0 });
}

/** A fake adapter: `send` records the message, `handle` decides what one call answers or throws. */
function makeFake() {
  const sent = [];
  const appended = [];
  let handler = null;
  const adapter = {
    async send(message) {
      sent.push(message);
      if (handler) return handler(message);
      return {
        messageId: message.messageId ?? "<fake@mail.example.test>",
        accepted: message.to.map((entry) => entry.address),
        rejected: [],
      };
    },
    async appendToSent(raw) {
      appended.push(Buffer.from(raw));
      return { folderPath: "Sent", uid: appended.length };
    },
  };
  return { adapter, sent, appended, handle(fn) { handler = fn; } };
}

function makeDeps(fake, overrides = {}) {
  let ids = 0;
  const timers = [];
  const syncs = [];
  const deps = {
    withAdapter: (accountId, fn) => fn(fake.adapter),
    isClaimedElsewhere: async () => ({ claimed: false, instanceName: null }),
    requestSync: async (accountId) => { syncs.push(accountId); },
    loadKey: () => SEED,
    readMessageRaw: null,
    readStorageFile: null,
    now: () => T0,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    newId: () => `id-${++ids}`,
    ...overrides,
  };
  return { deps, timers, syncs };
}

async function rawRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM mail_drafts WHERE id = ?", args: [id] });
  return rows[0];
}

async function tap(db, deps, draft, at = T0) {
  const out = await requestSend(db, deps, { draftId: draft.id, hash: draft.headHash, now: at });
  assert.equal(out.ok, true);
  return out;
}

async function waitFor(check, tries = 500) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the condition never held");
}

/** One draft made unknown by a NETWORK failure after the claim, and the instant of that attempt. */
async function unknownDraft(db, deps, fake, account) {
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);
  fake.handle(() => { throw new MailError("NETWORK", "ECONNRESET"); });
  const out = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(out.outcome, "unknown");
  return draft;
}

/* ------------------------------------------------------------------ the constants */

test("the hold, the grace window and the stale cutoff are the plan's", () => {
  assert.equal(HOLD_MS, 10_000);
  assert.equal(GRACE_MS, 10 * 60 * 1000);
  assert.equal(STALE_SENDING_MS, 10 * 60 * 1000);
  assert.equal(RECONCILE_WINDOW_MS, 24 * 60 * 60 * 1000);
  for (const sentence of [KEYCHAIN_KEY_MISSING_SENTENCE, UNKNOWN_STATE_SENTENCE, ALREADY_WENT_OUT_SENTENCE, CHANGED_SENTENCE]) {
    assert.equal(typeof sentence, "string");
    assert.ok(sentence.length > 0);
  }
  assert.equal(ALREADY_WENT_OUT_SENTENCE, "It already went out.");
  assert.equal(CHANGED_SENTENCE, "The draft just changed. Check it and press Send again.");
  assert.equal(
    UNKNOWN_STATE_SENTENCE,
    "We could not confirm this went out. Check your Sent folder, then press Send again only if it is not there.",
  );
  assert.equal(
    KEYCHAIN_KEY_MISSING_SENTENCE,
    "This Crow is missing its key file, so mail cannot be sent. Restore the key file or sign in to the account again.",
  );
  // Every reason is a short technical phrase and nothing else.
  for (const [key, phrase] of Object.entries(SEND_FAIL_REASONS)) {
    assert.match(key, /^[a-z][a-z0-9_]*$/, key);
    assert.equal(typeof phrase, "string");
    assert.ok(phrase.length > 0 && phrase.length <= 200, key);
    assert.equal(phrase.includes("@"), false, `${key} carries no address`);
  }
});

test("no module sets holding or scheduled except through transition called from requestSend", () => {
  for (const source of [SEND_SOURCE, SEAL_SOURCE]) {
    assert.equal(/INSERT\s+INTO\s+mail_drafts/i.test(source), false, "no row is created here");
    assert.equal(/UPDATE\s+mail_drafts[\s\S]{0,400}?state\s*=\s*'(?:holding|scheduled)'/i.test(source), false,
      "no direct write of a tap state");
  }
  // The one way into holding is a transition, and only requestSend calls it that way.
  assert.equal((SEND_SOURCE.match(/, "holding",/g) ?? []).length, 1);
  assert.equal((SEND_SOURCE.match(/, "scheduled",/g) ?? []).length, 0);
  assert.ok(SEND_SOURCE.includes("expectHash: hash"), "the tap's transition carries the hash guard");
});

/* --------------------------------------------------------------------- the tap */

test("send with a stale hash is refused changed and the adapter is never called", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, timers } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const stale = draft.headHash;
  // The bot writes another revision between the card and the tap.
  const second = await addRevision(db, draft.id, revInput({ body: "Hello Sam,\n\nWednesday works.\n" }), {
    author: "bot", expectHash: stale, now: () => T0 + 1000,
  });
  assert.ok(second.hash);

  const out = await requestSend(db, deps, { draftId: draft.id, hash: stale, now: T0 + 2000 });
  assert.deepEqual(out, { ok: false, code: "changed" });
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "draft");
  assert.equal(row.tapSeal, null);
  assert.equal(row.headHash, second.hash);
  assert.equal(fake.sent.length, 0);
  assert.equal(timers.length, 0);
});

test("undo within the hold returns the draft to draft and nothing is sent", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, timers } = makeDeps(fake);
  const draft = await makeDraft(db, account);

  const out = await tap(db, deps, draft);
  assert.equal(out.holdUntil, DUE);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, HOLD_MS);
  assert.equal((await getDraft(db, draft.id)).state, "holding");

  assert.deepEqual(await undoSend(db, deps, { draftId: draft.id, now: T0 + 1000 }), { ok: true });
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "draft");
  assert.equal(row.tapSeal, null);
  assert.equal(row.tapId, null);
  assert.equal(row.tapAction, null);
  assert.equal(row.attachDigest, null);

  const late = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(late.outcome, "lost_claim");
  assert.equal(fake.sent.length, 0);
});

test("undo racing the claim: exactly one of undo and deliver wins", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);

  // The undo lands first: the claim has nothing to take.
  const undone = await makeDraft(db, account);
  await tap(db, deps, undone);
  assert.deepEqual(await undoSend(db, deps, { draftId: undone.id, now: DUE }), { ok: true });
  const lost = await deliver(db, deps, undone.id, { now: DUE });
  assert.equal(lost.outcome, "lost_claim");
  assert.equal(fake.sent.length, 0);

  // The claim lands first: an undo that arrives during the adapter call is too late.
  const claimed = await makeDraft(db, account);
  await tap(db, deps, claimed);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.handle(async (message) => {
    await gate;
    return { messageId: message.messageId, accepted: message.to.map((entry) => entry.address), rejected: [] };
  });
  const pending = deliver(db, deps, claimed.id, { now: DUE });
  await waitFor(() => fake.sent.length === 1);

  const tooLate = await undoSend(db, deps, { draftId: claimed.id, now: DUE });
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.state, "sending");
  assert.equal(tooLate.sentence, ALREADY_WENT_OUT_SENTENCE);

  release();
  const done = await pending;
  assert.equal(done.outcome, "sent");
  assert.equal(fake.sent.length, 1);
  assert.equal((await getDraft(db, claimed.id)).state, "sent");
});

test("deliver claims before the adapter call", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);

  let seen = null;
  fake.handle(async (message) => {
    seen = { row: await rawRow(db, draft.id), message };
    return { messageId: message.messageId, accepted: message.to.map((entry) => entry.address), rejected: [] };
  });
  await deliver(db, deps, draft.id, { now: DUE });

  assert.equal(seen.row.state, "sending");
  assert.ok(seen.row.message_id, "a message id is on the row before the send");
  assert.ok(Number(seen.row.attempt_at) > 0, "the attempt is stamped before the send");
  assert.ok(seen.row.claim_token);
  assert.equal(seen.row.tap_seal, null, "the seal is consumed by the claim");
  assert.equal(seen.message.messageId, seen.row.message_id);
});

test("the same Message-ID is passed to the adapter that was stored on the row", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);
  await deliver(db, deps, draft.id, { now: DUE });

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "sent");
  assert.match(row.messageId, /^<id-\d+@example\.com>$/);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].messageId, row.messageId);
});

test("confirmResend reuses the original Message-ID", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await unknownDraft(db, deps, fake, account);
  const original = (await getDraft(db, draft.id)).messageId;
  assert.ok(original);
  // One Sent-folder check has run: a late success would have been seen by now.
  await db.execute({ sql: "UPDATE mail_drafts SET reconcile_count = 1 WHERE id = ?", args: [draft.id] });

  const again = await requestSend(db, deps, {
    draftId: draft.id, hash: draft.headHash, now: DUE + 60_000, confirmUnknown: true,
  });
  assert.equal(again.ok, true);
  fake.handle(null);
  const out = await deliver(db, deps, draft.id, { now: DUE + 60_000 + HOLD_MS });
  assert.equal(out.outcome, "sent");
  assert.equal(fake.sent[0].messageId, original);
});

/* --------------------------------------------------------------------- the replay */

test("cancel then a direct UPDATE back to scheduled never sends", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);
  assert.deepEqual(await undoSend(db, deps, { draftId: draft.id, now: T0 + 1000 }), { ok: true });
  await db.execute({
    sql: "UPDATE mail_drafts SET state = 'scheduled', due_at = ? WHERE id = ?",
    args: [DUE, draft.id],
  });

  const out = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "seal");
  assert.equal(fake.sent.length, 0);
});

test("a sent row set back to holding never sends", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);
  await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(fake.sent.length, 1);
  // Every exit from a tap state nulls the seal, so there is nothing for a revival to ride on.
  await db.execute({
    sql: "UPDATE mail_drafts SET state = 'holding', hold_until = ? WHERE id = ?",
    args: [DUE + 60_000, draft.id],
  });

  const out = await deliver(db, deps, draft.id, { now: DUE + 60_000 });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "seal");
  assert.equal(fake.sent.length, 1);
  assert.equal((await getDraft(db, draft.id)).state, "failed");
});

test("a discarded row set to scheduled never sends", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const discarded = await discardDraft(db, draft.id, { now: () => T0 + 1000 });
  assert.deepEqual(discarded, { ok: true });
  await db.execute({
    sql: "UPDATE mail_drafts SET state = 'scheduled', due_at = ? WHERE id = ?",
    args: [DUE, draft.id],
  });

  const out = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "seal");
  assert.equal(fake.sent.length, 0);
});

/* --------------------------------------------------------------------- the account */

test("an account whose address changed after the draft was made is refused bad_input at preflight", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await db.execute({ sql: "UPDATE mail_accounts SET address = ? WHERE id = ?", args: ["alex2@example.com", account.id] });

  const out = await requestSend(db, deps, { draftId: draft.id, hash: draft.headHash, now: T0 });
  assert.equal(out.ok, false);
  assert.equal(out.code, "preflight");
  assert.equal(out.preflight.code, "bad_input");
  assert.equal((await getDraft(db, draft.id)).state, "draft");
  assert.equal(fake.sent.length, 0);
});

test("no keychain key gives the keychain_key_missing reason and the fixed sentence on the card", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake, { loadKey: () => null });
  const draft = await makeDraft(db, account);

  const out = await requestSend(db, deps, { draftId: draft.id, hash: draft.headHash, now: T0 });
  assert.equal(out.ok, false);
  assert.equal(out.code, "not_sendable");
  assert.equal(out.reason, "keychain_key_missing");
  assert.equal(out.sentence, KEYCHAIN_KEY_MISSING_SENTENCE);
  assert.equal((await getDraft(db, draft.id)).state, "draft");
  assert.equal(fake.sent.length, 0);
  // The table carries the same reason for the row's fail_reason.
  assert.equal(typeof SEND_FAIL_REASONS.keychain_key_missing, "string");
});

/* ------------------------------------------------------------------ attachments */

test("an attachment whose bytes changed between tap and deliver fails attachment_changed", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  let bytes = Buffer.from("the first attachment bytes");
  const { deps } = makeDeps(fake, { readStorageFile: async (fileId) => (fileId === "file-1" ? bytes : null) });
  const draft = await makeDraft(db, account, {
    first: {
      attachments: [{ source: "storage", fileId: "file-1", filename: "notes.txt", size: bytes.length }],
    },
  });
  await tap(db, deps, draft);

  bytes = Buffer.from("the second, different attachment bytes");
  const out = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "attachment_changed");
  const row = await getDraft(db, draft.id);
  assert.equal(row.failReason, SEND_FAIL_REASONS.attachment_changed);
  assert.equal(row.tapSeal, null);
  assert.equal(fake.sent.length, 0);
});

/* ------------------------------------------------------------- the delivery outcome */

test("NETWORK after the adapter call began leaves state unknown and never calls send twice", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await unknownDraft(db, deps, fake, account);

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "unknown");
  assert.equal(row.failReason, SEND_FAIL_REASONS.network);
  assert.equal(row.reconcileCount, 0);
  assert.equal(row.nextReconcileAt, row.attemptAt + 60_000);
  assert.equal(fake.sent.length, 1);

  const again = await deliver(db, deps, draft.id, { now: DUE + 60_000 });
  assert.equal(again.outcome, "lost_claim");
  assert.equal(fake.sent.length, 1);
});

test("AUTH_FAILED leaves state failed and Send is allowed again", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);
  fake.handle(() => { throw new MailError("AUTH_FAILED", "EAUTH"); });

  const out = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "auth_failed");
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "failed");
  assert.equal(row.failReason, SEND_FAIL_REASONS.auth_failed);

  const again = await requestSend(db, deps, { draftId: draft.id, hash: row.headHash, now: DUE + 1000 });
  assert.equal(again.ok, true);
  assert.equal((await getDraft(db, draft.id)).state, "holding");
});

test("a slow send that outlives STALE_SENDING_MS in this process is never marked unknown by the sweep", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.handle(async (message) => {
    await gate;
    return { messageId: message.messageId, accepted: message.to.map((entry) => entry.address), rejected: [] };
  });
  const pending = deliver(db, deps, draft.id, { now: DUE });
  await waitFor(() => fake.sent.length === 1);

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "sending");
  assert.equal(isStaleSending(row, DUE + STALE_SENDING_MS + 60_000), false,
    "a row this process is still sending is never stale");

  release();
  assert.equal((await pending).outcome, "sent");
  assert.equal((await getDraft(db, draft.id)).state, "sent");
});

test("kill after claim leaves one row in unknown and resends nothing", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);

  // The process that claimed the row never answers: its adapter call never settles.
  const crashDeps = { ...deps, withAdapter: () => new Promise(() => {}) };
  void deliver(db, crashDeps, draft.id, { now: DUE });
  await waitFor(() => inFlight.has(draft.id));
  _resetInFlightForTests();

  await db.execute({
    sql: "UPDATE mail_drafts SET attempt_at = ? WHERE id = ?",
    args: [DUE - STALE_SENDING_MS - 1, draft.id],
  });
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "sending");
  assert.equal(isStaleSending(row, DUE), true);

  const moved = await transition(db, draft.id, ["sending"], "unknown",
    { fail_reason: SEND_FAIL_REASONS.network }, { now: DUE });
  assert.equal(moved, true);
  assert.equal((await getDraft(db, draft.id)).state, "unknown");

  const again = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(again.outcome, "lost_claim");
  assert.equal(fake.sent.length, 0, "nothing was resent");
});

test("a late success settles an unknown row to sent by claim_token; a wrong claim_token is ignored", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await unknownDraft(db, deps, fake, account);
  const row = await getDraft(db, draft.id);

  assert.equal(await settle(db, draft.id, "not-the-claim", "sent", { now: DUE + 1000, sentAt: DUE }), false);
  assert.equal((await getDraft(db, draft.id)).state, "unknown");

  assert.equal(await settle(db, draft.id, row.claimToken, "sent", { now: DUE + 2000, sentAt: DUE + 2000 }), true);
  const settled = await getDraft(db, draft.id);
  assert.equal(settled.state, "sent");
  assert.equal(settled.sentAt, DUE + 2000);
  assert.equal(settled.failReason, null);
});

test("rejected-all recipients is failed, partial rejection is sent with a note", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);

  const refused = await makeDraft(db, account);
  await tap(db, deps, refused);
  fake.handle(async (message) => ({ messageId: message.messageId, accepted: [], rejected: [SAM] }));
  const allRejected = await deliver(db, deps, refused.id, { now: DUE });
  assert.equal(allRejected.outcome, "failed");
  assert.equal(allRejected.reason, "all_rejected");
  assert.equal((await getDraft(db, refused.id)).failReason, SEND_FAIL_REASONS.all_rejected);

  const partial = await makeDraft(db, account);
  await tap(db, deps, partial);
  fake.handle(async (message) => ({ messageId: message.messageId, accepted: [SAM], rejected: [JO] }));
  const sent = await deliver(db, deps, partial.id, { now: DUE });
  assert.equal(sent.outcome, "sent");
  assert.deepEqual(sent.notes, [{ code: "rejected_recipients", count: 1 }]);
  assert.equal(JSON.stringify(sent).includes(JO), false, "the note carries no address");
  assert.equal((await getDraft(db, partial.id)).state, "sent");
});

/* ---------------------------------------------------------------- the Sent copy */

test("appendToSent failure does not change sent", async () => {
  const db = await freshDb();
  const account = await makeAccount(db, { sentCopy: "append" });
  const fake = makeFake();
  const { deps, syncs } = makeDeps(fake);
  fake.adapter.appendToSent = async () => { throw new MailError("NOT_FOUND", "sent"); };
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);

  const out = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(out.outcome, "sent");
  assert.equal((await getDraft(db, draft.id)).state, "sent");
  assert.deepEqual(syncs, [account.id], "the sync is asked for even when the copy failed");
});

test("sent_copy provider does not call appendToSent", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);
  const out = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(out.outcome, "sent");
  assert.equal(fake.appended.length, 0);
});

test("the Sent copy keeps Bcc", async () => {
  const db = await freshDb();
  const account = await makeAccount(db, { sentCopy: "append" });
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account, { first: { bcc: [{ address: HIDDEN }] } });
  await tap(db, deps, draft);
  const out = await deliver(db, deps, draft.id, { now: DUE });
  assert.equal(out.outcome, "sent");
  assert.equal(fake.appended.length, 1);
  const raw = fake.appended[0].toString("utf8");
  assert.match(raw, /^Bcc: /m, "the copy carries the blind recipient");
  assert.ok(raw.includes(HIDDEN));
});

/* ------------------------------------------------------------------ the reconcile */

test("reconcileUnknown backs off 1, 5, 15 minutes then hourly, stops after 24 hours, and settles sent when the Message-ID is in the synced Sent folder", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, syncs } = makeDeps(fake);
  const draft = await unknownDraft(db, deps, fake, account);
  const attemptAt = (await getDraft(db, draft.id)).attemptAt;
  assert.ok(attemptAt > 0);

  const early = await reconcileUnknown(db, deps, draft.id, { now: attemptAt + 60_000 - 1 });
  assert.equal(early.outcome, "not_due");

  const first = await reconcileUnknown(db, deps, draft.id, { now: attemptAt + 60_000 });
  assert.equal(first.outcome, "unknown");
  assert.equal(first.attempts, 1);
  assert.equal(first.nextReconcileAt, attemptAt + 5 * 60_000);

  const second = await reconcileUnknown(db, deps, draft.id, { now: attemptAt + 5 * 60_000 });
  assert.equal(second.attempts, 2);
  assert.equal(second.nextReconcileAt, attemptAt + 15 * 60_000);

  const third = await reconcileUnknown(db, deps, draft.id, { now: attemptAt + 15 * 60_000 });
  assert.equal(third.attempts, 3);
  assert.equal(third.nextReconcileAt, attemptAt + 60 * 60_000);

  const fourth = await reconcileUnknown(db, deps, draft.id, { now: attemptAt + 60 * 60_000 });
  assert.equal(fourth.attempts, 4);
  assert.equal(fourth.nextReconcileAt, attemptAt + 120 * 60_000);

  const stopped = await reconcileUnknown(db, deps, draft.id, { now: attemptAt + RECONCILE_WINDOW_MS + 1 });
  assert.equal(stopped.outcome, "stopped");
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "unknown");
  assert.equal(row.nextReconcileAt, null);
  assert.deepEqual(syncs, [account.id, account.id, account.id, account.id]);

  // The other ending: the Message-ID is in a Sent-role folder, so the row is settled sent. A message
  // sitting in Drafts proves nothing and must not settle it.
  const found = await unknownDraft(db, deps, fake, account);
  const waiting = await getDraft(db, found.id);
  const drafts = await db.execute({
    sql: `INSERT INTO mail_folders (account_id, path, name, special_use, delimiter) VALUES (?, ?, ?, ?, '/')`,
    args: [account.id, "Drafts", "Drafts", "\\Drafts"],
  });
  await db.execute({
    sql: `INSERT INTO mail_messages (account_id, folder_id, uid, message_id, subject, date)
          VALUES (?, ?, ?, ?, '', ?)`,
    args: [account.id, Number(drafts.lastInsertRowid), 1, waiting.messageId, DUE],
  });
  const notSent = await reconcileUnknown(db, deps, found.id, { now: waiting.nextReconcileAt });
  assert.equal(notSent.outcome, "unknown");
  assert.equal((await getDraft(db, found.id)).state, "unknown");

  const sentFolder = await db.execute({
    sql: `INSERT INTO mail_folders (account_id, path, name, special_use, delimiter) VALUES (?, ?, ?, ?, '/')`,
    args: [account.id, "Sent", "Sent", "\\Sent"],
  });
  await db.execute({
    sql: `INSERT INTO mail_messages (account_id, folder_id, uid, message_id, subject, date)
          VALUES (?, ?, ?, ?, '', ?)`,
    args: [account.id, Number(sentFolder.lastInsertRowid), 1, waiting.messageId, DUE],
  });
  const settled = await reconcileUnknown(db, deps, found.id, { now: notSent.nextReconcileAt });
  assert.equal(settled.outcome, "sent");
  const done = await getDraft(db, found.id);
  assert.equal(done.state, "sent");
  assert.equal(done.messageId, waiting.messageId);
});

/* ---------------------------------------------------------------- the confirm gate */

test("requestSend from unknown without confirmUnknown gives confirm_needed", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await unknownDraft(db, deps, fake, account);
  await db.execute({ sql: "UPDATE mail_drafts SET reconcile_count = 1 WHERE id = ?", args: [draft.id] });

  const out = await requestSend(db, deps, { draftId: draft.id, hash: draft.headHash, now: DUE + 1000 });
  assert.equal(out.ok, false);
  assert.equal(out.code, "confirm_needed");
  assert.equal(out.reason, "confirm_unknown");
  assert.equal((await getDraft(db, draft.id)).state, "unknown");
});

test("confirmUnknown before the first reconcile gives confirm_needed", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await unknownDraft(db, deps, fake, account);

  const out = await requestSend(db, deps, {
    draftId: draft.id, hash: draft.headHash, now: DUE + 1000, confirmUnknown: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "confirm_needed");
  assert.equal(out.reason, "reconcile_first");
  assert.equal((await getDraft(db, draft.id)).state, "unknown");
  assert.equal(fake.sent.length, 1, "no adapter call was made by the refusal");
});

test("confirmUnknown after one reconcile is accepted", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await unknownDraft(db, deps, fake, account);
  const row = await getDraft(db, draft.id);
  await reconcileUnknown(db, deps, draft.id, { now: row.nextReconcileAt });

  const out = await requestSend(db, deps, {
    draftId: draft.id, hash: draft.headHash, now: row.nextReconcileAt, confirmUnknown: true,
  });
  assert.equal(out.ok, true);
  const again = await getDraft(db, draft.id);
  assert.equal(again.state, "holding");
  assert.equal(again.messageId, row.messageId, "the original message id is kept");
});

/* ------------------------------------------------------------------- the claim */

test("deliver on a draft whose account is claimed elsewhere fails with the fixed sentence", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake, {
    isClaimedElsewhere: async () => ({ claimed: true, instanceName: "Second Crow" }),
  });
  const draft = await makeDraft(db, account);

  const out = await requestSend(db, deps, { draftId: draft.id, hash: draft.headHash, now: T0 });
  assert.equal(out.ok, false);
  assert.equal(out.code, "claimed_elsewhere");
  assert.equal(out.sentence, claimedElsewhereSentence("Second Crow"));
  assert.equal((await getDraft(db, draft.id)).state, "draft");
  assert.equal(fake.sent.length, 0);

  // And the delivery side: the borrowed connection refuses the account, nothing is sent.
  const { deps: openDeps } = makeDeps(fake);
  await tap(db, openDeps, draft);
  const { deps: claimedDeps } = makeDeps(fake, {
    withAdapter: () => Promise.reject(new MailError("CLAIMED_ELSEWHERE", null)),
  });
  const failed = await deliver(db, claimedDeps, draft.id, { now: DUE });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.reason, "claimed_elsewhere");
  assert.equal((await getDraft(db, draft.id)).failReason, SEND_FAIL_REASONS.claimed_elsewhere);
  assert.equal(fake.sent.length, 0);
});

/* --------------------------------------------------------------------- the log */

test("no error text from the adapter reaches fail_reason or the log", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);

  const secret = "hunter2pa55word";
  const lines = [];
  const saved = { warn: console.warn, error: console.error, log: console.log };
  for (const name of Object.keys(saved)) {
    console[name] = (...args) => { lines.push(args.map(String).join(" ")); };
  }
  try {
    fake.handle(() => {
      const err = new Error(`550 rejected ${SAM} for user ${secret}`);
      err.code = "EUNLISTEDREPLY";
      err.response = `NO ${SAM} ${secret}`;
      throw err;
    });
    const out = await deliver(db, deps, draft.id, { now: DUE });
    assert.equal(out.outcome, "unknown");
    assert.equal(out.reason, "protocol");
  } finally {
    console.warn = saved.warn;
    console.error = saved.error;
    console.log = saved.log;
  }

  const row = await getDraft(db, draft.id);
  assert.equal(row.failReason, SEND_FAIL_REASONS.protocol);
  assert.equal(String(row.failReason).includes(secret), false);
  assert.equal(String(row.failReason).includes(SAM), false);
  const joined = lines.join("\n");
  assert.equal(joined.includes(secret), false, "the log carries no adapter text");
  assert.equal(joined.includes(SAM), false, "the log carries no address");
});