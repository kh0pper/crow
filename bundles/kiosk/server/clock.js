/**
 * The display's clock for the voice turn (live test 2026-10-04: "What time is it?" →
 * "I don't have access to the current time."). Two pieces:
 *  - kioskNowContext(): local weekday, date, time and zone for THIS turn's user message
 *    (never the system message — it changes every minute and would break the prefix cache);
 *  - matchClockFastPath(): the plain "what time is it" / "what's the date" family (en + es),
 *    answered with no model call.
 * The zone is the one the page reports in `hello` (validated here); without one, the server's.
 */
import { INTENT_MAX_CHARS } from "./intent-text.js";

const SPACES = /[\u00a0\u202f]/g;   // ICU puts a narrow no-break space before AM/PM

/** An IANA zone this runtime knows, or null. Length and shape are checked before Intl sees it. */
export function validTimeZone(tz) {
  if (typeof tz !== "string" || tz.length < 1 || tz.length > 64 || !/^[A-Za-z0-9_+/-]+$/.test(tz)) return null;
  const parts = tz.split("/");
  if (parts.length > 3 || parts.some((x) => !x) || !/^[A-Za-z]/.test(tz)) return null;
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
 * to spaces, "what is" → "whats"). A question is a shortcut when it is exactly lead-ins, ONE
 * core phrase, tails — so "what time is the game" or "what's the date of the meeting" never match.
 *
 * Matched by comparing WORD LISTS, never by a pattern generated from the table: lead-ins overlap
 * ("hey crow" is also "hey" then "crow"), and a repeated group over overlapping alternatives is
 * exponential on input like "hey crow hey crow … x". Here every step drops at least one word, and
 * the transcript is capped (intent-text.js) before anything looks at it.
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
  tomorrow_en: {
    leads: EN_LEADS,
    cores: ["what day is tomorrow", "what day is it tomorrow", "what date is tomorrow", "what date is it tomorrow", "whats tomorrows date", "whats the date tomorrow", "tomorrows date", "what day will it be tomorrow"],
    tails: ["please", "crow", "thanks", "thank you"],
  },
  yesterday_en: {
    leads: EN_LEADS,
    cores: ["what day was yesterday", "what day was it yesterday", "what date was yesterday", "what date was it yesterday", "what was yesterdays date", "what was the date yesterday", "yesterdays date", "whats yesterdays date"],
    tails: ["please", "crow", "thanks", "thank you"],
  },
  tomorrow_es: {
    leads: ES_LEADS,
    cores: ["que dia es manana", "que fecha es manana", "que dia sera manana", "que dia va a ser manana", "la fecha de manana"],
    tails: ["por favor", "gracias", "crow"],
  },
  yesterday_es: {
    leads: ES_LEADS,
    cores: ["que dia fue ayer", "que fecha fue ayer", "que dia era ayer", "la fecha de ayer"],
    tails: ["por favor", "gracias", "crow"],
  },
});
const words = (phrase) => phrase.split(" ");
const byLength = (list) => list.map(words).sort((a, b) => b.length - a.length);
const TABLE = Object.fromEntries(Object.entries(CLOCK_PHRASES).map(([k, t]) => [k, {
  leads: byLength(t.leads), tails: byLength(t.tails), cores: new Set(t.cores),
  maxCore: Math.max(...t.cores.map((c) => words(c).length)),
}]));
const sameAt = (w, at, phrase) => phrase.every((x, i) => w[at + i] === x);

