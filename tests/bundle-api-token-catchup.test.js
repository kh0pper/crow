/**
 * `firstAdmin.setup.token` — the boot CATCH-UP (servers/gateway/bundle-api-token.js,
 * runApiTokenCatchUp).
 *
 * The install path ran the token step only from the version that shipped it, so an install
 * made earlier never got one. Once per gateway boot, after the add-ons settle, the catch-up
 * walks installed.json and gives each bundle its app's token — but only when every gate says
 * so:
 *
 *   - the reviewed manifest declares a token step Crow may run (apiTokenPlan, not refused);
 *   - the add-on is not satellite-hosted;
 *   - `first_admin_auto:<id>` says Crow's own admin setup returned "ok" for THIS install;
 *   - the token env holds no value yet (an operator's paste is never overwritten);
 *   - `api_token_auto:<id>` has no result for this install — except "not-running" (exit 4),
 *     which is retried on the next boot only.
 *
 * Every seam is injected: no database, no docker, no app. What this file pins down is the
 * gating, the marker, "reconnect once on ok and never otherwise", "one bell on failed only",
 * and that NO seam can make the catch-up throw.
 *
 * The last two tests run the REAL runApiToken through the catch-up's own deps, to pin the
 * stillInstalled guard: a bundle removed (or reinstalled — a new stamp) while the script
 * runs gets no token, records "failed", and reconnects nothing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runApiTokenCatchUp, apiTokenAutoKey, API_TOKEN_AUTO_PREFIX, runApiToken } =
  await import("../servers/gateway/bundle-api-token.js");
const { FIRST_ADMIN_AUTO_PREFIX } = await import("../servers/gateway/bundle-first-admin.js");

const TMP = mkdtempSync(join(tmpdir(), "crow-api-token-catchup-"));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const ID = "px";
const INSTALL = "2026-11-12T09:00:00.000Z";
const AT = "2026-11-12T10:00:00.000Z";
const TOKEN_ENV = "APP_API_TOKEN";
/** paperless-shaped: 40 hex, a `pattern` the manifest declares. */
const TOKEN = "0123456789abcdef0123456789abcdef01234567";

const MANIFEST = {
  id: ID,
  name: "Paperless-ngx",
  origin: "official",
  env_vars: [
    { name: "APP_URL", default: "http://127.0.0.1:8000" },
    { name: TOKEN_ENV, description: "API token", secret: true, pattern: "^[a-f0-9]{40}$" },
    { name: "APP_ADMIN_PASSWORD", description: "set by Crow", secret: true },
  ],
  firstAdmin: {
    mode: "crow",
    via: "setup",
    setup: {
      script: "scripts/first-admin.sh",
      timeout_s: 240,
      token: { script: "scripts/api-token.sh", env: TOKEN_ENV },
    },
    user: "admin",
    secretEnv: "APP_ADMIN_PASSWORD",
  },
};

/**
 * A full seam set over one bundle. `state` is what a test pokes (settings markers, the MCP
 * entry, the run's own answer) and what it reads back (calls).
 */
