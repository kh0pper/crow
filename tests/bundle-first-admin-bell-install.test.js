/**
 * N3-4 phase 1 — the install path really rings the bell (one per install).
 *
 * The unit half lives in tests/bundle-first-admin-notice.test.js; this drives
 * the REAL runInstallJob against a scratch CROW_HOME + a real crow.db, because
 * the whole point of the finding is that installing uptime-kuma told the
 * operator nothing beyond "Installed: Uptime Kuma".
 *
 * Fails on the code before this change: runInstallJob never looked at
 * `firstAdmin`, so the notifications table held only the generic install row.
 *
 * Scratch CROW_HOME/CROW_DATA_DIR, no compose file in the fixtures (nothing for
 * docker to do), no ports (no ufw/tailscale calls).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-fa-bell-home-"));
const TMP_DATA = join(TMP_HOME, "data");
const TMP_BUNDLES = mkdtempSync(join(tmpdir(), "crow-fa-bell-bundles-"));
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
  cwd: join(import.meta.dirname, ".."),
});

const {
  runInstallJob,
  _createJobForTest,
  _finishJobForTest,
  _setAppBundlesForTest,
  _setRestartHookForTest,
  _setComposeRunnerForTest,
  _setDockerRunnerForTest,
  _setHookRunnerForTest,
  _setFirstAdminSetupDepsForTest,
  _setApiTokenDepsForTest,
} = await import("../servers/gateway/routes/bundles.js");
const { tryBeginFirstAdminSetup, endFirstAdminSetup } = await import("../servers/gateway/bundle-first-admin-setup.js");

_setAppBundlesForTest(TMP_BUNDLES);
_setRestartHookForTest(() => {});

after(() => {
  _setRestartHookForTest(null);
  _setComposeRunnerForTest(null);
  _setDockerRunnerForTest(null);
  _setHookRunnerForTest(null);
  _setFirstAdminSetupDepsForTest(null);
  _setApiTokenDepsForTest(null);
  for (const d of [TMP_HOME, TMP_BUNDLES]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** A source manifest in the fixture bundles root, as the installer copies from. */
