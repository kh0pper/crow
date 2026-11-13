// Crow Mail's private API, its guards and its account routes (plan 1, Task 19).
//
// Harness: a real init-db'd scratch crow.db copied per test (CROW_DATA_DIR — nothing can touch
// ~/.crow), an ephemeral express app wired the way servers/gateway/index.js + dashboard/index.js wire
// it (the global 1mb JSON parser skipped by index.js's own `_hasOwnParser` predicate, read from its
// source; then a session stub, the dashboard's real CSRF middleware, then the real mail API router),
// the real account store, keychain credentials and claim code, a fake mail adapter (or a failing one),
// a recording supervisor, and the real owner rule with the request marked as coming from the owner's
// laptop (tests/helpers/off-box.js). No pi, no network, no host config.
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

const root = mkdtempSync(join(tmpdir(), "mail-api-"));
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
const { probeAccount } = await import("../servers/gateway/mail/probe.js");
const { createMailCredentials } = await import("../servers/gateway/mail/credentials.js");
const { accountsOverview } = await import("../servers/gateway/mail/accounts-overview.js");
const { addressHash, checkClaim, claimKey, listClaims, writeClaim } = await import("../servers/gateway/mail/claims.js");
const { createAccount, getAccount, setSyncState, addImageAllow } = await import("../servers/gateway/mail/store/accounts.js");
const { upsertFolders, upsertMessage } = await import("../servers/gateway/mail/store/messages.js");
const { createMailSupervisor } = await import("../servers/gateway/mail/sync/supervisor.js");
const { createFakeMailAdapter } = await import("./fixtures/fake-mail-adapter.mjs");
const { currentWriteContext, ownerWriteContext, withWriteContext } = await import("../servers/shared/history/write-context.js");

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const ONHOST = "minted-on-this-machine-session";
const CSRF = "csrf-token-value";
const LOCAL = { instanceId: "instA", instanceName: "Delta" };
const PEER = "instB";
const PASSWORD = "hunter2-app-password";
const USERNAME = "alexuser";
const ADDRESS = "alex@example.com";

const hashToken = (t) => createHash("sha256").update(t).digest("hex");
const flush = () => new Promise((r) => setImmediate(r));

const BODY = {
  label: "Personal",
  address: ADDRESS,
  username: USERNAME,
  imap: { host: "mail.example.test", port: 993, security: "ssl" },
  smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  password: PASSWORD,
};

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
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: join(root, "master") }, stdio: "pipe", cwd: REPO });
  const raw = new Database(MASTER);
  const insert = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))");
  insert.run(hashToken(OWNER), "dashboard");
  insert.run(hashToken(SSO), "dashboard sso src:peer-1");
  insert.run(hashToken(ONHOST), "dashboard onhost");
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

/** One request. `token: null` sends no session cookie; `csrf: null` sends no CSRF header; `laptop:
 *  false` leaves the request classified as coming from this machine. */