/** Calendar days in the display's zone. All arithmetic is on whole days in UTC, so no DST hour can shift a date. */
function localYmd(now, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zoneOf(tz), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return { y: g("year"), m: g("month"), d: g("day") };
}
const dayNum = ({ y, m, d }) => Math.round(Date.UTC(y, m - 1, d) / 86400000);
const fromDayNum = (n) => { const t = new Date(n * 86400000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const validYmd = ({ y, m, d }) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const fmtYmd = (locale, ymd, opts) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12))).replace(SPACES, " ");
const LONG = { month: "long", day: "numeric", year: "numeric" };
const SHORT = { month: "long", day: "numeric" };
const WEEKDAY = { weekday: "long" };

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
});
const ORDINALS = Object.freeze({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, primero: 1, uno: 1 });
/** Fixed-date names only (the same day every year, everywhere). */
const NAMED_DAYS = Object.freeze({
  christmas: [12, 25], "christmas day": [12, 25], "christmas eve": [12, 24], "new years day": [1, 1], "new years": [1, 1], "new years eve": [12, 31], halloween: [10, 31], "valentines day": [2, 14],
  navidad: [12, 25], nochebuena: [12, 24], "ano nuevo": [1, 1], nochevieja: [12, 31], "san valentin": [2, 14], "el dia de san valentin": [2, 14],
});
const TENS = Object.freeze({ twenty: 20, thirty: 30, veinte: 20, treinta: 30 });
/** "twenty fifth" → "25", "thirty first" → "31" (speech-to-text writes either form). Other words pass through. */
function joinOrdinals(a) {
  const out = [];
  for (let i = 0; i < a.length; i += 1) {
    const unit = Object.hasOwn(TENS, a[i]) && Object.hasOwn(ORDINALS, a[i + 1] ?? "") ? ORDINALS[a[i + 1]] : 0;
    if (unit >= 1 && unit <= 9) { out.push(String(TENS[a[i]] + unit)); i += 1; } else out.push(a[i]);
  }
  return out;
}
/** "25" | "25th" | "fifth" … → 1..31, else null. No pattern: digits are read one by one. */
function dayOf(word) {
  if (Object.hasOwn(ORDINALS, word)) return ORDINALS[word];
  let i = 0, n = 0;
  while (i < word.length && i < 2 && word[i] >= "0" && word[i] <= "9") { n = n * 10 + (word.charCodeAt(i) - 48); i += 1; }
  if (i === 0) return null;
  const rest = word.slice(i);
  return (rest === "" || rest === "st" || rest === "nd" || rest === "rd" || rest === "th") && n >= 1 && n <= 31 ? n : null;
}
function yearOf(word) {
  if (!word || word.length !== 4) return null;
  let n = 0;
  for (const ch of word) { if (ch < "0" || ch > "9") return null; n = n * 10 + (ch.charCodeAt(0) - 48); }
  return n >= 1900 && n <= 2200 ? n : null;
}
/**
 * The whole of w must be one date: "december 25[th] [2026]", "[the] 25th of december [2026]",
 * "[el] 25 de diciembre [de 2026]", or a fixed-date name. → { m, d, y|null } | null.
 */
function parseNamedDate(w) {
  if (!w.length || w.length > 8) return null;
  const named = NAMED_DAYS[w.join(" ")] || (w[0] === "the" ? NAMED_DAYS[w.slice(1).join(" ")] : null);
  if (named) return { m: named[0], d: named[1], y: null };
  let a = joinOrdinals(w[0] === "the" || w[0] === "el" ? w.slice(1) : w.slice());
  let y = null;
  if (a.length > 2 && yearOf(a.at(-1)) != null) { y = yearOf(a.at(-1)); a = a.slice(0, -1); if (a.at(-1) === "de" || a.at(-1) === "del") a = a.slice(0, -1); }
  let m = null, d = null;
  if (a.length === 2 && Object.hasOwn(MONTHS, a[0])) { m = MONTHS[a[0]]; d = dayOf(a[1]); }                                                  // december 25th
  else if (a.length === 3 && Object.hasOwn(MONTHS, a[0]) && a[1] === "the") { m = MONTHS[a[0]]; d = dayOf(a[2]); }                           // december the 25th
  else if (a.length === 3 && (a[1] === "of" || a[1] === "de") && Object.hasOwn(MONTHS, a[2])) { d = dayOf(a[0]); m = MONTHS[a[2]]; }          // 25th of december / 25 de diciembre
  return m && d ? { m, d, y } : null;
}
/** No year: the next time the date comes round (today counts), or — for a "was" question — the last time it did. */
function resolveNamed(nd, today, past) {
  if (nd.y) { const c = { y: nd.y, m: nd.m, d: nd.d }; return validYmd(c) ? c : null; }
  for (let k = 0; k <= 8; k += 1) {
    const c = { y: past ? today.y - k : today.y + k, m: nd.m, d: nd.d };
    if (validYmd(c) && (past ? dayNum(c) <= dayNum(today) : dayNum(c) >= dayNum(today))) return c;
  }
  return null;
}

/** Slot questions: a prefix, then a date that must fill the rest. Word lists, longest first. */
const SLOTS = [
  { kind: "weekday", lang: "en", past: false, prefixes: ["what day of the week is", "what day is", "which day is", "what day does", "what day will"], tails: ["fall on", "be on", "be", "on", "this year"] },
  { kind: "weekday", lang: "en", past: true, prefixes: ["what day of the week was", "what day was", "which day was", "what day did"], tails: ["fall on", "on", "this year"] },
  { kind: "until", lang: "en", past: false, prefixes: ["how many days is it until", "how many days are there until", "how many days until", "how many days till", "how many days before", "how many days to"], tails: [] },
  { kind: "weekday", lang: "es", past: false, prefixes: ["que dia de la semana es", "que dia es", "que dia cae", "que dia sera"], tails: ["este ano"] },
  { kind: "weekday", lang: "es", past: true, prefixes: ["que dia de la semana fue", "que dia fue", "que dia cayo"], tails: ["este ano"] },
  { kind: "until", lang: "es", past: false, prefixes: ["cuantos dias faltan para", "cuantos dias quedan para", "cuantos dias hay hasta", "cuantos dias faltan hasta"], tails: [] },
].map((s) => ({ ...s, prefixes: byLength(s.prefixes), tails: byLength([...s.tails, "please", "por favor", "crow", "thanks", "thank you", "gracias"]) }));

