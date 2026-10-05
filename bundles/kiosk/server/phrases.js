/**
 * T0: control phrases. A fixed table of whole utterances, English and Spanish, compared as WORD
 * LISTS after dropping polite lead-ins and tails — never a pattern built from the table. A phrase
 * only says what was asked; whether it may act (its target exists) is the executor's rule.
 */
import { INTENT_MAX_CHARS } from "./intent-text.js";

/** Plain words of a short utterance: no accents, apostrophes or punctuation; "what is" → "whats". null when empty or too long to be a control phrase. */
export function spokenWords(t) {
  if (typeof t !== "string" || t.length > INTENT_MAX_CHARS) return null;
  // "we're / you're / they're" are statements: kept apart from "were", a question opener (revision 6).
  const s = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(we|you|they)['’]re\b/g, "$1 are").replace(/['’]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/ +/g, " ").trim()
    .replace(/\bwhat is\b/g, "whats").replace(/\bwho is\b/g, "whos").replace(/\bthat is\b/g, "thats");
  return s ? s.split(" ") : null;
}

const byLength = (list) => list.map((p) => p.split(" ")).sort((a, b) => b.length - a.length);
const LEADS = byLength(["hey crow", "ok crow", "okay crow", "oye crow", "hey", "ok", "okay", "oye", "hola", "vale", "please", "por favor", "crow",
  "can you please", "could you please", "can you", "could you", "would you", "will you", "puedes", "podrias", "me puedes", "me podrias", "now", "just", "and", "so", "ahora", "y"]);
const TAILS = byLength(["please", "por favor", "thanks", "thank you", "gracias", "now", "right now", "for me", "ahora", "crow"]);
export const sameAt = (w, at, p) => p.every((x, i) => w[at + i] === x);

/** Drop polite lead-ins and tails. Every step removes at least one word and always leaves one. */
export function stripPolite(w) {
  let start = 0, end = w.length;
  for (;;) { const p = LEADS.find((x) => start + x.length < end && sameAt(w, start, x)); if (!p) break; start += p.length; }
  for (;;) { const p = TAILS.find((x) => end - x.length > start && sameAt(w, end - x.length, x)); if (!p) break; end -= p.length; }
  return w.slice(start, end);
}

/** The words that name a KIND of window ("the timer", "la lista"), en + es. */
export const KIND_NOUNS = Object.freeze({ timer: "timer", timers: "timer", alarm: "timer", countdown: "timer", temporizador: "timer", alarma: "timer", recipe: "recipe", steps: "recipe", receta: "recipe",
  list: "content", card: "content", note: "content", text: "content", lista: "content", tarjeta: "content", nota: "content" });

/** verb → the whole utterances that mean it. `next` is the bare word: the executor decides what it steps. */
export const T0_PHRASES = Object.freeze({
  close: {
    en: ["close", "close it", "close that", "close this", "close the window", "close this window", "close that window", "dismiss", "dismiss it", "dismiss that", "hide it", "hide that", "get rid of it", "get rid of that"],
    es: ["cierra", "cierralo", "cierrala", "cierra eso", "cierra esto", "cierra la ventana", "cierra esa ventana", "quita eso", "quitalo", "ocultalo"],
  },
  close_all: {
    en: ["close everything", "close all", "close all windows", "close all the windows", "close them all", "clear the screen", "clear the display", "clear everything"],
    es: ["cierra todo", "cierralo todo", "cierra todas las ventanas", "limpia la pantalla", "borra la pantalla", "quita todo"],
  },
  next: { en: ["next", "next one"], es: ["siguiente", "la siguiente"] },
  next_step: {
    en: ["next step", "the next step", "whats next", "whats the next step", "go to the next step"],
    es: ["siguiente paso", "el siguiente paso", "proximo paso", "cual es el siguiente paso", "que sigue"],
  },
  // "last step" is not here: it can mean the final step as easily as the one before.
  previous_step: {
    en: ["previous step", "the previous step", "go back a step", "back a step", "the step before"],
    es: ["paso anterior", "el paso anterior", "vuelve un paso", "regresa un paso"],
  },
  read_step: {
    en: ["read the step", "read that step", "read that step again", "read the step again", "repeat the step", "repeat that step", "say that step again", "whats the step", "what was that step"],
    es: ["lee el paso", "lee ese paso", "repite el paso", "repite ese paso", "lee el paso otra vez", "cual es el paso"],
  },
});
/** verb → prefixes that take a name after them ("close the rice timer"). */
export const T0_SLOTS = Object.freeze({
  close: { en: ["close the", "close my", "dismiss the", "hide the", "get rid of the", "stop the"], es: ["cierra el", "cierra la", "quita el", "quita la", "oculta el", "oculta la", "deten el", "deten la"] },
});
/**
 * Prefixes that are a command only when a KIND noun follows at once. Spanish "para el / para la"
 * is "stop the" and also "for the": "para el temporizador" stops a timer, "para la pasta" is not a command.
 */
export const T0_KIND_SLOTS = Object.freeze({ close: { en: [], es: ["para el", "para la"] } });

const PHRASE_VERB = new Map();
for (const [verb, l] of Object.entries(T0_PHRASES)) for (const p of [...l.en, ...l.es]) PHRASE_VERB.set(p, verb);
const prefixes = (table) => Object.entries(table).map(([verb, l]) => [verb, byLength([...l.en, ...l.es])]);
const SLOT_PREFIXES = prefixes(T0_SLOTS);
const KIND_SLOT_PREFIXES = prefixes(T0_KIND_SLOTS);
export const T0_MAX_WORDS = 8;
export const SLOT_MAX_WORDS = 4;

/** → { verb } | { verb, name } | null. */
export function matchT0(transcript) {
  const all = spokenWords(transcript);
  if (!all) return null;
  const w = stripPolite(all);
  if (!w.length || w.length > T0_MAX_WORDS) return null;
  const verb = PHRASE_VERB.get(w.join(" "));
  if (verb) return { verb };
  const fits = (p) => w.length > p.length && w.length - p.length <= SLOT_MAX_WORDS && sameAt(w, 0, p);
  for (const [v, list] of SLOT_PREFIXES) for (const p of list) if (fits(p)) return { verb: v, name: w.slice(p.length).join(" ") };
  for (const [v, list] of KIND_SLOT_PREFIXES) for (const p of list) if (fits(p) && Object.hasOwn(KIND_NOUNS, w[p.length])) return { verb: v, name: w.slice(p.length).join(" ") };
  return null;
}
