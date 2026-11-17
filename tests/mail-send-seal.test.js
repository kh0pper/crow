// Crow Mail's tap seal (plan 3, Task 5): the HMAC a tap writes, the length-prefixed fields it binds,
// and the row-level guards that keep a row which never carried a live tap from sending.
//
// Harness: the draft store's (a scratch DB built from MAIL_DDL, the account send columns,
// MAIL_DRAFTS_DDL and the contacts table preflight reads), the real account and draft stores, an
// injected clock that never advances on its own, a fake adapter built here and a fake `schedule` that
// records the ten-second timer instead of running it.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } from "../servers/shared/mail-schema.js";
import { createAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
import { createDraft, getDraft, listRevisions, revisionToInput, hashOf } from "../servers/gateway/mail/drafts/store.js";
import {
  TAP_SEAL_DOMAIN, newTapId, sealFor, verifySeal,
} from "../servers/gateway/mail/drafts/seal.js";
import {
  GRACE_MS, HOLD_MS, SEND_FAIL_REASONS, _resetInFlightForTests, deliver, requestSend, undoSend,
} from "../servers/gateway/mail/send/send-service.js";

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const HOST = "mail.example.test";
const T0 = 1_700_000_000_000;
const SEED = Buffer.alloc(32, 9);

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { _resetInFlightForTests(); });

/** The mail tables, the account send columns, the draft tables and the contacts table init-db builds. */
async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-send-seal-"));
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
  return updateAccount(db, account.id, { displayName: "Alex" });
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

/** A fake adapter: it records what it was handed and answers (or throws) through `handle`. */
function makeFake() {
  const sent = [];
  const appended = [];
  let handler = async (message) => ({
    messageId: message.messageId ?? "<fake@mail.example.test>",
    accepted: message.to.map((entry) => entry.address),
    rejected: [],
  });
  const adapter = {
    async send(message) {
      sent.push(message);
      return handler(message);
    },
    async appendToSent(raw) {
      appended.push(Buffer.from(raw));
      return { folderPath: "Sent", uid: appended.length };
    },
  };
  return { adapter, sent, appended, handle(fn) { handler = fn; } };
}

