// Crow Mail's notifications, settings, account removal and retention (plan 3, Task 13).
//
// Two rigs. The first is a scratch DB with the mail tables, the draft tables, the account send columns
// and the two settings tables, driving the real draft store, the real schedule service and the real
// removal guard with an injected clock and a recording notification creator. The second is a real
// express app over the real mail API router, for the owner-only `GET`/`PATCH /settings` pair and the
// per-account `sentCopy` field, with the owner rule injected and the request marked as the owner's own
// client (tests/helpers/off-box.js). No network, no pi, no host config.
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { markFromLaptop } from "./helpers/off-box.js";

const { default: express } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } = await import("../servers/shared/mail-schema.js");
const { createAccount, deleteAccount, getAccount, onAccountDeleting } =
  await import("../servers/gateway/mail/store/accounts.js");
const {
  ACCOUNT_REMOVED_REASON, addComment, addRevision, createDraft, getDraft, getVoice, setVoice,
} = await import("../servers/gateway/mail/drafts/store.js");
const { CLOUD_DRAFTING_SETTING, readDraftingSettings } = await import("../servers/gateway/mail/drafts/turn.js");
const {
  DRAFT_RETENTION_MS, PRUNE_SETTING_KEY, WORKING_HOURS_END_SETTING, WORKING_HOURS_START_SETTING,
  pruneMailDrafts, readWorkingHours, schedulePresets, sweepMailSends,
} = await import("../servers/gateway/mail/send/schedule-service.js");
const {
  ACCOUNT_REMOVED_BELL_BODY, MAIL_NOTIFICATION_TITLE, guardAccountRemoval,
} = await import("../servers/gateway/boot/mail-boot.js");
const {
  MAIL_API_PREFIX, MAIL_CLOUD_DRAFTING_SETTING, MAIL_WORKING_HOURS_END_SETTING,
  MAIL_WORKING_HOURS_START_SETTING, mailApiRouter, clearMailApiRuntime,
} = await import("../servers/gateway/routes/mail-api.js");
const { isSyncable } = await import("../servers/gateway/dashboard/settings/registry.js");

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const HOST = "mail.example.test";
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T18:00:00Z");
const CHICAGO = "America/Chicago";

const root = mkdtempSync(join(tmpdir(), "mail-draft-settings-"));
process.env.CROW_DATA_DIR = join(root, "data");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
mkdirSync(process.env.CROW_HOME, { recursive: true });

const dirs = [];
const servers = [];
const open = [];
after(() => {
  clearMailApiRuntime();
  for (const s of servers) s.close();
  for (const c of open) { try { c.close(); } catch { /* closed */ } }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
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
`;

/** A scratch crow.db with every table these tests read: the mail tables, the drafts, the settings. */
async function freshDb() {
  const dir = mkdtempSync(join(root, "db-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  open.push(db);
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  await db.executeMultiple(SETTINGS_DDL);
  return db;
}

async function setSetting(db, key, value) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = ?`,
    args: [key, value, value],
  });
}

async function getSetting(db, key) {
  const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
  return rows[0]?.value ?? null;
}

async function makeAccount(db, overrides = {}) {
  return createAccount(db, {
    label: "Alex",
    address: ALEX,
    imap: { host: HOST, port: 993, security: "ssl" },
    smtp: { host: HOST, port: 465, security: "ssl" },
    ...overrides,
  });
}

function revInput(overrides = {}) {
  return {
    to: [{ address: SAM }],
    cc: [],
    bcc: [],
    subject: "Re: Tuesday",
    body: "Hello Sam,\n\nTuesday works for me.\n",
    inReplyTo: null,
    references: [],
    attachments: [],
    ...overrides,
  };
}

async function makeDraft(db, account, overrides = {}) {
  return createDraft(db, {
    accountId: account.id,
    mode: "reply",
    threadKey: "thread-1",
    chatThreadId: "chat-1",
    first: revInput(overrides.first),
    author: "bot",
  }, { now: () => T0 });
}

