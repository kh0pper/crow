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
 * hold that names a booking (or one of a series' occurrences) is represented
 * by that booking, not counted twice. A booking whose approval is declined —
 * stored, or pending past its 12 h TTL — occupies no time at all; one whose
 * approval is still pending occupies its slot exactly like an approved one, so
 * a second booking can never take the same time while the owner is deciding,
 * and `approveBooking` re-checks the slot under the lock before it clears.
 *
 * A daily booking (`recur: {daily: "HH:MM-HH:MM"}`, optional `until`) is ONE
 * series row: `start` is the first occurrence's start, `end` is null while the
 * series is open-ended, and each occurrence is read through the row's
 * `occurrences` map keyed by the LOCAL date its start falls on (no entry means
 * "booked"). Occurrence ids are `<series id>@YYYY-MM-DD`; the series row is
 * never pruned, so its occurrences stay addressable, while a cancelled series
 * ages out like any other finished booking. Occurrence-map entries older than
 * 30 days are dropped on write.
 *
 * Occurrences expand in local wall-clock time: `new Date(y, m, d, hh, mm)` in
 * the process's zone, so a window keeps its clock across a DST change. A wall
 * time that does not exist (spring forward) becomes the top of the next hour,
 * and whether a window crosses midnight is decided from the clock times in its
 * spec (end at or before start), never from the resolved instants: a window
 * that does not cross midnight but collapses to zero length in the
 * spring-forward gap occupies nothing that day. An occurrence belongs to the
 * day it starts on.
 *
 * A pending approval older than 12 h (the private engineering notes §7.10)
 * reads as declined without writing the file, so a stale request can never be
 * approved by waiting. Done, cancelled and lapsed bookings are pruned once
 * they ended more than 30 days ago.
 *
 * The lock is not re-entrant: every public function is a lock-free
 * `…Locked` core plus a wrapper that takes the lock exactly once, and a
 * composed operation (book + activate) calls the cores directly.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  _activateHoldLocked, _renewHoldLocked, besideNeedsFootprint, HoldConflictError, lockPath,
  readReservation, reservationPath, schedulePath, withReservationLock,
} from "./box-reservation.js";

// The path helper is part of the calendar's public surface.
export { schedulePath };

const CALENDAR_VERSION = 1;
const APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const GAP_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A daily expansion never walks more than this many local days, so a corrupt
// `until` far in the future cannot spin.
const MAX_SERIES_DAYS = 800;
const BOOKING_KINDS = Object.freeze(["window", "gpu-job", "manual", "audit"]);
const BOOKING_MODES = Object.freeze(["exclusive", "beside"]);
const LIVE_STATUSES = Object.freeze(["booked", "active"]);
const ALL_STATUSES = Object.freeze(["booked", "active", "done", "cancelled", "lapsed"]);
const DAILY_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

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
// Local wall-clock recurrence.

const pad2 = (n) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for the local date `ms` falls on. */
function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `{year, month0, day}` for a `YYYY-MM-DD` key, or null. */
function parseDayKey(key) {
  const m = typeof key === "string" ? DATE_KEY_RE.exec(key) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const probe = new Date(y, mo, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo || probe.getDate() !== d) return null;
  return { y, m: mo, d };
}

function dayKeyOf(y, m, d) {
  const probe = new Date(y, m, d);
  return `${probe.getFullYear()}-${pad2(probe.getMonth() + 1)}-${pad2(probe.getDate())}`;
}

/** `"HH:MM-HH:MM"` as `{startH, startM, endH, endM}`, or null when malformed. */
function parseDaily(spec) {
  if (typeof spec !== "string") return null;
  const m = DAILY_RE.exec(spec.trim());
  if (!m) return null;
  const startH = Number(m[1]);
  const startM = Number(m[2]);
  const endH = Number(m[3]);
  const endM = Number(m[4]);
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null;
  return { startH, startM, endH, endM };
}

/**
 * The epoch ms of a local wall-clock time. A wall time that does not exist
 * (the spring-forward hour) resolves to the top of the next hour instead of
 * the shifted instant the Date constructor picks.
 */
function wallClock(y, m, d, hh, mm) {
  const at = new Date(y, m, d, hh, mm, 0, 0);
  if (at.getHours() !== hh || at.getMinutes() !== mm) {
    return new Date(y, m, d, hh + 1, 0, 0, 0).getTime();
  }
  return at.getTime();
}

