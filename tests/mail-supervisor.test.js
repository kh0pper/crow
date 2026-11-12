// Crow Mail's sync supervisor (Task 16 of plan 1): one worker per account, the IDLE watch, the poll
// tick, the back-off ladder, the deadline, the claim re-check, and the short-lived adapter an action
// borrows. Everything runs on a scratch DB built from MAIL_DDL, an in-memory fake adapter and a fake
// clock whose timers the test fires by hand, so no assertion here waits on real time.
//
// Two things are asserted everywhere they could leak: a sync of one account never overlaps itself,
// and nothing that came from a library (`Error("secret-text")` below) ever reaches a log line, the
// sync state, `status_detail` or a notice — only MailError codes and allow-listed detail tokens.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import {
  createAccount,
  getAccount,
  getSyncState,
  listAccounts,
  setSyncState,
  updateAccount,
} from "../servers/gateway/mail/store/accounts.js";
import { listFolders } from "../servers/gateway/mail/store/messages.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import { createFakeMailAdapter } from "./fixtures/fake-mail-adapter.mjs";
import { makeRaw } from "./fixtures/fake-mail-server.mjs";
import {
  ACTION_DEADLINE_MS,
  ACTION_IDLE_KEEP_MS,
  BACKOFF_BASE_MS,
  CLAIM_REFRESH_MS,
  FAILURES_BEFORE_NOTICE,
  IDLE_ROLES,
  NOTICE_GAP_MS,
  POLL_MS,
  SYNC_DEADLINE_MS,
  backoffDelay,
  createMailSupervisor,
  shouldRunMailSync,
} from "../servers/gateway/mail/sync/supervisor.js";

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/* --------------------------------------------------------------------- plumbing */

/** Let every pending promise, db call and timer callback settle. */
async function flush(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A clock whose timers only fire when the test advances it. */
function makeClock(start = T0) {
  const timers = new Map();
  let current = start;
  let seq = 0;
  return {
    now: () => current,
    setTimer(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: current + Math.max(0, Number(ms) || 0) });
      return seq;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    pending: () => timers.size,
    /** Fire every timer due within `ms`, earliest first, and settle everything it starts. */
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        await flush();
        let due = null;
        for (const entry of timers) {
          if (entry[1].at > target) continue;
          if (due == null || entry[1].at < due[1].at || (entry[1].at === due[1].at && entry[0] < due[0])) {
            due = entry;
          }
        }
        if (due == null) break;
        timers.delete(due[0]);
        if (due[1].at > current) current = due[1].at;
        due[1].fn();
      }
      current = target;
      await flush();
    },
  };
}

/**
 * One adapter from the factory: a thin view over the shared fake mailbox. It records its own calls
 * and its own closed flag, exactly as a real adapter's connection would, while the mailbox itself
 * (messages, UIDVALIDITY, watchers) stays shared — so a reconnected adapter still sees the same mail.
 *
 * `gate.delay` makes every call yield, and `gate.hold` parks every call on a promise the test
 * releases: that is how a test keeps a run observably in flight while it pokes at the supervisor.
 */
function adapterView(fake, gate) {
  const state = { calls: [], closed: false };
  const watchers = new Set();
  const pause = async () => {
    const hold = gate.hold;
    if (hold) await hold;
    for (let i = 0; i < gate.delay; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const open = (method) => {
    state.calls.push(method);
    if (state.closed) throw new MailError("PROTOCOL", "closed");
  };
  return {
    state,
    async connect() {
      open("connect");
      await pause();
      await fake.connect();
    },
    async close() {
      if (state.closed) return;
      state.closed = true;
      state.calls.push("close");
      for (const watcher of [...watchers]) watcher.stop();
      watchers.clear();
    },
    async listFolders() {
      open("listFolders");
      await pause();
      return fake.listFolders();
    },
    async list(folderPath, options) {
      open("list");
      await pause();
      return fake.list(folderPath, options);
    },
    async get(folderPath, uids) {
      open("get");
      await pause();
      return fake.get(folderPath, uids);
    },
    async search(query, options) {
      open("search");
      await pause();
      return fake.search(query, options);
    },
    async saveDraft(raw) {
      open("saveDraft");
      return fake.saveDraft(raw);
    },
    async send(message) {
      open("send");
      return fake.send(message);
    },
    async watch(folderPaths, handlers) {
      open("watch");
      await pause();
      const watcher = await fake.watch(folderPaths, handlers);
      const handle = {
        stop() {
          watchers.delete(handle);
          watcher.stop();
        },
      };
      watchers.add(handle);
      return handle;
    },
    // The seeding hooks, so a test can talk to the mailbox through the adapter it was handed.
    deliver: (...args) => fake.deliver(...args),
    expunge: (...args) => fake.expunge(...args),
    emit: (...args) => fake.emit(...args),
    dropWatch: (...args) => fake.dropWatch(...args),
    failNext: (...args) => fake.failNext(...args),
    hangNext: (...args) => fake.hangNext(...args),
  };
}

/** One scratch DB, one fake mailbox, one clock and one supervisor. */
async function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-supervisor-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);

  const clock = makeClock(options.startAt ?? T0);
  const fake = createFakeMailAdapter({ now: clock.now });
  const gate = { delay: options.delay ?? 0, hold: null };
  const views = [];
  const secrets = [];
  const factoryArgs = [];
  const box = { password: options.password ?? "first-secret" };
  const credentials = { async getSecrets() { return { password: box.password }; } };
  const notices = [];
  const logs = [];

  const factory = async ({ account, credentials: reader }) => {
    factoryArgs.push({ account, credentials: reader });
    const secret = reader != null && typeof reader.getSecrets === "function"
      ? await reader.getSecrets(account.id)
      : null;
    secrets.push(secret?.password ?? null);
    const view = adapterView(fake, gate);
    views.push(view);
    return view;
  };

  const account = await createAccount(db, {
    address: options.address ?? "alex@example.com",
    label: options.label ?? "Alex",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 587, security: "starttls" },
  });
  const extras = [];
  for (const extra of options.extraAccounts ?? []) extras.push(await addAccount(db, extra.address, extra.label));

  const supervisor = createMailSupervisor({
    db,
    credentials,
    adapterFactory: options.adapterFactory ?? factory,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    notify: async (title, body) => { notices.push({ title, body }); },
    log: (line) => { logs.push(line); },
    isClaimedElsewhere: options.isClaimedElsewhere ?? (async () => false),
    refreshClaim: options.refreshClaim ?? (async () => {}),
  });

  if (options.start !== false) await supervisor.start();

  return {
    db, clock, fake, gate, views, secrets, factoryArgs, box, credentials, notices, logs,
    factory, supervisor, account, accountId: account.id, extras,
  };
}

