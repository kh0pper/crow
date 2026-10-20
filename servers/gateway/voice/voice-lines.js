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
  }),
  es: Object.freeze({
    cant_do_say: "Lo siento, no puedo hacer eso desde aquí: este asistente no tiene una herramienta para eso.",
    not_done_say: "Lo siento, no pude hacer eso desde aquí, así que no se cambió nada.",
    not_ready_say: "El asistente que puede hacer eso todavía no está listo. Inténtalo de nuevo en un momento.",
    memo_only_say: "Guardé una nota, pero no puedo poner recordatorios desde aquí.",
    unsure_say: "No estoy seguro de que se haya hecho. Revísalo antes de volver a pedirlo.",
  }),
});

/** The line `key` in `lang` (anything but "es" is English), with {name} placeholders filled from `vars`; "" for an unknown key. */
export function voiceLine(key, lang, vars = {}) {
  const table = VOICE_LINES[lang === "es" ? "es" : "en"];
  const line = Object.hasOwn(table, key) ? table[key] : "";
  return line.replace(/\{(\w+)\}/g, (m, k) => (vars && Object.hasOwn(vars, k) ? String(vars[k]) : m));
}
