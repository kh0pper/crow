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
    return "Connect a client";
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
        connectGuide: "Connect a client",
        connectPointer: "Set up Claude Code, Cursor, Gemini CLI, and other clients with copy-paste config.",
        openWizard: "Open the connect wizard",
        contextUsage: "Context Usage",
        toolsLoaded: "tools loaded",
        core: "core", external: "external",
        tokensOfContext: "tokens of context",
        routerAvailable: "Router available",
        contextDoc: 'Learn more about <a href="https://maestro.press/software/crow/guide/cross-platform" style="color:var(--crow-accent);text-decoration:none">context management and the router</a>.',
      },
      es: {
        connectGuide: "Conecta un cliente",
        connectPointer: "Configura Claude Code, Cursor, Gemini CLI y otros clientes con configuración lista para copiar.",
        openWizard: "Abrir el asistente de conexión",
        contextUsage: "Uso de Contexto",
        toolsLoaded: "herramientas cargadas",
        core: "base", external: "externas",
        tokensOfContext: "tokens de contexto",
        routerAvailable: "Router disponible",
        contextDoc: 'Aprende más sobre <a href="https://maestro.press/software/crow/guide/cross-platform" style="color:var(--crow-accent);text-decoration:none">gestión de contexto y el router</a>.',
      },
    };
    const ht = helpT[currentLang] || helpT.en;

    const proxyStatus = getProxyStatus();
    const coreTools = 49;
    let externalToolCount = 0;
    for (const s of proxyStatus) {
      if (s.status === "connected") externalToolCount += (s.toolCount || 0);
    }
    const totalTools = coreTools + externalToolCount;
    const estimatedTokens = totalTools * 200;
    const routerDisabled = process.env.CROW_DISABLE_ROUTER === "1";

    const replayHtml = `<p style="margin-bottom:1rem"><a href="/dashboard/onboarding?step=0" style="color:var(--crow-accent);text-decoration:none;font-weight:600"><span aria-hidden="true">&#8635;</span> ${escapeHtml(t("onboarding.replayLink", currentLang))}</a></p>`;
    return `
      ${replayHtml}
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${ht.connectGuide}</h4>
      <p style="font-size:0.85rem;line-height:1.6;margin-bottom:0.75rem">${ht.connectPointer}</p>
      <p><a href="/dashboard/connect" style="color:var(--crow-accent);text-decoration:none;font-weight:600">${ht.openWizard} &rarr;</a></p>
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
