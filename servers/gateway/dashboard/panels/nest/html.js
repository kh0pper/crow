/**
 * Nest Panel — HTML Template
 *
 * Renders the home screen: launcher grid, recent activity, system snapshot.
 */

import { escapeHtml, badge, formatDate } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { getVisiblePanels } from "../../panel-registry.js";
import { CROW_HERO_SVG } from "../../shared/crow-hero.js";
import { getAddonLogo } from "../../shared/logos.js";

// Panel icon map (emoji/unicode for tiles)
const PANEL_ICONS = {
  messages: "\u{1F4AC}",
  memory: "\u{1F9E0}",
  blog: "\u270F\uFE0F",
  files: "\u{1F4C1}",
  extensions: "\u{1F9E9}",
  skills: "\u{1F4DA}",
  settings: "\u2699\uFE0F",
  media: "\u{1F4F0}",
};

const ACTION_ICONS = {
  new_post: "\u270F\uFE0F",
  new_chat: "\u{1F4AC}",
  search_memories: "\u{1F50D}",
  upload_file: "\u{1F4E4}",
};

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

export function buildNestHTML(data, lang) {
  const { pinnedItems, bundles, dockerInfo, dbStats, recentChats, recentSessions } = data;

  // --- Welcome ---
  const welcomeHtml = `<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
    <div style="width:56px;height:56px;flex-shrink:0">${CROW_HERO_SVG}</div>
    <div>
      <div style="font-family:'Fraunces',serif;font-size:1.15rem;font-weight:600">${t("health.welcome", lang)}</div>
      <div style="color:var(--crow-text-muted);font-size:0.85rem">${new Date().toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
    </div>
  </div>`;

  // --- Pinned Items ---
  const pinnedTiles = pinnedItems.map(p => {
    const icon = p.type === "conversation" ? "\u{1F4AC}" : p.type === "blog_draft" ? "\u270F\uFE0F" : p.type === "project" ? "\u{1F4CA}" : "\u{1F9E0}";
    return `<a href="${escapeHtml(p.href)}" class="nest-tile nest-tile--pinned" style="position:relative">
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
    const icon = PANEL_ICONS[p.id] || PANEL_ICONS[p.icon] || "\u{1F4CB}";
    const label = t("nav." + p.id, lang) !== "nav." + p.id ? t("nav." + p.id, lang) : p.name;
    return `<a href="${escapeHtml(p.route)}" class="nest-tile nest-tile--panel">
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
    const icon = ACTION_ICONS[a.key] || "\u26A1";
    return `<a href="${escapeHtml(a.href)}" class="nest-tile nest-tile--action">
      <div class="nest-tile-icon">${icon}</div>
      <div class="nest-tile-label">${escapeHtml(a.label)}</div>
    </a>`;
  }).join("");

  // --- Bundle Tiles ---
  const bundleTiles = bundles.map(b => {
    const logo = getAddonLogo(b.id, 32);
    const iconHtml = logo || `<div style="width:32px;height:32px;border-radius:50%;background:rgba(168,85,247,0.15);color:#a855f7;display:flex;align-items:center;justify-content:center;font-size:0.85rem;font-weight:600">${escapeHtml(b.name.charAt(0).toUpperCase())}</div>`;
    const statusDot = `<span class="nest-tile-status" style="background:${b.isRunning ? "var(--crow-success)" : "var(--crow-text-muted)"}" title="${b.isRunning ? t("health.runningStatus", lang) : t("health.stoppedStatus", lang)}"></span>`;
    const href = b.webUI ? `http://localhost:${b.webUI.port}${b.webUI.path || "/"}` : "/dashboard/extensions";
    return `<a href="${escapeHtml(href)}" class="nest-tile nest-tile--bundle" ${b.webUI ? 'target="_blank"' : ""}>
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
    chatItems = `<div class="nest-activity-empty">${t("messages.noChats", lang)}</div>`;
  } else {
    chatItems = recentChats.map(c => {
      const title = escapeHtml(c.title || "Chat");
      const meta = `${escapeHtml(c.provider || "")}${c.model ? " / " + escapeHtml(c.model) : ""} &middot; ${timeAgo(c.updated_at || c.created_at)}`;
      return `<a href="/dashboard/messages" class="nest-activity-item">
        <div class="nest-activity-icon nest-activity-icon--ai">\u{1F4AC}</div>
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
    sessionItems = `<div class="nest-activity-empty">${t("nest.noSessionsYet", lang)}</div>`;
  } else {
    sessionItems = recentSessions.map(s => {
      const clientName = s.client_info?.name || "MCP client";
      const server = escapeHtml(s.server_name || "");
      const tools = s.tool_call_count || 0;
      const ago = timeAgo(s.started_at);
      const ended = s.ended_at ? "" : ` &middot; <span style="color:var(--crow-success)">${t("nest.active", lang)}</span>`;
      return `<div class="nest-activity-item">
        <div class="nest-activity-icon nest-activity-icon--mcp">\u{1F50C}</div>
        <div class="nest-activity-body">
          <div class="nest-activity-title">${escapeHtml(clientName)} &middot; ${server}</div>
          <div class="nest-activity-meta">${tools} ${t("nest.tools", lang)} &middot; ${ago}${ended}</div>
        </div>
      </div>`;
    }).join("");
  }

  const activityHtml = `<div class="nest-section-title">${t("nest.recentActivity", lang)}</div>
  <div class="nest-activity">
    <div class="nest-activity-list">
      <div class="nest-activity-header">${t("nest.aiChats", lang)}</div>
      ${chatItems}
    </div>
    <div class="nest-activity-list">
      <div class="nest-activity-header">${t("nest.mcpSessions", lang)}</div>
      ${sessionItems}
    </div>
  </div>`;

  // --- System Snapshot ---
  const dbSize = formatSize(dbStats.sizeBytes);

  const snapshotHtml = `<div class="nest-snapshot">
    <div class="nest-snapshot-item">
      <span class="nest-snapshot-value">${dockerInfo.available ? dockerInfo.total : "\u2014"}</span>
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
