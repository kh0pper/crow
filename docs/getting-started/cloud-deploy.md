# Cloud Deploy (Render)

Deploy Crow to Render so it's accessible from any device and any AI platform.

## Step 1: Create a Turso Database

1. Sign up at [turso.tech](https://turso.tech) (free tier works)
2. Create a database named `crow`
3. Copy your **Database URL** (starts with `libsql://`)
4. Create an auth token and copy it

## Step 2: Deploy to Render

1. Fork the [Crow repository](https://github.com/kh0pper/crow) on GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**
3. Connect your forked repo — Render will detect the `render.yaml`
4. Set the required environment variables:
   - `TURSO_DATABASE_URL` — your Turso database URL
   - `TURSO_AUTH_TOKEN` — your Turso auth token
5. Click **Apply** — Render will deploy automatically

## Step 3: Initialize the Database

After deployment, open the Render shell for your service and run:

```bash
npm run init-db
```

Or trigger it via the health endpoint — the database tables are created automatically on first request.

## Step 4: Connect Your AI Platform

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

## Step 5: Add Integrations (Optional)

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
