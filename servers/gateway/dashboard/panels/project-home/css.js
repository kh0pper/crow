/**
 * Project home styles. Every rule is scoped under body.shell (the page only
 * renders in the new shell). Phone first (390 px): one column, every target
 * at least 44 px; from 1024 px the column is capped so lines stay readable.
 * Colours and radii are the Track 2 --crow-* tokens. The start control,
 * the list and the session cards are shared/session-cards.js's (the Chat tab
 * uses them too).
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */

import { sessionUiCss } from "../../shared/session-cards.js";

export function projectHomeCss() {
  return `<style>
  body.shell .ph { min-width: 0; max-width: 44rem; display: flex; flex-direction: column; gap: 24px; }
${sessionUiCss("body.shell")}
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
