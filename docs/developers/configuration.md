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
| `CROW_JOURNAL_MODE` | auto | SQLite journal mode. Unset, Crow picks `WAL`, or `DELETE` on low-RAM hosts (total memory ≤ `CROW_WAL_MIN_RAM_GB`, default 2 GiB — e.g. free-tier cloud VMs). Set explicitly to override the auto-selection; otherwise leave alone. The resolver reads the database's current mode first and only flips it when different, so a mode change never stalls connections. |
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
| `CROW_PROVIDERS_RECONCILE_MS` | `3600000` | Interval for the models.json → providers-DB reconcile (owner-asserted rows only; skipped entirely on `--no-auth` companions). |
| `CROW_MODELS_JSON` | *(unset = standard locations)* | Colon-separated override of the models.json search paths. Empty string = ignore all models.json files (hermetic tests / fresh-install audits). |
| `CROW_DISABLE_NOSTR` | *(unset)* | `1` disables all Nostr relay dialing (messaging transport). For scratch/test gateways: set together with `CROW_DISABLE_INSTANCE_SYNC=1` for a fully-offline boot. |
| `COMPANION_FAST_MODEL` | `crow-voice/qwen3.5-4b` | Fast voice-turn model for the AI Companion. |
| `COMPANION_ESCALATION_MODEL` | `crow-chat/qwen3.6-35b-a3b` | Escalation model (`!escalate` / tool turns). |
| `COMPANION_FAST_DISABLE_THINKING` | `1` | Disable chain-of-thought on voice turns. |
| `COMPANION_TOOL_ESCALATION` | `1` | Auto-escalate when tool use is detected. |
| `COMPANION_TOOL_CONTEXT_LOOKBACK` | `8` | Messages scanned for tool intent. |
| `COMPANION_PORT` | `12393` | Companion (Open-LLM-VTuber) server port. |
| `SDXL_SERVICE_URL` | `http://127.0.0.1:3005` | Image-generation service for storage tools. |
| `GPU_IDLE_CHECK_INTERVAL_MS` / `GPU_IDLE_REVERT_MS` | `120000` / `1200000` | GPU orchestrator idle polling / revert window. |

### Where model providers come from

The `providers` table in the database is the canonical registry every model
picker (Bot Builder, companion routing, the `/llm/v1` router) reads. It starts
**empty** on a fresh install — Crow does not ship a provider list. Providers
get in three ways:

1. **Model bundles** — installing a model bundle from Extensions registers its
   provider automatically (and uninstalling disables it).
2. **Cloud providers** — add manually in Settings → AI Models → Providers
   ("Add cloud provider").
3. **`models.json`** (advanced / recovery) — an operator-maintained file at
   `./models.json` or `./config/models.json` in the app tree (both gitignored;
   the seed/sync path also reads `~/.pi/agent/models.json`). On first boot with
   an empty providers table its entries seed the table; the "Sync bundle
   providers" button re-upserts entries this instance owns. See
   `models.example.json` in the repo root for the format. It is also the
   gateway's disaster-recovery fallback if the database is unreadable.

When no providers are configured, model pickers show an honest empty state and
link here — there is no built-in fallback model list.

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
| `CROW_PUSH_SEND_TIMEOUT_MS` | `10000` | Per-send cap for ntfy / email / web-push (a hung endpoint can no longer wedge notification delivery). |
| `RESEND_API_KEY` / `MPA_EMAIL_FROM` / `MPA_EMAIL_TO` | *(unset)* | Email notifications via Resend. |

## Sharing, P2P & calls

| Variable | Default | Purpose |
|---|---|---|
| `CROW_UNIFIED_DASHBOARD` | enabled | Federated dashboard across paired instances (`0` disables). |
| `CROW_DISABLE_INSTANCE_SYNC` | *(unset)* | `1` disables cross-instance sync entirely (Hypercore feeds, Hyperswarm DHT, tailnet-sync dialers). `--no-auth` gateways are always sync-disabled regardless. Pair with `CROW_DISABLE_NOSTR=1` for a fully-offline scratch/test boot. |
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
| `CROW_SSE_MAX` | `200` | Cap on concurrent open SSE streams across all stream endpoints; over the cap, requests get `503` + `Retry-After: 5`. |
| `CROW_SHUTDOWN_DRAIN_MS` | `3000` | How long graceful shutdown waits for in-flight requests before severing remaining connections. |
| `CROW_WAL_MIN_RAM_GB` | `2` | RAM threshold (GiB) below which the journal mode auto-selects `DELETE` instead of `WAL` (see `CROW_JOURNAL_MODE`). |
| `CROW_FILEVIEW_ROOT` | home directory | Root the dashboard markdown fileviewer may read. |
| `CROW_BUNDLES_DIR` | `~/.crow/bundles` | Installed-bundle directory. |

## Advanced / developer

These are intentionally **not** in `.env.example` — set them only if you know why:
`CROW_DISABLE_ROUTER` (=1 serves raw per-server tools instead of category tools), `CROW_ENABLE_TURBO` (=0 disables Turbo Drive), `CROW_DEFAULT_SERVER`, `CROW_SKIP_CONFIRM_GATES`, `CROW_SYNC_PROVIDERS`, `CROW_BUNDLE_HOST_ALLOW_ALL`, `STRICT_PANEL_MOUNT`, `CROW_PIPELINE_TRACE`, `CROW_PIPELINE_SUBPROCESS`, `CROW_REFCOUNT_PATH`, `CROW_PET_MODE`, `CROW_PET_SOCKET`, `BLOG_FIGURE_GATEWAY_URL`, `BLOG_FIGURE_PYTHON`, `RENDER_EXTERNAL_URL` (legacy Render deploys), `CROW_TASKS_DB_PATH`, `MPA_PROSPECTUS_INBOX`/`MPA_PROSPECTUS_OUT`, `JELLYFIN_URL`, `PLEX_URL`, `ROMM_PORT`, `BRAVE_API_KEY` (window-manager search). HTTP timeout overrides (in milliseconds, read once at startup): `CROW_HTTP_LLM_CONNECT_TIMEOUT_MS` (default 20000 — first-byte deadline for streaming LLM), `CROW_HTTP_AI_TIMEOUT_MS` (default 60000 — total cap for buffered embedding calls), `CROW_HTTP_TTS_TIMEOUT_MS` (default 10000 — first-byte deadline for TTS synthesis), `CROW_HTTP_VOICELIST_TIMEOUT_MS` (default 5000 — total cap for voice-list fetches).

## Integration API keys

Third-party integration keys (GitHub, Slack, Notion, Google Workspace, Discord, Trello, Canvas, Zotero, …) are documented inline in [`.env.example`](https://github.com/kh0pper/crow/blob/main/.env.example) with per-service setup links, and on each [integration page](/integrations/). Add one at a time; every one is optional.

## Bundle variables

Self-hosting bundles (Caddy, AdGuard, Gitea, Vaultwarden, SearXNG, Netdata, Uptime Kuma, …) read their own `*_PORT`/credential variables, documented in the bundle sections of `.env.example` and each bundle's manifest.

---

*This page is maintained by hand against the code. If you find a variable in the code that isn't listed here (or one listed that no longer exists), that's a bug — please file it.*