/** Force a draft row into a state this test needs, with the columns that state carries. */
async function forceState(db, draftId, state, fields = {}) {
  const sets = ["state = ?"];
  const args = [state];
  for (const [column, value] of Object.entries(fields)) {
    sets.push(`${column} = ?`);
    args.push(value);
  }
  args.push(draftId);
  await db.execute({ sql: `UPDATE mail_drafts SET ${sets.join(", ")} WHERE id = ?`, args });
}

async function countRows(db, table, where = "", args = []) {
  const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} ${where}`, args });
  return Number(rows[0]?.n ?? 0);
}

/** The wall clock in a zone at an instant, as comparable text. */
function wall(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const hour = String(Number(parts.hour) % 24).padStart(2, "0");
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}`, weekday: parts.weekday };
}

/** Every bell a run rings, in order. */
function bellRecorder(result = { id: 1 }) {
  const bells = [];
  return {
    bells,
    createNotification: async (db, options) => {
      bells.push(options);
      return result;
    },
  };
}

/* ---------------------------------------------------------------- the presets */

test("working hours change the presets, and none set keeps 7:30 and 8:00", async () => {
  const db = await freshDb();
  // Wednesday 12:00 in Chicago.
  const now = Date.parse("2026-11-11T18:00:00Z");

  const defaults = await schedulePresets(db, { now, zone: CHICAGO });
  assert.deepEqual(wall(defaults.tomorrowMorning.getTime(), CHICAGO),
    { date: "2026-11-12", time: "07:30", weekday: "Thu" });
  assert.deepEqual(wall(defaults.nextWorkDay.getTime(), CHICAGO),
    { date: "2026-11-12", time: "08:00", weekday: "Thu" });
  assert.equal(await readWorkingHours(db), null, "this instance has set no working hours");

  await setSetting(db, WORKING_HOURS_START_SETTING, "09:15");
  await setSetting(db, WORKING_HOURS_END_SETTING, "17:00");
  assert.deepEqual(await readWorkingHours(db),
    { start: "09:15", end: "17:00", hour: 9, minute: 15 });

  const set = await schedulePresets(db, { now, zone: CHICAGO });
  assert.deepEqual(wall(set.tomorrowMorning.getTime(), CHICAGO),
    { date: "2026-11-12", time: "09:15", weekday: "Thu" }, "tomorrow morning is the working start");
  assert.deepEqual(wall(set.nextWorkDay.getTime(), CHICAGO),
    { date: "2026-11-12", time: "09:15", weekday: "Thu" }, "the next work day starts at the working time");

  // Friday afternoon: the next work day is Monday, still at the working start.
  const friday = Date.parse("2026-11-13T20:00:00Z");
  const monday = await schedulePresets(db, { now: friday, zone: CHICAGO });
  assert.deepEqual(wall(monday.nextWorkDay.getTime(), CHICAGO),
    { date: "2026-11-16", time: "09:15", weekday: "Mon" });
  assert.deepEqual(wall(monday.tomorrowMorning.getTime(), CHICAGO),
    { date: "2026-11-14", time: "09:15", weekday: "Sat" });

  // One of the two keys is not a working day: the presets keep their defaults.
  await setSetting(db, WORKING_HOURS_END_SETTING, "");
  assert.equal(await readWorkingHours(db), null);
  const half = await schedulePresets(db, { now, zone: CHICAGO });
  assert.deepEqual(wall(half.tomorrowMorning.getTime(), CHICAGO),
    { date: "2026-11-12", time: "07:30", weekday: "Thu" });

  // A value that is not HH:MM is no working hours either.
  await setSetting(db, WORKING_HOURS_START_SETTING, "9:15");
  await setSetting(db, WORKING_HOURS_END_SETTING, "17:00");
  assert.equal(await readWorkingHours(db), null);

  // A caller may hand the presets the hours directly, which is what a test of the sheet would do.
  const passed = await schedulePresets(db, { now, zone: CHICAGO, workingHours: { start: "08:00", end: "16:00" } });
  assert.deepEqual(wall(passed.tomorrowMorning.getTime(), CHICAGO),
    { date: "2026-11-12", time: "08:00", weekday: "Thu" });
});

