/**
 * Nest Panel — HTML Template
 *
 * Renders the home screen: launcher grid, recent activity, system snapshot.
 * Uses inline SVG icons (matching sidebar nav style) instead of emoji.
 */

import { escapeHtml, badge, formatDate } from "../../shared/components.js";
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

  // Action icons
  new_post: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  new_chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>`,

  // Pinned type icons
  conversation: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  blog_draft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  project: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,

  // Activity feed icons
  ai_chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  mcp_session: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,

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

const ACTION_ICON_MAP = {
  new_post: "new_post",
  new_chat: "new_chat",
  search_memories: "search",
  upload_file: "upload",
};

function getTileIcon(key) {
  return TILE_ICONS[key] || TILE_ICONS.default;
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h";
  return Math.floor(hrs / 24) + "d";
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i] || "TB"}`;
}

// Crow SVG used as empty-state watermark (smaller, single-color)
const CROW_WATERMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none">
  <g transform="translate(40, 30)">
    <path d="M60 140 C20 140, 5 110, 10 80 C15 55, 35 35, 60 30 C75 27, 90 30, 100 40 C110 50, 115 65, 110 85 C108 95, 100 120, 95 130 C90 138, 75 142, 60 140Z" fill="currentColor"/>
    <circle cx="80" cy="42" r="22" fill="currentColor"/>
    <path d="M100 42 L120 38 L100 46Z" fill="currentColor"/>
    <path d="M15 120 C5 130, -5 140, -10 155 C0 150, 10 140, 20 130Z" fill="currentColor"/>
  </g>
