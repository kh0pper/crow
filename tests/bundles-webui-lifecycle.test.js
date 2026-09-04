/**
 * Install/uninstall lifecycle for bundles that declare a `webUI` block
 * (`servers/gateway/routes/bundles.js`).
 *
 * The gap this covers: extension-proxy computes its entire route table once,
 * at factory-construction time. A bundle installed into a RUNNING gateway
 * therefore has no /proxy/<id> route until the process restarts, so
 * runInstallJob must report needsRestart on install, and uninstall must flag
 * the same restart need (the route survives until then).
 *
 * bundles.js resolves CROW_HOME at module load — scratch dir set before the
 * import (tests/bundles-install-job.test.js header explains the live incident
 * an unisolated run once caused).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-webui-lifecycle-"));
// The bundles router opens a DB client for its cross-host middleware; give it
// its own empty scratch dir rather than depending on whatever CROW_DATA_DIR
// happens to exist (and never, ever the operator's real one).
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-webui-lifecycle-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

const CROW_HOME = process.env.CROW_HOME;
const BUNDLES_DIR = join(CROW_HOME, "bundles");

const {
  default: bundlesRouter,
  runInstallJob,
  _createJobForTest,
  _getJobForTest,
  _finishJobForTest,
  _setAppBundlesForTest,
  _setRestartHookForTest,
} = await import("../servers/gateway/routes/bundles.js");

after(() => {
  _setRestartHookForTest(null);
  try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {}
  try { rmSync(APP_BUNDLES_FIXTURE, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// One fixture stand-in for the repo's `bundles/` dir, shared by every test
// here. It has to be a single root: the uninstall route resolves its manifest
// with getManifest(), which reads APP_BUNDLES — NOT the installed copy — so a
// per-test root would leave a later test's uninstall looking at the wrong tree
// and silently taking the no-manifest path.
const APP_BUNDLES_FIXTURE = mkdtempSync(join(tmpdir(), "crow-webui-appbundles-"));
_setAppBundlesForTest(APP_BUNDLES_FIXTURE);

/** Write a manifest into the fixture APP_BUNDLES root. */
function writeSourceManifest(id, manifest) {
  const dir = join(APP_BUNDLES_FIXTURE, id);
  mkdirSync(dir, { recursive: true });
  const full = { id, name: id, type: "bundle", version: "0.1.0", ...manifest };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(full, null, 2));
  return full;
}

/** An already-installed bundle, as the uninstall route expects to find it. */
function seedInstalledBundle(id, manifest) {
  writeSourceManifest(id, manifest);
  const dir = join(BUNDLES_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", version: "0.1.0", ...manifest }, null, 2));
  mkdirSync(join(dir, "payload", "hub"), { recursive: true });
  writeFileSync(join(dir, "payload", "hub", "server.mjs"), "// stub payload\n");
  const installedPath = join(CROW_HOME, "installed.json");
  const installed = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, "utf8")) : [];
  installed.push({ id, type: "bundle", version: "0.1.0" });
  writeFileSync(installedPath, JSON.stringify(installed, null, 2));
  return dir;
}

async function withRouter(fn) {
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

/** POST the uninstall and wait for its job to reach a terminal status. */
async function uninstall(base, bundleId) {
  const res = await fetch(`${base}/bundles/api/uninstall`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle_id: bundleId }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `uninstall POST rejected: ${JSON.stringify(body)}`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = _getJobForTest(body.job_id);
    if (job && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`uninstall job ${body.job_id} never finished — the stop is not bounded`);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

test("installing a manifest with a webUI block reports needsRestart", async () => {
  const id = "fx-webui-restart";
  const manifest = writeSourceManifest(id, { webUI: { port: 4210, portEnv: "CROW_FX_WEBUI_PORT", path: "/", label: "Fixture Web UI", authTokenFile: "fx-token" } });
  const job = _createJobForTest(id, "install");
  try {
    const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, true, `install failed: ${out.reason}`);
    assert.equal(out.needsRestart, true,
      "without a restart the bundle gets no /proxy/<id> route and no supervised child — the user would install it and find nothing");
  } finally {
    _finishJobForTest(job, "complete");
  }
});

test("installing an otherwise identical manifest WITHOUT a webUI block does not force a restart", async () => {
  const id = "fx-nowebui-norestart";
  const manifest = writeSourceManifest(id, {});
  const job = _createJobForTest(id, "install");
  try {
    const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, true, `install failed: ${out.reason}`);
    assert.equal(out.needsRestart, false,
      "the webUI condition must not widen into a blanket restart-on-every-install");
  } finally {
    _finishJobForTest(job, "complete");
  }
});

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

test("uninstalling a webUI bundle flags a restart (the /proxy/<id> route survives until then)", async () => {
  const bundleDir = seedInstalledBundle("fx-other-webui", { webUI: { port: 6080, label: "Browser" } });
  const restarts = [];
  _setRestartHookForTest((delay) => restarts.push(delay));
  try {
    await withRouter(async (base) => {
      const job = await uninstall(base, "fx-other-webui");
      assert.equal(job.status, "complete_restart", "its /proxy/<id> route also survives until restart");
      assert.equal(existsSync(bundleDir), false, "bundle files must still be removed");
      assert.deepEqual(restarts, [3000]);
    });
  } finally {
    _setRestartHookForTest(null);
  }
});

test("uninstalling a bundle with no webUI block does not force a restart", async () => {
  const bundleDir = seedInstalledBundle("fx-plain-bundle", {});
  const restarts = [];
  _setRestartHookForTest((delay) => restarts.push(delay));
  try {
    await withRouter(async (base) => {
      const job = await uninstall(base, "fx-plain-bundle");
      assert.equal(job.status, "complete", "a plain bundle uninstall must not start forcing gateway restarts");
      assert.deepEqual(restarts, []);
      assert.equal(existsSync(bundleDir), false);
    });
  } finally {
    _setRestartHookForTest(null);
  }
});
