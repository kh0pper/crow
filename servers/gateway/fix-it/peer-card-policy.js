/**
 * N1b-8: pure policy for a peer-exposure "Allow" card.
 *
 * The old card was a single button that added the capability to the ALL-PEERS
 * allowlist — one peer, one click, every peer forever. The card is now scoped to
 * the peer that asked (identified by the VERIFIED instance id) and the operator
 * picks how long the grant lasts. This module holds the parts that need no I/O:
 * the remedy set, the dedupe key, and the rate-limit decision, so they can be
 * asserted directly with an injected clock.
 *
 * Rate limits (per peer, so one noisy peer cannot flood the Nest):
 *   - at most MAX_OPEN_CARDS_PER_PEER pending "Allow" cards;
 *   - at most ONE new card per peer per capability per 24 h — a repeat inside
 *     that window bumps the existing card's count instead of creating a card;
 *   - anything beyond a limit is counted (peer_exposure_card_suppressed) and
 *     creates no card.
 *
 * Fix round 3 (N1b-8): a card is also bound to the PAIRING it was raised under
 * (`context.pairingTag`, a tag of the peer's `auth_token_hash`). A pending card
 * whose tag is not this event's tag was raised by a pairing that is gone, so the
 * remedy will refuse it — it must not own this request's dedupe slot either.
 * Such a card is STALE: the decision names it in `staleItemIds` so the detector
 * resolves it and the request is decided as if it did not exist.
 */
import { normalizePairingTag } from "../../shared/peer-id.js";

export const MAX_OPEN_CARDS_PER_PEER = 3;
export const NEW_CARD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The durations the operator may pick on the card. 30 days is the default (it
 * renders first); `days: null` = "until I remove it" and never expires.
 *
 * Each has its OWN actionId: the Nest renders one POST form per remedy and the
 * action handler submits only `action_id`, so three buttons sharing one id would
 * be indistinguishable (every click would mean 30 days).
 */
export const CARD_DURATIONS = Object.freeze([
  { label: "Allow for 30 days", days: 30, actionId: "expose-capability-30d" },
  { label: "Allow for 7 days", days: 7, actionId: "expose-capability-7d" },
  { label: "Allow until I remove it", days: null, actionId: "expose-capability-forever" },
]);

/** Every actionId this card can post; the gateway registers all of them. */
export const CARD_ACTION_IDS = Object.freeze(CARD_DURATIONS.map((d) => d.actionId));

/**
 * Field separator for the dedupe key (N1, review round 1).
 *
 * The old key was `expose:<capability>:<peerId>`, but BOTH parts may contain a
 * colon — peer ids are `[A-Za-z0-9._:-]{1,128}` (servers/shared/peer-id.js), and
 * a capability id may be an installed-extension id (an `mcp-addons.json` key) —
 * so `expose:a:b:c` was ambiguous. `|` cannot appear in a peer id (the regex
 * excludes it). Nothing checks the SHAPE of a capability id — capability-ids.js
 * only requires provenance: the id is either `crow-<manifest category>` or a key
 * of this instance's own addon file, never a string a peer chose (round 2, N-e —
 * in round 1 the peer's tool name could reach this key). Cards written before
 * this change are still found by legacyDedupKeyFor().
 */
const DEDUP_SEP = "|";

/**
 * Stable dedupe key: one card per (capability, peer) — and, fix round 3, one per
 * PAIRING when the event carries a pairing tag.
 *
 * The tag segment exists because `fix_it_items` is UNIQUE(source, dedup_key):
 * when a stale card (raised under an earlier pairing) is resolved and the current
 * pairing raises its own, both rows must be able to exist, so the new card needs
 * its own key. It is also the honest shape — a card from another pairing is a
 * DIFFERENT question, not a repeat of this one. The tag is 16 hex chars
 * (servers/shared/peer-id.js), so it cannot make the key ambiguous; a card
 * written before tags existed keeps the plain three-part key, which the policy
 * still finds (by key and by its stored capability).
 */
export function dedupKeyFor(peerId, capability, tag = null) {
  const base = `expose${DEDUP_SEP}${capability}${DEDUP_SEP}${peerId}`;
  const pairing = normalizePairingTag(tag);
  return pairing ? `${base}${DEDUP_SEP}${pairing}` : base;
}

