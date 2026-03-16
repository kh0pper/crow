/**
 * Nest Panel — HTML Template
 *
 * Renders the home screen: greeting + pinned row + app grid.
 * Phone-style — clean, breathable, focused on navigation.
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { getVisiblePanels } from "../../panel-registry.js";
import { CROW_HERO_SVG } from "../../shared/crow-hero.js";
import { getAddonLogo } from "../../shared/logos.js";

// ─── SVG Icons (stroke-style, matching sidebar nav) ───

const TILE_ICONS = {
  // Panel icons (reused from layout.js NAV_ICONS at 22px)
  messages: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  files: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  extensions: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  health: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12L12 4l9 8"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-5h4v5h4a1 1 0 0 0 1-1v-9"/></svg>`,
  skills: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
  contacts: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  memory: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 3-1.5 5-3 6.5V18a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.5C6.5 14 5 12 5 9a7 7 0 0 1 7-7z"/><line x1="9" y1="22" x2="15" y2="22"/></svg>`,
  media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,

  // Pinned type icons
  conversation: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  blog_draft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  project: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,

  // Fallback
  default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`,
};

// Map panel icon keys to TILE_ICONS keys
const PANEL_ICON_MAP = {
  messages: "messages",
  memory: "memory",
  edit: "edit",
  files: "files",
  extensions: "extensions",
  skills: "skills",
  settings: "settings",
  health: "health",
  contacts: "contacts",
  media: "media",
  mic: "media",
};

function getTileIcon(key) {
  return TILE_ICONS[key] || TILE_ICONS.default;
}

export function buildNestHTML(data, lang) {
  const { pinnedItems, bundles } = data;

  let tileIndex = 0;

  // --- Welcome Header (light, floating — no card wrapper) ---
  const dateStr = new Date().toLocaleDateString(
    lang === "es" ? "es-ES" : "en-US",
    { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  );

  const welcomeHtml = `<div class="nest-welcome">
    <div class="nest-welcome-crow">${CROW_HERO_SVG}</div>
    <div class="nest-greeting">${t("health.welcome", lang)}</div>
    <div class="nest-date">${dateStr}</div>
  </div>`;

  // --- Pinned Row (shown above grid only if items exist) ---
  let pinnedHtml = "";
  if (pinnedItems.length > 0) {
    const pinnedItemsHtml = pinnedItems.map(p => {
      const iconKey = p.type === "conversation" ? "conversation" : p.type === "blog_draft" ? "blog_draft" : p.type === "project" ? "project" : "memory";
      const icon = getTileIcon(iconKey);
      return `<a href="${escapeHtml(p.href)}" class="nest-pinned-item">
        <form method="POST" class="nest-pinned-unpin" onclick="event.stopPropagation()">
          <input type="hidden" name="action" value="unpin">
          <input type="hidden" name="item_type" value="${escapeHtml(p.type)}">
          <input type="hidden" name="item_id" value="${escapeHtml(p.id)}">
          <button type="submit" style="all:inherit;cursor:pointer">&times;</button>
        </form>
        ${icon}
        ${escapeHtml(p.label)}
      </a>`;
    }).join("");

    pinnedHtml = `<div class="nest-pinned">
      <div class="nest-pinned-label">${t("nest.pinned", lang) !== "nest.pinned" ? t("nest.pinned", lang) : "Pinned"}</div>
      <div class="nest-pinned-row">${pinnedItemsHtml}</div>
    </div>`;
  }

  // --- Panel Tiles ---
  const panels = getVisiblePanels().filter(p => p.id !== "nest");
  const panelTiles = panels.map(p => {
    const iconKey = PANEL_ICON_MAP[p.icon] || PANEL_ICON_MAP[p.id] || "default";
    const icon = getTileIcon(iconKey);
    const label = t("nav." + p.id, lang) !== "nav." + p.id ? t("nav." + p.id, lang) : p.name;
    const delay = tileIndex++ * 40;
    return `<a href="${escapeHtml(p.route)}" class="nest-app nest-app--panel" style="animation-delay:${delay}ms">
      <div class="nest-app-icon">${icon}</div>
      <div class="nest-app-label">${escapeHtml(label)}</div>
    </a>`;
  }).join("");

  // --- Bundle Tiles ---
  const bundleTiles = bundles.map(b => {
    const logo = getAddonLogo(b.id, 32);
    const iconHtml = logo || `<div style="width:32px;height:32px;border-radius:50%;background:rgba(168,85,247,0.15);color:#a855f7;display:flex;align-items:center;justify-content:center;font-size:0.85rem;font-weight:600">${escapeHtml(b.name.charAt(0).toUpperCase())}</div>`;
    const statusDot = `<span class="nest-app-status" style="background:${b.isRunning ? "var(--crow-success)" : "var(--crow-text-muted)"}" title="${b.isRunning ? t("health.runningStatus", lang) : t("health.stoppedStatus", lang)}"></span>`;
    const hasWebUI = !!b.webUI;
    const webUIPort = hasWebUI ? b.webUI.port : "";
    const webUIPath = hasWebUI ? (b.webUI.path || "/") : "";
    const href = hasWebUI ? "#" : "/dashboard/extensions";
    const onclick = hasWebUI ? ` onclick="window.open(location.protocol+'//'+location.hostname+':${webUIPort}${webUIPath}','_blank');return false"` : "";
    const delay = tileIndex++ * 40;
    return `<a href="${escapeHtml(href)}" class="nest-app nest-app--bundle" style="animation-delay:${delay}ms"${onclick}>
      <div class="nest-app-icon">${statusDot}${iconHtml}</div>
      <div class="nest-app-label">${escapeHtml(b.name)}</div>
    </a>`;
  }).join("");

  // --- App Grid (panels + bundles, no quick actions) ---
  const gridHtml = `<div class="nest-grid">
    ${panelTiles}${bundleTiles}
  </div>`;

  return `${welcomeHtml}${pinnedHtml}${gridHtml}`;
}
