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
 *   asksCard                a card noun ("a list", "a timer") with a request cue or a making verb, no
 *                           question word: crow_show is offered and MUST run (the same rule as play/open).
 *   compound / compoundParts   two requests in one sentence ("close the timer and then show me a list"),
 *                           and the requests one by one — a must-run test reads each of them.
 */
import { spokenWords, stripPolite, sameAt, KIND_NOUNS } from "./phrases.js";
import { wantsDisplay } from "./wm.js";

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

/** "play some jazz" → { what: "some jazz" }; "put on the Night Owls" → { what: "night owls" }. */
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
// Revisions 4–5: a KIND of music names something to play even with no verb ("a little bossa nova for
// dinner would be nice") — but only inside a REQUEST FRAME (playFrame below), never in a question or an
// information request ("tell me about the history of jazz"). Bounded category lists, en + es; no artist
// or title is ever listed. Kinds: genres and styles, moods, decades, instruments, sound kinds.
const MUSIC_KINDS = new Set(["jazz", "blues", "rock", "reggae", "reggaeton", "cumbia", "cumbias", "bachata", "merengue", "mariachi", "ranchera", "rancheras",
  "bolero", "boleros", "samba", "tango", "flamenco", "funk", "disco", "techno", "edm", "punk", "gospel", "opera", "lofi", "ambient", "indie", "oldies",
  "hits", "exitos", "classical", "clasica", "symphony", "sinfonia", "orchestra", "orquesta", "acoustic", "acustica", "instrumental", "lullaby", "lullabies",
  "nortena", "electronic", "electronica", "motown", "kpop",
  // moods
  "upbeat", "mellow", "chill", "calm", "relaxing", "romantic", "romantico", "romantica", "tranquilo", "tranquila", "energetic", "cheerful", "alegre", "suave",
  // decades
  "fifties", "sixties", "seventies", "eighties", "nineties", "cincuenta", "sesenta", "setenta", "ochenta", "noventa", "setentas", "ochentas", "noventas",
  // instruments and sound kinds
  "piano", "guitar", "guitarra", "violin", "cello", "saxophone", "sax", "beats", "classics", "carols", "villancicos"]);
const MUSIC_RUNS = runs(["bossa nova", "hip hop", "lo fi", "r and b", "rnb", "heavy metal", "rock and roll", "rock n roll", "k pop", "top forty", "top 40",
  "white noise", "ruido blanco", "rain sounds", "sonido de lluvia", "musica regional"]);
// Ambiguous outside music ("add salsa to the list", "what country"): a genre only right after a quantity
// word — "some country", "a little soul", "algo de salsa", "un poco de pop".
const AMBIGUOUS_KINDS = new Set(["country", "pop", "soul", "salsa", "metal", "house", "banda", "rap"]);
function ambiguousKind(w) {
  for (let i = 1; i < w.length; i += 1) {
    if (!AMBIGUOUS_KINDS.has(w[i])) continue;
    const a = w[i - 1], b = w[i - 2];
    if (a === "some" || a === "little" || a === "more" || (a === "of" && b === "bit") || (a === "de" && (b === "algo" || b === "poco" || b === "mas"))) return true;
  }
  return false;
}
// A decade written as a number: 50s … 90s, 2000s.
const DECADE_TOKENS = new Set(["50s", "60s", "70s", "80s", "90s", "2000s"]);
// The request frame for a bare kind of music: a quantity or "again" word, a request cue, or "if you have
// any"; never a question start or an information request.
const FRAME_WORDS = new Set(["some", "something", "again", "algo", "otra", "please", "anything"]);
const FRAME_RUNS = runs(["a little", "a bit of", "a bit", "un poco", "otra vez", "de nuevo", "if you have", "if youve got", "if you got", "would be nice", "would be good", "seria bueno", "estaria bien"]);
const INFO_STARTS = runs(["tell me about", "tell me", "explain", "describe", "teach me", "hablame de", "hablame", "cuentame", "explica", "explicame", "describe"]);
const INFO_RUNS = runs(["history of", "historia de", "what does", "que significa", "where does", "de donde viene", "origin of", "origen de"]);
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

/** A word naming a play target directly (0.1.8 to revision 3): offered on these, as before. */
export function mentionsPlayWord(transcript) {
  const w = plain(transcript);
  return !!w && !hasAny(w, NOT_PLAY) && (hasAny(w, PLAY_WORDS) || hasAnyRun(w, PLAY_RUNS));
}
const namesMusicKind = (w) => hasAny(w, MUSIC_KINDS) || hasAnyRun(w, MUSIC_RUNS) || hasAny(w, DECADE_TOKENS) || ambiguousKind(w);
/** Revision 5: a request frame — not a question, not an information request, and a quantity word, "again", a request cue or "if you have any". */
function playFrame(w) {
  const core = stripPolite(w);
  if (QUESTION_STARTS.some((p) => sameAt(core, 0, p)) || INFO_STARTS.some((p) => sameAt(core, 0, p)) || hasAnyRun(w, INFO_RUNS)) return false;
  return hasAny(w, FRAME_WORDS) || hasAnyRun(w, FRAME_RUNS) || asks(w);
}
export function mentionsPlay(transcript) {
  const w = plain(transcript);
  if (!w || hasAny(w, NOT_PLAY)) return false;
  return hasAny(w, PLAY_WORDS) || hasAnyRun(w, PLAY_RUNS) || (namesMusicKind(w) && playFrame(w));
}
/** items: what this display may open ([{ id, title, aliases? }]). Naming one of them is a mention; so is an open word. */
export function mentionsOpen(transcript, items = []) {
  const w = plain(transcript);
  if (!w) return false;
  if (namesItem(w, items)) return true;
  return !hasAny(w, NOT_OPEN) && !hasAny(w, NOT_PLAY) && !hasAny(w, PLAY_WORDS) && !namesMusicKind(w) && (hasAny(w, OPEN_WORDS) || hasAnyRun(w, OPEN_RUNS));
}