async function addAccount(db, address, label) {
  return createAccount(db, {
    address,
    label,
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 587, security: "starttls" },
  });
}

const callsOf = (fake, method, firstArg) => fake.calls.filter((call) => (
  call.method === method && (firstArg === undefined || call.args[0] === firstArg)
));

const listCount = (fake, path) => callsOf(fake, "list", path).length;

async function messageCount(db, accountId) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?",
    args: [accountId],
  });
  return Number(rows[0].n);
}

async function folderRows(db, accountId) {
  return listFolders(db, accountId);
}

const netError = () => new MailError("NETWORK", "ECONNRESET");

/** Park every adapter call until `release()`: a run the test can hold open and inspect. */
function holdCalls(gate) {
  let release = null;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  gate.hold = held;
  return () => {
    gate.hold = null;
    release();
  };
}

function deliver(fake, mailbox, subject) {
  return fake.deliver(mailbox, makeRaw({ subject }), { internalDate: T0 });
}

/* ------------------------------------------------------------------- constants */

test("backoffDelay doubles from five seconds with jitter and stops at fifteen minutes", () => {
  assert.equal(BACKOFF_BASE_MS, 5000);
  assert.equal(backoffDelay(1, () => 0.5), 5000);
  assert.equal(backoffDelay(2, () => 0.5), 10000);
  assert.equal(backoffDelay(3, () => 0.5), 20000);
  assert.equal(backoffDelay(30, () => 0.5), 15 * 60 * 1000);
  assert.equal(backoffDelay(1, () => 0), 4000);
  assert.equal(backoffDelay(1, () => 1), 6000);
  assert.equal(backoffDelay(0, () => 0.5), 5000);
  assert.deepEqual([...IDLE_ROLES], ["inbox", "sent"]);
  assert.equal(FAILURES_BEFORE_NOTICE, 5);
  assert.equal(NOTICE_GAP_MS, 24 * 3600 * 1000);
  assert.equal(CLAIM_REFRESH_MS, 24 * 3600 * 1000);
});

test("shouldRunMailSync follows the flag, noAuth and the disable switch", () => {
  assert.equal(shouldRunMailSync({ env: {} }), false);
  assert.equal(shouldRunMailSync({ env: { CROW_MAIL: "1" } }), true);
  assert.equal(shouldRunMailSync({ env: { CROW_MAIL: "1" }, noAuth: true }), false);
  assert.equal(shouldRunMailSync({ env: { CROW_MAIL: "1", CROW_DISABLE_MAIL_SYNC: "1" } }), false);
  assert.equal(shouldRunMailSync({ env: { CROW_DISABLE_MAIL_SYNC: "1" } }), false);
});

/* ----------------------------------------------------------------------- start */

test("start syncs every active account and watches only INBOX and Sent", async () => {
  const h = await setup({ start: false, extraAccounts: [{ address: "sam@example.com", label: "Sam" }] });
  deliver(h.fake, "INBOX", "hello");
  assert.equal(h.views.length, 0);

  await h.supervisor.start();

  assert.equal(h.views.length, 2);
  assert.equal(await messageCount(h.db, h.accountId), 1);
  const watches = callsOf(h.fake, "watch");
  assert.equal(watches.length, 2);
  for (const call of watches) assert.deepEqual(call.args[0], ["INBOX", "Sent"]);
  assert.equal((await h.supervisor.status(h.accountId)).watching, true);
  assert.equal((await h.supervisor.status(h.accountId)).running, false);
});

test("an account claimed elsewhere is marked and never started", async () => {
  const h = await setup({
    start: false,
    extraAccounts: [{ address: "sam@example.com", label: "Sam" }],
    isClaimedElsewhere: async (account) => account.address === "sam@example.com",
  });
  const other = h.extras[0];
  await h.supervisor.start();

  assert.equal((await getAccount(h.db, other.id)).status, "claimed_elsewhere");
  assert.equal((await getAccount(h.db, other.id)).statusDetail, null);
  assert.equal(h.views.length, 1);
  assert.equal(callsOf(h.fake, "watch").length, 1);
  assert.equal((await h.supervisor.status(h.accountId)).watching, true);
  assert.equal((await h.supervisor.status(other.id)).watching, false);
});

/* ------------------------------------------------------------- idle and polling */

test("an IDLE change syncs that folder only, and changes during a sync coalesce into one more run", async () => {
  const h = await setup();
  const inboxBefore = listCount(h.fake, "INBOX");
  const draftsBefore = listCount(h.fake, "Drafts");

  const release = holdCalls(h.gate);
  h.fake.emit("INBOX");
  await flush(20);
  // The run is parked on its first adapter call: two more reports must coalesce into one pass.
  assert.equal((await h.supervisor.status(h.accountId)).running, true);
  h.fake.emit("INBOX");
  h.fake.emit("INBOX", "exists");
  await flush(20);
  release();
  await flush(300);

  assert.equal(listCount(h.fake, "INBOX") - inboxBefore, 2);
  assert.equal(listCount(h.fake, "Drafts"), draftsBefore);
  assert.equal((await h.supervisor.status(h.accountId)).running, false);
});

