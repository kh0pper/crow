// The reports send door's boot-built adapter (`reportsAdapterFor`, servers/gateway/boot/mail-boot.js):
// the one seam the door reaches a mail connection through.
//
// Harness: a scratch crow.db with the mail tables (MAIL_DDL plus the two settings tables claims.js
// reads and the account send columns), a real account row, a fake supervisor the boot module is handed
// through `createSupervisor`, and the module's own start/stop path — the same way tests/mail-boot.test.js
// drives it. Nothing here opens a connection or waits on real time.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reports-mail-boot-adapter-"));
const DATA_DIR = join(root, "data");
process.env.CROW_DATA_DIR = DATA_DIR;
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA_DIR, "tasks.db");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;

const { createDbClient } = await import("../servers/db.js");
const { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } = await import(
  "../servers/shared/mail-schema.js"
);
const { reportsAdapterFor, startMailSync, stopMailSync } = await import(
  "../servers/gateway/boot/mail-boot.js"
);
const { createAccount } = await import("../servers/gateway/mail/store/accounts.js");
const { MAIL_ERROR_CODES } = await import("../servers/gateway/mail/errors.js");

const LOCAL = Object.freeze({ instanceId: "instA", instanceName: "Alpha" });
const ADDRESS = "reports@example.com";

// The shapes claims.js reads: the settings registry (a local override per instance) and the instance
// table its liveness query filters on.
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

after(() => {
  for (const db of dbs) { try { db.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  // init-db is passed the scratch dir explicitly: an unset CROW_DATA_DIR would target the real ~/.crow.
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
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  // The account send columns are ADD COLUMN specs of their own, not part of MAIL_DDL.
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  dbs.push(db);
  return db;
}

/** One account row over an endpoint nothing dials: no adapter factory is ever called here. */
async function addAccount(db) {
  return createAccount(db, {
    address: ADDRESS,
    label: "Reports",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 587, security: "starttls" },
  });
}

/** The boot options a test needs: the real start path, a fake supervisor, no adapter built. */
function bootOptions(db) {
  return {
    db,
    env: { CROW_MAIL: "1" },
    noAuth: false,
    localInstance: LOCAL,
    log: () => {},
  };
}

/* ------------------------------------------------------------------- the seam */

test("with no supervisor running the seam rejects NETWORK and calls nothing", async () => {
  const db = await freshDb();
  const account = await addAccount(db);
  const calls = [];

  await assert.rejects(
    () => reportsAdapterFor(account, async () => { calls.push("fn"); }),
    (err) => {
      assert.equal(err.code, "NETWORK");
      assert.ok(MAIL_ERROR_CODES.includes(err.code), "a code from the mail vocabulary");
      return true;
    },
  );
  assert.deepEqual(calls, [], "nothing injected, nothing borrowed");
});

test("a running supervisor is asked for the account's own adapter, and the callback gets it", async () => {
  const db = await freshDb();
  const account = await addAccount(db);
  const borrowed = [];
  const adapter = { send: async () => ({ accepted: [{ address: ADDRESS }] }) };
  const supervisor = {
    start: async () => {},
    async stop() {},
    async withAdapter(accountId, fn) {
      borrowed.push(accountId);
      return fn(adapter);
    },
  };

  const handle = await startMailSync({ ...bootOptions(db), createSupervisor: () => supervisor });
  assert.equal(handle.started, true);

  const seen = [];
  const out = await reportsAdapterFor(account, async (given) => {
    seen.push(given);
    return { ok: true };
  });
  assert.deepEqual(out, { ok: true }, "the callback's own answer comes back");
  assert.deepEqual(seen, [adapter], "the callback was handed the supervisor's adapter");
  assert.deepEqual(borrowed, [account.id], "withAdapter was asked for this account's id");

  // And a stopped gateway borrows nothing again.
  await handle.stop();
  await assert.rejects(() => reportsAdapterFor(account, async () => "never"), { code: "NETWORK" });
  assert.deepEqual(borrowed, [account.id], "nothing was borrowed after the stop");
});

test("a supervisor that builds no adapter answers NETWORK rather than a silent success", async () => {
  const db = await freshDb();
  const account = await addAccount(db);
  const supervisor = { start: async () => {}, async stop() {} };

  const handle = await startMailSync({ ...bootOptions(db), createSupervisor: () => supervisor });
  assert.equal(handle.started, true);
  await assert.rejects(() => reportsAdapterFor(account, async () => "never"), { code: "NETWORK" });
  await handle.stop();
});