function call(method, path, { body, contentType = "application/json", headers = {}, token = OWNER, csrf = CSRF, laptop = true } = {}) {
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const h = { ...(payload === null ? {} : { "content-type": contentType, "content-length": Buffer.byteLength(payload) }) };
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
const patch = (path, body, opts) => call("PATCH", path, { body, ...opts });
const del = (path, opts) => call("DELETE", path, opts);
const accountsPath = `${MAIL_API_PREFIX}/accounts`;
const accountPath = (id) => `${accountsPath}/${encodeURIComponent(id)}`;

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

/**
 * One test's world. `adapterFactory` defaults to a working in-memory adapter, `supervisor` to one that
 * records its calls, `recordSecrets` to an in-memory recorder. `supervisorFactory({db, credentials,
 * adapterFactory})` builds a real supervisor over this test's database instead; `wrapDb` sees each
 * request's own client before the router does; `writeContext` runs every request inside an owner
 * write context, exactly as dashboardAuth does; `ownerCheck` replaces the owner rule.
 */
async function setup({
  adapterFactory = null,
  supervisor = undefined,
  supervisorFactory = null,
  recordSecrets = null,
  localInstance = LOCAL,
  credentials: credentialsOverride = null,
  wrapDb = null,
  writeContext = false,
  ownerCheck = undefined,
} = {}) {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  const db = createDbClient(crow);
  const credDb = createDbClient(crow);
  open.push(db, credDb);
  const credentials = credentialsOverride ?? createMailCredentials({ db: credDb, crowHome: process.env.CROW_HOME });

  const factoryCalls = [];
  const mail = adapterFactory ?? (() => createFakeMailAdapter());
  const adapter = async (args) => {
    factoryCalls.push(args);
    return mail(args);
  };

  const supervisorCalls = [];
  let fakeSupervisor;
  if (supervisorFactory != null) {
    fakeSupervisor = await supervisorFactory({ db, credentials, adapterFactory: adapter, crow });
  } else if (supervisor === undefined) {
    fakeSupervisor = {
      calls: supervisorCalls,
      async syncNow(id) { supervisorCalls.push(["syncNow", id]); },
      async stopAccount(id) { supervisorCalls.push(["stopAccount", id]); },
      async restartAccount(id) { supervisorCalls.push(["restartAccount", id]); },
    };
  } else {
    fakeSupervisor = supervisor;
  }

  const recorded = [];
  const record = recordSecrets ?? ((values) => { recorded.push(values); });

  const opened = { n: 0, closed: 0 };
  const openDb = () => {
    opened.n++;
    const c = createDbClient(crow);
    const close = c.close.bind(c);
    c.close = () => { opened.closed++; return close(); };
    return wrapDb == null ? c : (wrapDb(c) ?? c);
  };

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
    // The shape dashboardAuth gives a request: everything downstream runs inside a write context.
    if (writeContext) withWriteContext(ownerWriteContext(token), () => next());
    else next();
  };
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(mailApiRouter(sessionGate, {
    openDb,
    adapterFactory: adapter,
    supervisor: fakeSupervisor,
    credentials,
    localInstance,
    recordSecrets: record,
    ...(ownerCheck === undefined ? {} : { ownerCheck }),
  }));
  app.use(dash);

  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);

  const count = async (table, where = "", args = []) => {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} ${where}`, args });
    return Number(rows[0].n);
  };
  const keychainRows = async (accountId) => (await db.execute({
    sql: "SELECT id, kind, bundle_id, env_key, connection_uuid, secret_sealed FROM crow_keychain WHERE connection_uuid = ?",
    args: [accountId],
  })).rows;

  return {
    db, crow, credentials, factoryCalls, supervisorCalls, recorded, opened, count, keychainRows,
    hasOwnParser, supervisor: fakeSupervisor,
  };
}

/** An endpoint shape the account store accepts; nothing in these tests ever dials it. */
const ENDPOINT = { host: "mail.example.test", port: 993, security: "ssl" };

/* ------------------------------------------------------------------ tests */

test("the flag: every route is 404 with no data while CROW_MAIL is unset", async () => {
  const s = await setup();
  const created = await post(accountsPath, BODY);
  assert.equal(created.status, 201, created.text);
  const id = created.json.account.id;

  delete process.env.CROW_MAIL;
  try {
    const answers = [
      ["GET", await get(accountsPath)],
      ["POST", await post(accountsPath, BODY)],
      ["GET folders", await get(`${accountPath(id)}/folders`)],
      ["POST sync", await post(`${accountPath(id)}/sync`, {})],
      ["PATCH", await patch(accountPath(id), { label: "X" })],
      ["DELETE", await del(accountPath(id))],
    ];
    for (const [what, r] of answers) {
      assert.equal(r.status, 404, `${what}: ${r.text}`);
      assert.deepEqual(r.json, { error: "not_found", message: "Not found." }, what);
      assert.equal(r.text.includes(ADDRESS), false, `${what} carries no address`);
      assert.equal(r.text.includes("mail.example.test"), false, `${what} carries no host`);
    }
    // Nothing was read and nothing changed.
    assert.equal(await s.count("mail_accounts"), 1);
  } finally {
    process.env.CROW_MAIL = "1";
  }
});

test("a peer SSO session, an on-host login and this machine's own client are 403 with no data", async () => {
  const s = await setup();
  const created = await post(accountsPath, BODY);
  assert.equal(created.status, 201, created.text);
  const id = created.json.account.id;

  const cases = [
    ["a peer's SSO session", { token: SSO }],
    ["a session minted on this machine", { token: ONHOST }],
    ["a request from this machine", { token: OWNER, laptop: false }],
  ];
  for (const [label, opts] of cases) {
    for (const r of [
      await get(accountsPath, opts),
      await get(`${accountPath(id)}/folders`, opts),
      await post(accountsPath, { ...BODY, address: "sam@example.com" }, opts),
      await patch(accountPath(id), { label: "Owned" }, opts),
      await del(accountPath(id), opts),
      await post(`${accountPath(id)}/sync`, {}, opts),
    ]) {
      assert.equal(r.status, 403, `${label}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: "owner_only", message: "Only the owner can see this." }, label);
      assert.equal(r.text.includes(ADDRESS), false, `${label}: no address`);
      assert.equal(r.text.includes("mail.example.test"), false, `${label}: no host`);
    }
  }
  // The account is untouched and no second one was made.
  assert.equal(await s.count("mail_accounts"), 1);
  const row = await getAccount(s.db, id);
  assert.equal(row.label, "Personal");
});

test("a write without the dashboard's CSRF token never reaches a mail route", async () => {
  const s = await setup();
  const refused = await post(accountsPath, BODY, { csrf: null });
  assert.equal(refused.status, 403, refused.text);
  assert.match(refused.text, /CSRF/i, "the dashboard rail answers, not this router");
  assert.equal(await s.count("mail_accounts"), 0);
  assert.deepEqual(s.factoryCalls, [], "nothing was dialled");
});

