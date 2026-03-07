/**
 * Integration Registry — Single source of truth for all external MCP servers.
 *
 * Used by proxy.js (to spawn servers) and setup-page.js (to render status).
 * Each entry maps to a server in .mcp.json but adds metadata for the UI.
 */

export const INTEGRATIONS = [
  {
    id: "trello",
    name: "Trello",
    description: "Board and card management",
    command: "npx",
    args: ["-y", "mcp-server-trello"],
    envVars: ["TRELLO_API_KEY", "TRELLO_TOKEN"],
    keyUrl: "https://trello.com/power-ups/admin",
    keyInstructions: "Copy your API Key, then visit the authorization link on that page to generate a Token.",
  },
  {
    id: "canvas-lms",
    name: "Canvas LMS",
    description: "Course and assignment management",
    command: "npx",
    args: ["-y", "mcp-canvas-lms"],
    envVars: ["CANVAS_API_TOKEN", "CANVAS_BASE_URL"],
    keyUrl: "https://community.canvaslms.com/t5/Admin-Guide/How-do-I-manage-API-access-tokens/ta-p/89",
    keyInstructions: "In Canvas: Account → Settings → New Access Token. Also set your Canvas URL (e.g. https://your-school.instructure.com).",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repos, issues, pull requests, code search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    keyUrl: "https://github.com/settings/tokens",
    keyInstructions: "Generate new token (classic) → select scopes: repo, read:org, read:user → copy the token.",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search for research and fact-checking",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envVars: ["BRAVE_API_KEY"],
    keyUrl: "https://brave.com/search/api/",
    keyInstructions: "Sign up for a free API key and copy it from the dashboard.",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Team messaging and channels",
    command: "npx",
    args: ["-y", "@anthropic/mcp-server-slack"],
    envVars: ["SLACK_BOT_TOKEN"],
    keyUrl: "https://api.slack.com/apps",
    keyInstructions: "Create New App → OAuth & Permissions → add scopes (channels:history, channels:read, chat:write, users:read) → Install to Workspace → copy Bot Token (xoxb-...).",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Wiki pages, databases, knowledge base",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    envVars: ["NOTION_TOKEN"],
    envTransform: (env) => ({
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
      }),
    }),
    keyUrl: "https://www.notion.so/my-integrations",
    keyInstructions: "Create new integration → copy the Internal Integration Secret (ntn_...) → then share your Notion pages with the integration.",
  },
  {
    id: "discord",
    name: "Discord",
    description: "Community servers and channels",
    command: "npx",
    args: ["-y", "mcp-discord"],
    envVars: ["DISCORD_BOT_TOKEN"],
    keyUrl: "https://discord.com/developers/applications",
    keyInstructions: "New Application → Bot tab → Reset Token → copy it. Enable Message Content Intent under Bot settings.",
  },
  {
    id: "microsoft-teams",
    name: "Microsoft Teams",
    description: "Teams chats and channels (experimental)",
    command: "npx",
    args: ["-y", "mcp-server-microsoft-teams"],
    envVars: ["TEAMS_CLIENT_ID", "TEAMS_CLIENT_SECRET", "TEAMS_TENANT_ID"],
    keyUrl: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps",
    keyInstructions: "Register an app in Azure AD → add Graph permissions (Chat.Read, ChannelMessage.Read.All, ChannelMessage.Send) → create a client secret.",
  },
  {
    id: "google-workspace",
    name: "Google Workspace",
    description: "Gmail, Calendar, Docs, Sheets, Slides, Chat",
    command: "uvx",
    args: ["workspace-mcp"],
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    keyInstructions: "Create OAuth 2.0 Client ID (Desktop App type). Enable Gmail, Calendar, Sheets, Docs, and Slides APIs.",
  },
  {
    id: "zotero",
    name: "Zotero",
    description: "Citation and reference management",
    command: "uvx",
    args: ["zotero-mcp"],
    envVars: ["ZOTERO_API_KEY", "ZOTERO_USER_ID"],
    keyUrl: "https://www.zotero.org/settings/keys",
    keyInstructions: "Create new private key → check 'Allow library access' → copy the API key and your User ID (shown at top of page).",
  },
  {
    id: "arxiv",
    name: "arXiv",
    description: "Academic paper search and full-text retrieval",
    command: "uvx",
    args: ["arxiv-mcp-server"],
    envVars: [], // No API key needed
    keyUrl: null,
    keyInstructions: "No setup required — works out of the box.",
  },
  {
    id: "render",
    name: "Render",
    description: "Manage your Render deployment, services, and environment",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.render.com/mcp"],
    argsTransform: (env) => ["-y", "mcp-remote", "https://mcp.render.com/mcp", "--header", `Authorization: Bearer ${env.RENDER_API_KEY}`],
    envVars: ["RENDER_API_KEY"],
    keyUrl: "https://dashboard.render.com/account/api-keys",
    keyInstructions: "Go to Account Settings → API Keys → Create API Key → copy it.",
  },
];

/**
 * Check if an integration has all required env vars set.
 */
export function isIntegrationConfigured(integration) {
  if (integration.envVars.length === 0) return true;
  return integration.envVars.every((v) => process.env[v]);
}

/**
 * Build the environment object for spawning a server.
 */
export function getSpawnEnv(integration) {
  const env = {};
  for (const v of integration.envVars) {
    if (process.env[v]) env[v] = process.env[v];
  }
  // Some servers need transformed env vars (e.g., Notion)
  if (integration.envTransform) {
    return { ...env, ...integration.envTransform(env) };
  }
  return env;
}
