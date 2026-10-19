/**
 * servers/shared/relative-dates.js — the ONE implementation of the turn-context day lines ([Now], [Dates]) and the
 * relative-day trigger, shared by the kiosk (re-exported from bundles/kiosk/server/clock.js, so kiosk, glasses and
 * core run the same function objects), the companion router, dashboard chat and pi turns.
 * Its export names are an API: an installed kiosk copy (0.3.19+) reads them through the app root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.CROW_APP_ROOT = REPO;   // the kiosk's appImport must land on THIS tree's core module
const core = await import("../servers/shared/relative-dates.js");
const { relativeDatesContext, mentionsRelativeDay, appendDates, nowContext, validTimeZone, RELATIVE_DAY_MAX_CHARS } = core;

// ── Queue item 17a (2026-10-15): "add a car appointment 8:15 a.m. Monday" on Thursday Oct 15 was read as the PAST
// Monday. A voice turn that names a relative day gets a computed [Dates] line: the next seven dates, today, the offset.

const THU = Date.UTC(2026, 9, 15, 21, 57);   // Thursday 15 October 2026, 4:57 PM in Chicago (CDT)

test("relativeDatesContext: the next seven dates by weekday, tomorrow marked, today stated, the zone's offset", () => {
  assert.equal(relativeDatesContext(THU, "America/Chicago"),
    "[Dates] To add or plan something, a day named without a date is the next one: Friday 2026-10-16 (tomorrow), Saturday 2026-10-17, Sunday 2026-10-18, Monday 2026-10-19, Tuesday 2026-10-20, Wednesday 2026-10-21; Thursday is today 2026-10-15 or next week 2026-10-22. For something already past, it is the previous one. UTC offset -05:00.");
});

test("relativeDatesContext: late Sunday night → tomorrow is Monday; the display's zone decides the day", () => {
  const sunLate = Date.UTC(2026, 9, 19, 4, 30);   // Sunday 18 Oct 11:30 PM Chicago = Monday 19 Oct 1:30 PM Tokyo
  assert.match(relativeDatesContext(sunLate, "America/Chicago"), /: Monday 2026-10-19 \(tomorrow\), .* Saturday 2026-10-24; Sunday is today 2026-10-18 or next week 2026-10-25\. .* UTC offset -05:00\.$/);
  assert.match(relativeDatesContext(sunLate, "Asia/Tokyo"), /: Tuesday 2026-10-20 \(tomorrow\), .* Sunday 2026-10-25; Monday is today 2026-10-19 or next week 2026-10-26\. .* UTC offset \+09:00\.$/);
  assert.match(relativeDatesContext(sunLate, "UTC"), /UTC offset \+00:00\.$/);
  assert.match(relativeDatesContext(sunLate, "Asia/Kolkata"), /UTC offset \+05:30\.$/);
});

test("relativeDatesContext: a day across a DST change carries its own offset", () => {
  const thu29 = Date.UTC(2026, 9, 29, 17, 0);   // Thu 29 Oct 2026, Chicago; US DST ends Sun 1 Nov
  const line = relativeDatesContext(thu29, "America/Chicago");
  assert.match(line, /Saturday 2026-10-31, Sunday 2026-11-01 \(-06:00\), Monday 2026-11-02 \(-06:00\),/);
  assert.match(line, /UTC offset -05:00\.$/);
});

test("relativeDatesContext: a bad zone falls back to the server's and never throws", () => {
  assert.match(relativeDatesContext(THU, "Mars/Olympus"), /^\[Dates\] To add or plan something, a day named without a date is the next one: \w+day \d{4}-\d\d-\d\d \(tomorrow\), /);
});

test("mentionsRelativeDay: weekdays and relative days in English and Spanish, as whole words", () => {
  for (const t of ["Add a car appointment at 8:15 a.m. Monday to my calendar", "I had a car appointment at 815 a.m. Monday to my calendar.", "remind me tomorrow", "what's on next week?",
    "Schedule lunch on Friday's afternoon", "this weekend", "the day after tomorrow", "TUESDAY", "manana a las 9", "el miércoles a las 8 de la mañana", "on Mon at 3", "Thurs", "lunch tmrw", "cita el lunes a las ocho", "mañana a las 9", "el sábado", "pasado mañana",
    "la próxima semana", "la semana que viene", "este fin de semana", "el miercoles", "What do I have on Sunday?"]) assert.equal(mentionsRelativeDay(t), true, t);
  for (const t of ["what time is it", "play kpft", "Sundance festival", "set a timer for five minutes", "dinner tonight", "pon la cita a las 8 de la mañana", "por la mañana", "en la manana", "a la mañana", "Monitor the oven", "the wedding", "a fried egg", "", null, undefined, 42, "Mondaybeat"]) assert.equal(mentionsRelativeDay(t), false, String(t));
});

test("RELATIVE_DAY_MAX_CHARS is the kiosk's INTENT_MAX_CHARS (400): only the first 400 characters are read", async () => {
  const { INTENT_MAX_CHARS } = await import("../bundles/kiosk/server/intent-text.js");
  assert.equal(RELATIVE_DAY_MAX_CHARS, 400);
  assert.equal(RELATIVE_DAY_MAX_CHARS, INTENT_MAX_CHARS);
  assert.equal(mentionsRelativeDay("x".repeat(400) + " monday"), false);
  assert.equal(mentionsRelativeDay("x".repeat(390) + " monday"), true);
});

test("nowContext: the [Now] line (the kiosk's kioskNowContext, byte for byte)", () => {
  assert.equal(nowContext(THU, "America/Chicago"), "[Now] Thursday, October 15, 2026, 4:57 PM (time zone America/Chicago)");
  assert.equal(validTimeZone("America/Chicago"), "America/Chicago");
  assert.equal(validTimeZone("Mars/Olympus"), null);
});

test("appendDates: no relative day named → the prompt unchanged and line null", () => {
  assert.deepEqual(appendDates("User said: how are you", "how are you", { now: THU, tz: "America/Chicago" }), { text: "User said: how are you", line: null });
});

test("appendDates: a relative day named → prompt + blank line + the [Dates] line, and the line itself", () => {
  const line = relativeDatesContext(THU, "America/Chicago");
  assert.deepEqual(appendDates("User said: move my dentist to Monday", "move my dentist to Monday", { now: THU, tz: "America/Chicago" }),
    { text: `User said: move my dentist to Monday\n\n${line}`, line });
});

test("appendDates: only the USER's words trigger it (a prompt naming Friday with a plain user line stays unchanged)", () => {
  const prompt = "Card: ship the Friday release\nUser said: looks good";
  assert.deepEqual(appendDates(prompt, "looks good", { now: THU, tz: "America/Chicago" }), { text: prompt, line: null });
});

test("appendDates: non-string user text or prompt → unchanged, never throws", () => {
  for (const u of [null, undefined, 42, {}]) assert.deepEqual(appendDates("p", u, { now: THU }), { text: "p", line: null });
  assert.deepEqual(appendDates(null, "monday", { now: THU }), { text: null, line: null });
});

test("the kiosk's clock.js re-exports the core functions (same objects, so kiosk, glasses and core never drift)", async () => {
  const kiosk = await import("../bundles/kiosk/server/clock.js");
  assert.equal(kiosk.relativeDatesContext, core.relativeDatesContext);
  assert.equal(kiosk.mentionsRelativeDay, core.mentionsRelativeDay);
  assert.equal(kiosk.kioskNowContext, core.nowContext);
  assert.equal(kiosk.validTimeZone, core.validTimeZone);
});

test("stripTrailingDates: removes the blank line + [Dates] line appendDates added; anything else is unchanged", async () => {
  const { stripTrailingDates } = core;
  const line = relativeDatesContext(THU, "America/Chicago");
  const { text } = appendDates("move it to Monday", "move it to Monday", { now: THU, tz: "America/Chicago" });
  assert.equal(stripTrailingDates(text), "move it to Monday");
  assert.equal(stripTrailingDates(`a\n\n${line}\n\nmore`), `a\n\n${line}\n\nmore`, "only a TRAILING line");
  assert.equal(stripTrailingDates("I typed [Dates] myself"), "I typed [Dates] myself");
  for (const v of [null, undefined, 42, ""]) assert.equal(stripTrailingDates(v), v);
});
