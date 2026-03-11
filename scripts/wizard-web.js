#!/usr/bin/env node

/**
 * Crow — Web-Based Setup Wizard
 *
 * Launches a local web server with a friendly UI for configuring
 * integrations. No terminal prompts — everything happens in the browser.
 *
 * Usage: node scripts/wizard-web.js
 *        npm run wizard
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(ROOT, ".env");
const PORT = 3456;

// ── Env file helpers ─────────────────────────────────────────────

function loadEnv() {
  const env = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const val = t.slice(eq + 1).trim();
      if (val) env[t.slice(0, eq).trim()] = val;
    }
  }
  return env;
}

function saveEnv(env) {
  const lines = [
    "# Crow - Environment Variables",
    "# Saved by setup wizard",
    "",
    `CROW_DB_PATH=${env.CROW_DB_PATH || "./data/crow.db"}`,
    `CROW_FILES_PATH=${env.CROW_FILES_PATH || "/home"}`,
    "",
  ];
  for (const [key, val] of Object.entries(env)) {
    if (key === "CROW_DB_PATH" || key === "CROW_FILES_PATH") continue;
    lines.push(`${key}=${val}`);
  }
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
}

// ── HTML UI ──────────────────────────────────────────────────────

function buildHTML(env) {
  const integrations = [
    {
      id: "google", name: "Google Workspace",
      desc: "Gmail, Calendar, Docs, Sheets, Slides, and Google Chat",
      icon: "mail",
      oauth: true,
      note: "Google uses OAuth — you'll sign in with your Google account the first time you use it. No key needed here unless you want to set up your own OAuth app.",
      keys: [
        { key: "GOOGLE_CLIENT_ID", label: "OAuth Client ID", optional: true },
        { key: "GOOGLE_CLIENT_SECRET", label: "OAuth Client Secret", optional: true },
      ],
      steps: [
        "Google Workspace uses <strong>OAuth sign-in</strong> — it will prompt you to log in with Google the first time.",
        "If you want your own OAuth app: go to <a href='https://console.cloud.google.com/apis/credentials' target='_blank'>Google Cloud Console</a>",
        "Create a project → Enable Gmail, Calendar, Sheets, Docs, Slides APIs → Create OAuth 2.0 credentials",
        "Copy the Client ID and Client Secret below (optional — works without them too)",
      ],
    },
    {
      id: "notion", name: "Notion",
      desc: "Wiki pages, databases, and knowledge base",
      icon: "book",
      keys: [{ key: "NOTION_TOKEN", label: "Integration Token" }],
      steps: [
        'Go to <a href="https://www.notion.so/my-integrations" target="_blank">notion.so/my-integrations</a>',
        'Click <strong>"+ New integration"</strong>',
        "Give it a name (e.g., \"Crow Memory\") and select your workspace",
        'Click <strong>"Submit"</strong> → copy the <strong>Internal Integration Secret</strong>',
        "Paste it below",
        '<em>Important:</em> Open any Notion page you want Crow to access → click <strong>"..."</strong> → <strong>"Connect to"</strong> → select your integration',
      ],
    },
    {
      id: "slack", name: "Slack",
      desc: "Team messaging, channels, and conversations",
      icon: "message-circle",
      keys: [{ key: "SLACK_BOT_TOKEN", label: "Bot Token (xoxb-...)" }],
      steps: [
        'Go to <a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a>',
        'Click <strong>"Create New App"</strong> → <strong>"From scratch"</strong>',
        "Name it (e.g., \"Crow Memory\") and pick your workspace",
        'Go to <strong>"OAuth & Permissions"</strong> in the sidebar',
        'Under <strong>"Bot Token Scopes"</strong>, add: <code>channels:history</code>, <code>channels:read</code>, <code>chat:write</code>, <code>users:read</code>',
        'Click <strong>"Install to Workspace"</strong> at the top → <strong>"Allow"</strong>',
        'Copy the <strong>"Bot User OAuth Token"</strong> (starts with <code>xoxb-</code>)',
        "Paste it below",
      ],
    },
    {
      id: "discord", name: "Discord",
      desc: "Community servers, channels, and messages",
      icon: "message-square",
      keys: [{ key: "DISCORD_BOT_TOKEN", label: "Bot Token" }],
      steps: [
        'Go to <a href="https://discord.com/developers/applications" target="_blank">discord.com/developers/applications</a>',
        'Click <strong>"New Application"</strong> → name it → <strong>"Create"</strong>',
        'Go to <strong>"Bot"</strong> in the sidebar → click <strong>"Reset Token"</strong> → copy the token',
        'Enable <strong>"Message Content Intent"</strong> under Privileged Gateway Intents',
        'Go to <strong>"OAuth2" → "URL Generator"</strong> → check <code>bot</code> scope → check <code>Read Messages</code>, <code>Send Messages</code>',
        "Copy the generated URL → open it in your browser → add bot to your server",
        "Paste the bot token below",
      ],
    },
    {
      id: "github", name: "GitHub",
      desc: "Repositories, issues, pull requests, and code",
      icon: "git-branch",
      keys: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "Personal Access Token" }],
      steps: [
        'Go to <a href="https://github.com/settings/tokens?type=beta" target="_blank">github.com/settings/tokens</a>',
        'Click <strong>"Generate new token"</strong> (Fine-grained recommended)',
        "Give it a name (e.g., \"Crow Memory\") and set expiration",
        "Select which repositories to grant access to",
        'Under permissions, enable: <code>Issues</code> (Read/Write), <code>Pull requests</code> (Read/Write), <code>Contents</code> (Read)',
        'Click <strong>"Generate token"</strong> → copy it immediately',
        "Paste it below",
      ],
    },
    {
      id: "trello", name: "Trello",
      desc: "Project boards, lists, and cards",
      icon: "layout",
      keys: [
        { key: "TRELLO_API_KEY", label: "API Key" },
        { key: "TRELLO_TOKEN", label: "Token" },
      ],
      steps: [
        'Go to <a href="https://trello.com/power-ups/admin" target="_blank">trello.com/power-ups/admin</a>',
        "Click on your Power-Up (or create one) → copy the <strong>API Key</strong>",
        'Then click the <strong>"Token"</strong> link on that page to authorize → click <strong>"Allow"</strong>',
        "Copy the token that appears",
        "Paste both below",
      ],
    },
    {
      id: "brave", name: "Brave Search",
      desc: "Web search for research and fact-checking",
      icon: "search",
      keys: [{ key: "BRAVE_API_KEY", label: "API Key" }],
      steps: [
        'Go to <a href="https://brave.com/search/api/" target="_blank">brave.com/search/api</a>',
        'Click <strong>"Get Started"</strong> and create a free account',
        "The free plan gives you 2,000 searches/month",
        "Copy your API key from the dashboard",
        "Paste it below",
      ],
    },
    {
      id: "canvas", name: "Canvas LMS",
      desc: "Courses, assignments, and grades",
      icon: "graduation-cap",
      keys: [
        { key: "CANVAS_API_TOKEN", label: "Access Token" },
        { key: "CANVAS_BASE_URL", label: "Canvas URL (e.g., https://school.instructure.com)" },
      ],
      steps: [
        "Log into your Canvas account",
        'Go to <strong>Account</strong> (left sidebar) → <strong>Settings</strong>',
        'Scroll to <strong>"Approved Integrations"</strong> → click <strong>"+ New Access Token"</strong>',
        "Give it a purpose (e.g., \"Crow Memory\") → Generate Token",
        "Copy the token immediately (you won't see it again!)",
        "Paste both the token and your Canvas URL below",
      ],
    },
    {
      id: "zotero", name: "Zotero",
      desc: "Citation and reference management",
      icon: "bookmark",
      keys: [
        { key: "ZOTERO_API_KEY", label: "API Key" },
        { key: "ZOTERO_USER_ID", label: "User ID" },
      ],
      steps: [
        'Go to <a href="https://www.zotero.org/settings/keys" target="_blank">zotero.org/settings/keys</a>',
        "Your <strong>User ID</strong> is shown at the top of the page — copy it",
        'Click <strong>"Create new private key"</strong>',
        "Give it a name and grant library access",
        "Copy the API key",
        "Paste both below",
      ],
    },
    {
      id: "teams", name: "Microsoft Teams",
      desc: "Teams chats and channels (experimental)",
      icon: "users",
      advanced: true,
      keys: [
        { key: "TEAMS_CLIENT_ID", label: "App Client ID" },
        { key: "TEAMS_CLIENT_SECRET", label: "App Client Secret" },
        { key: "TEAMS_TENANT_ID", label: "Tenant ID" },
      ],
      steps: [
        '<em>Note: This requires Azure admin access and is more complex. Skip if unsure.</em>',
        'Go to <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps" target="_blank">Azure Portal → App Registrations</a>',
        'Click <strong>"+ New registration"</strong> → name it → Register',
        'Copy the <strong>Application (client) ID</strong> and <strong>Directory (tenant) ID</strong>',
        'Go to <strong>"Certificates & secrets"</strong> → <strong>"+ New client secret"</strong> → copy the value',
        'Go to <strong>"API permissions"</strong> → Add: <code>Chat.Read</code>, <code>ChannelMessage.Read.All</code>, <code>ChannelMessage.Send</code>',
        'Click <strong>"Grant admin consent"</strong>',
        "Paste all three values below",
      ],
    },
  ];

  const cards = integrations.map((integ) => {
    const isConfigured = integ.keys.every((k) => !k.optional && env[k.key]) ||
                         (integ.oauth && true);
    const badge = isConfigured && !integ.oauth
      ? '<span class="badge configured">Configured</span>'
      : integ.oauth
        ? '<span class="badge oauth">Auto sign-in</span>'
        : integ.advanced
          ? '<span class="badge advanced">Advanced</span>'
          : "";

    const keyInputs = integ.keys
      .map((k) => {
        const val = env[k.key] || "";
        const masked = val ? val.slice(0, 6) + "•".repeat(Math.max(0, val.length - 10)) + val.slice(-4) : "";
        return `
          <div class="key-field">
            <label for="${k.key}">${k.label}${k.optional ? " (optional)" : ""}</label>
            <div class="input-row">
              <input type="password" id="${k.key}" name="${k.key}" value="${val}"
                     placeholder="${k.optional ? "Optional — auto sign-in works without this" : "Paste your key here"}"
                     autocomplete="off" spellcheck="false">
              <button type="button" class="toggle-btn" onclick="toggleVisibility('${k.key}')">Show</button>
            </div>
            ${val ? `<small class="current-val">Current: ${masked}</small>` : ""}
          </div>`;
      })
      .join("");

    const stepsList = integ.steps
      .map((s, i) => `<li>${s}</li>`)
      .join("");

    return `
      <div class="card ${integ.advanced ? "advanced-card" : ""}" id="card-${integ.id}">
        <div class="card-header" onclick="toggleCard('${integ.id}')">
          <div class="card-title">
            <h3>${integ.name}</h3>
            <p>${integ.desc}</p>
          </div>
          <div class="card-badges">
            ${badge}
            <span class="chevron" id="chevron-${integ.id}">&#9660;</span>
          </div>
        </div>
        <div class="card-body" id="body-${integ.id}" style="display:none;">
          <div class="steps">
            <h4>How to set up:</h4>
            <ol>${stepsList}</ol>
          </div>
          <div class="key-inputs">
            ${keyInputs}
          </div>
        </div>
      </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crow — Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1117;
      color: #e1e4e8;
      line-height: 1.6;
      min-height: 100vh;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }
    header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid #2d333b;
    }
    header h1 {
      font-size: 1.8rem;
      color: #f0f6fc;
      margin-bottom: 0.5rem;
    }
    header h1 span { color: #58a6ff; }
    header p { color: #8b949e; font-size: 0.95rem; }
    .auto-note {
      background: #161b22;
      border: 1px solid #2d333b;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
      color: #8b949e;
    }
    .auto-note strong { color: #58a6ff; }

    .card {
      background: #161b22;
      border: 1px solid #2d333b;
      border-radius: 10px;
      margin-bottom: 0.75rem;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .card:hover { border-color: #444c56; }
    .advanced-card { opacity: 0.7; }
    .advanced-card:hover { opacity: 1; }

    .card-header {
      padding: 1rem 1.25rem;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
    }
    .card-title h3 {
      font-size: 1.05rem;
      color: #f0f6fc;
      margin-bottom: 0.15rem;
    }
    .card-title p {
      font-size: 0.85rem;
      color: #8b949e;
    }
    .card-badges {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }
    .badge {
      font-size: 0.7rem;
      padding: 0.2rem 0.5rem;
      border-radius: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .badge.configured { background: #1a3a2a; color: #3fb950; }
    .badge.oauth { background: #1a2a3a; color: #58a6ff; }
    .badge.advanced { background: #3a2a1a; color: #d29922; }
    .chevron {
      color: #484f58;
      font-size: 0.75rem;
      transition: transform 0.2s;
    }
    .chevron.open { transform: rotate(180deg); }

    .card-body {
      padding: 0 1.25rem 1.25rem;
      border-top: 1px solid #2d333b;
    }
    .steps {
      margin: 1rem 0;
    }
    .steps h4 {
      font-size: 0.85rem;
      color: #8b949e;
      margin-bottom: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .steps ol {
      padding-left: 1.5rem;
      font-size: 0.9rem;
    }
    .steps li {
      margin-bottom: 0.4rem;
      color: #c9d1d9;
    }
    .steps a {
      color: #58a6ff;
      text-decoration: none;
    }
    .steps a:hover { text-decoration: underline; }
    .steps code {
      background: #0d1117;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.85em;
      color: #f0883e;
    }
    .steps em { color: #d29922; font-style: normal; }

    .key-field {
      margin-top: 0.75rem;
    }
    .key-field label {
      display: block;
      font-size: 0.85rem;
      color: #8b949e;
      margin-bottom: 0.3rem;
      font-weight: 500;
    }
    .input-row {
      display: flex;
      gap: 0.5rem;
    }
    .key-field input {
      flex: 1;
      background: #0d1117;
      border: 1px solid #2d333b;
      border-radius: 6px;
      padding: 0.6rem 0.75rem;
      color: #f0f6fc;
      font-size: 0.9rem;
      font-family: monospace;
      outline: none;
      transition: border-color 0.2s;
    }
    .key-field input:focus { border-color: #58a6ff; }
    .key-field input::placeholder { color: #484f58; }
    .toggle-btn {
      background: #21262d;
      border: 1px solid #2d333b;
      border-radius: 6px;
      padding: 0.6rem 0.75rem;
      color: #8b949e;
      cursor: pointer;
      font-size: 0.8rem;
      white-space: nowrap;
    }
    .toggle-btn:hover { background: #2d333b; color: #c9d1d9; }
    .current-val {
      display: block;
      margin-top: 0.25rem;
      color: #484f58;
      font-family: monospace;
      font-size: 0.75rem;
    }

    .actions {
      margin-top: 2rem;
      display: flex;
      gap: 1rem;
      justify-content: center;
    }
    .btn {
      padding: 0.75rem 2rem;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #238636;
      color: #fff;
    }
    .btn-primary:hover { background: #2ea043; }
    .btn-primary:disabled { background: #1a3a2a; color: #3fb950; cursor: wait; }
    .btn-secondary {
      background: #21262d;
      color: #c9d1d9;
      border: 1px solid #2d333b;
    }
    .btn-secondary:hover { background: #2d333b; }

    .status {
      text-align: center;
      margin-top: 1rem;
      font-size: 0.9rem;
      min-height: 1.5rem;
    }
    .status.success { color: #3fb950; }
    .status.error { color: #f85149; }
    .status.saving { color: #58a6ff; }

    .footer {
      text-align: center;
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid #2d333b;
      color: #484f58;
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1><span>Crow</span> AI Platform</h1>
      <p>Set up your integrations — click each card for step-by-step instructions</p>
    </header>

    <div class="auto-note">
      <strong>Already included (no setup needed):</strong> Persistent Memory, Project Management & Research, Academic Search (arXiv & Semantic Scholar), and Local File Access.
      <br>Just enable the integrations below that you actually use.
    </div>

    <form id="wizard-form">
      ${cards}

      <div class="actions">
        <button type="submit" class="btn btn-primary" id="save-btn">Save &amp; Configure</button>
      </div>
      <div class="status" id="status"></div>
    </form>

    <!-- Mobile Access Section -->
    <div style="margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid #2d333b;">
      <h2 style="color: #f0f6fc; font-size: 1.3rem; margin-bottom: 0.5rem;">
        Mobile Access (Android / iOS)
      </h2>
      <p style="color: #8b949e; font-size: 0.9rem; margin-bottom: 1rem;">
        Access your Crow memory and project tools from the Claude mobile app.
      </p>

      <div class="card">
        <div class="card-header" onclick="toggleCard('mobile-cloud')">
          <div class="card-title">
            <h3>One-Click Cloud Deploy (Recommended)</h3>
            <p>Deploy to Render.com — free tier, takes 5 minutes</p>
          </div>
          <div class="card-badges">
            <span class="badge oauth">Easiest</span>
            <span class="chevron" id="chevron-mobile-cloud">&#9660;</span>
          </div>
        </div>
        <div class="card-body" id="body-mobile-cloud" style="display:none;">
          <div class="steps">
            <h4>How to set up:</h4>
            <ol>
              <li>Click the <strong>Deploy to Render</strong> button below (opens in new tab)</li>
              <li>Sign up for a free Render account if you don't have one</li>
              <li>Click <strong>"Create Web Service"</strong> — Render will build and deploy automatically</li>
              <li>Wait ~3 minutes for the build to complete</li>
              <li>Copy your service URL (e.g., <code>https://crow-gateway-xxxx.onrender.com</code>)</li>
              <li>Go to <a href="https://claude.ai/settings" target="_blank">claude.ai/settings</a> → <strong>Connectors</strong></li>
              <li>Click <strong>"Add Custom Connector"</strong></li>
              <li>Paste your URL + <code>/memory/mcp</code> (e.g., <code>https://crow-gateway-xxxx.onrender.com/memory/mcp</code>)</li>
              <li>Click <strong>Connect</strong> → complete the authorization</li>
              <li>Repeat step 7-9 for <code>/projects/mcp</code> if you want project tools on mobile too</li>
              <li>Open the Claude app on your phone — your tools are there!</li>
            </ol>
            <p style="margin-top: 0.75rem;">
              <a href="https://render.com/deploy" target="_blank" style="display: inline-block; background: #238636; color: white; padding: 0.5rem 1.25rem; border-radius: 6px; text-decoration: none; font-weight: 600;">
                Deploy to Render
              </a>
            </p>
          </div>
          <div class="key-field" style="margin-top: 1rem;">
            <label>Your Gateway URL (after deploying)</label>
            <div class="input-row">
              <input type="text" id="CROW_GATEWAY_URL" name="CROW_GATEWAY_URL"
                     value="${env.CROW_GATEWAY_URL || ""}"
                     placeholder="https://crow-gateway-xxxx.onrender.com"
                     autocomplete="off">
              <button type="button" class="toggle-btn" onclick="testGateway()">Test</button>
            </div>
            <small id="gateway-test-result" style="display:block; margin-top: 0.25rem; color: #484f58;"></small>
          </div>
        </div>
      </div>

      <div class="card advanced-card">
        <div class="card-header" onclick="toggleCard('mobile-local')">
          <div class="card-title">
            <h3>Local Network (Advanced)</h3>
            <p>Run on your own computer with Docker + tunnel</p>
          </div>
          <div class="card-badges">
            <span class="badge advanced">Docker Required</span>
            <span class="chevron" id="chevron-mobile-local">&#9660;</span>
          </div>
        </div>
        <div class="card-body" id="body-mobile-local" style="display:none;">
          <div class="steps">
            <h4>How to set up:</h4>
            <ol>
              <li>Install <a href="https://www.docker.com/products/docker-desktop/" target="_blank">Docker Desktop</a> if you don't have it</li>
              <li>Open a terminal in the Crow directory</li>
              <li>Run: <code>docker compose --profile local up --build</code></li>
              <li>For internet access, set up a <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" target="_blank">Cloudflare Tunnel</a> (free) or use <a href="https://ngrok.com" target="_blank">ngrok</a></li>
              <li>Add the tunnel URL as a connector at <a href="https://claude.ai/settings" target="_blank">claude.ai/settings</a></li>
            </ol>
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      After saving, restart Claude Code or Claude Desktop to use your new integrations.
    </div>
  </div>

  <script>
    function toggleCard(id) {
      const body = document.getElementById('body-' + id);
      const chevron = document.getElementById('chevron-' + id);
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      chevron.classList.toggle('open', !isOpen);
    }

    function toggleVisibility(inputId) {
      const input = document.getElementById(inputId);
      const btn = input.nextElementSibling;
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
      }
    }

    async function testGateway() {
      const url = document.getElementById('CROW_GATEWAY_URL').value.trim();
      const result = document.getElementById('gateway-test-result');
      if (!url) { result.textContent = 'Enter a URL first'; result.style.color = '#d29922'; return; }
      result.textContent = 'Testing...'; result.style.color = '#58a6ff';
      try {
        const resp = await fetch(url.replace(/\\/$/, '') + '/health', { mode: 'cors' });
        const data = await resp.json();
        if (data.status === 'ok') {
          result.textContent = 'Connected! Servers: ' + data.servers.join(', ');
          result.style.color = '#3fb950';
        } else {
          result.textContent = 'Unexpected response from server';
          result.style.color = '#d29922';
        }
      } catch (err) {
        result.textContent = 'Could not connect — check the URL and try again';
        result.style.color = '#f85149';
      }
    }

    document.getElementById('wizard-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = document.getElementById('status');
      const btn = document.getElementById('save-btn');

      status.className = 'status saving';
      status.textContent = 'Saving configuration...';
      btn.disabled = true;

      const formData = new FormData(e.target);
      const data = {};
      for (const [key, value] of formData.entries()) {
        if (value.trim()) data[key] = value.trim();
      }

      try {
        const resp = await fetch('/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        const result = await resp.json();

        if (result.ok) {
          status.className = 'status success';
          status.textContent = 'Saved! ' + result.message;
        } else {
          status.className = 'status error';
          status.textContent = 'Error: ' + result.message;
        }
      } catch (err) {
        status.className = 'status error';
        status.textContent = 'Connection error — is the wizard still running?';
      }

      btn.disabled = false;
    });
  </script>
</body>
</html>`;
}

// ── HTTP Server ──────────────────────────────────────────────────

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const env = loadEnv();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buildHTML(env));
    return;
  }

  if (req.method === "POST" && req.url === "/save") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const env = loadEnv();

        // Merge new values (don't remove existing keys not in form)
        for (const [key, val] of Object.entries(data)) {
          env[key] = val;
        }

        saveEnv(env);

        // Generate .mcp.json and desktop config
        let configMsg = "";
        try {
          execSync("node scripts/generate-mcp-config.js", {
            cwd: ROOT,
            stdio: "pipe",
          });
          configMsg = " .mcp.json updated.";
        } catch {
          configMsg = " (.mcp.json generation skipped.)";
        }

        let desktopMsg = "";
        try {
          execSync("node scripts/generate-desktop-config.js", {
            cwd: ROOT,
            stdio: "pipe",
          });
          desktopMsg = " Claude Desktop config updated too.";
        } catch {
          desktopMsg = " (Desktop config generation skipped.)";
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          message: `${Object.keys(data).length} keys saved to .env.${configMsg}${desktopMsg} Restart Claude to apply.`,
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Crow Setup Wizard running at: ${url}\n`);

  // Auto-open browser
  try {
    const cmd =
      platform() === "darwin" ? "open" :
      platform() === "win32" ? "start" : "xdg-open";
    execSync(`${cmd} ${url}`, { stdio: "pipe" });
    console.log("  Browser opened automatically.\n");
  } catch {
    console.log(`  Open ${url} in your browser.\n`);
  }

  console.log("  Press Ctrl+C to stop the wizard.\n");
});
