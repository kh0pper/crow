---
title: Obsidian
---

# Obsidian

Connect Crow to your Obsidian vault to search notes and sync knowledge with your AI assistant.

## What You Get

- Search across all notes in your vault by content or filename
- Read note contents including frontmatter metadata
- Browse vault folder structure
- Sync research findings between Crow Projects and Obsidian

## Setup

### Step 1: Locate your vault path

Find the full path to your Obsidian vault on disk:

- **macOS**: Typically `~/Documents/ObsidianVault` or `~/Obsidian`
- **Linux**: Typically `~/Documents/ObsidianVault` or `~/obsidian`
- **Windows**: Typically `C:\Users\YourName\Documents\ObsidianVault`

You can find the exact path by opening Obsidian, clicking the vault icon in the bottom-left, and noting the path shown for your vault.

### Step 2: Add to Crow

Paste your vault path in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variable is `OBSIDIAN_VAULT_PATH`.

No API key is needed — this integration reads directly from your local filesystem.

## Required Permissions

| Permission | Why |
|---|---|
| Filesystem read access | Read notes, attachments, and folder structure from your vault |

The integration accesses vault files directly on disk. Obsidian does not need to be running.

## Troubleshooting

### "ENOENT: no such file or directory"

The vault path is incorrect or the directory doesn't exist. Double-check the full path, including the correct case for folder names on case-sensitive filesystems (Linux).

### Notes not found in search

Make sure the path points to the vault root (the folder containing the `.obsidian` directory), not a subfolder within the vault.

### Changes not reflected

The integration reads files directly from disk. If you just edited a note in Obsidian, the changes are available immediately — there's no sync delay.
