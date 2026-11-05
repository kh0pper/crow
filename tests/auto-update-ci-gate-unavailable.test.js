// N1c-5: the auto-update CI gate must not fail open when GitHub cannot be asked.
//
// resolveCiVerdict used to answer "unknown" for BOTH "there is no CI to ask"
// (a non-GitHub origin) and "GitHub did not answer" (network error, timeout,
// 403/429, non-200, bad JSON), and the caller deployed on anything it did not
// recognise. During a GitHub outage that shipped an unverified sha.
//
// The tests below pin the split: not-applicable proceeds (a self-hosted origin
// must keep updating), unavailable skips like pending, and three consecutive
// unavailable ticks become a failure so the bell rings once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runLockedUpdate, checkForUpdates, classifyUpdateResult,
  _setAppRootForTest, _setDbForTest, _setCiVerdictForTest, _setCiFetchForTest, _setCiRemoteUrlForTest,
  _resolveCiVerdictForTest, CI_UNAVAILABLE_COUNT_KEY, CI_GATE_SETTING_KEY,
} from "../servers/gateway/auto-update.js";

// A successful update arms the gateway's restart chain; never inside a test.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const SHA = "1a2b3c4d5e6f7890a1b2c3d4e5f60718293a4b5c";
const GH_URL = "https://github.com/acme/crow.git";
const GREEN = { check_runs: [
  { name: "suite", status: "completed", conclusion: "success" },
  { name: "static-checks", status: "completed", conclusion: "success" },
  { name: "audit", status: "completed", conclusion: "success" },
] };

/** dashboard_settings behind a Map, plus the notifications INSERT, so a test can
 *  read the gate's bookkeeping and count bells. */
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
      if (/SELECT key, value FROM dashboard_settings WHERE key LIKE 'auto_update_%'/.test(sql || "")) {
        return { rows: [...settings].filter(([k]) => k.startsWith("auto_update_"))
          .map(([key, value]) => ({ key, value })) };
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

/**
 * A bare origin plus a clone one commit behind.
 *
 * The origin is always a LOCAL bare repo, because git has to be able to fetch
 * from it. The GitHub case is driven through `_setCiRemoteUrlForTest` (review
 * round 1, S1): the old fixture put the bare repo at <root>/github.com/acme/
 * crow.git and relied on a substring match on "github.com", which is exactly the
 * fail-open the shared parser now refuses — a local path is not GitHub.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "au-cigap-"));
  const origin = join(root, "origin.git");
  mkdirSync(join(origin, ".."), { recursive: true });
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
  // A new commit on origin (via a second clone) so the update has work to do.
  const pusher = join(root, "pusher");
  execFileSync("git", ["clone", origin, pusher], { stdio: "pipe" });
  g(pusher, "config", "user.email", "t@t");
  g(pusher, "config", "user.name", "t");
  writeFileSync(join(pusher, "b.txt"), "two\n");
  g(pusher, "add", "b.txt");
  g(pusher, "commit", "-m", "c2");
  g(pusher, "push", "origin", "main");
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Every way GitHub can fail to answer, as a fetch the resolver can call. */
const FAILURES = [
  ["503", () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })],
  ["403 rate limit", () => Promise.resolve({ ok: false, status: 403, json: async () => ({ message: "rate limit exceeded" }) })],
  ["429 rate limit", () => Promise.resolve({ ok: false, status: 429, json: async () => ({}) })],
  ["timeout", () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))],
  ["network error", () => Promise.reject(new TypeError("fetch failed"))],
  ["bad JSON", () => Promise.resolve({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } })],
];

