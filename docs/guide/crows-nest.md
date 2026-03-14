---
title: Crow's Nest
---

# Crow's Nest

The Crow's Nest is your private control panel for managing your Crow instance. It's accessible on your local network or via Tailscale — never exposed to the public internet.

## What is this?

The Crow's Nest is a password-protected web interface served by your gateway. It gives you a point-and-click way to manage messages, blog posts, files, and settings — everything you can do through MCP tools, but in a browser.

## Why would I want this?

- **Quick overview** — See your messages, recent posts, and storage usage at a glance
- **Non-technical access** — Manage Crow without using a terminal or AI conversation
- **File management** — Browse, upload, and delete stored files with drag-and-drop
- **Settings** — Change configuration without editing `.env` files
- **Mobile-friendly** — Access from your phone over your local network or Tailscale

## Starting the Gateway

The Crow's Nest requires the gateway to be running. Depending on how you installed Crow, this may already be handled for you:

- **Crow OS (Raspberry Pi)** — The installer creates a `crow-gateway` systemd service that starts automatically
- **Cloud (Render)** — The gateway runs as the main process
- **Docker** — `docker compose` runs the gateway container
- **Managed Hosting** — Pre-configured, always running
- **Desktop (stdio)** — No gateway by default — you need to start it manually if you want the Crow's Nest or blog

### Manual Start (Development / Desktop)

```bash
npm run gateway
```

This starts the gateway on port 3001 (or the port set in `PORT` / `CROW_GATEWAY_PORT`). Press Ctrl-C to stop.

### Persistent Service (Self-Hosted)

For a self-hosted server (Raspberry Pi, Ubuntu, etc.), create a systemd service so the gateway starts on boot and restarts on failure.

**System-level service** (runs as a dedicated user):

```bash
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << 'EOF'
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
User=crow
WorkingDirectory=/home/crow/.crow/app
ExecStart=/usr/bin/node servers/gateway/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable crow-gateway
sudo systemctl start crow-gateway
```

**User-level service** (runs as your own user, no sudo needed):

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/crow-gateway.service << 'EOF'
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.crow/app
ExecStart=/usr/bin/node servers/gateway/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable crow-gateway
systemctl --user start crow-gateway
```

**Verify it's running:**

```bash
# Check service status
sudo systemctl status crow-gateway    # system-level
systemctl --user status crow-gateway  # user-level

# Test the health endpoint
curl http://localhost:3001/health
```

## Accessing the Crow's Nest

Once the gateway is running:

| From | URL |
|---|---|
| Same machine | `http://localhost:3001/dashboard` |
| LAN (another device on your network) | `http://<server-ip>:3001/dashboard` |
| Remote via Tailscale | `http://<tailscale-ip>:3001/dashboard` |
| Remote via `tailscale serve` | `https://<hostname>.tail1234.ts.net/dashboard` |

### Remote Access with `tailscale serve`

If you want HTTPS and a proper hostname without exposing the Crow's Nest to the internet:

```bash
# Serve the gateway over Tailscale with a valid HTTPS certificate
tailscale serve --bg --https=443 http://localhost:3001
```

This makes the Crow's Nest available at `https://<hostname>.your-tailnet.ts.net/dashboard` from any device on your Tailscale network. Only Tailscale-connected devices can reach it.

## First Login

On first access, you'll be prompted to set a password. This is separate from any OAuth tokens or API keys — it's a simple password for browser access.

After setting your password, you'll see the Crow's Nest with its panel layout.

## Panels

