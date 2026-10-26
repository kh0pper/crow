/**
 * schedule-words: plain words (en, es) → a cron expression or a one-shot time, with a summary
 * rendered back from the cron and a preview of the next 3 runs. Pure: every case passes `now`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhen, describeCron, WHEN_MAX_CHARS } from "../servers/shared/schedule-words.js";
import { ONCE } from "../servers/shared/schedule-core.js";

const TZ = "America/Chicago";
const T = (s) => Date.parse(s);
// Monday 2026-10-26 10:00 CDT (15:00Z).
const MON_10AM = T("2026-10-26T15:00:00Z");
const P = (text, o = {}) => parseWhen(text, { lang: "en", tz: TZ, now: MON_10AM, ...o });
const cronOf = (text, o) => { const r = P(text, o); assert.ok(r.ok, `${text}: ${r.hint}`); return r.cron; };
const atOf = (text, o) => { const r = P(text, o); assert.ok(r.ok, `${text}: ${r.hint}`); assert.equal(r.cron, ONCE); return r.at; };
const fails = (text, code, o) => { const r = P(text, o); assert.equal(r.ok, false, `${text} should be refused`); assert.equal(r.code, code, `${text}: ${r.code} ${r.hint}`); assert.ok(r.hint && r.hint.length > 10, "a helpful hint"); return r; };

test("every day / daily, en and es", () => {
  assert.equal(cronOf("every day at 8"), "0 8 * * *");
  assert.equal(cronOf("Daily at 8:30"), "30 8 * * *");
  assert.equal(cronOf("every day at 7:30pm"), "30 19 * * *");
  assert.equal(cronOf("every day at 7:30 p.m."), "30 19 * * *");
  assert.equal(cronOf("everyday at 6 am"), "0 6 * * *");
  assert.equal(cronOf("cada día a las 8"), "0 8 * * *");
  assert.equal(cronOf("todos los días a las 8:30"), "30 8 * * *");
  assert.equal(cronOf("cada dia a las 7 de la tarde"), "0 19 * * *");
  assert.equal(cronOf("todos los días a las 9 de la noche"), "0 21 * * *");
  assert.equal(cronOf("todos los días a las 8 de la mañana"), "0 8 * * *");
});

test("weekdays and weekends, en and es", () => {
  assert.equal(cronOf("every weekday at 8"), "0 8 * * 1-5");
  assert.equal(cronOf("weekdays at 8"), "0 8 * * 1-5");
  assert.equal(cronOf("cada día laborable a las 8"), "0 8 * * 1-5");
  assert.equal(cronOf("de lunes a viernes a las 8"), "0 8 * * 1-5");
  assert.equal(cronOf("entre semana a las 8"), "0 8 * * 1-5");
  assert.equal(cronOf("every weekend at 10"), "0 10 * * 0,6");
  assert.equal(cronOf("los fines de semana a las 10"), "0 10 * * 0,6");
});

test("named weekdays, en and es", () => {
  assert.equal(cronOf("mondays and thursdays at 18:00"), "0 18 * * 1,4");
  assert.equal(cronOf("every monday, wednesday and friday at 7pm"), "0 19 * * 1,3,5");
  assert.equal(cronOf("every Tues at 9"), "0 9 * * 2");
  assert.equal(cronOf("todos los lunes a las 18:00"), "0 18 * * 1");
  assert.equal(cronOf("cada lunes, miércoles y viernes a las 7 de la tarde"), "0 19 * * 1,3,5");
  assert.equal(cronOf("los sábados y domingos a las 10"), "0 10 * * 0,6");
});

test("every N minutes / hours (only even gaps)", () => {
  const bot = { type: "bot_routine" };
  assert.equal(cronOf("every 2 hours"), "0 */2 * * *");
  assert.equal(cronOf("every hour"), "0 * * * *");
  assert.equal(cronOf("hourly"), "0 * * * *");
  assert.equal(cronOf("every two hours"), "0 */2 * * *");
  assert.equal(cronOf("cada hora"), "0 * * * *");
  assert.equal(cronOf("cada 3 horas"), "0 */3 * * *");
  assert.equal(cronOf("every 15 minutes", bot), "*/15 * * * *");
  assert.equal(cronOf("cada 30 minutos", bot), "*/30 * * * *");
  assert.equal(cronOf("every minute", bot), "* * * * *");
  assert.equal(cronOf("every 60 minutes"), "0 * * * *");
  const r7 = fails("every 7 minutes", "uneven", bot);
  assert.match(r7.hint, /\b6 or 10\b/, "names the nearest even choices");
  const r5 = fails("every 5 hours", "uneven");
  assert.match(r5.hint, /\b4\b.*\b6\b/);
  assert.match(fails("cada 7 minutos", "uneven", { ...bot, lang: "es" }).hint, /minutos/);
  fails("every 24 hours", "uneven");
});