/** One occurrence starting on local date (y, m, d): `{start, end}` in ms. */
function occurrenceBounds(y, m, d, spec) {
  const start = wallClock(y, m, d, spec.startH, spec.startM);
  // Whether the window crosses midnight is a property of the SPEC, not of the
  // resolved instants: on a spring-forward day a wall time that does not exist
  // resolves to the top of the next hour, so 02:10-02:50 becomes 03:00-03:00.
  // Reading that as "end <= start" would stretch it to the next day; whether
  // it crosses midnight is decided here, from the clock times it names.
  const crossesMidnight = (spec.endH * 60 + spec.endM) <= (spec.startH * 60 + spec.startM);
  const end = wallClock(y, m, d + (crossesMidnight ? 1 : 0), spec.endH, spec.endM);
  return { start, end };
}

/** Local date keys from `fromKey` through `toKey`, at most MAX_SERIES_DAYS. */
function* localDays(fromKey, toKey) {
  const parsed = parseDayKey(fromKey);
  if (!parsed) return;
  let y = parsed.y;
  let m = parsed.m;
  let d = parsed.d;
  for (let i = 0; i < MAX_SERIES_DAYS; i += 1) {
    const key = dayKeyOf(y, m, d);
    if (key > toKey) return;
    yield { y, m, d, key };
    const next = new Date(y, m, d + 1);
    y = next.getFullYear();
    m = next.getMonth();
    d = next.getDate();
  }
}

/**
 * Every occurrence of `series` overlapping [fromMs, toMs), in order. The walk
 * starts one local day before `fromMs`, so an occurrence that crosses midnight
 * into the range is found. Read-only; `occurrences` entries only carry
 * overrides (status, activated_at, an extended end).
 */
function expandSeries(series, fromMs = null, toMs = null) {
  if (!series || !series.recur) return [];
  const spec = parseDaily(series.recur.daily);
  const firstMs = msOf(series.start);
  if (!spec || firstMs == null) return [];
  const lowerMs = Math.max(firstMs, (fromMs == null ? firstMs : fromMs) - DAY_MS);
  const untilKey = typeof series.until === "string" && DATE_KEY_RE.test(series.until) ? series.until : null;
  const upperKey = untilKey || localDayKey(toMs == null ? Date.now() : toMs);
  const overrides = series.occurrences && typeof series.occurrences === "object" ? series.occurrences : {};
  const out = [];
  const seen = new Set();
  for (const day of localDays(localDayKey(lowerMs), upperKey)) {
    const bounds = occurrenceBounds(day.y, day.m, day.d, spec);
    if (toMs != null && bounds.start >= toMs) break;
    const key = localDayKey(bounds.start);
    if (seen.has(key)) continue;
    if (fromMs != null && bounds.end <= fromMs) continue;
    const override = overrides[key] && typeof overrides[key] === "object" ? overrides[key] : null;
    const storedEndMs = override ? msOf(override.end) : null;
    const endMs = storedEndMs != null && storedEndMs > bounds.end ? storedEndMs : bounds.end;
    // A window that does not cross midnight but resolves to no time at all
    // (both ends inside the spring-forward gap) occupies nothing that day.
    if (endMs <= bounds.start) continue;
    seen.add(key);
    const status = series.status === "cancelled"
      ? "cancelled"
      : (override && ALL_STATUSES.includes(override.status) ? override.status : "booked");
    out.push({
      key,
      start: bounds.start,
      end: endMs,
      status,
      activated_at: override && typeof override.activated_at === "string" ? override.activated_at : null,
    });
  }
  return out;
}

