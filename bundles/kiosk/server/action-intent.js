/**
 * Does the PLAIN transcript (never the turn-context prefix) ask the assistant to DO something
 * that only a tool could do — add, create, schedule, book, remind, send, delete, cancel, save?
 * The voice turn's actionWhen (queue item 29): such a turn escalates when the assistant has a
 * tool the quick model was not offered, and on a turn with no tool at all the model is told it
 * cannot act and its reply is checked for a false claim before it is heard.
 *
 * Conservative, OBJECT-anchored lists, en + es; mirrors wantsMemory. A bare verb is not enough
 * ("add 15 and 27", "create a poem", "recommend a good book" are questions): the request must
 * name a calendar, an appointment, a reminder, a message or a list. A false positive is not
 * just slower: on an assistant with no tool it is answered "I can't do that from here".
 */
import { intentText } from "./intent-text.js";

// Objects an assistant needs a tool for: a calendar, a reminder, a message, a list.
const THING = "calendar|schedule|agenda|reminders?|to do list|todo list|to-do list|shopping list|grocery list|list";
// Where a command verb stands: the start of the sentence, or after a lead-in ("can you", "please", "ok").
const LEAD = "(?:^|\\b(?:please|can you|could you|would you|will you|i want to|i need to|i d like to|i would like to|let s|go ahead and|ok|okay|hey|so|crow|hey crow|and|also|then) )";
const ACTION_INTENT = [
  // "Remind me what a gerund is" is a question: remind me + a question word is not a reminder request.
  /\bremind me(?! (what|who|how|when|where|why|which|of|about|again what))\b/,
  /\b(set an alarm|set my alarm|set a reminder|set up a reminder|sign me up)\b|\breminders?\b(?! (app|apps))/,
  new RegExp(`${LEAD}remember to\\b`),
  // A calendar or appointment of the user's own ("what is the Mayan calendar" is not).
  /\b(my|our|your|an|this|next|that) (calendar|appointment|appointments)\b|\b(reschedule|calendar event)\b/,
  new RegExp(`\\b(add|put|schedule|write|save)\\b.{0,60}\\b(to|on|in|into)( my| the| our)? (${THING})\\b`),
  /\b(create|make|schedule|book|add|set up) (a|an|my|the|new|a new) (event|meeting|appointment|reminder|task|alarm|call|table|room|flight|reservation|contact)\b/,
  new RegExp(`${LEAD}(schedule|book) (a|an|my|me|us)\\b`),
  /\bsend (a |an |the |my )?(email|e mail|text|message|reply)\b|\b(write|draft) (a |an |the |my )?(email|e mail|reply)\b|\bsend (it|this|that) to\b/,
  new RegExp(`${LEAD}(email|text|message) (him|her|them|my)\\b`),
  /\b(cancel|delete|remove|move|change) (my|the|that|this|our)( [a-z0-9]+){0,3} (appointment|meeting|event|reminder|alarm|email|reservation|booking)\b/,
  // Spanish (\b cannot sit next to an accented letter: those alternatives carry both spellings).
  /\b(recu[eé]rdame|recordatorio|recordatorios|ag[eé]ndame|pon (una |la |mi )?alarma)( |$)/,
  /\b(mi|nuestro|tu|al|en el) calendario( |$)|\b(mi|nuestra|tu) agenda( |$)/,
  /\b(a[nñ]ade|agrega|apunta|anota|pon|programa|guarda)\b.{0,60}\b(a|en|al) (mi |la |el |nuestra )?(calendario|agenda|lista)( |$)/,
  /\b(crea|programa|agenda|reserva|haz|a[nñ]ade|agrega|apunta|anota|pon) (un|una|mi|la|el) (evento|reuni[oó]n|cita|recordatorio|tarea|alarma|mesa|reserva|contacto)( |$)/,
  /\b(env[ií]a|manda|escribe) (un |una |el |la )?(correo|email|mensaje)( |$)|\b(env[ií]ale|m[aá]ndale)( |$)/,
  /\b(cancela|borra|elimina|mueve|cambia) (mi|la|el|esa|ese|esta|este)( [^ ]+){0,3} (cita|reuni[oó]n|evento|recordatorio|alarma|reserva)( |$)/,
];
// A how-to question is not a request ("hey, how do I set a reminder on my phone?"). Lead-in words are
// dropped one at a time (a word list, never a repeated group: "hey crow" vs "hey" + "crow" would backtrack).
const LEAD_IN = new Set(["hey", "ok", "okay", "so", "um", "uh", "well", "crow", "oye", "bueno", "pues", "tell", "me", "can", "you"]);
const HOW_TO = /^(how (do|can|would|should|could) (i|you|we|one)|how to|c[oó]mo (se|puedo|hago|podr[ií]a))\b/;
function howTo(t) {
  const w = t.split(" ");
  let i = 0;
  while (i < w.length && i < 6 && LEAD_IN.has(w[i])) i++;
  return HOW_TO.test(w.slice(i).join(" "));
}
// The turn right after an action request is guarded only when it reads as a change to it ("move it to 9
// instead", "make it 10", "also Tuesday", "cámbiala a las nueve"), not on any next question.
const FOLLOW_UP = /\b(it|that|this|instead|too|also|actually|move|change|make it|cancel|undo|same|another|one more|and on|lo|la|eso|esa|ese|tambi[eé]n|mejor|en vez|c[aá]mbia(la|lo)?|mu[eé]ve(la|lo)?|otra|otro)( |$)/;
export function wantsAction(transcript) {
  const t = intentText(transcript);
  return !!t && !howTo(t) && ACTION_INTENT.some((re) => re.test(t));
}

/** The turn after an action request: does it read as a change to that request? (The voice turn's actionFollowWhen.) */
export function wantsActionFollowUp(transcript) {
  const t = intentText(transcript);
  return !!t && FOLLOW_UP.test(t);
}
