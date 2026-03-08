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

import { getProxyStatus } from "./proxy.js";
import { isPasswordSet } from "./dashboard/auth.js";

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

  const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.CROW_GATEWAY_URL || "";
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
  <p class="subtitle">Integration status for your Crow AI Platform</p>

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

  ${isCrowOS && !passwordConfigured ? `
  <div class="section">
    <div class="section-title">Step 1: Set Dashboard Password</div>
    <div class="instructions">
      <p style="margin-bottom:12px">Protect your Crow dashboard with a password. This is required before you can access the dashboard.</p>
      <form method="POST" action="/dashboard/setup-password" style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="password" name="password" placeholder="Choose a password" required minlength="8"
          style="flex:1;min-width:200px;padding:10px 14px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        <button type="submit" style="padding:10px 20px;background:#007aff;color:white;border:none;border-radius:8px;font-weight:500;font-size:14px;cursor:pointer">Set Password</button>
      </form>
    </div>
  </div>` : ""}

  ${passwordConfigured ? `
  <div class="section">
    <div class="section-title">${isCrowOS ? "Step 1: Dashboard Password" : "Dashboard"}</div>
    <div class="card">
      <div class="card-header">
        <span class="status-dot green"></span>
        <div>
          <div class="card-name">Password configured</div>
          <div class="card-desc">Dashboard is protected</div>
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
        Add in Render: ${i.envVars.map((v) => `<span class="env-var">${v}</span>`).join(" + ")}
        <br>
        ${i.keyUrl ? `<a href="${i.keyUrl}" target="_blank" class="key-link">Get your API key &rarr;</a>` : ""}
        ${i.keyInstructions ? `<br><span style="color:#86868b;font-size:12px">${i.keyInstructions}</span>` : ""}
      </div>
    </div>`).join("")}
  </div>` : ""}

  <div class="section">
    <div class="section-title">How to Add an Integration</div>
    <div class="instructions">
      <ol>
        <li><strong>Get your API key</strong> from the service (click the "Get your API key" link above)</li>
        <li><strong>Go to your Render dashboard</strong> &rarr; your crow-gateway service &rarr; <strong>Environment</strong></li>
        <li><strong>Click "Add Environment Variable"</strong> &rarr; type the variable name exactly as shown above &rarr; paste your key &rarr; <strong>Save Changes</strong></li>
        <li>Render will <strong>automatically restart</strong> your service (~1 minute)</li>
        <li>Refresh this page to see the integration turn green</li>
      </ol>
      <a href="${renderDashboardUrl}" target="_blank" class="render-link">Open Render Dashboard</a>
    </div>
  </div>

  ${renderUrl ? `
  <div class="section">
    <div class="section-title">MCP Endpoint URLs</div>
    <div class="instructions">
      <p style="margin-bottom:8px">Use these URLs to connect from any MCP-compatible AI platform:</p>

      <p style="font-weight:600;font-size:15px;margin-top:16px">Memory</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">Streamable HTTP (Claude, Gemini, Grok, Cursor, Windsurf, Cline, Claude Code)</p>
      <div class="connector-url">${renderUrl}/memory/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">SSE (ChatGPT)</p>
      <div class="connector-url">${renderUrl}/memory/sse</div>

      <p style="font-weight:600;font-size:15px;margin-top:16px">Research</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">Streamable HTTP</p>
      <div class="connector-url">${renderUrl}/research/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">SSE (ChatGPT)</p>
      <div class="connector-url">${renderUrl}/research/sse</div>

      <p style="font-weight:600;font-size:15px;margin-top:16px">External Tools (GitHub, Slack, etc.)</p>
      <p style="font-size:12px;color:#86868b;margin-top:2px">Streamable HTTP</p>
      <div class="connector-url">${renderUrl}/tools/mcp</div>
      <p style="font-size:12px;color:#86868b;margin-top:8px">SSE (ChatGPT)</p>
      <div class="connector-url">${renderUrl}/tools/sse</div>

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
