/**
 * Nest Panel — Scoped CSS
 */

export function nestCSS() {
  return `<style>
  .nest-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }
  .nest-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 1rem 0.5rem;
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 12px;
    cursor: pointer;
    transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
    text-decoration: none;
    color: var(--crow-text-primary);
    min-height: 100px;
  }
  .nest-tile:hover {
    transform: translateY(-2px);
    border-color: var(--crow-accent);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    color: var(--crow-text-primary);
  }
  .nest-tile-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 0.5rem;
    font-size: 1.2rem;
  }
  .nest-tile-label {
    font-size: 0.8rem;
    font-weight: 500;
    line-height: 1.2;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nest-tile-status {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    position: absolute;
    top: 8px;
    right: 8px;
  }
  .nest-tile--pinned { border-left: 3px solid var(--crow-brand-gold); }
  .nest-tile--pinned .nest-tile-icon { background: rgba(234,179,8,0.15); color: var(--crow-brand-gold); }
  .nest-tile--panel .nest-tile-icon { background: rgba(99,102,241,0.1); color: var(--crow-accent); }
  .nest-tile--action .nest-tile-icon { background: rgba(34,197,94,0.1); color: var(--crow-success); }
  .nest-tile--action { border-style: dashed; }
  .nest-tile--bundle { position: relative; }
  .nest-tile--bundle .nest-tile-icon { background: rgba(168,85,247,0.1); color: #a855f7; }

  .nest-section-title {
    font-family: 'Fraunces', serif;
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: var(--crow-text-primary);
  }

  .nest-activity {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  @media (max-width: 768px) {
    .nest-activity { grid-template-columns: 1fr; }
  }
  .nest-activity-list {
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 12px;
    overflow: hidden;
  }
  .nest-activity-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--crow-border);
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--crow-text-muted);
  }
  .nest-activity-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--crow-border);
    font-size: 0.85rem;
    text-decoration: none;
    color: var(--crow-text-primary);
    transition: background 0.1s;
  }
  .nest-activity-item:last-child { border-bottom: none; }
  .nest-activity-item:hover { background: var(--crow-bg-elevated); }
  .nest-activity-icon {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
    flex-shrink: 0;
  }
  .nest-activity-icon--ai { background: rgba(99,102,241,0.15); color: var(--crow-accent); }
  .nest-activity-icon--mcp { background: rgba(34,197,94,0.15); color: var(--crow-success); }
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
    padding: 1.5rem;
    text-align: center;
    color: var(--crow-text-muted);
    font-size: 0.85rem;
  }

  .nest-snapshot {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    padding: 1rem;
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 12px;
    margin-bottom: 1.5rem;
  }
  .nest-snapshot-item {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .nest-snapshot-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.1rem;
    font-weight: 500;
    color: var(--crow-accent);
  }
  .nest-snapshot-label {
    font-size: 0.75rem;
    color: var(--crow-text-muted);
  }

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
  }
  .nest-tile--pinned:hover .nest-unpin-btn { display: flex; }
</style>`;
}
