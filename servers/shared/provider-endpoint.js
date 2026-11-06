/**
 * A provider's ENDPOINT — where this device would send its API key.
 *
 * Operator ruling (2026-11-06): an inbound sync change that moves a provider's
 * endpoint, when this device holds a key for that provider, is HELD as a
 * proposed change until the operator accepts it here. Without that, a
 * compromised peer points "openai" at its own server and this device hands over
 * the key it holds (security audit N1b-7, out-of-scope item 2).
 *
 * Two questions live here, so the hold decision and the conflict-review UI
 * cannot disagree about what "the same endpoint" means:
 *
 *   1. providerEndpointKey(url) — the comparable identity of an address:
 *      scheme, host, port and path, with a trailing slash ignored. Pure.
 *   2. providerEndpointChanged(before, after) — did the wire row move it? Pure.
 *   3. providerOrigin(url) — the scheme://host:port shown to the operator.
 *   4. noticeProviderEndpointHeld(db, row, heldConflictId) — one bell item per
 *      OPEN held conflict, by name, linking to the conflict review; and
 *      clearProviderEndpointHeldNotice(db, id) — quiet it once the operator has
 *      decided.
 *
 * Everything is per-DEVICE: the key never syncs (instance-sync.js's
 * LOCAL_ONLY_COLUMNS), so "this device holds a key" is a local question, and
 * the notice is a local notification (never emitted to a peer).
 */
import { providerDisplayName } from "./provider-key-need.js";

/** The conflict-review page a held endpoint change is decided on. */
export const SYNC_CONFLICTS_URL = "/dashboard/settings?section=sync-conflicts";

/**
 * The comparable identity of an endpoint: `origin + path`, trailing slash
 * ignored (so `https://api.openai.com/v1/` and `https://api.openai.com/v1` are
 * the same address). A port is part of it (it is part of `origin`), a query or
 * fragment is not — nothing dials those.
 *
 * A string that is not a URL at all (a bare host, junk) is compared as written,
 * also without a trailing slash: the operator's own row can hold one, and a
 * peer changing it is still a change.
 *
 * @param {unknown} url
 * @returns {string|null} null when there is no address at all
 */
export function providerEndpointKey(url) {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  if (raw === "") return null;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/**
 * Did an inbound row move the endpoint? Pure.
 *
 * Only a row that CARRIES an address can move it: a models-only update (no
 * `base_url` key, or an empty one) is never an endpoint change, which is what
 * keeps ordinary edits flowing.
 *
 * @param {unknown} before — the local row's base_url
 * @param {unknown} after — the incoming row's base_url
 * @returns {boolean}
 */
export function providerEndpointChanged(before, after) {
  const next = providerEndpointKey(after);
  if (next === null) return false;
  return providerEndpointKey(before) !== next;
}

/**
 * `scheme://host[:port]` for the operator-facing line — the part they can
 * recognise at a glance. Falls back to the address as written.
 * @param {unknown} url
 * @returns {string}
 */
export function providerOrigin(url) {
  if (typeof url !== "string") return "";
  const raw = url.trim();
  if (raw === "") return "";
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/** The notification `source` for one provider id — the per-id dedupe key. */
export function endpointHoldNoticeSource(id) {
  return `providers:endpoint-held:${String(id)}`;
}

/**
 * The notice metadata key holding the id of the held conflict it announced. The
 * bell is owed once per OPEN held conflict (fix round 2): a re-delivery of the
 * same held change — read or dismissed — is silent, while a NEW held conflict
 * formed after the previous one was resolved may ring again.
 */
export const HELD_CONFLICT_METADATA_KEY = "heldConflictId";

/** The held conflict id a notice was raised for, or null (pre-upgrade notice). Pure. */
function heldConflictOf(metadataJson) {
  if (!metadataJson) return null;
  try {
    const id = JSON.parse(metadataJson)?.[HELD_CONFLICT_METADATA_KEY];
    return Number.isFinite(Number(id)) ? Number(id) : null;
  } catch {
    return null;
  }
}

async function readLang(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'language'",
      args: [],
    });
    return rows[0]?.value === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

/**
 * Ring the bell ONCE per OPEN held conflict: "another device wants to change its
 * address". A newer held change for the same provider REPLACES the open conflict
 * rather than adding one (instance-sync.js), so the same conflict id is in hand
 * and it must not ring again — even after the operator read or dismissed the
 * notice. Only a NEW held conflict (a new sync_conflicts row, made after the
 * previous one was resolved) rings again.
 *
 * @param {object} db
 * @param {object} row — this device's providers row
 * @param {number|null} [heldConflictId] — the open sync_conflicts row this hold
 *   created; without it the notice falls back to the coarser per-provider dedupe
 *   (one open notice at a time).
 * @returns {Promise<"raised"|"already"|"filtered">}
 */
export async function noticeProviderEndpointHeld(db, row, heldConflictId = null) {
  const id = row?.id;
  if (typeof id !== "string" || id === "") return "already";
  const source = endpointHoldNoticeSource(id);
  const conflictId = Number.isFinite(Number(heldConflictId)) ? Number(heldConflictId) : null;
  const { rows: prior } = await db.execute({
    sql: "SELECT id, metadata, is_read, is_dismissed FROM notifications WHERE source = ?",
    args: [source],
  });
  const alreadyRang = prior.some((n) => {
    const recorded = heldConflictOf(n.metadata);
    // A notice raised before this round carries no conflict id: it can only be
    // attributed to the held change it named while it is still open.
    if (recorded === null) return Number(n.is_read) === 0 && Number(n.is_dismissed) === 0;
    return conflictId !== null && recorded === conflictId;
  });
  if (alreadyRang) return "already";

  // Loaded lazily: notifications.js and the i18n table are gateway-facing, and
  // this runs from the sync manager (which the stdio memory server also hosts).
  const [{ createNotification }, { t, fill }] = await Promise.all([
    import("./notifications.js"),
    import("../gateway/dashboard/shared/i18n.js"),
  ]);
  const lang = await readLang(db);
  const created = await createNotification(db, {
    type: "system",
    source,
    priority: "high",
    title: fill(t("providers.endpointHoldTitle", lang), { name: providerDisplayName(row) }),
    body: t("providers.endpointHoldBody", lang),
    action_url: SYNC_CONFLICTS_URL,
    metadata: conflictId === null ? null : { [HELD_CONFLICT_METADATA_KEY]: conflictId },
  });
  return created ? "raised" : "filtered";
}

/**
 * Quiet that notice because the operator decided the conflict (kept the local
 * address, or accepted the new one). Marks it read rather than deleting it, so
 * it stays in the bell's history; the NEXT held change raises a fresh one.
 * @returns {Promise<number>} rows touched
 */
export async function clearProviderEndpointHeldNotice(db, id) {
  if (typeof id !== "string" || id === "") return 0;
  const r = await db.execute({
    sql: `UPDATE notifications SET is_read = 1, updated_at = datetime('now')
          WHERE source = ? AND is_read = 0`,
    args: [endpointHoldNoticeSource(id)],
  });
  return Number(r.rowsAffected ?? 0);
}

/**
 * As above, for "resolve all": every held endpoint change was just decided.
 * @returns {Promise<number>} rows touched
 */
export async function clearAllProviderEndpointHeldNotices(db) {
  const r = await db.execute({
    sql: `UPDATE notifications SET is_read = 1, updated_at = datetime('now')
          WHERE source LIKE 'providers:endpoint-held:%' AND is_read = 0`,
    args: [],
  });
  return Number(r.rowsAffected ?? 0);
}