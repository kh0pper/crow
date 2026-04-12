/**
 * Maker Lab — shared output filter + persona helpers.
 *
 * Used by both the MCP tool handlers (server.js) and the kiosk HTTP hint
 * pipeline (hint-pipeline.js). Centralized so the safety posture is
 * identical regardless of entry point.
 */

export const HINT_RATE_PER_MIN = 6;
export const HINT_MAX_WORDS_KID = 40;
export const HINT_MAX_WORDS_TWEEN = 80;
export const HINT_MAX_WORDS_ADULT = 200;

// Small kid-safe blocklist. Matched case-insensitively on whole words.
// Kept conservative. Extend via runtime config if needed.
export const BLOCKLIST_KID = [
  "kill", "die", "death", "suicide", "murder", "weapon", "gun", "knife",
  "sex", "sexy", "porn", "naked", "drug", "drugs", "cocaine", "heroin",
  "beer", "wine", "alcohol", "blood", "bloody", "hate", "damn", "hell",
];

export const CANNED_HINTS_BY_AGE = {
  "kid-tutor": [
    "Let's look at the blocks together! Which one do you think comes first?",
    "What happens if we move that block a little?",
    "Great try! Want to peek at the next step?",
  ],
  "tween-tutor": [
    "What would you expect to happen when this runs? Trace it one step at a time.",
    "If you break the problem into two smaller pieces, which piece is easier?",
    "Hint: think about what the loop is repeating over.",
  ],
  "adult-tutor": [
    "Try tracing execution by hand for one iteration.",
    "What invariant should hold at the top of the loop?",
    "Sketch the types flowing through — where does the mismatch appear?",
  ],
};

export function personaForAge(age) {
  if (age == null) return "kid-tutor";
  if (age <= 9) return "kid-tutor";
  if (age <= 13) return "tween-tutor";
  return "adult-tutor";
}

export function ageBandFromGuestBand(band) {
  const b = String(band || "").toLowerCase();
  if (b.includes("5-9") || b === "kid" || b === "child") return "kid-tutor";
  if (b.includes("10-13") || b === "tween") return "tween-tutor";
  return "adult-tutor";
}

function wordCount(s) {
  return (String(s || "").match(/\S+/g) || []).length;
}

function simpleSyllableCount(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g) || [];
  let n = groups.length;
  if (w.endsWith("e") && n > 1) n--;
  return Math.max(1, n);
}

// Very rough Flesch-Kincaid grade level.
export function readingGrade(text) {
  const s = String(text || "").trim();
  if (!s) return 0;
  const sentences = Math.max(1, (s.match(/[.!?]+/g) || [""]).length);
  const words = s.match(/\S+/g) || [];
  if (!words.length) return 0;
  const syllables = words.reduce((sum, w) => sum + simpleSyllableCount(w), 0);
  const wpS = words.length / sentences;
  const spW = syllables / words.length;
  return 0.39 * wpS + 11.8 * spW - 15.59;
}

function hasBlockedWord(text, blocklist) {
  const lower = String(text || "").toLowerCase();
  for (const w of blocklist) {
    const re = new RegExp(`\\b${w}\\b`, "i");
    if (re.test(lower)) return w;
  }
  return null;
}

/**
 * Run the server-side hint filter.
 * @returns {{ok: boolean, text?: string, reason?: string}}
 */
export function filterHint(raw, persona) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, reason: "empty" };

  const maxWords =
    persona === "adult-tutor" ? HINT_MAX_WORDS_ADULT
    : persona === "tween-tutor" ? HINT_MAX_WORDS_TWEEN
    : HINT_MAX_WORDS_KID;

  if (wordCount(text) > maxWords) {
    return { ok: false, reason: `too_long:${wordCount(text)}>${maxWords}` };
  }

  if (persona === "kid-tutor") {
    const grade = readingGrade(text);
    if (grade > 3.5) return { ok: false, reason: `reading_grade:${grade.toFixed(1)}` };
  }

  const hit = hasBlockedWord(text, BLOCKLIST_KID);
  if (hit) return { ok: false, reason: `blocklist:${hit}` };

  return { ok: true, text };
}

export function pickCannedHint(persona, { cannedHints, level } = {}) {
  if (Array.isArray(cannedHints) && cannedHints.length) {
    const idx = level ? Math.min(level - 1, cannedHints.length - 1) : Math.floor(Math.random() * cannedHints.length);
    return cannedHints[idx];
  }
  const bucket = CANNED_HINTS_BY_AGE[persona] || CANNED_HINTS_BY_AGE["kid-tutor"];
  const idx = level ? Math.min(level - 1, bucket.length - 1) : Math.floor(Math.random() * bucket.length);
  return bucket[idx];
}

// ─── Rate limiter (process-global, per-session) ────────────────────────

const rateBuckets = new Map();

export function rateLimitCheck(token, limitPerMin = HINT_RATE_PER_MIN) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const bucket = (rateBuckets.get(token) || []).filter((t) => t > cutoff);
  if (bucket.length >= limitPerMin) {
    rateBuckets.set(token, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(token, bucket);
  return true;
}

export async function getLearnerAge(db, learnerId) {
  if (!learnerId) return null;
  try {
    const r = await db.execute({
      sql: `SELECT age FROM maker_learner_settings WHERE learner_id=?`,
      args: [learnerId],
    });
    if (r.rows.length && typeof r.rows[0].age === "number") return r.rows[0].age;
  } catch {}
  return null;
}

export async function resolvePersonaForSession(db, session) {
  if (!session) return "kid-tutor";
  if (session.is_guest) return ageBandFromGuestBand(session.guest_age_band);
  const age = await getLearnerAge(db, session.learner_id);
  return personaForAge(age);
}
