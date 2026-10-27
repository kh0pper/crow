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
</style>`;
