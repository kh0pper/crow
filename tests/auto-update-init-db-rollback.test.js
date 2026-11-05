/**
 * L0.5 — a pulled sha whose init-db fails is rolled back too (audit N1c-3).
 *
 * Before this, that path withheld the restart but LEFT the tree at the new sha:
 * the next restart for any reason (a reboot, a bundle install, a crash) booted
 * it, its boot guard re-ran the failing init-db and exited 1, and systemd looped
 * forever. The next tick also reported "Up to date", hiding the withheld restart.
 *
 * Rollback is allowed only when the schema generation did NOT advance: a
 * generation crossing means the new code already wrote the store, and the old
 * code was never written for that shape.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";
import { _setAlertChannelsForTest } from "../servers/shared/migration-guard.js";
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

const OK_INIT_DB = `process.exit(0);\n`;

/**
 * A bare origin plus a clone one commit behind.
 *
 *   mode "guarded": B changes scripts/init-db.js itself, which arms the
 *                   migration guard (the guarded init-db branch).
 *   mode "plain":   B changes a file init-db imports, so nothing arms and the
 *                   bare `node scripts/init-db.js` branch runs.
 */
function fixture({ mode, initDbBody }) {
  const root = mkdtempSync(join(tmpdir(), "idbr-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  mkdirSync(join(work, "scripts"), { recursive: true });
  mkdirSync(join(work, "servers", "gateway"), { recursive: true });
  // No import-check seam in this fixture: these tests are about init-db.
  writeFileSync(join(work, "servers", "gateway", "index.js"), "process.exit(0);\n");
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
  g(work, "add", "-A");
  g(work, "commit", "-m", "B");
  g(work, "push", "origin", "main");
  const bad = g(work, "rev-parse", "HEAD");
  g(work, "reset", "--hard", prev);

  const dbDir = join(root, "db");
  mkdirSync(dbDir, { recursive: true });
  const f = {
    root, work, prev, bad,
    gitDir: join(work, ".git"),
    dbPath: join(dbDir, "crow.db"),
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

function install(f, db, prevDbPathEnv) {
  _setAppRootForTest(f.work);
  _setDbForTest(db);
  process.env.CROW_DB_PATH = f.dbPath; // the guard resolves the DB from this
  return prevDbPathEnv;
}

function uninstall(prevDbPathEnv) {
  _setAppRootForTest(REAL_APP_ROOT);
  _setDbForTest(null);
  if (prevDbPathEnv === undefined) delete process.env.CROW_DB_PATH;
  else process.env.CROW_DB_PATH = prevDbPathEnv;
}

test("init-db failure without a generation advance resets the tree and quarantines (guarded branch)", async () => {
  const f = fixture({ mode: "guarded", initDbBody: FAILING_INIT_DB });
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
    // The operator-facing text is unchanged by the rollback.
    assert.match(db.settings.get("auto_update_last_result"), /^Migration failed \(init-db exit 1\)/);
  } finally { uninstall(saved); }
});

test("init-db failure without a generation advance resets the tree (bare branch)", async () => {
  const f = fixture({ mode: "plain", initDbBody: FAILING_INIT_DB });
  const db = stubDb();
  const saved = process.env.CROW_DB_PATH;
  try {
    install(f, db, saved);
    const r = await checkForUpdates();

    assert.equal(r.converge, false);
    assert.equal(existsSync(f.sentinel), true, "init-db did run (and failed)");
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev);
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }).reason, "init-db-failed");
    assert.match(db.settings.get("auto_update_last_result"), /^init-db failed \(exit 1\)/);
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
  } finally { uninstall(saved); }
});

test("the next tick says update quarantined, never Up to date", async () => {
  const f = fixture({ mode: "guarded", initDbBody: FAILING_INIT_DB });
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