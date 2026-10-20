/**
 * One-time download tickets for the keychain Export (2026-10-20).
 *
 * POST /export seals the file and parks it here under a random token; the browser (or the Crow
 * app) then GETs it once as a real attachment. The Nest reminder is recorded only when the file
 * was actually served, or, for the app, when it confirms the file was saved. In memory only: a
 * gateway restart forgets every ticket, and the user exports again.
 *
 * A ticket is bound to the dashboard session that made it, lives 2 minutes, and serves once. The
 * store keys sha256(token) and keeps sha256(session): neither raw value is held here, and the
 * sealed file is dropped as soon as it is served.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha = (v) => createHash("sha256").update(String(v)).digest();

export function createExportTickets({ now = Date.now, ttlMs = 120_000, confirmTtlMs = 600_000, max = 16 } = {}) {
  const tickets = new Map(); // hex sha256(token) → ticket

  const sweep = () => {
    const t = now();
    for (const [k, v] of tickets) {
      // An unclaimed file is dropped the moment its link expires; the husk stays a while so a
      // late click hears "expired" rather than "unknown".
      if (v.state === "ready" && t > v.expiresAt) { v.state = "expired"; v.file = null; v.record = null; v.confirmUntil = v.expiresAt; }
      if (v.state !== "ready" && t > v.confirmUntil + confirmTtlMs) tickets.delete(k);
    }
  };

  /** The ticket for (token, session), or null. A wrong session looks exactly like no ticket. */
  const find = (token, session) => {
    if (typeof token !== "string" || !TOKEN_RE.test(token) || typeof session !== "string" || !session) return null;
    const k = sha(token).toString("hex");
    const v = tickets.get(k);
    if (!v || !timingSafeEqual(v.session, sha(session))) return null;
    return { k, v };
  };

  function issue(session, { file, filename, keyId, snapshot, count }) {
    if (typeof session !== "string" || !session) throw new Error("a dashboard session is required");
    sweep();
    const s = sha(session);
    // One live link per session. A file already handed to the app and waiting for its "saved"
    // stays: a second Export while the picker is open must not turn that save into "not saved".
    for (const [k, v] of tickets) if (v.state === "ready" && timingSafeEqual(v.session, s)) tickets.delete(k);
    while (tickets.size >= max) tickets.delete(tickets.keys().next().value); // Map keeps insertion order
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + ttlMs;
    tickets.set(sha(token).toString("hex"), { session: s, state: "ready", expiresAt, confirmUntil: 0, file, filename, record: { keyId, snapshot, count }, count });
    return { token, expiresAt };
  }

  /** Serve the file once. deferRecord: the caller records only after confirm(). */
  function take(token, session, { deferRecord = false } = {}) {
    sweep();
    const hit = find(token, session);
    if (!hit) return { error: "not_found" };
    const { k, v } = hit;
    if (v.state === "expired") return { error: "expired" };
    if (v.state !== "ready") return { error: "used" };
    const out = { file: v.file, filename: v.filename, count: v.count, record: deferRecord ? null : v.record };
    v.file = null;
    if (deferRecord) {
      v.state = "served_pending";
      v.confirmUntil = now() + confirmTtlMs;
    } else {
      v.state = "served";
      v.record = null;
      v.confirmUntil = now();
    }
    return out;
  }

  /** The app saved the file: hand back the reminder record once. */
  function confirm(token, session) {
    sweep();
    const hit = find(token, session);
    if (!hit) return { error: "not_found" };
    const { k, v } = hit;
    if (v.state === "ready") return { error: "not_served" };
    if (v.state === "expired") return { error: "expired" };
    if (v.state !== "served_pending") return { error: "used" };
    if (now() > v.confirmUntil) { tickets.delete(k); return { error: "expired" }; }
    tickets.delete(k);
    return v.record;
  }

  return {
    issue, take, confirm,
    size: () => { sweep(); return tickets.size; },
    _debugEntries: () => [...tickets.entries()],
  };
}
