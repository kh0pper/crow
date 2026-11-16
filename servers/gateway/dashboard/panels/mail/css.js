/**
 * Crow Mail reader styles. Every rule is scoped under .ml, so the page reads the same in the new
 * shell and in classic. Phone first (390 px): one column, no fixed widths, every target at least
 * 44 px; from 1024 px the column is capped so lines stay readable. Colours and radii are the
 * --crow-* tokens, which follow the OS between light and dark.
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */
export function mailCss() {
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
  .ml a:focus-visible, .ml button:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
</style>`;
}

export default mailCss;