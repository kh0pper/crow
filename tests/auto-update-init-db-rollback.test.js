/**
 * L0.5 — a pulled sha whose init-db fails, and the limits of rolling it back
 * (audit N1c-3, plus fix-round-1 B1).
 *
 * Before L0.5, that path withheld the restart but LEFT the tree at the new sha:
 * the next restart for any reason (a reboot, a bundle install, a crash) booted
 * it, its boot guard re-ran the failing init-db and exited 1, and systemd looped
 * forever. The next tick also reported "Up to date", hiding the withheld restart.
 *
 * B1: the rollback is allowed ONLY when nothing about the new tree can have
 * reached the database — no schema-generation crossing, `scripts/init-db.js`
 * byte-identical in both commits, the DB still readable, `user_version` not
 * advanced. init-db writes its PRAGMA stamp as its very last statement, so a run
 * that failed halfway leaves "user_version did not advance" TRUE on top of
 * rebuilt or dropped tables; the guard does not restore the backup on a non-zero
 * exit either. Putting the old code back there is worse than the crash loop.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { checkForUpdates, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";
import { _setAlertChannelsForTest } from "../servers/shared/migration-guard.js";
import { _setAlertsRootForTest } from "../servers/shared/alert-spool.js";
import { readUpdateQuarantine, quarantinePath } from "../servers/shared/update-quarantine.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;
_setAlertChannelsForTest({ sendNtfyNotification: async () => {}, sendEmailNotification: async () => {} });

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const BS3 = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;

const _fixtures = [];
after(() => {
  _setAppRootForTest(REAL_APP_ROOT);
  _setDbForTest(null);
  _setAlertsRootForTest(null);
  for (const f of _fixtures) f.cleanup();
  _fixtures.length = 0;
});

/** init-db that fails after touching a sentinel (proves it ran). */
const FAILING_INIT_DB = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./init-db-ran.sentinel", import.meta.url), "1");
process.exit(1);
`;

/** init-db that advances the schema generation and then fails. */
const ADVANCING_INIT_DB = `import Database from ${JSON.stringify(BS3)};
const db = new Database(process.env.CROW_DB_PATH);
db.pragma("user_version = 99");
db.close();
process.exit(1);
`;

/** init-db that leaves the DB unreadable and then fails. */
const CORRUPTING_INIT_DB = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.CROW_DB_PATH, "this is not a sqlite database\\n");
process.exit(1);
`;

const OK_INIT_DB = `process.exit(0);\n`;

/**
 * A bare origin plus a clone one commit behind, and the DB the running instance
 * already has.
 *
 *   mode "guarded": B changes scripts/init-db.js itself, which arms the
 *                   migration guard (the guarded init-db branch).
 *   mode "plain":   B leaves scripts/init-db.js alone and changes a file it
 *                   imports, so nothing arms and the bare branch runs — the only
 *                   branch where B1 can still allow a rollback.
 */