test("reminders repeat at most hourly (the #560 rule); other types may go faster", () => {
  const r = fails("every 15 minutes", "too_frequent");
  assert.match(r.hint, /hour/);
  fails("every minute", "too_frequent");
  fails("cada 30 minutos", "too_frequent", { lang: "es" });
  fails("*/10 * * * *", "too_frequent");
  assert.equal(fails("every 7 minutes", "too_frequent").code, "too_frequent", "for a reminder the rate rule speaks first");
  assert.equal(cronOf("every hour"), "0 * * * *", "hourly is allowed");
  assert.equal(cronOf("0,30 9 * * *"), "0,30 9 * * *", "twice a day, 30 min apart, averages 720 min");
});

test("monthly, en and es", () => {
  assert.equal(cronOf("on the 1st of every month at 9"), "0 9 1 * *");
  assert.equal(cronOf("every month on the 15th at 8:30am"), "30 8 15 * *");
  assert.equal(cronOf("monthly on the 2nd at noon"), "0 12 2 * *");
  assert.equal(cronOf("el día 1 de cada mes a las 9"), "0 9 1 * *");
  assert.equal(cronOf("el primero de cada mes a las 9"), "0 9 1 * *");
  assert.equal(cronOf("cada mes el día 15 a las 10"), "0 10 15 * *");
  fails("on the 31st of every month at 9", "day_of_month");
  fails("on the 1st of every month", "no_time");
});

test("noon, midnight, a la una, de la madrugada, 12 de la noche", () => {
  assert.equal(cronOf("every day at noon"), "0 12 * * *");
  assert.equal(cronOf("every day at midnight"), "0 0 * * *");
  assert.equal(cronOf("every day at 12am"), "0 0 * * *");
  assert.equal(cronOf("every day at 12pm"), "0 12 * * *");
  assert.equal(cronOf("cada día al mediodía"), "0 12 * * *");
  assert.equal(cronOf("cada día a medianoche"), "0 0 * * *");
  assert.equal(cronOf("cada día a la una"), "0 1 * * *");
  assert.equal(cronOf("cada día a la 1"), "0 1 * * *");
  assert.equal(cronOf("cada día a la una de la tarde"), "0 13 * * *");
  assert.equal(cronOf("cada día a las 3 de la madrugada"), "0 3 * * *");
  assert.equal(cronOf("cada día a las 12 de la noche"), "0 0 * * *");
  assert.equal(cronOf("cada día a las 12 de la tarde"), "0 12 * * *");
  fails("every day at 13pm", "bad_time");
  fails("every day at 25:00", "bad_time");
  fails("cada día a las 9 de la madrugada", "bad_time");
});

test("a bare 8 means 08:00, and the preview says so", () => {
  const r = P("every day at 8");
  assert.equal(r.cron, "0 8 * * *");
  assert.equal(r.summary, "Every day at 8:00 AM");
  assert.match(r.next3[0].text, /8:00\s?AM/);
});

test("one-shots: tomorrow, today, a bare time, in N minutes, a date", () => {
  assert.equal(atOf("tomorrow at 3pm"), "2026-10-27T15:00:00-05:00");
  assert.equal(atOf("mañana a las 15:00"), "2026-10-27T15:00:00-05:00");
  assert.equal(atOf("mañana a las 8 de la mañana"), "2026-10-27T08:00:00-05:00", "the morning is not tomorrow twice");
  assert.equal(atOf("today at 5pm"), "2026-10-26T17:00:00-05:00");
  assert.equal(atOf("hoy a las 17:00"), "2026-10-26T17:00:00-05:00");
  assert.equal(atOf("at 17:00"), "2026-10-26T17:00:00-05:00");
  assert.equal(atOf("a las 17:00"), "2026-10-26T17:00:00-05:00");
  assert.equal(atOf("in 20 minutes"), "2026-10-26T10:20:00-05:00");
  assert.equal(atOf("en 20 minutos"), "2026-10-26T10:20:00-05:00");
  assert.equal(atOf("dentro de una hora"), "2026-10-26T11:00:00-05:00");
  assert.equal(atOf("in an hour"), "2026-10-26T11:00:00-05:00");
  assert.equal(atOf("in 2 hours"), "2026-10-26T12:00:00-05:00");
  assert.equal(atOf("on 2026-11-03 at 10"), "2026-11-03T10:00:00-06:00", "after the change: CST");
  assert.equal(atOf("el 2026-11-03 a las 10"), "2026-11-03T10:00:00-06:00");
  const r = P("tomorrow at 3pm");
  assert.equal(r.next3.length, 1);
  assert.equal(r.next3[0].iso, r.at);
  assert.equal(Date.parse(r.at), T("2026-10-27T20:00:00Z"));
  fails("tomorrow", "no_time");
  fails("in 20 minutes at 5pm", "unknown");
});

