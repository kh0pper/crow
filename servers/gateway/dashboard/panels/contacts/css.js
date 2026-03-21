/**
 * Contacts Panel — CSS
 *
 * Responsive card grid, profile page, group chips, import modal.
 * Uses design tokens from design-tokens.js (no new CSS variables).
 */

export function contactsCss() {
  return `<style>
  /* === Tab Bar === */
  .contacts-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--crow-border);
    margin-bottom: 1.25rem;
  }

  .contacts-tab {
    padding: 0.6rem 1.2rem;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--crow-text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
    text-decoration: none;
  }

  .contacts-tab:hover {
    color: var(--crow-text-secondary);
  }

  .contacts-tab.active {
    color: var(--crow-accent);
    border-bottom-color: var(--crow-accent);
  }

  /* === Search & Filters === */
  .contacts-toolbar {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .contacts-search {
    flex: 1;
    min-width: 200px;
    padding: 0.5rem 0.75rem;
    background: var(--crow-bg-deep);
    border: 1px solid var(--crow-border);
    border-radius: 6px;
    color: var(--crow-text-primary);
    font-size: 0.85rem;
  }

  .contacts-search::placeholder {
    color: var(--crow-text-muted);
  }

  .contacts-filter-select {
    padding: 0.5rem 0.75rem;
    background: var(--crow-bg-deep);
    border: 1px solid var(--crow-border);
    border-radius: 6px;
    color: var(--crow-text-primary);
    font-size: 0.85rem;
    cursor: pointer;
  }

  /* === Card Grid === */
  .contacts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 0.75rem;
  }

  .contact-card {
    background: var(--crow-bg-elevated);
    border: 1px solid var(--crow-border);
    border-radius: 8px;
    padding: 1rem;
    transition: border-color 0.15s, box-shadow 0.15s;
    cursor: pointer;
    text-decoration: none;
    color: inherit;
    display: block;
  }

  .contact-card:hover {
    border-color: var(--crow-accent);
    box-shadow: 0 0 0 1px var(--crow-accent-muted);
  }

  .contact-card-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .contact-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 0.85rem;
    color: #fff;
    flex-shrink: 0;
    background: var(--crow-accent);
    overflow: hidden;
  }

  .contact-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .contact-card-info {
    flex: 1;
    min-width: 0;
  }

  .contact-card-name {
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--crow-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .contact-card-meta {
    font-size: 0.75rem;
    color: var(--crow-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .contact-card-groups {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }

  /* === Group Chips === */
  .group-chip {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 500;
    color: #fff;
    background: var(--crow-accent);
  }

  /* === Contact Profile === */
  .contact-profile {
    max-width: 640px;
  }

  .contact-profile-header {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    margin-bottom: 1.5rem;
  }

  .profile-avatar-large {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 1.5rem;
    color: #fff;
    flex-shrink: 0;
    background: var(--crow-accent);
    overflow: hidden;
  }

  .profile-avatar-large img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .profile-info h2 {
    margin: 0 0 0.25rem;
    font-family: 'Fraunces', serif;
    font-size: 1.3rem;
    color: var(--crow-text-primary);
  }

  .profile-info .type-badge {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 10px;
    background: var(--crow-bg-deep);
    color: var(--crow-text-muted);
    border: 1px solid var(--crow-border);
  }

  .profile-section {
    margin-bottom: 1.25rem;
  }

  .profile-section-title {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--crow-text-muted);
    margin-bottom: 0.5rem;
  }

  .profile-field {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--crow-border);
    font-size: 0.85rem;
  }

  .profile-field-label {
    color: var(--crow-text-muted);
  }

  .profile-field-value {
    color: var(--crow-text-primary);
    text-align: right;
    max-width: 60%;
    word-break: break-word;
  }

  .profile-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 1rem;
  }

  /* === Activity Feed === */
  .activity-item {
    display: flex;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--crow-border);
    font-size: 0.8rem;
  }

  .activity-icon {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    background: var(--crow-bg-deep);
    color: var(--crow-text-muted);
  }

  .activity-detail {
    flex: 1;
    color: var(--crow-text-secondary);
  }

  .activity-time {
    flex-shrink: 0;
    color: var(--crow-text-muted);
    font-size: 0.75rem;
  }

  /* === Group Manager === */
  .group-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .group-item {
    background: var(--crow-bg-elevated);
    border: 1px solid var(--crow-border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }

  .group-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .group-item-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    font-size: 0.9rem;
  }

  .group-color-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .group-member-count {
    font-size: 0.75rem;
    color: var(--crow-text-muted);
  }

  .group-actions {
    display: flex;
    gap: 0.35rem;
  }

  /* === My Profile === */
  .my-profile-form {
    max-width: 480px;
  }

  .my-profile-preview {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: var(--crow-bg-elevated);
    border: 1px solid var(--crow-border);
    border-radius: 8px;
  }

  /* === Import Modal === */
  .import-modal-backdrop {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 1000;
    align-items: center;
    justify-content: center;
  }

  .import-modal-backdrop.visible {
    display: flex;
  }

  .import-modal {
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 10px;
    padding: 1.5rem;
    width: 90%;
    max-width: 520px;
    max-height: 80vh;
    overflow-y: auto;
  }

  .import-modal h3 {
    margin: 0 0 1rem;
    font-family: 'Fraunces', serif;
    font-size: 1.1rem;
  }

  /* === Empty State === */
  .contacts-empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--crow-text-muted);
  }

  .contacts-empty p {
    margin: 0.35rem 0;
  }

  /* === Responsive === */
  @media (max-width: 640px) {
    .contacts-grid {
      grid-template-columns: 1fr;
    }

    .contact-profile-header {
      flex-direction: column;
      text-align: center;
    }

    .contacts-toolbar {
      flex-direction: column;
    }

    .contacts-search {
      min-width: 100%;
    }
  }

  @media (min-width: 1200px) {
    .contacts-grid {
      grid-template-columns: repeat(4, 1fr);
    }
  }
</style>`;
}
