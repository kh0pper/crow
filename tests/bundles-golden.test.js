/**
 * SAT-2 golden tests: today's behaviour of routes/bundles.js, pinned BEFORE the
 * bundle-core extraction so the refactor can prove "no behaviour change".
 *
 *  1. A signed peer (the crossHostAuth path, real crow_instances row + HMAC):
 *     owner actions (install, install-set, uninstall, repin, consent-challenge,
 *     shared-storage apply) are refused 403 owner_only, in every spelling, and
 *     nothing is installed; the actions a peer may take (status, stop, env)
 *     still reach their handlers.
 *  2. Consent challenge and answer: mint, bundle-bound token, single use, and the
 *     consent record written to installed.json.
 *  3. Env read: the names-only view (set / unset) for anyone, values only for the
 *     local owner.
 *  4. Env write: line-preserving save, mode 600, the response shape, refusals.
 *  5. The job registry's change events (the hook the extraction makes injectable).
 *
 * Scratch CROW_HOME + CROW_DATA_DIR, stubbed docker / compose: nothing touches the host.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { rmScratch } from "./helpers/safe-rm.js";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-golden-home-"));
const TMP_DATA = join(TMP_HOME, "data");
mkdirSync(TMP_DATA, { recursive: true });
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const FIXTURES = mkdtempSync(join(tmpdir(), "crow-golden-app-"));
const GW = mkdtempSync(join(tmpdir(), "crow-golden-gw-"));
// The peer credential store at its default place (CROW_HOME/secrets, mode 700).
const STORE = join(TMP_HOME, "secrets", "peer-tokens.json");
mkdirSync(join(TMP_HOME, "secrets"), { recursive: true, mode: 0o700 });

// A real instance DB in the scratch data dir: the router's own createDbClient()
// opens it, so the peer row, the HMAC check and the consent tokens are all real.
const { makeRealDb, addPeerRow } = await import("./fixtures/sync-fleet.mjs");
const db = await makeRealDb(TMP_DATA);
const PEER = "golden-peer";
const PEER_TOKEN = "golden-peer-bearer";
const PEER_KEY = "ab".repeat(32);
await addPeerRow(db, PEER, { status: "active", trusted: 1 });
await db.execute({ sql: "UPDATE crow_instances SET auth_token_hash = ? WHERE id = ?", args: [createHash("sha256").update(PEER_TOKEN).digest("hex"), PEER] });
writeFileSync(STORE, JSON.stringify({ [PEER]: { auth_token: PEER_TOKEN, signing_key: PEER_KEY, created_at: new Date().toISOString(), rotated_at: null } }), { mode: 0o600 });

const B = await import("../servers/gateway/routes/bundles.js");
const { signRequest, _resetNonceCache } = await import("../servers/shared/cross-host-auth.js");
const { _setDockerProbeForTest } = await import("../servers/gateway/dashboard/panels/extensions/data-queries.js");
const { default: bus } = await import("../servers/shared/event-bus.js");

_setDockerProbeForTest(true);
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(GW, ".env"));
B._setRestartHookForTest(() => {});
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
// `docker compose config` (the model check): a minimal model named after the bundle.
B._setComposeConfigRunnerForTest(async (_args, { cwd }) => ({
  stdout: JSON.stringify({ name: cwd.split("/").pop(), services: { app: { image: "busybox:1.36" } } }),
  stderr: "",
}));
const composeCalls = [];
let psRunning = false;
B._setComposeRunnerForTest(async (args, opts) => {
  composeCalls.push({ args, cwd: opts?.cwd, extraEnv: opts?.extraEnv });
  if (args[0] === "ps") return { stdout: psRunning ? JSON.stringify({ Name: "app-1", Service: "app", State: "running", Status: "Up 1 minute" }) + "\n" : "", stderr: "" };
  return { stdout: "", stderr: "" };
});

after(() => {
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  B._setComposeConfigRunnerForTest(null);
  B._setRestartHookForTest(null);
  B._setAppEnvPathForTest(null);
  B._setOwnerCheckForTest(null);
  _setDockerProbeForTest(null);
  try { db.close(); } catch {}
  for (const d of [TMP_HOME, FIXTURES, GW]) rmScratch(d);
});

const COMPOSE = 'services:\n  app:\n    image: busybox:1.36\n    environment:\n      GREETING: "${GREETING:-hello}"\n    volumes:\n      - "${MEDIA_DIR:-./media}:/media"\n';
const ENV_VARS = [
  { name: "GREETING", description: "a greeting" },
  { name: "API_TOKEN", description: "a token", secret: true },
  { name: "MEDIA_DIR", description: "a folder" },
  { name: "UNSET_ONE", description: "never set" },
];
function fixture(id, extra = {}) {
  const m = { id, name: `Golden ${id}`, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: ENV_VARS, ...extra };
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(FIXTURES, id, "docker-compose.yml"), COMPOSE);
  return m;
}
fixture("gold-plain");
fixture("gold-consent", { consent_required: true });
fixture("gold-consent-two", { consent_required: true });

const INSTALLED = join(TMP_HOME, "installed.json");
const installedList = () => (existsSync(INSTALLED) ? JSON.parse(readFileSync(INSTALLED, "utf8")) : []);
/** An installed copy, as a finished install leaves it (written directly: the install job is pinned below). */
function seedInstalled(id, envText) {
  const dir = join(TMP_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), readFileSync(join(FIXTURES, id, "manifest.json")));
  writeFileSync(join(dir, "docker-compose.yml"), COMPOSE);
  writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  writeFileSync(INSTALLED, JSON.stringify([...installedList().filter((i) => i.id !== id), { id, type: "bundle", version: "0.1.0" }]));
  return dir;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
