/**
 * T1 and the display tools' word tests. Everything here reads the PLAIN transcript as a word list
 * (phrases.js spokenWords: capped, lower case, no accents) and compares words; there is no pattern
 * built from data and no capture.
 *
 *   parseOpen / parsePlay   an imperative at the START of the utterance, then a slot taken by word
 *                           index. This is T1 (no model) once the slot resolves on this display.
 *   mentionsOpen / mentionsPlay   the request is ABOUT opening / playing: wider than the parsers.
 *                           A display tool is OFFERED on these.
 *   asksOpen / asksPlay     the person is ASKING for it now (an imperative, or a mention together with
 *                           a request cue and no question word). The tool MUST run on these.
 *   compound                two requests in one sentence ("close the timer and then show me a list").
 */
import { spokenWords, stripPolite, sameAt } from "./phrases.js";

const ARTICLES = new Set(["the", "my", "our", "a", "an", "some", "el", "la", "los", "las", "mi", "mis", "un", "una", "algo", "de"]);
const OPEN_VERBS = [["open", "up"], ["open"], ["launch"], ["go", "to"], ["abre"], ["abreme"], ["abrir"], ["lanza"], ["ve", "a"]];
const PULL_VERBS = [["pull", "up"], ["bring", "up"]];   // looked up at T1 only; at the model these stay card verbs, as in 0.1.8
const PLAY_VERBS = [["play"], ["put", "on"], ["listen", "to"], ["reproduce"], ["reproducir"], ["toca"], ["quiero", "escuchar"], ["escuchar"], ["ponme"]];
// Spanish "pon" also sets timers and shows cards: it plays only with a media noun close behind it.
const PON_NOUNS = new Set(["musica", "radio", "noticias", "cancion", "canciones", "album", "disco", "emisora", "estacion"]);
// Never a play request: these belong to the card and timer verbs.
const NOT_PLAY = new Set(["screen", "display", "pantalla", "timer", "temporizador", "alarm", "alarma", "recipe", "receta", "lista", "outside", "afuera"]);
export const OPEN_MAX_WORDS = 10;
export const PLAY_MAX_WORDS = 16;

const startsWith = (w, p) => w.length > p.length && p.every((x, i) => w[i] === x);
/** Words after the verb, minus leading articles (one word always stays). */
const slot = (w, n) => { let i = n; while (i < w.length - 1 && ARTICLES.has(w[i])) i += 1; return w.slice(i); };
function words(transcript, max) {
  const all = spokenWords(transcript);
  if (!all) return null;
  const w = stripPolite(all);
  return w.length && w.length <= max ? w : null;
}
/** Is the run `p` in `w` as whole words, in order, next to each other? */
function hasRun(w, p) {
  for (let i = 0; i + p.length <= w.length; i += 1) if (sameAt(w, i, p)) return true;
  return false;
}
const hasAny = (w, set) => w.some((x) => set.has(x));
const hasAnyRun = (w, runs) => runs.some((p) => hasRun(w, p));
const runs = (list) => list.map((p) => p.split(" "));

/** "open the lab dashboard" → { name: "lab dashboard" }. pull: also accept "pull up" / "bring up". */
export function parseOpen(transcript, { pull = true } = {}) {
  const w = words(transcript, OPEN_MAX_WORDS);
  if (!w) return null;
  const v = (pull ? [...OPEN_VERBS, ...PULL_VERBS] : OPEN_VERBS).find((p) => startsWith(w, p));
  if (!v) return null;
  const name = slot(w, v.length);
  return name.length <= 6 ? { name: name.join(" ") } : null;
}

/** "play some jazz" → { what: "some jazz" }; "put on the Beatles" → { what: "beatles" }. */
export function parsePlay(transcript) {
  const w = words(transcript, PLAY_MAX_WORDS);
  if (!w || hasAny(w, NOT_PLAY)) return null;
  let v = PLAY_VERBS.find((p) => startsWith(w, p));
  let rest = v ? (v[0] === "play" ? w.slice(1) : slot(w, v.length)) : null;
  if (!v && w[0] === "pon" && w.slice(1, 4).some((x) => PON_NOUNS.has(x))) { v = ["pon"]; rest = slot(w, 1); }
  if (!v || !rest.length) return null;
  if (v[0] === "play" && rest[0] === "the" && rest.length > 1) rest = rest.slice(1);
  return { what: rest.join(" ") };
}

// ── offered: the request is about playing / opening ──────────────────────────────────────────────
const PLAY_WORDS = new Set(["play", "music", "song", "songs", "radio", "station", "album", "albums", "playlist", "playlists", "listen", "hear", "tune", "tunes", "news", "podcast", "podcasts",
  "reproduce", "reproducir", "toca", "tocar", "musica", "cancion", "canciones", "emisora", "estacion", "disco", "escuchar", "escucha", "oir", "noticias"]);
const PLAY_RUNS = runs(["put on", "pon algo"]);
const OPEN_WORDS = new Set(["open", "launch", "app", "apps", "start", "abre", "abreme", "abrir", "lanza", "aplicacion", "aplicaciones"]);
const OPEN_RUNS = runs(["take me to", "go to", "bring back", "llevame a", "ve a"]);
// "start a timer", "open the recipe": the card and timer verbs keep these.
const NOT_OPEN = new Set(["timer", "timers", "countdown", "alarm", "stopwatch", "recipe", "list", "temporizador", "alarma", "cronometro", "receta", "lista"]);