function harness({ overrides = {}, deps: extra = {} } = {}) {
  const state = {
    installed: [{ id: ID, installedAt: INSTALL }],
    manifest: MANIFEST,
    settings: {
      [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: JSON.stringify({ install: INSTALL, result: "ok" }),
      ...(overrides.settings || {}),
    },
    mcpEnv: {},
    mcpTransport: "stdio",
    keychainRow: false,
    result: "ok",
    calls: { run: [], reconnect: [], notify: [], wrote: [], begun: [], ended: [] },
  };
  const deps = {
    appBundles: () => "/reviewed",
    bundlesDir: () => "/installed",
    crowHome: () => "/home/crow",
    listInstalled: () => state.installed,
    getManifest: () => state.manifest,
    readSetting: (key) => (key in state.settings ? state.settings[key] : null),
    writeSetting: (key, value) => { state.settings[key] = value; state.calls.wrote.push({ key, value }); },
    mcpValue: (id, env) => state.mcpEnv[env] ?? "",
    mcpTransport: () => state.mcpTransport,
    // Which env keys the keychain holds an active row for. An env-admin bundle's gate is the
    // admin password's row; a token env's value is never replaced.
    hasKeychainRow: (id, env) => (Array.isArray(state.keychainRows) ? state.keychainRows.includes(env) : state.keychainRow),
    tryBegin: (id) => { state.calls.begun.push(id); return true; },
    end: (id) => { state.calls.ended.push(id); },
    runApiToken: async (o) => { state.calls.run.push(o); return { result: state.result, log: [] }; },
    reconnect: async (id) => { state.calls.reconnect.push(id); return { ok: true }; },
    notify: async (payload) => { state.calls.notify.push(payload); return { id: 1 }; },
    now: () => Date.parse(AT),
    ...extra,
  };
  if (overrides.result) state.result = overrides.result;
  if (overrides.mcpEnv) state.mcpEnv = overrides.mcpEnv;
  if (overrides.keychainRow) state.keychainRow = true;
  if (overrides.keychainRows) state.keychainRows = overrides.keychainRows;
  if (overrides.mcpTransport) state.mcpTransport = overrides.mcpTransport;
  if (overrides.manifest !== undefined) state.manifest = overrides.manifest;
  if (overrides.installed) state.installed = overrides.installed;
  return { deps, state };
}

// ── prefixes ──────────────────────────────────────────────────────────────────────

test("the marker prefix is its own, and the first-admin prefix matches the module that owns it", () => {
  assert.equal(API_TOKEN_AUTO_PREFIX, "api_token_auto:");
  assert.equal(apiTokenAutoKey(ID), `api_token_auto:${ID}`);
  assert.equal(FIRST_ADMIN_AUTO_PREFIX, "first_admin_auto:", "the catch-up gates on the marker bundle-first-admin.js writes");
});

// ── the happy path ────────────────────────────────────────────────────────────────

test("an installed, set-up, token-less bundle gets its token: one run, one reconnect, the marker", async () => {
  const { deps, state } = harness();
  const summary = await runApiTokenCatchUp({ deps });

  assert.deepEqual(summary, { checked: 1, ran: [{ id: ID, result: "ok" }] });
  assert.equal(state.calls.run.length, 1, "one run");
  const call = state.calls.run[0];
  assert.equal(call.bundleId, ID);
  assert.equal(call.manifest, MANIFEST, "the REVIEWED manifest, never the installed copy");
  assert.equal(call.scriptDir, "/reviewed/px", "the script comes from Crow's own copy of the bundle");
  assert.equal(call.destDir, "/installed/px");
  assert.equal(call.crowHome, "/home/crow");
  assert.deepEqual(state.calls.begun, [ID], "under the same per-bundle lock the install path takes");
  assert.deepEqual(state.calls.ended, [ID], "and released again");
  assert.deepEqual(state.calls.reconnect, [ID], "reconnected once, so the tools pick it up without a restart");
  assert.deepEqual(state.calls.notify, [], "nothing to report");
  assert.deepEqual(JSON.parse(state.settings[apiTokenAutoKey(ID)]), { install: INSTALL, at: AT, result: "ok" });
  assert.equal(state.calls.wrote.length, 1, "one marker write, nothing else");
});

test("an installed entry records its stamp as installed_at too", async () => {
  const { deps, state } = harness({ overrides: { installed: [{ id: ID, installed_at: INSTALL }] } });
  const summary = await runApiTokenCatchUp({ deps });
  assert.deepEqual(summary.ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.run.length, 1);
});

// ── the gates ────────────────────────────────────────────────────────────────────

test("nothing declared: a manifest with no setup.token is not run", async () => {
  const { deps, state } = harness({
    overrides: { manifest: { ...MANIFEST, firstAdmin: { ...MANIFEST.firstAdmin, setup: { script: "scripts/first-admin.sh" } } } },
  });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
  assert.equal(state.calls.run.length, 0);
});

test("a REFUSED declaration is not run (community origin, missing env entry, …)", async () => {
  const { deps, state } = harness({ overrides: { manifest: { ...MANIFEST, origin: "community" } } });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
  assert.equal(state.calls.run.length, 0);
  assert.equal(state.calls.begun.length, 0, "not even the lock is taken for a refused plan");
});

test("a satellite-hosted add-on is skipped: its token belongs to the box its tools run on", async () => {
  const { deps, state } = harness({ overrides: { mcpTransport: "satellite" } });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
  assert.equal(state.calls.run.length, 0);
});

test("the first-admin setup has to have succeeded for THIS install", async () => {
  // not ok
  for (const result of ["failed", "not-running", "busy", "kept"]) {
    const { deps, state } = harness({
      overrides: { settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: JSON.stringify({ install: INSTALL, result }) } },
    });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, [], result);
    assert.equal(state.calls.run.length, 0, result);
  }
  // ok, but for an EARLIER install (a reinstall whose marker was never rewritten)
  {
    const { deps, state } = harness({
      overrides: { settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: JSON.stringify({ install: "older", result: "ok" }) } },
    });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0);
  }
  // no marker at all (an admin saved by hand: out of scope)
  {
    const { deps, state } = harness({ overrides: { settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: null } } });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0);
  }
  // an unreadable marker value
  {
    const { deps, state } = harness({ overrides: { settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: "{not json" } } });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0);
  }
});

