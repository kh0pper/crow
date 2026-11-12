/**
 * The boot CATCH-UP for first-admin setup (servers/gateway/bundle-first-admin-catchup.js).
 *
 * The install path runs a `crow`/`via: "setup"` bundle's script once, right after `compose up`
 * succeeded. An install made before that shipped — or one whose app was not up yet — waited for
 * the operator to press "Set it up for me". Once per boot, after the add-ons settle, the
 * catch-up gives each of them exactly the run the card's button starts, and only when every
 * gate says so:
 *
 *   - the installed entry is not satellite-hosted,
 *   - the REVIEWED manifest declares a setup plan Crow may run (not refused) and is not an
 *     invite-only app,
 *   - the keychain does not already hold this bundle's admin login,
 *   - `first_admin_auto:<id>` has no result for THIS install — except "not-running", which is
 *     retried on the next boot only ("ok", "kept" and "failed" are never re-run),
 *   - the app is running,
 *   - the per-bundle first-admin lock is free.
 *
 * Every seam is injected: no database, no docker, no app. What this file pins down is the
 * gating, "one run under the lock, released always", the reconnect on mcpEnvUpdated, the
 * after-step parity with the card's route, that one bundle cannot stop the others, and that NO
 * password can reach a log line. The last test runs the REAL runFirstAdminSetup through the
 * catch-up with a sentinel password.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { captureOutput } from "./helpers/sentinel-scan.mjs";

const { runFirstAdminCatchUp } = await import("../servers/gateway/bundle-first-admin-catchup.js");
const { runFirstAdminSetup } = await import("../servers/gateway/bundle-first-admin-setup.js");
const { FIRST_ADMIN_AUTO_PREFIX } = await import("../servers/gateway/bundle-first-admin.js");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "crow-first-admin-catchup-"));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const ID = "frig";
const INSTALL = "2026-12-01T09:00:00.000Z";
const REINSTALL = "2026-12-02T09:00:00.000Z";
const SECRET_ENV = "FRIGATE_PASSWORD";

const MANIFEST = {
  id: ID,
  name: "Frigate",
  type: "bundle",
  category: "cameras",
  origin: "official",
  webUI: { port: 8971, path: "/", label: "Frigate" },
  env_vars: [{ name: SECRET_ENV, description: "the admin password", secret: true }],
  firstAdmin: {
    mode: "crow",
    via: "setup",
    setup: { script: "scripts/first-admin.sh", timeout_s: 30 },
    user: "admin",
    secretEnv: SECRET_ENV,
  },
};

/**
 * A full seam set over one bundle. `state` is what a test pokes (markers, the keychain, the
 * run's own answer) and what it reads back (calls).
 */
function harness({ overrides = {}, deps: extra = {} } = {}) {
  const state = {
    installed: [{ id: ID, installedAt: INSTALL }],
    manifest: MANIFEST,
    settings: {},
    transport: "stdio",
    savedKey: null,
    running: true,
    result: "ok",
    mcpEnvUpdated: false,
    afterAnswer: { ok: true, applied: true, outcome: "applied", line: 'after: "applied"', reason: null },
    calls: { run: [], reconnect: [], after: [], notify: [], begun: [], ended: [], warned: [] },
  };
  const deps = {
    appBundles: () => "/reviewed",
    bundlesDir: () => "/installed",
    crowHome: () => "/home/crow",
    setupDeps: () => ({ tag: "setup-deps" }),
    listInstalled: () => state.installed,
    getManifest: () => state.manifest,
    readSetting: (key) => (key in state.settings ? state.settings[key] : null),
    mcpTransport: () => state.transport,
    hasAdminSaved: (id, key) => state.savedKey === key,
    appRunning: () => state.running,
    tryBegin: (id) => { state.calls.begun.push(id); return true; },
    end: (id) => { state.calls.ended.push(id); },
    runSetup: async (o) => {
      state.calls.run.push(o);
      return { result: state.result, log: [], ...(state.mcpEnvUpdated ? { mcpEnvUpdated: true } : {}) };
    },
    applyAfter: async (o) => { state.calls.after.push(o); return state.afterAnswer; },
    recreate: async () => ({ ok: true, recreated: true }),
    reconnect: async (id) => { state.calls.reconnect.push(id); return { ok: true }; },
    reportAfterFailure: async (o) => { state.calls.notify.push(o); return null; },
    warn: (m) => { state.calls.warned.push(String(m)); },
    ...extra,
  };
  if (overrides.result) state.result = overrides.result;
  if (overrides.manifest !== undefined) state.manifest = overrides.manifest;
  if (overrides.installed) state.installed = overrides.installed;
  if (overrides.settings) state.settings = overrides.settings;
  if (overrides.transport) state.transport = overrides.transport;
  if (overrides.savedKey !== undefined) state.savedKey = overrides.savedKey;
  if (overrides.running !== undefined) state.running = overrides.running;
  if (overrides.mcpEnvUpdated) state.mcpEnvUpdated = true;
  if (overrides.afterAnswer) state.afterAnswer = overrides.afterAnswer;
  return { deps, state };
}

