// Crow Mail's message action routes (plan 2, Task 12): read/unread, archive, delete to Trash and move,
// as `POST /dashboard/mail/api/messages/:id/actions`.
//
// Harness: Task 19's (tests/mail-api-messages.test.js) — a real init-db'd scratch crow.db copied per
// test (CROW_DATA_DIR, so nothing can touch ~/.crow), an ephemeral express app wired the way
// servers/gateway/index.js and dashboard/index.js wire it (the global 1mb JSON parser skipped by
// index.js's own `_hasOwnParser` predicate, read from its source; then a session stub, the dashboard's
// real CSRF middleware, then the real mail API router), the real account, folder and message stores,
// a fake mail adapter behind a recording supervisor, and the real owner rule with the request marked
// as coming from the owner's laptop (tests/helpers/off-box.js).
//
// Four tests drive plan 1's REAL supervisor (createMailSupervisor) over the same fake mailbox, with a
// clock whose timers the test fires by hand: the noteChange rerun, a move that lands while a sync of
// its source folder is in flight, the destination-folder-only sync, and `withAdapter`'s one-call-at-a-
// time queue with its kept-then-closed connection.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";

const root = mkdtempSync(join(tmpdir(), "mail-api-actions-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { default: express, json: expressJson } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { mailApiRouter, clearMailApiRuntime, MAIL_API_PREFIX } = await import("../servers/gateway/routes/mail-api.js");
const { MAIL_ERROR_TEXT, MailError } = await import("../servers/gateway/mail/errors.js");
const { createAccount } = await import("../servers/gateway/mail/store/accounts.js");
const {
  getMessage,
  listFolders,
  setFolderSyncState,
  upsertFolders,
  upsertMessage,
} = await import("../servers/gateway/mail/store/messages.js");
const {
  ACTION_IDLE_KEEP_MS,
  createMailSupervisor,
} = await import("../servers/gateway/mail/sync/supervisor.js");
const { createFakeMailAdapter } = await import("./fixtures/fake-mail-adapter.mjs");
const { makeRaw } = await import("./fixtures/fake-mail-server.mjs");

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
// The CSRF token is SERVER-BOUND (queue item #51 PR-1): HMAC(secret, session id).
const { csrfTokenForSession } = await import("../servers/gateway/dashboard/shared/csrf.js");
const CSRF = csrfTokenForSession(OWNER);

const MESSAGES = `${MAIL_API_PREFIX}/messages`;
const actionPath = (id) => `${MESSAGES}/${id}/actions`;

/** The fake adapter's mailbox folders and the UIDVALIDITY it holds for each (base 71, in its order). */
const FAKE_VALIDITY = Object.freeze({ INBOX: 71, Sent: 72, Drafts: 73, Archive: 74 });

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

const open = [];
const servers = [];
after(() => {
  clearMailApiRuntime();
  for (const s of servers) s.close();
  for (const c of open) { try { c.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master") },
    stdio: "pipe",
    cwd: REPO,
  });
  const raw = new Database(MASTER);
  const insert = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))");
  insert.run(hashToken(OWNER), "dashboard");
  insert.run(hashToken(SSO), "dashboard sso src:peer-1");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
});

beforeEach(() => {
  clearMailApiRuntime();
  process.env.CROW_MAIL = "1";
});

/* ------------------------------------------------------------------ plumbing */