async function call(base, method, path, body, { signed = false } = {}) {
  const text = method === "GET" ? "{}" : JSON.stringify(body || {});
  const headers = { "content-type": "application/json" };
  if (signed) {
    _resetNonceCache();
    Object.assign(headers, signRequest({ method, path, body: text, authToken: PEER_TOKEN, signingKey: PEER_KEY, sourceInstanceId: PEER }));
  }
  const r = await fetch(base + path, { method, headers, ...(method === "GET" ? {} : { body: text }) });
  return { status: r.status, body: await r.json() };
}
async function waitJob(id) {
  const deadline = Date.now() + 15_000;
  let job;
  while (Date.now() < deadline) {
    job = B._getJobForTest(id);
    if (job && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  return job;
}

const OWNER_ONLY_BODY = { error: "This is an owner action on this instance; a peer instance can't perform it", code: "owner_only" };

test("peer (crossHostAuth): every owner action is refused 403 owner_only, in every spelling, and installs nothing", async () => {
  await withServer(async (base) => {
    // The signer reaches a peer-allowed route. Each 403 below carries code owner_only, which the
    // gate only sends when req.crossHostAuth is set — i.e. the HMAC verified (a bad one is 401, next test).
    const ok = await call(base, "GET", "/bundles/api/status", null, { signed: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { bundles: [] });
    const body = { bundle_id: "gold-plain", collection_id: "home-server", env_vars: { GREETING: "x" } };
    for (const [method, path] of [
      ["POST", "/bundles/api/install"],
      ["POST", "/bundles/api/INSTALL"],
      ["POST", "/bundles/api/install/"],
      ["POST", "/bundles/api/install-set"],
      ["POST", "/bundles/api/uninstall"],
      ["POST", "/bundles/api/repin"],
      ["GET", "/bundles/api/consent-challenge/gold-consent"],
      ["GET", "/bundles/api/Consent-Challenge/gold-consent"],
      ["POST", "/bundles/api/shared-storage/apply/gold-plain"],
    ]) {
      const r = await call(base, method, path, body, { signed: true });
      assert.equal(r.status, 403, `${method} ${path}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, OWNER_ONLY_BODY, `${method} ${path}`);
    }
    assert.deepEqual(installedList(), []);
    assert.equal(existsSync(join(TMP_HOME, "bundles", "gold-plain")), false);
    const { rows } = await db.execute("SELECT COUNT(*) AS n FROM install_consents");
    assert.equal(Number(rows[0].n), 0, "a peer never mints a consent token");
  });
});

test("peer (crossHostAuth): a bogus signature is 401 on an owner route, before the owner-only gate", async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/bundles/api/install", {
      method: "POST",
      headers: { "content-type": "application/json", "x-crow-signature": "bogus", "x-crow-source": PEER, "x-crow-timestamp": String(Date.now()), "x-crow-nonce": "n1", authorization: `Bearer ${PEER_TOKEN}` },
      body: JSON.stringify({ bundle_id: "gold-plain" }),
    });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "peer_auth_failed" });
  });
});

test("consent: challenge for a plain bundle says not required; a consent bundle mints a bundle-bound, single-use token", async () => {
  await withServer(async (base) => {
    const plain = await call(base, "GET", "/bundles/api/consent-challenge/gold-plain");
    assert.equal(plain.status, 200);
    assert.deepEqual(plain.body, { required: false, install_required: [], existing_secret_set: [] });

    const ch = await call(base, "GET", "/bundles/api/consent-challenge/gold-consent");
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    assert.match(ch.body.token, /^[0-9a-f]{64}$/);
    const { token, ...rest } = ch.body;
    assert.deepEqual(rest, {
      required: true,
      bundle_id: "gold-consent",
      bundle_name: "Golden gold-consent",
      privileged: false,
      consent_required: true,
      message: "This bundle requires explicit consent to install.",
      capabilities: [],
      prereqs: [],
      min_android_app: null,
      expires_in_seconds: 900,
      install_required: [],
      existing_secret_set: [],
    });

    const missing = await call(base, "POST", "/bundles/api/install", { bundle_id: "gold-consent" });
    assert.equal(missing.status, 403);
    assert.deepEqual(missing.body, { error: "Consent token required. Call GET /bundles/api/consent-challenge/:id to obtain one.", consent_required: true });

    const bogus = await call(base, "POST", "/bundles/api/install", { bundle_id: "gold-consent", consent_token: "0".repeat(64) });
    assert.equal(bogus.status, 403);
    assert.deepEqual(bogus.body, { error: "Consent token is invalid, expired, or already consumed. Mint a new one and retry.", consent_expired: true });

    // Bundle-bound: gold-consent's token does not answer gold-consent-two's challenge…
    const wrong = await call(base, "POST", "/bundles/api/install", { bundle_id: "gold-consent-two", consent_token: token });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.consent_expired, true);

    // …and answers its own exactly once.
    composeCalls.length = 0;
    const good = await call(base, "POST", "/bundles/api/install", { bundle_id: "gold-consent", consent_token: token, env_vars: { GREETING: "hi", API_TOKEN: "s3cret" } });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.ok, true);
    assert.equal(good.body.message, "Installing gold-consent...");
    const job = await waitJob(good.body.job_id);
    // complete_restart: the gateway env took the declared keys (the restart hook is stubbed).
    assert.equal(job.status, "complete_restart", job.log.join("\n"));
    assert.deepEqual(job.log, ["Copied bundle files", "Wrote 2 env vars", "Security check passed", "Pulling Docker images...", "Docker images pulled", "Starting containers...", "Containers started", "Configuration applied to gateway", "Installation tracked", "Scheduling gateway restart to load new panels/servers..."]);
    assert.equal(job.bundleId, "gold-consent");
    assert.equal(job.action, "install");
    assert.ok(job.completedAt);
    assert.deepEqual(composeCalls.map((c) => c.args[0]), ["pull", "up"]);
    for (const c of composeCalls) assert.equal(c.cwd, join(TMP_HOME, "bundles", "gold-consent"));

    const rec = installedList().find((i) => i.id === "gold-consent");
    assert.ok(rec, "installed.json has the record");
    assert.deepEqual(rec.consent, { verified: true, privileged: false, consent_required: true });
    const envPath = join(TMP_HOME, "bundles", "gold-consent", ".env");
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(envPath, "utf8"), "GREETING=hi\nAPI_TOKEN=s3cret\n");

    const { rows } = await db.execute({ sql: "SELECT consumed FROM install_consents WHERE token = ?", args: [token] });
    assert.equal(Number(rows[0]?.consumed), 1, "the token is consumed");

    // Already installed is checked before consent, so a reused token is never even read.
    const again = await call(base, "POST", "/bundles/api/install", { bundle_id: "gold-consent", consent_token: token });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "Bundle 'gold-consent' is already installed");
  });
});

test("env read: names-only for anyone (set secrets listed, unset and placeholder absent), values for the local owner", async () => {
  seedInstalled("gold-plain", "# kept comment\nGREETING=hey\nAPI_TOKEN=tok-value\nMEDIA_DIR=\nUNSET_ONE=changeme\n");
  assert.deepEqual(B.existingInstallEnv("gold-plain"), { values: { GREETING: "hey" }, secretSet: ["API_TOKEN"] });
  assert.deepEqual(B.existingInstallEnv("not-installed-bundle"), { values: {}, secretSet: [] });
  assert.deepEqual(B.existingInstallEnv("../etc"), { values: {}, secretSet: [] });
  await withServer(async (base) => {
    const anon = await call(base, "GET", "/bundles/api/consent-challenge/gold-plain");
    assert.deepEqual(anon.body, { required: false, install_required: [], existing_secret_set: ["API_TOKEN"] });
    B._setOwnerCheckForTest(() => true);
    try {
      const owner = await call(base, "GET", "/bundles/api/consent-challenge/gold-plain");
      assert.deepEqual(owner.body, { required: false, install_required: [], existing_secret_set: ["API_TOKEN"], existing_env: { GREETING: "hey" } });
    } finally { B._setOwnerCheckForTest(null); }
  });
});

test("env write: a peer saves a plain value line-preserving (mode 600) and gets the names-only response", async () => {
  const dir = seedInstalled("gold-plain", "# kept comment\nGREETING=hey\nAPI_TOKEN=tok-value\n");
  await withServer(async (base) => {
    psRunning = true;
    composeCalls.length = 0;
    const r = await call(base, "POST", "/bundles/api/env", { bundle_id: "gold-plain", env_vars: { GREETING: "bonjour" } }, { signed: true });
    psRunning = false;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      ok: true,
      message: "Environment variables saved. Restart the bundle to apply GREETING to its container — it keeps its old values until then",
      needs_restart: false,
      needs_bundle_restart: true,
      applies_on_next_start: false,
      bundle_restart_keys: ["GREETING"],
      needs_config: [],
      keychain: null,
    });
    assert.deepEqual(composeCalls.map((c) => c.args), [["ps", "--format", "json"]]);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "# kept comment\nGREETING=bonjour\nAPI_TOKEN=tok-value\n");
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);

    // Not running: applies on next start.
    const r2 = await call(base, "POST", "/bundles/api/env", { bundle_id: "gold-plain", env_vars: { GREETING: "hola" } });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.needs_bundle_restart, false);
    assert.equal(r2.body.applies_on_next_start, true);
    assert.equal(r2.body.message, "Environment variables saved. The bundle is not running; GREETING will apply on its next start");
  });
});

test("env write: refusals — a peer's host folder (403 folder_needs_owner), a bad key (400), not installed (404), bad id (400)", async () => {
  const dir = seedInstalled("gold-plain", "GREETING=hey\n");
  await withServer(async (base) => {
    const folder = await call(base, "POST", "/bundles/api/env", { bundle_id: "gold-plain", env_vars: { MEDIA_DIR: "/srv/elsewhere" } }, { signed: true });
    assert.equal(folder.status, 403);
    assert.deepEqual(folder.body, { code: "folder_needs_owner", key: "MEDIA_DIR", error: "Folder settings (MEDIA_DIR) are set from this machine's own dashboard, signed in with its password." });
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "GREETING=hey\n", "nothing written");

    const badKey = await call(base, "POST", "/bundles/api/env", { bundle_id: "gold-plain", env_vars: { "bad-key": "x" } }, { signed: true });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.body.code, "invalid_env");
    assert.equal(badKey.body.key, "bad-key");

    const multi = await call(base, "POST", "/bundles/api/env", { bundle_id: "gold-plain", env_vars: { GREETING: "a\nB=c" } });
    assert.equal(multi.status, 400);
    assert.equal(multi.body.code, "invalid_env");

    const missing = await call(base, "POST", "/bundles/api/env", { bundle_id: "gold-absent", env_vars: { GREETING: "x" } }, { signed: true });
    assert.deepEqual(missing, { status: 404, body: { error: "Bundle 'gold-absent' is not installed" } });

    const badId = await call(base, "POST", "/bundles/api/env", { bundle_id: "../x", env_vars: {} }, { signed: true });
    assert.deepEqual(badId, { status: 400, body: { error: "Invalid bundle ID" } });

    const notObj = await call(base, "POST", "/bundles/api/env", { bundle_id: "gold-plain", env_vars: "x" });
    assert.deepEqual(notObj, { status: 400, body: { error: "env_vars must be an object" } });
  });
});

test("peer (crossHostAuth): status and stop reach their handlers (compose ps / stop through the runner)", async () => {
  seedInstalled("gold-plain", "GREETING=hey\n");
  await withServer(async (base) => {
    psRunning = true;
    const s = await call(base, "GET", "/bundles/api/status", null, { signed: true });
    psRunning = false;
    assert.equal(s.status, 200);
    const plain = s.body.bundles.find((b) => b.id === "gold-plain");
    assert.deepEqual(plain, { id: "gold-plain", type: "bundle", version: "0.1.0", name: "Golden gold-plain", containers: [{ name: "app-1", state: "running", status: "Up 1 minute" }], running: true });

    composeCalls.length = 0;
    const stop = await call(base, "POST", "/bundles/api/stop", { bundle_id: "gold-plain" }, { signed: true });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.deepEqual(stop.body, { ok: true, message: "Bundle 'gold-plain' stopped" });
    assert.deepEqual(composeCalls.map((c) => c.args), [["stop"]]);
    assert.equal(composeCalls[0].cwd, join(TMP_HOME, "bundles", "gold-plain"));
  });
});

test("job registry: create, finish and the jobs:changed event shape", async () => {
  const events = [];
  const on = (e) => events.push(e);
  bus.on("jobs:changed", on);
  try {
    const job = B._createJobForTest("gold-job", "install");
    assert.equal(job.status, "running");
    assert.equal(job.completedAt, null);
    assert.deepEqual(job.log, []);
    assert.equal(B._getJobForTest(job.id), job);
    assert.equal(B.activeJobFor("gold-job"), job);
    B._finishJobForTest(job, "complete");
    assert.equal(job.status, "complete");
    assert.equal(B.activeJobFor("gold-job"), null);
    assert.equal(B._getJobForTest(job.id), job, "kept until the TTL after it ends");
    assert.doesNotThrow(() => JSON.stringify(job), "the eviction timer is not enumerable");
    assert.deepEqual(events.at(-1), { jobId: job.id, status: "complete", addonId: null, action: "install", lastLine: "", startedAt: job.startedAt, completedAt: job.completedAt });
  } finally { bus.off("jobs:changed", on); }
});
