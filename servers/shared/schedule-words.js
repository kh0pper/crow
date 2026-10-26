/**
 * schedule-words — plain words (English and Spanish) for when a schedule runs, turned into a cron
 * expression (repeating) or an absolute time with its offset (one time), plus a summary and the
 * next 3 runs for the user to check.
 *
 * Hand-rolled on purpose: a date library would be a new dependency, and those parse dates, not
 * recurrence. The grammar is small and closed; anything outside it is refused with a hint, never
 * guessed. Pure: Intl and cron-parser (through schedule-core) only, `now` is always passed in.
 *
 *   parseWhen(text, { lang, tz, now, type })
 *     → { ok:true, cron, at?, summary, next3:[{iso, text}], every?, zone }
 *     | { ok:false, code, hint }
 *
 * The summary is rendered back from the cron (describeCron), and only for the shapes this grammar
 * emits; any other cron reads "Custom schedule". A reminder may repeat at most hourly (#560).
 */
import { ONCE, cronNext, cadenceMinutes, zoneFor } from "./schedule-core.js";
import { localYmd, dayNum, fromDayNum } from "./relative-dates.js";

/** Longer input is refused before any pattern sees it, so no input can make the parser slow. */
export const WHEN_MAX_CHARS = 200;
const MIN_REMINDER_EVERY = 60;
const MAX_IN_MINUTES = 7 * 1440;

// --- words ------------------------------------------------------------------------------------

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, ocho: 8, diez: 10, doce: 12, quince: 15, veinte: 20, treinta: 30,
};
const numOf = (w) => (/^\d{1,4}$/.test(w) ? Number(w) : NUM_WORDS[w] ?? null);

// Day numbers are cron's: 0 = Sunday.
const EN_DAYS = [
  [0, /^sun(day)?s?$/], [1, /^mon(day)?s?$/], [2, /^tue(s(day)?)?s?$/], [3, /^wed(nesday)?s?$/],
  [4, /^thu(r(s(day)?)?)?s?$/], [5, /^fri(day)?s?$/], [6, /^sat(urday)?s?$/],
];
const ES_DAYS = [[0, /^domingos?$/], [1, /^lunes$/], [2, /^martes$/], [3, /^miercoles$/], [4, /^jueves$/], [5, /^viernes$/], [6, /^sabados?$/]];
const dayOf = (table, w) => { for (const [n, re] of table) if (re.test(w)) return n; return null; };

const NAMES = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  es: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
};

/** Lower case, accents and apostrophes off, "a.m." → "am", trailing punctuation and extra spaces gone. */
function fold(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’¿¡]/g, "")
    .replace(/\b([ap])\.\s?m\b\.?/g, "$1m").replace(/[.!?;]+$/g, "").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
}

// --- time of day ------------------------------------------------------------------------------

const EN_TIME = /(?:^|\s)(?:at\s+)?(?:(noon|midday|midnight)|(\d{1,2}):(\d{2})\s?(am|pm)?|(\d{1,2})\s?(am|pm))(?=\s|,|$)|(?:^|\s)at\s+(\d{1,2})(?=\s|,|$)/g;
const ES_PERIOD = "(?:\\s+de\\s+la\\s+(manana|tarde|noche|madrugada)|\\s?(am|pm))?";
const ES_TIME = new RegExp(
  "(?:^|\\s)(?:(?:a|al)\\s+(?:la\\s+)?)?(mediodia|medianoche)(?=\\s|,|$)"
  + `|(?:^|\\s)(?:a\\s+las?\\s+)?(\\d{1,2}):(\\d{2})${ES_PERIOD}(?=\\s|,|$)`
  + `|(?:^|\\s)a\\s+las?\\s+(\\d{1,2}|una)${ES_PERIOD}(?=\\s|,|$)`
  + "|(?:^|\\s)(\\d{1,2})\\s?(am|pm)(?=\\s|,|$)",
  "g",
);

