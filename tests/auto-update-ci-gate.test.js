// A5: CI-gate on auto-update — classifyCheckRuns (pure) and the wired skip in
// runLockedUpdate (via the verdict test hook; fixture remotes are local paths,
// so the real fetch path answers "not-applicable" — no CI to ask).
// N1c-5 (the unreadable-answer half: unavailable, the 3-in-a-row bell and the
// not-applicable setting) lives in auto-update-ci-gate-unavailable.test.js.
//
// Review round 1: S3 — green now needs ALL THREE contexts, so a subset of them
// is "pending"; and S1 — the origin is parsed by parseGithubRemote, not a
// substring match on "github.com". The URL-form table lives here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyCheckRuns, runLockedUpdate,
  _setAppRootForTest, _setDbForTest, _setCiVerdictForTest,
} from "../servers/gateway/auto-update.js";
import { parseGithubRemote } from "../servers/shared/ci-check-runs.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const run = (name, status, conclusion) => ({ name, status, conclusion });

test("classifyCheckRuns: all three green (extra runs ignored)", () => {
  assert.equal(classifyCheckRuns({ check_runs: [
    run("suite", "completed", "success"),
    run("static-checks", "completed", "success"),
    run("audit", "completed", "success"),
    run("deploy-docs", "completed", "failure"), // never blocks
  ] }), "green");
});

test("classifyCheckRuns: any named failure is red", () => {
  // Red wins over a missing context too: a reported failure is decisive even
  // when another required check has not reported yet.
  assert.equal(classifyCheckRuns({ check_runs: [
    run("suite", "completed", "failure"),
    run("static-checks", "completed", "success"),
  ] }), "red");
  assert.equal(classifyCheckRuns({ check_runs: [run("audit", "completed", "cancelled")] }), "red");
});

test("classifyCheckRuns: incomplete named run is pending", () => {
  assert.equal(classifyCheckRuns({ check_runs: [
    run("suite", "in_progress", null),
    run("audit", "completed", "success"),
  ] }), "pending");
});

test("classifyCheckRuns: neutral/skipped conclusions count as green (all three present)", () => {
  assert.equal(classifyCheckRuns({ check_runs: [
    run("suite", "completed", "success"),
    run("static-checks", "completed", "neutral"),
    run("audit", "completed", "skipped"),
  ] }), "green");
});

test("classifyCheckRuns: green requires ALL THREE contexts (review S3)", () => {
  // Before review round 1 the classifier returned green when ANY subset of the
  // three was present and passing, so a sha where only `audit` had reported was
  // deployed before `suite` and `static-checks` ever ran. A missing context is
  // now "pending" (it has not reported yet) — never green.
  const all = {
    suite: run("suite", "completed", "success"),
    "static-checks": run("static-checks", "completed", "success"),
    audit: run("audit", "completed", "success"),
  };
  assert.equal(classifyCheckRuns({ check_runs: [all.audit] }), "pending", "audit alone was green before");
  assert.equal(classifyCheckRuns({ check_runs: [all.suite, all.audit] }), "pending");
  assert.equal(classifyCheckRuns({ check_runs: [all.suite, all["static-checks"]] }), "pending");
  assert.equal(classifyCheckRuns({ check_runs: [all.suite, all["static-checks"], all.audit] }), "green");
  // All three present but one unfinished is still pending, as before.
  assert.equal(classifyCheckRuns({ check_runs: [
    all.suite, all["static-checks"], run("audit", "in_progress", null),
  ] }), "pending");
});

test("parseGithubRemote: every real GitHub remote form is GitHub (review S1)", () => {
  const forms = [
    "https://github.com/acme/crow",
    "https://github.com/acme/crow.git",
    "http://github.com/acme/crow.git",
    "https://github.com/acme/crow/",                    // trailing slash
    "https://github.com/acme/crow.git/",                // .git + slash
    "https://GitHub.com/acme/crow",                     // uppercase host
    "https://WWW.GitHub.com/acme/crow.git",
    "git@github.com:acme/crow.git",                     // scp-like
    "ssh://git@github.com/acme/crow.git",               // ssh scheme
    "ssh://git@ssh.github.com:443/acme/crow.git",       // SSH over 443 (was not-applicable: a fail-open deploy)
  ];
  for (const url of forms) assert.deepEqual(parseGithubRemote(url), { owner: "acme", repo: "crow" }, url);
});

