/**
 * Box hold (read-only): the current "this machine is spoken for" record from box-reservation.js,
 * as the Schedule page shows it. A missing or expired record is no hold; a record the reader
 * can't trust (fail-closed CORRUPT) is a problem with a copyable release command.
 */
import { readReservation } from "../box-reservation.js";

/** The release command the "Box hold unreadable" problem offers to copy (never run here). */
export const RELEASE_COMMAND = "node scripts/ops/box-reserve.mjs release";

const ms = (s) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? t : null; };

/**
 * @returns {{state:"none"} | {state:"corrupt"} |
 *   {state:"active", owner:string, reason:string, started:number|null, ends:number}}
 */
export function readBoxHold({ now = Date.now(), path } = {}) {
  let r;
  try { r = readReservation(path ? { now, path } : { now }); } catch { return { state: "none" }; }
  if (!r) return { state: "none" };
  if (r.corrupt) return { state: "corrupt" };
  return {
    state: "active",
    owner: String(r.owner || "").slice(0, 80),
    reason: String(r.reason || "").slice(0, 200),
    started: ms(r.started_at),
    ends: ms(r.expires_at),
  };
}
