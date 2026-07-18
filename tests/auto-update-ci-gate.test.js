// A5: CI-gate on auto-update — classifyCheckRuns (pure) and the wired skip in
// runLockedUpdate (via the verdict test hook; fixture remotes are local paths,
// so the real fetch path naturally fails open as "unknown").

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

test("classifyCheckRuns: neutral/skipped conclusions count as green", () => {
  assert.equal(classifyCheckRuns({ check_runs: [
    run("suite", "completed", "success"),
    run("audit", "completed", "skipped"),
  ] }), "green");
});

test("classifyCheckRuns: no named runs (fork without our CI) is unknown", () => {
  assert.equal(classifyCheckRuns({ check_runs: [] }), "unknown");
  assert.equal(classifyCheckRuns({ check_runs: [run("other-ci", "completed", "failure")] }), "unknown");
  assert.equal(classifyCheckRuns(null), "unknown");
  assert.equal(classifyCheckRuns({}), "unknown");
});

// --------------------------------------------------------- wired behavior

const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function fixture() {
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

test("local (non-GitHub) remotes fail open without the test hook", async () => {
  const fx = fixture();
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(stubDb());
    const res = await runLockedUpdate(() => {});
    assert.equal(res.updated, true, "unknown verdict (local remote) proceeds");
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(join(import.meta.dirname, ".."));
    fx.cleanup();
  }
});