test("the poll tick syncs the non-idle folders, and INBOX and Sent every second tick", async () => {
  const h = await setup();
  const start = {
    inbox: listCount(h.fake, "INBOX"),
    sent: listCount(h.fake, "Sent"),
    drafts: listCount(h.fake, "Drafts"),
    archive: listCount(h.fake, "Archive"),
  };

  await h.clock.advance(POLL_MS);
  assert.equal(listCount(h.fake, "Drafts"), start.drafts + 1);
  assert.equal(listCount(h.fake, "Archive"), start.archive + 1);
  assert.equal(listCount(h.fake, "INBOX"), start.inbox);
  assert.equal(listCount(h.fake, "Sent"), start.sent);

  await h.clock.advance(POLL_MS);
  assert.equal(listCount(h.fake, "Drafts"), start.drafts + 2);
  assert.equal(listCount(h.fake, "INBOX"), start.inbox + 1);
  assert.equal(listCount(h.fake, "Sent"), start.sent + 1);
});

/* ---------------------------------------------------------------- back-off ladder */

test("NETWORK failures back off 5, 10 and 20 seconds and a success resets the ladder", async () => {
  const h = await setup();
  const state = () => getSyncState(h.db, h.accountId);

  h.fake.failNext("listFolders", netError());
  await h.supervisor.syncNow(h.accountId);
  let current = await state();
  assert.equal(current.state, "backoff");
  assert.equal(current.errorCode, "NETWORK");
  assert.equal(current.failures, 1);
  assert.equal(current.backoffUntil, h.clock.now() + 5000);

  const viewsBefore = h.views.length;
  await h.clock.advance(BACKOFF_BASE_MS - 1);
  assert.equal(h.views.length, viewsBefore);
  assert.equal((await state()).failures, 1);

  h.fake.failNext("listFolders", netError());
  await h.clock.advance(1);
  current = await state();
  assert.equal(current.failures, 2);
  assert.equal(current.backoffUntil, h.clock.now() + 10000);

  h.fake.failNext("listFolders", netError());
  await h.clock.advance(10000);
  current = await state();
  assert.equal(current.failures, 3);
  assert.equal(current.backoffUntil, h.clock.now() + 20000);

  await h.clock.advance(20000);
  current = await state();
  assert.equal(current.state, "idle");
  assert.equal(current.errorCode, null);
  assert.equal(current.failures, 0);
  assert.equal(current.backoffUntil, null);
  assert.equal(current.lastSuccessAt, h.clock.now());
  assert.equal((await getAccount(h.db, h.accountId)).lastSyncAt, h.clock.now());
});

test("a lost watch backs off before reconnecting and never deletes or resets stored mail", async () => {
  const h = await setup({ start: false });
  deliver(h.fake, "INBOX", "keep me");
  await h.supervisor.start();
  const before = await folderRows(h.db, h.accountId);
  const inboxBefore = before.find((folder) => folder.path === "INBOX");
  assert.equal(await messageCount(h.db, h.accountId), 1);
  assert.equal(callsOf(h.fake, "watch").length, 1);

  h.fake.dropWatch();
  await flush();
  const state = await getSyncState(h.db, h.accountId);
  assert.equal(state.state, "backoff");
  assert.equal(state.failures, 1);
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);

  // Nothing stored was removed or reset while the watch was gone.
  assert.equal(await messageCount(h.db, h.accountId), 1);
  const after = (await folderRows(h.db, h.accountId)).find((folder) => folder.path === "INBOX");
  assert.deepEqual(after, inboxBefore);

  const viewsBefore = h.views.length;
  await h.clock.advance(BACKOFF_BASE_MS - 1);
  assert.equal(h.views.length, viewsBefore);
  assert.equal(callsOf(h.fake, "watch").length, 1);

  await h.clock.advance(1);
  assert.equal(h.views.length, viewsBefore + 1);
  assert.equal(callsOf(h.fake, "watch").length, 2);
  assert.equal((await h.supervisor.status(h.accountId)).watching, true);
  assert.equal(await messageCount(h.db, h.accountId), 1);
  assert.equal((await getSyncState(h.db, h.accountId)).state, "idle");
});

/* ----------------------------------------------------------------------- auth */

test("AUTH_FAILED marks the account, notices once, stops retrying, and syncNow resumes it", async () => {
  const h = await setup();
  h.fake.failNext("listFolders", new MailError("AUTH_FAILED"));
  await h.supervisor.syncNow(h.accountId);

  const account = await getAccount(h.db, h.accountId);
  assert.equal(account.status, "auth_failed");
  assert.equal(account.statusDetail, "AUTH_FAILED");
  const state = await getSyncState(h.db, h.accountId);
  assert.equal(state.state, "auth_failed");
  assert.equal(state.errorCode, "AUTH_FAILED");
  assert.equal(state.backoffUntil, null);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].title, "Crow Mail cannot sign in");
  assert.equal(h.notices[0].body, 'Crow could not sign in to "Alex". Check the app password.');
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);

  const viewsBefore = h.views.length;
  await h.clock.advance(POLL_MS * 3);
  assert.equal(h.views.length, viewsBefore);

  await h.supervisor.syncNow(h.accountId);
  assert.equal((await getAccount(h.db, h.accountId)).status, "active");
  assert.equal((await getSyncState(h.db, h.accountId)).state, "idle");
  assert.equal(h.notices.length, 1);
  assert.equal((await h.supervisor.status(h.accountId)).watching, true);
});

/* -------------------------------------------------------------------- notices */

test("the fifth failure notices once, the sixth does not, and a new supervisor within a day stays quiet", async () => {
  const h = await setup();
  const state = () => getSyncState(h.db, h.accountId);

  h.fake.failNext("listFolders", netError());
  await h.supervisor.syncNow(h.accountId);
  assert.equal((await state()).failures, 1);
  assert.equal(h.notices.length, 0);

  for (const delay of [5000, 10000, 20000, 40000]) {
    h.fake.failNext("listFolders", netError());
    await h.clock.advance(delay);
  }
  assert.equal((await state()).failures, FAILURES_BEFORE_NOTICE);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].title, "Mail sync is failing");
  assert.equal(h.notices[0].body, 'Crow cannot sync "Alex" right now. It will keep trying.');
  assert.equal((await state()).lastNoticeAt, h.clock.now());

  h.fake.failNext("listFolders", netError());
  await h.clock.advance(80000);
  assert.equal((await state()).failures, 6);
  assert.equal(h.notices.length, 1);

  // A restarted supervisor resumes the same ladder and the same notice gap.
  const laterNotices = [];
  const second = createMailSupervisor({
    db: h.db,
    credentials: h.credentials,
    adapterFactory: h.factory,
    now: h.clock.now,
    setTimer: h.clock.setTimer,
    clearTimer: h.clock.clearTimer,
    random: () => 0.5,
    notify: async (title, body) => { laterNotices.push({ title, body }); },
    log: () => {},
  });
  h.fake.failNext("listFolders", netError());
  await second.syncNow(h.accountId);
  assert.equal((await state()).failures, 7);
  assert.equal(laterNotices.length, 0);
  await second.stop();
});

