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
  const relays = new Map();
  const results = await Promise.allSettled(urls.map(async (url) => {
    const relay = await Promise.race([
      Relay.connect(url),
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
    try { subs.push(relay.subscribe([filter], { onevent })); } catch { /* per-relay */ }
  }
  return subs;
}

/** Publish an event to all relays (best-effort). */
export async function publish(relays, event) {
  for (const [, relay] of relays) { try { await relay.publish(event); } catch { /* per-relay */ } }
}