test("GET /accounts carries no host, port, username or hash, and names where an account is held", async () => {
  const s = await setup();
  await s.db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, 'Studio', 'crow:mail', 'active')",
    args: [PEER],
  });
  const mine = await createAccount(s.db, {
    label: "Personal", address: ADDRESS, username: USERNAME, authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const shared = await createAccount(s.db, {
    label: "Shared", address: "shared@example.com", authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  await s.db.execute({ sql: "UPDATE mail_accounts SET status = 'claimed_elsewhere' WHERE id = ?", args: [shared.id] });
  await writeClaim(s.db, "shared@example.com", { localInstanceId: PEER, instanceName: "Studio", now: 1_000 });

  const r = await get(accountsPath);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers["cache-control"], "no-store", "a mailbox list is never cached");
  const byId = new Map(r.json.accounts.map((a) => [a.id, a]));
  assert.equal(byId.get(mine.id).heldBy, null);
  assert.equal(byId.get(shared.id).heldBy, "Studio");
  assert.deepEqual(r.json.elsewhere, [{ instanceName: "Studio", claimedAt: 1_000 }]);
  for (const needle of ["mail.example.test", "993", "465", USERNAME, "imap", "smtp", "MAIL_PASSWORD",
    addressHash("shared@example.com"), "mail_claim"]) {
    assert.equal(r.text.includes(needle), false, `GET /accounts holds ${needle}`);
  }

  // The route is the overview function, byte for byte.
  assert.deepEqual(r.json, await accountsOverview(s.db, { localInstanceId: LOCAL.instanceId }));
  assert.equal(s.opened.n, s.opened.closed, "one client per request, closed");
});

test("a refused sign-in is 400 with the fixed sentence and stores nothing", async () => {
  const s = await setup({
    adapterFactory: () => {
      const fake = createFakeMailAdapter();
      fake.failNext("connect", new MailError("AUTH_FAILED"));
      return fake;
    },
  });
  const r = await post(accountsPath, BODY);
  assert.equal(r.status, 400, r.text);
  assert.deepEqual(r.json, { error: "AUTH_FAILED", message: MAIL_ERROR_TEXT.AUTH_FAILED });
  assert.equal(await s.count("mail_accounts"), 0, "no account");
  assert.equal(await s.count("crow_keychain"), 0, "no secret");
  assert.deepEqual(await listClaims(s.db, ADDRESS), [], "no claim");
});

test("a connect stores the account, the sealed secret and the claim, and starts a sync", async () => {
  const s = await setup();
  const r = await post(accountsPath, BODY);
  assert.equal(r.status, 201, r.text);
  const id = r.json.account.id;
  assert.match(id, /^ma-[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(r.json.account).sort(), [
    "address", "digestOptIn", "digestTime", "id", "label", "localModelsOnly", "status", "statusDetail",
  ]);
  assert.equal(r.json.account.address, ADDRESS);
  assert.equal(r.json.account.status, "active");
  assert.equal(r.text.includes(PASSWORD), false, "the answer carries no password");
  assert.equal(r.text.includes("mail.example.test"), false, "the answer carries no host");
  assert.equal(r.text.includes(USERNAME), false, "the answer carries no username");

  const row = await getAccount(s.db, id);
  assert.equal(row.address, ADDRESS);
  assert.equal(row.username, USERNAME);
  assert.equal(row.authKind, "password");
  const secrets = await s.keychainRows(id);
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].kind, "service");
  assert.equal(secrets[0].bundle_id, "crow-mail");
  assert.equal(secrets[0].env_key, "MAIL_PASSWORD");
  assert.equal(JSON.stringify(secrets).includes(PASSWORD), false, "the password is sealed, never a column");
  assert.deepEqual(await s.credentials.getSecrets(id), { MAIL_PASSWORD: PASSWORD });

  assert.deepEqual(await checkClaim(s.db, ADDRESS, { localInstanceId: LOCAL.instanceId }), { ok: true });
  const claims = await listClaims(s.db, ADDRESS);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].key, claimKey(ADDRESS, LOCAL.instanceId));
  assert.equal(claims[0].instanceName, LOCAL.instanceName);
  assert.equal(JSON.stringify(claims).includes(ADDRESS), false, "the claim carries no address");

  await flush();
  assert.deepEqual(s.supervisorCalls, [["syncNow", id]], "the first sync is started, in the background");
  assert.deepEqual(s.recorded, [[PASSWORD]], "the new password joined the masking set before it was stored");
});

test("RF5: an address spelled differently ('Alex@Example.COM') is a 409, and changes nothing", async () => {
  const s = await setup();
  assert.equal((await post(accountsPath, BODY)).status, 201);
  const before = await s.count("mail_accounts");
  assert.equal(s.factoryCalls.length, 1, "the first connect probed once");

  for (const address of ["Alex@Example.COM", " ALEX@example.com "]) {
    const r = await post(accountsPath, { ...BODY, address });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, "duplicate_address");
    assert.equal(r.text.includes(ADDRESS), false, "the answer names no address");
  }
  assert.equal(await s.count("mail_accounts"), before, "no second account");
  assert.equal(await s.count("crow_keychain"), 1, "no second secret");
  await flush();
  assert.equal(s.supervisorCalls.filter(([what]) => what === "syncNow").length, 1);
});