test("an existing value is never replaced: a real MCP env value, or an active keychain row", async () => {
  {
    const { deps, state } = harness({ overrides: { mcpEnv: { [TOKEN_ENV]: TOKEN } } });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0, "the operator's own token stays");
  }
  {
    const { deps, state } = harness({ overrides: { keychainRow: true } });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
    assert.equal(state.calls.run.length, 0, "Crow already keeps one");
  }
});

test("a PLACEHOLDER env value is not a value: the catch-up still runs", async () => {
  const { deps, state } = harness({ overrides: { mcpEnv: { [TOKEN_ENV]: "change-me" } } });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.run.length, 1);
});

test("a result for this install is not repeated — except 'not-running', which retries next boot", async () => {
  for (const result of ["ok", "failed", "skipped-has-value", "refused"]) {
    const { deps, state } = harness({
      overrides: { settings: { [apiTokenAutoKey(ID)]: JSON.stringify({ install: INSTALL, at: AT, result }) } },
    });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, [], result);
    assert.equal(state.calls.run.length, 0, result);
  }
  {
    const { deps, state } = harness({
      overrides: { settings: { [apiTokenAutoKey(ID)]: JSON.stringify({ install: INSTALL, at: AT, result: "not-running" }) } },
    });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
    assert.equal(state.calls.run.length, 1, "the app was not up then; this boot it is");
  }
  {
    const { deps, state } = harness({
      overrides: { settings: { [apiTokenAutoKey(ID)]: JSON.stringify({ install: "older", at: AT, result: "failed" }) } },
    });
    assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
    assert.equal(state.calls.run.length, 1, "another install's failure is not this install's answer");
  }
});

test("a run already in flight is skipped silently, and records nothing", async () => {
  const { deps, state } = harness({ deps: { tryBegin: () => false } });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
  assert.equal(state.calls.run.length, 0);
  assert.equal(state.calls.wrote.length, 0, "no marker: the other run owns this boot's answer");
  assert.deepEqual(state.calls.reconnect, []);
});

// ── reconnect / notify ──────────────────────────────────────────────────────────

test("reconnect runs once on ok, and never otherwise", async () => {
  for (const [result, expected] of [["ok", [ID]], ["failed", []], ["skipped-has-value", []], ["not-running", []]]) {
    const { deps, state } = harness({ overrides: { result } });
    await runApiTokenCatchUp({ deps });
    assert.deepEqual(state.calls.reconnect, expected, result);
  }
});

test("one bell on failed, and only on failed", async () => {
  for (const [result, rings] of [["failed", 1], ["not-running", 0], ["skipped-has-value", 0], ["ok", 0]]) {
    const { deps, state } = harness({ overrides: { result } });
    await runApiTokenCatchUp({ deps });
    assert.equal(state.calls.notify.length, rings, result);
    if (rings) {
      const bell = state.calls.notify[0];
      assert.equal(bell.source, "add-ons");
      assert.equal(bell.title, "Paperless-ngx: API token not created");
      assert.equal(bell.body, "Crow could not create an API token for Paperless-ngx. You can paste one in Configure.");
      assert.equal(JSON.stringify(bell).includes(TOKEN), false, "no value in a bell, ever");
    }
  }
});

