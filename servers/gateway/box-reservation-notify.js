/**
 * Box-reservation visibility (scope §3.5): the operator hears ONCE per
 * reservation that the box is reserved, and ONCE per reservation that the
 * reservation refused a model start — so a stuck or surprising reservation is
 * visible from the phone without flooding the notification list.
 *
 * `reservationNotices` is a pure state machine (no I/O) the orchestrator
 * calls on every residency tick and on every refusal; `sendReservationNotice`
 * is the thin sender that must never throw back into the orchestrator (a
 * notification failure is never a reason to change model residency).
 */

import { createDbClient } from "../db.js";

/** @returns {{ seen: Map<string, {refused: boolean}> }} */
export function createNoticeState() {
  return { seen: new Map() };
}

/**
 * @param {{seen: Map}} state
 * @param {{reservation: object|null, refused?: {provider: string, requester: string}}} input
 * @returns {Array<{kind: "start"|"refused", reservation: object, refused?: object}>}
 */
export function reservationNotices(state, { reservation, refused } = {}) {
  if (!reservation) return [];
  const key = reservation.key || "unknown";
  const out = [];
  let entry = state.seen.get(key);
  if (!entry) {
    // Bounded: only the live reservation is remembered. A new key means the
    // previous reservation ended; its notices can never fire again anyway.
    state.seen.clear();
    entry = { refused: false };
    state.seen.set(key, entry);
    out.push({ kind: "start", reservation });
  }
  if (refused && !entry.refused) {
    entry.refused = true;
    out.push({ kind: "refused", reservation, refused: { provider: String(refused.provider || "?"), requester: String(refused.requester || "-") } });
  }
  return out;
}

function shape(notice) {
  const r = notice.reservation || {};
  const until = r.expires_at || "?";
  if (notice.kind === "refused") {
    const who = notice.refused || {};
    return {
      type: "system",
      priority: "high",
      title: `Box reservation refused a model start: ${who.provider || "?"}`,
      body: `Reserved by ${r.owner || "unknown"} until ${until}. Asked by ${who.requester || "-"}. Escalations degrade to the resident fast model until the reservation ends; run \`box-reserve release\` if it is stale.`,
      action_url: "/dashboard/models",
      metadata: { kind: "box_reservation_refused", owner: r.owner || null, expires_at: r.expires_at || null, provider: who.provider || null },
    };
  }
  return {
    type: "system",
    priority: "normal",
    title: r.corrupt
      ? "Box reservation file is unreadable — treating the box as reserved"
      : `Box reserved by ${r.owner || "unknown"} until ${until}`,
    body: r.corrupt
      ? "The reservation file could not be parsed; no local model will start until it is fixed or removed (box-reserve release)."
      : `${r.reason || "(no reason given)"} — non-allowed local model starts are refused until then.`,
    action_url: "/dashboard/models",
    metadata: { kind: "box_reservation_start", owner: r.owner || null, expires_at: r.expires_at || null, corrupt: !!r.corrupt },
  };
}

async function defaultNotify(opts) {
  let db;
  try {
    const { createNotification } = await import("../shared/notifications.js");
    db = createDbClient();
    await createNotification(db, opts);
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
}

/**
 * @param {{kind: string, reservation: object, refused?: object}} notice
 * @param {{notify?: (opts: object) => Promise<void>, log?: (msg: string) => void}} [deps]
 * @returns {Promise<boolean>} true when the notification was handed off, false on any failure (logged, never thrown).
 */
export async function sendReservationNotice(notice, { notify = defaultNotify, log = (m) => console.warn(m) } = {}) {
  try {
    await notify(shape(notice));
    return true;
  } catch (e) {
    log(`[gpu-orchestrator] reservation notice failed (non-fatal): ${(e && e.message) || e}`);
    return false;
  }
}
