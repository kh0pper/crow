/**
 * The booking calendar — the persistent half of the one box calendar (the
 * private engineering notes §6.3). The active hold lives in
 * ./box-reservation.js; this module is the schedule that hold is taken from:
 * model windows, manual holds, the nightly audit and GPU jobs all book their
 * time here, and the active hold is at most one of those bookings at a time.
 *
 * On disk it is `{version: 1, bookings: [...]}` at `schedulePath()`. Every
 * write goes to a temp file and is renamed in the same directory, and every
 * read-modify-write runs under the one box lock from ./box-reservation.js
 * (never the lock the hold file would imply: the lock lives beside the
 * calendar so two processes with different hold paths still serialise).
 *
 * A missing file is an empty calendar. A file that is not JSON, or one with
 * no `bookings` array, raises CalendarCorruptError from every function that
 * reads it, and is never reset or overwritten: a calendar we cannot read is a
 * calendar whose promises we cannot see, so replacing it would drop someone's
 * booked time. Hold reads (`readReservation`) never touch this file.
 *
 * Bookings persist `start` / `end` as ISO-8601 UTC strings; callers pass epoch
 * milliseconds (or "now" / "asap" for `book`), and all comparisons are in ms.
 * `[start, end)` overlap is a conflict, so adjacent windows [a, b) [b, c) sit
 * side by side. An unexpired active hold with no `booking_id` is a legacy
 * writer's hold and occupies `[started_at, expires_at)` in the same checks; a
 * hold that names a booking is represented by that booking, not counted twice.
 *
 * A pending approval older than 12 h (the private engineering notes §7.10)
 * reads as declined without writing the file, so a stale request can never be
 * approved by waiting. Done, cancelled and lapsed bookings are pruned once
 * they ended more than 30 days ago; a recurring series is never pruned.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  lockPath, readReservation, reservationPath, schedulePath, withReservationLock,
} from "./box-reservation.js";

// The path helper is part of the calendar's public surface.
export { schedulePath };

const CALENDAR_VERSION = 1;
const APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const GAP_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const BOOKING_KINDS = Object.freeze(["window", "gpu-job", "manual", "audit"]);
const BOOKING_MODES = Object.freeze(["exclusive", "beside"]);
const LIVE_STATUSES = Object.freeze(["booked", "active"]);

export class CalendarCorruptError extends Error {
  constructor(message = "the box calendar file is unreadable") {
    super(message);
    this.name = "CalendarCorruptError";
    this.code = "calendar_corrupt";
    this.http = 500;
  }
}

export class BookingConflictError extends Error {
  /** @param {Object} conflict the booking (or legacy hold) in the way. */
  constructor(conflict) {
    const owner = (conflict && conflict.owner) || "unknown";
    const reason = conflict && conflict.kind === "legacy-hold"
      ? "a live hold"
      : (conflict && conflict.id ? `booking ${conflict.id}` : "a booking");
    const until = conflict && conflict.end ? ` until ${conflict.end}` : "";
    super(`box is booked by ${owner} (${reason})${until}`);
    this.name = "BookingConflictError";
    this.code = "booking_conflict";
    this.http = 409;
    this.conflict = conflict;
  }
}

function codeError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  return Object.assign(err, extra);
}

function badBooking(message) {
  const err = new TypeError(message);
  err.code = "bad_booking";
  return err;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Epoch ms for a number or a date string; null when it is neither. */
function msOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveMinutes(minutes, where) {
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0) {
    throw badBooking(`${where}: minutes must be a positive number`);
  }
  return mins;
}

function optionalNumber(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry !== "");
}

function newBookingId() {
  return "bk_" + randomBytes(6).toString("hex");
}

/** The lock file for a calendar path: always beside the calendar file. */
function lockFileFor(path) {
  return path ? join(dirname(path), "crow-box-schedule.lock") : lockPath();
}

function lockOptions(options) {
  if (options && options.lock) return options.lock;
  return { path: lockFileFor(options && options.path) };
}

