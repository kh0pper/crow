// pir_match.mjs — Shared PIR message-matching logic.
//
// Used by both sync_pir_responses.mjs (live ingest) and rematch_unmatched.mjs
// (backlog rematch). Owns the regex set for entity-side reference numbers and
// the deterministic matching ladder against pir_requests.

// Order matters only for performance; each regex is independent. Keep each one
// SPECIFIC — a too-greedy capture (e.g. "[\w-]{2,30}") swallows trailing
// subject text and breaks the downstream pir_number/reference_number lookup.
export const PIR_NUMBER_RES = [
  // TEA 7-digit tracking (2504156, 2503101, 2503540…)
  /\b(2[5-9]\d{5})\b/,
  // GovQA-style: single letter + 6 digits + dash + 6 digits
  //   AISD R000873-030926, FWISD W012170-042726, AISD R000778-022626
  /\b([A-Z]\d{6}-\d{6})\b/,
  // HISD: H + 6 digits + optional letter (H042726, H042726B)
  /\b(H\d{6}[A-Z]?)\b/,
  // Aldine ISD invoice: YY-YY-NNNNN (25-26-21214)
  /\b(\d{2}-\d{2}-\d{5})\b/,
  // IDEA Public Schools share folders: YYYY.NNN (2526.096, 2526.106, 2526.133)
  /\b(\d{4}\.\d{3})\b/,
  // State Dept FOIA: F-YYYY-NNNNN (F-2026-13033)
  /\b(F-\d{4}-\d{5})\b/,
  // AG Open Records Division file ID: OR-YY-NNNNNN-XX (OR-26-011908-CC)
  /\b(OR-\d{2}-\d{6}-[A-Z]{2})\b/,
  // ICE FOIA control numbers: YYYY-ICFO-NNNN+ (2026-ICFO-20329)
  /\b(\d{4}-ICFO-\d{4,})\b/,
  // Legacy FOIA submission IDs (FOIA-ICE-2793856 etc.)
  /\b(FOIA-[A-Z]+-\d{6,})\b/,
];

// Returns a pir_requests row (id, pir_number, status, recipient_email) or null.
//
// Ladder:
//   1. Subject regex → token list.
//   2. Exact match: pir_number = token OR reference_number = token. If exactly
//      one row matches across all tokens, return it.
//   3. LIKE fallback (only if exact returned 0): reference_number LIKE %token%.
//      If exactly one row matches, return it.
//   4. Sender-email fallback: exactly one ACTIVE row with the same
//      recipient_email.
//   5. Otherwise null (caller bucket → _unmatched).
//
// Stages 2 and 3 are split so that a backfilled reference_number like
// 'H042726' wins over a LIKE that also catches 'H042726B'.
export function findPirCandidates(canvasDb, { subject, senderEmail }) {
  const tokens = new Set();
  for (const re of PIR_NUMBER_RES) {
    const m = subject.match(re);
    if (m) tokens.add(m[1]);
  }

  if (tokens.size) {
    const exact = new Set();
    const exactStmt = canvasDb.prepare(
      "SELECT id FROM pir_requests WHERE pir_number = ? OR reference_number = ?",
    );
    for (const token of tokens) {
      for (const r of exactStmt.all(token, token)) exact.add(r.id);
    }
    if (exact.size === 1) {
      return canvasDb
        .prepare(
          "SELECT id, pir_number, status, recipient_email FROM pir_requests WHERE id = ?",
        )
        .get([...exact][0]);
    }

    if (exact.size === 0) {
      const fuzzy = new Set();
      const likeStmt = canvasDb.prepare(
        "SELECT id FROM pir_requests WHERE reference_number LIKE ?",
      );
      for (const token of tokens) {
        for (const r of likeStmt.all(`%${token}%`)) fuzzy.add(r.id);
      }
      if (fuzzy.size === 1) {
        return canvasDb
          .prepare(
            "SELECT id, pir_number, status, recipient_email FROM pir_requests WHERE id = ?",
          )
          .get([...fuzzy][0]);
      }
    }
  }

  const senderRows = canvasDb
    .prepare(
      `SELECT id, pir_number, status, recipient_email
       FROM pir_requests
       WHERE LOWER(recipient_email) = ?
         AND status IN ('pending','processing','clarification')`,
    )
    .all(senderEmail);
  if (senderRows.length === 1) return senderRows[0];

  return null;
}