test("a failed run still records its result, so the next boot does not try again", async () => {
  const { deps, state } = harness({ overrides: { result: "failed" } });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, [{ id: ID, result: "failed" }]);
  assert.deepEqual(JSON.parse(state.settings[apiTokenAutoKey(ID)]), { install: INSTALL, at: AT, result: "failed" });
});

test("a bundle removed (or reinstalled) while the script runs is saved nothing, and records failed", async () => {
  const STAMP_NEW = "2026-11-12T11:00:00.000Z";
  for (const change of ["removed", "reinstalled"]) {
    // Real folders: this run uses the REAL runApiToken, so the guard under test is the one
    // catchUpOne hands it — a re-read of installed.json, not a stub.
    const root = mkdtempSync(join(TMP, change === "removed" ? "gone-" : "new-"));
    const reviewed = join(root, "reviewed");
    const installedRoot = join(root, "installed");
    mkdirSync(join(reviewed, ID, "scripts"), { recursive: true });
    mkdirSync(join(installedRoot, ID), { recursive: true });
    writeFileSync(join(reviewed, ID, "scripts", "api-token.sh"), "#!/usr/bin/env bash\nexit 0\n");

    const state = {
      installed: [{ id: ID, installedAt: INSTALL }],
      settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: JSON.stringify({ install: INSTALL, result: "ok" }) },
      saves: [],
      reconnect: [],
    };
    // The script "runs": installed.json changes while it does.
    const runner = async () => {
      state.installed = change === "removed" ? [] : [{ id: ID, installedAt: STAMP_NEW }];
      return { stdout: "minted\n", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false };
    };
    const deps = {
      appBundles: () => reviewed,
      bundlesDir: () => installedRoot,
      crowHome: () => null,
      listInstalled: () => state.installed,
      getManifest: () => MANIFEST,
      readSetting: (key) => (key in state.settings ? state.settings[key] : null),
      writeSetting: (key, value) => { state.settings[key] = value; return true; },
      mcpValue: () => "",
      mcpTransport: () => "stdio",
      hasKeychainRow: () => false,
      tryBegin: () => true,
      end: () => {},
      tokenDeps: () => ({
        runner,
        save: async (o) => { state.saves.push(o); return { ok: true, needs_restart: false, needs_config: [] }; },
        warn: () => {},
      }),
      runApiToken,
      reconnect: async (id) => { state.reconnect.push(id); },
      notify: async () => {},
      now: () => Date.parse(AT),
    };
    const summary = await runApiTokenCatchUp({ deps });
    assert.deepEqual(summary, { checked: 1, ran: [{ id: ID, result: "failed" }] }, change);
    assert.equal(state.saves.length, 0, `${change}: no token is saved for a bundle that is gone`);
    assert.deepEqual(state.reconnect, [], `${change}: nothing was connected, so nothing reconnects`);
    assert.deepEqual(
      JSON.parse(state.settings[apiTokenAutoKey(ID)]),
      { install: INSTALL, at: AT, result: "failed" },
      `${change}: this install's answer is recorded, so the next boot does not retry`,
    );
  }
});

