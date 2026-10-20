/**
 * Does a voice reply CLAIM an action — done, promised or offered — that the turn had no tool
 * for? Read on a turn that offered the model no tool at all while the user asked it to do
 * something (queue item 29: "add a car appointment … to my calendar" on an assistant with no
 * calendar tool got "I've added your car appointment … I'll remind you about it later today").
 * The voice turn holds such a turn's text until the stream ends and, when this says yes,
 * speaks the display's "I can't do that from here" line instead.
 *
 * English and Spanish. The text is capped BEFORE any pattern runs (its first and last
 * CLAIM_MAX_CHARS characters), split into sentences, lower-cased, accents dropped, apostrophes
 * made spaces; each sentence is tested on its own, so "^" means the start of a sentence. Every
 * pattern is a bounded alternation.
 * Negations never match: an English claim needs a subject form such as "I've", "I'll" or "I can"
 * right before the verb ("I can't add" is "i can t add"), and a Spanish one may not follow "no"
 * ("no puedo añadir", "no te lo he puesto").
 */
export const CLAIM_MAX_CHARS = 2000;

const NEG = "(?<!\\bno(?: (?:te|lo|la|los|las|se|le|me|nunca|todavia|aun))* )";
const EN_DONE = "added|created|scheduled|rescheduled|booked|set up|set|sent|saved|stored|noted|put|deleted|removed|canceled|cancelled|moved|changed|updated|emailed|texted|invited|written down";
const EN_DO = "add|create|schedule|reschedule|book|set up|set|send|save|store|note|put|delete|remove|cancel|move|change|update|email|text|invite|remind|write down|let you know|follow up|keep track|check back|ping|notify|alert";
// "Let me …" without the verbs a plain answer uses ("let me put it this way", "let me note that…").
const EN_LET = "add|create|schedule|reschedule|book|set up|set|send|save|delete|remove|cancel|move|update|email|text|invite|remind";
// Sentence openers a small model puts before a bare claim ("Okay, added!", "Sure, done.", "Vale, apuntado.").
const OPEN = "^(?:(?:ok|okay|sure|great|alright|all right|perfect|yes|yep|yeah|absolutely|of course|no problem|vale|bueno|perfecto|claro|de acuerdo|si|venga|genial) )*";
const CLAIMS = [
  // Done: "I've added", "I have scheduled", "I just set", "I added".
  new RegExp(`\\bi(?: ve| have| just| ve just| have just)? (?:${EN_DONE})\\b`),
  // Promised: "I'll remind you", "I will add", "I'm going to send".
  new RegExp(`\\bi(?: ll| will| m going to| am going to| m gonna| shall)(?: also| go ahead and| make sure to| be sure to)? (?:${EN_DO})\\b`),
  new RegExp(`\\bi (?:m|am) (?:now |just )?(?:adding|creating|scheduling|rescheduling|setting|saving|sending|booking|putting|noting|deleting|removing|canceling|cancelling|moving|changing|updating|emailing|texting|reminding)\\b`),
  // Offered: "I can remind you", "want me to add", "would you like me to set", "Shall I schedule it?".
  new RegExp(`\\bi can(?: also)? (?:${EN_DO})\\b`),
  new RegExp(`\\b(?:want me to|would you like me to|do you want me to|should i go ahead and) (?:${EN_DO})\\b`),
  new RegExp(`${OPEN}(?:shall|should) i (?:${EN_DO})\\b`),
  new RegExp(`\\blet me (?:just |go ahead and )?(?:${EN_LET})\\b`),
  new RegExp(`\\bi d (?:be happy|love|be glad) to (?:${EN_DO})\\b`),
  // Bare, at the start of a sentence after an opener: "Added!", "Done.", "Got it", "Moved it to 9."
  new RegExp(`${OPEN}(?:done|added|set|scheduled|rescheduled|booked|saved|sent|noted|moved|changed|updated|deleted|removed|canceled|cancelled|got it|all done|all set|consider it done|you re all set|reminder set)\\b`),
  // "Car appointment added to your calendar."
  /\b(?:added|scheduled|booked|saved|put|set|created) (?:to|on|in|into|for) (?:your|the) (?:calendar|list|agenda|schedule|reminders)\b/,
  // State with an assistant-made subject: "your car appointment is scheduled for…", "it's in your calendar", "has been added".
  /\b(?:your|the) (?:\w+ ){0,5}(?:appointment|event|meeting|reminder|alarm|email|message|booking|reservation)s?(?: \w+){0,4} (?:is|are|has been|have been) (?:now |all )?(?:all set|set|scheduled|rescheduled|booked|added|saved|sent|created|confirmed|moved|updated|canceled|cancelled|deleted)\b/,
  /\b(?:it|that|this) (?:s|is|has been) (?:now |all )?(?:set|scheduled|booked|added|saved|sent|done|in your (?:calendar|list|schedule|agenda)|on your (?:calendar|list|schedule|agenda))\b/,
  /\b(?:your|the) (?:\w+ ){0,2}(?:appointment|event|meeting|reminder|alarm|booking|reservation)s? (?:is|are) (?:now )?(?:in|on) (?:the|your) (?:calendar|agenda|schedule|list)\b/,
  /\b(?:has|have) been (?:added|created|scheduled|booked|sent|saved|deleted|removed|canceled|cancelled|moved|updated)\b/,
  /\byou re (?:all )?set\b|\byou are (?:all )?set\b/,
  // Spanish (accents already dropped): done, promised, offered, state, bare.
  new RegExp(`${NEG}\\b(?:ya )?(?:te |lo |la |los |las |se )*he (?:anadido|agregado|creado|programado|agendado|reservado|enviado|mandado|guardado|anotado|apuntado|puesto|borrado|eliminado|cancelado|movido|cambiado|actualizado|configurado)\\b`),
  new RegExp(`${NEG}\\b(?:anadi|agregue|programe|agende|envie|mande|guarde|anote|apunte|borre|elimine|cancele)\\b`),
  new RegExp(`${NEG}\\b(?:recordare|anadire|agregare|creare|programare|agendare|reservare|enviare|mandare|guardare|anotare|apuntare|avisare|borrare|eliminare|cancelare)\\b`),
  new RegExp(`${NEG}\\bvoy a (?:anadir|agregar|crear|programar|agendar|reservar|enviar|mandar|guardar|anotar|apuntar|recordar|avisar|borrar|eliminar|cancelar)`),
  new RegExp(`${NEG}\\bpuedo (?:anadir|agregar|crear|programar|agendar|reservar|enviar|mandar|guardar|anotar|apuntar|recordar|avisar)`),
  /\b(?:quieres|te gustaria|deseas|prefieres) que (?:te |lo |la |le )*(?:recuerde|anada|agregue|cree|programe|agende|reserve|envie|mande|guarde|anote|apunte|avise)\b/,
  new RegExp(`${NEG}\\b(?:ya )?(?:esta|quedo|queda) (?:listo|lista|programad[oa]|agendad[oa]|anadid[oa]|agregad[oa]|guardad[oa]|reservad[oa]|en tu (?:calendario|agenda|lista))\\b`),
  new RegExp(`${NEG}\\b(?:ha|han) sido (?:anadid|agregad|cread|programad|agendad|enviad|guardad|reservad|borrad|eliminad|cancelad)[oa]s?\\b`),
  new RegExp(`${NEG}\\b(?:te lo|se lo|te la|se la|lo|la) (?:recuerdo|apunto|agendo|anoto|programo|guardo|agrego|anado|pongo|mando|envio)\\b`),
  new RegExp(`${OPEN}(?:listo|lista|hecho|agendad[oa]|programad[oa]|anotad[oa]|apuntad[oa]|guardad[oa]|anadid[oa]|agregad[oa]|reservad[oa]|enviad[oa])\\b`),
];