/* ------------------------------------------------------------- one run, or none */

test("a second syncNow during a run joins it: one connection, no overlapping passes, one rerun", async () => {
  const h = await setup();
  const listsBefore = callsOf(h.fake, "listFolders").length;

  const release = holdCalls(h.gate);
  const first = h.supervisor.syncNow(h.accountId);
  await flush(20);
  assert.equal((await h.supervisor.status(h.accountId)).running, true);
  const second = h.supervisor.syncNow(h.accountId);
  await flush(20);
  release();
  await Promise.all([first, second]);
  await flush(300);

  // The joined run and exactly one more full pass — never two at once, and only one connection.
  assert.equal(callsOf(h.fake, "listFolders").length - listsBefore, 2);
  assert.equal(h.views.length, 1);
  assert.equal((await h.supervisor.status(h.accountId)).running, false);
});

test("a syncNow during a requestSync run joins it and causes exactly one full rerun", async () => {
  const h = await setup();
  const folders = await folderRows(h.db, h.accountId);
  const drafts = folders.find((folder) => folder.path === "Drafts");
  const listsBefore = callsOf(h.fake, "listFolders").length;
  const draftsBefore = listCount(h.fake, "Drafts");

  h.gate.delay = 0;
  const release = holdCalls(h.gate);
  const folderRun = h.supervisor.requestSync(h.accountId, { folderIds: [drafts.id] });
  await flush(20);
  assert.equal((await h.supervisor.status(h.accountId)).running, true);
  const joined = h.supervisor.syncNow(h.accountId);
  await flush(20);
  release();
  await joined;
  await flush(300);

  // The folder run listed Drafts once, and the full rerun listed every folder — including Drafts.
  assert.equal(listCount(h.fake, "Drafts"), draftsBefore + 2);
  assert.equal(callsOf(h.fake, "listFolders").length - listsBefore, 1);
  await folderRun;
});

test("three requests during one run coalesce into exactly one rerun", async () => {
  const h = await setup();
  const folders = await folderRows(h.db, h.accountId);
  const drafts = folders.find((folder) => folder.path === "Drafts");
  const inbox = folders.find((folder) => folder.path === "INBOX");
  const listsBefore = callsOf(h.fake, "listFolders").length;

  const release = holdCalls(h.gate);
  const first = h.supervisor.requestSync(h.accountId, { folderIds: [drafts.id] });
  await flush(20);
  assert.equal((await h.supervisor.status(h.accountId)).running, true);
  const rest = [
    h.supervisor.requestSync(h.accountId, { folderIds: [inbox.id] }),
    h.supervisor.syncNow(h.accountId),
    h.supervisor.requestSync(h.accountId),
  ];
  await flush(20);
  release();
  await Promise.all([first, ...rest]);
  await flush(300);

  assert.equal(callsOf(h.fake, "listFolders").length - listsBefore, 1);
  assert.equal((await h.supervisor.status(h.accountId)).running, false);
});

test("noteChange nudges only a running sync, and exactly once", async () => {
  const h = await setup();
  const listsBefore = callsOf(h.fake, "listFolders").length;

  h.supervisor.noteChange(h.accountId);
  await flush(60);
  assert.equal(callsOf(h.fake, "listFolders").length, listsBefore);

  const release = holdCalls(h.gate);
  const run = h.supervisor.syncNow(h.accountId);
  await flush(20);
  assert.equal((await h.supervisor.status(h.accountId)).running, true);
  h.supervisor.noteChange(h.accountId);
  h.supervisor.noteChange(h.accountId);
  release();
  await run;
  await flush(300);

  assert.equal(callsOf(h.fake, "listFolders").length - listsBefore, 2);
});

test("requestSync with folder ids syncs only those folders", async () => {
  const h = await setup();
  const folders = await folderRows(h.db, h.accountId);
  const drafts = folders.find((folder) => folder.path === "Drafts");
  const draftsBefore = listCount(h.fake, "Drafts");
  const inboxBefore = listCount(h.fake, "INBOX");
  const sentBefore = listCount(h.fake, "Sent");

  await h.supervisor.requestSync(h.accountId, { folderIds: [drafts.id] });

  assert.equal(listCount(h.fake, "Drafts"), draftsBefore + 1);
  assert.equal(listCount(h.fake, "INBOX"), inboxBefore);
  assert.equal(listCount(h.fake, "Sent"), sentBefore);
});

/* -------------------------------------------------------------------- deadline */

test("a hung list hits the deadline timer, records TIMEOUT and lets a later syncNow run", async () => {
  const h = await setup();
  h.fake.hangNext("list");
  const run = h.supervisor.syncNow(h.accountId);
  await flush(8);
  assert.equal((await h.supervisor.status(h.accountId)).running, true);

  await h.clock.advance(SYNC_DEADLINE_MS);
  await run;

  const state = await getSyncState(h.db, h.accountId);
  assert.equal(state.state, "backoff");
  assert.equal(state.errorCode, "TIMEOUT");
  assert.equal(state.failures, 1);
  assert.equal(state.backoffUntil, h.clock.now() + 5000);
  const status = await h.supervisor.status(h.accountId);
  assert.equal(status.running, false);
  // The adapter the hung call was using was closed, so nothing is left holding the socket.
  assert.equal(h.views.at(-1).state.closed, true);

  const listsBefore = callsOf(h.fake, "listFolders").length;
  await h.supervisor.syncNow(h.accountId);
  assert.ok(callsOf(h.fake, "listFolders").length > listsBefore);
  assert.equal((await getSyncState(h.db, h.accountId)).state, "idle");
});

