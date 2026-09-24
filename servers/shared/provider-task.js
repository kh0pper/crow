/**
 * Host-neutral provider defaults (spec
 * docs/superpowers/specs/2026-09-24-host-neutral-model-defaults-design.md).
 *
 * A default must never name a machine. A task's default provider resolves:
 * env override → dashboard_settings key → the lowest-id ENABLED provider that
 * has a model tagged with one of the task's synonyms → null. Cached 30 s per
 * task|settingKey; the env is consulted before the cache on every call.
 */
import { createDbClient } from "../db.js";

export const EMBED_TASKS = Object.freeze(["embed", "embedding"]);
export const RERANK_TASKS = Object.freeze(["rerank", "score"]);

const TTL_MS = 30_000;
const _cache = new Map(); // `${tasks}|${settingKey}` -> { value, at }

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

export async function resolveProviderForTask({ tasks, envVar, settingKey, dbFactory = createDbClient }) {
  const env = envVar ? process.env[envVar] : undefined;
  if (typeof env === "string" && env.trim()) return env.trim();
  const key = `${[].concat(tasks).join(",")}|${settingKey || ""}`;
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
        value = pickProviderByTask(rows || [], tasks);
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
