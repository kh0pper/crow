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

## Remote Access with Tailscale

Access your Crow from anywhere with [Tailscale](https://tailscale.com) (free for personal use):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Set a memorable hostname in your [Tailscale admin console](https://login.tailscale.com/admin/machines) — rename the machine to `crow`. With MagicDNS enabled, your server is accessible at `http://crow:3001` from any device on your Tailscale network.

See the [Tailscale Setup Guide](./tailscale-setup) for advanced configuration, including HTTPS certificates and Tailscale Funnel for public blog access.

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
