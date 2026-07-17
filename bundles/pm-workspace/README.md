# PM Workspace

Personal PM workspace bundle for Crow:

- **Notes** — markdown notes and pressure-sensitive **drawing notes**
  (Fabric.js + perfect-freehand whiteboard) with handwriting **OCR** via
  any OpenAI-style vision endpoint. Notes are FTS-searchable and indexed
  into crow memories (best-effort embeddings).
- **Daily digest** — one email/ntfy summary a day assembled from local
  boards (tasks bundle kanban + Bot Board trackers), the local Monday
  mirror, and optional Google Calendar/Drive. Box and Outlook adapters
  are stubs reserved for later phases.
- **Monday.com sync** — deterministic pull/merge engine: `mirror` boards
  copy into a Bot Board tracker; `twoway` boards three-way merge with
  the kanban tasks DB. Deletions are never propagated (flagged only).

Boards/kanban UI stays with the existing tasks bundle and Bot Board —
this bundle deliberately ships **no tracker tables and no board UI**.

## Configuration

Config is layered: `$CROW_HOME/env/pm-workspace.env` → the file named by
`PM_SECRETS_FILE` → `process.env` (highest wins). Files are plain
`KEY=VALUE` lines; `#` comments, a leading `export `, and single/double
quotes around values are all accepted, so an existing shell-style
secrets file works as-is.

