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
