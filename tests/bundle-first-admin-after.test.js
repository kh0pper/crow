/**
 * N3-4, operator ruling "Crow creates, then closes" — the generic `firstAdmin.setup.after`
 * step.
 *
 * A bundle whose admin Crow creates can still leave a way in open: an app whose own
 * registration page accepts anyone keeps accepting after Crow's account exists. The manifest
 * now says what to do about it, beside the setup script:
 *
 *   "setup": { "script": "scripts/first-admin.sh", "timeout_s": 180,
 *              "after": { "env": { "APP_ENABLE_REGISTRATION": "false" }, "recreate": true } }
 *
 * Crow writes `after.env` into the installed bundle's .env (the same line-preserving,
 * mode-600 writer every install-time step uses) and, when `recreate` is true, recreates the
 * bundle's containers ONCE through the guarded path a Start uses. Both callers of
 * runFirstAdminSetup do it — the install path and the Extensions card's "Set it up for me" —
 * and only when the run returned ok: a failure here never undoes the account, whose password
 * is already in Crow's keychain.
 *
 * What this file holds down:
 *   1. the declaration's rules (only env/recreate; declared env names only; plain short
 *      strings; a boolean; a block that does something), through the SAME function the
 *      manifest contract uses,
 *   2. applyFirstAdminAfter over its seams: nothing declared → nothing happens, env written
 *      then one recreate, an env failure skips the recreate, a recreate failure is reported
 *      as one plain line and never throws,
 *   3. the bundle contract itself (undeclared key refused, non-string refused) and the real
 *      vikunja manifest accepted,
 *   4. the install path: after runs only on ok, the .env really carries the value, the
 *      recreate happens once through `up -d --force-recreate`, and a failed recreate is
 *      reported while the password stays saved,
 *   5. the route: the same, plus the plain `after` field in the answer.
 *
 * Scratch CROW_HOME/CROW_DATA_DIR before anything Crow-side is imported. No docker: the
 * compose, docker and `compose config` runners are stubbed and every argv is recorded.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-fa-after-home-"));
const TMP_DATA = join(TMP_HOME, "data");
const TMP_BUNDLES = mkdtempSync(join(tmpdir(), "crow-fa-after-src-"));
mkdirSync(TMP_DATA, { recursive: true });
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: TMP_DATA },
  stdio: "pipe",
  cwd: REPO,
});

const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");
const {
  firstAdminAfterProblems,
  firstAdminAfterPlan,
  applyFirstAdminAfter,
  firstAdminAfterFailureSentence,
  FIRST_ADMIN_AFTER_MAX_VALUE,
} = await import("../servers/gateway/bundle-first-admin-after.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const express = (await import("express")).default;
const B = await import("../servers/gateway/routes/bundles.js");

B._setAppBundlesForTest(TMP_BUNDLES);
B._setRestartHookForTest(() => {});

after(() => {
  B._setRestartHookForTest(null);
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  B._setComposeConfigRunnerForTest(null);
  B._setHookRunnerForTest(null);
  B._setFirstAdminSetupDepsForTest(null);
  B._setOwnerCheckForTest(null);
  for (const d of [TMP_HOME, TMP_BUNDLES]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const INSTALL = "2026-11-10T09:00:00.000Z";
const PASSPHRASE = "generated-Secret_1";
const SWITCH = "FX_ENABLE_REGISTRATION";

/** A crow/setup manifest that closes its own registration afterwards. */
const AFTER_MANIFEST = {
  id: "fx-app",
  name: "Fx App",
  description: "d",
  type: "bundle",
  category: "misc",
  origin: "official",
  webUI: { port: 4599, path: "/", label: "Fx App" },
  docker: { composefile: "docker-compose.yml" },
  firstAdmin: {
    mode: "crow",
    via: "setup",
    setup: {
      script: "scripts/first-admin.sh",
      timeout_s: 30,
      after: { env: { [SWITCH]: "false" }, recreate: true },
    },
    user: "admin",
    secretEnv: "FX_ADMIN_PASSWORD",
  },
  env_vars: [{ name: SWITCH, default: "true" }],
};

const withAfter = (after, over = {}) => {
  const setup = { ...AFTER_MANIFEST.firstAdmin.setup };
  if (after === undefined) delete setup.after;
  else setup.after = after;
  return { ...AFTER_MANIFEST, ...over, firstAdmin: { ...AFTER_MANIFEST.firstAdmin, setup } };
};

