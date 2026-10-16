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
const ACTION_INTENT = [
  /\b(remind me|reminder|reminders|set an alarm|set my alarm|set a reminder|sign me up|remember to)\b/,
  /\b(calendar|appointment|appointments|reschedule)\b/,
  new RegExp(`\\b(add|put|schedule|write|save)\\b.{0,60}\\b(to|on|in|into)( my| the| our)? (${THING})\\b`),
  /\b(create|make|schedule|book|add|set up) (a|an|my|the|new|a new) (event|meeting|appointment|reminder|task|alarm|call|table|room|flight|reservation|contact)\b/,
  /\b(schedule|book) (a|an|my|me|us)\b/,
  /\b(send|write|draft) (a|an|the|my)? ?(email|e mail|text|message|reply)\b|\b(email|text|message) (him|her|them|my|the)\b|\bsend (it|this|that) to\b/,
  /\b(cancel|delete|remove|move|change) (my|the|that|this|our)( [a-z0-9]+){0,3} (appointment|meeting|event|reminder|alarm|email|reservation|booking)\b/,
  // Spanish (\b cannot sit next to an accented letter: those alternatives carry both spellings).
  /\b(recu[eé]rdame|recordatorio|recordatorios|calendario|agenda(me)?|pon (una |la |mi )?alarma)( |$)/,
  /\b(a[nñ]ade|agrega|apunta|anota|pon|programa|guarda)\b.{0,60}\b(a|en|al) (mi |la |el |nuestra )?(calendario|agenda|lista)( |$)/,
  /\b(crea|programa|agenda|reserva|haz|a[nñ]ade|agrega|apunta|anota|pon) (un|una|mi|la|el) (evento|reuni[oó]n|cita|recordatorio|tarea|alarma|mesa|reserva|contacto)( |$)/,
  /\b(env[ií]a|manda|escribe) (un |una |el |la )?(correo|email|mensaje|texto)( |$)|\b(env[ií]ale|m[aá]ndale|escr[ií]bele)( |$)/,
  /\b(cancela|borra|elimina|mueve|cambia) (mi|la|el|esa|ese|esta|este)( [^ ]+){0,3} (cita|reuni[oó]n|evento|recordatorio|alarma|reserva)( |$)/,
];
// A how-to question is not a request ("how do I set a reminder on my phone?").
const HOW_TO = /^(how (do|can|would|should) (i|you|we)|how to|c[oó]mo (se|puedo|hago))\b/;
export function wantsAction(transcript) {
  const t = intentText(transcript);
  return !!t && !HOW_TO.test(t) && ACTION_INTENT.some((re) => re.test(t));
}
