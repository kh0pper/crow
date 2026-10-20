/**
 * Retiring the AI Companion, step 1 (store hiding). The Companion, Maker Lab
 * (archived: it requires the Companion) and Maker Lab Advanced (it requires
 * Maker Lab) are `draft: true`: the store no longer lists them, so none of
 * them can be installed fresh from Extensions. Their manifests stay in the
 * repo, because the uninstall route reads the REPO manifest (getManifest) to
 * undo an install. So a copy that is already installed must still come off
 * through the product's own Remove, Maker Lab first (it depends on the
 * Companion), then the Companion.
 *
 * bundles.js resolves CROW_HOME at module load, so the scratch dirs are set
 * before the import (tests/bundles-webui-lifecycle.test.js has the pattern).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-retired-companion-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-retired-companion-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

const CROW_HOME = process.env.CROW_HOME;
const BUNDLES_DIR = join(CROW_HOME, "bundles");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETIRED = ["companion", "maker-lab", "maker-lab-advanced"];

const B = await import("../servers/gateway/routes/bundles.js");
const { buildRegistry } = await import("../scripts/build-registry.mjs");

const APP_FIXTURE = mkdtempSync(join(tmpdir(), "crow-retired-companion-app-"));
const ENV_FIXTURE = join(APP_FIXTURE, "gateway.env");
writeFileSync(ENV_FIXTURE, "");
B._setAppEnvPathForTest(ENV_FIXTURE);
after(() => {
  B._setRestartHookForTest(null);
  B._setAppBundlesForTest(join(ROOT, "bundles"));
  B._setAppEnvPathForTest(null);
  for (const d of [CROW_HOME, process.env.CROW_DATA_DIR, APP_FIXTURE]) rmSync(d, { recursive: true, force: true });
});

const repoManifest = (id) => JSON.parse(readFileSync(join(ROOT, "bundles", id, "manifest.json"), "utf8"));

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

test("the Companion, Maker Lab and Maker Lab Advanced manifests are drafts (kept in the repo)", () => {
  for (const id of RETIRED) assert.equal(repoManifest(id).draft, true, `${id} must be draft: true`);
});

test("build-registry keeps all three out of the store as DRAFT, not invalid", () => {
  const { registry, audit } = buildRegistry({ tracked: null });
  const ids = new Set(registry["add-ons"].map((a) => a.id));
  for (const id of RETIRED) {
    assert.equal(ids.has(id), false, `${id} must not be listed`);
    const row = audit.find((a) => a.id === id);
    assert.equal(row?.status, "draft", `${id}: ${JSON.stringify(row?.errors)}`);
  }
});

test("the committed registry (what the Extensions store reads) lists none of the three", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "registry", "add-ons.json"), "utf8"));
  const ids = new Set(reg["add-ons"].map((a) => a.id));
  for (const id of RETIRED) assert.equal(ids.has(id), false, id);
});

test("Calls no longer points at the Companion (enhancedBy)", () => {
  assert.equal("enhancedBy" in repoManifest("calls"), false);
  const reg = JSON.parse(readFileSync(join(ROOT, "registry", "add-ons.json"), "utf8"));
  const calls = reg["add-ons"].find((a) => a.id === "calls");
  assert.ok(calls, "Calls stays published");
  assert.equal("enhancedBy" in calls, false);
});

// ---------------------------------------------------------------------------
// an installed copy still comes off
// ---------------------------------------------------------------------------

/**
 * The fixture repo root holds copies of the REAL repo manifests and skills, so
 * the uninstall reads the draft manifests exactly as it will in prod. One
 * deliberate change: `ports` is dropped from the Companion copy, because that
 * step shells out to `sudo -n ufw` and `sudo -n tailscale serve` with no test
 * seam, and a test must never touch the host's firewall or Serve config.
 */
function stageRepoCopy(id, edit = (m) => m) {
  const src = join(ROOT, "bundles", id);
  const dst = join(APP_FIXTURE, id);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, "manifest.json"), JSON.stringify(edit(repoManifest(id)), null, 2));
  if (existsSync(join(src, "skills"))) cpSync(join(src, "skills"), join(dst, "skills"), { recursive: true });
}

function seedInstalled(id, type) {
  const dir = join(BUNDLES_DIR, id);
  mkdirSync(dir, { recursive: true });
  cpSync(join(APP_FIXTURE, id, "manifest.json"), join(dir, "manifest.json"));
  const p = join(CROW_HOME, "installed.json");
  const installed = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
  installed.push({ id, type, version: repoManifest(id).version });
  writeFileSync(p, JSON.stringify(installed, null, 2));
  return dir;
}