/** Let every pending promise, db call and timer callback settle. */
async function flush(rounds = 60) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A clock whose timers only fire when the test advances it. */
function makeClock(start = Date.now()) {
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

/** Wait until `predicate()` holds: a run's in-flight window is the point of an assertion. */
async function waitFor(predicate, label) {
  for (let i = 0; i < 1000; i += 1) {
    if (await predicate()) return;
    await flush(2);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Capture console.warn while `fn` runs: a log line must carry no value. */
async function warnings(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  try {
    return { lines, result: await fn() };
  } finally {
    console.warn = original;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

let server = null;

/** One request. `csrf: null` sends no CSRF header; `laptop: false` leaves the request looking local. */
function call(method, path, { body, headers = {}, token = OWNER, csrf = csrfTokenForSession(token), laptop = true } = {}) {
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const h = { ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) };
  if (token) h.cookie = "crow_session=" + token;
  if (token && csrf) h["x-crow-csrf"] = csrf;
  if (laptop) h["x-test-from"] = "laptop";
  Object.assign(h, headers);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: h }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(payload === null ? undefined : payload);
  });
}

const post = (path, body, opts) => call("POST", path, { body, ...opts });

/* ----------------------------------------------------------------- setup */

let n = 0;

/**
 * A supervisor that hands the fake adapter of one account to `fn`, records its own calls, and mirrors
 * plan 1's one rule for `noteChange`: it marks a rerun only while a run is in flight.
 */
function makeSupervisor(adapterFor) {
  const calls = [];
  const state = { inflight: false, reruns: 0 };
  return {
    calls,
    state,
    async syncNow(accountId) { calls.push(["syncNow", accountId]); },
    async restartAccount(accountId) { calls.push(["restartAccount", accountId]); },
    async requestSync(accountId, options) {
      calls.push(["requestSync", accountId, Array.isArray(options?.folderIds) ? options.folderIds : null]);
    },
    noteChange(accountId) {
      calls.push(["noteChange", accountId]);
      if (state.inflight) state.reruns += 1;
    },
    async withAdapter(accountId, fn) {
      calls.push(["withAdapter", accountId]);
      return fn(adapterFor(accountId));
    },
  };
}

/** The scratch app: one per test, with whatever supervisor the test wants. */
async function setup({ supervisor = undefined } = {}) {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  const db = createDbClient(crow);
  open.push(db);

  const adapters = new Map();
  const adapterFor = (accountId) => {
    if (!adapters.has(accountId)) adapters.set(accountId, createFakeMailAdapter());
    return adapters.get(accountId);
  };
  const sup = supervisor === undefined ? makeSupervisor(adapterFor) : supervisor;

  const app = express();
  // servers/gateway/index.js's split, using the REAL predicate read from its source: the global 1mb
  // parser skips the paths whose router parses its own body.
  const indexSrc = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const predicate = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(indexSrc);
  assert.ok(predicate, "index.js's _hasOwnParser is where it was");
  const hasOwnParser = new Function("p", `return ${predicate[1]};`);
  const globalJson = expressJson({ limit: "1mb" });
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : globalJson(req, res, next)));

  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(mailApiRouter(sessionGate, { openDb: () => createDbClient(crow), supervisor: sup }));
  app.use(dash);

  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);

  const count = async (table, where = "", args = []) => {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} ${where}`, args });
    return Number(rows[0].n);
  };

  return { db, crow, adapters, adapterFor, supervisor: sup, count };
}

/** A fake adapter view that records its calls and how many of them ran at once, and can be closed. */
function adapterView(fake, gate) {
  const state = { calls: [], closed: false, inside: 0, maxInside: 0 };
  let dropCalls = null;
  const closedSignal = new Promise((resolve, reject) => {
    dropCalls = reject;
  });
  closedSignal.catch(() => {});
  const whileOpen = (work) => Promise.race([Promise.resolve().then(work), closedSignal]);
  /** A hold the test installs parks the FIRST call that meets it, and only that one. */
  const pause = async () => {
    const held = gate.hold;
    if (!held) return;
    gate.hold = null;
    await held;
  };
  const track = (method, run) => whileOpen(async () => {
    if (state.closed) throw new MailError("PROTOCOL", "closed");
    state.calls.push(method);
    state.inside += 1;
    state.maxInside = Math.max(state.maxInside, state.inside);
    try {
      await pause();
      return await run();
    } finally {
      state.inside -= 1;
    }
  });

  return {
    state,
    connect: () => track("connect", async () => fake.connect()),
    async close() {
      if (state.closed) return;
      state.closed = true;
      state.calls.push("close");
      dropCalls(new MailError("NETWORK", "closed"));
    },
    listFolders: () => track("listFolders", async () => fake.listFolders()),
    list: (path, options) => track("list", async () => fake.list(path, options)),
    get: (path, uids) => track("get", async () => fake.get(path, uids)),
    search: (query, options) => track("search", async () => fake.search(query, options)),
    saveDraft: (raw) => track("saveDraft", async () => fake.saveDraft(raw)),
    send: (message) => track("send", async () => fake.send(message)),
    setFlags: (path, uids, options) => track("setFlags", async () => fake.setFlags(path, uids, options)),
    move: (path, uids, dest, options) => track("move", async () => fake.move(path, uids, dest, options)),
    watch: (paths, handlers) => track("watch", async () => fake.watch(paths, handlers)),
  };
}

/**
 * The real supervisor over the same fake mailbox: one view per factory call, a clock the test drives,
 * and nothing started until a test asks for a sync.
 */
async function setupReal() {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  const db = createDbClient(crow);
  open.push(db);
  const clock = makeClock();
  const fake = createFakeMailAdapter({ now: clock.now });
  const gate = { hold: null };
  const views = [];
  const logs = [];
  const credentials = { async getSecrets() { return { MAIL_PASSWORD: "test-secret" }; } };

  const supervisor = createMailSupervisor({
    db,
    credentials,
    adapterFactory: async () => {
      const view = adapterView(fake, gate);
      views.push(view);
      return view;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    notify: async () => {},
    log: (line) => { logs.push(line); },
    isClaimedElsewhere: async () => false,
    refreshClaim: async () => {},
  });

  const app = express();
  const indexSrc = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const predicate = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(indexSrc);
  const hasOwnParser = new Function("p", `return ${predicate[1]};`);
  const globalJson = expressJson({ limit: "1mb" });
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : globalJson(req, res, next)));
  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(mailApiRouter(sessionGate, { openDb: () => createDbClient(crow), supervisor }));
  app.use(dash);
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);

  const count = async (table, where = "", args = []) => {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} ${where}`, args });
    return Number(rows[0].n);
  };

  const account = await createAccount(db, {
    label: "Personal",
    address: "alex@example.com",
    authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const folders = async () => listFolders(db, account.id);
  const folderByRole = async (role) => (await folders()).find((folder) => folder.role === role);

  return {
    db, crow, clock, fake, gate, views, logs, supervisor, account, accountId: account.id,
    count, folders, folderByRole,
  };
}

/* ----------------------------------------------------------------- seeds */

const ENDPOINT = { host: "mail.example.test", port: 993, security: "ssl" };

/** The four fake-mailbox folders as the store rows a sync would write, UIDVALIDITY included. */
function storeFolders(entries) {
  return entries.map((entry) => ({ ...entry }));
}

async function seedAccount(s, { address = "alex@example.com", label = "Personal", folders = null } = {}) {
  const account = await createAccount(s.db, {
    label,
    address,
    authKind: "password",
    imap: ENDPOINT,
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const listed = await upsertFolders(s.db, account.id, folders ?? storeFolders([
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
  ]));
  // The stored UIDVALIDITY is what an action hands the adapter as `expectedUidValidity`: it is the
  // value the row was stored under, and the fake adapter compares against its own.
  for (const folder of listed.folders) {
    const validity = FAKE_VALIDITY[folder.path];
    if (validity != null) await setFolderSyncState(s.db, folder.id, { uidValidity: validity });
  }
  const byPath = (path) => listed.folders.find((folder) => folder.path === path);
  return { account, folders: listed.folders, inbox: byPath("INBOX"), byPath };
}

/** One stored message row with the fields a test cares about. */
async function seedRow(s, account, folder, over = {}) {
  const date = over.date ?? Date.now();
  const uid = over.uid ?? 1;
  return upsertMessage(s.db, {
    accountId: account.id,
    folderId: folder.id,
    uid,
    messageId: over.messageId === undefined ? `<m-${uid}@mail.example.test>` : over.messageId,
    subject: over.subject ?? "Hello",
    from: over.from ?? { name: "Sam", address: "sam@example.com" },
    to: over.to ?? [{ name: "Alex", address: account.address }],
    cc: over.cc ?? [],
    text: over.text ?? "hello there",
    html: over.html ?? null,
    snippet: over.snippet ?? "hello there",
    attachments: over.attachments ?? [],
    date,
    internalDate: over.internalDate ?? date,
    flags: over.flags ?? [],
    parseError: over.parseError ?? null,
  });
}

/* ------------------------------------------------------------------ tests */

test("read and unread flip is_read locally after the adapter call and the unread count follows, with no sync started when none was running", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ subject: "Hello", messageId: "<m-1@mail.example.test>" }));
  const row = await seedRow(s, account, inbox, { uid, messageId: "<m-1@mail.example.test>" });

  const before = (await listFolders(s.db, account.id)).find((folder) => folder.id === inbox.id);
  assert.equal(before.unreadCount, 1);

  const read = await post(actionPath(row.id), { action: "read" });
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.json, { ok: true, isRead: true });
  assert.equal((await getMessage(s.db, row.id)).isRead, true);
  const afterRead = (await listFolders(s.db, account.id)).find((folder) => folder.id === inbox.id);
  assert.equal(afterRead.unreadCount, 0, "the unread count follows the local row");

  const flags = adapter.calls.filter((entry) => entry.method === "setFlags");
  assert.equal(flags.length, 1, "one adapter call for the one row");
  assert.deepEqual(flags[0].args[1], [uid]);
  assert.deepEqual(flags[0].args[2].add, ["\\Seen"]);
  assert.equal(flags[0].args[2].expectedUidValidity, FAKE_VALIDITY.INBOX);
  assert.equal(adapter.calls.some((entry) => entry.method === "move"), false);

  const unread = await post(actionPath(row.id), { action: "unread" });
  assert.equal(unread.status, 200, unread.text);
  assert.deepEqual(unread.json, { ok: true, isRead: false });
  assert.equal((await getMessage(s.db, row.id)).isRead, false);
  const afterUnread = (await listFolders(s.db, account.id)).find((folder) => folder.id === inbox.id);
  assert.equal(afterUnread.unreadCount, 1);
  const last = adapter.calls.filter((entry) => entry.method === "setFlags").at(-1);
  assert.deepEqual(last.args[2].remove, ["\\Seen"]);

  const started = s.supervisor.calls.filter((entry) => entry[0] === "requestSync" || entry[0] === "syncNow");
  assert.deepEqual(started, [], "no sync is started when none was running");
  assert.equal(s.supervisor.calls.filter((entry) => entry[0] === "noteChange").length, 2,
    "each local change is reported to the supervisor");
});

