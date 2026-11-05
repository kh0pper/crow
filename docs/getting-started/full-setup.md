---
title: Full Setup
---

# Full Setup

Run the complete Crow platform — gateway, Garage object storage, blog, and Crow's Nest — with a single Docker Compose command.

## What is this?

The full setup starts all Crow services together: the MCP gateway, [Garage](https://garagehq.deuxfleurs.fr/) object storage, and the Crow's Nest. This is the recommended way to run Crow if you want every feature available.

## Why would I want this?

- **Everything at once** — One command to start the full platform
- **File storage included** — Garage runs alongside the gateway, no separate setup needed
- **Blog ready** — Start publishing immediately after setup
- **Crow's Nest access** — Visual management from your browser

## Prerequisites

- Docker and Docker Compose installed
- Git (to clone the repository)
- A machine with at least 1 GB of RAM

## Step 1: Clone and Configure

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
cp .env.example .env
```

## Step 2: Edit Environment Variables

Open `.env` and set the required values:

```bash
# Garage (file storage) — the default object storage.
# The gateway's S3_* and the container's GARAGE_DEFAULT_* are ONE key pair: Garage
# creates that key on its first start, so both sides must match exactly.
S3_ENDPOINT=garage:3900        # "garage" for Docker Compose, 127.0.0.1:3900 outside Docker
S3_ACCESS_KEY=                 # = GARAGE_DEFAULT_ACCESS_KEY below
S3_SECRET_KEY=                 # = GARAGE_DEFAULT_SECRET_KEY below
S3_USE_SSL=false
S3_REGION=us-east-1            # must match s3_region in bundles/garage/garage.toml

# The Garage container's own secrets — all five are required; generate them with the
# commands below. Formats: the key ID is "GK" + 24 hex characters, the S3 secret and
# the RPC secret are 64 hex characters, the admin/metrics tokens are any long random
# string (64 hex is fine).
GARAGE_RPC_SECRET=
GARAGE_ADMIN_TOKEN=
GARAGE_METRICS_TOKEN=
GARAGE_DEFAULT_ACCESS_KEY=
GARAGE_DEFAULT_SECRET_KEY=

# Storage quota (in MB)
STORAGE_QUOTA_MB=1024
```

Generate the five Garage values and paste each line into `.env` — Compose does not expand `$(…)` inside an env file, so the values have to be literal there:

```bash
echo "GARAGE_DEFAULT_ACCESS_KEY=GK$(openssl rand -hex 12)"   # key ID: "GK" + 24 hex — copy as S3_ACCESS_KEY too
echo "GARAGE_DEFAULT_SECRET_KEY=$(openssl rand -hex 32)"     # 64 hex — copy as S3_SECRET_KEY too
echo "GARAGE_RPC_SECRET=$(openssl rand -hex 32)"             # 64 hex — Garage will not start without it
echo "GARAGE_ADMIN_TOKEN=$(openssl rand -hex 32)"
echo "GARAGE_METRICS_TOKEN=$(openssl rand -hex 32)"
```

The port belongs to `S3_ENDPOINT` (there is no `S3_PORT`), and the gateway's `S3_ACCESS_KEY` / `S3_SECRET_KEY` must be the same pair as `GARAGE_DEFAULT_ACCESS_KEY` / `GARAGE_DEFAULT_SECRET_KEY` — Garage creates that key on first start. Leave a `GARAGE_*` value blank and the Garage container stops on start (it refuses to run without an RPC secret), while the gateway itself still boots. Blog settings are managed via the `crow_blog_settings` MCP tool or the Crow's Nest — no env vars needed.

::: warning MinIO is no longer the default — and its image is no longer published
Garage became the default object storage on 2026-11-05. **MinIO's public images are gone:** Docker Hub and Quay refuse anonymous pulls as of that date, so a new deployment cannot download MinIO any more. MinIO now lives behind the `minio-legacy` compose profile.

**Already running MinIO?** Nothing changes in your data. Start the legacy profile instead of `storage`:

```bash
docker compose --profile cloud --profile minio-legacy up -d
```

Keep your existing `MINIO_ENDPOINT` / `MINIO_PORT` / `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` settings — the older `MINIO_*` names are still read when no `S3_*` setting is present — and stay there as long as you like.

**Moving data to Garage is not automated.** Crow has no MinIO-to-Garage export or import command: a `--profile storage` deployment starts with empty `garage-meta` / `garage-data` volumes, and stored files are not carried over. Existing deployments can therefore keep running `--profile minio-legacy` as their storage; new deployments should use `--profile storage` and the `S3_*` settings above.
:::

## Step 3: Start Everything

```bash
docker compose --profile cloud --profile storage up --build
```

This starts:

- **Gateway** on port `3001` — MCP server, blog, and API
- **Garage** — file storage; the S3 API stays on the compose network and only the admin API answers on `127.0.0.1:3903`
- **Crow's Nest** at `/dashboard` on the gateway

On first run, Docker downloads images and builds the gateway. Subsequent starts are faster.

## Step 4: Initialize the Database

In a separate terminal:

```bash
docker compose exec crow-gateway npm run init-db
```

This creates the SQLite database with all required tables.

## Step 5: Access Your Services

| Service | URL |
|---|---|
| Gateway health check | `http://localhost:3001/health` |
| Crow's Nest | `http://localhost:3001/dashboard` |
| Blog | `http://localhost:3001/blog` |

Browsing stored files happens in the Crow's Nest **Files** page — Garage has no web console of its own (its admin API on `127.0.0.1:3903` is for tools, not a browser).

## Step 6: Generate MCP Config

To use the storage server with Claude or other AI platforms:

```bash
npm run mcp-config
```

This regenerates `.mcp.json` with the storage server included (only if `S3_*` env vars are set).

## Running in the Background

To keep services running after you close the terminal:

```bash
docker compose --profile cloud --profile storage up --build -d
```

View logs:

```bash
docker compose logs -f crow-gateway
docker compose logs -f garage
```

Stop everything:

```bash
docker compose --profile cloud --profile storage down
```

## Persisted Data

Data is stored in Docker volumes:

- **crow-data** — SQLite database, identity files
- **garage-meta** / **garage-data** — Garage's metadata and all uploaded files

These persist across container restarts. To fully reset:

```bash
docker compose --profile cloud --profile storage down -v
```

This deletes all data. Use with caution.

## Adding Tailscale

For secure remote access, install Tailscale on the host machine (not inside Docker). See the [Tailscale Setup guide](/getting-started/tailscale-setup).

## Crow's Nest Password

The first time you visit the Crow's Nest (`/dashboard`), you'll be prompted to set a password. You can also set it from the `/setup` page or by asking your AI: "Set my Crow's Nest password."

::: tip First-run setup link
Until a password exists, the first-run pages ask for a one-time setup token, so someone else on your network cannot set the password first. The installer prints the setup URL with `?token=…` already in it; the same token is saved in `~/.crow/setup-token` (readable only by your account) if you need it again. Opening the page on the machine itself — `http://localhost:3001/setup`, or through an SSH tunnel — needs no token. The token stops working once the password is set.
:::

### Two-Factor Authentication (Optional)

You can enable TOTP-based 2FA from **Settings → Two-Factor Auth** in the Crow's Nest. This adds a second verification step using an authenticator app (Google Authenticator, Authy, etc.).

### Forgot Your Password?

If you get locked out, reset your password from the command line:

```bash
npm run reset-password
```

This prompts you for a new password and updates the database directly — no email or external service needed.

## Connect Your AI

Visit `http://localhost:3001/setup` to see integration status and endpoint URLs.

[Claude](/platforms/claude) · [ChatGPT](/platforms/chatgpt) · [All platforms](/platforms/)

**Try it out** — after connecting your AI platform, say:

> "Remember that today is my first day using Crow"
> "What do you remember?"

::: tip Chain multiple instances
Docker instances can be chained with other Crow installations — cloud VMs, desktops, or Raspberry Pis. Memories sync automatically via P2P. See [Multi-Device Quick Start](./multi-device).
:::

## Troubleshooting

**The gateway keeps restarting and the log says `Cannot find module '/prebuilds/linux-x64/rocksdb-native.node'`.** The prebuilt native addon links against `libatomic.so.1`, which minimal server and cloud images do not ship. Install it and restart the gateway:

```bash
sudo apt install libatomic1
docker compose restart crow-gateway
```

(If the installer set the gateway up as a service, use `sudo systemctl restart crow-gateway` instead.)

## Next Steps

- [Storage guide](/guide/storage) — Learn how to upload and manage files (Garage, the File Storage extension)
- [Blog guide](/guide/blog) — Start writing and publishing posts
- [Crow's Nest guide](/guide/crows-nest) — Explore the visual control panel
