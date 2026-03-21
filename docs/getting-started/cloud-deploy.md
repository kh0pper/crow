# Cloud Deploy

::: danger Archived — Legacy Deployment Path
This page documents the Render + Turso deployment method, which is **no longer supported**. Turso cloud database support has been removed from Crow. Multi-device sync is now handled by Hypercore P2P replication with local SQLite.

For new deployments, use [Oracle Cloud Free Tier](./oracle-cloud), a [Home Server](./home-server), or [Managed Hosting](./managed-hosting).
:::

::: tip Recommended: Oracle Cloud Free Tier
For new cloud deployments, we recommend **[Oracle Cloud Free Tier](./oracle-cloud)** — it never sleeps, uses local SQLite (no external database), and is genuinely permanent. The guide below is for Render, which is still supported but has significant limitations.
:::

::: tip Don't want to manage infrastructure?
Try [managed hosting](./managed-hosting) — $15/mo, no setup required.
:::

---

## Legacy: Render + Turso Deployment

::: warning Render Free Tier Limitations
- **Sleeps after 15 minutes** of inactivity — first request after sleep takes ~30 seconds
- **Ephemeral disk** — local files are lost on redeploy, requiring Turso as an external database
- **Two dependencies** — you need both a Render account and a Turso account
- **Cold starts** — every time the service wakes from sleep, all MCP connections must reconnect

For a free server that avoids all of these issues, use [Oracle Cloud](./oracle-cloud) instead.
:::

### Step 1: Create a Turso Database

1. Sign up at [turso.tech](https://turso.tech) (free tier works)
2. Create a database named `crow`
3. Copy your **Database URL** (starts with `libsql://`)
4. Create an auth token and copy it

> **Security note**: Your Turso credentials (database URL and auth token) grant full access to your Crow database. Treat them like passwords — never share them publicly or commit them to code. See the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md) for more details.

### Step 2: Deploy to Render

1. Fork the [Crow repository](https://github.com/kh0pper/crow) on GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**
3. Connect your forked repo — Render will detect the `render.yaml`
4. Set the required environment variables:
   - `TURSO_DATABASE_URL` — your Turso database URL
   - `TURSO_AUTH_TOKEN` — your Turso auth token
5. Click **Apply** — Render will deploy automatically

### Step 3: Initialize the Database

After deployment, open the Render shell for your service and run:

```bash
npm run init-db
```

Or trigger it via the health endpoint — the database tables are created automatically on first request.

### Step 4: Connect Your AI Platform

Once deployed, visit `https://your-service.onrender.com/setup` to see:

- Which integrations are connected
- Your MCP endpoint URLs for each platform
- Instructions for adding API keys

Then follow the platform-specific guide:

- [Claude Web & Mobile](../platforms/claude)
- [ChatGPT](../platforms/chatgpt)
- [Gemini](../platforms/gemini)
- [Grok](../platforms/grok)
- [Cursor](../platforms/cursor)
- [Windsurf](../platforms/windsurf)
- [Cline](../platforms/cline)
- [Claude Code](../platforms/claude-code)

### Step 5: Add Integrations (Optional)

> **Security note**: API keys are like passwords — each one grants access to a service on your behalf. Only add keys for services you actually need, and never share them. If a key is ever exposed, revoke it immediately at the service's website and create a new one. See the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md) for step-by-step instructions.

Add API keys for external services in your Render dashboard under **Environment**:

| Integration | Environment Variable | Get Key |
|---|---|---|
| GitHub | `GITHUB_PERSONAL_ACCESS_TOKEN` | [GitHub Settings](https://github.com/settings/tokens) |
| Brave Search | `BRAVE_API_KEY` | [Brave API](https://brave.com/search/api/) |
| Slack | `SLACK_BOT_TOKEN` | [Slack Apps](https://api.slack.com/apps) |
| Notion | `NOTION_TOKEN` | [Notion Integrations](https://www.notion.so/my-integrations) |
| Trello | `TRELLO_API_KEY` + `TRELLO_TOKEN` | [Trello Power-Ups](https://trello.com/power-ups/admin) |
| Google Workspace | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |

See the full list on the [Integrations](../integrations/) page.

After adding keys, Render restarts automatically. Refresh your `/setup` page to confirm they're connected.

::: warning What's publicly accessible after deployment?
When deployed to Render, your instance is on the public internet. Here's what that means:
- **Blog** (`/blog`) — Public, but only posts you explicitly publish with `public` visibility appear
- **Crow's Nest** (`/dashboard`) — Blocked from public IPs (returns 403). Only accessible from your Tailscale network or localhost
- **MCP endpoints** — Protected by OAuth 2.1. Only authorized AI clients can access your tools
- **Setup page** (`/setup`) — Shows connection status but never exposes API keys

Nothing personal is visible unless you publish it. See the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default) for details.
:::

### Verify

```bash
curl https://your-service.onrender.com/health
```

Visit `/setup` on your deployed URL to see integration status and endpoint URLs.

**Try it out** — after connecting your AI platform, say:

> "Remember that today is my first day using Crow"
> "What do you remember?"

::: tip Many integrations?
If you have several integrations enabled, use the `/router/mcp` endpoint instead of connecting each server individually. It consolidates all tools into 7 category tools, reducing context window usage by ~75%. See the [Context & Performance guide](/guide/context-performance).
:::

Now connect your AI: [Claude](/platforms/claude) · [ChatGPT](/platforms/chatgpt) · [All platforms](/platforms/)