test("M2: a duplicate address is answered before the probe, so the adapter is never built", async () => {
  const s = await setup();
  const first = await post(accountsPath, BODY);
  assert.equal(first.status, 201, first.text);
  const id = first.json.account.id;
  assert.equal(s.factoryCalls.length, 1, "the first connect was probed once");
  const claimsBefore = await listClaims(s.db, ADDRESS);
  const recordedBefore = s.recorded.length;

  const again = await post(accountsPath, { ...BODY, address: "alex@EXAMPLE.com", label: "Second" });
  assert.equal(again.status, 409, again.text);
  assert.deepEqual(again.json, {
    error: "duplicate_address",
    message: "That address is already connected on this Crow.",
  });
  assert.equal(s.factoryCalls.length, 1, "the duplicate never dialled the server");
  assert.equal(again.text.includes(ADDRESS), false, "the answer names no address");
  assert.equal(again.text.includes("mail.example.test"), false, "the answer names no host");
  assert.equal(await s.count("mail_accounts"), 1, "no second account");
  assert.equal(await s.count("crow_keychain"), 1, "no second secret");
  assert.deepEqual(await listClaims(s.db, ADDRESS), claimsBefore, "no second claim");
  assert.equal(s.recorded.length, recordedBefore, "the duplicate's password was never masked or stored");
  assert.equal((await getAccount(s.db, id)).label, "Personal", "the first account is untouched");
});

test("an address another live instance holds is a 409 naming it, and the adapter is never built", async () => {
  const s = await setup();
  await s.db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, 'Echo', 'crow:mail', 'active')",
    args: [PEER],
  });
  await writeClaim(s.db, ADDRESS, { localInstanceId: PEER, instanceName: "Echo", now: 1_000 });

  const r = await post(accountsPath, BODY);
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, {
    error: "CLAIMED_ELSEWHERE",
    message: "This account is already connected on Echo",
  });
  assert.deepEqual(s.factoryCalls, [], "nothing was dialled");
  assert.equal(await s.count("mail_accounts"), 0);
  assert.equal(await s.count("crow_keychain"), 0);
});

test("a connect that loses the post-write claim re-check is undone whole and answers 409", async () => {
  let s;
  s = await setup({
    adapterFactory: () => {
      const fake = createFakeMailAdapter();
      const connect = fake.connect.bind(fake);
      fake.connect = async () => {
        await connect();
        // The other instance's claim lands between our pre-check and our own write, and it is older.
        await writeClaim(s.db, ADDRESS, { localInstanceId: PEER, instanceName: "Echo", now: 1_000 });
      };
      return fake;
    },
  });
  await s.db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, 'Echo', 'crow:mail', 'active')",
    args: [PEER],
  });

  const r = await post(accountsPath, BODY);
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, {
    error: "CLAIMED_ELSEWHERE",
    message: "This account is already connected on Echo",
  });
  assert.equal(await s.count("mail_accounts"), 0, "the account was undone");
  assert.equal(await s.count("crow_keychain"), 0, "the secret was undone");
  const ours = (await listClaims(s.db, ADDRESS)).find((c) => c.key === claimKey(ADDRESS, LOCAL.instanceId));
  assert.ok(ours, "our claim row is still there");
  assert.equal(ours.released, true, "…as a tombstone, so the address is not held by a phantom");
  await flush();
  assert.deepEqual(s.supervisorCalls, [], "no sync of an account that does not exist");
});

test("a keychain whose key is not on this machine is its own answer, never a bad password", async () => {
  const { KeychainKeyMissingError } = await import("../servers/gateway/keychain/store.js");
  const s = await setup({
    credentials: {
      getSecrets: async () => ({}),
      saveSecret: async () => { throw new KeychainKeyMissingError(); },
      deleteSecrets: async () => ({ deleted: 0 }),
    },
  });
  const r = await post(accountsPath, BODY);
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, {
    error: "keychain_key_missing",
    message: "The keychain key for this password is not on this machine.",
  });
  assert.equal(r.text.includes(PASSWORD), false);
  assert.equal(await s.count("mail_accounts"), 0, "the half-made account was undone");
});