// ── 1. the declaration ──────────────────────────────────────────────────────────────

test("the after-step's rules: env and recreate only, declared names, plain short strings", () => {
  assert.deepEqual(firstAdminAfterProblems(AFTER_MANIFEST), [], "the shipped shape is usable");
  assert.equal(firstAdminAfterPlan(AFTER_MANIFEST).recreate, true);
  assert.deepEqual(firstAdminAfterPlan(AFTER_MANIFEST).env, { [SWITCH]: "false" });

  // No after-step at all is not a problem, and plans to nothing.
  const none = withAfter(undefined);
  assert.deepEqual(firstAdminAfterProblems(none), []);
  assert.equal(firstAdminAfterPlan(none), null);

  // A key the bundle does not declare would put a variable in .env that nothing asked for.
  assert.match(firstAdminAfterProblems(withAfter({ env: { FX_NOT_DECLARED: "1" } })).join(" "), /must name a declared env_vars entry/);
  // Values are plain strings, short ones.
  assert.match(firstAdminAfterProblems(withAfter({ env: { [SWITCH]: true } })).join(" "), /must be a plain string/);
  assert.match(firstAdminAfterProblems(withAfter({ env: { [SWITCH]: "x".repeat(FIRST_ADMIN_AFTER_MAX_VALUE + 1) } })).join(" "), /at most 200 characters/);
  // Only the two fields exist.
  assert.match(firstAdminAfterProblems(withAfter({ env: { [SWITCH]: "false" }, restart: true })).join(" "), /may only carry env and recreate/);
  assert.equal(firstAdminAfterProblems(withAfter({ recreate: "yes" })).join(" ").includes("must be a boolean"), true);
  // A block that does nothing is a mistake, not a no-op.
  assert.match(firstAdminAfterProblems(withAfter({})).join(" "), /does nothing/);
  assert.match(firstAdminAfterProblems(withAfter({ env: {} })).join(" "), /does nothing/);
  assert.match(firstAdminAfterProblems(withAfter({ recreate: false })).join(" "), /does nothing/);
  // Not an object at all.
  assert.match(firstAdminAfterProblems(withAfter([SWITCH])).join(" "), /must be an object/);
  // An env-only block is fine: some apps need a value but restart themselves.
  assert.deepEqual(firstAdminAfterProblems(withAfter({ env: { [SWITCH]: "false" } })), []);
  assert.deepEqual(firstAdminAfterPlan(withAfter({ env: { [SWITCH]: "false" } })), { env: { [SWITCH]: "false" }, recreate: false });
});

