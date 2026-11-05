/**
 * L0.2 — the puller's import check (audit N1c-3).
 *
 * A pulled sha whose gateway module graph throws while loading used to be
 * committed to: init-db ran against it, convergence wrote the boot cookie and
 * restarted, and systemd then restarted the crash loop forever — the fix on main
 * was never even fetched. The check runs the pulled tree in a child with the
 * ORIGINAL environment, requires exit 0 AND a token, and rolls the checkout back
 * with `git reset --keep` before init-db ever runs.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, _setAppRootForTest, _setDbForTest, _setImportCheckForTest } from "../servers/gateway/auto-update.js";
import { _setAlertChannelsForTest } from "../servers/shared/migration-guard.js";
import { _setAlertsRootForTest } from "../servers/shared/alert-spool.js";
import { readUpdateQuarantine } from "../servers/shared/update-quarantine.js";
import {
  IMPORT_CHECK_ENV, IMPORT_CHECK_TOKEN, _setOriginalEnvForTest, hasImportCheckSeam, originalEnv, runImportCheck,
} from "../servers/gateway/boot/import-check.js";

// A successful update arms the gateway's restart chain; never inside a test.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;
_setAlertChannelsForTest({ sendNtfyNotification: async () => {}, sendEmailNotification: async () => {} });

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const _fixtures = [];
after(() => {
  _setAppRootForTest(REAL_APP_ROOT);
  _setDbForTest(null);
  _setImportCheckForTest(null);
  _setOriginalEnvForTest(null);
  _setAlertsRootForTest(null);
  for (const f of _fixtures) f.cleanup();
  _fixtures.length = 0;
});

/* --------------------------------------------------------------- fixtures */

/** The pulled sha's gateway: the static graph throws before the seam is reached. */
const SEAM_THROWS = `import "./boom.js";
if (process.env.${IMPORT_CHECK_ENV} === "1") { process.stdout.write("${IMPORT_CHECK_TOKEN}\\n"); process.exit(0); }
`;

const BOOM = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./import-ran.sentinel", import.meta.url), "1");
throw new Error("this gateway graph does not load");
`;

/** Holds a live handle, so the child really hangs (a bare top-level await makes
 *  node exit by itself with "unsettled top-level await"). */
const HANGING = `if (process.env.${IMPORT_CHECK_ENV} === "1") { setInterval(() => {}, 1000); }
`;

/** Exits 0 without ever printing the token: not proof of a load. */
const NO_TOKEN = `if (process.env.${IMPORT_CHECK_ENV} === "1") { process.exit(0); }
`;

const NO_SEAM = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./import-ran.sentinel", import.meta.url), "1");
process.exit(0);
`;

const INIT_DB_OK = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./init-db-ran.sentinel", import.meta.url), "1");
process.exit(0);
`;

/** A pulled gateway that LOADS: it records that the child ran (the sentinel) and
 *  then answers the seam with the token, so the import check passes. */
const PASSING_SEAM = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./import-ran.sentinel", import.meta.url), "1");
if (process.env.${IMPORT_CHECK_ENV} === "1") { process.stdout.write("${IMPORT_CHECK_TOKEN}\\n"); process.exit(0); }
`;

/**
 * A bare origin plus a clone sitting one commit behind it.
 *
 * P is the running sha (init-db, a gateway, a.txt, package.json). B is the
 * pulled sha: `bIndex` becomes its servers/gateway/index.js.
 */
