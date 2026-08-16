// scripts/pi-bots/card-brief.mjs
//
// Track 3 Task 2 — pure builder for the "Work the following card" prompt
// block, extracted verbatim out of bridge.mjs (the `cardId != null` branch)
// so a later dispatch rail (interactive, not just the mail/discord bridge)
// can compose the identical brief. Deliberately has NO imports from
// bridge.mjs or tracker.mjs — every DB-touching lookup is injected by the
// caller as a function, so this module stays a pure string assembler with
// no cycle risk and no DB of its own.
//
// BYTE-IDENTITY with the historical bridge.mjs text is the binding
// requirement (see tests/card-brief.test.js's golden). The block starts at
// "Work the following card." and ends at "...not a status write." — the
// caller (bridge.mjs) still owns projectHeader/gatewayHint before this text
// and the channel-specific tail (" Then reply with a short summary for the
// gateway thread. One card only.") after it.

/**
 * @param {object} args
 * @param {number|string} args.cardId
 * @param {string} args.tasksDbPath
 * @param {string} args.userLine - the parameterized cleanMsg (spec §5.1)
 * @param {(cardId: number|string) => string|null} args.planForCard
 * @param {(cardId: number|string, tasksDbPath: string) => string} args.cardStatus
 * @param {(cardId: number|string, tasksDbPath: string) => { statuses: string[], terminals: string[] }} args.boardVocab
 * @returns {string}
 */
export function cardBriefBlock({ cardId, tasksDbPath, userLine, planForCard, cardStatus, boardVocab }) {
  const vocab = boardVocab(cardId, tasksDbPath);
  const planBody = planForCard(cardId);
  return "Work the following card.\n\nCARD #" + cardId +
    " (current board status: " + cardStatus(cardId, tasksDbPath) + "; this board's statuses: " + vocab.statuses.join(", ") + ").\nPLAN:\n---\n" +
    (planBody || "(no plan)") + "\n---\n\nUser said: \"" + userLine + "\"\n\n" +
    "Do the work the plan describes. You may use board_move_item to update this card's status " +
    "as you go (only ever use this board's statuses). When you are done, call board_report_result " +
    "with item_id=" + cardId + ", an outcome of success/failure/partial, and a summary_md describing " +
    "what you did — that call is what ends the run, not a status write.";
}
