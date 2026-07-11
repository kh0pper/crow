/**
 * Extensions Panel — CSS
 *
 * Scoped styles for the extensions/add-ons store panel.
 */

export function extensionStyles() {
  return `<style>
/* ─── Extensions Store ───
 * Hierarchy (collections > featured > groups) is carried by scale, weight and
 * one accent "spine" — never by new colors. Everything wraps: there is no
 * horizontally scrolling surface on this page, by design.
 */

/* View switcher (Browse | Installed) */
.ext-viewtabs {
  display:flex; flex-wrap:wrap; gap:0.25rem;
  padding:0.25rem;
  margin-bottom:1.25rem;
  background:var(--crow-bg-deep);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-pill, 8px);
  width:fit-content; max-width:100%;
}
.ext-viewtab {
  display:inline-flex; align-items:center; gap:0.4rem;
  padding:0.45rem 1.1rem;
  border:none; border-radius:calc(var(--crow-radius-pill, 8px) - 2px);
  background:transparent;
  color:var(--crow-text-secondary);
  font-family:'DM Sans',sans-serif;
  font-size:0.85rem; font-weight:500;
  cursor:pointer;
  transition:background 0.18s ease, color 0.18s ease;
}
.ext-viewtab:hover { color:var(--crow-text-primary); }
.ext-viewtab:focus-visible { outline:2px solid var(--crow-accent); outline-offset:2px; }
.ext-viewtab--active {
  background:var(--crow-bg-surface);
  color:var(--crow-text-primary);
  font-weight:600;
  box-shadow:0 1px 3px rgba(0,0,0,0.25);
}
.ext-viewtab__count {
  font-family:'JetBrains Mono',monospace;
  font-size:0.7rem;
  padding:0.05rem 0.35rem;
  border-radius:999px;
  background:var(--crow-accent-muted);
  color:var(--crow-accent);
}
.ext-view--hidden { display:none; }

/* Section headings — the type scale IS the hierarchy */
.ext-section { margin-bottom:2.25rem; }
.ext-section-title {
  font-family:'Fraunces',serif;
  font-weight:600;
  color:var(--crow-text-primary);
  margin:0 0 0.5rem;
  display:flex; align-items:center; gap:0.5rem;
  font-size:1rem;
}
.ext-section-title--lead { font-size:1.45rem; letter-spacing:-0.01em; margin-bottom:0.25rem; }
.ext-section-title--feature { font-size:1.2rem; margin-bottom:0.75rem; }
.ext-section-title--feature::before {
  content:""; flex:0 0 3px; align-self:stretch; min-height:1.1em;
  border-radius:2px; background:var(--crow-accent);
}
.ext-section-sub {
  font-size:0.85rem; color:var(--crow-text-muted);
  margin:0 0 1rem; max-width:56ch; line-height:1.5;
}
.ext-section-count {
  font-family:'JetBrains Mono',monospace;
  font-size:0.7rem; font-weight:500;
  color:var(--crow-text-muted);
  padding:0.1rem 0.4rem;
  border-radius:4px;
  background:var(--crow-bg-elevated);
}
.ext-sourcenote { font-size:0.75rem; color:var(--crow-text-muted); margin-bottom:1rem; }
.ext-empty { text-align:center; padding:2rem; color:var(--crow-text-muted); }

/* Starter collections — the loudest surface on the page */
.ext-collections__row {
  display:flex; flex-wrap:wrap; gap:0.85rem;
}
.ext-collection-card {
  flex:1 1 240px; min-width:0; max-width:100%;
  display:flex; flex-direction:column; align-items:flex-start; gap:0.3rem;
  padding:1.1rem 1.15rem 1.1rem 1.35rem;
  text-align:left;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-left:3px solid var(--crow-accent);
  border-radius:var(--crow-radius-card, 12px);
  cursor:pointer;
  font-family:'DM Sans',sans-serif;
  transition:transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  animation:fadeInUp 0.4s ease-out both;
}
.ext-collection-card:hover {
  transform:translateY(-3px);
  border-color:var(--crow-accent);
  box-shadow:0 10px 28px rgba(0,0,0,0.22);
}
.ext-collection-card:focus-visible { outline:2px solid var(--crow-accent); outline-offset:2px; }
.ext-collection-card__icon { font-size:1.6rem; line-height:1; margin-bottom:0.15rem; }
.ext-collection-card__name {
  font-family:'Fraunces',serif;
  font-size:1.05rem; font-weight:600;
  color:var(--crow-text-primary);
}
.ext-collection-card__desc {
  font-size:0.8rem; line-height:1.45;
  color:var(--crow-text-secondary);
}
.ext-collection-card__count {
  margin-top:0.35rem;
  font-family:'JetBrains Mono',monospace;
  font-size:0.7rem;
  color:var(--crow-accent);
}

/* Group chips — wrap, never scroll (the 19-tab nowrap row is what broke the page) */
.ext-group-chips {
  display:flex; flex-wrap:wrap; gap:0.5rem;
  margin-bottom:1.75rem;
}
.ext-group-chip {
  display:inline-flex; align-items:center; gap:0.35rem;
  padding:0.4rem 0.9rem;
  border-radius:var(--crow-radius-pill, 8px);
  background:transparent;
  border:1px solid var(--crow-border);
  color:var(--crow-text-secondary);
  font-family:'DM Sans',sans-serif;
  font-size:0.8rem; font-weight:500;
  cursor:pointer;
  transition:border-color 0.15s, color 0.15s, background 0.15s;
}
.ext-group-chip:hover { border-color:var(--crow-accent); color:var(--crow-text-primary); }
.ext-group-chip:focus-visible { outline:2px solid var(--crow-accent); outline-offset:2px; }
.ext-group-chip--active {
  background:var(--crow-accent-muted);
  color:var(--crow-accent);
  border-color:var(--crow-accent);
}
.ext-group-chip__count { font-family:'JetBrains Mono',monospace; font-size:0.7rem; opacity:0.75; }

/* Group sections */
.ext-group-section { margin-bottom:2rem; scroll-margin-top:1rem; }
.ext-group-more { margin-top:0.25rem; }

/* Collection install modal (shell — content is built by the client) */
.ext-collection-modal__title {
  font-family:'Fraunces',serif;
  font-size:1.2rem; font-weight:600;
  margin:0 0 0.35rem;
  color:var(--crow-text-primary);
}
.ext-collection-modal__desc {
  font-size:0.85rem; color:var(--crow-text-secondary);
  line-height:1.5; margin:0 0 1rem;
}
.ext-collection-modal__group-title {
  font-size:0.7rem; font-weight:600;
  text-transform:uppercase; letter-spacing:0.08em;
  color:var(--crow-text-muted);
  margin:1rem 0 0.4rem;
}
.ext-collection-modal__list { list-style:none; margin:0; padding:0; }
.ext-collection-modal__item {
  display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;
  padding:0.4rem 0;
  border-bottom:1px solid var(--crow-border);
  font-size:0.85rem;
  color:var(--crow-text-secondary);
}
.ext-collection-modal__item:last-child { border-bottom:none; }
.ext-collection-modal__item-name { color:var(--crow-text-primary); font-weight:500; }
.ext-collection-modal__item-state {
  margin-left:auto;
  font-family:'JetBrains Mono',monospace;
  font-size:0.7rem;
  color:var(--crow-text-muted);
}
.ext-collection-modal__item-state--done { color:var(--crow-success, var(--crow-accent)); }
.ext-collection-modal__item-state--failed { color:var(--crow-error, #e74c3c); }
.ext-collection-modal__note {
  font-size:0.8rem; line-height:1.5;
  color:var(--crow-text-muted);
  background:var(--crow-bg-deep);
  border-radius:8px;
  padding:0.65rem 0.85rem;
  margin-top:1rem;
}
.ext-collection-modal__progress { margin-top:1rem; }

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
/* Installed list — its own view now, so it is always expanded */
.ext-installed__list { display:flex; flex-direction:column; gap:0.5rem; margin-bottom:1.5rem; }
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
.ext-stores__row {
  display:flex; align-items:center; justify-content:space-between; gap:0.5rem;
  padding:0.4rem 0;
  border-bottom:1px solid var(--crow-border);
}
.ext-stores__url {
  font-size:0.85rem; color:var(--crow-text-secondary);
  font-family:'JetBrains Mono',monospace;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  min-width:0; flex:1 1 auto;
}

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

/* Glass overrides — every surface on this page has a companion rule here */
.theme-glass .ext-card,
.theme-glass .ext-installed__item,
.theme-glass .ext-stores__header,
.theme-glass .ext-stores__body,
.theme-glass .ext-viewtabs,
.theme-glass .ext-collection-card,
.theme-glass .ext-group-chip,
.theme-glass .ext-help {
  backdrop-filter:var(--crow-glass-blur);
  -webkit-backdrop-filter:var(--crow-glass-blur);
}
.theme-glass .ext-card:hover { box-shadow:0 8px 32px rgba(0,0,0,0.3); }
.theme-glass .ext-viewtab--active { box-shadow:0 1px 8px rgba(0,0,0,0.35); }
.theme-glass .ext-collection-card:hover { box-shadow:0 10px 34px rgba(0,0,0,0.32); }
.theme-glass .ext-collection-modal__note { backdrop-filter:var(--crow-glass-blur); -webkit-backdrop-filter:var(--crow-glass-blur); }
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
  .ext-viewtabs { width:100%; }
  .ext-viewtab { flex:1 1 0; justify-content:center; }
  .ext-collection-card { flex-basis:100%; }
  .ext-section-title--lead { font-size:1.25rem; }
}

@media (prefers-reduced-motion:reduce) {
  .ext-collection-card, .ext-card, .ext-installed__item { animation:none !important; }
  .ext-collection-card:hover, .ext-card:hover { transform:none; }
}
</style>`;
}
