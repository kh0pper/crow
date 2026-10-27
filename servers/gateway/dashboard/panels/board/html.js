/**
 * Board tab markup: lane chips with real counts, then the four lanes. Each
 * card reuses the Bot Board's face (cardFaceHtml) so a card looks the same in
 * both modes; a stretched link over it opens the card's conversation (or its
 * classic card view), and a Details link always reaches the full card.
 *
 * Every bot- or operator-written value goes through escapeHtml (the face does
 * its own escaping).
 */

import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { cardFaceHtml } from "../bot-board/html.js";
import { DEFAULT_BOARD_DEF } from "../../../routes/board-defs.js";
import { LANES } from "./lanes.js";

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
 * plain content. (Its Accept/Reject and no-JS move controls are hidden by
 * css.js until lane moves land.)
 */
/** Where tapping a card goes: its conversation if it has one, else its classic card view. */
export function cardHref(card, threadByCard) {
  const thread = threadByCard && threadByCard.get(Number(card.id));
  return thread
    ? `/dashboard/perch#${encodeURIComponent(thread)}`
    : `/dashboard/bot-board?card=${encodeURIComponent(String(card.id))}`;
}

function shellFace(card, locked, lang, def, bird) {
  return cardFaceHtml(card, locked, lang, def, bird)
    .replace(' tabindex="0" role="button" ', " ")
    .replace('draggable="true"', 'draggable="false"');
}

function cardHtml(card, ctx, lang) {
  const id = escapeHtml(String(card.id));
  const def = ctx.defs.get(card.project_id) ?? ctx.defs.get(null) ?? DEFAULT_BOARD_DEF;
  const locked = ctx.lockMap.get(card.id) === true;
  const bird = ctx.birds.get(card.id) || null;
  const title = escapeHtml(String(card.title || ""));
  return `<li class="sb-card" data-card="${id}">` +
    shellFace(card, locked, lang, def, bird) +
    `<a class="sb-open" href="${escapeHtml(cardHref(card, ctx.threads))}"><span class="sb-vh">#${id} ${title}</span></a>` +
    `<a class="sb-details" href="/dashboard/bot-board?card=${encodeURIComponent(String(card.id))}">${escapeHtml(t("shell.cardDetails", lang))}</a>` +
    `</li>`;
}

function laneHtml(lane, board, lang) {
  const cards = board.lanes[lane] || [];
  const n = board.counts[lane] || 0;
  const label = escapeHtml(t(LANE_LABEL_KEY[lane], lang));
  const body = cards.length
    ? `<ul class="sb-cards">${cards.map((c) => cardHtml(c, board, lang)).join("")}</ul>`
    : `<p class="sb-empty">${escapeHtml(t(LANE_EMPTY_KEY[lane], lang))}</p>`;
  const more = n > cards.length
    ? `<p class="sb-more">${escapeHtml(fill(t("shell.laneMore", lang), { shown: cards.length, n }))}</p>`
    : "";
  return `<section class="sb-lane" id="sb-lane-${lane}" data-lane="${lane}" aria-labelledby="sb-lane-${lane}-h">` +
    `<h3 class="sb-lane-h" id="sb-lane-${lane}-h">${label} <span class="sb-lane-count">${n}</span></h3>` +
    body + more + `</section>`;
}

/** The whole board. `board` is panels/board.js loadBoard()'s result. */
export function boardHtml(board, lang) {
  const total = LANES.reduce((s, l) => s + (board.counts[l] || 0), 0);
  if (!total) {
    return `<div class="sb-board sb-board-empty">` +
      `<p class="sb-empty">${escapeHtml(t("shell.boardEmpty", lang))}</p>` +
      `<p><a class="sb-chat-link" href="/dashboard/perch">${escapeHtml(t("shell.boardEmptyChat", lang))}</a></p>` +
      `</div>`;
  }
  const chips = LANES.map((l) =>
    `<a class="sb-chip" href="#sb-lane-${l}" data-lane="${l}" aria-controls="sb-lane-${l}">` +
    `<span class="sb-chip-label">${escapeHtml(t(LANE_LABEL_KEY[l], lang))}</span> ` +
    `<span class="sb-chip-count">${board.counts[l] || 0}</span></a>`).join("");
  return `<div class="sb-board" data-sb-board>` +
    `<div class="sb-chips" aria-label="${escapeHtml(t("shell.boardLanes", lang))}">${chips}</div>` +
    `<div class="sb-lanes">${LANES.map((l) => laneHtml(l, board, lang)).join("")}</div>` +
    `</div>`;
}
