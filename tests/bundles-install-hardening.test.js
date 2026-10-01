/**
 * Install-path hardening found live installing the privileged `phone` bundle
 * (2026-09-30):
 *   1. a required env var left blank was accepted → compose died on ${VAR:?}
 *   2. a compose-up failure returned early → "installed" bundle with no panel
 *   3. panels.json in its {enabled:[...]} shape crashed the installer
 *   4. Configure (POST /bundles/api/env) never reached the gateway's own .env
 *
 * Everything runs against a scratch CROW_HOME, a fixture bundle root, a stubbed
 * `docker compose`, and a scratch gateway .env — nothing touches the host.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

const HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
process.env.CROW_HOME = HOME;
// bundlesRouter() opens a DB client at construction; better-sqlite3 won't mkdir
// the scratch data dir (npm test always sets CROW_DATA_DIR to a scratch path).
if (process.env.CROW_DATA_DIR) mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
const B = await import("../servers/gateway/routes/bundles.js");
const {
  validateInstall, missingRequiredEnv, runInstallJob, addPanelEnabled, removePanelEnabled,
  _setAppBundlesForTest, _setComposeRunnerForTest, _setAppEnvPathForTest,
  _createJobForTest, _finishJobForTest,
} = B;
const bundlesRouter = B.default;

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-fx-bundles-"));
const GATEWAY_ENV = join(mkdtempSync(join(tmpdir(), "crow-fx-appenv-")), ".env");

after(() => {
  _setComposeRunnerForTest(null);
  _setAppEnvPathForTest(null);
  rmSync(FIXTURES, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

function buildFixture(id, manifestExtra = {}) {
  const dir = join(FIXTURES, id);
  mkdirSync(join(dir, "panel"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id, name: id, type: "bundle", version: "0.1.0", category: "productivity",
    panel: "panel/" + id + ".js",
    panelRoutes: "panel/routes.js",
    skills: ["skills/" + id + ".md"],
    env_vars: [
      { name: "FX_SECRET", required: true, secret: true },
      { name: "FX_WITH_DEFAULT", required: true, default: "dflt" },
      { name: "FX_OPTIONAL" },
    ],
    ...manifestExtra,
  }, null, 2));
  writeFileSync(join(dir, "docker-compose.yml"),
    "services:\n  app:\n    image: busybox\n    environment:\n      - FX_SECRET=${FX_SECRET:?set it}\n");
  writeFileSync(join(dir, "panel", id + ".js"), "export default { id: '" + id + "' };\n");
  writeFileSync(join(dir, "panel", "routes.js"), "export default function () {}\n");
  writeFileSync(join(dir, "skills", id + ".md"), "# skill\n");
  return dir;
}

_setAppBundlesForTest(FIXTURES);

// ─── 1. required env ───

test("missingRequiredEnv: blank / whitespace / absent required keys are reported by NAME; defaults satisfy", () => {
  const manifest = { env_vars: [
    { name: "A", required: true },
    { name: "B", required: true, default: "x" },
    { name: "C", required: true, default: "   " },
    { name: "D" },
  ] };
  assert.deepEqual(missingRequiredEnv(manifest, {}), ["A", "C"]);
  assert.deepEqual(missingRequiredEnv(manifest, { A: "   ", C: "" }), ["A", "C"]);
  assert.deepEqual(missingRequiredEnv(manifest, { A: "v", C: "w" }), []);
  assert.deepEqual(missingRequiredEnv(null, {}), []);
});

test("validateInstall(requireEnv) refuses 400 missing_required_env listing names, never values", async () => {
  buildFixture("fx-reqenv");
  const r = await validateInstall("fx-reqenv", { envVars: { FX_OPTIONAL: "secret-value" }, requireEnv: true, forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, "missing_required_env");
  assert.deepEqual(r.extra.missing_env, ["FX_SECRET"]);
  assert.match(r.error, /FX_SECRET/);
  assert.doesNotMatch(r.error + JSON.stringify(r.extra), /secret-value/);
});

test("validateInstall without requireEnv (collection path) does not apply the env gate", async () => {
  buildFixture("fx-reqenv-set");
  const r = await validateInstall("fx-reqenv-set", { envVars: {}, forceInstall: true });
  assert.notEqual(r.code, "missing_required_env");
});

test("POST /bundles/api/install refuses a blank required env var with 400 before creating a job", async () => {
  buildFixture("fx-reqenv-route");
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: "fx-reqenv-route", env_vars: { FX_SECRET: "  " }, force_install: true }),
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.code, "missing_required_env");
    assert.deepEqual(body.missing_env, ["FX_SECRET"]);
    assert.equal(body.job_id, undefined);
    assert.ok(!existsSync(join(HOME, "bundles", "fx-reqenv-route")), "nothing was copied");
  } finally {
    server.close();
  }
});

// ─── 3. panels.json shape helpers ───

test("addPanelEnabled / removePanelEnabled preserve the {enabled:[...]} shape and its other keys", () => {
  const p = join(mkdtempSync(join(tmpdir(), "crow-fx-panels-")), "panels.json");
  writeFileSync(p, JSON.stringify({ enabled: ["a"], note: "keep" }));
  assert.equal(addPanelEnabled("b", p), true);
  assert.equal(addPanelEnabled("b", p), false, "idempotent");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { enabled: ["a", "b"], note: "keep" });
  assert.equal(removePanelEnabled("a", p), true);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { enabled: ["b"], note: "keep" });
});

test("addPanelEnabled / removePanelEnabled keep a bare array a bare array, and create one when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-fx-panels-"));
  const p = join(dir, "panels.json");
  assert.equal(removePanelEnabled("x", p), false, "missing file: no-op");
  addPanelEnabled("x", p);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), ["x"]);
  addPanelEnabled("y", p);
  removePanelEnabled("x", p);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), ["y"]);
});

// ─── 2 + 3. compose-up failure still completes the non-container steps ───

test("compose-up failure: panel, routes, panels.json (object form), skills and gateway env still land; job reports failure", async () => {
  const id = "fx-composefail";
  buildFixture(id);
  writeFileSync(join(HOME, "panels.json"), JSON.stringify({ enabled: ["existing-panel"] }));
  writeFileSync(GATEWAY_ENV, "PORT=3001\n# FX_SECRET=\n");
  _setAppEnvPathForTest(GATEWAY_ENV);
  const composeCalls = [];
  _setComposeRunnerForTest(async (args) => {
    composeCalls.push(args[0]);
    if (args[0] === "up") throw Object.assign(new Error("exit 1"), { stderr: "required variable FX_SECRET is missing a value" });
    return { stdout: "", stderr: "" };
  });

  const job = _createJobForTest(id, "install");
  try {
    const manifest = JSON.parse(readFileSync(join(FIXTURES, id, "manifest.json"), "utf8"));
    const out = await runInstallJob(id, { FX_SECRET: "s3cret$1" }, {
      job, installedSnapshot: [], consentVerified: false, manifest,
    });

    assert.equal(out.ok, false, "the job still fails");
    assert.match(out.reason, /docker compose up failed: required variable FX_SECRET/);
    assert.equal(out.needsRestart, true, "the panel/env it did install need a restart to load");
    assert.ok(composeCalls.includes("up"));

    const panels = JSON.parse(readFileSync(join(HOME, "panels.json"), "utf8"));
    assert.deepEqual(panels, { enabled: ["existing-panel", id] }, "object shape preserved, id appended once");
    assert.ok(existsSync(join(HOME, "panels", id + ".js")), "panel installed");
    assert.ok(existsSync(join(HOME, "panels", id + "-routes.js")), "panel routes installed");
    assert.ok(existsSync(join(HOME, "skills", id + ".md")), "skill installed");
    assert.match(readFileSync(GATEWAY_ENV, "utf8"), /^FX_SECRET=s3cret\$1$/m, "gateway env propagated ($ kept literal)");

    const installed = JSON.parse(readFileSync(join(HOME, "installed.json"), "utf8"));
    assert.equal(installed.filter((i) => i.id === id).length, 1, "recorded exactly once, so Configure + Start works");
    assert.match(job.log[job.log.length - 1], /did not start.*FX_SECRET/, "the last log line (what the client shows) carries the cause");
  } finally {
    _finishJobForTest(job, "failed");
    clearTimeout(job._evictTimer);
    _setComposeRunnerForTest(null);
    _setAppEnvPathForTest(null);
  }
});

// ─── 4. Configure reaches the gateway env ───

test("POST /bundles/api/env propagates manifest-declared keys to the gateway .env and reports needs_restart", async () => {
  const id = "fx-envroute";
  buildFixture(id);
  mkdirSync(join(HOME, "bundles", id), { recursive: true });
  writeFileSync(join(HOME, "bundles", id, ".env"), "# placeholder\n");
  writeFileSync(GATEWAY_ENV, "PORT=3001\n");
  _setAppEnvPathForTest(GATEWAY_ENV);

  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const post = (env_vars) => fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle_id: id, env_vars }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const r1 = await post({ FX_SECRET: "abc\nCROW_DASHBOARD_PUBLIC=true", NOT_DECLARED: "zzz" });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.needs_restart, true);
    const env = readFileSync(GATEWAY_ENV, "utf8");
    assert.match(env, /^FX_SECRET=abcCROW_DASHBOARD_PUBLIC=true$/m, "a newline cannot smuggle a second line into the gateway env");
    assert.doesNotMatch(env, /^CROW_DASHBOARD_PUBLIC=/m);
    assert.doesNotMatch(env, /NOT_DECLARED/, "undeclared keys never reach the gateway env");

    const r2 = await post({ FX_SECRET: "abc\nCROW_DASHBOARD_PUBLIC=true" });
    assert.equal(r2.body.needs_restart, false, "an unchanged gateway env needs no restart");
  } finally {
    server.close();
    _setAppEnvPathForTest(null);
  }
});
