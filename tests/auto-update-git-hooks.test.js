/**
 * F1 — the updater must never run the PULLED commit's own hooks.
 *
 * A live install points `core.hooksPath` INTO the checkout (`scripts/hooks`), so
 * `git fetch` / `git pull` / `git merge` update refs and check out files with the
 * tree's hooks still armed: the incoming commit's `reference-transaction` and
 * `post-merge` hooks run as the updater's user BEFORE the import check, init-db
 * or the boot guard has seen the sha. Every git command the updater runs now
 * carries `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, through one
 * helper so no call site can forget them.
 *
 * The fixture is a real scratch repo whose hooks write sentinels, with a control
 * that proves the same sentinels DO fire when the flags are absent.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { checkForUpdates, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";

// A successful update arms the gateway's restart chain; never inside a test.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
// After core.hooksPath points into the tree, every test-side git call disables
// hooks too, or the test would create a sentinel it asserts is absent.
const gNoHooks = (cwd, ...args) => execFileSync(
  "git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, stdio: "pipe" },
).toString().trim();

const HOOKS = ["reference-transaction", "post-merge"];

const _fixtures = [];
after(() => {
  _setAppRootForTest(REAL_APP_ROOT);
  _setDbForTest(null);
  for (const f of _fixtures) { try { f.cleanup(); } catch {} }
});

const stubDb = () => ({ execute: async () => ({ rows: [] }) });

/**
 * A bare origin, a clone at P whose `core.hooksPath` is `scripts/hooks` INSIDE
 * the tree (the live install shape), and one commit B waiting on origin.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "au-hooks-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const out = join(root, "out");
  mkdirSync(out, { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");

  // Both hooks live in P, so they are on disk BEFORE any pull: a hook that only
  // arrives with the pulled commit could not fire on the merge that brings it.
  mkdirSync(join(work, "scripts", "hooks"), { recursive: true });
  for (const name of HOOKS) {
    const path = join(work, "scripts", "hooks", name);
    writeFileSync(path, `#!/bin/sh\n: > ${JSON.stringify(join(out, `${name}-ran`))}\n`);
    chmodSync(path, 0o755);
  }
  mkdirSync(join(work, "servers", "gateway"), { recursive: true });
  writeFileSync(join(work, "servers", "gateway", "index.js"), "process.exit(0);\n");
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "-A");
  g(work, "commit", "-m", "P");
  g(work, "push", "origin", "main");
  const prev = g(work, "rev-parse", "HEAD");

  // The pulled commit: one ordinary file, so nothing but the hooks can fail.
  const pusher = mkdtempSync(join(root, "pusher-"));
  execFileSync("git", ["clone", origin, pusher], { stdio: "pipe" });
  g(pusher, "config", "user.email", "t@t");
  g(pusher, "config", "user.name", "t");
  writeFileSync(join(pusher, "b.txt"), "two\n");
  g(pusher, "add", "b.txt");
  g(pusher, "commit", "-m", "B");
  g(pusher, "push", "origin", "main");
  const bad = g(pusher, "rev-parse", "HEAD");

  // Configured only now: the fixture's own commits above must not fire the hooks.
  g(work, "config", "core.hooksPath", "scripts/hooks");

  const f = {
    root, origin, work, out, prev, bad,
    sentinels: HOOKS.map((name) => join(out, `${name}-ran`)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  _fixtures.push(f);
  return f;
}

test("an update tick runs no hook of the pulled commit", async () => {
  const f = fixture();
  try {
    _setAppRootForTest(f.work);
    _setDbForTest(stubDb());

    const r = await checkForUpdates();
    assert.equal(r.updated, true, `the fixture update must really pull: ${JSON.stringify(r)}`);
    assert.equal(gNoHooks(f.work, "rev-parse", "HEAD"), f.bad, "the pull landed");
    for (const sentinel of f.sentinels) {
      assert.equal(existsSync(sentinel), false,
        `${sentinel} exists: the pulled commit's hook ran as the updater`);
    }
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
  }
});

test("control: the same pull DOES fire both hooks without the flags", () => {
  // Without this, "no sentinel" would pass even if the hooks were unreachable for
  // an unrelated reason (a wrong hooksPath, a missing exec bit).
  const f = fixture();
  execFileSync("git", ["pull", "--ff-only", "origin", "main"], { cwd: f.work, stdio: "pipe" });
  assert.equal(gNoHooks(f.work, "rev-parse", "HEAD"), f.bad);
  for (const sentinel of f.sentinels) {
    assert.ok(existsSync(sentinel), `${sentinel} must fire when hooks are enabled`);
  }
});

test("control: a bare fetch fires the reference-transaction hook", () => {
  // The fetch half of the tick alone runs the incoming commit's ref hook — it
  // lands before any of the updater's checks (that is the F1 finding).
  const f = fixture();
  execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: f.work, stdio: "pipe" });
  assert.ok(existsSync(f.sentinels[0]), "the ref update runs the tree's reference-transaction hook");
  assert.equal(existsSync(f.sentinels[1]), false, "no merge happened, so no post-merge");
});

test("every remaining git call site carries the hooks-off flags (F8 nit)", () => {
  // rev-parse runs no hooks today, but the rule is "EVERY call": a copy-paste
  // from one of these files must not reintroduce a bare `git rev-parse HEAD`.
  for (const file of ["scripts/guarded-init-db.mjs", "servers/gateway/index.js"]) {
    const lines = readFileSync(join(REAL_APP_ROOT, file), "utf8")
      .split("\n")
      .filter((line) => /"git", \[/.test(line));
    assert.ok(lines.length > 0, `${file}: expected a git call, found none — the assertion would be vacuous`);
    for (const line of lines) {
      assert.match(line, /GIT_SAFE/, `${file}: a git call without the hooks-off flags: ${line.trim()}`);
    }
  }
});