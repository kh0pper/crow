/**
 * Crow Mail reader styles. Every rule is scoped under .ml, so the page reads the same in the new
 * shell and in classic. Phone first (390 px): one column, no fixed widths, every target at least
 * 44 px; from 1024 px the column is capped so lines stay readable. Colours and radii are the
 * --crow-* tokens, which follow the OS between light and dark.
 *
 * The list rules (chips, the folder drawer and the message rows) come with the inbox view, which is
 * why they are behind `inbox`: a page that draws only an empty state ships only that state's rules.
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */

/** Account chips, the per-account folder drawer, and one row per message. */
const INBOX_RULES = `
  .ml-chips { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
  .ml-chip {
    display: inline-flex; align-items: center; min-height: 44px; max-width: 100%; padding: 0 14px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-pill); background: transparent;
    color: var(--crow-text-primary); font-size: 0.9rem; text-decoration: none; overflow-wrap: anywhere;
  }
  .ml-chip[aria-current="page"] { background: var(--crow-accent); border-color: var(--crow-accent); color: var(--crow-accent-contrast); font-weight: 600; }
  .ml-drawer { border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px); background: var(--crow-bg-surface); min-width: 0; }
  .ml-drawer-summary { display: flex; align-items: center; min-height: 44px; padding: 0 14px; box-sizing: border-box; cursor: pointer; font-size: 0.9rem; font-weight: 600; }
  .ml-drawer-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 0 12px 12px; }
  .ml-drawer-account { margin: 0; font-size: 0.78rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  .ml-folders { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ml-folder-item { min-width: 0; }
  .ml-folder {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 0 8px;
    box-sizing: border-box; border-radius: 8px; color: var(--crow-text-primary); font-size: 0.9rem; text-decoration: none;
    overflow-wrap: anywhere;
  }
  .ml-folder[aria-current="page"] { background: var(--crow-bg-elevated); font-weight: 600; }
  .ml-count { flex: none; font-size: 0.8rem; color: var(--crow-text-secondary); }
  .ml-list { display: flex; flex-direction: column; min-width: 0; }
  .ml-row {
    display: grid; min-height: 44px; min-width: 0; padding: 10px 12px; box-sizing: border-box; grid-template-columns: auto 1fr auto;
    grid-template-areas: "dot sender time" "dot subject subject" "dot snippet snippet"; column-gap: 8px; row-gap: 2px;
    border-bottom: 1px solid var(--crow-border); color: var(--crow-text-primary); text-decoration: none;
  }
  .ml-dot { grid-area: dot; align-self: center; width: 8px; height: 8px; border-radius: 50%; background: var(--crow-accent); }
  .ml-sender { grid-area: sender; min-width: 0; font-size: 0.9rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ml-subject { grid-area: subject; min-width: 0; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ml-snippet { grid-area: snippet; min-width: 0; font-size: 0.85rem; color: var(--crow-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ml-time { grid-area: time; font-size: 0.8rem; color: var(--crow-text-secondary); white-space: nowrap; }
  .ml-more {
    display: inline-flex; align-items: center; justify-content: center; align-self: flex-start; min-height: 44px; padding: 0 16px;
    box-sizing: border-box; border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-pill);
    color: var(--crow-text-primary); font-size: 0.9rem; text-decoration: none;
  }`;

/**
 * @param {{inbox?: boolean}} options `inbox` adds the list rules (chips, folder drawer, message rows)
 * @returns {string}
 */
export function mailCss({ inbox = false } = {}) {
  return `<style>
  .ml { max-width: 44rem; min-width: 0; display: flex; flex-direction: column; gap: 12px; color: var(--crow-text-primary); }
  .ml-title { margin: 0; font-size: 1.5rem; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
  .ml-empty {
    display: flex; flex-direction: column; align-items: flex-start; gap: 12px; min-width: 0; padding: 16px;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px); background: var(--crow-bg-surface);
  }
  .ml-note { margin: 0; font-size: 0.95rem; line-height: 1.45; overflow-wrap: anywhere; }
  .ml-btn {
    display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; box-sizing: border-box;
    border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-pill); background: transparent;
    color: var(--crow-text-primary); font: inherit; font-size: 0.9rem; text-decoration: none; cursor: pointer; text-align: center;
  }
  .ml-btn--primary { background: var(--crow-accent); border-color: var(--crow-accent); color: var(--crow-accent-contrast); font-weight: 600; }
  .ml a:focus-visible, .ml button:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }${inbox ? INBOX_RULES : ""}
</style>`;
}

export default mailCss;