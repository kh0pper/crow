// Crow Mail end to end (plan 1, Task 21): the real boot wiring (`startMailSync`), the real private API
// routes, the real IMAP/SMTP adapter, the real sync engine and supervisor, over the in-process fake
// IMAP and SMTP servers. Nothing here is a fake mail adapter.
//
// The harness is Task 19's (tests/mail-api-accounts.test.js): an init-db'd scratch crow.db copied per
// test (CROW_DATA_DIR / CROW_HOME, so nothing can touch ~/.crow), an ephemeral express app wired the way
// servers/gateway/index.js and dashboard/index.js wire it (the global 1mb parser skipped by index.js's
// own `_hasOwnParser` predicate, read from its source; then a session stub, the dashboard's real CSRF
// middleware, then the real mail API router) and the real owner rule with the request marked as coming
// from the owner's laptop (tests/helpers/off-box.js). The router is given no supervisor: the one
// `startMailSync` builds and publishes as the module runtime is what answers it.
//
// Time is injected into the supervisor (a fake clock whose timers the test fires by hand), so the
// back-off leg finishes in a millisecond instead of minutes. The whole run's console output is captured:
// the app password and every subject must appear in none of it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";

const root = mkdtempSync(join(tmpdir(), "mail-e2e-"));
// What the suite had before this file set its own scratch paths, restored at the end of the file.
const PRIOR_TASKS_DB_PATH = process.env.CROW_TASKS_DB_PATH;
const MASTER_TASKS_DB_PATH = join(root, "master", "tasks.db");
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = MASTER_TASKS_DB_PATH;
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { default: express, json: expressJson } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { mailApiRouter, MAIL_API_PREFIX } = await import("../servers/gateway/routes/mail-api.js");
const { startMailSync, stopMailSync } = await import("../servers/gateway/boot/mail-boot.js");
const { createImapSmtpAdapter } = await import("../servers/gateway/mail/adapter/imap-smtp.js");
const { listFolders } = await import("../servers/gateway/mail/store/messages.js");
const { listClaims } = await import("../servers/gateway/mail/claims.js");
const {
  FAKE_PASSWORD, FAKE_USER, createFakeImapServer, createFakeSmtpServer, makeRaw,
} = await import("./fixtures/fake-mail-server.mjs");

const OWNER = "owner-local-password-session";
const CSRF = "csrf-token-value";
const LOCAL = Object.freeze({ instanceId: "instA", instanceName: "Alpha" });
const DAY = 24 * 60 * 60 * 1000;
/** Short budgets: every connect here is a loopback socket. */
const FAST = { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 8000 };

const MESSAGES = `${MAIL_API_PREFIX}/messages`;
const SEARCH = `${MAIL_API_PREFIX}/search`;
const olderPath = (id) => `${MAIL_API_PREFIX}/folders/${encodeURIComponent(id)}/older`;

const SUBJECTS = [
  "A note about breakfast",
  "A newsletter with pictures",
  "A short plain note",
  "Delivered while the mailbox was away",
];
const OLD_SUBJECT = "A receipt from last winter";

/* ------------------------------------------------------------------ plumbing */

