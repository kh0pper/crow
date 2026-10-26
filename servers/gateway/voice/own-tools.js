/**
 * Crow's own tools (PR 2, Task 2.5): the voice bot adds a calendar event, a reminder or a task itself, to
 * whichever system is installed. One small tool per routine object, run in-process by the voice turn
 * (turn.js deps.ownTools), never through the model's remote tool list:
 *
 *   crow_calendar_add_event → Workspace (ws_cal_create_event) or Google (gcal_create_event)
 *   crow_reminder_add       → Crow's own schedules (one '@once' row the scheduler fires once)
 *   crow_task_add           → Workspace tasks (ws_task_create) or a board card (tagged crow-voice, gated)
 *
 * Rules:
 * - The spoken success line is the server's, built from what the backend returned, and only after the write
 *   returned ok (#499). A backend error is { ok:false, code:"backend_error" } with no say: the turn's action
 *   guard then speaks its not-done line.
 * - Validation failures are { ok:false, code:"bad_args", message } (the model reads the message; the turn
 *   steps up once). A date-time needs its UTC offset, and a known time zone (opts.tz from the surface):
 *   without one, nothing is guessed: { ok:false, code:"no_tz" }, which never steps up (a larger model cannot
 *   supply a zone).
 * - Strict confirm (the voice bot's voice.confirm "strict"), and the calendar-fallback reminder offer
 *   (ctx.fallback "calendar", rev 2.1), validate, hold the call as the device's pending "routine" entry and
 *   ask; nothing is written until a spoken yes reaches fastPath. Under "standard" the adds run at once.
 *
 * - Where a calendar event or a Workspace task goes (PR 2.1 Task 6, the operator's decision): the operator's chosen id;
 *   else a writable calendar or list Crow bot owns (`shared: false` from the Workspace listing; a missing field counts
 *   as shared); else, for the calendar under "auto" only, Google's primary when Google is connected; else, for tasks
 *   under "auto", a board card; else Crow asks once which one ("which_calendar" pending entry), and the spoken name is
 *   the answer and the yes. Crow never writes to a shared calendar or list nobody chose; the choice is never saved.
 *
 * The own tools are exempt from the turn's policy gate only because turn.js runs them from the loaded own-tool
 * set (ownByName); VOICE_OWN_TOOL_NAMES is for listing them (Bot Builder, the editor), never for skipping a gate.
 */
import { normalizeVoiceSettings, isVoiceBotDef } from "../../shared/voice-bot.js";
import { ROUTINE_OBJECTS, namesRoutineObjects } from "./routine-objects.js";
import { isObjectWord, hasDayTime } from "./stt-rewrite.js";
import { phraseWords } from "./tool-families.js";
import { voiceLine } from "./voice-lines.js";
import { matchYesNo } from "./pending.js";

export const VOICE_OWN_TOOL_NAMES = Object.freeze(["crow_calendar_add_event", "crow_reminder_add", "crow_task_add"]);

/**
 * The intent lists each own tool family is offered on (turn.js tool families): the routine-object vocabulary
 * (routine-objects.js, one list for "is this about a calendar / reminder / task") plus these few extra phrases
 * that ask for the tool without naming the object. Never a bare "to do" or "todo" ("apaga todo" is Spanish).
 */
export const OWN_INTENT_EXTRAS = Object.freeze({
  // "remember to X <time>" is a reminder request (offered beside memory; the model chooses). Never a bare
  // "remember": "remember that …" is a memory.
  reminders: Object.freeze({ en: Object.freeze(["wake me up", "remember to"]), es: Object.freeze(["despiertame", "acuérdate de", "acuerdate de"]) }),
});
export const OWN_TOOL_INTENTS = Object.freeze(Object.fromEntries(Object.keys(ROUTINE_OBJECTS).map((id) => [id, Object.freeze({
  en: Object.freeze([...ROUTINE_OBJECTS[id].en, ...(OWN_INTENT_EXTRAS[id]?.en || [])]),
  es: Object.freeze([...ROUTINE_OBJECTS[id].es, ...(OWN_INTENT_EXTRAS[id]?.es || [])]),
})])));

/**
 * The calendar tool's intentWhen (PR 2.1 [r2 I8]; turn.js reads it beside the intent lists): "add coffee Tuesday at
 * 9", "please add lunch tomorrow", "añade café el martes a las 9". The verb leads (after a few lead-in words), the
 * next word is the item (stt-rewrite.js isObjectWord: never "a", "the", a day or a number, so "add two minutes" is
 * not one), and a day or time follows. Calendar wins over a reminder unless a reminder word is said, and a request
 * that names a task or a list is theirs. turn.js also lets the display's own objects win (displayObjectWhen).
 */
const ADD_VERBS = new Set(["add", "anade", "agrega", "anademe", "agregame"]);
const ADD_LEAD = new Set(["please", "can", "could", "would", "will", "you", "ok", "okay", "hey", "crow", "so", "also", "and", "just", "go", "ahead", "i", "want", "to", "need", "lets", "oye", "por", "favor", "puedes"]);
const NOT_CALENDAR = new Set(["list", "lists", "lista", "listas"]);
export function calendarAddIntent(transcript) {
  const ws = phraseWords(transcript);
  let i = 0;
  while (i < ws.length && i < 4 && !ADD_VERBS.has(ws[i]) && ADD_LEAD.has(ws[i])) i++;
  if (!ADD_VERBS.has(ws[i]) || !isObjectWord(ws[i + 1]) || !hasDayTime(ws.slice(i + 2))) return false;
  if (ws.some((w) => NOT_CALENDAR.has(w))) return false;
  const named = namesRoutineObjects(ws.join(" "));
  return !named.includes("reminders") && !named.includes("tasks");
}

/** How long a calendar or task list Crow bot owns, found by listing, stays picked (per process). Never a shared one. */
export const OWN_ID_CACHE_MS = 10 * 60 * 1000;

