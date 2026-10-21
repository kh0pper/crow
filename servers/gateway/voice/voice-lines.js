/**
 * The lines every voice surface (phone, kiosk, glasses) speaks in its own language, in one place.
 * en and es have the same keys (tests/crow-voice-options.test.js). The five action lines are the
 * kiosk's own (bundles/kiosk/server/strings.js), word for word: a surface that passes its own copy
 * says the same thing.
 */
export const VOICE_LINES = Object.freeze({
  en: Object.freeze({
    cant_do_say: "Sorry, I can't do that from here: this assistant has no tool for it.",
    not_done_say: "Sorry, I couldn't do that from here, so nothing was changed.",
    not_ready_say: "The assistant that can do that isn't ready yet. Try again in a moment.",
    memo_only_say: "I saved a note, but I can't set reminders from here.",
    unsure_say: "I'm not sure that went through. Please check before you ask again.",
    partly_done_say: "I did part of that, but the rest didn't go through.",
    // After a blocked claim with no retry left, and on a change or cancel (turn.js HINT_TEXT, PR 2.1): what to say instead.
    hint_say: "I can only add new items by voice. Try: add lunch next Tuesday at noon.",
    // Crow's own tools (own-tools.js): spoken by the server, only after the write returned ok (#499).
    calendar_added: "Added {title} to your calendar for {when}.",
    reminder_set: "Okay, I'll remind you {when}: {text}.",
    task_added: "Added {title} to your tasks.",
    routine_confirm_calendar: "Add {title} to your calendar for {when}?",
    routine_confirm_reminder: "Remind you {when}: {text}?",
    routine_confirm_task: "Add {title} to your tasks?",
    declined: "Okay, I won't.",
    calendar_fallback_offer: "I can't add that to a calendar here, but I can remind you {when}: {text}. Okay?",
    // A past start or date (own-tools.js, PR 2.1): nothing is written; Crow offers the next one ({next_when} has the month and day).
    past_confirm_calendar: "That time has passed. Add {title} for {next_when} instead?",
    past_confirm_reminder: "That time has passed. Remind you {next_when} instead: {text}?",
    past_confirm_task: "That date has passed. Add {title} to your tasks for {next_when} instead?",
    // A later turn's claim about the last own write (turn.js sentence gate, PR 2.1): what is really on record.
    last_write_recap: "{title} is on your calendar for {when}.",
    last_write_recap_reminder: "Your reminder is set for {when}: {text}.",
    last_write_recap_task: "{title} is on your tasks.",
  }),
  es: Object.freeze({
    cant_do_say: "Lo siento, no puedo hacer eso desde aquí: este asistente no tiene una herramienta para eso.",
    not_done_say: "Lo siento, no pude hacer eso desde aquí, así que no se cambió nada.",
    not_ready_say: "El asistente que puede hacer eso todavía no está listo. Inténtalo de nuevo en un momento.",
    memo_only_say: "Guardé una nota, pero no puedo poner recordatorios desde aquí.",
    unsure_say: "No estoy seguro de que se haya hecho. Revísalo antes de volver a pedirlo.",
    partly_done_say: "Hice una parte, pero el resto no se pudo hacer.",
    hint_say: "Por voz solo puedo añadir cosas nuevas. Prueba: añade almuerzo el próximo martes al mediodía.",
    calendar_added: "Añadí {title} a tu calendario para el {when}.",
    reminder_set: "Vale, te lo recordaré {when}: {text}.",
    task_added: "Añadí {title} a tus tareas.",
    routine_confirm_calendar: "¿Añado {title} a tu calendario para el {when}?",
    routine_confirm_reminder: "¿Te lo recuerdo {when}: {text}?",
    routine_confirm_task: "¿Añado {title} a tus tareas?",
    declined: "Vale, no lo haré.",
    calendar_fallback_offer: "No puedo añadir eso a un calendario aquí, pero puedo recordártelo {when}: {text}. ¿Te parece?",
    past_confirm_calendar: "Esa hora ya pasó. ¿Añado {title} para el {next_when}?",
    past_confirm_reminder: "Esa hora ya pasó. ¿Te lo recuerdo {next_when}: {text}?",
    past_confirm_task: "Esa fecha ya pasó. ¿Añado {title} a tus tareas para el {next_when}?",
    last_write_recap: "{title} está en tu calendario para el {when}.",
    last_write_recap_reminder: "Tu recordatorio está puesto para {when}: {text}.",
    last_write_recap_task: "{title} está en tus tareas.",
  }),
});

/** The line `key` in `lang` (anything but "es" is English), with {name} placeholders filled from `vars`; "" for an unknown key. */
export function voiceLine(key, lang, vars = {}) {
  const table = VOICE_LINES[lang === "es" ? "es" : "en"];
  const line = Object.hasOwn(table, key) ? table[key] : "";
  return line.replace(/\{(\w+)\}/g, (m, k) => (vars && Object.hasOwn(vars, k) ? String(vars[k]) : m));
}
