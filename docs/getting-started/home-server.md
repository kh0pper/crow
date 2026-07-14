# Home Server Setup

Run Crow on a Raspberry Pi, old laptop, NUC, or any always-on Linux machine. Your data stays on your own hardware and your server never sleeps.

## What Counts as a Home Server?

Any machine that:
- Runs Linux (Debian, Ubuntu, or Raspberry Pi OS)
- Stays powered on
- Has at least 1 GB RAM and 8 GB storage
- Is connected to your home network

Common choices:

| Hardware | RAM | Good For |
|---|---|---|
| Raspberry Pi 4 (4 GB) | 4 GB | Core Crow + light add-ons |
| Raspberry Pi 5 (8 GB) | 8 GB | Full platform + Ollama with small models |
| Old laptop or desktop | 4-32 GB | Everything, including heavy add-ons |
| Intel NUC or mini PC | 8-16 GB | Compact, quiet, efficient |

## Quick Install

One command installs Crow and all dependencies:

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

::: warning Supported platforms
The install script supports **Debian/Ubuntu family systems only** (Debian, Ubuntu, Raspberry Pi OS, and derivatives — it installs via `apt`) and exits early on anything else. On macOS, Windows, or other Linux distributions there is no auto-install: follow the manual path instead — [Full Setup](./full-setup) (Docker Compose) or [Desktop Install](./desktop-install).
:::

::: tip Prefer to inspect the script first?
```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh -o crow-install.sh
less crow-install.sh   # Review the script
bash crow-install.sh   # Run it
```
:::

The installer takes 5-10 minutes and sets up:
- Node.js 20, Docker, Caddy, Avahi (mDNS)
- Crow platform with local SQLite database
- Cryptographic identity (Crow ID)
- systemd service for auto-start
- HTTPS via self-signed certificate
- Firewall (UFW) + fail2ban
- Tailscale (offered during install if not already present)

::: info Container extensions need Docker
Extensions that deploy their own containers (media servers, local AI, and most of the store) require Docker. The install script installs it for you; if you set Crow up another way, install Docker yourself — the Extensions page will tell you when it's missing, and container installs are refused until it's available. Extensions that only *connect* to existing services don't need Docker.
:::

## Remote Access with Tailscale

Access your Crow from anywhere with [Tailscale](https://tailscale.com) (free for personal use). The install script **offers to install Tailscale** if it isn't present (recommended — say yes, then authenticate with `sudo tailscale up` and re-run the script to wire up the hostname and HTTPS dashboard). To install it manually instead:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Set a memorable hostname in your [Tailscale admin console](https://login.tailscale.com/admin/machines) — rename the machine to `crow`. With MagicDNS enabled, your server is accessible at `http://crow:3001` from any device on your Tailscale network.

See the [Tailscale Setup Guide](./tailscale-setup) for advanced configuration, including HTTPS certificates and Tailscale Funnel for public blog access.

::: tip Chain with cloud instances
Your home server can sync with always-free cloud instances for redundancy and remote access. If your home network goes down, your data is safe in the cloud. Set up [Oracle Cloud](./oracle-cloud) or [Google Cloud](./google-cloud) as a second instance, then [chain them together](./multi-device) — memories sync automatically across both.
:::

## How Your Crow Stays Secure

A home server is private by default — you don't need to do anything extra for these to hold:

- **Nothing is exposed to the internet.** The installer configures the firewall (UFW) to deny inbound traffic except SSH and HTTPS, and adds fail2ban to block brute-force SSH attempts. Your dashboard and MCP endpoints are reachable only from your home network and your Tailscale network.
- **Never port-forward the gateway.** If you want remote access, use Tailscale (above) — it gives every device an encrypted tunnel without opening your router. The only thing that should ever be public is your blog, via [Tailscale Funnel](./tailscale-setup), which exposes *only* the public-safe paths (blog, feeds) — the dashboard and your data stay unreachable even with Funnel on.
- **Everything sensitive requires auth.** The dashboard has a password (with optional two-factor authentication in Settings → Two-Factor Auth, plus automatic lockout after repeated failures); remote AI clients authenticate with OAuth; local clients use a token you generate from the dashboard's Connect panel.
- **Keep auto-update on** (it's on by default) so security fixes arrive without you thinking about them.

For the full picture — what's public by default, how keys are stored, what to do if something leaks — see the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md).

## Connect Your AI Platform

Once Crow is running, connect it from any AI platform:

- [Claude Web & Mobile](../platforms/claude)
- [ChatGPT](../platforms/chatgpt)
- [Claude Code](../platforms/claude-code)
- [All platforms](../platforms/)

Visit `https://crow.local/setup` (local network) or `http://crow:3001/setup` (Tailscale) to see integration status and endpoint URLs.

## Managing Your Crow

```bash
# Platform status
crow status

# View gateway logs
sudo journalctl -u crow-gateway -f

# Restart gateway
sudo systemctl restart crow-gateway

# Install add-on bundles
crow bundle install ollama
crow bundle start ollama

# Update Crow
bash ~/.crow/app/scripts/crow-update.sh
```

## Raspberry Pi Users

For Pi-specific details — flashing SD cards, mDNS setup, hardware recommendations, and the setup wizard — see the [Raspberry Pi Setup Guide](./raspberry-pi).

## Making Your Blog Public

By default your Crow is only accessible from your home network (or via Tailscale). To make your blog publicly accessible, see the blog publishing options in the [Raspberry Pi guide](./raspberry-pi#making-your-blog-public) or the [Blog Guide](/guide/blog#making-your-blog-public).