/** One occurrence as a booking-shaped entry (the shape `listBookings` returns). */
function occurrenceEntry(series, occ) {
  const entry = {
    ...series,
    id: `${series.id}@${occ.key}`,
    series_id: series.id,
    start: iso(occ.start),
    end: iso(occ.end),
    status: occ.status,
  };
  delete entry.occurrences;
  if (occ.activated_at) entry.activated_at = occ.activated_at;
  return entry;
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

/**
 * Drop occurrence-map entries whose day ended more than 30 days ago. The
 * series row itself is kept (see `pruneBookings`).
 */
function pruneOccurrences(booking, now) {
  if (!booking.recur || !booking.occurrences || typeof booking.occurrences !== "object") return booking;
  const cutoff = now - PRUNE_AFTER_MS;
  for (const key of Object.keys(booking.occurrences)) {
    const parsed = parseDayKey(key);
    if (!parsed) {
      delete booking.occurrences[key];
      continue;
    }
    const dayMs = new Date(parsed.y, parsed.m, parsed.d).getTime();
    if (dayMs + DAY_MS < cutoff) delete booking.occurrences[key];
  }
  return booking;
}

/**
 * Old finished bookings are dropped. A series is kept for as long as it is
 * not cancelled; a cancelled one ages out on its last occurrence like any
 * other finished booking (an open-ended cancelled series has no last
 * occurrence, so it is kept).
 */
function pruneBookings(bookings, now) {
  return bookings.filter((booking) => {
    if (!booking || typeof booking !== "object") return false;
    if (booking.recur) {
      pruneOccurrences(booking, now);
      if (booking.status !== "cancelled") return true;
      const endMs = msOf(booking.end);
      return endMs == null || endMs >= now - PRUNE_AFTER_MS;
    }
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
 * True when the booking's approval keeps it off the calendar. Only a DECLINED
 * approval withholds time — stored as declined, or pending past its 12 h TTL,
 * which reads as declined (the private engineering notes §7.10). A pending
 * booking occupies its slot exactly like an approved one, so nothing can take
 * the time it is waiting for.
 */
function approvalWithholdsTime(booking, now) {
  const state = bookingForRead(booking, now).approval;
  return !!(state && state.state === "declined");
}

/**
 * @param {{from?: number|string, to?: number|string, path?: string, now?: number}} [options]
 * @returns {Object[]} bookings overlapping [from, to), sorted by start. A
 *   daily series expands into one entry per occurrence, with
 *   `<series id>@YYYY-MM-DD` ids. A pending approval older than the 12 h TTL
 *   reads as declined by "expired".
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
    const view = bookingForRead(booking, now);
    if (booking.recur) {
      const lower = fromMs == null ? Math.max(msOf(booking.start) ?? now - PRUNE_AFTER_MS, now - PRUNE_AFTER_MS) : fromMs;
      const upper = toMs == null ? now + GAP_HORIZON_MS : toMs;
      for (const occ of expandSeries(view, lower, upper)) out.push(occurrenceEntry(view, occ));
      continue;
    }
    const startMs = msOf(view.start);
    const endMs = msOf(view.end);
    if (startMs == null || endMs == null) continue;
    if (fromMs != null && endMs <= fromMs) continue;
    if (toMs != null && startMs >= toMs) continue;
    out.push(view);
  }
  out.sort((a, b) => (msOf(a.start) ?? 0) - (msOf(b.start) ?? 0));
  return out;
}

// ---------------------------------------------------------------------------
// Occupancy: live bookings, expanded series and the one active hold.

function splitOccurrenceId(id) {
  const text = typeof id === "string" ? id : "";
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) return null;
  return { seriesId: text.slice(0, at), key: text.slice(at + 1) };
}

/** The booking row an id names, plus the occurrence key when it names one. */
function resolveTarget(cal, id) {
  const text = id == null ? "" : String(id);
  const split = splitOccurrenceId(text);
  if (split) {
    const series = cal.bookings.find((entry) => entry && entry.id === split.seriesId && entry.recur);
    if (series) return { id: text, series, key: split.key, row: series };
  }
  const row = cal.bookings.find((entry) => entry && entry.id === text);
  if (!row) throw codeError("booking_not_found", `no booking ${text}`);
  return { id: text, series: row.recur ? row : null, key: null, row };
}

/**
 * One occurrence of a series, as a flat read-only view. Throws
 * `booking_not_found` for a date the series does not cover.
 */
function occurrenceView(series, key, now) {
  const view = bookingForRead(series, now);
  const spec = parseDaily(series.recur && series.recur.daily);
  const day = parseDayKey(key);
  if (!spec || !day) throw codeError("booking_not_found", `no booking ${series.id}@${key}`);
  const bounds = occurrenceBounds(day.y, day.m, day.d, spec);
  const firstMs = msOf(series.start);
  if (firstMs != null && bounds.start < firstMs) {
    throw codeError("booking_not_found", `no booking ${series.id}@${key} (the series starts later)`);
  }
  if (typeof series.until === "string" && DATE_KEY_RE.test(series.until) && key > series.until) {
    throw codeError("booking_not_found", `no booking ${series.id}@${key} (the series ends earlier)`);
  }
  const overrides = view.occurrences && typeof view.occurrences === "object" ? view.occurrences : {};
  const override = overrides[key] && typeof overrides[key] === "object" ? overrides[key] : null;
  const storedEndMs = override ? msOf(override.end) : null;
  const endMs = storedEndMs != null && storedEndMs > bounds.end ? storedEndMs : bounds.end;
  const status = view.status === "cancelled"
    ? "cancelled"
    : (override && ALL_STATUSES.includes(override.status) ? override.status : "booked");
  return {
    key,
    start: bounds.start,
    end: endMs,
    status,
    approval: view.approval,
    activated_at: override && typeof override.activated_at === "string" ? override.activated_at : null,
  };
}

/**
 * A booking or occurrence flattened into the fields activation, renewal and
 * status changes need. `target` is "booking", "series" or "occurrence".
 */
function targetView(cal, id, now) {
  const target = resolveTarget(cal, id);
  if (target.key != null) {
    const occ = occurrenceView(target.series, target.key, now);
    const series = target.series;
    return {
      id: target.id,
      target: "occurrence",
      row: series,
      seriesId: series.id,
      key: target.key,
      owner: series.owner,
      mode: series.mode || "exclusive",
      kind: series.kind,
      reason: series.reason,
      allow: series.allow,
      job_id: series.job_id,
      gtt_mb: series.gtt_mb,
      host_ram_mb: series.host_ram_mb,
      hip_procs: series.hip_procs,
      approval: occ.approval,
      start: occ.start,
      end: occ.end,
      status: occ.status,
    };
  }
  const view = bookingForRead(target.row, now);
  const isSeries = !!target.row.recur;
  return {
    id: target.id,
    target: isSeries ? "series" : "booking",
    row: target.row,
    seriesId: isSeries ? target.row.id : null,
    key: null,
    owner: view.owner,
    mode: view.mode || "exclusive",
    kind: view.kind,
    reason: view.reason,
    allow: view.allow,
    job_id: view.job_id,
    gtt_mb: view.gtt_mb,
    host_ram_mb: view.host_ram_mb,
    hip_procs: view.hip_procs,
    approval: view.approval,
    start: msOf(view.start),
    end: msOf(view.end),
    status: view.status,
  };
}

/** True when the hold's `booking_id` names a booking (or occurrence) that lives. */
function holdNamesLiveBooking(cal, hold, now) {
  if (!hold || !hold.booking_id) return false;
  let target;
  try {
    target = resolveTarget(cal, hold.booking_id);
  } catch {
    return false;
  }
  if (target.key != null) {
    try {
      return LIVE_STATUSES.includes(occurrenceView(target.series, target.key, now).status);
    } catch {
      return false;
    }
  }
  return LIVE_STATUSES.includes(bookingForRead(target.row, now).status);
}

/**
 * Everything that occupies box time for queries over [from, to), as sorted
 * `{start, end, conflict}` intervals. `ignoreId` leaves one booking out (a
 * hold that names it is represented by it, not counted separately), which is
 * what an approval re-check needs: the booking being approved must not be
 * found in its own way. `ignoreIds` leaves a whole list out (an occurrence id
 * included) — the composed `hold` books over exactly the bookings it is about
 * to preempt, so nothing is destroyed before the new hold exists. Throws
 * `hold_corrupt` when the hold file cannot be read: guessing an interval for
 * it would be worse than refusing.
 */
function occupiedIntervals(cal, {
  now = Date.now(), holdPath, from = null, to = null, ignoreId = null, ignoreIds = null,
} = {}) {
  const expandFrom = from == null ? now - PRUNE_AFTER_MS : from;
  const expandTo = to == null ? now + GAP_HORIZON_MS : to;
  const ignored = ignoreIds == null ? null : new Set(ignoreIds);
  const out = [];
  for (const booking of cal.bookings) {
    if (!booking || typeof booking !== "object") continue;
    if (ignoreId != null && booking.id === ignoreId) continue;
    if (ignored && ignored.has(booking.id)) continue;
    if (approvalWithholdsTime(booking, now)) continue;
    const view = bookingForRead(booking, now);
    if (booking.recur) {
      for (const occ of expandSeries(view, expandFrom, expandTo)) {
        if (!LIVE_STATUSES.includes(occ.status)) continue;
        if (ignored && ignored.has(`${view.id}@${occ.key}`)) continue;
        out.push({ start: occ.start, end: occ.end, conflict: occurrenceEntry(view, occ) });
      }
      continue;
    }
    if (!LIVE_STATUSES.includes(view.status)) continue;
    const startMs = msOf(view.start);
    const endMs = msOf(view.end);
    if (startMs == null || endMs == null || endMs <= startMs) continue;
    out.push({ start: startMs, end: endMs, conflict: view });
  }
  const hold = readReservation({ path: holdPath || reservationPath(), now });
  if (hold && hold.corrupt) {
    throw codeError("hold_corrupt", "the box reservation file is unreadable; refusing to guess what it holds");
  }
  if (hold && !hold.corrupt) {
    if (!holdNamesLiveBooking(cal, hold, now)) {
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

/**
 * Defence in depth for approval: the booked slot (or every future occurrence of
 * a series) must still be free of every OTHER live booking and of the live
 * hold. The booking being approved is left out of what it is checked against,
 * and a cancelled or finished occurrence of its own series is not checked. The
 * same conflict machinery as `book` decides, so a blocker is named the same way
 * and an empty calendar always passes.
 */
function assertApprovalFree(cal, booking, { now = Date.now(), holdPath } = {}) {
  const firstMs = msOf(booking.start);
  const lastMs = msOf(booking.end);
  const fromMs = Math.max(firstMs == null ? now - DAY_MS : firstMs, now - DAY_MS);
  const toMs = lastMs == null ? now + GAP_HORIZON_MS : lastMs + DAY_MS;
  const intervals = occupiedIntervals(cal, {
    now, holdPath, from: fromMs - DAY_MS, to: toMs, ignoreId: booking.id,
  });
  if (booking.recur) {
    for (const occ of expandSeries(bookingForRead(booking, now), fromMs, toMs)) {
      if (!LIVE_STATUSES.includes(occ.status) || occ.end <= now) continue;
      assertFree(intervals, occ.start, occ.end);
    }
    return;
  }
  if (firstMs == null || lastMs == null || lastMs <= firstMs) return;
  assertFree(intervals, firstMs, lastMs);
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
  const intervals = occupiedIntervals(cal, {
    now, holdPath, from: afterMs - DAY_MS, to: afterMs + GAP_HORIZON_MS,
  });
  return firstGap(intervals, mins, afterMs);
}

// ---------------------------------------------------------------------------
// Writes. Each public function is a lock-free `…Locked` core (the caller
// holds the one lock) plus a wrapper that takes it once. The lock is not
// re-entrant, so a composed operation must call the core directly.

/** The first occurrence at or after `now`, as bounds plus the local date. */
function firstOccurrenceAtOrAfter(spec, now) {
  const cursor = new Date(now);
  let y = cursor.getFullYear();
  let m = cursor.getMonth();
  let d = cursor.getDate();
  for (let i = 0; i < 4; i += 1) {
    const bounds = occurrenceBounds(y, m, d, spec);
    if (bounds.start >= now) return { ...bounds, y, m, d };
    const next = new Date(y, m, d + 1);
    y = next.getFullYear();
    m = next.getMonth();
    d = next.getDate();
  }
  throw badBooking("book: could not place the first daily occurrence");
}

/**
 * Create a booking. Caller holds the lock.
 *
 * `start` is epoch ms, "now" (the `now` clock) or "asap" (the first free gap
 * long enough). Adjacent intervals are free; an evict booking is not exempt
 * from conflicts. Throws BookingConflictError naming the blocker. A beside
 * booking needs a positive `gtt_mb` and `host_ram_mb` (or it reserves
 * nothing): without both it is refused with `beside_needs_footprint`.
 *
 * `ignoreIds` leaves those bookings (or `<series id>@<day>` occurrences) out
 * of the conflict check, so a composed `hold` can book the time it is about to
 * preempt without destroying anything first.
 *
 * A `daily` window creates ONE series row instead: `start` is the first
 * occurrence at or after `now`, `end` is null (open-ended) or the last
 * occurrence's end on or before `until`, and `start` / `minutes` are ignored.
 */
export function bookLocked({
  owner, kind, mode = "exclusive", start, minutes, reason = "", allow = [],
  gtt_mb, host_ram_mb, hip_procs, evict = [], needs_approval = false,
  daily, until, job_id, created_by, ignoreIds = [], now = Date.now(), path = schedulePath(), holdPath,
} = {}) {
  const who = typeof owner === "string" ? owner.trim() : "";
  if (!who) throw badBooking("book: owner is required");
  if (!BOOKING_KINDS.includes(kind)) throw badBooking(`book: kind must be one of ${BOOKING_KINDS.join(" | ")}`);
  if (!BOOKING_MODES.includes(mode)) throw badBooking(`book: mode must be one of ${BOOKING_MODES.join(" | ")}`);
  // A beside booking reserves part of the card for a job: without both numbers
  // it reserves nothing, and the gate could not size a start beside it.
  if (mode === "beside" && !(optionalNumber(gtt_mb) > 0 && optionalNumber(host_ram_mb) > 0)) {
    throw besideNeedsFootprint("book");
  }
  const cal = readCalendar(path);
  const dailySpec = daily == null || daily === "" ? null : parseDaily(daily);
  if (daily != null && daily !== "" && !dailySpec) throw badBooking("book: daily must be \"HH:MM-HH:MM\"");
  const mins = dailySpec ? null : positiveMinutes(minutes, "book");
  const durationMs = mins == null ? null : Math.round(mins * 60_000);

  let startMs;
  let endMs;
  let untilKey = null;
  if (dailySpec) {
    if (until != null && until !== "") {
      const text = String(until);
      if (!parseDayKey(text)) throw badBooking("book: until must be a \"YYYY-MM-DD\" local date");
      untilKey = text;
    }
    const first = firstOccurrenceAtOrAfter(dailySpec, now);
    const firstKey = localDayKey(first.start);
    if (untilKey != null && untilKey < firstKey) {
      throw badBooking(`book: until ${untilKey} is before the first occurrence ${firstKey}`);
    }
    const lastDay = untilKey != null ? parseDayKey(untilKey) : null;
    const lastBounds = lastDay ? occurrenceBounds(lastDay.y, lastDay.m, lastDay.d, dailySpec) : null;
    startMs = first.start;
    endMs = lastBounds == null ? null : lastBounds.end;
    const checkToMs = endMs == null ? now + GAP_HORIZON_MS : endMs;
    const intervals = occupiedIntervals(cal, {
      now, holdPath, from: startMs - DAY_MS, to: checkToMs + DAY_MS, ignoreIds,
    });
    const draft = {
      id: "draft", start: iso(startMs), recur: { daily: String(daily).trim() }, until: untilKey, occurrences: {},
    };
    for (const occ of expandSeries(draft, startMs - DAY_MS, checkToMs + DAY_MS)) {
      assertFree(intervals, occ.start, occ.end);
    }
  } else if (start === "now" || start === "asap") {
    const intervals = occupiedIntervals(cal, {
      now, holdPath, from: now - DAY_MS, to: now + GAP_HORIZON_MS, ignoreIds,
    });
    if (start === "now") startMs = now;
    else startMs = firstGap(intervals, mins, now);
    endMs = startMs + durationMs;
    assertFree(intervals, startMs, endMs);
  } else {
    startMs = msOf(start);
    if (startMs == null) throw badBooking("book: start must be epoch ms, \"now\" or \"asap\"");
    endMs = startMs + durationMs;
    const intervals = occupiedIntervals(cal, {
      now, holdPath, from: startMs - DAY_MS, to: endMs + DAY_MS, ignoreIds,
    });
    assertFree(intervals, startMs, endMs);
  }

  const evictList = stringList(evict);
  const booking = {
    id: newBookingId(),
    owner: who,
    kind,
    mode,
    start: iso(startMs),
    end: endMs == null ? null : iso(endMs),
    reason: String(reason || ""),
    allow: stringList(allow),
    evict: evictList,
    approval: { state: evictList.length > 0 || needs_approval === true ? "pending" : "not_needed" },
    status: "booked",
    created_by: created_by == null ? who : String(created_by),
    created_at: iso(now),
  };
  if (dailySpec) {
    booking.recur = { daily: String(daily).trim().replace(/\s+/g, "") };
    if (untilKey != null) booking.until = untilKey;
    booking.occurrences = {};
  }
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
 * An occurrence id cancels only that day; the series id cancels the series.
 * @returns the cancelled booking (an occurrence entry for an occurrence id).
 */
export function cancelBookingLocked(id, { owner, force = false, now = Date.now(), path = schedulePath() } = {}) {
  const cal = readCalendar(path);
  const target = resolveTarget(cal, id);
  const bookedBy = target.key != null ? target.series.owner : target.row.owner;
  if (!force && String(bookedBy || "") !== String(owner || "")) {
    throw codeError("booking_not_owner", `booking ${id} belongs to ${bookedBy}`);
  }
  if (target.key != null) {
    const occ = occurrenceView(target.series, target.key, now);
    const series = target.series;
    if (!series.occurrences || typeof series.occurrences !== "object") series.occurrences = {};
    series.occurrences[target.key] = { ...(series.occurrences[target.key] || {}), status: "cancelled" };
    writeCalendar(cal, path, now);
    const entry = occurrenceEntry(series, { ...occ, status: "cancelled" });
    return entry;
  }
  target.row.status = "cancelled";
  writeCalendar(cal, path, now);
  return target.row;
}

/** Take the lock once and cancel. */
export function cancelBooking(id, options = {}) {
  return withReservationLock(() => cancelBookingLocked(id, options), lockOptions(options));
}

/**
 * Clear or refuse a pending approval. Caller holds the lock. An approval is
 * per series: an occurrence id resolves to its series row. Approving also
 * re-checks that the slot is still free (see `assertApprovalFree`) and throws
 * `BookingConflictError` naming the blocker, leaving the request pending, when
 * it is not.
 */
function decideApprovalLocked(id, state, {
  by = "owner", now = Date.now(), path = schedulePath(), holdPath,
} = {}) {
  const cal = readCalendar(path);
  const target = resolveTarget(cal, id);
  // Approval is per series: an occurrence id resolves to its series row.
  const booking = target.series || target.row;
  if (target.key != null) occurrenceView(target.series, target.key, now);
  if (!booking.approval || booking.approval.state !== "pending") {
    throw codeError("booking_approval_not_pending", `booking ${id} has no pending approval`);
  }
  // A stale request may still be declined, but never approved.
  if (state === "approved" && approvalExpired(booking, now)) {
    throw codeError("booking_approval_expired", `booking ${id}'s approval is older than 12 h`);
  }
  // Clearing the approval is what lets the booking take the box, so the time it
  // names is re-checked under this same lock before anything is written.
  if (state === "approved") assertApprovalFree(cal, booking, { now, holdPath });
  booking.approval = { ...booking.approval, state, by: String(by), at: iso(now) };
  writeCalendar(cal, path, now);
  return booking;
}

/**
 * Approve a pending booking. Caller holds the lock. Refuses with
 * `BookingConflictError` (leaving the approval pending) when another live
 * booking or the live hold took the slot while the request waited.
 */
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

/**
 * The start (ms) of the next booked/active booking or occurrence after
 * `view`'s own, or Infinity. This is the wall a renewal may not run into.
 */
function nextLiveStartAfter(cal, view, now) {
  const from = view.start;
  if (from == null) return Infinity;
  let next = Infinity;
  for (const booking of cal.bookings) {
    if (!booking || typeof booking !== "object") continue;
    if (approvalWithholdsTime(booking, now)) continue;
    const row = bookingForRead(booking, now);
    if (booking.recur) {
      for (const occ of expandSeries(row, from, from + GAP_HORIZON_MS + DAY_MS)) {
        if (!LIVE_STATUSES.includes(occ.status)) continue;
        if (view.target === "occurrence" && booking.id === view.seriesId && occ.key === view.key) continue;
        if (occ.start >= from && occ.start < next) next = occ.start;
      }
      continue;
    }
    if (!LIVE_STATUSES.includes(row.status)) continue;
    if (view.target === "booking" && booking.id === view.id) continue;
    const startMs = msOf(row.start);
    if (startMs != null && startMs >= from && startMs < next) next = startMs;
  }
  return next;
}

/**
 * Turn a booking (or one occurrence of a series) into the active hold.
 * Caller holds the lock — this is the second half of `book + activate`.
 *
 * Refuses with `booking_not_approved` (pending or declined approval),
 * `booking_not_started`, `booking_ended`, `booking_not_owner` or
 * `booking_not_active_status`; re-activating one's own active booking is
 * allowed. A `HoldConflictError` from the hold layer propagates untouched.
 *
 * `takeOver` passes through to the hold layer: the caller has already decided
 * that a foreign hold may be replaced (the composed `hold`, which preempts a
 * `gpujob:` job). It makes the replacement one atomic rename, so there is no
 * moment with no hold at all.
 *
 * @returns the hold record written.
 */
export function activateBookingLocked(id, {
  owner, now = Date.now(), force = false, takeOver = false, path = schedulePath(), holdPath,
} = {}) {
  const cal = readCalendar(path);
  const view = targetView(cal, id, now);
  if (view.target === "series") {
    throw codeError("booking_needs_occurrence", `booking ${id} is a daily series; name the occurrence (${id}@YYYY-MM-DD)`);
  }
  const state = view.approval && view.approval.state;
  if (state === "pending" || state === "declined") {
    throw codeError("booking_not_approved", `booking ${id} is not approved (${state}); the owner has to approve it first`);
  }
  if (view.start == null || now < view.start) {
    throw codeError("booking_not_started", `booking ${id} starts at ${view.start == null ? "?" : iso(view.start)}`);
  }
  if (view.end == null || now >= view.end) {
    throw codeError("booking_ended", `booking ${id} ended at ${view.end == null ? "?" : iso(view.end)}`);
  }
  if (String(owner || "") !== String(view.owner || "")) {
    throw codeError("booking_not_owner", `booking ${id} belongs to ${view.owner}`);
  }
  if (!LIVE_STATUSES.includes(view.status)) {
    throw codeError("booking_not_active_status", `booking ${id} is ${view.status} and cannot be activated`);
  }
  const hold = _activateHoldLocked({
    owner: view.owner,
    reason: view.reason,
    minutes: (view.end - now) / 60000,
    allow: Array.isArray(view.allow) ? view.allow : [],
    mode: view.mode,
    kind: view.kind,
    booking_id: view.id,
    job_id: view.job_id,
    gtt_mb: view.gtt_mb,
    host_ram_mb: view.host_ram_mb,
    hip_procs: view.hip_procs,
    force,
    takeOver,
    now,
    path: holdPath || reservationPath(),
  });
  if (view.target === "occurrence") {
    const series = view.row;
    if (!series.occurrences || typeof series.occurrences !== "object") series.occurrences = {};
    series.occurrences[view.key] = {
      ...(series.occurrences[view.key] || {}),
      status: "active",
      activated_at: iso(now),
    };
  } else {
    view.row.status = "active";
  }
  writeCalendar(cal, path, now);
  return hold;
}

/** Take the lock once and activate a booking. @returns the hold record. */
export function activateBooking(id, options = {}) {
  return withReservationLock(() => activateBookingLocked(id, options), lockOptions(options));
}

/**
 * Extend the caller's own hold from a booking and move the booking's end with
 * it. Caller holds the lock. `notAfter` is the next booked/active start, so a
 * lease can never run into the booking behind it.
 *
 * The live hold must name THIS booking (or this occurrence) and belong to
 * `owner`, and the booking must still be booked or active: a hold that names
 * another booking is not this one's to extend.
 *
 * @returns the hold record written.
 * @throws RangeError("renew_past_next_booking") and HoldConflictError props.
 */
export function renewBookingLocked(id, {
  owner, minutes, now = Date.now(), force = false, path = schedulePath(), holdPath,
} = {}) {
  const cal = readCalendar(path);
  const view = targetView(cal, id, now);
  if (view.target === "series") {
    throw codeError("booking_needs_occurrence", `booking ${id} is a daily series; name the occurrence (${id}@YYYY-MM-DD)`);
  }
  if (!LIVE_STATUSES.includes(view.status)) {
    throw codeError("booking_not_active_status", `booking ${id} is ${view.status} and cannot be renewed`);
  }
  // The lease belongs to the hold this booking NAMES: a hold that names another
  // booking (or none) is not this booking's to renew, however its owner reads.
  const holdFile = holdPath || reservationPath();
  const current = readReservation({ path: holdFile, now });
  if (current && !current.corrupt) {
    if (String(owner || "") !== String(current.owner || "")) {
      throw new HoldConflictError(current.owner, { expires_at: current.expires_at });
    }
    if (current.booking_id !== view.id) {
      throw new HoldConflictError(current.owner, {
        expires_at: current.expires_at,
        message: `the live hold names booking ${current.booking_id || "none"}, not ${id}`,
      });
    }
  }
  const notAfter = nextLiveStartAfter(cal, view, now);
  const hold = _renewHoldLocked({
    owner, minutes, now, notAfter, force, path: holdFile,
  });
  const expiresMs = msOf(hold.expires_at);
  if (expiresMs != null && (view.end == null || expiresMs > view.end)) {
    if (view.target === "occurrence") {
      const series = view.row;
      if (!series.occurrences || typeof series.occurrences !== "object") series.occurrences = {};
      series.occurrences[view.key] = { ...(series.occurrences[view.key] || {}), end: iso(expiresMs) };
    } else {
      view.row.end = iso(expiresMs);
    }
    writeCalendar(cal, path, now);
  }
  return hold;
}

/** Take the lock once and renew from a booking. @returns the hold record. */
export function renewBooking(id, options = {}) {
  return withReservationLock(() => renewBookingLocked(id, options), lockOptions(options));
}

/**
 * Set a booking's status outright (the runner marks a job `done` or `lapsed`
 * this way). Accepts a booking, a series or one occurrence id. Caller holds
 * the lock.
 */
export function setBookingStatusLocked(id, status, { path = schedulePath(), now = Date.now() } = {}) {
  if (!ALL_STATUSES.includes(status)) {
    throw new TypeError(`status must be one of ${ALL_STATUSES.join(" | ")}`);
  }
  const cal = readCalendar(path);
  const target = resolveTarget(cal, id);
  if (target.key != null) {
    const occ = occurrenceView(target.series, target.key, now);
    const series = target.series;
    if (!series.occurrences || typeof series.occurrences !== "object") series.occurrences = {};
    series.occurrences[target.key] = { ...(series.occurrences[target.key] || {}), status };
    writeCalendar(cal, path, now);
    return occurrenceEntry(series, { ...occ, status });
  }
  target.row.status = status;
  writeCalendar(cal, path, now);
  return target.row;
}

/** Take the lock once and set a booking's status. */
export function setBookingStatus(id, status, options = {}) {
  return withReservationLock(() => setBookingStatusLocked(id, status, options), lockOptions(options));
}
