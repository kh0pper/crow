// tests/box-schedule.test.js
//
// The booking calendar is the persistent half of the one box calendar (the
// private engineering notes §6.3): model windows, manual holds, the nightly
// audit and GPU jobs all book their time here, next to the active hold that
// lives in box-reservation.js. Contract pinned here: conflicts on
// [start, end) overlap, adjacent bookings do not conflict, ASAP takes the
// first gap long enough, a legacy hold occupies its interval, a corrupt
// calendar refuses writes and is never replaced, and every write serialises
// on the one box lock.
//
// A daily booking is one series row with one entry per occurrence; it expands
// in local wall-clock time, so the DST nights below are read in a real zone.

process.env.TZ = "America/Chicago";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  book, bookLocked, listBookings, findGap, cancelBooking, approveBooking, declineBooking,
  activateBooking, activateBookingLocked, renewBooking, setBookingStatus, schedulePath,
  BookingConflictError, CalendarCorruptError,
} from "../servers/gateway/box-schedule.js";
import { HoldConflictError, readReservation, withReservationLock } from "../servers/gateway/box-reservation.js";

// Every state file this module touches lives in a scratch directory, set
// before the first call that resolves a path.
const DIR = mkdtempSync(join(tmpdir(), "box-schedule-"));
const SCHEDULE = join(DIR, "box-schedule.json");
const HOLD = join(DIR, "box-reservation.json");
const LOCK = join(DIR, "crow-box-schedule.lock");
process.env.CROW_BOX_SCHEDULE_PATH = SCHEDULE;
process.env.CROW_BOX_RESERVATION_PATH = HOLD;

const BASE = Date.parse("2026-10-27T00:00:00Z");
/** A fixed UTC clock: `at(10, 30)` is 10:30 on that day. */
const at = (h, m = 0) => BASE + h * 3_600_000 + m * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const NOW = at(9);
const MODULE_URL = new URL("../servers/gateway/box-schedule.js", import.meta.url).href;

/** Local wall-clock ms: `local(2026, 10, 27, 12)` is noon on 2026-10-27. */
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const DAY = 86_400_000;

function fresh() {
  for (const p of [SCHEDULE, HOLD, LOCK]) {
    try { unlinkSync(p); } catch (err) { if (!err || err.code !== "ENOENT") throw err; }
  }
}

/** The calendar file as it is on disk, for the series row itself. */
function calendarRow(id) {
  const raw = JSON.parse(readFileSync(SCHEDULE, "utf8"));
  return raw.bookings.find((b) => b && b.id === id);
}

test("missing file is an empty calendar", () => {
  fresh();
  assert.equal(schedulePath(), SCHEDULE);
  assert.deepEqual(listBookings({ now: NOW }), []);
  book({ owner: "alex", kind: "window", start: NOW, minutes: 60, now: NOW });
  assert.equal(listBookings({ now: NOW }).length, 1);
  assert.deepEqual(listBookings({ from: at(12), to: at(14), now: NOW }), []);
});

test("overlapping bookings conflict and name the blocker", () => {
  fresh();
  const first = book({ owner: "alex", kind: "window", start: at(10), minutes: 60, now: NOW });
  let err;
  try {
    book({ owner: "sam", kind: "manual", start: at(10, 30), minutes: 60, now: NOW });
  } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  assert.equal(err.code, "booking_conflict");
  assert.equal(err.http, 409);
  assert.equal(err.conflict.id, first.id);
  assert.equal(err.conflict.owner, "alex");
});

test("adjacent bookings [a,b) [b,c) do not conflict", () => {
  fresh();
  const a = book({ owner: "alex", kind: "window", start: at(10), minutes: 60, now: NOW });
  const b = book({ owner: "sam", kind: "manual", start: at(11), minutes: 60, now: NOW });
  assert.deepEqual(listBookings({ now: NOW }).map((x) => x.id), [a.id, b.id]);
});