test("read marks every copy (same Message-ID, From, Date, other folder) read locally and sets \\Seen on each copy's own folder", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    ]),
  });
  const inbox = byPath("INBOX");
  const archive = byPath("Archive");
  const adapter = s.adapterFor(account.id);
  const date = Date.UTC(2025, 9, 1, 10, 0, 0);
  adapter.deliver("INBOX", makeRaw({ subject: "Copy", messageId: "<copy@mail.example.test>", date: new Date(date) }), { internalDate: date });
  adapter.deliver("Archive", makeRaw({ subject: "Copy", messageId: "<copy@mail.example.test>", date: new Date(date) }), { internalDate: date });
  const row = await seedRow(s, account, inbox, { uid: 1, messageId: "<copy@mail.example.test>", date, internalDate: date });
  const copy = await seedRow(s, account, archive, { uid: 1, messageId: "<copy@mail.example.test>", date, internalDate: date });

  const read = await post(actionPath(row.id), { action: "read" });
  assert.equal(read.status, 200, read.text);
  assert.equal((await getMessage(s.db, row.id)).isRead, true);
  assert.equal((await getMessage(s.db, copy.id)).isRead, true, "the copy in the other folder is read too");

  const flags = adapter.calls.filter((entry) => entry.method === "setFlags");
  assert.equal(flags.length, 2, "one call per folder");
  const byPathArg = new Map(flags.map((entry) => [entry.args[0], entry.args]));
  assert.deepEqual(byPathArg.get("INBOX")[1], [1]);
  assert.equal(byPathArg.get("INBOX")[2].expectedUidValidity, FAKE_VALIDITY.INBOX);
  assert.deepEqual(byPathArg.get("Archive")[1], [1]);
  assert.equal(byPathArg.get("Archive")[2].expectedUidValidity, FAKE_VALIDITY.Archive,
    "each copy's own folder's stored UIDVALIDITY");
});

