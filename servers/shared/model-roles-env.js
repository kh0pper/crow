/**
 * Model roles: the environment pieces both RoleContext builders share (the
 * gateway's model-roles-store.js and the bots' scripts/pi-bots/role_context.mjs),
 * plus the snapshot path pi reads. A light leaf: node built-ins and
 * crow-home.js only, so a bridge process can use it without loading the
 * store or the settings registry.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCrowHome } from "./crow-home.js";

const CATALOG_PATH = fileURLToPath(new URL("../../registry/model-catalog.json", import.meta.url));
let catalogCache = { mtimeMs: -1, models: [] };

/** registry/model-catalog.json's `models`, re-read when its mtime changes; [] on any error. */
export function loadCatalog() {
  try {
    const { mtimeMs } = statSync(CATALOG_PATH);
    if (mtimeMs !== catalogCache.mtimeMs) {
      const j = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
      catalogCache = { mtimeMs, models: Array.isArray(j?.models) ? j.models : [] };
    }
  } catch {
    catalogCache = { mtimeMs: -1, models: [] };
  }
  return catalogCache.models;
}

/**
 * ownInstanceId for walkRole: a throw (or a getId that is not a function)
 * gives null, so every instance-owned row counts as foreign. Logged once per
 * wrapper.
 */
export function wrapOwnId(getId) {
  let warned = false;
  return () => {
    try {
      if (typeof getId !== "function") throw new TypeError("no ownInstanceId");
      return getId();
    } catch {
      if (!warned) {
        warned = true;
        console.warn("[roles] own instance id unavailable; instance-owned rows treated as foreign");
      }
      return null;
    }
  };
}

/** Where pi looks for the role snapshot (the gateway writes it there). */
export function roleSnapshotPath({ env = process.env } = {}) {
  return join(resolveCrowHome(env), "model-roles.json");
}
