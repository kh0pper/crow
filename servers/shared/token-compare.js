/**
 * Constant-time bearer-token comparison, for the room verifiers
 * (servers/sharing/rooms.js and servers/gateway/routes/calls-rooms.js).
 *
 * Both sides are SHA-256'd first, so the two buffers always have the same
 * length (`timingSafeEqual` throws on unequal lengths) and the compare time
 * does not depend on how many leading characters matched or on the length of
 * what was presented. A missing or non-string token is a mismatch.
 *
 * node:crypto only — calls-rooms.js is imported by the gateway's boot path
 * precisely to avoid dragging the sharing server's graph in.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** True when `a` and `b` are the same string, compared in constant time
 *  (both sides are hashed, so the buffers always match in length). */
export function tokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}