test("read does not touch a row that shares only the Message-ID", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  adapter.deliver("INBOX", makeRaw({ messageId: "<shared@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid: 1, messageId: "<shared@mail.example.test>" });
  // Same Message-ID, another sender: a reused id, so it is a different message and stays unread.
  const forged = await seedRow(s, account, byPath("Archive"), {
    uid: 1,
    messageId: "<shared@mail.example.test>",
    from: { name: "Other", address: "sam@example.com" },
    date: Date.UTC(2025, 10, 2, 10, 0, 0),
  });

  const read = await post(actionPath(row.id), { action: "read" });
  assert.equal(read.status, 200, read.text);
  assert.equal((await getMessage(s.db, row.id)).isRead, true);
  assert.equal((await getMessage(s.db, forged.id)).isRead, false, "the reused id is left alone");
  const flags = adapter.calls.filter((entry) => entry.method === "setFlags");
  assert.equal(flags.length, 1, "only the one folder is touched");
  assert.equal(flags[0].args[0], "INBOX");
});

test("read over several copies answers 409 changed_on_server, changes nothing locally and asks for a full sync when a copy's uid is gone", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const date = Date.UTC(2025, 8, 3, 9, 0, 0);
  adapter.deliver("INBOX", makeRaw({ subject: "Copies", messageId: "<copies@mail.example.test>", date: new Date(date) }), { internalDate: date });
  const row = await seedRow(s, account, byPath("INBOX"), { uid: 1, messageId: "<copies@mail.example.test>", date, internalDate: date });
  // The second folder's copy names a uid the mailbox does not hold: that folder flags fewer uids than
  // it was handed, which is the message being gone rather than a flag change.
  const copy = await seedRow(s, account, byPath("Archive"), { uid: 9, messageId: "<copies@mail.example.test>", date, internalDate: date });

  const read = await post(actionPath(row.id), { action: "read" });
  assert.equal(read.status, 409, read.text);
  assert.deepEqual(read.json, { error: "changed_on_server", message: MAIL_ERROR_TEXT.CHANGED });
  assert.equal((await getMessage(s.db, row.id)).isRead, false, "no row is marked read");
  assert.equal((await getMessage(s.db, copy.id)).isRead, false);
  // The copy in the first folder was flagged before the second folder's answer came back: the full
  // sync behind the answer is what repairs the local row that flagging left as it was.
  assert.deepEqual((await adapter.list("INBOX")).items.map((item) => item.flags), [["\\Seen"]]);
  assert.deepEqual(s.supervisor.calls.filter((entry) => entry[0] === "requestSync"),
    [["requestSync", account.id, null]], "a full sync is asked for");

  // The same answer when a folder reports the change itself.
  adapter.failNext("setFlags", new MailError("CHANGED"));
  const again = await post(actionPath(row.id), { action: "unread" });
  assert.equal(again.status, 409, again.text);
  assert.deepEqual(again.json, { error: "changed_on_server", message: MAIL_ERROR_TEXT.CHANGED });
  assert.equal((await getMessage(s.db, row.id)).isRead, false);
  assert.equal(s.supervisor.calls.filter((entry) => entry[0] === "requestSync").length, 2,
    "each answer asks for a full sync");
});

test("archive moves to the archive folder and the local row is gone", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<a-1@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid, messageId: "<a-1@mail.example.test>" });

  const archived = await post(actionPath(row.id), { action: "archive" });
  assert.equal(archived.status, 200, archived.text);
  assert.deepEqual(archived.json, { ok: true, movedTo: byPath("Archive").id });
  assert.equal(await getMessage(s.db, row.id), null, "the local row is gone");

  const moved = adapter.calls.filter((entry) => entry.method === "move");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].args[0], "INBOX");
  assert.deepEqual(moved[0].args[1], [uid]);
  assert.equal(moved[0].args[2], "Archive");
  assert.equal(moved[0].args[3].expectedUidValidity, FAKE_VALIDITY.INBOX);
  const inbox = await adapter.list("INBOX");
  assert.deepEqual(inbox.items.map((item) => item.uid), [], "the source no longer holds it");
  assert.deepEqual((await adapter.list("Archive")).items.map((item) => item.uid), [uid]);

  const reported = s.supervisor.calls.filter((entry) => entry[0] === "noteChange" || entry[0] === "requestSync");
  assert.deepEqual(reported, [
    ["noteChange", account.id],
    ["requestSync", account.id, [byPath("Archive").id]],
  ], "the local change is reported before the destination folder is asked for");
});

test("archive in an account with only \\All uses it", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      // The store names the server folder this account keeps its All Mail in; the fake adapter's own
      // folder for that path is where the message lands.
      { path: "Sent", name: "All Mail", specialUse: "\\All", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<all@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid, messageId: "<all@mail.example.test>" });

  const archived = await post(actionPath(row.id), { action: "archive" });
  assert.equal(archived.status, 200, archived.text);
  assert.deepEqual(archived.json, { ok: true, movedTo: byPath("Sent").id });
  assert.equal(await getMessage(s.db, row.id), null);
  assert.equal(adapter.calls.filter((entry) => entry.method === "move")[0].args[2], "Sent");
  assert.deepEqual(s.supervisor.calls.filter((entry) => entry[0] === "requestSync"), [],
    "a folder the sync skips is not synced");
});

test("archive with neither -> 409 no_archive_folder and nothing changed", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<n@mail.example.test>" }));
  const row = await seedRow(s, account, inbox, { uid, messageId: "<n@mail.example.test>" });

  const refused = await post(actionPath(row.id), { action: "archive" });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.error, "no_archive_folder");
  assert.notEqual(await getMessage(s.db, row.id), null, "the row is still there");
  assert.equal(adapter.calls.some((entry) => entry.method === "move"), false);
  assert.deepEqual(s.supervisor.calls.filter((entry) => entry[0] === "requestSync"), []);
});