/** 12-hour + am/pm → 0–23, or null. */
function ampm(h, p) {
  if (h < 1 || h > 12) return null;
  return p === "am" ? h % 12 : (h % 12) + 12;
}

/** Spanish "de la …" hours. "12 de la noche" is midnight; "de la madrugada" is the small hours. */
function esPeriod(h, period) {
  if (h > 12) return period === "tarde" || period === "noche" ? h : null; // "18:00 de la tarde"
  switch (period) {
    case "manana": return h >= 1 && h <= 11 ? h : null;
    case "tarde": return h === 12 ? 12 : h >= 1 ? h + 12 : null;
    case "noche": return h === 12 ? 0 : h >= 6 ? h + 12 : h >= 1 && h <= 5 ? h : null;
    case "madrugada": return h === 12 ? 0 : h >= 1 && h <= 6 ? h : null;
    default: return null;
  }
}

/** Find the one time of day in `s`. → {time:{h,m}|null, rest} | {error} */
function takeTime(s, lang) {
  const re = lang === "es" ? ES_TIME : EN_TIME;
  const found = [...s.matchAll(re)];
  if (found.length === 0) return { time: null, rest: s };
  if (found.length > 1) return { error: "two_times" };
  const g = found[0];
  let h = null, m = 0;
  if (lang === "en") {
    if (g[1]) h = g[1] === "midnight" ? 0 : 12;
    else if (g[2] !== undefined) { h = Number(g[2]); m = Number(g[3]); if (g[4]) h = ampm(h, g[4]); else if (h > 23) h = null; }
    else if (g[5] !== undefined) h = ampm(Number(g[5]), g[6]);
    else { h = Number(g[7]); if (h > 23) h = null; }
  } else {
    const fix = (hh, period, p) => (period ? esPeriod(hh, period) : p ? ampm(hh, p) : hh <= 23 ? hh : null);
    if (g[1]) h = g[1] === "medianoche" ? 0 : 12;
    else if (g[2] !== undefined) { m = Number(g[3]); h = fix(Number(g[2]), g[4], g[5]); }
    else if (g[6] !== undefined) h = fix(g[6] === "una" ? 1 : Number(g[6]), g[7], g[8]);
    else h = ampm(Number(g[9]), g[10]);
  }
  if (h === null || !(m >= 0 && m <= 59)) return { error: "bad_time" };
  const rest = (s.slice(0, g.index) + " " + s.slice(g.index + g[0].length)).replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "").trim();
  return { time: { h, m }, rest };
}

// --- day phrases ------------------------------------------------------------------------------

/** "monday, wednesday and friday" → {days, plural} | null. */
function dayList(s, table, joiner) {
  const parts = s.split(new RegExp(`\\s*(?:,\\s*(?:${joiner}\\s+)?|\\s${joiner}\\s)\\s*`)).map((p) => p.replace(/^(?:los|the)\s+/, "").trim());
  if (!parts.length || parts.some((p) => !p)) return null;
  const days = [];
  let plural = false;
  for (const p of parts) {
    const d = dayOf(table, p);
    if (d === null) return null;
    if (/s$/.test(p) && !/^(?:lunes|martes|miercoles|jueves|viernes|tues|thurs)$/.test(p)) plural = true;
    if (!days.includes(d)) days.push(d);
  }
  return { days: days.sort((a, b) => a - b), plural };
}

const ord = "(\\d{1,2})(?:st|nd|rd|th)?";
const EN_MONTHLY = [
  new RegExp(`^(?:every|each) month on the ${ord}$`), new RegExp(`^monthly on the ${ord}$`),
  new RegExp(`^(?:on )?the ${ord} of (?:every|each) month$`), new RegExp(`^(?:every|each) month on ${ord}$`),
];
const ES_MONTHLY = [
  /^(?:el )?(?:dia )?(\d{1,2}|primero) de cada mes$/, /^(?:cada mes|todos los meses|mensualmente) el (?:dia )?(\d{1,2}|primero)$/,
];

