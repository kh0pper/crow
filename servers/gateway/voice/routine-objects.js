/**
 * The routine objects Crow's own tools serve (a calendar, reminders, tasks), as phrase lists in English and
 * Spanish (tool-families.js rules: plain words compared word by word, never patterns). The voice turn uses
 * them when deps.ownTools reports an object as `unavailable`: an action request that names only such objects
 * gets the can't-do line, or for a calendar the offer of a Crow reminder (rev 2.1).
 *
 * Keep the calendar and reminder words a superset of the kiosk's action-intent objects
 * (bundles/kiosk/server/action-intent.js ACTION_OBJECTS): tests/voice-routine-objects.test.js checks it.
 * A bare "to do" is not a task ("remember to do the dishes" is a reminder).
 */
import { phraseWords, normalizeIntentLists, listMatches } from "./tool-families.js";

export const ROUTINE_OBJECTS = Object.freeze({
  calendar: Object.freeze({
    en: Object.freeze(["calendar", "calendars", "schedule", "agenda", "appointment", "appointments", "calendar event"]),
    es: Object.freeze(["calendario", "cita", "citas"]),
  }),
  reminders: Object.freeze({
    en: Object.freeze(["remind", "reminder", "reminders"]),
    es: Object.freeze(["recuerdame", "recordatorio", "recordatorios"]),
  }),
  tasks: Object.freeze({
    en: Object.freeze(["task", "tasks", "to do list", "todo list", "to-do list"]),
    es: Object.freeze(["tarea", "tareas", "pendiente", "pendientes"]),
  }),
});

/** id → normalized phrase lists. */
export const ROUTINE_OBJECT_LISTS = Object.freeze(Object.fromEntries(
  Object.entries(ROUTINE_OBJECTS).map(([id, v]) => [id, normalizeIntentLists(v)]),
));

/** The routine object ids a plain transcript names, in ROUTINE_OBJECTS order. */
export function namesRoutineObjects(transcript) {
  const words = phraseWords(transcript);
  return Object.keys(ROUTINE_OBJECT_LISTS).filter((id) => listMatches(words, ROUTINE_OBJECT_LISTS[id]));
}