test("parseGithubRemote: another host or a local path is NOT GitHub (review S1)", () => {
  const forms = [
    "https://github.com.evil.tld/acme/crow.git",
    "https://evilgithub.com/acme/crow.git",
    "git@github.com.evil.tld:acme/crow.git",
    // The old fixture put a bare repo at exactly this path and the substring
    // regex read it as GitHub; it is a local path, so the gate has no API.
    "/tmp/au-cigate-1234/github.com/acme/crow.git",
    "./github.com/acme/crow.git",
    "file:///srv/github.com/acme/crow.git",
    "/srv/git/crow.git",
    "git@example.com:acme/crow.git",
    "github.com/acme/crow.git",                          // no scheme, no colon
    "",
    null,
    undefined,
  ];
  for (const url of forms) assert.equal(parseGithubRemote(url), null, String(url));
});

test("classifyCheckRuns: no named runs (fork without our CI) is unknown", () => {
  assert.equal(classifyCheckRuns({ check_runs: [] }), "unknown");
  assert.equal(classifyCheckRuns({ check_runs: [run("other-ci", "completed", "failure")] }), "unknown");
  assert.equal(classifyCheckRuns(null), "unknown");
  assert.equal(classifyCheckRuns({}), "unknown");
});

// --------------------------------------------------------- wired behavior

const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function fixture({ behind = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "au-cigate-"));
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
  if (!behind) return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  // A new commit on origin (via a second clone) so the update has work to do.
  const pusher = mkdtempSync(join(root, "pusher-"));
  execFileSync("git", ["clone", origin, pusher], { stdio: "pipe" });
  g(pusher, "config", "user.email", "t@t");
  g(pusher, "config", "user.name", "t");
  writeFileSync(join(pusher, "b.txt"), "two\n");
  g(pusher, "add", "b.txt");
  g(pusher, "commit", "-m", "c2");
  g(pusher, "push", "origin", "main");
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const stubDb = () => ({ execute: async () => ({ rows: [] }) });

test("ci-red verdict skips the pull; HEAD unchanged; self-heals when green", async () => {
  const fx = fixture();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const before = g(fx.work, "rev-parse", "HEAD");

    _setCiVerdictForTest("red");
    const red = await runLockedUpdate(() => {});
    assert.equal(red.updated, false);
    assert.equal(red.skipped, "ci-red");
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before, "red CI must not pull");

    _setCiVerdictForTest("pending");
    const pending = await runLockedUpdate(() => {});
    assert.equal(pending.skipped, "ci-pending");
    assert.equal(g(fx.work, "rev-parse", "HEAD"), before, "pending CI must not pull");

    _setCiVerdictForTest("green");
    const ok = await runLockedUpdate(() => {});
    assert.equal(ok.updated, true, "green CI proceeds");
    assert.notEqual(g(fx.work, "rev-parse", "HEAD"), before);
  } finally {
    _setCiVerdictForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(join(import.meta.dirname, ".."));
    fx.cleanup();
  }
});

test("CROW_UPDATE_CI_GATE=0 disables the gate even on red", async () => {
  const fx = fixture();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    _setCiVerdictForTest("red");
    process.env.CROW_UPDATE_CI_GATE = "0";
    const res = await runLockedUpdate(() => {});
    assert.equal(res.updated, true, "gate disabled → red is ignored");
  } finally {
    delete process.env.CROW_UPDATE_CI_GATE;
    _setCiVerdictForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(join(import.meta.dirname, ".."));
    fx.cleanup();
  }
});

test("local (non-GitHub) remotes are not CI-gated: the update proceeds without the test hook", async () => {
  const fx = fixture();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const res = await runLockedUpdate(() => {});
    assert.equal(res.updated, true, "not-applicable verdict (local remote) proceeds");
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(join(import.meta.dirname, ".."));
    fx.cleanup();
  }
});

test("placement: an up-to-date repo short-circuits BEFORE the CI gate (red verdict never consulted)", async () => {
  const fx = fixture({ behind: false });
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    _setCiVerdictForTest("red");
    const res = await runLockedUpdate(() => {});
    assert.equal(res.updated, false);
    assert.equal(res.skipped, undefined, "behind=0 must return plain up-to-date, not a CI skip");
  } finally {
    _setCiVerdictForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(join(import.meta.dirname, ".."));
    fx.cleanup();
  }
});