test("a requestSync run carries the deadline too: a hung list is a TIMEOUT and clears the entry", async () => {
  const h = await setup();
  const folders = await folderRows(h.db, h.accountId);
  const drafts = folders.find((folder) => folder.path === "Drafts");
  h.fake.hangNext("list");

  const run = h.supervisor.requestSync(h.accountId, { folderIds: [drafts.id] });
  await flush(8);
  assert.equal((await h.supervisor.status(h.accountId)).running, true);
  await h.clock.advance(SYNC_DEADLINE_MS);
  await run;

  const state = await getSyncState(h.db, h.accountId);
  assert.equal(state.errorCode, "TIMEOUT");
  assert.equal(state.state, "backoff");
  assert.equal((await h.supervisor.status(h.accountId)).running, false);
});

/* --------------------------------------------------------------------- claims */

test("refreshClaim runs at start and again after a day, never for a claimed account", async () => {
  const refreshed = [];
  const h = await setup({
    start: false,
    extraAccounts: [{ address: "sam@example.com", label: "Sam" }],
    isClaimedElsewhere: async (account) => account.address === "sam@example.com",
    refreshClaim: async (account) => { refreshed.push(account.id); },
  });
  await h.supervisor.start();
  // Both accounts are stored active at start, so both get their claim rewritten once.
  const claimedId = h.extras[0].id;
  const spent = (id) => refreshed.filter((entry) => entry === id).length;
  assert.equal(refreshed.length, 2);
  assert.equal(spent(h.accountId), 1);
  assert.equal(spent(claimedId), 1);

  await h.clock.advance(POLL_MS * 4);
  assert.equal(refreshed.length, 2);

  // A day later the claimed account is skipped: only the account this instance owns is refreshed.
  await h.clock.advance(CLAIM_REFRESH_MS - POLL_MS * 4);
  assert.equal(refreshed.length, 3);
  assert.equal(spent(h.accountId), 2);
  assert.equal(spent(claimedId), 1);
});

test("a claim lost at start starts nothing, and one lost on a tick stops the worker until it clears", async () => {
  let claimed = true;
  const h = await setup({ start: false, isClaimedElsewhere: async () => claimed });

  await h.supervisor.start();
  assert.equal((await getAccount(h.db, h.accountId)).status, "claimed_elsewhere");
  assert.equal(h.views.length, 0);
  assert.equal(callsOf(h.fake, "watch").length, 0);
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);

  // The claim clears: the global tick brings the account back.
  claimed = false;
  await h.clock.advance(POLL_MS);
  assert.equal((await getAccount(h.db, h.accountId)).status, "active");
  assert.equal(h.views.length, 1);
  assert.equal(callsOf(h.fake, "watch").length, 1);

  // Lost on a tick: the watcher and the connection go, and no further sync happens.
  claimed = true;
  await h.clock.advance(POLL_MS);
  assert.equal((await getAccount(h.db, h.accountId)).status, "claimed_elsewhere");
  assert.equal(h.views[0].state.closed, true);
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);
  const listsBefore = callsOf(h.fake, "listFolders").length;
  await h.clock.advance(POLL_MS * 2);
  assert.equal(callsOf(h.fake, "listFolders").length, listsBefore);

  // And back again when it clears.
  claimed = false;
  await h.clock.advance(POLL_MS);
  assert.equal((await getAccount(h.db, h.accountId)).status, "active");
  assert.ok(callsOf(h.fake, "listFolders").length > listsBefore);
});

/* -------------------------------------------------------------------- actions */

test("withAdapter runs calls one at a time and reuses one kept adapter until the keep time", async () => {
  const h = await setup();
  const viewsBefore = h.views.length;
  const order = [];
  let go = null;
  const blocker = new Promise((resolve) => {
    go = resolve;
  });

  const first = h.supervisor.withAdapter(h.accountId, async (adapter) => {
    order.push("first-in");
    await blocker;
    order.push("first-out");
    return adapter.listFolders();
  });
  const second = h.supervisor.withAdapter(h.accountId, async (adapter) => {
    order.push("second-in");
    return adapter.listFolders();
  });
  await flush(40);
  // One call at a time for one account: the second waits for the first.
  assert.deepEqual(order, ["first-in"]);
  assert.equal(h.views.length, viewsBefore + 1);
  go();
  const results = await Promise.all([first, second]);
  assert.deepEqual(order, ["first-in", "first-out", "second-in"]);

  // One connection served both: the second call reused the kept adapter.
  assert.equal(h.views.length, viewsBefore + 1);
  assert.deepEqual(results[0], results[1]);
  const action = h.views.at(-1);
  assert.equal(action.state.closed, false);

  await h.clock.advance(ACTION_IDLE_KEEP_MS - 1);
  assert.equal(action.state.closed, false);
  await h.clock.advance(1);
  assert.equal(action.state.closed, true);

  // A call after the keep time opens a new connection.
  await h.supervisor.withAdapter(h.accountId, (adapter) => adapter.listFolders());
  assert.equal(h.views.length, viewsBefore + 2);
});

test("withAdapter closes the adapter at once when the call fails, and rethrows a MailError", async () => {
  const h = await setup();
  let captured = null;
  await assert.rejects(
    h.supervisor.withAdapter(h.accountId, (adapter) => {
      captured = adapter;
      throw Object.assign(new Error("secret-text"), { code: "ECONNRESET" });
    }),
    (err) => {
      assert.ok(err instanceof MailError);
      assert.equal(err.code, "NETWORK");
      assert.equal(err.message.includes("secret-text"), false);
      return true;
    },
  );
  assert.equal(captured.state.closed, true);
});

