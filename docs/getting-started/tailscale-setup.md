---
title: Tailscale Setup
---

# Tailscale Setup

Access your Crow's Nest and gateway securely from anywhere, without exposing them to the public internet.

## What is this?

Tailscale creates a private network (called a tailnet) between your devices. Once set up, your phone, laptop, and Crow server can talk to each other as if they were on the same local network — even when you're away from home.

## Why would I want this?

- **Secure remote access** — Reach the Crow's Nest from your phone or laptop anywhere
- **No port forwarding** — Works through NAT and firewalls without router configuration
- **No public exposure** — Your Crow gateway stays invisible to the internet
- **Easy setup** — Install, log in, done

## Step 1: Create a Tailscale Account

Sign up at [tailscale.com](https://tailscale.com). The free tier supports up to 100 devices.

## Step 2: Install on Your Crow Server

On Ubuntu/Debian:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the login URL printed in the terminal to authorize the device.

After login, get your server's Tailscale IP:

```bash
tailscale ip -4
```

This returns an IP like `100.x.x.x`. Note it down — you'll use this to access Crow remotely.

## Step 3: Install on Your Device

Install Tailscale on the device you want to access Crow from:

- **macOS/Windows/Linux**: Download from [tailscale.com/download](https://tailscale.com/download)
- **iOS**: [App Store](https://apps.apple.com/app/tailscale/id1470499037)
- **Android**: [Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)

Log in with the same account you used on your server.

## Step 4: Set Up MagicDNS (Optional but Recommended)

Instead of remembering IP addresses, set a friendly hostname so you can access Crow at `http://crow/` from any device on your Tailnet.

```bash
sudo tailscale set --hostname=crow
```

::: tip MagicDNS
MagicDNS is enabled by default on new Tailnets. If `http://crow/` doesn't resolve, check your [Tailscale admin console](https://login.tailscale.com/admin/dns) and enable MagicDNS.
:::

If `crow` is already taken on your Tailnet, use an alternative:

```bash
sudo tailscale set --hostname=crow-home
# Then access at http://crow-home/
```

## Step 5: Access Crow Remotely

Once both devices are on your tailnet, access the Crow's Nest at:

```
http://crow:3001/dashboard
```

Or using the Tailscale IP:

```
http://100.x.x.x:3001/dashboard
```

Replace `100.x.x.x` with your server's Tailscale IP from Step 2.

## Step 6: Verify the Connection

From your device, test the connection:

```bash
tailscale ping crow
curl http://crow:3001/health
```

You should see a health check response from the gateway.

## Making Your Blog Public

Your blog is public at your gateway URL, but the Crow's Nest stays private. To make the blog accessible outside your tailnet:

### Option A: Tailscale Funnel (Personal/Hobby Use)

The simplest approach — expose port 3001 publicly:

```bash
sudo tailscale funnel 3001
```

The gateway's built-in network restrictions ensure `/dashboard/*` routes are only accessible from local/Tailscale IPs, so the Crow's Nest remains protected even with Funnel enabled. Only the blog, health check, and MCP endpoints (which require OAuth) are accessible publicly.

::: warning Tailscale Funnel Limitations
Tailscale Funnel is designed for **personal and hobby use**. It has bandwidth limits and is not intended as a production hosting solution. If you plan to monetize your blog or podcast (ads, subscriptions, paid content), use a proper reverse proxy with a custom domain instead (Option B below) or consider [managed hosting](./managed-hosting).
:::

### Option B: Caddy Reverse Proxy (Recommended for Production)

For production use, monetized content, or higher traffic, use Caddy with a custom domain. Caddy provides automatic HTTPS via Let's Encrypt with no bandwidth limits:

Install Caddy:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Configure `/etc/caddy/Caddyfile` to expose only blog routes:

```
yourdomain.com {
    # Blog pages, posts, feeds, and sitemap
    handle /blog* {
        reverse_proxy localhost:3001
    }

    # Block everything else (Crow's Nest, MCP, API)
    handle {
        respond "Not Found" 404
    }
}
```

Then set `CROW_GATEWAY_URL` in your `.env` so RSS feeds, podcast URLs, and sitemaps use the public domain:

```bash
CROW_GATEWAY_URL=https://yourdomain.com
```

Restart both services:

```bash
sudo systemctl restart crow-gateway
sudo systemctl restart caddy
```

Caddy automatically obtains and renews Let's Encrypt certificates. Make sure your domain's DNS A record points to your server's public IP, and that ports 80 and 443 are open in your firewall.

::: tip Oracle Cloud Free Tier
If you're running on Oracle Cloud, you also need to add ingress rules for TCP ports 80 and 443 in your VCN's security list. See the [Oracle Cloud section](/getting-started/cloud-deploy#oracle-cloud-free-tier) for details.
:::

::: tip Beyond single-device access
Tailscale also enables multi-instance chaining — run Crow on multiple machines and sync data between them over your private Tailscale network. See [Multi-Device Quick Start](./multi-device).
:::

## Troubleshooting

### Cannot reach the server

1. Confirm both devices show as "Connected" in the Tailscale admin console at [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines)
2. Check that the Crow gateway is running: `curl http://localhost:3001/health` on the server
3. Verify the Tailscale IP hasn't changed: `tailscale ip -4`
4. Try restarting Tailscale: `sudo systemctl restart tailscaled`

### Connection times out

- Tailscale needs an initial connection to a coordination server. If your server is behind a strict firewall, it may need outbound access to `login.tailscale.com` on port 443.
- Some corporate networks block UDP traffic that Tailscale uses for direct connections. Tailscale will fall back to relay servers (DERP), which may be slower but still work.

### Crow's Nest returns 403

The Crow's Nest network check automatically allows localhost, RFC 1918 private ranges, and Tailscale's CGNAT range (`100.64.0.0/10`).

If you need to allow additional IP addresses or ranges, set the `CROW_ALLOWED_IPS` environment variable in your `.env` file:

```bash
# Single IP
CROW_ALLOWED_IPS=203.0.113.50

# Multiple IPs and CIDR ranges, comma-separated
CROW_ALLOWED_IPS=203.0.113.50,198.51.100.0/24
```

Alternatively, set `CROW_DASHBOARD_PUBLIC=true` to disable the network check entirely. Only use this if you have other access controls in place (e.g., a reverse proxy with authentication).

### Tailscale not starting on boot

Enable the systemd service:

```bash
sudo systemctl enable tailscaled
```
