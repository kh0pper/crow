/**
 * Speech-recognition repair for the voice turn (PR 2.1 Task 4). The kiosk's English STT model hears a leading
 * "add" as "had", "ad", "at" or "and" ("Had coffee Tuesday at 9"); the model then took "Had Coffee" as the title
 * and read the tense as a past date (the private engineering notes, 2026-10-21 calendar test). sttRewrite puts
 * the "add" back only when what follows reads as a new item for a day or a time, never on a plain sentence.
 *
 * The word tests here are shared with the calendar tool's intentWhen (own-tools.js): one vocabulary. Words are
 * compared as tool-families.js phraseWords gives them (lower case, accents and apostrophes gone), en and es merged.
 */
import { phraseWords } from "./tool-families.js";
import { namesRoutineObjects } from "./routine-objects.js";

const words = (list) => new Set(list.split(" "));

/** Words that are never the item being added. */
const STOP = words("a an the i you we it this that then so my your great good nice fun been to on in at for with what how when"
  + " un una unos unas el la los las lo mi mis tu tus al en de del que para con eso esto esta este");
/** Day and time words. "may" is a verb as often as a month: left out. */
const DAY_TIME = words("monday tuesday wednesday thursday friday saturday sunday tues thurs today tonight tomorrow tmrw"
  + " noon midnight morning afternoon evening weekend am pm oclock"
  + " january february march april june july august september october november december"
  + " lunes martes miercoles jueves viernes sabado domingo hoy manana pasado mediodia medianoche tarde noche"
  + " enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre");
const NUMBER_WORDS = words("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"
  + " sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty half quarter"
  + " uno una dos tres cuatro cinco seis siete ocho nueve diez once doce quince veinte treinta media cuarto");
const isNumber = (w) => /^\d+(st|nd|rd|th|am|pm)?$/.test(w) || NUMBER_WORDS.has(w);

/** Could this word be the thing being added ("coffee", "lunch")? Not a stop word, a day or time word, or a number. */
export function isObjectWord(w) {
  return typeof w === "string" && w.length > 0 && !STOP.has(w) && !DAY_TIME.has(w) && !isNumber(w);
}

/** Do these words (phraseWords) hold a day or a time: "Tuesday", "tomorrow", "next week", "at 9", "9 am", "a las 9", "a la una"? */
export function hasDayTime(ws) {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const next = ws[i + 1];
    if (DAY_TIME.has(w) || /^\d{1,2}(am|pm)$/.test(w)) return true;
    if (w === "next" && (next === "week" || next === "month")) return true;
    if (w === "fin" && next === "de" && ws[i + 2] === "semana") return true;
    if ((w === "proxima" || w === "proximo") && next === "semana") return true;
    if (w === "at" && next && isNumber(next)) return true;
    if (w === "a" && (next === "las" || next === "la") && ws[i + 2] && isNumber(ws[i + 2])) return true;
    if (isNumber(w) && next && (next === "am" || next === "pm" || next === "oclock" || (/^[ap]$/.test(next) && ws[i + 2] === "m"))) return true;
  }
  return false;
}

const MISHEARD = new Set(["had", "ad", "at", "and"]);
const MISHEARD_RE = /^(\s*)(had|ad|at|and)\b/i;

/**
 * transcript → { text, from } when its first word is a misheard "add", else null. The rules ([r2 I6]):
 *   - the first word is "had", "ad", "at" or "and", and the next word is an object word (isObjectWord);
 *   - the rest holds a routine object (a calendar, a reminder, a task) or a day or time phrase.
 * So "and tomorrow?", "and on Friday?", "at nine tomorrow add lunch", "had a great day on Tuesday" and "and then
 * what" are never touched. English only; the caller (turn.js) also skips it for any bot but the voice bot and
 * while a question waits for a yes.
 */
export function sttRewrite(transcript, { lang } = {}) {
  if (typeof transcript !== "string" || (lang && !/^en\b/i.test(lang))) return null;
  const m = MISHEARD_RE.exec(transcript);
  if (!m) return null;
  const ws = phraseWords(transcript);
  if (!MISHEARD.has(ws[0]) || !isObjectWord(ws[1])) return null;
  const rest = ws.slice(1);
  if (!hasDayTime(rest) && namesRoutineObjects(rest.join(" ")).length === 0) return null;
  return { text: `${m[1]}add${transcript.slice(m[0].length)}`, from: m[2].toLowerCase() };
}