test("cloud drafting defaults to off, persists in a local row and is not syncable", async () => {
  const db = await freshDb();
  assert.equal(isSyncable(CLOUD_DRAFTING_SETTING), false, "the cloud switch never replicates");
  assert.equal(MAIL_CLOUD_DRAFTING_SETTING, CLOUD_DRAFTING_SETTING, "one key, both readers");

  const before = await readDraftingSettings(db);
  assert.equal(before.cloudDrafting, false, "off until the owner turns it on (Q1)");

  const { writeSetting, getSettingScope } = await import("../servers/gateway/dashboard/settings/registry.js");
  await writeSetting(db, CLOUD_DRAFTING_SETTING, "1", { scope: "local" });
  assert.equal((await readDraftingSettings(db)).cloudDrafting, true);
  assert.equal(await getSettingScope(db, CLOUD_DRAFTING_SETTING), "local", "the decision is this box's own");
  assert.equal(await countRows(db, "dashboard_settings", "WHERE key = ?", [CLOUD_DRAFTING_SETTING]), 0,
    "the switch is never a global row");
});

/* ---------------------------------------------------------------- the retention */

test("retention deletes a 91-day-old sent draft with its revisions, voice rows and comments", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);

  const old = await makeDraft(db, account);
  await addRevision(db, old.id, revInput({ body: "Hello Sam,\n\nOne.\n" }), {
    author: "user", expectHash: old.headHash, now: () => T0 + 1000,
  });
  await addComment(db, old.id, { rev: 1, lineIndex: 0, quote: "Hello Sam,", text: "Softer." }, { now: () => T0 + 2000 });
  assert.equal(await setVoice(db, old.id, 2, { score: 80 }, { now: () => T0 + 3000 }), true);
  await forceState(db, old.id, "sent", { sent_at: T0, updated_at: NOW - DRAFT_RETENTION_MS - DAY });

  const unconfirmed = await makeDraft(db, account);
  await addRevision(db, unconfirmed.id, revInput({ body: "Hello Sam,\n\nTwo.\n" }), {
    author: "bot", expectHash: unconfirmed.headHash, now: () => T0 + 1000,
  });
  await addComment(db, unconfirmed.id, { rev: 1, lineIndex: 0, text: "Keep." }, { now: () => T0 + 2000 });
  await setVoice(db, unconfirmed.id, 1, { score: 40 }, { now: () => T0 + 3000 });
  await forceState(db, unconfirmed.id, "unknown", {
    fail_reason: "timeout", attempt_at: NOW - DRAFT_RETENTION_MS - DAY,
    updated_at: NOW - DRAFT_RETENTION_MS - DAY,
  });

  const recent = await makeDraft(db, account);
  await addRevision(db, recent.id, revInput({ body: "Hello Sam,\n\nThree.\n" }), {
    author: "user", expectHash: recent.headHash, now: () => T0 + 1000,
  });
  await forceState(db, recent.id, "sent", { sent_at: NOW - 89 * DAY, updated_at: NOW - 89 * DAY });

  const out = await pruneMailDrafts(db, { now: NOW });
  assert.deepEqual(out, { pruned: 1 });

  assert.equal(await getDraft(db, old.id), null, "the sent draft is gone");
  assert.equal(await countRows(db, "mail_draft_revisions", "WHERE draft_id = ?", [old.id]), 0);
  assert.equal(await countRows(db, "mail_draft_comments", "WHERE draft_id = ?", [old.id]), 0);
  assert.equal(await countRows(db, "mail_draft_voice", "WHERE draft_id = ?", [old.id]), 0);

  assert.ok(await getDraft(db, unconfirmed.id), "an unconfirmed outcome is never pruned");
  assert.equal(await countRows(db, "mail_draft_revisions", "WHERE draft_id = ?", [unconfirmed.id]), 2);
  assert.equal(await countRows(db, "mail_draft_comments", "WHERE draft_id = ?", [unconfirmed.id]), 1);
  assert.equal((await getVoice(db, unconfirmed.id, 1)).rev, 1);

  const kept = await getDraft(db, recent.id);
  assert.ok(kept, "an 89-day-old sent draft is inside the window");
  assert.equal(await countRows(db, "mail_draft_revisions", "WHERE draft_id = ?", [recent.id]), 2);
  assert.equal(kept.state, "sent");
});

