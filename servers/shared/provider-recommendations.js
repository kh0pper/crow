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

/**
 * The entry kind each role takes. Chat-family roles take "chat" (or an entry
 * with no kind); embed and rerank take only their own kind. Realtime, audio
 * and live kinds fit no role: Crow's voice role is the text LLM behind the
 * voice router, which a realtime model does not serve.
 */
export const entryKind = (e) => (typeof e?.kind === "string" && e.kind ? e.kind : "chat");
export function kindFitsRole(roleId, kind) {
  const k = typeof kind === "string" && kind ? kind : "chat";
  if (roleId === "embed") return k === "embed";
  if (roleId === "rerank") return k === "rerank";
  return k === "chat";
}

/**
 * A listed model id without a leading "models/" (Google's OpenAI-compatible
 * listing may answer "models/<id>", while requests and the file use the bare id).
 */
export function bareModelId(id) {
  return typeof id === "string" && id.startsWith("models/") && id.length > 7 ? id.slice(7) : id;
}

const EMPTY = Object.freeze({ schema_version: 1, accessed: null, review_by: null, source_notes: "", providers: {} });
const cache = new Map(); // path -> {mtimeMs, data}

export function loadRecommendations({ file = DEFAULT_FILE } = {}) {
  let mtimeMs;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return EMPTY; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  // A malformed file fails closed (no picks, stale) and is cached against its
  // mtime like a good one, so it is not re-parsed on every call; the next
  // write (new mtime) is read again.
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { data = EMPTY; }
  if (!data || typeof data !== "object" || !data.providers || typeof data.providers !== "object") data = EMPTY;
  cache.set(file, { mtimeMs, data });
  return data;
}

/** Ordered entries for one provider and role (copies), or [] when none. */
export function recommendedFor(presetId, roleId, opts) {
  if (!RECOMMENDATION_ROLES.includes(roleId)) return [];
  const list = loadRecommendations(opts).providers?.[presetId]?.roles?.[roleId];
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e === "object" && !Array.isArray(e)).map((e) => structuredClone(e));
}

/**
 * Every model id the file recommends for a preset (any role, primaries and
 * alternatives), once each in role order: what the add sheet offers as
 * checkboxes when the provider has no model list. Only verified ids of a kind
 * some role takes (never a realtime entry).
 */
export function recommendedModelIds(presetId, opts) {
  const out = [];
  for (const roleId of RECOMMENDATION_ROLES) {
    for (const e of recommendedFor(presetId, roleId, opts)) {
      if (e.id_verified !== true || !kindFitsRole(roleId, e.kind) || typeof e.model_id !== "string" || !e.model_id) continue;
      if (!out.includes(e.model_id)) out.push(e.model_id);
    }
  }
  return out;
}

/** A strict YYYY-MM-DD string that names a real calendar day, else null. */
function validDay(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = new Date(v + "T00:00:00Z");
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v ? v : null;
}

/**
 * The entry "Use the recommended models" would choose, or null.
 * Eligible: a kind the role takes (`kindFitsRole`), `id_verified`, `retires`
 * null or after `review_by`, and present in `liveModelIds` when a listing
 * exists (null/undefined = no listing; "models/<id>" matches "<id>"). The first
 * eligible `stable` entry wins; only when there is none does the first eligible
 * `preview` entry come back, flagged `preview: true`.
 */
export function candidatePick(presetId, roleId, { liveModelIds = null } = {}, opts) {
  const reviewBy = validDay(loadRecommendations(opts).review_by);
  const live = Array.isArray(liveModelIds) ? new Set(liveModelIds.map(bareModelId)) : null;
  const eligible = recommendedFor(presetId, roleId, opts).filter((e) =>
    kindFitsRole(roleId, e.kind)
    && e.id_verified === true
    && (e.retires == null || (reviewBy && validDay(e.retires) && e.retires > reviewBy))
    && (!live || live.has(e.model_id)));
  const stable = eligible.find((e) => e.status === "stable");
  if (stable) return stable;
  const preview = eligible.find((e) => e.status === "preview");
  return preview ? { ...preview, preview: true } : null;
}

/** The preset a providers row was made from, by normalised base URL (variants and aliases included). */
export function presetForRow(row) {
  const url = normalizeBaseUrl(row?.baseUrl || row?.base_url);
  if (!url) return null;
  for (const p of PROVIDER_PRESETS) {
    if (presetBaseUrls(p).includes(url)) return p.id;
  }
  return null;
}

/** True once `now` is past the file's `review_by` date; a missing or invalid date fails closed (stale). */
export function isRecommendationsStale(now = new Date(), opts) {
  const reviewBy = validDay(loadRecommendations(opts).review_by);
  if (!reviewBy) return true;
  return now.getTime() > new Date(reviewBy + "T23:59:59Z").getTime();
}
