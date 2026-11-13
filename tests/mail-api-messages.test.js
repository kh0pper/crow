// Crow Mail's private API, mailbox routes: lists, one message, images, search and older mail
// (plan 1, Task 20).
//
// Harness: Task 19's (tests/mail-api-accounts.test.js) — a real init-db'd scratch crow.db copied per
// test (CROW_DATA_DIR, so nothing can touch ~/.crow), an ephemeral express app wired the way
// servers/gateway/index.js and dashboard/index.js wire it (the global 1mb JSON parser skipped by
// index.js's own `_hasOwnParser` predicate, read from its source; then a session stub, the dashboard's
// real CSRF middleware, then the real mail API router), the real account, folder and message stores,
// a fake mail adapter behind a recording supervisor, and the real owner rule with the request marked
// as coming from the owner's laptop (tests/helpers/off-box.js). No pi, no network, no host config.
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

const root = mkdtempSync(join(tmpdir(), "mail-api-messages-"));
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
const { MAIL_ERROR_TEXT } = await import("../servers/gateway/mail/errors.js");
const { createAccount, isImageAllowed } = await import("../servers/gateway/mail/store/accounts.js");
const { setFolderSyncState, upsertFolders, upsertMessage } = await import("../servers/gateway/mail/store/messages.js");
const { createFakeMailAdapter } = await import("./fixtures/fake-mail-adapter.mjs");

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const CSRF = "csrf-token-value";

const MESSAGES = `${MAIL_API_PREFIX}/messages`;
const SEARCH = `${MAIL_API_PREFIX}/search`;
const REMOTE_SEARCH = `${MAIL_API_PREFIX}/search/remote`;
const IMAGE_ALLOW = `${MAIL_API_PREFIX}/image-allow`;
const olderPath = (id) => `${MAIL_API_PREFIX}/folders/${encodeURIComponent(id)}/older`;

/** Exactly what a list item carries: no body, no headers, no attachment bytes. */
const SUMMARY_KEYS = [
  "accountId", "date", "folderId", "fromAddr", "fromName", "hasAttachments", "id", "isRead",
  "messageId", "snippet", "subject", "threadId",
];

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

/* ------------------------------------------------------------------ HTTP */

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
function call(method, path, { body, headers = {}, token = OWNER, csrf = CSRF, laptop = true } = {}) {
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const h = { ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) };
  if (token) h.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
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

const get = (path, opts) => call("GET", path, opts);
const post = (path, body, opts) => call("POST", path, { body, ...opts });
const del = (path, { body, ...opts } = {}) => call("DELETE", path, { body, ...opts });

const page = (params) => `${MESSAGES}?${new URLSearchParams(params).toString()}`;

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

/* ----------------------------------------------------------------- setup */

let n = 0;

/** A supervisor that hands the fake adapter of one account to `fn`, and records its own calls. */
function makeSupervisor(adapterFor) {
  const calls = [];
  return {
    calls,
    async syncNow(accountId) { calls.push(["syncNow", accountId]); },
    async restartAccount(accountId) { calls.push(["restartAccount", accountId]); },
    async withAdapter(accountId, fn) {
      calls.push(["withAdapter", accountId]);
      return fn(adapterFor(accountId));
    },
  };
}

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

/* ----------------------------------------------------------------- seeds */

const ENDPOINT = { host: "mail.example.test", port: 993, security: "ssl" };
const DEFAULT_FOLDERS = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
  { path: "Sent", name: "Sent", specialUse: "\\Sent", delimiter: "/" },
];

