/**
 * npm_required hard-fail + concurrent-install guard — C4 Task 3.
 *
 * At the generic npm-install site in runInstallJob, manifest.npm_required ===
 * true means the bundle is USELESS without a working install (bot-engine's pi
 * CLI, added in C4 Task 2) — any npm problem must hard-fail the install
 * (destDir removed, installed.json never gains the bundle), unlike every
 * other bundle's warn-only behavior. A pre-existing node_modules must never
 * be trusted as "already installed": an interrupted prior install can leave a
 * partial tree, so npm_required bundles always rm -rf node_modules and
 * reinstall clean, then verify manifest.verify_paths[] actually materialized.
 *
 * Seam: PATH-stubbed fake `npm` (pattern: tests/docker-point-of-use.test.js's
 * fake `docker` on PATH) — no real npm or network is ever touched. The fake
 * writes an args log so a test can assert `npm ci` vs `npm install` and the
 * flags, and can conditionally materialize the fixture's verify_paths file.
 *
 * All tests share ONE scratch CROW_HOME (set once at module load, matching
 * tests/bundles-install-job.test.js), so — following the per-test-unique-id
 * convention in tests/bundle-version-refresh.test.js — every test uses its
 * OWN bundle id. Without this, a successful install in one test would leave
 * behind an installed.json entry / destDir contents (package-lock.json,
 * node_modules) that silently corrupts a later test reusing the same id.
 *
 * The concurrent-install guard (POST /bundles/api/install returning 409
 * already_installing) is exercised over real HTTP against the actual
 * bundlesRouter(), following the tests/install-set-e2e.test.js pattern.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bundles.js resolves BUNDLES_DIR/INSTALLED_PATH from CROW_HOME at module
// load — point it at a scratch dir BEFORE importing (see
// tests/bundles-install-job.test.js's header comment for the live incident
// an unisolated run caused).
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

const {
  default: bundlesRouter,
  runInstallJob,
  _createJobForTest,
  _finishJobForTest,
  _setAppBundlesForTest,
} = await import("../servers/gateway/routes/bundles.js");

const VERIFY_REL = "node_modules/@fixture/pkg/dist/cli.js";

function freshRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Build a fresh fixture bundle source tree: npm_required + verify_paths, mirroring bot-engine's manifest shape (never depends on the real pi package). */
function buildFixture(id, { withLock = true } = {}) {
  const root = freshRoot("crow-fixture-npmreq-");
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id,
    name: "Fixture npm_required",
    type: "bundle",
    category: "ai",
    version: "1.0.0",
    description: "d",
    npm_required: true,
    requires: { min_ram_mb: 1, min_disk_mb: 1 },
    env_vars: [],
    verify_paths: [VERIFY_REL],
  }, null, 2));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: id,
    dependencies: { "@fixture/pkg": "1.0.0" },
  }, null, 2));
  if (withLock) {
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
      name: id, lockfileVersion: 3,
    }, null, 2));
  }
  return root;
}

function readManifest(fixtureRoot, id) {
  return JSON.parse(readFileSync(join(fixtureRoot, id, "manifest.json"), "utf8"));
}

function destDirFor(id) {
  return join(process.env.CROW_HOME, "bundles", id);
}

// ─── PATH-stubbed fake npm ───

const REAL_PATH = process.env.PATH;
const STUB_DIR = mkdtempSync(join(tmpdir(), "crow-npm-stub-"));
const STUB_BIN = join(STUB_DIR, "npm");

/**
 * Point PATH at a fake `npm` whose behavior is controlled by env vars the
 * spawned child reads at run time (one binary serves every scenario):
 *   NPM_STUB_EXIT        — exit code (0 unless set)
 *   NPM_STUB_STDERR       — stderr text to emit before exiting
 *   NPM_STUB_MATERIALIZE  — "1" → mkdir -p + write VERIFY_REL under cwd
 *   NPM_STUB_LOG          — file to append "$@" to, so a test can assert the
 *                           exact npm subcommand/flags used
 */
function stubNpm() {
  const dollar = "$";
  const body = [
    "#!/bin/sh",
    `if [ -n "${dollar}NPM_STUB_LOG" ]; then echo "${dollar}@" >> "${dollar}NPM_STUB_LOG"; fi`,
    `if [ -n "${dollar}NPM_STUB_STDERR" ]; then echo "${dollar}NPM_STUB_STDERR" 1>&2; fi`,
    `if [ "${dollar}NPM_STUB_MATERIALIZE" = "1" ]; then`,
    `  mkdir -p "${dollar}(dirname "${VERIFY_REL}")"`,
    `  echo "fixture cli" > "${VERIFY_REL}"`,
    "fi",
    `exit "${dollar}{NPM_STUB_EXIT:-0}"`,
  ].join("\n") + "\n";
  writeFileSync(STUB_BIN, body);
  chmodSync(STUB_BIN, 0o755);
  process.env.PATH = `${STUB_DIR}:${REAL_PATH}`;
}