test("asap takes the first gap long enough", () => {
  fresh();
  book({ owner: "alex", kind: "window", start: at(10), minutes: 60, now: NOW });
  book({ owner: "alex", kind: "window", start: at(11, 30), minutes: 90, now: NOW });
  // 09:30-10:00 is 30 min and 11:00-11:30 is 30 min, so a 30 min request fits
  // at 09:30 while a 45 min one has to wait for 13:00.
  assert.equal(findGap({ minutes: 30, after: at(9, 30), now: NOW }), at(9, 30));
  assert.equal(findGap({ minutes: 45, after: at(9, 30), now: NOW }), at(13));
  assert.equal(findGap({ minutes: 45, after: at(10, 15), now: NOW }), at(13));
  const asap = book({ owner: "sam", kind: "manual", start: "asap", minutes: 45, now: at(9, 30) });
  assert.equal(asap.start, iso(at(13)));
});

test("findGap with minutes longer than any gap throws no_gap", () => {
  fresh();
  book({ owner: "alex", kind: "manual", start: NOW, minutes: 14 * 24 * 60, now: NOW });
  let err;
  try { findGap({ minutes: 1, after: NOW, now: NOW }); } catch (e) { err = e; }
  assert.equal(err && err.code, "no_gap");
});

test("book over a live legacy dsv4 hold conflicts and names its owner", () => {
  fresh();
  writeFileSync(HOLD, JSON.stringify({
    owner: "pi-lab-dsv4",
    reason: "model window",
    started_at: iso(at(9)),
    expires_at: iso(at(12)),
    allow: ["crow-embed"],
  }) + "\n");
  let err;
  try {
    book({ owner: "sam", kind: "manual", start: at(10, 30), minutes: 30, now: at(10) });
  } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  assert.equal(err.conflict.id, null);
  assert.equal(err.conflict.kind, "legacy-hold");
  assert.equal(err.conflict.owner, "pi-lab-dsv4");
  assert.equal(findGap({ minutes: 30, after: at(10), now: at(10) }), at(12));
});

test("a hold that belongs to a booking is not double counted", () => {
  fresh();
  const linked = book({
    owner: "runner", kind: "gpu-job", mode: "beside", start: at(10), minutes: 60,
    gtt_mb: 50_000, now: NOW,
  });
  // The lease outlives the booking's end; only the booking's [10:00, 11:00)
  // occupies the calendar, the hold is represented by it.
  writeFileSync(HOLD, JSON.stringify({
    owner: "runner",
    reason: "job",
    started_at: iso(at(10)),
    expires_at: iso(at(12)),
    allow: [],
    mode: "beside",
    kind: "gpu-job",
    booking_id: linked.id,
  }) + "\n");
  let err;
  try {
    book({ owner: "sam", kind: "manual", start: at(10, 30), minutes: 30, now: at(10, 30) });
  } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  assert.equal(err.conflict.id, linked.id);
  const after = book({ owner: "sam", kind: "manual", start: at(11), minutes: 30, now: at(11) });
  assert.match(after.id, /^bk_[0-9a-f]{12}$/);
});

test("evict booking is pending approval; approve flips it with by and at", () => {
  fresh();
  const b = book({
    owner: "alex", kind: "gpu-job", mode: "beside", start: at(10), minutes: 60,
    evict: ["crow-chat"], gtt_mb: 40_000, now: NOW,
  });
  assert.equal(b.approval.state, "pending");
  assert.deepEqual(b.evict, ["crow-chat"]);
  const approved = approveBooking(b.id, { by: "alex", now: NOW + 60_000 });
  assert.equal(approved.approval.state, "approved");
  assert.equal(approved.approval.by, "alex");
  assert.equal(approved.approval.at, iso(NOW + 60_000));
  const [persisted] = listBookings({ now: NOW + 60_000 });
  assert.equal(persisted.approval.state, "approved");
});

