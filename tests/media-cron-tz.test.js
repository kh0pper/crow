/**
 * Cron in a named time zone (bundles/media/server/cron-tz.js): the media bundle's own evaluator.
 * Cross-checked against cron-parser (the library the gateway scheduler uses) so the News schedule
 * and the row's next_run cannot disagree on the expressions both support.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CronExpressionParser } from "cron-parser";
import { parseCron, occurrences, nextOccurrence, localParts, validTimeZone } from "../bundles/media/server/cron-tz.js";

const iso = (ms) => new Date(ms).toISOString();
const at = (s) => Date.parse(s);
const TZ = "America/Chicago";

test("0 8 * * * in America/Chicago is 13:00Z in summer and 14:00Z after the November change", () => {
  assert.equal(iso(nextOccurrence("0 8 * * *", TZ, at("2026-10-05T12:00:00Z"))), "2026-10-05T13:00:00.000Z");
  assert.equal(iso(nextOccurrence("0 8 * * *", TZ, at("2026-10-05T13:00:00Z"))), "2026-10-06T13:00:00.000Z");
  assert.equal(iso(nextOccurrence("0 8 * * *", TZ, at("2026-10-31T13:00:00Z"))), "2026-11-01T14:00:00.000Z");
  assert.equal(iso(nextOccurrence("0 8 * * *", TZ, at("2027-03-13T14:00:00Z"))), "2027-03-14T13:00:00.000Z");
});

test("occurrences are (from, to]: the boundary minute belongs to the earlier window only", () => {
  const occ = at("2026-10-05T13:00:00Z");
  assert.deepEqual(occurrences("0 8 * * *", TZ, occ - 60_000, occ).map(iso), ["2026-10-05T13:00:00.000Z"]);
  assert.deepEqual(occurrences("0 8 * * *", TZ, occ, occ + 3_600_000), []);
});

test("a wall-clock minute that repeats fires once; one that never happens does not fire", () => {
  // 2026-11-01: 01:30 CDT (06:30Z) and 01:30 CST (07:30Z). Both half-hours repeat.
  const fallBack = occurrences("*/30 1 * * *", TZ, at("2026-11-01T05:00:00Z"), at("2026-11-01T09:00:00Z")).map(iso);
  assert.deepEqual(fallBack, ["2026-11-01T06:00:00.000Z", "2026-11-01T06:30:00.000Z"]);
  // A window that starts between the two passes still treats the second pass as a repeat.
  assert.deepEqual(occurrences("30 1 * * *", TZ, at("2026-11-01T07:00:00Z"), at("2026-11-01T09:00:00Z")), []);
  // 2027-03-14: 02:30 local does not exist.
  assert.deepEqual(occurrences("30 2 * * *", TZ, at("2027-03-14T00:00:00Z"), at("2027-03-14T23:00:00Z")), []);
});

test("weekdays, lists, ranges, steps and names", () => {
  const week = occurrences("0 8 * * 1-5", TZ, at("2026-10-02T13:00:00Z"), at("2026-10-09T13:00:00Z")).map((t) => localParts(t, TZ).dow);
  assert.deepEqual(week, [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 8 * * mon-fri").sets[4]].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 8 * * 7").sets[4]], [0]);
  assert.deepEqual([...parseCron("5/20 * * * *").sets[0]], [5, 25, 45]);
  assert.deepEqual([...parseCron("0 6,18 1 jan *").sets[1]], [6, 18]);
  // Day-of-month and day-of-week both restricted: either matches (the 13th, or any Friday).
  const either = occurrences("0 0 13 * 5", "UTC", at("2026-11-01T00:00:00Z"), at("2026-11-30T23:59:00Z")).map((t) => new Date(t).getUTCDate());
  assert.deepEqual(either, [6, 13, 20, 27]);
});

test("unsupported or malformed expressions and zones are refused, never ignored", () => {
  for (const bad of ["", "0 8 * *", "0 8 * * * *", "@daily", "0 8 L * *", "60 8 * * *", "0 24 * * *", "0 8 0 * *", "0 8 * 13 *", "5-1 * * * *", "*/0 * * * *", "a b c d e", "0 8 * * 1#2"]) {
    assert.throws(() => parseCron(bad), { code: "bad_cron" }, bad);
  }
  assert.equal(validTimeZone("America/Chicago"), true);
  assert.equal(validTimeZone("Mars/Olympus"), false);
  assert.throws(() => occurrences("0 8 * * *", "Mars/Olympus", 0, 1), { code: "bad_tz" });
});

test("agrees with cron-parser wherever cron-parser is right: autumn change included, the spring-forward day excluded", () => {
  // cron-parser 5.5.0 skips every occurrence on a spring-forward day when asked from before the gap
  // ("0 8 * * *" in America/Chicago, asked on 2027-03-13, answers 2027-03-15). This module does not
  // (pinned in the first test), so the comparison runs on windows that end before, or start after, that day.
  const exprs = ["0 8 * * *", "30 7 * * 1-5", "15 6,18 * * *", "0 */6 * * *", "45 23 * * 0", "0 12 1,15 * *", "*/20 9-10 * * 2,4"];
  const windows = [["2026-10-20T00:00:00Z", "2027-02-20T00:00:00Z"], ["2027-04-01T00:00:00Z", "2027-06-01T00:00:00Z"]];
  let compared = 0;
  for (const tz of ["America/Chicago", "Europe/Madrid", "Asia/Kolkata", "UTC"]) {
    for (const [start, end] of windows) {
      for (const expr of exprs) {
        const theirs = CronExpressionParser.parse(expr, { tz, currentDate: new Date(start), endDate: new Date(end) });
        const mine = occurrences(expr, tz, at(start), at(end), 60);
        for (const t of mine) { assert.equal(iso(t), theirs.next().toISOString(), `${expr} in ${tz} from ${start}`); compared++; }
        assert.ok(mine.length >= 4, `${expr} in ${tz}: only ${mine.length} occurrences compared`);
      }
    }
  }
  assert.ok(compared > 1500, `compared ${compared}`);
});

test("bounded work: a week of every-minute occurrences, and hostile input, return quickly", () => {
  const t0 = Date.now();
  assert.equal(occurrences("* * * * *", TZ, at("2026-10-05T00:00:00Z"), at("2026-10-12T00:00:00Z")).length, 10080);
  assert.throws(() => parseCron(`${"1,".repeat(50_000)}1 * * * *`), { code: "bad_cron" });
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});
