/**
 * Extensions Panel — CSS
 *
 * Scoped styles for the extensions/add-ons store panel.
 */

export function extensionStyles() {
  return `<style>
/* ─── Extensions Store ─── */
.ext-search { position:relative; margin-bottom:1.5rem; }
.ext-search__icon {
  position:absolute; left:0.85rem; top:50%;
  transform:translateY(-50%);
  width:16px; height:16px;
  color:var(--crow-text-muted); pointer-events:none;
}
.ext-search__input {
  width:100%; box-sizing:border-box;
  padding:0.65rem 0.75rem 0.65rem 2.5rem;
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  background:var(--crow-bg-surface);
  color:var(--crow-text-primary);
  font-size:0.9rem;
  font-family:'DM Sans',sans-serif;
  transition:border-color 0.15s;
}
.ext-search__input:focus { outline:none; border-color:var(--crow-accent); }
.ext-search__input::placeholder { color:var(--crow-text-muted); }

/* Installed strip */
.ext-section-label {
  font-size:0.75rem; font-weight:600;
  text-transform:uppercase; letter-spacing:0.08em;
  color:var(--crow-text-muted);
  margin:0 0 0.6rem 0.1rem;
}
.ext-installed-toggle {
  display:flex; align-items:center; justify-content:space-between;
  padding:0.6rem 1rem;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  cursor:pointer; user-select:none;
  font-size:0.85rem; font-weight:600;
  color:var(--crow-text-secondary);
  margin-bottom:0.5rem;
  transition:border-color 0.15s;
}
.ext-installed-toggle:hover { border-color:var(--crow-accent); }
.ext-installed-toggle__chevron { transition:transform 0.2s; font-size:0.8rem; }
.ext-installed-toggle__chevron--open { transform:rotate(180deg); }
.ext-installed__list { display:none; flex-direction:column; gap:0.5rem; margin-bottom:1.5rem; }
.ext-installed__list--open { display:flex; }
.ext-installed__item {
  display:flex; align-items:center; gap:0.75rem;
  padding:0.65rem 1rem;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  transition:border-color 0.15s;
}
.ext-installed__item:hover { border-color:var(--crow-accent); }
.ext-installed__icon { flex-shrink:0; width:36px; height:36px; display:flex; align-items:center; justify-content:center; }
.ext-installed__info { flex:1; min-width:0; display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
.ext-installed__name { font-family:'Fraunces',serif; font-size:0.95rem; font-weight:600; }
.ext-installed__meta { font-size:0.75rem; font-family:'JetBrains Mono',monospace; color:var(--crow-text-muted); }
.ext-installed__actions { display:flex; gap:0.4rem; align-items:center; flex-shrink:0; }

/* Category tabs */
.ext-tabs {
  display:flex; gap:0.5rem;
  margin-bottom:1.25rem;
  overflow-x:auto; scrollbar-width:none;
  padding-bottom:0.25rem;
  -webkit-overflow-scrolling:touch;
}
.ext-tabs::-webkit-scrollbar { display:none; }
.ext-tab {
  flex-shrink:0;
  padding:0.4rem 0.9rem;
  border-radius:var(--crow-radius-pill, 8px);
  background:transparent;
  border:1px solid var(--crow-border);
  color:var(--crow-text-secondary);
  font-size:0.8rem; font-weight:500;
  cursor:pointer;
  transition:all 0.15s;
  white-space:nowrap;
  font-family:'DM Sans',sans-serif;
}
.ext-tab:hover { border-color:var(--crow-accent); color:var(--crow-text-primary); }
.ext-tab--active {
  background:var(--crow-accent-muted);
  color:var(--crow-accent);
  border-color:var(--crow-accent);
}

/* Browse grid */
.ext-grid {
  display:grid;
  grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));
  gap:1rem;
  margin-bottom:1.5rem;
}

/* Add-on card (vertical) */
.ext-card {
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  padding:1.25rem 1rem;
  display:flex; flex-direction:column; align-items:center;
  text-align:center;
  transition:transform 0.15s, border-color 0.15s, box-shadow 0.15s;
  cursor:default;
}
.ext-card:hover {
  transform:translateY(-3px);
  border-color:var(--crow-accent);
  box-shadow:0 8px 24px rgba(0,0,0,0.2);
}
.ext-card__icon {
  width:64px; height:64px;
  border-radius:16px;
  display:flex; align-items:center; justify-content:center;
  margin-bottom:0.75rem;
  transition:transform 0.2s ease;
}
.ext-card:hover .ext-card__icon { transform:scale(1.06); }
.ext-card__icon > div { width:32px; height:32px; }
.ext-card__body { flex:1; display:flex; flex-direction:column; align-items:center; width:100%; }
.ext-card__name {
  font-family:'Fraunces',serif;
  font-size:0.95rem; font-weight:600;
  margin-bottom:0.35rem;
  color:var(--crow-text-primary);
}
.ext-card__desc {
  font-size:0.8rem;
  color:var(--crow-text-secondary);
  line-height:1.45;
  margin-bottom:0.5rem;
  display:-webkit-box;
  -webkit-line-clamp:2;
  -webkit-box-orient:vertical;
  overflow:hidden;
}
.ext-card__meta { display:flex; flex-wrap:wrap; gap:0.25rem; justify-content:center; margin-bottom:0.4rem; }
.ext-card__badge {
  font-size:0.6rem; font-weight:500;
  padding:0.1rem 0.4rem; border-radius:4px;
  text-transform:uppercase; letter-spacing:0.02em;
}
.ext-card__badge--official { color:var(--crow-accent); background:var(--crow-accent-muted); }
.ext-card__badge--community { color:#f0ad4e; background:rgba(240,173,78,0.15); border:1px solid rgba(240,173,78,0.3); }
.ext-card__badge--type { color:var(--crow-text-muted); background:var(--crow-bg-elevated); }
.ext-card__resources { font-size:0.7rem; color:var(--crow-text-muted); margin-bottom:0.2rem; }
.ext-card__version { font-size:0.7rem; color:var(--crow-text-muted); font-family:'JetBrains Mono',monospace; }
.ext-card__footer { margin-top:auto; padding-top:0.6rem; width:100%; }
.ext-card__footer .btn { width:100%; justify-content:center; }
.ext-card__footer .badge { display:block; text-align:center; }

/* Community stores (collapsible) */
.ext-stores { margin-bottom:1.5rem; }
.ext-stores__header {
  display:flex; align-items:center; gap:0.5rem;
  padding:0.75rem 1rem;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  cursor:pointer;
  font-size:0.9rem; font-weight:500;
  color:var(--crow-text-secondary);
  transition:border-color 0.15s;
  user-select:none;
}
.ext-stores__header:hover { border-color:var(--crow-accent); }
.ext-stores__chevron { margin-left:auto; transition:transform 0.2s; font-size:0.8rem; }
.ext-stores__chevron--open { transform:rotate(180deg); }
.ext-stores__body {
  display:none;
  padding:1rem;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-top:none;
  border-radius:0 0 var(--crow-radius-card, 12px) var(--crow-radius-card, 12px);
}
.ext-stores__body--open { display:block; }

/* Help card */
.ext-help {
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  padding:1rem 1.25rem;
  color:var(--crow-text-muted);
  font-size:0.85rem;
}

/* Modal overlay */
#modal-overlay {
  display:none; position:fixed;
  top:0; left:0; width:100%; height:100%;
  background:rgba(0,0,0,0.6);
  z-index:1000;
  align-items:center; justify-content:center;
  backdrop-filter:blur(4px);
  -webkit-backdrop-filter:blur(4px);
}
#modal-content {
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  padding:1.5rem;
  max-width:500px; width:90%;
  max-height:80vh; overflow-y:auto; overflow-x:hidden;
  box-sizing:border-box; word-wrap:break-word;
  box-shadow:0 20px 60px rgba(0,0,0,0.5);
}

/* Glass overrides */
.theme-glass .ext-card,
.theme-glass .ext-installed__item,
.theme-glass .ext-installed-toggle,
.theme-glass .ext-stores__header,
.theme-glass .ext-stores__body {
  backdrop-filter:var(--crow-glass-blur);
  -webkit-backdrop-filter:var(--crow-glass-blur);
}
.theme-glass .ext-card:hover { box-shadow:0 8px 32px rgba(0,0,0,0.3); }
.theme-glass .ext-search__input {
  backdrop-filter:var(--crow-glass-blur);
  -webkit-backdrop-filter:var(--crow-glass-blur);
}

/* Detail modal */
#modal-content { position:relative; }
.ext-detail__header { display:flex; gap:1rem; align-items:flex-start; margin-bottom:1rem; }
.ext-detail__icon { flex-shrink:0; width:64px; height:64px; border-radius:16px; display:flex; align-items:center; justify-content:center; }
.ext-detail__info { flex:1; min-width:0; }
.ext-detail__title { font-family:'Fraunces',serif; font-size:1.15rem; font-weight:600; margin:0 0 0.25rem; color:var(--crow-text-primary); }
.ext-detail__author { font-size:0.75rem; font-family:'JetBrains Mono',monospace; color:var(--crow-text-muted); }
.ext-detail__badges { display:flex; flex-wrap:wrap; gap:0.3rem; margin:0.75rem 0; }
.ext-detail__desc { font-size:0.9rem; color:var(--crow-text-secondary); line-height:1.6; margin-bottom:1rem; }
.ext-detail__section { margin-bottom:1rem; }
.ext-detail__section-title { font-size:0.7rem; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:var(--crow-text-muted); margin-bottom:0.4rem; }
.ext-detail__tags { display:flex; flex-wrap:wrap; gap:0.3rem; }
.ext-detail__tag { font-size:0.7rem; padding:0.15rem 0.5rem; border-radius:4px; background:var(--crow-bg-elevated); color:var(--crow-text-secondary); }
.ext-detail__notes { font-size:0.85rem; color:var(--crow-text-secondary); background:var(--crow-bg-deep); border-radius:8px; padding:0.75rem 1rem; line-height:1.5; }
.ext-detail__req { display:flex; flex-wrap:wrap; gap:0.4rem; }
.ext-detail__req-chip { padding:0.2rem 0.6rem; border-radius:4px; background:var(--crow-bg-elevated); font-family:'JetBrains Mono',monospace; font-size:0.75rem; color:var(--crow-text-secondary); }
.ext-detail__actions { display:flex; gap:0.5rem; justify-content:flex-end; margin-top:1.25rem; padding-top:1rem; border-top:1px solid var(--crow-border); }
.ext-detail__close { position:absolute; top:0.5rem; right:0.75rem; background:none; border:none; color:var(--crow-text-muted); font-size:1.4rem; cursor:pointer; padding:0.25rem; line-height:1; transition:color 0.15s; }
.ext-detail__close:hover { color:var(--crow-text-primary); }

@media (max-width:480px) {
  .ext-detail__header { flex-direction:column; align-items:center; text-align:center; }
  .ext-detail__badges { justify-content:center; }
  .ext-detail__actions { flex-direction:column; }
  .ext-detail__actions .btn { width:100%; justify-content:center; }
}

/* Responsive */
@media (max-width:600px) {
  .ext-grid { grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:0.75rem; }
  .ext-card { padding:1rem 0.75rem; }
  .ext-card__icon { width:48px; height:48px; border-radius:12px; }
  .ext-installed__item { flex-wrap:wrap; }
  .ext-installed__actions { width:100%; justify-content:flex-end; margin-top:0.25rem; }
}
</style>`;
}
