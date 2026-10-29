/**
 * Project home styles. Every rule is scoped under body.shell (the page only
 * renders in the new shell). Phone first (390 px): one column, every target
 * at least 44 px; from 1024 px the column is capped so lines stay readable.
 * Colours and radii are the Track 2 --crow-* tokens.
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */

export function projectHomeCss() {
  return `<style>
  body.shell .ph { min-width: 0; max-width: 44rem; display: flex; flex-direction: column; gap: 24px; }
  body.shell .ph-section { min-width: 0; }
  body.shell .ph-h { margin: 0 0 8px; font-size: 0.95rem; font-weight: 600; color: var(--crow-text-primary); }
  body.shell .ph-line { margin: 0 0 8px; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  body.shell .ph-sub { margin: 0 0 8px; font-size: 0.85rem; color: var(--crow-text-secondary); }
  body.shell .ph-start-btn {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 48px; min-width: 44px; padding: 0 20px; max-width: 100%;
    border: 0; border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-accent); color: var(--crow-accent-contrast);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  body.shell .ph-start-btn[disabled] { opacity: 0.6; cursor: progress; }
  body.shell .ph-with { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.35rem; margin: 6px 0 0; color: var(--crow-text-secondary); min-height: 44px; overflow-wrap: anywhere; }
  body.shell .ph-with strong { color: var(--crow-text-primary); font-weight: 600; }
  body.shell .ph-change {
    display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; padding: 0 6px;
    border: 0; background: none; font: inherit; color: var(--crow-accent); cursor: pointer; text-decoration: underline;
  }
  body.shell .ph-pick { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 0; font-size: 0.85rem; color: var(--crow-text-secondary); }
  body.shell .ph-pick[hidden] { display: none; }
  body.shell .ph-pick select {
    min-height: 44px; max-width: 100%; padding: 0 10px; font: inherit; font-size: 1rem;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-bg-surface); color: var(--crow-text-primary);
  }
  body.shell .ph-status { margin: 6px 0 0; font-size: 0.85rem; color: var(--crow-text-secondary); }
  body.shell .ph-status:empty { display: none; }
  body.shell .ph-list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  body.shell .ph-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
    min-height: 44px; padding: 8px 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px);
    background: var(--crow-bg-surface); color: var(--crow-text-primary); text-decoration: none;
  }
  body.shell .ph-row:hover { border-color: var(--crow-accent); }
  body.shell .ph-row-title { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
  body.shell .ph-meta { font-size: 0.8rem; color: var(--crow-text-secondary); }
  body.shell .ph-kind {
    flex: none; padding: 2px 8px; border-radius: var(--crow-radius-pill, 999px);
    font-size: 0.75rem; font-weight: 600; background: var(--crow-accent-muted); color: var(--crow-accent);
  }
  body.shell .ph-link {
    display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; padding: 0 4px;
    color: var(--crow-accent); font-weight: 600; text-decoration: none;
  }
  body.shell .ph-link:hover { text-decoration: underline; }
  body.shell .ph-start-btn:focus-visible, body.shell .ph-change:focus-visible,
  body.shell .ph-row:focus-visible, body.shell .ph-link:focus-visible,
  body.shell .ph-pick select:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  body.shell .ph-missing { align-items: flex-start; gap: 12px; }
  /* Where you left off (R1.2 PR 4). A summary row stacks its title over its text. */
  body.shell .ph-summary { flex-direction: column; align-items: flex-start; gap: 4px; }
  body.shell .ph-summary .ph-row-title { flex: none; font-weight: 600; }
  body.shell .ph-summary-text { color: var(--crow-text-secondary); font-size: 0.9rem; overflow-wrap: anywhere; }
  body.shell .ph-kind--outside { background: var(--crow-bg-elevated, var(--crow-bg-surface)); color: var(--crow-text-secondary); border: 1px solid var(--crow-border); }
  body.shell .ph-mem-sheet .ph-list { margin-top: 8px; }
  body.shell .ph-memory .ph-row-title { font-size: 0.9rem; }
  /* The chip already names the project: the header title stays for screen
     readers only (visually hidden, never display:none). */
  body.shell:has([data-ph]) .content-header h2 {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
  }
</style>`;
}