/** One account with its folders: the store's own rows, so the routes see what a sync would write. */
async function seedAccount(s, { address = "alex@example.com", label = "Personal", folders = null } = {}) {
  const account = await createAccount(s.db, {
    label,
    address,
    authKind: "password",
    imap: ENDPOINT,
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const listed = await upsertFolders(s.db, account.id, folders ?? DEFAULT_FOLDERS);
  return {
    account,
    folders: listed.folders,
    inbox: listed.folders.find((folder) => folder.path === "INBOX"),
  };
}

/** One stored message, with the fields a test cares about; everything else is a plain default. */
async function seedMessage(s, account, folder, over = {}) {
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

/** A hand-written RFC 822 message for the fake adapter's mailbox. */
function makeRaw({ from = "Sam <sam@example.com>", to = "alex@example.com", subject = "Hello", body = "hi", messageId = "<raw-1@mail.example.test>" } = {}) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Date: Wed, 01 Oct 2025 10:00:00 +0000",
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    body,
    "",
  ].join("\r\n");
}

/* ------------------------------------------------------------------ tests */

test("the flag: every mailbox route is 404 with no data while CROW_MAIL is unset", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, { uid: 1, subject: "Private subject line" });

  delete process.env.CROW_MAIL;
  try {
    const answers = [
      ["GET /messages", await get(MESSAGES)],
      ["GET /messages/:id", await get(`${MESSAGES}/${written.id}`)],
      ["GET /search", await get(`${SEARCH}?q=hello`)],
      ["POST /search/remote", await post(REMOTE_SEARCH, { q: "hello" })],
      ["POST /folders/:id/older", await post(olderPath(inbox.id), {})],
      ["POST /image-allow", await post(IMAGE_ALLOW, { accountId: account.id, sender: "sam@example.com" })],
    ];
    for (const [what, r] of answers) {
      assert.equal(r.status, 404, `${what}: ${r.text}`);
      assert.deepEqual(r.json, { error: "not_found", message: "Not found." }, what);
      assert.equal(r.text.includes("Private subject line"), false, `${what} carries no subject`);
    }
    assert.deepEqual(s.supervisor.calls, [], "no account was touched");
  } finally {
    process.env.CROW_MAIL = "1";
  }
});

