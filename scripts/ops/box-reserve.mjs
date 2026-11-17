#!/usr/bin/env node
/**
 * box-reserve — the operator's command line for the one box calendar (the
 * private engineering notes §6.3): the active hold that gpu-orchestrator
 * honors before starting any local model, and the persistent booking calendar
 * behind it.
 *
 *   box-reserve book --owner <name> [--kind k] [--mode m] [--start <ISO|now|asap>]
 *                    [--minutes N] [--allow p1,p2] [--reason <text>] [--needs-approval]
 *                    [--daily HH:MM-HH:MM [--until YYYY-MM-DD]]
 *   box-reserve calendar [--from ISO] [--to ISO] [--json|--markdown]
 *   box-reserve cancel <id> --owner <name> [--force]
 *   box-reserve approve <id> · decline <id>
 *   box-reserve hold --owner <name> --reason <text> [--minutes N=480] [--allow p1,p2]
 *                    [--kind k] [--mode m] [--force]      (book + activate in one step)
 *   box-reserve hold --booking <id> [--owner <name>] [--force]
 *   box-reserve renew --owner <name> --minutes N [--force]
 *   box-reserve release [--owner <name>] [--force]
 *   box-reserve status
 *
 * The active hold is $CROW_BOX_RESERVATION_PATH (default
 * /run/user/<uid>/crow-box-reservation.json); the calendar is
 * $CROW_BOX_SCHEDULE_PATH (else $XDG_STATE_HOME/crow/box-schedule.json, else
 * ~/.local/state/crow/box-schedule.json). A hold longer than 8 h needs
 * --force. While the hold file exists, escalations degrade to the fast
 * resident model and non-allowed model starts are refused with `box_reserved`
 * — see docs/architecture/box-reservation.md.
 *
 * A plain `hold` is one operation under the one box lock: it marks its own
 * owner's overlapping bookings `done` (a re-hold replaces your own hold),
 * preempts a `gpujob:` owner's gpu-job booking or live hold, refuses to
 * overlap anyone else's window / manual / audit booking or hold, then books
 * and activates. The new booking is written FIRST, over exactly the bookings
 * this hold preempts (`ignoreIds`), and the activation replaces the old hold
 * in one atomic rename (`takeOver`) — so nothing is destroyed up front, and
 * there is never a moment with no hold at all. Only after both succeed is the
 * overlap marked done or lapsed; if activation fails the new booking is
 * cancelled and every other booking and the old hold are left as they were.
 *
 * A bare `release` (no --owner) frees the current hold when its kind is null
 * (a legacy writer) or "manual", and refuses a gpu-job hold without --force;
 * the pi-lab teardown traps keep working. Release marks the booking the hold
 * named `done`.
 *
 * Exit codes: 0 ok · 1 refused (conflict, foreign holder, not approved, over
 * the max, calendar corrupt, lock timeout) · 2 usage.
 */

import {
  DEFAULT_MAX_HOLD_MS, HoldConflictError, _releaseHoldLocked, _renewHoldLocked,
  clearReservation, readReservation, reservationPath, schedulePath, withReservationLock,
} from "../../servers/gateway/box-reservation.js";
import {
  BookingConflictError, activateBookingLocked, approveBooking, book, bookLocked,
  cancelBooking, declineBooking, listBookings, renewBookingLocked, setBookingStatusLocked,
} from "../../servers/gateway/box-schedule.js";

const BOOLEAN_FLAGS = new Set(["force", "help", "json", "markdown", "needs-approval"]);
const KINDS = ["window", "gpu-job", "manual", "audit"];
const MODES = ["exclusive", "beside"];
const LIVE_STATUSES = ["booked", "active"];
const DEFAULT_MINUTES = 480;
const DAY_MS = 86_400_000;
const NEXT_BOOKINGS = 3;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MARKDOWN_HEADER = "| when (local) | owner | kind | mode | status | approval |";
const MARKDOWN_RULE = "|---|---|---|---|---|---|";

