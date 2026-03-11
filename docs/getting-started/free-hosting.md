# Free Hosting Options

Crow can be deployed for free on several platforms. Here's how they compare:

## Comparison

| Provider | Compute | RAM | Storage | Bandwidth | Sleep? | Best For |
|---|---|---|---|---|---|---|
| **Render** (free tier) | Shared CPU | 512 MB | Ephemeral | 750 hrs/mo | Yes (15 min) | Trying Crow out |
| **Oracle Cloud** (Always Free) | 1 OCPU (x86) | 1 GB | 47 GB | 10 TB/mo | No | Permanent self-hosting |
| **Raspberry Pi** | 4 cores | 4-8 GB | SD/SSD | LAN only* | No | Home lab / Crow OS |

\* Raspberry Pi can be exposed to the internet via Tailscale or Cloudflare Tunnel.

## Render + Turso (Quickest Start)

The fastest way to try Crow. Deploy in under 5 minutes with the included `render.yaml`.

**Limits:**
- 750 free hours/month (enough for one instance 24/7)
- Sleeps after 15 minutes of inactivity — first request after sleep takes ~30 seconds (cold start)
- Ephemeral disk — data resets on redeploy (that's why Turso is needed for persistence)

**Turso free tier:**
- 9 GB total storage
- 500 million row reads/month
- 25 million row writes/month

This is more than enough for personal use. A typical Crow installation uses <100 MB of database storage.

> See the [Cloud Deploy Guide](./cloud-deploy) for step-by-step instructions.

## Oracle Cloud Always Free (Recommended for Permanent Hosting)

Oracle's Always Free tier includes a VM.Standard.E2.1.Micro instance — 1 OCPU and 1 GB RAM. It's modest but sufficient for a personal Crow gateway. It never sleeps and never expires.

::: tip
Oracle also advertises an ARM A1 instance (4 OCPUs, 24 GB RAM) on the Always Free tier, but capacity is extremely limited — most regions are permanently full. The x86 Micro instance described here is reliably available.
:::

### Step 1: Create an Oracle Cloud Account

1. Go to [cloud.oracle.com](https://cloud.oracle.com) and sign up
2. You'll need a credit card for verification, but the Always Free tier is genuinely free — you won't be charged
3. Select your home region (closest to you for lowest latency)

### Step 2: Provision a Micro Instance

1. Go to **Compute > Instances > Create Instance**
2. **Image:** Oracle Linux 9 or Ubuntu 22.04 (Minimal)
3. **Shape:** VM.Standard.E2.1.Micro (1 OCPU, 1 GB RAM) — this is the Always Free x86 shape
4. **Networking:** Create a VCN with a public subnet
5. **SSH key:** Upload your public key or let Oracle generate one
6. Click **Create**

### Step 3: Connect and Install Prerequisites

```bash
# SSH into your instance
ssh -i ~/.ssh/your_key ubuntu@<public-ip>

# Update packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should be 20.x
npm --version
```

### Step 4: Install Crow

```bash
# Clone Crow
git clone https://github.com/kh0pper/crow.git ~/.crow/app
cd ~/.crow/app

# Run setup (installs deps + initializes SQLite database)
npm run setup

# Edit .env with your API keys
nano .env
```

No Turso needed — local SQLite works directly on Oracle's boot volume.

### Step 5: Set Up HTTPS

You have two options for HTTPS:

**Option A: Caddy + Domain (recommended if you have a domain)**

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Configure reverse proxy
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
crow.yourdomain.com {
    reverse_proxy localhost:3001
}
EOF

sudo systemctl restart caddy
```

Caddy automatically provisions Let's Encrypt certificates. Point your domain's DNS to the instance's public IP.

**Option B: Cloudflare Tunnel (no domain needed)**

```bash
# Install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create crow
cloudflared tunnel route dns crow crow.yourdomain.com

# Create config
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << EOF
tunnel: crow
credentials-file: /home/ubuntu/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: crow.yourdomain.com
    service: http://localhost:3001
  - service: http_status:404
EOF

# Run as service
sudo cloudflared service install
sudo systemctl start cloudflared
```

### Step 6: Security Hardening

```bash
# Enable firewall
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable

# Install fail2ban for SSH protection
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

### Step 7: Create a systemd Service

```bash
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << EOF
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/.crow/app
ExecStart=/usr/bin/node servers/gateway/index.js
Restart=unless-stopped
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now crow-gateway
```

### Step 8: Verify

```bash
# Check service status
sudo systemctl status crow-gateway

# Test locally
curl http://localhost:3001/health

# Test via HTTPS
curl https://crow.yourdomain.com/health
```

Visit `https://crow.yourdomain.com/setup` to see your integration status.

## Raspberry Pi

For a dedicated home appliance, see the [Raspberry Pi Setup Guide](./raspberry-pi).

## Paid Alternative

If you'd rather skip infrastructure management entirely, [managed hosting](./managed-hosting) gives you a pre-configured Crow instance for $15/mo (or $120/yr). No setup, no maintenance — just pick a username and connect your AI.

## Which Should I Choose?

- **Just trying Crow out?** → Render + Turso. Deploy in 5 minutes, sleep behavior is fine for testing.
- **Want a permanent free server?** → Oracle Cloud. 1 GB RAM micro instance, never sleeps, never expires.
- **Want a home appliance?** → Raspberry Pi with [Crow OS](./raspberry-pi). Physical device on your network.
- **Already have a server?** → Follow the Oracle Cloud steps on any Linux VPS (skip steps 1-2).
