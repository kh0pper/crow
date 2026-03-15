/**
 * Setup Status Page — Shows which integrations are connected.
 *
 * Serves a mobile-friendly HTML page at GET /setup with:
 * - Connected integrations (green) with tool counts
 * - Missing integrations (gray) with links to get API keys
 * - Instructions for adding env vars in Render
 * - Collapsible sections for cleaner UX
 * - EN/ES i18n with browser auto-detect + toggle
 *
 * No auth required — doesn't expose secrets, just shows which vars are set.
 */

import { execFileSync } from "node:child_process";
import { getProxyStatus } from "./proxy.js";
import { connectedServers } from "./proxy.js";
import { isPasswordSet, parseCookies } from "./dashboard/auth.js";
import { INTEGRATIONS } from "./integrations.js";
import { APP_ROOT, resolveEnvPath, writeEnvVar, removeEnvVar, sanitizeEnvValue } from "./env-manager.js";
import { CROW_HERO_SVG } from "./dashboard/shared/crow-hero.js";

// --- i18n translations ---
const translations = {
  en: {
    title: "Crow Setup",
    subtitle: "Integration status for your Crow instance",
    connected: "Connected",
    available: "Available",
    contextUsage: "Context Usage",
    toolsLoaded: "tools loaded",
    core: "core",
    external: "external",
    tokensOfContext: "tokens of context",
    routerAvailable: "Router available",
    tip: "Tip:",
    routerTip: "consider using the <strong>Router endpoint</strong> (<code>/router/mcp</code>) to reduce context usage to just 7 tools (~2.5K tokens).",
    contextLearnMore: 'Learn more about <a href="https://maestro.press/software/crow/guide/cross-platform" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none">context management and the router</a>.',
    step1Password: "Set Crow's Nest Password",
    crowsNest: "Crow's Nest",
    useInviteLink: "Use the link you were sent.",
    setupTokenRequired: "This instance requires a setup token. Check your invite email for the correct link.",
    protectPassword: "Protect your Crow's Nest with a password. This is required before you can access the control panel.",
    choosePassword: "Choose a password (12+ characters)",
    confirmPassword: "Confirm password",
    setPassword: "Set Password",
    passwordConfigured: "Password configured",
    nestProtected: "Crow's Nest is protected",
    step2Identity: "Your Identity",
    identity: "Identity",
    crowIdDesc: 'Your Crow ID &mdash; share this with peers to connect. <a href="https://maestro.press/software/crow/guide/sharing" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none;font-weight:400">Learn about sharing &amp; messaging</a>',
    step3Network: "Network Access",
    networkAccess: "Network Access",
    // Hosted network access
    yourInstance: "Your Instance",
    instanceOnline: "Online",
    dashboard: "Dashboard",
    blog: "Blog",
    tailscaleGuideNote: 'For additional private access via Tailscale, see the <a href="https://maestro.press/software/crow/guide/tailscale" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none">setup guide</a>.',
    // Self-hosted network states
    readyAccess: "Ready &mdash; access Crow from any device",
    tsConnectedHostname: "Tailscale is connected with hostname",
    crowsNestLabel: "Crow's Nest:",
    blogLabel: "Blog:",
    tailscaleIpLabel: "Tailscale IP:",
    caddyDetected: "Caddy reverse proxy detected &mdash; port-free URLs available",
    tsConnected: "Tailscale Connected",
    hostnameIs: "Hostname is",
    considerChanging: "consider changing to <strong>crow</strong> for easier access",
    currentUrl: "Current URL:",
    recommendHostname: 'Recommended: Set hostname to &ldquo;crow&rdquo;',
    hostnameExplanation: "This lets you access Crow at <strong>http://crow/</strong> from any device on your Tailnet &mdash; phone, laptop, or tablet.",
    hostnameAlternatives: 'If &ldquo;crow&rdquo; is already taken on your Tailnet, try <code>crow-2</code> or <code>crow-home</code>.',
    tsInstalled: "Tailscale Installed",
    tsNotConnected: "Not connected &mdash; authenticate to enable remote access",
    runCommands: "Run these commands on your server to connect:",
    followLogin: "Follow the login URL to authorize this device. Then set the hostname:",
    afterThat: "After that, open <strong>http://crow/dashboard</strong> from any device on your Tailnet.",
    setupRemoteAccess: "Set Up Remote Access",
    remoteAccessDesc: "Access Crow from your phone, laptop, or anywhere &mdash; securely and privately",
    tsIntro: 'creates a private network between your devices. Once set up, you can reach Crow at <strong>http://crow/</strong> from any device &mdash; no port forwarding, no public exposure.',
    step1Account: "1. Create a free account",
    signUpAt: 'Sign up at <a href="https://tailscale.com" target="_blank" style="color:#6366f1;text-decoration:none">tailscale.com</a> (free for up to 100 devices).',
    step2Install: "2. Install on this server",
    followLoginTerminal: "Follow the login URL printed in the terminal.",
    step3Hostname: "3. Set your hostname",
    hostnameAccessible: "This makes Crow accessible at <strong>http://crow/</strong> on your Tailnet.",
    step4Devices: "4. Install on your other devices",
    installOtherDevices: 'Install Tailscale on your phone, laptop, or tablet from <a href="https://tailscale.com/download" target="_blank" style="color:#6366f1;text-decoration:none">tailscale.com/download</a> and sign in with the same account.',
    thenOpen: "Then open <strong>http://crow/dashboard</strong> in any browser.",
    tailscaleAddonNote: "You can also install Tailscale as an add-on from the Extensions panel.",
    // Connected integrations
    connectedSection: "Connected",
    toolAvailable: "tool available",
    toolsAvailable: "tools available",
    remove: "Remove",
    // Errors
    errors: "Errors",
    failedToConnect: "Failed to connect",
    // Available integrations
    availableIntegrations: "Available Integrations",
    productivity: "Productivity",
    communication: "Communication",
    developmentSearch: "Development & Search",
    requiresPython: "Requires Python (uvx) &mdash; install Python to enable this integration",
    getApiKey: "Get your API key",
    setupGuide: "Setup guide",
    noConfigNeeded: "No configuration needed &mdash; works out of the box.",
    save: "Save",
    // Hosted integrations
    availableAddKeys: "Available &mdash; Add API Keys to Enable",
    addInRender: "Add in Render",
    envVariable: "Environment variable",
    getApiKeyArrow: "Get your API key &rarr;",
    // How to add
    howToAdd: "How to Add an Integration",
    hostedStep1: "<strong>Get your API key</strong> from the service",
    hostedStep2: "Go to your <strong>Crow's Nest</strong> &rarr; <strong>Settings</strong> panel",
    hostedStep3: "Add the environment variable name and your API key",
    hostedStep4: "Your instance will restart automatically (~10 seconds)",
    hostedStep5: "Refresh this page to see the integration turn green",
    renderStep1: "<strong>Get your API key</strong> from the service",
    renderStep2: "<strong>Go to your Render dashboard</strong> &rarr; your crow-gateway service &rarr; <strong>Environment</strong>",
    renderStep3: '<strong>Click "Add Environment Variable"</strong> &rarr; type the variable name &rarr; paste your key &rarr; <strong>Save Changes</strong>',
    renderStep4: "Render will <strong>automatically restart</strong> your service (~1 minute)",
    renderStep5: "Refresh this page to see the integration turn green",
    openRenderDashboard: "Open Render Dashboard",
    // MCP Endpoints
    mcpEndpoints: "MCP Endpoint URLs",
    mcpIntro: "Use these URLs to connect from any MCP-compatible AI platform:",
    routerRecommended: "Router (Recommended &mdash; 7 tools instead of 49+)",
    streamableHttp: "Streamable HTTP (Claude, Gemini, Grok, Cursor, Windsurf, Cline, Claude Code)",
    sseChatgpt: "SSE (ChatGPT)",
    memory: "Memory",
    research: "Research",
    streamableHttpShort: "Streamable HTTP",
    externalTools: "External Tools (GitHub, Slack, etc.)",
    quickSetup: "Quick Setup by Platform:",
    // Platform instructions with doc links
    claudeWebInstr: 'Settings &rarr; Integrations &rarr; Add Custom &rarr; paste <code>/mcp</code> URL',
    claudeDesktopInstr: "Use stdio transport (see docs)",
    chatgptInstr: 'Settings &rarr; Apps &rarr; Create &rarr; paste <code>/sse</code> URL',
    geminiInstr: 'Add to <code>~/.gemini/settings.json</code> with <code>url</code> property',
    cursorInstr: 'Add to <code>.cursor/mcp.json</code> with <code>url</code> property',
    windsurfInstr: 'Add to <code>~/.codeium/windsurf/mcp_config.json</code>',
    clineInstr: "VS Code MCP settings &rarr; add server URL",
    claudeCodeInstr: 'Add to <code>.mcp.json</code> or <code>~/.claude/mcp.json</code>',
    // Restart banner
    keysSaved: "Keys saved! Restarting gateway...",
    waitingRestart: "Waiting for restart...",
    removeConfirm: "Remove this integration\u2019s API keys?",
    savedRestart: "Saved! Restart gateway to apply.",
    error: "Error",
    gatewayManualRestart: "Gateway may need manual restart.",
  },
  es: {
    title: "Configuración de Crow",
    subtitle: "Estado de integraciones de tu instancia Crow",
    connected: "Conectadas",
    available: "Disponibles",
    contextUsage: "Uso de Contexto",
    toolsLoaded: "herramientas cargadas",
    core: "base",
    external: "externas",
    tokensOfContext: "tokens de contexto",
    routerAvailable: "Router disponible",
    tip: "Consejo:",
    routerTip: "considera usar el <strong>endpoint del Router</strong> (<code>/router/mcp</code>) para reducir el uso de contexto a solo 7 herramientas (~2.5K tokens).",
    contextLearnMore: 'Aprende más sobre <a href="https://maestro.press/software/crow/guide/cross-platform" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none">gestión de contexto y el router</a>.',
    step1Password: "Establecer Contraseña del Nido",
    crowsNest: "Nido de Crow",
    useInviteLink: "Usa el enlace que te enviaron.",
    setupTokenRequired: "Esta instancia requiere un token de configuración. Revisa tu correo de invitación para el enlace correcto.",
    protectPassword: "Protege tu Nido de Crow con una contraseña. Esto es necesario antes de poder acceder al panel de control.",
    choosePassword: "Elige una contraseña (12+ caracteres)",
    confirmPassword: "Confirmar contraseña",
    setPassword: "Establecer Contraseña",
    passwordConfigured: "Contraseña configurada",
    nestProtected: "El Nido de Crow está protegido",
    step2Identity: "Tu Identidad",
    identity: "Identidad",
    crowIdDesc: 'Tu Crow ID &mdash; compártelo con otros para conectar. <a href="https://maestro.press/software/crow/guide/sharing" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none;font-weight:400">Sobre compartir y mensajes</a>',
    step3Network: "Acceso a la Red",
    networkAccess: "Acceso a la Red",
    yourInstance: "Tu Instancia",
    instanceOnline: "En línea",
    dashboard: "Panel de control",
    blog: "Blog",
    tailscaleGuideNote: 'Para acceso privado adicional mediante Tailscale, consulta la <a href="https://maestro.press/software/crow/guide/tailscale" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none">guía de configuración</a>.',
    readyAccess: "Listo &mdash; accede a Crow desde cualquier dispositivo",
    tsConnectedHostname: "Tailscale está conectado con el hostname",
    crowsNestLabel: "Nido de Crow:",
    blogLabel: "Blog:",
    tailscaleIpLabel: "IP de Tailscale:",
    caddyDetected: "Proxy reverso Caddy detectado &mdash; URLs sin puerto disponibles",
    tsConnected: "Tailscale Conectado",
    hostnameIs: "El hostname es",
    considerChanging: "considera cambiarlo a <strong>crow</strong> para acceso más fácil",
    currentUrl: "URL actual:",
    recommendHostname: 'Recomendado: Cambiar hostname a &ldquo;crow&rdquo;',
    hostnameExplanation: "Esto te permite acceder a Crow en <strong>http://crow/</strong> desde cualquier dispositivo en tu Tailnet &mdash; teléfono, laptop o tablet.",
    hostnameAlternatives: 'Si &ldquo;crow&rdquo; ya está en uso en tu Tailnet, prueba <code>crow-2</code> o <code>crow-home</code>.',
    tsInstalled: "Tailscale Instalado",
    tsNotConnected: "No conectado &mdash; autentícate para habilitar el acceso remoto",
    runCommands: "Ejecuta estos comandos en tu servidor para conectar:",
    followLogin: "Sigue la URL de inicio de sesión para autorizar este dispositivo. Luego establece el hostname:",
    afterThat: "Después de eso, abre <strong>http://crow/dashboard</strong> desde cualquier dispositivo en tu Tailnet.",
    setupRemoteAccess: "Configurar Acceso Remoto",
    remoteAccessDesc: "Accede a Crow desde tu teléfono, laptop o cualquier lugar &mdash; de forma segura y privada",
    tsIntro: 'crea una red privada entre tus dispositivos. Una vez configurado, puedes acceder a Crow en <strong>http://crow/</strong> desde cualquier dispositivo &mdash; sin reenvío de puertos, sin exposición pública.',
    step1Account: "1. Crear una cuenta gratuita",
    signUpAt: 'Regístrate en <a href="https://tailscale.com" target="_blank" style="color:#6366f1;text-decoration:none">tailscale.com</a> (gratis para hasta 100 dispositivos).',
    step2Install: "2. Instalar en este servidor",
    followLoginTerminal: "Sigue la URL de inicio de sesión impresa en la terminal.",
    step3Hostname: "3. Establecer tu hostname",
    hostnameAccessible: "Esto hace que Crow sea accesible en <strong>http://crow/</strong> en tu Tailnet.",
    step4Devices: "4. Instalar en tus otros dispositivos",
    installOtherDevices: 'Instala Tailscale en tu teléfono, laptop o tablet desde <a href="https://tailscale.com/download" target="_blank" style="color:#6366f1;text-decoration:none">tailscale.com/download</a> e inicia sesión con la misma cuenta.',
    thenOpen: "Luego abre <strong>http://crow/dashboard</strong> en cualquier navegador.",
    tailscaleAddonNote: "También puedes instalar Tailscale como complemento desde el panel de Extensiones.",
    connectedSection: "Conectadas",
    toolAvailable: "herramienta disponible",
    toolsAvailable: "herramientas disponibles",
    remove: "Eliminar",
    errors: "Errores",
    failedToConnect: "Error al conectar",
    availableIntegrations: "Integraciones Disponibles",
    productivity: "Productividad",
    communication: "Comunicación",
    developmentSearch: "Desarrollo y Búsqueda",
    requiresPython: "Requiere Python (uvx) &mdash; instala Python para habilitar esta integración",
    getApiKey: "Obtener tu API key",
    setupGuide: "Guía de configuración",
    noConfigNeeded: "No necesita configuración &mdash; funciona de inmediato.",
    save: "Guardar",
    availableAddKeys: "Disponibles &mdash; Agrega API Keys para Habilitar",
    addInRender: "Agregar en Render",
    envVariable: "Variable de entorno",
    getApiKeyArrow: "Obtener tu API key &rarr;",
    howToAdd: "Cómo Agregar una Integración",
    hostedStep1: "<strong>Obtén tu API key</strong> del servicio",
    hostedStep2: "Ve a tu <strong>Nido de Crow</strong> &rarr; panel de <strong>Configuración</strong>",
    hostedStep3: "Agrega el nombre de la variable de entorno y tu API key",
    hostedStep4: "Tu instancia se reiniciará automáticamente (~10 segundos)",
    hostedStep5: "Recarga esta página para ver la integración en verde",
    renderStep1: "<strong>Obtén tu API key</strong> del servicio",
    renderStep2: "<strong>Ve a tu panel de Render</strong> &rarr; tu servicio crow-gateway &rarr; <strong>Environment</strong>",
    renderStep3: '<strong>Haz clic en "Add Environment Variable"</strong> &rarr; escribe el nombre de la variable &rarr; pega tu key &rarr; <strong>Save Changes</strong>',
    renderStep4: "Render <strong>reiniciará automáticamente</strong> tu servicio (~1 minuto)",
    renderStep5: "Recarga esta página para ver la integración en verde",
    openRenderDashboard: "Abrir Panel de Render",
    mcpEndpoints: "URLs de Endpoints MCP",
    mcpIntro: "Usa estas URLs para conectar desde cualquier plataforma AI compatible con MCP:",
    routerRecommended: "Router (Recomendado &mdash; 7 herramientas en vez de 49+)",
    streamableHttp: "Streamable HTTP (Claude, Gemini, Grok, Cursor, Windsurf, Cline, Claude Code)",
    sseChatgpt: "SSE (ChatGPT)",
    memory: "Memoria",
    research: "Investigación",
    streamableHttpShort: "Streamable HTTP",
    externalTools: "Herramientas Externas (GitHub, Slack, etc.)",
    quickSetup: "Configuración Rápida por Plataforma:",
    claudeWebInstr: 'Settings &rarr; Integrations &rarr; Add Custom &rarr; pega la URL <code>/mcp</code>',
    claudeDesktopInstr: "Usa transporte stdio (ver docs)",
    chatgptInstr: 'Settings &rarr; Apps &rarr; Create &rarr; pega la URL <code>/sse</code>',
    geminiInstr: 'Agrega a <code>~/.gemini/settings.json</code> con la propiedad <code>url</code>',
    cursorInstr: 'Agrega a <code>.cursor/mcp.json</code> con la propiedad <code>url</code>',
    windsurfInstr: 'Agrega a <code>~/.codeium/windsurf/mcp_config.json</code>',
    clineInstr: "VS Code MCP settings &rarr; agrega la URL del servidor",
    claudeCodeInstr: 'Agrega a <code>.mcp.json</code> o <code>~/.claude/mcp.json</code>',
    keysSaved: "¡Keys guardadas! Reiniciando gateway...",
    waitingRestart: "Esperando reinicio...",
    removeConfirm: "¿Eliminar las API keys de esta integración?",
    savedRestart: "¡Guardado! Reinicia el gateway para aplicar.",
    error: "Error",
    gatewayManualRestart: "El gateway podría necesitar reinicio manual.",
  },
};

