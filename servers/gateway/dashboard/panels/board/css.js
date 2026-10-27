/**
 * Board tab styles. The card face keeps the Bot Board's own styles
 * (botBoardStyles, bb-* classes) so a card looks the same in both modes;
 * every rule this file adds is scoped under body.shell, so a classic page
 * never matches one.
 *
 * Phone first (390 px): the four lanes sit in one horizontal scroll-snap
 * container inside the board (each lane 86% wide so the next one peeks in);
 * the page itself never scrolls sideways. From 1024 px the lanes sit side by
 * side and the chips go (each lane heading carries its count).
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */

import { botBoardStyles } from "../bot-board/css.js";

export function boardCss() {
  return botBoardStyles() + `<style>
  body.shell .sb-board { min-width: 0; max-width: 100%; }
  body.shell .sb-chips {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    margin: 0 0 12px;
  }
  body.shell .sb-chip {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 44px; padding: 4px 6px;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-bg-surface); color: var(--crow-text-secondary);
    font-size: 0.8rem; line-height: 1.2; text-align: center; text-decoration: none;
    overflow-wrap: anywhere;
  }
  body.shell .sb-chip-count { font-weight: 600; color: var(--crow-text-primary); }
  body.shell .sb-chip[aria-selected="true"] { border-color: var(--crow-accent); color: var(--crow-accent); }
  body.shell .sb-chip[aria-selected="true"] .sb-chip-count { color: var(--crow-accent); }
  body.shell .sb-chip:focus-visible,
  body.shell .sb-open:focus-visible::after,
  body.shell .sb-details:focus-visible,
  body.shell .sb-chat-link:focus-visible,
  body.shell .sb-lane:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }

  body.shell .sb-lanes {
    position: relative;
    display: flex; gap: 12px;
    overflow-x: auto; overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory; scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 8px;
  }
  body.shell .sb-lane { flex: 0 0 86%; min-width: 0; scroll-snap-align: start; }
  body.shell .sb-lane-h {
    display: flex; align-items: baseline; gap: 0.4rem;
    margin: 0 0 8px; font-size: 0.95rem; font-weight: 600; color: var(--crow-text-primary);
  }
  body.shell .sb-lane-count { font-weight: 400; color: var(--crow-text-muted); }
  body.shell .sb-cards { list-style: none; margin: 0; padding: 0; }
  body.shell .sb-card { position: relative; margin: 0 0 8px; }
  body.shell .sb-card .bb-card { margin: 0; padding-bottom: 48px; cursor: pointer; }
  body.shell .sb-card:hover .bb-card { border-color: var(--crow-accent); }
  /* Accept/Reject and the no-JS move buttons belong to the classic board's
     script and form flow; lane moves arrive with their own controls. */
  body.shell .sb-card .bb-result-actions,
  body.shell .sb-card .bb-nojs-move { display: none; }
  /* The one tap target: a link stretched over the whole card. */
  body.shell .sb-open::after { content: ""; position: absolute; inset: 0; border-radius: var(--crow-radius-card, 12px); }
  body.shell .sb-details {
    position: absolute; right: 4px; bottom: 2px; z-index: 1;
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px; min-width: 44px; padding: 0 12px;
    color: var(--crow-accent); font-size: 0.85rem; text-decoration: none;
  }
  body.shell .sb-details:hover { text-decoration: underline; }
  body.shell .sb-vh {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  body.shell .sb-empty { color: var(--crow-text-muted); font-size: 0.9rem; margin: 4px 0 12px; }
  body.shell .sb-more { color: var(--crow-text-muted); font-size: 0.8rem; margin: 4px 0 0; }
  body.shell .sb-chat-link {
    display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px;
    border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-accent); color: var(--crow-accent-contrast); text-decoration: none;
  }

  @media (min-width: 1024px) {
    body.shell .sb-chips { display: none; }
    body.shell .sb-lanes {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
      overflow-x: visible; scroll-snap-type: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    body.shell .sb-lanes { scroll-behavior: auto; }
  }
  </style>`;
}