test("a bare past time rolls to tomorrow; an explicit past day is an error", () => {
  assert.equal(atOf("at 9"), "2026-10-27T09:00:00-05:00", "9:00 has passed at 10:00 → tomorrow");
  assert.equal(atOf("a las 9"), "2026-10-27T09:00:00-05:00");
  fails("today at 9", "past");
  fails("hoy a las 9", "past", { lang: "es" });
  fails("on 2026-10-01 at 9", "past");
  fails("el 2026-10-01 a las 9", "past");
});

test("weekday one-shots: never the past one; the same weekday later today, or next week", () => {
  // Monday 10:00: "on friday" is this Friday.
  assert.equal(atOf("on friday at 5pm"), "2026-10-30T17:00:00-05:00");
  assert.equal(atOf("el viernes a las 5 de la tarde"), "2026-10-30T17:00:00-05:00");
  assert.equal(atOf("monday at 11"), "2026-10-26T11:00:00-05:00", "later today");
  assert.equal(atOf("on monday at 9"), "2026-11-02T09:00:00-06:00", "already past today → next week");
  // Friday 2026-10-30 18:00 CDT: "on friday at 5pm" means next week.
  const fri6pm = T("2026-10-30T23:00:00Z");
  assert.equal(atOf("on friday at 5pm", { now: fri6pm }), "2026-11-06T17:00:00-06:00");
  assert.equal(atOf("on friday at 7pm", { now: fri6pm }), "2026-10-30T19:00:00-05:00");
  fails("next friday at 5pm", "ambiguous");
  fails("monday and thursday at 9", "ambiguous");
});

test("a raw 5-field cron passes after validation and is worded Custom schedule", () => {
  const r = P("15 9 * * 1-3");
  assert.ok(r.ok);
  assert.equal(r.cron, "15 9 * * 1-3");
  assert.equal(r.summary, "Custom schedule");
  assert.equal(r.next3.length, 3);
  assert.equal(P("15 9 * * 1-3", { lang: "es" }).summary, "Horario personalizado");
  fails("99 9 * * *", "unknown");
});

test("garbage and empty input are refused with a hint, in the asked language", () => {
  const r = fails("whenever the moon is full", "unknown");
  assert.match(r.hint, /every weekday at 8/);
  const es = parseWhen("cuando quieras", { lang: "es", tz: TZ, now: MON_10AM });
  assert.equal(es.ok, false);
  assert.match(es.hint, /cada día laborable a las 8/);
  fails("", "empty");
  fails("   ", "empty");
  fails("every day at 8 and at 9", "two_times");
  fails("every day", "no_time");
  fails("every weekday", "no_time");
});

test("a 10k-char input is refused quickly (the length cap)", () => {
  const long = "every day at 8 ".repeat(700);
  const t0 = process.hrtime.bigint();
  const r = P(long);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.ok, false);
  assert.equal(r.code, "too_long");
  assert.ok(ms < 5, `took ${ms} ms`);
  assert.ok(WHEN_MAX_CHARS <= 200);
  // A worst case just under the cap is still fast.
  const near = ("1:1 " + "a ".repeat(90)).slice(0, WHEN_MAX_CHARS);
  const t1 = process.hrtime.bigint();
  P(near);
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 5);
});

