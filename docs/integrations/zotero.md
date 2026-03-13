---
title: Zotero
---

# Zotero

Connect Crow to Zotero to search your reference library and manage citations through your AI assistant.

## What You Get

- Search your Zotero library by title, author, or tag
- Browse collections and subcollections
- Retrieve full citation metadata for bibliography generation
- Access PDF attachments and notes

## Prerequisites

This integration requires **uvx** (Python package runner). Install it with:

```bash
# macOS
brew install uv

# Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Setup

### Step 1: Find your User ID

1. Go to [zotero.org/settings/keys](https://www.zotero.org/settings/keys)
2. Your **User ID** is displayed at the top of the page (a numeric value)

### Step 2: Create an API key

1. On the same page, click **Create new private key**
2. Name it (e.g., "Crow")
3. Under **Personal Library**, check:
   - **Allow library access**
   - **Allow notes access**
4. Under **Default Group Permissions**, select **Read Only** if you want access to group libraries
5. Click **Save Key**
6. Copy the API key from the confirmation page

### Step 3: Add to Crow

Paste both values in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variables are `ZOTERO_API_KEY` and `ZOTERO_USER_ID`.

## Required Permissions

| Permission | Why |
|---|---|
| **Allow library access** | Read items, collections, and metadata from your library |
| **Allow notes access** | Read notes attached to library items |

## Troubleshooting

### "403 Forbidden" error

Your API key may not have library access enabled. Go to [zotero.org/settings/keys](https://www.zotero.org/settings/keys), click on your key, and ensure **Allow library access** is checked.

### "uvx: command not found"

Install uv first (see Prerequisites above), then restart your terminal.

### Wrong User ID

The User ID is a number, not your username. Find it at the top of [zotero.org/settings/keys](https://www.zotero.org/settings/keys).
