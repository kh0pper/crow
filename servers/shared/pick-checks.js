/**
 * Stored pick checks (roles phase 2b): the read-only side of "Test the picks".
 *
 * Results live in `dashboard_settings.provider_pick_checks` (instance scope,
 * never synced) as `{[providerId]: {"<modelId>|<kind>": {ok, code, at, fp, url}}}`.
 * `fp` and `url` stamp the row the check ran against (see `checkStamp`), so a
 * check never carries over to another key or address under the same id.
 * Only the probe module writes them. This module reads them and makes no
 * request of any kind, so adding a provider or listing picks can import it
 * without any path to a probe.
 */
import { createHash } from "node:crypto";
import { isRecommendationsStale } from "./provider-recommendations.js";
import { normalizeBaseUrl } from "./provider-presets.js";

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
 * What a check is tied to: `fp`, the first 16 hex of sha256 of the row's
 * trimmed key (never the key itself; "" for no key), and `url`, the row's
 * normalised base URL.
 */
export function checkStamp(row) {
  const raw = row?.apiKey ?? row?.api_key;
  const key = typeof raw === "string" ? raw.trim() : "";
  return {
    fp: createHash("sha256").update(key).digest("hex").slice(0, 16),
    url: normalizeBaseUrl(row?.baseUrl ?? row?.base_url),
  };
}

/**
 * The check for one model in an already-read object, or null (not tested)
 * when none exists, the recommendations are past `review_by`, no `row` is
 * given, or the check was made with another key or address than `row` has
 * now (a check stored without a stamp counts as another). A failed check with
 * a retryable code comes back with `retryable: true`, which every reader
 * treats as not tested. Pure.
 */
export function checkIn(checks, providerId, modelId, { kind = "chat", now = new Date(), recOpts, row } = {}) {
  if (!row || isRecommendationsStale(now, recOpts)) return null;
  const c = checks?.[providerId]?.[`${modelId}|${kind}`];
  if (!c || typeof c !== "object") return null;
  const stamp = checkStamp(row);
  if (c.fp !== stamp.fp || c.url !== stamp.url) return null;
  const out = { ok: !!c.ok, code: String(c.code), at: c.at };
  // Busy, failing or unreachable says nothing about the model: not tested, code kept (L2).
  if (!out.ok && isRetryableCode(out.code)) out.retryable = true;
  return out;
}

/**
 * Probe codes that say nothing about the model (try again later): a busy or
 * failing server (429, any 5xx), no answer, a redirect, or a timeout.
 * no_tool_call, bad_embedding and other 4xx are definite failures.
 */
export function isRetryableCode(code) {
  return code === "http_429" || /^http_5\d\d$/.test(String(code)) || code === "unreachable" || code === "redirect" || code === "timeout";
}

/** The stored check for a model against `opts.row`, or null (not tested). */
export async function pickCheckOf(db, providerId, modelId, opts = {}) {
  return checkIn(await readPickChecks(db), providerId, modelId, opts);
}

/** The check kind a role's pick is stored under: embed picks are probed as embeddings, the rest as chat. */
export const checkKindFor = (roleId) => (roleId === "embed" ? "embed" : "chat");

/** The entry kinds "Test the picks" has a probe for (an entry with no kind is chat). Rerank and the rest stay "not tested". */
export const isProbeKind = (kind) => (kind == null || kind === "" ? true : kind === "chat" || kind === "embed");