const marker = (install, result) => JSON.stringify({ install, result });

// ── the happy path ────────────────────────────────────────────────────────────────

test("an un-recorded install gets exactly the run the card's button starts", async () => {
  const { deps, state } = harness();
  const summary = await runFirstAdminCatchUp({ deps });

  assert.deepEqual(summary, { checked: 1, ran: [{ id: ID, result: "ok" }] });
  assert.equal(state.calls.run.length, 1, "one run");
  const call = state.calls.run[0];
  assert.equal(call.bundleId, ID);
  assert.equal(call.manifest, MANIFEST, "the REVIEWED manifest, never the installed copy");
  assert.equal(call.scriptDir, "/reviewed/frig", "the script comes from Crow's own copy of the bundle");
  assert.equal(call.destDir, "/installed/frig", "the installed folder is the working directory");
  assert.equal(call.installId, INSTALL, "the marker is written for THIS install");
  assert.equal(call.crowHome, "/home/crow");
  assert.equal(call.holdsLock, true, "the catch-up holds the lock, so the run must not take it again");
  assert.deepEqual(call.deps, { tag: "setup-deps" }, "the caller's own setup seams");
  assert.deepEqual(state.calls.begun, [ID], "under the same per-bundle lock the install path takes");
  assert.deepEqual(state.calls.ended, [ID], "and released again");
  assert.deepEqual(state.calls.reconnect, [], "nothing was written to the MCP entry, so nothing reconnects");
});

test("an installed entry records its stamp as installed_at too", async () => {
  const { deps, state } = harness({ overrides: { installed: [{ id: ID, installed_at: INSTALL }] } });
  const summary = await runFirstAdminCatchUp({ deps });
  assert.deepEqual(summary.ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.run[0].installId, INSTALL);
});

// ── the gates ────────────────────────────────────────────────────────────────────

test("a run recorded for THIS install is never repeated (ok, kept or failed)", async () => {
  for (const result of ["ok", "kept", "failed"]) {
    const { deps, state } = harness({ overrides: { settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: marker(INSTALL, result) } } });
    assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, [], result);
    assert.equal(state.calls.run.length, 0, result);
    assert.equal(state.calls.begun.length, 0, `${result}: not even the lock is taken for a finished install`);
  }
});

test("'not-running' is retried on the next boot (the app may be up now)", async () => {
  const { deps, state } = harness({ overrides: { settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: marker(INSTALL, "not-running") } } });
  assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.run.length, 1);
});

test("a different installedAt (a reinstall) is its own install, so it runs again", async () => {
  const { deps, state } = harness({ overrides: { settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: marker(REINSTALL, "failed") } } });
  assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.run.length, 1, "another install's failure is not this install's answer");
});

test("an unreadable marker is not a result: the run happens", async () => {
  const { deps, state } = harness({ overrides: { settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: "{not json" } } });
  assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.run.length, 1);
});

test("a login the keychain already holds is left alone", async () => {
  {
    const { deps, state } = harness({ overrides: { savedKey: SECRET_ENV } });
    assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0, "the card's own 'nothing left to ask' signal");
  }
  {
    // A manifest that declares no secretEnv looks under the generic admin key.
    const plain = { ...MANIFEST, firstAdmin: { ...MANIFEST.firstAdmin, secretEnv: undefined } };
    const { deps, state } = harness({ overrides: { manifest: plain, savedKey: "APP_ADMIN_PASSWORD" } });
    assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0);
  }
});

