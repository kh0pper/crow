# Oracle Cloud Free Tier (Recommended)

Oracle Cloud's Always Free tier gives you a permanent server that never sleeps, never expires, and costs nothing. Unlike other free hosting options, your data stays on local disk (no external database needed) and your server responds instantly — no cold starts.

::: tip Why Oracle Cloud?
- **Genuinely free** — the credit card is for identity verification only. You will not be charged.
- **Never sleeps** — your server is always on, always responsive
- **Local SQLite** — no external database service needed
- **47 GB disk** — more than enough for Crow and all your data
- **10 TB/month bandwidth** — more than most paid plans
:::

## Step 1: Create an Oracle Cloud Account

1. Go to [cloud.oracle.com](https://cloud.oracle.com) and click **Sign Up**
2. Enter your email and create a password
3. You'll need a credit card for verification — Oracle uses this to confirm you're a real person. The Always Free tier is genuinely free and you will not be charged.
4. Select your **home region** — pick the one closest to you for the lowest latency. This cannot be changed later.
5. Wait for your account to be provisioned (usually a few minutes)

## Step 2: Launch an Always Free Instance

1. Sign in to the [Oracle Cloud Console](https://cloud.oracle.com)
2. Go to **Compute → Instances → Create Instance**
3. Give your instance a name (e.g., `crow`)
4. **Image:** Select **Ubuntu 22.04 Minimal** (under "Change image" → Platform images)
5. **Shape:** Click **Change shape** → **Specialty and previous generation** → Select **VM.Standard.E2.1.Micro** (1 OCPU, 1 GB RAM)
   - Look for the "Always Free Eligible" badge — this confirms you won't be charged
6. **Networking:** The default VCN and public subnet are fine. Make sure "Assign a public IPv4 address" is checked.
7. **SSH key:** Click "Generate a key pair" and download both keys, or upload your own public key if you have one
8. Click **Create**

The instance takes 1-2 minutes to provision. Once the status shows "Running", note the **Public IP address** on the instance details page.

::: tip ARM instance (bonus)
Oracle also advertises an A1 ARM instance (4 OCPUs, 24 GB RAM) on the Always Free tier. Capacity is extremely limited — most regions are permanently full. The E2.1.Micro x86 instance described here is reliably available and runs Crow perfectly well.
:::

## Step 3: Connect via SSH

```bash
# If you downloaded Oracle's generated key
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<your-public-ip>

# If you uploaded your own key
ssh ubuntu@<your-public-ip>
```

## Step 4: Install Node.js

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git

# Verify
node --version   # Should be 20.x
npm --version
```

## Step 5: Install Crow

You can use the one-command installer or install manually.

**Option A: One-command installer (Recommended)**

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

**Option B: Manual install**

```bash
git clone https://github.com/kh0pper/crow.git ~/.crow/app
cd ~/.crow/app
npm run setup
```

::: warning Option B leaves things out
Option B does not set up the proxy socket Caddy uses, the bubblewrap sandbox for bots, automatic updates for Node, Docker and Caddy, the boot guard that rolls back a bad update, the firewall coming up first, or the Caddy admin socket. Option B is for people who know they want that.
:::

No external database needed — Crow uses local SQLite on Oracle's boot volume automatically.

## Step 6: Security Hardening

Your server is on the public internet. These steps protect it from common attacks.

### Oracle Security Lists (cloud firewall)

Oracle has its own firewall that controls what traffic can reach your instance. By default, only SSH (port 22) is open.

1. In the Oracle Cloud Console, go to **Networking → Virtual Cloud Networks**
2. Click your VCN → click your **Subnet** → click the **Security List**
3. Click **Add Ingress Rules** and add:

| Source CIDR | Protocol | Dest Port | Description |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `443` | HTTPS |

You only need port 22 (SSH, already open) and port 443 (HTTPS, for public blog if desired). Crow's gateway on port 3001 will be accessed through Tailscale, which doesn't need open ports.

### UFW (on-instance firewall)

::: tip
Skip this if you used Option A: the installer already did it. It opens 22 and 443 only.
:::

Defense in depth — a second firewall on the instance itself, in case Oracle's security list is misconfigured.

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 443/tcp    # HTTPS (for public blog)
sudo ufw allow 41641/udp  # Tailscale (WireGuard)
sudo ufw enable
```

### fail2ban (blocks brute-force SSH attempts)

::: tip
Skip this if you used Option A: the installer already did it.
:::

fail2ban watches your login logs and temporarily blocks IP addresses that fail too many login attempts. This stops automated password-guessing attacks.

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

### Disable SSH password authentication

SSH keys are much more secure than passwords. Since you used an SSH key to connect, you can safely disable password login:

```bash
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

::: warning
Only do this after confirming your SSH key login works. If you disable passwords and lose your key, you'll be locked out.
:::

### Automatic security updates

Keep the system patched automatically:

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Select "Yes" when prompted. The system will now install security updates automatically.

## Step 7: Install Tailscale

[Tailscale](https://tailscale.com) creates a private network between your devices using WireGuard encryption. Your Crow server becomes accessible from your phone, laptop, or any device on your Tailscale network — without opening any ports to the public internet.

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the link shown in your terminal to authorize the device in your Tailscale admin console.

**Set a memorable hostname:**

1. Go to your [Tailscale admin console](https://login.tailscale.com/admin/machines)
2. Click your Oracle instance → Edit → Rename to `crow`
3. Enable **MagicDNS** if not already enabled (under DNS settings)

Then put the gateway behind Tailscale Serve, which gives it a real HTTPS certificate on your tailnet. The firewall rules above don't open `3001` to the internet, and the systemd unit below runs with `NODE_ENV=production`, so its `Secure` session cookie needs Serve's HTTPS port:

```bash
sudo tailscale serve --bg --https=8444 http://localhost:3001
```

Your server is now accessible at `https://crow.your-tailnet.ts.net:8444` from any device on your Tailscale network (your hostname and tailnet name are the ones shown by `tailscale status`). Use `http://` URLs only on the machine itself.

For advanced Tailscale configuration, see the [Tailscale Setup Guide](./tailscale-setup).

## Step 8: Create a systemd Service

::: warning
Skip this step if you used Option A. The installer already wrote this service, with the proxy socket and the boot guard. Running the block below would overwrite it.
:::

The unit below is the plain manual version, for Option B. Run the Crow gateway as a background service that starts automatically on boot:

```bash
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << 'EOF'
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/.crow/app
ExecStart=/usr/bin/node servers/gateway/index.js
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now crow-gateway
```

Verify it's running:

```bash
sudo systemctl status crow-gateway
curl http://localhost:3001/health
```

::: tip Low-RAM hosts are handled automatically
On a 1 GB instance like the E2.1.Micro, Crow automatically selects SQLite's `DELETE` journal mode instead of `WAL` (the threshold is configurable via `CROW_WAL_MIN_RAM_GB`, default 2 GiB). No tuning needed — see the [configuration reference](../developers/configuration.md) if you want to override it.
:::

## Step 9: Connect Your AI Platform

Your Crow server is now running and accessible via Tailscale. Connect it from any AI platform:

- [Claude Web & Mobile](../platforms/claude) — `https://crow.your-tailnet.ts.net:8444/memory/mcp`
- [ChatGPT](../platforms/chatgpt) — `https://crow.your-tailnet.ts.net:8444/memory/sse`
- [Gemini](../platforms/gemini) — `https://crow.your-tailnet.ts.net:8444/memory/mcp`
- [Claude Code](../platforms/claude-code) — `https://crow.your-tailnet.ts.net:8444/memory/mcp`
- [All platforms](../platforms/)

Visit `https://crow.your-tailnet.ts.net:8444/setup` from a device on your Tailscale network to see integration status and endpoint URLs (the `tailscale serve` step in Step 7 is what makes that HTTPS address work).

::: tip Try it out
After connecting your AI platform, say:

> "Remember that today is my first day using Crow"
> "What do you remember?"
:::

## Optional: Make Your Blog Public

By default, everything is private behind Tailscale. If you want your blog accessible from the public internet, you have two options:

### Option A: Tailscale Funnel (no domain needed)

The simplest way — Tailscale serves your blog through their infrastructure.

```bash
# Enable Funnel in your Tailscale admin console first:
# https://login.tailscale.com/admin/dns → Enable Funnel

# Expose only the public blog paths
tailscale funnel --bg --set-path=/blog http://localhost:3001/blog
tailscale funnel --bg --set-path=/robots.txt http://localhost:3001/robots.txt
tailscale funnel --bg --set-path=/sitemap.xml http://localhost:3001/sitemap.xml
tailscale funnel --bg --set-path=/.well-known/ http://localhost:3001/.well-known/
```

Funnel publishes to the whole internet, so only these blog paths go on it — mapping `/` would expose the Crow's Nest dashboard login. The dashboard stays on `tailscale serve` (tailnet only, Step 7): Serve and Funnel share port `443` on the same host, so keep the dashboard on Serve's `8444` and let Funnel take `443`.

Your blog is now at `https://crow.your-tailnet.ts.net/blog`. The Crow's Nest remains private — a funneled request to any other path gets a 403.

### Option B: Caddy + Custom Domain

For a professional URL like `blog.yourdomain.com`.

**If you used Option A**, Caddy and its Caddyfile already exist. Do not replace the file. Open `/etc/caddy/Caddyfile` and change only the site name on the line that opens the block to your domain (for example `blog.yourdomain.com`). Remove the `tls internal` line in that block, so Caddy gets a Let's Encrypt certificate for your domain. Keep the `reverse_proxy unix//run/crow-proxy/gateway.sock` line and the global `admin` block. Then reload Caddy:

```bash
sudo systemctl reload caddy
```

**If you used the manual path** (Option B in Step 5), install Caddy first:

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Then write the Caddyfile with the same site block, dialing `localhost:3001`:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
blog.yourdomain.com {
    reverse_proxy localhost:3001
}
EOF

sudo systemctl restart caddy
```

::: warning Caddy on localhost:3001 is turned away
A Caddy that dials `localhost:3001` reaches the gateway as an unverified loopback connection, and the Crow's Nest turns it away. Once Caddy is running, run `sudo bash scripts/fix-caddy-proxy-socket.sh` in `~/.crow/app`. That switches it to the proxy socket.
:::

Point your domain's DNS A record to your Oracle instance's public IP. Caddy automatically provisions Let's Encrypt certificates. For detailed DNS setup instructions, see [Custom Domain Setup](./custom-domain).

Set the public URL in your `.env`:

```bash
echo 'CROW_GATEWAY_URL=https://blog.yourdomain.com' >> ~/.crow/app/.env
sudo systemctl restart crow-gateway
```

## Chain with Another Instance

Have another machine? Chain your Oracle Cloud instance with a [Google Cloud free tier VM](./google-cloud), a [Raspberry Pi](./raspberry-pi), or any other device for redundant, synced Crow across multiple machines.

See [Multi-Device Quick Start](./multi-device) for the full walkthrough.

## What to Do If Compromised

If you suspect unauthorized access:

1. **Rotate SSH keys** — generate a new key pair and update `~/.ssh/authorized_keys`
2. **Check login attempts** — `sudo grep "Failed password" /var/log/auth.log | tail -20`
3. **Check active sessions** — `who` and `last` to see logged-in users
4. **Review crontabs** — `crontab -l` and `sudo crontab -l` for unexpected scheduled tasks
5. **Re-image if needed** — Oracle lets you terminate and recreate instances. Your Crow data can be restored from a backup (`npm run backup` / `npm run restore`).
