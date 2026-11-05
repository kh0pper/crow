/**
 * L0.3 — the update quarantine marker (audit N1c-3).
 *
 * A commit this host already rolled back must never be pulled again, or the
 * updater re-rolls it on every tick. The record lives in the GIT DIR (shared by
 * co-hosted instances, untouched by `reset`/`clean`), names full 40-hex shas,
 * and clears itself when main moves past the bad commit.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";
import {
  evaluateUpdateQuarantine, quarantinePath, readUpdateQuarantine, writeUpdateQuarantine,
} from "../servers/shared/update-quarantine.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const _fixtures = [];
process.on("exit", () => { for (const f of _fixtures) { try { f.cleanup(); } catch {} } });

/**
 * A bare origin plus a clone one commit behind it. The pulled tree carries NO
 * import-check seam, so these tests stay about the marker: the update itself is
 * allowed to complete.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "uq-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  mkdirSync(join(work, "scripts"), { recursive: true });
  mkdirSync(join(work, "servers", "gateway"), { recursive: true });
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  writeFileSync(join(work, "servers", "gateway", "index.js"), "process.exit(0);\n");
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "-A");
  g(work, "commit", "-m", "c1");
  g(work, "push", "origin", "main");
  const f = {
    root, origin, work, gitDir: join(work, ".git"), prev: g(work, "rev-parse", "HEAD"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  _fixtures.push(f);
  return f;
}

/** Land a commit on origin only; the clone stays behind (a real deploy). */
function pushToOrigin(fx, name, content) {
  const pusher = mkdtempSync(join(fx.root, "pusher-"));
  execFileSync("git", ["clone", fx.origin, pusher], { stdio: "pipe" });
  g(pusher, "config", "user.email", "t@t");
  g(pusher, "config", "user.name", "t");
  writeFileSync(join(pusher, name), content);
  g(pusher, "add", name);
  g(pusher, "commit", "-m", `up ${name}`);
  g(pusher, "push", "origin", "main");
  return g(pusher, "rev-parse", "HEAD");
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

function cleanup() {
  _setAppRootForTest(REAL_APP_ROOT);
  _setDbForTest(null);
}

test("the marker blocks the pull when origin/main is the quarantined sha", async () => {
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check" });
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.skipped, "update-quarantined", JSON.stringify(r));
    assert.equal(db.settings.get("auto_update_last_result"),
      `Skipped: update quarantined (${bad.slice(0, 9)}, import-check); waiting for a newer commit on main`);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev, "the quarantined sha was never pulled");
    assert.ok(!existsSync(join(f.work, "b.txt")), "not a single file of it landed");
  } finally { cleanup(); }
});

test("the marker clears when main moves past it", async () => {
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check" });
    const fix = pushToOrigin(f, "c.txt", "three\n");
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.updated, true, JSON.stringify(r));
    assert.equal(g(f.work, "rev-parse", "HEAD"), fix, "a commit past the bad one is taken normally");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "the spent record is removed");
  } finally { cleanup(); }
});

test("a transient reason expires after its 6 h TTL", async () => {
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    // Written 7 h ago: a timeout rollback must not pause updates indefinitely.
    writeUpdateQuarantine({
      gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-timeout",
      now: Date.now() - 7 * 60 * 60 * 1000,
    });
    assert.ok(readUpdateQuarantine({ gitDir: f.gitDir }), "the record is still there (readers decide)");
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.updated, true, `an expired quarantine must not block: ${JSON.stringify(r)}`);
    assert.equal(g(f.work, "rev-parse", "HEAD"), bad);
  } finally { cleanup(); }
});

test("an init-db-failed marker also expires, an import-check one does not", () => {
  const f = fixture();
  try {
    const sha = f.prev;
    const old = Date.now() - 7 * 60 * 60 * 1000;
    writeUpdateQuarantine({ gitDir: f.gitDir, sha, reason: "init-db-failed", now: old });
    assert.equal(evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: sha }).blocked, false);
    assert.ok(!existsSync(quarantinePath(f.gitDir)), "the expired record is cleaned up");

    // A sha whose CODE does not load gets no deadline: it waits for main.
    writeUpdateQuarantine({ gitDir: f.gitDir, sha, reason: "import-check", now: old });
    const m = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(m.expires_at, undefined, "a clean import failure has no TTL");
    assert.equal(evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: sha }).blocked, true);
  } finally { f.cleanup(); }
});

test("a short sha is never a match", async () => {
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    // A prefix would also name other commits; the writer refuses it, and the
    // reader ignores one planted by hand.
    assert.equal(writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad.slice(0, 9), reason: "import-check" }), null);
    writeFileSync(quarantinePath(f.gitDir), JSON.stringify({
      v: 1, sha: bad.slice(0, 9), previous: f.prev, reason: "import-check", at: new Date().toISOString(), by: "test",
    }));
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "a non-full sha is not a marker");
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();
    assert.equal(r.updated, true, `a short prefix must never block an update: ${JSON.stringify(r)}`);
  } finally { cleanup(); }
});

test("a malformed marker file is ignored, not obeyed", () => {
  const f = fixture();
  try {
    writeFileSync(quarantinePath(f.gitDir), "{not json");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null);
    assert.equal(evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: f.prev }).blocked, false);
  } finally { f.cleanup(); }
});

test("Check-now goes through the same under-lock path", () => {
  // The Settings button must consult the marker too; it does only because it
  // calls checkForUpdates(), which lands in runLockedUpdate.
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway",
    "dashboard", "settings", "sections", "updates.js"), "utf8");
  assert.match(src, /check_updates_now[\s\S]*?checkForUpdates\(\)/);
  const au = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "auto-update.js"), "utf8");
  assert.match(au, /evaluateUpdateQuarantine\(\{ gitDir, originHeadSha \}\)/);
});