const installedIds = () => JSON.parse(readFileSync(join(CROW_HOME, "installed.json"), "utf8")).map((i) => i.id);

async function withRouter(fn) {
  const app = express();
  app.use(express.json());
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

async function postUninstall(base, id) {
  const res = await fetch(`${base}/bundles/api/uninstall`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitJob(jobId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const job = B._getJobForTest(jobId);
    if (job && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`job ${jobId} never finished`);
}

test("an installed draft Companion + Maker Lab still uninstall: Maker Lab first, then the Companion", async () => {
  B._setAppBundlesForTest(APP_FIXTURE);
  stageRepoCopy("companion", ({ ports: _ports, ...m }) => m);
  stageRepoCopy("maker-lab");
  const companionDir = seedInstalled("companion", "bundle");
  const makerDir = seedInstalled("maker-lab", "mcp-server");
  mkdirSync(join(CROW_HOME, "panels"), { recursive: true });
  writeFileSync(join(CROW_HOME, "panels", "maker-lab.js"), "export default {};\n");
  writeFileSync(join(CROW_HOME, "panels", "maker-lab-routes.js"), "export default () => {};\n");
  writeFileSync(join(CROW_HOME, "mcp-addons.json"), JSON.stringify({ "maker-lab": { command: "node", args: ["server/index.js"] } }));

  const restarts = [];
  B._setRestartHookForTest((delay) => restarts.push(delay));
  await withRouter(async (base) => {
    // The dependency guard still holds for drafts: the Companion can't go first.
    const early = await postUninstall(base, "companion");
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.deepEqual(early.body.dependents, ["maker-lab"]);

    const mk = await postUninstall(base, "maker-lab");
    assert.equal(mk.status, 200, JSON.stringify(mk.body));
    const mkJob = await waitJob(mk.body.job_id);
    assert.match(mkJob.status, /^complete/, JSON.stringify(mkJob.logs || mkJob));
    assert.equal(existsSync(makerDir), false);
    assert.equal(existsSync(join(CROW_HOME, "panels", "maker-lab.js")), false);
    assert.equal(existsSync(join(CROW_HOME, "panels", "maker-lab-routes.js")), false);
    assert.equal("maker-lab" in JSON.parse(readFileSync(join(CROW_HOME, "mcp-addons.json"), "utf8")), false);
    assert.deepEqual(installedIds(), ["companion"]);

    const co = await postUninstall(base, "companion");
    assert.equal(co.status, 200, JSON.stringify(co.body));
    const coJob = await waitJob(co.body.job_id);
    assert.match(coJob.status, /^complete/, JSON.stringify(coJob.logs || coJob));
    assert.equal(existsSync(companionDir), false);
    assert.deepEqual(installedIds(), []);
  });
  assert.ok(restarts.length >= 1, "Remove still schedules the gateway restart that unloads the panel / web UI");
});

test("the Companion's version bump refreshes an installed copy without bringing its compose file or Dockerfile in", async () => {
  // Plan step A2/A4: the installed copy on a live box has no compose file, so
  // Remove skips `docker compose down`. The bump must not change that, and must
  // not shell out (no npm, no docker) at gateway boot.
  B._setAppBundlesForTest(APP_FIXTURE);
  rmSync(join(APP_FIXTURE, "companion"), { recursive: true, force: true });
  stageRepoCopy("companion");
  for (const f of ["docker-compose.yml", "Dockerfile", "settings-section.js"]) {
    cpSync(join(ROOT, "bundles", "companion", f), join(APP_FIXTURE, "companion", f));
  }
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "companion", type: "bundle", version: "1.0.0" }]));
  const dest = join(BUNDLES_DIR, "companion");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json"), JSON.stringify({ ...repoManifest("companion"), version: "1.0.4", draft: undefined }));

  const calls = [];
  const out = await B.repairInstalledBundleAssets({ appBundles: APP_FIXTURE, run: async (...a) => { calls.push(a); return { stdout: "", stderr: "" }; }, log: () => {} });
  assert.deepEqual(out.errors, []);
  assert.ok(out.repaired.some((r) => r.startsWith("companion: refreshed 1.0.4 -> ")), JSON.stringify(out.repaired));
  const installed = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
  assert.equal(installed.version, repoManifest("companion").version);
  assert.equal(installed.draft, true);
  assert.equal(existsSync(join(dest, "docker-compose.yml")), false, "Remove must still find no compose file");
  assert.equal(existsSync(join(dest, "Dockerfile")), false);
  assert.deepEqual(calls, [], "the refresh must not run npm or docker");
});
