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
  validateInstall, installBlockingEnvKeys, hardFailComposeKeys, findInvalidEnv, runInstallJob, addPanelEnabled, removePanelEnabled,
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
      { name: "FX_TOKEN", required: true, secret: true },   // post-install token: compose never needs it
      { name: "FX_OPTIONAL" },
    ],
    ...manifestExtra,
  }, null, 2));
  writeFileSync(join(dir, "docker-compose.yml"),
    "services:\n  app:\n    image: busybox\n    environment:\n      - FX_SECRET=${FX_SECRET:?set it}\n      - FX_WITH_DEFAULT=${FX_WITH_DEFAULT?}\n      - FX_OPTIONAL=${FX_OPTIONAL:-x}\n");
  writeFileSync(join(dir, "panel", id + ".js"), "export default { id: '" + id + "' };\n");
  writeFileSync(join(dir, "panel", "routes.js"), "export default function () {}\n");
  writeFileSync(join(dir, "skills", id + ".md"), "# skill\n");
  return dir;
}

_setAppBundlesForTest(FIXTURES);

// ─── 1. required env ───

test("hardFailComposeKeys: only ${KEY:?…} / ${KEY?…} count — not ${KEY}, ${KEY:-…}", () => {
  const keys = hardFailComposeKeys("a: ${A:?msg}\nb: ${B?}\nc: ${C}\nd: ${D:-x}\ne: ${E-x}\n");
  assert.deepEqual([...keys].sort(), ["A", "B"]);
});

test("installBlockingEnvKeys = required AND no default AND compose hard-fails on it", () => {
  buildFixture("fx-blocking");
  // FX_SECRET blocks; FX_WITH_DEFAULT is hard-fail but has a manifest default;
  // FX_TOKEN is required but compose never references it; FX_OPTIONAL is not required.
  assert.deepEqual(installBlockingEnvKeys("fx-blocking"), ["FX_SECRET"]);
  assert.deepEqual(installBlockingEnvKeys("no-such-bundle"), []);
});

test("real bundles: phone is blocked on PHONE_RUNNER_SECRET; gitea's post-install GITEA_TOKEN is not", async () => {
  _setAppBundlesForTest(new URL("../bundles", import.meta.url).pathname);
  try {
    assert.deepEqual(installBlockingEnvKeys("phone"), ["PHONE_RUNNER_SECRET"]);
    const phone = await validateInstall("phone", { envVars: {}, requireEnv: true, forceInstall: true });
    assert.equal(phone.code, "missing_required_env");
    assert.deepEqual(phone.extra.missing_env, ["PHONE_RUNNER_SECRET"]);

    const giteaManifest = JSON.parse(readFileSync(new URL("../bundles/gitea/manifest.json", import.meta.url), "utf8"));
    assert.ok(giteaManifest.env_vars.some((v) => v.name === "GITEA_TOKEN" && v.required), "precondition: GITEA_TOKEN is manifest-required");
    assert.deepEqual(installBlockingEnvKeys("gitea"), []);
    const gitea = await validateInstall("gitea", { envVars: {}, requireEnv: true, forceInstall: true });
    assert.notEqual(gitea.code, "missing_required_env", "gitea installs blank and is configured later");
  } finally {
    _setAppBundlesForTest(FIXTURES);
  }
});

test("real bundles: media-path / admin-password compose hard-fail keys are required, so they block install (B1)", async () => {
  // Found 2026-10-02: jellyfin/navidrome/plex/miniflux interpolate these as
  // ${KEY:?…} but marked them required:false, so a blank install reached
  // `docker compose up` and failed there.
  _setAppBundlesForTest(new URL("../bundles", import.meta.url).pathname);
  try {
    const expected = {
      jellyfin: "JELLYFIN_MEDIA_PATH",
      navidrome: "NAVIDROME_MUSIC_PATH",
      plex: "PLEX_MEDIA_PATH",
      miniflux: "MINIFLUX_ADMIN_PASSWORD",
    };
    for (const [id, key] of Object.entries(expected)) {
      assert.deepEqual(installBlockingEnvKeys(id), [key], id + " blocks on " + key);
      const r = await validateInstall(id, { envVars: {}, requireEnv: true, forceInstall: true });
      assert.equal(r.code, "missing_required_env", id + ": " + JSON.stringify(r));
      assert.deepEqual(r.extra.missing_env, [key]);
      const ok = await validateInstall(id, { envVars: { [key]: "/srv/x" }, requireEnv: true, forceInstall: true });
      assert.notEqual(ok.code, "missing_required_env", id + " with " + key + " set");
    }
  } finally {
    _setAppBundlesForTest(FIXTURES);
  }
});

test("a required key with a manifest default (even compose hard-fail) and a required key compose ignores both install", async () => {
  buildFixture("fx-defaulted");
  const r = await validateInstall("fx-defaulted", { envVars: { FX_SECRET: "s" }, requireEnv: true, forceInstall: true });
  assert.notEqual(r.code, "missing_required_env", JSON.stringify(r));
});

