/**
 * Crow Mail's account settings page, the add-account form and the password update route (plan 2,
 * Task 7), through the REAL dashboard router over a scratch CROW_DATA_DIR and CROW_HOME: accounts are
 * written with plan 1's stores, the page is read over HTTP, and the update route runs on a mail API
 * router built here with this file's own adapter factory and a recording supervisor.
 *
 * The page: one card per account (label, address, a status word, the sync and model controls, the
 * allowed senders, the remove block behind its own sentence), the "Mail is set up on <instance>"
 * lines for mail held elsewhere, and the add-account form below — with no host, port, username or
 * secret of any stored account in the answer. A label carrying markup stays text, and a person's
 * quotes stay inside the attribute.
 *
 * The route: a refused sign-in stores nothing (400, fixed sentence), an accepted one stores the
 * secret, marks the account active, restarts it and starts a sync, and the next factory call is
 * handed the new password. An OAuth account is refused; nothing is dialled. A failing adapter's own
 * text never reaches the answer.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "mail-reader-settings-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
delete process.env.CROW_MAIL;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-mail-settings");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

const PEER = "inst-peer-settings";
const NET = serveHeaders("operator@example.com");
const SETTINGS = "/dashboard/mail?view=settings";
const ACCOUNTS_API = "/dashboard/mail/api/accounts";
const OLD_PASSWORD = "old-app-password";
const NEW_PASSWORD = "new-app-password";

let server, base, MODE;
const stores = { accounts: null, credentials: null };
let createFakeMailAdapter, MailError, MAIL_ERROR_TEXT;

/** The mail API's dependencies for one test: a factory whose answer the test decides, and a supervisor
 *  that records the restart and the sync the route asks for. */
let factory = () => createFakeMailAdapter();
let factoryCalls = [];
let supervisorCalls = [];
const supervisor = {
  async syncNow(id) { supervisorCalls.push(["syncNow", id]); },
  async restartAccount(id) { supervisorCalls.push(["restartAccount", id]); },
};
const adapterFactory = (args) => {
  factoryCalls.push(args);
  return factory(args);
};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')");
  tok.run(hashToken("owner-sess"), "dashboard");
  tok.run(hashToken("sso-sess"), "dashboard sso src:instance-peer");
  c.close();

  stores.accounts = await import("../servers/gateway/mail/store/accounts.js");
  stores.credentials = await import("../servers/gateway/mail/credentials.js");
  ({ createFakeMailAdapter } = await import("./fixtures/fake-mail-adapter.mjs"));
  ({ MailError, MAIL_ERROR_TEXT } = await import("../servers/gateway/mail/errors.js"));
  const { default: mailApiRouter } = await import("../servers/gateway/routes/mail-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { markFromLaptop } = await import("./helpers/off-box.js");

  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => {
    res.redirectAfterPost = (url) => res.redirect(303, url);
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  // The mail API as the gateway wires it, with this file's factory and supervisor: the dashboard's own
  // mount is built at import time and would hold the real adapter, so this one answers first.
  const sessionGate = (req, res, next) => {
    const cookies = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    if (!cookies.crow_session) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = cookies.crow_session;
    markFromLaptop(req);
    next();
  };
  const apiDash = express.Router();
  apiDash.use("/dashboard", csrfMiddleware);
  apiDash.use(mailApiRouter(sessionGate, { adapterFactory, supervisor }));
  app.use(apiDash);
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  delete process.env.CROW_MAIL;
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  factory = () => createFakeMailAdapter();
  factoryCalls = [];
  supervisorCalls = [];
  const c = new Database(DB_FILE);
  try {
    c.prepare("DELETE FROM mail_messages").run();
    c.prepare("DELETE FROM mail_folders").run();
    c.prepare("DELETE FROM mail_threads").run();
    c.prepare("DELETE FROM mail_image_allow").run();
    c.prepare("DELETE FROM mail_sync_state").run();
    c.prepare("DELETE FROM mail_accounts").run();
    c.prepare("DELETE FROM crow_instances").run();
    c.prepare("DELETE FROM dashboard_settings WHERE key LIKE 'mail_claim_%'").run();
    c.prepare("DELETE FROM dashboard_settings_overrides WHERE key LIKE 'mail_claim_%'").run();
  } finally { c.close(); }
});