test("an app that is not running is skipped, and nothing is recorded (the next boot asks again)", async () => {
  const { deps, state } = harness({ overrides: { running: false } });
  assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, []);
  assert.equal(state.calls.run.length, 0);
  assert.equal(state.calls.begun.length, 0);
});

test("a satellite-hosted entry is skipped, whichever way it says so", async () => {
  {
    const { deps, state } = harness({ overrides: { installed: [{ id: ID, mode: "satellite", installedAt: INSTALL }] } });
    assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0, "its own box runs its setup");
  }
  {
    const { deps, state } = harness({ overrides: { transport: "satellite" } });
    assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0);
  }
});

test("a run already in flight is skipped silently", async () => {
  const { deps, state } = harness({ deps: { tryBegin: (id) => { state.calls.begun.push(id); return false; } } });
  assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, []);
  assert.equal(state.calls.run.length, 0, "the other run owns this boot's answer");
  assert.deepEqual(state.calls.ended, [], "and a lock this pass never took is never released");
});

test("a declaration Crow may not run is skipped: no plan, refused, invite-only", async () => {
  const cases = {
    "finish-setup": { ...MANIFEST, firstAdmin: { mode: "finish-setup" } },
    "no firstAdmin": { ...MANIFEST, firstAdmin: undefined },
    community: { ...MANIFEST, origin: "community" },
    "invite-only": { ...MANIFEST, firstAdmin: { mode: "finish-setup", invite: "vaultwarden" } },
  };
  for (const [name, manifest] of Object.entries(cases)) {
    const { deps, state } = harness({ overrides: { manifest } });
    assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, [], name);
    assert.equal(state.calls.run.length, 0, name);
    assert.equal(state.calls.begun.length, 0, `${name}: not even the lock is taken`);
  }
});

// ── what the run's result means for the rest of the pass ────────────────────────

test("a run that wrote the MCP entry reconnects that add-on once, and never restarts the gateway", async () => {
  const { deps, state } = harness({ overrides: { mcpEnvUpdated: true } });
  assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
  assert.deepEqual(state.calls.reconnect, [ID], "the same reconnect the API-token catch-up does after a save");
});

test("a run that changed nothing reconnects nothing", async () => {
  for (const result of ["ok", "kept", "not-running", "failed"]) {
    const { deps, state } = harness({ overrides: { result } });
    await runFirstAdminCatchUp({ deps });
    assert.deepEqual(state.calls.reconnect, [], result);
  }
});

test("a 'busy' answer from the run records nothing and reconnects nothing", async () => {
  const { deps, state } = harness({ overrides: { result: "busy", mcpEnvUpdated: true } });
  assert.deepEqual((await runFirstAdminCatchUp({ deps })).ran, []);
  assert.deepEqual(state.calls.reconnect, []);
});

test("the manifest's after-step runs exactly as the card's route runs it", async () => {
  const manifest = {
    ...MANIFEST,
    env_vars: [...MANIFEST.env_vars, { name: "FRIGATE_SIGNUPS", default: "true" }],
    firstAdmin: {
      ...MANIFEST.firstAdmin,
      setup: { ...MANIFEST.firstAdmin.setup, after: { env: { FRIGATE_SIGNUPS: "false" } } },
    },
  };
  const { deps, state } = harness({ overrides: { manifest } });
  const summary = await runFirstAdminCatchUp({ deps });

  assert.deepEqual(summary.ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.after.length, 1, "the follow-up step ran");
  assert.equal(state.calls.after[0].bundleId, ID);
  assert.equal(state.calls.after[0].manifest, manifest, "the reviewed manifest");
  assert.equal(state.calls.after[0].destDir, "/installed/frig");
  assert.equal(typeof state.calls.after[0].recreate, "function", "the guarded recreate needs no request");
  assert.deepEqual(state.calls.notify, [], "a follow-up that succeeded rings nothing");
});