test("two sweeps on one day prune once, and a later day prunes again", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);

  const first = await makeDraft(db, account);
  await forceState(db, first.id, "discarded", { updated_at: NOW - 91 * DAY });

  const one = await sweepMailSends(db, {}, { now: NOW });
  assert.equal(one.pruned, 1);
  assert.equal(await getDraft(db, first.id), null);
  assert.equal(await getSetting(db, PRUNE_SETTING_KEY), String(NOW), "the day's prune is recorded");

  // A second tick the same day finds the compare-and-set already spent: its candidate stays.
  const second = await makeDraft(db, account);
  await forceState(db, second.id, "discarded", { updated_at: NOW - 91 * DAY });
  const two = await sweepMailSends(db, {}, { now: NOW + 60_000 });
  assert.equal(two.pruned, 0);
  assert.ok(await getDraft(db, second.id), "one prune a day, whatever the tick interval is");

  // The next day's tick wins the compare-and-set and takes the candidate with it.
  const later = await sweepMailSends(db, {}, { now: NOW + DAY + 60_000 });
  assert.equal(later.pruned, 1);
  assert.equal(await getDraft(db, second.id), null);
});

/* ------------------------------------------------------------ the account removal */

test("removing an account discards its live drafts, deletes them and posts one bell", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const live = [];
  for (const state of ["draft", "failed", "missed", "holding", "scheduled"]) {
    const draft = await makeDraft(db, account);
    await addComment(db, draft.id, { rev: 1, lineIndex: 0, text: "Line." }, { now: () => T0 + 1000 });
    await forceState(db, draft.id, state, {
      due_at: state === "scheduled" ? NOW + DAY : null,
      hold_until: state === "holding" ? NOW + 10_000 : null,
      fail_reason: state === "failed" || state === "missed" ? "reason" : null,
    });
    live.push(draft);
  }
  const bell = bellRecorder();
  const out = await guardAccountRemoval(db, account.id, { now: NOW, createNotification: bell.createNotification });

  assert.equal(out.discarded, 5);
  assert.equal(out.deleted, 5);
  for (const draft of live) {
    assert.equal(await getDraft(db, draft.id), null, "a cancelled draft goes with its account");
    assert.equal(await countRows(db, "mail_draft_revisions", "WHERE draft_id = ?", [draft.id]), 0);
    assert.equal(await countRows(db, "mail_draft_comments", "WHERE draft_id = ?", [draft.id]), 0);
  }

  // One bell for the removal, and it names nothing from the mail itself.
  assert.equal(bell.bells.length, 1, "one bell for the removal");
  assert.equal(bell.bells[0].source, "mail");
  assert.equal(bell.bells[0].type, "attention");
  assert.equal(bell.bells[0].title, MAIL_NOTIFICATION_TITLE);
  assert.equal(bell.bells[0].body, ACCOUNT_REMOVED_BELL_BODY);
  const text = JSON.stringify(bell.bells[0]);
  for (const needle of [ALEX, SAM, "Tuesday", "Hello Sam", HOST]) {
    assert.equal(text.includes(needle), false, `the bell carries no ${needle}`);
  }
});

test("removal still succeeds when createNotification returns null", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const draft = await makeDraft(db, account);
  const bell = bellRecorder(null);

  const out = await guardAccountRemoval(db, account.id, { now: NOW, createNotification: bell.createNotification });
  assert.equal(bell.bells.length, 1, "the call was made");
  assert.equal(out.discarded, 1);
  assert.equal(await getDraft(db, draft.id), null);

  // The same, through the real delete path: a filtered bell never blocks or fails a removal.
  const second = await makeAccount(db, { address: "sam@example.com", label: "Sam" });
  const other = await makeDraft(db, second);
  const off = onAccountDeleting((hookDb, accountId) => guardAccountRemoval(hookDb, accountId, {
    now: NOW, createNotification: bell.createNotification,
  }));
  try {
    const removed = await deleteAccount(db, second.id);
    assert.equal(typeof removed.messages, "number");
  } finally {
    off();
  }
  assert.equal(await getAccount(db, second.id), null);
  assert.equal(await getDraft(db, other.id), null);
});