test("RF5/M4/B1: DELETE stops the account's real worker first, then removes the messages, folders, secret and claim", async () => {
  const order = [];
  const views = [];
  let armed = false;
  const atDelete = [];
  const s = await setup({
    // A real supervisor: its worker owns a connection and an IDLE watch for the account, so the stop
    // the route performs is observable in what is closed and in what the rows see.
    supervisorFactory: async ({ db, credentials, adapterFactory }) => {
      const real = createMailSupervisor({
        db,
        credentials,
        adapterFactory: async (args) => {
          const view = await adapterFactory(args);
          views.push(view);
          return view;
        },
        setTimer: (fn) => fn,
        clearTimer: () => {},
        notify: async () => { order.push("notice"); },
        log: () => {},
      });
      return {
        ...real,
        async syncNow(id) { order.push("syncNow:" + id); return real.syncNow(id); },
        async stopAccount(id) {
          order.push("stop:" + id);
          await real.stopAccount(id);
          order.push("stopped:" + id);
        },
      };
    },
    // Every request's own client, seen just before the router: the delete's transaction is the moment
    // the rows go, so what the worker looks like there is the whole question.
    wrapDb: (client) => {
      const realRun = client.runTransaction.bind(client);
      client.runTransaction = async (work) => {
        if (armed) {
          atDelete.push({
            order: [...order],
            closed: views.map((view) => view.calls.some((call) => call.method === "close")),
          });
        }
        return realRun(work);
      };
      return client;
    },
  });

  const created = await post(accountsPath, BODY);
  assert.equal(created.status, 201, created.text);
  const id = created.json.account.id;
  await flush(60);
  assert.equal(views.length, 1, "the connect opened one connection for its first sync");
  assert.equal((await s.supervisor.status(id)).watching, true, "the worker holds an IDLE watch");

  const { folders } = await upsertFolders(s.db, id, [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" }]);
  await upsertMessage(s.db, {
    accountId: id, folderId: folders[0].id, uid: 1, messageId: "<m1@mail.example.test>",
    subject: "Hello", from: { name: "Sam", address: "sam@example.com" }, to: [], cc: [], text: "hi",
    snippet: "hi", date: Date.now(), internalDate: Date.now(), flags: [],
  });
  await setSyncState(s.db, id, { state: "idle" });
  await addImageAllow(s.db, id, "sam@example.com");

  armed = true;
  const r = await del(accountPath(id));
  armed = false;
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, messages: 1 });

  // The stop ran to completion BEFORE the delete's own transaction: the worker's connection was
  // already closed when the rows went, so nothing could write them back.
  assert.equal(atDelete.length, 1, "the delete ran in one transaction");
  assert.ok(atDelete[0].order.includes("stopped:" + id), "the stop was awaited before the rows were deleted");
  assert.ok(atDelete[0].order.indexOf("stop:" + id) < atDelete[0].order.indexOf("stopped:" + id));
  assert.deepEqual(atDelete[0].closed, [true], "the worker's connection was closed before the rows went");
  assert.equal(order.includes("notice"), false, "no notice was sent");

  for (const table of ["mail_messages", "mail_threads", "mail_folders", "mail_image_allow", "mail_sync_state"]) {
    assert.equal(await s.count(table, "WHERE account_id = ?", [id]), 0, `${table} has no row left`);
  }
  assert.equal(await s.count("mail_accounts", "WHERE id = ?", [id]), 0);
  assert.deepEqual(await s.keychainRows(id), [], "no crow_keychain row left");
  const claims = await listClaims(s.db, ADDRESS);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].released, true, "the claim is a tombstone, so the address is free");
  assert.deepEqual(await checkClaim(s.db, ADDRESS, { localInstanceId: "instC" }), { ok: true });

  // And the worker stays gone: nothing is opened again for the id afterwards.
  await flush(120);
  assert.equal(views.length, 1, "no second connection for the deleted account");
  assert.equal((await s.supervisor.status(id)).watching, false);
  assert.equal((await s.supervisor.status(id)).running, false);

  assert.equal((await del(accountPath(id))).status, 404, "a second delete is a 404");
  assert.equal((await del(`${accountsPath}/ma-0123456789abcdef`)).status, 404);
  assert.equal((await del(`${accountsPath}/not-an-account`)).status, 404);
  await s.supervisor.stop();
});

test("DELETE brackets the removal: beginRemoval before stopAccount, endRemoval after the rows", async () => {
  const order = [];
  const supervisor = {
    async syncNow() {},
    async stopAccount(id) { order.push("stopAccount:" + id); },
    beginRemoval(id) { order.push("beginRemoval:" + id); },
    endRemoval(id) { order.push("endRemoval:" + id); },
  };
  const s = await setup({
    supervisor,
    wrapDb: (client) => {
      const realRun = client.runTransaction.bind(client);
      client.runTransaction = async (work) => {
        order.push("delete");
        return realRun(work);
      };
      return client;
    },
  });

  const created = await post(accountsPath, BODY);
  assert.equal(created.status, 201, created.text);
  const id = created.json.account.id;
  order.length = 0;

  const r = await del(accountPath(id));
  assert.equal(r.status, 200, r.text);

  // The id is marked as being removed before the worker is told to stop, so a sync or an action that
  // lands in between is refused; the mark goes only after the rows are gone.
  assert.deepEqual(order.slice(0, 3), [
    "beginRemoval:" + id,
    "stopAccount:" + id,
    "delete",
  ]);
  assert.equal(order.at(-1), "endRemoval:" + id, "the mark is dropped after the rows went");
  assert.equal(order.filter((entry) => entry.startsWith("endRemoval")).length, 1);
  assert.equal(await s.count("mail_accounts"), 0);
});

test("DELETE drops the removal mark even when the rows cannot be removed", async () => {
  const order = [];
  const supervisor = {
    async syncNow() {},
    async stopAccount() { order.push("stopAccount"); },
    beginRemoval() { order.push("beginRemoval"); },
    endRemoval() { order.push("endRemoval"); },
  };
  const s = await setup({
    supervisor,
    wrapDb: (client) => {
      client.runTransaction = async () => {
        order.push("delete");
        throw new Error("database is locked");
      };
      return client;
    },
  });

  const created = await post(accountsPath, BODY);
  assert.equal(created.status, 201, created.text);
  const id = created.json.account.id;
  order.length = 0;

  const r = await del(accountPath(id));
  assert.equal(r.status, 500, r.text);
  assert.deepEqual(r.json, { error: "internal", message: "Something went wrong." });
  assert.deepEqual(order, ["beginRemoval", "stopAccount", "delete", "endRemoval"]);
  assert.equal(await s.count("mail_accounts", "WHERE id = ?", [id]), 1, "the account is still there");
});

