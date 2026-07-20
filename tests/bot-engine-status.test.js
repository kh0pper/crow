/**
 * bot-engine-status — C4 Task 4.
 *
 * engineStatus() is the single leaf-level readiness check the attach gate
 * and the readiness UI both call. Its four states have a strict precedence
 * (r1-reviewed): installing > absent > unhealthy > ready. The two
 * interesting precedence cases are:
 *   - installing beats everything, even a resolved+healthy engine (an
 *     in-flight reinstall of bot-engine must read as "installing", not
 *     whatever the pre-reinstall disk state happens to look like).
 *   - absent beats a stale open breaker — an uninstalled engine must never
 *     read as "unhealthy" just because some earlier process left a breaker
 *     open; resolvePiCli() returning null is ground truth.
 *
 * "absent" needs resolvePiCli() to miss on EVERY ladder rung (env, bundle,
 * repo, global) — not just the ones this test module controls directly.
 * The global rung derives from process.execPath, which on a dev box with
 * pi installed globally under nvm genuinely resolves to a real cli.js (this
 * was confirmed on crow's dev worktree before writing this test) — so an
 * absent test that doesn't override execPath would spuriously pass through
 * to "ready". absentOpts() below points crowHome/repoRoot/execPath at three
 * fresh empty tmp dirs so every rung misses regardless of the host.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  engineStatus,
  _setSeamsForTest,
  ENGINE_CHANNELS,
} from "../servers/gateway/bot-engine-status.js";

function emptyTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Opts guaranteed to miss every resolvePiCli rung, on any host. */
function absentOpts() {
  const crowHome = emptyTmp("crow-bes-home-");
  const repoRoot = emptyTmp("crow-bes-repo-");
  const execDir = emptyTmp("crow-bes-exec-");
  return {
    env: { ...process.env, CROW_HOME: crowHome, PIBOT_PI_CLI: undefined },
    crowHome,
    repoRoot,
    execPath: join(execDir, "node"),
  };
}

/** A real tmp file + env override that makes resolvePiCli hit the "env" rung. */
function readyEnv() {
  const dir = emptyTmp("crow-bes-cli-");
  const cliPath = join(dir, "cli.js");
  writeFileSync(cliPath, "// fixture pi cli\n");
  return { env: { ...process.env, PIBOT_PI_CLI: cliPath }, cliPath };
}

beforeEach(() => {
  // Reset both registered sources before every test — they are module-level
  // state, so one test's stub must never bleed into the next.
  _setSeamsForTest();
});

test("ENGINE_CHANNELS lists the supported bot channels", () => {
  assert.deepEqual(ENGINE_CHANNELS, ["gmail", "discord", "telegram", "slack"]);
});

test("absent: resolvePiCli misses on every rung (env/bundle/repo/global)", () => {
  const status = engineStatus(absentOpts());
  assert.deepEqual(status, { state: "absent" });
});

test("ready: PIBOT_PI_CLI points at a real file, no breaker, no active job", () => {
  const { env, cliPath } = readyEnv();
  const status = engineStatus({ env });
  assert.equal(status.state, "ready");
  assert.equal(status.source, "env");
  assert.equal(status.cliPath, cliPath);
});

test("unhealthy: engine resolves fine but the breaker is open", () => {
  const { env } = readyEnv();
  _setSeamsForTest({
    breaker: () => ({ open: true, lastError: "spawn ENOENT", retryAt: "2026-07-21T00:00:00Z" }),
  });
  const status = engineStatus({ env });
  assert.deepEqual(status, {
    state: "unhealthy",
    error: "spawn ENOENT",
    retryAt: "2026-07-21T00:00:00Z",
  });
});

test("unhealthy: missing lastError/retryAt on the breaker report null, not undefined", () => {
  const { env } = readyEnv();
  _setSeamsForTest({ breaker: () => ({ open: true }) });
  const status = engineStatus({ env });
  assert.deepEqual(status, { state: "unhealthy", error: null, retryAt: null });
});

test("installing: an unfinished bot-engine install job takes precedence over a ready+healthy engine", () => {
  const { env } = readyEnv();
  _setSeamsForTest({
    activeJob: (bundleId) => (bundleId === "bot-engine" ? { id: "42" } : null),
  });
  const status = engineStatus({ env });
  assert.deepEqual(status, { state: "installing" });
});

test("installing only fires for the bot-engine bundle id, not any other job", () => {
  const { env } = readyEnv();
  _setSeamsForTest({
    activeJob: (bundleId) => (bundleId === "some-other-bundle" ? { id: "1" } : null),
  });
  const status = engineStatus({ env });
  assert.equal(status.state, "ready");
});

test("precedence: installing beats absent — a job can be running before the engine ever lands on disk", () => {
  _setSeamsForTest({ activeJob: () => ({ id: "1" }) });
  const status = engineStatus(absentOpts());
  assert.deepEqual(status, { state: "installing" });
});

test("precedence: absent beats a stale open breaker — an uninstalled engine is absent, never unhealthy", () => {
  _setSeamsForTest({ breaker: () => ({ open: true, lastError: "stale from a previous install" }) });
  const status = engineStatus(absentOpts());
  assert.deepEqual(status, { state: "absent" });
});

test("precedence: unhealthy beats ready — an open breaker wins even when resolvePiCli succeeds", () => {
  const { env } = readyEnv();
  _setSeamsForTest({ breaker: () => ({ open: true, lastError: "x" }) });
  const status = engineStatus({ env });
  assert.equal(status.state, "unhealthy");
});
