/**
 * Schedule panel: scoped styles (Perch tokens only, no new colours; the Skills page's patterns).
 * Phone first; ≥ 769px pins the one `.sc-detail` as a side pane. Every interactive target is at
 * least 44px. Fixed pieces (the toast, the pane, the sheet) reserve the player bar themselves
 * (--crow-player-h).
 */
export const SCHEDULE_CSS = `<style>
  .sc-page { --sc-pane-w: min(420px, 38vw); max-width: 100%; }
  .sc-vh { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .sc-lede { margin: 0 0 var(--crow-space-3); color: var(--crow-text-secondary); }
  .sc-muted { color: var(--crow-text-muted); font-size: 0.85rem; margin: 0; }
  .sc-mono { font-family: var(--crow-mono-font); font-size: 0.85em; overflow-wrap: anywhere; }
  .sc-page a:focus-visible, .sc-page button:focus-visible, .sc-page summary:focus-visible, .sc-page input:focus-visible, .sc-page [tabindex]:focus-visible, .sc-dialog :focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  .sc-page .btn, .sc-dialog .btn { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-align: center; }
  .sc-page .btn-sm { min-height: 44px; }
  .sc-inline-form { display: inline-flex; margin: 0; max-width: 100%; }
  .sc-inline-form .btn { max-width: 100%; white-space: normal; }

  .sc-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .sc-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 0.78rem; font-weight: 500; padding: 2px 8px; border-radius: var(--crow-radius-pill); max-width: 100%; overflow-wrap: anywhere; }
  .sc-chip-accent { background: var(--crow-accent-muted); color: var(--crow-accent); }
  .sc-chip-info { background: color-mix(in srgb, var(--crow-info) 14%, transparent); color: var(--crow-info); }
  .sc-chip-plain { background: var(--crow-bg-elevated); color: var(--crow-text-secondary); }
  .sc-chip-muted { background: transparent; color: var(--crow-text-muted); border: 1px solid var(--crow-border); }
  .sc-st { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  .sc-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
  .sc-st-info { color: var(--crow-info); } .sc-st-warning { color: var(--crow-warning); } .sc-st-error { color: var(--crow-error); }
  .sc-st-muted { color: var(--crow-text-muted); } .sc-st-ok { color: var(--crow-success); }

  .sc-attn { background: var(--crow-bg-surface); border: 1px solid var(--crow-border); border-left: 4px solid var(--crow-warning); border-radius: var(--crow-radius-card); padding: 10px 12px; margin: 0 0 14px; }
  .sc-attn.ok { border-left-color: var(--crow-success); display: flex; align-items: center; min-height: 44px; }
  .sc-attn h2 { margin: 2px 0 6px; font-size: 1rem; font-family: var(--crow-body-font); }
  .sc-attn.ok h2 { margin: 0; font-weight: 600; }
  .sc-attn-list { list-style: none; margin: 0; padding: 0; }
  .sc-attn-item { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--crow-border); font-size: 0.88rem; }
  .sc-attn-item:first-child { border-top: 0; }
  .sc-attn-text { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
  .sc-attn-text > span { display: block; color: var(--crow-text-secondary); font-size: 0.84rem; }
  .sc-attn-name { color: inherit; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; }
  .sc-attn-name:hover { text-decoration: underline; }
  .sc-attn-acts { display: flex; flex-wrap: wrap; gap: 6px; }

  .sc-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 var(--crow-space-3); }
  .sc-filter { display: inline-flex; align-items: center; min-height: 44px; padding: 0 14px; border-radius: var(--crow-radius-pill); border: 1px solid var(--crow-border); color: var(--crow-text-secondary); text-decoration: none; }
  .sc-filter[aria-current="true"] { background: var(--crow-accent-muted); color: var(--crow-accent); border-color: transparent; }

  .sc-day, .sc-fold { background: var(--crow-bg-surface); border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card); margin: 0 0 12px; overflow: hidden; }
  .sc-day-h, .sc-fold-h { display: flex; align-items: baseline; gap: 8px; min-height: 48px; padding: 12px 14px 8px; margin: 0; font-size: 0.95rem; font-family: var(--crow-body-font); }
  .sc-day-date { color: var(--crow-text-muted); font-weight: 400; font-size: 0.85rem; }
  .sc-fold-h { cursor: pointer; list-style: none; align-items: center; padding: 0 14px; }
  .sc-fold-h::-webkit-details-marker { display: none; }
  .sc-fold-h::after { content: "▸"; color: var(--crow-text-muted); margin-left: auto; }
  .sc-fold[open] > .sc-fold-h::after { content: "▾"; }
  .sc-list { list-style: none; margin: 0; padding: 0; }
  .sc-row { border-top: 1px solid var(--crow-border); }
  .sc-row.sel { background: var(--crow-bg-elevated); }
  .sc-hit { display: flex; align-items: flex-start; gap: 12px; min-height: 56px; padding: 10px 14px; color: inherit; text-decoration: none; }
  .sc-at { flex: none; min-width: 5.5rem; max-width: 40%; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--crow-text-secondary); font-size: 0.88rem; padding-top: 1px; overflow-wrap: anywhere; }
  .sc-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .sc-name { font-weight: 600; overflow-wrap: anywhere; }
  .sc-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 0.8rem; color: var(--crow-text-muted); overflow-wrap: anywhere; }
  .sc-ro { cursor: default; }
  .sc-row-ro .sc-name { font-weight: 500; }
  .sc-ro-label { display: inline-flex; align-items: center; gap: 3px; color: var(--crow-text-muted); }
  .sc-lock { flex: none; }
  .sc-host + .sc-host { border-top: 1px solid var(--crow-border); }
  .sc-host-h { flex-wrap: wrap; }
  .sc-host-empty { padding: 0 14px 12px; }
  .sc-copy { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: 100%; }
  .sc-copy-text { display: inline-block; padding: 6px 8px; border-radius: var(--crow-radius-control); background: var(--crow-bg-elevated); border: 1px solid var(--crow-border); user-select: all; -webkit-user-select: all; max-width: 100%; box-sizing: border-box; }
  .sc-empty { display: grid; justify-items: center; text-align: center; gap: 6px; padding: 22px 16px; margin: 0 0 12px; border: 1px dashed var(--crow-border-strong); border-radius: var(--crow-radius-card); color: var(--crow-text-secondary); font-size: 0.9rem; }
  .sc-empty b { color: var(--crow-text-primary); }
  .sc-foot { margin: 16px 0 0; font-size: 0.82rem; color: var(--crow-text-muted); }

  .sc-switch-form { display: inline-flex; margin: 0; flex: none; }
  .sc-switch { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 10px 0 4px; background: none; border: 1px solid var(--crow-border); color: var(--crow-text-primary); cursor: pointer; font: inherit; border-radius: var(--crow-radius-control); }
  .sc-switch-track { position: relative; width: 44px; height: 26px; border-radius: 13px; background: var(--crow-border-strong); flex: none; }
  .sc-switch-track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--crow-bg-surface); transition: transform 0.15s; }
  .sc-switch[aria-checked="true"] .sc-switch-track { background: var(--crow-accent); }
  .sc-switch[aria-checked="true"] .sc-switch-track::after { transform: translateX(18px); }

  .sc-detail { padding: 12px 14px 16px; background: var(--crow-bg-elevated); border-top: 1px solid var(--crow-border); font-size: 0.9rem; overflow-wrap: anywhere; }
  .sc-d-head { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
  #sc-detail-h:focus, #sc-confirm-text:focus { outline: none; }
  .sc-d-head h2 { margin: 0; font-size: 1.1rem; flex: 1; min-width: 0; font-family: var(--crow-body-font); overflow-wrap: anywhere; }
  .sc-close { display: inline-grid; place-items: center; min-width: 44px; min-height: 44px; border: 0; background: none; color: var(--crow-text-secondary); text-decoration: none; font: inherit; cursor: pointer; border-radius: 10px; }
  .sc-d-sec { margin: 12px 0; display: flex; flex-direction: column; gap: 3px; }
  .sc-d-sec > b { display: block; font-size: 0.74rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--crow-text-muted); margin-bottom: 2px; }
  .sc-d-goal { margin: 4px 0 0; color: var(--crow-text-secondary); }
  .sc-d-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
  .sc-next { margin: 0; padding-left: 1.2rem; }
  .sc-next li { margin: 2px 0; }
  .sc-runs { list-style: none; margin: 0; padding: 0; }
  .sc-run { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; padding: 6px 0; border-top: 1px solid var(--crow-border); }
  .sc-run:first-child { border-top: 0; }
  .sc-run-at { color: var(--crow-text-muted); font-size: 0.82rem; }
  .sc-note { padding: 10px 12px; border-radius: 10px; font-size: 0.86rem; background: var(--crow-bg-surface); margin: 8px 0; }
  .sc-note-err { background: color-mix(in srgb, var(--crow-error) 14%, transparent); }
  .sc-note-ok { background: color-mix(in srgb, var(--crow-success) 14%, transparent); }
  .sc-note-ok:focus, .sc-note-err:focus { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  .sc-confirm { margin-top: 12px; padding: 12px; border: 1px solid var(--crow-error); border-radius: 10px; background: color-mix(in srgb, var(--crow-error) 8%, transparent); }
  .sc-confirm p { margin: 0; font-weight: 600; }

  /* margin: auto again: the layout's global reset zeroes it, which pins a modal dialog to the left edge. */
  .sc-dialog { margin: auto; width: min(560px, calc(100vw - 24px)); max-height: calc(100dvh - var(--crow-player-h, 0px) - 24px); overflow: auto; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card); background: var(--crow-bg-surface); color: var(--crow-text-primary); padding: 12px 16px max(16px, env(safe-area-inset-bottom)); z-index: 1200; }
  .sc-dialog::backdrop { background: color-mix(in srgb, var(--crow-bg-deep) 55%, transparent); }
  .sc-types { border: 0; padding: 0; margin: 0 0 12px; display: flex; flex-wrap: wrap; gap: 8px; }
  .sc-types legend { font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; padding: 0; }
  .sc-type, .sc-type-link { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control); color: var(--crow-text-primary); text-decoration: none; cursor: pointer; max-width: 100%; flex-wrap: wrap; }
  .sc-type:has(input:checked) { border-color: var(--crow-accent); background: var(--crow-accent-muted); }
  .sc-type input { width: 20px; height: 20px; accent-color: var(--crow-accent); margin: 0; }
  .sc-field { display: block; font-weight: 600; font-size: 0.88rem; margin: 10px 0 4px; }
  .sc-input { width: 100%; box-sizing: border-box; min-height: 44px; padding: 8px 12px; font: inherit; color: var(--crow-text-primary); background: var(--crow-bg-surface); border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control); }
  .sc-hint { margin: 4px 0 0; font-size: 0.8rem; color: var(--crow-text-muted); }
  .sc-adv { margin: 10px 0 0; }
  .sc-adv > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--crow-text-secondary); }
  .sc-preview { margin: 12px 0 0; padding: 10px 12px; border: 1px dashed var(--crow-border-strong); border-radius: 10px; min-height: 44px; }
  .sc-preview-sum { margin: 0 0 4px; }

  .sc-toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--crow-player-h, 0px) + 12px); width: max-content; max-width: calc(100vw - 32px); z-index: 30; }
  .sc-toast:not(:empty) { padding: 0.7rem 1rem; border: 1px solid var(--crow-border); border-left: 3px solid var(--crow-success); border-radius: var(--crow-radius-control); background: var(--crow-bg-surface); box-shadow: 0 6px 24px color-mix(in srgb, var(--crow-bg-deep) 30%, transparent); }

  @media (max-width: 479px) {
    .sc-attn-acts { flex-basis: 100%; }
    .sc-attn-acts > *, .sc-attn-acts .sc-inline-form, .sc-attn-acts .btn { flex: 1 1 100%; width: 100%; }
    .sc-attn-acts .sc-copy-text { flex: 1 1 100%; width: 100%; }
    .sc-hit { flex-wrap: wrap; gap: 4px 12px; }
    .sc-at { min-width: 0; max-width: 100%; }
    .sc-main { flex-basis: 100%; }
  }
  @media (min-width: 769px) {
    .sc-page.has-detail .sc-agenda, .sc-page.has-detail .sc-attn, .sc-page.has-detail .sc-toolbar, .sc-page.has-detail .sc-foot, .sc-page.has-detail .sc-lede { margin-right: calc(var(--sc-pane-w) + 20px); }
    .sc-detail { position: fixed; right: 20px; top: var(--sc-pane-top, 88px); width: var(--sc-pane-w); max-height: calc(100dvh - var(--crow-player-h, 0px) - var(--sc-pane-top, 88px) - 16px); overflow: auto; z-index: 5; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card); background: var(--crow-bg-surface); box-shadow: 0 8px 28px color-mix(in srgb, var(--crow-bg-deep) 18%, transparent); box-sizing: border-box; }
  }
</style>`;