test("probeAccount closes the adapter on success and on failure, and leaks neither secret nor username", async () => {
  // Success: connect and list, then close.
  const good = createFakeMailAdapter();
  await probeAccount({
    adapterFactory: () => good,
    account: { id: "probe", address: ADDRESS, username: USERNAME, authKind: "password", imap: ENDPOINT, smtp: ENDPOINT },
    credentials: { getSecrets: async () => ({ MAIL_PASSWORD: PASSWORD }) },
  });
  assert.deepEqual(good.calls.map((c) => c.method), ["connect", "listFolders", "close"]);

  // Failure after connecting: still closed, and the error is the code's fixed sentence.
  const bad = createFakeMailAdapter();
  bad.failNext("listFolders", new MailError("AUTH_FAILED"));
  await assert.rejects(
    () => probeAccount({
      adapterFactory: () => bad,
      account: { id: "probe", address: ADDRESS, username: USERNAME, authKind: "password", imap: ENDPOINT, smtp: ENDPOINT },
      credentials: { getSecrets: async () => ({ MAIL_PASSWORD: PASSWORD }) },
    }),
    (err) => {
      assert.equal(err.code, "AUTH_FAILED");
      assert.equal(err.message, MAIL_ERROR_TEXT.AUTH_FAILED);
      assert.equal(String(err.message).includes(PASSWORD), false);
      assert.equal(String(err.message).includes(USERNAME), false);
      return true;
    },
  );
  assert.equal(bad.calls.filter((c) => c.method === "close").length, 1, "closed on failure too");

  // A factory that throws, and an adapter that fails to build: nothing to close, nothing leaked.
  await assert.rejects(
    () => probeAccount({ adapterFactory: () => { throw new Error(`login failed for ${USERNAME} with ${PASSWORD}`); }, account: { id: "probe" } }),
    (err) => {
      assert.equal(err.code, "PROTOCOL");
      assert.equal(err.message, MAIL_ERROR_TEXT.PROTOCOL);
      return true;
    },
  );
});

test("RF2: an adapter error seeded with the password and the username answers only the fixed sentence", async () => {
  const s = await setup({
    adapterFactory: () => {
      const fake = createFakeMailAdapter();
      fake.connect = async () => {
        const err = new Error(`LOGIN failed for ${USERNAME} with password ${PASSWORD}`);
        err.code = "EUNKNOWNTHING";
        throw err;
      };
      return fake;
    },
  });
  const { lines, result: r } = await warnings(() => post(accountsPath, BODY));
  assert.equal(r.status, 502, r.text);
  assert.deepEqual(r.json, { error: "PROTOCOL", message: MAIL_ERROR_TEXT.PROTOCOL });
  for (const text of [r.text, lines.join("\n")]) {
    assert.equal(text.includes(PASSWORD), false, "no password in the answer or a log");
    assert.equal(text.includes(USERNAME), false, "no username in the answer or a log");
    assert.equal(text.includes("LOGIN failed"), false, "no library text anywhere");
  }
  assert.equal(await s.count("mail_accounts"), 0);
});

test("a recorder that fails does not leak the password and does not fail the connect", async () => {
  const seen = [];
  const s = await setup({
    recordSecrets: (values) => {
      seen.push(values);
      throw new Error(`cannot write the hashes file: ${values[0]}`);
    },
  });
  const { lines, result: r } = await warnings(() => post(accountsPath, BODY));
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(seen, [[PASSWORD]], "the recorder was handed the password");
  assert.equal(r.text.includes(PASSWORD), false);
  assert.equal(lines.join("\n").includes(PASSWORD), false, "a failed recorder logs a code, not the value");
  assert.equal(await s.count("mail_accounts"), 1);
});

test("a 100 KB body is 413 from the mail router, and the path is one the global parser skips", async () => {
  const s = await setup();
  assert.equal(s.hasOwnParser(`${MAIL_API_PREFIX}/accounts`), true);
  assert.equal(s.hasOwnParser("/dashboard/mail/api/anything"), true);
  assert.equal(s.hasOwnParser("/dashboard/mail"), false);
  assert.equal(s.hasOwnParser("/dashboard/staged/x"), false);

  const big = JSON.stringify({ label: "Big", padding: "a".repeat(100 * 1024) });
  const tooBig = await post(accountsPath, big);
  assert.equal(tooBig.status, 413, tooBig.text);
  assert.deepEqual(tooBig.json, { error: "too_large", message: "That request is too large." });

  // Malformed JSON, under the limit, is this router's own 400 — not the global parser's.
  const malformed = await post(accountsPath, `{"label": "x"`);
  assert.equal(malformed.status, 400, malformed.text);
  assert.deepEqual(malformed.json, { error: "bad_input", message: "That request is not valid." });
  assert.equal(await s.count("mail_accounts"), 0);
});

