/**
 * Setup Status Page — Shows which integrations are connected.
 *
 * Serves a mobile-friendly HTML page at GET /setup with:
 * - Connected integrations (green) with tool counts
 * - Missing integrations (gray) with links to get API keys
 * - Instructions for adding env vars in Render
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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crow Setup</title>
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
  </style>
</head>
<body>
  <div id="restart-banner" style="display:none">
    Keys saved! Restarting gateway...
    <span id="restart-status">Waiting for restart...</span>
  </div>
  <div style="text-align:center;margin-bottom:8px"><div style="width:80px;height:80px;margin:0 auto">${CROW_HERO_SVG}</div></div>
  <h1>Crow Setup</h1>
  <p class="subtitle">Integration status for your Crow instance</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-number green">${connected.length}</div>
      <div class="stat-label">Connected</div>
    </div>
    <div class="stat">
      <div class="stat-number gray">${notConfigured.length}</div>
      <div class="stat-label">Available</div>
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
    return `
  <div class="section">
    <div class="section-title">Context Usage</div>
    <div class="card" style="border-left: 3px solid ${showWarning ? "#ff9f0a" : "#22c55e"}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-name">${totalTools} tools loaded</div>
          <div class="card-desc">${coreTools} core + ${externalTools} external &mdash; ~${(estimatedTokens / 1000).toFixed(1)}K tokens of context</div>
        </div>
        ${!routerDisabled ? `<div style="font-size:12px;background:#e8f5e9;color:#2e7d32;padding:4px 10px;border-radius:6px">Router available</div>` : ""}
      </div>
      ${showWarning ? `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid #f0f0f0;font-size:13px;color:#86868b">
        <strong style="color:#ff9f0a">Tip:</strong> With ${totalTools} tools, consider using the <strong>Router endpoint</strong>
        (<code>/router/mcp</code>) to reduce context usage to just 7 tools (~2.5K tokens).
      </div>` : ""}
    </div>
  </div>`;
  })()}

  ${isCrowOS && !passwordConfigured ? (() => {
    // Setup token gating: if CROW_SETUP_TOKEN is set, require valid token in query string
    const setupToken = process.env.CROW_SETUP_TOKEN;
    const queryToken = req.query.token;
    if (setupToken && queryToken !== setupToken) {
      return `
  <div class="section">
    <div class="section-title">Step 1: Set Crow's Nest Password</div>
    <div class="instructions">
      <p style="margin-bottom:12px;color:#ff3b30"><strong>Use the link you were sent.</strong></p>
      <p style="color:#86868b">This instance requires a setup token. Check your invite email for the correct link.</p>
    </div>
  </div>`;
    }
    return `
  <div class="section">
    <div class="section-title">Step 1: Set Crow's Nest Password</div>
    <div class="instructions">
      <p style="margin-bottom:12px">Protect your Crow's Nest with a password. This is required before you can access the control panel.</p>
      <form method="POST" action="/dashboard/login" style="display:flex;gap:8px;flex-wrap:wrap;align-items:start">
        ${setupToken ? `<input type="hidden" name="setup_token" value="${setupToken}">` : ""}
        <input type="password" name="password" placeholder="Choose a password (12+ characters)" required minlength="12"
          style="flex:1;min-width:160px;padding:10px 14px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        <input type="password" name="confirm" placeholder="Confirm password" required minlength="12"
          style="flex:1;min-width:160px;padding:10px 14px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        <button type="submit" style="padding:10px 20px;background:#6366f1;color:white;border:none;border-radius:8px;font-weight:500;font-size:14px;cursor:pointer">Set Password</button>
      </form>
    </div>
  </div>`;
  })() : ""}

  ${passwordConfigured ? `
  <div class="section">
    <div class="section-title">${isCrowOS ? "Step 1: Crow's Nest Password" : "Crow's Nest"}</div>
    <div class="card">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">Password configured</div>
          <div class="card-desc">Crow's Nest is protected</div>
        </div>
      </div>
    </div>
  </div>` : ""}

  ${crowId ? `
  <div class="section">
    <div class="section-title">${isCrowOS ? "Step 2: Your Identity" : "Identity"}</div>
    <div class="card">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">${crowId}</div>
          <div class="card-desc">Your Crow ID — share this with peers to connect</div>
        </div>
      </div>
    </div>
  </div>` : ""}

  <div class="section">
    <div class="section-title">${isCrowOS ? "Step 3: Network Access" : "Network Access"}</div>
    ${(() => {
      // State 1: Tailscale connected, hostname is "crow" — ideal
      if (tailscale?.ip && tailscale.hostname === "crow") {
        return `
    <div class="card" style="border-left: 3px solid #22c55e">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">Ready &mdash; access Crow from any device</div>
          <div class="card-desc">Tailscale is connected with hostname <strong>crow</strong></div>
        </div>
      </div>
      <div class="card-env" style="line-height: 2">
        <strong>Crow's Nest:</strong> <span class="env-var">http://crow${portSuffix}/dashboard</span><br>
        <strong>Blog:</strong> <span class="env-var">http://crow${portSuffix}/blog</span><br>
        <strong>Tailscale IP:</strong> <span class="env-var">http://${tailscale.ip}${portSuffix}/dashboard</span>
      </div>
      ${hasCaddy ? `<div style="margin-top:8px;font-size:12px;color:#86868b">Caddy reverse proxy detected &mdash; port-free URLs available</div>` : ""}
    </div>`;
      }

      // State 2: Tailscale connected, hostname is NOT "crow"
      if (tailscale?.ip && tailscale.hostname) {
        return `
    <div class="card" style="border-left: 3px solid #ff9f0a">
      <div class="card-header">
        <span class="status-dot yellow"></span>
        <div>
          <div class="card-name">Tailscale Connected</div>
          <div class="card-desc">Hostname is <strong>${tailscale.hostname}</strong> &mdash; consider changing to <strong>crow</strong> for easier access</div>
        </div>
      </div>
      <div class="card-env" style="line-height: 2">
        <strong>Current URL:</strong> <span class="env-var">http://${tailscale.hostname}${portSuffix}/dashboard</span><br>
        <strong>Tailscale IP:</strong> <span class="env-var">http://${tailscale.ip}${portSuffix}/dashboard</span>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">Recommended: Set hostname to &ldquo;crow&rdquo;</div>
        <p style="font-size:13px;color:#86868b;margin-bottom:8px">
          This lets you access Crow at <strong>http://crow/</strong> from any device on your Tailnet &mdash; phone, laptop, or tablet.
        </p>
        <div class="connector-url">sudo tailscale set --hostname=crow</div>
        <p style="font-size:12px;color:#86868b;margin-top:8px">
          If &ldquo;crow&rdquo; is already taken on your Tailnet, try <code>crow-2</code> or <code>crow-home</code>.
        </p>
      </div>
    </div>`;
      }

      // State 3a: Tailscale installed but not connected/authenticated
      if (tailscale?.installed && !tailscale?.ip) {
        return `
    <div class="card" style="border-left: 3px solid #ff9f0a">
      <div class="card-header">
        <span class="status-dot yellow"></span>
        <div>
          <div class="card-name">Tailscale Installed</div>
          <div class="card-desc">Not connected &mdash; authenticate to enable remote access</div>
        </div>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0">
        <p style="font-size:13px;color:#86868b;margin-bottom:10px">Run these commands on your server to connect:</p>
        <div class="connector-url" style="margin-bottom:6px">sudo tailscale up</div>
        <p style="font-size:12px;color:#86868b;margin-bottom:10px">Follow the login URL to authorize this device. Then set the hostname:</p>
        <div class="connector-url">sudo tailscale set --hostname=crow</div>
        <p style="font-size:12px;color:#86868b;margin-top:10px">
          After that, open <strong>http://crow/dashboard</strong> from any device on your Tailnet.
        </p>
      </div>
    </div>`;
      }

      // State 3b: Tailscale not installed
      return `
    <div class="card" style="border-left: 3px solid #86868b">
      <div class="card-header">
        <span class="status-dot gray"></span>
        <div>
          <div class="card-name">Set Up Remote Access</div>
          <div class="card-desc">Access Crow from your phone, laptop, or anywhere &mdash; securely and privately</div>
        </div>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0">
        <p style="font-size:13px;margin-bottom:12px">
          <a href="https://tailscale.com" target="_blank" style="color:#6366f1;text-decoration:none;font-weight:500">Tailscale</a>
          creates a private network between your devices. Once set up, you can reach Crow at
          <strong>http://crow/</strong> from any device &mdash; no port forwarding, no public exposure.
        </p>

        <div style="font-size:14px;font-weight:600;margin-bottom:8px">1. Create a free account</div>
        <p style="font-size:13px;color:#86868b;margin-bottom:12px">
          Sign up at <a href="https://tailscale.com" target="_blank" style="color:#6366f1;text-decoration:none">tailscale.com</a> (free for up to 100 devices).
        </p>

        <div style="font-size:14px;font-weight:600;margin-bottom:8px">2. Install on this server</div>
        <div class="connector-url" style="margin-bottom:4px">curl -fsSL https://tailscale.com/install.sh | sh</div>
        <div class="connector-url" style="margin-bottom:4px">sudo tailscale up</div>
        <p style="font-size:12px;color:#86868b;margin-bottom:12px">Follow the login URL printed in the terminal.</p>

        <div style="font-size:14px;font-weight:600;margin-bottom:8px">3. Set your hostname</div>
        <div class="connector-url" style="margin-bottom:4px">sudo tailscale set --hostname=crow</div>
        <p style="font-size:12px;color:#86868b;margin-bottom:12px">This makes Crow accessible at <strong>http://crow/</strong> on your Tailnet.</p>

        <div style="font-size:14px;font-weight:600;margin-bottom:8px">4. Install on your other devices</div>
        <p style="font-size:13px;color:#86868b;margin-bottom:4px">
          Install Tailscale on your phone, laptop, or tablet from
          <a href="https://tailscale.com/download" target="_blank" style="color:#6366f1;text-decoration:none">tailscale.com/download</a>
          and sign in with the same account.
        </p>
        <p style="font-size:13px;margin-top:12px">
          Then open <strong>http://crow/dashboard</strong> in any browser.
        </p>
      </div>
    </div>`;
    })()}
  </div>

  ${connected.length > 0 ? `
  <div class="section">
    <div class="section-title">Connected</div>
    ${connected.map((i) => `
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
        <div class="card-tools" style="margin-bottom:12px">${i.toolCount} tool${i.toolCount !== 1 ? "s" : ""} available</div>
        ${!isRender && !isHosted ? `
        <div class="card-actions">
          <button class="btn-remove" onclick="removeIntegration('${i.id}')">Remove</button>
        </div>` : ""}
      </div>
    </div>`).join("")}
  </div>` : ""}

  ${errored.length > 0 ? `
  <div class="section">
    <div class="section-title">Errors</div>
    ${errored.map((i) => `
    <div class="card">
      <div class="card-header">
        <span class="status-dot red"></span>
        <div>
          <div class="card-name">${i.name}</div>
          <div class="card-desc">${i.description}</div>
        </div>
      </div>
      <div class="card-error">${i.error || "Failed to connect"}</div>
    </div>`).join("")}
  </div>` : ""}

  ${!isRender && !isHosted && notConfigured.length > 0 ? `
  <div class="section">
    <div class="section-title">Available Integrations</div>
    ${["productivity", "communication", "development"].map(cat => {
      const items = notConfigured.filter(i => (categoryMap[i.id] || "development") === cat);
      if (items.length === 0) return "";
      const label = { productivity: "Productivity", communication: "Communication", development: "Development & Search" }[cat];
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
              <div class="requires-note">Requires Python (uvx) &mdash; install Python to enable this integration</div>
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
                  ${i.keyUrl ? `<a href="${i.keyUrl}" target="_blank">Get your API key</a>` : ""}
                  ${i.keyUrl && i.docsUrl ? ` <span style="color:#86868b">&middot;</span> ` : ""}
                  ${i.docsUrl ? `<a href="${i.docsUrl}" target="_blank">Setup guide</a>` : ""}
                </div>
                ${i.keyInstructions ? `<div style="color:#86868b;font-size:12px;margin-bottom:12px">${i.keyInstructions}</div>` : ""}
                <div class="card-actions">
                  <button type="submit" class="btn-save">Save</button>
                </div>
              </form>
            ` : `
              <div style="color:#86868b;font-size:13px">No configuration needed &mdash; works out of the box.</div>
            `}
          </div>
        </div>`).join("")}`;
    }).join("")}
  </div>` : ""}

  ${(isRender || isHosted) && notConfigured.length > 0 ? `
  <div class="section">
    <div class="section-title">Available &mdash; Add API Keys to Enable</div>
    ${notConfigured.map((i) => `
    <div class="card">
      <div class="card-header">
        <span class="status-dot gray"></span>
        <div>
          <div class="card-name">${i.name}</div>
          <div class="card-desc">${i.description}</div>
        </div>
      </div>
      <div class="card-env">
        ${isRender ? "Add in Render" : "Environment variable"}: ${i.envVars.map((v) => `<span class="env-var">${v}</span>`).join(" + ")}
        <br>
        ${i.keyUrl ? `<a href="${i.keyUrl}" target="_blank" class="key-link">Get your API key &rarr;</a>` : ""}
        ${i.keyInstructions ? `<br><span style="color:#86868b;font-size:12px">${i.keyInstructions}</span>` : ""}
      </div>
    </div>`).join("")}
  </div>` : ""}

  ${isRender || isHosted ? `
  <div class="section">
    <div class="section-title">How to Add an Integration</div>
    <div class="instructions">
      ${isHosted ? `
      <ol>
        <li><strong>Get your API key</strong> from the service</li>
        <li>Go to your <strong>Crow's Nest</strong> &rarr; <strong>Settings</strong> panel</li>
        <li>Add the environment variable name and your API key</li>
        <li>Your instance will restart automatically (~10 seconds)</li>
        <li>Refresh this page to see the integration turn green</li>
      </ol>` : `
      <ol>
        <li><strong>Get your API key</strong> from the service</li>
        <li><strong>Go to your Render dashboard</strong> &rarr; your crow-gateway service &rarr; <strong>Environment</strong></li>
        <li><strong>Click "Add Environment Variable"</strong> &rarr; type the variable name &rarr; paste your key &rarr; <strong>Save Changes</strong></li>
        <li>Render will <strong>automatically restart</strong> your service (~1 minute)</li>
        <li>Refresh this page to see the integration turn green</li>
      </ol>
      <a href="${renderDashboardUrl}" target="_blank" class="render-link">Open Render Dashboard</a>`}
    </div>
  </div>` : ""}

  ${gatewayUrl ? `
  <div class="section">
    <div class="section-title">MCP Endpoint URLs</div>
    <div class="instructions">
      <p style="margin-bottom:8px">Use these URLs to connect from any MCP-compatible AI platform:</p>

      ${process.env.CROW_DISABLE_ROUTER !== "1" ? `
      <p style="font-weight:600;font-size:15px;margin-top:16px">Router (Recommended &mdash; 7 tools instead of 49+)</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">Streamable HTTP (Claude, Gemini, Grok, Cursor, Windsurf, Cline, Claude Code)</p>
      <div class="connector-url">${gatewayUrl}/router/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">SSE (ChatGPT)</p>
      <div class="connector-url">${gatewayUrl}/router/sse</div>
      ` : ""}

      <p style="font-weight:600;font-size:15px;margin-top:16px">Memory</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">Streamable HTTP (Claude, Gemini, Grok, Cursor, Windsurf, Cline, Claude Code)</p>
      <div class="connector-url">${gatewayUrl}/memory/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">SSE (ChatGPT)</p>
      <div class="connector-url">${gatewayUrl}/memory/sse</div>

      <p style="font-weight:600;font-size:15px;margin-top:16px">Research</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">Streamable HTTP</p>
      <div class="connector-url">${gatewayUrl}/research/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">SSE (ChatGPT)</p>
      <div class="connector-url">${gatewayUrl}/research/sse</div>

      <p style="font-weight:600;font-size:15px;margin-top:16px">External Tools (GitHub, Slack, etc.)</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">Streamable HTTP</p>
      <div class="connector-url">${gatewayUrl}/tools/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">SSE (ChatGPT)</p>
      <div class="connector-url">${gatewayUrl}/tools/sse</div>

      <p style="font-weight:600;font-size:13px;margin-top:20px;margin-bottom:8px">Quick Setup by Platform:</p>
      <ul style="font-size:13px;padding-left:18px;list-style:disc">
        <li><strong>Claude Web/Mobile</strong> — Settings &rarr; Integrations &rarr; Add Custom &rarr; paste <code>/mcp</code> URL</li>
        <li><strong>Claude Desktop</strong> — Use stdio transport (see docs)</li>
        <li><strong>ChatGPT</strong> — Settings &rarr; Apps &rarr; Create &rarr; paste <code>/sse</code> URL</li>
        <li><strong>Gemini CLI</strong> — Add to <code>~/.gemini/settings.json</code> with <code>url</code> property</li>
        <li><strong>Cursor</strong> — Add to <code>.cursor/mcp.json</code> with <code>url</code> property</li>
        <li><strong>Windsurf</strong> — Add to <code>~/.codeium/windsurf/mcp_config.json</code></li>
        <li><strong>Cline</strong> — VS Code MCP settings &rarr; add server URL</li>
        <li><strong>Claude Code</strong> — Add to <code>.mcp.json</code> or <code>~/.claude/mcp.json</code></li>
      </ul>
    </div>
  </div>` : ""}

<script>
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
          btn.textContent = 'Saved! Restart gateway to apply.';
          setTimeout(function() { btn.textContent = origText; btn.disabled = false; }, 3000);
        }
      } else {
        btn.textContent = data.error || 'Error';
        setTimeout(function() { btn.textContent = origText; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      btn.textContent = 'Error';
      setTimeout(function() { btn.textContent = origText; btn.disabled = false; }, 3000);
    }
  });
});

function removeIntegration(id) {
  if (!confirm('Remove this integration\\'s API keys?')) return;
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
      if (status) status.textContent = 'Waiting for restart... (' + (attempts * 2) + 's)';
    }
    if (attempts > 30) {
      clearInterval(interval);
      if (status) status.textContent = 'Gateway may need manual restart.';
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