function sourceManifest(id, extra) {
  const dir = join(TMP_BUNDLES, id);
  mkdirSync(dir, { recursive: true });
  const manifest = { id, name: `${id} app`, type: "bundle", version: "0.1.0", webUI: { port: 4599, path: "/", label: id }, ...extra };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * A source bundle that ships a compose file: the installer really tries to run
 * it, which is what the half-failure paths need. Nothing here reaches docker:
 * the compose and docker runners are stubbed per test.
 */
function composeManifest(id, extra) {
  const dir = join(TMP_BUNDLES, id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id, name: `${id} app`, type: "bundle", version: "0.1.0", category: "misc",
    docker: { composefile: "docker-compose.yml" },
    webUI: { port: 4599, path: "/", label: id },
    ...extra,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  app:\n    image: busybox\n");
  return manifest;
}

/** Run one install to its (possibly failing) outcome, always closing the job. */
async function installOutcome(id, manifest) {
  const job = _createJobForTest(id, "install");
  try {
    return await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  } finally {
    _finishJobForTest(job, "failed");
  }
}

/** The stubs every composed fixture needs: never touch a real docker daemon. */
function stubDocker({ upFails = false, hookFails = false } = {}) {
  _setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  _setComposeRunnerForTest(async (args) => {
    if (upFails && args[0] === "up") throw Object.assign(new Error("exit 1"), { stderr: "port is already allocated" });
    return { stdout: "", stderr: "" };
  });
  _setHookRunnerForTest(hookFails ? async () => { throw Object.assign(new Error("exit 7"), { stderr: "auth refused" }); } : null);
}
function unstubDocker() {
  _setComposeRunnerForTest(null);
  _setDockerRunnerForTest(null);
  _setHookRunnerForTest(null);
}

/** The bell rows this install path wrote (kind-tagged), newest last. */
async function firstAdminBells() {
  // The gateway's own client (better-sqlite3), the one the install path wrote
  // through: a second client on the same file can miss rows that are still only
  // in the write-ahead log.
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try {
    const { rows } = await db.execute({
      sql: "SELECT title, body, action_url, metadata FROM notifications WHERE metadata LIKE ? ORDER BY id",
      args: ['%"kind":"bundle-first-admin"%'],
    });
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
  } finally {
    db.close();
  }
}

async function install(id, manifest, installedSnapshot = []) {
  const job = _createJobForTest(id, "install");
  try {
    const out = await runInstallJob(id, {}, { job, installedSnapshot, consentVerified: false, manifest });
    assert.equal(out.ok, true, `install failed: ${out.reason}`);
    return out;
  } finally {
    _finishJobForTest(job, "complete");
  }
}

test("installing a finish-setup app rings ONE bell, naming it and linking its Extensions page", async () => {
  const manifest = sourceManifest("fx-kuma", { firstAdmin: { mode: "finish-setup" } });
  await install("fx-kuma", manifest);

  const bells = await firstAdminBells();
  assert.equal(bells.length, 1, "exactly one bell");
  assert.equal(bells[0].title, "Finish fx-kuma app's setup now");
  assert.match(bells[0].body, /can claim fx-kuma app's admin account/);
  assert.equal(bells[0].action_url, "/dashboard/extensions?q=fx-kuma");
  assert.deepEqual(bells[0].metadata, { kind: "bundle-first-admin", bundle: "fx-kuma", mode: "finish-setup" });
});

test("a crow app and a no-login app ring none", async () => {
  await install("fx-flux", sourceManifest("fx-flux", {
    firstAdmin: { mode: "crow", via: "env", secretEnv: "FX_ADMIN_PASSWORD" },
    env_vars: [{ name: "FX_ADMIN_PASSWORD", generate: "secret", keychain: true, secret: true }],
  }));
  await install("fx-dx", sourceManifest("fx-dx", { firstAdmin: { mode: "none" } }));
  assert.equal((await firstAdminBells()).filter((b) => b.metadata.bundle !== "fx-kuma").length, 0);
});

test("a reinstall over the SAME install record does not ring a second time", async () => {
  const manifest = sourceManifest("fx-kuma", { firstAdmin: { mode: "finish-setup" } });
  // The router re-validates and hands the snapshot it read — installed.json as
  // it stands, with this bundle's existing record and installedAt.
  const installedSnapshot = JSON.parse(readFileSync(join(TMP_HOME, "installed.json"), "utf8"));
  assert.ok(installedSnapshot.some((i) => i.id === "fx-kuma"), "the first install recorded it");
  await install("fx-kuma", manifest, installedSnapshot);
  const bells = (await firstAdminBells()).filter((b) => b.metadata.bundle === "fx-kuma");
  assert.equal(bells.length, 1, "still one bell for this install");
});

// ── the half-failed install still rings (review round 1, S3) ──
// A compose or hook failure leaves a recorded bundle the owner can finish with
// Configure + Start, so its first-run setup page is just as claimable. The notice
// used to sit after the early returns and was skipped on both paths.

test("a compose-up failure still rings the bell once", async () => {
  const manifest = composeManifest("fx-half-compose", { firstAdmin: { mode: "finish-setup" } });
  stubDocker({ upFails: true });
  try {
    const out = await installOutcome("fx-half-compose", manifest);
    assert.equal(out.ok, false, "the job still reports the failure");
    assert.match(out.reason, /compose up failed/);
  } finally {
    unstubDocker();
  }
  const bells = (await firstAdminBells()).filter((b) => b.metadata.bundle === "fx-half-compose");
  assert.equal(bells.length, 1, "the app that can still start asks for its setup now");
  assert.equal(bells[0].metadata.mode, "finish-setup");
});
test("a post-install hook failure still rings the bell once", async () => {
  const manifest = composeManifest("fx-half-hook", {
    firstAdmin: { mode: "finish-setup" },
    postInstall: { script: "scripts/setup.sh" },
  });
  mkdirSync(join(TMP_BUNDLES, "fx-half-hook", "scripts"), { recursive: true });
  writeFileSync(join(TMP_BUNDLES, "fx-half-hook", "scripts", "setup.sh"), "#!/bin/sh\nexit 7\n");
  stubDocker({ hookFails: true });
  try {
    const out = await installOutcome("fx-half-hook", manifest);
    assert.equal(out.ok, false, "the job still reports the failure");
    assert.match(out.reason, /post-install setup failed/);
  } finally {
    unstubDocker();
  }
  const bells = (await firstAdminBells()).filter((b) => b.metadata.bundle === "fx-half-hook");
  assert.equal(bells.length, 1, "installed and running, setup incomplete: still one bell");
  assert.equal(bells[0].metadata.mode, "finish-setup");
});

// ── phase 2a: Crow creates the admin itself (`firstAdmin.via: "setup"`) ──
// The install path runs the bundle's own script AFTER compose up succeeded, and the
// outcome decides whether the bell rings: silent when Crow created the login, one bell
// otherwise (the operator has to finish it, or save the login they already use).

/** A crow/setup bundle that ships its script, so the installer really runs one. */
function setupManifest(id) {
  const manifest = composeManifest(id, {
    firstAdmin: {
      mode: "crow",
      via: "setup",
      setup: { script: "scripts/first-admin.sh", timeout_s: 30 },
      user: "admin",
      secretEnv: "FX_ADMIN_PASSWORD",
    },
    env_vars: [{ name: "FX_ADMIN_PASSWORD", secret: true }],
  });
  mkdirSync(join(TMP_BUNDLES, id, "scripts"), { recursive: true });
  writeFileSync(join(TMP_BUNDLES, id, "scripts", "first-admin.sh"), "#!/bin/sh\nexit 0\n");
  return manifest;
}

test("a crow/setup install whose script succeeds rings no bell and logs the plain sentence", async () => {
  const id = "fx-fa-ok";
  const manifest = setupManifest(id);
  stubDocker({});
  _setFirstAdminSetupDepsForTest({
    runScript: async () => ({ stdout: "created the admin\n", stderr: "" }),
    save: async () => ({ id: 1 }),
    writeEnv: () => {},
  });
  try {
    const job = _createJobForTest(id, "install");
    const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    _finishJobForTest(job, "complete");
    assert.equal(out.ok, true, out.reason);
    const log = job.log.join("\n");
    assert.match(log, /created the admin/, "the script's own output reaches the install log");
    assert.match(log, new RegExp(`Crow created ${id} app's admin login \\(admin\\) and saved it in Settings → Passwords\\.`));
  } finally {
    _setFirstAdminSetupDepsForTest(null);
    unstubDocker();
  }
  assert.equal((await firstAdminBells()).filter((b) => b.metadata.bundle === id).length, 0, "Crow made the account: nothing to claim");
});

test("a crow/setup install whose script fails rings ONE bell, and the marker says failed", async () => {
  const id = "fx-fa-fail";
  const manifest = setupManifest(id);
  stubDocker({});
  _setFirstAdminSetupDepsForTest({
    runScript: async () => { throw Object.assign(new Error("exit 4"), { exitCode: 4, stdout: "", stderr: "nothing is listening\nexit 4" }); },
  });
  try {
    const job = _createJobForTest(id, "install");
    const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    _finishJobForTest(job, "complete");
    assert.equal(out.ok, true, "the install itself is fine; the app's admin is what is missing");
    assert.match(job.log.join("\n"), /could not set up fx-fa-fail app's admin login/);
  } finally {
    _setFirstAdminSetupDepsForTest(null);
    unstubDocker();
  }
  const bells = (await firstAdminBells()).filter((b) => b.metadata.bundle === id);
  assert.equal(bells.length, 1, "the app is running without the admin Crow meant to create");
  assert.equal(bells[0].title, `Finish ${id} app's setup now`);
  assert.match(bells[0].body, /Crow can create/);
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [`first_admin_auto:${id}`] });
    assert.equal(JSON.parse(rows[0].value).result, "not-running", "the card reads this word");
  } finally {
    db.close();
  }
});

test("a crow/setup install with no reviewed manifest runs nothing and logs the plain sentence", async () => {
  const id = "fx-fa-norepo";
  const manifest = setupManifest(id);
  // The installer validated a manifest the repo copy no longer has: nothing reviewed to run.
  rmSync(join(TMP_BUNDLES, id, "manifest.json"));
  stubDocker({});
  let ran = 0;
  _setFirstAdminSetupDepsForTest({ runScript: async () => { ran++; return { stdout: "", stderr: "" }; } });
  try {
    const job = _createJobForTest(id, "install");
    const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    _finishJobForTest(job, "complete");
    assert.equal(out.ok, true, out.reason);
    assert.match(job.log.join("\n"), /This app can't be set up automatically; finish it in the app\./);
  } finally {
    _setFirstAdminSetupDepsForTest(null);
    unstubDocker();
  }
  assert.equal(ran, 0, "the installed copy's script is never a source");
  const bells = (await firstAdminBells()).filter((b) => b.metadata.bundle === id);
  assert.equal(bells.length, 1, "the operator hears about the admin that was not created");
});

test("an install never starts a setup script while the card's run is in flight", async () => {
  const id = "fx-fa-busy";
  const manifest = setupManifest(id);
  stubDocker({});
  let ran = 0;
  _setFirstAdminSetupDepsForTest({ runScript: async () => { ran++; return { stdout: "", stderr: "" }; } });
  assert.equal(tryBeginFirstAdminSetup(id), true, "the card's run holds the lock");
  try {
    const job = _createJobForTest(id, "install");
    const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    _finishJobForTest(job, "complete");
    assert.equal(out.ok, true, out.reason);
    assert.match(job.log.join("\n"), new RegExp(`Crow is already setting up ${id} app's admin login\\.`));
  } finally {
    endFirstAdminSetup(id);
    _setFirstAdminSetupDepsForTest(null);
    unstubDocker();
  }
  assert.equal(ran, 0, "the second script never started");
});

// ── the API token the app mints for Crow (`firstAdmin.setup.token`) ──
// The install path runs the token script only after `firstAdmin.setup` reported ok, under the
// same per-bundle lock, and never reconnects: a token written into the bundle's MCP entry is
// what `needsRestart` (the caller's one restart) is for.

/** A 40-hex token, the shape the fixture manifest's own `pattern` describes. */
const TOKEN = "0123456789abcdef0123456789abcdef01234567";

/** The same crow/setup bundle, declaring that its app mints an API token for Crow. */
function tokenSetupManifest(id) {
  const manifest = setupManifest(id);
  manifest.firstAdmin.setup.token = { script: "scripts/api-token.sh", env: "FX_API_TOKEN", timeout_s: 30 };
  manifest.env_vars.push({ name: "FX_API_TOKEN", description: "API token", secret: true, pattern: "^[0-9a-f]{40}$" });
  writeFileSync(join(TMP_BUNDLES, id, "manifest.json"), JSON.stringify(manifest, null, 2));
  mkdirSync(join(TMP_BUNDLES, id, "scripts"), { recursive: true });
  writeFileSync(join(TMP_BUNDLES, id, "scripts", "api-token.sh"), "#!/bin/sh\nexit 0\n");
  return manifest;
}

/** The setup half of a successful install: the admin script really reports ok. */
const SETUP_OK = {
  runScript: async () => ({ stdout: "created the admin\n", stderr: "" }),
  save: async () => ({ id: 1 }),
  writeEnv: () => {},
};

test("the install runs the API-token step after the admin succeeded, and asks for the restart", async () => {
  const id = "fx-token-ok";
  const manifest = tokenSetupManifest(id);
  stubDocker({});
  const saved = [];
  _setFirstAdminSetupDepsForTest(SETUP_OK);
  _setApiTokenDepsForTest({
    runner: async () => ({ stdout: "minted\n", stderr: "", secret: `${TOKEN}\n` }),
    save: async (o) => { saved.push(o); return { ok: true, needs_restart: true, needs_config: [] }; },
    warn: () => {},
  });
  try {
    const job = _createJobForTest(id, "install");
    const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    _finishJobForTest(job, "complete");
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.needsRestart, true, "the token went into the MCP entry: the caller's restart loads it");
    const log = job.log.join("\n");
    assert.match(log, /Connected Crow to fx-token-ok app with an API token it created/);
    assert.match(log, /minted/, "the script's own output is in the log, indented like the setup's");
    assert.equal(log.includes(TOKEN), false, "the token never reaches the install log");
    assert.equal(saved.length, 1, "one save");
    assert.deepEqual(
      { ...saved[0], manifest: "manifest" },
      {
        bundleId: id,
        manifest: "manifest",
        envKey: "FX_API_TOKEN",
        value: TOKEN,
        crowHome: TMP_HOME,
        origin: "generated",
        propagate: false,
        firstWriterWins: true,
      },
    );
  } finally {
    _setFirstAdminSetupDepsForTest(null);
    _setApiTokenDepsForTest(null);
    unstubDocker();
  }
});

test("a failed admin setup never runs the API-token step", async () => {
  const id = "fx-token-skip";
  const manifest = tokenSetupManifest(id);
  stubDocker({});
  let tokenRan = 0;
  _setFirstAdminSetupDepsForTest({
    runScript: async () => { throw Object.assign(new Error("exit 4"), { exitCode: 4, stdout: "", stderr: "nothing is listening\nexit 4" }); },
  });
  _setApiTokenDepsForTest({
    runner: async () => { tokenRan++; return { stdout: "", stderr: "", secret: `${TOKEN}\n` }; },
    warn: () => {},
  });
  try {
    const job = _createJobForTest(id, "install");
    const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    _finishJobForTest(job, "complete");
    assert.equal(out.ok, true, "the install itself is fine; the app's admin is what is missing");
    assert.match(job.log.join("\n"), /could not set up fx-token-skip app's admin login/);
    assert.equal(job.log.join("\n").includes("API token"), false, "nothing about a token either");
  } finally {
    _setFirstAdminSetupDepsForTest(null);
    _setApiTokenDepsForTest(null);
    unstubDocker();
  }
  assert.equal(tokenRan, 0, "no admin, no token: the token script needs one to sign in with");
});
