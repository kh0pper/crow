/**
 * L0.3 — the update quarantine marker (audit N1c-3).
 *
 * A commit this host already rolled back must never be pulled again, or the
 * updater re-rolls it on every tick. The record lives in the GIT DIR (shared by
 * co-hosted instances, untouched by `reset`/`clean`), names full 40-hex shas,
 * and clears itself when main moves past the bad commit.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
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
  const notifications = [];
  return {
    settings,
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

test("a blocked rollback says the bad commit is still checked out (S5)", async () => {
  // After a blocked rollback HEAD is still the bad sha, so the next tick used to
  // report "waiting for a newer commit" and the bell said the update "was rolled
  // back" — while the next restart or reboot boots exactly that commit.
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    g(f.work, "pull", "--ff-only", "origin", "main"); // the checkout HOLDS the bad sha
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check" });
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.skipped, "update-rollback-blocked", JSON.stringify(r));
    assert.equal(db.settings.get("auto_update_last_result"),
      `Update rollback blocked: ${bad.slice(0, 9)} is still checked out; the next restart will boot it`);
    assert.equal(db.notifications.length, 1, `one bell: ${JSON.stringify(db.notifications)}`);
    const n = db.notifications[0];
    assert.equal(JSON.parse(n.metadata).code, "update-rollback-blocked");
    assert.match(n.body, /still checked out/);
    assert.ok(!/was rolled back/.test(`${n.title} ${n.body}`),
      `the bell must not claim a rollback that never happened: ${n.title} | ${n.body}`);
  } finally { cleanup(); }
});

test("the marker reader refuses a symlink, a directory and an oversized file", () => {
  // The writer is atomic and never follows a planted file; the reader must be
  // just as strict, because PR 2's boot guard trusts the same record.
  const f = fixture();
  const path = quarantinePath(f.gitDir);
  const valid = JSON.stringify({
    v: 1, sha: f.prev, reason: "import-check", at: new Date().toISOString(), by: "test",
  });
  try {
    const real = join(f.root, "real-marker.json");
    writeFileSync(real, valid);
    symlinkSync(real, path);
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "a symlinked marker is never followed");

    rmSync(path, { force: true });
    mkdirSync(path);
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "a directory is not a marker");
    rmSync(path, { recursive: true, force: true });

    const huge = JSON.parse(valid);
    huge.pad = "x".repeat(70 * 1024);
    writeFileSync(path, JSON.stringify(huge));
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "above the 64 KiB cap nothing is read");

    writeFileSync(path, valid);
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }).sha, f.prev, "a plain, small, regular file still reads");
  } finally { f.cleanup(); }
});

test("Check-now goes through the same under-lock path", async () => {
  // The Settings button must consult the marker too. Drive the REAL handler
  // (settings.post "check_updates_now"), not a pattern match on its source: the
  // handler imports auto-update.js, so the same module instance and the same
  // _setAppRootForTest fixture apply.
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check" });
    _setAppRootForTest(f.work);
    _setDbForTest(db);
    const section = (await import(
      "../servers/gateway/dashboard/settings/sections/updates.js"
    )).default;
    let payload = null;
    const handled = await section.handleAction({
      req: { body: {} },
      res: { json: (o) => { payload = o; } },
      db: null,
      action: "check_updates_now",
    });

    assert.equal(handled, true, "the handler recognised the action");
    assert.equal(payload.skipped, "update-quarantined", JSON.stringify(payload));
    assert.match(payload.message, /^Skipped: update quarantined \(/);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev, "Check-now never pulls the quarantined sha");
    assert.ok(!existsSync(join(f.work, "b.txt")));
  } finally { cleanup(); }
});