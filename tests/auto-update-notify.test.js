/**
 * N1c-2 — auto-update failures ring the in-app bell.
 *
 * ntfy/email are unconfigured by default, so an updater that stopped only ever
 * told the operator through the Settings → Updates card. Every result write
 * funnels through saveSetting(), so these tests drive the real path
 * (checkForUpdates → runLockedUpdate → saveSetting) exactly as
 * auto-update-result-since.test.js does: a local fixture repo and the module's
 * own `_setAppRootForTest` / `_setDbForTest` seams.
 *
 * Contract under test: one bell per classification CODE, no repeat within 24 h,
 * and never for ok / transient / skip-by-design results.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkForUpdates, _setAppRootForTest, _setDbForTest, _setCiVerdictForTest,
  UPDATE_NOTIFIED_CODE_KEY, UPDATE_NOTIFIED_AT_KEY, UPDATE_NOTIFY_COOLDOWN_MS,
} from "../servers/gateway/auto-update.js";

// A successful update arms the gateway's restart chain; never inside a test.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/**
 * dashboard_settings behind a Map plus the notifications table's INSERT, so a
 * test can count bells and read the cooldown keys. Mirrors the stub in
 * auto-update-result-since.test.js and adds what createNotification needs.
 */
function stubDb(initial = {}) {
  const settings = new Map(Object.entries(initial));
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
          priority: args[4], action_url: args[5], metadata: args[6], is_dismissed: 0,
        });
        return { rows: [], lastInsertRowid: notifications.length };
      }
      if (/UPDATE notifications SET is_dismissed = 1/.test(sql || "") && /WHERE source = \?/.test(sql || "")) {
        const mine = notifications.filter((n) => n.source === args[0] && !n.is_dismissed);
        for (const n of mine) n.is_dismissed = 1;
        return { rows: [], rowsAffected: mine.length };
      }
      return { rows: [] };
    },
  };
}