/** The pre-round-1 key shape, still read so an open card keeps its dedupe. */
export function legacyDedupKeyFor(peerId, capability) {
  return `expose:${capability}:${peerId}`;
}

/**
 * The card's remedy buttons. Every arg needed to scope the grant travels in the
 * stored card (`capability` + the verified `requestingInstance`), never from the
 * request that triggered the card.
 */
export function cardRemedies(capability, peerId) {
  return CARD_DURATIONS.map(({ label, days, actionId }) => ({
    label,
    actionId,
    kind: "instant",
    args: days == null
      ? { capability, requestingInstance: peerId, untilRemoved: true }
      : { capability, requestingInstance: peerId, days },
  }));
}

/**
 * SQLite stores `datetime('now')` as "YYYY-MM-DD HH:MM:SS" in UTC, which
 * Date.parse() reads as LOCAL time. Treat a bare timestamp as UTC.
 */
export function parseDbTime(value) {
  if (typeof value !== "string" || !value) return NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Date.parse(iso);
}

/**
 * Decide what a denial event should do with the card store.
 *
 * @param {object} o
 * @param {Array} o.items every existing card of this detector's source (any status)
 * @param {string} o.peerId verified peer instance id
 * @param {string} o.capability canonical capability id
 * @param {string|null} [o.pairingTag] tag of the pairing this event was verified under
 * @param {number} [o.now] injected clock (tests)
 * @returns {{action: "create"|"dedupe"|"count"|"drop", itemId?: number, reason?: string, staleItemIds?: number[]}}
 */
export function decidePeerExposureCard({ items = [], peerId, capability, pairingTag: tag = null, now = Date.now() } = {}) {
  const key = dedupKeyFor(peerId, capability, tag);
  const legacyKey = legacyDedupKeyFor(peerId, capability);
  const incomingTag = normalizePairingTag(tag);
  const mineAll = (items || []).filter((i) => i && i.context && i.context.requestingInstance === peerId);
  // An OPEN card is stale when this event's pairing is KNOWN and that card was
  // raised under a different one (or before tags existed, which is `null`): it
  // can never be allowed, so it must not own this request's dedupe slot. Two
  // nulls are the same (untagged) pairing, so a pre-round-3 card still dedupes
  // onto itself rather than multiplying; and an event whose tag could not be
  // read (null) makes no claim about an existing card, so it leaves it alone.
  const stale = incomingTag
    ? mineAll.filter((i) => i.status === "pending" && normalizePairingTag(i.context?.pairingTag) !== incomingTag)
    : [];
  const mine = stale.length ? mineAll.filter((i) => !stale.includes(i)) : mineAll;
  // Both key shapes (a card opened before round 1 still owns its dedupe slot),
  // else the stored capability — which is what the rate limit really means.
  const existing = mine.find((i) => i.dedupKey === key || i.dedupKey === legacyKey)
    || mine.find((i) => i.context?.capability === capability);
  // Name the stale cards on whatever we decide, so the detector can resolve them
  // first. Omitted when empty: the decision objects are asserted literally.
  const withStale = (d) => (stale.length ? { ...d, staleItemIds: stale.map((i) => i.id) } : d);

  if (existing) {
    // Same request again while the card is open → the store's upsert bumps its
    // count and keeps one card (that IS the dedupe).
    if (existing.status === "pending") return withStale({ action: "dedupe", itemId: existing.id });
    // Already answered (resolved or dismissed) inside the 24 h window: record
    // the request on that card, but do NOT reopen it — reopening is a NEW card.
    const touched = parseDbTime(existing.updatedAt || existing.createdAt);
    if (Number.isFinite(touched) && now - touched < NEW_CARD_WINDOW_MS) {
      return withStale({ action: "count", itemId: existing.id, reason: "same_capability_within_24h" });
    }
  }

  const open = mine.filter((i) => i.status === "pending");
  if (open.length >= MAX_OPEN_CARDS_PER_PEER) return withStale({ action: "drop", reason: "open_card_cap" });
  return withStale({ action: "create" });
}