test("a peer SSO session and a request from this machine are 403 with no data", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, { uid: 1, subject: "Private subject line" });

  const cases = [
    ["a peer's SSO session", { token: SSO }],
    ["a request from this machine", { token: OWNER, laptop: false }],
  ];
  for (const [label, opts] of cases) {
    for (const r of [
      await get(MESSAGES, opts),
      await get(`${MESSAGES}/${written.id}`, opts),
      await get(`${SEARCH}?q=hello`, opts),
      await post(REMOTE_SEARCH, { q: "hello" }, opts),
      await post(olderPath(inbox.id), {}, opts),
      await post(IMAGE_ALLOW, { accountId: account.id, sender: "sam@example.com" }, opts),
      await del(IMAGE_ALLOW, { body: { accountId: account.id, sender: "sam@example.com" }, ...opts }),
    ]) {
      assert.equal(r.status, 403, `${label}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: "owner_only", message: "Only the owner can see this." }, label);
      assert.equal(r.text.includes("Private subject line"), false, `${label}: no subject`);
      assert.equal(r.text.includes(account.address), false, `${label}: no address`);
    }
  }
  assert.deepEqual(s.supervisor.calls, [], "nothing reached an adapter");
  assert.equal(await s.count("mail_image_allow"), 0);
});

test("RF4: keyset paging has no repeat and no gap while mail arrives between pages", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const baseDate = 1_700_000_000_000;
  const seeded = [];
  for (let i = 0; i < 60; i += 1) {
    const written = await seedMessage(s, account, inbox, {
      uid: 100 + i,
      subject: `Bulk ${i}`,
      snippet: `bulk-${i}`,
      date: baseDate + Math.floor(i / 20),
    });
    seeded.push(written.id);
  }

  const seen = [];
  let cursor = null;
  for (let round = 0; round < 10; round += 1) {
    const params = { account: account.id, role: "inbox", limit: "20" };
    if (cursor) params.cursor = cursor;
    const r = await get(page(params));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers["cache-control"], "no-store", "a mailbox list is never cached");
    for (const item of r.json.items) {
      assert.deepEqual(Object.keys(item).sort(), SUMMARY_KEYS, "an item carries no body");
      seen.push(item.id);
    }
    cursor = r.json.nextCursor;
    if (round === 0) {
      // Mail arrives between the first page and the second: newest of them all, so it belongs above
      // the cursor and must not shift the older pages.
      await seedMessage(s, account, inbox, { uid: 200, subject: "Arrived later", date: baseDate + 10_000 });
    }
    if (!cursor) break;
  }

  assert.equal(new Set(seen).size, seen.length, "no message is listed twice");
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [...seeded].sort((a, b) => a - b),
    "every seeded message is listed exactly once",
  );
});

test("GET /messages clamps the page size and refuses a bad cursor, role, folder or account", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  for (let i = 0; i < 3; i += 1) {
    await seedMessage(s, account, inbox, { uid: 100 + i, subject: `Note ${i}`, date: 1_700_000_000_000 + i });
  }

  const clampedLow = await get(page({ account: account.id, limit: "0" }));
  assert.equal(clampedLow.status, 200, clampedLow.text);
  assert.equal(clampedLow.json.items.length, 1, "a limit below the floor becomes one");

  const clampedHigh = await get(page({ account: account.id, limit: "1000" }));
  assert.equal(clampedHigh.json.items.length, 3);
  assert.equal(clampedHigh.json.nextCursor, null, "a page above the ceiling is still one page");

  for (const [what, r] of [
    ["a cursor that is not one", await get(page({ account: account.id, cursor: "not-a-cursor" }))],
    ["a role outside the list", await get(page({ account: account.id, role: "everything" }))],
    ["a limit that is not a number", await get(page({ account: account.id, limit: "many" }))],
  ]) {
    assert.equal(r.status, 400, `${what}: ${r.text}`);
    assert.equal(r.json.error, "bad_input", what);
  }

  for (const [what, r] of [
    ["an unknown folder", await get(page({ folder: "999999" }))],
    ["a folder id that is not one", await get(page({ folder: "not-a-folder" }))],
    ["an unknown account", await get(page({ account: "ma-0123456789abcdef" }))],
  ]) {
    assert.equal(r.status, 404, `${what}: ${r.text}`);
    assert.deepEqual(r.json, { error: "not_found", message: "Not found." }, what);
  }
});

test("the unified inbox merges accounts by date, and another account's folder is a 404", async () => {
  const s = await setup();
  const alex = await seedAccount(s, { address: "alex@example.com", label: "Personal" });
  const sam = await seedAccount(s, { address: "sam@example.com", label: "Work" });
  const alexMessage = await seedMessage(s, alex.account, alex.inbox, {
    uid: 1, subject: "Alex older", date: 1_700_000_000_000,
  });
  await seedMessage(s, sam.account, sam.inbox, { uid: 1, subject: "Sam newer", date: 1_700_000_500_000 });

  const unified = await get(page({ account: "all", role: "inbox" }));
  assert.equal(unified.status, 200, unified.text);
  assert.deepEqual(unified.json.items.map((item) => item.subject), ["Sam newer", "Alex older"]);
  assert.deepEqual(unified.json.items.map((item) => item.accountId), [sam.account.id, alex.account.id]);

  const oneAccount = await get(page({ account: alex.account.id, role: "inbox" }));
  assert.deepEqual(oneAccount.json.items.map((item) => item.id), [alexMessage.id]);

  const inFolder = await get(page({ account: alex.account.id, folder: String(alex.inbox.id) }));
  assert.deepEqual(inFolder.json.items.map((item) => item.id), [alexMessage.id]);

  const foreignFolder = await get(page({ account: alex.account.id, folder: String(sam.inbox.id) }));
  assert.equal(foreignFolder.status, 404);
  assert.deepEqual(foreignFolder.json, { error: "not_found", message: "Not found." });
});

test("GET /messages/:id sanitises the body, counts blocked images, and shows them only when asked or allowed", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const html = [
    '<p data-crow-brief-marker="marker-8fd1">Hello there</p>',
    '<script>window.pwned = "marker-script"</script>',
    '<img src="https://track.example.test/pixel.gif" width="1" height="1">',
  ].join("");
  const written = await seedMessage(s, account, inbox, {
    uid: 1,
    subject: "Your receipt",
    html,
    text: "Hello there",
    from: { name: "Sam", address: "sam@example.com" },
    attachments: [
      { filename: "report.pdf", contentType: "application/pdf", size: 1234, contentId: null, disposition: "attachment" },
    ],
  });

  const blocked = await get(`${MESSAGES}/${written.id}`);
  assert.equal(blocked.status, 200, blocked.text);
  assert.equal(blocked.headers["cache-control"], "no-store");
  assert.equal(blocked.json.subject, "Your receipt");
  assert.deepEqual(blocked.json.from, { name: "Sam", address: "sam@example.com" });
  assert.equal(blocked.json.isRead, false);
  assert.equal(blocked.json.parseError, null);
  assert.deepEqual(blocked.json.attachments, [
    { filename: "report.pdf", contentType: "application/pdf", size: 1234 },
  ], "attachments are metadata only");
  assert.equal(blocked.json.body.source, "html");
  assert.equal(blocked.json.body.imagesShown, false);
  assert.equal(blocked.json.body.remoteImageCount, 1);
  assert.equal(blocked.json.body.blockedRemoteImageCount, 1);
  assert.ok(blocked.json.body.html.includes("Hello there"), "the text survives");
  assert.ok(blocked.json.body.html.includes('data-crow-blocked="1"'), "a blocked image is marked");
  for (const needle of ["marker-8fd1", "data-crow-brief-marker", "window.pwned", "<script", "pixel.gif"]) {
    assert.equal(blocked.text.includes(needle), false, `the answer carries no ${needle}`);
  }

  const asked = await get(`${MESSAGES}/${written.id}?images=1`);
  assert.equal(asked.status, 200, asked.text);
  assert.equal(asked.json.body.imagesShown, true);
  assert.equal(asked.json.body.blockedRemoteImageCount, 0);
  assert.ok(asked.json.body.html.includes('src="https://track.example.test/pixel.gif"'));

  const blockedAgain = await get(`${MESSAGES}/${written.id}`);
  assert.equal(blockedAgain.json.body.imagesShown, false, "images=1 applied to that call only");
  assert.equal(blockedAgain.json.body.blockedRemoteImageCount, 1);

  const allowed = await post(IMAGE_ALLOW, { accountId: account.id, sender: "Sam@Example.COM" });
  assert.equal(allowed.status, 200, allowed.text);
  assert.deepEqual(allowed.json, { ok: true, allowed: true });
  const stored = await s.db.execute({
    sql: "SELECT sender FROM mail_image_allow WHERE account_id = ?",
    args: [account.id],
  });
  assert.deepEqual(stored.rows.map((row) => row.sender), ["sam@example.com"], "the sender is stored lower-cased");

  const bySender = await get(`${MESSAGES}/${written.id}`);
  assert.equal(bySender.json.body.imagesShown, true, "an allow-listed sender's images show unasked");
  assert.equal(bySender.json.body.blockedRemoteImageCount, 0);

  assert.equal((await post(IMAGE_ALLOW, { accountId: account.id, sender: "sam@example.com" })).status, 200);
  assert.equal(await s.count("mail_image_allow", "WHERE account_id = ?", [account.id]), 1, "adding twice holds one row");

  const removed = await del(IMAGE_ALLOW, { body: { accountId: account.id, sender: "sam@example.com" } });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(removed.json, { ok: true, allowed: false });
  assert.equal(await isImageAllowed(s.db, account.id, "sam@example.com"), false);

  const blockedAfterDelete = await get(`${MESSAGES}/${written.id}`);
  assert.equal(blockedAfterDelete.json.body.imagesShown, false, "the allowance ended with the DELETE");
  assert.equal(blockedAfterDelete.json.body.blockedRemoteImageCount, 1);
  assert.equal((await del(IMAGE_ALLOW, { body: { accountId: account.id, sender: "sam@example.com" } })).status, 200);

  for (const body of [
    { accountId: account.id, sender: "Sam <sam@example.com>" },
    { accountId: account.id, sender: "no-at-sign" },
    { accountId: account.id, sender: "" },
    { sender: "sam@example.com" },
  ]) {
    const r = await post(IMAGE_ALLOW, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    assert.equal(r.json.error, "bad_input");
  }
  const unknown = await post(IMAGE_ALLOW, { accountId: "ma-0123456789abcdef", sender: "sam@example.com" });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, { error: "not_found", message: "Not found." });
});

test("a stored parseError comes back as it is, and an unknown message or account is a 404", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, {
    uid: 5, subject: "Too big", text: "", html: null, snippet: "", parseError: "too_large",
  });

  const r = await get(`${MESSAGES}/${written.id}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.parseError, "too_large");
  assert.deepEqual(r.json.body, {
    html: "",
    source: "none",
    remoteImageCount: 0,
    blockedRemoteImageCount: 0,
    imagesShown: false,
  });
  assert.deepEqual(r.json.attachments, []);

  for (const bad of ["999999", "not-an-id", "0", "-1"]) {
    const missing = await get(`${MESSAGES}/${bad}`);
    assert.equal(missing.status, 404, bad);
    assert.deepEqual(missing.json, { error: "not_found", message: "Not found." });
  }

  // A row whose account is gone is not readable either.
  await s.db.execute({ sql: "DELETE FROM mail_accounts WHERE id = ?", args: [account.id] });
  const orphan = await get(`${MESSAGES}/${written.id}`);
  assert.equal(orphan.status, 404);
  assert.deepEqual(orphan.json, { error: "not_found", message: "Not found." });
});

