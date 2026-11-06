/**
 * v1 Fix-it detector: a peer instance was denied a tool call because the owning
 * capability isn't exposed to THAT peer. Hooks the `peer-exposure:denied` event
 * emitted at the enforcePeerExposure chokepoint.
 *
 * N1b-8 (security audit): the card used to be a single "Allow" that added the
 * capability to the all-trusted-peers allowlist — one peer's request, one click,
 * every peer and no expiry. Now:
 *   - the card is keyed by the VERIFIED peer instance id (`requestingInstance`,
 *     never a name or id from the request body) and the Allow remedies grant
 *     that peer only, for a chosen duration;
 *   - at most MAX_OPEN_CARDS_PER_PEER open cards per peer, and at most one new
 *     card per peer per capability per 24 h (peer-card-policy.js);
 *   - requests that earn no card are COUNTED, not dropped silently.
 *
 * Review round 1:
 *   - B1: the decide-then-upsert step runs under a per-peer lock
 *     (peer-card-lock.js), so concurrent denials cannot all see "no cards" and
 *     each create one;
 *   - B2: `capabilityKnown === false` (the gate could not match the id against
 *     this instance's own catalog) earns no card and ONE counter bucket per
 *     peer, never a key built from the peer's own string.
 *
 * Review round 2:
 *   - SF1: a `dedupe` decision acts on the EXISTING card, whatever key shape it
 *     was written with — it never falls through to an upsert that would insert
 *     a second open card under the new key;
 *   - N-b: that per-peer queue is bounded (peer-card-lock.js), so a flood is
 *     dropped and counted in memory instead of queued without limit.
 *
 * Fix round 3: the card records `context.pairingTag` — the tag of the pairing
 * the denial was verified under (the gate sends it; see
 * servers/gateway/peer-exposure.js). The remedy refuses a card whose tag does
 * not match the peer's CURRENT `auth_token_hash`, which is what stops an old
 * card from granting the peer after a revoke→re-pair under the same id. A
 * pending card carrying another pairing's tag is stale: the policy names it and
 * this detector resolves it before deciding again (a new card must never dedupe
 * onto a card that can never be allowed).
 *
 * DB-free: it composes strings from the (already name-enriched) payload and the
 * pure friendly-name map, then calls the db-bound store it's handed.
 */
import { resolveFriendlyName } from "../friendly-names.js";
import { normalizePeerId, normalizePairingTag } from "../../../shared/peer-id.js";
import { UNKNOWN_CAPABILITY_BUCKET } from "../peer-card-counters.js";
import { withPeerLock } from "../peer-card-lock.js";
import {
  cardRemedies,
  decidePeerExposureCard,
  dedupKeyFor,
} from "../peer-card-policy.js";

const SOURCE = "remote-exposure";

/** The decide-then-upsert body, run under the per-peer lock. */
async function decideAndStore({ capability, peerId, peerName, toolName, tag, store, now }) {
  let items = [];
  try {
    items = typeof store?.listBySource === "function" ? await store.listBySource(SOURCE) : [];
  } catch { items = []; }

  const decision = decidePeerExposureCard({ items, peerId, capability, pairingTag: tag, now });

  // Fix round 3: a pending card raised under another pairing can never be
  // allowed (the remedy compares tags), so it must not answer this request.
  // Resolve it first, then carry on with the decision, which was already made
  // as if it did not exist. Best-effort, like the rest of this path.
  for (const staleId of decision.staleItemIds || []) {
    try {
      if (store?.markResolved) await store.markResolved(staleId);
    } catch { /* best-effort: this runs on the peer-exposure request path */ }
  }

  // SF1 (review round 2): `dedupe` means this (capability, peer) pair already
  // owns a card — possibly one written under the PRE-round-1 key shape
  // (`expose:<cap>:<peer>`). Act on THAT row: upserting here would write the
  // NEW key and insert a SECOND open card for the same request.
  if (decision.action === "dedupe") {
    try {
      if (store?.recordDuplicate) await store.recordDuplicate(decision.itemId);
    } catch { /* best-effort: this runs on the peer-exposure request path */ }
    return;
  }

  if (decision.action === "drop" || decision.action === "count") {
    // Recorded, but no card (or no NEW card). Never let bookkeeping break the
    // request path — the caller is the peer-exposure gate.
    try {
      if (decision.action === "count" && store?.recordDuplicate) {
        await store.recordDuplicate(decision.itemId);
      }
      if (store?.recordSuppressed) {
        await store.recordSuppressed({ peerId, capability, reason: decision.reason || decision.action, now });
      }
    } catch { /* best-effort bookkeeping */ }
    return; // no card, no NEW card
  }

  const friendly = resolveFriendlyName(capability);
  // `requestingInstanceName` is the peer's label as THIS instance stored it
  // (fix-it/index.js resolves it from the instance registry by the verified
  // id) — display text only; identity stays `peerId`.
  const peer = peerName || "another device";
  await store.upsertItem({
    source: SOURCE,
    dedupKey: dedupKeyFor(peerId, capability, tag),
    title: `Your ${peer} tried to use ${friendly}, but it isn't shared with this device yet`,
    why: `Allow it for ${peer} only — your other Crows stay unchanged, and the allowance can expire or be removed in Settings.`,
    severity: "warn",
    remedies: cardRemedies(capability, peerId),
    context: { capability, requestingInstance: peerId, toolName: toolName || null, pairingTag: normalizePairingTag(tag) },
  });
}

export default {
  source: SOURCE,
  events: ["peer-exposure:denied"],
  async onEvent(_eventName, payload, store) {
    const { capability, requestingInstance, requestingInstanceName, toolName, capabilityKnown, pairingTag } = payload || {};

    // The identity is the id the request was VERIFIED with. Anything else (a
    // display name, a missing id, a non-id string) earns no card at all: a card
    // we cannot scope to one peer is a card we must not offer.
    const peerId = normalizePeerId(requestingInstance);
    if (!peerId) return;

    const now = typeof store?.now === "function" ? store.now() : Date.now();

    // B2: the peer named a tool the gate could not match to a capability of
    // this instance (it may not even be id-shaped, hence the check before the
    // `!capability` guard). It is refused — the gate already did that — and
    // counted in one bounded bucket: no card, and no counter key the peer chose.
    if (capabilityKnown === false) {
      try {
        if (store?.recordSuppressed) {
          await store.recordSuppressed({
            peerId,
            capability: UNKNOWN_CAPABILITY_BUCKET,
            reason: "unknown_capability",
            now,
          });
        }
      } catch { /* best-effort bookkeeping */ }
      return;
    }

    if (!capability) return; // only real, resolvable capabilities become cards

    // B1: serialise the read-decide-write per peer.
    await withPeerLock(peerId, () => decideAndStore({
      capability, peerId, peerName: requestingInstanceName, toolName, tag: pairingTag, store, now,
    }));
  },
};