/**
 * The day part of the words, with the time already taken out.
 * → {kind:'cron', dow?, dom?} | {kind:'step', unit, n} | {kind:'in', minutes}
 *   | {kind:'once', day:'today'|'tomorrow'|'bare'|{dow}|{ymd}} | {error} | null (not this language)
 */
function dayPhrase(s, lang) {
  if (lang === "en") {
    if (/^(?:every ?day|daily|each day)$/.test(s)) return { kind: "cron", dow: "*" };
    if (/^(?:(?:every|each|on) )?weekdays?$/.test(s) && s !== "weekday") return { kind: "cron", dow: "1-5" };
    if (/^(?:monday (?:to|through|thru) friday)$/.test(s)) return { kind: "cron", dow: "1-5" };
    if (/^(?:(?:every|each|on) )?weekends?$/.test(s) && s !== "weekend") return { kind: "cron", dow: "0,6" };
    if (/^hourly$/.test(s)) return { kind: "step", unit: "hour", n: 1 };
    let m = /^every (?:([a-z0-9]+) )?(minutes?|mins?|hours?|hrs?)$/.exec(s);
    if (m) return stepOf(m[1], m[2].startsWith("h") ? "hour" : "minute");
    for (const re of EN_MONTHLY) if ((m = re.exec(s))) return { kind: "cron", dom: Number(m[1]) };
    m = /^in (?:([a-z0-9]+) )?(minutes?|mins?|hours?|hrs?)$/.exec(s);
    if (m) return inOf(m[1], m[2].startsWith("h") ? 60 : 1);
    if (s === "") return { kind: "once", day: "bare" };
    if (s === "today") return { kind: "once", day: "today" };
    if (s === "tomorrow" || s === "tmrw") return { kind: "once", day: "tomorrow" };
    if ((m = /^(?:on )?(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { kind: "once", day: { ymd: { y: +m[1], m: +m[2], d: +m[3] } } };
    if (/^(?:on )?(?:next|this coming) /.test(s)) return { error: "ambiguous" };
    m = /^(?:(every|each|on) )?(.+)$/.exec(s);
    const list = dayList(m[2], EN_DAYS, "and");
    if (list) {
      if (m[1] === "every" || m[1] === "each" || list.plural) return { kind: "cron", dow: list.days.join(",") };
      if (list.days.length === 1) return { kind: "once", day: { dow: list.days[0] } };
      return { error: "ambiguous" };
    }
    return null;
  }
  if (/^(?:cada dia|todos los dias|diariamente|a diario)$/.test(s)) return { kind: "cron", dow: "*" };
  if (/^(?:(?:cada|todos los|los) )?dias? laborables?$|^entre semana$|^de lunes a viernes$|^cada dia entre semana$/.test(s) && s !== "dia laborable") return { kind: "cron", dow: "1-5" };
  if (/^(?:los |cada |todos los )?fines? de semana$/.test(s) && s !== "fin de semana") return { kind: "cron", dow: "0,6" };
  let m = /^cada (?:([a-z0-9]+) )?(minutos?|horas?)$/.exec(s);
  if (m) return stepOf(m[1], m[2].startsWith("h") ? "hour" : "minute");
  for (const re of ES_MONTHLY) if ((m = re.exec(s))) return { kind: "cron", dom: m[1] === "primero" ? 1 : Number(m[1]) };
  m = /^(?:en|dentro de) (?:([a-z0-9]+) )?(minutos?|horas?)$/.exec(s);
  if (m) return inOf(m[1], m[2].startsWith("h") ? 60 : 1);
  if (s === "") return { kind: "once", day: "bare" };
  if (s === "hoy") return { kind: "once", day: "today" };
  if (s === "manana") return { kind: "once", day: "tomorrow" };
  if ((m = /^(?:el )?(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { kind: "once", day: { ymd: { y: +m[1], m: +m[2], d: +m[3] } } };
  if (/(?:^|\s)(?:proximo|que viene)(?:\s|$)/.test(s)) return { error: "ambiguous" };
  m = /^(?:(cada|todos los|los|el|este) )?(.+)$/.exec(s);
  const list = dayList(m[2], ES_DAYS, "y");
  if (list) {
    if (m[1] === "cada" || m[1] === "todos los" || m[1] === "los" || list.plural) return { kind: "cron", dow: list.days.join(",") };
    if (list.days.length === 1) return { kind: "once", day: { dow: list.days[0] } };
    return { error: "ambiguous" };
  }
  return null;
}

function stepOf(word, unit) {
  const n = word === undefined ? 1 : numOf(word);
  if (n === null || n < 1) return { error: "unknown" };
  return { kind: "step", unit, n };
}
function inOf(word, scale) {
  const n = word === undefined ? (scale === 60 ? 1 : null) : numOf(word);
  if (n === null || n < 1 || n * scale > MAX_IN_MINUTES) return { error: "unknown" };
  return { kind: "in", minutes: n * scale };
}

const DIV60 = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const DIV24 = [1, 2, 3, 4, 6, 8, 12];
const near = (list, n) => [list.filter((x) => x < n).pop(), list.find((x) => x > n)].filter((x) => x !== undefined);

// --- wall-clock time in a zone ----------------------------------------------------------------

const fmtCache = new Map();
function partsAt(ms, zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(zone, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}
const offsetMin = (ms, zone) => { const p = partsAt(ms, zone); return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60_000); };

/** The first instant whose wall clock in `zone` reads ymd h:m, or null when that time does not exist (clocks jumped). */
function wallToMs({ y, m, d }, h, mi, zone) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offs = new Set([offsetMin(guess - 86_400_000 / 2, zone), offsetMin(guess, zone), offsetMin(guess + 86_400_000 / 2, zone)]);
  const hits = [];
  for (const o of offs) {
    const t = guess - o * 60_000;
    const p = partsAt(t, zone);
    if (p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === mi) hits.push(t);
  }
  return hits.length ? Math.min(...hits) : null;
}

const pad = (n) => String(n).padStart(2, "0");
/** "2026-10-27T15:00:00-05:00": the instant as wall time in `zone`, with that zone's offset. */
function isoInZone(ms, zone) {
  const p = partsAt(ms, zone);
  const o = offsetMin(ms, zone);
  const sign = o < 0 ? "-" : "+";
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
}

// --- words back from the cron -----------------------------------------------------------------

function timeWords(h, m, lang) {
  if (lang === "es") return `${h === 1 ? "a la" : "a las"} ${h}:${pad(m)}`;
  return `at ${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}
function joinList(items, lang) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${lang === "es" ? "y" : "and"} ${items.at(-1)}`;
}
const ordinal = (n) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const NUM = "(0|[1-9]\\d?)";

/**
 * Plain words for a cron expression, ONLY for the shapes parseWhen emits (no general cron-to-words
 * engine: day-of-month/day-of-week OR rules, ranges and steps would be easy to word wrongly).
 * null for anything else; the caller shows "Custom schedule" and the next runs.
 */
export function describeCron(cron, lang = "en") {
  const es = lang === "es";
  const f = String(cron ?? "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mon, dow] = f;
  if (mon !== "*") return null;
  if (f.join(" ") === "* * * * *") return es ? "Cada minuto" : "Every minute";
  let m = new RegExp(`^\\*/${NUM}$`).exec(mi);
  if (m && h === "*" && dom === "*" && dow === "*" && DIV60.includes(+m[1]) && +m[1] > 1) return es ? `Cada ${m[1]} minutos` : `Every ${m[1]} minutes`;
  if (mi !== "0" && !/^[1-5]?\d$/.test(mi)) return null;
  if (mi === "0" && h === "*" && dom === "*" && dow === "*") return es ? "Cada hora" : "Every hour";
  m = new RegExp(`^\\*/${NUM}$`).exec(h);
  if (m && mi === "0" && dom === "*" && dow === "*" && DIV24.includes(+m[1]) && +m[1] > 1) return es ? `Cada ${m[1]} horas` : `Every ${m[1]} hours`;
  if (!/^(?:1?\d|2[0-3])$/.test(h)) return null;
  const at = timeWords(+h, +mi, lang);
  if (dom === "*") {
    if (dow === "*") return es ? `Cada día ${at}` : `Every day ${at}`;
    if (dow === "1-5") return es ? `De lunes a viernes ${at}` : `Every weekday ${at}`;
    if (dow === "0,6") return es ? `Los fines de semana ${at}` : `Every weekend ${at}`;
    if (!/^[0-6](?:,[0-6])*$/.test(dow)) return null;
    const days = dow.split(",").map(Number);
    if (days.some((d, i) => i > 0 && d <= days[i - 1])) return null; // emitted lists are sorted, no repeats
    return `${es ? "Cada" : "Every"} ${joinList(days.map((d) => NAMES[es ? "es" : "en"][d]), lang)} ${at}`;
  }
  if (dow === "*" && /^(?:[1-9]|1\d|2[0-8])$/.test(dom)) return es ? `El día ${dom} de cada mes ${at}` : `On the ${ordinal(+dom)} of every month ${at}`;
  return null;
}

// --- messages ---------------------------------------------------------------------------------

const EXAMPLES = {
  en: '"every weekday at 8", "mondays and thursdays at 6pm", "every 2 hours", "on the 1st of every month at 9", "tomorrow at 3pm" or "in 20 minutes"',
  es: '"cada día laborable a las 8", "todos los lunes a las 18:00", "cada 2 horas", "el día 1 de cada mes a las 9", "mañana a las 15:00" o "en 20 minutos"',
};
function hint(code, lang, x = {}) {
  const es = lang === "es";
  switch (code) {
    case "empty": return es ? `Escribe cuándo, por ejemplo ${EXAMPLES.es}.` : `Say when, for example ${EXAMPLES.en}.`;
    case "too_long": return es ? `Es demasiado largo (máximo ${WHEN_MAX_CHARS} caracteres). Prueba con algo como ${EXAMPLES.es}.` : `That is too long (${WHEN_MAX_CHARS} characters at most). Try something like ${EXAMPLES.en}.`;
    case "two_times": return es ? "Pon una sola hora por horario. Para dos horas distintas, crea dos horarios." : "Give one time per schedule. For two different times, make two schedules.";
    case "bad_time": return es ? 'Esa hora no existe. Usa algo como "a las 8", "a las 19:30" o "a las 7 de la tarde".' : 'That is not a time of day. Use something like "at 8", "at 19:30" or "at 7:30pm".';
    case "no_time": return es ? `Falta la hora: por ejemplo "${x.example ?? "cada día laborable a las 8"}".` : `Add a time of day, for example "${x.example ?? "every weekday at 8"}".`;
    case "uneven": {
      const unit = x.unit === "hour" ? (es ? "horas" : "hours") : (es ? "minutos" : "minutes");
      const per = x.unit === "hour" ? (es ? "el día" : "the day") : (es ? "la hora" : "the hour");
      const alt = x.near.join(es ? " o " : " or ");
      return es ? `Cada ${x.n} ${unit} no reparte ${per} en partes iguales. Prueba cada ${alt} ${unit}.` : `Every ${x.n} ${unit} doesn't divide ${per} evenly. Try every ${alt} ${unit}.`;
    }
    case "too_frequent": return es ? `Los recordatorios se repiten como mucho cada hora (esto sería cada ${x.every} minutos). Prueba "cada hora" o "cada 2 horas".` : `Reminders repeat at most once an hour (this would be every ${x.every} minutes). Try "every hour" or "every 2 hours".`;
    case "day_of_month": return es ? "Elige un día del 1 al 28: los meses sin ese día se saltarían." : "Pick a day from the 1st to the 28th: months without that day would be skipped.";
    case "past": return es ? "Esa fecha y hora ya pasaron. Elige una en el futuro." : "That date and time have already passed. Pick one in the future.";
    case "ambiguous": return es
      ? 'No está claro qué día es. Di "el viernes" (el próximo que llega), "cada lunes y jueves" para repetir, o una fecha como "el 2026-11-03".'
      : 'It is not clear which day that is. Say "on friday" (the next one to come), "every monday and thursday" to repeat, or a date like "on 2026-11-03".';
    case "no_such_time": return es ? "Esa hora no existe ese día (cambio de hora). Elige otra hora." : "That time does not exist that day (the clocks change). Pick another time.";
    case "bad_date": return es ? "Esa fecha no existe. Usa el formato 2026-11-03." : "That date does not exist. Use the form 2026-11-03.";
    default: return es ? `No entiendo cuándo. Prueba con algo como ${EXAMPLES.es}, o una expresión cron de 5 campos.` : `I couldn't tell when that is. Try something like ${EXAMPLES.en}, or a 5-field cron expression.`;
  }
}

// --- the parser -------------------------------------------------------------------------------

const RAW_CRON = /^[0-9*/,-]+(?: [0-9a-z*/,-]+){4}$/i;

function preview(ms, lang, zone) {
  const text = new Intl.DateTimeFormat(lang === "es" ? "es" : "en-US", {
    timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(ms)).replace(/[  ]/g, " ");
  return { iso: isoInZone(ms, zone), text };
}

/** Parse one language's grammar. null = these are not this language's words. */
function parseIn(s, lang, zone, now) {
  const t = takeTime(s, lang);
  if (t.error) return { error: t.error };
  const d = dayPhrase(t.rest, lang);
  if (d === null) return null;
  if (d.error) return d;
  const { time } = t;

  if (d.kind === "step") {
    if (time) return { error: "unknown" };
    if (d.unit === "minute") {
      if (d.n === 60) return { cron: "0 * * * *" };
      if (!DIV60.includes(d.n)) return d.n > 60 ? { error: "unknown" } : { error: "uneven", unit: "minute", n: d.n, near: near(DIV60, d.n) };
      return { cron: d.n === 1 ? "* * * * *" : `*/${d.n} * * * *` };
    }
    if (d.n === 1) return { cron: "0 * * * *" };
    if (!DIV24.includes(d.n)) return d.n > 24 ? { error: "unknown" } : { error: "uneven", unit: "hour", n: d.n, near: near(DIV24, d.n).filter((x) => x > 1) };
    return { cron: `0 */${d.n} * * *` };
  }
  if (d.kind === "in") {
    if (time) return { error: "unknown" };
    // Whole minutes from now: "in 20 minutes" at 10:00:40 is 10:20:40 → 10:20:00 would be early; round up.
    const at = Math.ceil((now + d.minutes * 60_000) / 60_000) * 60_000;
    return { at };
  }
  if (d.kind === "cron") {
    if (!time) return { error: "no_time", example: lang === "es" ? `${t.rest} a las 8` : `${t.rest} at 8` };
    if (d.dom !== undefined) {
      if (d.dom < 1 || d.dom > 31) return { error: "unknown" };
      if (d.dom > 28) return { error: "day_of_month" };
      return { cron: `${time.m} ${time.h} ${d.dom} * *` };
    }
    return { cron: `${time.m} ${time.h} * * ${d.dow}` };
  }
  // One time.
  if (!time) return { error: "no_time", example: lang === "es" ? "mañana a las 9" : "tomorrow at 9" };
  const today = localYmd(now, zone);
  const at = (ymd) => wallToMs(ymd, time.h, time.m, zone);
  const day = d.day;
  let ms;
  if (day === "bare" || day === "today" || day === "tomorrow") {
    ms = at(day === "tomorrow" ? fromDayNum(dayNum(today) + 1) : today);
    if (day === "bare" && (ms === null || ms <= now)) ms = at(fromDayNum(dayNum(today) + 1)); // a bare time already past → tomorrow
    if (ms === null) return { error: "no_such_time" };
    if (ms <= now) return { error: "past" };
    return { at: ms };
  }
  if (day.ymd) {
    const back = fromDayNum(dayNum(day.ymd));
    if (back.y !== day.ymd.y || back.m !== day.ymd.m || back.d !== day.ymd.d) return { error: "bad_date" };
    ms = at(day.ymd);
    if (ms === null) return { error: "no_such_time" };
    if (ms <= now) return { error: "past" }; // an explicit date is never rolled
    return { at: ms };
  }
  // A named weekday: the next one to come — today if its time is still ahead, else next week.
  const todayDow = (((dayNum(today) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
  let delta = (day.dow - todayDow + 7) % 7;
  ms = at(fromDayNum(dayNum(today) + delta));
  if (delta === 0 && ms !== null && ms <= now) { delta = 7; ms = at(fromDayNum(dayNum(today) + delta)); }
  if (ms === null) return { error: "no_such_time" };
  return { at: ms };
}

/**
 * @param {string} text the user's words (or a raw 5-field cron)
 * @param {{lang?:'en'|'es', tz?:string|null, now?:number, type?:'reminder'|'bot_routine'}} opts
 *   tz: the schedule's zone, or the instance's (an invalid one falls back to the host's)
 *   type: reminders (the default) may repeat at most hourly
 */
export function parseWhen(text, { lang = "en", tz = null, now = Date.now(), type = "reminder" } = {}) {
  lang = String(lang).toLowerCase().startsWith("es") ? "es" : "en";
  const zone = zoneFor(tz);
  const fail = (code, x) => ({ ok: false, code, hint: hint(code, lang, x) });
  const raw = typeof text === "string" ? text : "";
  if (raw.length > WHEN_MAX_CHARS) return fail("too_long");
  const s = fold(raw);
  if (!s) return fail("empty");

  let r;
  const cronText = raw.trim().replace(/\s+/g, " ");
  if (RAW_CRON.test(cronText)) {
    r = cronNext(cronText, zone, now) === null ? { error: "unknown" } : { cron: cronText, raw: true };
  } else {
    // The asked language first, then the other one (a Spanish phrase on an English instance).
    // A language that does not know the words (null, or "unknown") gives way to the other.
    const known = (x) => x && x.error !== "unknown";
    const first = parseIn(s, lang, zone, now);
    r = known(first) ? first : parseIn(s, lang === "es" ? "en" : "es", zone, now);
    if (!known(r)) r = { error: "unknown" };
  }
  // For a reminder, any minute step is too frequent: say that first, not "pick an even gap".
  if (r.error === "uneven" && r.unit === "minute" && type === "reminder") r = { error: "too_frequent", every: r.n };
  if (r.error) return fail(r.error, r);

  if (r.at !== undefined) {
    const p = preview(r.at, lang, zone);
    const when = new Intl.DateTimeFormat(lang === "es" ? "es" : "en-US", { timeZone: zone, dateStyle: "full", timeStyle: "short" })
      .format(new Date(r.at)).replace(/[  ]/g, " ");
    return { ok: true, cron: ONCE, at: p.iso, summary: `${lang === "es" ? "Una vez" : "Once"}: ${when}`, next3: [p], zone };
  }

  const every = cadenceMinutes(r.cron, zone, now);
  if (type === "reminder" && every !== null && every < MIN_REMINDER_EVERY) return fail("too_frequent", { every });
  const next3 = [];
  let t = now;
  for (let i = 0; i < 3; i++) {
    t = cronNext(r.cron, zone, t);
    if (t === null) break;
    next3.push(preview(t, lang, zone));
  }
  if (!next3.length) return fail("unknown");
  const summary = (r.raw ? null : describeCron(r.cron, lang)) ?? (lang === "es" ? "Horario personalizado" : "Custom schedule");
  return { ok: true, cron: r.cron, summary, next3, every, zone };
}
