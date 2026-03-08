---
title: Dashboard
---

# Dashboard

A visual control panel for managing your Crow instance without typing commands.

## What is this?

The Crow Dashboard is a password-protected web interface served by your gateway. It gives you a point-and-click way to manage messages, blog posts, files, and settings — everything you can do through MCP tools, but in a browser.

## Why would I want this?

- **Quick overview** — See your messages, recent posts, and storage usage at a glance
- **Non-technical access** — Manage Crow without using a terminal or AI conversation
- **File management** — Browse, upload, and delete stored files with drag-and-drop
- **Settings** — Change configuration without editing `.env` files
- **Mobile-friendly** — Access from your phone over your local network or Tailscale

## Accessing the Dashboard

The dashboard is available at:

```
http://your-server:3001/dashboard
```

By default, access is restricted to local network and Tailscale connections. See [Network Security](#network-security) below.

## First Login

On first access, you'll be prompted to set a dashboard password. This is separate from any OAuth tokens or API keys — it's a simple password for browser access.

After setting your password, you'll see the main dashboard with its panel layout.

## Panels

The dashboard is organized into panels:

### Messages

View and manage your peer messages. Incoming messages from connected Crow users appear here with read/unread status. You can read threads, mark messages as read, and see message history.

### Blog

Manage your blog posts. View drafts and published posts, edit content, publish or unpublish, and see post statistics. The blog panel shows the same data as the `crow_list_posts` and `crow_get_post` MCP tools.

### Files

Browse your stored files with a visual file browser. Upload new files via drag-and-drop, preview images, copy file URLs, and delete files. Shows storage quota usage.

### Settings

Configure your Crow instance:

- Blog metadata (title, description, author)
- Storage quota
- Network access rules
- Theme preferences (dark/light mode)

## Dark and Light Themes

The dashboard uses the **Dark Editorial** design system. Toggle between dark and light modes using the theme switcher in the top navigation. Your preference is saved in your browser.

## Network Security

The dashboard is **not** intended for public internet exposure. By default, it only accepts connections from:

- **Localhost** (`127.0.0.1`, `::1`)
- **LAN** (`10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`)
- **Tailscale** (`100.64.0.0/10`)

If a request comes from an IP outside these ranges, the dashboard returns a 403 response.

To customize allowed IPs, set the `DASHBOARD_ALLOWED_IPS` environment variable:

```bash
DASHBOARD_ALLOWED_IPS=10.0.0.0/8,100.64.0.0/10
```

## Remote Access via Tailscale

For secure remote access without exposing the dashboard to the internet, use Tailscale. See the [Tailscale Setup guide](/getting-started/tailscale-setup) for step-by-step instructions.

Once Tailscale is running on both your server and your device, access the dashboard at:

```
http://100.x.x.x:3001/dashboard
```

Replace `100.x.x.x` with your server's Tailscale IP.

## Third-Party Panels

The dashboard supports add-on panels created by the community. Panels are placed in `~/.crow/panels/` and enabled through a configuration file. See [Creating Panels](/developers/creating-panels) for details.
