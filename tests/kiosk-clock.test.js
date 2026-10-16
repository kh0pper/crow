import { test } from "node:test";
import assert from "node:assert/strict";
import { validTimeZone, kioskNowContext, matchClockFastPath } from "../bundles/kiosk/server/clock.js";

// Sunday 4 October 2026, 20:42:10 UTC = 3:42 PM in Chicago (CDT), 22:42 in Madrid (CEST), Monday 05:42 in Tokyo.
const AT = Date.UTC(2026, 9, 4, 20, 42, 10);
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

test("validTimeZone: an IANA zone the runtime knows, else null (the caller falls back to the server's zone)", () => {
  assert.equal(validTimeZone("America/Chicago"), "America/Chicago");
  assert.equal(validTimeZone("Europe/Madrid"), "Europe/Madrid");
  assert.equal(validTimeZone("UTC"), "UTC");
  for (const bad of ["Mars/Olympus", "", null, undefined, 42, {}, "America/Chicago; DROP", "x".repeat(200), "../../etc/passwd", "<script>"]) assert.equal(validTimeZone(bad), null, String(bad));
});

test("kioskNowContext: the display's local weekday, date, time and zone for THIS turn's user message", () => {
  assert.equal(kioskNowContext(AT, "America/Chicago"), "[Now] Sunday, October 4, 2026, 3:42 PM (time zone America/Chicago)");
  assert.equal(kioskNowContext(AT, "Asia/Tokyo"), "[Now] Monday, October 5, 2026, 5:42 AM (time zone Asia/Tokyo)");
  assert.match(kioskNowContext(AT, null), new RegExp(`\\(time zone ${SERVER_TZ.replace("/", "\\/")}\\)$`), "no zone from the display → the server's zone");
  assert.match(kioskNowContext(AT, "Mars/Olympus"), /^\[Now\] \w+day, \w+ \d+, 2026, \d+:\d\d [AP]M \(time zone /, "a bad zone never throws");
});

test("clock fast path: the plain 'what time is it' family is answered with no model call, in the language asked (en + es)", () => {
  const at = (q, tz = "America/Chicago") => matchClockFastPath(q, { now: AT, tz });
  for (const q of ["What time is it?", "what time is it", "What's the time?", "Whats the time", "What is the time right now?", "Hey Crow, what time is it?", "Tell me the time", "Do you know what time it is?", "What time is it now", "what time is it please"]) {
    assert.deepEqual(at(q), { say: "It's 3:42 PM.", events: [] }, q);
  }
  for (const q of ["¿Qué hora es?", "que hora es", "Dime la hora", "¿Me dices la hora?", "¿Qué hora es ahora?", "qué horas son"]) {
    assert.deepEqual(at(q, "Europe/Madrid"), { say: "Son las 22:42.", events: [] }, q);
  }
  assert.equal(at("qué hora es", "America/Anchorage").say, "Son las 12:42.");
  assert.equal(matchClockFastPath("qué hora es", { now: Date.UTC(2026, 9, 4, 23, 5), tz: "Europe/Madrid" }).say, "Es la 1:05.", "one o'clock is singular in Spanish");
  assert.equal(at("What time is it?", "Asia/Tokyo").say, "It's 5:42 AM.");
  assert.match(at("What time is it?", null).say, /^It's \d+:42 [AP]M\.$/, "no display zone → the server's");
});

test("clock fast path: the plain 'what's the date' family (en + es)", () => {
  const at = (q, tz = "America/Chicago") => matchClockFastPath(q, { now: AT, tz });
  for (const q of ["What's today's date?", "What's the date?", "What is the date today?", "What is today's date", "What day is it?", "What day is it today?", "Tell me the date", "what's the date today please"]) {
    assert.deepEqual(at(q), { say: "Today is Sunday, October 4, 2026.", events: [] }, q);
  }
  for (const q of ["¿Qué día es hoy?", "que dia es hoy", "¿Qué fecha es hoy?", "¿Cuál es la fecha de hoy?", "¿A qué estamos hoy?", "Dime la fecha"]) {
    assert.deepEqual(at(q, "Europe/Madrid"), { say: "Hoy es domingo, 4 de octubre de 2026.", events: [] }, q);
  }
  assert.equal(at("What day is it?", "Asia/Tokyo").say, "Today is Monday, October 5, 2026.", "the display's zone decides the day");
});

test("clock fast path: anything that is not the plain question goes to the model (which has the [Now] context)", () => {
  for (const q of ["What time is it in Tokyo?", "What time does the pharmacy close?", "What time is the game?", "Is it time for lunch?", "What's the date of the next eclipse?", "What day is the meeting?", "Tell me a joke", "set a timer for one minute", "time", "¿A qué hora abre la farmacia?", "¿Qué hora es en Tokio?", ""]) {
    assert.equal(matchClockFastPath(q, { now: AT, tz: "America/Chicago" }), null, q);
  }
});

// ── Live re-test 2026-10-04: "What's today's date?" (or a close variant) missed the shortcut ──────
test("phrase table: every listed way of asking the time or the date is a shortcut, with fillers and politeness around it (en + es)", () => {
  const at = (q) => matchClockFastPath(q, { now: AT, tz: "America/Chicago" });
  const TIME_EN = ["what time is it", "what's the time", "what is the time", "do you know what time it is", "can you tell me the time", "tell me the time", "time please",
    "What time is it right now?", "Hey, what time is it?", "So what time is it?", "Um, what's the time?", "Okay Crow, what's the time?", "Could you tell me what time it is?", "What's the current time?", "What time is it, please?", "what time is it crow", "And what time is it now?", "Do you have the time?", "What time do you have?", "Can you tell me what time it is, please?", "Well, what is the time?"];
  for (const q of TIME_EN) assert.equal(at(q)?.say, "It's 3:42 PM.", q);
  const DATE_EN = ["what's today's date", "what is today's date", "what's the date", "what is the date today", "what day is it", "what day is it today", "what's today", "today's date",
    "What’s today’s date?", "Whats todays date", "Hey, what's today's date?", "So what is today's date?", "What is the date?", "What's the date today, please?", "What date is it?", "What date is it today?", "What day is today?", "What is today?", "What's the day today?", "Can you tell me today's date?", "Do you know what day it is?", "Tell me what day it is", "Okay, what is today's date?", "What's today's date, Crow?", "What is the date for today?", "What day of the week is it?", "And what's the date?"];
  for (const q of DATE_EN) assert.equal(at(q)?.say, "Today is Sunday, October 4, 2026.", q);
  const es = (q) => matchClockFastPath(q, { now: AT, tz: "Europe/Madrid" });
  for (const q of ["qué hora es", "me dices la hora", "¿Qué hora es ahora?", "Oye, ¿qué hora es?", "¿Me puedes decir qué hora es?", "¿Tienes hora?", "que hora es por favor", "¿Sabes qué hora es?", "Dime qué hora es", "La hora, por favor"]) assert.equal(es(q)?.say, "Son las 22:42.", q);
  for (const q of ["qué día es hoy", "qué fecha es hoy", "a qué estamos hoy", "¿Qué día es?", "¿A qué día estamos?", "¿Cuál es la fecha de hoy?", "Oye, ¿qué día es hoy?", "¿Me dices qué día es hoy?", "¿Qué fecha es?", "¿Sabes qué día es hoy?", "la fecha de hoy, por favor"]) assert.equal(es(q)?.say, "Hoy es domingo, 4 de octubre de 2026.", q);
});

test("phrase table: questions that only CONTAIN those words go to the model", () => {
  const no = ["what time is the game", "what's the date of the meeting", "what day is the party", "What time is it in Tokyo?", "What time does the store close today?", "What's tomorrow?", "what's today's weather", "What's today's plan?", "today", "time", "date", "please", "what", "What is the time difference with London?", "What time is it going to rain?", "what day is it in Australia", "Tell me the time in Paris", "what's the date on the milk", "do you know what time the bus comes",
    "qué hora es en Tokio", "a qué hora es la cena", "qué día es la fiesta", "qué fecha es el examen", "hoy", "hora"];
  for (const q of no) assert.equal(matchClockFastPath(q, { now: AT, tz: "America/Chicago" }), null, q);
});

test("phrase table: CLOCK_PHRASES is the single source — each core phrase matches bare, and with a lead-in and a tail", async () => {
  const { CLOCK_PHRASES } = await import("../bundles/kiosk/server/clock.js");
  for (const [key, want] of [["time_en", /^It's /], ["date_en", /^Today is /], ["time_es", /^(Son las|Es la) /], ["date_es", /^Hoy es /]]) {
    const t = CLOCK_PHRASES[key];
    assert.ok(t.cores.length >= 5, key);
    for (const core of t.cores) {
      assert.match(matchClockFastPath(core, { now: AT, tz: "UTC" })?.say || "", want, `${key}: ${core}`);
      assert.match(matchClockFastPath(`${t.leads[0]} ${core} ${t.tails[0]}`, { now: AT, tz: "UTC" })?.say || "", want, `${key}: ${t.leads[0]} ${core} ${t.tails[0]}`);
    }
  }
});

// ── WM1a: tomorrow, yesterday, named dates ────────────────────────────────────────────────────
const AT_SUN = Date.UTC(2026, 9, 4, 20, 42, 10);   // Sunday 4 October 2026, 3:42 PM in America/Chicago
const chi = (q) => matchClockFastPath(q, { now: AT_SUN, tz: "America/Chicago" })?.say ?? null;
const mad = (q) => matchClockFastPath(q, { now: AT_SUN, tz: "Europe/Madrid" })?.say ?? null;

test("tomorrow and yesterday: answered with no model, in the language asked", () => {
  for (const q of ["What day is tomorrow?", "What's tomorrow's date?", "What is the date tomorrow?", "What day is it tomorrow?", "Hey Crow, what's the date tomorrow, please?", "tomorrow's date"]) assert.equal(chi(q), "Tomorrow is Monday, October 5, 2026.", q);
  for (const q of ["What was yesterday's date?", "What day was yesterday?", "What was the date yesterday?", "yesterday's date"]) assert.equal(chi(q), "Yesterday was Saturday, October 3, 2026.", q);
  for (const q of ["¿Qué día es mañana?", "qué fecha es mañana", "¿Qué día será mañana?"]) assert.equal(mad(q), "Mañana es lunes, 5 de octubre de 2026.", q);
  for (const q of ["¿Qué día fue ayer?", "qué fecha fue ayer"]) assert.equal(mad(q), "Ayer fue sábado, 3 de octubre de 2026.", q);
});

test("tomorrow and yesterday are the display's local days (a zone where it is already tomorrow)", () => {
  const tokyo = (q) => matchClockFastPath(q, { now: AT_SUN, tz: "Asia/Tokyo" }).say;   // 05:42 on Monday 5 October there
  assert.equal(tokyo("What day is tomorrow?"), "Tomorrow is Tuesday, October 6, 2026.");
  assert.equal(tokyo("What day was yesterday?"), "Yesterday was Sunday, October 4, 2026.");
});

test("the weekday of a named date: the next time it comes round, in the forms speech-to-text writes", () => {
  for (const q of ["What day is December 25th?", "What day of the week is December 25?", "What day is the 25th of December?", "What day does December 25th fall on?", "What day is Christmas?", "What day is December 25th, 2026?"]) assert.equal(chi(q), "December 25, 2026 is a Friday.", q);
  assert.equal(chi("What day is October 4th?"), "That's today, Sunday.");
  assert.equal(chi("What day is October 3rd?"), "October 3, 2027 is a Sunday.", "already past this year: next year's");
  assert.equal(chi("What day was October 3rd?"), "October 3, 2026 was a Saturday.");
  assert.equal(chi("What day is February 29th?"), "February 29, 2028 is a Tuesday.", "the next real one");
  assert.equal(mad("¿Qué día es el 25 de diciembre?"), "El 25 de diciembre de 2026 es viernes.");
  assert.equal(mad("¿Qué día cae Navidad?"), "El 25 de diciembre de 2026 es viernes.");
  assert.equal(mad("¿Qué día fue el 3 de octubre?"), "El 3 de octubre de 2026 fue sábado.");
});

test("days until a named date", () => {
  for (const q of ["How many days until December 25th?", "How many days till Christmas?", "How many days is it until Christmas?", "Hey, how many days until December 25, please?"]) assert.equal(chi(q), "82 days until December 25.", q);
  assert.equal(chi("How many days until Halloween?"), "27 days until October 31.");
  assert.equal(chi("How many days until October 5th?"), "It's tomorrow.");
  assert.equal(chi("How many days until October 4th?"), "That's today.");
  assert.equal(mad("¿Cuántos días faltan para Navidad?"), "Faltan 82 días para el 25 de diciembre.");
  assert.equal(mad("¿Cuántos días quedan para el 31 de octubre?"), "Faltan 27 días para el 31 de octubre.");
});

test("anything that is not a plain date question still goes to the model", () => {
  for (const q of ["What day is the meeting?", "What day is the party?", "How many days until the trip?", "How many days until my birthday?", "What day is February 30th?", "What day is the 45th of March?", "How many days until Easter?", "What day is December?", "How many days in December?",
    "qué día es la fiesta", "cuántos días faltan para el examen", "What day is December 25th in Japan?", "What happened on December 25th?"]) assert.equal(chi(q), null, q);
});

test("ordinals as speech-to-text writes them: digits, one word, or two words", () => {
  for (const q of ["What day is December twenty fifth?", "What day is December twenty-fifth?", "What day is the twenty fifth of December?", "What day is December 25?"]) assert.equal(chi(q), "December 25, 2026 is a Friday.", q);
  assert.equal(chi("What day is October thirty first?"), "October 31, 2026 is a Saturday.");
  assert.equal(chi("How many days until December thirty second?"), null);
  assert.equal(chi("What day is December twenty?"), null, "a bare tens word is not a day");
});

test("'what's tomorrow?' is not a date question here: an assistant with a calendar answers it", () => {
  assert.equal(chi("What's tomorrow?"), null);
  assert.equal(chi("What is tomorrow?"), null);
});

// ── Queue item 17a (2026-10-15): "add a car appointment 8:15 a.m. Monday" on Thursday Oct 15 was read as the PAST
// Monday. A voice turn that names a relative day gets a computed [Dates] line: the next seven dates, today, the offset.
import { relativeDatesContext, mentionsRelativeDay } from "../bundles/kiosk/server/clock.js";

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
    "Schedule lunch on Friday's afternoon", "this weekend", "the day after tomorrow", "TUESDAY", "manana a las 9", "el miércoles a las 8 de la mañana", "cita el lunes a las ocho", "mañana a las 9", "el sábado", "pasado mañana",
    "la próxima semana", "la semana que viene", "este fin de semana", "el miercoles", "What do I have on Sunday?"]) assert.equal(mentionsRelativeDay(t), true, t);
  for (const t of ["what time is it", "play kpft", "Sundance festival", "set a timer for five minutes", "dinner tonight", "pon la cita a las 8 de la mañana", "por la mañana", "en la manana", "", null, undefined, 42, "Mondaybeat"]) assert.equal(mentionsRelativeDay(t), false, String(t));
});