// ── must run: the person is asking for it now ────────────────────────────────────────────────────
const CUE_WORDS = new Set(["please", "lets", "quiero", "quisiera", "necesito", "pon", "ponme", "dame", "puedes", "podrias", "hazme", "haznos", "escribeme"]);
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

// ── must run: a card, asked for without a display word ("I need a list of three fruits") ─────────────
// The card nouns of KIND_NOUNS, plus plurals; "text" and "note" are left out ("I need to text my mom").
const CARD_NOUNS = Object.freeze({ ...Object.fromEntries(Object.entries(KIND_NOUNS).filter(([k]) => k !== "text" && k !== "note")),
  lists: "content", timers: "timer", alarms: "timer", recipes: "recipe", listas: "content", recetas: "recipe", temporizadores: "timer" });
// A making verb at the start is a request with no cue: "make a list of chores", "hazme una lista".
const MAKE_STARTS = runs(["make", "make me", "make us", "write", "write me", "write down", "create", "start", "set", "haz", "crea", "escribe"]);
// Reading, closing or changing what is there is not a request for a NEW card.
const NOT_CARD = new Set(["read", "close", "remove", "delete", "clear", "hide", "dismiss", "cancel", "stop", "pause", "app", "apps", "lee", "leeme", "cierra", "quita", "borra", "oculta", "cancela", "para"]);
// Revisions 4–5: words that place something ON the screen. STRONG phrases name the screen itself; WEAK
// ones ("up there", "on the tv") count only with a card noun, a display verb, or an object pronoun right
// before them ("put the steps up there", "put it up there") — never "is it cold up there in Denver".
const PLACE_STRONG = runs(["up on the screen", "on the screen", "on screen", "on the display", "on the big screen", "on my screen", "put it up", "put that up", "put them up",
  "en la pantalla", "en pantalla", "en mi pantalla"]);
const PLACE_WEAK = runs(["up there", "on there", "on the tv", "on the television", "en la tele", "ahi arriba", "alla arriba"]);
const DISPLAY_VERBS = new Set(["put", "show", "display", "throw", "stick", "pon", "ponlo", "ponla", "ponme", "muestra", "muestrame", "pasa", "pasalo"]);
const OBJECT_PRONOUNS = new Set(["it", "that", "this", "them", "those", "these", "eso", "esto", "lo", "la", "los", "las"]);
const DETERMINERS = new Set(["a", "an", "the", "some", "my", "our", "una", "un", "la", "el", "los", "las", "unos", "unas", "mi", "mis", "nuestra", "nuestro"]);
// A statement ABOUT a list or a timer ("the list my boss sent is long") is not a request for one.
const NOUN_PREPS = new Set(["for", "of", "to", "with", "de", "del", "con", "para"]);
const STATEMENT_VERBS = new Set(["is", "was", "are", "were", "has", "had", "have", "sent", "got", "went", "said", "looks", "seems", "es", "era", "fue", "son", "tiene", "tenia", "esta", "estaba", "parece", "dijo"]);
function placesOnScreen(w) {
  if (hasAnyRun(w, PLACE_STRONG)) return true;
  for (const p of PLACE_WEAK) for (let i = 0; i + p.length <= w.length; i += 1) {
    if (!sameAt(w, i, p)) continue;
    if (OBJECT_PRONOUNS.has(w[i - 1]) || w.some((x) => Object.hasOwn(CARD_NOUNS, x)) || hasAny(w, DISPLAY_VERBS)) return true;
  }
  return false;
}
/**
 * Revisions 4–5: is the request ABOUT a card on the screen? (1) a placement phrase (placesOnScreen: anywhere,
 * a question included: "how do you make it? put the steps up there"); or (2) a card noun phrase that OPENS
 * the utterance ("a list of…", "the steps for…", "una lista con…", "my list for the store: …") with no
 * statement verb and no question start; or (3) a card noun with a request cue. Never a noun inside an
 * item's name. → boolean. One predicate for the offer AND the executor (showIntent).
 */