test("GET /search is local only: it finds a message per account and refuses an empty q or a remote parameter", async () => {
  const s = await setup();
  const alex = await seedAccount(s, { address: "alex@example.com", label: "Personal" });
  const sam = await seedAccount(s, { address: "sam@example.com", label: "Work" });
  await seedMessage(s, alex.account, alex.inbox, {
    uid: 1, subject: "Quarterly invoice", from: { name: "Kim", address: "kim@example.com" }, text: "the amount is due",
  });
  await seedMessage(s, sam.account, sam.inbox, {
    uid: 1, subject: "Lunch", from: { name: "Lee", address: "lee@example.com" }, text: "quarterly plans",
  });
  const adapter = s.adapterFor(alex.account.id);

  const everywhere = await get(`${SEARCH}?q=quarterly&account=all`);
  assert.equal(everywhere.status, 200, everywhere.text);
  assert.equal(everywhere.json.items.length, 2);

  const one = await get(`${SEARCH}?q=quarterly&account=${alex.account.id}`);
  assert.equal(one.json.items.length, 1);
  assert.equal(one.json.items[0].accountId, alex.account.id);
  assert.deepEqual(Object.keys(one.json.items[0]).sort(), SUMMARY_KEYS, "a result carries no body");

  const bySender = await get(`${SEARCH}?q=kim`);
  assert.equal(bySender.json.items.length, 1);
  assert.equal(bySender.json.items[0].subject, "Quarterly invoice");

  for (const query of ["", "   "]) {
    const r = await get(`${SEARCH}?q=${encodeURIComponent(query)}`);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error, "bad_input");
  }
  const absent = await get(SEARCH);
  assert.equal(absent.status, 400, absent.text);

  const before = await s.count("mail_messages");
  const remoteParam = await get(`${SEARCH}?q=quarterly&remote=1`);
  assert.equal(remoteParam.status, 400, "a GET must not write by searching the server");
  assert.equal(remoteParam.json.error, "bad_input");
  assert.equal(await s.count("mail_messages"), before, "nothing was stored");
  assert.equal(adapter.calls.some((call) => call.method === "search"), false, "no server was asked");
});

