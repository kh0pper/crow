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
 * DB-free: it composes strings from the (already name-enriched) payload and the
 * pure friendly-name map, then calls the db-bound store it's handed.
 */
import { resolveFriendlyName } from "../friendly-names.js";
import { normalizePeerId } from "../../../shared/peer-id.js";
import {
  cardRemedies,
  decidePeerExposureCard,
  dedupKeyFor,
} from "../peer-card-policy.js";

const SOURCE = "remote-exposure";

export default {
  source: SOURCE,
  events: ["peer-exposure:denied"],
  async onEvent(_eventName, payload, store) {
    const { capability, requestingInstance, requestingInstanceName, toolName } = payload || {};
    if (!capability) return; // only real, resolvable capabilities become cards

    // The identity is the id the request was VERIFIED with. Anything else (a
    // display name, a missing id, a non-id string) earns no card at all: a card
    // we cannot scope to one peer is a card we must not offer.
    const peerId = normalizePeerId(requestingInstance);
    if (!peerId) return;

    const now = typeof store?.now === "function" ? store.now() : Date.now();

    let items = [];
    try {
      items = typeof store?.listBySource === "function" ? await store.listBySource(SOURCE) : [];
    } catch { items = []; }

    const decision = decidePeerExposureCard({ items, peerId, capability, now });
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
    const peer = requestingInstanceName || "another device";
    await store.upsertItem({
      source: SOURCE,
      dedupKey: dedupKeyFor(peerId, capability),
      title: `Your ${peer} tried to use ${friendly}, but it isn't shared with this device yet`,
      why: `Allow it for ${peer} only — your other Crows stay unchanged, and the allowance can expire or be removed in Settings.`,
      severity: "warn",
      remedies: cardRemedies(capability, peerId),
      context: { capability, requestingInstance: peerId, toolName: toolName || null },
    });
  },
};