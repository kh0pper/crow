---
name: network-setup
description: Tailscale setup guidance for secure remote dashboard access
triggers:
  - tailscale
  - remote access
  - dashboard access
  - network setup
  - VPN setup
tools: []
---

# Network Setup — Tailscale for Secure Remote Access

## When to Activate

- User gets a 403 error accessing the dashboard from a non-local IP
- User asks about setting up remote access to Crow
- User mentions Tailscale or VPN for their Crow instance
- User wants to access the dashboard from outside their home network

## Why Tailscale?

The Crow Dashboard is restricted to local network (LAN) and Tailscale IPs by default. This is a security measure — the dashboard has full control over your Crow instance. Tailscale creates an encrypted mesh VPN that makes your devices appear on the same network, without exposing ports to the internet.

## Setup Guide

### Step 1: Install Tailscale on the Crow Server

```bash
# Linux (Ubuntu/Debian)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Follow the URL to authenticate
```

### Step 2: Install Tailscale on Your Device

- **macOS/Windows/Linux**: Download from https://tailscale.com/download
- **iOS/Android**: Install from App Store or Google Play
- Sign in with the same account

### Step 3: Access the Dashboard

Once both devices are on Tailscale:

```
# Find your Crow server's Tailscale IP
tailscale ip -4

# Access the dashboard using the Tailscale IP
http://100.x.x.x:3001/dashboard
```

### Alternative: Public Access (Not Recommended)

If you understand the risks and want to allow access from any IP:

```bash
# Add to .env
CROW_DASHBOARD_PUBLIC=true
```

This bypasses the network allowlist. Ensure you have a strong dashboard password set.

## Allowed Networks (Default)

The dashboard accepts connections from:
- `127.0.0.1` / `::1` — localhost
- `10.0.0.0/8` — private network (Class A)
- `172.16.0.0/12` — private network (Class B)
- `192.168.0.0/16` — private network (Class C)
- `100.64.0.0/10` — Tailscale CGNAT range

### Making Your Blog Public (Tailscale Funnel)

If the user wants their blog accessible from the public internet (not just their Tailscale network), Tailscale Funnel exposes the gateway publicly while the dashboard stays private:

```bash
tailscale funnel --bg --https=443 http://localhost:3001
```

The blog becomes available at `https://<hostname>.your-tailnet.ts.net/blog`. The dashboard still returns 403 to non-local IPs, so only the blog and other unauthenticated routes (`/health`, `/setup`) are effectively public. Funnel must be enabled in the Tailscale admin console first.

## Troubleshooting

- **403 Forbidden**: Your IP is not on the allowlist. Use Tailscale or set `CROW_DASHBOARD_PUBLIC=true`.
- **Can't connect at all**: Check that the gateway is running (`npm run gateway`) and the port is correct.
- **Tailscale connected but still 403**: The gateway might not see the Tailscale IP. Check if you're behind a reverse proxy that masks the client IP. Set `trust proxy` in Express if needed.
