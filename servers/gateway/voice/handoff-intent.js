/**
 * Hand-off intent (PR 3, Task 3.5): is a spoken request bigger work for a bot ("research…", "write it up",
 * "have writer…"), a question about a hand-off ("how's it going?"), or a stop ("stop writer", "cancel it")?
 * The voice turn offers the hand-off tool only when wantsHandoff says so.
 *
 * Plain en/es phrase lists compared word by word (tool-families.js phraseWords/listMatches: capped at
 * INTENT_MAX_CHARS, accents and apostrophes dropped), never a pattern: a bot's name comes from its owner,
 * and a name-built pattern would make every voice turn slow.
 */
import { phraseWords, normalizeIntentLists, listMatches, MAX_PHRASES, MAX_PHRASE_WORDS } from "./tool-families.js";
import { HANDOFF_TARGET_PHRASES } from "./handoff-constants.js";

export { HANDOFF_TARGET_PHRASES };

const freezeLists = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, l]) => [k, Object.freeze({ en: Object.freeze(l.en), es: Object.freeze(l.es) })])));

/** The raw en/es lists (the tests read them for parity). */
export const HANDOFF_INTENT_WORDS = freezeLists({
  work: {
    en: ["research", "look into", "find out about", "write up", "write it up", "write a report", "write a document", "write a summary", "draft a", "create a document", "make a document", "make a report", "make a presentation", "automate", "set up an automation", "in depth", "hand this to", "hand it to", "give this to", "give it to", "write me a report", "put together a report", "prepare a presentation"],
    es: ["investiga", "investigar", "averigua", "redacta", "escribe un informe", "escribe un documento", "escribe un resumen", "crea un documento", "haz un informe", "automatiza", "a fondo", "pasale esto a", "dale esto a", "pidele a", "haz una investigacion", "prepara un informe", "hazme un resumen"],
  },
  // No wildcards: "how is <bot> doing" and "is <bot> done" are a code check (statusNamesBot). "ya esta" alone
  // is everyday Spanish ("ya está bien"), so it counts only with a done word after it.
  status: {
    en: ["how is it going", "hows it going", "is it done", "status of", "any news on", "how far along"],
    es: ["como va", "como lo lleva", "ya termino", "ya esta listo", "ya esta lista", "ya esta hecho", "ya esta hecha", "ya esta terminado", "ya esta terminada"],
  },
  stopVerbs: { en: ["stop", "cancel", "halt"], es: ["para", "deten", "cancela"] },
  stopTargets: { en: ["the research", "that research", "the task", "that task", "the hand off", "the handoff"], es: ["la tarea", "esa tarea", "la investigacion", "esa investigacion", "el encargo", "ese encargo"] },
  stopPronouns: { en: ["stop it", "cancel it", "stop that", "cancel that"], es: ["paralo", "cancelalo", "detenlo", "cancela eso", "para eso"] },
});

const LISTS = Object.freeze(Object.fromEntries(Object.entries(HANDOFF_INTENT_WORDS).map(([k, l]) => [k, Object.freeze(normalizeIntentLists(l))])));
const STOP_VERBS = new Set(LISTS.stopVerbs.map((p) => p.join(" ")));
// A bot name made only of these is dropped: a bot called "the" or "it" would otherwise match everything.
const STOPWORDS = new Set(["the", "a", "an", "it", "that", "this", "to", "of", "and", "or", "is", "el", "la", "lo", "los", "las", "un", "una", "eso", "esto", "que", "de", "y", "en", "por", "para"]);
// "don't stop writer", "do not cancel it", "never halt that task": a negated verb is not a stop.
const NEGATIONS = new Set(["dont", "not", "never"]);
// Never "no": "no, stop writer" is a stop (phraseWords drops the comma).

/**
 * Bot names and ids as word lists: strings only, at most MAX_PHRASES of them, each cut to MAX_PHRASE_WORDS
 * words, none made only of STOPWORDS.
 */
function botPhrases(botNames) {
  if (!Array.isArray(botNames)) return [];
  const out = [];
  for (const b of botNames.slice(0, MAX_PHRASES)) {
    if (typeof b !== "string") continue;
    const w = phraseWords(b).slice(0, MAX_PHRASE_WORDS);
    if (w.length && !w.every((x) => STOPWORDS.has(x))) out.push(w);
  }
  return out;
}

