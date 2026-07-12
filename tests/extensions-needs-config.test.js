/**
 * "Needs setup" — the durable config-state affordance on the Installed cards.
 *
 * Compute layer (bundles-config.js → panels/extensions/data-queries.js), the
 * compute→render seam (html.js), and the server truth the client renders
 * (POST /bundles/api/env returns the RE-DERIVED needs_config).
 *
 * Isolation (non-negotiable): CROW_HOME/CROW_DATA_DIR point at a scratch dir and
 * every module under test is imported DYNAMICALLY afterwards — both
 * bundles-config.js and data-queries.js capture CROW_HOME at module load, so a
 * static import would read (and the route test would WRITE) the operator's real
 * ~/.crow. Never add these tests to extensions-page-render.test.js or
 * extensions-client-contract.test.js: those two declare they never touch ~/.crow.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "crowhome-needsconfig-"));
mkdirSync(join(HOME, "bundles"), { recursive: true });
mkdirSync(join(HOME, "data"), { recursive: true });

process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

/** The sentinel that must never reach the browser (AC-8). */
const SENTINEL = "SECRET_SENTINEL_VALUE_9f3a";

/** Write an INSTALLED bundle: manifest (+ optional .env) under CROW_HOME/bundles/<id>. */
function installedBundle(id, envVars, dotEnv /* object|null */) {
  const dir = join(HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id, name: id, type: "bundle", version: "1.0.0", env_vars: envVars,
  }, null, 2));
  if (dotEnv) {
    writeFileSync(
      join(dir, ".env"),
      Object.entries(dotEnv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    );
  }
}

function writeMcpAddons(entries) {
  writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify(entries, null, 2));
}

const REQUIRED = (...names) => names.map((n) => ({ name: n, description: `${n} desc`, required: true }));

// ─── Fixtures (one scratch CROW_HOME shared by the whole file) ───

// docker-style: .env present, one required key still blank → the affordance
installedBundle("fx-docker", REQUIRED("DOCKER_KEY"), { DOCKER_KEY: "" });

// MCP add-on configured ONLY through mcp-addons.json (no .env) → AC-3, no affordance
installedBundle("fx-mcp", REQUIRED("MCP_KEY"), null);

// MCP add-on whose required key only exists in the gateway's ambient env → AC-4
installedBundle("fx-ambient", REQUIRED("AMBIENT_KEY"), null);
process.env.AMBIENT_KEY = "from-systemd";

// manifest-only stub (capstone-tracker's real shape): no .env, no mcp entry → AC-5
installedBundle("fx-stub", REQUIRED("STUB_KEY"), null);

// every required key has a value → AC-6
installedBundle("fx-done", REQUIRED("DONE_KEY"), { DONE_KEY: "set" });
// no required keys at all → AC-6
installedBundle("fx-norequire", [{ name: "OPTIONAL_KEY", required: false }], { OPTIONAL_KEY: "" });

// AC-8: TWO required keys — one holds the sentinel (in .env AND mcp-addons.json),
// one is empty. The empty one is what makes the card render an affordance at all;
// without it this test would be vacuous (a configured bundle renders nothing).
installedBundle("fx-secret", REQUIRED("SENTINEL_KEY", "EMPTY_KEY"), {
  SENTINEL_KEY: SENTINEL,
  EMPTY_KEY: "",
});

// the route test's target: two required keys, both blank
installedBundle("fx-route", REQUIRED("KEY_A", "KEY_B"), { KEY_A: "", KEY_B: "" });

writeMcpAddons({
  "fx-mcp": { command: "node", args: ["x.js"], env: { MCP_KEY: "live-value" } },
  "fx-ambient": { command: "node", args: ["x.js"], env: {} },
  "fx-secret": { command: "node", args: ["x.js"], env: { SENTINEL_KEY: SENTINEL } },
});

writeFileSync(join(HOME, "installed.json"), JSON.stringify(
  ["fx-docker", "fx-mcp", "fx-ambient", "fx-stub", "fx-done", "fx-norequire", "fx-secret", "fx-route"]
    .map((id) => ({ id, version: "1.0.0", installed_at: "2026-07-11T00:00:00Z" })),
));

// Import AFTER the env is set (CROW_HOME is captured at module load).
const { fetchNeedsConfig, getInstalled } = await import(
  "../servers/gateway/dashboard/panels/extensions/data-queries.js"
);
const { buildExtensionsHTML } = await import(
  "../servers/gateway/dashboard/panels/extensions/html.js"
);
const { default: bundlesRouter } = await import("../servers/gateway/routes/bundles.js");