function fixture({ mode = "plain", initDbBody = FAILING_INIT_DB, bFiles = {}, dbUserVersion = 1, changePkg = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "idbr-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  mkdirSync(join(work, "scripts"), { recursive: true });
  mkdirSync(join(work, "servers", "gateway"), { recursive: true });
  mkdirSync(join(work, "servers", "shared"), { recursive: true });
  // No import-check seam in this fixture: these tests are about init-db.
  writeFileSync(join(work, "servers", "gateway", "index.js"), "process.exit(0);\n");
  writeFileSync(join(work, "servers", "shared", "schema-version.js"), "export const SCHEMA_GENERATION = 1;\n");
  writeFileSync(join(work, "package.json"), '{\n  "name": "fixture"\n}\n');
  if (mode === "plain") {
    writeFileSync(join(work, "scripts", "init-db-env.mjs"), "process.exit(0);\n");
    writeFileSync(join(work, "scripts", "init-db.js"), 'import "./init-db-env.mjs";\nprocess.exit(0);\n');
  } else {
    writeFileSync(join(work, "scripts", "init-db.js"), OK_INIT_DB);
  }
  g(work, "add", "-A");
  g(work, "commit", "-m", "P");
  g(work, "push", "origin", "main");
  const prev = g(work, "rev-parse", "HEAD");

  if (mode === "plain") writeFileSync(join(work, "scripts", "init-db-env.mjs"), initDbBody);
  else writeFileSync(join(work, "scripts", "init-db.js"), initDbBody);
  // A dependency change makes the rollback reinstall node_modules too.
  if (changePkg) writeFileSync(join(work, "package.json"), '{\n  "name": "fixture",\n  "version": "0.0.2"\n}\n');
  for (const [name, body] of Object.entries(bFiles)) {
    mkdirSync(join(work, name, ".."), { recursive: true });
    writeFileSync(join(work, name), body);
  }
  g(work, "add", "-A");
  g(work, "commit", "-m", "B");
  g(work, "push", "origin", "main");
  const bad = g(work, "rev-parse", "HEAD");
  g(work, "reset", "--hard", prev);

  const dbDir = join(root, "db");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "crow.db");
  // A real, readable DB: readSchemaState() must be able to judge it before AND
  // after the failure, or B1 refuses the rollback for the wrong reason.
  const d = new Database(dbPath);
  for (const tbl of ["memories", "dashboard_settings", "crow_context"]) {
    d.prepare(`CREATE TABLE ${tbl} (id INTEGER PRIMARY KEY)`).run();
  }
  d.pragma(`user_version = ${dbUserVersion}`);
  d.close();

  const f = {
    root, work, prev, bad,
    gitDir: join(work, ".git"),
    dbPath,
    alerts: join(root, "alerts"),
    sentinel: join(work, "scripts", "init-db-ran.sentinel"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  _fixtures.push(f);
  return f;
}

function stubDb() {
  const settings = new Map();
  return {
    settings,
    async execute({ sql, args = [] } = {}) {
      if (/^\s*SELECT value FROM dashboard_settings WHERE key = \?/.test(sql || "")) {
        return { rows: settings.has(args[0]) ? [{ value: settings.get(args[0]) }] : [] };
      }
      if (/SELECT key, value FROM dashboard_settings WHERE key IN \(\?, \?\)/.test(sql || "")) {
        return { rows: args.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })) };
      }
      if (/INSERT INTO dashboard_settings/.test(sql || "")) settings.set(args[0], args[1]);
      return { rows: [] };
    },
  };
}

/** Bodies of the alerts spooled under `root`, newest last. */
function spooledBodies(root) {
  try {
    return readdirSync(join(root, "pending"))
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(root, "pending", n), "utf8")))
      .map((a) => ({ code: a.code, body: a.body }));
  } catch { return []; }
}

function install(f, db, prevDbPathEnv) {
  _setAppRootForTest(f.work);
  _setDbForTest(db);
  _setAlertsRootForTest(f.alerts);
  process.env.CROW_DB_PATH = f.dbPath; // the guard resolves the DB from this
  return prevDbPathEnv;
}

function uninstall(prevDbPathEnv) {
  _setAppRootForTest(REAL_APP_ROOT);
  _setDbForTest(null);
  _setAlertsRootForTest(null);
  if (prevDbPathEnv === undefined) delete process.env.CROW_DB_PATH;
  else process.env.CROW_DB_PATH = prevDbPathEnv;
}