function clearNpmStubEnv() {
  delete process.env.NPM_STUB_EXIT;
  delete process.env.NPM_STUB_STDERR;
  delete process.env.NPM_STUB_MATERIALIZE;
  delete process.env.NPM_STUB_LOG;
}

function restorePath() {
  process.env.PATH = REAL_PATH;
  clearNpmStubEnv();
}

// ─── npm exit 1 → hard fail ───

test("npm_required: npm exit 1 with stderr → hard fail, destDir removed, job log carries the npm error, installed.json untouched", async () => {
  const id = "fx-npmreq-failexit";
  const fixtureRoot = buildFixture(id);
  _setAppBundlesForTest(fixtureRoot);
  const job = _createJobForTest(id, "install");
  try {
    stubNpm();
    process.env.NPM_STUB_EXIT = "1";
    process.env.NPM_STUB_STDERR = "npm ERR! fixture install failure";

    const out = await runInstallJob(id, {}, {
      job, installedSnapshot: [], consentVerified: false,
      manifest: readManifest(fixtureRoot, id),
    });

    assert.equal(out.ok, false, "npm exit !=0 must hard-fail an npm_required install");
    assert.match(out.reason, /npm install failed/i);
    assert.match(out.reason, /fixture install failure/);
    assert.ok(
      job.log.some((l) => l.includes("fixture install failure")),
      "job log must carry the npm stderr",
    );

    assert.equal(existsSync(destDirFor(id)), false, "destDir must be removed on hard fail (clean re-install on retry)");

    const installedPath = join(process.env.CROW_HOME, "installed.json");
    const installedRaw = existsSync(installedPath) ? readFileSync(installedPath, "utf8") : "[]";
    assert.ok(!installedRaw.includes(id), "installed.json must never gain a bundle whose npm_required install failed");
  } finally {
    _finishJobForTest(job, "failed");
    restorePath();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ─── npm exit 0 but verify_paths missing → hard fail ───

test("npm_required: npm exits 0 but verify_paths is NOT materialized → hard fail, destDir removed", async () => {
  const id = "fx-npmreq-noverify";
  const fixtureRoot = buildFixture(id);
  _setAppBundlesForTest(fixtureRoot);
  const job = _createJobForTest(id, "install");
  try {
    stubNpm();
    process.env.NPM_STUB_EXIT = "0";
    // Deliberately do NOT set NPM_STUB_MATERIALIZE — npm "succeeds" (as a
    // truncated/partial install genuinely can) without the promised artifact.

    const out = await runInstallJob(id, {}, {
      job, installedSnapshot: [], consentVerified: false,
      manifest: readManifest(fixtureRoot, id),
    });

    assert.equal(out.ok, false, "a clean npm exit that doesn't produce verify_paths must still hard-fail");
    assert.match(out.reason, /verify_paths|verif/i);
    assert.ok(
      job.log.some((l) => /verif/i.test(l)),
      "job log must record the verify_paths failure",
    );
    assert.equal(existsSync(destDirFor(id)), false, "destDir must be removed when verify_paths fails to materialize");
  } finally {
    _finishJobForTest(job, "failed");
    restorePath();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ─── interrupted-install retry: clean-slate rm before reinstall ───

test("npm_required: interrupted-install retry — a pre-existing partial node_modules is wiped before reinstall, and the retry lands green", async () => {
  const id = "fx-npmreq-retry";
  const fixtureRoot = buildFixture(id);
  _setAppBundlesForTest(fixtureRoot);
  const job = _createJobForTest(id, "install");
  const logDir = freshRoot("crow-npmlog-");
  try {
    // Simulate a prior interrupted install: destDir already has a partial
    // node_modules tree. cpSync(sourceDir, destDir) in runInstallJob is
    // additive, so this stray content survives the file-copy step exactly
    // like a real interrupted install would — the absence-only check this
    // task replaces would bless it as "already installed" and skip npm.
    const destDir = destDirFor(id);
    mkdirSync(join(destDir, "node_modules", "stale-partial-pkg"), { recursive: true });
    writeFileSync(join(destDir, "node_modules", "stale-partial-pkg", "marker.txt"), "STALE PARTIAL INSTALL — must be wiped\n");

    stubNpm();
    process.env.NPM_STUB_EXIT = "0";
    process.env.NPM_STUB_MATERIALIZE = "1";
    process.env.NPM_STUB_LOG = join(logDir, "calls.log");

    const out = await runInstallJob(id, {}, {
      job, installedSnapshot: [], consentVerified: false,
      manifest: readManifest(fixtureRoot, id),
    });

    assert.equal(out.ok, true, `expected the retry to succeed, got: ${out.reason}`);
    assert.ok(existsSync(join(destDir, VERIFY_REL)), "verify_paths file must exist after a successful reinstall");
    assert.equal(
      existsSync(join(destDir, "node_modules", "stale-partial-pkg")),
      false,
      "the stale partial node_modules entry must be gone — npm_required always rm -rf's node_modules before reinstalling",
    );
    assert.ok(
      existsSync(process.env.NPM_STUB_LOG) && readFileSync(process.env.NPM_STUB_LOG, "utf8").trim().length > 0,
      "npm must actually run on retry, not be skipped just because node_modules pre-existed",
    );
    const npmCall = readFileSync(process.env.NPM_STUB_LOG, "utf8").trim();
    assert.match(npmCall, /^ci /, "a bundle shipping package-lock.json must use `npm ci`");
    assert.match(npmCall, /--ignore-scripts/, "npm_required installs must pass --ignore-scripts (Task 2's viability check cleared this)");
  } finally {
    _finishJobForTest(job, "complete");
    restorePath();
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ─── no package-lock.json → falls back to `npm install` ───

test("npm_required: no package-lock.json shipped → falls back to `npm install` (still --ignore-scripts)", async () => {
  const id = "fx-npmreq-nolock";
  const fixtureRoot = buildFixture(id, { withLock: false });
  _setAppBundlesForTest(fixtureRoot);
  const job = _createJobForTest(id, "install");
  const logDir = freshRoot("crow-npmlog-");
  try {
    stubNpm();
    process.env.NPM_STUB_EXIT = "0";
    process.env.NPM_STUB_MATERIALIZE = "1";
    process.env.NPM_STUB_LOG = join(logDir, "calls.log");

    const out = await runInstallJob(id, {}, {
      job, installedSnapshot: [], consentVerified: false,
      manifest: readManifest(fixtureRoot, id),
    });

    assert.equal(out.ok, true, `expected success, got: ${out.reason}`);
    const npmCall = readFileSync(process.env.NPM_STUB_LOG, "utf8").trim();
    assert.match(npmCall, /^install /, "no lockfile → `npm install`, not `npm ci`");
    assert.match(npmCall, /--ignore-scripts/);
  } finally {
    _finishJobForTest(job, "complete");
    restorePath();
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ─── missing package.json entirely → hard fail (npm_required with nothing to install) ───

test("npm_required: bundle ships no package.json at all → hard fail, destDir removed", async () => {
  const id = "fx-npmreq-nopkgjson";
  const fixtureRoot = buildFixture(id);
  // Remove package.json (and lockfile) after buildFixture wrote them, so the
  // fixture is otherwise identical (manifest still declares npm_required).
  rmSync(join(fixtureRoot, id, "package.json"), { force: true });
  rmSync(join(fixtureRoot, id, "package-lock.json"), { force: true });
  _setAppBundlesForTest(fixtureRoot);
  const job = _createJobForTest(id, "install");
  try {
    const out = await runInstallJob(id, {}, {
      job, installedSnapshot: [], consentVerified: false,
      manifest: readManifest(fixtureRoot, id),
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /package\.json/i);
    assert.equal(existsSync(destDirFor(id)), false);
  } finally {
    _finishJobForTest(job, "failed");
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ─── concurrent-install guard ───

test("concurrent-install guard: a second POST /bundles/api/install for the SAME bundle_id gets 409 already_installing with the first job's id", async () => {
  const id = "fx-npmreq-concurrent";
  const fixtureRoot = buildFixture(id);
  _setAppBundlesForTest(fixtureRoot);

  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Simulate an in-flight install job for this exact bundle_id directly
  // (avoids needing to pause a real npm/compose call mid-flight to win the
  // race deterministically).
  const existingJob = _createJobForTest(id, "install");
  try {
    const res = await fetch(base + "/bundles/api/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: id }),
    });
    const body = await res.json();
    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.code, "already_installing");
    assert.equal(body.job_id, existingJob.id);
    assert.ok(
      typeof body.error === "string" && body.error.length > 0,
      "error field is required — the shipped extensions client renders res.data.error on a non-ok install",
    );
  } finally {
    _finishJobForTest(existingJob, "complete");
    server.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("concurrent-install guard: once the first job finishes, a new install of the same bundle_id is accepted (no stale 409)", async () => {
  const id = "fx-npmreq-concurrent-cleared";
  const fixtureRoot = buildFixture(id, { withLock: false });
  // No package.json at all for this fixture's second install attempt so the
  // background install (kicked off unawaited by the route) never touches
  // npm/network — it only needs to prove a fresh job_id is issued, not that
  // the install itself succeeds.
  rmSync(join(fixtureRoot, id, "package.json"), { force: true });
  writeFileSync(join(fixtureRoot, id, "manifest.json"), JSON.stringify({
    id, name: "Fixture", type: "bundle", category: "ai", version: "1.0.0", description: "d",
  }, null, 2));
  _setAppBundlesForTest(fixtureRoot);

  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const finishedJob = _createJobForTest(id, "install");
  _finishJobForTest(finishedJob, "complete"); // no longer "running"
  try {
    const res = await fetch(base + "/bundles/api/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: id }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.ok(body.job_id, "a fresh job must be created once the prior one has finished");
    assert.notEqual(body.job_id, finishedJob.id);
  } finally {
    server.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
