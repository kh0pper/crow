# Cloud Deploy (Render)

::: tip Don't want to manage infrastructure?
Try [managed hosting](./managed-hosting) — $15/mo, no setup required.
:::

Deploy Crow to Render so it's accessible from any device and any AI platform.

## Step 1: Create a Turso Database

1. Sign up at [turso.tech](https://turso.tech) (free tier works)
2. Create a database named `crow`
3. Copy your **Database URL** (starts with `libsql://`)
4. Create an auth token and copy it

> **Security note**: Your Turso credentials (database URL and auth token) grant full access to your Crow database. Treat them like passwords — never share them publicly or commit them to code. See the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md) for more details.

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

## Verify and Connect Your AI

Check that everything is working:

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

---

## Oracle Cloud Free Tier {#oracle-cloud-free-tier}

Oracle Cloud offers an Always Free tier with up to 24GB RAM and 200GB storage — enough to run Crow with all add-ons. Unlike Render's free tier, Oracle instances are persistent (no sleep, no ephemeral storage).

### Setting Up Crow on Oracle Cloud

1. **Create a free Oracle Cloud account** at [cloud.oracle.com](https://cloud.oracle.com)
2. **Launch a compute instance** — Choose "Always Free Eligible" shape (VM.Standard.A1.Flex with 1-4 OCPUs / 6-24GB RAM, ARM architecture)
3. **SSH into your instance** and run the Crow installer:

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

4. **Set up Tailscale** for private access to the Crow's Nest:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

### Making Your Blog/Podcast Public

To serve your blog or podcast publicly (required for podcast directories, monetization, etc.), set up a Caddy reverse proxy with a custom domain.

#### 1. Open Firewall Ports

**Oracle Cloud Security List** (cloud-level firewall):

1. Go to the [Oracle Cloud Console](https://cloud.oracle.com) → **Networking** → **Virtual Cloud Networks**
2. Click your VCN → click your **Subnet** → click the **Security List**
3. Click **Add Ingress Rules** and add:

| Source CIDR | Protocol | Dest Port Range | Description |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `80` | HTTP |
| `0.0.0.0/0` | TCP | `443` | HTTPS |

**UFW** (on-box firewall):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

#### 2. Point Your Domain

Add an A record for your domain pointing to your Oracle instance's public IP:

```
blog.yourdomain.com → <oracle-public-ip>
```

#### 3. Install and Configure Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Configure `/etc/caddy/Caddyfile`:

```
blog.yourdomain.com {
    handle /blog* {
        reverse_proxy localhost:3001
    }
    handle {
        respond "Not Found" 404
    }
}
```

Set the public URL and restart:

```bash
# Add to your .env file
echo 'CROW_GATEWAY_URL=https://blog.yourdomain.com' >> ~/.crow/app/.env

sudo systemctl restart crow-gateway
sudo systemctl restart caddy
```

Caddy will automatically obtain a Let's Encrypt certificate. Your blog and podcast RSS feeds will now be publicly accessible at `https://blog.yourdomain.com/blog/`.

::: tip Monetization-Ready
This setup is suitable for monetized content (paid blogs, podcast sponsorships, subscriptions). Oracle's free tier includes 10TB/month outbound bandwidth — more than enough for most blogs and podcasts. For an even simpler setup, consider [managed hosting](./managed-hosting).
:::
