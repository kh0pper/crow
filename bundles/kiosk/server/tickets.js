/**
 * Display tickets. A media element cannot send the display's token, and the token must never be
 * in a URL — so a stream is fetched through a ticket: 128 random bits in the path, created over
 * the authenticated session, bound to ONE device and ONE resource, useless on any other route.
 * Held in memory, by hash (the id itself is never stored or logged). The mount that serves a
 * ticket applies the display network gate BEFORE it looks the ticket up.
 *
 * A ticket ends when it is revoked, when its device is unpaired, or at its lifetime — and the
 * lifetime is a timer, not a check on the next visit: requests still open on it are cut then.
 */
import { createHash, randomBytes } from "node:crypto";

export const TICKET_ID = /^[A-Za-z0-9_-]{22}$/;
export const MAX_PER_DEVICE = 8;
/** A media element opens a second request for a seek while its first is still closing; nothing needs more. */
export const MAX_CONCURRENT = 2;
const hashOf = (id) => createHash("sha256").update("crow-kiosk-ticket-v1:" + id).digest("hex");

export function createTicketStore({ now = Date.now, random = () => randomBytes(16).toString("base64url"), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const byHash = new Map();   // insertion order = age
  function drop(t) {
    if (!byHash.delete(t.key)) return;
    clearTimer(t.timer);
    try { t.abort.abort(); } catch {}
  }
  function sweep() { const at = now(); for (const t of [...byHash.values()]) if (at >= t.expires) drop(t); }
  const find = (id) => (typeof id === "string" && TICKET_ID.test(id) ? byHash.get(hashOf(id)) || null : null);
  return {
    /** → { id, path }. The id leaves this function once, inside the path sent to its display. */
    mint({ deviceId, kind, resource, ttlMs }) {
      sweep();
      const mine = [...byHash.values()].filter((t) => t.deviceId === deviceId);
      while (mine.length >= MAX_PER_DEVICE) drop(mine.shift());
      const id = random();
      const t = { key: hashOf(id), deviceId, kind, resource, expires: now() + ttlMs, open: 0, abort: new AbortController(), timer: null };
      t.timer = setTimer(() => drop(t), ttlMs);
      t.timer?.unref?.();
      byHash.set(t.key, t);
      return { id, path: `/display/t/${id}/${kind}` };
    },
    get(id) {
      const t = find(id);
      if (!t) return null;
      if (now() >= t.expires) { drop(t); return null; }
      return t;
    },
    enter(t) { if (t.open >= MAX_CONCURRENT) return false; t.open++; return true; },
    leave(t) { if (t.open > 0) t.open--; },
    revoke(id) { const t = find(id); if (t) drop(t); },
    revokeDevice(deviceId) { for (const t of [...byHash.values()]) if (t.deviceId === deviceId) drop(t); },
    size: () => byHash.size,
    /** Tests only: what the store holds (hashes, never ids). */
    debugState: () => [...byHash.values()].map((t) => ({ key: t.key, deviceId: t.deviceId, kind: t.kind, expires: t.expires })),
  };
}
