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
    align-self: flex-start; display: inline-flex; align-items: center; min-height: 44px; max-width: 100%;
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
  body.shell .svc-private { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; margin-top: 0.25rem; font-size: 0.85rem; }
  body.shell .svc-private-switch { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 44px; cursor: pointer; }
  body.shell .svc-private-switch input[disabled] { cursor: not-allowed; }
  body.shell .svc-private-switch input:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  body.shell .svc-private-note { color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  body.shell .svc-pill {
    flex: none; padding: 4px 8px; border-radius: var(--crow-radius-pill, 999px);
    font-size: 0.75rem; font-weight: 600; max-width: 6.5rem; text-align: center; overflow-wrap: anywhere;
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
  /* Add a service and the connect sheet: a centred dialog, a bottom sheet on a phone. */
  body.shell .svc-sheet {
    width: 100%; max-width: 32rem; max-height: 90vh; margin: auto; padding: 16px; box-sizing: border-box;
    overflow-y: auto; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px);
    background: var(--crow-bg-surface); color: var(--crow-text-primary);
  }
  body.shell .svc-sheet::backdrop { background: rgba(0, 0, 0, 0.35); }
  body.shell .svc-sheet-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; min-width: 0; }
  body.shell .svc-sheet-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 1.15rem; font-weight: 600; overflow-wrap: anywhere; }
  body.shell .svc-icon-btn {
    flex: none; display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px;
    border: 0; border-radius: var(--crow-radius-control, 10px); background: none;
    font: inherit; font-size: 1.25rem; color: var(--crow-text-secondary); cursor: pointer;
  }
  body.shell .svc-icon-btn:hover { background: var(--crow-bg-elevated); }
  body.shell .svc-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  body.shell .svc-field-label { font-size: 0.8rem; color: var(--crow-text-secondary); }
  body.shell .svc-input {
    width: 100%; min-height: 44px; padding: 10px 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-bg-elevated); color: var(--crow-text-primary); font: inherit;
  }
  body.shell .svc-input[aria-invalid="true"] { border-color: var(--crow-error); }
  body.shell .svc-help { margin: 0; font-size: 0.8rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  body.shell .svc-groups { display: flex; flex-direction: column; gap: 14px; margin: 14px 0; }
  body.shell .svc-group { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  body.shell .svc-pick-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  body.shell .svc-pick {
    display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 44px; padding: 10px 12px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px); background: var(--crow-bg-surface);
  }
  body.shell .svc-pick[hidden], body.shell .svc-group[hidden] { display: none; }
  body.shell .svc-pick-name { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
  body.shell .svc-pick-btn {
    flex: none; display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 14px;
    border: 0; border-radius: var(--crow-radius-pill, 999px); background: var(--crow-accent); color: var(--crow-accent-contrast);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  body.shell .svc-pick-btn--install { background: var(--crow-bg-elevated); color: var(--crow-text-primary); }
  body.shell .svc-browse {
    display: inline-flex; align-items: center; min-height: 44px; font-weight: 600; color: var(--crow-accent);
  }
  body.shell .svc-connect { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  body.shell .svc-steps { margin: 0; padding-left: 1.4em; display: flex; flex-direction: column; gap: 6px; line-height: 1.5; overflow-wrap: anywhere; }
  body.shell .svc-step-link { display: inline-flex; align-items: center; min-height: 44px; color: var(--crow-accent); }
  body.shell .svc-for {
    margin: 0; padding: 12px 14px; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px);
    font-size: 0.85rem; color: var(--crow-text-secondary); overflow-wrap: anywhere;
  }
  body.shell .svc-install-step {
    display: flex; gap: 12px; align-items: flex-start; min-width: 0; padding: 14px; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px); background: var(--crow-bg-surface);
  }
  body.shell .svc-install-num {
    flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
    border-radius: 50%; background: var(--crow-bg-elevated); font-weight: 700;
  }
  body.shell .svc-install-step--done .svc-install-num { background: var(--crow-accent); color: var(--crow-accent-contrast); }
  body.shell .svc-install-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  body.shell .svc-install-title { font-weight: 600; overflow-wrap: anywhere; }
  body.shell .svc-link-btn {
    display: inline-flex; align-items: center; min-height: 44px; padding: 0 4px; border: 0; background: none;
    font: inherit; font-weight: 600; color: var(--crow-accent); cursor: pointer;
  }
  body.shell .svc-footnote { margin: 0; font-size: 0.85rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  body.shell .svc-error { margin: 0; color: var(--crow-error); overflow-wrap: anywhere; }
  body.shell .svc-ok { margin: 0; color: var(--crow-success); font-weight: 600; }
  body.shell .svc-error:empty, body.shell .svc-ok:empty { display: none; }
  body.shell .svc-submit {
    display: flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; padding: 0 16px;
    border: 0; border-radius: var(--crow-radius-pill, 999px); background: var(--crow-accent); color: var(--crow-accent-contrast);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  body.shell .svc-submit[disabled] { opacity: 0.6; cursor: progress; }
  body.shell .svc-row-error { font-size: 0.85rem; color: var(--crow-error); overflow-wrap: anywhere; }
  body.shell .svc-icon-btn:focus-visible, body.shell .svc-input:focus-visible, body.shell .svc-pick-btn:focus-visible,
  body.shell .svc-browse:focus-visible, body.shell .svc-step-link:focus-visible, body.shell .svc-submit:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  @media (max-width: 480px) {
    body.shell .svc-sheet {
      max-width: 100%; max-height: 92vh; margin: auto 0 0;
      border-radius: var(--crow-radius-card, 12px) var(--crow-radius-card, 12px) 0 0;
      padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    }
  }
  /* The page draws its own header (project, title, + Add): the layout's title stays for screen
     readers only (visually hidden, never display:none). */
  body.shell:has([data-svc]) .content-header h2 {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
  }
</style>`;
}
