---
name: add-ons
description: Browse, install, update, and remove Crow add-ons
triggers:
  - add-on
  - addon
  - extension
  - install plugin
  - what add-ons
  - browse extensions
  - install the
tools:
  - crow-memory
  - filesystem
---

# Add-on Management

## When to Activate

- User asks what add-ons or extensions are available
- User wants to install, update, or remove an add-on
- User asks about extending Crow's functionality

## How Add-ons Work

Add-ons extend Crow with new dashboard panels, MCP servers, or skill files. They are listed in the official registry hosted on GitHub and can be installed with a single command.

**Add-on types:**
- `panel` — Dashboard panel (JS module + optional skill)
- `mcp-server` — External MCP server integration
- `skill` — Skill file only (behavioral prompt, no code)
- `bundle` — Multi-service bundle (Docker Compose)

## Workflows

### Browse Available Add-ons

1. Fetch the registry: `https://raw.githubusercontent.com/kh0pper/crow-addons/main/registry/add-ons.json`
2. List add-ons with name, description, type, and tags
3. Indicate which are already installed (check `~/.crow/installed.json`)

### Install an Add-on

1. Fetch the registry
2. Find the add-on by ID or name
3. Download files to the correct locations:
   - Panels → `~/.crow/panels/<id>.js`
   - Skills → download to `skills/<id>.md` in the Crow directory
   - MCP servers → add entry to the server registry
4. For panels: add the panel ID to `~/.crow/panels.json` (create if needed)
5. For MCP servers: run `npm run mcp-config` to regenerate `.mcp.json`
6. Record installation in `~/.crow/installed.json`
7. Report success and any restart requirements

### Remove an Add-on

1. Check `~/.crow/installed.json` for the add-on
2. Remove installed files (panel JS, skill MD)
3. For MCP servers: remove from server registry, run `npm run mcp-config`
4. For panels: remove from `~/.crow/panels.json`
5. Remove entry from `~/.crow/installed.json`

### Update Add-ons

1. Fetch the latest registry
2. Compare versions in `~/.crow/installed.json` with registry
3. For each outdated add-on: download new files, update `installed.json`

## Security Notes

- Only install add-ons from the official registry or sources the user trusts
- All file URLs in the registry are pinned to commit SHAs with SHA-256 checksums
- If a checksum doesn't match, abort the install and warn the user
- Panel JS runs in the Node process — same trust model as npm packages
- Always confirm with the user before downloading and installing

## File Locations

```
~/.crow/
  installed.json     — Track installed add-ons (version, date, type)
  panels/            — Third-party dashboard panels
  panels.json        — List of enabled panel IDs
```

## Dashboard Alternative

Non-technical users can browse and install add-ons from the Extensions panel in the dashboard at `/dashboard/extensions`.
