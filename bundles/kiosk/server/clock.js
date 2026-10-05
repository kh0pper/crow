/**
 * The display's clock for the voice turn (live test 2026-10-04: "What time is it?" →
 * "I don't have access to the current time."). Two pieces:
 *  - kioskNowContext(): local weekday, date, time and zone for THIS turn's user message
 *    (never the system message — it changes every minute and would break the prefix cache);
 *  - matchClockFastPath(): the plain "what time is it" / "what's the date" family (en + es),
 *    answered with no model call.
 * The zone is the one the page reports in `hello` (validated here); without one, the server's.
 */
const SPACES = /[  ]/g;   // ICU puts a narrow no-break space before AM/PM

/** An IANA zone this runtime knows, or null. */
export function validTimeZone(tz) {
  if (typeof tz !== "string" || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}
const zoneOf = (tz) => validTimeZone(tz) || Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmt = (locale, opts, at, tz) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: zoneOf(tz) }).format(new Date(at)).replace(SPACES, " ");
const DATE = { weekday: "long", month: "long", day: "numeric", year: "numeric" };
const TIME = { hour: "numeric", minute: "2-digit" };

export function kioskNowContext(now, tz) {
  return `[Now] ${fmt("en-US", DATE, now, tz)}, ${fmt("en-US", TIME, now, tz)} (time zone ${zoneOf(tz)})`;
}

/**
 * The phrase table (after normalize(): lower case, no accents or apostrophes, punctuation
 * to spaces, "what is" → "whats"). A question is a shortcut when it is exactly
 * [lead …] core [tail …] — any number of lead-ins and tails around ONE core phrase — so
 * "what time is the game" or "what's the date of the meeting" never match.
 */
const EN_LEADS = ["hey crow", "ok crow", "okay crow", "hey", "hi", "ok", "okay", "so", "and", "um", "uh", "well", "alright", "all right", "now", "please", "crow", "excuse me", "quick question",
  "can you tell me", "can you please tell me", "could you tell me", "would you tell me", "tell me", "please tell me", "do you know", "do you happen to know", "i want to know", "id like to know", "let me know"];
const ES_LEADS = ["oye crow", "oye", "hola", "ok", "vale", "bueno", "y", "por favor", "crow", "me dices", "me puedes decir", "me podrias decir", "puedes decirme", "podrias decirme", "dime", "sabes"];
export const CLOCK_PHRASES = Object.freeze({
  time_en: {
    leads: EN_LEADS,
    cores: ["what time is it", "what time it is", "whats the time", "whats the current time", "the time", "the current time", "time please", "do you have the time", "have you got the time", "what time do you have"],
    tails: ["right now", "now", "please", "crow", "thanks", "thank you", "currently", "at the moment", "exactly"],
  },
  date_en: {
    leads: EN_LEADS,
    cores: ["whats todays date", "whats the date", "whats today", "todays date", "the date", "what day is it", "what day it is", "what day is today", "what date is it", "what date it is", "whats the day", "what day of the week is it"],
    tails: ["today", "for today", "right now", "now", "please", "crow", "thanks", "thank you"],
  },
  time_es: {
    leads: ES_LEADS,
    cores: ["que hora es", "que horas son", "que hora tienes", "que hora tenemos", "la hora", "tienes hora", "tienes la hora"],
    tails: ["ahora", "ahora mismo", "por favor", "gracias", "crow"],
  },
  date_es: {
    leads: ES_LEADS,
    cores: ["que dia es", "que fecha es", "cual es la fecha", "a que estamos", "a que dia estamos", "a que fecha estamos", "en que dia estamos", "la fecha", "que dia de la semana es"],
    tails: ["hoy", "de hoy", "por favor", "gracias", "crow"],
  },
});
const alt = (list) => [...list].sort((a, b) => b.length - a.length).join("|");
const ASK = Object.fromEntries(Object.entries(CLOCK_PHRASES).map(([k, t]) => [k, new RegExp(`^(?:(?:${alt(t.leads)}) )*(?:${alt(t.cores)})(?: (?:${alt(t.tails)}))*$`)]));
function normalize(t) {
  return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\bwhat is\b/g, "whats");
}

/** → { say, events: [] } for the plain clock questions, else null (the model answers, with the [Now] context). */
export function matchClockFastPath(transcript, { now = Date.now(), tz = null } = {}) {
  const q = normalize(transcript);
  if (!q) return null;
  let say = null;
  if (ASK.time_en.test(q)) say = `It's ${fmt("en-US", TIME, now, tz)}.`;
  else if (ASK.date_en.test(q)) say = `Today is ${fmt("en-US", DATE, now, tz)}.`;
  else if (ASK.time_es.test(q)) {
    const hm = fmt("es", { ...TIME, hourCycle: "h23" }, now, tz);
    say = `${hm.startsWith("1:") ? "Es la" : "Son las"} ${hm}.`;
  } else if (ASK.date_es.test(q)) say = `Hoy es ${fmt("es", DATE, now, tz)}.`;
  return say ? { say, events: [] } : null;
}