function fixture({ bIndex, bFiles = {}, changeA = false, changePkg = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ic-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  mkdirSync(join(work, "scripts"), { recursive: true });
  mkdirSync(join(work, "servers", "gateway"), { recursive: true });
  writeFileSync(join(work, "scripts", "init-db.js"), INIT_DB_OK);
  writeFileSync(join(work, "servers", "gateway", "index.js"), "process.exit(0);\n");
  writeFileSync(join(work, "a.txt"), "one\n");
  writeFileSync(join(work, "package.json"), '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  g(work, "add", "-A");
  g(work, "commit", "-m", "P");
  g(work, "push", "origin", "main");
  const prev = g(work, "rev-parse", "HEAD");

  writeFileSync(join(work, "servers", "gateway", "index.js"), bIndex);
  for (const [name, body] of Object.entries(bFiles)) {
    mkdirSync(join(work, name, ".."), { recursive: true });
    writeFileSync(join(work, name), body);
  }
  if (changeA) writeFileSync(join(work, "a.txt"), "two\n");
  if (changePkg) writeFileSync(join(work, "package.json"), '{\n  "name": "fixture",\n  "version": "1.1.0"\n}\n');
  g(work, "add", "-A");
  g(work, "commit", "-m", "B");
  g(work, "push", "origin", "main");
  const bad = g(work, "rev-parse", "HEAD");
  g(work, "reset", "--hard", prev); // the clone is now genuinely behind

  const f = {
    root, origin, work, prev, bad,
    gitDir: join(work, ".git"),
    alerts: join(root, "alerts"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  _fixtures.push(f);
  return f;
}

function stubDb() {
  const settings = new Map();
  const notifications = [];
  return {
    settings,
    // Bells: createNotification's INSERT is recorded so a test can count them.
    notifications,
    async execute({ sql, args = [] } = {}) {
      if (/^\s*SELECT value FROM dashboard_settings WHERE key = \?/.test(sql || "")) {
        return { rows: settings.has(args[0]) ? [{ value: settings.get(args[0]) }] : [] };
      }
      if (/SELECT key, value FROM dashboard_settings WHERE key IN \(\?, \?\)/.test(sql || "")) {
        return { rows: args.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })) };
      }
      if (/INSERT INTO dashboard_settings/.test(sql || "")) {
        settings.set(args[0], args[1]);
        return { rows: [], lastInsertRowid: 0 };
      }
      if (/INSERT INTO notifications/.test(sql || "")) {
        notifications.push({
          type: args[0], source: args[1], title: args[2], body: args[3],
          priority: args[4], action_url: args[5], metadata: args[6],
        });
        return { rows: [], lastInsertRowid: notifications.length };
      }
      return { rows: [] };
    },
  };
}

/** Codes of the alerts spooled under `root` by the run under test. */
function spooledCodes(root) {
  const dir = join(root, "pending");
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).code);
  } catch { return []; }
}

function install(f, db) {
  _setAppRootForTest(f.work);
  _setDbForTest(db);
  _setAlertsRootForTest(f.alerts);
}

/* --------------------------------------------------- the import check itself */

test("a tree whose gateway graph throws at import fails the check", () => {
  const f = fixture({ bIndex: SEAM_THROWS, bFiles: { "servers/gateway/boom.js": BOOM } });
  g(f.work, "checkout", f.bad); // look at the pulled tree directly
  return runImportCheck({ appRoot: f.work }).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.token, false);
    assert.equal(r.exitCode, 1);
    assert.equal(r.timedOut, false);
    assert.match(r.stderr, /does not load/);
    assert.ok(existsSync(join(f.work, "servers", "gateway", "import-ran.sentinel")),
      "the child really did evaluate the graph");
  });
});

test("a tree whose index.js only MENTIONS the seam in a comment has no seam", () => {
  // S3: `includes("CROW_GATEWAY_IMPORT_CHECK")` is true for a comment, so a
  // future sha that keeps the comment but moves the statement would be run as a
  // full gateway (with the live DB) until the deadline kills it.
  const f = fixture({
    bIndex: `// The ${IMPORT_CHECK_ENV} seam was moved below this line.\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(new URL("./import-ran.sentinel", import.meta.url), "1");\n` +
      `process.exit(0);\n`,
  });
  g(f.work, "checkout", f.bad);
  assert.equal(hasImportCheckSeam(f.work), false, "a comment is not a seam");
});

