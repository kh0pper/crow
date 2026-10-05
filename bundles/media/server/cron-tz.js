/**
 * Cron in a named time zone, with no dependency.
 *
 * An occurrence is a UTC minute whose wall-clock time in `tz` matches the expression. That makes
 * daylight-saving changes correct by construction: "0 8 * * *" is 08:00 local on both sides of a
 * change. A wall-clock minute that happens twice (clocks going back) fires once, the first time; a
 * wall-clock minute that never happens (clocks going forward) does not fire.
 *
 * Supported: five fields (minute hour day-of-month month day-of-week); numbers, "*", lists (a,b),
 * ranges (a-b), steps (star/n, a-b/n); three-letter month and weekday names; weekday 0-7 (0 and 7
 * are Sunday). Day-of-month and day-of-week combine the standard way: when both are restricted,
 * either may match. Anything else (six fields, "@daily", "L", "#") throws `bad_cron`, so a row this
 * module cannot evaluate is reported instead of silently never firing.
 */
import { localParts, validTimeZone } from "./zone.js";

export { localParts, validTimeZone };

const MINUTE = 60_000;
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function bad(why) { return Object.assign(new Error(`bad_cron: ${why}`), { code: "bad_cron" }); }

function num(token, idx) {
  const t = token.toLowerCase();
  if (idx === 3 && MONTHS.includes(t)) return MONTHS.indexOf(t) + 1;
  if (idx === 4 && DAYS.includes(t)) return DAYS.indexOf(t);
  if (!/^\d{1,2}$/.test(t)) throw bad(`"${token}"`);
  return Number(t);
}

function parseField(text, idx) {
  const [lo, hi] = RANGES[idx];
  const out = new Set();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || range === "") throw bad(`"${part}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > hi) throw bad(`step "${part}"`);
    let a = lo, b = hi;
    if (range !== "*") {
      const ends = range.split("-");
      if (ends.length > 2) throw bad(`"${part}"`);
      a = num(ends[0], idx);
      b = ends.length === 2 ? num(ends[1], idx) : (stepText === undefined ? a : hi);
    }
    if (a < lo || b > hi || a > b) throw bad(`range "${part}"`);
    for (let v = a; v <= b; v += step) out.add(idx === 4 && v === 7 ? 0 : v);
  }
  return out;
}

/** → { sets: [minute, hour, dom, month, dow], domAny, dowAny }; throws `bad_cron`. */
export function parseCron(expr) {
  const fields = String(expr ?? "").trim().slice(0, 100).split(/\s+/);
  if (fields.length !== 5) throw bad("five fields are required");
  return { sets: fields.map(parseField), domAny: fields[2] === "*", dowAny: fields[4] === "*" };
}

function dayMatches(cron, p) {
  const [, ho, dom, mo, dow] = cron.sets;
  if (!ho.has(p.hour) || !mo.has(p.month)) return false;
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dow.has(p.dow);
  if (cron.dowAny) return dom.has(p.day);
  return dom.has(p.day) || dow.has(p.dow);
}

/** Occurrences t (UTC ms, ascending) with fromMs < t <= toMs. `limit` stops early. */
export function occurrences(expr, tz, fromMs, toMs, limit = Infinity) {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  if (!validTimeZone(tz)) throw Object.assign(new Error(`bad_tz: "${tz}"`), { code: "bad_tz" });
  const out = [];
  const seen = new Set();
  const BLOCK = 15 * MINUTE;
  // Every zone's offset is a multiple of 15 minutes and changes only on such a boundary, so the
  // wall clock is read once per 15-minute block. The scan starts over an hour early, so the second
  // pass of a repeated wall-clock hour is known to be a repeat.
  for (let b = (Math.floor(fromMs / BLOCK) - 5) * BLOCK; b <= toMs && out.length < limit; b += BLOCK) {
    const p = localParts(b, tz);
    if (!dayMatches(cron, p)) continue;
    for (let k = 0; k < 15 && out.length < limit; k++) {
      if (!cron.sets[0].has(p.minute + k)) continue;
      const key = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute + k}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = b + k * MINUTE;
      if (t > fromMs && t <= toMs) out.push(t);
    }
  }
  return out;
}

/** The first occurrence after `afterMs`, or null when there is none within `horizonDays`. */
export function nextOccurrence(expr, tz, afterMs, horizonDays = 8) {
  return occurrences(expr, tz, afterMs, afterMs + horizonDays * 1440 * MINUTE, 1)[0] ?? null;
}