test("the manifest contract refuses what the runtime would not do", () => {
  const bundleExists = (id) => existsSync(join(REPO, "bundles", id, "manifest.json"));
  const dir = mkdtempSync(join(tmpdir(), "crow-fa-after-contract-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "first-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
    // The id must equal the directory name, so the fixture is built inside its own folder.
    const bundleDir = join(dir, "fx-app");
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(join(bundleDir, "scripts"), { recursive: true });
    writeFileSync(join(bundleDir, "scripts", "first-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(bundleDir, "docker-compose.yml"), "services:\n  app:\n    image: busybox\n");
    const validate = (manifest) => validateManifest(manifest, bundleDir, { bundleExists }).errors;

    assert.deepEqual(validate(AFTER_MANIFEST), [], "the usable declaration passes");
    assert.match(validate(withAfter({ env: { FX_NOT_DECLARED: "1" } })).join(" "), /after\.env FX_NOT_DECLARED must name a declared env_vars entry/);
    // A non-string value is refused by the schema's own shape check before the rules run.
    const notString = validate(withAfter({ env: { [SWITCH]: 1 } })).join(" ");
    assert.match(notString, /FX_ENABLE_REGISTRATION/);
    assert.match(notString, /must be (a plain )?string/);
    assert.match(validate(withAfter({ recreate: "yes" })).join(" "), /after(\/recreate|\.recreate) must be (a )?boolean/);
    // An unknown field is refused by the schema (additionalProperties: false) before the rules.
    assert.match(validate(withAfter({ env: { [SWITCH]: "false" }, when: "now" })).join(" "), /after (may only carry env and recreate|must NOT have additional properties)/);
    // The schema refuses the same shapes before the contract logic runs.
    assert.equal(validate(withAfter({ env: { [SWITCH]: "x".repeat(FIRST_ADMIN_AFTER_MAX_VALUE + 1) } })).length > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real vikunja manifest passes the contract with its after-step", () => {
  const vikunjaDir = join(REPO, "bundles", "vikunja");
  const manifest = JSON.parse(readFileSync(join(vikunjaDir, "manifest.json"), "utf8"));
  const { errors } = validateManifest(manifest, vikunjaDir, { bundleExists: (id) => existsSync(join(REPO, "bundles", id, "manifest.json")) });
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest.firstAdmin.setup.after, { env: { VIKUNJA_ENABLE_REGISTRATION: "false" }, recreate: true });
});

// ── 2. applyFirstAdminAfter, over its seams ─────────────────────────────────────────

test("nothing declared: no write, no restart", async () => {
  let calls = 0;
  const out = await applyFirstAdminAfter({
    bundleId: "fx-app",
    manifest: withAfter(undefined),
    destDir: "/nonexistent",
    writeEnv: () => { calls++; },
    recreate: async () => { calls++; return { ok: true }; },
  });
  assert.deepEqual({ ...out }, { ok: true, applied: false, outcome: null, line: null, reason: null });
  assert.equal(calls, 0);
});

test("env is written with the bundle's own writer, then the bundle is recreated exactly once", async () => {
  const order = [];
  const written = [];
  const recreated = [];
  const out = await applyFirstAdminAfter({
    bundleId: "fx-app",
    manifest: AFTER_MANIFEST,
    destDir: "/tmp/fx-app",
    writeEnv: (dir, values) => { order.push("env"); written.push({ dir, values }); },
    recreate: async (id) => { order.push("recreate"); recreated.push(id); return { ok: true, recreated: true }; },
  });
  assert.deepEqual(out, { ok: true, applied: true, outcome: "applied", line: 'after: "applied"', reason: null });
  assert.deepEqual(written, [{ dir: "/tmp/fx-app", values: { [SWITCH]: "false" } }]);
  assert.deepEqual(recreated, ["fx-app"], "one recreate, for this bundle");
  assert.deepEqual(order, ["env", "recreate"], "the value is on disk before the restart reads it");
});

test("an env-only after-step writes and does not restart", async () => {
  let recreated = 0;
  const out = await applyFirstAdminAfter({
    bundleId: "fx-app",
    manifest: withAfter({ env: { [SWITCH]: "false" } }),
    destDir: "/tmp/fx-app",
    writeEnv: () => {},
    recreate: async () => { recreated++; return { ok: true }; },
  });
  assert.equal(out.ok, true);
  assert.equal(recreated, 0);
});

test("an env write that fails is reported and skips the restart", async () => {
  let recreated = 0;
  const out = await applyFirstAdminAfter({
    bundleId: "fx-app",
    manifest: AFTER_MANIFEST,
    destDir: "/tmp/fx-app",
    writeEnv: () => { throw Object.assign(new Error("read-only"), { code: "EACCES" }); },
    recreate: async () => { recreated++; return { ok: true }; },
  });
  assert.equal(out.ok, false);
  assert.equal(recreated, 0, "nothing is restarted for a value that is not on disk");
  assert.match(out.line, /^after: "env-failed: EACCES"$/);
  assert.equal(out.applied, false);
});

test("a recreate that fails is one plain line, and never throws", async () => {
  for (const [stub, want] of [
    [async () => ({ ok: false, code: "compose_security_check", reason: "Security check failed: host networking needs consent" }), /recreate-failed: Security check failed/],
    [async () => { throw Object.assign(new Error("exit 1"), { stderr: "port is already allocated\n" }); }, /recreate-failed: port is already allocated/],
    [async () => ({ ok: false }), /recreate-failed: the bundle could not be restarted/],
  ]) {
    const out = await applyFirstAdminAfter({ bundleId: "fx-app", manifest: AFTER_MANIFEST, destDir: "/tmp/fx-app", writeEnv: () => {}, recreate: stub });
    assert.equal(out.ok, false);
    assert.match(out.line, want);
    assert.equal(out.line.split("\n").length, 1, "one line, whatever the failure printed");
    assert.equal(out.line.includes("\n"), false);
  }
  assert.match(firstAdminAfterFailureSentence("Fx App"), /could not apply the follow-up change to Fx App/);
  assert.match(firstAdminAfterFailureSentence("Fx App"), /registration may still be open: press Restart/);
});

// ── 3. a bundle that ships its script, installed for real (no docker) ───────────────

const composeCalls = [];

/** The stubs every install here needs: no docker daemon is ever touched. */
function stubDocker({ failRecreate = false } = {}) {
  B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  B._setComposeConfigRunnerForTest(async (_args, { cwd }) => ({
    stdout: JSON.stringify({ name: cwd.split("/").pop(), services: { app: { image: "busybox:1.36" } } }),
    stderr: "",
  }));
  B._setComposeRunnerForTest(async (args) => {
    composeCalls.push(args);
    if (failRecreate && args.includes("--force-recreate")) {
      throw Object.assign(new Error("exit 1"), { stderr: "port is already allocated" });
    }
    return { stdout: "", stderr: "" };
  });
  B._setHookRunnerForTest(null);
}
function unstubDocker() {
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  B._setComposeConfigRunnerForTest(null);
  B._setHookRunnerForTest(null);
  B._setFirstAdminSetupDepsForTest(null);
}

/** A crow/setup bundle WITH an after-step, in the source tree the installer copies from. */
function afterBundle(id) {
  const manifest = { ...AFTER_MANIFEST, id, name: `${id} app` };
  const dir = join(TMP_BUNDLES, id);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  app:\n    image: busybox\n");
  writeFileSync(join(dir, "scripts", "first-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
  return manifest;
}

/** The setup-run seams: the script succeeds and the password is "saved", nothing else. */
function setupSeams({ result = "ok" } = {}) {
  const saves = [];
  const deps = {
    runScript: async () => {
      if (result !== "ok") throw Object.assign(new Error("exit 4"), { exitCode: 4, stdout: "", stderr: "nothing is listening" });
      return { stdout: "registered the account\n", stderr: "" };
    },
    openDb: () => ({ close() {} }),
    hasSaved: async () => false,
    ensureWriteKey: async () => ({ id: "k1" }),
    newSecret: () => PASSPHRASE,
    save: async (_db, _key, entry) => { saves.push(entry); return { id: 1 }; },
    writeMarker: async () => true,
    now: () => Date.parse(INSTALL),
    warn: () => {},
  };
  return { deps, saves };
}

async function installBundle(id, manifest) {
  const job = B._createJobForTest(id, "install");
  try {
    return { out: await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest }), job };
  } finally {
    B._finishJobForTest(job, "complete");
  }
}

const installedEnv = (id) => {
  try { return parseEnvText(readFileSync(join(TMP_HOME, "bundles", id, ".env"), "utf8")); } catch { return null; }
};

test("the install path applies the after-step once, after an ok run, and the .env really carries it", async () => {
  const id = "fx-after-ok";
  const manifest = afterBundle(id);
  composeCalls.length = 0;
  stubDocker();
  const { deps, saves } = setupSeams();
  B._setFirstAdminSetupDepsForTest(deps);
  try {
    const { out, job } = await installBundle(id, manifest);
    assert.equal(out.ok, true, out.reason);
    assert.equal(saves.length, 1, "the password was kept");
    assert.equal(installedEnv(id)[SWITCH], "false", "the installed .env carries the value");
    assert.equal(composeCalls.filter((a) => a.includes("--force-recreate")).length, 1, "the bundle is recreated exactly once");
    const log = job.log.join("\n");
    assert.match(log, /^after: "applied"$/m);
    assert.equal(/press Restart/.test(log), false, "there is nothing to press Restart for");
  } finally {
    unstubDocker();
  }
});

test("the install path runs no after-step when the setup script did not finish", async () => {
  const id = "fx-after-kept";
  const manifest = afterBundle(id);
  composeCalls.length = 0;
  stubDocker();
  const { deps } = setupSeams({ result: "not-running" });
  B._setFirstAdminSetupDepsForTest(deps);
  try {
    const { out, job } = await installBundle(id, manifest);
    assert.equal(out.ok, true, "the install itself is fine");
    assert.equal(composeCalls.filter((a) => a.includes("--force-recreate")).length, 0, "nothing is restarted");
    assert.equal(installedEnv(id)?.[SWITCH], undefined, "and nothing is written");
    const log = job.log.join("\n");
    assert.equal(/after:/.test(log), false, "no after line at all");
    assert.match(log, /could not set up fx-after-kept app's admin login/);
  } finally {
    unstubDocker();
  }
});

test("a failed recreate is reported as one plain line, and the account is still Crow's", async () => {
  const id = "fx-after-recreate-fails";
  const manifest = afterBundle(id);
  composeCalls.length = 0;
  stubDocker({ failRecreate: true });
  const { deps, saves } = setupSeams();
  B._setFirstAdminSetupDepsForTest(deps);
  try {
    const { out, job } = await installBundle(id, manifest);
    assert.equal(out.ok, true, "the install is not failed by the follow-up step");
    assert.equal(saves.length, 1, "the password stays saved: the app holds it");
    assert.equal(installedEnv(id)[SWITCH], "false", "the value is on disk, so a manual Restart applies it");
    const log = job.log.join("\n");
    assert.match(log, /^after: "recreate-failed: port is already allocated"$/m);
    assert.match(log, /registration may still be open: press Restart on the Extensions card/);
  } finally {
    unstubDocker();
  }
});

// ── 4. the same, from the Extensions card's route ───────────────────────────────────

/** Seed a REVIEWED manifest plus an installed copy and the install record. */
function seedInstalled(manifest) {
  for (const root of [TMP_BUNDLES, join(TMP_HOME, "bundles")]) {
    const dir = join(root, manifest.id);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(dir, "docker-compose.yml"), "services:\n  app:\n    image: busybox\n");
    writeFileSync(join(dir, "scripts", "first-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
  }
  const path = join(TMP_HOME, "installed.json");
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  writeFileSync(path, JSON.stringify([...current.filter((e) => e && e.id !== manifest.id), { id: manifest.id, type: "bundle", version: "1.0.0", installedAt: INSTALL }], null, 2));
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  B._setOwnerCheckForTest(() => true);
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    return await fn(post);
  } finally {
    server.close();
    B._setOwnerCheckForTest(null);
  }
}

test("the card's route reports the after-step's plain outcome and writes the value", async () => {
  const id = "fx-after-route";
  const manifest = { ...AFTER_MANIFEST, id, name: "Fx Route App" };
  seedInstalled(manifest);
  composeCalls.length = 0;
  stubDocker();
  const { deps, saves } = setupSeams();
  B._setFirstAdminSetupDepsForTest(deps);
  try {
    await withServer(async (post) => {
      const r = await post("/bundles/api/first-admin-auto", { bundle_id: id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.result, "ok");
      assert.equal(r.body.after, "applied", "the response carries the plain outcome");
      assert.equal(r.body.log.some((l) => l === 'after: "applied"'), true, "and the log line");
      assert.equal(installedEnv(id)[SWITCH], "false");
    });
    assert.equal(saves.length, 1);
    assert.equal(composeCalls.filter((a) => a.includes("--force-recreate")).length, 1);
  } finally {
    unstubDocker();
  }
});

test("the card's route says a failed recreate may have left registration open, and keeps the login", async () => {
  const id = "fx-after-route-fail";
  const manifest = { ...AFTER_MANIFEST, id, name: "Fx Route App" };
  seedInstalled(manifest);
  composeCalls.length = 0;
  stubDocker({ failRecreate: true });
  const { deps, saves } = setupSeams();
  B._setFirstAdminSetupDepsForTest(deps);
  try {
    await withServer(async (post) => {
      const r = await post("/bundles/api/first-admin-auto", { bundle_id: id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true, "the login was created; only the follow-up failed");
      assert.match(r.body.after, /^recreate-failed: /);
      assert.equal(r.body.log.some((l) => /registration may still be open: press Restart/.test(l)), true);
      assert.equal(r.body.message.includes("Settings → Passwords"), true, "the login sentence is unchanged");
    });
    assert.equal(saves.length, 1, "the password is kept by the keychain save");
  } finally {
    unstubDocker();
  }
});

test("the route's answer carries no after field for an app that declares none", async () => {
  const id = "fx-after-none";
  const plain = { ...AFTER_MANIFEST, id, name: "Fx Plain App", firstAdmin: { ...AFTER_MANIFEST.firstAdmin, setup: { script: "scripts/first-admin.sh", timeout_s: 30 } } };
  seedInstalled(plain);
  composeCalls.length = 0;
  stubDocker();
  const { deps } = setupSeams();
  B._setFirstAdminSetupDepsForTest(deps);
  try {
    await withServer(async (post) => {
      const r = await post("/bundles/api/first-admin-auto", { bundle_id: id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal("after" in r.body, false, "nothing to report");
      assert.equal(installedEnv(id)?.[SWITCH], undefined, "and nothing written");
    });
    assert.equal(composeCalls.filter((a) => a.includes("--force-recreate")).length, 0, "and nothing restarted");
  } finally {
    unstubDocker();
  }
});

// ── 5. recreateBundleGuarded itself: the guards a Start runs ────────────────────────

const guarded = (id) => B._recreateBundleGuardedForTest(id);

/** An installed record for one bundle (its folders + entry). */
function seedEntry(id, compose = "services:\n  app:\n    image: busybox\n", entry = {}) {
  const manifest = { id, name: `${id} app`, type: "bundle", version: "1.0.0", category: "misc", ...entry };
  for (const root of [TMP_BUNDLES, join(TMP_HOME, "bundles")]) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    if (compose !== null) writeFileSync(join(dir, "docker-compose.yml"), compose);
  }
  const path = join(TMP_HOME, "installed.json");
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  writeFileSync(path, JSON.stringify([...current.filter((e) => e && e.id !== id), { id, type: "bundle", version: "1.0.0", installedAt: INSTALL }], null, 2));
}

test("the guarded recreate refuses a bundle that is not installed here", async () => {
  composeCalls.length = 0;
  stubDocker();
  try {
    const out = await guarded("fx-not-installed");
    assert.equal(out.ok, false);
    assert.equal(out.code, "not_installed");
    assert.equal(composeCalls.length, 0, "nothing is started for a bundle this instance does not have");
  } finally {
    unstubDocker();
  }
});

test("the guarded recreate never restarts a satellite's containers (they run on another host)", async () => {
  const id = "fx-sat";
  seedEntry(id);
  const path = join(TMP_HOME, "installed.json");
  const current = JSON.parse(readFileSync(path, "utf8"));
  current[current.findIndex((e) => e.id === id)] = { id, type: "bundle", version: "1.0.0", mode: "satellite", host: "other", installedAt: INSTALL };
  writeFileSync(path, JSON.stringify(current, null, 2));
  composeCalls.length = 0;
  stubDocker();
  try {
    const out = await guarded(id);
    assert.equal(out.ok, false);
    assert.equal(out.code, "satellite");
    assert.match(out.reason, /runs on another instance/);
    assert.equal(composeCalls.length, 0, "a satellite's containers are its own host's business");
  } finally {
    unstubDocker();
  }
});

test("a bundle with no compose file has no containers to recreate", async () => {
  const id = "fx-nocompose";
  seedEntry(id, null);
  composeCalls.length = 0;
  stubDocker();
  try {
    assert.deepEqual({ ...(await guarded(id)) }, { ok: true, recreated: false });
    assert.equal(composeCalls.length, 0);
  } finally {
    unstubDocker();
  }
});

test("the compose safety check still refuses what a Start would refuse", async () => {
  const id = "fx-host-net";
  seedEntry(id, "services:\n  app:\n    image: busybox\n    network_mode: host\n");
  composeCalls.length = 0;
  stubDocker();
  // The model Compose would apply carries the host network (the check reads this, not the text).
  B._setComposeConfigRunnerForTest(async (_args, { cwd }) => ({
    stdout: JSON.stringify({ name: cwd.split("/").pop(), services: { app: { image: "busybox:1.36", network_mode: "host" } } }),
    stderr: "",
  }));
  try {
    const out = await guarded(id);
    assert.equal(out.ok, false);
    assert.equal(out.code, "compose_security_check", out.reason);
    assert.match(out.reason, /Security check failed/);
    assert.equal(composeCalls.filter((a) => a.includes("--force-recreate")).length, 0, "nothing is re-created after a refused check");
  } finally {
    unstubDocker();
  }
});

test("an ordinary installed bundle is re-created once, by force", async () => {
  const id = "fx-plain-recreate";
  seedEntry(id);
  composeCalls.length = 0;
  stubDocker();
  try {
    const out = await guarded(id);
    assert.deepEqual({ ...out }, { ok: true, recreated: true });
    assert.deepEqual(composeCalls, [["up", "-d", "--force-recreate"]]);
  } finally {
    unstubDocker();
  }
});