test("an init-db failure that changed nothing resets the tree and quarantines (bare branch)", async () => {
  const f = fixture({ mode: "plain", initDbBody: FAILING_INIT_DB });
  const db = stubDb();
  const saved = process.env.CROW_DB_PATH;
  try {
    install(f, db, saved);
    const r = await checkForUpdates();

    assert.equal(r.converge, false, "the restart stays withheld");
    assert.equal(existsSync(f.sentinel), true, "init-db did run (and failed)");
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev, "the tree is rolled back, not left at the failing sha");
    const marker = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(marker.sha, f.bad);
    assert.equal(marker.reason, "init-db-failed");
    assert.ok(marker.expires_at, "a machine-side reason expires");
    // The operator-facing result text is unchanged by the rollback…
    assert.match(db.settings.get("auto_update_last_result"), /^init-db failed \(exit 1\)/);
    // …but the alert says what actually happened, and never promises a retry on
    // the next restart after the tree was reset (B1).
    const alert = spooledBodies(f.alerts).find((a) => a.code === "init-db-failed");
    assert.ok(alert, "the DB-possibly-broken path keeps the spool alert");
    assert.match(alert.body, new RegExp(`The checkout was rolled back to ${f.prev.slice(0, 9)}`));
    assert.ok(!/next restart will retry/.test(alert.body), `the tree was reset: ${alert.body}`);
  } finally { uninstall(saved); }
});

test("a changed scripts/init-db.js leaves the tree at the pulled sha and says so (guarded)", async () => {
  // B1: a mid-run failure of a CHANGED init-db may have rebuilt or dropped
  // tables on DB shape, without moving user_version. Rolling back would put old
  // code on a store it was never written for.
  const f = fixture({ mode: "guarded", initDbBody: FAILING_INIT_DB });
  const db = stubDb();
  const saved = process.env.CROW_DB_PATH;
  try {
    install(f, db, saved);
    const r = await checkForUpdates();

    assert.equal(r.converge, false);
    assert.equal(existsSync(f.sentinel), true, "init-db did run (and failed)");
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad,
      "a changed init-db.js means the store may be half-rebuilt — the tree stays");
    assert.equal(existsSync(quarantinePath(f.gitDir)), false, "nothing is quarantined either");
    const alert = spooledBodies(f.alerts).find((a) => a.code === "migration-failed");
    assert.ok(alert, "the operator is told");
    assert.match(alert.body, /The tree was left at/);
    assert.match(alert.body, /scripts\/init-db\.js changed in the pull/);
    assert.match(alert.body, /next restart will retry via the boot gate/);
    assert.ok(!/rolled back to/.test(alert.body), `nothing was rolled back: ${alert.body}`);
  } finally { uninstall(saved); }
});

test("a schema-generation crossing leaves the tree even when user_version did not advance", async () => {
  const f = fixture({
    mode: "guarded",
    initDbBody: FAILING_INIT_DB,
    dbUserVersion: 1,
    bFiles: { "servers/shared/schema-version.js": "export const SCHEMA_GENERATION = 2;\n" },
  });
  const db = stubDb();
  const saved = process.env.CROW_DB_PATH;
  try {
    install(f, db, saved);
    const r = await checkForUpdates();

    assert.equal(r.converge, false);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad,
      "the pull crosses a generation — old code was never written for the new shape");
    assert.equal(existsSync(quarantinePath(f.gitDir)), false);
    const alert = spooledBodies(f.alerts).find((a) => a.code === "migration-failed");
    assert.match(alert.body, /crosses a schema generation \(1 -> 2\)/);
    assert.match(alert.body, /The tree was left at/);
  } finally { uninstall(saved); }
});

test("an unreadable database after the failure leaves the tree (fail closed)", async () => {
  const f = fixture({ mode: "plain", initDbBody: CORRUPTING_INIT_DB });
  const db = stubDb();
  const saved = process.env.CROW_DB_PATH;
  try {
    install(f, db, saved);
    const r = await checkForUpdates();

    assert.equal(r.converge, false);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad,
      "a DB that cannot be read is not evidence that nothing was migrated");
    assert.equal(existsSync(quarantinePath(f.gitDir)), false);
    const alert = spooledBodies(f.alerts).find((a) => a.code === "init-db-failed");
    assert.match(alert.body, /the database could not be read after the failure/);
  } finally { uninstall(saved); }
});