/** The length of the first phrase in `phrases` that starts at words[i], or 0. */
function matchAt(words, i, phrases) {
  for (const p of phrases) {
    if (i + p.length > words.length) continue;
    let k = 0;
    while (k < p.length && words[i + k] === p[k]) k++;
    if (k === p.length) return p.length;
  }
  return 0;
}

/**
 * Is this bigger work for a bot? A work phrase, or any whole bot name or id. A name alone is enough, so
 * "have writer…", "ask hank…", "get writer to…" and "que writer…" need no rule of their own.
 */
export function wantsHandoff(transcript, botNames) {
  const words = phraseWords(transcript);
  if (!words.length) return false;
  return listMatches(words, LISTS.work) || listMatches(words, botPhrases(botNames));
}

/**
 * A status phrase, or "how is <bot> doing" / "how's <bot> doing" / "is <bot> done" (an optional "the" before
 * the name). "how is it going to…" and "como va a…" are not.
 */
export function wantsHandoffStatus(transcript, botNames = []) {
  const words = phraseWords(transcript);
  if (!words.length) return false;
  const bots = botPhrases(botNames);
  for (let i = 0; i < words.length; i++) {
    const n = matchAt(words, i, LISTS.status);
    if (n) {
      const said = words.slice(i, i + n).join(" ");
      const next = words[i + n];
      // "how is it going to rain", "como va a estar el clima": a future, not a progress question.
      if (!((said === "how is it going" || said === "hows it going") && next === "to") && !(said === "como va" && next === "a")) return true;
    }
    const howLead = words[i] === "hows" ? 1 : words[i] === "how" && words[i + 1] === "is" ? 2 : 0;
    const lead = howLead || (words[i] === "is" ? 1 : 0);
    if (lead) {
      const at = i + lead + (words[i + lead] === "the" ? 1 : 0);
      const b = matchAt(words, at, bots);
      if (b && words[at + b] === (howLead ? "doing" : "done")) return true;
    }
  }
  return false;
}

// Words that may come before a sentence-initial "para" (a stop), and after a target or a pronoun at the end.
const PARA_LEADS = new Set(["hey", "ok", "okay", "crow", "oye", "bueno", "por", "favor", "ya"]);
const END_WORDS = new Set(["please", "now", "right", "thanks", "crow", "por", "favor", "ya", "ahora", "mismo", "gracias"]);
const endsAt = (words, j) => words.slice(j).every((w) => END_WORDS.has(w));
const negated = (words, i) => i > 0 && NEGATIONS.has(words[i - 1]);
const paraOpens = (words, i) => words.slice(0, i).every((w) => PARA_LEADS.has(w));

/**
 * "named": a stop verb (stop, cancel, halt, para, detén, cancela) followed by a bot name or a work word ("the
 * research", "la tarea"; Spanish may put "a" between: "detén a writer"). "pronoun": "stop it", "cancel that",
 * "páralo", "cancela eso"… ending the sentence ("stop that song" is not one). null otherwise.
 * "para" is also "for" ("una nota para writer"): it is a stop only as the first word (after lead-ins such as
 * "oye crow") with its target ending the sentence. A verb right after a negation ("don't stop writer") is not one.
 */
export function wantsHandoffStop(transcript, botNames) {
  const words = phraseWords(transcript);
  if (!words.length) return null;
  const targets = [...LISTS.stopTargets, ...botPhrases(botNames)];
  for (let i = 0; i < words.length; i++) {
    if (!STOP_VERBS.has(words[i]) || negated(words, i)) continue;
    const isPara = words[i] === "para";
    if (isPara && !paraOpens(words, i)) continue;
    for (const j of words[i + 1] === "a" ? [i + 1, i + 2] : [i + 1]) {
      const n = matchAt(words, j, targets);
      if (n && (!isPara || endsAt(words, j + n))) return "named";
    }
  }
  for (let i = 0; i < words.length; i++) {
    const n = matchAt(words, i, LISTS.stopPronouns);
    if (n && endsAt(words, i + n) && !negated(words, i) && (words[i] !== "para" || paraOpens(words, i))) return "pronoun";
  }
  return null;
}