test("the happy path still saves when installed.json is unchanged (the guard is not a wall)", async () => {
  const root = mkdtempSync(join(TMP, "still-"));
  const reviewed = join(root, "reviewed");
  const installedRoot = join(root, "installed");
  mkdirSync(join(reviewed, ID, "scripts"), { recursive: true });
  mkdirSync(join(installedRoot, ID), { recursive: true });
  writeFileSync(join(reviewed, ID, "scripts", "api-token.sh"), "#!/usr/bin/env bash\nexit 0\n");
  const state = {
    installed: [{ id: ID, installedAt: INSTALL }],
    settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: JSON.stringify({ install: INSTALL, result: "ok" }) },
    saves: [],
  };
  const summary = await runApiTokenCatchUp({
    deps: {
      appBundles: () => reviewed,
      bundlesDir: () => installedRoot,
      crowHome: () => null,
      listInstalled: () => state.installed,
      getManifest: () => MANIFEST,
      readSetting: (key) => (key in state.settings ? state.settings[key] : null),
      writeSetting: (key, value) => { state.settings[key] = value; return true; },
      mcpValue: () => "",
      mcpTransport: () => "stdio",
      hasKeychainRow: () => false,
      tryBegin: () => true,
      end: () => {},
      tokenDeps: () => ({
        runner: async () => ({ stdout: "", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false }),
        save: async (o) => { state.saves.push(o); return { ok: true, needs_restart: false, needs_config: [] }; },
        warn: () => {},
      }),
      runApiToken,
      reconnect: async () => {},
      notify: async () => {},
      now: () => Date.parse(AT),
    },
  });
  assert.deepEqual(summary.ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].value, TOKEN);
});

// ── the via "env" gate: the keychain's generated admin password IS the admin ──────

/** The same bundle, but Crow makes its admin with an environment variable (Miniflux-style). */
const ENV_MANIFEST = {
  id: ID,
  name: "Miniflux",
  origin: "official",
  env_vars: [
    { name: "APP_URL", default: "http://127.0.0.1:8000" },
    { name: TOKEN_ENV, description: "API key", secret: true },
    { name: "APP_ADMIN_PASSWORD", description: "generated by Crow", secret: true, generate: "secret", keychain: true },
    { name: "APP_ADMIN_USER", description: "the admin account" },
  ],
  firstAdmin: {
    mode: "crow",
    via: "env",
    secretEnv: "APP_ADMIN_PASSWORD",
    userEnv: "APP_ADMIN_USER",
    token: { script: "scripts/api-token.sh", env: TOKEN_ENV, stdin: "admin-password" },
  },
};

/** The same, filling TWO env vars from one answer (Wallabag-style). */
const ENV_MULTI_MANIFEST = {
  ...ENV_MANIFEST,
  env_vars: [
    ...ENV_MANIFEST.env_vars,
    { name: "APP_CLIENT_SECRET", description: "client secret", secret: true },
  ],
  firstAdmin: { ...ENV_MANIFEST.firstAdmin, token: { script: "scripts/api-token.sh", env: [TOKEN_ENV, "APP_CLIENT_SECRET"] } },
};

test("via \"env\": the keychain's admin password row is what proves the admin exists", async () => {
  // No first_admin_auto marker at all (nothing ran to write one) — the keychain row is enough.
  const { deps, state } = harness({
    overrides: {
      manifest: ENV_MANIFEST,
      settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: null },
      keychainRows: ["APP_ADMIN_PASSWORD"],
    },
  });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.run.length, 1);
  assert.equal(state.calls.run[0].manifest, ENV_MANIFEST, "the reviewed manifest, with its token beside secretEnv");
  assert.deepEqual(JSON.parse(state.settings[apiTokenAutoKey(ID)]), { install: INSTALL, at: AT, result: "ok" });

  // No password row: the app's admin is not Crow's, so there is nothing to sign in with.
  const none = harness({ overrides: { manifest: ENV_MANIFEST, settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: null } } });
  assert.deepEqual((await runApiTokenCatchUp({ deps: none.deps })).ran, []);
  assert.equal(none.state.calls.run.length, 0);
  assert.equal(none.state.calls.begun.length, 0, "not even the lock is taken");

  // A FAILED setup marker does not matter for an env admin: there was no setup run to fail.
  const stale = harness({
    overrides: {
      manifest: ENV_MANIFEST,
      settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: JSON.stringify({ install: INSTALL, result: "failed" }) },
      keychainRows: ["APP_ADMIN_PASSWORD"],
    },
  });
  assert.deepEqual((await runApiTokenCatchUp({ deps: stale.deps })).ran, [{ id: ID, result: "ok" }]);
});