/** → { kind, lang, past, date } | null. Lead-ins are dropped one at a time; each try is a few word comparisons. */
function matchDateSlot(w) {
  const leads = [...TABLE.date_en.leads, ...TABLE.date_es.leads];
  for (let start = 0; start < w.length;) {
    for (const s of SLOTS) for (const p of s.prefixes) {
      if (start + p.length >= w.length || !sameAt(w, start, p)) continue;
      let end = w.length;
      for (;;) { const tail = s.tails.find((t) => end - t.length > start + p.length && sameAt(w, end - t.length, t)); if (!tail) break; end -= tail.length; }
      const date = parseNamedDate(w.slice(start + p.length, end));
      if (date) return { kind: s.kind, lang: s.lang, past: s.past, date };
    }
    const lead = leads.find((l) => start + l.length < w.length && sameAt(w, start, l));
    if (!lead) return null;
    start += lead.length;
  }
  return null;
}
/** w[start..end) is a core phrase, or becomes one after dropping tails from its end / lead-ins from its start. */
function isAsk(w, t) {
  for (let start = 0; ;) {
    for (let end = w.length; ;) {
      if (end - start <= t.maxCore && t.cores.has(w.slice(start, end).join(" "))) return true;
      const tail = t.tails.find((p) => end - p.length > start && sameAt(w, end - p.length, p));
      if (!tail) break;
      end -= tail.length;
    }
    const lead = t.leads.find((p) => start + p.length < w.length && sameAt(w, start, p));
    if (!lead) return false;
    start += lead.length;
  }
}
function normalize(t) {
  if (typeof t !== "string" || t.length > INTENT_MAX_CHARS) return "";   // longer than any plain clock question
  return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\bwhat is\b/g, "whats");
}

/** → { say, events: [] } for the plain clock questions, else null (the model answers, with the [Now] context). */
export function matchClockFastPath(transcript, { now = Date.now(), tz = null } = {}) {
  const q = normalize(transcript);
  if (!q) return null;
  const w = q.split(" ");
  let say = null;
  if (isAsk(w, TABLE.time_en)) say = `It's ${fmt("en-US", TIME, now, tz)}.`;
  else if (isAsk(w, TABLE.date_en)) say = `Today is ${fmt("en-US", DATE, now, tz)}.`;
  else if (isAsk(w, TABLE.time_es)) {
    const hm = fmt("es", { ...TIME, hourCycle: "h23" }, now, tz);
    say = `${hm.startsWith("1:") ? "Es la" : "Son las"} ${hm}.`;
  } else if (isAsk(w, TABLE.date_es)) say = `Hoy es ${fmt("es", DATE, now, tz)}.`;
  if (!say) {
    const today = localYmd(now, tz);
    const rel = (delta) => fromDayNum(dayNum(today) + delta);
    if (isAsk(w, TABLE.tomorrow_en)) say = `Tomorrow is ${fmtYmd("en-US", rel(1), DATE)}.`;
    else if (isAsk(w, TABLE.yesterday_en)) say = `Yesterday was ${fmtYmd("en-US", rel(-1), DATE)}.`;
    else if (isAsk(w, TABLE.tomorrow_es)) say = `Mañana es ${fmtYmd("es", rel(1), DATE)}.`;
    else if (isAsk(w, TABLE.yesterday_es)) say = `Ayer fue ${fmtYmd("es", rel(-1), DATE)}.`;
    else {
      const q = matchDateSlot(w);
      const c = q ? resolveNamed(q.date, today, q.past) : null;
      if (c) {
        const n = dayNum(c) - dayNum(today);
        const en = q.lang === "en";
        const wd = fmtYmd(en ? "en-US" : "es", c, WEEKDAY);
        if (q.kind === "weekday") {
          if (n === 0) say = en ? `That's today, ${wd}.` : `Es hoy, ${wd}.`;
          else if (en) say = `${fmtYmd("en-US", c, LONG)} ${n < 0 ? "was" : "is"} a ${wd}.`;
          else say = `El ${fmtYmd("es", c, LONG)} ${n < 0 ? "fue" : "es"} ${wd}.`;
        } else if (n === 0) say = en ? "That's today." : "Es hoy.";
        else if (n === 1) say = en ? "It's tomorrow." : "Es mañana.";
        else if (n > 1) say = en ? `${n} days until ${fmtYmd("en-US", c, SHORT)}.` : `Faltan ${n} días para el ${fmtYmd("es", c, SHORT)}.`;
      }
    }
  }
  return say ? { say, events: [] } : null;
}
