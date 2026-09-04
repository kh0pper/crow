// scripts/pi-bots/card-brief.mjs
//
// Track 3 Task 2 — pure builder for the "Work the following card" prompt
// block, extracted out of bridge.mjs (the `cardId != null` branch) so the
// interactive dispatch rail (not just the mail/discord bridge) composes the
// identical brief. Deliberately has NO imports from bridge.mjs or
// tracker.mjs — every DB-touching lookup is injected by the caller as a
// function, so this module stays a pure string assembler with no cycle risk
// and no DB of its own.
//
// Both callers (bridge.mjs and perch-interactive.js) call this one builder,
// so the two rails' briefs are identical by construction. The block starts
// at "Work the following card." and ends at "...not a status write." — the
// caller (bridge.mjs) still owns projectHeader/gatewayHint before this text
// and the channel-specific tail (" Then reply with a short summary for the
// gateway thread. One card only.") after it.
//
// Track 3 acceptance F1: the brief carries the card's own title and
// description (the `cardText` seam) — a card with no plan record used to
// dispatch a bot with nothing but a number and "(no plan)".

/**
 * @param {object} args
 * @param {number|string} args.cardId
 * @param {string} args.tasksDbPath
 * @param {string} args.userLine - the parameterized cleanMsg (spec §5.1)
 * @param {(cardId: number|string) => string|null} args.planForCard
 * @param {(cardId: number|string, tasksDbPath: string) => string} args.cardStatus
 * @param {(cardId: number|string, tasksDbPath: string) => { statuses: string[], terminals: string[] }} args.boardVocab
 * @param {(cardId: number|string, tasksDbPath: string) => { title: string, description: string|null }} [args.cardText]
 *   optional (legacy callers omit it) — absent behaves as `{ title: "", description: null }`
 * @returns {string}
 */
export function cardBriefBlock({ cardId, tasksDbPath, userLine, planForCard, cardStatus, boardVocab, cardText }) {
  const vocab = boardVocab(cardId, tasksDbPath);
  const planBody = planForCard(cardId);
  const text = typeof cardText === "function" ? (cardText(cardId, tasksDbPath) || {}) : {};
  const title = text.title ? " — " + String(text.title).replace(/\s+/g, " ").trim() : "";
  const desc = text.description ? String(text.description).trim() : "(none)";
  return "Work the following card.\n\nCARD #" + cardId + title +
    " (current board status: " + cardStatus(cardId, tasksDbPath) + "; this board's statuses: " + vocab.statuses.join(", ") + ").\n" +
    "DESCRIPTION:\n---\n" + desc + "\n---\nPLAN:\n---\n" +
    (planBody || "(no plan)") + "\n---\n\nUser said: \"" + userLine + "\"\n\n" +
    "Do the work the plan describes; if there is no plan, do what the card's title and description ask. You may use board_move_item to update this card's status " +
    "as you go (only ever use this board's statuses). When you are done, call board_report_result " +
    "with item_id=" + cardId + ", an outcome of success/failure/partial, and a summary_md describing " +
    "what you did — that call is what ends the run, not a status write.";
}
