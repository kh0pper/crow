/**
 * Minimal Nostr DM client for the pi-bots crow-messages adapter. Mirrors the
 * NIP-44 / kind:4 conventions in servers/sharing/nostr.js but stands alone in
 * the pi-bots host process. Pure helpers (xOnly/buildDM/openDM/makeDedupeGate)
 * are unit-tested; the relay wrappers are thin and exercised via injected stubs.
 */
// Polyfill WebSocket for Node < 22 (nostr-tools/relay needs it). NOTE: static
// imports below are HOISTED and evaluated before this top-level block runs, so
// textual order is NOT the mechanism — at module-eval time nostr-tools/relay
// captures the (still-undefined) global. What makes it work: ESM awaits this
// module's top-level `await import("ws")` (which sets globalThis.WebSocket)
// before start() runs, AND we pin the impl explicitly via
// useWebSocketImplementation so we don't rely on nostr-tools' runtime fallback.
// (Mirrors servers/sharing/nostr.js:12-20, hardened.)
if (typeof globalThis.WebSocket === "undefined") {
  try {
    const ws = await import("ws");
    globalThis.WebSocket = ws.default || ws.WebSocket;
  } catch {
    // ws not available — Nostr messaging will fail gracefully
  }
}
import { finalizeEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import { safeRelayPublish } from "../../../servers/sharing/safe-relay-publish.js";
import { makeResilientSub } from "../../../servers/sharing/resilient-subscribe.js";
import { installNostrCrashGuard } from "../../../servers/sharing/nostr-crash-guard.js";
// Pin the implementation explicitly (survives a future nostr-tools that drops
// the constructor-time `|| WebSocket` fallback).
if (globalThis.WebSocket) { try { useWebSocketImplementation(globalThis.WebSocket); } catch { /* older nostr-tools: runtime fallback covers it */ } }

/** Normalize any secp pubkey hex to Nostr x-only 64-hex (strip 02/03 prefix). */
export function xOnly(hex) {
  const h = String(hex || "");
  return h.length === 66 ? h.slice(2) : h;
}

/**
 * Cross-relay dedup gate. The same event id is delivered once PER relay; without
 * this, every inbound chat/accept runs N times (N pi turns, N replies). Returns
 * a function `(eventId) => boolean` that is true the FIRST time it sees an id and
 * false thereafter. Bounded (FIFO eviction) so a long-lived handle can't grow
 * without limit. (Mirrors the seenEventIds guard in nostr.js:330,345-346.)
 */
export function makeDedupeGate(maxSize = 4096) {
  const seen = new Set();
  return (eventId) => {
    if (!eventId) return false;
    if (seen.has(eventId)) return false;
    seen.add(eventId);
    if (seen.size > maxSize) seen.delete(seen.values().next().value);
    return true;
  };
}

/** Build a signed kind:4 NIP-44 DM from senderPriv to recipient (x-only hex). */
export function buildDM(senderPriv, recipientXOnlyPubkey, content) {
  const ck = nip44.v2.utils.getConversationKey(senderPriv, recipientXOnlyPubkey);
  const encrypted = nip44.v2.encrypt(content, ck);
  return finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientXOnlyPubkey]],
    content: encrypted,
  }, senderPriv);
}

/** Decrypt a kind:4 NIP-44 DM addressed to us, given the sender's x-only pubkey. */
export function openDM(recipientPriv, senderXOnlyPubkey, content) {
  const ck = nip44.v2.utils.getConversationKey(recipientPriv, xOnly(senderXOnlyPubkey));
  return nip44.v2.decrypt(content, ck);
}

/** Connect to relays; returns a Map<url, Relay> of those that connected. */
export async function connectRelays(urls, timeoutMs = 10000) {
  // Narrow process-level net for nostr-tools' orphaned close-race rejection
  // (2c-F1 C1b). Idempotent; the connect path is the choke point every pi-bots
  // host (bridge_tick, discord_gateway) passes through before touching relays.
  installNostrCrashGuard();
  const relays = new Map();
  const results = await Promise.allSettled(urls.map(async (url) => {
    const relay = await Promise.race([
      // enablePing is load-bearing for the health loop: a ping timeout closes a
      // silently-dead half-open socket (ws.close → relay.connected = false), which
      // is the ONLY signal ensureHealthy() has to trigger a reconnect/resubscribe.
      // Without it, relay.connected stays true forever and the sub never re-establishes.
      Relay.connect(url, { enablePing: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("connection timeout")), timeoutMs)),
    ]);
    return { url, relay };
  }));
  for (const r of results) if (r.status === "fulfilled") relays.set(r.value.url, r.value.relay);
  return relays;
}

/** Subscribe a filter across all relays; returns an array of sub handles. */
export function subscribe(relays, filter, onevent) {
  const subs = [];
  for (const [, relay] of relays) {
    // A dropped relay's subscribe() orphans an ASYNC rejected send()
    // (SendingOnClosedConnection) that the catch below cannot see — skip it
    // (no await between check and call; callers tolerate per-relay skips).
    if (!relay.connected) continue;
    try { subs.push(relay.subscribe([filter], { onevent })); } catch { /* per-relay */ }
  }
  return subs;
}

/**
 * Resilient variant of subscribe(): one self-healing handle per relay. The
 * caller drives recovery by calling ensureAllHealthy() on an interval and tears
 * down with stop(). Pair with Relay.connect(url, { enablePing: true }).
 */
export function subscribeResilient(relays, filter, onevent, opts = {}) {
  const handles = [];
  for (const [, relay] of relays) handles.push(makeResilientSub(relay, filter, onevent, opts));
  return {
    handles,
    // Heal all relays concurrently (parity with the gateway side): one slow/hung
    // relay reconnect must not serialize the others. ensureHealthy self-guards
    // (busy/stopped, bounded connect) so concurrent calls are safe.
    async ensureAllHealthy() { await Promise.allSettled(handles.map((h) => h.ensureHealthy())); },
    stop() { for (const h of handles) { try { h.close(); } catch {} } },
  };
}

/** Publish an event to all relays (best-effort). */
export async function publish(relays, event) {
  // safeRelayPublish reconnects-or-skips a dropped relay so a closed-connection
  // send() can't leak an unhandled rejection and crash the pi-bots host.
  for (const [, relay] of relays) { try { await safeRelayPublish(relay, event); } catch { /* per-relay */ } }
}
