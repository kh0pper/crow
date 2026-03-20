/**
 * Settings Section: Connection URLs
 */

import { escapeHtml, badge, dataTable } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";

export default {
  id: "connections",
  group: "connections",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  labelKey: "settings.section.connections",
  navOrder: 10,

  async getPreview({ lang }) {
    const localUrl = `localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;
    return localUrl;
  },

  async render({ req, lang }) {
    const gatewayUrl = process.env.CROW_GATEWAY_URL || "";
    const localUrl = `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;
    const requestUrl = `${req.protocol}://${req.get("host")}`;

    const urlRows = [];
    urlRows.push([
      t("settings.local", lang),
      `<code style="font-size:0.85rem;word-break:break-all">${escapeHtml(localUrl)}</code>`,
      badge(t("settings.always", lang), "connected"),
    ]);
    if (requestUrl !== localUrl) {
      urlRows.push([
        t("settings.tailnetLan", lang),
        `<code style="font-size:0.85rem;word-break:break-all">${escapeHtml(requestUrl)}</code>`,
        badge(t("settings.active", lang), "connected"),
      ]);
    }
    if (gatewayUrl) {
      urlRows.push([
        t("settings.publicBlogOnly", lang),
        `<a href="${escapeHtml(gatewayUrl)}/blog/" target="_blank" style="font-size:0.85rem;word-break:break-all">${escapeHtml(gatewayUrl)}/blog/</a>`,
        badge(t("settings.live", lang), "published"),
      ]);
    }

    const baseUrl = requestUrl;
    const mcpEndpoints = [
      [t("settings.routerRecommended", lang), `${baseUrl}/router/mcp`, t("settings.categoryTools", lang)],
      ["Memory", `${baseUrl}/memory/mcp`, t("settings.allMemoryTools", lang)],
      ["Projects", `${baseUrl}/research/mcp`, t("settings.allResearchTools", lang)],
      ["Sharing", `${baseUrl}/sharing/mcp`, t("settings.allSharingTools", lang)],
    ];

    const mcpRows = mcpEndpoints.map(([name, url, desc]) => [
      name,
      `<code style="font-size:0.8rem;word-break:break-all">${escapeHtml(url)}</code>`,
      `<span style="color:var(--crow-text-muted);font-size:0.85rem">${desc}</span>`,
    ]);

    return dataTable([t("settings.context", lang), t("settings.url", lang), t("settings.statusColumn", lang)], urlRows)
      + `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">The Crow's Nest is private (local/Tailscale only). Set <code>CROW_GATEWAY_URL</code> in .env for public blog/podcast URLs.</p>`
      + `<div style="margin-top:1rem"><h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${t("settings.mcpEndpoints", lang)}</h4>`
      + dataTable([t("settings.server", lang), t("settings.endpointUrl", lang), t("settings.scope", lang)], mcpRows)
      + `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">Use these Streamable HTTP endpoints to connect Claude.ai, ChatGPT, Gemini, Cursor, or other MCP clients. See the Help &amp; Setup section for platform-specific instructions.</p></div>`;
  },

  async handleAction() {
    return false;
  },
};
