# Crow OS Architecture

Crow OS transforms a stock Raspberry Pi OS into a dedicated Crow appliance. It's not a custom Linux distribution — it's an installer script that configures standard components on top of Debian/Ubuntu.

## Design Philosophy

**Installer, not image.** Following the approach that Umbrel converged on, Crow OS uses a single install script rather than a custom OS image. Benefits:
- Users can apply OS security updates normally
- No custom kernel or init system to maintain
- Works on any Debian/Ubuntu ARM64 system, not just Raspberry Pi
- Lower maintenance burden than maintaining ISO images

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│              Browser (any device)            │
│         https://crow.local/setup            │
└──────────────────────┬──────────────────────┘
                       │ HTTPS (port 443)
┌──────────────────────▼──────────────────────┐
│                    Caddy                     │
│         Reverse proxy + TLS termination      │
│    (self-signed / Tailscale / Let's Encrypt) │
└──────────────────────┬──────────────────────┘
                       │ HTTP (port 3001)
┌──────────────────────▼──────────────────────┐
│              Crow Gateway (Node.js)          │
│  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Memory  │ │ Research │ │   Sharing    │  │
│  │ Server  │ │  Server  │ │   Server     │  │
│  └────┬────┘ └─────┬────┘ └──────┬───────┘  │
│       │            │             │           │
│  ┌────▼────┐ ┌─────▼────┐ ┌─────▼───────┐  │
│  │  Blog   │ │ Storage  │ │  Dashboard  │  │
│  │ Server  │ │  Server  │ │     UI      │  │
│  └────┬────┘ └─────┬────┘ └─────────────┘  │
│       │            │                         │
│  ┌────▼────────────▼────┐                   │
│  │    SQLite (local)     │                   │
│  │  ~/.crow/data/crow.db │                   │
│  └──────────────────────┘                   │
└─────────────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
┌──────────────┐ ┌──────────┐ ┌──────────┐
│   Ollama     │ │Nextcloud │ │  Immich  │
│  (Docker)    │ │ (Docker) │ │ (Docker) │
│  optional    │ │ optional │ │ optional │
└──────────────┘ └──────────┘ └──────────┘
```

## Data Directory Layout

All Crow data lives in `~/.crow/`, making the entire installation portable:

```
~/.crow/
├── app/                    # Git clone of Crow repo
├── data/
│   ├── crow.db             # SQLite database (all memories, research, blog, etc.)
│   └── identity.json       # Cryptographic identity (Ed25519 + secp256k1)
├── .env                    # API keys and configuration (permissions 600)
├── panels/                 # Installed dashboard panels
├── panels.json             # Enabled panels
├── installed.json          # Installed add-ons tracking
├── bundles/                # Installed bundle add-on files
│   ├── ollama/
│   │   ├── docker-compose.yml
│   │   └── .env
│   └── nextcloud/
│       ├── docker-compose.yml
│       └── .env
├── minio-data/             # MinIO storage (if storage enabled)
└── update.log              # Update history
```

## Installer Script

`scripts/crow-install.sh` performs these steps:

1. **System updates** — `apt update && apt upgrade`
2. **Node.js 20** — via NodeSource repository
3. **Docker + Docker Compose** — official install script
4. **Caddy** — reverse proxy with automatic TLS
5. **Avahi** — mDNS for `crow.local` hostname
6. **Crow setup** — clone repo, `npm run setup`, generate identity
7. **systemd services** — `crow-gateway.service` for auto-start
8. **Security hardening** — UFW firewall, ufw-docker, fail2ban

### Security Model

| Layer | Protection |
|---|---|
| **Network** | UFW deny-by-default, only ports 22 (SSH) and 443 (HTTPS) |
| **Docker** | `ufw-docker` utility resolves Docker/UFW conflict without breaking inter-container networking |
| **Authentication** | Gateway OAuth enabled by default, dashboard password required |
| **Secrets** | `~/.crow/.env` with permissions 600 |
| **SSH** | fail2ban monitors and blocks brute-force attempts |
| **TLS** | Self-signed by default, upgradeable to Tailscale or Let's Encrypt |

::: warning Why not `iptables: false`?
Setting `"iptables": false` in Docker's daemon.json is a common recommendation for Docker/UFW conflicts, but it **breaks inter-container networking**. Crow uses the `ufw-docker` utility instead, which adds proper UFW rules that work alongside Docker's iptables.
:::

## Bundle Lifecycle Manager

The `crow` CLI manages bundle add-ons:

```bash
crow bundle install <id>    # Copy files, pull images
crow bundle start <id>      # docker compose up -d
crow bundle stop <id>       # docker compose stop
crow bundle remove <id>     # Stop, remove images, clean files
crow bundle status          # List installed bundles
```

Bundle files are stored in `~/.crow/bundles/<id>/`. Each bundle has its own `docker-compose.yml` and `.env` file.

## Update Mechanism

`scripts/crow-update.sh` performs safe updates:

1. Save current git ref for rollback
2. `git pull --ff-only` (fails safely on conflicts)
3. `npm install` for new dependencies
4. `npm run init-db` for schema migrations
5. Restart `crow-gateway.service`
6. If gateway fails to start: automatic rollback to previous ref
7. Log results to `~/.crow/update.log`

## HTTPS Options

Progressively better HTTPS, from simplest to best:

| Option | Setup | Certificate | Requirement |
|---|---|---|---|
| Self-signed (default) | Automatic | Browser warning | None |
| Tailscale | `tailscale up` + update Caddyfile | Valid, automatic | Free Tailscale account |
| Let's Encrypt | Point domain DNS + update Caddyfile | Valid, automatic | Domain name |
| Cloudflare Tunnel | Install cloudflared + configure | Valid, automatic | Free Cloudflare account |

## ARM64 Compatibility

All core components run natively on ARM64. Bundle add-on compatibility:

| Bundle | ARM64 | Notes |
|---|---|---|
| Ollama | Yes | Use smaller models (llama3.2:1b) on Pi 4 |
| Nextcloud | Yes | Official ARM64 images |
| Immich | Limited | Check latest release for ARM64 support |
| MinIO | Yes | Official ARM64 images |
