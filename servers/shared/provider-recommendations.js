/**
 * The curated per-provider, per-role model picks (roles phase 2b).
 *
 * Data: registry/provider-recommendations.json (researched picks with a
 * quarterly `review_by`; not smoke-tested — "Test the picks" does that).
 * Entries per role are ordered: index 0 is the primary, then alternatives.
 *
 * Every reader takes an optional `{file}` so tests can point at a fixture;
 * the parsed file is cached per path and re-read when its mtime changes.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_PRESETS, normalizeBaseUrl, presetBaseUrls } from "./provider-presets.js";

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "registry", "provider-recommendations.json");

/** Roles the file may carry. No safety, stt, tts, image or video. */
export const RECOMMENDATION_ROLES = Object.freeze([
  "coordinator", "quick", "deep", "everyday", "expert", "critic", "vision", "voice", "embed", "rerank",
]);

const EMPTY = Object.freeze({ schema_version: 1, accessed: null, review_by: null, source_notes: "", providers: {} });
const cache = new Map(); // path -> {mtimeMs, data}

export function loadRecommendations({ file = DEFAULT_FILE } = {}) {
  let mtimeMs;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return EMPTY; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return hit ? hit.data : EMPTY; }
  if (!data || typeof data !== "object" || !data.providers) data = EMPTY;
  cache.set(file, { mtimeMs, data });
  return data;
}

/** Ordered entries for one provider and role (copies), or [] when none. */
export function recommendedFor(presetId, roleId, opts) {
  if (!RECOMMENDATION_ROLES.includes(roleId)) return [];
  const list = loadRecommendations(opts).providers?.[presetId]?.roles?.[roleId];
  return Array.isArray(list) ? list.map((e) => structuredClone(e)) : [];
}

/**
 * The entry "Use the recommended models" would choose, or null.
 * Eligible: `id_verified`, `retires` null or after `review_by`, and present in
 * `liveModelIds` when a listing exists (null/undefined = no listing). The first
 * eligible `stable` entry wins; only when there is none does the first eligible
 * `preview` entry come back, flagged `preview: true`.
 */
export function candidatePick(presetId, roleId, { liveModelIds = null } = {}, opts) {
  const reviewBy = loadRecommendations(opts).review_by;
  const live = Array.isArray(liveModelIds) ? new Set(liveModelIds) : null;
  const eligible = recommendedFor(presetId, roleId, opts).filter((e) =>
    e.id_verified === true
    && (e.retires == null || (reviewBy && e.retires > reviewBy))
    && (!live || live.has(e.model_id)));
  const stable = eligible.find((e) => e.status === "stable");
  if (stable) return stable;
  const preview = eligible.find((e) => e.status === "preview");
  return preview ? { ...preview, preview: true } : null;
}

/** The preset a providers row was made from, by normalised base URL (variants and aliases included). */
export function presetForRow(row) {
  const url = normalizeBaseUrl(row?.baseUrl ?? row?.base_url);
  if (!url) return null;
  for (const p of PROVIDER_PRESETS) {
    if (presetBaseUrls(p).includes(url)) return p.id;
  }
  return null;
}

/** True once `now` is past the file's `review_by` date (or the file has none). */
export function isRecommendationsStale(now = new Date(), opts) {
  const reviewBy = loadRecommendations(opts).review_by;
  if (!reviewBy) return true;
  return now.getTime() > new Date(reviewBy + "T23:59:59Z").getTime();
}