const USAGE = [
  "usage:",
  "  box-reserve book --owner <name> [--kind window|gpu-job|manual|audit=manual]",
  "                   [--mode exclusive|beside=exclusive] [--start <ISO|now|asap>=now]",
  "                   [--minutes N] [--allow p1,p2] [--gtt-mb N] [--host-ram-mb N]",
  "                   [--hip-procs N] [--reason <text>] [--needs-approval]",
  "                   [--daily HH:MM-HH:MM [--until YYYY-MM-DD]]",
  "  box-reserve calendar [--from ISO] [--to ISO] [--json|--markdown]",
  "  box-reserve cancel <id> --owner <name> [--force]",
  "  box-reserve approve <id>",
  "  box-reserve decline <id>",
  "  box-reserve hold --owner <name> --reason <text> [--minutes N=480] [--allow p1,p2]",
  "                   [--kind window|gpu-job|manual|audit=manual] [--mode exclusive|beside=exclusive] [--force]",
  "  box-reserve hold --booking <id> [--owner <name>] [--force]",
  "  box-reserve renew --owner <name> --minutes N [--force]",
  "  box-reserve release [--owner <name>] [--force]",
  "  box-reserve status",
  "",
  `active hold: ${reservationPath()}  (override with CROW_BOX_RESERVATION_PATH)`,
  `calendar:    ${schedulePath()}  (override with CROW_BOX_SCHEDULE_PATH)`,
].join("\n");

class UsageError extends Error {}

function usage() {
  throw new UsageError("usage");
}

function codeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Argument parsing.

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { out.help = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) usage();
      out[key] = val; i++;
      continue;
    }
    out._.push(a);
  }
  return out;
}

function requireOwner(args) {
  if (args.owner === undefined) usage();
  return String(args.owner);
}

function requireId(args) {
  const id = args._[1];
  if (id === undefined) usage();
  return String(id);
}

function numberArg(value) {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) usage();
  return n;
}

function positiveMinutesArg(value) {
  const n = numberArg(value);
  if (n == null || n <= 0) usage();
  return n;
}

function isoArg(value) {
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) usage();
  return ms;
}

