/**
 * Skills panel, option C: scoped styles (Perch tokens only, no hex colours).
 * Phone first; ≥ 769px pins the one `.sk-detail` as a side pane. Every
 * interactive target is at least 44px tall. Fixed pieces (the toast, the
 * pane) reserve the player bar themselves (--crow-player-h).
 */
export const SKILLS_CSS = `<style>
  .sk-page { --sk-pane-w: min(420px, 38vw); max-width: 100%; }
  .sk-vh { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .sk-lede { margin: 0 0 var(--crow-space-3); color: var(--crow-text-secondary); }
  .sk-muted { color: var(--crow-text-muted); font-size: 0.85rem; margin: 0; }
  .sk-page a:focus-visible, .sk-page button:focus-visible, .sk-page summary:focus-visible, .sk-page input:focus-visible, .sk-page textarea:focus-visible, .sk-page [tabindex]:focus-visible, .sk-dialog :focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  .sk-page .btn, .sk-dialog .btn { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .sk-page .btn-sm { min-height: 44px; }
  .sk-toolbar { display: flex; gap: 8px; align-items: center; margin: 0 0 var(--crow-space-3); }
  .sk-search { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; min-height: 44px; padding: 0 12px; background: var(--crow-bg-surface); border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control); }
  .sk-search input { flex: 1; min-width: 0; min-height: 42px; border: 0; background: none; color: var(--crow-text-primary); font: inherit; outline: none; }
  .sk-search span { color: var(--crow-text-muted); }
  .sk-new { flex: none; white-space: nowrap; }
  .sk-av { flex: none; display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; font-weight: 700; font-size: 0.85rem; }
  .sk-av-builtin { background: var(--crow-bg-elevated); color: var(--crow-text-secondary); border: 1px solid var(--crow-border); }
  .sk-av-yours { background: var(--crow-accent-muted); color: var(--crow-accent); }
  .sk-av-ext { background: hsl(var(--sk-h, 200) 55% 50% / 0.16); color: hsl(var(--sk-h, 200) 45% 42%); }
  .sk-av-missing { background: var(--crow-bg-elevated); color: var(--crow-text-muted); border: 1px dashed var(--crow-border-strong); }
  .sk-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .sk-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 0.78rem; font-weight: 500; padding: 2px 8px; border-radius: var(--crow-radius-pill); max-width: 100%; overflow-wrap: anywhere; }
  .sk-chip-yours { background: var(--crow-accent-muted); color: var(--crow-accent); }
  .sk-chip-ext { background: color-mix(in srgb, var(--crow-info) 14%, transparent); color: var(--crow-info); }
  .sk-chip-builtin { background: var(--crow-bg-elevated); color: var(--crow-text-secondary); border: 1px solid var(--crow-border); }
  .sk-chip-flag { background: color-mix(in srgb, var(--crow-warning) 16%, transparent); color: var(--crow-warning); }
  .sk-chip-plain { background: var(--crow-bg-elevated); color: var(--crow-text-secondary); }
  .sk-chip-link { min-height: 44px; padding: 0 12px; text-decoration: none; }
  .sk-st { display: inline-flex; align-items: center; gap: 6px; font-size: 0.82rem; color: var(--crow-text-secondary); }
  .sk-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
  .sk-st-info { color: var(--crow-info); } .sk-st-warning { color: var(--crow-warning); } .sk-st-error { color: var(--crow-error); }
  .sk-st-muted { color: var(--crow-text-muted); } .sk-st-ok { color: var(--crow-success); }
  .sk-st-off { color: var(--crow-text-muted); } .sk-st-off .sk-dot { background: none; border: 1.5px solid currentColor; }

  .sk-attn { background: var(--crow-bg-surface); border: 1px solid var(--crow-border); border-left: 4px solid var(--crow-warning); border-radius: var(--crow-radius-card); padding: 10px 12px; margin: 0 0 14px; }
  .sk-attn.ok { border-left-color: var(--crow-success); display: flex; align-items: center; min-height: 44px; }
  .sk-attn h2 { margin: 2px 0 6px; font-size: 1rem; font-family: var(--crow-body-font); }
  .sk-attn-item { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 6px 0; border-top: 1px solid var(--crow-border); font-size: 0.88rem; }
  .sk-attn-item:first-of-type { border-top: 0; }
  .sk-attn-text { flex: 1 1 10rem; min-width: 0; overflow-wrap: anywhere; }
  .sk-attn-text span { display: block; color: var(--crow-text-secondary); font-size: 0.82rem; }
  .sk-attn-acts { display: flex; flex-wrap: wrap; gap: 6px; }
  .sk-inline-form { display: inline-flex; margin: 0; }

  .sk-sec { background: var(--crow-bg-surface); border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card); margin: 0 0 12px; overflow: hidden; }
  .sk-sec-h { display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 0 14px; cursor: pointer; list-style: none; }
  .sk-sec-h::-webkit-details-marker { display: none; }
  .sk-sec-h::after { content: "▸"; color: var(--crow-text-muted); }
  .sk-sec[open] > .sk-sec-h::after { content: "▾"; }
  .sk-sec-h b { flex: 1; }
  .sk-sec-count { font-size: 0.82rem; color: var(--crow-text-muted); }
  .sk-row { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--crow-border); padding-right: 8px; }
  .sk-row.sel { background: var(--crow-bg-elevated); }
  .sk-row[hidden] { display: none; }
  .sk-hit { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 60px; padding: 8px 4px 8px 12px; color: inherit; text-decoration: none; }
  .sk-main { min-width: 0; display: flex; flex-direction: column; }
  .sk-name { font-weight: 600; overflow-wrap: anywhere; }
  .sk-purpose { font-size: 0.85rem; color: var(--crow-text-secondary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
  .sk-meta { font-size: 0.78rem; color: var(--crow-text-muted); overflow-wrap: anywhere; }
  .sk-switch-form { display: inline-flex; margin: 0; flex: none; }
  .sk-switch { display: inline-flex; align-items: center; justify-content: center; min-width: 52px; min-height: 44px; padding: 0 4px; background: none; border: 0; color: var(--crow-text); cursor: pointer; font: inherit; border-radius: 10px; }
  .sk-switch-track { position: relative; width: 44px; height: 26px; border-radius: 13px; background: var(--crow-border-strong); transition: background 0.15s; flex: none; }
  .sk-switch-track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--crow-bg-surface); transition: transform 0.15s; }
  .sk-switch[aria-checked="true"] .sk-switch-track { background: var(--crow-accent); }
  .sk-switch[aria-checked="true"] .sk-switch-track::after { transform: translateX(18px); }
  .sk-switch-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

  .sk-detail { padding: 12px 14px 16px; background: var(--crow-bg-elevated); border-top: 1px solid var(--crow-border); font-size: 0.9rem; overflow-wrap: anywhere; }
  .sk-d-head { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
  .sk-d-head h2 { margin: 0; font-size: 1.1rem; flex: 1; min-width: 0; font-family: var(--crow-body-font); }
  .sk-close { display: inline-grid; place-items: center; min-width: 44px; min-height: 44px; border: 0; background: none; color: var(--crow-text-secondary); text-decoration: none; font: inherit; cursor: pointer; border-radius: 10px; }
  .sk-d-purpose { margin: 0.4rem 0 0.6rem; }
  .sk-d-sec { margin: 12px 0; }
  .sk-d-sec > b, .sk-d-sec > summary > b { display: block; font-size: 0.74rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--crow-text-muted); margin-bottom: 5px; }
  .sk-instr > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
  .sk-pre, .sk-diff { font-family: var(--crow-mono-font); font-size: 0.78rem; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--crow-bg-surface); border: 1px solid var(--crow-border); border-radius: 10px; padding: 10px; max-height: 360px; overflow: auto; margin: 0; }
  .sk-diff-add { color: var(--crow-success); } .sk-diff-del { color: var(--crow-error); } .sk-diff-ctx { color: var(--crow-text-secondary); }
  .sk-note { padding: 10px 12px; border-radius: 10px; font-size: 0.86rem; background: var(--crow-bg-surface); margin: 8px 0; }
  .sk-note-warn { background: color-mix(in srgb, var(--crow-warning) 14%, transparent); }
  .sk-note-info { background: color-mix(in srgb, var(--crow-info) 14%, transparent); }
  .sk-note-err { background: color-mix(in srgb, var(--crow-error) 14%, transparent); }
  .sk-d-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
  .sk-act-warn { flex-basis: 100%; color: var(--crow-text-muted); font-size: 0.8rem; margin-top: -4px; }
  .sk-empty { display: grid; justify-items: center; text-align: center; gap: 6px; padding: 22px 16px; margin: 0 12px 12px; border: 1px dashed var(--crow-border-strong); border-radius: var(--crow-radius-card); color: var(--crow-text-secondary); font-size: 0.9rem; }
  .sk-empty b { color: var(--crow-text-primary); }
  .sk-nomatch { margin: 0 0 12px; }
  .sk-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 18px 0 0; padding: 8px 14px; border: 1px dashed var(--crow-border-strong); border-radius: var(--crow-radius-card); font-size: 0.86rem; color: var(--crow-text-secondary); }
  .sk-foot a { color: var(--crow-accent); font-weight: 600; text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; }
  .sk-card-body { padding: 0 14px 14px; }
  .sk-ctx { border-top: 1px solid var(--crow-border); }
  .sk-ctx > summary { list-style: none; }
  .sk-ctx > summary::-webkit-details-marker { display: none; }
  .sk-back { display: inline-flex; align-items: center; min-height: 44px; color: var(--crow-accent); text-decoration: none; font-weight: 600; }
  .sk-behavior-h { font-family: var(--crow-body-font); font-size: 1.3rem; margin: 0 0 12px; }
  .sk-hint { margin: -0.5rem 0 1rem; font-size: 0.8rem; color: var(--crow-text-muted); }

  .sk-dialog { width: min(560px, calc(100vw - 24px)); max-height: calc(100dvh - var(--crow-player-h, 0px) - 24px); border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card); background: var(--crow-bg-surface); color: var(--crow-text-primary); padding: 12px 16px 16px; }
  .sk-dialog::backdrop { background: color-mix(in srgb, var(--crow-bg-deep) 55%, transparent); }
  .sk-dialog textarea { width: 100%; }

  .skills-toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--crow-player-h, 0px) + 12px); width: max-content; max-width: calc(100vw - 32px); z-index: 30; }
  .skills-toast:not(:empty) { padding: 0.7rem 1rem; border: 1px solid var(--crow-border); border-left: 3px solid var(--crow-success); border-radius: var(--crow-radius-control); background: var(--crow-bg-surface); box-shadow: 0 6px 24px color-mix(in srgb, var(--crow-bg-deep) 30%, transparent); }

  @media (max-width: 768px) {
    .sk-toolbar { flex-wrap: nowrap; }
    .sk-new { padding: 0 12px; }
  }
  @media (min-width: 769px) {
    .sk-page.has-detail .sk-list, .sk-page.has-detail .sk-attn, .sk-page.has-detail .sk-foot { margin-right: calc(var(--sk-pane-w) + 20px); }
    .sk-detail { position: fixed; right: 20px; top: var(--sk-pane-top, 88px); width: var(--sk-pane-w); max-height: calc(100dvh - var(--crow-player-h, 0px) - var(--sk-pane-top, 88px) - 16px); overflow: auto; z-index: 5; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card); background: var(--crow-bg-surface); box-shadow: 0 8px 28px color-mix(in srgb, var(--crow-bg-deep) 18%, transparent); }
  }
</style>`;
