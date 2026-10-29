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
    // A write to a calendar or list that is neither Google's primary nor the operator's chosen one names it (PR 2.1 Task 6).
    calendar_added_crow: "Added {title} to Crow's calendar for {when}.",
    calendar_added_named: "Added {title} to the {calendar} calendar for {when}.",
    task_added_crow: "Added {title} to Crow's task list.",
    task_added_named: "Added {title} to the {list} list.",
    // No calendar or list is chosen and Crow owns none: it asks once ({options}: "Personal or Menu").
    which_calendar_ask: "Which calendar should I use: {options}?",
    which_list_ask: "Which task list should I use: {options}?",
    which_or: "{rest} or {last}",
    which_hint: "To use it every time, choose it in Bot Builder → Crow → Calendar, reminders and tasks.",
    which_hint_list: "To use it every time, choose it in Bot Builder → Crow → Calendar, reminders and tasks.",
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
    // Task 6: a write to Crow's own calendar or list, or to the one named answering the which-question.
    last_write_recap_crow: "{title} is on Crow's calendar for {when}.",
    last_write_recap_named: "{title} is on the {calendar} calendar for {when}.",
    last_write_recap_task_crow: "{title} is on Crow's task list.",
    last_write_recap_task_named: "{title} is on the {list} list.",
    // The hand-off (handoff.js, PR 3): Crow proposes, asks which bot, or says none can; nothing is created yet.
    // {bot} is always the bot's display name.
    handoff_propose: "I'll have {bot} {task} — okay?",
    handoff_propose_queued: "{bot} can't start right now, so this would wait on {bot}'s board: {task}. Put it there?",
    handoff_model_starts: " {bot}'s model will need to start first.",
    handoff_which: "That could go to {a} or to {b} — which one?",
    handoff_which_one: "Should {a} take that?",
    handoff_none: "None of your bots can take that from here.",
    // The spoken yes (handoff.js confirm): "on it" only once the bot really started on an up model; the start
    // failure is a notification title too. {task} is the confirmed task line.
    handoff_started: "Okay, {bot}'s on it.",
    handoff_starting_up: "It's on {bot}'s board, and {bot} is starting up. I'll tell you if it can't.",
    handoff_start_failed: "{bot} couldn't start {task}. It's waiting on {bot}'s board.",
    handoff_queued: "Okay, it's on {bot}'s board. {bot} can't start it right now, so it will wait there.",
    handoff_failed: "Sorry, I couldn't hand that to {bot}, so nothing was started.",
    handoff_already: "That one is already with {bot}.",
    // A kiosk (a shared display) never takes a spoken yes (PR 4): the proposal is pushed to the operator's phone.
    // "sent" only once the push really went out [rv1 C5]; one open phone confirmation per kiosk [rv2 m4].
    handoff_sent_to_phone: "I've sent that to your phone to confirm.",
    handoff_phone_off: "I couldn't send that to your phone, because Crow's alerts are turned off there. Ask me from your phone instead.",
    // The push itself failed (an error, not the alerts turned off): a passing failure, so try again.
    handoff_phone_failed: "I couldn't reach your phone just now — try again in a moment.",
    handoff_already_sent: "I've already sent one to your phone. Confirm or decline that first.",
    // The push's title; {display} is the kiosk's name, or handoff_display_fallback when it has none.
    handoff_phone_title: "Crow on {display}: hand a task to {bot}?",
    handoff_display_fallback: "the kiosk",
    // A stop that landed while the yes was still starting the bot (the status lines proper are PR 5).
    status_stopped: "{bot}'s task was stopped. What it made so far is kept.",
    // The completion notice (handoff-completion.js, PR 5): the bot's own final report ends the hand-off. The
    // title opens what it made; the spoken line goes to a live voice surface, and a kiosk never hears the task.
    completion_title_done: "{bot} finished: {task}",
    completion_title_failed: "{bot} couldn't finish: {task}",
    completion_spoken: "{bot} finished {task}. It's on your phone.",
    completion_spoken_kiosk: "{bot} has finished a task. The details are on your phone.",
    completion_failed_spoken: "{bot} couldn't finish {task}. The details are on your phone.",
    completion_failed_spoken_kiosk: "{bot} couldn't finish a task. The details are on your phone.",
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
    calendar_added_crow: "Añadí {title} al calendario de Crow para el {when}.",
    calendar_added_named: "Añadí {title} al calendario {calendar} para el {when}.",
    task_added_crow: "Añadí {title} a la lista de tareas de Crow.",
    task_added_named: "Añadí {title} a la lista {list}.",
    which_calendar_ask: "¿Qué calendario uso: {options}?",
    which_list_ask: "¿Qué lista de tareas uso: {options}?",
    which_or: "{rest} o {last}",
    which_hint: "Para usarlo siempre, elígelo en Bot Builder → Crow → Calendario, recordatorios y tareas.",
    which_hint_list: "Para usarla siempre, elígela en Bot Builder → Crow → Calendario, recordatorios y tareas.",
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
    last_write_recap_crow: "{title} está en el calendario de Crow para el {when}.",
    last_write_recap_named: "{title} está en el calendario {calendar} para el {when}.",
    last_write_recap_task_crow: "{title} está en la lista de tareas de Crow.",
    last_write_recap_task_named: "{title} está en la lista {list}.",
    handoff_propose: "Puedo pedirle a {bot}: {task}. ¿Vale?",
    handoff_propose_queued: "{bot} no puede empezar ahora, así que esto esperaría en el tablero de {bot}: {task}. ¿Lo dejo ahí?",
    handoff_model_starts: " Antes tendrá que arrancar el modelo de {bot}.",
    handoff_which: "Eso podría ir a {a} o a {b}. ¿A cuál?",
    handoff_which_one: "¿Se lo paso a {a}?",
    handoff_none: "Ninguno de tus bots puede encargarse de eso desde aquí.",
    handoff_started: "Vale, {bot} se pone con ello.",
    handoff_starting_up: "Está en el tablero de {bot}, y {bot} se está poniendo en marcha. Te aviso si no puede.",
    handoff_start_failed: "{bot} no pudo empezar: {task}. Está esperando en el tablero de {bot}.",
    handoff_queued: "Vale, está en el tablero de {bot}. {bot} no puede empezar ahora, así que esperará ahí.",
    handoff_failed: "Lo siento, no pude pasárselo a {bot}, así que no se ha empezado nada.",
    handoff_already: "Eso ya lo tiene {bot}.",
    handoff_sent_to_phone: "Te lo he enviado al teléfono para que lo confirmes.",
    handoff_phone_off: "No pude enviártelo al teléfono porque las alertas de Crow están desactivadas. Pídemelo desde el teléfono.",
    handoff_phone_failed: "No pude avisar a tu teléfono ahora mismo; inténtalo de nuevo en un momento.",
    handoff_already_sent: "Ya te envié una al teléfono. Confírmala o recházala primero.",
    handoff_phone_title: "Crow en {display}: ¿pasarle una tarea a {bot}?",
    handoff_display_fallback: "el quiosco",
    status_stopped: "La tarea de {bot} se paró. Lo que hizo hasta ahora se queda.",
    completion_title_done: "{bot} terminó: {task}",
    completion_title_failed: "{bot} no pudo terminar: {task}",
    completion_spoken: "{bot} terminó: {task}. Lo tienes en el teléfono.",
    completion_spoken_kiosk: "{bot} ha terminado una tarea. Los detalles están en tu teléfono.",
    completion_failed_spoken: "{bot} no pudo terminar: {task}. Los detalles están en tu teléfono.",
    completion_failed_spoken_kiosk: "{bot} no pudo terminar una tarea. Los detalles están en tu teléfono.",
  }),
});

/** The line `key` in `lang` (anything but "es" is English), with {name} placeholders filled from `vars`; "" for an unknown key. */
export function voiceLine(key, lang, vars = {}) {
  const table = VOICE_LINES[lang === "es" ? "es" : "en"];
  const line = Object.hasOwn(table, key) ? table[key] : "";
  return line.replace(/\{(\w+)\}/g, (m, k) => (vars && Object.hasOwn(vars, k) ? String(vars[k]) : m));
}
