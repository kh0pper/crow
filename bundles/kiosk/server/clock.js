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

const LEAD_EN = "(?:(?:can|could) you tell me |do you know |tell me )?";
const LEAD_ES = "(?:me dices |me puedes decir |dime |sabes )?";
const ASK = {
  time_en: new RegExp(`^${LEAD_EN}(?:what time is it|what time it is|what(?: is| s|s) the (?:current )?time|the (?:current )?time)(?: right now| now)?$`),
  date_en: new RegExp(`^${LEAD_EN}(?:what(?: is| s|s) (?:today s|todays|the) date(?: today)?|what day is it(?: today)?|what day is today|the date(?: today)?|today s date)$`),
  time_es: new RegExp(`^${LEAD_ES}(?:qu[eé] hora es|qu[eé] horas son|qu[eé] hora tienes|la hora)(?: ahora)?$`),
  date_es: new RegExp(`^${LEAD_ES}(?:qu[eé] d[ií]a es(?: hoy)?|qu[eé] fecha es(?: hoy)?|cu[aá]l es la fecha(?: de hoy)?|a qu[eé] (?:d[ií]a )?estamos(?: hoy)?|la fecha(?: de hoy)?)$`),
};
function normalize(t) {
  return String(t || "").toLowerCase()
    .replace(/[¿¡“”"'’,.!?;:]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(hey crow|ok crow|okay crow|oye crow|ok|okay|please|por favor)\s+/, "")
    .replace(/\s+(please|thanks|thank you|por favor|gracias)$/, "")
    .trim();
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