// ---------------------------------------------------------------------------
// The file itself.

/** Read and validate the calendar. `ENOENT` is an empty calendar. */
function readCalendar(path = schedulePath()) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { version: CALENDAR_VERSION, bookings: [] };
    throw new CalendarCorruptError(`the box calendar file is unreadable: ${err && err.message ? err.message : err}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CalendarCorruptError("the box calendar file is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.bookings)) {
    throw new CalendarCorruptError("the box calendar file has no bookings array");
  }
  return { version: CALENDAR_VERSION, bookings: raw.bookings };
}

/** Old finished bookings are dropped; a recurring series is kept forever. */
function pruneBookings(bookings, now) {
  return bookings.filter((booking) => {
    if (!booking || typeof booking !== "object") return false;
    if (booking.recur) return true;
    if (booking.status !== "done" && booking.status !== "cancelled" && booking.status !== "lapsed") return true;
    const endMs = msOf(booking.end);
    return endMs == null || endMs >= now - PRUNE_AFTER_MS;
  });
}

/** Write the calendar atomically (tmp + rename in the same directory). */
function writeCalendar(cal, path = schedulePath(), now = Date.now()) {
  const kept = pruneBookings(cal.bookings, now);
  const dir = dirname(path);
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists or unwritable — the write reports it */ }
  const tmp = join(dir, `.crow-box-schedule.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify({ version: CALENDAR_VERSION, bookings: kept }, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
  cal.bookings = kept;
}

// ---------------------------------------------------------------------------
// Approval reads (never written on read).

function approvalExpired(booking, now) {
  const createdMs = msOf(booking.created_at);
  return createdMs != null && now - createdMs > APPROVAL_TTL_MS;
}

function bookingForRead(booking, now) {
  if (booking && booking.approval && booking.approval.state === "pending" && approvalExpired(booking, now)) {
    return { ...booking, approval: { ...booking.approval, state: "declined", by: "expired" } };
  }
  return booking;
}

/**
 * @param {{from?: number|string, to?: number|string, path?: string, now?: number}} [options]
 * @returns {Object[]} bookings overlapping [from, to), sorted by start. A
 *   pending approval older than the 12 h TTL reads as declined by "expired".
 */
export function listBookings({ from, to, path = schedulePath(), now = Date.now() } = {}) {
  const cal = readCalendar(path);
  return collectBookings(cal, { from, to, now });
}

/** The read core. A recurring series expands into occurrences here. */
function collectBookings(cal, { from, to, now }) {
  const fromMs = from == null ? null : msOf(from);
  const toMs = to == null ? null : msOf(to);
  const out = [];
  for (const booking of cal.bookings) {
    if (!booking || typeof booking !== "object") continue;
    const startMs = msOf(booking.start);
    const endMs = msOf(booking.end);
    if (startMs == null || endMs == null) continue;
    if (fromMs != null && endMs <= fromMs) continue;
    if (toMs != null && startMs >= toMs) continue;
    out.push(bookingForRead(booking, now));
  }
  out.sort((a, b) => (msOf(a.start) ?? 0) - (msOf(b.start) ?? 0));
  return out;
}

// ---------------------------------------------------------------------------
// Occupancy: live bookings plus the one active hold.

/**
 * Everything that occupies box time right now, as sorted `{start, end,
 * conflict}` intervals. Throws `hold_corrupt` when the hold file cannot be
 * read: guessing an interval for it would be worse than refusing.
 */
function occupiedIntervals(cal, { now = Date.now(), holdPath } = {}) {
  const out = [];
  for (const booking of cal.bookings) {
    if (!booking || typeof booking !== "object") continue;
    if (!LIVE_STATUSES.includes(booking.status)) continue;
    const startMs = msOf(booking.start);
    const endMs = msOf(booking.end);
    if (startMs == null || endMs == null || endMs <= startMs) continue;
    out.push({ start: startMs, end: endMs, conflict: booking });
  }
  const hold = readReservation({ path: holdPath || reservationPath(), now });
  if (hold && hold.corrupt) {
    throw codeError("hold_corrupt", "the box reservation file is unreadable; refusing to guess what it holds");
  }
  if (hold && !hold.corrupt) {
    const linked = hold.booking_id
      ? cal.bookings.find((booking) => booking && booking.id === hold.booking_id)
      : null;
    const linkedOccupies = linked && LIVE_STATUSES.includes(linked.status);
    if (!linkedOccupies) {
      const endMs = msOf(hold.expires_at);
      const startedMs = msOf(hold.started_at);
      const startMs = startedMs == null ? now : startedMs;
      if (endMs != null && endMs > startMs) {
        out.push({
          start: startMs,
          end: endMs,
          conflict: {
            id: hold.booking_id || null,
            owner: hold.owner,
            kind: hold.booking_id ? "hold" : "legacy-hold",
            start: iso(startMs),
            end: iso(endMs),
          },
        });
      }
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

function assertFree(intervals, startMs, endMs) {
  for (const interval of intervals) {
    if (startMs < interval.end && interval.start < endMs) throw new BookingConflictError(interval.conflict);
  }
}

/** The start of the first free gap of `minutes`, within 14 days of `after`. */
function firstGap(intervals, minutes, afterMs) {
  const durationMs = Math.round(minutes * 60_000);
  const horizon = afterMs + GAP_HORIZON_MS;
  let cursor = afterMs;
  for (const interval of intervals) {
    if (interval.end <= cursor) continue;
    if (interval.start >= cursor + durationMs) return cursor;
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor + durationMs <= horizon) return cursor;
  throw codeError("no_gap", `no free gap of ${minutes} min within 14 days of ${iso(afterMs)}`);
}

/**
 * @param {{minutes: number, after: number, path?: string, holdPath?: string, now?: number}} options
 * @returns {number} the start (epoch ms) of the first free gap of at least
 *   `minutes` at or after `after`. Throws `{code: "no_gap"}` when the 14 day
 *   horizon holds nothing.
 */
export function findGap({ minutes, after = Date.now(), path = schedulePath(), holdPath, now = Date.now() } = {}) {
  const mins = positiveMinutes(minutes, "findGap");
  const afterMs = msOf(after);
  if (afterMs == null) throw badBooking("findGap: after must be a time in epoch ms");
  const cal = readCalendar(path);
  return firstGap(occupiedIntervals(cal, { now, holdPath }), mins, afterMs);
}

// ---------------------------------------------------------------------------
// Writes. Each public function is a lock-free `…Locked` core (the caller
// holds the one lock) plus a wrapper that takes it once. The lock is not
// re-entrant, so a composed operation must call the core directly.

function findBooking(cal, id) {
  const booking = cal.bookings.find((entry) => entry && entry.id === id);
  if (!booking) throw codeError("booking_not_found", `no booking ${id}`);
  return booking;
}

/**
 * Create a booking. Caller holds the lock.
 *
 * `start` is epoch ms, "now" (the `now` clock) or "asap" (the first free gap
 * long enough). Adjacent intervals are free; an evict booking is not exempt
 * from conflicts. Throws BookingConflictError naming the blocker.
 */
export function bookLocked({
  owner, kind, mode = "exclusive", start, minutes, reason = "", allow = [],
  gtt_mb, host_ram_mb, hip_procs, evict = [], needs_approval = false,
  job_id, created_by, now = Date.now(), path = schedulePath(), holdPath,
} = {}) {
  const who = typeof owner === "string" ? owner.trim() : "";
  if (!who) throw badBooking("book: owner is required");
  if (!BOOKING_KINDS.includes(kind)) throw badBooking(`book: kind must be one of ${BOOKING_KINDS.join(" | ")}`);
  if (!BOOKING_MODES.includes(mode)) throw badBooking(`book: mode must be one of ${BOOKING_MODES.join(" | ")}`);
  const mins = positiveMinutes(minutes, "book");
  const durationMs = Math.round(mins * 60_000);
  const cal = readCalendar(path);
  const intervals = occupiedIntervals(cal, { now, holdPath });
  let startMs;
  if (start === "now") startMs = now;
  else if (start === "asap") startMs = firstGap(intervals, mins, now);
  else startMs = msOf(start);
  if (startMs == null) throw badBooking("book: start must be epoch ms, \"now\" or \"asap\"");
  const endMs = startMs + durationMs;
  assertFree(intervals, startMs, endMs);

  const evictList = stringList(evict);
  const booking = {
    id: newBookingId(),
    owner: who,
    kind,
    mode,
    start: iso(startMs),
    end: iso(endMs),
    reason: String(reason || ""),
    allow: stringList(allow),
    evict: evictList,
    approval: { state: evictList.length > 0 || needs_approval === true ? "pending" : "not_needed" },
    status: "booked",
    created_by: created_by == null ? who : String(created_by),
    created_at: iso(now),
  };
  const gttMb = optionalNumber(gtt_mb);
  const hostRamMb = optionalNumber(host_ram_mb);
  const hipProcs = optionalNumber(hip_procs);
  if (gttMb != null) booking.gtt_mb = gttMb;
  if (hostRamMb != null) booking.host_ram_mb = hostRamMb;
  if (hipProcs != null) booking.hip_procs = hipProcs;
  if (typeof job_id === "string" && job_id !== "") booking.job_id = job_id;

  cal.bookings.push(booking);
  writeCalendar(cal, path, now);
  return booking;
}

/** Take the lock once and book. */
export function book(options = {}) {
  return withReservationLock(() => bookLocked(options), lockOptions(options));
}

/**
 * Cancel a booking: its owner, or `force`, may do it. Caller holds the lock.
 * @returns the cancelled booking.
 */
export function cancelBookingLocked(id, { owner, force = false, now = Date.now(), path = schedulePath() } = {}) {
  const cal = readCalendar(path);
  const booking = findBooking(cal, id);
  if (!force && booking.owner !== String(owner || "")) {
    throw codeError("booking_not_owner", `booking ${id} belongs to ${booking.owner}`);
  }
  booking.status = "cancelled";
  writeCalendar(cal, path, now);
  return booking;
}

/** Take the lock once and cancel. */
export function cancelBooking(id, options = {}) {
  return withReservationLock(() => cancelBookingLocked(id, options), lockOptions(options));
}

function decideApprovalLocked(id, state, { by = "owner", now = Date.now(), path = schedulePath() } = {}) {
  const cal = readCalendar(path);
  const booking = findBooking(cal, id);
  if (!booking.approval || booking.approval.state !== "pending") {
    throw codeError("booking_approval_not_pending", `booking ${id} has no pending approval`);
  }
  // A stale request may still be declined, but never approved.
  if (state === "approved" && approvalExpired(booking, now)) {
    throw codeError("booking_approval_expired", `booking ${id}'s approval is older than 12 h`);
  }
  booking.approval = { ...booking.approval, state, by: String(by), at: iso(now) };
  writeCalendar(cal, path, now);
  return booking;
}

/** Approve a pending booking. Caller holds the lock. */
export function approveBookingLocked(id, options = {}) {
  return decideApprovalLocked(id, "approved", options);
}

/** Decline a pending booking. Caller holds the lock. */
export function declineBookingLocked(id, options = {}) {
  return decideApprovalLocked(id, "declined", options);
}

/** Take the lock once and approve. */
export function approveBooking(id, options = {}) {
  return withReservationLock(() => approveBookingLocked(id, options), lockOptions(options));
}

/** Take the lock once and decline. */
export function declineBooking(id, options = {}) {
  return withReservationLock(() => declineBookingLocked(id, options), lockOptions(options));
}