test("resolveCiVerdict: every failure to read GitHub is 'unavailable', never 'unknown'", async () => {
  try {
    for (const [name, impl] of FAILURES) {
      _setCiFetchForTest(impl);
      assert.equal(await _resolveCiVerdictForTest(GH_URL, SHA), "unavailable", name);
    }
    // A GitHub-shaped origin that answers is still classified by check-runs …
    let seenUrl = null;
    _setCiFetchForTest((url) => { seenUrl = url; return Promise.resolve({ ok: true, status: 200, json: async () => GREEN }); });
    assert.equal(await _resolveCiVerdictForTest(GH_URL, SHA), "green");
    // Review S3: ask for a full page — the default 30 silently truncated a
    // commit with more runs, and a now-required context could then never arrive.
    assert.equal(
      seenUrl,
      `https://api.github.com/repos/acme/crow/commits/${SHA}/check-runs?per_page=100`,
    );
    // … and a payload with no run for our three contexts is unverifiable, which
    // is "no-ci" (review S2: its own verdict, never the old deploy-on-unknown
    // and no longer "CI still running").
    _setCiFetchForTest(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ check_runs: [] }) }));
    assert.equal(await _resolveCiVerdictForTest(GH_URL, SHA), "no-ci");
    // A payload where only SOME of the three reported is never green (S3). With
    // everything present finished, review round 2 makes it no-ci: `suite` and
    // `static-checks` will never report on this origin, so waiting is forever.
    _setCiFetchForTest(() => Promise.resolve({ ok: true, status: 200, json: async () => ({
      check_runs: [{ name: "audit", status: "completed", conclusion: "success" }],
    }) }));
    assert.equal(await _resolveCiVerdictForTest(GH_URL, SHA), "no-ci");
    // …but a present run that is still going keeps it pending: the next tick may
    // really see it finish, so that shape must keep waiting.
    _setCiFetchForTest(() => Promise.resolve({ ok: true, status: 200, json: async () => ({
      check_runs: [
        { name: "audit", status: "in_progress", conclusion: null },
        { name: "suite", status: "completed", conclusion: "success" },
      ],
    }) }));
    assert.equal(await _resolveCiVerdictForTest(GH_URL, SHA), "pending");
    // The documented SSH-over-443 form is GitHub too — it used to read as
    // "not-applicable" and deploy without the gate (S1). The fetch seam
    // receives the OWNER/REPO parsed from it.
    let sshUrl = null;
    _setCiFetchForTest((url) => { sshUrl = url; return Promise.resolve({ ok: true, status: 200, json: async () => GREEN }); });
    assert.equal(await _resolveCiVerdictForTest("ssh://git@ssh.github.com:443/acme/crow.git", SHA), "green");
    assert.match(sshUrl, /^https:\/\/api\.github\.com\/repos\/acme\/crow\/commits\//);
  } finally {
    _setCiFetchForTest(null);
  }

  // No CI to ask for is a different answer: the gate can never apply there.
  assert.equal(await _resolveCiVerdictForTest("/srv/git/crow.git", SHA), "not-applicable");
  assert.equal(await _resolveCiVerdictForTest("git@example.com:acme/crow.git", SHA), "not-applicable");
  // A local path containing github.com/o/r is a local path, not GitHub (S1).
  assert.equal(await _resolveCiVerdictForTest("/tmp/github.com/acme/crow.git", SHA), "not-applicable");
  assert.equal(await _resolveCiVerdictForTest("https://github.com.evil.tld/acme/crow.git", SHA), "not-applicable");
  assert.equal(await _resolveCiVerdictForTest("", SHA), "not-applicable");
});