test("an after-step that failed rings the one bell the card's route rings", async () => {
  const manifest = {
    ...MANIFEST,
    env_vars: [...MANIFEST.env_vars, { name: "FRIGATE_SIGNUPS", default: "true" }],
    firstAdmin: {
      ...MANIFEST.firstAdmin,
      setup: { ...MANIFEST.firstAdmin.setup, after: { env: { FRIGATE_SIGNUPS: "false" }, recreate: true } },
    },
  };
  const { deps, state } = harness({
    overrides: { manifest, afterAnswer: { ok: false, applied: false, outcome: "recreate-failed: port is taken", line: 'after: "x"', reason: "port is taken" } },
  });
  const summary = await runFirstAdminCatchUp({ deps });

  assert.deepEqual(summary.ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.notify.length, 1, "the card is already hidden by the saved login: the bell is the signal");
  assert.equal(state.calls.notify[0].bundleId, ID);
  assert.equal(state.calls.notify[0].installId, INSTALL);
  assert.equal(state.calls.notify[0].autoResult, "ok");
  assert.deepEqual(state.calls.notify[0].afterResult, { ok: false, outcome: "recreate-failed: port is taken" });
  assert.equal(JSON.stringify(state.calls.notify[0].afterResult).includes("port is taken"), true, "the reason, never a value");
});

test("an after-step that cannot be performed here is left to the card, with one log line", async () => {
  const manifest = {
    ...MANIFEST,
    firstAdmin: { ...MANIFEST.firstAdmin, setup: { ...MANIFEST.firstAdmin.setup, after: { recreate: true } } },
  };
  // A caller with no recreate seam at all (null, not undefined: the seam lookup falls back to
  // the real deps only for an absent one) cannot perform the step, so it is left to the card.
  const { deps, state } = harness({ overrides: { manifest }, deps: { recreate: null } });
  const summary = await runFirstAdminCatchUp({ deps });
  assert.deepEqual(summary.ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.after.length, 0, "not half-applied: the card can still do it");
  assert.equal(state.calls.warned.length, 1);
  assert.match(state.calls.warned[0], /Extensions card can/);
});

// ── it never throws, and never leaks ────────────────────────────────────────────

test("one bundle's broken seam does not stop the next bundle", async () => {
  const state = { settings: {} };
  const ran = [];
  const deps = {
    appBundles: () => "/reviewed",
    bundlesDir: () => "/installed",
    crowHome: () => null,
    setupDeps: () => ({}),
    listInstalled: () => [{ id: "a", installedAt: INSTALL }, { id: "b", installedAt: INSTALL }],
    getManifest: (id) => {
      if (id === "a") throw new Error("no manifest for a");
      return { ...MANIFEST, id: "b" };
    },
    readSetting: (key) => state.settings[key] ?? null,
    mcpTransport: () => "stdio",
    hasAdminSaved: () => false,
    appRunning: () => true,
    tryBegin: () => true,
    end: () => {},
    runSetup: async (o) => { ran.push(o.bundleId); return { result: "ok", log: [] }; },
    applyAfter: async () => ({ ok: true }),
    recreate: async () => ({ ok: true }),
    reconnect: async () => {},
    reportAfterFailure: async () => null,
    warn: () => {},
  };
  const summary = await runFirstAdminCatchUp({ deps });
  assert.deepEqual(ran, ["b"], "the second bundle is still served");
  assert.deepEqual(summary.ran, [{ id: "b", result: "ok" }]);
  assert.equal(summary.checked, 2);
});

test("no seam can make the catch-up throw", async () => {
  const boom = () => { throw new Error("seam broke"); };
  const asyncBoom = async () => { throw new Error("seam broke"); };
  const cases = {
    listInstalled: asyncBoom,
    getManifest: boom,
    readSetting: boom,
    mcpTransport: boom,
    hasAdminSaved: asyncBoom,
    appRunning: asyncBoom,
    tryBegin: boom,
    end: asyncBoom,
    runSetup: asyncBoom,
    applyAfter: asyncBoom,
    reconnect: asyncBoom,
    reportAfterFailure: asyncBoom,
  };
  for (const [name, fn] of Object.entries(cases)) {
    const { deps } = harness({ deps: { [name]: fn } });
    const summary = await runFirstAdminCatchUp({ deps });
    assert.ok(summary && Array.isArray(summary.ran), `${name}: an answer, not a throw`);
  }
});

