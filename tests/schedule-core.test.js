/**
 * schedule-core: the pure rules behind schedule types, zones and missed runs.
 * No database, no clock: every function takes `now` explicitly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scheduleKind, reminderText, SCHEDULE_OWNERS, zoneFor, cronNext, cronPrev, countGrid,
  cadenceMinutes, settleDue, graceMs, ONCE, MISSED_CAP,
} from "../servers/shared/schedule-core.js";

const T = (s) => Date.parse(s);
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const GRACE = 5 * MIN;

test("the type comes from the task text", () => {
  assert.equal(scheduleKind("pipeline:botcron:lab-triage"), "bot_routine");
  assert.equal(scheduleKind("pipeline:something-else"), "system");
  assert.equal(scheduleKind("media:briefing"), "briefing");
  assert.equal(scheduleKind("reminder:stretch"), "reminder");
  assert.equal(scheduleKind("check the oven"), "reminder", "bare text is a reminder (#364 shape)");
  assert.equal(scheduleKind(""), "reminder");
  assert.equal(scheduleKind(null), "reminder");
  assert.equal(SCHEDULE_OWNERS["media:briefing"].kind, "briefing");
  assert.ok(Object.isFrozen(SCHEDULE_OWNERS));
});

test("reminderText strips an optional prefix", () => {
  assert.equal(reminderText("reminder:  stretch "), "stretch");
  assert.equal(reminderText("water the plants"), "water the plants");
  assert.equal(reminderText("reminder:"), "");
});

test("zoneFor falls back on null, empty and unknown zones", () => {
  assert.equal(zoneFor("Europe/Madrid", "America/Chicago"), "Europe/Madrid");
  assert.equal(zoneFor(null, "America/Chicago"), "America/Chicago");
  assert.equal(zoneFor("", "America/Chicago"), "America/Chicago");
  assert.equal(zoneFor("Mars/Olympus", "America/Chicago"), "America/Chicago");
  assert.ok(zoneFor(null, null), "no fallback → the host zone, never empty");
});

test("DST in America/Chicago: the pinned values", () => {
  // spring forward: 02:30 does not exist on 2026-03-08 → 03:30 CDT
  assert.equal(new Date(cronNext("30 2 * * *", "America/Chicago", T("2026-03-08T06:00:00Z"))).toISOString(), "2026-03-08T08:30:00.000Z");
  // fall back: 01:30 happens twice, the job runs once
  const a = cronNext("30 1 * * *", "America/Chicago", T("2026-11-01T05:00:00Z"));
  assert.equal(new Date(a).toISOString(), "2026-11-01T06:30:00.000Z");
  assert.equal(new Date(cronNext("30 1 * * *", "America/Chicago", a)).toISOString(), "2026-11-02T07:30:00.000Z");
  // */30 during the repeated hour: 06:00Z and 06:30Z only
  const b1 = cronNext("*/30 1 * * *", "America/Chicago", T("2026-11-01T05:00:00Z"));
  const b2 = cronNext("*/30 1 * * *", "America/Chicago", b1);
  const b3 = cronNext("*/30 1 * * *", "America/Chicago", b2);
  assert.deepEqual([b1, b2, b3].map((x) => new Date(x).toISOString()),
    ["2026-11-01T06:00:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-02T07:00:00.000Z"]);
  // weekdays at 8 across the change
  assert.equal(new Date(cronNext("0 8 * * 1-5", "America/Chicago", T("2026-11-01T06:00:00Z"))).toISOString(), "2026-11-02T14:00:00.000Z");
});

test("the spring-forward day is not skipped (cron-parser 5.5.0 next() skips it)", () => {
  assert.equal(new Date(cronNext("0 9 * * *", "America/Chicago", T("2026-03-07T20:00:00Z"))).toISOString(), "2026-03-08T14:00:00.000Z");
  assert.equal(new Date(cronNext("0 9 * * *", "Europe/Madrid", T("2026-03-28T12:00:00Z"))).toISOString(), "2026-03-29T07:00:00.000Z");
  assert.equal(countGrid("0 9 * * *", "America/Chicago", T("2026-03-06T20:00:00Z"), T("2026-03-10T20:00:00Z"), 500).n, 4);
});

