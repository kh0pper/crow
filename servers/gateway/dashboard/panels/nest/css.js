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
    opacity: 0.025;
    pointer-events: none;
    z-index: 0;
  }
  .theme-light .nest-watermark { opacity: 0.04; }

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
    font-family: 'Fraunces', serif;
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
    background: rgba(251,191,36,0.06);
    border: 1px solid rgba(251,191,36,0.15);
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
  .theme-light .nest-pinned-item {
    background: rgba(251,191,36,0.08);
    border-color: rgba(251,191,36,0.2);
  }
  .nest-pinned-item:hover {
    background: rgba(251,191,36,0.12);
    border-color: rgba(251,191,36,0.3);
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
    max-width: 520px;
    margin: 0 auto;
  }
  @media (max-width: 600px) {
    .nest-grid {
      grid-template-columns: repeat(3, 1fr);
      padding: 1.5rem 1.5rem 2.5rem;
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

  .nest-app-label {
    font-size: 0.7rem;
    font-weight: 500;
    text-align: center;
    max-width: 72px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.2;
  }
  .nest-app:hover .nest-app-label {
    color: var(--crow-text-primary);
  }

  /* Icon color themes */
  .nest-app--panel .nest-app-icon {
    background: rgba(99,102,241,0.12);
    color: var(--crow-accent);
    box-shadow: 0 2px 8px rgba(99,102,241,0.1);
  }
  .nest-app--panel:hover .nest-app-icon {
    box-shadow: 0 4px 20px rgba(99,102,241,0.2);
  }
  .theme-light .nest-app--panel .nest-app-icon {
    background: rgba(79,70,229,0.1);
  }

  .nest-app--bundle .nest-app-icon {
    background: rgba(168,85,247,0.1);
    color: #a855f7;
    box-shadow: 0 2px 8px rgba(168,85,247,0.08);
  }
  .nest-app--bundle:hover .nest-app-icon {
    box-shadow: 0 4px 20px rgba(168,85,247,0.18);
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
    touch-action: pan-x;
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
    background: rgba(99,102,241,0.08);
    border-color: var(--crow-accent);
    color: var(--crow-text-primary);
  }
  .nest-instance-retry:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }

  /* ─── Instance Tabs Strip (rendered by shared/layout.js) ─── */
  .crow-instance-tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--crow-border);
    overflow-x: auto;
    scrollbar-width: none;
    background: var(--crow-bg-deep);
  }
  .crow-instance-tabs::-webkit-scrollbar { display: none; }

  .crow-instance-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.85rem;
    border-radius: 8px;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--crow-text-secondary);
    text-decoration: none;
    cursor: pointer;
    background: transparent;
    border: 1px solid transparent;
    white-space: nowrap;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .crow-instance-tab:hover {
    background: rgba(99,102,241,0.08);
    color: var(--crow-text-primary);
  }
  .crow-instance-tab:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }
  .crow-instance-tab.active,
  .crow-instance-tab[aria-selected="true"] {
    background: rgba(99,102,241,0.15);
    border-color: rgba(99,102,241,0.3);
    color: var(--crow-text-primary);
  }
  .crow-instance-tab[aria-disabled="true"],
  .crow-instance-tab.tab--offline {
    opacity: 0.5;
    cursor: default;
  }
  .crow-instance-tab-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--crow-text-muted);
  }
  .crow-instance-tab.tab--online .crow-instance-tab-dot {
    background: var(--crow-success);
  }
  .crow-instance-tab.tab--offline .crow-instance-tab-dot {
    background: var(--crow-text-muted);
  }

  body.unified-off #crow-instance-tabs { display: none; }

</style>`;
}
