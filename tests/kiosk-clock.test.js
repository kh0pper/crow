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
  const no = ["what time is the game", "what's the date of the meeting", "what day is the party", "What time is it in Tokyo?", "What time does the store close today?", "What's the date tomorrow?", "What day is it tomorrow?", "What was the date yesterday?", "what's today's weather", "What's today's plan?", "today", "time", "date", "please", "what", "What is the time difference with London?", "What time is it going to rain?", "what day is it in Australia", "Tell me the time in Paris", "what's the date on the milk", "do you know what time the bus comes",
    "qué hora es en Tokio", "a qué hora es la cena", "qué día es la fiesta", "qué fecha es el examen", "qué día es mañana", "hoy", "hora"];
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