test("findInvalidEnv names the key (never the value) for a bad name or a CR/LF/NUL value", () => {
  assert.equal(findInvalidEnv({ GOOD: "v", OTHER_1: "x" }), null);
  assert.equal(findInvalidEnv({ lower: "v" }).key, "lower");
  assert.equal(findInvalidEnv({ "A=B": "v" }).key, "A=B");
  for (const bad of ["a\nb", "a\rb", "a\u0000b", "secret\r\n"]) {
    const r = findInvalidEnv({ K: bad });
    assert.equal(r.key, "K");
    assert.ok(!JSON.stringify(r).includes("secret"));
  }
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

test("POST /bundles/api/install rejects an invalid env key or a multi-line value with 400 invalid_env, writing nothing", async () => {
  buildFixture("fx-invalid-env");
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const post = (env_vars) => fetch(`http://127.0.0.1:${server.address().port}/bundles/api/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle_id: "fx-invalid-env", env_vars, force_install: true }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const r1 = await post({ FX_SECRET: "topsecret\nCROW_DASHBOARD_PUBLIC=true" });
    assert.equal(r1.status, 400);
    assert.equal(r1.body.code, "invalid_env");
    assert.equal(r1.body.key, "FX_SECRET");
    assert.doesNotMatch(JSON.stringify(r1.body), /topsecret/, "the value is never echoed");
    const r2 = await post({ FX_SECRET: "ok", "bad key": "v" });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.key, "bad key");
    assert.ok(!existsSync(join(HOME, "bundles", "fx-invalid-env")), "nothing was copied or written");
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
    const out = await runInstallJob(id, { FX_SECRET: "s3cret$1", CROW_DASHBOARD_PUBLIC: "true" }, {
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
    assert.doesNotMatch(readFileSync(GATEWAY_ENV, "utf8"), /CROW_DASHBOARD_PUBLIC/,
      "an UNDECLARED install key never reaches the gateway .env (network-exposure invariant)");

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
    const bundleEnvPath = join(HOME, "bundles", id, ".env");
    // I1: a multi-line value is REJECTED before either file is touched, so the
    // bundle .env and the gateway .env can never hold different copies.
    const bad = await post({ FX_SECRET: "abc\nCROW_DASHBOARD_PUBLIC=true" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "invalid_env");
    assert.equal(bad.body.key, "FX_SECRET");
    assert.doesNotMatch(JSON.stringify(bad.body), /abc/);
    assert.equal(readFileSync(bundleEnvPath, "utf8"), "# placeholder\n", "bundle .env untouched");
    assert.equal(readFileSync(GATEWAY_ENV, "utf8"), "PORT=3001\n", "gateway .env untouched");
    const badKey = await post({ "x;y": "v" });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.body.key, "x;y");

    const r1 = await post({ FX_SECRET: "abc", NOT_DECLARED: "zzz" });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.needs_restart, true);
    const env = readFileSync(GATEWAY_ENV, "utf8");
    assert.match(env, /^FX_SECRET=abc$/m);
    assert.doesNotMatch(env, /NOT_DECLARED/, "undeclared keys never reach the gateway env");
    assert.match(readFileSync(bundleEnvPath, "utf8"), /^FX_SECRET=abc$/m, "bundle and gateway copies agree");

    const r2 = await post({ FX_SECRET: "abc" });
    assert.equal(r2.body.needs_restart, false, "an unchanged gateway env needs no restart");
  } finally {
    server.close();
    _setAppEnvPathForTest(null);
  }
});

// ─── 5. B4: Configure says when the running container needs a restart ───

test("composeConsumedKeys: ${KEY…} and $KEY references, $$ is literal, env_file .env means every key", () => {
  const r = B.composeConsumedKeys("a: ${A:-x}\nb: $B\nc: $$NOT\nd: ${D:?m}\n");
  assert.deepEqual([...r.keys].sort(), ["A", "B", "D"]);
  assert.equal(r.all, false);
  assert.equal(B.composeConsumedKeys("services:\n  s:\n    env_file:\n      - .env\n").all, true);
  assert.equal(B.composeConsumedKeys("services:\n  s:\n    env_file: ./.env\n").all, true);
  assert.equal(B.composeConsumedKeys("services:\n  s:\n    env_file: [other.env, \".env\"]\n").all, true);
  assert.equal(B.composeConsumedKeys("services:\n  s:\n    env_file:\n      - path: .env\n        required: false\n").all, true);
  assert.equal(B.composeConsumedKeys("services:\n  s:\n    env_file: [app.env]\n").all, false);
});

test("POST /bundles/api/env: changing a key the compose consumes reports needs_bundle_restart with the key names (B4)", async () => {
  const id = "fx-envrestart";
  buildFixture(id);
  mkdirSync(join(HOME, "bundles", id), { recursive: true });
  writeFileSync(join(HOME, "bundles", id, ".env"), "FX_SECRET=old\n");
  writeFileSync(join(HOME, "bundles", id, "docker-compose.yml"), readFileSync(join(FIXTURES, id, "docker-compose.yml"), "utf8"));
  writeFileSync(GATEWAY_ENV, "PORT=3001\n");
  _setAppEnvPathForTest(GATEWAY_ENV);
  // M8: only a RUNNING container is stale. The stubbed `compose ps` says running.
  let psState = "running";
  const psCalls = [];
  _setComposeRunnerForTest(async (args, opts) => {
    psCalls.push({ args, cwd: opts?.cwd });
    return { stdout: psState ? JSON.stringify({ Service: "app", State: psState }) + "\n" : "", stderr: "" };
  });
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
    const changed = await post({ FX_SECRET: "new-secret-value", FX_TOKEN: "t" });
    assert.deepEqual(psCalls.at(-1).args, ["ps", "--format", "json"]);
    assert.equal(psCalls.at(-1).cwd, join(HOME, "bundles", id));
    assert.equal(changed.body.applies_on_next_start, false);
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.needs_bundle_restart, true);
    assert.deepEqual(changed.body.bundle_restart_keys, ["FX_SECRET"], "FX_TOKEN is not consumed by compose");
    assert.match(changed.body.message, /Restart the bundle to apply FX_SECRET/);
    assert.doesNotMatch(JSON.stringify(changed.body), /new-secret-value/, "names only, never values");

    const same = await post({ FX_SECRET: "new-secret-value" });
    assert.equal(same.body.needs_bundle_restart, false, "an unchanged value needs no container restart");
    assert.deepEqual(same.body.bundle_restart_keys, []);

    const notConsumed = await post({ FX_TOKEN: "t2" });
    assert.equal(notConsumed.body.needs_bundle_restart, false, "a key compose never reads needs no container restart");

    // M8: a STOPPED bundle (ps lists nothing running) is not offered a restart;
    // the change applies on its next start, and the message says so.
    for (const state of ["", "exited"]) {
      psState = state;
      const stopped = await post({ FX_SECRET: "v-" + (state || "none") });
      assert.equal(stopped.body.needs_bundle_restart, false, "stopped (" + JSON.stringify(state) + ") → no Restart offer");
      assert.equal(stopped.body.applies_on_next_start, true);
      assert.deepEqual(stopped.body.bundle_restart_keys, ["FX_SECRET"]);
      assert.match(stopped.body.message, /not running; FX_SECRET will apply on its next start/);
    }

    // A failed `ps` (no docker) errs toward the warning.
    _setComposeRunnerForTest(async () => { throw new Error("docker not found"); });
    const unknown = await post({ FX_SECRET: "v-unknown" });
    assert.equal(unknown.body.needs_bundle_restart, true);
  } finally {
    server.close();
    _setAppEnvPathForTest(null);
    _setComposeRunnerForTest(null);
  }
});

test("POST /bundles/api/env: a bundle with no compose file never asks for a container restart (B4)", async () => {
  const id = "fx-envrestart-nocompose";
  buildFixture(id);
  mkdirSync(join(HOME, "bundles", id), { recursive: true });
  writeFileSync(join(HOME, "bundles", id, ".env"), "FX_SECRET=old\n");
  writeFileSync(GATEWAY_ENV, "PORT=3001\n");
  _setAppEnvPathForTest(GATEWAY_ENV);
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: id, env_vars: { FX_SECRET: "new" } }),
    });
    const body = await res.json();
    assert.equal(body.needs_bundle_restart, false);
  } finally {
    server.close();
    _setAppEnvPathForTest(null);
  }
});

test("POST /bundles/api/start with recreate:true runs up -d --force-recreate; without it, plain up -d (B4)", async () => {
  const id = "fx-recreate";
  buildFixture(id);
  mkdirSync(join(HOME, "bundles", id), { recursive: true });
  writeFileSync(join(HOME, "bundles", id, "docker-compose.yml"), "services:\n  app:\n    image: busybox\n");
  writeFileSync(join(HOME, "bundles", id, "manifest.json"), readFileSync(join(FIXTURES, id, "manifest.json"), "utf8"));
  const calls = [];
  _setComposeRunnerForTest(async (args, opts) => { calls.push({ args, cwd: opts?.cwd }); return { stdout: "", stderr: "" }; });
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/bundles/api/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const r1 = await post({ bundle_id: id, recreate: true });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual(calls[0].args, ["up", "-d", "--force-recreate"]);
    assert.equal(calls[0].cwd, join(HOME, "bundles", id));
    const r2 = await post({ bundle_id: id });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(calls[1].args, ["up", "-d"]);
  } finally {
    server.close();
    _setComposeRunnerForTest(null);
  }
});
