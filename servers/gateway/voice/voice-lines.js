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
    // Crow's own tools (own-tools.js): spoken by the server, only after the write returned ok (#499).
    calendar_added: "Added {title} to your calendar for {when}.",
    reminder_set: "Okay, I'll remind you {when}: {text}.",
    task_added: "Added {title} to your tasks.",
    routine_confirm_calendar: "Add {title} to your calendar for {when}?",
    routine_confirm_reminder: "Remind you {when}: {text}?",
    routine_confirm_task: "Add {title} to your tasks?",
    declined: "Okay, I won't.",
    calendar_fallback_offer: "I can't add that to a calendar here, but I can remind you {when}: {text}. Okay?",
  }),
  es: Object.freeze({
    cant_do_say: "Lo siento, no puedo hacer eso desde aquí: este asistente no tiene una herramienta para eso.",
    not_done_say: "Lo siento, no pude hacer eso desde aquí, así que no se cambió nada.",
    not_ready_say: "El asistente que puede hacer eso todavía no está listo. Inténtalo de nuevo en un momento.",
    memo_only_say: "Guardé una nota, pero no puedo poner recordatorios desde aquí.",
    unsure_say: "No estoy seguro de que se haya hecho. Revísalo antes de volver a pedirlo.",
    calendar_added: "Añadí {title} a tu calendario para el {when}.",
    reminder_set: "Vale, te lo recordaré el {when}: {text}.",
    task_added: "Añadí {title} a tus tareas.",
    routine_confirm_calendar: "¿Añado {title} a tu calendario para el {when}?",
    routine_confirm_reminder: "¿Te lo recuerdo el {when}: {text}?",
    routine_confirm_task: "¿Añado {title} a tus tareas?",
    declined: "Vale, no lo haré.",
    calendar_fallback_offer: "No puedo añadir eso a un calendario aquí, pero puedo recordártelo el {when}: {text}. ¿Te parece?",
  }),
});

/** The line `key` in `lang` (anything but "es" is English), with {name} placeholders filled from `vars`; "" for an unknown key. */
export function voiceLine(key, lang, vars = {}) {
  const table = VOICE_LINES[lang === "es" ? "es" : "en"];
  const line = Object.hasOwn(table, key) ? table[key] : "";
  return line.replace(/\{(\w+)\}/g, (m, k) => (vars && Object.hasOwn(vars, k) ? String(vars[k]) : m));
}