test("delete goes to Trash, never expunges", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      // The fake mailbox's folders are INBOX/Sent/Drafts/Archive, so the trash-role folder the store
      // knows is the one at the Drafts path.
      { path: "Drafts", name: "Trash", specialUse: "\\Trash", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<d@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid, messageId: "<d@mail.example.test>" });

  const deleted = await post(actionPath(row.id), { action: "delete" });
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(deleted.json, { ok: true, movedTo: byPath("Drafts").id });
  assert.equal(await getMessage(s.db, row.id), null);
  assert.deepEqual((await adapter.list("Drafts")).items.map((item) => item.uid), [uid], "it is in Trash");
  assert.equal(adapter.wire.includes("UID EXPUNGE"), false, "nothing was expunged");
  assert.equal(adapter.calls.some((entry) => entry.method === "expunge"), false);
});

test("delete with no Trash -> 409", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<nt@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid, messageId: "<nt@mail.example.test>" });

  const refused = await post(actionPath(row.id), { action: "delete" });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.error, "no_trash_folder");
  assert.notEqual(await getMessage(s.db, row.id), null);
  assert.equal(adapter.calls.some((entry) => entry.method === "move"), false);
});

test("move to a folder of another account -> 400", async () => {
  const s = await setup();
  const mine = await seedAccount(s, { address: "alex@example.com" });
  const other = await seedAccount(s, {
    address: "sam@example.com",
    label: "Work",
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(mine.account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<o@mail.example.test>" }));
  const row = await seedRow(s, mine.account, mine.inbox, { uid, messageId: "<o@mail.example.test>" });

  const refused = await post(actionPath(row.id), { action: "move", folderId: other.byPath("Archive").id });
  assert.equal(refused.status, 400, refused.text);
  assert.deepEqual(refused.json, { error: "bad_input", message: "That request is not valid." });
  assert.notEqual(await getMessage(s.db, row.id), null, "nothing moved");
  assert.equal(adapter.calls.some((entry) => entry.method === "move"), false);
  assert.equal(s.adapters.has(other.account.id), false, "the other account was never touched");
});

test("move to the source folder -> 400", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<s@mail.example.test>" }));
  const row = await seedRow(s, account, inbox, { uid, messageId: "<s@mail.example.test>" });

  const refused = await post(actionPath(row.id), { action: "move", folderId: inbox.id });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.json.error, "bad_input");
  assert.notEqual(await getMessage(s.db, row.id), null);
  assert.equal(adapter.calls.some((entry) => entry.method === "move"), false);
});

test("adapter failure leaves the row and returns the fixed sentence", async () => {
  const SEEDED = "hunter2-in-the-adapter-reply";
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<f@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid, messageId: "<f@mail.example.test>" });

  const failure = (method) => {
    const err = new Error(`IMAP server said: ${SEEDED}`);
    err.code = "ECONNRESET";
    adapter.failNext(method, new MailError("NETWORK", "ECONNRESET"));
    return err;
  };
  failure("move");
  const archived = await warnings(() => post(actionPath(row.id), { action: "archive" }));
  assert.equal(archived.result.status, 502, archived.result.text);
  assert.deepEqual(archived.result.json, { error: "NETWORK", message: MAIL_ERROR_TEXT.NETWORK });
  assert.equal(archived.result.text.includes(SEEDED), false, "no library text in the answer");
  assert.equal(archived.lines.join("\n").includes(SEEDED), false, "no library text in a log line");
  assert.notEqual(await getMessage(s.db, row.id), null, "the row is untouched");
  assert.equal((await getMessage(s.db, row.id)).isRead, false);

  adapter.failNext("setFlags", new MailError("PROTOCOL", "NO"));
  const read = await post(actionPath(row.id), { action: "read" });
  assert.equal(read.status, 502, read.text);
  assert.deepEqual(read.json, { error: "PROTOCOL", message: MAIL_ERROR_TEXT.PROTOCOL });
  assert.equal((await getMessage(s.db, row.id)).isRead, false, "no local change either");
  assert.deepEqual(s.supervisor.calls.filter((entry) => entry[0] === "requestSync"), [],
    "an adapter failure is not a changed message");
});

test("RF7: after bumpUidValidity with a different message delivered at the same uid, archive, delete, move and read each return 409 changed_on_server, change nothing on the server or locally, and request a full sync", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
      { path: "Drafts", name: "Trash", specialUse: "\\Trash", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ subject: "Mine", messageId: "<mine@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid, messageId: "<mine@mail.example.test>" });

  // A reset: the UID space starts again, and a different message now holds the uid the row names.
  adapter.resetUidValidity("INBOX");
  adapter.deliver("INBOX", makeRaw({ from: "Other <sam@example.com>", subject: "Someone else", messageId: "<other@mail.example.test>" }));
  const wireBefore = adapter.wire.length;

  const attempts = [
    ["read", { action: "read" }],
    ["archive", { action: "archive" }],
    ["delete", { action: "delete" }],
    ["move", { action: "move", folderId: byPath("Archive").id }],
  ];
  for (const [what, body] of attempts) {
    const r = await post(actionPath(row.id), body);
    assert.equal(r.status, 409, `${what}: ${r.text}`);
    assert.deepEqual(r.json, { error: "changed_on_server", message: MAIL_ERROR_TEXT.CHANGED }, what);
  }

  const stored = await getMessage(s.db, row.id);
  assert.notEqual(stored, null, "the row is unchanged");
  assert.equal(stored.isRead, false, "and still unread");
  const newUid = (await adapter.list("INBOX")).items[0];
  assert.deepEqual(newUid.flags, [], "the message now holding the uid kept its flags");
  assert.deepEqual((await adapter.list("Archive")).items, [], "nothing was moved");
  assert.equal(adapter.wire.slice(wireBefore).includes("UID STORE"), false, "no STORE was sent");
  assert.equal(adapter.wire.slice(wireBefore).includes("UID MOVE"), false, "no MOVE was sent");

  const syncs = s.supervisor.calls.filter((entry) => entry[0] === "requestSync");
  assert.equal(syncs.length, attempts.length, "each refused action asks for a full sync");
  for (const sync of syncs) assert.deepEqual(sync, ["requestSync", account.id, null], "a full one");
});

