// Crow Mail's boot wiring (plan 1, Task 21): the gate (`CROW_MAIL`, `--no-auth`,
// `CROW_DISABLE_MAIL_SYNC`), the supervisor it builds, the adapter factory and claim wrappers it hands
// that supervisor, and the handle post-listen keeps so the shutdown path can stop it.
//
// Everything runs on a scratch DB built from MAIL_DDL plus the two settings tables and `crow_instances`
// (the shapes claims.js reads), an in-memory fake adapter, a fake clock and, where the runtime matters,
// the real mail API router: its "is a supervisor running" answer comes from the module-level runtime
// `start()` sets and `stop()` clears. Nothing here waits on real time or touches a mailbox server.
//
// Three things are asserted wherever they could leak: the gate builds no adapter and no supervisor,
// an account that fails never stops another, and a thrown library error reaches the log only as a code.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const root = mkdtempSync(join(tmpdir(), "mail-boot-"));
const DATA_DIR = join(root, "data");
process.env.CROW_DATA_DIR = DATA_DIR;
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA_DIR, "tasks.db");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;

const { default: express } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { MAIL_DDL } = await import("../servers/shared/mail-schema.js");
const { startMailSync, stopMailSync } = await import("../servers/gateway/boot/mail-boot.js");
const { createAccount, getAccount, getSyncState } = await import("../servers/gateway/mail/store/accounts.js");
const { CLAIM_RETRY_MS } = await import("../servers/gateway/mail/sync/supervisor.js");
const { mailApiRouter, MAIL_API_PREFIX } = await import("../servers/gateway/routes/mail-api.js");
const { listClaims, releaseClaim, writeClaim } = await import("../servers/gateway/mail/claims.js");
const { createFakeMailAdapter } = await import("./fixtures/fake-mail-adapter.mjs");
const { makeRaw } = await import("./fixtures/fake-mail-server.mjs");

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const LOCAL = Object.freeze({ instanceId: "instA", instanceName: "Alpha" });
const PEER = "instB";
const ADDRESS = "alex@example.com";

// The real shapes claims.js reads, trimmed to what it touches: the settings registry resolves a local
// override per instance, and the claim's liveness query filters on crow_instances.status.
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

const dbs = [];
const servers = [];
after(() => {
  for (const s of servers) s.close();
  for (const db of dbs) { try { db.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  // init-db makes the instance's own data dir a real instance (instance-id). It is passed explicitly
  // and checked first: an unset dir would make init-db target the real ~/.crow.
  if (!DATA_DIR) throw new Error("CROW_DATA_DIR is unset: init-db would target the real ~/.crow");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: DATA_DIR },
    stdio: "pipe",
    cwd: REPO,
  });
});

afterEach(async () => {
  // Module state is shared by the whole file: a handle one test leaves behind would answer for the next.
  await stopMailSync();
});

/* ------------------------------------------------------------------ plumbing */

let n = 0;

/** One scratch crow.db with the mail tables, the settings tables and crow_instances. */
async function freshDb() {
  const dir = join(root, "db" + (++n));
  mkdirSync(dir, { recursive: true });
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL + SETTINGS_DDL);
  dbs.push(db);
  return db;
}

/** An account over an endpoint that is never dialled: every test injects its own adapter factory. */
async function addAccount(db, address = ADDRESS, label = "Alex") {
  return createAccount(db, {
    address,
    label,
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 587, security: "starttls" },
  });
}