test("removal is never blocked by a live draft, and it leaves unknown rows visible", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const holding = await makeDraft(db, account);
  await forceState(db, holding.id, "holding", { hold_until: NOW + 10_000 });
  const scheduled = await makeDraft(db, account);
  await forceState(db, scheduled.id, "scheduled", { due_at: NOW + DAY });
  const unknown = await makeDraft(db, account);
  await addRevision(db, unknown.id, revInput({ body: "Hello Sam,\n\nLater.\n" }), {
    author: "bot", expectHash: unknown.headHash, now: () => T0 + 1000,
  });
  await forceState(db, unknown.id, "unknown", { fail_reason: "timeout", attempt_at: NOW - 60_000 });

  const bell = bellRecorder();
  const off = onAccountDeleting((hookDb, accountId) => guardAccountRemoval(hookDb, accountId, {
    now: NOW, createNotification: bell.createNotification,
  }));
  try {
    await deleteAccount(db, account.id);
  } finally {
    off();
  }

  assert.equal(await getAccount(db, account.id), null, "nothing a live draft does can stop a removal");
  assert.equal(await getDraft(db, holding.id), null);
  assert.equal(await getDraft(db, scheduled.id), null);

  const kept = await getDraft(db, unknown.id);
  assert.ok(kept, "the unconfirmed row stays: it is the only record a message may have gone out");
  assert.equal(kept.state, "unknown");
  assert.equal(kept.failReason, ACCOUNT_REMOVED_REASON, "the reason rides the row's own fail_reason");
  assert.equal(await countRows(db, "mail_draft_revisions", "WHERE draft_id = ?", [unknown.id]), 2,
    "its revisions stay with it");
  assert.equal(bell.bells.length, 1);
});

test("a sending row of a removed account becomes unknown with reason account_removed and is never reconciled", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const draft = await makeDraft(db, account);
  await forceState(db, draft.id, "sending", {
    claim_token: "claim-1", claimed_at: NOW - 5 * 60_000, attempt_at: NOW - 5 * 60_000,
    message_id: "<one@mail.example.test>",
  });
  const already = await makeDraft(db, account);
  await forceState(db, already.id, "unknown", {
    fail_reason: "timeout", attempt_at: NOW - 5 * 60_000, next_reconcile_at: NOW - 1,
  });

  const bell = bellRecorder();
  const out = await guardAccountRemoval(db, account.id, { now: NOW, createNotification: bell.createNotification });
  assert.equal(out.unknown, 2, "the sending row and the row already unknown");

  const sending = await getDraft(db, draft.id);
  assert.equal(sending.state, "unknown", "an outcome nobody can confirm is not called sent or not sent");
  assert.equal(sending.failReason, ACCOUNT_REMOVED_REASON);
  assert.equal(sending.claimToken, "claim-1", "a late success can still settle the row by its token");
  assert.equal((await getDraft(db, already.id)).failReason, ACCOUNT_REMOVED_REASON);

  // The sweep leaves both alone: their account is gone, and the reason says no check can run either.
  const syncs = [];
  const tick = await sweepMailSends(db, { requestSync: (id) => { syncs.push(id); } }, { now: NOW + 60_000 });
  assert.equal(tick.reconciled, 0, "there is no Sent folder and no adapter");
  assert.deepEqual(syncs, [], "not even a sync was asked for");
  assert.equal((await getDraft(db, draft.id)).reconcileCount, 0);
  assert.equal((await getDraft(db, draft.id)).state, "unknown");

  // Removing the account twice changes nothing and rings nothing more.
  await guardAccountRemoval(db, account.id, { now: NOW + 1000, createNotification: bell.createNotification });
  assert.equal(bell.bells.length, 1, "one bell for one removal");
  assert.equal((await getDraft(db, draft.id)).failReason, ACCOUNT_REMOVED_REASON);
});

