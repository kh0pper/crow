/**
 * Pending voice confirmations (PR 2, Task 2.2): what a display is waiting for a spoken yes on (a routine
 * write in strict mode, the calendar-fallback reminder offer, a hand-off proposal, a "which bot", a stop),
 * and the yes/no matcher that answers it.
 *
 * The store is in memory and per device: an entry lives HANDOFF_PROPOSAL_TTL_MS, and nothing survives a
 * restart (a restart forgets the question, so a later "yes" is just an utterance).
 *
 * matchYesNo is built on PR 1's isAffirmative/isNegative (turn-helpers.js): one yes/no rule for the voice
 * turn. On top of it, a yes that names another bot or carries an action ("yes, but send it to …") is not a
 * plain yes (null: the model hears it as a correction). There is no core list of action-intent verbs as
 * plain words yet (the kiosk's is a pattern list inside its bundle, and the hand-off intent lists arrive
 * later), so the small CORRECTION_PHRASES list below stands in for them.
 */
import { isAffirmative, isNegative } from "./turn-helpers.js";
import { phraseWords, normalizeIntentLists, listMatches } from "./tool-families.js";

/** How long a pending proposal waits for its yes (plan constant). */
export const HANDOFF_PROPOSAL_TTL_MS = 120_000;

const PENDING_KINDS = new Set(["routine", "handoff", "which", "stop"]);

export function createPendingStore({ now = Date.now, ttlMs = HANDOFF_PROPOSAL_TTL_MS } = {}) {
  const entries = new Map();   // deviceId → entry
  const live = (deviceId) => {
    const e = entries.get(deviceId);
    if (!e) return null;
    if (now() - e.at > ttlMs) { entries.delete(deviceId); return null; }
    return e;
  };
  return {
    /** Replaces the device's entry; `at` is stamped now. */
    set(deviceId, entry) {
      if (!deviceId || !entry || !PENDING_KINDS.has(entry.kind)) throw new Error("pending: a device id and an entry of a known kind are required");
      entries.set(deviceId, { ...entry, at: now() });
    },
    get(deviceId) { const e = live(deviceId); return e ? { ...e } : null; },
    take(deviceId) { const e = live(deviceId); entries.delete(deviceId); return e ? { ...e } : null; },
    clear(deviceId) { entries.delete(deviceId); },
  };
}

// Lead-in words dropped before matching ("hey, yes", "bueno, dale"). ok/okay are PR 1 yes words: they are
// dropped only when more words follow, so "okay, cancel" is a no and "okay what's the weather" is not a yes.
const LEAD_INS = new Set(["hey", "ok", "okay", "so", "crow", "oye", "bueno"]);
const LEAD_TOKEN = /^\s*([^\s,.!?¡¿;:]+)[\s,.!?¡¿;:]*/u;
function stripLeadIns(text) {
  let rest = String(text ?? "");
  for (let i = 0; i < 4; i++) {
    const m = LEAD_TOKEN.exec(rest);
    if (!m || !LEAD_INS.has(phraseWords(m[1]).join(" "))) break;
    const after = rest.slice(m[0].length);
    if (!after.trim()) break;
    rest = after;
  }
  return rest;
}

// Words after a yes that make it a correction or a new request, not a plain yes (en + es; phraseWords form).
// have/ask/get count only before a bot name, which the bot scan already catches.
const CORRECTION_PHRASES = normalizeIntentLists({
  en: ["give it to", "give this to", "hand it to", "hand this to", "pass it to", "send it to", "instead",
    "add", "put", "create", "schedule", "reschedule", "book", "send", "delete", "remove", "change", "move",
    "research", "look into", "find out", "write up", "draft"],
  es: ["pasale", "pasaselo", "dale esto a", "daselo a", "pidele a", "mejor", "en vez", "anade", "agrega", "crea",
    "programa", "agenda", "manda", "envia", "borra", "elimina", "cambia", "mueve", "investiga", "redacta"],
});

/**
 * "yes" | "no" | null. yes: isAffirmative, and the utterance names no bot in otherBots (ids or names) and no
 * correction phrase, whatever its length. no: isNegative (a negation in the first words included).
 */
export function matchYesNo(transcript, { otherBots = [] } = {}) {
  if (typeof transcript !== "string" || !transcript.trim()) return null;
  const t = stripLeadIns(transcript);
  if (isNegative(t)) return "no";
  if (!isAffirmative(t)) return null;
  const words = phraseWords(t);
  const bots = (Array.isArray(otherBots) ? otherBots : []).map((b) => phraseWords(String(b ?? ""))).filter((w) => w.length);
  if (listMatches(words, bots) || listMatches(words, CORRECTION_PHRASES)) return null;
  return "yes";
}
