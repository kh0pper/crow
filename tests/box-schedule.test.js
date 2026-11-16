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

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  book, listBookings, findGap, cancelBooking, approveBooking,
  BookingConflictError, CalendarCorruptError, schedulePath,
} from "../servers/gateway/box-schedule.js";
import { readReservation } from "../servers/gateway/box-reservation.js";

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

function fresh() {
  for (const p of [SCHEDULE, HOLD, LOCK]) {
    try { unlinkSync(p); } catch (err) { if (!err || err.code !== "ENOENT") throw err; }
  }
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