test("DST in Europe/Madrid", () => {
  // 2026-03-29: 02:00 → 03:00 local
  assert.equal(new Date(cronNext("0 9 * * *", "Europe/Madrid", T("2026-03-28T12:00:00Z"))).toISOString(), "2026-03-29T07:00:00.000Z");
  assert.equal(new Date(cronNext("0 9 * * *", "Europe/Madrid", T("2026-03-27T12:00:00Z"))).toISOString(), "2026-03-28T08:00:00.000Z");
});

test("cronPrev includes an occurrence exactly at `at`; cronNext is strictly after", () => {
  const at = T("2026-10-26T14:00:00Z");
  assert.equal(cronPrev("0 14 * * *", "UTC", at), at);
  assert.equal(cronPrev("0 14 * * *", "UTC", at - 1), at - DAY);
  assert.equal(cronNext("0 14 * * *", "UTC", at), at + DAY);
  assert.equal(cronNext("not a cron", "UTC", at), null);
  assert.equal(cronPrev("not a cron", "UTC", at), null);
});

test("countGrid counts (after, to] and stops at the cap", () => {
  const from = T("2026-10-26T00:00:00Z");
  assert.deepEqual(countGrid("*/15 * * * *", "UTC", from, from + DAY, 500), { n: 96, capped: false });
  assert.deepEqual(countGrid("* * * * *", "UTC", from, from + 10 * HOUR, 500), { n: 500, capped: true });
});

test("cadenceMinutes is the shortest gap between the next occurrences", () => {
  const now = T("2026-10-26T20:00:00Z");
  assert.equal(cadenceMinutes("*/5 * * * *", "UTC", now), 5);
  assert.equal(cadenceMinutes("0 * * * *", "UTC", now), 60);
  assert.equal(cadenceMinutes("*/20 9-17 * * *", "UTC", now), 20, "a gap at night does not hide a 20-min day cadence");
  assert.equal(cadenceMinutes("0 9 * * *", "UTC", now), 1440);
  assert.equal(cadenceMinutes("bad", "UTC", now), null);
});

test("graceMs: default 5 min, env clamped 1–60", () => {
  assert.equal(graceMs({}), 5 * MIN);
  assert.equal(graceMs({ CROW_SCHEDULE_GRACE_MIN: "0" }), 1 * MIN);
  assert.equal(graceMs({ CROW_SCHEDULE_GRACE_MIN: "999" }), 60 * MIN);
  assert.equal(graceMs({ CROW_SCHEDULE_GRACE_MIN: "nope" }), 5 * MIN);
});

const daily = (next_run, extra = {}) => ({ cron_expression: "0 9 * * *", next_run, tz: "UTC", ...extra });

test("settleDue: nothing due → null", () => {
  assert.equal(settleDue(daily(null), T("2026-10-26T10:00:00Z"), { graceMs: GRACE }), null);
  assert.equal(settleDue(daily("2026-10-26T11:00:00Z"), T("2026-10-26T10:00:00Z"), { graceMs: GRACE }), null);
});

test("settleDue: within grace fires (ok under 90 s, late after)", () => {
  const due = "2026-10-26T09:00:00.000Z";
  let r = settleDue(daily(due), T(due) + 30_000, { graceMs: GRACE });
  assert.equal(r.fire, T(due)); assert.equal(r.status, "ok"); assert.equal(r.missed, null);
  assert.equal(r.nextRun, T("2026-10-27T09:00:00Z"));
  r = settleDue(daily(due), T(due) + 4 * MIN, { graceMs: GRACE });
  assert.equal(r.fire, T(due)); assert.equal(r.status, "late"); assert.equal(r.late, false);
});

test("settleDue: beyond grace → missed only, nothing fires", () => {
  const due = "2026-10-26T09:00:00.000Z";
  const r = settleDue(daily(due), T(due) + 10 * MIN, { graceMs: GRACE });
  assert.equal(r.fire, null);
  assert.deepEqual(r.missed, { first: T(due), last: T(due), count: 1, capped: false });
  assert.equal(r.nextRun, T("2026-10-27T09:00:00Z"));
});

test("settleDue: a 3-day outage of a daily cron is one window of 3", () => {
  const due = "2026-10-23T09:00:00.000Z";
  const r = settleDue(daily(due), T("2026-10-26T08:00:00Z"), { graceMs: GRACE });
  assert.equal(r.fire, null);
  assert.deepEqual(r.missed, { first: T(due), last: T("2026-10-25T09:00:00Z"), count: 3, capped: false });
});

