# Configuration Reference

Every environment variable Crow reads, in one place. Crow follows a **zero-config-first** philosophy: the gateway boots with no `.env` at all, using the defaults below. Set variables only when you need the feature they unlock.

Configuration lives in `.env` at the repo root (copied from `.env.example` by `npm run setup`). After editing, run `npm run mcp-config` to regenerate the MCP client config, and restart the gateway.

::: tip Day-1 essentials
A brand-new operator usually only ever touches these: `CROW_GATEWAY_URL` (remote access), `MINIO_ENDPOINT` + `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (file storage), and one or two integration API keys. Everything else has a working default.
:::

## Core (paths, ports, identity)

| Variable | Default | Purpose |
|---|---|---|
| `CROW_HOME` | `~/.crow` | Config/data base directory. A second instance on one machine uses its own (e.g. `~/.crow-mpa`). |
| `CROW_DATA_DIR` | `~/.crow/data` | SQLite data root. |
| `CROW_DB_PATH` | `~/.crow/data/crow.db` | Main database file. |
| `CROW_GATEWAY_PORT` / `PORT` | `3001` | Gateway listen port. |
| `CROW_GATEWAY_BIND` | `0.0.0.0` | Gateway bind address. |
| `CROW_GATEWAY_URL` | *(unset = local-only)* | Public URL of this instance (e.g. your `*.ts.net` HTTPS address). Required for remote MCP clients and OAuth. |
| `CROW_DEVICE_ID` | *(unset)* | Device identity for per-device crow.md overrides (e.g. `laptop`). |
| `CROW_FILES_PATH` | `/home` | Root the filesystem MCP server may access (used by `npm run mcp-config`). |
| `CROW_JOURNAL_MODE` | `WAL` | SQLite journal mode. Leave alone. |
| `NODE_ENV` | `development` | Set `production` on deployed instances. |

## Gateway, auth & access

| Variable | Default | Purpose |
|---|---|---|
| `CROW_DASHBOARD_PUBLIC` | `false` | Escape hatch that lets funneled traffic reach the dashboard. **Leave off** — the network-exposure invariant depends on it. |
| `CROW_ALLOWED_IPS` | *(unset)* | Extra CIDR allowlist for dashboard access (e.g. a reverse proxy). |
| `CROW_SETUP_TOKEN` | *(unset)* | Required token for first-run password setup when set. |
| `CROW_CSRF_STRICT` | enabled | Set `0` only as an emergency CSRF kill-switch. |
| `CORS_ALLOWED_ORIGINS` | *(unset)* | Comma-separated CORS origin allowlist. |
| `CROW_ENROLL_ENABLED` | `0` | Allow new instance enrollment (pairing). Enable only while pairing. |
| `CROW_ENROLL_OTC` | *(unset)* | One-time code required for enrollment when set. |
| `CROW_HOSTED` / `CROW_HOSTING_API_URL` / `CROW_HOSTING_AUTH_TOKEN` | *(unset)* | Managed-hosting mode only. |
| `CROW_CROWDSEC_BOUNCER_KEY` / `CROW_CROWDSEC_LAPI_URL` | *(unset)* / `http://127.0.0.1:8091` | CrowdSec bouncer integration (optional bundle). |

## AI & models

| Variable | Default | Purpose |
|---|---|---|
| `CROW_ORCHESTRATOR_PROVIDER` / `CROW_ORCHESTRATOR_MODEL` | *(DB `providers` table first)* | Default provider/model for the orchestrator. Prefer configuring providers in Settings → AI. |
| `COMPANION_FAST_MODEL` | `crow-voice/qwen3.5-4b` | Fast voice-turn model for the AI Companion. |
| `COMPANION_ESCALATION_MODEL` | `crow-chat/qwen3.6-35b-a3b` | Escalation model (`!escalate` / tool turns). |
| `COMPANION_FAST_DISABLE_THINKING` | `1` | Disable chain-of-thought on voice turns. |
| `COMPANION_TOOL_ESCALATION` | `1` | Auto-escalate when tool use is detected. |
| `COMPANION_TOOL_CONTEXT_LOOKBACK` | `8` | Messages scanned for tool intent. |
| `COMPANION_PORT` | `12393` | Companion (Open-LLM-VTuber) server port. |
| `SDXL_SERVICE_URL` | `http://127.0.0.1:3005` | Image-generation service for storage tools. |
| `GPU_IDLE_CHECK_INTERVAL_MS` / `GPU_IDLE_REVERT_MS` | `120000` / `1200000` | GPU orchestrator idle polling / revert window. |

## Storage (MinIO / S3)