test("withAdapter times out a hung call, closes the adapter and rejects TIMEOUT", async () => {
  const h = await setup();
  let captured = null;
  const call = h.supervisor.withAdapter(h.accountId, (adapter) => {
    captured = adapter;
    adapter.hangNext("listFolders");
    return adapter.listFolders();
  });
  await flush(4);
  await h.clock.advance(ACTION_DEADLINE_MS);

  const err = await call.then(() => null, (rejection) => rejection);
  assert.ok(err instanceof MailError);
  assert.equal(err.code, "TIMEOUT");
  assert.equal(err.detail, "action_deadline");
  assert.equal(captured.state.closed, true);
});

test("withAdapter refuses a claimed or signed-out account without building an adapter", async () => {
  const h = await setup();
  const viewsBefore = h.views.length;

  await updateAccount(h.db, h.accountId, { status: "claimed_elsewhere", statusDetail: null });
  await assert.rejects(
    h.supervisor.withAdapter(h.accountId, () => { throw new Error("must not run"); }),
    (err) => err.code === "CLAIMED_ELSEWHERE",
  );

  await updateAccount(h.db, h.accountId, { status: "auth_failed", statusDetail: "AUTH_FAILED" });
  await assert.rejects(
    h.supervisor.withAdapter(h.accountId, () => { throw new Error("must not run"); }),
    (err) => err.code === "AUTH_FAILED",
  );

  assert.equal(h.views.length, viewsBefore);
});

test("restartAccount drops both adapters and the next factory call sees the new secret", async () => {
  const h = await setup();
  let action = null;
  await h.supervisor.withAdapter(h.accountId, (adapter) => {
    action = adapter;
    return adapter.listFolders();
  });
  const worker = h.views[0];
  assert.equal(h.secrets.at(-1), "first-secret");

  h.box.password = "second-secret";
  await h.supervisor.restartAccount(h.accountId);
  await flush(100);

  assert.equal(action.state.closed, true);
  assert.equal(worker.state.closed, true);
  assert.equal(h.secrets.at(-1), "second-secret");
  assert.equal((await h.supervisor.status(h.accountId)).watching, true);
});

/* ------------------------------------------------------------------ no leakage */

test("start never throws: a factory that cannot connect is a code in the log and a back-off", async () => {
  const h = await setup({
    start: false,
    adapterFactory: async () => {
      throw Object.assign(new Error("secret-text"), { code: "ECONNREFUSED" });
    },
  });
  await h.supervisor.start();

  const state = await getSyncState(h.db, h.accountId);
  assert.equal(state.state, "backoff");
  assert.equal(state.errorCode, "NETWORK");
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);
  assert.equal(JSON.stringify(h.logs).includes("secret-text"), false);
  assert.equal((await getAccount(h.db, h.accountId)).status, "active");
});

test("no library text reaches a log line, the sync state, status_detail or a notice", async () => {
  const h = await setup();
  const secret = "secret-text";

  // A library-shaped failure raised inside a borrowed adapter's call.
  await assert.rejects(
    h.supervisor.withAdapter(h.accountId, () => {
      throw Object.assign(new Error(secret), { code: "ECONNRESET" });
    }),
    (err) => err.code === "NETWORK",
  );

  const original = h.fake.listFolders;
  h.fake.listFolders = async () => {
    throw Object.assign(new Error(secret), { authenticationFailed: true });
  };
  await h.supervisor.syncNow(h.accountId);
  h.fake.listFolders = original;

  const account = await getAccount(h.db, h.accountId);
  const state = await getSyncState(h.db, h.accountId);
  assert.equal(account.statusDetail, "AUTH_FAILED");
  assert.equal(state.errorCode, "AUTH_FAILED");
  assert.equal(state.state, "auth_failed");
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].body, 'Crow could not sign in to "Alex". Check the app password.');

  const logged = JSON.stringify(h.logs);
  assert.equal(logged.includes(secret), false);
  assert.equal(JSON.stringify({ account, state, notices: h.notices }).includes(secret), false);
  for (const line of h.logs) {
    if ("code" in line) assert.match(String(line.code), /^[A-Z][A-Z_]+$/);
  }
});

/* ----------------------------------------------------------------------- stop */

test("stop clears every timer, stops the watcher and closes every adapter, twice over", async () => {
  const h = await setup();
  await h.supervisor.withAdapter(h.accountId, (adapter) => adapter.listFolders());
  const action = h.views.at(-1);
  assert.ok(h.clock.pending() > 0);

  await h.supervisor.stop();
  assert.equal(h.clock.pending(), 0);
  assert.equal(action.state.closed, true);
  assert.equal(h.views[0].state.closed, true);
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);
  assert.equal((await h.supervisor.status(h.accountId)).running, false);

  await h.supervisor.stop();
  assert.equal(h.clock.pending(), 0);
});

/* --------------------------------------------- after stop() nothing opens (S1) */

test("after stop() syncNow, requestSync and restartAccount open nothing and withAdapter is refused", async () => {
  let inner = null;
  let opened = 0;
  const h = await setup({
    start: false,
    adapterFactory: async (args) => {
      opened += 1;
      return inner(args);
    },
  });
  inner = h.factory;
  await h.supervisor.start();
  const before = opened;
  assert.equal(before, 1);

  await h.supervisor.stop();
  await h.supervisor.syncNow(h.accountId);
  await h.supervisor.requestSync(h.accountId);
  await h.supervisor.restartAccount(h.accountId);
  await assert.rejects(
    h.supervisor.withAdapter(h.accountId, () => {
      throw new Error("must not run");
    }),
    (err) => {
      assert.ok(err instanceof MailError);
      assert.equal(err.code, "NETWORK");
      assert.equal(err.detail, "stopped");
      return true;
    },
  );
  // A late open would land here: give every pending promise room to misbehave.
  await flush(60);

  assert.equal(opened, before);
  assert.equal(h.views.length, before);
  assert.equal((await getSyncState(h.db, h.accountId)).state, "idle");
});

