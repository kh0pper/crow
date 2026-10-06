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
  // ── Playback. A phrase here fires only while something plays AND the verb would change it (the
  // executor's rule): "pause" with nothing playing, or "resume" while it plays, is conversation.
  // Words people also say to an assistant mid-sentence — "go on", "continue", "carry on", "skip",
  // "silence", "that's enough", "what's this", "sigue", "otra", "basta" — are NOT phrases on their own:
  // every such verb is listed in a form that names the music. The short ones that remain ("pause",
  // "stop", "louder", "mute") have no other meaning on a display while audio plays.
  pause: {
    en: ["pause", "pause it", "pause that", "pause this", "pause the music", "pause the song", "pause the radio", "pause the station", "pause playback", "hold the music"],
    es: ["pausa", "pausalo", "pausala", "pausa la musica", "pausa la cancion", "pausa la radio", "pon pausa", "ponlo en pausa"],
  },
  // "play" alone resumes what is paused. "keep going" is how people ask for the music back after a pause.
  resume: {
    en: ["resume", "resume the music", "resume playing", "resume playback", "unpause", "play", "keep playing", "keep going", "continue the music", "continue playing", "turn the music back on", "put the music back on", "start the music again"],
    es: ["reanuda", "reanuda la musica", "continua la musica", "sigue tocando", "sigue con la musica", "quita la pausa", "vuelve a poner la musica"],
  },
  // "stop the song" is here, as a whole phrase, so that it is never read as "close the window named song".
  stop: {
    en: ["stop", "stop it", "stop that", "stop the music", "stop the song", "stop the radio", "stop the station", "stop playing", "stop playback", "turn off the music", "turn the music off", "turn off the radio", "turn the radio off"],
    es: ["para", "paralo", "detente", "para la musica", "para la cancion", "para la radio", "deten la musica", "apaga la musica", "apaga la radio", "quita la musica"],
  },
  next_track: {
    // "skip this one": a skip while something plays; with nothing playing it is conversation (the executor's rule).
    en: ["next song", "next track", "the next song", "skip this song", "skip the song", "skip this track", "skip song", "skip track", "play the next song", "skip this one", "skip that one"],
    es: ["siguiente cancion", "la siguiente cancion", "pasa la cancion", "salta la cancion", "salta esta cancion", "cambia de cancion", "otra cancion"],
  },
  previous_track: {
    en: ["previous song", "previous track", "the previous song", "go back a song", "back a song", "last song", "the last song", "the song before", "play the previous song"],
    es: ["cancion anterior", "la cancion anterior", "vuelve una cancion", "regresa una cancion", "la cancion de antes"],
  },
  volume_up: {
    en: ["louder", "turn it up", "turn up the volume", "turn the volume up", "volume up", "a bit louder", "a little louder", "make it louder", "raise the volume", "turn up the music", "turn the music up"],
    es: ["mas alto", "mas fuerte", "sube el volumen", "subele", "subelo", "sube la musica", "mas volumen", "subele el volumen"],
  },
  volume_down: {
    en: ["quieter", "softer", "turn it down", "turn down the volume", "turn the volume down", "volume down", "a bit quieter", "a little quieter", "make it quieter", "lower the volume", "turn down the music", "turn the music down", "too loud", "thats too loud", "its too loud"],
    es: ["mas bajo", "mas suave", "baja el volumen", "bajale", "bajalo", "baja la musica", "menos volumen", "bajale el volumen"],
  },
  mute: { en: ["mute", "mute it", "mute that", "mute the music", "mute the radio", "mute the sound"], es: ["silencia", "silencialo", "silencia la musica", "quita el sonido", "sin sonido"] },
  unmute: { en: ["unmute", "unmute it", "unmute the music", "sound on", "turn the sound on", "turn the sound back on"], es: ["activa el sonido", "quita el silencio", "pon el sonido", "vuelve a poner el sonido"] },
  now_playing: {
    en: ["whats playing", "whats this song", "what song is this", "what song is playing", "what station is this", "what am i listening to", "what are we listening to", "who sings this", "who sings this song", "whats the name of this song"],
    es: ["que suena", "que esta sonando", "que cancion es", "que cancion es esta", "que estoy escuchando", "quien canta", "quien canta esta cancion", "que emisora es"],
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

// "volume four", "set the volume to 60", "volumen a cinco": a prefix, then ONE number.
const VOLUME_PREFIXES = byLength(["set the volume to", "turn the volume to", "set volume to", "volume to", "volume", "pon el volumen a", "pon el volumen en", "volumen al", "volumen a", "volumen"]);
const NUMBER_WORDS = Object.freeze({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 });
/** One number word or up to three digits, optionally followed by "percent" / "por ciento". 0..10 is a step ("four" → 40); 11..100 is the level. → 0..100 | null */
function volumeValue(w) {
  const rest = w.length === 2 && w[1] === "percent" ? [w[0]] : w.length === 3 && w[1] === "por" && w[2] === "ciento" ? [w[0]] : w;
  if (rest.length !== 1) return null;
  let n = Object.hasOwn(NUMBER_WORDS, rest[0]) ? NUMBER_WORDS[rest[0]] : null;
  if (n === null) {
    const s = rest[0];
    if (s.length < 1 || s.length > 3) return null;
    n = 0;
    for (const ch of s) { if (ch < "0" || ch > "9") return null; n = n * 10 + (ch.charCodeAt(0) - 48); }
  }
  return n <= 10 ? n * 10 : n <= 100 ? n : null;
}

/** → { verb } | { verb, name } | { verb: "volume", value } | null. */
export function matchT0(transcript) {
  const all = spokenWords(transcript);
  if (!all) return null;
  const w = stripPolite(all);
  if (!w.length || w.length > T0_MAX_WORDS) return null;
  const verb = PHRASE_VERB.get(w.join(" "));
  // The bare word "stop": with nothing playing it is answered at once ("Nothing is playing.").
  if (verb === "stop" && w.length === 1 && w[0] === "stop") return { verb, bare: true };
  if (verb) return { verb };
  for (const p of VOLUME_PREFIXES) if (w.length > p.length && sameAt(w, 0, p)) { const value = volumeValue(w.slice(p.length)); if (value !== null) return { verb: "volume", value }; }
  const fits = (p) => w.length > p.length && w.length - p.length <= SLOT_MAX_WORDS && sameAt(w, 0, p);
  for (const [v, list] of SLOT_PREFIXES) for (const p of list) if (fits(p)) return { verb: v, name: w.slice(p.length).join(" ") };
  for (const [v, list] of KIND_SLOT_PREFIXES) for (const p of list) if (fits(p) && Object.hasOwn(KIND_NOUNS, w[p.length])) return { verb: v, name: w.slice(p.length).join(" ") };
  return null;
}