test("the sweep skips an unknown row whose account is gone, and one whose reason is account_removed", async () => {
  const db = await freshDb();
  const gone = await makeAccount(db, { address: ALEX, label: "Alex" });
  const orphan = await makeDraft(db, gone);
  await forceState(db, orphan.id, "unknown", {
    fail_reason: "timeout", attempt_at: NOW - 5 * 60_000, next_reconcile_at: NOW - 1,
  });

  const live = await makeAccount(db, { address: "sam@example.com", label: "Sam" });
  const marked = await makeDraft(db, live);
  await forceState(db, marked.id, "unknown", {
    fail_reason: ACCOUNT_REMOVED_REASON, attempt_at: NOW - 5 * 60_000, next_reconcile_at: NOW - 1,
  });
  const due = await makeDraft(db, live);
  await forceState(db, due.id, "unknown", {
    fail_reason: "timeout", attempt_at: NOW - 5 * 60_000, next_reconcile_at: NOW - 1,
  });

  // The first account is deleted without its guard: the row is left exactly as the sweep must read it.
  await db.execute({ sql: "DELETE FROM mail_accounts WHERE id = ?", args: [gone.id] });

  const syncs = [];
  const tick = await sweepMailSends(db, { requestSync: (id) => { syncs.push(id); } }, { now: NOW });
  assert.equal(tick.reconciled, 1, "only the row of a live account with a real reason is checked");
  assert.deepEqual(syncs, [live.id]);
  assert.equal((await getDraft(db, orphan.id)).reconcileCount, 0);
  assert.equal((await getDraft(db, marked.id)).reconcileCount, 0, "the removal's own mark is terminal");
  assert.equal((await getDraft(db, due.id)).reconcileCount, 1);
});

/* ------------------------------------------------------------------ the settings routes */

const OWNER = "owner-local-password-session";
const CSRF = "csrf-token-value";
let server = null;
let apiDb = null;
let apiPath = null;

before(async () => {
  apiPath = join(root, "api.db");
  apiDb = createDbClient(apiPath);
  open.push(apiDb);
  await apiDb.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await apiDb.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await apiDb.executeMultiple(MAIL_DRAFTS_DDL);
  await apiDb.executeMultiple(SETTINGS_DDL);

  const app = express();
  const sessionGate = (req, res, next) => {
    const match = /(?:^|;)\s*crow_session=([^;]*)/.exec(String(req.headers.cookie || ""));
    if (!match) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = decodeURIComponent(match[1]);
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  app.use(mailApiRouter(sessionGate, {
    openDb: () => createDbClient(apiPath),
    ownerCheck: (db, req) => req.dashboardSession === OWNER
      // The owner's own client is off this machine: the same shape the real rule reads.
      && req[Symbol.for("crow.peer-class")]?.via === "direct",
    localInstance: { instanceId: "instA", instanceName: "Delta" },
    supervisor: null,
  }));
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    servers.push(s);
  });
});

beforeEach(() => {
  clearMailApiRuntime();
  process.env.CROW_MAIL = "1";
});

function call(method, path, { body, token = OWNER, csrf = CSRF, laptop = true } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (payload !== null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (token) headers.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
  if (token && csrf) headers["x-crow-csrf"] = csrf;
  if (laptop) headers["x-test-from"] = "laptop";
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    req.end(payload === null ? undefined : payload);
  });
}

const SETTINGS_PATH = `${MAIL_API_PREFIX}/settings`;

test("GET and PATCH /settings are owner-only", async () => {
  const read = await call("GET", SETTINGS_PATH);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.json.settings,
    { workingHoursStart: null, workingHoursEnd: null, cloudDrafting: false });
  assert.equal(typeof read.json.sentCopies, "object");

  for (const [label, options] of [
    ["no session", { token: null }],
    ["a peer session", { token: "peer-sso-session" }],
    ["this machine's own client", { laptop: false }],
  ]) {
    const refused = await call("GET", SETTINGS_PATH, options);
    assert.equal(refused.status, tokenStatus(options), label);
    assert.equal(refused.text.includes("workingHours"), false, `${label} reads nothing`);
    const denied = await call("PATCH", SETTINGS_PATH, { ...options, body: { cloudDrafting: true } });
    assert.equal(denied.status, tokenStatus(options), label);
  }

  delete process.env.CROW_MAIL;
  try {
    const off = await call("GET", SETTINGS_PATH);
    assert.equal(off.status, 404);
    assert.deepEqual(off.json, { error: "not_found", message: "Not found." });
  } finally {
    process.env.CROW_MAIL = "1";
  }
});