test("approval pending past 12 h reads as declined", () => {
  fresh();
  const b = book({
    owner: "alex", kind: "gpu-job", mode: "beside", start: at(10), minutes: 60,
    needs_approval: true, now: NOW,
  });
  assert.equal(b.approval.state, "pending");
  const before = readFileSync(SCHEDULE, "utf8");
  const [read] = listBookings({ now: NOW + 13 * 3_600_000 });
  assert.equal(read.approval.state, "declined");
  assert.equal(read.approval.by, "expired");
  // A read never writes the file.
  assert.equal(readFileSync(SCHEDULE, "utf8"), before);
  let err;
  try { approveBooking(b.id, { by: "alex", now: NOW + 13 * 3_600_000 }); } catch (e) { err = e; }
  assert.equal(err && err.code, "booking_approval_expired");
});

test("corrupt calendar: book refuses with code calendar_corrupt; readReservation unaffected", () => {
  fresh();
  const garbage = "{\"version\": 1, \"bookings\": oops\n";
  writeFileSync(SCHEDULE, garbage);
  writeFileSync(HOLD, JSON.stringify({
    owner: "alex", reason: "", started_at: iso(NOW), expires_at: iso(NOW + 3_600_000), allow: [],
  }) + "\n");
  let err;
  try {
    book({ owner: "sam", kind: "manual", start: at(10), minutes: 30, now: NOW });
  } catch (e) { err = e; }
  assert.ok(err instanceof CalendarCorruptError);
  assert.equal(err.code, "calendar_corrupt");
  assert.throws(() => listBookings({ now: NOW }), (e) => e.code === "calendar_corrupt");
  const hold = readReservation({ now: NOW });
  assert.equal(hold && hold.owner, "alex");
  assert.equal(readFileSync(SCHEDULE, "utf8"), garbage);
});

test("cancel by non-owner refuses; owner and force succeed", () => {
  fresh();
  const a = book({ owner: "alex", kind: "window", start: at(10), minutes: 60, now: NOW });
  const b = book({ owner: "alex", kind: "window", start: at(11), minutes: 60, now: NOW });
  let err;
  try { cancelBooking(a.id, { owner: "sam", now: NOW }); } catch (e) { err = e; }
  assert.equal(err && err.code, "booking_not_owner");
  assert.equal(cancelBooking(a.id, { owner: "alex", now: NOW }).status, "cancelled");
  assert.equal(cancelBooking(b.id, { owner: "sam", force: true, now: NOW }).status, "cancelled");
  let missing;
  try { cancelBooking("bk_ffffffffffff", { owner: "alex", now: NOW }); } catch (e) { missing = e; }
  assert.equal(missing && missing.code, "booking_not_found");
});

test("concurrent book from two processes never double-books", async () => {
  fresh();
  const script = `
import { book } from ${JSON.stringify(MODULE_URL)};
const base = ${BASE};
const won = [];
for (let i = 0; i < 50; i += 1) {
  const start = base + i * 3600000;
  try {
    book({ owner: process.env.BOOK_OWNER, kind: "manual", start, minutes: 30, now: start });
    won.push(i);
  } catch (err) {
    if (!err || err.code !== "booking_conflict") {
      console.error(String(err && err.stack ? err.stack : err));
      process.exit(3);
    }
  }
}
process.stdout.write(JSON.stringify(won));
`;
  const run = (owner) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, BOOK_OWNER: owner },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errOut += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`child ${owner} exited ${code}: ${errOut}`));
      else resolve(JSON.parse(out));
    });
  });
  const [first, second] = await Promise.all([run("proc-a"), run("proc-b")]);
  const taken = [...first, ...second].sort((x, y) => x - y);
  assert.deepEqual(taken, Array.from({ length: 50 }, (_, i) => i));
  assert.equal(listBookings({ now: NOW }).length, 50);
});

