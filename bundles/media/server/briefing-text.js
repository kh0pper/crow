/**
 * The words of a briefing: cleaning feed text for speech, choosing stories, and writing the script.
 * Pure functions (no database, no clock of their own). No model is involved: this is the plain
 * writer, and every sentence it speaks comes from the feed item it names.
 */
import { localParts } from "./zone.js";
import { tr } from "./strings.js";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", laquo: "«", raquo: "»", deg: "°", euro: "€", pound: "£" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? " ";
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 31 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : " ";
  });
}
const stripTags = (s) => s.replace(/<(script|style)\b[^>]{0,500}>[\s\S]{0,20000}?<\/\1\s*>/gi, " ").replace(/<[^>]{0,2000}>/g, " ");

/**
 * Feed text → words a voice can read: markup and entity-encoded markup removed, entities decoded,
 * addresses dropped, boilerplate ("Read more", "The post … appeared first on …", "[…]") dropped,
 * whitespace collapsed. Input is capped, and every pattern is bounded.
 */
export function cleanForSpeech(input) {
  let s = String(input ?? "").slice(0, 20_000);
  // Twice: some feeds entity-encode their markup, so decoding reveals tags (and "&amp;amp;").
  for (let i = 0; i < 2; i++) s = decodeEntities(stripTags(s));
  s = stripTags(s)
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']{1,500}/gi, " ")
    .replace(/\[\s*(?:…|\.{3}|read more|more)\s*\]/gi, " ")
    .replace(/\bThe post\b[^.]{0,300}\bappeared first on\b[^.]{0,200}\./gi, " ")
    .replace(/\b(?:Read more|Continue reading|Read the full (?:story|article)|Click here)\b[^.]{0,120}(?:\.|$)/gi, " ")
    .replace(/[\x00-\x1f\x7f\p{Zs}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  return s;
}

/** The first `count` sentences, at most `maxChars`, ending cleanly. */
export function firstSentences(text, count = 2, maxChars = 400) {
  const sentences = String(text ?? "").split(/(?<=[.!?…]["”’)]?)\s+(?=[A-ZÁÉÍÓÚÑ¿¡"“‘(\d])/).slice(0, count);
  let out = "";
  for (const s of sentences) {
    if (out && out.length + 1 + s.length > maxChars) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const kept = cut.slice(0, Math.max(cut.lastIndexOf(" "), maxChars - 60)).replace(/[\s,;:–—-]+$/, "");
    out = /[.!?…]$/.test(kept) ? kept : `${kept}…`;
  }
  if (out && !/[.!?…]["”’)]?$/.test(out)) out += ".";
  return out;
}

/**
 * A source's name as a voice should say it: a feed's channel title often carries a tagline after a
 * separator ("Al Jazeera – Breaking News, World News…", "NYT > Top Stories", "PBS NewsHour - The
 * Latest", "NOTUS | News of the United States"). Only the part before the first spaced separator is
 * spoken, unless that part would be too short to name anything.
 */
export function spokenSourceName(name) {
  const full = cleanForSpeech(name);
  const head = full.split(/\s(?:[|>–—-]|::)\s/)[0].trim();
  return head.length >= 2 ? head : full;
}

const titleKey = (t) => String(t).toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Stories for a briefing from candidate rows (newest first; site feeds only is the query's job).
 * One story per source, newest sources first, then a second round, at most `perSource` each:
 * a busy source cannot fill the briefing. Same-title items are told once.
 */
export function selectStories(rows, { maxStories = 8, perSource = 2 } = {}) {
  const seen = new Set();
  const bySource = new Map();
  for (const r of rows || []) {
    const title = cleanForSpeech(r.title);
    const key = titleKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let text = firstSentences(cleanForSpeech(r.summary) || cleanForSpeech(r.content_full));
    if (titleKey(text) === key || titleKey(text).length < 12) text = "";
    const list = bySource.get(r.source_id) || [];
    if (list.length >= perSource) continue;
    list.push({ article_id: Number(r.id), title, text, source: spokenSourceName(r.source_name) || "your sources", link: /^https?:\/\//i.test(r.url || "") ? r.url : null });
    bySource.set(r.source_id, list);
  }
  const out = [];
  for (let round = 0; round < perSource && out.length < maxStories; round++) {
    for (const list of bySource.values()) {
      if (list[round] && out.length < maxStories) out.push(list[round]);
    }
  }
  return out;
}

const ORDINAL = (n) => { const v = n % 100; return `${n}${v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`; };

/** Day and date as spoken, time of day, and a short clock time, in the briefing's zone and language. */
export function spokenWhen(ms, tz, lang = "en") {
  const locale = lang === "es" ? "es-MX" : "en-US";
  const part = (opts) => new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(new Date(ms));
  const p = localParts(ms, tz);
  const weekday = part({ weekday: "long" });
  const month = part({ month: "long" });
  return {
    weekday: lang === "es" ? weekday : weekday[0].toUpperCase() + weekday.slice(1),
    date: lang === "es" ? `${p.day} de ${month}` : `${month} ${ORDINAL(p.day)}`,
    daypart: p.hour < 12 ? "morning" : p.hour < 18 ? "afternoon" : "evening",
    time: part({ hour: "numeric", minute: "2-digit" }).replace(/\p{Zs}/gu, " "),
    ymd: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
    dow: p.dow,
  };
}

export function briefingTitle({ kind, topic, when, lang }) {
  if (kind === "daily") return tr(`title_${when.daypart}`, lang, when);
  if (topic) return tr("title_topic", lang, { ...when, topic: cleanForSpeech(topic).slice(0, 60) });
  return tr("title_manual", lang, when);
}

/**
 * The script: one paragraph per chapter. The first sentence pair always states the day and date,
 * so a briefing can never be taken for another day's. `show` is the name of a show that follows
 * the narration (the closing line is true whether or not it has been published yet).
 * → { paragraphs: string[], chapters: string[] } (same length, same order)
 */
export function buildScript({ stories, when, lang = "en", show = null }) {
  const n = stories.length;
  const count = n === 0 ? tr("intro_none", lang) : n === 1 ? tr("intro_one", lang) : tr("intro_count", lang, { n });
  const paragraphs = [`${tr(`greet_${when.daypart}`, lang)} ${tr("intro_date", lang, when)} ${count}`];
  const chapters = [tr("chapter_intro", lang)];
  for (const s of stories) {
    const title = /[.!?…]["”’)]?$/.test(s.title) ? s.title : `${s.title}.`;
    paragraphs.push([tr("story_from", lang, { source: s.source }), title, s.text].filter(Boolean).join(" "));
    chapters.push(s.title);
  }
  paragraphs.push(show ? tr("outro_show", lang, { show: cleanForSpeech(show).slice(0, 80) }) : tr("outro", lang));
  chapters.push(tr("chapter_end", lang));
  return { paragraphs, chapters };
}