/** A clock whose timers only fire when a test advances it. */
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
    clearTimer(handle) { timers.delete(handle); },
    pending: () => timers.size,
    advance(ms) { current += ms; },
    /** Fire every timer due within `ms`, earliest first, and settle everything it starts. */
    async fire(ms) {
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

async function flush(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Wait for a predicate to hold, on real time: the supervisor's work is real promises. */
async function until(predicate, { timeoutMs = 4000 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function messageCount(db, accountId) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?",
    args: [accountId],
  });
  return Number(rows[0].n);
}

function clockOptions(clock) {
  return {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  };
}

/* ---------------------------------------------------------------------- gate */

test("the flag gates everything: unset, --no-auth or sync disabled starts nothing and builds no adapter", async () => {
  const db = await freshDb();
  const account = await addAccount(db);
  const built = [];
  const adapterFactory = () => {
    built.push("adapter");
    return createFakeMailAdapter();
  };

  const cases = [
    [{}, "disabled"],
    [{ CROW_MAIL: "1", CROW_DISABLE_MAIL_SYNC: "1" }, "sync_disabled"],
  ];
  for (const [env, reason] of cases) {
    const result = await startMailSync({ db, env, noAuth: false, adapterFactory, log: () => {} });
    assert.equal(result.started, false, reason);
    assert.equal(result.reason, reason);
    assert.equal(result.supervisor, undefined, "no supervisor is built behind a closed gate");
    await result.stop();
  }

  const noAuth = await startMailSync({
    db, env: { CROW_MAIL: "1" }, noAuth: true, adapterFactory, log: () => {},
  });
  assert.equal(noAuth.started, false);
  assert.equal(noAuth.reason, "no_auth");
  assert.equal(noAuth.supervisor, undefined);

  assert.deepEqual(built, [], "no adapter factory call behind a closed gate");
  // The account is untouched: nothing was synced and no worker ran.
  assert.equal(await messageCount(db, account.id), 0);
  assert.equal(await getSyncState(db, account.id), null);
});

/* --------------------------------------------------------------------- start */

test("a started supervisor is returned at once, without waiting for its first full sync", async () => {
  const db = await freshDb();
  await addAccount(db);
  let startCalls = 0;
  const pending = new Promise(() => {});
  const supervisor = {
    start() { startCalls += 1; return pending; },
    async stop() {},
  };

  const handle = await startMailSync({
    db,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    createSupervisor: () => supervisor,
    localInstance: LOCAL,
    log: () => {},
  });
  await flush();
  assert.equal(handle.started, true);
  assert.equal(handle.supervisor, supervisor);
  assert.equal(startCalls, 1, "start() is called exactly once");
  await handle.stop();
});

test("one failing account does not stop another, and the failure reaches the log only as a code", async () => {
  const db = await freshDb();
  const bad = await addAccount(db, "bad@example.com", "Bad");
  const good = await addAccount(db, "good@example.com", "Good");
  const clock = makeClock();
  const goodAdapter = createFakeMailAdapter({ now: clock.now });
  goodAdapter.deliver("INBOX", makeRaw({ subject: "hello from the good account" }));
  const logs = [];

  const handle = await startMailSync({
    db,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    localInstance: LOCAL,
    ...clockOptions(clock),
    adapterFactory: ({ account }) => {
      if (account.id === bad.id) throw new Error("hunter2 the server said no");
      return goodAdapter;
    },
    log: (line) => logs.push(line),
  });
  assert.equal(handle.started, true);

  const arrived = await until(async () => (await messageCount(db, good.id)) === 1);
  assert.equal(arrived, true, "the healthy account still synced");

  const state = await getSyncState(db, bad.id);
  assert.ok(state, "the failing account has a sync state row");
  assert.equal(state.state, "backoff");
  assert.equal(state.errorCode, "PROTOCOL", "an unknown library error is classified, never quoted");

  const line = JSON.stringify(logs);
  assert.equal(line.includes("hunter2"), false, "no library text in a log line");
  assert.equal(line.includes("bad@example.com"), false, "no address in a log line");
  await handle.stop();
});

test("a supervisor factory that throws is caught and logged by code only", async () => {
  const db = await freshDb();
  await addAccount(db);
  const logs = [];
  const result = await startMailSync({
    db,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    localInstance: LOCAL,
    createSupervisor: () => { throw new Error("hunter2 while building"); },
    log: (line) => logs.push(line),
  });
  assert.equal(result.started, false);
  assert.equal(result.reason, "error");
  assert.ok(logs.some((entry) => entry.event === "start_failed" && typeof entry.code === "string"));
  assert.equal(JSON.stringify(logs).includes("hunter2"), false);
  await result.stop();
});

test("a start() that rejects is caught and logged by code only", async () => {
  const db = await freshDb();
  await addAccount(db);
  const logs = [];
  const supervisor = {
    start: async () => { throw new Error("hunter2 on the way up"); },
    async stop() {},
  };
  const handle = await startMailSync({
    db,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    createSupervisor: () => supervisor,
    localInstance: LOCAL,
    log: (line) => logs.push(line),
  });
  assert.equal(handle.started, true, "boot carries on even when the first start fails");
  await until(() => logs.some((entry) => entry.event === "start_failed"));
  assert.ok(logs.some((entry) => entry.event === "start_failed" && typeof entry.code === "string"));
  assert.equal(JSON.stringify(logs).includes("hunter2"), false);
  await handle.stop();
});

/* ---------------------------------------------------- one start, and a shutdown */

test("two concurrent starts build one supervisor and share one handle", async () => {
  const db = await freshDb();
  await addAccount(db);
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  let builds = 0;
  const supervisor = { start: async () => {}, stop: async () => {} };
  const options = {
    db,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    localInstance: async () => { await held; return LOCAL; },
    createSupervisor: () => { builds += 1; return supervisor; },
    log: () => {},
  };

  const first = startMailSync(options);
  const second = startMailSync(options);
  await flush();
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(builds, 1, "the second call joined the start already in flight");
  assert.equal(a, b, "both calls receive the same handle");
  assert.equal(a.started, true);
  assert.equal(a.supervisor, supervisor);
  await a.stop();
});

test("a shutdown during an in-flight start stops it: nothing is built or published", async () => {
  const db = await freshDb();
  await addAccount(db);
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  let builds = 0;
  const logs = [];

  const started = startMailSync({
    db,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    localInstance: async () => { await held; return LOCAL; },
    createSupervisor: () => { builds += 1; return { start: async () => {}, stop: async () => {} }; },
    log: (line) => logs.push(line),
  });
  await flush();

  // No handle exists yet, so there is nothing for the shutdown to stop — and the start must not
  // carry on once it resumes.
  assert.equal(await stopMailSync(), false, "no handle was there to stop");
  release();
  const result = await started;

  assert.equal(result.started, false, "the start reports itself as not started");
  assert.equal(result.reason, "shutting_down");
  assert.equal(result.supervisor, undefined, "no supervisor is published after shutdown began");
  assert.equal(builds, 0, "nothing is built for a process that is going down");
  assert.ok(logs.some((line) => line.event === "not_started" && line.reason === "shutting_down"));
  assert.equal(await stopMailSync(), false, "no handle was published afterwards either");
});

/* -------------------------------------------------------------------- claims */

test("the supervisor is handed claim wrappers bound to this instance: a loser is detected, refresh touches only our own live claim", async () => {
  const db = await freshDb();
  const account = await addAccount(db);
  const stub = { start: async () => {}, stop: async () => {} };
  const credentials = { getSecrets: async () => ({ MAIL_PASSWORD: "never-used" }) };
  const adapterFactory = () => createFakeMailAdapter();
  let captured = null;

  const handle = await startMailSync({
    db,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    credentials,
    adapterFactory,
    createSupervisor: (options) => { captured = options; return stub; },
    localInstance: LOCAL,
    log: () => {},
  });
  assert.equal(captured.credentials, credentials, "the keychain reader reaches the factory");
  assert.equal(captured.adapterFactory, adapterFactory, "the adapter factory reaches the supervisor");
  assert.equal(typeof captured.isClaimedElsewhere, "function");
  assert.equal(typeof captured.refreshClaim, "function");

  // No claim at all: this instance may connect, and the answer is a strict boolean.
  assert.equal(await captured.isClaimedElsewhere(account), false);

  // A live peer claim written earlier wins, so this instance is the loser.
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, 'Studio', 'crow:mail', 'active')",
    args: [PEER],
  });
  await writeClaim(db, ADDRESS, { localInstanceId: PEER, instanceName: "Studio", now: 1_000 });
  assert.equal(await captured.isClaimedElsewhere(account), true);

  // Our own later claim does not unseat it: the winner is a pure function of the set.
  await writeClaim(db, ADDRESS, { localInstanceId: LOCAL.instanceId, instanceName: LOCAL.instanceName, now: 2_000 });
  assert.equal(await captured.isClaimedElsewhere(account), true);

  // A refresh rewrites our own row with the same time and leaves the peer's row alone.
  await captured.refreshClaim(account);
  const claims = await listClaims(db, ADDRESS);
  const mine = claims.find((claim) => claim.instanceId === LOCAL.instanceId);
  const theirs = claims.find((claim) => claim.instanceId === PEER);
  assert.equal(mine.claimedAt, 2_000, "a refresh keeps the place in the queue");
  assert.equal(theirs.claimedAt, 1_000, "a refresh never rewrites another instance's claim");

  // A tombstone is never resurrected by a refresh.
  await releaseClaim(db, ADDRESS, { localInstanceId: LOCAL.instanceId, now: 3_000 });
  await captured.refreshClaim(account);
  const after = await listClaims(db, ADDRESS);
  const tombstone = after.find((claim) => claim.instanceId === LOCAL.instanceId);
  assert.equal(tombstone.released, true);

  // No own claim at all: a refresh writes nothing rather than claiming on someone's behalf.
  await captured.refreshClaim({ address: "sam@example.com" });
  assert.deepEqual(await listClaims(db, "sam@example.com"), []);

  await handle.stop();
});