/** Let every pending promise, db call and immediate settle. */
async function flush(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A clock whose timers only fire when the test advances it. */
function makeClock(start) {
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
    clearTimer(handle) { timers.delete(handle); },
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

/** Wait for a predicate on real time: the sockets here are real. */
async function until(predicate, { timeoutMs = 8000, intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

const servers = [];
const clients = [];
after(() => {
  for (const s of servers) s.close();
  for (const c of clients) { try { c.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
  if (PRIOR_TASKS_DB_PATH === undefined) delete process.env.CROW_TASKS_DB_PATH;
  else process.env.CROW_TASKS_DB_PATH = PRIOR_TASKS_DB_PATH;
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
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
});

/* ---------------------------------------------------------------------- HTTP */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

let server = null;

/** One request as the owner's own laptop makes it: the session cookie and the CSRF header. */
function call(method, path, { body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const h = {};
  if (payload !== null) {
    h["content-type"] = "application/json";
    h["content-length"] = Buffer.byteLength(payload);
  }
  h.cookie = `crow_session=${OWNER}; crow_csrf=${CSRF}`;
  h["x-crow-csrf"] = CSRF;
  h["x-test-from"] = "laptop";
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: h }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
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

const get = (path) => call("GET", path);
const post = (path, body) => call("POST", path, { body });
const del = (path) => call("DELETE", path);
const accountsPath = `${MAIL_API_PREFIX}/accounts`;

/* ----------------------------------------------------------------------- test */

test("a mailbox end to end: connect, IDLE, read, search, older mail, a UIDVALIDITY reset, back-off and delete", async () => {
  const dir = join(root, "e2e");
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
  process.env.CROW_MAIL = "1";

  const db = createDbClient(crow);
  clients.push(db);
  const clock = makeClock(Date.now());
  const logs = [];

  const imap = await createFakeImapServer();
  const smtp = await createFakeSmtpServer();
  const output = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => output.push(args.map((a) => String(a)).join(" "));
  console.warn = (...args) => output.push(args.map((a) => String(a)).join(" "));
  console.error = (...args) => output.push(args.map((a) => String(a)).join(" "));

  const count = async (table) => {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table}`, args: [] });
    return Number(rows[0].n);
  };
  let handle = null;
  try {
    // The 200-day-old message arrives FIRST, so it holds the lowest UID on the server: it is outside
    // the 90-day window of the first sync and only on-demand paging can reach it.
    const oldUid = imap.deliver("INBOX", makeRaw({
      subject: OLD_SUBJECT,
      body: "Paid in full.",
      messageId: "winter@example.test",
    }), { internalDate: new Date(clock.now() - 200 * DAY) });

    const adapterFactory = ({ account, credentials }) => createImapSmtpAdapter({
      account, credentials, timeouts: FAST,
    });

    const app = express();
    // index.js's split, using the REAL predicate read from its source.
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
    // No `supervisor` here on purpose: the routes read the runtime `startMailSync` publishes.
    dash.use(mailApiRouter(sessionGate, {
      openDb: () => createDbClient(crow),
      adapterFactory,
      localInstance: LOCAL,
    }));
    app.use(dash);
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);

    // Connect the account through the real route (real probe against the fake IMAP server).
    const created = await post(accountsPath, {
      label: "Personal",
      address: FAKE_USER,
      username: FAKE_USER,
      imap: { host: imap.host, port: imap.port, security: "none" },
      smtp: { host: smtp.host, port: smtp.port, security: "none" },
      password: FAKE_PASSWORD,
    });
    assert.equal(created.status, 201, created.text);
    const accountId = created.json.account.id;
    assert.match(accountId, /^ma-[0-9a-f]{16}$/);

    handle = await startMailSync({
      db,
      env: { CROW_MAIL: "1" },
      noAuth: false,
      adapterFactory,
      localInstance: LOCAL,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 0.5,
      log: (line) => logs.push(line),
    });
    assert.equal(handle.started, true);
    const supervisor = handle.supervisor;

    // The first full sync runs in the background; wait until IDLE is armed on INBOX and Sent.
    assert.equal(await until(async () => (await supervisor.status(accountId)).watching === true), true,
      "the first sync finished and the watch is armed");
    assert.equal(await count("mail_messages"), 0, "the 200-day-old message is outside the window");

    /* ------------------------------------------------------------------ IDLE */

    const uids = [
      imap.deliver("INBOX", makeRaw({
        subject: SUBJECTS[0],
        body: "A marmalade note waits inside this message.",
        messageId: "breakfast@example.test",
      })),
      imap.deliver("INBOX", makeRaw({
        subject: SUBJECTS[1],
        body: "Hello there.",
        html: '<p>Hello there.</p><img src="https://tracker.example.test/pixel.png"><script>alert(1)</script>',
        messageId: "newsletter@example.test",
      })),
      imap.deliver("INBOX", makeRaw({
        subject: SUBJECTS[2],
        body: "Nothing else to say.",
        messageId: "short@example.test",
      })),
    ];
    // No syncNow: the three arrive through the IDLE watch alone.
    assert.equal(await until(async () => (await count("mail_messages")) === 3), true,
      `IDLE brought all three in (logs: ${JSON.stringify(logs).slice(0, 400)})`);

    /* ------------------------------------------------------------------ read */

    const list = await get(`${MESSAGES}?account=${accountId}`);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.items.length, 3);
    for (const item of list.json.items) {
      assert.equal(Object.hasOwn(item, "body"), false, "a list item carries no body");
      assert.equal(Object.hasOwn(item, "bodyHtml"), false);
    }

    const rowOf = async (subject) => (await db.execute({
      sql: "SELECT id FROM mail_messages WHERE subject = ?",
      args: [subject],
    })).rows[0];
    const secondId = Number((await rowOf(SUBJECTS[1])).id);
    const opened = await get(`${MESSAGES}/${secondId}`);
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.json.body.source, "html");
    assert.equal(/<script/i.test(opened.json.body.html), false, "the script is gone");
    assert.equal(/\son\w+\s*=/i.test(opened.json.body.html), false, "no event handler survives");
    assert.equal(/src\s*=/i.test(opened.json.body.html), false, "the remote image is not loaded");
    assert.equal(opened.json.body.remoteImageCount, 1);
    assert.equal(opened.json.body.blockedRemoteImageCount, 1);
    assert.equal(opened.json.body.imagesShown, false);

    // Showing the images is per call only.
    const shown = await get(`${MESSAGES}/${secondId}?images=1`);
    assert.equal(shown.json.body.imagesShown, true);
    assert.match(shown.json.body.html, /https:\/\/tracker\.example\.test\/pixel\.png/);

    /* ---------------------------------------------------------------- search */

    const found = await get(`${SEARCH}?q=marmalade&account=${accountId}`);
    assert.equal(found.status, 200, found.text);
    assert.equal(found.json.items.length, 1);
    assert.equal(found.json.items[0].subject, SUBJECTS[0], "search finds the message by a body word");

    /* ------------------------------------------------------------ older mail */

    const inbox = (await listFolders(db, accountId)).find((folder) => folder.role === "inbox");
    assert.ok(inbox, "the INBOX folder is stored");
    const older = await post(olderPath(inbox.id), {});
    assert.equal(older.status, 200, older.text);
    assert.equal(older.json.added, 1, "the 200-day-old message is fetched on demand");
    assert.equal(older.json.reachedStart, true);
    assert.ok(await rowOf(OLD_SUBJECT), "it is stored");
    assert.equal(await count("mail_messages"), 4);

    /* ------------------------------------------------- UIDVALIDITY (+ expunge) */

    const storedUids = async () => (await db.execute({
      sql: "SELECT uid FROM mail_messages WHERE folder_id = ? ORDER BY uid ASC",
      args: [inbox.id],
    })).rows.map((row) => Number(row.uid));
    const expected = JSON.stringify([...uids].sort((a, b) => a - b));

    imap.bumpUidValidity("INBOX");
    imap.expunge("INBOX", oldUid);
    const nudged = await post(`${accountsPath}/${accountId}/sync`, {});
    assert.ok(nudged.status === 202 || nudged.status === 200, nudged.text);
    assert.equal(await until(async () => JSON.stringify(await storedUids()) === expected), true,
      `a UIDVALIDITY reset leaves exactly the server's messages (${await storedUids()})`);
    assert.equal(await count("mail_messages"), 3, "no duplicate and no orphan after the reset");

    /* ------------------------------------------------------ drop and back-off */

    const uncaught = [];
    const spy = (err) => uncaught.push(err);
    process.on("uncaughtException", spy);
    try {
      imap.dropConnections();
      assert.equal(await until(async () => (await supervisor.status(accountId)).state === "backoff"), true,
        "the dropped connection is a failure, not a crash");
      imap.deliver("INBOX", makeRaw({
        subject: SUBJECTS[3],
        body: "Delivered while the mailbox was away.",
        messageId: "after-drop@example.test",
      }));
      // The back-off ladder (five seconds at the first failure) is fired by hand.
      await clock.advance(60 * 1000);
      assert.equal(await until(async () => (await count("mail_messages")) === 4), true,
        "the delivery arrives after the back-off, with no syncNow");
      assert.deepEqual(uncaught, [], "the dropped connection raised no uncaught error");
    } finally {
      process.off("uncaughtException", spy);
    }

    /* ---------------------------------------------------------------- delete */

    const deleted = await del(`${accountsPath}/${accountId}`);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.json.ok, true);
    for (const table of [
      "mail_accounts", "mail_folders", "mail_threads", "mail_messages",
      "mail_messages_fts", "mail_sync_state", "mail_image_allow",
    ]) {
      assert.equal(await count(table), 0, `${table} is empty after the delete`);
    }
    const keychain = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM crow_keychain WHERE connection_uuid = ?",
      args: [accountId],
    });
    assert.equal(Number(keychain.rows[0].n), 0, "the sealed password is gone");
    const live = (await listClaims(db, FAKE_USER)).filter((claim) => !claim.released);
    assert.deepEqual(live, [], "the claim is a tombstone now");

    await handle.stop();
    handle = null;

    const captured = output.join("\n");
    assert.equal(captured.includes(FAKE_PASSWORD), false, "the password never reaches the output");
    for (const subject of [...SUBJECTS, OLD_SUBJECT]) {
      assert.equal(captured.includes(subject), false, `no subject in the output (${subject})`);
    }
    // The supervisor's own log lines are the other sink: a message subject or the password must not
    // be in one either.
    const logged = JSON.stringify(logs);
    assert.equal(logged.includes(FAKE_PASSWORD), false, "the password never reaches a log line");
    for (const subject of [...SUBJECTS, OLD_SUBJECT]) {
      assert.equal(logged.includes(subject), false, `no subject in a log line (${subject})`);
    }
  } finally {
    if (handle != null) await handle.stop();
    await stopMailSync();
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    await imap.close();
    await smtp.close();
    delete process.env.CROW_MAIL;
    process.env.CROW_TASKS_DB_PATH = MASTER_TASKS_DB_PATH;
  }
});