/** The board card's author: the owner, speaking through Crow's voice. */
const VOICE_ACTOR = Object.freeze({ kind: "human", id: "crow.voice", jobId: null });
const BACKEND_ERROR = Object.freeze({ ok: false, code: "backend_error" });
const TITLE_MAX = 200;

// ─── Dates and times ───
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Do these wall-clock fields name a real moment (no 30 February, no 25:00)? */
function realWall(y, mo, d, h = 0, mi = 0, s = 0) {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
}

/** "2026-10-26T12:00:00-05:00" → { ms, off (minutes east of UTC), date "2026-10-26" } | null (no offset → null). */
function parseDateTime(v) {
  if (typeof v !== "string") return null;
  const m = DT_RE.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || "0"].map(Number);
  if (!realWall(y, mo, d, h, mi, s)) return null;
  let off = 0;
  if (m[7] !== "Z") {
    const sign = m[7][0] === "-" ? -1 : 1;
    const digits = m[7].slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    if (oh > 18 || om > 59) return null;
    off = sign * (oh * 60 + om);
  }
  return { ms: Date.UTC(y, mo - 1, d, h, mi, s) - off * 60_000, off, date: `${m[1]}-${m[2]}-${m[3]}` };
}

function parseDate(v) {
  if (typeof v !== "string") return null;
  const m = DATE_RE.exec(v.trim());
  if (!m || !realWall(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The moment `ms` written in the offset `off` ("2026-10-26T13:00:00-05:00"). */
function withOffset(ms, off) {
  const w = new Date(ms + off * 60_000);
  const o = off === 0 ? "Z" : `${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())}${o}`;
}

const DAY_MS = 86_400_000;
function addDays(date, n) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const nextDay = (date) => addDays(date, 1);

// One offset formatter per zone (a formatter is costly to build; the zones in use are few).
const OFFSET_FORMATS = new Map();
function offsetFormat(tz) {
  let f = OFFSET_FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
    if (OFFSET_FORMATS.size >= 64) OFFSET_FORMATS.clear();
    OFFSET_FORMATS.set(tz, f);
  }
  return f;
}
/** The UTC offset of `tz` (minutes east of UTC) at the moment `ms`. */
function zoneOffsetAt(ms, tz) {
  const name = offsetFormat(tz).formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName")?.value || "GMT";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}
/** The local wall-clock time of `ms` in `tz`, as a UTC timestamp of those fields. */
const wallOf = (ms, tz) => ms + zoneOffsetAt(ms, tz) * 60_000;
/**
 * The moment a local wall-clock time (a UTC timestamp of its fields) names in `tz`. The offsets a day either side are
 * the candidates (zone changes are months apart): the earlier moment that really shows that wall time wins (a
 * fall-back hour happens twice); a time the clocks skip (spring-forward 02:30) is read with the offset before the
 * change, which lands on the same distance past it (03:30).
 */
function momentOf(wall, tz) {
  const before = zoneOffsetAt(wall - DAY_MS, tz);
  const after = zoneOffsetAt(wall + DAY_MS, tz);
  const shows = [before, after].map((o) => wall - o * 60_000).filter((t) => wallOf(t, tz) === wall).sort((x, y) => x - y);
  return shows.length ? shows[0] : wall - before * 60_000;
}
/**
 * The first moment after `now` of a wall time `wall` stepped by `period` (a day or a week): a constant-time jump to
 * about the right step, then at most a few steps either side for the DST hour.
 */
function nextAfter(wall, period, now, tz) {
  let k = Math.max(1, Math.ceil((now - (wall - zoneOffsetAt(wall, tz) * 60_000)) / period));
  while (k > 1 && momentOf(wall + (k - 1) * period, tz) > now) k -= 1;
  let at = momentOf(wall + k * period, tz);
  for (let i = 0; at <= now && i < 4; i += 1) { k += 1; at = momentOf(wall + k * period, tz); }
  return at;
}
/** `ms` written with the offset `tz` has on that date (the offset is recomputed: DST can lie between). */
const inZone = (ms, tz) => withOffset(ms, zoneOffsetAt(ms, tz));
/**
 * Today's date in `tz` (YYYY-MM-DD). With no zone, the date furthest behind (UTC-12): a date before it is past
 * everywhere, so nothing that may still be today is called past.
 */
const todayIn = (now, tz) => new Date(tz ? wallOf(now, tz) : now - 12 * 3_600_000).toISOString().slice(0, 10);
/** A date moved forward by whole weeks (same weekday) to the first that is `today` or later (constant time). */
function sameWeekdayFrom(date, today) {
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);
  return days <= 0 ? date : addDays(date, Math.ceil(days / 7) * 7);
}
/** Grace for a timed start or reminder a moment ago ("in a minute" said slowly, a clock a little behind): not past. */
const PAST_GRACE_MS = 5 * 60_000;
/** Further back than this is not a slip of the day but a wrong argument (a wrong year): bad_args, never rolled forward. */
const PAST_LIMIT_DAYS = 366;
const TOO_FAR_PAST = "That date is more than a year ago. Ask the user which date they mean.";
// A weekday named in the user's words (en, es; accents ignored): a past task due date keeps that weekday.
const WEEKDAY_WORD = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/;
const namesWeekday = (t) => typeof t === "string" && WEEKDAY_WORD.test(t.slice(0, 400).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

/** A usable IANA zone, or null. */
function validTz(tz) {
  if (typeof tz !== "string" || !tz.trim()) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}

const locale = (lang) => (lang === "es" ? "es" : "en-US");
const FORMAT_OPTS = {
  timed: { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" },
  day: { weekday: "long", month: "long", day: "numeric" },
  time: { hour: "numeric", minute: "2-digit" },
};
// One formatter per (language, zone, kind), bounded like the offset formatters.
const WHEN_FORMATS = new Map();
function whenFormat(lang, tz, kind) {
  const key = `${locale(lang)}|${tz}|${kind}`;
  let f = WHEN_FORMATS.get(key);
  if (!f) {
    const dtf = new Intl.DateTimeFormat(locale(lang), { ...FORMAT_OPTS[kind], timeZone: tz });
    // ICU versions differ in the space before AM/PM (U+202F, U+00A0, or plain): speak a plain one.
    f = { format: (d) => dtf.format(d).replace(/[\u202f\u00a0]/g, " ") };
    if (WHEN_FORMATS.size >= 64) WHEN_FORMATS.clear();
    WHEN_FORMATS.set(key, f);
  }
  return f;
}
/** Test-only: how many formatters are cached. */
export const _whenFormatCacheSize = () => WHEN_FORMATS.size;
/** A moment with its weekday, month and day ("Tuesday, October 27 at 9:00 AM"): the one formatter for a spoken date and time. */
export const whenOn = (ms, lang, tz) => whenFormat(lang, tz, "timed").format(new Date(ms));
/** An all-day date (YYYY-MM-DD) as its weekday, month and day. */
const whenDay = (date, lang) => whenFormat(lang, "UTC", "day").format(new Date(`${date}T12:00:00Z`));
/**
 * A reminder's moment: "today at ..." / "tomorrow at ..." (es "hoy a las ..." / "mañana a las ...") when it is within 24
 * hours (the day read in `tz`), else the full date; in es the full date carries its "el" (the line has none).
 */
function whenReminder(ms, lang, tz, now) {
  if (ms >= now - PAST_GRACE_MS && ms - now <= DAY_MS) {
    const days = Math.round((Date.parse(`${new Date(wallOf(ms, tz)).toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${todayIn(now, tz)}T00:00:00Z`)) / DAY_MS);
    if (days === 0 || days === 1) {
      const time = whenFormat(lang, tz, "time").format(new Date(ms));
      if (lang === "es") return `${days === 0 ? "hoy" : "mañana"} a ${new Date(wallOf(ms, tz)).getUTCHours() === 1 ? "la" : "las"} ${time}`;
      return `${days === 0 ? "today" : "tomorrow"} at ${time}`;
    }
  }
  return lang === "es" ? `el ${whenOn(ms, lang, tz)}` : whenOn(ms, lang, tz);
}

// ─── Validation ───
const bad = (message, code = "bad_args") => ({ error: message, code });
// no_tz is its own code: a larger model cannot supply a missing zone, so the turn never steps up on it.
const NO_TZ = "No time zone is known on this device, so a time cannot be set here. Tell the user you can't set a time from this device.";
const NEED_OFFSET = "Give the time as a date-time with the UTC offset of the user's time zone, e.g. 2026-10-26T12:00:00-05:00.";

function cleanText(v, what) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return { error: `${what} is required.` };
  if (t.length > TITLE_MAX) return { error: `${what} is too long (at most ${TITLE_MAX} characters).` };
  return { value: t };
}

/**
 * → { args, when } (args normalized; when spoken) | { error, code } (code "bad_args", or "no_tz" when no zone is known)
 * | { args, when, past: true, nextWhen } for a past start or date (PR 2.1): args are already the NEXT occurrence (an
 * event's same weekday and local time; a reminder's next day; a task's tomorrow, or its weekday next week when the user
 * named one), with the offset recomputed for that date. Nothing past is written: the caller asks about the next one.
 * Past: a timed start before now minus PAST_GRACE_MS, an all-day date or a due date before today in `tz`, a reminder
 * at or before now. no_tz comes first: without a zone, no date-time is checked or moved.
 */
function validate(tool, raw, opts) {
  const v = validateNow(tool, raw, opts);
  if (v.error || !v.next) return v;
  const n = validateNow(tool, v.next, opts);
  if (n.error || n.next) return bad("That time has already passed. Ask the user for a time in the future.", "past_time");
  return { ...n, past: true };
}

function validateNow(tool, raw, { tz, lang, now, transcript }) {
  const a = raw && typeof raw === "object" ? raw : {};
  if (tool === "crow_calendar_add_event") {
    const title = cleanText(a.title, "The title");
    if (title.error) return bad(title.error);
    const startDate = parseDate(a.start);
    const startDt = startDate ? null : parseDateTime(a.start);
    if (!startDate && !startDt) return bad(`The start is not a date or a date-time with an offset. ${NEED_OFFSET} Use YYYY-MM-DD for an all-day event.`);
    const allDay = !!startDate || a.all_day === true;
    if (allDay) {
      const start = startDate || startDt.date;
      let end = start;
      if (a.end != null && a.end !== "") {
        end = parseDate(a.end) || parseDateTime(a.end)?.date || null;
        if (!end) return bad("The end is not a date (YYYY-MM-DD) for an all-day event.");
        if (end < start) return bad("The end is before the start.");
      }
      const today = todayIn(now, tz);
      if (start < addDays(today, -PAST_LIMIT_DAYS)) return bad(TOO_FAR_PAST);
      if (start < today) {
        const next = sameWeekdayFrom(start, today);
        const shift = Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
        return { next: { title: title.value, start: next, end: addDays(end, shift), all_day: true } };
      }
      return { args: { title: title.value, start, end, all_day: true }, when: whenDay(start, lang), nextWhen: whenDay(start, lang) };
    }
    if (!tz) return bad(NO_TZ, "no_tz");
    let end = withOffset(startDt.ms + 3_600_000, startDt.off);
    let endMs = startDt.ms + 3_600_000;
    if (a.end != null && a.end !== "") {
      const e = parseDateTime(a.end);
      if (!e) return bad(`The end is not a date-time with an offset. ${NEED_OFFSET}`);
      if (e.ms <= startDt.ms) return bad("The end must be after the start.");
      end = String(a.end).trim();
      endMs = e.ms;
    }
    if (startDt.ms < now - PAST_LIMIT_DAYS * DAY_MS) return bad(TOO_FAR_PAST);
    if (startDt.ms < now - PAST_GRACE_MS) {
      // The same weekday and the local time the model wrote (its own clock fields, not the zone's reading of them),
      // the first week on that is ahead; the same length; the offset that date has.
      const at = nextAfter(startDt.ms + startDt.off * 60_000, 7 * DAY_MS, now, tz);
      return { next: { title: title.value, start: inZone(at, tz), end: inZone(at + (endMs - startDt.ms), tz), all_day: false } };
    }
    return { args: { title: title.value, start: String(a.start).trim(), end, all_day: false }, when: whenOn(startDt.ms, lang, tz), nextWhen: whenOn(startDt.ms, lang, tz) };
  }
  if (tool === "crow_reminder_add") {
    const text = cleanText(a.text, "The reminder text");
    if (text.error) return bad(text.error);
    const at = parseDateTime(a.at);
    if (!at) return bad(`The time is not a date-time with an offset. ${NEED_OFFSET}`);
    if (!tz) return bad(NO_TZ, "no_tz");
    if (at.ms < now - PAST_LIMIT_DAYS * DAY_MS) return bad(TOO_FAR_PAST);
    if (at.ms < now - PAST_GRACE_MS) {
      // The local time the model wrote, the first day on that is ahead, in that day's offset.
      const ms = nextAfter(at.ms + at.off * 60_000, DAY_MS, now, tz);
      return { next: { text: text.value, at: inZone(ms, tz) } };
    }
    return { args: { text: text.value, at: String(a.at).trim() }, when: whenReminder(at.ms, lang, tz, now), atIso: new Date(at.ms).toISOString(), nextWhen: whenReminder(at.ms, lang, tz, now) };
  }
  if (tool === "crow_task_add") {
    const title = cleanText(a.title, "The title");
    if (title.error) return bad(title.error);
    let due = null;
    if (a.due != null && a.due !== "") {
      due = parseDate(a.due);
      if (!due) return bad("The due date must be YYYY-MM-DD.");
      const today = todayIn(now, tz);
      if (due < addDays(today, -PAST_LIMIT_DAYS)) return bad(TOO_FAR_PAST);
      if (due < today) return { next: { title: title.value, due: namesWeekday(transcript) ? sameWeekdayFrom(due, today) : addDays(today, 1) } };
    }
    return { args: { title: title.value, ...(due ? { due } : {}) }, when: null, nextWhen: due ? whenDay(due, lang) : null };
  }
  return bad("Unknown tool.");
}

/**
 * The success line. `target.say` (resolveTarget): "your" (Google primary, the operator's chosen one, the board), "crow"
 * (a calendar or list Crow bot owns, picked on its own) or "named" (the one the user named answering the which-question):
 * a write anywhere but primary or the chosen one is audible.
 */
function successLine(tool, v, lang, target) {
  if (tool === "crow_reminder_add") return voiceLine("reminder_set", lang, { when: v.when, text: v.args.text });
  const how = target?.say === "crow" ? "_crow" : target?.say === "named" ? "_named" : "";
  if (tool === "crow_calendar_add_event") return voiceLine(`calendar_added${how}`, lang, { title: v.args.title, when: v.when, calendar: spokenName(target?.name) });
  return voiceLine(`task_added${how}`, lang, { title: v.args.title, list: spokenName(target?.name) });
}
const pastLine = (tool, v, lang) => (tool === "crow_calendar_add_event" ? voiceLine("past_confirm_calendar", lang, { title: v.args.title, next_when: v.nextWhen })
  : tool === "crow_reminder_add" ? voiceLine("past_confirm_reminder", lang, { next_when: v.nextWhen, text: v.args.text })
    : voiceLine("past_confirm_task", lang, { title: v.args.title, next_when: v.nextWhen }));
const confirmLine = (tool, v, lang) => (tool === "crow_calendar_add_event" ? voiceLine("routine_confirm_calendar", lang, { title: v.args.title, when: v.when })
  : tool === "crow_reminder_add" ? voiceLine("routine_confirm_reminder", lang, { when: v.when, text: v.args.text })
    : voiceLine("routine_confirm_task", lang, { title: v.args.title }));

/**
 * What an ok write put on record (turn.js voice memory lastWrite): { tool, title, start, target, target_name }. A task's
 * start is its due date or null; target is the success line's class ("your", "crow", "named"; null for a reminder).
 */
const writeOf = (tool, v, target) => ({ tool, family: DEFINITIONS[tool].family, title: tool === "crow_reminder_add" ? v.args.text : v.args.title,
  start: tool === "crow_calendar_add_event" ? v.args.start : tool === "crow_reminder_add" ? v.args.at : (v.args.due ?? null),
  target: target?.say ?? null, target_name: target?.name == null ? null : spokenName(target.name) });

/** A record's start as the spoken {when}: an all-day date as its day; a date-time in `tz`, else in its own UTC offset. */
function recapWhen(start, lang, tz, reminder, now) {
  const date = parseDate(start);
  if (date) return whenDay(date, lang);
  const dt = parseDateTime(start);
  if (!dt) return null;
  const zone = validTz(tz);
  const [ms, z, n] = zone ? [dt.ms, zone, now] : [dt.ms + dt.off * 60_000, "UTC", now + dt.off * 60_000];
  // With no zone the day is unknown, so a reminder gets the full date, never "today" or "tomorrow".
  return reminder && zone ? whenReminder(ms, lang, z, n) : reminder ? (lang === "es" ? `el ${whenOn(ms, lang, z)}` : whenOn(ms, lang, z)) : whenOn(ms, lang, z);
}

/**
 * The truthful recap of the last own write ({ tool, title, start, tz? }) in `lang` (voice-lines last_write_recap, with a
 * reminder and a task variant), or "" when it cannot be said (no title, or a calendar or reminder start it cannot read).
 */
export function lastWriteRecap(w, lang, now = Date.now()) {
  const title = typeof w?.title === "string" ? w.title.trim() : "";
  if (!title) return "";
  const cap = title[0].toUpperCase() + title.slice(1);
  // Where it went (Task 6): Crow's own, or the one named answering the which-question; else "your".
  const how = w.target === "crow" ? "_crow" : w.target === "named" && typeof w.target_name === "string" && w.target_name ? "_named" : "";
  if (w.tool === "crow_task_add") return voiceLine(`last_write_recap_task${how}`, lang, { title: cap, list: spokenName(w.target_name) });
  const when = recapWhen(w.start, lang, w.tz, w.tool === "crow_reminder_add", now);
  if (!when) return "";
  if (w.tool === "crow_reminder_add") return voiceLine("last_write_recap_reminder", lang, { when, text: title });
  return w.tool === "crow_calendar_add_event" ? voiceLine(`last_write_recap${how}`, lang, { title: cap, when, calendar: spokenName(w.target_name) }) : "";
}

/**
 * The one log line of an ok own write (PR 2.1 Task 7):
 *   [voice-own-tools] <tool> added (<backend> <class> <id> <start>)
 * backend: google | workspace | board | crow (Crow's schedules). class: primary (Google's own), chosen (the operator's),
 * owned (a calendar or list Crow bot owns), named (answered to the which-question), board, crow-reminder. id: the NEW
 * item's id as the backend answered it (event or task uid, card or schedule row), "-" unless a plain token. start: the
 * start, reminder time or due date, "-" when none. Never the title, the reminder text, an email address, or a calendar
 * or list id or name.
 */
const plainToken = (v, re, max) => {
  const x = typeof v === "bigint" || typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  return x && x.length <= max && re.test(x) && !x.includes("@") ? x : "-";
};
function addedLine(tool, v, t, made) {
  const reminder = tool === "crow_reminder_add";
  const backend = reminder ? "crow" : t?.backend === "google" || t?.backend === "workspace" ? t.backend : "board";
  const cls = reminder ? "crow-reminder" : backend === "board" ? "board"
    : t.say === "named" ? "named" : t.say === "crow" ? "owned" : backend === "google" && t.id === "primary" ? "primary" : "chosen";
  const id = reminder ? made?.lastInsertRowid : backend === "board" ? made?.id : (made?.uid ?? made?.id);
  const start = reminder ? (v.atIso ?? v.args.at) : tool === "crow_calendar_add_event" ? v.args.start : v.args.due;
  return `[voice-own-tools] ${tool} added (${backend} ${cls} ${plainToken(id, /^[A-Za-z0-9._-]+$/, 128)} ${plainToken(start, /^[0-9T:+.Z-]+$/, 40)})`;
}

// ─── Definitions ───
const DEFINITIONS = Object.freeze({
  crow_calendar_add_event: {
    family: "own:calendar", intent: OWN_TOOL_INTENTS.calendar, intentWhen: calendarAddIntent,
    definition: {
      name: "crow_calendar_add_event",
      description: "Add an event to the user's calendar. The server tells the user when it is done.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: TITLE_MAX, description: "What the event is" },
          start: { type: "string", description: "A date-time with the UTC offset of the user's time zone (2026-10-26T12:00:00-05:00), or YYYY-MM-DD for an all-day event" },
          end: { type: "string", description: "Optional; same form as start. Default: one hour after start, or the same day for an all-day event" },
          all_day: { type: "boolean", description: "True for an all-day event" },
        },
        required: ["title", "start"],
        additionalProperties: false,
      },
    },
  },
  crow_reminder_add: {
    family: "own:reminders", intent: OWN_TOOL_INTENTS.reminders,
    definition: {
      name: "crow_reminder_add",
      description: "Set a one-time reminder for the user at a given time. The server tells the user when it is set.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: TITLE_MAX, description: "What to remind the user of" },
          at: { type: "string", description: "When: a date-time with the UTC offset of the user's time zone (2026-10-26T09:30:00-05:00)" },
        },
        required: ["text", "at"],
        additionalProperties: false,
      },
    },
  },
  crow_task_add: {
    family: "own:tasks", intent: OWN_TOOL_INTENTS.tasks,
    definition: {
      name: "crow_task_add",
      description: "Add a task to the user's to-do list. The server tells the user when it is added.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: TITLE_MAX, description: "The task" },
          due: { type: "string", description: "Optional due date, YYYY-MM-DD" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
});
const OBJECT_OF = Object.freeze({ crow_calendar_add_event: "calendar", crow_reminder_add: "reminders", crow_task_add: "tasks" });

// ─── Which calendar or task list (PR 2.1 Task 6) ───
/** At most this many choices are read out. */
const MAX_CHOICES = 4;
/** Only Crow bot's own calendar or list is ever picked without a choice; a missing `shared` field counts as shared. */
const isOwned = (x) => x?.shared === false;
const usable = (x) => x && x.writable === true && typeof x.id === "string" && x.id;
/**
 * The spoken name: Nextcloud shows a collection someone shared with Crow bot as "Menu (admin)"; the owner is dropped.
 * Mirrors baseOf in the Workspace bundle (bundles/workspace/server/pim/caldav.js; same pattern): core cannot import a bundle.
 */
const baseName = (name) => String(name ?? "").replace(/\s+\([^()]*\)$/, "");
/** A shared calendar or list name is someone else's text: at most this many characters are spoken or kept on record. */
const SPOKEN_NAME_MAX = 60;
/** One line (whitespace and control characters collapse to a space), capped at SPOKEN_NAME_MAX with an ellipsis. */
function spokenName(name) {
  const one = String(name ?? "").replace(/[\s\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();
  if (one.length <= SPOKEN_NAME_MAX || (one.length === SPOKEN_NAME_MAX + 1 && one.endsWith("…"))) return one;   // already capped
  // Cut at a word end where one is near, so the words heard are whole words (a which-answer may repeat them).
  const cut = one.slice(0, SPOKEN_NAME_MAX + 1);
  const end = cut.lastIndexOf(" ");
  return `${(end >= SPOKEN_NAME_MAX / 2 ? cut.slice(0, end) : one.slice(0, SPOKEN_NAME_MAX)).trimEnd()}…`;
}
/**
 * Up to MAX_CHOICES writable entries as { id, name } (name: spokenName); two with the same spoken name keep their full
 * names. When capping changed the name, `match` keeps the uncapped one: a which-answer may name either.
 */
function choicesOf(items) {
  const picked = items.filter(usable).slice(0, MAX_CHOICES).map((x) => ({ id: x.id, full: String(x.name || x.id), name: baseName(x.name || x.id) || x.id }));
  const key = (n) => phraseWords(n).join(" ");
  return picked.map((c) => {
    const raw = picked.filter((o) => key(o.name) === key(c.name)).length > 1 ? c.full : c.name;
    const name = spokenName(raw) || c.id;
    return name === raw ? { id: c.id, name } : { id: c.id, name, match: raw };
  });
}
/** "Personal or Menu" / "Personal, Menu o Familia". */
function joinOr(names, lang) {
  if (names.length <= 1) return names[0] || "";
  return voiceLine("which_or", lang, { rest: names.slice(0, -1).join(", "), last: names.at(-1) });
}
/** The words a short which-answer may carry besides the name ("the menu one", "el de Menu"), at most CHOICE_FILLER_MAX. */
const CHOICE_FILLER = new Set(["the", "one", "use", "calendar", "list", "task", "tasks", "my", "that", "please", "ok", "okay",
  "el", "la", "los", "las", "de", "del", "uno", "una", "usa", "calendario", "lista", "tareas", "mi", "por", "favor", "vale"]);
const CHOICE_FILLER_MAX = 3;
/** A no to the which-question is short; longer, it is something else to answer (the model hears it). */
const WHICH_NO_MAX_WORDS = 4;
/**
 * The option a SHORT answer names (case and accents ignored): the name, plus at most CHOICE_FILLER_MAX filler words and
 * nothing else, so a name inside an unrelated sentence ("what's on the menu tonight") is no answer. A longer name beats
 * a shorter one; two equally good → null (never guessed).
 */
export function matchChoice(transcript, options) {
  const words = phraseWords(transcript);
  if (!words.length || !Array.isArray(options)) return null;
  let best = null; let bestScore = 0; let tie = false;
  for (const o of options) {
    // The spoken name (capped, as heard) or the full one (`match`, when capping changed it).
    let ow = [];
    let ok = false;
    for (const said of [o?.name, o?.match]) {
      if (ok || typeof said !== "string") continue;
      ow = phraseWords(said);
      if (!ow.length || ow.length > words.length) continue;
      for (let i = 0; !ok && i + ow.length <= words.length; i++) {
        if (!ow.every((w, j) => words[i + j] === w)) continue;
        const rest = [...words.slice(0, i), ...words.slice(i + ow.length)];
        ok = rest.length <= CHOICE_FILLER_MAX && rest.every((w) => CHOICE_FILLER.has(w));
      }
    }
    if (!ok) continue;
    if (ow.length > bestScore) { best = o; bestScore = ow.length; tie = false; } else if (ow.length === bestScore) tie = true;
  }
  return best && !tie ? best : null;
}

async function defaultOpenTasksDb() {
  const { createDbClient } = await import("../../db.js");
  const { tasksDbPath } = await import("../../../scripts/pi-bots/instance-paths.mjs");
  return createDbClient(tasksDbPath());
}

/** settings: normalizeVoiceSettings(bot) (or anything with .routine). An explicit backend not connected → null. */
export function resolveRoutineBackends(settings, conn) {
  const r = normalizeVoiceSettings({ routine: settings?.routine }).routine;
  const has = (n) => conn instanceof Set && conn.has(n);
  const cal = r.calendar.backend;
  const calendar = cal === "workspace" ? (has("ws_cal_create_event") ? "workspace" : null)
    : cal === "google" ? (has("gcal_create_event") ? "google" : null)
      : cal === "auto" ? (has("ws_cal_create_event") ? "workspace" : has("gcal_create_event") ? "google" : null) : null;
  const reminders = r.reminders.backend === "off" ? null : "crow";
  const tb = r.tasks.backend;
  const tasks = tb === "workspace" ? (has("ws_task_create") ? "workspace" : null)
    : tb === "board" ? "board"
      : tb === "auto" ? (has("ws_task_create") ? "workspace" : "board") : null;
  return { calendar, reminders, tasks };
}

/**
 * createOwnTools({ pending, now, log, connected, openTasksDb }):
 *   pending      createPendingStore() (pending.js): the per-device pending confirmations
 *   connected()  → Set of connected add-on tool names (tool-executor connectedAddonToolNames)
 *   openTasksDb  → the instance-global tasks.db client (default: instance-paths tasksDbPath)
 * → { forTurn, fastPath, turnContext, resolveBackends }
 */
export function createOwnTools({ pending, now = Date.now, log = () => {}, connected = () => new Set(), openTasksDb = defaultOpenTasksDb } = {}) {
  if (!pending || typeof pending.set !== "function") throw new Error("own tools: a pending store is required");
  const idCache = new Map();   // "calendar" | "tasks" → { id, at }
  const connectedNow = () => { try { const s = connected(); return s instanceof Set ? s : new Set(s || []); } catch { return new Set(); } };

  const resolveBackends = resolveRoutineBackends;

  async function callTool(executor, name, args) {
    if (!executor || typeof executor.executeToolCalls !== "function") throw new Error("no tool executor");
    const [r] = await executor.executeToolCalls([{ id: `own-${name}`, name, arguments: args }]);
    if (!r || r.isError) throw new Error(`${name} failed`);
    // Every backend called here answers a JSON object (Workspace: { success, data }; Google: the API object).
    // Anything else (plain text, an array, null) is not a documented success: an error, never "added".
    let body = null;
    try { body = JSON.parse(String(r.result)); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${name} answered no JSON object`);
    if (body.success === false || (body.success !== true && body.error)) throw new Error(`${name} failed`);
    return body.success === true && "data" in body ? body.data : body;
  }

  /** Every calendar or task list the Workspace listing gives (writable or not). */
  async function listTargets(kind, executor) {
    const data = await callTool(executor, kind === "calendar" ? "ws_cal_list_calendars" : "ws_tasks_list_lists", {});
    const items = data?.[kind === "calendar" ? "calendars" : "lists"];
    return Array.isArray(items) ? items : [];
  }

  /**
   * Where this add goes (the rules in the header). → { backend: "google"|"workspace"|"board", id?, name?, say } or
   * { ask: [{ id, name }] } (nobody chose one and Crow owns none). Throws when nothing can take it (no writable one).
   * The cache only ever holds a calendar or list Crow bot owns.
   */
  async function resolveTarget(tool, settings, executor) {
    const kind = tool === "crow_calendar_add_event" ? "calendar" : "tasks";
    const r = settings.routine;
    const backend = resolveBackends(settings, connectedNow())[kind];
    if (!backend) throw new Error("no backend");
    if (backend === "board") return { backend: "board", say: "your" };
    const chosen = kind === "calendar" ? r.calendar.calendar : r.tasks.list;
    if (backend === "google") return { backend: "google", id: chosen || "primary", say: "your" };
    if (chosen) return { backend: "workspace", id: chosen, say: "your" };
    const auto = (kind === "calendar" ? r.calendar.backend : r.tasks.backend) === "auto";
    const hit = idCache.get(kind);
    if (hit && now() - hit.at < OWN_ID_CACHE_MS) return { backend: "workspace", id: hit.id, say: "crow" };
    let items;
    try { items = await listTargets(kind, executor); }
    catch (err) { if (kind === "tasks" && auto) return { backend: "board", say: "your" }; throw err; }
    const own = items.find((x) => usable(x) && isOwned(x));
    if (own) { idCache.set(kind, { id: own.id, at: now() }); return { backend: "workspace", id: own.id, say: "crow" }; }
    if (auto && kind === "calendar" && connectedNow().has("gcal_create_event")) return { backend: "google", id: "primary", say: "your" };
    if (auto && kind === "tasks") return { backend: "board", say: "your" };   // auto: no list of Crow's own → the board
    const ask = choicesOf(items);
    if (!ask.length) throw new Error(`no writable ${kind === "calendar" ? "calendar" : "task list"}`);
    return { ask };
  }

  /** Hold the add as this device's which-question and say it. No device → nothing is asked or written. */
  function askWhich(deviceId, tool, v, options, lang, tz) {
    if (!deviceId) return { ...BACKEND_ERROR };
    const say = voiceLine(tool === "crow_calendar_add_event" ? "which_calendar_ask" : "which_list_ask", lang, { options: joinOr(options.map((o) => o.name), lang) });
    pending.set(deviceId, { kind: "which_calendar", tool, args: v.args, options, say, lang, tz });
    return { ok: true, effect: false, code: "needs_confirm", final: true, say };
  }

  async function boardCard(v, settings) {
    const { createCard } = await import("../board/card-service.js");
    const tdb = await openTasksDb();
    try {
      return await createCard(tdb, { title: v.args.title, due_date: v.args.due ?? null, tags: "crow-voice", project_id: settings.routine.tasks.project_id ?? null }, VOICE_ACTOR);
    } finally { try { tdb.close(); } catch {} }
  }

  /**
   * Write a validated call. → the result object; a failure is BACKEND_ERROR (logged, never spoken as success); with no
   * target given and none resolving, { ask } (nothing written: the caller asks which one).
   */
  async function perform(tool, v, { db, executor, settings, lang, target = null }) {
    let t = target;
    let made = null;   // what the backend answered (the new item's id is read from it for the log line only)
    try {
      if (tool === "crow_reminder_add") {
        if (!resolveBackends(settings, connectedNow()).reminders) throw new Error("no backend");
        made = await db.execute({
          sql: "INSERT INTO schedules (task, cron_expression, description, next_run) VALUES ('reminder:' || ?, '@once', 'Set by Crow''s voice', ?)",
          args: [v.args.text, v.atIso],
        });
      } else {
        if (!t) t = await resolveTarget(tool, settings, executor);
        if (t.ask) return { ask: t.ask };
        if (tool === "crow_calendar_add_event") {
          const a = v.args;
          if (t.backend === "workspace") {
            made = await callTool(executor, "ws_cal_create_event", { calendar: t.id, summary: a.title, start: a.start, end: a.end });
          } else {
            // Google's all-day end is exclusive: a same-day end becomes the next day.
            const end = a.all_day && a.end <= a.start ? nextDay(a.start) : a.end;
            made = await callTool(executor, "gcal_create_event", { summary: a.title, start: a.start, end, calendar_id: t.id });
          }
        } else if (t.backend === "workspace") {
          made = await callTool(executor, "ws_task_create", { list: t.id, summary: v.args.title, ...(v.args.due ? { due: v.args.due } : {}) });
        } else {
          made = await boardCard(v, settings);
        }
      }
    } catch (err) {
      log(`[voice-own-tools] ${tool} not written (${String(err?.message || err).slice(0, 120)})`);
      return { ...BACKEND_ERROR };
    }
    log(addedLine(tool, v, t, made));
    return { ok: true, code: "added", final: true, say: successLine(tool, v, lang, t), write: writeOf(tool, v, t) };
  }

  /** → { tools, unavailable } for one voice turn (turn.js deps.ownTools). */
  function forTurn({ bot, lang, tz } = {}) {
    const settings = normalizeVoiceSettings(bot);
    const zone = validTz(tz);
    const backends = resolveBackends(settings, connectedNow());
    const unavailable = Object.keys(backends).filter((k) => !backends[k]);
    const tools = VOICE_OWN_TOOL_NAMES.filter((n) => backends[OBJECT_OF[n]]).map((name) => {
      const d = DEFINITIONS[name];
      return {
        definition: d.definition,
        family: d.family,
        intent: d.intent,
        ...(d.intentWhen ? { intentWhen: d.intentWhen } : {}),
        async execute(args, ctx = {}) {
          const v = validate(name, args, { tz: zone, lang, now: now(), transcript: ctx.transcript });
          if (v.error) return JSON.stringify({ ok: false, code: v.code || "bad_args", message: v.error });
          const offer = ctx.fallback === "calendar" && name === "crow_reminder_add";
          const deviceId = ctx.device?.id;
          const hold = (say) => {
            if (!deviceId) return JSON.stringify(BACKEND_ERROR);   // no device to hold the question: nothing is asked or written
            pending.set(deviceId, { kind: "routine", tool: name, args: v.args, say, lang, tz: zone });
            return JSON.stringify({ ok: true, effect: false, code: "needs_confirm", final: true, say });
          };
          // A past date always asks (PR 2.1): the held call is the next occurrence, written only on a yes (and the
          // which-question, when one is needed, follows that yes).
          if (v.past || offer) return hold(v.past ? pastLine(name, v, lang) : voiceLine("calendar_fallback_offer", lang, { when: v.when, text: v.args.text }));
          // Where it goes comes first (Task 6): with nothing chosen and nothing of Crow's own, the which-question is the
          // only question, even under "strict" or ctx.confirm; naming one is the yes.
          let target = null;
          if (name !== "crow_reminder_add") {
            try { target = await resolveTarget(name, settings, ctx.executor); }
            catch (err) { log(`[voice-own-tools] ${name} not written (${String(err?.message || err).slice(0, 120)})`); return JSON.stringify(BACKEND_ERROR); }
            if (target.ask) return JSON.stringify(askWhich(deviceId, name, v, target.ask, lang, zone));
          }
          // ctx.confirm (turn.js): a stray call on a tool offered only through carry-over asks first, as under "strict".
          if (settings.confirm === "strict" || ctx.confirm === true) return hold(confirmLine(name, v, lang));
          return JSON.stringify(await perform(name, v, { db: ctx.db, executor: ctx.executor, settings, lang, target }));
        },
      };
    });
    return { tools, unavailable };
  }

  /**
   * deps.voiceActions.fastPath: answers only this device's pending "routine" entry. yes → the held call runs
   * (validated again, under the voice bot's current settings) and the success line is spoken; no → declined;
   * anything else → null (the entry waits out its TTL). No device, or nothing pending → null: nothing ever runs
   * without a held question. A yes with no voice bot (disabled) or under another bot speaks not-done, writes nothing.
   */
  async function fastPath({ db, device, transcript, lang, bot, executor } = {}) {
    const id = device?.id;
    if (!id) return null;
    const peek = pending.get(id);
    if (peek?.kind === "which_calendar") return answerWhich({ id, db, transcript, lang, bot, executor });
    if (!peek || peek.kind !== "routine") return null;
    const answer = matchYesNo(transcript);
    if (!answer) return null;
    const entry = pending.take(id);   // act on what take() returned, never the earlier copy
    if (!entry || entry.kind !== "routine" || !Object.hasOwn(DEFINITIONS, entry.tool)) return null;
    const speak = lang || entry.lang;
    if (answer === "no") return { say: voiceLine("declined", speak), verb: "routine_no" };
    // Only the voice bot writes: a yes while it is disabled (no bot) or under another bot (opts.botId) runs nothing.
    if (!bot || !isVoiceBotDef(bot)) return { say: voiceLine("not_done_say", speak), verb: "routine_failed" };
    const settings = normalizeVoiceSettings(bot);
    const v = validate(entry.tool, entry.args, { tz: entry.tz, lang: speak, now: now() });
    const res = v.error || v.past ? null : await perform(entry.tool, v, { db, executor, settings, lang: speak });
    if (res?.ask) {
      const q = askWhich(id, entry.tool, v, res.ask, speak, entry.tz);
      return q.ok ? { say: q.say, verb: "which_ask" } : { say: voiceLine("not_done_say", speak), verb: "routine_failed" };
    }
    return res?.ok === true ? { say: res.say, verb: "routine_yes", write: res.write } : { say: voiceLine("not_done_say", speak), verb: "routine_failed" };
  }

  /**
   * The answer to this device's which-question (any answer ends it): a short no declines; a short answer naming one writes the
   * held item once to that one (validated again, under the voice bot's current settings), then the hint; anything else
   * → null, so the model answers what was really said (nothing written or claimed). Nothing is saved to the bot.
   */
  async function answerWhich({ id, db, transcript, lang, bot, executor }) {
    const entry = pending.take(id);
    if (!entry || entry.kind !== "which_calendar" || !Object.hasOwn(DEFINITIONS, entry.tool)) return null;
    const speak = lang || entry.lang;
    // A short no ("no", "no, not menu", "never mind") declines; a long sentence that starts with one is a new request.
    if (matchYesNo(transcript) === "no" && phraseWords(transcript).length <= WHICH_NO_MAX_WORDS) return { say: voiceLine("declined", speak), verb: "which_no" };
    const pick = matchChoice(transcript, entry.options);
    if (!pick) return null;
    if (!bot || !isVoiceBotDef(bot)) return { say: voiceLine("not_done_say", speak), verb: "which_failed" };
    const settings = normalizeVoiceSettings(bot);
    const v = validate(entry.tool, entry.args, { tz: entry.tz, lang: speak, now: now() });
    // The named one is written only while this object still goes to Workspace (the settings may have changed since).
    const still = resolveBackends(settings, connectedNow())[OBJECT_OF[entry.tool]] === "workspace";
    const res = v.error || v.past || !still ? null : await perform(entry.tool, v, { db, executor, settings, lang: speak, target: { backend: "workspace", id: pick.id, name: pick.name, say: "named" } });
    const hint = voiceLine(entry.tool === "crow_task_add" ? "which_hint_list" : "which_hint", speak);
    return res?.ok === true ? { say: `${res.say} ${hint}`, verb: "which_yes", write: res.write } : { say: voiceLine("not_done_say", speak), verb: "which_failed" };
  }

  /** deps.voiceActions.turnContext (synchronous): while a routine or which-question waits, the turn says so. */
  function turnContext({ device } = {}) {
    const entry = device?.id ? pending.get(device.id) : null;
    return entry && (entry.kind === "routine" || entry.kind === "which_calendar") ? { text: `[Pending] ${entry.say}`, pending: true } : null;
  }

  return { forTurn, fastPath, turnContext, resolveBackends };
}