const REMINDER = [
  /\bremind|\breminder|\blet you know\b|\bfollow up\b|\bcheck back\b|\bnotify\b|\balert you\b|\bping you\b/,
  new RegExp(`${NEG}\\b(?:recordar|recordare|recuerdo|recuerde|avisar|avisare|avise|aviso)\\w*`),
];

/** Lower case, accents dropped, apostrophes to a space, everything but letters and digits to a space. */
export function claimText(text) {
  if (typeof text !== "string") return "";
  return text.slice(0, CLAIM_MAX_CHARS).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/** The sentences a claim check reads: the first and last CLAIM_MAX_CHARS characters, split at sentence ends. */
export function claimSentences(text) {
  if (typeof text !== "string" || !text) return [];
  const capped = text.length > 2 * CLAIM_MAX_CHARS ? `${text.slice(0, CLAIM_MAX_CHARS)}\n${text.slice(-CLAIM_MAX_CHARS)}` : text;
  // A time (8:15) or a decimal is not a sentence end.
  return capped.split(/(?:(?<!\d)[.:]|[.:](?!\d)|[!?¡¿;\n—–])+|,(?= )/).map(claimText).filter(Boolean);
}

// Clauses joined by "and" are read on their own too ("I've made a note and added it to your calendar").
const clauses = (text) => claimSentences(text).flatMap((t) => [t, ...t.split(/ (?:and|also|then|plus|y|tambien|luego) /)]);
export function claimsAction(text) {
  return clauses(text).some((t) => CLAIMS.some((re) => re.test(t)));
}

/** A claim of a reminder or a later follow-up — what a saved memory is not (a memory call alone backs the rest). */
export function claimsReminder(text) {
  return claimSentences(text).some((t) => CLAIMS.some((re) => re.test(t)) && REMINDER.some((re) => re.test(t)));
}

// Effective tool names: what changes something (create, send, delete…), what only reads, and what is unknown.
const WRITES = /(?:^|_)(?:create|add|insert|append|update|edit|set|delete|remove|trash|send|schedule|book|respond|reply|move|rename|share|upload|store|save|write|cancel|archive|label|plan|call|draft|complete|make|new|post|publish|unpublish|revoke|invite|copy|replace|rewrite|format|apply|run|restore|undo|clear|duplicate|reorder|resolve|transfer|sync|react|dismiss|memo|crosspost|change|toggle|mark|assign|attach|submit|order|play|pause|stop|start|enable|disable)(?:_|$)/;
const READS = /(?:^|_)(?:list|get|search|read|find|discover|status|query|export|download|recall|stats|structure|permissions|metadata|tabs|lookup|fetch|browse|preview|check|count|show|describe|info|inbox)(?:_|$)/;
/** "createEvent", "create-event", "crow_create_event" → "create_event". */
export const toolNameWords = (name) => String(name || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^crow_/, "").replace(/^_+|_+$/g, "");
/**
 * "write" | "read" | "unknown" for an (effective) tool name. Only a write backs an action turn; an ok read
 * (list events, search mail) proves nothing was added, and its text may be anyone's. The first verb in the
 * name decides; "find_replace" is one write. Unknown is neither:
 * after an ok unknown call the turn never says "nothing was changed".
 */
export function toolEffect(name) {
  return firstVerb(name)?.effect || "unknown";
}
/**
 * The first verb in an (effective) tool name and what it does: { verb, effect: "write" | "read" } | null.
 * "crow_get_post" → get (read); "ws_cal_create_event" → create (write); find/search straight before
 * replace is one compound write, "replace" ("find_replace").
 */
function firstVerb(name) {
  const n = toolNameWords(name);
  if (!n) return null;
  const parts = n.split("_");
  for (let i = 0; i < parts.length; i++) {
    const w = `_${parts[i]}_`;
    if (WRITES.test(w)) return { verb: parts[i], effect: "write" };
    if (READS.test(w)) {
      return (parts[i] === "find" || parts[i] === "search") && parts[i + 1] === "replace"
        ? { verb: "replace", effect: "write" } : { verb: parts[i], effect: "read" };
    }
  }
  return null;
}
export const changesSomething = (name) => toolEffect(name) === "write";

// The verbs a voice bot asks a spoken yes for: what deletes, changes or sends (a create, a save, a play does not).
const SPOKEN_YES_VERBS = new Set(["delete", "remove", "trash", "clear", "send", "reply", "post", "publish", "unpublish", "share",
  "transfer", "update", "edit", "replace", "rewrite", "move", "rename", "archive", "cancel", "restore", "undo", "dismiss",
  "write", "upload", "apply", "crosspost", "revoke"]);
/** Does this (effective) tool name delete, change or send something? Its first verb (as toolEffect finds it) decides. */
export function needsSpokenYes(name) {
  const v = firstVerb(name);
  return !!v && v.effect === "write" && SPOKEN_YES_VERBS.has(v.verb);
}

// A sentence that only says something was saved or noted ("I've saved that", "Lo he guardado").
const SAVE_ONLY = /\b(?:saved|noted|stored|remember|remembered|got it|note|guardado|anotado|apuntado|guardo|anoto|apunto|recordare eso|lo recordare)\b/;
// A save that names a calendar, list, reminder or message is not a memory save ("I've saved it to your calendar").
const NOT_MEMORY = /\b(?:calendar|agenda|schedule|list|reminders?|email|message|appointment|calendario|lista|recordatorio|correo|mensaje|cita)\b/;
/**
 * After a memory was saved (and nothing else changed): a claim beyond that save — a reminder, a calendar
 * entry, a sent message. "I've saved that" is true; "I've saved it and added it to your calendar" is not.
 */
export function claimsBeyondMemory(text) {
  return claimSentences(text).flatMap((t) => t.split(/ (?:and|also|then|plus|y|tambien|luego) /)).some((t) => CLAIMS.some((re) => re.test(t))
    && (REMINDER.some((re) => re.test(t)) || NOT_MEMORY.test(t) || !SAVE_ONLY.test(t)));
}
