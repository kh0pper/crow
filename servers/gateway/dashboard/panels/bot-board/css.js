/**
 * Bot Board Panel — CSS
 *
 * Scoped styles for the bot-board panel.
 */

import { PERCH_TOKENS } from "../../shared/design-tokens.js";
import { birdDrawerCss } from "./drawer.js";

export function botBoardStyles() {
  // Track 3 Task 11 (spec §3.2/§5.6): the card-face bird glyph. OS-driven
  // theme (light on :root, dark inside @media prefers-color-scheme — same
  // convention as design-tokens.js/layout.js, no data-theme state of its
  // own). PERCH_TOKENS.dark has no `alive`/`attn` entries (matches the
  // vendored payload it's drift-tested against, Decision 15) — working/
  // waiting keep their light-palette color in both themes; hibernating/idle
  // use `dim`, which both palettes define.
  const birdCss = `
  .bb-bird{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;margin-left:.35rem;vertical-align:middle;background:${PERCH_TOKENS.light.dim}}
  .bb-bird--working{background:${PERCH_TOKENS.light.alive}}
  .bb-bird--waiting{background:${PERCH_TOKENS.light.attn};box-shadow:0 0 0 2px ${PERCH_TOKENS.light.attn}33}
  .bb-bird--hibernating{background:${PERCH_TOKENS.light.dim}}
  .bb-bird--idle{background:${PERCH_TOKENS.light.dim}}
  .bb-bird--observing{background:${PERCH_TOKENS.light.wire}}
  @media (prefers-color-scheme: dark) {
    .bb-bird{background:${PERCH_TOKENS.dark.dim}}
    .bb-bird--hibernating{background:${PERCH_TOKENS.dark.dim}}
    .bb-bird--idle{background:${PERCH_TOKENS.dark.dim}}
    .bb-bird--observing{background:${PERCH_TOKENS.dark.wire}}
  }`;
  // Track 3 Task 12: the roost strip — "birds on a wire" above the board.
  // `.bb-roost-track`'s bottom border IS the wire (PERCH_TOKENS.wire, both
  // palettes carry it — no OS-driven fallback needed the way birdCss above
  // needs one for `alive`/`attn`).
  const roostCss = `
  .bb-roost{margin:.6rem 0 1rem;padding:.5rem .6rem .7rem;background:${PERCH_TOKENS.light.card};border:1px solid var(--crow-border);border-radius:var(--crow-radius-card)}
  .bb-roost-track{display:flex;gap:.5rem;overflow-x:auto;padding-bottom:.5rem;border-bottom:2px solid ${PERCH_TOKENS.light.wire}}
  .bb-roost-empty{font-size:.8rem;color:var(--crow-text-muted);padding:.3rem 0}
  .bb-roost-bird{position:relative;display:flex;align-items:center;gap:.4rem;padding:.35rem .5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);white-space:nowrap;flex:0 0 auto}
  .bb-roost-name{font-size:.8rem;font-weight:600;color:var(--crow-text-primary)}
  .bb-roost-state{font-size:.68rem;color:var(--crow-text-muted)}
  .bb-roost-primary{font-size:.7rem;padding:.2rem .5rem;background:${PERCH_TOKENS.light.teal};border:none;border-radius:var(--crow-radius-control);color:${PERCH_TOKENS.light.card};cursor:pointer}
  .bb-roost-primary.bb-roost-link{background:none;color:${PERCH_TOKENS.light.teal};text-decoration:underline;padding:0}
  .bb-roost-more{background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:.85rem;padding:.1rem .3rem;line-height:1}
  .bb-roost-more:hover{color:var(--crow-text-primary)}
  .bb-roost-menu{display:none;position:absolute;top:100%;right:0;margin-top:.2rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.2);padding:.3rem;z-index:20;min-width:130px}
  .bb-roost-menu.bb-open{display:block}
  .bb-roost-menu button,.bb-roost-menu a{display:block;width:100%;text-align:left;background:none;border:none;padding:.3rem .4rem;font-size:.75rem;color:var(--crow-text-primary);cursor:pointer;text-decoration:none;border-radius:4px;font:inherit}
  .bb-roost-menu button:hover,.bb-roost-menu a:hover{background:var(--crow-bg-elevated)}
  @media (prefers-color-scheme: dark) {
    .bb-roost{background:${PERCH_TOKENS.dark.card}}
    .bb-roost-track{border-bottom-color:${PERCH_TOKENS.dark.wire}}
    .bb-roost-primary{background:${PERCH_TOKENS.dark.teal};color:${PERCH_TOKENS.dark.card}}
    .bb-roost-primary.bb-roost-link{color:${PERCH_TOKENS.dark.teal}}
  }`;
  return `<style>
  ${birdCss}
  ${roostCss}
  ${birdDrawerCss()}
  .bb-switch{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  .bb-switch select,.bb-switch input{padding:.45rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-primary)}
  .bb-switch button{padding:.45rem .9rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-control);color:var(--crow-accent-contrast);cursor:pointer}
  .bb-board{display:grid;grid-template-columns:repeat(var(--bb-cols,4),1fr);gap:.75rem;align-items:start;overflow-x:auto}
  .bb-col{background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);padding:.6rem;min-height:120px;min-width:140px}
  .bb-col.bb-dragover{border-color:var(--crow-accent);background:var(--crow-bg-elevated)}
  .bb-col h4{margin:.1rem 0 .6rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:var(--crow-text-muted);display:flex;justify-content:space-between}
  .bb-card{background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);padding:.55rem;margin-bottom:.5rem;cursor:pointer;transition:border-color .12s}
  .bb-card:hover{border-color:var(--crow-accent)}
  .bb-card.bb-locked{opacity:.85;cursor:not-allowed;border-style:dashed}
  .bb-card-top{display:flex;align-items:center;gap:.4rem;font-size:.72rem;color:var(--crow-text-muted)}
  .bb-id{font-family:'JetBrains Mono',monospace}
  .bb-title{font-weight:600;font-size:.9rem;margin:.25rem 0}
  .bb-card-meta{display:flex;gap:.6rem;flex-wrap:wrap}
  .bb-meta{font-size:.72rem;color:var(--crow-text-secondary)}
  .bb-tags{margin-top:.3rem;display:flex;gap:.25rem;flex-wrap:wrap}
  .bb-tag{font-size:.68rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);padding:0 .4rem;color:var(--crow-text-muted)}
  .bb-sub{font-size:.7rem;color:var(--crow-text-muted);margin-top:.25rem}
  .bb-lock{margin-left:auto;color:#b8860b;font-weight:600}
  .bb-archived-flag{margin-left:auto;color:#888;font-weight:600}
  .bb-card.bb-archived{opacity:.7;border-style:dotted}
  .bb-marker{font-size:.68rem;border-radius:var(--crow-radius-pill);padding:0 .4rem;margin-top:.25rem;display:inline-block}
  .bb-marker-waiting{background:#fff3cd;color:#7a5b00}
  .bb-marker-failed{background:#fbdada;color:#8a1f11}
  .bb-prio{font-weight:700}.bb-prio-1,.bb-prio-2{color:#c0392b}.bb-prio-3{color:#b8860b}.bb-prio-4,.bb-prio-5{color:#888}
  .bb-nojs-move{display:flex;gap:.25rem;flex-wrap:wrap;margin-top:.4rem}
  .bb-nojs-move button{font-size:.66rem;padding:.15rem .4rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-secondary);cursor:pointer}
  body.bb-js .bb-nojs-move{display:none}
  .bb-drawer{position:fixed;top:0;right:0;height:100vh;width:min(480px,92vw);background:var(--crow-bg-surface);border-left:1px solid var(--crow-border);box-shadow:-8px 0 24px rgba(0,0,0,.3);transform:translateX(100%);transition:transform .18s ease;z-index:50;overflow-y:auto;padding:1rem}
  .bb-drawer.bb-open{transform:translateX(0)}
  .bb-drawer label{display:block;font-size:.75rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:.05em;margin:.7rem 0 .25rem}
  .bb-drawer input,.bb-drawer select,.bb-drawer textarea{width:100%;padding:.45rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary);font:inherit}
  .bb-drawer textarea{font-family:'JetBrains Mono',monospace;font-size:.82rem;min-height:220px}
  .bb-drawer .bb-row{display:flex;gap:.5rem}.bb-drawer .bb-row>*{flex:1}
  .bb-btn{padding:.45rem .9rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-control);color:var(--crow-accent-contrast);cursor:pointer;margin:.5rem .4rem 0 0}
  .bb-btn.bb-sec{background:var(--crow-bg-elevated);color:var(--crow-text-secondary);border:1px solid var(--crow-border)}
  .bb-btn:disabled{opacity:.5;cursor:not-allowed}
  .bb-msg{font-size:.82rem;margin:.5rem 0;min-height:1.1em}
  .bb-msg.ok{color:#1a7f37}.bb-msg.err{color:#c0392b}.bb-msg.warn{color:#b8860b}
  .bb-pre{background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:6px;padding:.6rem;white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono',monospace;font-size:.82rem;max-height:340px;overflow:auto}
  .bb-filter-bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.6rem 0}
  .bb-search{flex:1;min-width:200px;padding:.45rem .7rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-primary);font:inherit;font-size:.85rem}
  .bb-search::placeholder{color:var(--crow-text-muted)}
  .bb-chips{display:flex;gap:.3rem;flex-wrap:wrap}
  .bb-chip{padding:.25rem .65rem;font-size:.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-secondary);cursor:pointer;transition:all .12s}
  .bb-chip:hover{border-color:var(--crow-accent)}
  .bb-chip-active{background:var(--crow-accent);border-color:var(--crow-accent);color:var(--crow-accent-contrast)}
  .bb-chip-action{border-color:#b8860b;color:#b8860b}
  .bb-chip-action.bb-chip-active{background:#b8860b;border-color:#b8860b;color:#fff}
  .bb-view-toggle{display:flex;gap:0;margin-left:auto}
  .bb-view-btn{padding:.25rem .65rem;font-size:.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);color:var(--crow-text-secondary);cursor:pointer;transition:all .12s}
  .bb-view-btn:first-child{border-radius:var(--crow-radius-control) 0 0 var(--crow-radius-control)}
  .bb-view-btn:last-child{border-radius:0 var(--crow-radius-control) var(--crow-radius-control) 0;border-left:none}
  .bb-view-btn-active{background:var(--crow-accent);border-color:var(--crow-accent);color:var(--crow-accent-contrast)}
  .bb-list-table{width:100%;border-collapse:collapse;font-size:.85rem}
  .bb-list-table th{text-align:left;padding:.4rem .6rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--crow-text-muted);border-bottom:2px solid var(--crow-border);cursor:pointer;user-select:none;white-space:nowrap}
  .bb-list-table th:hover{color:var(--crow-text-primary)}
  .bb-list-table th.bb-sort-asc::after{content:' \\25B2';font-size:.6rem}
  .bb-list-table th.bb-sort-desc::after{content:' \\25BC';font-size:.6rem}
  .bb-list-table td{padding:.4rem .6rem;border-bottom:1px solid var(--crow-border);vertical-align:top}
  .bb-list-table tr:hover td{background:var(--crow-bg-elevated)}
  .bb-list-table tbody tr{cursor:pointer}
  .bb-list-status{display:inline-block;padding:.1rem .45rem;font-size:.72rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill)}
  .bb-col-toggle{background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:.85rem;padding:0 .3rem;margin-left:.4rem;line-height:1}
  .bb-col-toggle:hover{color:var(--crow-text-primary)}
  .bb-col-collapsed .bb-col-body{display:none}
  .bb-col-collapsed{min-width:60px!important}
  .bb-td-field-row{margin:.4rem 0}
  .bb-td-field-label{display:block;font-size:.72rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.2rem}
  .bb-td-section{font-size:.8rem;color:var(--crow-text-primary);margin:1rem 0 .4rem;padding-bottom:.25rem;border-bottom:1px solid var(--crow-border)}
  .bb-td-link{display:block;font-size:.82rem;color:var(--crow-accent);text-decoration:none;margin:.3rem 0}
  .bb-td-link:hover{text-decoration:underline}
  .bb-td-readonly{font-size:.85rem;color:var(--crow-text-secondary)}
</style>`;
}
