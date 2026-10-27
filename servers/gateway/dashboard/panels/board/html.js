/**
 * Board tab markup: lane chips with real counts, then the four lanes. Each
 * card reuses the Bot Board's face (cardFaceHtml) so a card looks the same in
 * both modes; a stretched link over it opens the card's conversation (or,
 * without one, its details), and a Details link always reaches the full card
 * (detailsHref: its drawer on the classic board).
 *
 * Every bot- or operator-written value goes through escapeHtml (the face does
 * its own escaping).
 *
 * Lane moves (Task 3.3): each card's Move button carries its lane
 * (`data-from`), per other lane the reason a move there is refused
 * (`data-refuse`, movePlan over the same stored state the lanes come from),
 * and what the card showed when it was drawn: its newest result id
 * (`data-seen-result`, empty for none) and its ask version
 * (`data-seen-version`, cardVersion). Every move, drag and Accept sends those
 * back, and the server refuses a move made against a card that has changed.
 * The client offers two paths to the one move route: a Move button that opens a sheet with the four
 * lanes (phone and keyboard), and drag between lanes (desktop). Refused lanes
 * are disabled with their reason; nothing moves until the server says so.
 */

import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { cardFaceHtml } from "../bot-board/html.js";
import { DEFAULT_BOARD_DEF } from "../../../routes/board-defs.js";
import { LANES, movePlan, openDecision, cardVersion } from "./lanes.js";

export const LANE_LABEL_KEY = Object.freeze({
  needs_you: "shell.laneNeedsYou",
  working: "shell.laneWorking",
  up_next: "shell.laneUpNext",
  done: "shell.laneDone",
});

const LANE_EMPTY_KEY = Object.freeze({
  needs_you: "shell.laneEmptyNeedsYou",
  working: "shell.laneEmptyWorking",
  up_next: "shell.laneEmptyUpNext",
  done: "shell.laneEmptyDone",
});

/**
 * The Bot Board face, minus what only the classic board's script drives:
 * there it is a focusable role=button that opens the drawer and can be
 * dragged. Here the stretched link is the one tap target, so the face is
 * plain content. Its no-JS move form is hidden by css.js (the Move sheet
 * replaces it); its Accept/Reject buttons stay, driven by this tab's client.
 */
/**
 * Where Details goes: the card's drawer (plan, results, history, decision)
 * on the board of the bot on its project, through the classic client's
 * one-shot `#open=N` deep link (openCardById). `botByCard` maps card id to
 * that bot's id (panels/board.js). A card no card board shows (no project,
 * or no bot on it) gets the standalone card view, `?card=N`, which is also
 * what works without JS.
 */
export function detailsHref(card, botByCard) {
  const id = encodeURIComponent(String(card.id));
  const bot = botByCard && botByCard.get(Number(card.id));
  return bot ? `/dashboard/bot-board?bot=${encodeURIComponent(bot)}#open=${id}` : `/dashboard/bot-board?card=${id}`;
}

/** Where tapping a card goes: its conversation if it has one, else its details (detailsHref). */
export function cardHref(card, threadByCard, botByCard) {
  const thread = threadByCard && threadByCard.get(Number(card.id));
  return thread ? `/dashboard/perch#${encodeURIComponent(thread)}` : detailsHref(card, botByCard);
}

// The face's Accept button. On a card with an open decision Accept can never
// succeed here (answer_first wins, Ruling P2), so the Board tab drops it.
const FACE_ACCEPT_RE = /<button type="button" class="bb-btn bb-sec" data-result-action="accept">[^<]*<\/button>/;

function shellFace(card, locked, lang, def, bird) {
  const face = cardFaceHtml(card, locked, lang, def, bird)
    .replace(' tabindex="0" role="button" ', " ")
    .replace('draggable="true"', 'draggable="false"');
  return openDecision(card) ? face.replace(FACE_ACCEPT_RE, "") : face;
}

