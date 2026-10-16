/**
 * Does a voice reply CLAIM an action — done, promised or offered — that the turn had no tool
 * for? Read on a turn that offered the model no tool at all while the user asked it to do
 * something (queue item 29: "add a car appointment … to my calendar" on an assistant with no
 * calendar tool got "I've added your car appointment … I'll remind you about it later today").
 * The voice turn holds such a turn's text until the stream ends and, when this says yes,
 * speaks the display's "I can't do that from here" line instead.
 *
 * English and Spanish. The text is capped BEFORE any pattern runs, lower-cased, accents
 * dropped, curly apostrophes made straight; every pattern is a plain alternation (linear).
 * Negations never match: an English claim needs a subject form such as "I've", "I'll" or "I can"
 * right before the verb ("I can't add" is "i can t add"), and a Spanish one may not follow "no"
 * ("no puedo añadir", "no te lo he puesto").
 */
export const CLAIM_MAX_CHARS = 2000;

const EN_DONE = "added|created|scheduled|rescheduled|booked|set up|set|sent|saved|stored|noted|put|made|deleted|removed|canceled|cancelled|moved|updated|emailed|texted|invited|remembered|written down|written";
const EN_DO = "add|create|schedule|reschedule|book|set up|set|send|save|store|note|put|make|delete|remove|cancel|move|update|email|text|invite|remember|remind|write down|let you know|follow up|keep track|check back|ping|notify|alert";
const CLAIMS = [
  // Done: "I've added", "I have scheduled", "I just set", "I added".
  new RegExp(`\\bi(?: ve| have| just| ve just| have just)? (?:${EN_DONE})\\b`),
  // Promised: "I'll remind you", "I will add", "I'm going to send".
  new RegExp(`\\bi(?: ll| will| m going to| am going to| m gonna| shall)(?: also| go ahead and| make sure to| be sure to)? (?:${EN_DO})\\b`),
  // Offered: "I can remind you", "want me to add", "would you like me to set", "shall I schedule".
  new RegExp(`\\bi can(?: also)? (?:${EN_DO})\\b`),
  new RegExp(`\\b(?:want|would you like|do you want|should|shall) (?:me to|i) (?:${EN_DO})\\b`),
  // State: "it's on your calendar", "you're all set", "has been added", "reminder set".
  /\b(?:it s|that s|you re|it is|that is|you are|everything s|everything is) (?:all )?(?:set|scheduled|booked|added|saved|done|on your (?:calendar|list|schedule))\b/,
  /\b(?:has|have) been (?:added|created|scheduled|booked|set|sent|saved|deleted|removed|canceled|cancelled|moved|updated)\b/,
  /\breminder(?: is| has been)? set\b|\ball set\b/,
  // Spanish (accents already dropped): done, promised, offered, state.
  /(?<!\bno(?: (?:te|lo|la|los|las|se|le|me|nunca|todavia|aun))* )\b(?:ya )?(?:te |lo |la |los |las |se )*he (?:anadido|agregado|creado|programado|agendado|reservado|enviado|mandado|guardado|anotado|apuntado|puesto|borrado|eliminado|cancelado|movido|actualizado|configurado)\b/,
  /(?<!\bno(?: (?:te|lo|la|los|las|se|le|me|nunca|todavia|aun))* )\b(?:anadi|agregue|programe|agende|envie|mande|guarde|anote|apunte|borre|elimine|cancele)\b/,
  /(?<!\bno(?: (?:te|lo|la|los|las|se|le|me|nunca|todavia|aun))* )\b(?:recordare|anadire|agregare|creare|programare|agendare|reservare|enviare|mandare|guardare|anotare|apuntare|avisare|borrare|eliminare|cancelare)\b/,
  /(?<!\bno(?: (?:te|lo|la|los|las|se|le|me|nunca|todavia|aun))* )\bvoy a (?:anadir|agregar|crear|programar|agendar|reservar|enviar|mandar|guardar|anotar|apuntar|recordar|avisar|borrar|eliminar|cancelar)/,
  /(?<!\bno(?: (?:te|lo|la|los|las|se|le|me|nunca|todavia|aun))* )\bpuedo (?:anadir|agregar|crear|programar|agendar|reservar|enviar|mandar|guardar|anotar|apuntar|recordar|avisar)/,
  /\b(?:quieres|te gustaria|deseas|prefieres) que (?:te |lo |la |le )*(?:recuerde|anada|agregue|cree|programe|agende|reserve|envie|mande|guarde|anote|apunte|avise)\b/,
  /(?<!\bno(?: (?:te|lo|la|los|las|se|le|me|nunca|todavia|aun))* )\b(?:ya )?(?:esta|quedo|queda) (?:listo|lista|programad[oa]|agendad[oa]|anadid[oa]|agregad[oa]|guardad[oa]|reservad[oa]|en tu (?:calendario|agenda|lista))\b/,
  /(?<!\bno(?: (?:te|lo|la|los|las|se|le|me|nunca|todavia|aun))* )\b(?:ha|han) sido (?:anadid|agregad|cread|programad|agendad|enviad|guardad|reservad|borrad|eliminad|cancelad)[oa]s?\b/,
  /^listo\b/,
  // Subjectless and progressive forms a small model favours (plan review C1).
  /^(?:done|added|scheduled|rescheduled|booked|saved|sent|noted|set|got it|all done|consider it done)\b/,
  new RegExp(`\\bi (?:m|am) (?:now |just )?(?:adding|creating|scheduling|rescheduling|setting|saving|sending|booking|putting|noting|deleting|removing|canceling|cancelling|moving|updating|emailing|texting|reminding)\\b`),
  new RegExp(`\\blet me (?:just |go ahead and )?(?:${EN_DO})\\b`),
  /\b(?:is|are) (?:now |all )?(?:set|scheduled|rescheduled|booked|added|saved|on your (?:calendar|list|schedule))(?: for)?\b/,
  new RegExp(`\\bi d (?:be happy|love|be glad) to (?:${EN_DO})\\b`),
  /(?<!\bno )\b(?:te lo|se lo|te la|se la|lo|la) (?:recuerdo|apunto|agendo|anoto|programo|guardo|agrego|anado|pongo|mando|envio)\b/,
  /^(?:hecho|agendad[oa]|programad[oa]|anotad[oa]|guardad[oa]|anadid[oa]|agregad[oa]|reservad[oa])\b/,
];

const REMINDER = [
  /\bremind|\breminder|\blet you know\b|\bfollow up\b|\bcheck back\b|\bnotify\b|\balert you\b|\bping you\b/,
  /(?<!\bno(?: (?:te|lo|la|se|le|me))* )\b(?:recordar|recordare|recuerdo|recuerde|avisar|avisare|avise|aviso)\w*/,
];

/** Lower case, accents dropped, apostrophes to a space, everything but letters and digits to a space. */
export function claimText(text) {
  if (typeof text !== "string") return "";
  return text.slice(0, CLAIM_MAX_CHARS).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

export function claimsAction(text) {
  const t = claimText(text);
  return !!t && CLAIMS.some((re) => re.test(t));
}

/** A claim of a reminder or a later follow-up — what a saved memory is not (a memory call alone backs the rest). */
export function claimsReminder(text) {
  const t = claimText(text);
  return !!t && claimsAction(text) && REMINDER.some((re) => re.test(t));
}