test("a claim check that cannot be read starts nothing through the boot wrapper, and the short re-check starts it", async () => {
  const db = await freshDb();
  const account = await addAccount(db);
  const clock = makeClock();
  const fake = createFakeMailAdapter({ now: clock.now });
  fake.deliver("INBOX", makeRaw({ subject: "hello after the claim came back" }));
  const built = [];
  const logs = [];
  let claimStoreFails = true;

  // The claim's liveness read is the one that fails: every other statement, transaction and batch the
  // supervisor and the stores use passes straight through, so this is the claim check and nothing else.
  const flaky = new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return (statement) => {
          const sql = typeof statement === "string" ? statement : (statement?.sql ?? "");
          if (claimStoreFails && sql.includes("crow_instances")) {
            return Promise.reject(new Error("hunter2 claim store"));
          }
          return target.execute(statement);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const handle = await startMailSync({
    db: flaky,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    localInstance: LOCAL,
    ...clockOptions(clock),
    adapterFactory: () => { built.push("adapter"); return fake; },
    log: (line) => logs.push(line),
  });
  assert.equal(handle.started, true);
  await flush();

  assert.deepEqual(built, [], "no connection is opened for a claim that was never read");
  assert.equal((await getAccount(db, account.id)).status, "active", "the account is not marked elsewhere");
  assert.equal(await getSyncState(db, account.id), null, "nothing was started");
  assert.equal(await messageCount(db, account.id), 0);
  assert.equal(JSON.stringify(logs).includes("hunter2"), false, "the store's text reaches no log line");
  assert.ok(logs.some((line) => line.event === "claim_check_failed" && line.code === "PROTOCOL"));

  // The claim readable again: the short re-check starts the worker instead of waiting for a poll tick.
  claimStoreFails = false;
  await clock.fire(CLAIM_RETRY_MS);
  assert.equal(await until(async () => (await messageCount(db, account.id)) === 1), true,
    "the re-check started the worker and it synced");
  assert.equal(built.length, 1);
  assert.equal((await getAccount(db, account.id)).status, "active");
  await handle.stop();
});

/* -------------------------------------------------------------------- runtime */

test("stop closes the supervisor once, clears the runtime the routes read, and is idempotent", async () => {
  const dir = join(root, "runtime");
  mkdirSync(dir, { recursive: true });
  const crowPath = join(dir, "crow.db");
  const db = createDbClient(crowPath);
  await db.executeMultiple(MAIL_DDL + SETTINGS_DDL);
  dbs.push(db);
  const account = await addAccount(db);
  process.env.CROW_MAIL = "1";
  const app = express();
  // The router's own request client, on the same file: the runtime is what is under test here.
  app.use(mailApiRouter((req, res, next) => next(), {
    openDb: () => createDbClient(crowPath),
    ownerCheck: async () => true,
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const syncPath = `${MAIL_API_PREFIX}/accounts/${account.id}/sync`;
  const askSync = () => new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, method: "POST", path: syncPath },
      (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end();
  });

  let stopped = 0;
  const supervisor = {
    start: async () => {},
    async stop() { stopped += 1; },
    async syncNow() {},
  };
  try {
    // With no sync running the route has no supervisor to start.
    const before = await askSync();
    assert.equal(before.status, 200);
    assert.equal(before.json.started, false, "no runtime yet");

    const handle = await startMailSync({
      db,
      env: { CROW_MAIL: "1" },
      noAuth: false,
      createSupervisor: () => supervisor,
      localInstance: LOCAL,
      log: () => {},
    });
    assert.equal(handle.started, true);
    const during = await askSync();
    assert.equal(during.status, 202);
    assert.equal(during.json.started, true, "the runtime supervisor is what the route sees");

    await handle.stop();
    await handle.stop();
    assert.equal(stopped, 1, "stop() is idempotent");
    const afterward = await askSync();
    assert.equal(afterward.json.started, false, "the runtime is cleared at shutdown");
    assert.equal(await stopMailSync(), false, "no handle is left to stop twice");
  } finally {
    delete process.env.CROW_MAIL;
  }
});

/* -------------------------------------------------------------------- wiring */

test("post-listen starts mail sync after listening and the shutdown path stops it", () => {
  const postListen = readFileSync(join(REPO, "servers/gateway/boot/post-listen.js"), "utf8");
  assert.match(postListen, /startMailSync\(/, "post-listen starts the supervisor");
  const index = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const scheduler = index.indexOf("stopScheduler()");
  const mail = index.indexOf("stopMailSync()");
  assert.ok(scheduler > -1 && mail > scheduler, "the shutdown path stops mail sync beside the scheduler");
});