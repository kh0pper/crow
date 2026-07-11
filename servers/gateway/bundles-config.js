/**
 * Bundle config resolution — the SINGLE source of truth.
 *
 * Owns the paths every bundle code path resolves against (CROW_HOME/BUNDLES_DIR,
 * APP_ROOT/APP_BUNDLES), manifest lookup, and the "is this bundle actually
 * configured?" computation. `routes/bundles.js` imports these (and re-exports
 * `needsConfigKeys` + `_setAppBundlesForTest` for its pre-existing importers);
 * the extensions panel's data path imports `needsConfigKeys` from HERE and never
 * from `routes/bundles.js`, which would drag express, db.js, peer-forward,
 * cross-host-auth and the settings registry into the panel render path.
 *
 * Imports node builtins ONLY — no circular-import risk with routes/bundles.js.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Respect the instance's CROW_HOME (matches proxy.js resolveCrowHome). Without
// this, an alternate instance (CROW_HOME=~/.crow-mpa, ~/.crow-finance) reads and
// writes the MAIN ~/.crow, re-coupling the instances (commit 1b28d38a).
export const CROW_HOME = process.env.CROW_HOME || join(homedir(), ".crow");
export const BUNDLES_DIR = join(CROW_HOME, "bundles");
export const MCP_ADDONS_PATH = join(CROW_HOME, "mcp-addons.json");

// NOTE the depth: this file lives at servers/gateway/, so the repo root is two
// levels up ("../.."), NOT the three that routes/bundles.js used from
// servers/gateway/routes/ (cf. servers/gateway/env-manager.js:7). A literal copy
// of the old expression points APP_BUNDLES at <home>/bundles and 404s every install.
export const APP_ROOT = resolve(__dirname, "../..");

// `let` (not `const`): _setAppBundlesForTest below repoints this at a scratch
// source tree so install-set E2E tests never install real bundles onto the
// operator's host (see tests/install-set-e2e.test.js — a prior run actually did).
// This must remain the codebase's ONLY binding of APP_BUNDLES: routes/bundles.js
// imports it (ESM live binding) so the setter repoints both readers at once.
export let APP_BUNDLES = join(APP_ROOT, "bundles");

/** Test-only: repoint the repo bundle-source root (normally APP_ROOT/bundles). */
export function _setAppBundlesForTest(path) { APP_BUNDLES = path; }

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read manifest.json for a bundle from app source (the repo checkout).
 *
 * Deliberately repo-only. ~18 callers depend on this: validateInstall, the hardware
 * gate, /consent-challenge, compose validation, findDependents, planInstallSet. The
 * installed tree can hold bundles that are stale or absent from installed.json, and
 * validating a *future* install against a stale installed manifest would be wrong.
 * Config-completeness wants the other precedence — that is getInstalledFirstManifest.
 */
export function getManifest(bundleId) {
  return readJson(join(APP_BUNDLES, bundleId, "manifest.json"));
}

/**
 * Installed copy first, repo as fallback — the right truth for config-completeness
 * ONLY (cf. resolveManifestHost, which uses the same precedence). A bundle installed
 * from a version no longer in the repo would otherwise yield getManifest → null →
 * needsConfigKeys → [], silently hiding the affordance on exactly the stale installs
 * that need it. Do not widen this to getManifest's callers.
 */
export function getInstalledFirstManifest(bundleId) {
  return (
    readJson(join(BUNDLES_DIR, bundleId, "manifest.json")) ??
    readJson(join(APP_BUNDLES, bundleId, "manifest.json"))
  );
}

/** Parse a KEY=value .env file into a plain object (same grammar as the installer writes). */
function parseEnvFile(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* unreadable → treat as empty */ }
  return env;
}

/** The bundle's ~/.crow/mcp-addons.json entry, or null if it registers no MCP server. */
function readMcpAddonEntry(bundleId) {
  const all = readJson(MCP_ADDONS_PATH);
  if (!all || typeof all !== "object") return null;
  return all[bundleId] || null;
}

