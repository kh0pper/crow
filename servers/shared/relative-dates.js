/**
 * The day lines a model turn carries on its USER message (never the system message — it changes every minute and
 * would break the prefix cache): [Now] (local weekday, date, time, zone) and [Dates] (the next week's dates by
 * weekday, for a turn that names a relative day), plus the trigger that decides when [Dates] is added.
 *
 * ONE implementation. The kiosk's bundles/kiosk/server/clock.js re-exports these through the app root (so kiosk,
 * glasses and every core caller — the companion router, dashboard chat, pi turns — run the same function objects).
 * The export names are therefore an API for installed kiosk copies (0.3.19+): rename nothing without a kiosk bump.
 * Pure: Intl only, no I/O.
 */

/** Only the first 400 characters of a user turn are read (the kiosk's INTENT_MAX_CHARS): no input can make the pattern slow. */
export const RELATIVE_DAY_MAX_CHARS = 400;

const SPACES = /[\u00a0\u202f]/g;   // ICU puts a narrow no-break space before AM/PM

/** An IANA zone this runtime knows, or null. Length and shape are checked before Intl sees it. */
export function validTimeZone(tz) {
  if (typeof tz !== "string" || tz.length < 1 || tz.length > 64 || !/^[A-Za-z0-9_+/-]+$/.test(tz)) return null;
  const parts = tz.split("/");
  if (parts.length > 3 || parts.some((x) => !x) || !/^[A-Za-z]/.test(tz)) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}
export const zoneOf = (tz) => validTimeZone(tz) || Intl.DateTimeFormat().resolvedOptions().timeZone;
export const fmt = (locale, opts, at, tz) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: zoneOf(tz) }).format(new Date(at)).replace(SPACES, " ");
export const DATE = { weekday: "long", month: "long", day: "numeric", year: "numeric" };
export const TIME = { hour: "numeric", minute: "2-digit" };

/** "[Now] Thursday, October 15, 2026, 4:57 PM (time zone America/Chicago)" — the zone given if valid, else the server's. */
export function nowContext(now, tz) {
  return `[Now] ${fmt("en-US", DATE, now, tz)}, ${fmt("en-US", TIME, now, tz)} (time zone ${zoneOf(tz)})`;
}

/** Calendar days in the display's zone. All arithmetic is on whole days in UTC, so no DST hour can shift a date. */
export function localYmd(now, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zoneOf(tz), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return { y: g("year"), m: g("month"), d: g("day") };
}
export const dayNum = ({ y, m, d }) => Math.round(Date.UTC(y, m - 1, d) / 86400000);
export const fromDayNum = (n) => { const t = new Date(n * 86400000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
export const fmtYmd = (locale, ymd, opts) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12))).replace(SPACES, " ");
export const WEEKDAY = { weekday: "long" };

/**
 * Queue item 17a (2026-10-15): "add a car appointment 8:15 a.m. Monday" said on Thursday 15 October was read as
 * the PAST Monday. The quick voice model slips when it counts weekdays from the [Now] line, so a turn that names
 * a relative day gets the dates computed here: the next six days by weekday, plus next week's today (a bare weekday means its next
 * date; today's weekday is offered as today or next week, since either is meant), the rule for the past (the
 * mistranscribed "I had … Monday" is why tense is not a signal), and the zone's UTC offset for a calendar tool, each
 * day's taken at local noon (a DST change happens at night); a day whose offset differs carries its own. The rule
 * rides in the line, so the system message stays byte-stable. "Next Monday" stays the model's call (US speech uses
 * it both ways).
 */
function offsetOf(ymd, tz) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zoneOf(tz), timeZoneName: "longOffset" })
    .formatToParts(new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12))).find((x) => x.type === "timeZoneName")?.value || "GMT";
  const m = /^GMT([+-]\d{2}:\d{2})$/.exec(name);
  return m ? m[1] : "+00:00";
}

/**
 * "[Zone] America/Chicago, UTC-05:00": the zone and its UTC offset at `now`, for a turn that offers a tool taking a
 * date-time with an offset (Crow's own routine tools). null when the zone is not a valid one (never the server's
 * zone: a guessed offset would write the wrong hour).
 */
export function zoneContext(now, tz) {
  const zone = validTimeZone(tz);
  if (!zone) return null;
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(new Date(now)).find((x) => x.type === "timeZoneName")?.value || "GMT";
  const m = /^GMT([+-]\d{2}:\d{2})$/.exec(name);
  return `[Zone] ${zone}, UTC${m ? m[1] : "+00:00"}`;
}
const isoYmd = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function relativeDatesContext(now, tz) {
  const today = localYmd(now, tz);
  const off = offsetOf(today, tz);
  const at = (i) => { const day = fromDayNum(dayNum(today) + i); const o = offsetOf(day, tz); return `${isoYmd(day)}${o !== off ? ` (${o})` : ""}`; };
  const days = [];
  for (let i = 1; i <= 6; i += 1) days.push(`${fmtYmd("en-US", fromDayNum(dayNum(today) + i), WEEKDAY)} ${at(i)}${i === 1 ? " (tomorrow)" : ""}`);
  return `[Dates] To add or plan something, a day named without a date is the next one: ${days.join(", ")}; ${fmtYmd("en-US", today, WEEKDAY)} is today ${isoYmd(today)} or next week ${at(7)}. For something already past, it is the previous one. UTC offset ${off}.`;
}

const RELATIVE_DAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun|tomorrow|tmrw|weekend|next week|lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|fin de semana|proxima semana|semana que viene)(s)?\b/;
// "a/de/por/en la mañana" is "in the morning", not "tomorrow".
const MORNING = /\b(a|de|por|en) la manana\b/g;
/** True when the transcript names a weekday or a relative day (en, es; whole words, accents ignored). */
export function mentionsRelativeDay(transcript) {
  if (typeof transcript !== "string" || !transcript) return false;
  const t = transcript.slice(0, RELATIVE_DAY_MAX_CHARS).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "");
  return RELATIVE_DAY.test(t.replace(MORNING, " "));
}

/**
 * For a text prompt (a pi turn): the prompt plus a blank line and the [Dates] line when the USER's own words name a
 * relative day (never the prompt: a card brief or project header can name weekdays), else the prompt unchanged.
 * → { text, line } (line null when nothing was added) so the caller can echo-guard exactly that line.
 */
export function appendDates(prompt, userText, { now = Date.now(), tz = null } = {}) {
  if (typeof prompt !== "string" || !mentionsRelativeDay(userText)) return { text: prompt, line: null };
  const line = relativeDatesContext(now, tz);
  return { text: `${prompt}\n\n${line}`, line };
}

const TRAILING_DATES = /\n\n\[Dates\] To add or plan something, [^\n]*$/;
/** The text without a trailing blank line + [Dates] line (what appendDates added), for showing the user's own words back. */
export function stripTrailingDates(text) {
  return typeof text === "string" ? text.replace(TRAILING_DATES, "") : text;
}