test("a hanging graph is a timeout, not a pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "ic-plain-"));
  try {
    mkdirSync(join(root, "servers", "gateway"), { recursive: true });
    writeFileSync(join(root, "servers", "gateway", "index.js"), HANGING);
    const r = await runImportCheck({ appRoot: root, timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true, "the child was killed at the deadline");
    assert.equal(r.token, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exit 0 without the token is a failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "ic-plain-"));
  try {
    mkdirSync(join(root, "servers", "gateway"), { recursive: true });
    writeFileSync(join(root, "servers", "gateway", "index.js"), NO_TOKEN);
    const r = await runImportCheck({ appRoot: root });
    assert.equal(r.exitCode, 0);
    assert.equal(r.token, false);
    assert.equal(r.ok, false, "an early exit proves nothing about the graph");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A shell for "is this pid still running?" that does not count a zombie. */
function processAlive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z"; // it exited; only the table entry is left
  } catch { return true; } // no /proc: trust the signal check
}

test("a grandchild holding stdout is a clean timeout, and nothing survives it", async () => {
  // The child loads, prints the token and exits 0, but leaves a grandchild that
  // inherited stdout. The parent's pipe only closes with the last holder, so a
  // direct-child kill alone would (a) report this healthy tree as a timeout AND
  // (b) leak the grandchild. The deadline must take the whole process group.
  const root = mkdtempSync(join(tmpdir(), "ic-grandchild-"));
  const pidFile = join(root, "servers", "gateway", "grandchild.pid");
  try {
    mkdirSync(join(root, "servers", "gateway"), { recursive: true });
    writeFileSync(join(root, "servers", "gateway", "index.js"), `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const kid = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "ignore"] });
writeFileSync(new URL("./grandchild.pid", import.meta.url), String(kid.pid));
if (process.env.${IMPORT_CHECK_ENV} === "1") { process.stdout.write("${IMPORT_CHECK_TOKEN}\\n"); process.exit(0); }
`);
    const r = await Promise.race([
      runImportCheck({ appRoot: root, timeoutMs: 1500 }),
      new Promise((_res, rej) => setTimeout(() => rej(new Error("the import check never returned")), 10000)),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true, "the pipe stayed open past the deadline — that is a timeout, not a pass");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0, "the fixture recorded its grandchild's pid");
    assert.equal(processAlive(pid), false, "the whole process group was killed, not just the direct child");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tree without the seam reports it, so the caller can skip and log", () => {
  const f = fixture({ bIndex: NO_SEAM });
  g(f.work, "checkout", f.bad);
  assert.equal(hasImportCheckSeam(f.work), false);
});

/* ------------------------------------------------------------- the rollback */

test("a pulled sha whose gateway graph throws at import is rolled back before init-db", async () => {
  const f = fixture({ bIndex: SEAM_THROWS, bFiles: { "servers/gateway/boom.js": BOOM } });
  const db = stubDb();
  try {
    install(f, db);
    const r = await checkForUpdates();

    assert.equal(r.converged, false, "a rolled-back update never restarts");
    assert.equal(r.rolledBack, true, JSON.stringify(r));
    assert.match(db.settings.get("auto_update_last_result"), /^Rolled back: /);
    assert.match(db.settings.get("auto_update_last_result"),
      new RegExp(`Rolled back: ${f.bad.slice(0, 9)} fails to load \\(import-check\\); running ${f.prev.slice(0, 9)}`));

    // HEAD is AHEAD-attached-to-main at the previous sha, not a detached HEAD.
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev);
    assert.equal(g(f.work, "symbolic-ref", "HEAD"), "refs/heads/main");

    // The child ran (the check happened) but init-db never did.
    assert.ok(existsSync(join(f.work, "servers", "gateway", "import-ran.sentinel")));
    assert.ok(!existsSync(join(f.work, "scripts", "init-db-ran.sentinel")),
      "init-db must not run for a sha that cannot load");

    // The record: in the git dir, full shas, no TTL for a clean failure.
    const marker = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(marker.sha, f.bad);
    assert.equal(marker.previous, f.prev);
    assert.equal(marker.reason, "import-check");
    assert.equal(marker.expires_at, undefined);
    assert.ok(marker.previous.length === 40 && marker.sha.length === 40, "full 40-hex shas only");

    assert.ok(spooledCodes(f.alerts).length === 0,
      `one bell per rollback: the spool write is dropped, the classified result already rings it (saw ${JSON.stringify(spooledCodes(f.alerts))})`);
  } finally {
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("a timeout quarantines with the transient reason and a 6 h TTL", async () => {
  const f = fixture({ bIndex: SEAM_THROWS, bFiles: { "servers/gateway/boom.js": BOOM } });
  const db = stubDb();
  try {
    install(f, db);
    _setImportCheckForTest(() => ({ ok: false, reason: "import-timeout" }));
    const r = await checkForUpdates();

    assert.equal(r.rolledBack, true, JSON.stringify(r));
    assert.match(db.settings.get("auto_update_last_result"), /fails to load \(import-timeout\)/);
    const marker = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(marker.reason, "import-timeout");
    const ttl = Date.parse(marker.expires_at) - Date.parse(marker.at);
    assert.ok(Math.abs(ttl - 6 * 60 * 60 * 1000) < 2000, `expected a 6 h TTL, got ${ttl} ms`);
  } finally {
    _setImportCheckForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("an overlapping tracked change: --keep refuses, the marker stays, the alert fires", async () => {
  const f = fixture({ bIndex: SEAM_THROWS, bFiles: { "servers/gateway/boom.js": BOOM }, changeA: true });
  const db = stubDb();
  const realGit = execFileSync("sh", ["-c", "command -v git"], { stdio: "pipe" }).toString().trim();
  const shimDir = join(f.root, "bin");
  const prevPath = process.env.PATH;
  try {
    install(f, db);
    // The shim dirties a file B changed at the moment of the reset, i.e. local
    // work that overlaps the rollback — exactly what --keep must never destroy.
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "reset" ]; then printf 'local edit\\n' > '${join(f.work, "a.txt")}'; fi
done
exec ${realGit} "$@"
`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${prevPath}`;

    const r = await checkForUpdates();
    process.env.PATH = prevPath;

    assert.equal(r.blocked, true, JSON.stringify(r));
    assert.match(db.settings.get("auto_update_last_result"), /^Update rollback blocked/);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad, "nothing was reset");
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "local edit\n", "the local edit survived");
    const marker = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(marker.sha, f.bad, "the sha is quarantined whatever the checkout does");
    assert.ok(spooledCodes(f.alerts).length === 0,
      `one bell per rollback: no spool file on the blocked path either (saw ${JSON.stringify(spooledCodes(f.alerts))})`);
  } finally {
    process.env.PATH = prevPath;
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("deps changed: npm runs again after the reset, back on the previous sha", async () => {
  const f = fixture({ bIndex: SEAM_THROWS, bFiles: { "servers/gateway/boom.js": BOOM }, changePkg: true });
  const db = stubDb();
  const shimDir = join(f.root, "bin");
  const npmLog = join(f.root, "npm-calls.log");
  const prevPath = process.env.PATH;
  try {
    install(f, db);
    mkdirSync(shimDir, { recursive: true });
    // Records the sha the checkout holds at npm-call time: the second call must
    // find the PREVIOUS sha, i.e. it ran after the reset.
    writeFileSync(join(shimDir, "npm"), `#!/bin/sh
git -C "$PWD" rev-parse HEAD >> '${npmLog}'
exit 0
`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${prevPath}`;

    const r = await checkForUpdates();
    process.env.PATH = prevPath;

    assert.equal(r.rolledBack, true, JSON.stringify(r));
    const calls = readFileSync(npmLog, "utf8").trim().split("\n");
    assert.equal(calls.length, 2, `expected npm before and after the rollback, saw ${JSON.stringify(calls)}`);
    assert.equal(calls[0], f.bad, "the first install is for the pulled sha");
    assert.equal(calls[1], f.prev, "the reinstall happens after the reset, on the previous sha");
  } finally {
    process.env.PATH = prevPath;
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

/* ---------------------------------------------- N1c-4: a failed npm install */

/** A local npm for the PATH shim: the FIRST call fails (and prints a
 *  path-shaped stderr), every later call succeeds. Each call appends the sha the
 *  checkout holds at that moment, so a test can see WHEN the reinstall ran. */
function npmShim(shimDir, npmLog, marker) {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "npm"), `#!/bin/sh
git -C "$PWD" rev-parse HEAD >> '${npmLog}'
if [ ! -f '${marker}' ]; then
  : > '${marker}'
  echo 'npm ERR! /home/example/.crow/app/node_modules/broken postinstall failed' >&2
  exit 1
fi
exit 0
`, { mode: 0o755 });
}

test("a failed npm install aborts the update: rolled back before the import check and init-db", async () => {
  // N1c-4. On the old code the failing install only set a flag: the tick went on
  // to the import check (which passes here, so the half-installed node_modules
  // were never noticed), then to init-db, and recorded `Updated …` — a sha whose
  // dependencies never installed was left checked out for the next restart.
  const f = fixture({ bIndex: PASSING_SEAM, changePkg: true });
  const db = stubDb();
  const shimDir = join(f.root, "bin");
  const npmLog = join(f.root, "npm-calls.log");
  const failMarker = join(f.root, "npm-failed.once");
  const prevPath = process.env.PATH;
  try {
    install(f, db);
    npmShim(shimDir, npmLog, failMarker);
    process.env.PATH = `${shimDir}:${prevPath}`;

    const r = await checkForUpdates();
    process.env.PATH = prevPath;

    // The update stopped here: previous sha, still attached to main.
    assert.equal(r.rolledBack, true, JSON.stringify(r));
    assert.equal(r.converge, false, "nothing may restart into a tree it just abandoned");
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev);
    assert.equal(g(f.work, "symbolic-ref", "HEAD"), "refs/heads/main");

    // Neither later step ran: no import-check child, no init-db.
    assert.ok(!existsSync(join(f.work, "servers", "gateway", "import-ran.sentinel")),
      "the import check must not run against half-installed node_modules");
    assert.ok(!existsSync(join(f.work, "scripts", "init-db-ran.sentinel")),
      "init-db must not migrate for a sha whose deps never installed");

    // The marker: the sha, the machine-side reason, and its 6 h TTL.
    const marker = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(marker.sha, f.bad);
    assert.equal(marker.previous, f.prev);
    assert.equal(marker.reason, "deps-failed");
    const ttl = Date.parse(marker.expires_at) - Date.parse(marker.at);
    assert.ok(Math.abs(ttl - 6 * 60 * 60 * 1000) < 2000, `expected a 6 h TTL, got ${ttl} ms`);

    // The result: our own sentence, naming the cause and the retry.
    const result = db.settings.get("auto_update_last_result");
    assert.match(result, /^Rolled back: /);
    assert.equal(result,
      `Rolled back: ${f.bad.slice(0, 9)} — npm install failed; running ${f.prev.slice(0, 9)}; retried after 6 h or when main moves`);

    // One event, one bell — and npm's stderr (which names paths) never reaches it.
    assert.equal(db.notifications.length, 1, `one bell, saw ${JSON.stringify(db.notifications)}`);
    const n = db.notifications[0];
    assert.equal(n.source, "auto-update");
    assert.equal(JSON.parse(n.metadata).code, "update-rolled-back");
    assert.match(n.body, /npm install failed/i, "the bell names the cause");
    assert.ok(!/node_modules|\/home\/example|npm ERR!/.test(`${n.title} ${n.body}`),
      `npm's stderr must stay in the log: ${n.title} | ${n.body}`);
    assert.equal(spooledCodes(f.alerts).length, 0, "the DB is healthy here: no spool file");

    // The second install (the rollback's) ran on the PREVIOUS sha, not the pulled one.
    const calls = readFileSync(npmLog, "utf8").trim().split("\n");
    assert.equal(calls.length, 2, `expected npm before and after the rollback, saw ${JSON.stringify(calls)}`);
    assert.equal(calls[0], f.bad, "the first install is for the pulled sha");
    assert.equal(calls[1], f.prev, "the reinstall happens after the reset, on the previous sha");
  } finally {
    process.env.PATH = prevPath;
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("a failed npm install whose rollback is refused reports the blocked result and keeps the marker", async () => {
  // N1c-4 + B3: the same wording family as the import-check path, from the same
  // factored branch. On the old code nothing was rolled back at all, so there was
  // no refusal to report and the result read `Updated …`.
  const f = fixture({ bIndex: PASSING_SEAM, changePkg: true, changeA: true });
  const db = stubDb();
  const shimDir = join(f.root, "bin");
  const npmLog = join(f.root, "npm-calls.log");
  const failMarker = join(f.root, "npm-failed.once");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { stdio: "pipe" }).toString().trim();
  const prevPath = process.env.PATH;
  try {
    install(f, db);
    npmShim(shimDir, npmLog, failMarker);
    // The git shim dirties a file the pulled commit changed at the moment of the
    // reset: local work that overlaps the rollback, exactly what --keep refuses
    // to destroy.
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "reset" ]; then printf 'local edit\\n' > '${join(f.work, "a.txt")}'; fi
done
exec ${realGit} "$@"
`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${prevPath}`;

    const r = await checkForUpdates();
    process.env.PATH = prevPath;

    assert.equal(r.blocked, true, JSON.stringify(r));
    assert.equal(r.converge, false);
    assert.equal(db.settings.get("auto_update_last_result"),
      `Update rollback blocked: ${f.bad.slice(0, 9)} — npm install failed and the checkout could not be reset to ${f.prev.slice(0, 9)} — local changes overlap it; restart withheld`);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad, "nothing was reset");
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "local edit\n", "the local edit survived");

    // The marker is written FIRST, so it stays whatever the checkout does.
    const marker = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(marker.sha, f.bad, "the sha is quarantined whatever the checkout does");
    assert.equal(marker.reason, "deps-failed");

    assert.ok(!existsSync(join(f.work, "servers", "gateway", "import-ran.sentinel")));
    assert.ok(!existsSync(join(f.work, "scripts", "init-db-ran.sentinel")));
    assert.equal(db.notifications.length, 1, `one bell, saw ${JSON.stringify(db.notifications)}`);
    assert.equal(JSON.parse(db.notifications[0].metadata).code, "update-rollback-blocked");
    // The reinstall never runs when the reset refused: node_modules still hold
    // the pulled sha's tree, frozen until the operator repairs the checkout.
    assert.equal(readFileSync(npmLog, "utf8").trim().split("\n").length, 1);
  } finally {
    process.env.PATH = prevPath;
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("no dependency change: npm never runs and the update completes as before", async () => {
  // The abort lives INSIDE the deps-changed path, so an update that touched no
  // package file must not pay for a dependency install — or a reinstall.
  const f = fixture({ bIndex: PASSING_SEAM });
  const db = stubDb();
  const shimDir = join(f.root, "bin");
  const npmLog = join(f.root, "npm-calls.log");
  const prevPath = process.env.PATH;
  try {
    install(f, db);
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "npm"), `#!/bin/sh
echo called >> '${npmLog}'
exit 1
`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${prevPath}`;

    const r = await checkForUpdates();
    process.env.PATH = prevPath;

    assert.equal(r.updated, true, JSON.stringify(r));
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad);
    assert.ok(!existsSync(npmLog), "no package file changed, so npm was never invoked");
    assert.ok(existsSync(join(f.work, "servers", "gateway", "import-ran.sentinel")));
    assert.ok(existsSync(join(f.work, "scripts", "init-db-ran.sentinel")), "the update completed normally");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "nothing was quarantined");
    assert.match(db.settings.get("auto_update_last_result"), /^Updated /);
    assert.equal(db.notifications.length, 0, "a successful update never rings");
  } finally {
    process.env.PATH = prevPath;
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("an unresolvable previous sha is a distinct blocked reason, never a bogus reset", async () => {
  // `reset --keep ""` fails with git's overlap message, which would blame local
  // changes for a checkout whose own HEAD could not be read.
  const f = fixture({ bIndex: SEAM_THROWS, bFiles: { "servers/gateway/boom.js": BOOM } });
  const db = stubDb();
  const realGit = execFileSync("sh", ["-c", "command -v git"], { stdio: "pipe" }).toString().trim();
  const shimDir = join(f.root, "bin");
  const argvLog = join(f.root, "git-argv.log");
  const prevPath = process.env.PATH;
  try {
    install(f, db);
    mkdirSync(shimDir, { recursive: true });
    // `rev-parse HEAD` (the FULL-sha read, not `--short`) prints nothing while the
    // checkout still sits on the previous sha: the pre-pull read is unresolvable.
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> '${argvLog}'
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ] && [ "$(${realGit} rev-parse HEAD)" = '${f.prev}' ]; then exit 0; fi
exec ${realGit} "$@"
`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${prevPath}`;

    const r = await checkForUpdates();
    process.env.PATH = prevPath;

    assert.equal(r.blocked, true, JSON.stringify(r));
    assert.match(db.settings.get("auto_update_last_result"),
      new RegExp(`^Update rollback blocked: ${f.bad.slice(0, 9)} fails to load \\(import-check\\) and the checkout could not be reset to the previous commit — the previous commit could not be determined`));
    const calls = readFileSync(argvLog, "utf8");
    assert.ok(!/reset --keep/.test(calls), `no reset was attempted: ${calls}`);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad, "nothing was reset");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }).sha, f.bad, "the sha is still quarantined");
  } finally {
    process.env.PATH = prevPath;
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("originalEnv() is the PRE-gate environment: a real gate run leaves it untouched", async () => {
  // S6: the snapshot test above proves the object is frozen, not that it is the
  // environment the unit configured. This spawns a real process whose first
  // import is the real instance-paths gate, so the checkout .env really does pin
  // CROW_DATA_DIR in process.env — and originalEnv() must still be clean.
  const scratchHome = mkdtempSync(join(tmpdir(), "ic-env-"));
  const entry = join(scratchHome, "entry.mjs");
  const outFile = join(scratchHome, "out.json");
  const dataDir = join(scratchHome, "inst", "data");
  const envPath = join(scratchHome, "gateway.env");
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(envPath, `CROW_DATA_DIR=${dataDir}\n`);
    writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(join(REAL_APP_ROOT, "servers", "gateway", "boot", "run-instance-paths-gate.js")).href)};
import { writeFileSync } from "node:fs";
import { originalEnv } from ${JSON.stringify(pathToFileURL(join(REAL_APP_ROOT, "servers", "gateway", "boot", "import-check.js")).href)};
writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
  live: process.env.CROW_DATA_DIR ?? null,
  original: originalEnv().CROW_DATA_DIR ?? null,
}));
`);
    const childEnv = { ...process.env };
    for (const k of ["CROW_DATA_DIR", "CROW_DB_PATH", "CROW_TASKS_DB_PATH", "CROW_ALLOW_SHARED_DATA_DIR"]) delete childEnv[k];
    Object.assign(childEnv, {
      HOME: scratchHome,
      CROW_HOME: join(scratchHome, ".crow"),
      CROW_APP_ENV_PATH: envPath,
      CROW_ISOLATION_CHECK: "0",
    });
    execFileSync(process.execPath, [entry], { env: childEnv, stdio: "pipe", timeout: 30000 });

    const seen = JSON.parse(readFileSync(outFile, "utf8"));
    assert.equal(seen.live, dataDir, "the gate pinned CROW_DATA_DIR in process.env, as it does in the gateway");
    assert.equal(seen.original, null, "the child's env must come from BEFORE the gate (S1)");
  } finally { rmSync(scratchHome, { recursive: true, force: true }); }
});

test("a tree without the seam: the check is skipped, no child is spawned, the update goes through", async () => {
  const f = fixture({ bIndex: NO_SEAM });
  const db = stubDb();
  try {
    install(f, db);
    const r = await checkForUpdates();

    assert.equal(r.updated, true, JSON.stringify(r));
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.bad);
    assert.ok(!existsSync(join(f.work, "servers", "gateway", "import-ran.sentinel")),
      "no child may be spawned for a sha that cannot answer the check");
    assert.ok(existsSync(join(f.work, "scripts", "init-db-ran.sentinel")), "the update completed normally");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "nothing was quarantined");
  } finally {
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("the child env is the ORIGINAL environ: a waiver key from .env makes it exit 78", async () => {
  // A mini-gateway: the REAL instance-paths gate, so the child answers exactly
  // as the gateway would.
  const gateUrl = pathToFileURL(join(REAL_APP_ROOT, "servers", "gateway", "boot", "run-instance-paths-gate.js")).href;
  const bIndex = `import ${JSON.stringify(gateUrl)};
if (process.env.${IMPORT_CHECK_ENV} === "1") { process.stdout.write("${IMPORT_CHECK_TOKEN}\\n"); process.exit(0); }
process.exit(0);
`;
  const f = fixture({ bIndex });
  g(f.work, "checkout", f.bad);
  const scratchHome = join(f.root, "home");
  const ownHome = join(f.root, "inst");
  mkdirSync(join(scratchHome, ".crow", "data"), { recursive: true });
  mkdirSync(join(ownHome, "data"), { recursive: true });
  const envPath = join(f.root, "gateway.env");
  // The checkout .env names a data dir — the waiver key. A child that inherits
  // the gate's mutated process.env sees it as UNIT env and the waiver is lost.
  writeFileSync(envPath, `CROW_DATA_DIR=${join(ownHome, "data")}\n`);

  const pristine = { ...process.env, HOME: scratchHome, CROW_HOME: ownHome, CROW_APP_ENV_PATH: envPath };
  delete pristine.CROW_DATA_DIR;
  delete pristine.CROW_DB_PATH;
  delete pristine.CROW_TASKS_DB_PATH;
  delete pristine.CROW_ALLOW_SHARED_DATA_DIR;
  const savedDataDir = process.env.CROW_DATA_DIR;
  try {
    _setOriginalEnvForTest(pristine);
    // What the boot gate leaves behind in the live process: CROW_DATA_DIR, as if
    // the operator had set it in the unit.
    process.env.CROW_DATA_DIR = join(ownHome, "data");

    assert.equal(originalEnv().CROW_DATA_DIR, undefined, "the pristine env is what the child gets");
    const r = await runImportCheck({ appRoot: f.work });
    assert.equal(r.exitCode, 78, `the same env rules as the unit must apply (stderr: ${r.stderr})`);
    assert.equal(r.ok, false);
  } finally {
    if (savedDataDir === undefined) delete process.env.CROW_DATA_DIR;
    else process.env.CROW_DATA_DIR = savedDataDir;
    _setOriginalEnvForTest(null);
  }
});

test("the rollback reset runs with hooks disabled and fsmonitor off", async () => {
  const f = fixture({ bIndex: SEAM_THROWS, bFiles: { "servers/gateway/boom.js": BOOM } });
  const db = stubDb();
  const realGit = execFileSync("sh", ["-c", "command -v git"], { stdio: "pipe" }).toString().trim();
  const shimDir = join(f.root, "bin");
  const argvLog = join(f.root, "git-argv.log");
  const prevPath = process.env.PATH;
  try {
    install(f, db);
    mkdirSync(shimDir, { recursive: true });
    // Records the argv of every git invocation; live installs point
    // core.hooksPath INTO the tree, so a reset that let the pulled sha's own
    // hooks run would execute the bad sha's code as the updater's user.
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> '${argvLog}'
exec ${realGit} "$@"
`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${prevPath}`;

    const r = await checkForUpdates();
    process.env.PATH = prevPath;

    assert.equal(r.rolledBack, true, JSON.stringify(r));
    const calls = readFileSync(argvLog, "utf8").trim().split("\n");
    const reset = calls.find((line) => line.includes("reset --keep"));
    assert.ok(reset, `the rollback must be a reset --keep: ${JSON.stringify(calls)}`);
    assert.match(reset, /-c core\.hooksPath=\/dev\/null/);
    assert.match(reset, /-c core\.fsmonitor=false/);
    assert.ok(reset.indexOf("core.hooksPath") < reset.indexOf("reset"),
      "the -c overrides must precede the subcommand, or git ignores them");
    assert.ok(reset.endsWith(`--keep ${f.prev}`), `--keep names the full previous sha: ${reset}`);
  } finally {
    process.env.PATH = prevPath;
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

/* ------------------------------------------------------------------- wiring */

test("the seam is the FIRST body statement after the static imports", () => {
  const src = readFileSync(join(REAL_APP_ROOT, "servers", "gateway", "index.js"), "utf8");
  const seam = src.indexOf(`process.env.${IMPORT_CHECK_ENV} === "1"`);
  assert.ok(seam > 0, `index.js must carry the ${IMPORT_CHECK_ENV} seam`);

  // Imports are hoisted: every module of the static graph is evaluated before
  // any body statement, so a seam placed before the first body statement is
  // already "after the whole graph".
  const gateImport = src.indexOf('import "./boot/run-instance-paths-gate.js";');
  assert.ok(gateImport > 0 && gateImport < seam, "the instance-path gate stays the first import");
  const firstBody = src.indexOf("const __gatewayDir");
  assert.ok(firstBody > seam, "the seam must come before __gatewayDir — nothing may run first");

  // No DB access and no listener above it.
  for (const forbidden of ["createDbClient(", "initOAuthTables(", "app.listen(", "new Database("]) {
    const at = src.indexOf(forbidden);
    assert.ok(at === -1 || at > seam, `${forbidden} must not run before the seam`);
  }
  // The token goes out synchronously: an async write then process.exit truncates.
  const block = src.slice(seam, seam + 260);
  assert.match(block, new RegExp(`writeSync\\(1, "${IMPORT_CHECK_TOKEN}`), "the token must be written with writeSync");
  assert.match(block, /process\.exit\(0\)/);
});

test("the env snapshot is frozen before the boot gate can mutate process.env", async () => {
  const { ORIGINAL_ENV } = await import("../servers/gateway/boot/satellite-profile-guard.js");
  assert.ok(Object.isFrozen(ORIGINAL_ENV), "a later mutation of the snapshot would be silent");
  process.env.CROW_IMPORT_SNAPSHOT_PROBE = "1";
  try {
    assert.equal(ORIGINAL_ENV.CROW_IMPORT_SNAPSHOT_PROBE, undefined,
      "keys added after module evaluation are not part of the original env");
  } finally {
    delete process.env.CROW_IMPORT_SNAPSHOT_PROBE;
  }
});