test("via \"env\": a value in ANY of the token env vars is never replaced", async () => {
  const { deps, state } = harness({
    overrides: {
      manifest: ENV_MULTI_MANIFEST,
      settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: null },
      keychainRows: ["APP_ADMIN_PASSWORD", "APP_CLIENT_SECRET"],
    },
  });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
  assert.equal(state.calls.run.length, 0, "a half-filled extension is left alone, never mixed with fresh values");
});

test("via \"env\": a token-less bundle runs once per install, and the marker holds the answer", async () => {
  const { deps, state } = harness({
    overrides: {
      manifest: ENV_MULTI_MANIFEST,
      settings: { [`${FIRST_ADMIN_AUTO_PREFIX}${ID}`]: null },
      keychainRows: ["APP_ADMIN_PASSWORD"],
    },
  });
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, [{ id: ID, result: "ok" }]);
  assert.equal(state.calls.run.length, 1);
  // The next boot: this install already has its answer.
  assert.deepEqual((await runApiTokenCatchUp({ deps })).ran, []);
  assert.equal(state.calls.run.length, 1);
});

// ── it never throws ─────────────────────────────────────────────────────────────

test("no seam can make the catch-up throw", async () => {
  const boom = () => { throw new Error("seam broke"); };
  const asyncBoom = async () => { throw new Error("seam broke"); };
  const cases = {
    listInstalled: asyncBoom,
    getManifest: boom,
    readSetting: boom,
    writeSetting: asyncBoom,
    mcpValue: boom,
    mcpTransport: boom,
    hasKeychainRow: asyncBoom,
    runApiToken: asyncBoom,
    reconnect: asyncBoom,
    notify: asyncBoom,
    now: boom,
    tryBegin: boom,
    end: asyncBoom,
  };
  for (const [name, fn] of Object.entries(cases)) {
    const { deps } = harness({ deps: { [name]: fn } });
    const summary = await runApiTokenCatchUp({ deps });
    assert.ok(summary && Array.isArray(summary.ran), `${name}: an answer, not a throw`);
  }
});

test("one bundle's broken seam does not stop the next bundle", async () => {
  const state = { settings: {} };
  state.settings[`${FIRST_ADMIN_AUTO_PREFIX}a`] = JSON.stringify({ install: INSTALL, result: "ok" });
  state.settings[`${FIRST_ADMIN_AUTO_PREFIX}b`] = JSON.stringify({ install: INSTALL, result: "ok" });
  const ran = [];
  const deps = {
    appBundles: () => "/reviewed",
    bundlesDir: () => "/installed",
    crowHome: () => null,
    listInstalled: () => [{ id: "a", installedAt: INSTALL }, { id: "b", installedAt: INSTALL }],
    getManifest: (id) => {
      if (id === "a") throw new Error("no manifest for a");
      return { ...MANIFEST, id: "b" };
    },
    readSetting: (key) => state.settings[key] ?? null,
    writeSetting: () => true,
    mcpValue: () => "",
    mcpTransport: () => "stdio",
    hasKeychainRow: () => false,
    tryBegin: () => true,
    end: () => {},
    runApiToken: async (o) => { ran.push(o.bundleId); return { result: "ok", log: [] }; },
    reconnect: async () => {},
    notify: async () => {},
    now: () => Date.parse(AT),
  };
  const summary = await runApiTokenCatchUp({ deps });
  assert.deepEqual(ran, ["b"], "the second bundle is still served");
  assert.deepEqual(summary.ran, [{ id: "b", result: "ok" }]);
  assert.equal(summary.checked, 2);
});

test("an entry with no id, and an empty install list, are simply nothing to do", async () => {
  {
    const { deps, state } = harness({ overrides: { installed: [] } });
    assert.deepEqual(await runApiTokenCatchUp({ deps }), { checked: 0, ran: [] });
    assert.equal(state.calls.run.length, 0);
  }
  {
    const { deps, state } = harness({ overrides: { installed: [{ installedAt: INSTALL }, { id: "" }] } });
    assert.deepEqual(await runApiTokenCatchUp({ deps }), { checked: 0, ran: [] });
    assert.equal(state.calls.run.length, 0);
  }
});