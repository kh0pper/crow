/**
 * The project Services page styles. Every rule is scoped under body.shell (the page only renders
 * in the new shell). Phone first (390 px): one column, full-width rows, every target at least
 * 44 px, and no fixed width above 360 px; from wider screens the column is capped so lines stay
 * readable. Colours and radii are the --crow-* tokens.
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */

export function projectServicesCss() {
  return `<style>
  body.shell .svc { min-width: 0; max-width: 44rem; display: flex; flex-direction: column; gap: 16px; }
  body.shell .svc-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
  body.shell .svc-head-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  body.shell .svc-project {
    align-self: flex-start; display: inline-flex; align-items: center; min-height: 32px; max-width: 100%;
    font-size: 0.8rem; color: var(--crow-text-secondary); text-decoration: none; overflow-wrap: anywhere;
  }
  body.shell .svc-project:hover { color: var(--crow-accent); text-decoration: underline; }
  body.shell .svc-title { margin: 0; font-size: 1.25rem; font-weight: 600; color: var(--crow-text-primary); }
  body.shell .svc-add {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px; min-width: 44px; padding: 0 16px;
    border: 0; border-radius: var(--crow-radius-pill, 999px);
    background: var(--crow-accent); color: var(--crow-accent-contrast);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  body.shell .svc-section { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  body.shell .svc-label {
    margin: 0; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--crow-text-secondary);
  }
  body.shell .svc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  body.shell .svc-row {
    position: relative; display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 44px;
    padding: 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px);
    background: var(--crow-bg-surface); color: var(--crow-text-primary);
  }
  body.shell .svc-icon {
    flex: none; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
    border-radius: var(--crow-radius-control, 10px); background: var(--crow-bg-elevated);
    color: var(--crow-text-primary); font-weight: 700;
  }
  body.shell .svc-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  body.shell .svc-name { font-weight: 600; overflow-wrap: anywhere; }
  body.shell .svc-sub { font-size: 0.85rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  body.shell .svc-pill {
    flex: none; padding: 4px 8px; border-radius: var(--crow-radius-pill, 999px);
    font-size: 0.75rem; font-weight: 600; white-space: nowrap;
    background: var(--crow-bg-elevated); color: var(--crow-text-secondary);
  }
  body.shell .svc-pill--active { background: color-mix(in srgb, var(--crow-success) 16%, transparent); color: var(--crow-success); }
  body.shell .svc-pill--error, body.shell .svc-pill--needs_reauth { background: color-mix(in srgb, var(--crow-error) 16%, transparent); color: var(--crow-error); }
  body.shell .svc-pill--needs_install { background: color-mix(in srgb, var(--crow-warning) 16%, transparent); color: var(--crow-warning); }
  body.shell .svc-menu { flex: none; }
  body.shell .svc-menu > summary {
    list-style: none; display: flex; align-items: center; justify-content: center;
    min-width: 44px; min-height: 44px; border-radius: var(--crow-radius-control, 10px);
    color: var(--crow-text-secondary); font-size: 1.25rem; cursor: pointer;
  }
  body.shell .svc-menu > summary::-webkit-details-marker { display: none; }
  body.shell .svc-menu[open] > summary { background: var(--crow-bg-elevated); }
  body.shell .svc-menu-list {
    position: absolute; right: 8px; top: calc(100% - 4px); z-index: 5;
    display: flex; flex-direction: column; min-width: 12rem; max-width: calc(100% - 16px); padding: 4px;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px);
    background: var(--crow-bg-elevated); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }
  body.shell .svc-menu-item {
    display: flex; align-items: center; min-height: 44px; padding: 0 12px;
    border: 0; border-radius: var(--crow-radius-control, 10px); background: none;
    font: inherit; text-align: left; color: var(--crow-text-primary); cursor: pointer;
  }
  body.shell .svc-menu-item:hover { background: var(--crow-bg-surface); }
  body.shell .svc-menu-item--danger { color: var(--crow-error); }
  body.shell .svc-menu-item[disabled] { opacity: 0.6; cursor: progress; }
  body.shell .svc-empty { margin: 0; color: var(--crow-text-secondary); }
  body.shell .svc-note {
    display: flex; flex-direction: column; gap: 6px; padding: 12px 14px;
    border: 1px dashed var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-card, 12px);
    font-size: 0.85rem; line-height: 1.45; color: var(--crow-text-secondary);
  }
  body.shell .svc-note p { margin: 0; overflow-wrap: anywhere; }
  body.shell .svc-also-line { margin: 0; line-height: 1.5; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  body.shell .svc-inline {
    display: inline-flex; align-items: center; min-height: 44px; padding: 0 4px;
    border: 0; background: none; font: inherit; font-weight: 600; color: var(--crow-accent);
    cursor: pointer; text-decoration: underline;
  }
  body.shell .svc-status { margin: 0; font-size: 0.85rem; color: var(--crow-text-secondary); }
  body.shell .svc-status:empty { display: none; }
  body.shell .svc-add:focus-visible, body.shell .svc-project:focus-visible, body.shell .svc-menu > summary:focus-visible,
  body.shell .svc-menu-item:focus-visible, body.shell .svc-inline:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  /* The page draws its own header (project, title, + Add): the layout's title stays for screen
     readers only (visually hidden, never display:none). */
  body.shell:has([data-svc]) .content-header h2 {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
  }
</style>`;
}