test("RF4: hostile search input never fails the route", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  await seedMessage(s, account, inbox, { uid: 1, subject: "Invoice", text: "body words" });

  for (const query of ['"', "NEAR(", "*", "AND", "a".repeat(10000), '"" OR ""', "* AND NEAR(", "%", "_", "OR OR"]) {
    const r = await get(`${SEARCH}?q=${encodeURIComponent(query)}`);
    assert.equal(r.status, 200, `${query.slice(0, 12)}: ${r.text}`);
    assert.ok(Array.isArray(r.json.items), query.slice(0, 12));
  }
});

test("POST /search/remote stores an older server-only message, and only with a CSRF token", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  await seedMessage(s, account, inbox, { uid: 101, subject: "Window", text: "newer local", date: Date.now() });
  await setFolderSyncState(s.db, inbox.id, { uidValidity: 71, highestUid: 101, floorUid: 101 });
  const adapter = s.adapterFor(account.id);
  adapter.deliver("INBOX", makeRaw({ subject: "Old zebra", body: "the zebra is old", messageId: "<old-1@mail.example.test>" }), {
    internalDate: Date.now() - 200 * 86400000,
  });

  const refused = await post(REMOTE_SEARCH, { q: "zebra" }, { csrf: null });
  assert.equal(refused.status, 403, refused.text);
  assert.match(refused.text, /CSRF/i, "the dashboard rail answers, not this router");
  assert.equal(adapter.calls.some((call) => call.method === "search"), false);

  const empty = await post(REMOTE_SEARCH, { q: "   " });
  assert.equal(empty.status, 400, empty.text);
  assert.equal(empty.json.error, "bad_input");
  assert.equal(adapter.calls.some((call) => call.method === "search"), false);

  const unknown = await post(REMOTE_SEARCH, { q: "zebra", account: "ma-0123456789abcdef" });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, { error: "not_found", message: "Not found." });

  const before = await s.count("mail_messages");
  const r = await post(REMOTE_SEARCH, { q: "zebra", account: account.id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { added: 1, failures: [] });
  assert.equal(await s.count("mail_messages"), before + 1, "the older hit was stored");
  const stored = await s.db.execute({
    sql: "SELECT uid, subject FROM mail_messages WHERE folder_id = ? AND uid = 1",
    args: [inbox.id],
  });
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].subject, "Old zebra");

  const found = await get(`${SEARCH}?q=zebra`);
  assert.equal(found.json.items.length, 1, "and the local search finds it afterwards");
});

