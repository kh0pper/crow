---
title: Notion
---

# Notion

Connect Crow to Notion to search, read, and create pages and databases through your AI assistant.

## What You Get

- Search across your Notion workspace
- Read and create pages
- Query and update databases
- Add and read comments on pages

## Setup

### Step 1: Create an internal integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration**
3. Name it (e.g., "Crow") and select your workspace
4. Under **Type**, keep **Internal** selected
5. Click **Save**
6. Copy the **Internal Integration Secret** (starts with `ntn_`)

### Step 2: Share pages with the integration

Notion integrations can only access pages that have been explicitly shared with them:

1. Open a Notion page or database you want Crow to access
2. Click the **...** menu in the top-right corner
3. Click **Connections** → **Connect to** → find and select your integration
4. Repeat for each page or database

Child pages inherit the connection, so sharing a top-level page grants access to all its subpages.

### Step 3: Add to Crow

Paste your integration secret in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variable is `NOTION_TOKEN`.

## Required Permissions

Permissions are configured on the integration settings page at [notion.so/my-integrations](https://www.notion.so/my-integrations):

| Permission | Why |
|---|---|
| **Read content** | Search and read pages and databases |
| **Update content** | Edit existing pages and database entries |
| **Insert content** | Create new pages and database entries |
| **Read comments** | View comments on pages |
| **Insert comments** | Add comments to pages |

## Troubleshooting

### "object_not_found" error

The page or database hasn't been shared with your integration. Open the page in Notion, click **...** → **Connections**, and add your integration.

### Can't find pages in search

Notion search only returns pages that have been explicitly connected to the integration. Share the parent page to grant access to all subpages.

### Token starts with "secret_" instead of "ntn_"

Older Notion integrations used the `secret_` prefix. Both formats work — just paste the full token as-is.

## Sync Notion into Crow memory (local semantic search)

Notion's API (and its MCP server) only does **keyword** search. Crow's **semantic**
search runs over the `memories` table, not over Notion live. `scripts/sync-notion.js`
bridges the two: it pulls every page shared with your integration, converts it to
Markdown, and stores each as a memory (`category=learning`, `tags=notion,sync`). The
normal embedding pipeline then makes that content semantically searchable through
`crow_search_memories` / `crow_deep_recall` from any connected client.

It's **idempotent** — pages are deduped on `source = notion:<pageId>` and only re-embedded
when their Notion `last_edited_time` changes — and **inert** when `NOTION_TOKEN` is unset,
so instances that don't use Notion are unaffected.

### Run it

```bash
# Token must be in the environment (e.g. via --env-file=.env, Node >= 20):
npm run sync-notion -- --once --dry-run --limit 5   # preview decisions, no writes
npm run sync-notion -- --once                        # full sync
npm run sync-notion -- --once --force                # re-embed everything
```

Flags: `--dry-run` (show insert/update/skip, no writes), `--limit N` (cap pages),
`--force` (ignore `last_edited_time`). If the embedding provider is offline the pages
are still stored (keyword-searchable); run `node scripts/backfill-embeddings.js --only memories` later
to fill embeddings.

> One memory per page (v1). Very long, multi-topic pages are averaged into a single
> embedding and content past ~8000 chars is excluded from the *embedding* (still stored
> and keyword-searchable). The `source` key already supports a future per-section
> (`notion:<pageId>#<n>`) chunking upgrade with no schema change.

### Schedule it

Run the sync on a timer. A macOS launchd template is provided at
[`examples/notion-sync/com.crow.notion-sync.plist.example`](https://github.com/kh0pper/crow/blob/main/examples/notion-sync/com.crow.notion-sync.plist.example)
(fill in the placeholder paths, copy to `~/Library/LaunchAgents/`, `launchctl load`).

::: tip Why not crow_create_schedule?
The built-in scheduler only advances DB rows and emits notifications — it does not spawn
external scripts. Use an OS timer (launchd / systemd / cron) instead.
:::

**Linux (systemd user timer)** — `~/.config/systemd/user/crow-notion-sync.{service,timer}`:

```ini
# crow-notion-sync.service
[Service]
Type=oneshot
WorkingDirectory=%h/Developer/crow
ExecStart=/usr/bin/node --env-file=%h/Developer/crow/.env scripts/sync-notion.js --once

# crow-notion-sync.timer
[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
[Install]
WantedBy=timers.target
```
Enable with `systemctl --user enable --now crow-notion-sync.timer`.

**cron** (every 6 hours):

```cron
0 */6 * * * cd $HOME/Developer/crow && /usr/bin/node --env-file=.env scripts/sync-notion.js --once >> $HOME/.crow/logs/notion-sync.log 2>&1
```
