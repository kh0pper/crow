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