export function mentionsCard(transcript, items = []) {
  const w = plain(transcript);
  if (!w) return false;
  if (placesOnScreen(w)) return true;
  if (namesItem(w, items) || hasAny(w, NOT_CARD_READ)) return false;
  const core = stripPolite(w);
  if (QUESTION_STARTS.some((p) => sameAt(core, 0, p)) || INFO_STARTS.some((p) => sameAt(core, 0, p))) return false;
  // A bare noun opens a request only before a preposition ("lista de…", "timer for…"); "list the planets" is a verb.
  const opens = (Object.hasOwn(CARD_NOUNS, core[0]) && (core.length === 1 || NOUN_PREPS.has(core[1]))) || (DETERMINERS.has(core[0]) && Object.hasOwn(CARD_NOUNS, core[1] || ""));
  if (opens && !hasAny(w, STATEMENT_VERBS)) return true;
  return w.some((x) => Object.hasOwn(CARD_NOUNS, x)) && asks(w);
}
// Reading or closing a card is not a request for a new one (the "para" of asksCard's veto is a stop verb
// only at the start, which the open-at-start rule above never sees as a card noun).
const NOT_CARD_READ = new Set(["read", "close", "remove", "delete", "clear", "hide", "dismiss", "cancel", "lee", "leeme", "cierra", "quita", "borra", "oculta", "cancela"]);

/** Revision 5: the display-intent test BOTH the offer (crow_show.when) and the executor (show's echo guard) use. */
export function showIntent(transcript, items = []) {
  return wantsDisplay(transcript) || asksCard(transcript, items) !== null || mentionsCard(transcript, items);
}

// Revision 5: a FOLLOW-UP to what is on the screen — the only way a turn with no display intent may change
// an open card or timer: a change word, or an object pronoun, and not a question.
const FOLLOW_WORDS = new Set(["add", "also", "too", "instead", "remove", "change", "update", "replace", "swap", "plus", "more", "less", "extra", "another", "make", "throw", "put", "take", "drop", "rename",
  "mas", "tambien", "agrega", "agregale", "anade", "anadele", "quita", "quitale", "cambia", "cambialo", "pon", "ponle", "ponlo", "mejor", "otro", "otra", "menos", "hazlo"]);
const FOLLOW_RUNS = runs(["as well", "en vez", "en lugar"]);
export function followUp(transcript) {
  const w = plain(transcript);
  if (!w) return false;
  const core = stripPolite(w);
  if (QUESTION_STARTS.some((p) => sameAt(core, 0, p))) return false;
  return hasAny(w, FOLLOW_WORDS) || hasAnyRun(w, FOLLOW_RUNS) || hasAny(w, OBJECT_PRONOUNS);
}

/** → "timer" | "recipe" | "content" | null. items: what this display may open (a noun inside an item's name is that item). */
export function asksCard(transcript, items = []) {
  const w = plain(transcript);
  if (!w || hasAny(w, NOT_CARD) || namesItem(w, items)) return null;
  const noun = w.find((x) => Object.hasOwn(CARD_NOUNS, x));
  if (!noun) return null;
  const core = stripPolite(w);
  if (QUESTION_STARTS.some((p) => sameAt(core, 0, p))) return null;
  return asks(w) || MAKE_STARTS.some((p) => sameAt(core, 0, p)) ? CARD_NOUNS[noun] : null;
}

// ── two requests in one sentence ─────────────────────────────────────────────────────────────────
const SEQUENCE = new Set(["then", "luego", "despues"]);
const JOINERS = new Set(["and", "also", "plus", "y", "tambien", "ademas"]);
const REQUEST_VERBS = new Set(["show", "display", "put", "play", "open", "close", "start", "set", "stop", "pause", "resume", "turn", "tell", "read", "add", "make", "give", "bring", "pull", "clear", "skip", "launch",
  "muestra", "muestrame", "pon", "ponme", "abre", "cierra", "reproduce", "toca", "para", "deten", "dime", "lee", "agrega", "anade", "quita", "dame", "inicia", "limpia"]);
/** "…and then …", or a joining word with a request verb within the next three words. "fruits and vegetables" is one request. */
export function compound(transcript) {
  return compoundParts(transcript).length > 1;
}
/** The requests in the sentence, each as plain words ("close the timer", "show me a list of three fruits"). One entry when it is not compound; none when there is nothing to read. */
export function compoundParts(transcript) {
  const w = plain(transcript);
  if (!w) return [];
  const parts = [];
  let from = 0;
  for (let i = 1; i < w.length - 1; i += 1) {
    const cut = SEQUENCE.has(w[i]) || (JOINERS.has(w[i]) && !SEQUENCE.has(w[i + 1]) && w.slice(i + 1, i + 4).some((x) => REQUEST_VERBS.has(x)));
    if (!cut) continue;
    // "and then": the joining word before a sequence word belongs to the cut, not to the first request.
    const end = i > from && JOINERS.has(w[i - 1]) && SEQUENCE.has(w[i]) ? i - 1 : i;
    if (end > from) parts.push(w.slice(from, end).join(" "));
    from = i + 1;
  }
  parts.push(w.slice(from).join(" "));
  return parts.filter(Boolean);
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