test("POST /search/remote and POST /folders/:id/older answer 'unavailable' with no supervisor", async () => {
  const s = await setup({ supervisor: null });
  const { account, inbox } = await seedAccount(s);

  const search = await post(REMOTE_SEARCH, { q: "zebra", account: account.id });
  assert.equal(search.status, 503, search.text);
  assert.equal(search.json.error, "unavailable");

  const older = await post(olderPath(inbox.id), {});
  assert.equal(older.status, 503, older.text);
  assert.equal(older.json.error, "unavailable");
});

test("RF2: a failed remote search reports the code's fixed sentence and never the library's text", async () => {
  const SEEDED = "hunter2-do-not-print";
  const supervisor = {
    calls: [],
    async syncNow() {},
    async restartAccount() {},
    async withAdapter(accountId, fn) {
      supervisor.calls.push(accountId);
      const adapter = createFakeMailAdapter();
      adapter.search = async () => {
        const err = new Error(`IMAP tagged NO: login failed for alex with ${SEEDED}`);
        err.code = "EUNKNOWNSERVER";
        throw err;
      };
      return fn(adapter);
    },
  };
  const s = await setup({ supervisor });
  const { account } = await seedAccount(s);

  const { lines, result } = await warnings(() => post(REMOTE_SEARCH, { q: "zebra" }));
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.added, 0);
  assert.deepEqual(result.json.failures, [{ accountId: account.id, error: MAIL_ERROR_TEXT.PROTOCOL }]);
  for (const text of [result.text, lines.join("\n")]) {
    assert.equal(text.includes(SEEDED), false, "the seeded secret travels nowhere");
    assert.equal(text.includes("login failed"), false, "no library text either");
  }
});