test("writes prune old done bookings", () => {
  fresh();
  const oldDone = {
    id: "bk_000000000001", owner: "alex", kind: "window", mode: "exclusive",
    start: iso(NOW - 41 * 86_400_000), end: iso(NOW - 40 * 86_400_000),
    reason: "", allow: [], evict: [], approval: { state: "not_needed" },
    status: "done", created_by: "alex", created_at: iso(NOW - 41 * 86_400_000),
  };
  const oldCancelled = {
    ...oldDone, id: "bk_000000000002", status: "cancelled",
    start: iso(NOW - 32 * 86_400_000), end: iso(NOW - 31 * 86_400_000),
    created_at: iso(NOW - 32 * 86_400_000),
  };
  const recentDone = {
    ...oldDone, id: "bk_000000000003", status: "done",
    start: iso(NOW - 2 * 86_400_000), end: iso(NOW - 2 * 86_400_000 + 3_600_000),
    created_at: iso(NOW - 2 * 86_400_000),
  };
  writeFileSync(SCHEDULE, JSON.stringify({
    version: 1, bookings: [oldDone, oldCancelled, recentDone],
  }, null, 2) + "\n");
  const added = book({ owner: "sam", kind: "manual", start: at(10), minutes: 30, now: NOW });
  assert.deepEqual(
    listBookings({ now: NOW }).map((b) => b.id),
    [recentDone.id, added.id],
  );
});

// ---------------------------------------------------------------------------
// Daily recurrence. One series row, one entry per occurrence, expanded in
// local wall-clock time.

test("daily 02:15-04:15 blocks a 03:00 booking on any day", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const series = book({
    owner: "pi-lab-nightly-audit", kind: "audit", mode: "exclusive",
    daily: "02:15-04:15", reason: "nightly audit", created_by: "alex", now,
  });
  assert.match(series.id, /^bk_[0-9a-f]{12}$/);
  assert.deepEqual(series.recur, { daily: "02:15-04:15" });
  assert.equal(series.status, "booked");
  // The first occurrence at or after `now`: 02:15 on the 27th has passed.
  assert.equal(series.start, iso(local(2026, 10, 28, 2, 15)));
  assert.equal(series.end, null);
  for (const day of [28, 29, 30, 31]) {
    let err;
    try {
      book({ owner: "sam", kind: "manual", start: local(2026, 10, day, 3), minutes: 30, now });
    } catch (e) { err = e; }
    assert.ok(err instanceof BookingConflictError, `day ${day}`);
    assert.equal(err.conflict.id, `${series.id}@2026-10-${day}`);
    assert.equal(err.conflict.series_id, series.id);
    assert.deepEqual(err.conflict.recur, { daily: "02:15-04:15" });
  }
  // 05:00 sits outside the window on every day.
  const free = book({ owner: "sam", kind: "manual", start: local(2026, 11, 2, 5), minutes: 30, now });
  assert.match(free.id, /^bk_[0-9a-f]{12}$/);
});

test("daily 23:30-01:00 crosses midnight", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const series = book({ owner: "runner", kind: "gpu-job", mode: "beside", daily: "23:30-01:00", now });
  const [occ] = listBookings({ from: local(2026, 10, 27, 22), to: local(2026, 10, 28, 2), now });
  assert.equal(occ.id, `${series.id}@2026-10-27`);
  assert.equal(occ.series_id, series.id);
  assert.equal(occ.start, iso(local(2026, 10, 27, 23, 30)));
  assert.equal(occ.end, iso(local(2026, 10, 28, 1)));
  // 00:30 the next day is inside the occurrence that started the night before.
  let err;
  try {
    book({
      owner: "sam", kind: "manual", start: local(2026, 10, 28, 0, 30), minutes: 20,
      now: local(2026, 10, 27, 20),
    });
  } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  assert.equal(err.conflict.id, `${series.id}@2026-10-27`);
  // 23:00-23:30 the next evening is adjacent to that evening's window.
  const before = book({
    owner: "sam", kind: "manual", start: local(2026, 10, 28, 23), minutes: 30,
    now: local(2026, 10, 27, 20),
  });
  assert.ok(before.id);
});

