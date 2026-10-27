/**
 * Board tab lanes — which of the four lanes a card belongs in, derived from
 * real stored state and nothing else (no false status: the lane never claims
 * a bot is working when no session or job holds the card).
 *
 * Pure module: no DB access. laneOf needs only fields a count query can
 * select (status, latest_result_status, action_needed, data_json) plus the
 * lock flag, so the panel's lane counts can be exactly laneOf over the same
 * rows.
 */

import { DEFAULT_BOARD_DEF, isTerminal } from "../../../routes/board-defs.js";

export const LANES = Object.freeze(["needs_you", "working", "up_next", "done"]);

/**
 * True when the card carries an open decision (#535): `data_json.decision`
 * present with no `chosen` and no `expired_at`. `data_json` may be a JSON
 * string or an already-parsed object; absent or malformed is false. Terminal
 * and archived cards are the caller's concern (terminal is laneOf rule 1;
 * archived cards never reach the board).
 */
export function openDecision(card) {
  let data = card?.data_json;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return false; }
  }
  const d = data && typeof data === "object" ? data.decision : null;
  if (!d || typeof d !== "object") return false;
  return !d.chosen && !d.expired_at;
}

/**
 * Lane for one card on its own board def, in this order:
 *   1. terminal status on the card's board        -> done
 *   2. recorded result, action needed, or an open
 *      decision                                   -> needs_you
 *   3. a live session or job holds the card       -> working
 *   4. otherwise                                  -> up_next
 * An "in progress" card nothing holds is up_next, not working.
 */
export function laneOf(card, def, { locked } = {}) {
  if (isTerminal(def || DEFAULT_BOARD_DEF, card.status)) return "done";
  if (
    card.latest_result_status === "recorded" ||
    String(card.action_needed ?? "").trim() !== "" ||
    openDecision(card)
  ) return "needs_you";
  if (locked === true) return "working";
  return "up_next";
}

/**
 * Group cards into the four lanes, each ordered priority ascending then id
 * ascending (the Bot Board's order). `defsByProject` maps project_id to that
 * project's board def; a card whose project has no entry uses the `null`
 * entry if present, else DEFAULT_BOARD_DEF. `lockMap` is lockMapFor's
 * Map<cardId, boolean>: every id has an entry, so "held" is `get(id) === true`,
 * never `has(id)`.
 */
export function groupByLane(cards, defsByProject, lockMap) {
  const out = Object.fromEntries(LANES.map((l) => [l, []]));
  for (const card of cards || []) {
    const def = defsByProject?.get(card.project_id) ?? defsByProject?.get(null) ?? DEFAULT_BOARD_DEF;
    out[laneOf(card, def, { locked: lockMap?.get(card.id) === true })].push(card);
  }
  const byPrioId = (a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || Number(a.id) - Number(b.id);
  for (const l of LANES) out[l].sort(byPrioId);
  return out;
}

// ---- Task 3.3: lane moves map to real actions ----

/** The status "Done" means on a board: "done" when it is terminal there, else the first terminal status. */
export function doneStatus(def) {
  const d = def || DEFAULT_BOARD_DEF;
  return d.terminal_values.includes("done") ? "done" : d.terminal_values[0];
}

/** The status a reopened card goes back to: the board's first non-terminal status. */
export function reopenStatus(def) {
  const d = def || DEFAULT_BOARD_DEF;
  return d.status_values.find((s) => !isTerminal(d, s));
}

const refuse = (reason) => ({ action: "refuse", reason });

/**
 * What dropping a card on `toLane` does. A lane is derived state, so a move
 * is exactly one real write, or a refusal with a reason:
 *   { action: "none" }                         same lane
 *   { action: "move", status }                 moveCard
 *   { action: "accept", resultId, status }     acceptResult (approve + move)
 *   { action: "clear_ask" }                    updateCard action_needed = null
 *   { action: "refuse", reason }               needs_session | needs_reason |
 *                                              locked | use_review |
 *                                              answer_first | bad_lane
 * `latestResult` is the card's newest board_results row ({ id, status }) or
 * null; when given, it is what the lane is computed from. An open decision
 * wins over a recorded result (Ruling P2): answer it first. A card a session
 * holds is never moved or cleared by a lane move (the lock rule the classic
 * board applies to moves and edits), but a recorded result on it can still
 * be accepted: the approval stands and the move is then the lock rule's call.
 */
export function movePlan(card, def, { locked, latestResult } = {}, toLane) {
  const d = def || DEFAULT_BOARD_DEF;
  const c = latestResult === undefined
    ? card
    : { ...card, latest_result_status: latestResult ? latestResult.status : null };
  if (!LANES.includes(toLane)) return refuse("bad_lane");
  const from = laneOf(c, d, { locked });
  if (from === toLane) return { action: "none" };
  if (toLane === "working") return refuse("needs_session");
  if (toLane === "needs_you") return refuse("needs_reason");
  if (from === "working") return refuse("locked");
  if (from === "needs_you") {
    if (openDecision(c)) return refuse("answer_first");
    if (c.latest_result_status === "recorded") {
      return toLane === "done" && latestResult
        ? { action: "accept", resultId: latestResult.id, status: doneStatus(d) }
        : refuse("use_review");
    }
    if (locked === true) return refuse("locked");
    return toLane === "done" ? { action: "move", status: doneStatus(d) } : { action: "clear_ask" };
  }
  if (locked === true) return refuse("locked");
  if (from === "up_next") return { action: "move", status: doneStatus(d) }; // toLane is done
  return { action: "move", status: reopenStatus(d) }; // done -> up_next
}
