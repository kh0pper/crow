# Google Cloud Guide + Chaining Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Google Cloud free tier setup guide and improve multi-instance chaining documentation visibility across the Crow docs site.

**Architecture:** Documentation-only changes — 2 new VitePress pages, updates to 6 existing pages, sidebar config updates. No code changes.

**Tech Stack:** VitePress markdown, YAML frontmatter

**Spec:** `docs/superpowers/specs/2026-03-20-google-cloud-guide-and-chaining-docs.md`

---

### Task 1: Create Google Cloud Free Tier Guide

**Files:**
- Create: `docs/getting-started/google-cloud.md`

- [ ] **Step 1: Write the guide**

Create `docs/getting-started/google-cloud.md` with this structure (follow the Oracle Cloud guide pattern at `docs/getting-started/oracle-cloud.md`):

```markdown
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

## What to Do If Compromised

1. **Stop the instance** — Compute Engine → VM Instances → Stop
2. **Backup your data** — if you can still SSH in: `cd ~/crow && npm run backup`
3. **Rotate SSH keys** — delete old keys from Console Metadata, add new ones
4. **Check logs** — `sudo grep "Failed password" /var/log/auth.log | tail -20`
5. **Re-image if needed** — delete and recreate the VM. Restore data with `npm run restore`
```

- [ ] **Step 2: Commit**

```bash
git add docs/getting-started/google-cloud.md
git commit -m "docs: add Google Cloud free tier setup guide with chaining walkthrough"
```

---

### Task 2: Create Spanish Locale Stub

**Files:**
- Create: `docs/es/getting-started/google-cloud.md`

- [ ] **Step 1: Write the stub**

```markdown
---
title: Google Cloud Nivel Gratuito
description: Configura Crow en la VM e2-micro siempre gratuita de Google Cloud
---

# Google Cloud Nivel Gratuito

Configura Crow en la VM e2-micro siempre gratuita de Google Cloud con Tailscale y encadénalo con tus otras instancias.

Ver la [versión en inglés](/software/crow/getting-started/google-cloud) para la documentación completa.
```

- [ ] **Step 2: Commit**

```bash
git add docs/es/getting-started/google-cloud.md
git commit -m "docs: add Spanish locale stub for Google Cloud guide"
```

---

### Task 3: Update VitePress Sidebar Config

**Files:**
- Modify: `docs/.vitepress/config.ts`

- [ ] **Step 1: Add English sidebar entry**

In the Getting Started `items` array, immediately after `{ text: 'Oracle Cloud Free Tier', link: '/getting-started/oracle-cloud' }` and before `{ text: 'Home Server', link: '/getting-started/home-server' }`, add:

```typescript
{ text: 'Google Cloud Free Tier', link: '/getting-started/google-cloud' },
```

- [ ] **Step 2: Add Spanish sidebar entry**

In the `es` locale sidebar's `Primeros Pasos` items, immediately after `{ text: 'Oracle Cloud Nivel Gratuito', link: '/es/getting-started/oracle-cloud' }`, add:

```typescript
{ text: 'Google Cloud Nivel Gratuito', link: '/es/getting-started/google-cloud' },
```

- [ ] **Step 3: Commit**

```bash
git add docs/.vitepress/config.ts
git commit -m "docs: add Google Cloud to VitePress sidebar (EN + ES)"
```

---

### Task 4: Update Getting Started Overview

**Files:**
- Modify: `docs/getting-started/index.md`

- [ ] **Step 1: Read the file**

Read `docs/getting-started/index.md` to find the deployment options list.

- [ ] **Step 2: Add Google Cloud entry**

Add Google Cloud to the deployment options list, after Oracle Cloud. Match the existing entry format:

```markdown
### Google Cloud Free Tier

A permanent free VM (1GB RAM, 30GB disk) in the US. Great as a secondary instance for multi-cloud chaining with Oracle Cloud.

> [Google Cloud Setup Guide](./google-cloud)
```

- [ ] **Step 3: Add multi-instance chaining callout**

Add a callout box (VitePress `:::` syntax) after the deployment options:

```markdown
::: info Multi-Instance Chaining
Run Crow on **multiple free-tier clouds** and chain them together. Your memories sync automatically, and you can call tools on any instance from any other. Set up [Oracle Cloud](./oracle-cloud) + [Google Cloud](./google-cloud), then [chain them](./multi-device).
:::
```

- [ ] **Step 4: Commit**

```bash
git add docs/getting-started/index.md
git commit -m "docs: add Google Cloud + chaining callout to Getting Started overview"
```

---

### Task 5: Update Free Hosting Comparison

**Files:**
- Modify: `docs/getting-started/free-hosting.md`

- [ ] **Step 1: Read the file and find the comparison table**

- [ ] **Step 2: Add Google Cloud row**

Add to the comparison table:

| Provider | Always Free | Specs | Limitation | Recommended |
|----------|-------------|-------|------------|-------------|
| Google Cloud | Yes | e2-micro (0.25 vCPU, 1GB RAM, 30GB disk) | US regions only | Yes (secondary/satellite) |

- [ ] **Step 3: Update narrative**

Add to the "Which Should I Choose?" or summary section:

```markdown
**Our recommendation:** Start with [Oracle Cloud](./oracle-cloud) as your primary instance — it has more RAM and is reliably available. Then add [Google Cloud](./google-cloud) as a satellite and [chain them together](./multi-device) for redundancy and federation. Two always-free clouds, synced automatically.
```