test("daily window holds wall-clock on the DST change night", () => {
  fresh();
  const now = local(2026, 10, 30, 12);
  const series = book({
    owner: "pi-lab-nightly-audit", kind: "audit", mode: "exclusive", daily: "02:15-04:15", now,
  });
  // 2026-11-01 is the fall-back night in America/Chicago: 02:15 and 04:15 are
  // both real local times, so the window keeps its wall clock.
  const occ = listBookings({ from: local(2026, 11, 1), to: local(2026, 11, 2), now })
    .find((entry) => entry.id === `${series.id}@2026-11-01`);
  assert.ok(occ);
  assert.equal(new Date(occ.start).getHours(), 2);
  assert.equal(new Date(occ.start).getMinutes(), 15);
  assert.equal(new Date(occ.end).getHours(), 4);
  assert.equal(new Date(occ.end).getMinutes(), 15);
  let err;
  try {
    book({ owner: "sam", kind: "manual", start: local(2026, 11, 1, 3), minutes: 30, now });
  } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  assert.equal(err.conflict.id, `${series.id}@2026-11-01`);
});

test("daily 02:15-04:15 on 2027-03-14 (02:15 doesn't exist, America/Chicago) starts at 03:00 local and still blocks", () => {
  fresh();
  const now = local(2027, 3, 13, 12);
  const series = book({
    owner: "pi-lab-nightly-audit", kind: "audit", mode: "exclusive", daily: "02:15-04:15", now,
  });
  const occ = listBookings({ from: local(2027, 3, 14), to: local(2027, 3, 15), now })
    .find((entry) => entry.id === `${series.id}@2027-03-14`);
  assert.ok(occ);
  const start = new Date(occ.start);
  assert.equal(start.getHours(), 3);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getDate(), 14);
  let err;
  try {
    book({ owner: "sam", kind: "manual", start: local(2027, 3, 14, 3, 30), minutes: 20, now });
  } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  assert.equal(err.conflict.id, `${series.id}@2027-03-14`);
});

test("activating one audit occurrence does not mark the series done", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const series = book({
    owner: "pi-lab-nightly-audit", kind: "audit", mode: "exclusive",
    daily: "02:15-04:15", reason: "nightly audit", now,
  });
  const dayKey = "2026-10-28";
  const occId = `${series.id}@${dayKey}`;
  const startNow = local(2026, 10, 28, 2, 30);
  const hold = activateBooking(occId, { owner: "pi-lab-nightly-audit", now: startNow });
  assert.equal(hold.owner, "pi-lab-nightly-audit");
  assert.equal(hold.kind, "audit");
  assert.equal(hold.booking_id, occId);
  const row = calendarRow(series.id);
  assert.equal(row.status, "booked");
  assert.equal(row.occurrences[dayKey].status, "active");
  assert.equal(row.occurrences[dayKey].activated_at, iso(startNow));
  const expanded = listBookings({ from: local(2026, 10, 28), to: local(2026, 10, 30), now: startNow });
  assert.equal(expanded.find((e) => e.id === occId).status, "active");
  assert.equal(expanded.find((e) => e.id === `${series.id}@2026-10-29`).status, "booked");
  // A per-occurrence status change leaves the series where it was.
  const done = setBookingStatus(occId, "done", { now: startNow });
  assert.equal(done.status, "done");
  assert.equal(done.id, occId);
  assert.equal(calendarRow(series.id).status, "booked");
  assert.equal(calendarRow(series.id).occurrences[dayKey].status, "done");
  assert.throws(() => setBookingStatus(occId, "finished", { now: startNow }), TypeError);
});

test("series survives the 30-day prune", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const series = book({
    owner: "pi-lab-nightly-audit", kind: "audit", mode: "exclusive", daily: "02:15-04:15", now,
  });
  // A write two months later prunes finished one-off bookings, never a series.
  const later = now + 60 * DAY;
  book({ owner: "sam", kind: "manual", start: later + 3 * 3_600_000, minutes: 30, now: later });
  const row = calendarRow(series.id);
  assert.ok(row);
  assert.equal(row.status, "booked");
  assert.deepEqual(row.recur, { daily: "02:15-04:15" });
  const upcoming = listBookings({ now: later });
  assert.ok(upcoming.some((entry) => entry.series_id === series.id));
});