/** Reason key (movePlan) -> i18n key of the sentence the operator sees. */
export const REFUSE_KEY = Object.freeze({
  needs_session: "shell.refuseWorking",
  needs_reason: "shell.refuseNeedsYou",
  locked: "shell.refuseLocked",
  use_review: "shell.refuseReview",
  answer_first: "shell.refuseDecision",
  // Not a movePlan refusal: the route's ask to confirm a failed result. The
  // client shows the confirm dialog; this text is its fallback.
  confirm_failure: "shell.confirmFailure",
});

/** { lane: reason } for every other lane a move to is refused, from movePlan over stored state. */
export function refusalsFor(card, def, locked) {
  const latestResult = card.latest_result_id != null
    ? { id: Number(card.latest_result_id), status: String(card.latest_result_status) }
    : null;
  const out = {};
  for (const lane of LANES) {
    const plan = movePlan(card, def, { locked, latestResult }, lane);
    if (plan.action === "refuse") out[lane] = plan.reason;
  }
  return out;
}

function cardHtml(card, ctx, lang, lane) {
  const id = escapeHtml(String(card.id));
  const def = ctx.defs.get(card.project_id) ?? ctx.defs.get(null) ?? DEFAULT_BOARD_DEF;
  const locked = ctx.lockMap.get(card.id) === true;
  const bird = ctx.birds.get(card.id) || null;
  const title = escapeHtml(String(card.title || ""));
  const refuse = escapeHtml(JSON.stringify(refusalsFor(card, def, locked)));
  const seenResult = card.latest_result_id != null ? escapeHtml(String(Number(card.latest_result_id))) : "";
  const seen = `data-seen-result="${seenResult}" data-seen-version="${escapeHtml(cardVersion(card))}"`;
  return `<li class="sb-card" data-card="${id}">` +
    shellFace(card, locked, lang, def, bird) +
    `<a class="sb-open" href="${escapeHtml(cardHref(card, ctx.threads, ctx.botByCard))}" draggable="false"><span class="sb-vh" data-sb-name>#${id} ${title}</span></a>` +
    `<button type="button" class="sb-move" data-sb-move data-from="${lane}" data-refuse="${refuse}" ${seen} aria-haspopup="dialog">${escapeHtml(t("shell.move", lang))}<span class="sb-vh"> #${id} ${title}</span></button>` +
    `<a class="sb-details" href="${escapeHtml(detailsHref(card, ctx.botByCard))}" draggable="false">${escapeHtml(t("shell.cardDetails", lang))}</a>` +
    `</li>`;
}

function laneHtml(lane, board, lang) {
  const cards = board.lanes[lane] || [];
  const n = board.counts[lane] || 0;
  const label = escapeHtml(t(LANE_LABEL_KEY[lane], lang));
  const body = cards.length
    ? `<ul class="sb-cards">${cards.map((c) => cardHtml(c, board, lang, lane)).join("")}</ul>`
    : `<p class="sb-empty">${escapeHtml(t(LANE_EMPTY_KEY[lane], lang))}</p>`;
  const more = n > cards.length
    ? `<p class="sb-more">${escapeHtml(fill(t("shell.laneMore", lang), { shown: cards.length, n }))}</p>`
    : "";
  return `<section class="sb-lane" id="sb-lane-${lane}" data-lane="${lane}" aria-labelledby="sb-lane-${lane}-h">` +
    `<h3 class="sb-lane-h" id="sb-lane-${lane}-h">${label} <span class="sb-lane-count">${n}</span></h3>` +
    `<p class="sb-drop-hint" data-drop-hint hidden></p>` +
    body + more + `</section>`;
}

/** The empty board's sentence for a scope: a project, Unassigned, or Everything. */
function emptyKey(scope) {
  if (scope && scope.projectId != null) return "shell.boardEmpty";
  if (scope && scope.unassigned) return "shell.boardEmptyUnassigned";
  return "shell.boardEmptyAll";
}

/**
 * The whole board. `board` is panels/board.js loadBoard()'s result; `scope`
 * is the shell scope it was loaded for (req.crowScope; Everything if absent).
 */