/** The injected dependencies: no real mail, no real timer, a clock that only moves when a test says. */
function makeDeps(fake, overrides = {}) {
  let ids = 0;
  const timers = [];
  return {
    timers,
    deps: {
      withAdapter: (accountId, fn) => fn(fake.adapter),
      isClaimedElsewhere: async () => ({ claimed: false, instanceName: null }),
      requestSync: async () => {},
      loadKey: () => SEED,
      readMessageRaw: null,
      readStorageFile: null,
      now: () => T0,
      schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      newId: () => `id-${++ids}`,
      ...overrides,
    },
  };
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

/* ------------------------------------------------------------------ the seal itself */

function payload(overrides = {}) {
  return {
    draftId: "md-1111",
    headHash: "hash-1",
    action: "send",
    when: T0 + HOLD_MS,
    attachDigest: "digest-1",
    accountId: "acct-1",
    fromAddress: ALEX,
    tapId: "0f".repeat(16),
    ...overrides,
  };
}

test("the seal covers the draft, the hash, the action, the time, the account, the from, the digest and the tap", () => {
  assert.equal(TAP_SEAL_DOMAIN, "crow-mail-tap-seal-v1");
  const seal = sealFor(payload(), SEED);
  assert.match(seal, /^[0-9a-f]{64}$/);
  assert.equal(verifySeal(payload(), seal, SEED), true);

  const other = {
    draftId: "md-2222",
    headHash: "hash-2",
    action: "schedule",
    when: T0 + HOLD_MS + 1,
    attachDigest: "digest-2",
    accountId: "acct-2",
    fromAddress: SAM,
    tapId: newTapId(),
  };
  for (const [key, value] of Object.entries(other)) {
    assert.equal(verifySeal(payload({ [key]: value }), seal, SEED), false, `a changed ${key} does not verify`);
  }
  // A different keychain seed is a different Crow.
  assert.equal(verifySeal(payload(), seal, Buffer.alloc(32, 10)), false);
});

test("the fields are length-prefixed, so two spellings cannot hash alike", () => {
  const long = sealFor(payload({ draftId: "ab", headHash: "c" }), SEED);
  const short = sealFor(payload({ draftId: "a", headHash: "bc" }), SEED);
  assert.notEqual(long, short);
  // A missing field is refused rather than sealed as an empty one.
  assert.throws(() => sealFor(payload({ tapId: undefined }), SEED), { code: "BAD_INPUT" });
  assert.throws(() => sealFor(payload(), null), { code: "BAD_INPUT" });
});

test("a seal for one tap does not verify for another tap of the same content and time", () => {
  const first = payload({ tapId: newTapId() });
  const second = payload({ tapId: newTapId() });
  assert.notEqual(first.tapId, second.tapId);
  assert.equal(first.tapId.length, 32);
  const seal = sealFor(first, SEED);
  assert.equal(verifySeal(first, seal, SEED), true);
  assert.equal(verifySeal(second, seal, SEED), false);
});

test("verifySeal refuses a seal of the wrong length or one changed character", () => {
  const seal = sealFor(payload(), SEED);
  assert.equal(verifySeal(payload(), seal.slice(0, 62), SEED), false);
  assert.equal(verifySeal(payload(), `${seal}00`, SEED), false);
  assert.equal(verifySeal(payload(), `${seal[0] === "0" ? "1" : "0"}${seal.slice(1)}`, SEED), false);
  assert.equal(verifySeal(payload(), "", SEED), false);
  assert.equal(verifySeal(payload(), null, SEED), false);
  // One seal has one spelling: a stored seal must be 64 lower-case hex characters before anything is
  // compared, so an upper-case copy of a real seal is not a seal.
  const upperCase = seal.replace(/[a-f]/g, (character) => character.toUpperCase());
  assert.notEqual(upperCase, seal);
  assert.equal(verifySeal(payload(), upperCase, SEED), false);
  assert.equal(verifySeal(payload(), ` ${seal.slice(1)}`, SEED), false);
  assert.equal(verifySeal(payload(), `${seal.slice(0, 63)}g`, SEED), false);
});

/* -------------------------------------------------------------------- the row's seal */

test("a row with no seal, or a seal for another hash, fails with reason seal and the adapter is never called", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);

  // No seal at all: a writer that moved the row into holding by hand.
  const bare = await makeDraft(db, account);
  await tap(db, deps, bare);
  await db.execute({
    sql: `UPDATE mail_drafts SET tap_seal = NULL, tap_id = NULL, tap_action = NULL, attach_digest = NULL
           WHERE id = ?`,
    args: [bare.id],
  });
  const noSeal = await deliver(db, deps, bare.id, { now: T0 + HOLD_MS });
  assert.equal(noSeal.outcome, "failed");
  assert.equal(noSeal.reason, "seal");
  assert.equal((await getDraft(db, bare.id)).failReason, SEND_FAIL_REASONS.seal);

  // A seal that was made for another head hash (the column moved under it).
  const moved = await makeDraft(db, account);
  await tap(db, deps, moved);
  await db.execute({
    sql: "UPDATE mail_drafts SET head_hash = ? WHERE id = ?",
    args: ["0123456789abcdef".repeat(4), moved.id],
  });
  const otherHash = await deliver(db, deps, moved.id, { now: T0 + HOLD_MS });
  assert.equal(otherHash.outcome, "failed");
  assert.equal(otherHash.reason, "seal");

  assert.equal(fake.sent.length, 0);
});

test("a row written by a direct UPDATE to holding does not send", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await db.execute({
    sql: "UPDATE mail_drafts SET state = 'holding', hold_until = ?, updated_at = ? WHERE id = ?",
    args: [T0 + HOLD_MS, T0, draft.id],
  });

  const out = await deliver(db, deps, draft.id, { now: T0 + HOLD_MS });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "seal");
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "failed");
  assert.equal(row.tapSeal, null);
  assert.equal(fake.sent.length, 0);
});