test("cancel one occurrence leaves the series; cancel the series id cancels all", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const series = book({
    owner: "pi-lab-nightly-audit", kind: "audit", mode: "exclusive", daily: "02:15-04:15", now,
  });
  const cancelledDay = `${series.id}@2026-10-28`;
  const cancelled = cancelBooking(cancelledDay, { owner: "pi-lab-nightly-audit", now });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.series_id, series.id);
  const row = calendarRow(series.id);
  assert.equal(row.status, "booked");
  assert.equal(row.occurrences["2026-10-28"].status, "cancelled");
  // The cancelled night is free, the next one is not.
  const free = book({ owner: "sam", kind: "manual", start: local(2026, 10, 28, 3), minutes: 30, now });
  assert.ok(free.id);
  let err;
  try {
    book({ owner: "sam", kind: "manual", start: local(2026, 10, 29, 3), minutes: 30, now });
  } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  // Cancelling the series id cancels every remaining occurrence.
  const all = cancelBooking(series.id, { owner: "pi-lab-nightly-audit", now });
  assert.equal(all.status, "cancelled");
  const after = listBookings({ from: local(2026, 10, 29), to: local(2026, 11, 2), now });
  assert.ok(after.length > 0);
  assert.ok(after.every((entry) => entry.status === "cancelled"));
  const also = book({ owner: "sam", kind: "manual", start: local(2026, 10, 30, 3), minutes: 30, now });
  assert.ok(also.id);
});

// ---------------------------------------------------------------------------
// Activation, renewal and status changes.

test("approve then activate writes the hold with booking_id and mode", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const b = book({
    owner: "alex", kind: "gpu-job", mode: "beside", start: local(2026, 10, 27, 13), minutes: 120,
    needs_approval: true, gtt_mb: 50_000, host_ram_mb: 32_000, hip_procs: 1, reason: "render job", now,
  });
  assert.equal(b.approval.state, "pending");
  const startNow = local(2026, 10, 27, 13, 10);
  approveBooking(b.id, { by: "alex", now });
  const hold = activateBooking(b.id, { owner: "alex", now: startNow });
  assert.equal(hold.booking_id, b.id);
  assert.equal(hold.mode, "beside");
  assert.equal(hold.kind, "gpu-job");
  assert.equal(hold.owner, "alex");
  const read = readReservation({ now: startNow });
  assert.equal(read.booking_id, b.id);
  assert.equal(read.mode, "beside");
  assert.equal(read.kind, "gpu-job");
  assert.equal(read.gtt_mb, 50_000);
  assert.equal(read.expires_at, iso(local(2026, 10, 27, 15)));
  const [stored] = listBookings({ now: startNow });
  assert.equal(stored.status, "active");
});

test("evict booking cannot activate until approved", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const b = book({
    owner: "sam", kind: "gpu-job", mode: "exclusive", start: local(2026, 10, 27, 13),
    minutes: 60, evict: ["crow-chat"], now,
  });
  assert.equal(b.approval.state, "pending");
  let err;
  try { activateBooking(b.id, { owner: "sam", now: local(2026, 10, 27, 13, 5) }); } catch (e) { err = e; }
  assert.equal(err && err.code, "booking_not_approved");
  // A refused activation leaves no hold behind.
  assert.equal(readReservation({ now: local(2026, 10, 27, 13, 5) }), null);
  assert.equal(listBookings({ now }).find((x) => x.id === b.id).status, "booked");
});

test("activate before start refuses", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const b = book({ owner: "alex", kind: "window", start: local(2026, 10, 27, 14), minutes: 60, now });
  let early;
  try { activateBooking(b.id, { owner: "alex", now: local(2026, 10, 27, 13, 59) }); } catch (e) { early = e; }
  assert.equal(early && early.code, "booking_not_started");
  let late;
  try { activateBooking(b.id, { owner: "alex", now: local(2026, 10, 27, 15) }); } catch (e) { late = e; }
  assert.equal(late && late.code, "booking_ended");
  assert.equal(readReservation({ now: local(2026, 10, 27, 14) }), null);
});