const jar = (sess) => `crow_session=${sess}; crow_csrf=tok; ${MODE}=new`;

async function call(method, path, { sess = "owner-sess", csrf = "tok", body } = {}) {
  const headers = { ...NET, cookie: jar(sess) };
  if (csrf) headers["x-crow-csrf"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: text, json, headers: r.headers };
}

const get = (path, opts) => call("GET", path, opts);

async function withFlag(fn) {
  process.env.CROW_MAIL = "1";
  try { return await fn(); } finally { delete process.env.CROW_MAIL; }
}

async function withDb(fn) {
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try { return await fn(db); } finally { db.close(); }
}

/** Let every background promise of one request reach its end. */
const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
};

const ACCOUNT = (label, address, username) => ({
  label,
  address,
  username,
  authKind: "password",
  imap: { host: "mail.example.test", port: 993, security: "ssl" },
  smtp: { host: "mail.example.test", port: 465, security: "ssl" },
});

/** A peer instance the claim rules count as live, and a claim it holds on `address`. */
async function heldElsewhere(address, instanceName) {
  const { writeClaim } = await import("../servers/gateway/mail/claims.js");
  await withDb(async (db) => {
    await db.execute({
      sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, 'crow:mail', 'active')",
      args: [PEER, instanceName],
    });
    await writeClaim(db, address, { localInstanceId: PEER, instanceName, now: 1_000 });
  });
}

/** The mail API's dependencies for one test: a factory whose answer the test decides, and the
 *  recording supervisor above. */
function useFactory(chosen = () => createFakeMailAdapter()) {
  factory = chosen;
  return { calls: supervisorCalls, factoryCalls, supervisor };
}

/** One stored account with its old secret in the keychain. */
async function accountWithSecret(input = ACCOUNT("Personal", "alex@example.com", "alexuser")) {
  return withDb(async (db) => {
    const account = await stores.accounts.createAccount(db, input);
    const credentials = stores.credentials.createMailCredentials({ db });
    await credentials.saveSecret(account.id, "MAIL_PASSWORD", OLD_PASSWORD);
    return account;
  });
}

async function secretOf(id) {
  return withDb(async (db) => {
    const credentials = stores.credentials.createMailCredentials({ db });
    const secrets = await credentials.getSecrets(id);
    return secrets.MAIL_PASSWORD ?? null;
  });
}

const passwordPath = (id) => `${ACCOUNTS_API}/${encodeURIComponent(id)}/password`;
const putPassword = (id, body, opts) => call("PUT", passwordPath(id), { body, ...opts });

/* ---------------------------------------------------------------- the page */