function tokenStatus(options) {
  return options.token === null ? 401 : 403;
}

test("PATCH /settings saves working hours and the cloud switch, and refuses an unknown key or a bad time", async () => {
  const saved = await call("PATCH", SETTINGS_PATH, {
    body: { workingHoursStart: "09:15", workingHoursEnd: "17:00", cloudDrafting: true },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.settings,
    { workingHoursStart: "09:15", workingHoursEnd: "17:00", cloudDrafting: true });

  // What was stored is what both readers read: the presets and the drafting gate.
  assert.equal((await readWorkingHours(apiDb)).start, "09:15");
  assert.equal((await readWorkingHours(apiDb)).end, "17:00");
  assert.equal((await readDraftingSettings(apiDb)).cloudDrafting, true);
  assert.equal(isSyncable(CLOUD_DRAFTING_SETTING), false);
  assert.equal(MAIL_WORKING_HOURS_START_SETTING, WORKING_HOURS_START_SETTING);
  assert.equal(MAIL_WORKING_HOURS_END_SETTING, WORKING_HOURS_END_SETTING);

  // A read now answers the stored values.
  const read = await call("GET", SETTINGS_PATH);
  assert.deepEqual(read.json.settings,
    { workingHoursStart: "09:15", workingHoursEnd: "17:00", cloudDrafting: true });

  // Clearing both is how working hours are unset; the switch turns off.
  const cleared = await call("PATCH", SETTINGS_PATH, {
    body: { workingHoursStart: null, workingHoursEnd: null, cloudDrafting: false },
  });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual(cleared.json.settings,
    { workingHoursStart: null, workingHoursEnd: null, cloudDrafting: false });
  assert.equal(await readWorkingHours(apiDb), null);

  const refused = [
    { unknown: true },
    { workingHoursStart: "09:15" },
    { workingHoursStart: "09:15", workingHoursEnd: null },
    { workingHoursStart: "9:15", workingHoursEnd: "17:00" },
    { workingHoursStart: "24:00", workingHoursEnd: "17:00" },
    { workingHoursStart: "09:15", workingHoursEnd: "17:60" },
    { workingHoursStart: 915, workingHoursEnd: 1700 },
    { cloudDrafting: "yes" },
    { cloudDrafting: 1 },
    [],
    "not an object",
  ];
  for (const body of refused) {
    const bad = await call("PATCH", SETTINGS_PATH, { body });
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.equal(bad.json.error, "bad_input", JSON.stringify(body));
  }
  // A body with no key at all is accepted and changes nothing.
  const empty = await call("PATCH", SETTINGS_PATH, { body: {} });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.settings,
    { workingHoursStart: null, workingHoursEnd: null, cloudDrafting: false });
});

test("the account PATCH takes sentCopy from the two words and nothing else", async () => {
  const account = await createAccount(apiDb, {
    label: "Personal",
    address: "alex@example.com",
    imap: { host: HOST, port: 993, security: "ssl" },
    smtp: { host: HOST, port: 465, security: "ssl" },
  });
  assert.equal((await getAccount(apiDb, account.id)).sentCopy, "provider", "the column's default");

  const path = `${MAIL_API_PREFIX}/accounts/${encodeURIComponent(account.id)}`;
  const saved = await call("PATCH", path, { body: { sentCopy: "append" } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.account.id, account.id);
  assert.equal((await getAccount(apiDb, account.id)).sentCopy, "append");

  for (const value of ["bogus", null, "APPEND", true]) {
    const bad = await call("PATCH", path, { body: { sentCopy: value } });
    assert.equal(bad.status, 400, String(value));
    assert.equal(bad.json.error, "bad_input", String(value));
  }
  assert.equal((await getAccount(apiDb, account.id)).sentCopy, "append", "a refused value wrote nothing");

  // The settings read carries the rule per account, so the page can show the stored choice.
  const settings = await call("GET", SETTINGS_PATH);
  assert.equal(settings.json.sentCopies[account.id], "append");
});