| Variable | Default | Purpose |
|---|---|---|
| `MINIO_ENDPOINT` | *(unset = storage disabled)* | MinIO host (or host:port). |
| `MINIO_PORT` | from endpoint | Port override. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `crowadmin` / *(required)* | Credentials. |
| `MINIO_USE_SSL` | `false` | TLS to MinIO. |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | *(unset)* | Any S3-compatible alternative to MinIO. |
| `MAX_UPLOAD_SIZE` | `104857600` (100 MB) | HTTP upload cap (bytes). |
| `STORAGE_QUOTA_MB` | `5120` | Per-user quota. |

## Notifications & push

| Variable | Default | Purpose |
|---|---|---|
| `NTFY_HOST` / `NTFY_PORT` | `localhost` / `2586` | ntfy server for phone push. |
| `NTFY_TOPIC` | *(unset = disabled)* | Topic to publish to. |
| `NTFY_AUTH_TOKEN` / `NTFY_EXTERNAL_URL` / `NTFY_EXTRA_TOPICS` | *(unset)* | Auth, external URL for links, extra topics. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(unset = PWA push disabled)* | Web Push keys (`npx web-push generate-vapid-keys`). |
| `VAPID_EMAIL` | `mailto:admin@localhost` | VAPID contact. |
| `RESEND_API_KEY` / `MPA_EMAIL_FROM` / `MPA_EMAIL_TO` | *(unset)* | Email notifications via Resend. |

## Sharing, P2P & calls

| Variable | Default | Purpose |
|---|---|---|
| `CROW_UNIFIED_DASHBOARD` | enabled | Federated dashboard across paired instances (`0` disables). |
| `CROW_PEER_TOKENS_PATH` | per-`CROW_HOME` | Peer credential file override (multi-gateway hosts). |
| `CROW_CALLS_ENABLED` | `0` | WebRTC calls feature. |
| `CROW_CALLS_MAX_PEERS` | `4` | Max peers per call room. |
| `WEBRTC_TURN_URL` / `TURN_SECRET` | *(unset)* | TURN relay for NAT traversal. |

## Backup & ops

| Variable | Default | Purpose |
|---|---|---|
| `CROW_BACKUP_DIR` | `~/.crow/backups` | Output of `POST /api/admin/backup` (localhost-only endpoint). |
| `CROW_BACKUP_KEEP_DAYS` | `7` | Retention. |
| `CROW_BACKUP_TOKEN` | *(unset)* | Extra bearer requirement for the backup endpoint. |
| `CROW_AUTO_UPDATE` | enabled | Pull-based auto-update (`0` disables). |
| `CROW_FILEVIEW_ROOT` | home directory | Root the dashboard markdown fileviewer may read. |
| `CROW_BUNDLES_DIR` | `~/.crow/bundles` | Installed-bundle directory. |

## Advanced / developer

These are intentionally **not** in `.env.example` — set them only if you know why:
`CROW_DISABLE_ROUTER` (=1 serves raw per-server tools instead of category tools), `CROW_ENABLE_TURBO` (=0 disables Turbo Drive), `CROW_DEFAULT_SERVER`, `CROW_SKIP_CONFIRM_GATES`, `CROW_SYNC_PROVIDERS`, `CROW_BUNDLE_HOST_ALLOW_ALL`, `STRICT_PANEL_MOUNT`, `CROW_PIPELINE_TRACE`, `CROW_PIPELINE_SUBPROCESS`, `CROW_REFCOUNT_PATH`, `CROW_PET_MODE`, `CROW_PET_SOCKET`, `BLOG_FIGURE_GATEWAY_URL`, `BLOG_FIGURE_PYTHON`, `RENDER_EXTERNAL_URL` (legacy Render deploys), `CROW_TASKS_DB_PATH`, `MPA_PROSPECTUS_INBOX`/`MPA_PROSPECTUS_OUT`, `JELLYFIN_URL`, `PLEX_URL`, `ROMM_PORT`, `BRAVE_API_KEY` (window-manager search).

## Integration API keys

Third-party integration keys (GitHub, Slack, Notion, Google Workspace, Discord, Trello, Canvas, Zotero, …) are documented inline in [`.env.example`](https://github.com/kh0pper/crow/blob/main/.env.example) with per-service setup links, and on each [integration page](/integrations/). Add one at a time; every one is optional.

## Bundle variables

Self-hosting bundles (Caddy, AdGuard, Gitea, Vaultwarden, SearXNG, Netdata, Uptime Kuma, …) read their own `*_PORT`/credential variables, documented in the bundle sections of `.env.example` and each bundle's manifest.

---

*This page is maintained by hand against the code. If you find a variable in the code that isn't listed here (or one listed that no longer exists), that's a bug — please file it.*
