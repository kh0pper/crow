/**
 * Nest Panel — Scoped CSS
 * "Dark Sanctuary" — phone-style home screen with atmospheric depth.
 * Large floating app icons, generous spacing, crow watermark.
 */

export function nestCSS() {
  return `<style>
  /* ─── Page Atmosphere ─── */
  .nest-page {
    position: relative;
    min-height: 70vh;
    display: flex;
    flex-direction: column;
  }

  /* Crow watermark — atmospheric, not functional */
  .nest-watermark {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 320px;
    height: 320px;
    opacity: 0.04;
    pointer-events: none;
    z-index: 0;
  }
  @media (prefers-color-scheme: dark) {
    .nest-watermark { opacity: 0.025; }
  }

  /* ─── Welcome ─── */
  .nest-welcome {
    text-align: center;
    padding: 2.5rem 1rem 1rem;
    position: relative;
    z-index: 1;
  }
  .nest-welcome-crow {
    width: 48px;
    height: 48px;
    margin: 0 auto 0.75rem;
    color: var(--crow-text-muted);
    opacity: 0.5;
  }
  .nest-welcome-crow svg {
    width: 100%;
    height: 100%;
  }
  .nest-greeting {
    font-family: var(--crow-body-font);
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--crow-text-primary);
    margin-bottom: 0.25rem;
    letter-spacing: -0.01em;
  }
  .nest-date {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: var(--crow-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  /* ─── Pinned Row ─── */
  .nest-pinned {
    position: relative;
    z-index: 1;
    padding: 1.5rem 1rem 0.5rem;
    max-width: 520px;
    margin: 0 auto;
  }
  .nest-pinned-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--crow-brand-gold);
    opacity: 0.7;
    margin-bottom: 0.6rem;
    padding-left: 0.25rem;
  }
  .nest-pinned-row {
    display: flex;
    gap: 0.75rem;
    overflow-x: auto;
    padding-bottom: 0.5rem;
    scrollbar-width: none;
  }
  .nest-pinned-row::-webkit-scrollbar { display: none; }

  .nest-pinned-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.85rem;
    background: color-mix(in srgb, var(--crow-brand-gold) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--crow-brand-gold) 20%, transparent);
    border-radius: 10px;
    text-decoration: none;
    color: var(--crow-text-primary);
    white-space: nowrap;
    flex-shrink: 0;
    font-size: 0.8rem;
    font-weight: 500;
    transition: background 0.15s, border-color 0.15s;
    position: relative;
  }
  @media (prefers-color-scheme: dark) {
    .nest-pinned-item {
      background: color-mix(in srgb, var(--crow-brand-gold) 6%, transparent);
      border-color: color-mix(in srgb, var(--crow-brand-gold) 15%, transparent);
    }
  }
  .nest-pinned-item:hover {
    background: color-mix(in srgb, var(--crow-brand-gold) 12%, transparent);
    border-color: color-mix(in srgb, var(--crow-brand-gold) 30%, transparent);
    color: var(--crow-text-primary);
  }
  .nest-pinned-item svg {
    width: 14px;
    height: 14px;
    color: var(--crow-brand-gold);
    flex-shrink: 0;
  }
  .nest-pinned-unpin {
    display: none;
    position: absolute;
    top: -5px;
    right: -5px;
    background: var(--crow-bg-elevated);
    border: 1px solid var(--crow-border);
    border-radius: 50%;
    width: 16px;
    height: 16px;
    font-size: 0.55rem;
    color: var(--crow-text-muted);
    cursor: pointer;
    align-items: center;
    justify-content: center;
    line-height: 1;
    z-index: 2;
  }
  .nest-pinned-item:hover .nest-pinned-unpin { display: flex; }

  /* ─── App Grid ─── */
  .nest-grid {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1.25rem 1rem;
    padding: 2rem 2rem 3rem;
    /* rem, so a larger text size widens the cells with the labels. */
    max-width: 32.5rem;
    margin: 0 auto;
  }
  @media (max-width: 600px) {
    .nest-grid {
      grid-template-columns: repeat(3, 1fr);
      /* A phone's width is fixed, so the side gutters give way as the text
         grows: 24px / 16px at the default size (as before), narrower at a
         larger one, so "Extensiones" still fits its cell at 150%. */
      padding: 1.5rem max(8px, calc(48px - 1.5rem)) 2.5rem;
      column-gap: max(6px, calc(32px - 1rem));
      max-width: 380px;
    }
  }
  @media (max-width: 380px) {
    .nest-grid {
      grid-template-columns: repeat(2, 1fr);
      max-width: 260px;
    }
  }

  /* ─── App Tile ─── */
  .nest-app {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    min-width: 0;
    gap: 0.45rem;
    text-decoration: none;
    color: var(--crow-text-secondary);
    cursor: pointer;
    position: relative;
    /* staggered reveal */
    opacity: 0;
    animation: nestAppIn 0.4s ease forwards;
  }

  .nest-app-icon {
    width: 56px;
    height: 56px;
    border-radius: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    position: relative;
  }
  .nest-app-icon svg {
    width: 26px;
    height: 26px;
  }

  .nest-app:hover .nest-app-icon {
    transform: scale(1.08);
  }
  .nest-app:active .nest-app-icon {
    transform: scale(0.95);
  }

  /* Two lines, then clipped: "Kolibri Learning Platform" reads whole instead
     of "Kolibri Lea...". min-height keeps one-line labels on the same rows.
     The label spans the whole grid cell (not a fixed 80px), so a word wraps
     only between words; break-word stays as the last resort for a single
     word wider than the cell ("Changedetection.io"). */
  .nest-app-label {
    font-size: 0.7rem;
    font-weight: 500;
    text-align: center;
    width: 100%;
    max-width: 100%;
    line-height: 1.2;
    min-height: 2.4em;
    white-space: normal;
    overflow-wrap: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .nest-app:hover .nest-app-label {
    color: var(--crow-text-primary);
  }

  /* Icon color themes */
  .nest-app--panel .nest-app-icon {
    background: color-mix(in srgb, var(--crow-accent) 10%, transparent);
    color: var(--crow-accent);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--crow-accent) 10%, transparent);
  }
  .nest-app--panel:hover .nest-app-icon {
    box-shadow: 0 4px 20px color-mix(in srgb, var(--crow-accent) 20%, transparent);
  }
  @media (prefers-color-scheme: dark) {
    .nest-app--panel .nest-app-icon { background: color-mix(in srgb, var(--crow-accent) 12%, transparent); }
  }

  .nest-app--bundle .nest-app-icon {
    background: rgba(147,51,234,0.1);
    color: #9333ea;
    box-shadow: 0 2px 8px rgba(147,51,234,0.08);
  }
  .nest-app--bundle:hover .nest-app-icon {
    box-shadow: 0 4px 20px rgba(147,51,234,0.18);
  }
  @media (prefers-color-scheme: dark) {
    .nest-app--bundle .nest-app-icon {
      background: rgba(192,132,252,0.12);
      color: #c084fc;
    }
  }
  .nest-bundle-glyph {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Bundle status dot */
  .nest-app-status {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 2px solid var(--crow-bg-deep);
  }

  @keyframes nestAppIn {
    from { opacity: 0; transform: translateY(12px) scale(0.9); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* ─── Unified Carousel (Phase 2) ─── */
  .nest-instance-carousel {
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    touch-action: pan-x pan-y; /* pan-y too: the carousel wraps the whole grid, and pan-x alone blocks vertical page scroll on phones */
    scroll-behavior: smooth;
    position: relative;
    z-index: 1;
    scrollbar-width: none;
  }
  .nest-instance-carousel::-webkit-scrollbar { display: none; }

  .nest-instance-section {
    scroll-snap-align: start;
    flex: 0 0 100%;
    min-width: 100%;
    box-sizing: border-box;
  }

  .nest-instance-section--offline .nest-instance-offline {
    padding: 3rem 1.5rem;
    text-align: center;
    color: var(--crow-text-muted);
    font-size: 0.85rem;
  }
  .nest-instance-section--offline .nest-instance-offline p {
    margin: 0 0 1rem;
  }
  .nest-instance-retry {
    background: transparent;
    border: 1px solid var(--crow-border);
    color: var(--crow-text-secondary);
    padding: 0.5rem 1.25rem;
    border-radius: 8px;
    font-size: 0.75rem;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .nest-instance-retry:hover {
    background: color-mix(in srgb, var(--crow-accent) 8%, transparent);
    border-color: var(--crow-accent);
    color: var(--crow-text-primary);
  }
  .nest-instance-retry:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }

  /* Instance-tabs strip styles live in shared/layout.js (dashboardCss) —
   * the strip is part of the shared layout, re-rendered on every page
   * (it is deliberately NOT data-turbo-permanent; see W1-2). */

  /* ─── Health Strip (W3-3) ─── */
  .nest-health-strip {
    margin: 0 1rem 0.75rem;
    border-radius: 10px;
    padding: 0.6rem 0.9rem;
    font-size: 0.82rem;
    border: 1px solid var(--crow-border);
    background: var(--crow-bg-surface);
  }
  .nest-health-strip--ok {
    border-color: rgba(34,197,94,0.25);
    background: rgba(34,197,94,0.04);
  }
  .nest-health-strip--warn {
    border-color: rgba(234,179,8,0.3);
    background: rgba(234,179,8,0.05);
  }
  .nest-health-allgood {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--crow-success);
    font-weight: 500;
  }
  .nest-health-allgood-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--crow-success);
    flex-shrink: 0;
  }
  .nest-health-issues {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .nest-health-issue {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .nest-health-issue-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .nest-health-issue-dot--warn { background: var(--crow-brand-gold); }
  .nest-health-issue-dot--info { background: var(--crow-accent); }
  .nest-health-issue-label {
    flex: 1;
    color: var(--crow-text-secondary);
    min-width: 0;
  }
  .nest-health-issue-action {
    font-size: 0.75rem;
    color: var(--crow-accent);
    text-decoration: none;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .nest-health-issue-action:hover { text-decoration: underline; }
  .nest-health-backup-form {
    display: inline;
    margin: 0;
    padding: 0;
  }
  .nest-health-backup-btn {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font-size: 0.75rem;
    color: var(--crow-accent);
    cursor: pointer;
    text-decoration: none;
    font-family: inherit;
  }
  .nest-health-backup-btn:hover { text-decoration: underline; }
  .nest-health-details {
    margin-top: 0.5rem;
    border-top: 1px solid var(--crow-border);
  }
  .nest-health-details summary {
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--crow-text-muted);
    padding-top: 0.4rem;
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .nest-health-details summary::-webkit-details-marker { display: none; }
  .nest-health-details[open] summary { color: var(--crow-text-secondary); }
  .nest-health-detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 0.35rem 0.5rem;
    margin-top: 0.5rem;
  }
  .nest-health-detail-card {
    background: var(--crow-bg-elevated);
    border: 1px solid var(--crow-border);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
  }
  .nest-health-detail-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--crow-text-muted);
    margin-bottom: 0.15rem;
  }
  .nest-health-detail-value {
    font-size: 0.8rem;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 500;
  }
  .nest-health-detail-value--ok { color: var(--crow-success); }
  .nest-health-detail-value--warn { color: var(--crow-brand-gold); }
  .nest-health-detail-value--info { color: var(--crow-accent); }
  .nest-health-detail-value--off { color: var(--crow-text-muted); }

  /* flash banner (post-backup redirect) */
  .nest-flash {
    margin: 0 1rem 0.75rem;
    border-radius: 8px;
    padding: 0.5rem 0.85rem;
    font-size: 0.82rem;
    border: 1px solid transparent;
  }
  .nest-flash--success {
    background: rgba(34,197,94,0.08);
    border-color: rgba(34,197,94,0.25);
    color: var(--crow-success);
  }
  .nest-flash--error {
    background: rgba(239,68,68,0.08);
    border-color: rgba(239,68,68,0.25);
    color: var(--crow-error);
  }

  /* ─── Phone: start the grid high (design quick win 3) ───
     The greeting, the all-good strip and the grid padding used to push the
     first tile to ~360px on a 412x915 phone. Compact all three; the desktop
     layout above is unchanged. */
  @media (max-width: 600px) {
    .nest-welcome { padding: 0.75rem 1rem 0.5rem; }
    .nest-welcome-crow { display: none; }
    .nest-greeting { font-size: 1.1rem; margin-bottom: 0; }
    .nest-date {
      font-family: var(--crow-body-font);
      font-size: 0.75rem;
      text-transform: none;
      letter-spacing: 0;
    }
    .nest-health-strip { padding: 0.45rem 0.8rem; margin-bottom: 0.25rem; }
    .nest-health-strip--ok {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.25rem 0.75rem;
    }
    .nest-health-strip--ok .nest-health-details {
      margin-top: 0;
      border-top: none;
    }
    .nest-health-strip--ok .nest-health-details summary { padding-top: 0; }
    .nest-health-strip--ok .nest-health-details[open] {
      flex-basis: 100%;
      border-top: 1px solid var(--crow-border);
    }
    .nest-health-strip--ok .nest-health-details[open] summary { padding-top: 0.4rem; }
    .nest-grid { padding-top: 0.75rem; row-gap: 1rem; }
  }

</style>`;
}