The Crow's Nest is organized into panels. The landing page — labeled **Crow's Nest** in the navigation — shows system health stats (CPU, RAM, disk, Docker containers, DB metrics) along with the [App Launcher](#app-launcher) grid.

### Messages

View and manage your peer messages. Incoming messages from connected Crow users appear here with read/unread status. You can read threads, mark messages as read, and see message history. The Messages panel also includes an **AI Chat** tab for conversations with your configured AI provider.

### Contacts

Manage your Crow contacts. View all connected contacts with their Crow IDs, online status, and last-seen timestamps. Block or unblock contacts directly from the panel. The Contacts panel also explains how to generate and accept invite codes through your AI.

### Memory

Browse and search your stored memories. View memory counts by category, search by content, and see recent memories.

### Blog

Manage your blog posts. View drafts and published posts, edit content, publish or unpublish, and see post statistics. The blog panel shows the same data as the `crow_list_posts` and `crow_get_post` MCP tools.

### Files

Browse your stored files with a visual file browser. Upload new files via drag-and-drop, preview images, copy file URLs, and delete files. Shows storage quota usage.

### Extensions

Browse and install community add-ons. Each add-on displays an SVG logo (with emoji fallback for unknown add-ons), description, and action buttons in a card layout. Before installing resource-heavy add-ons, the Extensions page shows a warning with estimated RAM and disk requirements from the add-on manifest.

### Podcasts

Subscribe to and listen to podcasts directly in the Crow's Nest:

- **Subscribe** — Enter an RSS feed URL to add a podcast
- **Episode browser** — Browse recent episodes across all subscriptions with HTML5 audio player
- **Playback tracking** — Mark episodes as played/unplayed
- **Playlist support** — Organize episodes into playlists (via the database — UI coming)
- **Feed caching** — Episodes are cached locally; feeds refresh on demand or at configurable intervals

### Settings

Configure your Crow instance:

- Blog metadata (title, description, author)
- Storage quota
- Network access rules
- Theme preferences (dark/light mode)

## Dark and Light Themes

The Crow's Nest uses the **Dark Editorial** design system. Toggle between dark and light modes using the theme switcher in the top navigation. Your preference is saved in your browser.

## Network Security

The Crow's Nest is **private by default** — think of it like a locked back office. Only connections from trusted networks are allowed:

| Network | Range | Who uses this |
|---|---|---|
| Localhost | `127.0.0.1`, `::1` | The server itself |
| LAN (Class A) | `10.0.0.0/8` | Home/office networks |
| LAN (Class B) | `172.16.0.0/12` | Docker, some corporate networks |
| LAN (Class C) | `192.168.0.0/16` | Most home routers |
| Tailscale | `100.64.0.0/10` | Tailscale VPN (CGNAT range) |

If a request comes from an IP outside these ranges, the Crow's Nest returns a **403 Forbidden** response. This is intentional — the Crow's Nest has full control over your data and should not be exposed to the public internet.

::: warning
Only set `CROW_DASHBOARD_PUBLIC=true` if the gateway is behind another authentication layer (e.g., a reverse proxy with HTTP basic auth, Cloudflare Access, or a VPN). Without an additional auth layer, anyone on the internet could access the Crow's Nest with only a password between them and your data.
:::

For remote access without opening the Crow's Nest publicly, use [Tailscale](/getting-started/tailscale-setup). Tailscale IPs fall within the `100.64.0.0/10` range that the Crow's Nest already trusts.

For the full picture of what's public and what's private across Crow, see the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default).

## App Launcher

The Crow's Nest landing page includes a **Your Apps** section that shows launcher tiles for your installed add-ons. Each tile displays:

- **SVG logo** (48px) — Provided by the add-on, or a fallback initial letter
- **Name** — The add-on's display name
- **Status indicator** — A green dot for running containers or a gray dot for stopped ones (Docker-based add-ons only)
- **Open button** — For add-ons with a web UI (e.g., Nextcloud, Immich), a button that opens the app in a new tab

The launcher reads `~/.crow/installed.json` and filters for `bundle` and `mcp-server` type add-ons. Docker container status is checked via `docker ps --filter` with a 30-second cache to avoid repeated shell commands on page load.

Add-ons that declare a `webUI` field in their manifest (with `port`, `path`, and `label`) get an "Open" button that links to the local web interface.

## Third-Party Panels

The Crow's Nest supports add-on panels created by the community. Panels are placed in `~/.crow/panels/` and enabled through a configuration file. Add-ons that include a `panel` field in their manifest get their panel automatically installed and registered when the add-on is installed, and removed when uninstalled. See [Creating Panels](/developers/creating-panels) for details.