after(() => {
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
});

// ─── Compute layer ───

test("fetchNeedsConfig: a managed bundle with an empty required key reports that key by NAME", () => {
  const map = fetchNeedsConfig(getInstalled());
  assert.deepEqual(map["fx-docker"], ["DOCKER_KEY"]);
});

test("fetchNeedsConfig: an MCP add-on configured only via mcp-addons.json reports nothing (AC-3)", () => {
  const map = fetchNeedsConfig(getInstalled());
  assert.ok(!map["fx-mcp"] || map["fx-mcp"].length === 0,
    "a WORKING add-on whose env lives in mcp-addons.json must never be badged");
});

test("fetchNeedsConfig: a required key supplied only by ambient process.env reports nothing (AC-4)", () => {
  const map = fetchNeedsConfig(getInstalled());
  assert.ok(!map["fx-ambient"] || map["fx-ambient"].length === 0,
    "proxy.js spawns MCP children with { ...process.env, ...config.env } — the ambient value is real config");
});

test("fetchNeedsConfig: a bundle with no managed evidence reports nothing (AC-5)", () => {
  const map = fetchNeedsConfig(getInstalled());
  assert.ok(!map["fx-stub"], "no .env and no mcp-addons entry → we cannot tell unconfigured from unmanaged: fail closed");
});

test("fetchNeedsConfig: a configured bundle and a bundle with no required keys report nothing (AC-6)", () => {
  const map = fetchNeedsConfig(getInstalled());
  assert.ok(!map["fx-done"]);
  assert.ok(!map["fx-norequire"]);
});

test("fetchNeedsConfig: the map is keyed by bundle id over the installed OBJECT", () => {
  const map = fetchNeedsConfig(getInstalled());
  assert.deepEqual(Object.keys(map).sort(), ["fx-docker", "fx-route", "fx-secret"]);
  assert.deepEqual(map["fx-route"], ["KEY_A", "KEY_B"]);
});

// ─── AC-8: the compute→render seam leaks key NAMES only, never VALUES ───

test("SECURITY: the compute→render seam emits the Configure affordance but never a config VALUE (AC-8)", () => {
  const installed = getInstalled();
  const needsConfig = fetchNeedsConfig(installed);

  assert.deepEqual(needsConfig["fx-secret"], ["EMPTY_KEY"],
    "only the EMPTY key is missing — the sentinel-valued one is configured");

  const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
    installed,
    available: [{ id: "fx-secret", name: "Fixture Secret", description: "d", type: "bundle", category: "other", version: "1.0.0", author: "x", tags: [], env_vars: REQUIRED("SENTINEL_KEY", "EMPTY_KEY") }],
    collections: [],
    registrySource: "local",
    communityStores: [],
    bundleStatus: {},
    needsConfig,
    lang: "en",
  });
  const html = viewsHtml + addonRegistryScript + collectionsScript;

  // (a) the affordance IS rendered — otherwise (b) would be vacuous
  assert.match(html, /class="btn btn-sm btn-primary bundle-configure"[^>]*data-id="fx-secret"/,
    "the Configure button must be on the fx-secret card");
  assert.match(html, /data-keys="EMPTY_KEY"/, "scoped to the still-missing key");
  assert.match(html, /Needs setup/, "and the badge is rendered");

  // (b) and the secret is nowhere in what we hand the browser
  assert.equal(html.split(SENTINEL).length - 1, 0,
    "a config VALUE must never reach the browser — key names are public, values are secrets (D5)");
});

// ─── Server truth: POST /bundles/api/env returns the RE-DERIVED needs_config ───

test("POST /bundles/api/env: a PARTIAL save returns the keys that are STILL missing", async (t) => {
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = (body) => fetch(base + "/bundles/api/env", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  // 1 of 2 keys — and a whitespace-only value for the other, which the client's
  // `if (inp && inp.value)` guard happily accepts but needsConfigKeys trims away.
  const partial = await post({ bundle_id: "fx-route", env_vars: { KEY_A: "value-a", KEY_B: "   " } });
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.needs_config, ["KEY_B"],
    "the route must RE-DERIVE config state after the write — a 200 does not mean 'configured'");

  const full = await post({ bundle_id: "fx-route", env_vars: { KEY_B: "value-b" } });
  assert.equal(full.ok, true);
  assert.deepEqual(full.needs_config, [], "every required key now has a value");
  assert.equal(typeof full.needs_restart, "boolean", "the pre-existing response fields survive");
});
