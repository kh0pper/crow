/**
 * Model roles, bot side: the RoleContext the role walker needs, read
 * synchronously from a better-sqlite3 connection. The gateway's async twin is
 * loadRoleContext in servers/shared/model-roles-store.js; both build the same
 * shape: {bindings, customDefs, providers, models, catalog, ownInstanceId}.
 *
 *  - bindings/customDefs: a range SELECT on dashboard_settings (never LIKE).
 *  - providers: every row, disabled ones too, through providerRowToObject.
 *    "Configured" comes from `models`, the caller's loadModels() result (the
 *    enabled rows, else models.json), loaded once by the caller.
 *  - catalog: registry/model-catalog.json, module-relative.
 *  - ownInstanceId: the caller's function, wrapped so a throw gives null
 *    (instance-owned rows then count as foreign), logged once.
 *
 * Synchronous and never throws: a failed read leaves that part empty.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBindingRows, ROLE_KEY_RANGE } from "../../servers/shared/model-roles.js";
import { providerRowToObject } from "../../servers/shared/provider-row.js";

const CATALOG_PATH = fileURLToPath(new URL("../../registry/model-catalog.json", import.meta.url));
let catalogCache = { mtimeMs: -1, models: [] };

function loadCatalog() {
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

let idWarned = false;

function wrapOwnId(getId) {
  return () => {
    try {
      if (typeof getId !== "function") throw new TypeError("no ownInstanceId");
      return getId();
    } catch {
      if (!idWarned) {
        idWarned = true;
        console.warn("[roles] own instance id unavailable; instance-owned rows treated as foreign");
      }
      return null;
    }
  };
}

/**
 * @param {import("better-sqlite3").Database} conn
 * @param {{models: object|null, ownInstanceId: () => string}} opts
 */
export function loadRoleContextSync(conn, { models = null, ownInstanceId } = {}) {
  let bindings = {}, customDefs = {}, providers = [];
  try {
    const rows = conn.prepare("SELECT key, value FROM dashboard_settings WHERE key >= ? AND key < ?")
      .all(ROLE_KEY_RANGE.lo, ROLE_KEY_RANGE.hi);
    ({ bindings, customDefs } = parseBindingRows(rows));
  } catch (e) {
    console.warn("[roles] bindings unreadable: " + (e?.message || e));
  }
  try {
    providers = conn.prepare("SELECT * FROM providers").all().map(providerRowToObject);
  } catch (e) {
    console.warn("[roles] providers unreadable: " + (e?.message || e));
  }
  return { bindings, customDefs, providers, models, catalog: loadCatalog(), ownInstanceId: wrapOwnId(ownInstanceId) };
}