test("activate refuses a foreign owner and a foreign unexpired hold", () => {
  fresh();
  const now = local(2026, 10, 27, 12);
  const b = book({ owner: "alex", kind: "window", start: local(2026, 10, 27, 13), minutes: 60, now });
  let err;
  try { activateBooking(b.id, { owner: "sam", now: local(2026, 10, 27, 13, 5) }); } catch (e) { err = e; }
  assert.equal(err && err.code, "booking_not_owner");
  writeFileSync(HOLD, JSON.stringify({
    owner: "pi-lab-dsv4",
    reason: "model window",
    started_at: iso(now),
    expires_at: iso(now + 4 * 3_600_000),
    allow: [],
  }) + "\n");
  let held;
  try { activateBooking(b.id, { owner: "alex", now: local(2026, 10, 27, 13, 5) }); } catch (e) { held = e; }
  assert.ok(held instanceof HoldConflictError);
  assert.equal(held.code, "box_held");
  assert.equal(held.holder, "pi-lab-dsv4");
  assert.equal(readReservation({ now: local(2026, 10, 27, 13, 5) }).owner, "pi-lab-dsv4");
});

test("renewBooking extends end so findGap does not hand out the running job's time", () => {
  fresh();
  const start = local(2026, 10, 27, 10);
  const b = book({
    owner: "runner", kind: "gpu-job", mode: "beside", start, minutes: 60, now: local(2026, 10, 27, 9),
  });
  activateBooking(b.id, { owner: "runner", now: start });
  const hold = renewBooking(b.id, { owner: "runner", minutes: 120, now: local(2026, 10, 27, 10, 30) });
  assert.equal(hold.expires_at, iso(local(2026, 10, 27, 12, 30)));
  assert.equal(hold.started_at, iso(start));
  const asked = local(2026, 10, 27, 11, 5);
  assert.equal(findGap({ minutes: 15, after: asked, now: asked }), local(2026, 10, 27, 12, 30));
});

test("renewBooking refuses to run into the next booking", () => {
  fresh();
  const now = local(2026, 10, 27, 9);
  const a = book({
    owner: "runner", kind: "gpu-job", mode: "beside", start: local(2026, 10, 27, 10),
    minutes: 60, now,
  });
  book({ owner: "alex", kind: "window", start: local(2026, 10, 27, 12), minutes: 60, now });
  activateBooking(a.id, { owner: "runner", now: local(2026, 10, 27, 10) });
  const fiveToEleven = local(2026, 10, 27, 10, 55);
  let err;
  try { renewBooking(a.id, { owner: "runner", minutes: 180, now: fiveToEleven }); } catch (e) { err = e; }
  assert.ok(err instanceof RangeError);
  assert.equal(err.message, "renew_past_next_booking");
  assert.equal(listBookings({ now }).find((x) => x.id === a.id).end, iso(local(2026, 10, 27, 11)));
  assert.equal(readReservation({ now: fiveToEleven }).expires_at, iso(local(2026, 10, 27, 11)));
});

test("hold = book + activate completes under one lock without box_lock_timeout", () => {
  fresh();
  const start = local(2026, 10, 27, 10);
  const out = withReservationLock(() => {
    const booking = bookLocked({
      owner: "alex", kind: "manual", mode: "exclusive", start: "now", minutes: 60,
      now: start, path: SCHEDULE, holdPath: HOLD,
    });
    const hold = activateBookingLocked(booking.id, {
      owner: "alex", now: start, path: SCHEDULE, holdPath: HOLD,
    });
    return { booking, hold };
  }, { path: LOCK, timeoutMs: 1_000 });
  assert.equal(out.hold.owner, "alex");
  assert.equal(out.hold.booking_id, out.booking.id);
  assert.equal(out.hold.expires_at, iso(local(2026, 10, 27, 11)));
  assert.equal(listBookings({ now: start }).find((x) => x.id === out.booking.id).status, "active");
});

