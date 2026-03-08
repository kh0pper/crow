---
title: Tailscale Setup
---

# Tailscale Setup

Access your Crow dashboard and gateway securely from anywhere, without exposing them to the public internet.

## What is this?

Tailscale creates a private network (called a tailnet) between your devices. Once set up, your phone, laptop, and Crow server can talk to each other as if they were on the same local network — even when you're away from home.

## Why would I want this?

- **Secure remote access** — Reach your dashboard from your phone or laptop anywhere
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

## Step 4: Access Crow Remotely

Once both devices are on your tailnet, access the dashboard at:

```
http://100.x.x.x:3001/dashboard
```

Replace `100.x.x.x` with your server's Tailscale IP from Step 2.

The gateway API is available at:

```
http://100.x.x.x:3001
```

## Step 5: Verify the Connection

From your device, test the connection:

```bash
ping 100.x.x.x
curl http://100.x.x.x:3001/health
```

You should see a health check response from the gateway.

## Troubleshooting

### Cannot reach the server

1. Confirm both devices show as "Connected" in the Tailscale admin console at [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines)
2. Check that the Crow gateway is running: `curl http://localhost:3001/health` on the server
3. Verify the Tailscale IP hasn't changed: `tailscale ip -4`
4. Try restarting Tailscale: `sudo systemctl restart tailscaled`

### Connection times out

- Tailscale needs an initial connection to a coordination server. If your server is behind a strict firewall, it may need outbound access to `login.tailscale.com` on port 443.
- Some corporate networks block UDP traffic that Tailscale uses for direct connections. Tailscale will fall back to relay servers (DERP), which may be slower but still work.

### Dashboard returns 403

The dashboard IP allowlist includes Tailscale's CGNAT range (`100.64.0.0/10`) by default. If you've customized `DASHBOARD_ALLOWED_IPS`, make sure this range is included:

```bash
DASHBOARD_ALLOWED_IPS=10.0.0.0/8,100.64.0.0/10
```

### Tailscale not starting on boot

Enable the systemd service:

```bash
sudo systemctl enable tailscaled
```
