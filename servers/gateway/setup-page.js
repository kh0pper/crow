/**
 * Setup Page — First-run password setup only.
 *
 * GET /setup:
 * - If password is already set → redirect to /dashboard/login
 * - If password is not set → show minimal password form (with setup token validation for hosted)
 * - EN/ES i18n with browser auto-detect + toggle
 *
 * All informational content (integrations, MCP endpoints, platform guides, context usage)
 * lives in the Settings panel's "Help & Setup" section, behind authentication.
 */

import { isPasswordSet, parseCookies } from "./dashboard/auth.js";
import { CROW_HERO_SVG } from "./dashboard/shared/crow-hero.js";

/** Escape a string for safe interpolation into HTML attributes. */
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- i18n translations (password form only) ---
const translations = {
  en: {
    title: "Crow Setup",
    subtitle: "Set up your Crow instance",
    step1Password: "Set Crow\u2019s Nest Password",
    useInviteLink: "Use the link you were sent.",
    setupTokenRequired: "This instance requires a setup token. Check your invite email for the correct link.",
    protectPassword: "Protect your Crow\u2019s Nest with a password. This is required before you can access the control panel.",
    choosePassword: "Choose a password (12+ characters)",
    confirmPassword: "Confirm password",
    setPassword: "Set Password",
  },
  es: {
    title: "Configuración de Crow",
    subtitle: "Configura tu instancia Crow",
    step1Password: "Establecer Contraseña del Nido",
    useInviteLink: "Usa el enlace que te enviaron.",
    setupTokenRequired: "Esta instancia requiere un token de configuración. Revisa tu correo de invitación para el enlace correcto.",
    protectPassword: "Protege tu Nido de Crow con una contraseña. Esto es necesario antes de poder acceder al panel de control.",
    choosePassword: "Elige una contraseña (12+ caracteres)",
    confirmPassword: "Confirmar contraseña",
    setPassword: "Establecer Contraseña",
  },
};

/**
 * Express handler for GET /setup
 */
export async function setupPageHandler(req, res) {
  const passwordConfigured = await isPasswordSet().catch(() => false);

  // Once password is set, setup page is done — redirect to login
  if (passwordConfigured) {
    return res.redirect("/dashboard/login?next=/dashboard/settings");
  }

  // --- Language detection ---
  // Priority: query param > cookie > DB setting > browser Accept-Language > 'en'
  const langParam = req.query.lang;
  const cookies = parseCookies(req);
  const langCookie = cookies.crow_lang;
  let dbLang = null;
  try {
    const { createDbClient } = await import("../db.js");
    const db = createDbClient();
    const r = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'language'", args: [] });
    dbLang = r.rows[0]?.value || null;
    db.close();
  } catch { /* DB not available */ }
  const acceptLang = req.headers["accept-language"] || "";
  const browserLang = acceptLang.startsWith("es") ? "es" : "en";
  const lang = ["en", "es"].includes(langParam) ? langParam
    : (langCookie || dbLang || browserLang);
  const t = translations[lang] || translations.en;

  // Setup token gating for hosted instances
  const setupToken = process.env.CROW_SETUP_TOKEN;
  const queryToken = req.query.token;
  const tokenBlocked = setupToken && queryToken !== setupToken;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f7; color: #1d1d1f; padding: 20px;
      max-width: 700px; margin: 0 auto; line-height: 1.5;
    }
    h1 { font-size: 24px; margin-bottom: 4px; }
    .subtitle { color: #86868b; font-size: 14px; margin-bottom: 24px; }
    .section { margin-bottom: 24px; }
    .section-title {
      font-size: 13px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.5px; color: #86868b; margin-bottom: 8px;
    }
    .instructions {
      background: white; border-radius: 12px; padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08); font-size: 14px;
    }
    .lang-toggle { position: absolute; top: 20px; right: 20px; display: flex; gap: 4px; }
    .lang-btn {
      padding: 4px 10px; border: 1px solid #d2d2d7; border-radius: 6px;
      background: white; color: #86868b; font-size: 12px; font-weight: 600;
      cursor: pointer; text-decoration: none;
    }
    .lang-btn.active { background: #6366f1; color: white; border-color: #6366f1; }
  </style>
</head>
<body>
  <div class="lang-toggle">
    <a href="?lang=en${setupToken && queryToken ? '&token=' + escapeAttr(queryToken) : ''}" class="lang-btn${lang === "en" ? " active" : ""}" onclick="setLang('en');return false;">EN</a>
    <a href="?lang=es${setupToken && queryToken ? '&token=' + escapeAttr(queryToken) : ''}" class="lang-btn${lang === "es" ? " active" : ""}" onclick="setLang('es');return false;">ES</a>
  </div>

  <div style="text-align:center;margin-bottom:8px"><div style="width:80px;height:80px;margin:0 auto">${CROW_HERO_SVG}</div></div>
  <h1>${t.title}</h1>
  <p class="subtitle">${t.subtitle}</p>

  <div class="section">
    <div class="section-title">${t.step1Password}</div>
    ${tokenBlocked ? `
    <div class="instructions">
      <p style="margin-bottom:12px;color:#ff3b30"><strong>${t.useInviteLink}</strong></p>
      <p style="color:#86868b">${t.setupTokenRequired}</p>
    </div>` : `
    <div class="instructions">
      <p style="margin-bottom:12px">${t.protectPassword}</p>
      <form method="POST" action="/dashboard/login" style="display:flex;gap:8px;flex-wrap:wrap;align-items:start">
        ${setupToken ? `<input type="hidden" name="setup_token" value="${escapeAttr(setupToken)}">` : ""}
        <input type="password" name="password" placeholder="${t.choosePassword}" required minlength="12"
          style="flex:1;min-width:160px;padding:10px 14px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        <input type="password" name="confirm" placeholder="${t.confirmPassword}" required minlength="12"
          style="flex:1;min-width:160px;padding:10px 14px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        <button type="submit" style="padding:10px 20px;background:#6366f1;color:white;border:none;border-radius:8px;font-weight:500;font-size:14px;cursor:pointer">${t.setPassword}</button>
      </form>
    </div>`}
  </div>

<script>
function setLang(l) {
  document.cookie = 'crow_lang=' + l + ';path=/;max-age=' + (30*24*60*60) + ';SameSite=Strict';
  var url = new URL(window.location);
  url.searchParams.set('lang', l);
  window.location = url.toString();
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
}
