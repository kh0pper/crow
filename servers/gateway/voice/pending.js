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
 * plain yes (null: the model hears it as a correction). A correction names a new target: a bot, or one of
 * the CORRECTION_PHRASES below ("give it to", "instead"…); a bare action verb does not make one.
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
const LEAD_TOKEN = /^[\s¡¿]*([^\s,.!?¡¿;:]+)[\s,.!?¡¿;:]*/u;
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

// A yes is a correction only when it names a NEW target: one of these phrases, or a bot in otherBots. A verb
// with only a pronoun object ("yes, add it", "sí, bórralo") is a plain yes, as PR 1's confirm gate reads it.
const CORRECTION_PHRASES = normalizeIntentLists({
  en: ["give it to", "send it to", "pass it to", "instead", "rather"],
  es: ["en vez", "en lugar", "mejor a", "daselo a"],
});

// A correction lead: "but"/"pero", or words that change the held call ("mejor mañana", "make it four",
// "at four", "a las cuatro"), each only when more words follow it ("yes, make it" alone is still a yes).
const CORRECTION_LEADS = [["but"], ["pero"], ["mejor"], ["make", "it"], ["at"], ["a", "las"]];
const leadsCorrection = (words) => CORRECTION_LEADS.some((lead) => {
  for (let i = 0; i + lead.length < words.length; i++) if (lead.every((w, j) => words[i + j] === w)) return true;
  return false;
});

/**
 * "yes" | "no" | null. yes: isAffirmative, and the utterance names no bot in otherBots (ids or names), no
 * correction phrase (a new target) and no correction lead ("but", "pero", "mejor", "make it", "at", "a las") followed by more words, whatever its length. no: isNegative (a negation in the first words included).
 */
export function matchYesNo(transcript, { otherBots = [] } = {}) {
  if (typeof transcript !== "string" || !transcript.trim()) return null;
  const t = stripLeadIns(transcript);
  if (isNegative(t)) return "no";
  if (!isAffirmative(t)) return null;
  const words = phraseWords(t);
  const bots = (Array.isArray(otherBots) ? otherBots : []).map((b) => phraseWords(String(b ?? ""))).filter((w) => w.length);
  if (listMatches(words, bots) || listMatches(words, CORRECTION_PHRASES)) return null;
  // "yes, but at four" / "sí, mejor mañana" / "yes, make it four": a correction lead with more words after it changes what was asked.
  if (leadsCorrection(words)) return null;
  return "yes";
}

/**
 * deps.voiceActions from several members (turn.js documents the hook): Crow's own tools now, the hand-off
 * after them (PR 3). fastPath: the first member that answers (non-null) wins; later members are not asked.
 * turnContext: SYNCHRONOUS; the members' texts joined by newlines, pending when any member is pending; null
 * when no member has anything. afterTurn: every member's, in order (a throw in one never skips the next; it
 * is rethrown after, so turn.js logs it).
 */
export function chainVoiceActions(members) {
  const list = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === "object");
  return {
    async fastPath(args) {
      for (const m of list) {
        if (typeof m.fastPath !== "function") continue;
        const r = await m.fastPath(args);
        if (r) return r;
      }
      return null;
    },
    turnContext(args) {
      const texts = [];
      let pending = false;
      for (const m of list) {
        if (typeof m.turnContext !== "function") continue;
        const v = m.turnContext(args);
        if (!v) continue;
        const text = typeof v === "string" ? v : String(v.text || "");
        if (text) texts.push(text);
        if (v.pending === true) pending = true;
      }
      return texts.length || pending ? { text: texts.join("\n"), pending } : null;
    },
    async afterTurn(args) {
      let first = null;
      for (const m of list) {
        if (typeof m.afterTurn !== "function") continue;
        try { await m.afterTurn(args); } catch (err) { first ??= err; }
      }
      if (first) throw first;
    },
  };
}
