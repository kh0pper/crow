/**
 * Does the PLAIN transcript (never the turn-context prefix) ask the assistant to remember,
 * recall or forget something? With memories on for a display, the memory tool is offered to
 * the model only on such turns, and a forced memory call on any other turn is refused — the
 * same function decides both (the voice turn's memoryWhen). Live re-test 2026-10-04:
 * "what's today's date" went to memory twice and took 11.5 s.
 *
 * The trade-off, by design: the assistant uses memories when it is ASKED to remember or
 * recall, not on every question. Conservative word lists, en + es; mirrors wantsDisplay.
 */
const MEMORY_INTENT = [
  /\b(remember|recall)\b/,
  /\b(don t|dont|do not|never) forget\b/,
  /\bforget (that|this|it|about|what|everything)\b/,
  /\bnote that\b|\b(make|take) a note\b|\bnote (this|it) down\b/,
  /\bsave (that|this|it)\b/,
  /\bkeep (that |this |it )?in mind\b/,
  /\bwhat did i (tell|say|ask|mention)\b|\bdid i (tell|mention|say)\b/,
  /\bwhat do you know about (me|my|our|us)\b/,
  /\b(what|who|when) ?(s|is|are|was|were) (my|our)\b/,
  /\bwhere did i (put|leave)\b/,
  /\b(your|my|the) memor(y|ies)\b/,
  // Spanish (\b cannot sit next to an accented letter: those alternatives carry both spellings).
  /\b(recuerda|recuerdas|recu[eé]rdame|recu[eé]rdalo|recordar|acu[eé]rdate|te acuerdas)\b/,
  /\bno (te )?olvides\b/,
  /\b(anota|apunta|toma nota)\b|\bgu[aá]rda(lo|la|melo)\b/,
  /\bolvida (eso|esto|lo)\b|\bolv[ií]dalo\b/,
  /\bqu[eé] te (dije|cont[eé]|coment[eé])\b/,
  /\bqu[eé] sabes (de|sobre) (m[ií]|mis?|nosotros|nuestr[oa]s?)( |$)/,
  /\b(cu[aá]l|qui[eé]n|cu[aá]ndo) (es|son|era) (mis?|nuestr[oa]s?)\b/,
  /\b(tu|mi|la) memoria\b/,
];
export function wantsMemory(transcript) {
  if (typeof transcript !== "string") return false;
  const t = transcript.toLowerCase().replace(/[¿¡“”"'’,.!?;:]+/g, " ").replace(/\s+/g, " ").trim();
  return !!t && MEMORY_INTENT.some((re) => re.test(t));
}