/** A local repo with no origin: the branch guard decides, no fetch needed. */
function branchFixture() {
  const root = mkdtempSync(join(tmpdir(), "n1c2-au-"));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-b", "main", work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "a.txt");
  g(work, "commit", "-m", "c1");
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A bare origin + a clone, so the CI gate decides with one commit behind. */
function originFixture() {
  const root = mkdtempSync(join(tmpdir(), "n1c2-au-ci-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  mkdirSync(join(work, "scripts"), { recursive: true });
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  g(work, "add", "a.txt", "scripts/init-db.js");
  g(work, "commit", "-m", "c1");
  g(work, "push", "origin", "main");
  return { root, origin, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function pushFile(fx, name, content) {
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

/** Several files in one commit: a pulled sha whose gateway throws at import. */
function pushFiles(fx, files) {
  const pusher = mkdtempSync(join(fx.root, "pusher-"));
  execFileSync("git", ["clone", fx.origin, pusher], { stdio: "pipe" });
  g(pusher, "config", "user.email", "t@t");
  g(pusher, "config", "user.name", "t");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(pusher, name, ".."), { recursive: true });
    writeFileSync(join(pusher, name), content);
  }
  g(pusher, "add", "-A");
  g(pusher, "commit", "-m", "pulled sha");
  g(pusher, "push", "origin", "main");
  return g(pusher, "rev-parse", "HEAD");
}

function pushCommit(fx) {
  pushFile(fx, "b.txt", "two\n");
}

test("a failure result rings once: system, high, auto-update, Updates card link", async () => {
  const fx = branchFixture();
  const db = stubDb();
  try {
    g(fx.work, "checkout", "-b", "feature/x");
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    const r = await checkForUpdates();
    assert.equal(r.skipped, "not-on-main");
    assert.equal(db.notifications.length, 1, `one bell, saw ${JSON.stringify(db.notifications)}`);
    const n = db.notifications[0];
    assert.equal(n.type, "system");
    assert.equal(n.priority, "high");
    assert.equal(n.source, "auto-update");
    assert.equal(n.action_url, "/dashboard/settings?section=updates");
    assert.match(n.title, /not on the main branch/);
    assert.match(n.body, /Skipped: not on main \(on 'feature\/x'\)/, "the recorded result is reused verbatim (safe codes only)");
    assert.match(n.body, /Switch it back to main/, "the body names the action");
    assert.equal(JSON.parse(n.metadata).code, "not-on-main");
    assert.equal(db.settings.get(UPDATE_NOTIFIED_CODE_KEY), "not-on-main");
    assert.ok(Number.isFinite(Date.parse(db.settings.get(UPDATE_NOTIFIED_AT_KEY))));
    // The text must not carry command output (paths/secrets live there).
    assert.ok(!/fatal:|error:|\.git|stdout|stderr/i.test(`${n.title} ${n.body}`));
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("a failure that returns after a recovery rings again", async () => {
  // The cooldown is for a STANDING condition, not for the failure itself: once a
  // healthy result cleared the bell, the same failure coming back is a new event and
  // has to ring (review N5-4) — otherwise the operator hears nothing for 24 h.
  const fx = originFixture();
  const db = stubDb();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);

    // The failure rings and stamps the cooldown.
    g(fx.work, "checkout", "-b", "feature/x");
    const first = await checkForUpdates();
    assert.equal(first.skipped, "not-on-main", JSON.stringify(first));
    assert.equal(db.notifications.length, 1);
    assert.equal(db.settings.get(UPDATE_NOTIFIED_CODE_KEY), "not-on-main", "the cooldown is stamped");

    // The updater recovers: an ok result dismisses the bell AND forgets the cooldown.
    g(fx.work, "checkout", "main");
    const recovered = await checkForUpdates();
    assert.equal(recovered.updated, false, JSON.stringify(recovered));
    assert.equal(db.settings.get("auto_update_last_result"), "Up to date");
    assert.equal(db.notifications[0].is_dismissed, 1, "the stopped-updates bell is gone");
    assert.equal(db.settings.get(UPDATE_NOTIFIED_CODE_KEY), "", "the cooldown code is reset");
    assert.equal(db.settings.get(UPDATE_NOTIFIED_AT_KEY), "", "and so is its clock");

    // The very same failure returns minutes later: it rings again.
    g(fx.work, "checkout", "feature/x");
    const again = await checkForUpdates();
    assert.equal(again.skipped, "not-on-main", JSON.stringify(again));
    assert.equal(db.notifications.length, 2, "the same failure rings again after a recovery");
    assert.equal(db.notifications[1].is_dismissed, 0, "and the new bell is open");
    assert.equal(JSON.parse(db.notifications[1].metadata).code, "not-on-main");
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("the same code again within 24 h rings nothing; a different code does; past the window it rings again", async () => {
  const fx = branchFixture();
  const db = stubDb();
  try {
    g(fx.work, "checkout", "-b", "feature/x");
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    await checkForUpdates();
    assert.equal(db.notifications.length, 1);

    // Same code, another branch, minutes later.
    g(fx.work, "checkout", "-b", "feature/y");
    const repeat = await checkForUpdates();
    assert.equal(repeat.skipped, "not-on-main");
    assert.equal(db.notifications.length, 1, "no second bell inside the cooldown");

    // A different code (git cannot read a branch at all) rings.
    _setAppRootForTest(join(fx.root, "not-a-checkout"));
    await checkForUpdates();
    assert.equal(db.notifications.length, 2, "a different failure code rings");
    assert.equal(JSON.parse(db.notifications[1].metadata).code, "branch-unknown");
    assert.equal(db.settings.get(UPDATE_NOTIFIED_CODE_KEY), "branch-unknown");

    // The window is a window, not a one-shot: the same code after 24 h rings.
    db.settings.set(UPDATE_NOTIFIED_CODE_KEY, "not-on-main");
    db.settings.set(UPDATE_NOTIFIED_AT_KEY, new Date(Date.now() - UPDATE_NOTIFY_COOLDOWN_MS - 60_000).toISOString());
    _setAppRootForTest(fx.work);
    await checkForUpdates();
    assert.equal(db.notifications.length, 3, "past the cooldown the same code rings again");
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("a transient result (CI still running) and an ok result (up to date) ring nothing", async () => {
  const fx = originFixture();
  const db = stubDb();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);

    // ok: nothing to pull.
    const upToDate = await checkForUpdates();
    assert.equal(upToDate.updated, false);
    assert.equal(db.settings.get("auto_update_last_result"), "Up to date");
    assert.equal(db.notifications.length, 0, "an ok result never rings");

    // transient: CI is still running on the one commit behind us.
    pushCommit(fx);
    _setCiVerdictForTest("pending");
    const pending = await checkForUpdates();
    assert.equal(pending.skipped, "ci-pending");
    assert.match(db.settings.get("auto_update_last_result"), /^Skipped: CI still running/);
    assert.equal(db.notifications.length, 0, "a transient result never rings");
    assert.equal(db.settings.has(UPDATE_NOTIFIED_CODE_KEY), false, "and no cooldown is stamped");
  } finally {
    _setCiVerdictForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("a stderr-carrying failure rings with the cause and action but no command output", async () => {
  const fx = originFixture();
  const db = stubDb();
  try {
    pushFile(fx, "a.txt", "two\n"); // origin moves a file we also edited
    writeFileSync(join(fx.work, "a.txt"), "local-dirty\n");
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    const r = await checkForUpdates();
    assert.ok(r.error && /Pull failed/.test(r.error), JSON.stringify(r));
    assert.equal(db.notifications.length, 1);
    const n = db.notifications[0];
    assert.match(n.title, /pull failed/i);
    assert.equal(JSON.parse(n.metadata).code, "pull-failed");
    assert.match(n.body, /local changes overlap it/);
    // The raw result embeds `git pull` stderr — it must never reach the bell.
    assert.ok(!/a\.txt|error:|fatal:|local-dirty/i.test(`${n.title} ${n.body}`), `${n.title} | ${n.body}`);
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("a rolled-back update and a quarantined commit each ring once, quoting our own sentence", async () => {
  // N1c-3 Layer 0: the settings write is the only bell for these, so each new
  // code needs an UPDATE_FAILURE_TEXT row AND a RESULT_TEXT_IS_SAFE entry —
  // the recorded text is quoted into the body only for codes whose sentence is
  // ours (no git/npm stderr).
  const fx = originFixture();
  const db = stubDb();
  try {
    const bad = pushFiles(fx, {
      "servers/gateway/index.js": `import "./boom.js";
if (process.env.CROW_GATEWAY_IMPORT_CHECK === "1") { process.stdout.write("crow-gateway-import-ok\\n"); process.exit(0); }
`,
      "servers/gateway/boom.js": "throw new Error('the gateway graph does not load');\n",
    });
    _setAppRootForTest(fx.work);
    _setDbForTest(db);

    const rolled = await checkForUpdates();
    assert.equal(rolled.rolledBack, true, JSON.stringify(rolled));
    assert.equal(db.notifications.length, 1, `one bell, saw ${JSON.stringify(db.notifications)}`);
    const n = db.notifications[0];
    assert.equal(JSON.parse(n.metadata).code, "update-rolled-back");
    assert.equal(n.source, "auto-update");
    assert.match(n.title, /rolled back an update that would not start/i);
    assert.match(n.body, new RegExp(`Rolled back: ${bad.slice(0, 9)} fails to load \\(import-check\\)`),
      "the recorded result is quoted verbatim: it is our own fixed sentence plus shas");

    // Next tick: the same commit is still the head of main, so updates are
    // skipped — a DIFFERENT code, so it rings too.
    const quarantined = await checkForUpdates();
    assert.equal(quarantined.skipped, "update-quarantined");
    assert.equal(db.notifications.length, 2);
    const q = db.notifications[1];
    assert.equal(JSON.parse(q.metadata).code, "update-quarantined");
    assert.match(q.title, /quarantined/i);
    assert.match(q.body, /^Skipped: update quarantined \(/, "our own sentence, never command output");
    assert.ok(!/boom|Error:|fatal:/i.test(`${q.title} ${q.body}`));
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});