const isSet = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Resolve a bundle's EFFECTIVE config env — what the thing actually runs with.
 *
 * Three sources, highest precedence first:
 *   1. bundles/<id>/.env              — docker bundles (compose reads it).
 *   2. mcp-addons.json[<id>].env      — MCP add-ons. proxy.js spawns children with
 *                                       { ...process.env, ...config.env }; they never
 *                                       read bundles/<id>/.env.
 *   3. ambient process.env            — same spawn: a key supplied via the gateway's
 *                                       own env / systemd Environment= is real config
 *                                       that appears in neither file.
 * (2) and (3) apply ONLY to bundles that register an MCP server — the gateway's
 * environment is not a Docker container's.
 *
 * Precedence is resolved over *non-empty* values: a blank line in a copied
 * .env.example cannot mask a live mcp-addons value, because an MCP child never reads
 * that file — the value is genuinely in effect.
 *
 * `managed` is the managed-evidence gate: false when there is no positive evidence the
 * gateway manages this bundle's config (no .env AND no mcp-addons entry). On a real
 * host a missing .env usually means "not gateway-managed-with-config", not
 * "unconfigured" — capstone-tracker's installed dir holds only manifest.json;
 * frigate/motioneye have no .env. Callers must fail closed on managed === false.
 *
 * @param {string} bundleId
 * @param {object|null} manifest         installed-first manifest (for env_vars names)
 * @param {{envOverride?: object|null}} [opts]  envOverride = the whole truth (test seam)
 * @returns {{managed: boolean, env: Record<string,string>}}
 */
export function resolveEffectiveEnv(bundleId, manifest, { envOverride = null } = {}) {
  // An injected env is the WHOLE truth: it must not be topped up from mcp-addons or
  // process.env, or a unit test's result would depend on what the host happens to have
  // installed (tests/bundles-install-set.test.js:40,45).
  if (envOverride) return { managed: true, env: { ...envOverride } };

  const dotEnvPath = join(BUNDLES_DIR, bundleId, ".env");
  const hasDotEnv = existsSync(dotEnvPath);
  const mcpEntry = readMcpAddonEntry(bundleId);
  if (!hasDotEnv && !mcpEntry) return { managed: false, env: {} };

  const env = {};
  if (mcpEntry) {
    // Lowest precedence first: ambient, then the add-on's own env.
    for (const v of manifest?.env_vars || []) {
      if (isSet(process.env[v.name])) env[v.name] = process.env[v.name];
    }
    for (const [k, v] of Object.entries(mcpEntry.env || {})) {
      if (isSet(v)) env[k] = v;
    }
  }
  if (hasDotEnv) {
    for (const [k, v] of Object.entries(parseEnvFile(dotEnvPath))) {
      if (isSet(v)) env[k] = v;
    }
  }
  return { managed: true, env };
}

/**
 * Manifest-required env keys that are still EMPTY in the bundle's EFFECTIVE env.
 *
 * Keys with a value (including .env.example defaults — DB passwords, secret keys)
 * count as configured and are NEVER surfaced: those are consumed at first container
 * boot, and changing them afterwards breaks the app or strands its data. Corollary:
 * manifest `default`s are copied into mcp-addons.json at install, so an MCP bundle
 * whose required key has a placeholder default will never be reported. Same rule.
 *
 * Fails closed when the gateway has no evidence it manages this bundle's config
 * (see resolveEffectiveEnv's `managed`) — a false nag is worse than a missing one.
 *
 * @param {string} bundleId
 * @param {object} [envOverride] test seam — the parsed .env; short-circuits everything else
 * @returns {string[]} key NAMES only. Never values: those are secrets (see D5).
 */
export function needsConfigKeys(bundleId, envOverride = null) {
  const man = getInstalledFirstManifest(bundleId);
  const required = (man?.env_vars || []).filter((v) => v.required).map((v) => v.name);
  if (required.length === 0) return [];
  const { managed, env } = resolveEffectiveEnv(bundleId, man, { envOverride });
  if (!managed) return [];
  return required.filter((k) => !isSet(env[k]));
}