test("POST /accounts refuses a bad address, endpoint, security or password with 400 and stores nothing", async () => {
  const s = await setup();
  const cases = [
    { address: "not-an-address" },
    { address: "two@at@example.com" },
    { address: "a b@example.com" },
    { address: "<alex@example.com>" },
    { address: "alex@example.com\r\nBcc: x@example.com" },
    { imap: { host: "mail.example.test", port: 0, security: "ssl" } },
    { imap: { host: "mail.example.test", port: 70000, security: "ssl" } },
    { imap: { host: "mail.example.test", port: 993, security: "plain" } },
    { smtp: { host: "mail .example.test", port: 465, security: "ssl" } },
    { smtp: { host: "", port: 465, security: "ssl" } },
    { label: "" },
    { label: "x".repeat(200) },
    { username: "with space" },
    { password: "" },
    { password: "x".repeat(1025) },
    { password: 123 },
  ];
  for (const over of cases) {
    const r = await post(accountsPath, { ...BODY, ...over });
    assert.equal(r.status, 400, `${JSON.stringify(over)}: ${r.text}`);
    assert.equal(r.json.error, "bad_input");
  }
  assert.equal(await s.count("mail_accounts"), 0, "nothing stored");
  assert.equal(await s.count("crow_keychain"), 0);
  assert.deepEqual(s.factoryCalls, [], "no probe was opened for an invalid body");
});

test("PATCH writes only the four settings fields; anything else is 400", async () => {
  const s = await setup();
  const row = await createAccount(s.db, {
    label: "Personal", address: ADDRESS, authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });

  const ok = await patch(accountPath(row.id), { label: "Home", localModelsOnly: true, digestOptIn: true, digestTime: "07:30" });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.account, {
    id: row.id, label: "Home", address: ADDRESS, status: "active", statusDetail: null,
    localModelsOnly: true, digestOptIn: true, digestTime: "07:30",
  });
  const stored = await getAccount(s.db, row.id);
  assert.deepEqual(
    [stored.label, stored.localModelsOnly, stored.digestOptIn, stored.digestTime],
    ["Home", true, true, "07:30"],
  );
  assert.equal(ok.text.includes("mail.example.test"), false, "no host in the answer");

  for (const body of [
    { address: "other@example.com" },
    { status: "auth_failed" },
    { imap: { host: "x" } },
    { windowDays: 30 },
    { localModelsOnly: "yes" },
    { digestOptIn: 1 },
    { digestTime: "7:30" },
    { digestTime: "24:00" },
    { label: "" },
  ]) {
    const r = await patch(accountPath(row.id), body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    assert.equal(r.json.error, "bad_input");
  }
  const after = await getAccount(s.db, row.id);
  assert.deepEqual(
    [after.address, after.status, after.localModelsOnly, after.digestOptIn, after.digestTime],
    [ADDRESS, "active", true, true, "07:30"],
    "a refused PATCH changed nothing",
  );

  assert.equal((await patch(`${accountsPath}/ma-0123456789abcdef`, { label: "X" })).status, 404);
  assert.equal((await patch(`${accountsPath}/nope`, { label: "X" })).status, 404);
});