// Validate translation completeness at startup
const enKeys = Object.keys(translations.en);
const esKeys = Object.keys(translations.es);
const missingInEs = enKeys.filter((k) => !esKeys.includes(k));
const missingInEn = esKeys.filter((k) => !enKeys.includes(k));
if (missingInEs.length > 0) {
  console.warn(`[setup-page] Missing ES translations: ${missingInEs.join(", ")}`);
}
if (missingInEn.length > 0) {
  console.warn(`[setup-page] Extra ES keys not in EN: ${missingInEn.join(", ")}`);
}

/**
 * Detect Tailscale hostname and IP if available.
 * Returns { hostname, ip, installed } or { installed: false } if not installed,
 * or null if installed but not running/authenticated.
 */
function detectTailscale() {
  // Check if tailscale binary exists
  try {
    execFileSync("which", ["tailscale"], { stdio: "pipe", timeout: 2000 });
  } catch {
    return { installed: false };
  }

  try {
    const json = execFileSync("tailscale", ["status", "--json"], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const status = JSON.parse(json);
    const self = status.Self;
    if (!self) return { installed: true, hostname: null, ip: null };

    const hostname = self.HostName || null;
    const ip = self.TailscaleIPs?.[0] || null;
    return { installed: true, hostname, ip };
  } catch {
    return { installed: true, hostname: null, ip: null };
  }
}

/**
 * Detect if Caddy is running as a reverse proxy.
 * When Caddy proxies the gateway, users can access without the port number.
 */
function detectCaddy() {
  try {
    const result = execFileSync("systemctl", ["is-active", "caddy"], {
      timeout: 2000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() === "active";
  } catch {
    return false;
  }
}

/** Platform doc link base URL */
const DOCS_BASE = "https://maestro.press/software/crow/platforms";

/**
 * Express handler for GET /setup
 */
export async function setupPageHandler(req, res) {
  const integrations = getProxyStatus();
  const passwordConfigured = await isPasswordSet().catch(() => false);

  // If password is set and user is authenticated, redirect to settings
  if (passwordConfigured && !req.query.standalone) {
    const cookies = parseCookies(req);
    if (cookies.crow_session) {
      return res.redirect("/dashboard/settings#setup");
    }
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
  } catch { /* DB not available — use other sources */ }
  const acceptLang = req.headers["accept-language"] || "";
  const browserLang = acceptLang.startsWith("es") ? "es" : "en";
  const lang = ["en", "es"].includes(langParam) ? langParam
    : (langCookie || dbLang || browserLang);
  const t = translations[lang] || translations.en;

  // Detect Crow OS mode (installed to ~/.crow/app)
  const isCrowOS = process.env.CROW_DATA_DIR || process.cwd().includes(".crow/app");

  // Try to read Crow ID
  let crowId = null;
  try {
    const { loadOrCreateIdentity } = await import("../../servers/sharing/identity.js");
    const identity = loadOrCreateIdentity();
    crowId = identity.crowId;
  } catch {
    // Identity not available
  }
  const connected = integrations.filter((i) => i.status === "connected");
  const errored = integrations.filter((i) => i.status === "error" && !i.requiresMissing);
  const notConfigured = integrations.filter((i) => !i.configured);
  const pending = integrations.filter(
    (i) => i.configured && i.status !== "connected" && i.status !== "error"
  );

  // Detect Tailscale and Caddy for access URL display
  const tailscale = detectTailscale();
  const hasCaddy = detectCaddy();
  const port = parseInt(process.env.PORT || process.env.CROW_GATEWAY_PORT || "3001", 10);
  const portSuffix = hasCaddy ? "" : (port === 80 ? "" : `:${port}`);

  const gatewayUrl = process.env.RENDER_EXTERNAL_URL || process.env.CROW_GATEWAY_URL || "";
  const isRender = !!process.env.RENDER_EXTERNAL_URL || !!process.env.RENDER_SERVICE_ID;
  const isHosted = !!process.env.CROW_HOSTED;
  const renderServiceId = process.env.RENDER_SERVICE_ID || "";
  const renderDashboardUrl = renderServiceId
    ? `https://dashboard.render.com/web/${renderServiceId}/env`
    : "https://dashboard.render.com";

  // Build category map from INTEGRATIONS registry
  const categoryMap = {};
  for (const integ of INTEGRATIONS) {
    categoryMap[integ.id] = integ.category || "development";
  }

  // Category labels for i18n
  const catLabels = {
    productivity: t.productivity,
    communication: t.communication,
    development: t.developmentSearch,
  };

  // --- Helper: collapsible section wrapper ---
  function sec(title, body, { open = false } = {}) {
    const collapsedClass = open ? "" : " sec-collapsed";
    return `
    <div class="section">
      <div class="section-header${collapsedClass}" onclick="toggleSection(this)">
        <div class="section-title" style="margin-bottom:0">${title}</div>
        <span class="sec-chevron">&#9656;</span>
      </div>
      <div class="section-body${collapsedClass}">
        ${body}
      </div>
    </div>`;
  }

  // --- Build Network Access section content ---
  function buildNetworkAccess() {
    // Hosted mode: show "Your Instance" card
    if (isHosted) {
      return `
    <div class="card" style="border-left: 3px solid #22c55e">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">${t.yourInstance}</div>
          <div class="card-desc">${t.instanceOnline}</div>
        </div>
      </div>
      <div class="card-env" style="line-height: 2">
        ${gatewayUrl ? `<strong>${t.dashboard}:</strong> <a href="${gatewayUrl}/dashboard" style="color:#6366f1;text-decoration:none">${gatewayUrl}/dashboard</a><br>` : ""}
        ${gatewayUrl ? `<strong>${t.blog}:</strong> <a href="${gatewayUrl}/blog" style="color:#6366f1;text-decoration:none">${gatewayUrl}/blog</a>` : ""}
      </div>
      <div style="margin-top:10px;font-size:13px;color:#86868b">${t.tailscaleGuideNote}</div>
    </div>`;
    }

    // Self-hosted: existing 4-state Tailscale logic

    // State 1: Tailscale connected, hostname is "crow" — ideal
    if (tailscale?.ip && tailscale.hostname === "crow") {
      return `
    <div class="card" style="border-left: 3px solid #22c55e">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">${t.readyAccess}</div>
          <div class="card-desc">${t.tsConnectedHostname} <strong>crow</strong></div>
        </div>
      </div>
      <div class="card-env" style="line-height: 2">
        <strong>${t.crowsNestLabel}</strong> <span class="env-var">http://crow${portSuffix}/dashboard</span><br>
        <strong>${t.blogLabel}</strong> <span class="env-var">http://crow${portSuffix}/blog</span><br>
        <strong>${t.tailscaleIpLabel}</strong> <span class="env-var">http://${tailscale.ip}${portSuffix}/dashboard</span>
      </div>
      ${hasCaddy ? `<div style="margin-top:8px;font-size:12px;color:#86868b">${t.caddyDetected}</div>` : ""}
    </div>
    <div style="margin-top:8px;font-size:13px;color:#86868b">${t.tailscaleAddonNote}</div>`;
    }

    // State 2: Tailscale connected, hostname is NOT "crow"
    if (tailscale?.ip && tailscale.hostname) {
      return `
    <div class="card" style="border-left: 3px solid #ff9f0a">
      <div class="card-header">
        <span class="status-dot yellow"></span>
        <div>
          <div class="card-name">${t.tsConnected}</div>
          <div class="card-desc">${t.hostnameIs} <strong>${tailscale.hostname}</strong> &mdash; ${t.considerChanging}</div>
        </div>
      </div>
      <div class="card-env" style="line-height: 2">
        <strong>${t.currentUrl}</strong> <span class="env-var">http://${tailscale.hostname}${portSuffix}/dashboard</span><br>
        <strong>${t.tailscaleIpLabel}</strong> <span class="env-var">http://${tailscale.ip}${portSuffix}/dashboard</span>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">${t.recommendHostname}</div>
        <p style="font-size:13px;color:#86868b;margin-bottom:8px">${t.hostnameExplanation}</p>
        <div class="connector-url">sudo tailscale set --hostname=crow</div>
        <p style="font-size:12px;color:#86868b;margin-top:8px">${t.hostnameAlternatives}</p>
      </div>
    </div>
    <div style="margin-top:8px;font-size:13px;color:#86868b">${t.tailscaleAddonNote}</div>`;
    }

    // State 3a: Tailscale installed but not connected/authenticated
    if (tailscale?.installed && !tailscale?.ip) {
      return `
    <div class="card" style="border-left: 3px solid #ff9f0a">
      <div class="card-header">
        <span class="status-dot yellow"></span>
        <div>
          <div class="card-name">${t.tsInstalled}</div>
          <div class="card-desc">${t.tsNotConnected}</div>
        </div>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0">
        <p style="font-size:13px;color:#86868b;margin-bottom:10px">${t.runCommands}</p>
        <div class="connector-url" style="margin-bottom:6px">sudo tailscale up</div>
        <p style="font-size:12px;color:#86868b;margin-bottom:10px">${t.followLogin}</p>
        <div class="connector-url">sudo tailscale set --hostname=crow</div>
        <p style="font-size:12px;color:#86868b;margin-top:10px">${t.afterThat}</p>
      </div>
    </div>
    <div style="margin-top:8px;font-size:13px;color:#86868b">${t.tailscaleAddonNote}</div>`;
    }

    // State 3b: Tailscale not installed
    return `
    <div class="card" style="border-left: 3px solid #86868b">
      <div class="card-header">
        <span class="status-dot gray"></span>
        <div>
          <div class="card-name">${t.setupRemoteAccess}</div>
          <div class="card-desc">${t.remoteAccessDesc}</div>
        </div>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0">
        <p style="font-size:13px;margin-bottom:12px">
          <a href="https://tailscale.com" target="_blank" style="color:#6366f1;text-decoration:none;font-weight:500">Tailscale</a>
          ${t.tsIntro}
        </p>
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">${t.step1Account}</div>
        <p style="font-size:13px;color:#86868b;margin-bottom:12px">${t.signUpAt}</p>
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">${t.step2Install}</div>
        <div class="connector-url" style="margin-bottom:4px">curl -fsSL https://tailscale.com/install.sh | sh</div>
        <div class="connector-url" style="margin-bottom:4px">sudo tailscale up</div>
        <p style="font-size:12px;color:#86868b;margin-bottom:12px">${t.followLoginTerminal}</p>
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">${t.step3Hostname}</div>
        <div class="connector-url" style="margin-bottom:4px">sudo tailscale set --hostname=crow</div>
        <p style="font-size:12px;color:#86868b;margin-bottom:12px">${t.hostnameAccessible}</p>
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">${t.step4Devices}</div>
        <p style="font-size:13px;color:#86868b;margin-bottom:4px">${t.installOtherDevices}</p>
        <p style="font-size:13px;margin-top:12px">${t.thenOpen}</p>
      </div>
    </div>
    <div style="margin-top:8px;font-size:13px;color:#86868b">${t.tailscaleAddonNote}</div>`;
  }

  // --- Build hosted integrations (grouped by category, collapsible) ---
  function buildHostedIntegrations() {
    return ["productivity", "communication", "development"].map(cat => {
      const items = notConfigured.filter(i => (categoryMap[i.id] || "development") === cat);
      if (items.length === 0) return "";
      const label = catLabels[cat];
      return `
        <div class="category-title" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none" onclick="toggleSection(this)">
          <span>${label}</span>
          <span class="sec-chevron sec-collapsed" style="font-size:14px;color:#86868b">&#9656;</span>
        </div>
        <div class="section-body sec-collapsed">
        ${items.map((i) => `
        <div class="card">
          <div class="card-header">
            <span class="status-dot gray"></span>
            <div>
              <div class="card-name">${i.name}</div>
              <div class="card-desc">${i.description}</div>
            </div>
          </div>
          <div class="card-env">
            ${isRender ? t.addInRender : t.envVariable}: ${i.envVars.map((v) => `<span class="env-var">${v}</span>`).join(" + ")}
            <br>
            ${i.keyUrl ? `<a href="${i.keyUrl}" target="_blank" class="key-link">${t.getApiKeyArrow}</a>` : ""}
            ${i.keyInstructions ? `<br><span style="color:#86868b;font-size:12px">${i.keyInstructions}</span>` : ""}
          </div>
        </div>`).join("")}
        </div>`;
    }).join("");
  }

  // --- Platform setup list with doc links ---
  const platforms = [
    { name: "Claude Web/Mobile", href: `${DOCS_BASE}/claude`, instr: t.claudeWebInstr },
    { name: "Claude Desktop", href: `${DOCS_BASE}/claude-desktop`, instr: t.claudeDesktopInstr },
    { name: "ChatGPT", href: `${DOCS_BASE}/chatgpt`, instr: t.chatgptInstr },
    { name: "Gemini CLI", href: `${DOCS_BASE}/gemini-cli`, instr: t.geminiInstr },
    { name: "Cursor", href: `${DOCS_BASE}/cursor`, instr: t.cursorInstr },
    { name: "Windsurf", href: `${DOCS_BASE}/windsurf`, instr: t.windsurfInstr },
    { name: "Cline", href: `${DOCS_BASE}/cline`, instr: t.clineInstr },
    { name: "Claude Code", href: `${DOCS_BASE}/claude-code`, instr: t.claudeCodeInstr },
  ];
  const platformListHtml = platforms.map(p =>
    `<li><a href="${p.href}" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none;font-weight:600">${p.name}</a> &mdash; ${p.instr}</li>`
  ).join("\n        ");

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
    .section-header {
      cursor: pointer; display: flex; align-items: center;
      justify-content: space-between; user-select: none; margin-bottom: 8px;
    }
    .section-header .sec-chevron { transition: transform 0.2s; font-size: 18px; color: #86868b; }
    .section-header.sec-collapsed .sec-chevron { transform: rotate(0deg); }
    .section-header:not(.sec-collapsed) .sec-chevron { transform: rotate(90deg); }
    .section-body.sec-collapsed { display: none; }
    .sec-chevron { transition: transform 0.2s; }
    .sec-collapsed > .sec-chevron { transform: rotate(0deg) !important; }
    .card {
      background: white; border-radius: 12px; padding: 16px;
      margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .card-header {
      display: flex; align-items: center; gap: 10px;
    }
    .status-dot {
      width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
    }
    .status-dot.green { background: #22c55e; }
    .status-dot.red { background: #ff3b30; }
    .status-dot.gray { background: #c7c7cc; }
    .status-dot.yellow { background: #ff9f0a; }
    .card-name { font-weight: 600; font-size: 16px; }
    .card-desc { color: #86868b; font-size: 13px; margin-top: 2px; }
    .card-tools { color: #22c55e; font-size: 13px; font-weight: 500; }
    .card-error { color: #ff3b30; font-size: 13px; margin-top: 4px; }
    .card-env {
      margin-top: 8px; padding-top: 8px; border-top: 1px solid #f0f0f0;
      font-size: 13px;
    }
    .env-var {
      font-family: 'SF Mono', Menlo, monospace; background: #f5f5f7;
      padding: 2px 6px; border-radius: 4px; font-size: 12px;
    }
    .key-link {
      display: inline-block; margin-top: 6px; color: #6366f1;
      text-decoration: none; font-size: 13px;
    }
    .key-link:hover { text-decoration: underline; }
    .instructions {
      background: white; border-radius: 12px; padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08); font-size: 14px;
    }
    .instructions ol { padding-left: 20px; }
    .instructions li { margin-bottom: 8px; }
    .render-link {
      display: inline-block; margin-top: 12px; padding: 10px 20px;
      background: #6366f1; color: white; border-radius: 8px;
      text-decoration: none; font-weight: 500; font-size: 14px;
    }
    .render-link:hover { background: #4f46e5; }
    .connector-url {
      background: #f5f5f7; padding: 10px 14px; border-radius: 8px;
      font-family: 'SF Mono', Menlo, monospace; font-size: 13px;
      word-break: break-all; margin-top: 8px;
    }
    .stats {
      display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap;
    }
    .stat {
      background: white; border-radius: 12px; padding: 14px 18px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08); flex: 1; min-width: 100px;
      text-align: center;
    }
    .stat-number { font-size: 28px; font-weight: 700; }
    .stat-label { font-size: 12px; color: #86868b; margin-top: 2px; }
    .stat-number.green { color: #22c55e; }
    .stat-number.gray { color: #86868b; }
    .integration-card .card-header { cursor: pointer; user-select: none; }
    .integration-card .chevron { margin-left: auto; transition: transform 0.2s; font-size: 18px; color: #86868b; }
    .integration-card .chevron.open { transform: rotate(90deg); }
    .card-body { padding: 12px 16px 16px; border-top: 1px solid #f0f0f0; }
    .field { margin-bottom: 12px; }
    .field label { display: block; font-size: 12px; font-weight: 600; color: #86868b; margin-bottom: 4px; font-family: 'SF Mono', Menlo, monospace; }
    .field input { width: 100%; padding: 8px 12px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 14px; }
    .card-links { font-size: 13px; margin-bottom: 12px; }
    .card-links a { color: #6366f1; text-decoration: none; }
    .card-links a:hover { text-decoration: underline; }
    .card-actions { display: flex; gap: 8px; }
    .card-actions button { padding: 8px 16px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
    .card-actions .btn-save { background: #6366f1; color: white; }
    .card-actions .btn-save:hover { background: #4f46e5; }
    .card-actions .btn-remove { background: #f5f5f7; color: #ff3b30; }
    .card-actions .btn-remove:hover { background: #fee; }
    .category-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; margin: 16px 0 8px; }
    .requires-note { color: #ff9f0a; font-size: 13px; padding: 8px 0; }
    #restart-banner { position: fixed; top: 0; left: 0; right: 0; background: #22c55e; color: white; padding: 12px; text-align: center; font-weight: 500; z-index: 1000; }
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
  <div id="restart-banner" style="display:none">
    ${t.keysSaved}
    <span id="restart-status">${t.waitingRestart}</span>
  </div>

  <div class="lang-toggle">
    <a href="?lang=en" class="lang-btn${lang === "en" ? " active" : ""}" onclick="setLang('en');return false;">EN</a>
    <a href="?lang=es" class="lang-btn${lang === "es" ? " active" : ""}" onclick="setLang('es');return false;">ES</a>
  </div>

  <div style="text-align:center;margin-bottom:8px"><div style="width:80px;height:80px;margin:0 auto">${CROW_HERO_SVG}</div></div>
  <h1>${t.title}</h1>
  <p class="subtitle">${t.subtitle}</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-number green">${connected.length}</div>
      <div class="stat-label">${t.connected}</div>
    </div>
    <div class="stat">
      <div class="stat-number gray">${notConfigured.length}</div>
      <div class="stat-label">${t.available}</div>
    </div>
  </div>

  ${(() => {
    const coreTools = 49;
    let externalTools = 0;
    for (const [, entry] of connectedServers) {
      if (entry.status === "connected") externalTools += entry.tools.length;
    }
    const totalTools = coreTools + externalTools;
    const estimatedTokens = totalTools * 200;
    const routerDisabled = process.env.CROW_DISABLE_ROUTER === "1";
    const showWarning = totalTools > 30;
    const body = `
    <div class="card" style="border-left: 3px solid ${showWarning ? "#ff9f0a" : "#22c55e"}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-name">${totalTools} ${t.toolsLoaded}</div>
          <div class="card-desc">${coreTools} ${t.core} + ${externalTools} ${t.external} &mdash; ~${(estimatedTokens / 1000).toFixed(1)}K ${t.tokensOfContext}</div>
        </div>
        ${!routerDisabled ? `<div style="font-size:12px;background:#e8f5e9;color:#2e7d32;padding:4px 10px;border-radius:6px">${t.routerAvailable}</div>` : ""}
      </div>
      ${showWarning ? `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid #f0f0f0;font-size:13px;color:#86868b">
        <strong style="color:#ff9f0a">${t.tip}</strong> ${t.routerTip}
      </div>` : ""}
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid #f0f0f0;font-size:13px;color:#86868b">${t.contextLearnMore}</div>
    </div>`;
    return sec(t.contextUsage, body);
  })()}

  ${(isCrowOS || isHosted) && !passwordConfigured ? (() => {
    // Setup token gating: if CROW_SETUP_TOKEN is set, require valid token in query string
    const setupToken = process.env.CROW_SETUP_TOKEN;
    const queryToken = req.query.token;
    if (setupToken && queryToken !== setupToken) {
      const body = `
    <div class="instructions">
      <p style="margin-bottom:12px;color:#ff3b30"><strong>${t.useInviteLink}</strong></p>
      <p style="color:#86868b">${t.setupTokenRequired}</p>
    </div>`;
      return sec(isCrowOS ? `Step 1: ${t.step1Password}` : t.step1Password, body, { open: true });
    }
    const body = `
    <div class="instructions">
      <p style="margin-bottom:12px">${t.protectPassword}</p>
      <form method="POST" action="/dashboard/login" style="display:flex;gap:8px;flex-wrap:wrap;align-items:start">
        ${setupToken ? `<input type="hidden" name="setup_token" value="${setupToken}">` : ""}
        <input type="password" name="password" placeholder="${t.choosePassword}" required minlength="12"
          style="flex:1;min-width:160px;padding:10px 14px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        <input type="password" name="confirm" placeholder="${t.confirmPassword}" required minlength="12"
          style="flex:1;min-width:160px;padding:10px 14px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        <button type="submit" style="padding:10px 20px;background:#6366f1;color:white;border:none;border-radius:8px;font-weight:500;font-size:14px;cursor:pointer">${t.setPassword}</button>
      </form>
    </div>`;
    return sec(isCrowOS ? `Step 1: ${t.step1Password}` : t.step1Password, body, { open: true });
  })() : ""}

  ${passwordConfigured ? (() => {
    const body = `
    <div class="card">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">${t.passwordConfigured}</div>
          <div class="card-desc">${t.nestProtected}</div>
        </div>
      </div>
    </div>`;
    return sec(isCrowOS ? `Step 1: ${t.crowsNest}` : t.crowsNest, body, { open: true });
  })() : ""}

  ${crowId ? (() => {
    const body = `
    <div class="card">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">${crowId}</div>
          <div class="card-desc">${t.crowIdDesc}</div>
        </div>
      </div>
    </div>`;
    return sec(isCrowOS ? `Step 2: ${t.step2Identity}` : t.identity, body);
  })() : ""}

  ${sec(isCrowOS ? `Step 3: ${t.step3Network}` : t.networkAccess, buildNetworkAccess())}

  ${connected.length > 0 ? sec(t.connectedSection, connected.map((i) => `
    <div class="card integration-card">
      <div class="card-header" onclick="toggleCard(this)">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">${i.name}</div>
          <div class="card-desc">${i.description}</div>
        </div>
        <span class="chevron">&#9656;</span>
      </div>
      <div class="card-body" style="display:none">
        <div class="card-tools" style="margin-bottom:12px">${i.toolCount} ${i.toolCount !== 1 ? t.toolsAvailable : t.toolAvailable}</div>
        ${!isRender && !isHosted ? `
        <div class="card-actions">
          <button class="btn-remove" onclick="removeIntegration('${i.id}')">${t.remove}</button>
        </div>` : ""}
      </div>
    </div>`).join("")) : ""}

  ${errored.length > 0 ? sec(t.errors, errored.map((i) => `
    <div class="card">
      <div class="card-header">
        <span class="status-dot red"></span>
        <div>
          <div class="card-name">${i.name}</div>
          <div class="card-desc">${i.description}</div>
        </div>
      </div>
      <div class="card-error">${i.error || t.failedToConnect}</div>
    </div>`).join("")) : ""}

  ${!isRender && !isHosted && notConfigured.length > 0 ? sec(t.availableIntegrations, ["productivity", "communication", "development"].map(cat => {
      const items = notConfigured.filter(i => (categoryMap[i.id] || "development") === cat);
      if (items.length === 0) return "";
      const label = catLabels[cat];
      return `
        <div class="category-title">${label}</div>
        ${items.map(i => `
        <div class="card integration-card">
          <div class="card-header" onclick="toggleCard(this)">
            <span class="status-dot ${i.requiresMissing ? 'yellow' : 'gray'}"></span>
            <div>
              <div class="card-name">${i.name}</div>
              <div class="card-desc">${i.description}</div>
            </div>
            <span class="chevron">&#9656;</span>
          </div>
          <div class="card-body" style="display:none">
            ${i.requiresMissing ? `
              <div class="requires-note">${t.requiresPython}</div>
            ` : i.envVars.length > 0 ? `
              <form class="integration-form">
                <input type="hidden" name="integration_id" value="${i.id}">
                <input type="hidden" name="action" value="save">
                ${i.envVars.map(v => `
                <div class="field">
                  <label>${v}</label>
                  <input type="password" name="${v}" placeholder="${v.toLowerCase().includes('url') || v.toLowerCase().includes('path') ? 'https://...' : '...'}" autocomplete="off">
                </div>`).join("")}
                <div class="card-links">
                  ${i.keyUrl ? `<a href="${i.keyUrl}" target="_blank">${t.getApiKey}</a>` : ""}
                  ${i.keyUrl && i.docsUrl ? ` <span style="color:#86868b">&middot;</span> ` : ""}
                  ${i.docsUrl ? `<a href="${i.docsUrl}" target="_blank">${t.setupGuide}</a>` : ""}
                </div>
                ${i.keyInstructions ? `<div style="color:#86868b;font-size:12px;margin-bottom:12px">${i.keyInstructions}</div>` : ""}
                <div class="card-actions">
                  <button type="submit" class="btn-save">${t.save}</button>
                </div>
              </form>
            ` : `
              <div style="color:#86868b;font-size:13px">${t.noConfigNeeded}</div>
            `}
          </div>
        </div>`).join("")}`;
    }).join("")) : ""}

  ${(isRender || isHosted) && notConfigured.length > 0 ? sec(t.availableAddKeys, buildHostedIntegrations()) : ""}

  ${isRender || isHosted ? sec(t.howToAdd, `
    <div class="instructions">
      ${isHosted ? `
      <ol>
        <li>${t.hostedStep1}</li>
        <li>${t.hostedStep2}</li>
        <li>${t.hostedStep3}</li>
        <li>${t.hostedStep4}</li>
        <li>${t.hostedStep5}</li>
      </ol>` : `
      <ol>
        <li>${t.renderStep1}</li>
        <li>${t.renderStep2}</li>
        <li>${t.renderStep3}</li>
        <li>${t.renderStep4}</li>
        <li>${t.renderStep5}</li>
      </ol>
      <a href="${renderDashboardUrl}" target="_blank" class="render-link">${t.openRenderDashboard}</a>`}
    </div>`) : ""}

  ${gatewayUrl ? sec(t.mcpEndpoints, `
    <div class="instructions">
      <p style="margin-bottom:8px">${t.mcpIntro}</p>

      ${process.env.CROW_DISABLE_ROUTER !== "1" ? `
      <p style="font-weight:600;font-size:15px;margin-top:16px">${t.routerRecommended}</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">${t.streamableHttp}</p>
      <div class="connector-url">${gatewayUrl}/router/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">${t.sseChatgpt}</p>
      <div class="connector-url">${gatewayUrl}/router/sse</div>
      ` : ""}

      <p style="font-weight:600;font-size:15px;margin-top:16px">${t.memory}</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">${t.streamableHttp}</p>
      <div class="connector-url">${gatewayUrl}/memory/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">${t.sseChatgpt}</p>
      <div class="connector-url">${gatewayUrl}/memory/sse</div>

      <p style="font-weight:600;font-size:15px;margin-top:16px">${t.research}</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">${t.streamableHttpShort}</p>
      <div class="connector-url">${gatewayUrl}/research/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">${t.sseChatgpt}</p>
      <div class="connector-url">${gatewayUrl}/research/sse</div>

      <p style="font-weight:600;font-size:15px;margin-top:16px">${t.externalTools}</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">${t.streamableHttpShort}</p>
      <div class="connector-url">${gatewayUrl}/tools/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">${t.sseChatgpt}</p>
      <div class="connector-url">${gatewayUrl}/tools/sse</div>

      <p style="font-weight:600;font-size:13px;margin-top:20px;margin-bottom:8px">${t.quickSetup}</p>
      <ul style="font-size:13px;padding-left:18px;list-style:disc">
        ${platformListHtml}
      </ul>
    </div>`, { open: true }) : ""}

<script>
function toggleSection(header) {
  header.classList.toggle('sec-collapsed');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('sec-collapsed');
}

function toggleCard(header) {
  var body = header.nextElementSibling;
  var chevron = header.querySelector('.chevron');
  if (body.style.display === 'none' || !body.style.display) {
    body.style.display = 'block';
    if (chevron) chevron.classList.add('open');
  } else {
    body.style.display = 'none';
    if (chevron) chevron.classList.remove('open');
  }
}

function setLang(l) {
  document.cookie = 'crow_lang=' + l + ';path=/;max-age=' + (30*24*60*60) + ';SameSite=Strict';
  var url = new URL(window.location);
  url.searchParams.set('lang', l);
  window.location = url.toString();
}

document.querySelectorAll('.integration-form').forEach(function(form) {
  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    var origText = btn.textContent;
    btn.textContent = 'Saving...';
    btn.disabled = true;
    try {
      var resp = await fetch('/setup/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      var data = await resp.json();
      if (data.ok) {
        if (data.restarting) {
          document.getElementById('restart-banner').style.display = 'block';
          pollHealth();
        } else {
          btn.textContent = '${t.savedRestart}';
          setTimeout(function() { btn.textContent = origText; btn.disabled = false; }, 3000);
        }
      } else {
        btn.textContent = data.error || '${t.error}';
        setTimeout(function() { btn.textContent = origText; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      btn.textContent = '${t.error}';
      setTimeout(function() { btn.textContent = origText; btn.disabled = false; }, 3000);
    }
  });
});

function removeIntegration(id) {
  if (!confirm('${t.removeConfirm}')) return;
  fetch('/setup/integrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ integration_id: id, action: 'remove' }),
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.ok && data.restarting) {
      document.getElementById('restart-banner').style.display = 'block';
      pollHealth();
    } else if (data.ok) {
      location.reload();
    }
  });
}

function pollHealth() {
  var status = document.getElementById('restart-status');
  var attempts = 0;
  var interval = setInterval(async function() {
    attempts++;
    try {
      var resp = await fetch('/health', { signal: AbortSignal.timeout(2000) });
      if (resp.ok) { clearInterval(interval); location.reload(); }
    } catch(e) {
      if (status) status.textContent = '${t.waitingRestart} (' + (attempts * 2) + 's)';
    }
    if (attempts > 30) {
      clearInterval(interval);
      if (status) status.textContent = '${t.gatewayManualRestart}';
    }
  }, 2000);
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
}

/**
 * Express handler for POST /setup/integrations
 * Requires dashboard authentication.
 * CSRF protection is provided by the SameSite=Strict cookie attribute
 * set on the session cookie (see dashboard/auth.js setSessionCookie()).
 */
export async function setupIntegrationsHandler(req, res) {
  // Key management is disabled on cloud/hosted deployments
  if (process.env.RENDER_EXTERNAL_URL || process.env.RENDER_SERVICE_ID || process.env.CROW_HOSTED) {
    return res.status(403).json({ error: "Key management is not available on hosted deployments. Use your platform's environment variable settings." });
  }

  // SameSite=Strict on the session cookie is the primary CSRF protection.
  // This check confirms the csrf cookie was set (defense-in-depth).
  const cookies = parseCookies(req);
  const csrfCookie = cookies.crow_csrf;
  if (!csrfCookie) {
    return res.status(403).json({ error: "Missing session context" });
  }

  const { integration_id, action } = req.body;

  // Validate integration exists
  const integration = INTEGRATIONS.find((i) => i.id === integration_id);
  if (!integration) {
    return res.status(400).json({ error: "Unknown integration" });
  }

  const envPath = resolveEnvPath();

  if (action === "remove") {
    for (const envVar of integration.envVars) {
      removeEnvVar(envPath, envVar);
    }
  } else {
    // Save — only accept whitelisted env var names
    for (const envVar of integration.envVars) {
      const value = req.body[envVar];
      if (value !== undefined && value !== "") {
        const sanitized = sanitizeEnvValue(value);
        writeEnvVar(envPath, envVar, sanitized);
      }
    }
  }

  // Regenerate .mcp.json
  try {
    execFileSync("node", ["scripts/generate-mcp-config.js"], {
      cwd: APP_ROOT,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch (e) {
    console.warn("[setup] Failed to regenerate .mcp.json:", e.message);
  }

  // Detect systemd
  const isSystemd = !!process.env.INVOCATION_ID;

  res.json({ ok: true, restarting: isSystemd });

  // If systemd, exit after response flushes
  if (isSystemd) {
    setTimeout(() => process.exit(0), 500);
  }
}
