/**
 * Extensions Panel — Data Queries
 *
 * Constants, file-system helpers, and GET data-acquisition functions
 * for the extensions/add-ons store panel.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { execFile, execFileSync } from "child_process";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { loadCollections } from "./collections.js";
// bundles-config.js ONLY — never routes/bundles.js, which would drag express
// Router, db.js, peer-forward, cross-host-auth and the settings registry into the
// panel's render path (it already imports ./collections.js, so that knot is real).
import { needsConfigKeys } from "../../../bundles-config.js";

// Respect the instance's CROW_HOME (matches bundles.js / proxy.js resolveCrowHome).
// Without this, an alternate instance (CROW_HOME=~/.crow-mpa, ~/.crow-finance) reads
// the MAIN ~/.crow's installed.json/stores.json instead of its own.
export const CROW_DIR = process.env.CROW_HOME || join(homedir(), ".crow");
export const INSTALLED_PATH = join(CROW_DIR, "installed.json");
export const STORES_PATH = join(CROW_DIR, "stores.json");

// Local fallback registry path (five levels up from panels/extensions/ to repo root)
const __dirname = dirname(fileURLToPath(import.meta.url));
export const LOCAL_REGISTRY = join(__dirname, "../../../../../registry/add-ons.json");

// ─── Docker daemon availability probe (Item 4-PR5) ───
//
// One probe, two consumers: the extensions page banner (this panel) and the
// deploys-install guard in routes/bundles.js (which re-exports it). It lives
// HERE, not in routes/bundles.js, because the panel render path must never
// import routes/bundles.js (see the import note above) while routes/bundles.js
// already imports from this panel dir.
//
// `docker info` is the reliable daemon-reachability check (`docker compose
// version` is a client-side plugin probe and succeeds with the daemon down).
// Short execFile timeout so a hung daemon can never block a page render; the
// result is cached ~60s so repeated renders/installs don't re-spawn docker.
const DOCKER_PROBE_TTL_MS = 60_000;
const DOCKER_PROBE_TIMEOUT_MS = 3_000;
let _dockerProbe = { ok: null, at: 0 };
let _dockerProbeInflight = null;

/** Test-only: clear the cached probe result (and any in-flight probe). */
export function _resetDockerProbeForTest() {
  _dockerProbe = { ok: null, at: 0 };
  _dockerProbeInflight = null;
  _dockerProbePin = null;
}

// Test-only pin, consulted before the cache AND the TTL — a pinned value can
// never expire mid-test-file the way a cached probe result can (the 60s TTL
// re-probes, and on a loaded host the 3s `docker info` times out → tests that
// aren't about docker fail on the docker gate).
let _dockerProbePin = null;

/** Test-only: pin dockerAvailable() to a fixed value (null un-pins). */
export function _setDockerProbeForTest(ok) {
  _dockerProbePin = typeof ok === "boolean" ? ok : null;
}

/**
 * Is a Docker daemon reachable on this host? Cached ~60s; concurrent callers
 * share one in-flight probe. Resolves false on: binary absent, daemon down,
 * or probe timeout. Never rejects.
 * @returns {Promise<boolean>}
 */
export function dockerAvailable() {
  if (_dockerProbePin !== null) return Promise.resolve(_dockerProbePin);
  const now = Date.now();
  if (_dockerProbe.ok !== null && now - _dockerProbe.at < DOCKER_PROBE_TTL_MS) {
    return Promise.resolve(_dockerProbe.ok);
  }
  if (_dockerProbeInflight) return _dockerProbeInflight;
  _dockerProbeInflight = new Promise((resolveProbe) => {
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: DOCKER_PROBE_TIMEOUT_MS }, (err) => {
      _dockerProbe = { ok: !err, at: Date.now() };
      _dockerProbeInflight = null;
      resolveProbe(!err);
    });
  });
  return _dockerProbeInflight;
}

export function getInstalled() {
  try {
    if (existsSync(INSTALLED_PATH)) {
      const data = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
      if (Array.isArray(data)) {
        const obj = {};
        for (const item of data) obj[item.id] = item;
        return obj;
      }
      return data;
    }
  } catch {}
  return {};
}

export function getStores() {
  try {
    if (existsSync(STORES_PATH)) {
      return JSON.parse(readFileSync(STORES_PATH, "utf8"));
    }
  } catch {}
  return [];
}

export function saveStores(stores) {
  writeFileSync(STORES_PATH, JSON.stringify(stores, null, 2));
}