test("stop() during ensureWatch stops the watcher it was arming and keeps no connection", async () => {
  let inner = null;
  let watchEntered = false;
  let lateWatcherStopped = false;
  let releaseWatch = null;
  const watchGate = new Promise((resolve) => {
    releaseWatch = resolve;
  });
  const h = await setup({
    start: false,
    adapterFactory: async (args) => {
      const view = await inner(args);
      view.watch = async (paths, handlers) => {
        watchEntered = true;
        await watchGate;
        const watcher = await h.fake.watch(paths, handlers);
        return {
          stop() {
            lateWatcherStopped = true;
            watcher.stop();
          },
        };
      };
      return view;
    },
  });
  inner = h.factory;

  const starting = h.supervisor.start();
  await flush(100);
  assert.equal(watchEntered, true);
  assert.equal(h.views.length, 1);

  await h.supervisor.stop();
  releaseWatch();
  await starting;
  await flush(100);

  assert.equal(lateWatcherStopped, true);
  assert.equal(h.views[0].state.closed, true);
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);
  assert.equal(h.clock.pending(), 0);
});

/* -------------------------------------- restartAccount prepares like syncNow (S2) */

test("restartAccount on an account that is still claimed elsewhere syncs nothing", async () => {
  const h = await setup({ start: false, isClaimedElsewhere: async () => true });
  await h.supervisor.start();
  assert.equal((await getAccount(h.db, h.accountId)).status, "claimed_elsewhere");
  assert.equal(h.views.length, 0);

  // Nothing to do, and nothing thrown: the claim is re-checked, not assumed.
  await h.supervisor.restartAccount(h.accountId);
  await flush(40);

  assert.equal(h.views.length, 0);
  assert.equal(callsOf(h.fake, "listFolders").length, 0);
  assert.equal((await getAccount(h.db, h.accountId)).status, "claimed_elsewhere");
});

test("restartAccount retries a signed-out account with the new password and marks it active", async () => {
  const h = await setup();
  h.fake.failNext("listFolders", new MailError("AUTH_FAILED"));
  await h.supervisor.syncNow(h.accountId);
  assert.equal((await getAccount(h.db, h.accountId)).status, "auth_failed");
  const viewsBefore = h.views.length;

  // The owner re-entered the app password: a restart is the password-change path.
  h.box.password = "second-secret";
  await h.supervisor.restartAccount(h.accountId);
  await flush(100);

  assert.equal(h.views.length, viewsBefore + 1);
  assert.equal(h.secrets.at(-1), "second-secret");
  const account = await getAccount(h.db, h.accountId);
  assert.equal(account.status, "active");
  assert.equal(account.statusDetail, null);
  const state = await getSyncState(h.db, h.accountId);
  assert.equal(state.state, "idle");
  assert.equal(state.errorCode, null);
  assert.equal(state.failures, 0);
  assert.equal(state.backoffUntil, null);
  assert.equal((await h.supervisor.status(h.accountId)).watching, true);
});

/* ----------------------------------- every non-auth code takes the ladder (S3) */

test("a BAD_INPUT failure backs off, notices at the threshold, and IDLE is re-armed afterwards", async () => {
  const h = await setup();
  const folders = await folderRows(h.db, h.accountId);
  const drafts = folders.find((folder) => folder.path === "Drafts");
  const state = () => getSyncState(h.db, h.accountId);
  const watchBefore = callsOf(h.fake, "watch").length;
  const badInput = () => new MailError("BAD_INPUT", "window_days");
  const runFolder = (folderId) => h.supervisor.requestSync(h.accountId, { folderIds: [folderId] });

  // A code the ladder never singled out: the server refuses the folder listing's shape.
  h.fake.failNext("list", badInput());
  await runFolder(drafts.id);
  let current = await state();
  assert.equal(current.state, "backoff");
  assert.equal(current.errorCode, "BAD_INPUT");
  assert.equal(current.failures, 1);
  assert.equal(current.backoffUntil, h.clock.now() + 5000);
  // The failed run closed the connection it had and dropped the watch it carried.
  assert.equal(h.views.at(-1).state.closed, true);
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    h.fake.failNext("list", badInput());
    await runFolder(drafts.id);
  }
  current = await state();
  assert.equal(current.errorCode, "BAD_INPUT");
  assert.equal(current.failures, FAILURES_BEFORE_NOTICE);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].title, "Mail sync is failing");
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);

  // The ladder's next retry (a full sync) succeeds: the watch comes back on its own.
  await h.clock.advance(80000);
  current = await state();
  assert.equal(current.state, "idle");
  assert.equal(current.failures, 0);
  assert.equal((await h.supervisor.status(h.accountId)).watching, true);
  assert.equal(callsOf(h.fake, "watch").length, watchBefore + 1);
});

/* ---------------------------------- a late connection is never adopted (S4) */

test("a connection that lands after the run timed out is closed, never adopted", async () => {
  let inner = null;
  let firstCall = true;
  let releaseLate = null;
  const lateGate = new Promise((resolve) => {
    releaseLate = resolve;
  });
  const h = await setup({
    start: false,
    adapterFactory: async (args) => {
      if (firstCall) {
        firstCall = false;
        await lateGate;
      }
      return inner(args);
    },
  });
  inner = h.factory;

  const runA = h.supervisor.syncNow(h.accountId);
  await flush(20);
  // A's handshake never lands: the deadline closes the run out from under it.
  await h.clock.advance(SYNC_DEADLINE_MS);
  await runA;
  assert.equal((await getSyncState(h.db, h.accountId)).errorCode, "TIMEOUT");

  // Now A finally connects, with nobody waiting for it: it is closed, not kept.
  releaseLate();
  await flush(120);
  assert.equal(h.views.length, 1);
  assert.equal(h.views[0].state.closed, true);
  assert.equal((await h.supervisor.status(h.accountId)).watching, false);

  // The next run builds its own connection instead of inheriting the abandoned one.
  await h.supervisor.syncNow(h.accountId);
  assert.equal(h.views.length, 2);
  assert.equal(h.views.at(-1).state.closed, false);
  await h.supervisor.stop();
});

