---
title: Google Cloud Free Tier
description: Set up Crow on Google Cloud's always-free e2-micro VM with Tailscale and chain it with your other instances.
---

# Google Cloud Free Tier

Google Cloud's always-free e2-micro VM gives you a permanent server with 1GB RAM and 30GB disk — enough for base Crow. Chain it with an Oracle Cloud instance for redundant, multi-cloud Crow.

::: tip Why Google Cloud as a secondary?
- **Always free** — e2-micro never expires, no surprise charges
- **1 GB RAM, 30 GB disk** — runs base Crow comfortably
- **Chains with Oracle Cloud** — two free clouds, synced automatically
- **US regions** — us-west1, us-central1, or us-east1 (free tier restriction)
:::

## Step 1: Create a Google Cloud Account

1. Go to [cloud.google.com](https://cloud.google.com) and click **Get started for free**
2. Sign in with your Google account
3. Enter billing information — Google requires a credit card for verification. The e2-micro instance is genuinely free and you will not be charged as long as you stay within the free tier limits.
4. You'll receive $300 in free trial credits (valid 90 days) but do not need them — the e2-micro is in the **Always Free** tier, separate from the trial.

## Step 2: Create an e2-micro VM

1. Go to the [Google Cloud Console](https://console.cloud.google.com)
2. Navigate to **Compute Engine → VM Instances** (enable the API if prompted)
3. Click **Create Instance**
4. Configure:
   - **Name:** `crow`
   - **Region:** `us-central1` (or `us-west1`, `us-east1` — **only these three regions are free**)
   - **Zone:** Any available zone in your chosen region
   - **Machine type:** Under **General purpose → E2**, select **e2-micro** (0.25 vCPU, 1 GB RAM)
     - Look for "1 free e2-micro instance per month" in the Always Free tier docs
   - **Boot disk:** Click **Change** → Ubuntu 22.04 LTS → Size: **30 GB** → Standard persistent disk
   - **Firewall:** Do NOT check "Allow HTTP traffic" or "Allow HTTPS traffic" — we'll use Tailscale for private access
5. Click **Create**

The VM takes about a minute to start. Note the **External IP** on the instances list.

::: warning Free tier limits
The e2-micro free tier includes 1 instance, 30GB disk, and 1GB egress/month to regions outside North America. Exceeding these limits incurs charges. Monitor your billing dashboard.
:::

## Step 3: Connect via SSH

Click the **SSH** button next to your VM in the Console, or from your local machine:

```bash
# Add your SSH key to the VM via the Console:
# Compute Engine → Metadata → SSH Keys → Add SSH Key
ssh your-username@<EXTERNAL_IP>
```

## Step 4: Install Crow

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Clone and set up Crow
git clone https://github.com/kh0pper/crow.git ~/crow
cd ~/crow
npm install
npm run setup
npm run init-db
```

Verify:
```bash
node servers/memory/index.js
# Should start without errors — press Ctrl+C to stop
```

## Step 5: Security Hardening

```bash
# Enable firewall — only allow SSH and Tailscale
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 41641/udp  # Tailscale
sudo ufw enable

# Install fail2ban
sudo apt install -y fail2ban
sudo systemctl enable fail2ban

# Disable SSH password auth (use keys only)
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# Enable automatic security updates
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Also remove the default GCP firewall rules that allow HTTP/HTTPS from anywhere:
1. Go to **VPC Network → Firewall** in the Google Cloud Console
2. Find `default-allow-http` and `default-allow-https`
3. Delete them (or set them to disabled) — Tailscale handles all access

## Step 6: Install Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the authentication URL. Once connected:

```bash
# Note your Tailscale IP
tailscale ip -4
```

Allow Crow's gateway port through UFW for Tailscale traffic:
```bash
# Allow port 3001 from Tailscale network only
sudo ufw allow from 100.64.0.0/10 to any port 3001
```

## Step 7: Start the Gateway

```bash
cd ~/crow

# Create a systemd service for persistence
# Replace YOUR_USERNAME with your actual username (run `whoami` to check)
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << 'EOF'
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/crow
ExecStart=/usr/bin/node servers/gateway/index.js --no-auth
Restart=always
RestartSec=5
Environment=PORT=3001

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable crow-gateway
sudo systemctl start crow-gateway
```

Verify:
```bash
sudo systemctl status crow-gateway
curl http://localhost:3001/health
```

## Step 8: Connect Your AI Platform

Your Crow server is now running and accessible via Tailscale. Connect it from any AI platform:

- [Claude Web & Mobile](../platforms/claude) — `http://<tailscale-ip>:3001/memory/mcp`
- [ChatGPT](../platforms/chatgpt) — `http://<tailscale-ip>:3001/memory/sse`
- [Gemini](../platforms/gemini) — `http://<tailscale-ip>:3001/memory/mcp`
- [Claude Code](../platforms/claude-code) — `http://<tailscale-ip>:3001/memory/mcp`
- [All platforms](../platforms/)

Visit `http://<tailscale-ip>:3001/setup` from a device on your Tailscale network to see integration status and endpoint URLs.

::: tip Try it out
After connecting your AI platform, say:

> "Remember that today is my first day using Crow"
> "What do you remember?"
:::

## Step 9: Chain with Oracle Cloud

If you have an [Oracle Cloud instance](./oracle-cloud) running Crow, you can chain them together so memories sync automatically and you can call tools on either from either.

### Export identity from Oracle Cloud

On your Oracle Cloud instance (the home instance):

```bash
cd ~/crow
npm run identity:export
```

Copy the export file to your Google Cloud instance:
```bash
scp ~/.crow/identity-export.enc your-username@<google-cloud-external-ip>:~/
```

### Import identity on Google Cloud

On Google Cloud:
```bash
cd ~/crow
npm run identity:import
# Enter the same passphrase used during export
```

Verify both have the same Crow ID:
```bash
npm run identity
# Should show the same crow:xxxxxxxxxx on both machines
```

### Register instances

Tell your AI on the **Oracle Cloud** instance:
```
"Register my Google Cloud instance as a satellite at http://<google-tailscale-ip>:3001,
hostname google-cloud, name Cloud Satellite"
```

Tell your AI on the **Google Cloud** instance:
```
"Register my Oracle Cloud instance as home at http://<oracle-tailscale-ip>:3001,
hostname oracle-cloud, name Oracle Home"
```

### Verify federation

On either machine:
```
"List instances"
```

You should see both listed. Test sync:
```
# On Oracle Cloud
"Remember that my Google Cloud satellite is working"

# On Google Cloud (wait a moment)
"Search memories for Google Cloud satellite"
```

The memory should appear on both instances.

::: tip What you get from chaining
- **Redundancy** — if one cloud goes down, the other has your data
- **Federation** — call tools on Oracle from Google Cloud and vice versa
- **Free tier stacking** — Oracle (1GB RAM) + Google Cloud (1GB RAM) = more capacity for separate workloads
:::

For the full multi-device reference, see [Multi-Device Quick Start](./multi-device).

## Optional: Make Your Blog Public

For public blog setup, see the [Oracle Cloud guide's blog section](./oracle-cloud#optional-make-your-blog-public) — the steps are identical for Google Cloud.

## What to Do If Compromised

1. **Stop the instance** — Compute Engine → VM Instances → Stop
2. **Backup your data** — if you can still SSH in: `cd ~/crow && npm run backup`
3. **Rotate SSH keys** — delete old keys from Console Metadata, add new ones
4. **Check logs** — `sudo grep "Failed password" /var/log/auth.log | tail -20`
5. **Re-image if needed** — delete and recreate the VM. Restore data with `npm run restore`
