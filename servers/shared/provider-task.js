/**
 * Host-neutral provider defaults (spec
 * the private engineering notes).
 *
 * A default must never name a machine. A task's default provider resolves:
 * env override → dashboard_settings key → a CHOSEN model role (embed/rerank;
 * a seeded binding never counts) → the lowest-id ENABLED provider that has a
 * model tagged with one of the task's synonyms → null. Cached 30 s per
 * task|settingKey|roleId; the env is consulted before the cache on every call.
 */
import { createDbClient } from "../db.js";
import { splitKey } from "../../scripts/pi-bots/model_resolver.mjs";

export const EMBED_TASKS = Object.freeze(["embed", "embedding"]);
export const RERANK_TASKS = Object.freeze(["rerank", "score"]);

const TTL_MS = 30_000;
const _cache = new Map(); // `${tasks}|${settingKey}|${roleId}` -> { value, at }

/** Test seam: forget cached resolutions. */
export function _resetProviderTaskCacheForTest() { _cache.clear(); }

function modelsOf(p) {
  if (!p) return [];
  if (Array.isArray(p.models)) return p.models;
  if (typeof p.models === "string") {
    try { const m = JSON.parse(p.models); return Array.isArray(m) ? m : []; } catch { return []; }
  }
  return [];
}

/** Lowest enabled id with any model tagged in `tasks`, else null. Pure. */
export function pickProviderByTask(providers, tasks) {
  if (!providers || typeof providers !== "object") return null;
  const want = new Set(Array.isArray(tasks) ? tasks : [tasks]);
  const entries = Array.isArray(providers)
    ? providers.filter((p) => p && p.id).map((p) => [p.id, p])
    : Object.entries(providers);
  const ids = entries
    .filter(([, p]) => p && !Number(p.disabled) && modelsOf(p).some((m) => m && want.has(m.task)))
    .map(([id]) => id)
    .sort();
  return ids[0] ?? null;
}

const loggedMismatch = new Set();

function firstTaskModel(row, tasks) {
  const want = new Set([].concat(tasks));
  const m = modelsOf(row).find((x) => x && want.has(x.task));
  return m?.id ?? null;
}

/**
 * The role step: a CHOSEN role's provider half (a seeded binding gives null).
 * The consumer still serves the provider's first matching model, so a role
 * naming another model on it is logged once (M4).
 */
async function roleProvider(db, roleId, tasks, rows) {
  const { resolveRole } = await import("./model-roles-store.js"); // lazy (I4): model-roles.js imports this module
  const list = [].concat(tasks);
  const need = list.some((t) => RERANK_TASKS.includes(t)) ? "score" : "embed";
  const r = await resolveRole(db, "role:" + roleId, { need, chosenOnly: true });
  if (!r?.key) return null;
  const { provider, model } = splitKey(r.key);
  if (!provider || !model) return null;
  const first = firstTaskModel((rows || []).find((p) => p.id === provider), list);
  if (first && first !== model) {
    const msg = `[roles] ${roleId} names ${model}, but ${provider} serves ${first} for this task`;
    if (!loggedMismatch.has(msg)) { loggedMismatch.add(msg); console.warn(msg); }
  }
  return provider;
}

/**
 * env → `settingKey` row → a chosen `roleId` role (provider half) → the
 * lowest-id enabled provider with a task model → null. All but the env sit
 * inside the TTL cache.
 */
export async function resolveProviderForTask({ tasks, envVar, settingKey, roleId, dbFactory = createDbClient }) {
  const env = envVar ? process.env[envVar] : undefined;
  if (typeof env === "string" && env.trim()) return env.trim();
  const key = `${[].concat(tasks).join(",")}|${settingKey || ""}|${roleId || ""}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const db = dbFactory();
    try {
      if (settingKey) {
        const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [settingKey] });
        const v = rows?.[0]?.value;
        if (v && String(v).trim()) value = String(v).trim();
      }
      if (!value) {
        const { rows } = await db.execute({ sql: "SELECT id, models, disabled FROM providers WHERE (disabled IS NULL OR disabled = 0) ORDER BY id", args: [] });
        if (roleId) {
          try { value = await roleProvider(db, roleId, tasks, rows || []); } catch { value = null; } // a role failure never costs the task pick
        }
        if (!value) value = pickProviderByTask(rows || [], tasks);
      }
    } finally {
      db.close?.();
    }
  } catch {
    value = null; // DB unavailable: never fall back to a named host
  }
  _cache.set(key, { value, at: Date.now() });
  return value;
}