test("a late-connecting adapter from a timed-out run replaces and closes nothing", async () => {
  let inner = null;
  let firstCall = true;
  let releaseLate = null;
  const lateGate = new Promise((resolve) => {
    releaseLate = resolve;
  });
  const h = await setup({
    start: false,
    adapterFactory: async (args) => {
      if (firstCall) {
        firstCall = false;
        await lateGate;
      }
      return inner(args);
    },
  });
  inner = h.factory;

  const runA = h.supervisor.syncNow(h.accountId);
  await flush(20);
  // A's handshake never lands: the deadline closes the run out from under it.
  await h.clock.advance(SYNC_DEADLINE_MS);
  await runA;
  assert.equal((await getSyncState(h.db, h.accountId)).errorCode, "TIMEOUT");

  // A later run opens B and keeps it.
  await h.supervisor.syncNow(h.accountId);
  assert.equal(h.views.length, 1);
  const adapterB = h.views[0];
  assert.equal(adapterB.state.closed, false);

  // Now A finally connects. It must be closed, and B must be untouched and still the worker's.
  releaseLate();
  await flush(120);

  assert.equal(h.views.length, 2);
  assert.notEqual(h.views.at(-1), adapterB);
  assert.equal(h.views.at(-1).state.closed, true);
  assert.equal(adapterB.state.closed, false);
  assert.equal((await h.supervisor.status(h.accountId)).watching, true);
  await h.supervisor.stop();
});

/* -------------------------------- the action deadline covers the connect (S5) */

test("withAdapter times out a hanging connect and the next call proceeds", async () => {
  let inner = null;
  let firstCall = true;
  let releaseOpen = null;
  const openGate = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  const h = await setup({
    start: false,
    adapterFactory: async (args) => {
      if (firstCall) {
        firstCall = false;
        await openGate;
      }
      return inner(args);
    },
  });
  inner = h.factory;

  let ran = false;
  const call = h.supervisor.withAdapter(h.accountId, () => {
    ran = true;
  });
  await flush(20);
  await h.clock.advance(ACTION_DEADLINE_MS);

  const err = await call.then(() => null, (rejection) => rejection);
  assert.ok(err instanceof MailError);
  assert.equal(err.code, "TIMEOUT");
  assert.equal(err.detail, "action_deadline");
  assert.equal(ran, false);

  // The account's queue was released: the next call connects and runs at once.
  const kept = await h.supervisor.withAdapter(h.accountId, (adapter) => adapter.listFolders());
  assert.ok(Array.isArray(kept));
  assert.equal(h.views.length, 1);
  const keptView = h.views[0];
  assert.equal(keptView.state.closed, false);

  // The connection the abandoned call finally got is closed, and the kept one is not.
  releaseOpen();
  await flush(120);
  assert.equal(h.views.length, 2);
  assert.equal(h.views.at(-1).state.closed, true);
  assert.equal(keptView.state.closed, false);
  await h.supervisor.stop();
});

/* --------------------------------------- the auth notice has its own gate (S6) */

test("a failing-sync notice does not silence the AUTH_FAILED notice that follows it", async () => {
  const h = await setup();

  h.fake.failNext("listFolders", netError());
  await h.supervisor.syncNow(h.accountId);
  for (const delay of [5000, 10000, 20000, 40000]) {
    h.fake.failNext("listFolders", netError());
    await h.clock.advance(delay);
  }
  let state = await getSyncState(h.db, h.accountId);
  assert.equal(state.failures, FAILURES_BEFORE_NOTICE);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].title, "Mail sync is failing");
  const firstNoticeAt = state.lastNoticeAt;

  // The next attempt is refused on the credential, minutes after the failing-sync notice.
  h.fake.failNext("listFolders", new MailError("AUTH_FAILED"));
  await h.clock.advance(80000);

  assert.equal((await getAccount(h.db, h.accountId)).status, "auth_failed");
  assert.equal(h.notices.length, 2);
  assert.equal(h.notices[1].title, "Crow Mail cannot sign in");
  state = await getSyncState(h.db, h.accountId);
  assert.equal(state.state, "auth_failed");
  assert.ok(state.lastNoticeAt > firstNoticeAt);
});

/* --------------------------------------------------- start: back-off and speed (M) */

test("a persisted backoff_until in the future delays the first sync after start", async () => {
  const h = await setup({ start: false });
  await setSyncState(h.db, h.accountId, {
    state: "backoff",
    errorCode: "NETWORK",
    failures: 3,
    backoffUntil: T0 + 60000,
  });

  await h.supervisor.start();
  assert.equal(h.views.length, 0);
  assert.equal((await h.supervisor.status(h.accountId)).running, false);

  await h.clock.advance(59999);
  assert.equal(h.views.length, 0);

  await h.clock.advance(1);
  assert.equal(h.views.length, 1);
  const state = await getSyncState(h.db, h.accountId);
  assert.equal(state.state, "idle");
  assert.equal(state.failures, 0);
  assert.equal(state.backoffUntil, null);
  await h.supervisor.stop();
});

test("start() starts every account at once: a hung server does not delay the others", async () => {
  let inner = null;
  let others = new Set();
  const never = new Promise(() => {});
  const h = await setup({
    start: false,
    extraAccounts: [{ address: "sam@example.com", label: "Sam" }],
    adapterFactory: async (args) => {
      if (others.has(args.account.id)) await never;
      return inner(args);
    },
  });
  inner = h.factory;
  // Every account but the one start() reaches last hangs: a start that worked through the list one
  // account at a time would never reach the last one.
  const order = (await listAccounts(h.db)).map((account) => account.id);
  const lastId = order.at(-1);
  others = new Set(order.slice(0, -1));
  assert.equal(order.length, 2);

  const starting = h.supervisor.start();
  await flush(300);

  // The last account synced and is watching while the servers before it have not answered at all.
  const lastState = await getSyncState(h.db, lastId);
  assert.equal(lastState?.state, "idle");
  assert.equal(lastState?.lastSuccessAt, T0);
  assert.equal((await h.supervisor.status(lastId)).watching, true);
  assert.equal(callsOf(h.fake, "watch").length, 1);
  for (const hungId of others) {
    assert.equal((await h.supervisor.status(hungId)).running, true);
  }

  await h.supervisor.stop();
  await flush(20);
  // The hung runs are closed out; start() itself is still parked on the server that never answers.
  for (const hungId of others) {
    assert.equal((await h.supervisor.status(hungId)).running, false);
  }
  starting.catch(() => {});
});