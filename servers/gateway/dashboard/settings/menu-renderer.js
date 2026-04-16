/**
 * Settings Menu Renderer — iOS/Android-style grouped menu
 */

import { GROUPS, readSettings } from "./registry.js";
import { t } from "../shared/i18n.js";

/**
 * Render the grouped settings menu.
 * @param {object[]} sections - Sorted section manifests
 * @param {object} db - Database client
 * @param {string} lang - Language code
 * @returns {Promise<string>} HTML string
 */
export async function renderSettingsMenu(sections, db, lang) {
  // Merge globals + this-instance overrides. Section.getPreview() expects the
  // effective values; reading dashboard_settings alone would leave stale rows
  // in the preview row (e.g. Theme would show old mode after a local save).
  const settings = Object.fromEntries(await readSettings(db, "%"));

  // Group sections (skip hidden ones — still registered and deep-linkable,
  // but not shown in the menu. Used for staged rollouts where a feature
  // bundle ships settings that shouldn't appear until the consumer lands.)
  const grouped = {};
  for (const section of sections) {
    if (section.hidden) continue;
    const group = section.group || "general";
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(section);
  }

  // Render groups in order
  const sortedGroups = Object.keys(GROUPS).sort(
    (a, b) => GROUPS[a].order - GROUPS[b].order
  );

  let html = `<style>${menuCss()}</style>`;
  html += `<div class="settings-menu">`;

  for (const groupKey of sortedGroups) {
    const items = grouped[groupKey];
    if (!items || items.length === 0) continue;

    const groupDef = GROUPS[groupKey];
    html += `<div class="settings-group-label">${t(groupDef.labelKey, lang)}</div>`;
    html += `<div class="settings-group-card">`;

    for (let i = 0; i < items.length; i++) {
      const section = items[i];
      let preview = "";
      try {
        if (section.getPreview) {
          preview = await section.getPreview({ settings, lang }) || "";
        }
      } catch {}

      const isLast = i === items.length - 1;
      const borderClass = isLast ? "" : " settings-row-bordered";

      html += `<a href="/dashboard/settings?section=${section.id}" class="settings-row${borderClass}">
        <span class="settings-row-icon">${section.icon || ""}</span>
        <span class="settings-row-label">${t(section.labelKey, lang)}</span>
        <span class="settings-row-preview">${preview}</span>
        <span class="settings-row-chevron">&rsaquo;</span>
      </a>`;
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function menuCss() {
  return `
  .settings-menu { max-width: 640px; }
  .settings-group-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--crow-text-muted);
    margin: 1.25rem 0 0.4rem 0.25rem;
    font-weight: 600;
  }
  .settings-menu > .settings-group-label:first-child { margin-top: 0.5rem; }
  .settings-group-card {
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: var(--crow-radius-card, 12px);
    overflow: hidden;
  }
  .theme-glass .settings-group-card {
    backdrop-filter: var(--crow-glass-blur, blur(12px));
    -webkit-backdrop-filter: var(--crow-glass-blur, blur(12px));
  }
  .settings-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    text-decoration: none;
    color: var(--crow-text-primary);
    cursor: pointer;
    transition: background 0.15s;
  }
  .settings-row:hover {
    background: var(--crow-bg-elevated);
  }
  .settings-row-bordered {
    border-bottom: 1px solid var(--crow-border);
  }
  .settings-row-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--crow-accent);
  }
  .settings-row-icon svg {
    width: 18px;
    height: 18px;
  }
  .settings-row-label {
    flex: 1;
    font-size: 0.95rem;
    font-weight: 500;
  }
  .settings-row-preview {
    font-size: 0.85rem;
    color: var(--crow-text-muted);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .settings-row-chevron {
    color: var(--crow-text-muted);
    font-size: 1.2rem;
    flex-shrink: 0;
    line-height: 1;
  }
  .settings-back {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--crow-accent);
    text-decoration: none;
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }
  .settings-back:hover {
    text-decoration: underline;
  }
  @media (max-width: 600px) {
    .settings-row { padding: 0.85rem 0.75rem; }
    .settings-row-preview { max-width: 120px; font-size: 0.8rem; }
  }`;
}