test("unavailable does not pull; three in a row turn into a failure and exactly one bell", async () => {
  const fx = fixture();
  const db = stubDb();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    // The REAL resolver, a GitHub origin (the seam), and a GitHub that is down.
    _setCiRemoteUrlForTest(GH_URL);
    _setCiFetchForTest(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
    const before = g(fx.work, "rev-parse", "HEAD");
    const lastResult = () => db.settings.get("auto_update_last_result");

    const first = await runLockedUpdate(() => {});
    assert.equal(first.updated, false);
    assert.equal(first.skipped, "ci-unavailable");
    assert.match(first.message, /^Skipped: CI status could not be read for origin\/main \([0-9a-f]{9}\)/);
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before, "an unreadable CI answer must not pull");
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "1");
    assert.equal(db.settings.get(CI_GATE_SETTING_KEY), "unavailable");
    assert.deepEqual(classifyUpdateResult(lastResult()), { kind: "transient", code: "ci-unavailable" });
    assert.equal(db.notifications.length, 0, "one outage tick stays quiet");

    const second = await runLockedUpdate(() => {});
    assert.equal(second.ciUnavailableCount, 2);
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before);
    assert.deepEqual(classifyUpdateResult(lastResult()), { kind: "transient", code: "ci-unavailable" });
    assert.equal(db.notifications.length, 0, "two outage ticks stay quiet");

    const third = await runLockedUpdate(() => {});
    assert.equal(third.ciUnavailableCount, 3);
    assert.match(third.message, /^Skipped: CI status unreadable for 3 checks in a row — updates are paused until GitHub answers \(or set CROW_UPDATE_CI_GATE=0\)$/);
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before, "still no pull");
    assert.deepEqual(classifyUpdateResult(lastResult()), { kind: "failure", code: "ci-gate-unavailable" });
    assert.equal(db.notifications.length, 1, `exactly one bell, saw ${JSON.stringify(db.notifications)}`);
    assert.equal(JSON.parse(db.notifications[0].metadata).code, "ci-gate-unavailable");
    assert.match(db.notifications[0].body, /Skipped: CI status unreadable for 3 checks in a row/,
      "the recorded result is our own sentence, quoted verbatim");

    // The bell's 24 h per-code cooldown keeps a long outage to one ring.
    const fourth = await runLockedUpdate(() => {});
    assert.equal(fourth.ciUnavailableCount, 4);
    assert.equal(db.notifications.length, 1, "the cooldown prevents spam");

    // GitHub answers again: the count resets and the same tick deploys.
    _setCiFetchForTest(() => Promise.resolve({ ok: true, status: 200, json: async () => GREEN }));
    const green = await runLockedUpdate(() => {});
    assert.equal(green.updated, true, JSON.stringify(green));
    assert.notEqual(g(fx.work, "rev-parse", "HEAD"), before, "a green answer pulls");
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "0", "any other verdict resets the count");
    assert.equal(db.settings.get(CI_GATE_SETTING_KEY), "green");
  } finally {
    _setCiFetchForTest(null);
    _setCiRemoteUrlForTest(null);
    _setCiVerdictForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("a GitHub origin with none of our checks is 'no-ci' (review S2): skipped, transient, no bell", async () => {
  const fx = fixture();
  const db = stubDb();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    // A real GitHub origin (the seam). Before review S2 an answer carrying no
    // run of ours was recorded as "CI still running", so the card warned "CI is
    // still running on main (for 12h)" for a fork forever.
    _setCiRemoteUrlForTest(GH_URL);
    // One unreadable tick first: no-ci must clear that streak (any verdict other
    // than "unavailable" resets the count).
    _setCiFetchForTest(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
    assert.equal((await runLockedUpdate(() => {})).skipped, "ci-unavailable");
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "1");

    _setCiFetchForTest(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ check_runs: [] }) }));
    const before = g(fx.work, "rev-parse", "HEAD");
    const res = await runLockedUpdate(() => {});
    assert.equal(res.updated, false, JSON.stringify(res));
    assert.equal(res.skipped, "no-ci");
    assert.equal(
      res.message,
      `Skipped: origin/main has none of the required CI checks (${g(fx.work, "rev-parse", "origin/main").slice(0, 9)}; a fork without this repo's CI?) — not deploying an unverified commit; set CROW_UPDATE_CI_GATE=0 to update without the gate`,
    );
    assert.equal(res.converge, undefined, "no converge:false — this refuses the NEXT commit, not the tree on disk");
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before, "an unverified sha must not pull");
    assert.equal(db.settings.get(CI_GATE_SETTING_KEY), "no-ci");
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "0", "no-ci resets the outage streak");
    assert.deepEqual(classifyUpdateResult(db.settings.get("auto_update_last_result")), { kind: "transient", code: "no-ci" });
    assert.equal(db.notifications.length, 0, "a transient no-ci never rings the bell");
  } finally {
    _setCiFetchForTest(null);
    _setCiRemoteUrlForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("a non-GitHub origin is 'not-applicable': it pulls, logs, and records the setting", async () => {
  const fx = fixture();
  const db = stubDb();
  const logs = [];
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    const before = g(fx.work, "rev-parse", "HEAD");

    // No fetch seam and no verdict hook: the real resolver must NOT ask GitHub.
    const res = await runLockedUpdate((m) => logs.push(m));
    assert.equal(res.updated, true, JSON.stringify(res));
    assert.notEqual(g(fx.work, "rev-parse", "HEAD"), before, "no CI to ask for must keep updating");
    assert.equal(db.settings.get(CI_GATE_SETTING_KEY), "not-applicable");
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "0");
    assert.ok(logs.includes("CI gate not applicable (origin is not GitHub)"),
      `expected the not-applicable log line, saw ${JSON.stringify(logs)}`);
    assert.equal(db.notifications.length, 0, "not-applicable is not a failure");
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("Check for updates now goes through the same gate: an unreadable answer skips it too", async () => {
  const fx = fixture();
  const db = stubDb();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    _setCiRemoteUrlForTest(GH_URL);
    _setCiVerdictForTest("unavailable");
    const before = g(fx.work, "rev-parse", "HEAD");

    // checkForUpdates is what the manual button calls.
    const res = await checkForUpdates();
    assert.equal(res.updated, false, JSON.stringify(res));
    assert.equal(res.skipped, "ci-unavailable");
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before, "the manual button cannot bypass the gate");
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "1");
  } finally {
    _setCiVerdictForTest(null);
    _setCiRemoteUrlForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("N1: an up-to-date checkout resets the outage streak and keeps not-applicable on a self-hosted origin", async () => {
  // Two unreadable ticks, then the operator pulls by hand: without the reset the
  // count stays at 2, so the NEXT single GitHub blip (days later) rings the
  // "updates are paused" bell.
  //
  // Review round 2: "Up to date" is what a self-hosted origin records on nearly
  // every tick, so the old unconditional `""` here hid the not-applicable info
  // line except between a pull and the next tick. The origin is re-read locally
  // (no GitHub request) and a non-GitHub origin keeps the reading.
  const fx = fixture();
  const db = stubDb({ [CI_UNAVAILABLE_COUNT_KEY]: "2" });
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    // Fast-forward the checkout onto origin/main so behindCount is 0.
    g(fx.work, "pull", "--ff-only", "origin", "main");
    const res = await runLockedUpdate(() => {});
    assert.equal(res.updated, false, JSON.stringify(res));
    assert.equal(res.skipped, undefined, "plain up-to-date, not a CI skip");
    assert.equal(db.settings.get("auto_update_last_result"), "Up to date");
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "0", "the streak must not survive an up-to-date tick");
    assert.equal(db.settings.get(CI_GATE_SETTING_KEY), "not-applicable",
      "a self-hosted origin keeps the not-applicable reading between checks");

    // …and the card keeps showing the line, which is the whole point of keeping
    // the key: the same db the tick just wrote.
    const { collectHealthSignals, invalidateHealthCache } = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
    const saved = process.env.CROW_AUTO_UPDATE;
    delete process.env.CROW_AUTO_UPDATE;
    try {
      invalidateHealthCache();
      const health = await collectHealthSignals(db, { now: () => Date.now(), lang: "en", uptimeMs: 60_000 });
      const card = health.details.find((d) => d.id === "updates");
      assert.equal(card.state, "ok", "an up-to-date tick is still an ok card");
      const line = health.issues.find((i) => i.id === "updates:ci-gate");
      assert.ok(line, `the not CI-gated info line survives the up-to-date tick: ${JSON.stringify(health.issues)}`);
      assert.equal(line.severity, "info");
    } finally {
      invalidateHealthCache();
      if (saved !== undefined) process.env.CROW_AUTO_UPDATE = saved;
    }
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("N1: an up-to-date tick on a GitHub origin clears a stale not-applicable reading, without asking GitHub", async () => {
  const fx = fixture();
  const db = stubDb({ [CI_UNAVAILABLE_COUNT_KEY]: "2", [CI_GATE_SETTING_KEY]: "not-applicable" });
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    // The fixture origin is a local bare repo; the seam makes the tick read it as
    // GitHub (an origin change, seen from the updater's point of view).
    _setCiRemoteUrlForTest(GH_URL);
    // No network call on an up-to-date tick: the verdict is never resolved, so
    // the fetch seam must not be reached.
    _setCiFetchForTest(() => { throw new Error("an up-to-date tick must not ask GitHub"); });
    g(fx.work, "pull", "--ff-only", "origin", "main");
    const res = await runLockedUpdate(() => {});
    assert.equal(res.updated, false, JSON.stringify(res));
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "0");
    assert.equal(db.settings.get(CI_GATE_SETTING_KEY), "", "a GitHub origin drops the stale not-applicable line");
  } finally {
    _setCiFetchForTest(null);
    _setCiRemoteUrlForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("N1: the gate-disabled path (CROW_UPDATE_CI_GATE=0) resets both keys too", async () => {
  const fx = fixture();
  const db = stubDb({ [CI_UNAVAILABLE_COUNT_KEY]: "2", [CI_GATE_SETTING_KEY]: "not-applicable" });
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    // A GitHub origin, but the gate is switched off: no verdict is consulted.
    _setCiRemoteUrlForTest(GH_URL);
    _setCiFetchForTest(() => { throw new Error("the disabled gate must not ask GitHub"); });
    process.env.CROW_UPDATE_CI_GATE = "0";
    const before = g(fx.work, "rev-parse", "HEAD");
    const res = await runLockedUpdate(() => {});
    assert.equal(res.updated, true, JSON.stringify(res));
    assert.notEqual(g(fx.work, "rev-parse", "HEAD"), before);
    assert.equal(db.settings.get(CI_UNAVAILABLE_COUNT_KEY), "0", "a streak from before the switch must not ring later");
    assert.equal(db.settings.get(CI_GATE_SETTING_KEY), "", "no stale not-applicable notice");
  } finally {
    delete process.env.CROW_UPDATE_CI_GATE;
    _setCiFetchForTest(null);
    _setCiRemoteUrlForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("the Updates card adds one info line when the origin is not GitHub (en + es)", async () => {
  const { collectHealthSignals, invalidateHealthCache } = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  const saved = process.env.CROW_AUTO_UPDATE;
  delete process.env.CROW_AUTO_UPDATE;
  const now = Date.now();
  const db = {
    async execute({ sql }) {
      if (String(sql).includes("auto_update_%")) {
        return { rows: [
          { key: "auto_update_enabled", value: "true" },
          { key: "auto_update_interval_hours", value: "6" },
          { key: "auto_update_last_check", value: new Date(now - 60_000).toISOString() },
          { key: "auto_update_last_result", value: "Updated c29e19c → 9d18049" },
          { key: "auto_update_current_version", value: "9d18049" },
          { key: "auto_update_latest_version", value: "9d18049" },
          { key: "auto_update_ci_gate", value: "not-applicable" },
        ] };
      }
      return { rows: [] };
    },
  };
  try {
    for (const lang of ["en", "es"]) {
      invalidateHealthCache();
      const result = await collectHealthSignals(db, { now: () => now, lang, uptimeMs: 60_000 });
      const card = result.details.find((d) => d.id === "updates");
      assert.equal(card.state, "ok", `${lang}: the card keeps its own reading`);
      const line = result.issues.find((i) => i.id === "updates:ci-gate");
      assert.ok(line, `${lang}: no CI-gate info line`);
      assert.equal(line.severity, "info", `${lang}: info, never a warn`);
      assert.equal(line.label, t("signals.updates.ciGateNotApplicable", lang));
    }
    assert.notEqual(t("signals.updates.ciGateNotApplicable", "es"), t("signals.updates.ciGateNotApplicable", "en"),
      "the Spanish line is translated");
  } finally {
    invalidateHealthCache();
    if (saved !== undefined) process.env.CROW_AUTO_UPDATE = saved;
  }
});