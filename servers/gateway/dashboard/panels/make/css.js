/** Make panel: scoped styles (`.mk-*`, Perch tokens only). Phone first; every target is at least 44px. */
export const MAKE_CSS = `<style>
  .mk-page { max-width: 100%; }
  .mk-chips { display: flex; gap: var(--crow-space-2); flex-wrap: wrap; margin: 0 0 var(--crow-space-3); }
  .mk-chip { display: inline-flex; align-items: center; min-height: 44px; padding: 0 var(--crow-space-3); border: 1px solid var(--crow-border); border-radius: 999px; color: var(--crow-text-secondary); text-decoration: none; }
  .mk-chip-on { color: var(--crow-text-primary); border-color: var(--crow-accent); background: var(--crow-bg-elevated); }
  .mk-notice { margin: 0 0 var(--crow-space-3); color: var(--crow-text-muted); font-size: 0.9rem; }
  .mk-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--crow-space-3); grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .mk-tile { display: flex; flex-direction: column; gap: var(--crow-space-2); min-height: 44px; height: 100%; padding: var(--crow-space-2); border: 1px solid var(--crow-border); border-radius: 12px; background: var(--crow-bg-surface); color: var(--crow-text-primary); text-decoration: none; }
  .mk-tile.mk-just { border-color: var(--crow-accent); box-shadow: 0 0 0 1px var(--crow-accent); }
  .mk-preview { display: flex; align-items: center; justify-content: center; aspect-ratio: 4 / 3; border-radius: 8px; background: var(--crow-bg-elevated); color: var(--crow-text-muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .mk-title { font-weight: 600; overflow-wrap: anywhere; }
  .mk-meta { display: flex; gap: var(--crow-space-2); flex-wrap: wrap; align-items: center; color: var(--crow-text-muted); font-size: 0.8rem; }
  .mk-badge { padding: 1px 8px; border-radius: 999px; background: var(--crow-accent); color: var(--crow-bg-deep); font-weight: 600; }
  .mk-card { font-variant-numeric: tabular-nums; }
  .mk-empty { display: grid; gap: var(--crow-space-3); max-width: 480px; }
  .mk-empty-text { color: var(--crow-text-muted); }
  .mk-offer { display: grid; gap: var(--crow-space-2); justify-items: start; margin: 0 0 var(--crow-space-3); padding: var(--crow-space-3); border: 1px dashed var(--crow-border); border-radius: 12px; }
  .mk-offer p { margin: 0; }
  .mk-bar { display: flex; gap: var(--crow-space-3); flex-wrap: wrap; align-items: center; justify-content: space-between; }
  .mk-start-btn { min-height: 44px; }
  .mk-sheet { width: min(480px, 100vw); max-width: 100vw; max-height: 90vh; margin: auto auto 0; padding: 0; border: 1px solid var(--crow-border); border-radius: 16px 16px 0 0; background: var(--crow-bg-surface); color: var(--crow-text-primary); }
  .mk-sheet::backdrop { background: rgba(0,0,0,0.4); }
  .mk-sheet-inner { padding: var(--crow-space-3); display: grid; gap: var(--crow-space-3); }
  .mk-sheet-head { display: flex; align-items: center; justify-content: space-between; }
  .mk-sheet-title { margin: 0; font-size: 1.1rem; }
  .mk-sheet-close { min-width: 44px; min-height: 44px; border: 0; background: transparent; color: var(--crow-text-secondary); font-size: 1.5rem; cursor: pointer; }
  .mk-start-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--crow-space-2); }
  .mk-start-row { display: flex; gap: var(--crow-space-2); align-items: center; justify-content: space-between; }
  .mk-start-name { flex: 1; font-weight: 600; }
  .mk-start-type { flex: 1; display: flex; align-items: center; min-height: 44px; padding: 0 var(--crow-space-3); border: 1px solid var(--crow-border); border-radius: 12px; background: var(--crow-bg-elevated); color: var(--crow-text-primary); font-weight: 600; text-align: left; cursor: pointer; }
  .mk-start-act { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; }
  .mk-composer { display: grid; gap: var(--crow-space-2); }
  .mk-composer[hidden], .mk-field[hidden] { display: none; }
  .mk-pills { display: flex; gap: var(--crow-space-2); flex-wrap: wrap; }
  .mk-pill { min-height: 44px; padding: 0 var(--crow-space-3); border: 1px solid var(--crow-border); border-radius: 999px; background: transparent; color: var(--crow-text-secondary); cursor: pointer; }
  .mk-pill[aria-pressed="true"] { color: var(--crow-text-primary); border-color: var(--crow-accent); background: var(--crow-bg-elevated); }
  .mk-project-chip { justify-self: start; display: inline-flex; align-items: center; min-height: 44px; padding: 0 var(--crow-space-3); border-radius: 999px; background: var(--crow-bg-elevated); color: var(--crow-text-secondary); }
  .mk-field { display: grid; gap: 4px; font-size: 0.85rem; color: var(--crow-text-secondary); }
  .mk-field select, .mk-field input { min-height: 44px; box-sizing: border-box; width: 100%; padding: 0 var(--crow-space-2); border: 1px solid var(--crow-border); border-radius: 8px; background: var(--crow-bg-deep); color: var(--crow-text-primary); font: inherit; }
  .mk-text { box-sizing: border-box; width: 100%; padding: var(--crow-space-2); border: 1px solid var(--crow-border); border-radius: 8px; background: var(--crow-bg-deep); color: var(--crow-text-primary); font: inherit; resize: vertical; }
  .mk-status { margin: 0; min-height: 1.2em; color: var(--crow-text-muted); font-size: 0.85rem; }
  .mk-composer-actions { display: flex; gap: var(--crow-space-2); justify-content: flex-end; }
  .mk-composer-actions .btn { min-height: 44px; }
  .mk-cell { position: relative; }
  .mk-more { position: absolute; top: 4px; right: 4px; min-width: 44px; min-height: 44px; border: 0; border-radius: 999px; background: var(--crow-bg-elevated); color: var(--crow-text-secondary); font-size: 1.25rem; cursor: pointer; }
  .mk-tile { -webkit-touch-callout: none; }
  .mk-vline { min-height: 44px; justify-self: start; padding: 0 var(--crow-space-3); border: 0; border-radius: 999px; background: var(--crow-bg-elevated); color: var(--crow-text-primary); font: inherit; cursor: pointer; }
  .mk-vline:not(button), .mk-vline[data-plain] { cursor: default; }
  .mk-versions { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--crow-space-2); }
  .mk-versions[hidden], .mk-vline[hidden] { display: none; }
  .mk-vlink { display: flex; align-items: center; min-height: 44px; padding: 0 var(--crow-space-3); border: 1px solid var(--crow-border); border-radius: 12px; color: var(--crow-text-primary); text-decoration: none; }
</style>`;
