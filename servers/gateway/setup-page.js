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
import { isPasswordSet } from "./dashboard/auth.js";

/**
 * Detect Tailscale hostname and IP if available.
 * Returns { hostname, ip } or null if Tailscale is not running.
 */
function detectTailscale() {
  try {
    const json = execFileSync("tailscale", ["status", "--json"], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const status = JSON.parse(json);
    const self = status.Self;
    if (!self) return null;

    const hostname = self.HostName || null;
    const ip = self.TailscaleIPs?.[0] || null;
    return { hostname, ip };
  } catch {
    return null;
  }
}

/**
 * Express handler for GET /setup
 */
export async function setupPageHandler(req, res) {
  const integrations = getProxyStatus();
  const passwordConfigured = await isPasswordSet().catch(() => false);

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
  const errored = integrations.filter((i) => i.status === "error");
  const notConfigured = integrations.filter((i) => !i.configured);
  const pending = integrations.filter(
    (i) => i.configured && i.status !== "connected" && i.status !== "error"
  );

  // Detect Tailscale for access URL display
  const tailscale = detectTailscale();

  const gatewayUrl = process.env.RENDER_EXTERNAL_URL || process.env.CROW_GATEWAY_URL || "";
  const isRender = !!process.env.RENDER_EXTERNAL_URL || !!process.env.RENDER_SERVICE_ID;
  const isHosted = !!process.env.CROW_HOSTED;
  const renderServiceId = process.env.RENDER_SERVICE_ID || "";
  const renderDashboardUrl = renderServiceId
    ? `https://dashboard.render.com/web/${renderServiceId}/env`
    : "https://dashboard.render.com";

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
    .status-dot.green { background: #34c759; }
    .status-dot.red { background: #ff3b30; }
    .status-dot.gray { background: #c7c7cc; }
    .status-dot.yellow { background: #ff9f0a; }
    .card-name { font-weight: 600; font-size: 16px; }
    .card-desc { color: #86868b; font-size: 13px; margin-top: 2px; }
    .card-tools { color: #34c759; font-size: 13px; font-weight: 500; }
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
      display: inline-block; margin-top: 6px; color: #007aff;
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
      background: #007aff; color: white; border-radius: 8px;
      text-decoration: none; font-weight: 500; font-size: 14px;
    }
    .render-link:hover { background: #0056b3; }
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
    .stat-number.green { color: #34c759; }
    .stat-number.gray { color: #86868b; }
  </style>
</head>
<body>
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
    <div class="card" style="border-left: 3px solid ${showWarning ? "#ff9f0a" : "#34c759"}">
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

  ${isCrowOS && !passwordConfigured ? `
  <div class="section">
    <div class="section-title">Step 1: Set Crow's Nest Password</div>
    <div class="instructions">
      <p style="margin-bottom:12px">Protect your Crow's Nest with a password. This is required before you can access the control panel.</p>
      <form method="POST" action="/dashboard/setup-password" style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="password" name="password" placeholder="Choose a password" required minlength="8"
          style="flex:1;min-width:200px;padding:10px 14px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        <button type="submit" style="padding:10px 20px;background:#007aff;color:white;border:none;border-radius:8px;font-weight:500;font-size:14px;cursor:pointer">Set Password</button>
      </form>
    </div>
  </div>` : ""}

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

  ${tailscale ? `
  <div class="section">
    <div class="section-title">${isCrowOS ? "Step 3: Network Access" : "Network Access"}</div>
    <div class="card">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">Tailscale Connected</div>
          <div class="card-desc">Access your Crow's Nest from any device on your Tailnet</div>
        </div>
      </div>
      <div class="card-env">
        ${tailscale.hostname ? `<strong>Crow's Nest:</strong> <span class="env-var">http://${tailscale.hostname}:3001/dashboard</span><br>` : ""}
        ${tailscale.ip ? `<strong>Tailscale IP:</strong> <span class="env-var">http://${tailscale.ip}:3001/dashboard</span><br>` : ""}
        ${tailscale.hostname ? `<strong>Blog:</strong> <span class="env-var">http://${tailscale.hostname}:3001/blog</span>` : ""}
      </div>
    </div>
  </div>` : ""}

  ${connected.length > 0 ? `
  <div class="section">
    <div class="section-title">Connected</div>
    ${connected.map((i) => `
    <div class="card">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">${i.name}</div>
          <div class="card-desc">${i.description}</div>
        </div>
      </div>
      <div class="card-tools">${i.toolCount} tool${i.toolCount !== 1 ? "s" : ""} available</div>
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

  ${notConfigured.length > 0 ? `
  <div class="section">
    <div class="section-title">Available — Add API Keys to Enable</div>
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

  <div class="section">
    <div class="section-title">How to Add an Integration</div>
    <div class="instructions">
      ${isHosted ? `
      <ol>
        <li><strong>Get your API key</strong> from the service (click the "Get your API key" link above)</li>
        <li>Go to your <strong>Crow's Nest</strong> &rarr; <strong>Settings</strong> panel</li>
        <li>Add the environment variable name and your API key</li>
        <li>Your instance will restart automatically (~10 seconds)</li>
        <li>Refresh this page to see the integration turn green</li>
      </ol>` : isRender ? `
      <ol>
        <li><strong>Get your API key</strong> from the service (click the "Get your API key" link above)</li>
        <li><strong>Go to your Render dashboard</strong> &rarr; your crow-gateway service &rarr; <strong>Environment</strong></li>
        <li><strong>Click "Add Environment Variable"</strong> &rarr; type the variable name exactly as shown above &rarr; paste your key &rarr; <strong>Save Changes</strong></li>
        <li>Render will <strong>automatically restart</strong> your service (~1 minute)</li>
        <li>Refresh this page to see the integration turn green</li>
      </ol>
      <a href="${renderDashboardUrl}" target="_blank" class="render-link">Open Render Dashboard</a>` : `
      <ol>
        <li><strong>Get your API key</strong> from the service (click the "Get your API key" link above)</li>
        <li>Add the environment variable to your <code>.env</code> file or hosting environment</li>
        <li>Restart the Crow gateway</li>
        <li>Refresh this page to see the integration turn green</li>
      </ol>`}
    </div>
  </div>

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

</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
}