test("settings lists accounts with status words and no host, port, username or secret", async () => {
  const active = await withDb((db) => stores.accounts.createAccount(db, ACCOUNT("Personal", "alex@example.com", "alexuser")));
  const held = await withDb((db) => stores.accounts.createAccount(db, ACCOUNT("Shared", "sam@example.com", "samuser")));
  await withDb((db) => db.execute({ sql: "UPDATE mail_accounts SET status = 'claimed_elsewhere' WHERE id = ?", args: [held.id] }));
  await heldElsewhere("sam@example.com", "Studio");

  await withFlag(async () => {
    const r = await get(SETTINGS);
    assert.equal(r.status, 200);
    assert.match(r.body, /<div class="ml" data-ml>/);
    assert.match(r.body, new RegExp(`data-ml-account="${active.id}"`));
    assert.match(r.body, new RegExp(`data-ml-account="${held.id}"`));
    assert.match(r.body, /alex@example\.com/);
    assert.match(r.body, /sam@example\.com/);
    assert.match(r.body, /data-ml-status="active">Working</);
    assert.match(r.body, /<p class="ml-note">Mail is set up on Studio<\/p>/);
    assert.match(r.body, /data-ml-status="claimed_elsewhere">Connected on Studio</);
    assert.match(r.body, />Sync now</);
    assert.match(r.body, /Local models only/);
    assert.match(r.body, /Applies when Crow drafts or summarises with a model\./);
    for (const needle of ["mail.example.test", "alexuser", "samuser", OLD_PASSWORD]) {
      assert.equal(r.body.includes(needle), false, `the card carries ${needle}`);
    }
    // The cards and the form carry no connection detail: no port of any account is drawn.
    const start = r.body.indexOf("data-ml-settings");
    const end = r.body.indexOf("</form>", start);
    const settings = r.body.slice(start, end < 0 ? undefined : end);
    assert.ok(settings.includes("data-ml-account="), "the settings section is the slice");
    assert.doesNotMatch(settings, /\b993\b|\b465\b/, "no port of any account");
  });
});

test("an auth_failed account offers the password control; an active one does not", async () => {
  const failed = await withDb((db) => stores.accounts.createAccount(db, ACCOUNT("Personal", "alex@example.com", "alexuser")));
  const active = await withDb((db) => stores.accounts.createAccount(db, ACCOUNT("Work", "sam@example.com", "samuser")));
  await withDb((db) => stores.accounts.updateAccount(db, failed.id, { status: "auth_failed", statusDetail: "AUTH_FAILED" }));

  await withFlag(async () => {
    const r = await get(SETTINGS);
    assert.equal(r.status, 200);
    assert.match(r.body, /Sign-in failed\. Update the password\./);
    assert.match(r.body, new RegExp(`data-ml-update-password data-account="${failed.id}"`));
    assert.doesNotMatch(r.body, new RegExp(`data-ml-update-password data-account="${active.id}"`));
    assert.match(r.body, /Update password/);
  });
});

test("elsewhere and no local accounts shows the sentence and the add form", async () => {
  await heldElsewhere("sam@example.com", "Studio");
  await withFlag(async () => {
    const r = await get(SETTINGS);
    assert.equal(r.status, 200);
    assert.match(r.body, /<p class="ml-note">Mail is set up on Studio<\/p>/);
    assert.match(r.body, /<form[^>]*action="\/dashboard\/mail\/api\/accounts"[^>]*data-ml-add-account>/);
    assert.match(r.body, /Add an account/);
  });
});

test("a label with markup stays text and its rename field is attribute-escaped", async () => {
  const label = "R&D \"quoted\" <script>alert(1)</script>";
  await withDb((db) => stores.accounts.createAccount(db, ACCOUNT(label, "alex@example.com", "alexuser")));
  await withFlag(async () => {
    const r = await get(SETTINGS);
    assert.equal(r.status, 200);
    const escaped = "R&amp;D &quot;quoted&quot; &lt;script&gt;alert(1)&lt;/script&gt;";
    assert.ok(r.body.includes(`value="${escaped}"`), "the rename field's value is escaped");
    assert.ok(r.body.includes(escaped), "the label reads as text");
    assert.doesNotMatch(r.body, /<script>alert\(1\)/);
  });
});

test("every allowed sender is listed with its own remove control", async () => {
  const account = await withDb((db) => stores.accounts.createAccount(db, ACCOUNT("Personal", "alex@example.com", "alexuser")));
  await withDb(async (db) => {
    await stores.accounts.addImageAllow(db, account.id, "Sam@Example.com");
    await stores.accounts.addImageAllow(db, account.id, "other@example.com");
  });
  await withFlag(async () => {
    const r = await get(SETTINGS);
    assert.equal(r.status, 200);
    for (const sender of ["sam@example.com", "other@example.com"]) {
      assert.ok(r.body.includes(sender), sender);
      const tag = (r.body.match(new RegExp(`<button[^>]*data-ml-remove-sender[^>]*data-sender="${sender}"[^>]*>`)) || [])[0];
      assert.ok(tag, `a remove control for ${sender}`);
      assert.match(tag, new RegExp(`data-account="${account.id}"`), sender);
      assert.match(tag, /type="button"/, sender);
    }
    assert.match(r.body, />Remove</);
  });
});