| Key | Purpose |
|---|---|
| `PM_SECRETS_FILE` | Optional second env file (e.g. your existing secrets file) |
| `PM_RUN_CRON` | `1` = run digest/sync schedulers in this process. Enable on **exactly one** registration (normally the gateway's add-on entry) or two gateways sharing a DB will double-send |
| `OCR_VISION_URL` / `OCR_VISION_MODEL` / `OCR_VISION_API_KEY` | OpenAI-style vision endpoint for handwriting OCR (`<url>/chat/completions`; key defaults to `none` for local endpoints) |
| `PM_EMBED_URL` / `PM_EMBED_MODEL` | OpenAI-style embeddings endpoint (`<url>/embeddings`) for best-effort note embeddings into `memory_embeddings_blob` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Digest email transport; From = `SMTP_USER` (port 465 = implicit TLS, else STARTTLS) |
| `DIGEST_TO` | Digest recipient |
| `DIGEST_CRON` | Digest schedule, default `0 7 * * *` |
| `SYNC_CRON` | Sync schedule, default `*/15 * * * *` |
| `MONDAY_TOKEN` | Monday.com API v2 token |
| `SYNC_CONFIG_FILE` | Path to the sync config JSON (below) |
| `NTFY_TOPIC` / `NTFY_URL` | Optional ntfy push of the digest summary (default base `https://ntfy.sh`) |
| `GOOGLE_TOKEN_FILE` | Google OAuth2 `authorized_user` JSON (the format google-workspace-mcp writes). Access tokens are minted in memory via the refresh grant; nothing is written back |
| `CROW_GATEWAY_URL` | Used for the digest footer link |
| `CROW_TASKS_DB_PATH` | Kanban tasks DB, default `$CROW_DATA_DIR/tasks.db` |

Reserved for later phases (adapters currently stubs): `BOX_CLIENT_ID`,
`BOX_CLIENT_SECRET`, `BOX_FOLDER_IDS`, `MSGRAPH_CLIENT_ID`,
`MSGRAPH_CLIENT_SECRET`, `MSGRAPH_TENANT_ID`, `MSGRAPH_TOKEN_FILE`.

## How digest cron gating works

The schedulers only start when `PM_RUN_CRON=1` — set it **only in the
gateway's add-on registration** (mcp-addons.json env), not on every
client that spawns this server, or each spawned copy would try to
schedule. A 60s tick fires the digest once the most recent
`DIGEST_CRON` occurrence for today has passed **and** `pm_digests` has
no row for today; that row-gate doubles as startup catch-up (a server
booted at 9:00 with a 7:00 cron still sends once) and restart
protection (never twice). Sync fires when the most recent `SYNC_CRON`
occurrence is newer than the last run (seeded from `pm_sync_log` on
boot). Manual paths (`crow_pm_digest_send`, `crow_pm_sync_run`, the
panel buttons) work with crons disabled.

## Sync config (`SYNC_CONFIG_FILE`)

```json
{
  "boards": [
    {
      "board_id": "1234567890",
      "mode": "mirror",
      "target": { "kind": "tracker", "slug": "team-campaign" },
      "group_ids": ["topics"],
      "column_map": {
        "status": { "field": "stage", "team_visible": true },
        "date4": { "field": "due", "team_visible": true },
        "text8": { "field": "owner", "team_visible": true }
      },
      "status_map": { "Working on it": "active", "Done": "done", "Stuck": "blocked" },
      "status_default": "other",
      "status_column_id": "status"
    },
    {
      "board_id": "9876543210",
      "mode": "twoway",
      "target": { "kind": "kanban", "project_id": 1 },
      "group_ids": ["group_mine"],
      "phase_from_status": true,
      "column_map": {
        "text": { "field": "description", "team_visible": true },
        "date4": { "field": "due_date", "team_visible": true },
        "person": { "field": "owner", "team_visible": false }
      },
      "status_map": {
        "Not started": "pending",
        "Working on it": "in_progress",
        "TEA review": "in_progress",
        "Done": "done"
      },
      "status_column_id": "status"
    }
  ]
}
```

Field reference:

- `board_id` — Monday board id (string or number).
- `mode` — `mirror` (pull-only into a tracker) or `twoway` (three-way
  merge with kanban `tasks_items`; requires a `kanban` target).
- `target` — `{ "kind": "tracker", "slug": "…" }` or
  `{ "kind": "kanban", "project_id": N }`. `project_id` also scopes
  which local kanban rows are pushed up as new Monday items; omit it
  and local-side creation is skipped.
- `column_map` — Monday column id → `{ field, team_visible }`. Kanban
  fields: `title`, `description`, `due_date`, `priority`, `owner`,
  `tags`, `phase`. Only `team_visible: true` fields are ever pushed to
  Monday (and `phase` never pushes).
- `status_map` — Monday status **label text** → local status.
  On push, the reverse mapping is used, and status is pushed only when
  the local status actually differs from what the remote label maps to.
- `status_column_id` — the Monday status column id (required with
  `status_map`).
- `group_ids` *(optional)* — only pull items whose Monday group id is
  in this list (filtered client-side). Note: an item moved out of a
  listed group looks like a deletion and gets flagged, not deleted.
- `phase_from_status` *(optional, twoway/kanban)* — additionally write
  the raw Monday status label into `tasks_items.phase`, preserving the
  fine-grained stage (e.g. "TEA review") that the coarse
  pending/in_progress/done kanban status loses. Phase never pushes
  back.
- `status_default` *(optional, mirror)* — local status for Monday
  labels missing from `status_map` (instead of logging an unmapped
  warning and keeping the raw label).

Conflict policy (twoway): remote-newer updates local; local-newer
pushes `team_visible` fields; both-changed → Monday wins on
`team_visible` fields, local wins on the rest, logged as `conflict`.
Deletions on either side are logged (`delete_flagged`) and never
propagated. Every action lands in `pm_sync_log`.

## Panel

`/dashboard/pm-workspace` — overview (due/overdue, last digest, sync
health), notes (list + editors), digests (history + preview/run), sync
(log tail + manual run). Editors live at `/pm/notes/new` (drawing) and
`/pm/notes/new-md` (markdown); they autosave and post large drawing
snapshots as `text/plain` JSON to stay under the gateway's 1mb JSON
parser cap.

## Notes on storage

- Tables: `pm_notes` (+FTS), `pm_digests`, `pm_sync_state`,
  `pm_sync_log` in crow.db. Drawing PNGs land in
  `$CROW_DATA_DIR/pm-workspace/notes/<id>.png`.
- Sync writes `tasks_items` (tasks.db) and `tracker_items` (crow.db)
  with plain SQL under `busy_timeout=10000`. Bot-board processing
  leases are advisory conventions between bots; sync writes are
  idempotent upserts and simply re-converge next run.