</svg>`;

export function buildNestHTML(data, lang) {
  const { pinnedItems, bundles, dockerInfo, dbStats, recentChats, recentSessions } = data;

  let tileIndex = 0;

  // --- Welcome Header ---
  const dateStr = new Date().toLocaleDateString(
    lang === "es" ? "es-ES" : "en-US",
    { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  );

  const welcomeHtml = `<div class="nest-welcome">
    <div class="nest-welcome-crow">${CROW_HERO_SVG}</div>
    <div class="nest-welcome-text">
      <div class="nest-welcome-greeting">${t("health.welcome", lang)}</div>
      <div class="nest-welcome-date">${dateStr}</div>
    </div>
  </div>`;

  // --- Pinned Items ---
  const pinnedTiles = pinnedItems.map(p => {
    const iconKey = p.type === "conversation" ? "conversation" : p.type === "blog_draft" ? "blog_draft" : p.type === "project" ? "project" : "memory";
    const icon = getTileIcon(iconKey);
    const delay = tileIndex++ * 40;
    return `<a href="${escapeHtml(p.href)}" class="nest-tile nest-tile--pinned" style="animation-delay:${delay}ms">
      <form method="POST" class="nest-unpin-btn" onclick="event.stopPropagation()">
        <input type="hidden" name="action" value="unpin">
        <input type="hidden" name="item_type" value="${escapeHtml(p.type)}">
        <input type="hidden" name="item_id" value="${escapeHtml(p.id)}">
        <button type="submit" style="all:inherit;cursor:pointer">&times;</button>
      </form>
      <div class="nest-tile-icon">${icon}</div>
      <div class="nest-tile-label">${escapeHtml(p.label)}</div>
    </a>`;
  }).join("");

  // --- Panel Shortcuts ---
  const panels = getVisiblePanels().filter(p => p.id !== "nest");
  const panelTiles = panels.map(p => {
    const iconKey = PANEL_ICON_MAP[p.icon] || PANEL_ICON_MAP[p.id] || "default";
    const icon = getTileIcon(iconKey);
    const label = t("nav." + p.id, lang) !== "nav." + p.id ? t("nav." + p.id, lang) : p.name;
    const delay = tileIndex++ * 40;
    return `<a href="${escapeHtml(p.route)}" class="nest-tile nest-tile--panel" style="animation-delay:${delay}ms">
      <div class="nest-tile-icon">${icon}</div>
      <div class="nest-tile-label">${escapeHtml(label)}</div>
    </a>`;
  }).join("");

  // --- Quick Actions ---
  const actions = [
    { key: "new_post", label: t("blog.newPost", lang), href: "/dashboard/blog?action=new" },
    { key: "new_chat", label: t("messages.newAiChat", lang), href: "/dashboard/messages?action=new_chat" },
    { key: "search_memories", label: t("memory.search", lang), href: "/dashboard/memory" },
    { key: "upload_file", label: t("files.upload", lang), href: "/dashboard/files" },
  ];
  const actionTiles = actions.map(a => {
    const iconKey = ACTION_ICON_MAP[a.key] || "default";
    const icon = getTileIcon(iconKey);
    const delay = tileIndex++ * 40;
    return `<a href="${escapeHtml(a.href)}" class="nest-tile nest-tile--action" style="animation-delay:${delay}ms">
      <div class="nest-tile-icon">${icon}</div>
      <div class="nest-tile-label">${escapeHtml(a.label)}</div>
    </a>`;
  }).join("");

  // --- Bundle Tiles ---
  const bundleTiles = bundles.map(b => {
    const logo = getAddonLogo(b.id, 32);
    const iconHtml = logo || `<div style="width:32px;height:32px;border-radius:50%;background:rgba(168,85,247,0.15);color:#a855f7;display:flex;align-items:center;justify-content:center;font-size:0.85rem;font-weight:600">${escapeHtml(b.name.charAt(0).toUpperCase())}</div>`;
    const statusDot = `<span class="nest-tile-status" style="background:${b.isRunning ? "var(--crow-success)" : "var(--crow-text-muted)"}" title="${b.isRunning ? t("health.runningStatus", lang) : t("health.stoppedStatus", lang)}"></span>`;
    const hasWebUI = !!b.webUI;
    const webUIPort = hasWebUI ? b.webUI.port : "";
    const webUIPath = hasWebUI ? (b.webUI.path || "/") : "";
    const href = hasWebUI ? "#" : "/dashboard/extensions";
    const onclick = hasWebUI ? ` onclick="window.open(location.protocol+'//'+location.hostname+':${webUIPort}${webUIPath}','_blank');return false"` : "";
    const delay = tileIndex++ * 40;
    return `<a href="${escapeHtml(href)}" class="nest-tile nest-tile--bundle" style="animation-delay:${delay}ms"${onclick}>
      ${statusDot}
      <div class="nest-tile-icon" style="background:none">${iconHtml}</div>
      <div class="nest-tile-label">${escapeHtml(b.name)}</div>
    </a>`;
  }).join("");

  // --- Launcher Grid ---
  const launcherHtml = `<div class="nest-grid">
    ${pinnedTiles}${panelTiles}${actionTiles}${bundleTiles}
  </div>`;

  // --- Recent Activity: AI Chats ---
  let chatItems = "";
  if (recentChats.length === 0) {
    chatItems = `<div class="nest-activity-empty">${CROW_WATERMARK}<div>${t("messages.noChats", lang)}</div></div>`;
  } else {
    chatItems = recentChats.map(c => {
      const title = escapeHtml(c.title || "Chat");
      const meta = `${escapeHtml(c.provider || "")}${c.model ? " / " + escapeHtml(c.model) : ""} &middot; ${timeAgo(c.updated_at || c.created_at)}`;
      return `<a href="/dashboard/messages" class="nest-activity-item">
        <div class="nest-activity-icon nest-activity-icon--ai">${getTileIcon("ai_chat")}</div>
        <div class="nest-activity-body">
          <div class="nest-activity-title">${title}</div>
          <div class="nest-activity-meta">${meta}</div>
        </div>
      </a>`;
    }).join("");
  }

  // --- Recent Activity: MCP Sessions ---
  let sessionItems = "";
  if (recentSessions.length === 0) {
    sessionItems = `<div class="nest-activity-empty">${CROW_WATERMARK}<div>${t("nest.noSessionsYet", lang)}</div></div>`;
  } else {
    sessionItems = recentSessions.map(s => {
      const clientName = s.client_info?.name || "MCP client";
      const server = escapeHtml(s.server_name || "");
      const tools = s.tool_call_count || 0;
      const ago = timeAgo(s.started_at);
      const ended = s.ended_at ? "" : ` &middot; <span style="color:var(--crow-success)">${t("nest.active", lang)}</span>`;
      return `<div class="nest-activity-item">
        <div class="nest-activity-icon nest-activity-icon--mcp">${getTileIcon("mcp_session")}</div>
        <div class="nest-activity-body">
          <div class="nest-activity-title">${escapeHtml(clientName)} &middot; ${server}</div>
          <div class="nest-activity-meta">${tools} ${t("nest.tools", lang)} &middot; ${ago}${ended}</div>
        </div>
      </div>`;
    }).join("");
  }

  const activityHtml = `<div class="nest-section-title">${t("nest.recentActivity", lang)}</div>
  <hr class="nest-section-rule">
  <div class="nest-activity">
    <div class="nest-activity-list nest-activity-list--ai">
      <div class="nest-activity-header">${t("nest.aiChats", lang)}</div>
      ${chatItems}
    </div>
    <div class="nest-activity-list nest-activity-list--mcp">
      <div class="nest-activity-header">${t("nest.mcpSessions", lang)}</div>
      ${sessionItems}
    </div>
  </div>`;

  // --- System Snapshot ---
  const dbSize = formatSize(dbStats.sizeBytes);
  const dockerRunning = dockerInfo.available && dockerInfo.total > 0;

  const snapshotHtml = `<div class="nest-section-title">${t("nest.systemSnapshot", lang) !== "nest.systemSnapshot" ? t("nest.systemSnapshot", lang) : "System"}</div>
  <hr class="nest-section-rule">
  <div class="nest-snapshot">
    <div class="nest-snapshot-item">
      <span class="nest-snapshot-value${dockerRunning ? " nest-snapshot-value--active" : ""}">${dockerInfo.available ? dockerInfo.total : "\u2014"}</span>
      <span class="nest-snapshot-label">${t("health.docker", lang)}</span>
    </div>
    <div class="nest-snapshot-item">
      <span class="nest-snapshot-value">${escapeHtml(dbSize)}</span>
      <span class="nest-snapshot-label">${t("health.database", lang)}</span>
    </div>
    <div class="nest-snapshot-item">
      <span class="nest-snapshot-value">${dbStats.memories}</span>
      <span class="nest-snapshot-label">${t("health.memories", lang)}</span>
    </div>
    <div class="nest-snapshot-item">
      <span class="nest-snapshot-value">${dbStats.posts}</span>
      <span class="nest-snapshot-label">${t("health.posts", lang)}</span>
    </div>
    <div class="nest-snapshot-item">
      <span class="nest-snapshot-value">${dbStats.contacts}</span>
      <span class="nest-snapshot-label">${t("health.contacts", lang)}</span>
    </div>
  </div>`;

  return `${welcomeHtml}${launcherHtml}${activityHtml}${snapshotHtml}`;
}