test("the add form offers ssl and starttls and posts to the accounts route", async () => {
  await withFlag(async () => {
    const r = await get(SETTINGS);
    assert.equal(r.status, 200);
    assert.match(r.body, /<form[^>]*action="\/dashboard\/mail\/api\/accounts"[^>]*>/);
    assert.match(r.body, /<option value="ssl">ssl<\/option>/);
    assert.match(r.body, /<option value="starttls">starttls<\/option>/);
    assert.doesNotMatch(r.body, /value="none"/);
    for (const name of ["label", "address", "password", "imap-host", "imap-port", "imap-security",
      "smtp-host", "smtp-port", "smtp-security"]) {
      assert.match(r.body, new RegExp(`name="${name}"`), name);
    }
  });
});

test("remove sits behind its own sentence and the page itself calls nothing", async () => {
  await withDb((db) => stores.accounts.createAccount(db, ACCOUNT("Personal", "alex@example.com", "alexuser")));
  await withFlag(async () => {
    const r = await get(SETTINGS);
    assert.equal(r.status, 200);
    assert.match(r.body, /This deletes the mail Crow stored for it\. Mail on the server is not touched\./);
    assert.match(r.body, /data-ml-remove-account data-account="ma-[0-9a-f]{16}"/);
    const tag = (r.body.match(/<button[^>]*data-ml-remove-account-btn[^>]*>/) || [])[0];
    assert.ok(tag, "the remove control");
    assert.match(tag, /type="button"/, "a person confirms first; no implicit submit");
    // The destructive request belongs to the client script (Task 8), never to this markup.
    const source = readFileSync(join(REPO, "servers/gateway/dashboard/panels/mail/settings-html.js"), "utf8");
    assert.doesNotMatch(source, /fetch\(/);
    assert.doesNotMatch(source, /"DELETE"|'DELETE'/);
  });
});

/* ------------------------------------------------------- the password route */

test("the flag off and a peer SSO session are refused with no data", async () => {
  const account = await accountWithSecret();
  const { factoryCalls } = useFactory();

  const off = await putPassword(account.id, { password: NEW_PASSWORD });
  assert.equal(off.status, 404);
  assert.deepEqual(off.json, { error: "not_found", message: "Not found." });
  assert.equal(off.body.includes(NEW_PASSWORD), false);

  await withFlag(async () => {
    const sso = await putPassword(account.id, { password: NEW_PASSWORD }, { sess: "sso-sess" });
    assert.equal(sso.status, 403);
    assert.deepEqual(sso.json, { error: "owner_only", message: "Only the owner can see this." });
    assert.equal(sso.body.includes(NEW_PASSWORD), false);
  });
  assert.deepEqual(factoryCalls, [], "nothing was dialled");
  assert.equal(await secretOf(account.id), OLD_PASSWORD);
});

test("a wrong password is 400 with the fixed sentence and the stored secret is unchanged", async () => {
  const account = await accountWithSecret();
  const { calls } = useFactory(() => {
    const fake = createFakeMailAdapter();
    fake.failNext("connect", new MailError("AUTH_FAILED"));
    return fake;
  });
  await withFlag(async () => {
    const r = await putPassword(account.id, { password: NEW_PASSWORD });
    assert.equal(r.status, 400, r.body);
    assert.deepEqual(r.json, { error: "AUTH_FAILED", message: MAIL_ERROR_TEXT.AUTH_FAILED });
    assert.equal(r.body.includes(NEW_PASSWORD), false);
    assert.equal(r.body.includes(OLD_PASSWORD), false);
  });
  assert.equal(await secretOf(account.id), OLD_PASSWORD);
  assert.equal((await withDb((db) => stores.accounts.getAccount(db, account.id))).status, "active");
  assert.deepEqual(calls, [], "no restart and no sync for a refused sign-in");
});

test("a right password is stored, marks the account active, restarts it and starts a sync", async () => {
  const account = await accountWithSecret();
  await withDb((db) => stores.accounts.updateAccount(db, account.id, { status: "auth_failed", statusDetail: "AUTH_FAILED" }));
  const { calls, factoryCalls } = useFactory();
  await withFlag(async () => {
    const r = await putPassword(account.id, { password: NEW_PASSWORD });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.body.includes(NEW_PASSWORD), false, "the answer never echoes it");
    await flush();
    assert.deepEqual(calls, [["restartAccount", account.id], ["syncNow", account.id]]);
    // The next factory call is handed the new secret, not the cached one.
    const last = factoryCalls[factoryCalls.length - 1];
    const secrets = await last.credentials.getSecrets(account.id);
    assert.equal(secrets.MAIL_PASSWORD, NEW_PASSWORD);
    // And the page it goes back to never carries it either.
    const page = await get(SETTINGS);
    assert.equal(page.status, 200);
    assert.equal(page.body.includes(NEW_PASSWORD), false);
  });
  assert.equal(await secretOf(account.id), NEW_PASSWORD);
  assert.equal((await withDb((db) => stores.accounts.getAccount(db, account.id))).status, "active");
});