/** Fetch add-ons from a community store GitHub repo */
export async function fetchCommunityStore(storeUrl) {
  try {
    const match = storeUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return { addons: [], store: null };

    const rawUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/registry.json`;
    const storeMetaUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/crow-store.json`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let store = null;
    try {
      const metaResp = await fetch(storeMetaUrl, { signal: controller.signal });
      if (metaResp.ok) store = await metaResp.json();
    } catch {}

    const resp = await fetch(rawUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return { addons: [], store };

    const data = await resp.json();
    const addons = (data["add-ons"] || []).map((a) => ({
      ...a,
      _community: true,
      _storeName: store?.name || match[1],
      _storeUrl: storeUrl,
    }));
    return { addons, store };
  } catch {
    return { addons: [], store: null };
  }
}

// A registry entry can itself be a third-party listing (manifest origin:
// "community" → the generated entry carries official: false) — those get the
// same Community badge + install-modal caution as community-store add-ons, so
// _community means "not maintained by Crow", not "came from a community store".
// An ABSENT official field defaults to first-party: never falsely badge.
export function withProvenance(addons) {
  return addons.map((a) => ({ ...a, _community: a.official === false }));
}

/**
 * Load the in-repo registry + community stores into the available add-ons list.
 * The in-repo registry (registry/add-ons.json) is the sole source of truth —
 * the remote crow-addons mirror was retired 2026-07-18 (it was listing-only:
 * installs always need the local checkout, so remote-only entries could only
 * ever render as phantom, uninstallable cards).
 * Returns { installed, available, collections, registrySource, communityStores }.
 */
export async function fetchRegistryData() {
  const installed = getInstalled();

  let localAddons = [];
  let registrySource = "none";
  try {
    if (existsSync(LOCAL_REGISTRY)) {
      const local = JSON.parse(readFileSync(LOCAL_REGISTRY, "utf8"));
      localAddons = local["add-ons"] || [];
      registrySource = "local";
    }
  } catch {}

  const officialAddons = withProvenance(localAddons);
  const communityStores = getStores();
  const communityResults = await Promise.all(communityStores.map((s) => fetchCommunityStore(s.url)));
  const communityAddons = communityResults.flatMap((r) => r.addons);

  const officialIds = new Set(officialAddons.map((a) => a.id));
  const dedupedCommunity = communityAddons.filter((a) => !officialIds.has(a.id));
  const available = [...officialAddons, ...dedupedCommunity];
  available.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return { installed, available, collections: loadCollections(), registrySource, communityStores };
}

/**
 * Which installed bundles still have an unmet required config key.
 *
 * Returns key NAMES only — a value from .env / mcp-addons.json must never reach the
 * browser (D5). Bundles with nothing missing are omitted entirely, so the render
 * layer can just test `needsConfig[id]`.
 *
 * `installed` is the OBJECT getInstalled() returns (keyed by id), not an array.
 *
 * @param {Record<string, object>} installed
 * @returns {Record<string, string[]>}
 */
export function fetchNeedsConfig(installed) {
  const out = {};
  for (const id of Object.keys(installed || {})) {
    const keys = needsConfigKeys(id);
    if (keys.length > 0) out[id] = keys;
  }
  return out;
}

/**
 * Probe docker-compose status for installed bundles.
 * Returns { bundleStatus }.
 */
export function fetchBundleStatus(installed) {
  // Detect docker compose command variant
  let composeCmd = null;
  try {
    execFileSync("docker", ["compose", "version"], { timeout: 3000 });
    composeCmd = { cmd: "docker", prefix: ["compose"] };
  } catch {
    try {
      execFileSync("python3", ["-m", "compose", "version"], { timeout: 3000 });
      composeCmd = { cmd: "python3", prefix: ["-m", "compose"] };
    } catch {
      try {
        execFileSync("docker-compose", ["version"], { timeout: 3000 });
        composeCmd = { cmd: "docker-compose", prefix: [] };
      } catch {}
    }
  }

  // Fetch live container status for installed Docker bundles
  let bundleStatus = {};
  if (composeCmd) {
    try {
      const bundlesDir = join(CROW_DIR, "bundles");
      for (const [id] of Object.entries(installed)) {
        const composePath = join(bundlesDir, id, "docker-compose.yml");
        if (existsSync(composePath)) {
          try {
            const out = execFileSync(composeCmd.cmd, [...composeCmd.prefix, "ps", "--format", "json"], {
              cwd: join(bundlesDir, id),
              timeout: 5000,
            }).toString().trim();
            const containers = out.split("\n").filter(Boolean).map((line) => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);
            bundleStatus[id] = {
              running: containers.some((c) => c.State === "running"),
              containers: containers.length,
            };
          } catch {
            bundleStatus[id] = { running: false, containers: 0 };
          }
        }
      }
    } catch {}
  }

  return { bundleStatus };
}
