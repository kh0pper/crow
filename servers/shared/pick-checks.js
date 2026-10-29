/**
 * Stored pick checks (roles phase 2b): the read-only side of "Test the picks".
 *
 * Results live in `dashboard_settings.provider_pick_checks` (instance scope,
 * never synced) as `{[providerId]: {"<modelId>|<kind>": {ok, code, at}}}`.
 * Only the probe module writes them. This module reads them and makes no
 * request of any kind, so adding a provider or listing picks can import it
 * without any path to a probe.
 */
import { isRecommendationsStale } from "./provider-recommendations.js";

export const PICK_CHECKS_KEY = "provider_pick_checks";

/** The whole stored object, or {} when none is stored or it does not parse. */
export async function readPickChecks(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [PICK_CHECKS_KEY] });
    const v = rows[0]?.value;
    const parsed = v ? JSON.parse(v) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/**
 * The check for one model in an already-read object, or null (not tested)
 * when none exists or the recommendations are past `review_by`. Pure.
 */
export function checkIn(checks, providerId, modelId, { kind = "chat", now = new Date(), recOpts } = {}) {
  if (isRecommendationsStale(now, recOpts)) return null;
  const c = checks?.[providerId]?.[`${modelId}|${kind}`];
  if (!c || typeof c !== "object") return null;
  return { ok: !!c.ok, code: String(c.code), at: c.at };
}

/** The stored check for a model, or null (not tested). */
export async function pickCheckOf(db, providerId, modelId, opts = {}) {
  return checkIn(await readPickChecks(db), providerId, modelId, opts);
}

/** The check kind a role's pick is stored under: embed picks are probed as embeddings, the rest as chat. */
export const checkKindFor = (roleId) => (roleId === "embed" ? "embed" : "chat");

/** The entry kinds "Test the picks" has a probe for (an entry with no kind is chat). Rerank and the rest stay "not tested". */
export const isProbeKind = (kind) => (kind == null || kind === "" ? true : kind === "chat" || kind === "embed");
