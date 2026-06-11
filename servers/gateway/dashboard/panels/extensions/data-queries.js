/**
 * Extensions Panel — Data Queries
 *
 * Constants, file-system helpers, and GET data-acquisition functions
 * for the extensions/add-ons store panel.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

export const REGISTRY_URL = "https://raw.githubusercontent.com/kh0pper/crow-addons/main/registry.json";
export const CROW_DIR = join(homedir(), ".crow");
export const INSTALLED_PATH = join(CROW_DIR, "installed.json");
export const STORES_PATH = join(CROW_DIR, "stores.json");

// Local fallback registry path (five levels up from panels/extensions/ to repo root)
const __dirname = dirname(fileURLToPath(import.meta.url));
export const LOCAL_REGISTRY = join(__dirname, "../../../../../registry/add-ons.json");

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

/**
 * Fetch and merge remote + local registry into the available add-ons list.
 * Returns { installed, available, registrySource, communityStores }.
 */
export async function fetchRegistryData() {
  const installed = getInstalled();

  // Load remote registry + merge with local (local entries override/supplement remote)
  let remoteAddons = [];
  let localAddons = [];
  let registrySource = "none";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) {
      const remote = await resp.json();
      remoteAddons = remote["add-ons"] || [];
      registrySource = "remote";
    }
  } catch {}

  try {
    if (existsSync(LOCAL_REGISTRY)) {
      const local = JSON.parse(readFileSync(LOCAL_REGISTRY, "utf8"));
      localAddons = local["add-ons"] || [];
      if (registrySource === "none") registrySource = "local";
      else registrySource += "+local";
    }
  } catch {}

  // Merge: local entries override remote for matching IDs, new local entries are appended
  const localIds = new Set(localAddons.map((a) => a.id));
  const mergedAddons = [
    ...remoteAddons.filter((a) => !localIds.has(a.id)),
    ...localAddons,
  ];

  // Merge official add-ons with community store add-ons
  const officialAddons = mergedAddons.map((a) => ({ ...a, _community: false }));
  const communityStores = getStores();
  const communityResults = await Promise.all(communityStores.map((s) => fetchCommunityStore(s.url)));
  const communityAddons = communityResults.flatMap((r) => r.addons);

  const officialIds = new Set(officialAddons.map((a) => a.id));
  const dedupedCommunity = communityAddons.filter((a) => !officialIds.has(a.id));
  const available = [...officialAddons, ...dedupedCommunity];
  available.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return { installed, available, registrySource, communityStores };
}

/**
 * Probe docker-compose status for installed bundles.
 * Returns { composeCmd, bundleStatus }.
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

  return { composeCmd, bundleStatus };
}