export function boardHtml(board, lang, scope = { all: true }) {
  const total = LANES.reduce((s, l) => s + (board.counts[l] || 0), 0);
  if (!total) {
    return `<div class="sb-board sb-board-empty">` +
      `<p class="sb-empty">${escapeHtml(t(emptyKey(scope), lang))}</p>` +
      `<p><a class="sb-chat-link" href="/dashboard/perch">${escapeHtml(t("shell.boardEmptyChat", lang))}</a></p>` +
      `</div>`;
  }
  const chips = LANES.map((l) =>
    `<a class="sb-chip" href="#sb-lane-${l}" data-lane="${l}" aria-controls="sb-lane-${l}">` +
    `<span class="sb-chip-label">${escapeHtml(t(LANE_LABEL_KEY[l], lang))}</span> ` +
    `<span class="sb-chip-count">${board.counts[l] || 0}</span></a>`).join("");
  return `<div class="sb-board" data-sb-board data-reasons="${escapeHtml(JSON.stringify(reasonTexts(lang)))}">` +
    `<div class="sb-chips" aria-label="${escapeHtml(t("shell.boardLanes", lang))}">${chips}</div>` +
    `<p class="sb-status" role="status" aria-live="polite" data-sb-status></p>` +
    `<div class="sb-lanes">${LANES.map((l) => laneHtml(l, board, lang)).join("")}</div>` +
    moveSheetHtml(lang) +
    confirmHtml(lang) +
    `</div>`;
}

/** Every sentence the client may show for a move, keyed by movePlan reason (plus here / failed). */
function reasonTexts(lang) {
  const out = Object.fromEntries(Object.entries(REFUSE_KEY).map(([r, k]) => [r, t(k, lang)]));
  out.here = t("shell.moveHere", lang);
  out.failed = t("shell.laneMoveFailed", lang);
  return out;
}

/** The Move sheet: one per board, filled by the client for the card it opens on. */
function moveSheetHtml(lang) {
  const lanes = LANES.map((l) =>
    `<li><button type="button" class="sb-sheet-lane" data-to="${l}" aria-describedby="sb-sheet-sub-${l}">` +
    `<span class="sb-sheet-label">${escapeHtml(t(LANE_LABEL_KEY[l], lang))}</span>` +
    `<span class="sb-sheet-sub" id="sb-sheet-sub-${l}"></span></button></li>`).join("");
  return `<dialog class="sb-sheet" data-sb-sheet aria-labelledby="sb-sheet-h">` +
    `<h3 class="sb-sheet-h" id="sb-sheet-h">${escapeHtml(t("shell.moveTo", lang))}</h3>` +
    `<p class="sb-sheet-card" data-sb-sheet-card></p>` +
    `<ul class="sb-sheet-lanes">${lanes}</ul>` +
    `<button type="button" class="sb-sheet-cancel" data-sb-sheet-cancel>${escapeHtml(t("shell.moveCancel", lang))}</button>` +
    `</dialog>`;
}

/**
 * The confirm before a failed result is accepted (operator ruling): an
 * in-page modal dialog like the Move sheet, No first (and focused), Yes
 * re-sends the move with accept_failure. Filled and opened by the client
 * when the server answers 409 confirm_failure.
 */
function confirmHtml(lang) {
  return `<dialog class="sb-sheet sb-confirm" data-sb-confirm aria-labelledby="sb-confirm-text">` +
    `<p class="sb-confirm-text" id="sb-confirm-text" data-sb-confirm-text>${escapeHtml(t("shell.confirmFailure", lang))}</p>` +
    `<div class="sb-confirm-actions">` +
    `<button type="button" class="sb-confirm-btn" data-sb-confirm-no>${escapeHtml(t("shell.confirmFailureNo", lang))}</button>` +
    `<button type="button" class="sb-confirm-btn sb-confirm-yes" data-sb-confirm-yes>${escapeHtml(t("shell.confirmFailureYes", lang))}</button>` +
    `</div></dialog>`;
}