test("POST /accounts/:id/sync starts the supervisor's sync, and answers 'not started' without one", async () => {
  const s = await setup();
  const row = await createAccount(s.db, {
    label: "Personal", address: ADDRESS, authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const started = await post(`${accountPath(row.id)}/sync`, {});
  assert.equal(started.status, 202, started.text);
  assert.deepEqual(started.json, { ok: true, started: true });
  await flush();
  assert.deepEqual(s.supervisorCalls, [["syncNow", row.id]]);

  const bare = await setup({ supervisor: null });
  const second = await createAccount(bare.db, {
    label: "Personal", address: ADDRESS, authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const r = await post(`${accountPath(second.id)}/sync`, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, started: false }, "no supervisor: skipped, never thrown");

  assert.equal((await post(`${accountsPath}/ma-0123456789abcdef/sync`, {})).status, 404);
});

test("GET /accounts/:id/folders lists the real folders with their counts and skips the virtual ones", async () => {
  const s = await setup();
  const row = await createAccount(s.db, {
    label: "Personal", address: ADDRESS, authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const { folders } = await upsertFolders(s.db, row.id, [
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
    { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/" },
    { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", delimiter: "/" },
    { path: "[Gmail]/Flagged", name: "Flagged", specialUse: "\\Flagged", delimiter: "/" },
    { path: "[Gmail]/Important", name: "Important", specialUse: "\\Important", delimiter: "/" },
  ]);
  const inbox = folders.find((f) => f.path === "INBOX");
  await upsertMessage(s.db, {
    accountId: row.id, folderId: inbox.id, uid: 1, messageId: "<m1@mail.example.test>",
    subject: "Hi", from: { name: "Sam", address: "sam@example.com" }, to: [], cc: [], text: "hi",
    snippet: "hi", date: Date.now(), internalDate: Date.now(), flags: [],
  });

  const r = await get(`${accountPath(row.id)}/folders`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.folders.map((f) => f.path), ["Archive", "INBOX"]);
  const inboxView = r.json.folders.find((f) => f.path === "INBOX");
  assert.deepEqual(Object.keys(inboxView).sort(), ["id", "name", "path", "role", "totalCount", "unreadCount"]);
  assert.equal(inboxView.role, "inbox");
  assert.equal(inboxView.name, "INBOX");
  assert.equal(inboxView.unreadCount, 1);
  assert.equal(inboxView.totalCount, 1);
  assert.equal(r.text.includes("mail.example.test"), false, "no host in the answer");

  assert.equal((await get(`${accountsPath}/ma-0123456789abcdef/folders`)).status, 404);
  assert.equal((await get(`${accountsPath}/bogus/folders`)).status, 404);
});

test("the runtime set by boot is what a router without deps uses, and clearing it falls back", async () => {
  const { setMailApiRuntime } = await import("../servers/gateway/routes/mail-api.js");
  const calls = [];
  const supervisor = { async syncNow(id) { calls.push(id); }, async restartAccount() {} };
  setMailApiRuntime({ supervisor, adapterFactory: () => createFakeMailAdapter() });

  const s = await setup({ supervisor: undefined });
  // The dep wins over the runtime: this app was built with its own recording supervisor.
  const row = await createAccount(s.db, {
    label: "Personal", address: ADDRESS, authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  assert.equal((await post(`${accountPath(row.id)}/sync`, {})).status, 202);
  await flush();
  assert.deepEqual(calls, [], "the injected supervisor is the one that ran");
  assert.deepEqual(s.supervisorCalls, [["syncNow", row.id]]);
  clearMailApiRuntime();
});

/* ------------------------------------------------ a fault that is not mail's (M5) */

test("M5: a failure that is not a MailError is 500 internal, never a mail-server sentence", async () => {
  // A keychain write that fails like a database would: not a MailError, and its text names the store.
  const s = await setup({
    credentials: {
      getSecrets: async () => ({}),
      saveSecret: async () => { throw new Error("SQLITE_FULL: database or disk is full (crow_keychain)"); },
      deleteSecrets: async () => ({ deleted: 0 }),
    },
  });
  const { lines, result: stored } = await warnings(() => post(accountsPath, BODY));
  assert.equal(stored.status, 500, stored.text);
  assert.deepEqual(stored.json, { error: "internal", message: "Something went wrong." });
  for (const text of [stored.text, lines.join("\n")]) {
    assert.equal(text.includes("SQLITE_FULL"), false, "no store text in the answer or a log");
    assert.equal(text.includes(PASSWORD), false, "no password anywhere");
    assert.equal(text.includes("crow_keychain"), false, "no table name anywhere");
  }
  assert.equal(await s.count("mail_accounts"), 0, "the half-made account was undone");

  // A read that fails the same way, from the request's own database client.
  const reads = await setup({
    ownerCheck: async () => true,
    wrapDb: (client) => {
      const realExecute = client.execute.bind(client);
      client.execute = async (query, ...rest) => {
        const sql = typeof query === "string" ? query : (query?.sql ?? "");
        if (/FROM mail_accounts/.test(sql)) throw new Error("SQLITE_IOERR: disk I/O error");
        return realExecute(query, ...rest);
      };
      return client;
    },
  });
  const broken = await get(`${accountsPath}/ma-0123456789abcdef/folders`);
  assert.equal(broken.status, 500, broken.text);
  assert.deepEqual(broken.json, { error: "internal", message: "Something went wrong." });
  assert.equal(broken.text.includes("SQLITE_IOERR"), false);
  assert.equal(reads.opened.n, reads.opened.closed, "one client per request, closed");

  // A MailError keeps its own code and its own fixed sentence.
  const refused = await setup({
    adapterFactory: () => {
      const fake = createFakeMailAdapter();
      fake.failNext("connect", new MailError("AUTH_FAILED"));
      return fake;
    },
  });
  const auth = await post(accountsPath, BODY);
  assert.equal(auth.status, 400, auth.text);
  assert.deepEqual(auth.json, { error: "AUTH_FAILED", message: MAIL_ERROR_TEXT.AUTH_FAILED });
  assert.equal(await refused.count("mail_accounts"), 0);
});

/* --------------------------------- the supervisor's work outlives the request (M1) */

test("M1: the long-lived supervisor work is opened outside the request's write context", async () => {
  const seen = [];
  const supervisor = {
    async syncNow(id) { seen.push(["syncNow", id, currentWriteContext()]); },
    async stopAccount(id) { seen.push(["stopAccount", id, currentWriteContext()]); },
  };
  const s = await setup({ supervisor, writeContext: true });

  const created = await post(accountsPath, BODY);
  assert.equal(created.status, 201, created.text);
  const id = created.json.account.id;
  await flush();
  assert.equal((await del(accountPath(id))).status, 200, "the delete goes through");

  assert.deepEqual(seen.map(([what]) => what), ["syncNow", "stopAccount"]);
  for (const [what, , ctx] of seen) {
    assert.equal(ctx, null, `${what} carries no request author into its writes`);
  }
  assert.equal(await s.count("mail_accounts"), 0);
});