- [ ] **Step 4: Commit**

```bash
git add docs/getting-started/free-hosting.md
git commit -m "docs: add Google Cloud to free hosting comparison"
```

---

### Task 6: Add Chaining Callout to Oracle Cloud Guide

**Files:**
- Modify: `docs/getting-started/oracle-cloud.md`

- [ ] **Step 1: Read the end of the file**

Read `docs/getting-started/oracle-cloud.md` to find the "What to Do If Compromised" section (last section).

- [ ] **Step 2: Add callout before the compromised section**

Insert before "## What to Do If Compromised":

```markdown
## Chain with Another Instance

Have another machine? Chain your Oracle Cloud instance with a [Google Cloud free tier VM](./google-cloud), a [Raspberry Pi](./raspberry-pi), or any other device for redundant, synced Crow across multiple machines.

See [Multi-Device Quick Start](./multi-device) for the full walkthrough.
```

- [ ] **Step 3: Commit**

```bash
git add docs/getting-started/oracle-cloud.md
git commit -m "docs: add multi-instance chaining callout to Oracle Cloud guide"
```

---

### Task 7: Add Concrete Example to Multi-Device Guide

**Files:**
- Modify: `docs/getting-started/multi-device.md`

- [ ] **Step 1: Read the existing file**

Read `docs/getting-started/multi-device.md` — keep the existing generic server-a/server-b walkthrough intact.

- [ ] **Step 2: Add Oracle + Google Cloud example**

Insert a new section **before** the existing "## Troubleshooting" section (line ~136):

```markdown
## Example: Oracle Cloud + Google Cloud

A common setup is Oracle Cloud (home, 1GB RAM) + Google Cloud (satellite, 1GB RAM) — two always-free clouds chained together.

### Setup

| Instance | Role | IP (Tailscale) | Guide |
|----------|------|----------------|-------|
| Oracle Cloud | Home | `100.x.x.x` | [Setup guide](./oracle-cloud) |
| Google Cloud | Satellite | `100.y.y.y` | [Setup guide](./google-cloud) |

Follow the Google Cloud guide's [Step 9: Chain with Oracle Cloud](./google-cloud#step-9-chain-with-oracle-cloud) for the complete walkthrough.

### What you get

- **Redundancy** — memories exist on both clouds
- **Federation** — query Oracle's projects from Google Cloud
- **Free tier stacking** — separate workloads across two machines
- **Geographic distribution** — Oracle (your home region) + Google Cloud (US)
```

- [ ] **Step 3: Add troubleshooting items**

Add to the existing Troubleshooting section:

```markdown
### Tailscale not connecting between clouds

- Verify both machines are on the same Tailscale network: `tailscale status` on both
- Check that UDP port 41641 is open on both (required for direct connections)
- Try `tailscale ping <other-ip>` to test connectivity
- If using Google Cloud, verify the VPC firewall allows Tailscale UDP traffic

### Gateway health check fails from remote machine

- Verify the gateway is running: `curl http://localhost:3001/health` on the machine itself
- Check UFW: `sudo ufw status` — port 3001 should be allowed from `100.64.0.0/10` (Tailscale)
- Check cloud firewall rules (Oracle Security Lists / Google VPC Firewall)
```

- [ ] **Step 4: Commit**

```bash
git add docs/getting-started/multi-device.md
git commit -m "docs: add Oracle+Google Cloud example and troubleshooting to multi-device guide"
```

---

### Task 8: Add "Why Chain?" Section to Instances Guide

**Files:**
- Modify: `docs/guide/instances.md`

- [ ] **Step 1: Read the opening of the file**

Read `docs/guide/instances.md` to understand the existing opening content.

- [ ] **Step 2: Add "Why Chain Instances?" after the opening paragraph**

Insert after the opening paragraph (before "## What is an Instance?"):

```markdown
## Why Chain Instances?

| Benefit | How it helps |
|---------|-------------|
| **Redundancy** | If one instance goes down, your data is safe on the other |
| **Free tier stacking** | Combine Oracle Cloud + Google Cloud for 2GB total RAM at zero cost |
| **Project isolation** | Dedicate instances to different workstreams (research on one, data scraping on another) |
| **Geographic distribution** | Place instances in different regions for lower latency |
| **Offline resilience** | Satellites work independently when disconnected, then sync when reconnected |

The simplest chain is two always-free cloud VMs: [Oracle Cloud](../getting-started/oracle-cloud) as home + [Google Cloud](../getting-started/google-cloud) as satellite. See the [Multi-Device Quick Start](../getting-started/multi-device) to set it up in 15 minutes.
```

- [ ] **Step 3: Commit**

```bash
git add docs/guide/instances.md
git commit -m "docs: add 'Why Chain Instances?' section with value proposition"
```

---

### Task 9: Final Review and Push

- [ ] **Step 1: Verify all new pages exist**

```bash
ls docs/getting-started/google-cloud.md \
   docs/es/getting-started/google-cloud.md
```

- [ ] **Step 2: Check for broken links**

```bash
grep -r "google-cloud" docs/ --include="*.md" | head -20
grep -r "multi-device" docs/ --include="*.md" | head -20
```

- [ ] **Step 3: Push all commits**

```bash
git push origin main
```

- [ ] **Step 4: Deploy to all devices**

```bash
ssh black-swan "cd ~/crow && git pull origin main"
```

Note: grackle is the working directory (already has changes). Managed hosting deploys automatically via GitHub Pages on push.