test("a uid that vanished (updated 0) returns the same 409", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const adapter = s.adapterFor(account.id);
  adapter.deliver("INBOX", makeRaw({ messageId: "<gone@mail.example.test>" }));
  // The stored row names a uid the mailbox no longer holds.
  const row = await seedRow(s, account, inbox, { uid: 9, messageId: "<gone@mail.example.test>" });

  const r = await post(actionPath(row.id), { action: "read" });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, { error: "changed_on_server", message: MAIL_ERROR_TEXT.CHANGED });
  assert.equal((await getMessage(s.db, row.id)).isRead, false, "nothing local changed");
  assert.deepEqual(s.supervisor.calls.filter((entry) => entry[0] === "requestSync"),
    [["requestSync", account.id, null]], "a full sync is asked for");
});

test("archive, delete and move answer 409 changed_on_server, change nothing and ask for a full sync when the uid has vanished (moved 0)", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
      { path: "Drafts", name: "Trash", specialUse: "\\Trash", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  // One message the mailbox really holds, and a row that names a uid it does not: the adapter's move
  // answers {moved: 0} for every action here.
  adapter.deliver("INBOX", makeRaw({ messageId: "<untouched@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid: 9, messageId: "<vanished@mail.example.test>" });

  const attempts = [
    ["archive", { action: "archive" }],
    ["delete", { action: "delete" }],
    ["move", { action: "move", folderId: byPath("Archive").id }],
  ];
  for (const [what, body] of attempts) {
    const r = await post(actionPath(row.id), body);
    assert.equal(r.status, 409, `${what}: ${r.text}`);
    assert.deepEqual(r.json, { error: "changed_on_server", message: MAIL_ERROR_TEXT.CHANGED }, what);
    assert.notEqual(await getMessage(s.db, row.id), null, `${what}: the row is still there`);
  }

  const moves = adapter.calls.filter((entry) => entry.method === "move");
  assert.equal(moves.length, 3, "each action reached the mailbox");
  assert.deepEqual((await adapter.list("INBOX")).items.map((item) => item.uid), [1], "nothing was moved");
  assert.deepEqual((await adapter.list("Archive")).items, []);
  assert.deepEqual((await adapter.list("Drafts")).items, []);
  assert.equal(adapter.wire.includes("UID MOVE"), false, "a move that found nothing sent no MOVE");

  const syncs = s.supervisor.calls.filter((entry) => entry[0] === "requestSync");
  assert.equal(syncs.length, attempts.length, "each refused action asks for a sync");
  for (const sync of syncs) assert.deepEqual(sync, ["requestSync", account.id, null], "a full one");
});

test("the adapter receives the folder's stored uid_validity as expectedUidValidity", async () => {
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const date = Date.UTC(2025, 9, 4, 8, 0, 0);
  adapter.deliver("INBOX", makeRaw({ messageId: "<v@mail.example.test>", date: new Date(date) }), { internalDate: date });
  adapter.deliver("Archive", makeRaw({ messageId: "<v@mail.example.test>", date: new Date(date) }), { internalDate: date });
  const row = await seedRow(s, account, byPath("INBOX"), { uid: 1, messageId: "<v@mail.example.test>", date, internalDate: date });
  await seedRow(s, account, byPath("Archive"), { uid: 1, messageId: "<v@mail.example.test>", date, internalDate: date });

  const read = await post(actionPath(row.id), { action: "read" });
  assert.equal(read.status, 200, read.text);
  const flags = adapter.calls.filter((entry) => entry.method === "setFlags");
  for (const entry of flags) {
    assert.equal(entry.args[2].expectedUidValidity, FAKE_VALIDITY[entry.args[0]],
      `${entry.args[0]} is acted on with its own stored UIDVALIDITY`);
  }

  // A folder whose stored UIDVALIDITY is unknown cannot be acted on: nothing is sent, and the answer
  // is the same one a changed mailbox gets, with a full sync behind it.
  const before = adapter.calls.length;
  await setFolderSyncState(s.db, byPath("INBOX").id, { uidValidity: 0 });
  const refused = await warnings(() => post(actionPath(row.id), { action: "unread" }));
  assert.equal(refused.result.status, 409, refused.result.text);
  assert.equal(refused.result.json.error, "changed_on_server");
  assert.equal(adapter.calls.slice(before).some((entry) => entry.method === "setFlags"), false);
});

test("unknown action -> 400", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<u@mail.example.test>" }));
  const row = await seedRow(s, account, inbox, { uid, messageId: "<u@mail.example.test>" });

  for (const body of [
    { action: "frobnicate" },
    { action: "move" },
    {},
    { action: "" },
    { action: "move", folderId: "not-a-folder" },
  ]) {
    const r = await post(actionPath(row.id), body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    assert.deepEqual(r.json, { error: "bad_input", message: "That request is not valid." });
  }
  assert.notEqual(await getMessage(s.db, row.id), null);
  assert.equal(adapter.calls.some((entry) => entry.method === "move" || entry.method === "setFlags"), false);
});

test("RF6: flag unset 404, peer SSO 403, CSRF missing 403", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<rf6@mail.example.test>" }));
  const row = await seedRow(s, account, inbox, { uid, messageId: "<rf6@mail.example.test>" });

  delete process.env.CROW_MAIL;
  try {
    const off = await post(actionPath(row.id), { action: "read" });
    assert.equal(off.status, 404, off.text);
    assert.deepEqual(off.json, { error: "not_found", message: "Not found." });
  } finally {
    process.env.CROW_MAIL = "1";
  }

  const sso = await post(actionPath(row.id), { action: "read" }, { token: SSO });
  assert.equal(sso.status, 403, sso.text);
  assert.deepEqual(sso.json, { error: "owner_only", message: "Only the owner can see this." });
  assert.equal(sso.text.includes(account.address), false, "no account data");

  const noToken = await post(actionPath(row.id), { action: "read" }, { csrf: null });
  assert.equal(noToken.status, 403, noToken.text);

  assert.equal((await getMessage(s.db, row.id)).isRead, false, "no refused request changed anything");
});

/* ------------------------------------------------- the real supervisor (S5, 18) */

test("S5: read while a sync is running calls noteChange and the rerun happens; read with no sync running starts no sync", async () => {
  const s = await setupReal();
  s.fake.deliver("INBOX", makeRaw({ subject: "First", messageId: "<first@mail.example.test>" }));
  await s.supervisor.syncNow(s.accountId);
  await flush();
  const inbox = await s.folderByRole("inbox");
  assert.ok(inbox, "the sync stored the INBOX folder");
  const { rows } = await s.db.execute({ sql: "SELECT id FROM mail_messages WHERE account_id = ?", args: [s.accountId] });
  const firstRow = Number(rows[0].id);
  const listCalls = () => s.fake.calls.filter((entry) => entry.method === "listFolders").length;
  // The IDLE watch is dropped: a flag change reports itself to the supervisor, and this test is
  // about what the ROUTE asks for, not about the sync the watch would start on its own.
  s.fake.dropWatch();
  await flush();
  const baseline = listCalls();
  assert.ok(baseline >= 1);

  // No run is in flight: the read changes the row locally and starts nothing.
  const read = await post(actionPath(firstRow), { action: "read" });
  assert.equal(read.status, 200, read.text);
  await flush();
  assert.equal((await s.supervisor.status(s.accountId)).running, false);
  assert.equal(listCalls(), baseline, "no sync was started");

  // A run in flight: the read reports the change, and the run's end starts one more full sync.
  s.fake.deliver("INBOX", makeRaw({ subject: "Second", messageId: "<second@mail.example.test>" }));
  await s.supervisor.syncNow(s.accountId);
  await flush();
  const { rows: afterRows } = await s.db.execute({
    sql: "SELECT id, is_read FROM mail_messages WHERE account_id = ? ORDER BY id",
    args: [s.accountId],
  });
  const secondRow = afterRows.find((candidate) => Number(candidate.is_read) === 0);
  assert.ok(secondRow, "the second message is unread");

  // Hold the next run's first adapter call, so the action lands while it is in flight.
  let release = null;
  s.gate.hold = new Promise((resolve) => { release = resolve; });
  const mark = listCalls();
  const run = s.supervisor.syncNow(s.accountId);
  await waitFor(async () => (await s.supervisor.status(s.accountId)).running === true, "the run to be in flight");

  const during = await post(actionPath(Number(secondRow.id)), { action: "read" });
  assert.equal(during.status, 200, during.text);
  assert.equal((await s.db.execute({ sql: "SELECT is_read FROM mail_messages WHERE id = ?", args: [Number(secondRow.id)] }))
    .rows[0].is_read, 1);

  release();
  s.gate.hold = null;
  await run;
  await waitFor(() => listCalls() === mark + 2, "the rerun noteChange asked for");
  assert.equal(listCalls(), mark + 2, "the run in flight plus the one full rerun noteChange asked for");
});

test("S5: a move that lands while a sync of its source folder is mid-flight does not bring the moved message back (the dirty rerun removes it)", async () => {
  const s = await setupReal();
  const messageId = "<moved@mail.example.test>";
  s.fake.deliver("INBOX", makeRaw({ subject: "Moved", messageId }));
  await s.supervisor.syncNow(s.accountId);
  await flush();
  const inbox = await s.folderByRole("inbox");
  const archive = await s.folderByRole("archive");
  const sent = await s.folderByRole("sent");
  assert.ok(inbox && archive && sent, "the sync stored the folders");

  const rowsOf = async (folderId, mid) => (await s.db.execute({
    sql: `SELECT id FROM mail_messages
           WHERE account_id = ? AND folder_id = ? AND message_id = ?`,
    args: [s.accountId, folderId, mid],
  })).rows.map((row) => Number(row.id));
  const [row] = await rowsOf(inbox.id, messageId);
  assert.ok(row, "the message is stored in INBOX");
  // The IDLE watch reports a flag change of its own; this test is about what the route asks for.
  s.fake.dropWatch();
  await flush();

  // The in-flight run re-reads INBOX from the start, so its listing and its body fetch both see the
  // message BEFORE the move: the row it writes afterwards is the one a rerun has to take back.
  await setFolderSyncState(s.db, inbox.id, { highestUid: 0, floorUid: null });

  // The hold sits in the body fetch, the call after the source folder's listing: the bytes are the
  // mailbox's before the move, while the write of them lands after it.
  const realGet = s.fake.get;
  let release = null;
  let held = false;
  const gate = new Promise((resolve) => { release = resolve; });
  s.fake.get = async (path, uids) => {
    const answer = await realGet(path, uids);
    if (!held && path === "INBOX") {
      held = true;
      await gate;
    }
    return answer;
  };

  const listCalls = () => s.fake.calls.filter((entry) => entry.method === "listFolders").length;
  const mark = listCalls();
  const run = s.supervisor.requestSync(s.accountId, { folderIds: [inbox.id] });
  await waitFor(() => held, "the in-flight run to reach its body fetch");

  const moved = await post(actionPath(row), { action: "archive" });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual(await rowsOf(inbox.id, messageId), [], "the local row is gone straight away");

  release();
  await run;
  await waitFor(async () => (await rowsOf(archive.id, messageId)).length === 1,
    "the destination folder to hold the moved message");

  assert.equal(listCalls(), mark + 1, "the run in flight, then one full rerun");
  assert.equal((await s.supervisor.status(s.accountId)).running, false);
  assert.deepEqual(await rowsOf(inbox.id, messageId), [],
    "the row the in-flight run wrote back is gone from its source folder");

  // With nothing in flight the note is a no-op: only the route's own request for the destination can
  // store a moved message there.
  s.fake.get = realGet;
  s.fake.dropWatch();
  await flush();
  const secondId = "<moved-later@mail.example.test>";
  s.fake.deliver("INBOX", makeRaw({ subject: "Later", messageId: secondId }));
  await s.supervisor.syncNow(s.accountId);
  await flush();
  s.fake.dropWatch();
  await flush();
  const [second] = await rowsOf(inbox.id, secondId);
  assert.ok(second, "the second message is stored in INBOX");
  assert.equal((await s.supervisor.status(s.accountId)).running, false, "nothing is in flight for it");

  const sentListCalls = () => s.fake.calls.filter((entry) => entry.method === "list" && entry.args[0] === "Sent").length;
  const listedBefore = sentListCalls();

  const later = await post(actionPath(second), { action: "move", folderId: sent.id });
  assert.equal(later.status, 200, later.text);
  await waitFor(async () => (await rowsOf(sent.id, secondId)).length === 1,
    "the destination sync to read the sent folder and store the moved message");
  assert.ok(sentListCalls() > listedBefore, "the sent folder was read again, by the sync the route asked for");
});

test("move requests a sync of the destination folder only (spy on syncFolder), and none when the destination is a \\All folder", async () => {
  // The route never calls `syncFolder` itself: it hands the supervisor one folder id, which is the
  // folder plan 1's run syncs — so that argument list is the whole of what this route decides.
  const s = await setup();
  const { account, byPath } = await seedAccount(s, {
    folders: storeFolders([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
      // This account's All Mail folder, at a path the fake mailbox holds.
      { path: "Sent", name: "All Mail", specialUse: "\\All", delimiter: "/" },
    ]),
  });
  const adapter = s.adapterFor(account.id);
  const uid = adapter.deliver("INBOX", makeRaw({ messageId: "<dest@mail.example.test>" }));
  const row = await seedRow(s, account, byPath("INBOX"), { uid, messageId: "<dest@mail.example.test>" });

  // `requestSync`'s folder list is what plan 1's run hands `syncFolder`: one entry, the destination.
  const moved = await post(actionPath(row.id), { action: "move", folderId: byPath("Archive").id });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual(s.supervisor.calls.filter((entry) => entry[0] === "requestSync"),
    [["requestSync", account.id, [byPath("Archive").id]]], "the destination folder only");
  assert.deepEqual(s.supervisor.calls.filter((entry) => entry[0] === "syncNow"), [],
    "never a whole-account sync");

  // The message is in Archive now; a move into the \All folder is the same route with a skipped
  // destination, and nothing is synced for it at all.
  const { rows } = await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?", args: [account.id] });
  assert.equal(rows[0].n, 0, "the moved row is gone");
  const archivedUid = adapter.deliver("Archive", makeRaw({ messageId: "<to-all@mail.example.test>" }));
  const inArchive = await seedRow(s, account, byPath("Archive"), { uid: archivedUid, messageId: "<to-all@mail.example.test>" });
  s.supervisor.calls.length = 0;
  const toAll = await post(actionPath(inArchive.id), { action: "move", folderId: byPath("Sent").id });
  assert.equal(toAll.status, 200, toAll.text);
  assert.equal(toAll.json.movedTo, byPath("Sent").id);
  assert.deepEqual(s.supervisor.calls.filter((entry) => entry[0] === "requestSync"), [],
    "a folder the sync skips is never asked for");
});

test("actions run through withAdapter (one at a time) and the adapter is closed afterwards", async () => {
  const s = await setupReal();
  s.fake.deliver("INBOX", makeRaw({ subject: "One", messageId: "<one@mail.example.test>" }));
  s.fake.deliver("INBOX", makeRaw({ subject: "Two", messageId: "<two@mail.example.test>" }));
  await s.supervisor.syncNow(s.accountId);
  await flush();
  const { rows } = await s.db.execute({
    sql: "SELECT id FROM mail_messages WHERE account_id = ? ORDER BY id",
    args: [s.accountId],
  });
  const ids = rows.map((row) => Number(row.id));
  const viewsBefore = s.views.length;

  const [first, second] = await Promise.all([
    post(actionPath(ids[0]), { action: "read" }),
    post(actionPath(ids[1]), { action: "read" }),
  ]);
  assert.equal(first.status, 200, first.text);
  assert.equal(second.status, 200, second.text);

  const actionViews = s.views.slice(viewsBefore);
  assert.equal(actionViews.length, 1, "one borrowed connection served both actions");
  assert.equal(actionViews[0].state.maxInside, 1, "never two calls at once");
  assert.equal(actionViews[0].state.calls.filter((method) => method === "setFlags").length, 2);

  await s.clock.advance(ACTION_IDLE_KEEP_MS);
  assert.equal(actionViews[0].state.closed, true, "the kept connection is closed after the idle keep");
  assert.ok(actionViews[0].state.calls.includes("close"));
});