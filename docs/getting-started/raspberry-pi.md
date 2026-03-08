# Raspberry Pi Setup (Crow OS)

Turn a Raspberry Pi into a dedicated Crow appliance. No SSH required after initial setup — everything is configured through a web browser.

## Hardware Requirements

| | Minimum | Recommended |
|---|---|---|
| **Board** | Raspberry Pi 4 (4 GB) | Raspberry Pi 5 (8 GB) |
| **Storage** | 32 GB microSD | NVMe SSD via HAT |
| **Network** | Ethernet or Wi-Fi | Ethernet |
| **Power** | Official PSU | Official PSU |

**Resource usage:** Gateway ~100 MB RAM, SQLite negligible, Docker ~200 MB base. Each bundle add-on varies (Ollama needs 2-4 GB for models, Nextcloud ~500 MB).

## Step 1: Flash Raspberry Pi OS

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Select **Raspberry Pi OS Lite (64-bit)** — the desktop environment is not needed
3. Click the gear icon to pre-configure:
   - **Enable SSH** with password authentication
   - **Set username and password** (e.g., `crow` / your-password)
   - **Configure Wi-Fi** if not using Ethernet
   - **Set hostname** to `crow`
4. Flash to your SD card or SSD

## Step 2: First Boot and Connect

1. Insert the SD card, connect Ethernet (if using), power on
2. Wait ~2 minutes for first boot
3. Find your Pi on the network:
   ```bash
   # From another computer on the same network
   ping crow.local
   # Or check your router's DHCP client list
   ```
4. SSH in:
   ```bash
   ssh crow@crow.local
   ```

## Step 3: Run the Installer

One command installs everything:

```bash
curl -sSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
```

::: tip Prefer to inspect first?
```bash
curl -sSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh -o crow-install.sh
less crow-install.sh   # Review the script
bash crow-install.sh   # Run it
```
:::

The installer takes 5-10 minutes and sets up:
- Node.js 20, Docker, Caddy, Avahi (mDNS)
- Crow platform with SQLite database
- Cryptographic identity (Crow ID)
- systemd service for auto-start
- HTTPS via self-signed certificate
- Firewall (UFW) + fail2ban

## Step 4: Open the Setup Wizard

From any device on your network, open:

```
https://crow.local/setup
```

::: warning Browser Warning
You'll see a certificate warning because the self-signed cert isn't trusted by browsers. This is normal for local network access. Click "Advanced" → "Proceed" to continue. For valid certificates, set up [Tailscale](#optional-remote-access-with-tailscale) or add a domain.
:::

The setup wizard walks you through:
1. **Set dashboard password** — required before accessing the dashboard
2. **View your Crow ID** — your cryptographic identity for P2P sharing
3. **Configure integrations** — add API keys for GitHub, Gmail, etc.

## Step 5: Connect Your AI Platform

Your Crow instance is now running. Connect it from any AI platform:

**Claude Web/Mobile:** Settings → Integrations → Add Custom → `https://crow.local/memory/mcp`

**ChatGPT:** Settings → Apps → Create → `https://crow.local/memory/sse`

**Claude Code:** Add to `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "crow-memory": {
      "url": "https://crow.local/memory/mcp"
    }
  }
}
```

See the [Platforms guide](/platforms/) for all supported AI clients.

## Managing Your Crow

### Useful Commands

```bash
# Platform status
crow status

# View gateway logs
sudo journalctl -u crow-gateway -f

# Restart gateway
sudo systemctl restart crow-gateway

# Install a bundle add-on
crow bundle install ollama
crow bundle start ollama

# Update Crow
bash ~/.crow/app/scripts/crow-update.sh
```

### Dashboard

Access the visual dashboard at `https://crow.local/dashboard` — manage messages, blog posts, files, and settings from your browser.

### Installing Add-ons

Install self-hosted services as bundle add-ons:

```bash
crow bundle install ollama      # Local AI models
crow bundle install nextcloud   # File sync
crow bundle install immich      # Photo library
```

Or ask your AI: "Install the Ollama add-on."

## Optional: Remote Access with Tailscale

Access your Crow from anywhere with [Tailscale](https://tailscale.com) (free for personal use):

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Get your Tailscale hostname
tailscale status
```

Then update Caddy for automatic valid HTTPS certificates:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
crow.your-tailnet.ts.net {
    reverse_proxy localhost:3001
}
EOF
sudo systemctl restart caddy
```

See the [Tailscale Setup Guide](/getting-started/tailscale-setup) for detailed instructions.

## Optional: Custom Domain

If you have a domain, point it at your Pi's IP and update the Caddyfile:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
crow.yourdomain.com {
    reverse_proxy localhost:3001
}
EOF
sudo systemctl restart caddy
```

Caddy automatically provisions Let's Encrypt certificates.

## Troubleshooting

### Can't find crow.local

- Make sure Avahi is running: `sudo systemctl status avahi-daemon`
- mDNS may not work across VLANs — use the IP address directly
- On Windows, install [Bonjour Print Services](https://support.apple.com/kb/DL999) for mDNS support

### Gateway won't start

```bash
sudo systemctl status crow-gateway
sudo journalctl -u crow-gateway --no-pager -n 50
```

### Out of disk space

```bash
# Check disk usage
df -h

# Clean Docker images
docker system prune -a

# Check Crow data size
du -sh ~/.crow/data/
```

### Performance

- Use an NVMe SSD instead of microSD for dramatically better I/O performance
- The Pi 5 is ~2-3x faster than the Pi 4 for Node.js workloads
- If running Ollama, use the smallest models (llama3.2:1b, phi3:mini) — larger models will be very slow on ARM