test("an entry with no id, and an empty install list, are simply nothing to do", async () => {
  {
    const { deps, state } = harness({ overrides: { installed: [] } });
    assert.deepEqual(await runFirstAdminCatchUp({ deps }), { checked: 0, ran: [] });
    assert.equal(state.calls.run.length, 0);
  }
  {
    const { deps, state } = harness({ overrides: { installed: [{ installedAt: INSTALL }, { id: "" }] } });
    assert.deepEqual(await runFirstAdminCatchUp({ deps }), { checked: 0, ran: [] });
    assert.equal(state.calls.run.length, 0);
  }
});

test("no password reaches a log line: the REAL run, with a sentinel", async (t) => {
  const out = captureOutput(t);
  const SENTINEL = `sentinel-${randomUUID()}`;
  const root = mkdtempSync(join(TMP, "real-"));
  const reviewed = join(root, "reviewed");
  const installedRoot = join(root, "installed");
  mkdirSync(join(reviewed, ID, "scripts"), { recursive: true });
  mkdirSync(join(installedRoot, ID), { recursive: true });
  writeFileSync(join(reviewed, ID, "scripts", "first-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
  const markers = [];
  const deps = {
    appBundles: () => reviewed,
    bundlesDir: () => installedRoot,
    crowHome: () => null,
    setupDeps: () => ({
      // The script echoes the password it was given (a real script might): the run must hide it.
      runScript: async () => ({ stdout: `created the admin with ${SENTINEL}\n`, stderr: "" }),
      openDb: () => ({ close() {} }),
      hasSaved: async () => false,
      ensureWriteKey: async () => ({ id: "k1" }),
      newSecret: () => SENTINEL,
      save: async () => ({ id: 1 }),
      writeEnv: () => {},
      writeMarker: async (db, id, value) => { markers.push({ id, ...value }); return true; },
      now: () => 0,
      warn: (m) => console.warn(m),
      applyMcpEnv: async () => false,
      requestReload: async () => {},
    }),
    listInstalled: () => [{ id: ID, installedAt: INSTALL }],
    getManifest: () => MANIFEST,
    readSetting: () => null,
    mcpTransport: () => "stdio",
    hasAdminSaved: () => false,
    appRunning: () => true,
    tryBegin: () => true,
    end: () => {},
    runSetup: runFirstAdminSetup,
    applyAfter: async () => ({ ok: true }),
    recreate: async () => ({ ok: true }),
    reconnect: async () => {},
    reportAfterFailure: async () => null,
    warn: (m) => console.warn(m),
  };
  const summary = await runFirstAdminCatchUp({ deps });

  assert.deepEqual(summary, { checked: 1, ran: [{ id: ID, result: "ok" }] });
  assert.deepEqual(markers, [{ id: ID, install: INSTALL, result: "ok" }], "the marker carries a result word only");
  assert.equal(out.text().includes(SENTINEL), false, "nothing this pass printed carries the password");
  assert.equal(JSON.stringify(summary).includes(SENTINEL), false, "and neither does its answer");
  assert.equal(JSON.stringify(markers).includes(SENTINEL), false);
});

// ── the boot wiring: first-admin FIRST, then the API token ──────────────────────

test("post-listen runs the first-admin catch-up before the API-token one, behind one settle gate", () => {
  const src = readFileSync(join(REPO, "servers", "gateway", "boot", "post-listen.js"), "utf8");
  const admin = src.indexOf("runFirstAdminCatchUp");
  const token = src.indexOf("runApiTokenCatchUp");
  assert.ok(admin > -1, "post-listen runs the first-admin catch-up");
  assert.ok(token > -1, "and still runs the API-token catch-up");
  assert.ok(admin < token, "the admin login first: a token needs the admin to exist");

  // Both inside the SAME chain: the --no-auth skip and the settle race open it, and no new IIFE
  // starts between the two calls.
  const gate = src.lastIndexOf("if (!noAuth)", admin);
  assert.ok(gate > -1, "behind the --no-auth skip");
  const block = src.slice(gate, token);
  assert.match(block, /addonsSettled\(\)/, "behind the add-ons' settle gate");
  assert.match(block, /10 \* 60 \* 1000/, "with the same 10-minute cap");
  assert.match(block, /firstAdminCatchUpDeps\(\)/, "wired with the module's own real seams");
  assert.equal(block.match(/\(async \(\) => \{/g).length, 1, "one chain, not a second fire-and-forget block");
  assert.match(src.slice(admin, token + 400), /\[first-admin\] catch-up:/, "one line per run, ids and result words");
});