test("an OAuth account is refused with 400 and nothing changes", async () => {
  const account = await withDb((db) => stores.accounts.createAccount(db, {
    ...ACCOUNT("Personal", "alex@example.com", "alexuser"),
    authKind: "xoauth2",
  }));
  const { calls, factoryCalls } = useFactory();
  await withFlag(async () => {
    const r = await putPassword(account.id, { password: NEW_PASSWORD });
    assert.equal(r.status, 400, r.body);
    assert.deepEqual(r.json, { error: "bad_input", message: "That request is not valid." });
    assert.equal(r.body.includes(NEW_PASSWORD), false);
  });
  assert.deepEqual(factoryCalls, [], "no adapter is opened for an OAuth account");
  assert.deepEqual(calls, []);
  assert.equal(await secretOf(account.id), null);
});

test("an adapter's own text never reaches the answer, even when it quotes the password", async () => {
  const account = await accountWithSecret();
  useFactory(() => ({
    async connect() { throw new Error(`cannot sign in with ${NEW_PASSWORD} at mail.example.test`); },
    async listFolders() { return []; },
    async close() {},
  }));
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  try {
    await withFlag(async () => {
      const r = await putPassword(account.id, { password: NEW_PASSWORD });
      assert.equal(r.status, 502, r.body);
      assert.equal(r.json.message, MAIL_ERROR_TEXT.PROTOCOL);
      assert.equal(r.body.includes(NEW_PASSWORD), false);
      assert.equal(r.body.includes("mail.example.test"), false);
    });
  } finally {
    console.warn = original;
  }
  assert.equal(lines.join("\n").includes(NEW_PASSWORD), false, "no log line carries it");
  assert.equal(await secretOf(account.id), OLD_PASSWORD);
});

test("an unknown account or an empty password is refused and nothing is dialled", async () => {
  const { factoryCalls } = useFactory();
  await withFlag(async () => {
    const unknown = await putPassword("ma-0000000000000000", { password: NEW_PASSWORD });
    assert.equal(unknown.status, 404, unknown.body);
    const missing = await putPassword("ma-0000000000000000", {});
    assert.equal(missing.status, 404, missing.body);

    const account = await accountWithSecret();
    for (const body of [{}, { password: "" }, { password: 42 }]) {
      const r = await putPassword(account.id, body);
      assert.equal(r.status, 400, r.body);
      assert.deepEqual(r.json, { error: "bad_input", message: "That request is not valid." });
    }
  });
  assert.deepEqual(factoryCalls, []);
});