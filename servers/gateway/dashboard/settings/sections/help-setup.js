/**
 * Settings Section: Help & Setup
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { getProxyStatus } from "../../../proxy.js";

export default {
  id: "help-setup",
  group: "connections",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  labelKey: "settings.section.helpSetup",
  navOrder: 20,

  async getPreview() {
    return "8 platforms";
  },

  async render({ req, db, lang }) {
    // Get current language for translations
    const langResult = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'language'", args: []
    });
    const { parseCookies } = await import("../../auth.js");
    const currentLang = langResult.rows[0]?.value || parseCookies(req).crow_lang || "en";

    const helpT = {
      en: {
        platformSetup: "Quick Setup by Platform",
        contextUsage: "Context Usage",
        toolsLoaded: "tools loaded",
        core: "core", external: "external",
        tokensOfContext: "tokens of context",
        routerAvailable: "Router available",
        contextDoc: 'Learn more about <a href="https://maestro.press/software/crow/guide/cross-platform" style="color:var(--crow-accent);text-decoration:none">context management and the router</a>.',
        claudeWebInstr: "Settings &rarr; Integrations &rarr; Add Custom &rarr; paste <code>/mcp</code> URL",
        claudeDesktopInstr: "Use stdio transport (see docs)",
        chatgptInstr: "Settings &rarr; Apps &rarr; Create &rarr; paste <code>/sse</code> URL",
        geminiInstr: "Add to <code>~/.gemini/settings.json</code> with <code>url</code> property",
        cursorInstr: "Add to <code>.cursor/mcp.json</code> with <code>url</code> property",
        windsurfInstr: "Add to <code>~/.codeium/windsurf/mcp_config.json</code>",
        clineInstr: "VS Code MCP settings &rarr; add server URL",
        claudeCodeInstr: "Add to <code>.mcp.json</code> or <code>~/.claude/mcp.json</code>",
      },
      es: {
        platformSetup: "Configuración Rápida por Plataforma",
        contextUsage: "Uso de Contexto",
        toolsLoaded: "herramientas cargadas",
        core: "base", external: "externas",
        tokensOfContext: "tokens de contexto",
        routerAvailable: "Router disponible",
        contextDoc: 'Aprende más sobre <a href="https://maestro.press/software/crow/guide/cross-platform" style="color:var(--crow-accent);text-decoration:none">gestión de contexto y el router</a>.',
        claudeWebInstr: "Settings &rarr; Integrations &rarr; Add Custom &rarr; pega la URL <code>/mcp</code>",
        claudeDesktopInstr: "Usa transporte stdio (ver docs)",
        chatgptInstr: "Settings &rarr; Apps &rarr; Create &rarr; pega la URL <code>/sse</code>",
        geminiInstr: "Agrega a <code>~/.gemini/settings.json</code> con la propiedad <code>url</code>",
        cursorInstr: "Agrega a <code>.cursor/mcp.json</code> con la propiedad <code>url</code>",
        windsurfInstr: "Agrega a <code>~/.codeium/windsurf/mcp_config.json</code>",
        clineInstr: "VS Code MCP settings &rarr; agrega la URL del servidor",
        claudeCodeInstr: "Agrega a <code>.mcp.json</code> o <code>~/.claude/mcp.json</code>",
      },
    };
    const ht = helpT[currentLang] || helpT.en;
    const docsBase = "https://maestro.press/software/crow/platforms";
    const platforms = [
      { name: "Claude Web/Mobile", slug: "claude", instr: ht.claudeWebInstr },
      { name: "Claude Desktop", slug: "claude-desktop", instr: ht.claudeDesktopInstr },
      { name: "ChatGPT", slug: "chatgpt", instr: ht.chatgptInstr },
      { name: "Gemini CLI", slug: "gemini-cli", instr: ht.geminiInstr },
      { name: "Cursor", slug: "cursor", instr: ht.cursorInstr },
      { name: "Windsurf", slug: "windsurf", instr: ht.windsurfInstr },
      { name: "Cline", slug: "cline", instr: ht.clineInstr },
      { name: "Claude Code", slug: "claude-code", instr: ht.claudeCodeInstr },
    ];
    const platformListHtml = platforms.map(p =>
      `<li><a href="${docsBase}/${p.slug}" target="_blank" rel="noopener" style="color:var(--crow-accent);text-decoration:none;font-weight:600">${escapeHtml(p.name)}</a> &mdash; ${p.instr}</li>`
    ).join("\n");

    const proxyStatus = getProxyStatus();
    const coreTools = 49;
    let externalToolCount = 0;
    for (const s of proxyStatus) {
      if (s.status === "connected") externalToolCount += (s.toolCount || 0);
    }
    const totalTools = coreTools + externalToolCount;
    const estimatedTokens = totalTools * 200;
    const routerDisabled = process.env.CROW_DISABLE_ROUTER === "1";

    return `
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${ht.platformSetup}</h4>
      <ul style="font-size:0.85rem;padding-left:1.2rem;list-style:disc;line-height:1.8">
        ${platformListHtml}
      </ul>
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin:1.25rem 0 0.5rem">${ht.contextUsage}</h4>
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
        <span style="font-size:0.95rem;font-weight:600">${totalTools} ${ht.toolsLoaded}</span>
        <span style="font-size:0.8rem;color:var(--crow-text-muted)">${coreTools} ${ht.core} + ${externalToolCount} ${ht.external} &mdash; ~${(estimatedTokens / 1000).toFixed(1)}K ${ht.tokensOfContext}</span>
        ${!routerDisabled ? `<span style="font-size:0.75rem;background:color-mix(in srgb, var(--crow-success) 15%, transparent);color:var(--crow-success);padding:2px 8px;border-radius:4px">${ht.routerAvailable}</span>` : ""}
      </div>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">${ht.contextDoc}</p>`;
  },

  async handleAction() {
    return false;
  },
};