test("settleDue: a 15-min cron down for a day → 96 missed (then one fires within grace)", () => {
  const due = "2026-10-25T10:00:00.000Z";
  const row = { cron_expression: "*/15 * * * *", next_run: due, tz: "UTC" };
  const r = settleDue(row, T("2026-10-26T10:00:30Z"), { graceMs: GRACE });
  assert.equal(r.fire, T("2026-10-26T10:00:00Z"), "the latest occurrence is inside grace");
  assert.equal(r.missed.count, 96);
  assert.equal(r.missed.first, T(due));
  assert.equal(r.missed.last, T("2026-10-26T09:45:00Z"));
});

test("C1a: an off-grid next_run is still an occurrence (never silently dropped)", () => {
  // next_run written in another zone / by hand: 09:07 is not on the 09:00 grid
  const due = "2026-10-26T09:07:00.000Z";
  const missed = settleDue(daily(due), T("2026-10-26T12:00:00Z"), { graceMs: GRACE });
  assert.equal(missed.fire, null);
  assert.deepEqual(missed.missed, { first: T(due), last: T(due), count: 1, capped: false });
  const fired = settleDue(daily(due), T(due) + 60_000, { graceMs: GRACE });
  assert.equal(fired.fire, T(due));
});

test("C1b: a 1-min cron after a 10 h outage still fires the occurrence 40 s ago; the cap bounds only the count", () => {
  const now = T("2026-10-26T20:00:40Z");
  const row = { cron_expression: "* * * * *", next_run: "2026-10-26T10:00:00.000Z", tz: "UTC" };
  const r = settleDue(row, now, { graceMs: GRACE });
  assert.equal(r.fire, T("2026-10-26T20:00:00Z"));
  assert.equal(r.status, "ok");
  assert.equal(r.missed.capped, true);
  assert.equal(r.missed.count, MISSED_CAP);
  assert.equal(r.missed.last, T("2026-10-26T19:59:00Z"));
});

test("a live process that stalled past grace fires late instead of recording a miss", () => {
  const due = "2026-10-26T09:00:00.000Z";
  const r = settleDue(daily(due), T(due) + 20 * MIN, { graceMs: GRACE, aliveAt: T(due) - 30_000 });
  assert.equal(r.fire, T(due));
  assert.equal(r.status, "late");
  assert.equal(r.missed, null);
  const cold = settleDue(daily(due), T(due) + 20 * MIN, { graceMs: GRACE, aliveAt: T(due) - 10 * MIN });
  assert.equal(cold.fire, null, "a tick long before due proves nothing");
});

test("one-shots always fire; beyond grace they are marked late (D7)", () => {
  const due = "2026-10-26T09:00:00.000Z";
  const once = { cron_expression: ONCE, next_run: due, tz: null };
  let r = settleDue(once, T(due) + 10_000, { graceMs: GRACE });
  assert.deepEqual({ fire: r.fire, status: r.status, late: r.late, missed: r.missed, nextRun: r.nextRun },
    { fire: T(due), status: "ok", late: false, missed: null, nextRun: null });
  r = settleDue(once, T(due) + 3 * HOUR, { graceMs: GRACE });
  assert.equal(r.fire, T(due)); assert.equal(r.status, "late"); assert.equal(r.late, true); assert.equal(r.missed, null);
});

test("an unparseable recurring cron settles with no fire and no next run", () => {
  const r = settleDue({ cron_expression: "garbage", next_run: "2026-10-26T09:00:00Z", tz: null }, T("2026-10-26T09:01:00Z"), { graceMs: GRACE });
  assert.equal(r.nextRun, null);
  assert.equal(r.fire, T("2026-10-26T09:00:00Z"), "the stored time itself is still honoured once");
});

test("the repeated fall-back hour is never a second occurrence, forwards or backwards", () => {
  const z = "America/Chicago";
  // 01:30 CDT = 06:30Z is the occurrence; 01:30 CST = 07:30Z is the repeat
  assert.equal(cronPrev("30 1 * * *", z, T("2026-11-01T07:35:00Z")), T("2026-11-01T06:30:00Z"));
  assert.equal(countGrid("30 1 * * *", z, T("2026-10-31T12:00:00Z"), T("2026-11-01T12:00:00Z"), 500).n, 1);
  assert.equal(cronPrev("0 9 * * *", z, T("2026-11-01T16:00:00Z")), T("2026-11-01T15:00:00Z"), "an ordinary prev is untouched");
});
