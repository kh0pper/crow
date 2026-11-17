// Crow Mail's scheduling (plan 3, Task 6): the presets the sheet offers, the tap that freezes a draft
// until its due time, the scheduler tick that delivers held and scheduled sends, the missed ones, the
// interrupted ones and the ones whose account moved on.
//
// Every test builds the mail tables, the account send columns, the draft tables and the contacts table
// in a scratch DB, injects a clock, a zone, a fake adapter and a fake notification creator, and drives
// the real draft store and the real preflight. Nothing waits on real time.
import { test, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } from "../servers/shared/mail-schema.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import { claimedElsewhereSentence } from "../servers/gateway/mail/claims.js";
import { createAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
import { addRevision, createDraft, getDraft } from "../servers/gateway/mail/drafts/store.js";
import {
  GRACE_MS, SEND_FAIL_REASONS, _resetInFlightForTests, deliver, requestSend, settle,
} from "../servers/gateway/mail/send/send-service.js";
import {
  MISSED_TITLE, SCHEDULE_MAX_AHEAD_MS, SCHEDULE_MIN_LEAD_MS, _drainForTests,
  _resetSweepForTests, cancelSchedule, localTimeToInstant, missedNoticeText, parseRouteDueAt,
  scheduleDraft, schedulePresets, sweepMailSends,
} from "../servers/gateway/mail/send/schedule-service.js";
import { registerMailSendHook } from "../servers/gateway/mail/send/hook.js";
import { runSchedulerHooks, unregisterSchedulerHook } from "../servers/gateway/scheduler-hooks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SCHEDULE_SOURCE = readFileSync(join(REPO, "servers/gateway/mail/send/schedule-service.js"), "utf8");

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const HOST = "mail.example.test";
const T0 = 1_700_000_000_000;
const SEED = Buffer.alloc(32, 7);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CHICAGO = "America/Chicago";
const AUCKLAND = "Pacific/Auckland";

/** A Chicago 07:30 (CST, 2026-11-12) — the due time the missed-notice text names. */
const CHICAGO_0730 = Date.parse("2026-11-12T13:30:00Z");

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  _resetInFlightForTests();
  _resetSweepForTests();
});
afterEach(() => {
  unregisterSchedulerHook("mail-send");
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

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-schedule-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  await db.executeMultiple(SETTINGS_DDL);
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

async function setSetting(db, key, value) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = ?`,
    args: [key, value, value],
  });
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
  const notifications = [];
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
    zone: () => CHICAGO,
    createNotification: async (db, opts) => {
      notifications.push(opts);
      return { id: notifications.length };
    },
    ...overrides,
  };
  return { deps, timers, syncs, notifications };
}

/** Schedule one draft and insist it was taken. */
async function schedule(db, deps, draft, dueAt, now = T0) {
  const out = await scheduleDraft(db, deps, { draftId: draft.id, hash: draft.headHash, dueAt, now });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}

/** The wall clock in a zone at an instant, as compare-able text. */
function wall(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const hour = String(Number(parts.hour) % 24).padStart(2, "0");
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    weekday: parts.weekday,
  };
}

/** A source tree's .js files, path by path. */
function jsFiles(root) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...jsFiles(path));
    else if (name.endsWith(".js")) out.push(path);
  }
  return out;
}

/* ------------------------------------------------------------------- the presets */

test("tomorrow morning is 7:30 local and next work day skips the weekend", async () => {
  const db = await freshDb();

  // America/Chicago: Wednesday 12:00 CST -> tomorrow (Thursday) 7:30, next work day Thursday 8:00.
  const chicago = await schedulePresets(db, { now: Date.parse("2026-11-11T18:00:00Z"), zone: CHICAGO });
  assert.ok(chicago.tomorrowMorning instanceof Date);
  assert.deepEqual(wall(chicago.tomorrowMorning.getTime(), CHICAGO),
    { date: "2026-11-12", time: "07:30", weekday: "Thu" });
  assert.deepEqual(wall(chicago.nextWorkDay.getTime(), CHICAGO),
    { date: "2026-11-12", time: "08:00", weekday: "Thu" });

  // Friday noon: tomorrow morning is Saturday, the next work day is Monday.
  const weekend = await schedulePresets(db, { now: Date.parse("2026-11-13T18:00:00Z"), zone: CHICAGO });
  assert.deepEqual(wall(weekend.tomorrowMorning.getTime(), CHICAGO),
    { date: "2026-11-14", time: "07:30", weekday: "Sat" });
  assert.deepEqual(wall(weekend.nextWorkDay.getTime(), CHICAGO),
    { date: "2026-11-16", time: "08:00", weekday: "Mon" });

  // Pacific/Auckland: Thursday 07:00 NZDT -> 8:00 today is still ahead, tomorrow is Friday.
  const auckland = await schedulePresets(db, { now: Date.parse("2026-11-11T18:00:00Z"), zone: AUCKLAND });
  assert.deepEqual(wall(auckland.tomorrowMorning.getTime(), AUCKLAND),
    { date: "2026-11-13", time: "07:30", weekday: "Fri" });
  assert.deepEqual(wall(auckland.nextWorkDay.getTime(), AUCKLAND),
    { date: "2026-11-12", time: "08:00", weekday: "Thu" });

  // Auckland on a Friday midday: the next work day is Monday.
  const aucklandWeekend = await schedulePresets(db, { now: Date.parse("2026-11-12T23:00:00Z"), zone: AUCKLAND });
  assert.deepEqual(wall(aucklandWeekend.tomorrowMorning.getTime(), AUCKLAND),
    { date: "2026-11-14", time: "07:30", weekday: "Sat" });
  assert.deepEqual(wall(aucklandWeekend.nextWorkDay.getTime(), AUCKLAND),
    { date: "2026-11-16", time: "08:00", weekday: "Mon" });

  // Both presets are in the future, so neither can be refused as past.
  for (const preset of [chicago, weekend, auckland, aucklandWeekend]) {
    assert.ok(preset.tomorrowMorning.getTime() > Date.parse("2026-11-11T00:00:00Z"));
    assert.ok(preset.nextWorkDay.getTime() > Date.parse("2026-11-11T00:00:00Z"));
  }
});

test("a DST gap time moves to the first valid minute", () => {
  // 02:30 does not exist on the spring-forward morning: the clock jumps 02:00 -> 03:00.
  const chicago = localTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, CHICAGO);
  assert.deepEqual(wall(chicago, CHICAGO), { date: "2026-03-08", time: "03:00", weekday: "Sun" });

  const auckland = localTimeToInstant({ year: 2026, month: 9, day: 27, hour: 2, minute: 30 }, AUCKLAND);
  assert.deepEqual(wall(auckland, AUCKLAND), { date: "2026-09-27", time: "03:00", weekday: "Sun" });

  // A time that does exist is answered exactly, in both of the zone's offsets.
  const summer = localTimeToInstant({ year: 2026, month: 7, day: 1, hour: 7, minute: 30 }, CHICAGO);
  assert.deepEqual(wall(summer, CHICAGO), { date: "2026-07-01", time: "07:30", weekday: "Wed" });
  assert.equal(new Date(summer).toISOString(), "2026-07-01T12:30:00.000Z");
});

test("presets use instanceZone and not ownerZone", async () => {
  const db = await freshDb();
  // The instance runs in Auckland; a bundle-owned row (the News briefing) says Chicago.
  await setSetting(db, "instance_timezone", AUCKLAND);
  await setSetting(db, "media_briefing_config", JSON.stringify({ tz: CHICAGO }));

  const presets = await schedulePresets(db, { now: Date.parse("2026-11-11T18:00:00Z") });
  // Auckland: 07:00 local, so tomorrow morning is Thursday's 13th 07:30 NZDT.
  assert.deepEqual(wall(presets.tomorrowMorning.getTime(), AUCKLAND),
    { date: "2026-11-13", time: "07:30", weekday: "Fri" });
  // In Chicago's clock that instant is the 12th at 12:30 — the bundle's zone was not consulted.
  assert.deepEqual(wall(presets.tomorrowMorning.getTime(), CHICAGO),
    { date: "2026-11-12", time: "12:30", weekday: "Thu" });
});

/* ------------------------------------------------------------ the tap on schedule */

test("a stale hash is refused changed", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const stale = draft.headHash;

  // A missing or empty hash is never a permission: refused before anything is read or written.
  for (const hash of [undefined, "", null]) {
    const out = await scheduleDraft(db, deps, { draftId: draft.id, hash, dueAt: T0 + 5 * MIN, now: T0 });
    assert.deepEqual(out, { ok: false, code: "changed" }, String(hash));
  }
  assert.equal((await getDraft(db, draft.id)).state, "draft");

  // The bot writes another revision between the card and the tap.
  const second = await addRevision(db, draft.id, revInput({ body: "Hello Sam,\n\nWednesday works.\n" }), {
    author: "bot", expectHash: stale, now: () => T0 + 1000,
  });
  assert.ok(second.hash);

  const out = await scheduleDraft(db, deps, { draftId: draft.id, hash: stale, dueAt: T0 + 5 * MIN, now: T0 });
  assert.deepEqual(out, { ok: false, code: "changed" });
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "draft");
  assert.equal(row.tapSeal, null);
  assert.equal(row.headHash, second.hash);
  assert.equal(fake.sent.length, 0);

  // The hash the person is looking at is passed to the guarded UPDATE every time.
  assert.ok(SCHEDULE_SOURCE.includes("expectHash: hash"), "the schedule transition carries the hash guard");
  assert.equal(SCHEDULE_SOURCE.includes("expectHash: null"), false);
});

test("scheduling in the past or inside 60 s is refused past", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);

  for (const dueAt of [T0 - MIN, T0, T0 + 30_000, T0 + SCHEDULE_MIN_LEAD_MS - 1]) {
    const out = await scheduleDraft(db, deps, { draftId: draft.id, hash: draft.headHash, dueAt, now: T0 });
    assert.equal(out.ok, false, String(dueAt));
    assert.equal(out.code, "past");
  }
  // Exactly one minute ahead is the first time the sheet may offer.
  const edge = await scheduleDraft(db, deps, {
    draftId: draft.id, hash: draft.headHash, dueAt: T0 + SCHEDULE_MIN_LEAD_MS, now: T0,
  });
  assert.equal(edge.ok, true);
  assert.equal(edge.dueAt, T0 + SCHEDULE_MIN_LEAD_MS);
});

test("beyond 90 days is refused too_far", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);

  const tooFar = await scheduleDraft(db, deps, {
    draftId: draft.id, hash: draft.headHash, dueAt: T0 + SCHEDULE_MAX_AHEAD_MS + 1, now: T0,
  });
  assert.equal(tooFar.ok, false);
  assert.equal(tooFar.code, "too_far");

  const edge = await scheduleDraft(db, deps, {
    draftId: draft.id, hash: draft.headHash, dueAt: T0 + SCHEDULE_MAX_AHEAD_MS, now: T0,
  });
  assert.equal(edge.ok, true);
});

test("a dueAt whose offset does not match the instance zone is refused", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);

  // November in Chicago is -06:00, so -05:00 names an instant the sheet's zone never shows.
  const wrong = await scheduleDraft(db, deps, {
    draftId: draft.id, hash: draft.headHash, dueAt: "2026-11-12T07:30:00-05:00", now: CHICAGO_0730 - DAY,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "bad_input");

  // No offset at all is not a zone-qualified time.
  for (const dueAt of ["2026-11-12T07:30:00", "2026-11-12", "not a time", true]) {
    const out = await scheduleDraft(db, deps, {
      draftId: draft.id, hash: draft.headHash, dueAt, now: CHICAGO_0730 - DAY,
    });
    assert.equal(out.ok, false, String(dueAt));
    assert.equal(out.code, "bad_input", String(dueAt));
  }

  const right = await scheduleDraft(db, deps, {
    draftId: draft.id, hash: draft.headHash, dueAt: "2026-11-12T07:30:00-06:00", now: CHICAGO_0730 - DAY,
  });
  assert.equal(right.ok, true);
  assert.equal(right.dueAt, CHICAGO_0730, "the zone-qualified text is stored as epoch ms");
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "scheduled");
  assert.equal(row.dueAt, CHICAGO_0730);
});

test("a wall time a DST gap skips is refused bad_input at either offset", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const now = Date.parse("2026-03-08T00:00:00Z");

  // 02:30 does not exist on the spring-forward morning in Chicago: neither offset names an instant the
  // zone shows at that wall clock, so both are refused rather than reinterpreted.
  for (const dueAt of ["2026-03-08T02:30:00-06:00", "2026-03-08T02:30:00-05:00"]) {
    const out = await scheduleDraft(db, deps, { draftId: draft.id, hash: draft.headHash, dueAt, now });
    assert.equal(out.ok, false, dueAt);
    assert.equal(out.code, "bad_input", dueAt);
    const row = await getDraft(db, draft.id);
    assert.equal(row.state, "draft", "nothing was frozen");
    assert.equal(row.dueAt, null);
  }

  // The first minute of the skipped hour does exist at -05:00, so the refusal is the gap and not the day.
  const firstMinute = await scheduleDraft(db, deps, {
    draftId: draft.id, hash: draft.headHash, dueAt: "2026-03-08T03:00:00-05:00", now,
  });
  assert.equal(firstMinute.ok, true, JSON.stringify(firstMinute));
  assert.equal(firstMinute.dueAt, Date.parse("2026-03-08T08:00:00Z"));
  assert.deepEqual(wall(firstMinute.dueAt, CHICAGO), { date: "2026-03-08", time: "03:00", weekday: "Sun" });
});

test("the route parser takes zone-qualified text and refuses a number", () => {
  assert.equal(parseRouteDueAt("2026-11-12T07:30:00-06:00", { zone: CHICAGO }), CHICAGO_0730);

  // A numeric dueAt is the plan's internal form for trusted callers; a route body never supplies one.
  const refused = [CHICAGO_0730, 0, null, undefined, true, {}, [], "", "   ", "2026-11-12T07:30:00"];
  for (const value of refused) {
    assert.throws(() => parseRouteDueAt(value, { zone: CHICAGO }), (err) => {
      assert.ok(err instanceof MailError, String(value));
      assert.equal(err.code, "BAD_INPUT", String(value));
      return true;
    }, String(value));
  }
  // The offset check is the tap's own: an offset the zone does not have at that instant is refused.
  assert.throws(() => parseRouteDueAt("2026-11-12T07:30:00-05:00", { zone: CHICAGO }), MailError);
});

test("scheduling without a keychain key is refused not_sendable, and a doomed schedule is refused up front", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();

  const noKey = makeDeps(fake, { loadKey: () => null });
  const draft = await makeDraft(db, account);
  const out = await scheduleDraft(db, noKey.deps, {
    draftId: draft.id, hash: draft.headHash, dueAt: T0 + 5 * MIN, now: T0,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "not_sendable");
  assert.equal(out.reason, "keychain_key_missing");
  assert.equal((await getDraft(db, draft.id)).state, "draft");

  const elsewhere = makeDeps(fake, {
    isClaimedElsewhere: async () => ({ claimed: true, instanceName: "Second Crow" }),
  });
  const claimed = await scheduleDraft(db, elsewhere.deps, {
    draftId: draft.id, hash: draft.headHash, dueAt: T0 + 5 * MIN, now: T0,
  });
  assert.equal(claimed.ok, false);
  assert.equal(claimed.code, "claimed_elsewhere");
  assert.equal(claimed.sentence, claimedElsewhereSentence("Second Crow"));
  assert.equal((await getDraft(db, draft.id)).state, "draft");
  assert.equal(fake.sent.length, 0);
});

test("scheduling with no running mail connection is refused not_sendable/supervisor_missing, like a send", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { withAdapter, ...noConnection } = makeDeps(fake).deps;
  assert.equal(typeof withAdapter, "function");

  const draft = await makeDraft(db, account);
  const out = await scheduleDraft(db, noConnection, {
    draftId: draft.id, hash: draft.headHash, dueAt: T0 + 5 * MIN, now: T0,
  });
  assert.deepEqual(out, { ok: false, code: "not_sendable", reason: "supervisor_missing" });

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "draft", "nothing is frozen for a Crow that cannot send it");
  assert.equal(row.tapSeal, null);
  assert.equal(row.dueAt, null);
  assert.equal(fake.sent.length, 0);

  // The send tap answers in the same words, so one card shows one reason for one problem.
  const sent = await requestSend(db, noConnection, { draftId: draft.id, hash: draft.headHash, now: T0 });
  assert.deepEqual(sent, { ok: false, code: "not_sendable", reason: "supervisor_missing" });
  assert.equal((await getDraft(db, draft.id)).state, "draft");
});

test("cancelSchedule returns the draft to draft and clears the seal", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await schedule(db, deps, draft, T0 + 5 * MIN);

  assert.deepEqual(await cancelSchedule(db, { draftId: draft.id, now: T0 + MIN }), { ok: true });
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "draft");
  assert.equal(row.tapSeal, null);
  assert.equal(row.tapId, null);
  assert.equal(row.dueAt, null);

  const out = await sweepMailSends(db, deps, { now: T0 + 5 * MIN });
  assert.equal(out.delivered, 0);
  assert.equal(fake.sent.length, 0);
});

/* -------------------------------------------------------------------- the sweep */

test("a scheduled draft delivers on the first tick at or after due_at", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, deps, draft, dueAt);

  // A tick before the due time changes nothing.
  const early = await sweepMailSends(db, deps, { now: dueAt - MIN });
  assert.deepEqual({ delivered: early.delivered, missed: early.missed }, { delivered: 0, missed: 0 });
  assert.equal((await getDraft(db, draft.id)).state, "scheduled");
  assert.equal(fake.sent.length, 0);

  const tick = await sweepMailSends(db, deps, { now: dueAt });
  assert.equal(tick.delivered, 1, "the tick starts the delivery and returns");
  await _drainForTests();

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "sent");
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].text, "Hello Sam,\n\nTuesday works for me.");
});

test("two concurrent sweeps deliver once", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, deps, draft, dueAt);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.handle(async (message) => {
    await gate;
    return { messageId: message.messageId, accepted: message.to.map((entry) => entry.address), rejected: [] };
  });

  const [first, second] = await Promise.all([
    sweepMailSends(db, deps, { now: dueAt }),
    sweepMailSends(db, deps, { now: dueAt }),
  ]);
  assert.equal(first.delivered + second.delivered >= 1, true, "a sweep started the delivery");
  release();
  await _drainForTests();

  assert.equal(fake.sent.length, 1, "one claim, one SMTP call");
  assert.equal((await getDraft(db, draft.id)).state, "sent");
});

test("a restart between schedule and due still delivers", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const before = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, before.deps, draft, dueAt);

  // A new process: no in-flight delivery and no supervisor state of its own, the same DB.
  _resetInFlightForTests();
  _resetSweepForTests();
  const after_ = makeDeps(fake);
  const tick = await sweepMailSends(db, after_.deps, { now: dueAt + MIN });
  assert.equal(tick.delivered, 1);
  await _drainForTests();

  assert.equal((await getDraft(db, draft.id)).state, "sent");
  assert.equal(fake.sent.length, 1);
});

test("due 9 minutes ago (short restart) is delivered", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, deps, draft, dueAt);

  const tick = await sweepMailSends(db, deps, { now: dueAt + 9 * MIN });
  assert.equal(tick.delivered, 1);
  assert.equal(tick.missed, 0, "inside the grace window a late send still goes out");
  await _drainForTests();
  assert.equal((await getDraft(db, draft.id)).state, "sent");
  assert.equal(fake.sent.length, 1);
});

test("due 11 minutes ago is missed, not sent, one bell notification with source mail, none on the next sweep", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, notifications } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await schedule(db, deps, draft, CHICAGO_0730, CHICAGO_0730 - DAY);

  const tick = await sweepMailSends(db, deps, { now: CHICAGO_0730 + 11 * MIN });
  assert.equal(tick.missed, 1);
  assert.equal(tick.delivered, 0);
  await _drainForTests();

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "missed", "a missed send never goes out by itself");
  assert.equal(row.failReason, SEND_FAIL_REASONS.missed);
  assert.equal(row.notifiedAt, CHICAGO_0730 + 11 * MIN);
  assert.equal(fake.sent.length, 0);

  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    title: MISSED_TITLE,
    body: "A message was due at 7:30 and did not go out. Open Crow Mail to send now, pick a new time, or cancel.",
    type: "attention",
    source: "mail",
    priority: "normal",
  });
  assert.equal(MISSED_TITLE, "Crow Mail");
  assert.equal(missedNoticeText(CHICAGO_0730, CHICAGO),
    "A message was due at 7:30 and did not go out. Open Crow Mail to send now, pick a new time, or cancel.");
  assert.ok(GRACE_MS === 10 * MIN);

  // The next tick finds a terminal row: no second bell, no send.
  const again = await sweepMailSends(db, deps, { now: CHICAGO_0730 + 20 * MIN });
  assert.equal(again.missed, 0);
  assert.equal(again.delivered, 0);
  assert.equal(notifications.length, 1);
  assert.equal(fake.sent.length, 0);
});

test("a filtered notification type (createNotification returns null) still ends the row missed, leaves notified_at null and does not throw", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake, { createNotification: async () => null });
  const draft = await makeDraft(db, account);
  await schedule(db, deps, draft, T0 + 5 * MIN);

  const tick = await sweepMailSends(db, deps, { now: T0 + 20 * MIN });
  assert.equal(tick.missed, 1);
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "missed");
  assert.equal(row.notifiedAt, null, "nothing was delivered, so nothing is claimed to have been");
  assert.equal(fake.sent.length, 0);
});

test("a missed draft can be sent only through a fresh requestSend with the current hash", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await schedule(db, deps, draft, T0 + 5 * MIN);
  await sweepMailSends(db, deps, { now: T0 + 20 * MIN });
  assert.equal((await getDraft(db, draft.id)).state, "missed");

  // The sweep never resends a missed row, however many ticks pass.
  const later = await sweepMailSends(db, deps, { now: T0 + 60 * MIN });
  assert.equal(later.delivered, 0);
  assert.equal(fake.sent.length, 0);

  // A fresh tap with the hash the card is showing is the only way out.
  const fresh = await getDraft(db, draft.id);
  const staleHash = await requestSend(db, deps, { draftId: draft.id, hash: "not-the-head", now: T0 + 61 * MIN });
  assert.deepEqual(staleHash, { ok: false, code: "changed" });

  const tapped = await requestSend(db, deps, { draftId: draft.id, hash: fresh.headHash, now: T0 + 62 * MIN });
  assert.equal(tapped.ok, true);
  const sent = await deliver(db, deps, draft.id, { now: tapped.holdUntil });
  assert.equal(sent.outcome, "sent");
  assert.equal(fake.sent.length, 1);
});

test("editing a scheduled draft cancels the schedule", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, deps, draft, dueAt);

  const edited = await addRevision(db, draft.id, revInput({ body: "Hello Sam,\n\nThursday, then.\n" }), {
    author: "user", expectHash: draft.headHash, cancelSchedule: true, now: () => T0 + MIN,
  });
  assert.ok(edited.hash, "the person's edit became the next revision");
  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "draft");
  assert.equal(row.tapSeal, null);

  const tick = await sweepMailSends(db, deps, { now: dueAt });
  assert.equal(tick.delivered, 0);
  assert.equal(tick.missed, 0);
  assert.equal(fake.sent.length, 0);
});

test("a zone change after scheduling does not move the stored instant", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  // No injected zone: the tap and the tick read `instanceZone(db)`, as the gateway does.
  const { deps } = makeDeps(fake, { zone: undefined });
  await setSetting(db, "instance_timezone", CHICAGO);

  const draft = await makeDraft(db, account);
  await schedule(db, deps, draft, "2026-11-12T07:30:00-06:00", CHICAGO_0730 - DAY);
  assert.equal((await getDraft(db, draft.id)).dueAt, CHICAGO_0730);

  // The instance is moved to another zone after the schedule was taken.
  await setSetting(db, "instance_timezone", AUCKLAND);
  assert.notDeepEqual(wall(CHICAGO_0730, AUCKLAND), wall(CHICAGO_0730, CHICAGO));

  const tick = await sweepMailSends(db, deps, { now: CHICAGO_0730 });
  assert.equal(tick.delivered, 1);
  await _drainForTests();

  const row = await getDraft(db, draft.id);
  assert.equal(row.dueAt, CHICAGO_0730, "the instant is what was stored, whatever the zone now says");
  assert.equal(row.state, "sent");
  assert.equal(fake.sent.length, 1);
});

/* ------------------------------------------------------------------- the hold */

test("a restart during the ten-second hold delivers on the next tick", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);

  const tapped = await requestSend(db, deps, { draftId: draft.id, hash: draft.headHash, now: T0 });
  assert.equal(tapped.ok, true);
  assert.equal((await getDraft(db, draft.id)).state, "holding");

  // A new process: the hold's own timer never fires, the row is still there when it falls due.
  _resetInFlightForTests();
  _resetSweepForTests();
  const restarted = makeDeps(fake);
  const tick = await sweepMailSends(db, restarted.deps, { now: tapped.holdUntil });
  assert.equal(tick.delivered, 1);
  await _drainForTests();

  assert.equal((await getDraft(db, draft.id)).state, "sent");
  assert.equal(fake.sent.length, 1);
});

test("a hold older than the grace window becomes missed with one bell, and never sends", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, notifications } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const tapped = await requestSend(db, deps, { draftId: draft.id, hash: draft.headHash, now: T0 });
  assert.equal(tapped.ok, true);

  const tick = await sweepMailSends(db, deps, { now: tapped.holdUntil + GRACE_MS + MIN });
  assert.equal(tick.missed, 1);
  assert.equal(tick.delivered, 0);
  await _drainForTests();

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "missed");
  assert.equal(row.failReason, SEND_FAIL_REASONS.missed);
  assert.equal(row.tapSeal, null);
  assert.equal(fake.sent.length, 0, "a hold that ran out never goes out by itself");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].source, "mail");

  const again = await sweepMailSends(db, deps, { now: tapped.holdUntil + GRACE_MS + 2 * MIN });
  assert.equal(again.missed, 0);
  assert.equal(notifications.length, 1, "one bell per missed send");
  assert.equal(fake.sent.length, 0);
});

test("an auth_failed account on a held row fails the send with no adapter call", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, notifications } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const tapped = await requestSend(db, deps, { draftId: draft.id, hash: draft.headHash, now: T0 });
  assert.equal(tapped.ok, true);
  await updateAccount(db, account.id, { status: "auth_failed" });

  const tick = await sweepMailSends(db, deps, { now: tapped.holdUntil });
  assert.equal(tick.delivered, 0);
  assert.equal(tick.failed.length, 1);
  assert.equal(tick.failed[0].reason, "auth_failed");

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "failed");
  assert.equal(row.failReason, SEND_FAIL_REASONS.auth_failed);
  assert.equal(row.tapSeal, null);
  assert.equal(fake.sent.length, 0);
  assert.equal(notifications.length, 1);
});

/* -------------------------------------------------- the account the schedule outlived */

test("account removed after scheduling: row fails with the fixed sentence", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, notifications } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await schedule(db, deps, draft, T0 + 5 * MIN);
  await db.execute({ sql: "DELETE FROM mail_accounts WHERE id = ?", args: [account.id] });

  const tick = await sweepMailSends(db, deps, { now: T0 + 5 * MIN });
  await _drainForTests();

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "failed", "never silently dropped, never sent");
  assert.equal(row.failReason, SEND_FAIL_REASONS.account_removed);
  assert.equal(typeof row.failReason, "string");
  assert.ok(row.failReason.length > 0 && row.failReason.length <= 200);
  assert.equal(fake.sent.length, 0, "no adapter call for a mailbox that is gone");
  assert.equal(notifications.length, 0);
  assert.equal(tick.delivered, 0);
});

test("auth_failed account at due time: failed, notification, never missed-then-sent", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, notifications } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, deps, draft, dueAt);
  await updateAccount(db, account.id, { status: "auth_failed" });

  const tick = await sweepMailSends(db, deps, { now: dueAt });
  assert.equal(tick.delivered, 0);
  assert.equal(tick.missed, 0);
  assert.equal(tick.failed.length, 1);
  assert.equal(tick.failed[0].reason, "auth_failed");

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "failed");
  assert.equal(row.failReason, SEND_FAIL_REASONS.auth_failed);
  assert.equal(fake.sent.length, 0);
  assert.equal(notifications.length, 1);
  // The plan fixes no sentence for this bell, so it carries the title and no body.
  assert.deepEqual(notifications[0], {
    title: MISSED_TITLE, type: "attention", source: "mail", priority: "normal",
  });

  // Past the grace window the same row is still failed, not missed, and no second bell rings.
  const later = await sweepMailSends(db, deps, { now: dueAt + 20 * MIN });
  assert.equal(later.missed, 0);
  assert.equal((await getDraft(db, draft.id)).state, "failed");
  assert.equal(notifications.length, 1);
});

test("claim moved to another instance: failed with \"This account now connects from another Crow.\", no adapter call", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps: atTap } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, atTap, draft, dueAt);

  // The claim moves between the schedule and its due time.
  const { deps } = makeDeps(fake, {
    isClaimedElsewhere: async () => ({ claimed: true, instanceName: null }),
  });
  const tick = await sweepMailSends(db, deps, { now: dueAt });
  await _drainForTests();

  const row = await getDraft(db, draft.id);
  assert.equal(row.state, "failed");
  assert.equal(row.failReason, SEND_FAIL_REASONS.claimed_elsewhere);
  assert.equal(tick.failed.length, 1);
  assert.equal(tick.failed[0].reason, "claimed_elsewhere");
  assert.equal(tick.failed[0].sentence, claimedElsewhereSentence(null));
  assert.equal(fake.sent.length, 0, "never sent from a Crow that does not hold the account");
});

test("the notification text contains no address, subject or body", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps, notifications } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  await schedule(db, deps, draft, CHICAGO_0730, CHICAGO_0730 - DAY);
  await sweepMailSends(db, deps, { now: CHICAGO_0730 + 11 * MIN });

  assert.equal(notifications.length, 1);
  const text = JSON.stringify(notifications[0]);
  assert.equal(text.includes(SAM), false);
  assert.equal(text.includes(ALEX), false);
  assert.equal(text.includes("Tuesday"), false);
  assert.equal(text.includes("Hello Sam"), false);
  assert.equal(text.includes(HOST), false);
});

/* --------------------------------------------------- the interrupted send and the reconcile */

test("a stale claim is left alone while this process still runs it, and settles by its token once swept", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const map = new Map();
  const { deps } = makeDeps(fake, { inFlight: map });
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, deps, draft, dueAt);

  // The claim exactly as `deliver` writes it: a token, a claim time, an attempt, and the seal columns
  // nulled. The process that wrote it then dies, which is what the in-flight map stops saying.
  const attempt = dueAt - 30 * MIN;
  await db.execute({
    sql: `UPDATE mail_drafts
             SET state = 'sending', claim_token = 'claim-1', claimed_at = ?, attempt_at = ?,
                 tap_seal = NULL, tap_id = NULL, tap_action = NULL, attach_digest = NULL
           WHERE id = ?`,
    args: [attempt, attempt, draft.id],
  });

  map.set(draft.id, { claimToken: "claim-1", at: attempt });
  const running = await sweepMailSends(db, deps, { now: dueAt });
  assert.equal(running.unknown, 0, "a row this process is sending is never stale");
  assert.equal(running.delivered, 0);
  assert.equal((await getDraft(db, draft.id)).state, "sending");

  map.delete(draft.id);
  const stale = await sweepMailSends(db, deps, { now: dueAt });
  assert.equal(stale.unknown, 1);
  const unknown = await getDraft(db, draft.id);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.claimToken, "claim-1", "the token is kept, so a late success can still settle it");
  assert.equal(unknown.failReason, SEND_FAIL_REASONS.send_failed);
  assert.equal(unknown.tapSeal, null);
  assert.equal(unknown.reconcileCount, 1, "the first Sent-folder check was already due, so this tick ran it");
  assert.equal(unknown.nextReconcileAt, attempt + 5 * MIN, "and the next is five minutes after the attempt");
  assert.equal(fake.sent.length, 0, "the sweep never sends a row it did not claim");

  // A later tick past next_reconcile_at reconciles again and still sends nothing.
  const later = await sweepMailSends(db, deps, { now: dueAt + 20 * MIN });
  assert.equal(later.delivered, 0);
  assert.equal((await getDraft(db, draft.id)).reconcileCount, 2);
  assert.equal(fake.sent.length, 0);

  // The send that outlived the cutoff still settles its own row by the token it claimed with.
  const now = dueAt + 25 * MIN;
  assert.equal(await settle(db, draft.id, "claim-1", "sent", { now, sentAt: now }), true);
  const settled = await getDraft(db, draft.id);
  assert.equal(settled.state, "sent");
  assert.equal(settled.sentAt, now);
  assert.equal(settled.failReason, null);
  assert.equal(fake.sent.length, 0);
});

/* --------------------------------------------------------------------- the hook */

test("a throwing sweep is caught inside the hook and logged as an event and a code, and the next tick retries", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fake = makeFake();
  const { deps } = makeDeps(fake);
  const draft = await makeDraft(db, account);
  const dueAt = T0 + 5 * MIN;
  await schedule(db, deps, draft, dueAt);

  let fail = true;
  const flaky = new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return (statement) => {
          const sql = typeof statement === "string" ? statement : (statement?.sql ?? "");
          if (fail && sql.includes("mail_drafts")) return Promise.reject(new Error("hunter2 store pwd=a@example.com"));
          return target.execute(statement);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (line) => { warnings.push(String(line)); };
  const hook = registerMailSendHook(flaky, { ...deps, now: () => dueAt });
  try {
    // The hook answers the tick itself: the scheduler never sees a throw, and the text it carried never
    // reaches the log.
    await runSchedulerHooks("tick", flaky);
  } finally {
    console.warn = realWarn;
  }

  assert.equal(warnings.length, 1, "one line for one failed sweep");
  assert.equal(warnings[0], "[mail-schedule] sweep_failed unknown");
  const logged = warnings.join("\n");
  assert.equal(logged.includes("hunter2"), false, "an error's message never reaches the log");
  assert.equal(logged.includes(ALEX), false);
  assert.equal(logged.includes("[scheduler]"), false, "the scheduler was never handed the throw");

  fail = false;
  await runSchedulerHooks("tick", db);
  await _drainForTests();
  assert.equal(fake.sent.length, 1, "the next tick retries and delivers");
  assert.equal((await getDraft(db, draft.id)).state, "sent");

  // A MailError's own code is what a thrown sweep is reported as.
  const broken = registerMailSendHook(db, { ...deps, now: () => -1 });
  warnings.length = 0;
  const warn2 = console.warn;
  console.warn = (line) => { warnings.push(String(line)); };
  try {
    await runSchedulerHooks("tick", db);
  } finally {
    console.warn = warn2;
    broken.unregister();
  }
  assert.deepEqual(warnings, ["[mail-schedule] sweep_failed BAD_INPUT"]);

  hook.unregister();
  const before = fake.sent.length;
  await runSchedulerHooks("tick", db);
  assert.equal(fake.sent.length, before, "an unregistered hook runs nothing");
});

/* ------------------------------------------------------------------ nothing else taps */

/**
 * One call's argument text, split at its own top-level commas: the scan starts just after the opening
 * paren at `openIndex` and stops at the paren that closes it. Quoted strings and template literals are
 * stepped over, so a comma or a paren inside one is not an argument boundary.
 *
 * @param {string} source
 * @param {number} openIndex index of the `(`
 * @returns {string[]} the argument texts, trimmed by the caller
 */
function callArguments(source, openIndex) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = openIndex + 1;
  for (let i = openIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote != null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth += 1; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) { args.push(source.slice(start, i)); return args; }
      depth -= 1;
      continue;
    }
    if (ch === "," && depth === 0) { args.push(source.slice(start, i)); start = i + 1; }
  }
  return args;
}

/** A string literal, in either quote style. */
const STRING_LITERAL = /^(?:"[^"\n]*"|'[^'\n]*')$/;

/**
 * Every `transition(...)` call in a source text, as its argument texts. A mention in prose
 * (`transition()`) has no four arguments and is skipped: every real call names the row, the states it
 * may take, the state it writes and what it writes.
 */
function transitionCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/\btransition\s*\(/g)) {
    const args = callArguments(source, match.index + match[0].length - 1).map((arg) => arg.trim());
    if (args.length >= 4) calls.push(args);
  }
  return calls;
}

/** The calls whose target-state argument (`to`) is not a string literal, as the text it is instead. */
function nonLiteralTargets(source) {
  return transitionCalls(source).filter((args) => !STRING_LITERAL.test(args[3])).map((args) => args[3]);
}

test("no code path other than requestSend/scheduleDraft sets holding or scheduled", () => {
  const files = [
    ...jsFiles(join(REPO, "servers/gateway/mail")),
    ...jsFiles(join(REPO, "servers/gateway/routes")),
  ];
  assert.ok(files.length > 10, "the mail tree was read");
  // The exported state list in the draft store names every state; it is not a write.
  const STATE_LIST_LINE = /^\s*["']draft["'], ["']holding["'], ["']scheduled["'],/;
  // One entry per file that may hold either of the send service's two pinned spots, below.
  const SEND_SERVICE = "servers/gateway/mail/send/send-service.js";
  const storeFile = "servers/gateway/mail/drafts/store.js";
  for (const file of files) {
    const relative = file.slice(REPO.length + 1).split(sep).join("/");
    if (relative === storeFile) continue;
    const source = readFileSync(file, "utf8");

    // A literal tap state in an UPDATE on the draft table, in either quote style.
    assert.equal(
      /UPDATE\s+mail_drafts[\s\S]{0,500}?state\s*=\s*(['"])(?:holding|scheduled)\1/i.test(source),
      false,
      `${relative} writes a tap state directly`,
    );

    // A state written through a bind parameter could be any state, so only the draft store may do it.
    const parameterised = (source.match(/state\s*=\s*\?/gi) ?? []).length;
    assert.equal(parameterised, relative === SEND_SERVICE ? 1 : 0,
      `${relative} binds the state it writes`);

    // Every transition() call names the state it moves the row to as a string literal, so a target a
    // caller chooses cannot be a tap state the store would then seal.
    const targets = nonLiteralTargets(source);
    assert.deepEqual(targets, relative === SEND_SERVICE ? ["to"] : [],
      `${relative} passes a state name that is not a string literal`);

    let entrances = 0;
    for (const line of source.split("\n")) {
      if (STATE_LIST_LINE.test(line)) continue;
      entrances += (line.match(/, (["'])(?:holding|scheduled)\1,/g) ?? []).length;
    }
    if (relative.endsWith("mail/send/send-service.js") || relative.endsWith("mail/send/schedule-service.js")) {
      continue;
    }
    assert.equal(entrances, 0, `${relative} enters a tap state`);
  }

  // The two pinned spots are the send service's own failure paths: `failPending` writes "failed" unless
  // its caller names the one other word ("missed"), and `settle` refuses every target but sent/failed at
  // the top of the function. They are named here so any new bound state or non-literal target fails.
  assert.deepEqual(nonLiteralTargets(readFileSync(join(REPO, SEND_SERVICE), "utf8")), ["to"]);

  // The two owner taps, one each, and nothing else in the two services.
  const send = readFileSync(join(REPO, SEND_SERVICE), "utf8");
  assert.equal((send.match(/, "holding",/g) ?? []).length, 1);
  assert.equal((send.match(/, "scheduled",/g) ?? []).length, 0);
  assert.equal((SCHEDULE_SOURCE.match(/, "scheduled",/g) ?? []).length, 1);
  assert.equal((SCHEDULE_SOURCE.match(/, "holding",/g) ?? []).length, 0);
  // Only requestSend and scheduleDraft import the seal's writer.
  for (const file of files) {
    const relative = file.slice(REPO.length + 1).split(sep).join("/");
    const source = readFileSync(file, "utf8");
    if (!/from\s+"[^"]*drafts\/seal\.js"/.test(source)) continue;
    assert.ok(
      relative.endsWith("mail/send/send-service.js") || relative.endsWith("mail/send/schedule-service.js"),
      `${relative} may not mint a tap seal`,
    );
  }
});