test("a declined or expired-pending booking does not block the calendar", () => {
  fresh();
  const now = local(2026, 10, 27, 9);
  const declined = book({
    owner: "alex", kind: "gpu-job", mode: "beside", start: local(2026, 10, 27, 10),
    minutes: 60, needs_approval: true, now,
  });
  declineBooking(declined.id, { by: "alex", now });
  book({
    owner: "alex", kind: "gpu-job", mode: "beside", start: local(2026, 10, 27, 12),
    minutes: 60, needs_approval: true, now,
  });
  // 13 h later the second request is past the 12 h TTL and reads as declined.
  const laterNow = now + 13 * 3_600_000;
  assert.equal(findGap({ minutes: 60, after: local(2026, 10, 27, 10), now: laterNow }), local(2026, 10, 27, 10));
  const first = book({
    owner: "sam", kind: "manual", start: local(2026, 10, 27, 10, 15), minutes: 30, now: laterNow,
  });
  const second = book({
    owner: "sam", kind: "manual", start: local(2026, 10, 27, 12, 15), minutes: 30, now: laterNow,
  });
  assert.ok(first.id);
  assert.ok(second.id);
});

// A pending approval holds its slot: approving it later can never double-book
// the box, because nothing else could have taken that time in the meantime.
test("a pending booking occupies its slot: a second overlapping booking conflicts", () => {
  fresh();
  const now = at(9);
  const pending = book({
    owner: "alex", kind: "gpu-job", mode: "exclusive", start: at(10), minutes: 60,
    evict: ["crow-chat"], now,
  });
  assert.equal(pending.approval.state, "pending");
  let err;
  try {
    book({ owner: "sam", kind: "manual", start: at(10, 30), minutes: 30, now });
  } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  assert.equal(err.code, "booking_conflict");
  assert.equal(err.conflict.id, pending.id);
  assert.equal(err.conflict.owner, "alex");
  // The gap finder waits for the pending slot to clear as well.
  assert.equal(findGap({ minutes: 30, after: at(10, 15), now }), at(11));
});

test("approving the first after another booking took an adjacent-free slot still succeeds", () => {
  fresh();
  const now = at(9);
  const first = book({
    owner: "alex", kind: "gpu-job", mode: "exclusive", start: at(10), minutes: 60,
    evict: ["crow-chat"], now,
  });
  // [11:00, 12:00) is adjacent, so it is free while the evict request waits.
  const second = book({ owner: "sam", kind: "manual", start: at(11), minutes: 60, now });
  assert.ok(second.id);
  const approved = approveBooking(first.id, { by: "alex", now });
  assert.equal(approved.approval.state, "approved");
  assert.equal(calendarRow(first.id).approval.state, "approved");
});

test("approve re-checks occupancy and refuses a slot that was taken", () => {
  fresh();
  const now = at(9);
  const pending = book({
    owner: "alex", kind: "gpu-job", mode: "exclusive", start: at(10), minutes: 60,
    evict: ["crow-chat"], now,
  });
  assert.equal(pending.approval.state, "pending");
  // A row written straight into the calendar file, the way a second writer
  // that never went through book() would: it overlaps the pending slot.
  const raw = JSON.parse(readFileSync(SCHEDULE, "utf8"));
  const intruder = {
    id: "bk_00000000feed", owner: "sam", kind: "manual", mode: "exclusive",
    start: iso(at(10, 15)), end: iso(at(10, 45)),
    reason: "", allow: [], evict: [], approval: { state: "not_needed" },
    status: "booked", created_by: "sam", created_at: iso(now),
  };
  raw.bookings.push(intruder);
  writeFileSync(SCHEDULE, JSON.stringify(raw, null, 2) + "\n");
  let err;
  try { approveBooking(pending.id, { by: "alex", now }); } catch (e) { err = e; }
  assert.ok(err instanceof BookingConflictError);
  assert.equal(err.code, "booking_conflict");
  assert.equal(err.http, 409);
  assert.equal(err.conflict.id, intruder.id);
  assert.equal(err.conflict.owner, "sam");
  // Refused under the lock: nothing was written, so the request is still pending.
  assert.equal(calendarRow(pending.id).approval.state, "pending");
  assert.equal(listBookings({ now }).find((b) => b.id === pending.id).approval.state, "pending");
});