function allowList(value) {
  if (value === undefined) return [];
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function kindArg(args) {
  const kind = args.kind === undefined ? "manual" : String(args.kind);
  if (!KINDS.includes(kind)) usage();
  return kind;
}

function modeArg(args) {
  const mode = args.mode === undefined ? "exclusive" : String(args.mode);
  if (!MODES.includes(mode)) usage();
  return mode;
}

// ---------------------------------------------------------------------------
// Calendar helpers.

function occupiesTime(entry) {
  if (!LIVE_STATUSES.includes(entry.status)) return false;
  return !(entry.approval && entry.approval.state === "declined");
}

function overlapsRange(entry, fromMs, toMs) {
  const startMs = Date.parse(entry.start);
  const endMs = Date.parse(entry.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return startMs < toMs && fromMs < endMs;
}

/** A gpu-job owned by the runner: a plain hold may preempt it. */
function preemptable(entry) {
  return entry.kind === "gpu-job" && String(entry.owner || "").startsWith("gpujob:");
}

function preemptableHold(hold) {
  return hold.kind === "gpu-job" && String(hold.owner || "").startsWith("gpujob:");
}

function conflictOf(entry) {
  return { id: entry.id || null, owner: entry.owner, kind: entry.kind, start: entry.start, end: entry.end };
}

function conflictLine(conflict) {
  const id = conflict && conflict.id ? conflict.id : "legacy-hold";
  const owner = conflict && conflict.owner ? conflict.owner : "unknown";
  const start = conflict && conflict.start ? conflict.start : "?";
  const end = conflict && conflict.end ? conflict.end : "?";
  return `conflict with ${id} (${owner}, ${start} -> ${end})`;
}

/** The next booked bookings starting after `now`, soonest first. */
function nextBookings(now) {
  return listBookings({ from: now, to: now + 14 * DAY_MS, path: schedulePath(), now })
    .filter((entry) => entry.status === "booked" && (Date.parse(entry.start) || 0) > now)
    .slice(0, NEXT_BOOKINGS);
}

/** A booking (or occurrence) id -> its entry, for the default --owner. */
function bookingForActivation(id, now) {
  return listBookings({
    from: now - 30 * DAY_MS, to: now + 30 * DAY_MS, path: schedulePath(), now,
  }).find((entry) => entry.id === id) || null;
}

/** Best effort: the hold is gone either way, so a broken calendar must not undo it. */
function markHoldBookingDone(hold, now) {
  if (!hold || !hold.booking_id) return;
  try {
    setBookingStatusLocked(hold.booking_id, "done", { path: schedulePath(), now });
  } catch { /* the calendar may be unreadable; releasing the hold still stands */ }
}

// ---------------------------------------------------------------------------
// Local-time rendering for `calendar`.

const pad2 = (n) => String(n).padStart(2, "0");

function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function dayStamp(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "Tue 2026-11-17 19:30-20:45", or "daily 02:15-04:15" for a series row. */
function whenCell(entry) {
  if (entry && entry.recur && typeof entry.recur.daily === "string") return `daily ${entry.recur.daily}`;
  const startMs = Date.parse(entry && entry.start);
  if (!Number.isFinite(startMs)) return "?";
  const endMs = Date.parse(entry && entry.end);
  return `${dayStamp(startMs)} ${hhmm(startMs)}-${Number.isFinite(endMs) ? hhmm(endMs) : "?"}`;
}

function approvalState(entry) {
  return (entry && entry.approval && entry.approval.state) || "not_needed";
}

function rowCells(entry) {
  return [
    whenCell(entry),
    entry.owner,
    entry.kind,
    entry.mode || "exclusive",
    entry.status,
    approvalState(entry),
  ].map((cell) => (cell == null ? "" : String(cell)));
}

function markdownRow(entry) {
  return `| ${rowCells(entry).join(" | ")} |`;
}

function plainRow(entry) {
  return rowCells(entry).join("  ");
}

// ---------------------------------------------------------------------------
// Subcommands.

function statusCmd() {
  const now = Date.now();
  const hold = readReservation({ path: reservationPath(), now });
  const next = nextBookings(now);
  if (!hold) {
    if (next.length === 0) { console.log("none"); return 0; }
    console.log(JSON.stringify({ active: null, next_bookings: next }, null, 2));
    return 0;
  }
  console.log(JSON.stringify({ ...hold, next_bookings: next }, null, 2));
  return 0;
}

function bookCmd(args) {
  const owner = requireOwner(args);
  const kind = kindArg(args);
  const mode = modeArg(args);
  const daily = args.daily === undefined ? null : String(args.daily);
  if (daily !== null && (args.start !== undefined || args.minutes !== undefined)) usage();
  if (daily === null && args.until !== undefined) usage();
  if (daily === null && args.minutes === undefined) usage();
  let start = "now";
  if (daily === null) {
    const raw = args.start === undefined ? "now" : String(args.start);
    if (raw === "now" || raw === "asap") start = raw;
    else start = isoArg(raw);
  }
  const booking = book({
    owner,
    kind,
    mode,
    start,
    minutes: daily === null ? positiveMinutesArg(args.minutes) : undefined,
    reason: args.reason === undefined ? "" : String(args.reason),
    allow: allowList(args.allow),
    gtt_mb: numberArg(args["gtt-mb"]),
    host_ram_mb: numberArg(args["host-ram-mb"]),
    hip_procs: numberArg(args["hip-procs"]),
    needs_approval: args["needs-approval"] === true,
    daily: daily === null ? undefined : daily,
    until: args.until === undefined ? undefined : String(args.until),
    created_by: owner,
    path: schedulePath(),
    holdPath: reservationPath(),
  });
  if (booking.recur) console.log(`booked ${booking.id} daily ${booking.recur.daily}`);
  else console.log(`booked ${booking.id} ${booking.start} -> ${booking.end}`);
  return 0;
}

function calendarCmd(args) {
  if (args.json && args.markdown) usage();
  const now = Date.now();
  const fromMs = args.from === undefined ? now : isoArg(args.from);
  const toMs = args.to === undefined ? fromMs + 14 * DAY_MS : isoArg(args.to);
  const list = listBookings({ from: fromMs, to: toMs, path: schedulePath(), now });
  if (args.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  if (args.markdown) {
    console.log(MARKDOWN_HEADER);
    console.log(MARKDOWN_RULE);
    for (const entry of list) console.log(markdownRow(entry));
    return 0;
  }
  for (const entry of list) console.log(plainRow(entry));
  return 0;
}

function cancelCmd(args) {
  const id = requireId(args);
  if (args.owner === undefined) usage();
  cancelBooking(id, {
    owner: String(args.owner),
    force: args.force === true,
    path: schedulePath(),
    holdPath: reservationPath(),
  });
  console.log(`cancelled ${id}`);
  return 0;
}

function approveCmd(args, state) {
  const id = requireId(args);
  const options = { by: "owner", path: schedulePath(), holdPath: reservationPath() };
  if (state === "approved") approveBooking(id, options);
  else declineBooking(id, options);
  console.log(`${state} ${id}`);
  return 0;
}

function checkHoldCap(minutes, force) {
  const holdMs = Math.round(minutes * 60_000);
  if (holdMs > DEFAULT_MAX_HOLD_MS && !force) {
    throw codeError("hold_too_long", `hold of ${minutes} min exceeds the 8h default max; pass --force to exceed it`);
  }
}

function holdBookingCmd(args) {
  if (args.minutes !== undefined || args.daily !== undefined || args.until !== undefined || args.start !== undefined) usage();
  const id = String(args.booking);
  const force = args.force === true;
  const calPath = schedulePath();
  const holdPath = reservationPath();
  withReservationLock(() => {
    const now = Date.now();
    const found = bookingForActivation(id, now);
    const owner = args.owner === undefined ? (found && found.owner) : String(args.owner);
    if (!owner) throw codeError("booking_not_found", `no booking ${id}`);
    const rec = activateBookingLocked(id, { owner, now, force, path: calPath, holdPath });
    console.log(`held by ${rec.owner} until ${rec.expires_at} (${holdPath})`);
  });
  return 0;
}

function holdCmd(args) {
  if (args.booking !== undefined) return holdBookingCmd(args);
  const owner = requireOwner(args);
  if (args.start !== undefined || args.daily !== undefined || args.until !== undefined) usage();
  const minutes = args.minutes === undefined ? DEFAULT_MINUTES : positiveMinutesArg(args.minutes);
  const kind = kindArg(args);
  const mode = modeArg(args);
  const force = args.force === true;
  // Over the cap: refused before anything (hold file or calendar) is touched.
  checkHoldCap(minutes, force);
  const now = Date.now();
  const holdMs = Math.round(minutes * 60_000);
  const calPath = schedulePath();
  const holdPath = reservationPath();
  const allow = allowList(args.allow);
  const reason = args.reason === undefined ? "" : String(args.reason);
  const gttMb = numberArg(args["gtt-mb"]);
  const hostRamMb = numberArg(args["host-ram-mb"]);
  const hipProcs = numberArg(args["hip-procs"]);

  withReservationLock(() => {
    const endMs = now + holdMs;
    const overlapping = listBookings({ from: now, to: endMs, path: calPath, now })
      .filter((entry) => occupiesTime(entry) && overlapsRange(entry, now, endMs));
    const blocked = overlapping.find((entry) => entry.owner !== owner && !preemptable(entry));
    if (blocked) throw new BookingConflictError(conflictOf(blocked));

    const current = readReservation({ path: holdPath, now });
    if (current && current.corrupt) {
      throw new HoldConflictError("unknown", {
        message: "the box reservation file is unreadable (box held by unknown)",
      });
    }
    const foreignHold = current && current.owner !== owner ? current : null;
    if (foreignHold && !preemptableHold(foreignHold)) {
      throw new HoldConflictError(foreignHold.owner, { expires_at: foreignHold.expires_at });
    }

    // Our own overlapping bookings give way (a re-hold replaces your own), and
    // so does anything this hold may preempt — but only AFTER the new booking
    // and the new hold exist. Booking over them now (`ignoreIds`) and activating
    // with `takeOver` (one atomic rename, no gap) means a failure here leaves
    // the old hold and every booking untouched.
    let booking = null;
    let rec = null;
    try {
      booking = bookLocked({
        owner,
        kind,
        mode,
        start: now,
        minutes,
        reason,
        allow,
        gtt_mb: gttMb,
        host_ram_mb: hostRamMb,
        hip_procs: hipProcs,
        created_by: owner,
        ignoreIds: overlapping.map((entry) => entry.id),
        now,
        path: calPath,
        holdPath,
      });
      rec = activateBookingLocked(booking.id, {
        owner, now, force, takeOver: true, path: calPath, holdPath,
      });
    } catch (err) {
      // No ghost booking: a hold that could not activate leaves nothing behind.
      if (booking) {
        try {
          setBookingStatusLocked(booking.id, "cancelled", { path: calPath, now });
        } catch { /* the calendar is already the thing that failed */ }
      }
      throw err;
    }
    for (const entry of overlapping) {
      setBookingStatusLocked(entry.id, entry.owner === owner ? "done" : "lapsed", { path: calPath, now });
    }
    console.log(`held by ${rec.owner} until ${rec.expires_at} (${holdPath})`);
  });
  return 0;
}

function renewCmd(args) {
  const owner = requireOwner(args);
  if (args.minutes === undefined) usage();
  const minutes = positiveMinutesArg(args.minutes);
  const force = args.force === true;
  const holdPath = reservationPath();
  withReservationLock(() => {
    const now = Date.now();
    const hold = readReservation({ path: holdPath, now });
    const rec = hold && !hold.corrupt && hold.booking_id
      ? renewBookingLocked(hold.booking_id, {
        owner, minutes, now, force, path: schedulePath(), holdPath,
      })
      : _renewHoldLocked({ owner, minutes, now, force, path: holdPath });
    console.log(`renewed until ${rec.expires_at}`);
  });
  return 0;
}

function releaseCmd(args) {
  const owner = args.owner === undefined ? null : String(args.owner);
  const force = args.force === true;
  const holdPath = reservationPath();
  withReservationLock(() => {
    const now = Date.now();
    const hold = readReservation({ path: holdPath, now });

    if (owner === null) {
      if (!hold) {
        const removed = clearReservation({ path: holdPath });
        console.log(removed ? `released ${holdPath}` : "none (nothing to release)");
        return;
      }
      if (hold.corrupt) {
        clearReservation({ path: holdPath });
        console.log(`released ${holdPath}`);
        return;
      }
      const bare = hold.kind === null || hold.kind === "manual";
      if (!bare && !force) {
        throw codeError(
          "box_held",
          `the hold belongs to ${hold.owner} (${hold.kind || "no kind"}); pass --force or release it as --owner ${hold.owner}`,
        );
      }
      _releaseHoldLocked({ owner: hold.owner, force: true, path: holdPath });
      markHoldBookingDone(hold, now);
      console.log(`released ${holdPath}`);
      return;
    }

    if (!hold) {
      console.log("none (nothing to release)");
      return;
    }
    if (hold.corrupt) {
      throw new HoldConflictError("unknown", {
        message: force
          ? "the box reservation file is unreadable"
          : "the box reservation file is unreadable (box held by unknown); pass --force to remove it",
      });
    }
    const removed = _releaseHoldLocked({ owner, force, path: holdPath });
    if (!removed) throw new HoldConflictError(hold.owner, { expires_at: hold.expires_at });
    markHoldBookingDone(hold, now);
    console.log(`released ${holdPath}`);
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point.

function main(args) {
  const cmd = args._[0];
  if (args.help || !cmd) usage();
  switch (cmd) {
    case "status": return statusCmd(args);
    case "book": return bookCmd(args);
    case "calendar": return calendarCmd(args);
    case "cancel": return cancelCmd(args);
    case "approve": return approveCmd(args, "approved");
    case "decline": return approveCmd(args, "declined");
    case "hold": return holdCmd(args);
    case "renew": return renewCmd(args);
    case "release": return releaseCmd(args);
    default: usage();
  }
}

try {
  process.exitCode = main(parseArgs(process.argv.slice(2)));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else if (err && err.conflict) {
    console.error(conflictLine(err.conflict));
    process.exitCode = 1;
  } else {
    console.error(`${(err && err.code) || "error"}: ${(err && err.message) || err}`);
    process.exitCode = 1;
  }
}