/** The plain words of any transcript the matchers read (null when empty or over the cap). */
const plain = (transcript) => spokenWords(transcript);
const norm = (s) => (spokenWords(String(s ?? "").slice(0, 80)) || []).join(" ");
const itemNames = (i) => [i?.title, ...(Array.isArray(i?.aliases) ? i.aliases : [])].map(norm).filter(Boolean);
/** Does the transcript contain the whole title (or an alias) of one of this display's items? */
function namesItem(w, items) {
  for (const i of Array.isArray(items) ? items.slice(0, 64) : []) for (const n of itemNames(i)) if (hasRun(w, n.split(" "))) return true;
  return false;
}

export function mentionsPlay(transcript) {
  const w = plain(transcript);
  return !!w && !hasAny(w, NOT_PLAY) && (hasAny(w, PLAY_WORDS) || hasAnyRun(w, PLAY_RUNS));
}
/** items: what this display may open ([{ id, title, aliases? }]). Naming one of them is a mention; so is an open word. */
export function mentionsOpen(transcript, items = []) {
  const w = plain(transcript);
  if (!w) return false;
  if (namesItem(w, items)) return true;
  return !hasAny(w, NOT_OPEN) && !hasAny(w, NOT_PLAY) && !hasAny(w, PLAY_WORDS) && (hasAny(w, OPEN_WORDS) || hasAnyRun(w, OPEN_RUNS));
}

// ── must run: the person is asking for it now ────────────────────────────────────────────────────
const CUE_WORDS = new Set(["please", "lets", "quiero", "quisiera", "necesito", "pon", "ponme", "dame", "puedes", "podrias"]);
const CUE_RUNS = runs(["put on", "i want", "i wanna", "id like", "i would like", "i need", "we need", "can we", "can you", "could we", "could you", "would you", "let us", "how about", "give me",
  "take me to", "go to", "bring back", "me pones", "me pone", "nos pones", "vamos a", "por favor", "llevame a", "ve a"]);
// A question about the thing is not a request for it ("who plays the lead?", "what's in the news?").
const QUESTION_STARTS = runs(["who", "whos", "what", "whats", "when", "where", "why", "which", "whose", "is", "are", "was", "were", "do", "does", "did", "have", "has",
  "how many", "how much", "how long", "how do", "how does", "how did", "how is", "how old",
  "quien", "que", "cuando", "donde", "por que", "cual", "cuales", "cuanto", "cuantos", "cuanta", "cuantas", "como", "es", "son", "hay", "tienes"]);
function asks(w) {
  const core = stripPolite(w);
  if (QUESTION_STARTS.some((p) => sameAt(core, 0, p))) return false;
  return hasAny(w, CUE_WORDS) || hasAnyRun(w, CUE_RUNS);
}
export function asksPlay(transcript) {
  if (parsePlay(transcript) !== null) return true;
  const w = plain(transcript);
  return !!w && mentionsPlay(transcript) && asks(w);
}
export function asksOpen(transcript, items = []) {
  const w = plain(transcript);
  return !!w && mentionsOpen(transcript, items) && (parseOpen(transcript, { pull: false }) !== null || asks(w));
}

// ── two requests in one sentence ─────────────────────────────────────────────────────────────────
const SEQUENCE = new Set(["then", "luego", "despues"]);
const JOINERS = new Set(["and", "also", "plus", "y", "tambien", "ademas"]);
const REQUEST_VERBS = new Set(["show", "display", "put", "play", "open", "close", "start", "set", "stop", "pause", "resume", "turn", "tell", "read", "add", "make", "give", "bring", "pull", "clear", "skip", "launch",
  "muestra", "muestrame", "pon", "ponme", "abre", "cierra", "reproduce", "toca", "para", "deten", "dime", "lee", "agrega", "anade", "quita", "dame", "inicia", "limpia"]);
/** "…and then …", or a joining word with a request verb within the next three words. "fruits and vegetables" is one request. */
export function compound(transcript) {
  const w = plain(transcript);
  if (!w) return false;
  for (let i = 1; i < w.length - 1; i += 1) {
    if (SEQUENCE.has(w[i])) return true;
    if (JOINERS.has(w[i]) && w.slice(i + 1, i + 4).some((x) => REQUEST_VERBS.has(x))) return true;
  }
  return false;
}

/** items: [{ id, title, aliases? }]. Exact name or alias, else a unique prefix. → { match } | { many } | null. */
export function lookupItem(items, name) {
  const q = norm(name);
  if (!q || !Array.isArray(items)) return null;
  const exact = items.filter((i) => itemNames(i).includes(q));
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { many: exact.slice(0, 4) };
  const pre = items.filter((i) => itemNames(i).some((n) => n.startsWith(`${q} `)));
  if (pre.length === 1) return { match: pre[0] };
  return pre.length >= 2 && pre.length <= 4 ? { many: pre } : null;
}

/** → an intent for the executor, or null. ctx.items = what this display may open. (T1 play is added with the media session.) */
export function matchT1(transcript, ctx) {
  const o = parseOpen(transcript);
  if (o) {
    const hit = lookupItem(ctx.items || [], o.name);
    if (hit?.match) return { verb: "open", app: hit.match.id };
    if (hit?.many) return { verb: "choices", names: hit.many.map((i) => i.title) };
  }
  return null;
}
