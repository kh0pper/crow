/**
 * Nest Panel — Scoped CSS
 * "Dark Editorial Nest" aesthetic — glass-morphism tiles, staggered reveal,
 * editorial typography, gold accents, timeline activity feed.
 */

export function nestCSS() {
  return `<style>
  /* ─── Welcome Header ─── */
  .nest-welcome {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    margin-bottom: 2rem;
    padding: 1.5rem 1.75rem;
    border-radius: 16px;
    background:
      radial-gradient(ellipse at 20% 50%, rgba(99,102,241,0.12) 0%, transparent 60%),
      var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    position: relative;
    overflow: hidden;
  }
  .nest-welcome::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 1.75rem;
    right: 1.75rem;
    height: 1px;
    background: linear-gradient(90deg, var(--crow-brand-gold), transparent 70%);
    opacity: 0.4;
  }
  .nest-welcome-crow {
    width: 72px;
    height: 72px;
    flex-shrink: 0;
    filter: drop-shadow(0 0 18px rgba(251,191,36,0.25));
  }
  .nest-welcome-text {
    flex: 1;
    min-width: 0;
  }
  .nest-welcome-greeting {
    font-family: 'Fraunces', serif;
    font-size: 1.3rem;
    font-weight: 600;
    color: var(--crow-text-primary);
    margin-bottom: 0.15rem;
  }
  .nest-welcome-date {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: var(--crow-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* ─── Section Titles ─── */
  .nest-section-title {
    font-family: 'Fraunces', serif;
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: var(--crow-text-primary);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .nest-section-title::before {
    content: '—';
    color: var(--crow-brand-gold);
    font-weight: 400;
  }
  .nest-section-rule {
    border: none;
    border-top: 1px solid var(--crow-border);
    margin: -0.25rem 0 1rem;
    opacity: 0.5;
  }

  /* ─── Launcher Grid ─── */
  .nest-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 0.75rem;
    margin-bottom: 2rem;
  }

  /* ─── Tiles (shared) ─── */
  .nest-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 1rem 0.5rem;
    background: rgba(26,26,46,0.6);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(61,61,77,0.6);
    border-radius: 14px;
    cursor: pointer;
    transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
    text-decoration: none;
    color: var(--crow-text-primary);
    min-height: 100px;
    position: relative;
    /* staggered reveal */
    opacity: 0;
    animation: nestTileIn 0.35s ease forwards;
  }
  .theme-light .nest-tile {
    background: rgba(255,255,255,0.7);
    border-color: rgba(231,229,228,0.8);
  }
  .nest-tile:hover {
    transform: translateY(-3px);
    border-color: rgba(99,102,241,0.5);
    box-shadow:
      0 8px 24px rgba(0,0,0,0.35),
      inset 0 1px 0 rgba(255,255,255,0.04);
    background: rgba(45,45,61,0.7);
    color: var(--crow-text-primary);
  }
  .theme-light .nest-tile:hover {
    background: rgba(255,255,255,0.95);
    box-shadow: 0 8px 24px rgba(0,0,0,0.08);
    border-color: var(--crow-accent);
  }

  @keyframes nestTileIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ─── Tile Icon ─── */
  .nest-tile-icon {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 0.5rem;
    position: relative;
  }
  .nest-tile-icon svg {
    width: 22px;
    height: 22px;
  }

  /* ─── Tile Label ─── */
  .nest-tile-label {
    font-size: 0.8rem;
    font-weight: 500;
    line-height: 1.2;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── Tile Status Dot ─── */
  .nest-tile-status {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    position: absolute;
    top: 10px;
    right: 10px;
    box-shadow: 0 0 6px currentColor;
  }

  /* ─── Pinned Tiles ─── */
  .nest-tile--pinned {
    border-left: 3px solid var(--crow-brand-gold);
  }
  .nest-tile--pinned .nest-tile-icon {
    background: rgba(251,191,36,0.1);
    color: var(--crow-brand-gold);
    box-shadow: 0 0 12px rgba(251,191,36,0.12);
  }
  .nest-tile--pinned:hover {
    border-color: var(--crow-brand-gold);
    box-shadow:
      0 8px 24px rgba(0,0,0,0.35),
      0 0 16px rgba(251,191,36,0.08);
  }

  /* ─── Panel Tiles ─── */
  .nest-tile--panel .nest-tile-icon {
    background: rgba(99,102,241,0.1);
    color: var(--crow-accent);
    box-shadow: 0 0 10px rgba(99,102,241,0.08);
  }
  .nest-tile--panel:hover .nest-tile-icon {
    box-shadow: 0 0 16px rgba(99,102,241,0.2);
  }

  /* ─── Action Tiles ─── */
  .nest-tile--action .nest-tile-icon {
    background: rgba(34,197,94,0.08);
    color: var(--crow-success);
    box-shadow: 0 0 10px rgba(34,197,94,0.06);
  }
  .nest-tile--action {
    border-style: solid;
    border-color: rgba(61,61,77,0.35);
    background:
      repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 6px,
        rgba(61,61,77,0.08) 6px,
        rgba(61,61,77,0.08) 7px
      ),
      rgba(26,26,46,0.4);
  }
  .theme-light .nest-tile--action {
    background:
      repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 6px,
        rgba(0,0,0,0.02) 6px,
        rgba(0,0,0,0.02) 7px
      ),
      rgba(255,255,255,0.5);
  }
  .nest-tile--action:hover .nest-tile-icon {
    box-shadow: 0 0 16px rgba(34,197,94,0.18);
  }

  /* ─── Bundle Tiles ─── */
  .nest-tile--bundle .nest-tile-icon {
    background: rgba(168,85,247,0.08);
    color: #a855f7;
    box-shadow: 0 0 10px rgba(168,85,247,0.06);
  }
  .nest-tile--bundle:hover .nest-tile-icon {
    box-shadow: 0 0 16px rgba(168,85,247,0.18);
  }

  /* ─── Unpin Button ─── */
  .nest-unpin-btn {
    display: none;
    position: absolute;
    top: 4px;
    right: 4px;
    background: var(--crow-bg-elevated);
    border: 1px solid var(--crow-border);
    border-radius: 50%;
    width: 18px;
    height: 18px;
    font-size: 0.65rem;
    color: var(--crow-text-muted);
    cursor: pointer;
    align-items: center;
    justify-content: center;
    line-height: 1;
    z-index: 2;
  }
  .nest-tile--pinned:hover .nest-unpin-btn { display: flex; }

  /* ─── Activity Feed ─── */
  .nest-activity {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 2rem;
  }
  @media (max-width: 768px) {
    .nest-activity { grid-template-columns: 1fr; }
  }

  .nest-activity-list {
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 14px;
    overflow: hidden;
  }
  .nest-activity-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--crow-border);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--crow-text-muted);
  }

  /* Timeline connector */
  .nest-activity-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 1rem;
    padding-left: 1.5rem;
    border-bottom: 1px solid rgba(61,61,77,0.3);
    font-size: 0.85rem;
    text-decoration: none;
    color: var(--crow-text-primary);
    transition: transform 0.15s ease, background 0.15s ease;
    position: relative;
  }
  .nest-activity-item:last-child { border-bottom: none; }

  /* Timeline vertical line */
  .nest-activity-item::before {
    content: '';
    position: absolute;
    left: 8px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--crow-border);
  }
  .nest-activity-item:first-child::before { top: 50%; }
  .nest-activity-item:last-child::before { bottom: 50%; }

  /* Timeline dot */
  .nest-activity-item::after {
    content: '';
    position: absolute;
    left: 5px;
    top: 50%;
    transform: translateY(-50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--crow-border);
    border: 2px solid var(--crow-bg-surface);
    z-index: 1;
  }

  /* Color-coded timeline */
  .nest-activity-list--ai .nest-activity-item::before { background: rgba(99,102,241,0.3); }
  .nest-activity-list--ai .nest-activity-item::after { background: var(--crow-accent); }
  .nest-activity-list--mcp .nest-activity-item::before { background: rgba(34,197,94,0.3); }
  .nest-activity-list--mcp .nest-activity-item::after { background: var(--crow-success); }

  .nest-activity-item:hover {
    transform: translateX(2px);
    background: rgba(99,102,241,0.04);
  }

  .nest-activity-icon {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .nest-activity-icon svg {
    width: 16px;
    height: 16px;
  }
  .nest-activity-icon--ai { background: rgba(99,102,241,0.12); color: var(--crow-accent); }
  .nest-activity-icon--mcp { background: rgba(34,197,94,0.12); color: var(--crow-success); }

  .nest-activity-body { flex: 1; min-width: 0; }
  .nest-activity-title {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nest-activity-meta {
    font-size: 0.7rem;
    color: var(--crow-text-muted);
    font-family: 'JetBrains Mono', monospace;
  }

  .nest-activity-empty {
    padding: 2rem 1.5rem;
    text-align: center;
    color: var(--crow-text-muted);
    font-size: 0.85rem;
    position: relative;
  }
  .nest-activity-empty svg {
    opacity: 0.08;
    width: 64px;
    height: 64px;
    margin-bottom: 0.5rem;
  }

  /* ─── System Snapshot ─── */
  .nest-snapshot {
    display: flex;
    gap: 0;
    flex-wrap: wrap;
    padding: 1.25rem 1.5rem;
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 14px;
    margin-bottom: 1.5rem;
  }
  .nest-snapshot-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    flex: 1;
    min-width: 80px;
    padding: 0.25rem 0.75rem;
  }
  .nest-snapshot-item + .nest-snapshot-item {
    border-left: 1px solid rgba(251,191,36,0.2);
  }
  .nest-snapshot-value {
    font-family: 'Fraunces', serif;
    font-size: 1.4rem;
    font-weight: 600;
    color: var(--crow-accent);
    line-height: 1;
  }
  .nest-snapshot-label {
    font-size: 0.7rem;
    color: var(--crow-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Docker pulse when running */
  .nest-snapshot-value--active {
    animation: snapshotPulse 2s ease-in-out infinite;
  }
  @keyframes snapshotPulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.7; }
  }
</style>`;
}