test("the summary is rendered from the cron and round-trips for every emitted shape", () => {
  const cases = [
    ["every day at 8", "Every day at 8:00 AM", "Cada día a las 8:00"],
    ["every weekday at 8", "Every weekday at 8:00 AM", "De lunes a viernes a las 8:00"],
    ["every weekend at 10", "Every weekend at 10:00 AM", "Los fines de semana a las 10:00"],
    ["mondays and thursdays at 18:00", "Every Monday and Thursday at 6:00 PM", "Cada lunes y jueves a las 18:00"],
    ["every monday, wednesday and friday at 7pm", "Every Monday, Wednesday and Friday at 7:00 PM", "Cada lunes, miércoles y viernes a las 19:00"],
    ["every day at 1pm", "Every day at 1:00 PM", "Cada día a las 13:00"],
    ["cada día a la una", "Every day at 1:00 AM", "Cada día a la 1:00"],
    ["on the 1st of every month at 9", "On the 1st of every month at 9:00 AM", "El día 1 de cada mes a las 9:00"],
    ["every month on the 22nd at 9", "On the 22nd of every month at 9:00 AM", "El día 22 de cada mes a las 9:00"],
    ["every 2 hours", "Every 2 hours", "Cada 2 horas"],
    ["every hour", "Every hour", "Cada hora"],
  ];
  for (const [words, en, es] of cases) {
    const r = P(words);
    assert.ok(r.ok, words);
    assert.equal(r.summary, en, words);
    assert.equal(describeCron(r.cron, "en"), en);
    assert.equal(describeCron(r.cron, "es"), es);
    // Round trip: the summary, read back, is the same schedule.
    assert.equal(P(en).cron, r.cron, `en round trip: ${en}`);
    assert.equal(parseWhen(es, { lang: "es", tz: TZ, now: MON_10AM }).cron, r.cron, `es round trip: ${es}`);
  }
  const bot = { type: "bot_routine" };
  assert.equal(P("every 15 minutes", bot).summary, "Every 15 minutes");
  assert.equal(describeCron("*/15 * * * *", "es"), "Cada 15 minutos");
  assert.equal(describeCron("* * * * *", "en"), "Every minute");
  assert.equal(describeCron("0 8 * * 7", "en"), null, "not an emitted shape");
  assert.equal(describeCron("0 8 1 * 1", "en"), null);
  assert.match(P("tomorrow at 3pm").summary, /^Once: Tuesday, October 27, 2026(,| at) 3:00\s?PM$/);
  assert.match(parseWhen("mañana a las 15:00", { lang: "es", tz: TZ, now: MON_10AM }).summary, /^Una vez: martes, 27 de octubre de 2026.*15:00$/);
});

test("the preview lists the next 3 runs in the schedule's zone, across the fall-back change", () => {
  // Friday 2026-10-30 12:00 CDT; clocks go back Sunday 2026-11-01 02:00.
  const now = T("2026-10-30T17:00:00Z");
  const r = P("every day at 7:30pm", { now });
  assert.deepEqual(r.next3.map((x) => x.iso), ["2026-10-30T19:30:00-05:00", "2026-10-31T19:30:00-05:00", "2026-11-01T19:30:00-06:00"]);
  assert.match(r.next3[0].text, /7:30\s?PM CDT/);
  assert.match(r.next3[2].text, /7:30\s?PM CST/);
  // The repeated 1:30 fires once (the first pass), as schedule-core decides.
  const once = P("every day at 1:30am", { now });
  assert.equal(Date.parse(once.next3[1].iso), T("2026-11-01T06:30:00Z"));
  assert.equal(once.next3[2].iso, "2026-11-02T01:30:00-06:00");
  // Another zone: the same words, Madrid time.
  const mad = parseWhen("every day at 7:30pm", { lang: "es", tz: "Europe/Madrid", now });
  assert.equal(mad.next3[0].iso, "2026-10-30T19:30:00+01:00");
  assert.match(mad.next3[0].text, /19:30/);
});

test("spring forward: the preview pins schedule-core's values; a one-shot in the gap is refused", () => {
  const sat = T("2026-03-07T20:00:00Z"); // Saturday 14:00 CST; clocks jump at 02:00 Sunday.
  const r = P("every day at 2:30", { now: sat });
  assert.equal(Date.parse(r.next3[0].iso), T("2026-03-08T08:30:00Z"), "03:30 CDT, the day of the change");
  assert.equal(r.next3[1].iso, "2026-03-09T02:30:00-05:00");
  const nine = P("every day at 9", { now: sat });
  assert.equal(nine.next3[0].iso, "2026-03-08T09:00:00-05:00", "the change day is not skipped");
  fails("tomorrow at 2:30", "no_such_time", { now: sat });
  assert.equal(atOf("tomorrow at 3:30", { now: sat }), "2026-03-08T03:30:00-05:00");
  // Fall back: an ambiguous 1:30 one-shot is the first pass, like a repeating one.
  assert.equal(atOf("on 2026-11-01 at 1:30"), "2026-11-01T01:30:00-05:00");
});

test("a time with a step, or a lone weekday list without 'every', is refused, not guessed", () => {
  fails("every 2 hours at 9", "unknown");
  fails("every 0 hours", "unknown");
  fails("in 0 minutes", "unknown");
});

test("defaults: an invalid zone falls back, the language defaults to en", () => {
  const r = parseWhen("every day at 8", { tz: "Not/AZone", now: MON_10AM });
  assert.ok(r.ok);
  assert.equal(r.summary, "Every day at 8:00 AM");
  assert.ok(typeof r.zone === "string" && r.zone.length > 0);
});