test("a direct UPDATE of the revision body under a valid seal fails with reason seal", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);
  await db.execute({
    sql: "UPDATE mail_draft_revisions SET body = ? WHERE draft_id = ? AND rev = ?",
    args: ["Hello Sam,\n\nSomething else entirely.\n", draft.id, draft.headRev],
  });

  const out = await deliver(db, deps, draft.id, { now: T0 + HOLD_MS });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "seal");
  assert.equal((await getDraft(db, draft.id)).failReason, SEND_FAIL_REASONS.seal);
  assert.equal(fake.sent.length, 0);
});

test("changing account_id on a holding row to an account that is not here fails with account_removed", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);
  await db.execute({
    sql: "UPDATE mail_drafts SET account_id = ? WHERE id = ?",
    args: ["acct-other", draft.id],
  });

  // The row names a mailbox this Crow does not have, so there is no From to send from at all; the
  // swap to another real account is the seal's own case (see the two-account test below).
  const out = await deliver(db, deps, draft.id, { now: T0 + HOLD_MS });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "account_removed");
  assert.equal(fake.sent.length, 0);
});

test("a seal copied from one tap does not verify for a later tap of the same content and time", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);

  await tap(db, deps, draft);
  const first = await rawRow(db, draft.id);
  assert.deepEqual(await undoSend(db, deps, { draftId: draft.id, now: T0 + 1000 }), { ok: true });

  // The same content, tapped again at the same instant: the same hold time, a different tap.
  await tap(db, deps, draft);
  const second = await rawRow(db, draft.id);
  assert.notEqual(first.tap_id, second.tap_id);
  assert.notEqual(first.tap_seal, second.tap_seal);
  assert.equal(first.hold_until, second.hold_until);

  // The first tap's seal, under the second tap's id.
  await db.execute({
    sql: "UPDATE mail_drafts SET tap_seal = ? WHERE id = ?",
    args: [first.tap_seal, draft.id],
  });
  const out = await deliver(db, deps, draft.id, { now: T0 + HOLD_MS });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "seal");
  assert.equal(fake.sent.length, 0);
});

test("deliver leaves a hold time in the future alone and marks one older than the grace window missed", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);

  // A hold that is still running is not a refusal: the seal is good, the row is simply not due yet.
  const early = await makeDraft(db, account);
  await tap(db, deps, early);
  const tooSoon = await deliver(db, deps, early.id, { now: T0 + HOLD_MS - 1 });
  assert.equal(tooSoon.outcome, "not_due");
  assert.equal(tooSoon.retryInMs, 1, "the answer says how long the hold has left");
  const held = await getDraft(db, early.id);
  assert.equal(held.state, "holding", "nothing is written for a hold that is still running");
  assert.ok(held.tapSeal, "the tap is still the live one");
  assert.equal(held.failReason, null);

  const late = await makeDraft(db, account);
  await tap(db, deps, late);
  const pastGrace = await deliver(db, deps, late.id, { now: T0 + HOLD_MS + GRACE_MS + 1 });
  assert.equal(pastGrace.outcome, "missed");
  assert.equal(pastGrace.reason, "missed");
  const row = await getDraft(db, late.id);
  assert.equal(row.state, "missed");
  assert.equal(row.failReason, SEND_FAIL_REASONS.missed);
  assert.equal(row.tapSeal, null);

  assert.equal(fake.sent.length, 0);
});

test("two real accounts: swapping account_id on a holding row is refused by the seal alone", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const other = await makeAccount(db, { label: "Second", address: "alex@second.example.com" });
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await tap(db, deps, draft);

  // The head hash is the revision row's own hash, so it passes whichever account the row names: only
  // the account in the seal can catch a row moved to another real mailbox.
  const [rev] = await listRevisions(db, draft.id);
  assert.equal(hashOf(revisionToInput(rev), { mode: draft.mode }), draft.headHash);
  await db.execute({ sql: "UPDATE mail_drafts SET account_id = ? WHERE id = ?", args: [other.id, draft.id] });

  const out = await deliver(db, deps, draft.id, { now: T0 + HOLD_MS });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "seal");
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "failed");
  assert.equal(row.failReason, SEND_FAIL_REASONS.seal);
  assert.equal(fake.sent.length, 0, "no adapter call for a mailbox the tap was not taken for");
});