test("POST /folders/:id/older pages a folder's history back and reports the start of it", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  await seedMessage(s, account, inbox, { uid: 5, subject: "Newest local", date: Date.now() });
  await setFolderSyncState(s.db, inbox.id, { uidValidity: 71, highestUid: 5, floorUid: 5 });
  const adapter = s.adapterFor(account.id);
  for (let i = 1; i <= 4; i += 1) {
    adapter.deliver("INBOX", makeRaw({ subject: `Older ${i}`, body: `older body ${i}`, messageId: `<older-${i}@mail.example.test>` }), {
      internalDate: Date.now() - i * 86400000,
    });
  }

  const r = await post(olderPath(inbox.id), {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { added: 4, reachedStart: true });
  const uids = (await s.db.execute({
    sql: "SELECT uid FROM mail_messages WHERE folder_id = ? ORDER BY uid ASC",
    args: [inbox.id],
  })).rows.map((row) => Number(row.uid));
  assert.deepEqual(uids, [1, 2, 3, 4, 5]);

  for (const bad of ["999999", "not-a-folder"]) {
    const missing = await post(olderPath(bad), {});
    assert.equal(missing.status, 404, bad);
    assert.deepEqual(missing.json, { error: "not_found", message: "Not found." });
  }
});

test("RF2: an adapter failure while paging older mail answers only the code's fixed sentence", async () => {
  const SEEDED = "hunter2-in-the-imap-reply";
  const supervisor = {
    calls: [],
    async syncNow() {},
    async restartAccount() {},
    async withAdapter(accountId, fn) {
      supervisor.calls.push(accountId);
      const adapter = createFakeMailAdapter();
      adapter.list = async () => {
        const err = new Error(`IMAP server said: ${SEEDED}`);
        err.code = "EWEIRDREPLY";
        throw err;
      };
      return fn(adapter);
    },
  };
  const s = await setup({ supervisor });
  const { account, inbox } = await seedAccount(s);
  await seedMessage(s, account, inbox, { uid: 5, subject: "Local" });
  await setFolderSyncState(s.db, inbox.id, { uidValidity: 71, highestUid: 5, floorUid: 5 });

  const { lines, result } = await warnings(() => post(olderPath(inbox.id), {}));
  assert.equal(result.status, 502, result.text);
  assert.deepEqual(result.json, { error: "PROTOCOL", message: MAIL_ERROR_TEXT.PROTOCOL });
  for (const text of [result.text, lines.join("\n")]) {
    assert.equal(text.includes(SEEDED), false, "the seeded secret travels nowhere");
  }
  assert.equal(await s.count("mail_messages"), 1, "nothing was touched");
});

test("a Gmail-style duplicate is one inbox row and one search hit; the store lists its two rows", async () => {
  const s = await setup();
  const { account, inbox, folders } = await seedAccount(s, {
    folders: [
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
      { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", delimiter: "/" },
    ],
  });
  const label = folders.find((folder) => folder.path === "[Gmail]/All Mail");
  const date = 1_700_000_000_000;
  const same = { messageId: "<dup-1@mail.example.test>", subject: "Label copy", from: { name: "Sam", address: "sam@example.com" }, date };
  await seedMessage(s, account, inbox, { ...same, uid: 10, text: "the duplicate body" });
  await seedMessage(s, account, label, { ...same, uid: 20, text: "the duplicate body" });

  const inboxOnly = await get(page({ account: "all", role: "inbox" }));
  assert.equal(inboxOnly.json.items.length, 1, "only INBOX has the inbox role");

  const everyRow = await get(page({ account: account.id }));
  assert.equal(everyRow.json.items.length, 2, "listMessages shows every stored row, as the store documents");
  assert.deepEqual(
    everyRow.json.items.map((item) => item.messageId),
    ["<dup-1@mail.example.test>", "<dup-1@mail.example.test>"],
  );

  const found = await get(`${SEARCH}?q=duplicate`);
  assert.equal(found.json.items.length, 1, "search dedupes the two rows into one message");
  assert.equal(found.json.items[0].messageId, "<dup-1@mail.example.test>");
});