test("with a generation advance the tree is left exactly as it is", async () => {
  const f = fixture({ mode: "guarded", initDbBody: ADVANCING_INIT_DB });
  const db = stubDb();
  const saved = process.env.CROW_DB_PATH;
  try {
    install(f, db, saved);
    const r = await checkForUpdates();

    assert.equal(r.converge, false);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad,
      "the new code already wrote the store — rolling it back would run old code on a shape it never knew");
    assert.equal(existsSync(quarantinePath(f.gitDir)), false, "nothing is quarantined for a generation crossing");
    assert.match(db.settings.get("auto_update_last_result"), /^Migration failed \(init-db exit 1\)/);
    const alert = spooledBodies(f.alerts).find((a) => a.code === "migration-failed");
    assert.match(alert.body, /user_version advanced \(1 -> 99\)/);
  } finally { uninstall(saved); }
});

test("the init-db rollback's own failed npm install is reported on the result and the alert", async () => {
  // S1. The rollback reinstalls the previous commit's deps; when THAT npm fails,
  // node_modules may hold a half-written tree under the last healthy commit, so
  // the operator has to be told to run the install by hand before restarting.
  // The old code logged it and reported a clean rollback.
  const f = fixture({ mode: "plain", initDbBody: FAILING_INIT_DB, changePkg: true });
  const db = stubDb();
  const saved = process.env.CROW_DB_PATH;
  const shimDir = join(f.root, "bin");
  const callsLog = join(f.root, "npm-calls.log");
  const prevPath = process.env.PATH;
  try {
    install(f, db, saved);
    mkdirSync(shimDir, { recursive: true });
    // The install for the PULLED sha succeeds; the rollback's reinstall fails.
    writeFileSync(join(shimDir, "npm"), `#!/bin/sh
echo call >> '${callsLog}'
if [ "$(wc -l < '${callsLog}')" -gt 1 ]; then exit 1; fi
exit 0
`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${prevPath}`;

    const r = await checkForUpdates();
    process.env.PATH = prevPath;

    assert.equal(r.converge, false, "the restart stays withheld");
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev, "the tree WAS rolled back");
    assert.equal(readFileSync(callsLog, "utf8").trim().split("\n").length, 2,
      "npm ran once for the pull and once for the rollback");

    // Case-insensitive: the result joins the clause with `; `, the alert opens a
    // sentence with it.
    const clause = /its dependencies could not be reinstalled — run npm install --omit=dev in the checkout before the next restart/i;
    const result = db.settings.get("auto_update_last_result");
    assert.match(result, /^init-db failed \(exit 1\)/, "the classification prefix is unchanged");
    assert.match(result, clause, `the result must say the deps are not back: ${result}`);

    const alert = spooledBodies(f.alerts).find((a) => a.code === "init-db-failed");
    assert.ok(alert, "the DB-possibly-broken path keeps the spool alert");
    assert.match(alert.body, clause, `the alert must carry the same clause: ${alert.body}`);
    assert.ok(!/with its own dependencies reinstalled/i.test(`${alert.body} ${result}`),
      "nothing may claim the deps were reinstalled");
  } finally {
    process.env.PATH = prevPath;
    uninstall(saved);
  }
});

test("the next tick says update quarantined, never Up to date", async () => {
  const f = fixture({ mode: "plain", initDbBody: FAILING_INIT_DB });
  const db = stubDb();
  const saved = process.env.CROW_DB_PATH;
  try {
    install(f, db, saved);
    assert.equal((await checkForUpdates()).converge, false);

    db.settings.clear();
    const second = await checkForUpdates();

    assert.equal(second.skipped, "update-quarantined", JSON.stringify(second));
    assert.match(db.settings.get("auto_update_last_result"), /^Skipped: update quarantined/);
    assert.notEqual(db.settings.get("auto_update_last_result"), "Up to date");
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev);
  } finally { uninstall(saved); }
});