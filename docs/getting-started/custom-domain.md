---
title: Custom Domain Setup
description: Point your own domain to your Crow server with DNS A records and automatic HTTPS via Caddy.
---

# Custom Domain Setup

If you want a professional URL for your Crow blog or gateway (e.g., `blog.yourdomain.com` instead of `crow.your-tailnet.ts.net`), you need to point a DNS record at your server's public IP address. This guide covers the DNS setup for common providers and how Caddy handles HTTPS automatically.

## Prerequisites

- A running Crow server with a **public IP address** (see [Oracle Cloud Free Tier](./oracle-cloud) or another cloud provider)
- A domain name you own
- Port 443 open in your server's firewall (covered in the Oracle Cloud guide's security hardening step)

## What Is an A Record?

An A record maps a domain name (like `blog.yourdomain.com`) to an IPv4 address. When someone visits your domain, their browser uses this record to find your server. You need one A record pointing your chosen domain or subdomain to your Crow server's public IP.

## Step 1: Find Your Server's Public IP

```bash
# On your server
curl -4 ifconfig.me
```

Note this IP address — you'll enter it in your DNS provider's dashboard.

## Step 2: Create the DNS Record

Choose your DNS provider below and follow the instructions. In each case, you're creating an A record that points your domain or subdomain to your server's IP.

### Cloudflare

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com)
2. Select your domain
3. Go to **DNS** in the left sidebar
4. Click **Add Record**
5. Set the fields:
   - **Type:** `A`
   - **Name:** your subdomain (e.g., `blog`) or `@` for the root domain
   - **IPv4 address:** your server's public IP
   - **Proxy status:** Toggle to **DNS only** (gray cloud). Caddy needs a direct connection to provision certificates. You can enable the orange-cloud proxy later if desired, but start with DNS only.
   - **TTL:** Auto
6. Click **Save**

### Namecheap

1. Log in to [Namecheap](https://www.namecheap.com) and go to **Domain List**
2. Click **Manage** next to your domain
3. Go to the **Advanced DNS** tab
4. Click **Add New Record**
5. Set the fields:
   - **Type:** `A Record`
   - **Host:** your subdomain (e.g., `blog`) or `@` for the root domain
   - **Value:** your server's public IP
   - **TTL:** Automatic
6. Click the checkmark to save

### GoDaddy

1. Log in to [GoDaddy](https://www.godaddy.com) and go to **My Products**
2. Find your domain and click **DNS** (or **Manage DNS**)
3. Click **Add** in the Records section
4. Set the fields:
   - **Type:** `A`
   - **Name:** your subdomain (e.g., `blog`) or `@` for the root domain
   - **Value:** your server's public IP
   - **TTL:** 600 seconds (or the lowest available)
5. Click **Save**

### DigitalOcean

1. Log in to the [DigitalOcean Control Panel](https://cloud.digitalocean.com)
2. Go to **Networking** in the left sidebar
3. If your domain isn't listed, enter it under "Add a Domain" and click **Add Domain**
4. In the domain's DNS records, click **Create new record**
5. Set the fields:
   - **Type:** `A` (selected by default)
   - **Hostname:** your subdomain (e.g., `blog`) or `@` for the root domain
   - **Will Direct To:** your server's public IP
   - **TTL:** 3600 (default)
6. Click **Create Record**

::: tip Other providers
The process is the same everywhere: find the DNS management page, add an A record, enter your subdomain and server IP. If your provider isn't listed here, search their help docs for "add A record."
:::

## Step 3: Install and Configure Caddy

Crow's Docker setup uses [Caddy](https://caddyserver.com) as a reverse proxy. Caddy automatically provisions and renews Let's Encrypt TLS certificates when DNS is pointed at your server — no manual certificate management required.

If you followed the [Oracle Cloud guide](./oracle-cloud#option-b-caddy-custom-domain), you may already have Caddy installed. If not:

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Configure the reverse proxy:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
blog.yourdomain.com {
    reverse_proxy localhost:3001
}
EOF

sudo systemctl restart caddy
```

Replace `blog.yourdomain.com` with your actual domain. Caddy will detect the domain, contact Let's Encrypt, and provision a certificate automatically. This typically takes under a minute.

## Step 4: Set the Public URL

Tell Crow its public address so it generates correct links in blog feeds, share URLs, and the Crow's Nest:

```bash
# If using the installer layout
echo 'CROW_GATEWAY_URL=https://blog.yourdomain.com' >> ~/.crow/app/.env
sudo systemctl restart crow-gateway

# If using Docker
# Add CROW_GATEWAY_URL=https://blog.yourdomain.com to your .env file
# then: docker compose --profile cloud up --build -d
```

## Step 5: Verify

Open `https://blog.yourdomain.com/health` in your browser. You should see a JSON response confirming the gateway is running, served over HTTPS with a valid certificate.

## Troubleshooting

### DNS propagation delay

After creating or changing a DNS record, it can take up to 48 hours to propagate worldwide, though most changes take effect within 30 minutes. You can check propagation status with:

```bash
# Check if DNS has updated
dig +short blog.yourdomain.com

# Or use an online tool like https://dnschecker.org
```

If the command returns your server's IP, propagation is complete.

### HTTPS not working

If you see certificate errors or Caddy fails to provision a certificate:

1. Confirm DNS is pointing to the correct IP: `dig +short blog.yourdomain.com`
2. Confirm port 443 is open on your server and any cloud firewall (Oracle Security Lists, AWS Security Groups, etc.)
3. Check Caddy's logs for specific errors:

```bash
sudo journalctl -u caddy --no-pager -n 50
```

Common causes:
- **DNS not propagated yet** — wait and retry. Caddy retries automatically.
- **Port 443 blocked** — Let's Encrypt needs to reach port 443 for the HTTP challenge. Check both your OS firewall (`sudo ufw status`) and your cloud provider's firewall rules.
- **Cloudflare proxy enabled** — if you're using Cloudflare with the orange cloud (proxy) on, Caddy can't complete the ACME challenge. Switch to DNS only (gray cloud) for initial setup.

### Wrong IP address

If your domain loads someone else's site or times out:

1. Verify your server's current public IP: `curl -4 ifconfig.me`
2. Compare with what DNS returns: `dig +short blog.yourdomain.com`
3. If they don't match, update the A record in your DNS provider and wait for propagation

Cloud providers sometimes change your public IP if you stop and restart an instance. If this happens, update your A record with the new IP. Consider reserving a static IP (called "Reserved Public IP" on Oracle Cloud, "Elastic IP" on AWS) to prevent this.

## Related Guides

- [Oracle Cloud Free Tier](./oracle-cloud) — recommended free server for hosting Crow
- [Tailscale Remote Access](./tailscale-setup) — private access without a public domain
- [Docker](./docker) — container-based deployment with built-in Caddy support
