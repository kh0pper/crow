---
title: Creating Add-ons
---

# Creating Add-ons

Build reusable extensions for the Crow platform. Add-ons package panels, MCP servers, skills, or combinations of these into installable units.

## What is this?

A Crow add-on is a packaged extension that other users can install. It follows a standard format with a manifest file, so the platform knows what it contains and how to set it up.

## Why would I want this?

- **Share your work** — Package a custom panel, server, or skill for others to use
- **Reusable bundles** — Combine related components (e.g., a server + skill + panel) into one installable package
- **Community ecosystem** — Contribute to the Crow add-on registry

## Add-on Types

| Type | What it contains | Installed to |
|---|---|---|
| `panel` | Crow's Nest panel | `~/.crow/panels/` |
| `mcp-server` | MCP server (factory + stdio) | `~/.crow/servers/` |
| `skill` | Skill markdown file | `~/.crow/skills/` |
| `bundle` | Multiple components | Each to its respective location |

## manifest.json

Every add-on has a `manifest.json` at its root:

```json
{
  "name": "crow-weather-panel",
  "version": "1.0.0",
  "type": "panel",
  "description": "Weather panel showing local forecast",
  "author": "Your Name",
  "license": "MIT",
  "crow": {
    "minVersion": "1.0.0"
  },
  "components": [
    {
      "type": "panel",
      "id": "weather",
      "entry": "panel/index.js"
    }
  ],
  "dependencies": {
    "node-fetch": "^3.0.0"
  },
  "envVars": [
    {
      "name": "WEATHER_API_KEY",
      "description": "API key from openweathermap.org",
      "required": true
    }
  ]
}
```

### Manifest Fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Package name (lowercase, hyphens ok) |
| `version` | Yes | Semver version string |
| `type` | Yes | One of: `panel`, `mcp-server`, `skill`, `bundle` |
| `description` | Yes | Short description (under 200 characters) |
| `author` | Yes | Author name or handle |
| `license` | Yes | SPDX license identifier |
| `crow.minVersion` | No | Minimum Crow version required |
| `components` | Yes | Array of component definitions |
| `dependencies` | No | npm dependencies (installed automatically) |
| `envVars` | No | Required environment variables |

### `webUI` Field

Add-ons that provide a browser-accessible interface should declare a `webUI` object:

```json
{
  "webUI": {
    "port": 8080,
    "path": "/",
    "label": "Open App"
  }
}
```

| Field | Description |
|---|---|
| `port` | The local port the web UI listens on |
| `path` | URL path to append after the port (e.g., `/` or `/admin`) |
| `label` | Button text shown on launcher tiles and the Extensions page |

Set `webUI` to `null` for headless add-ons (no web interface). When `webUI` is present, the Crow's Nest launcher shows an "Open" button linking to `http://localhost:<port><path>`.

### `panel` Field

Add-ons can include a Crow's Nest panel that gets automatically installed and registered:

```json
{
  "panel": "panels/my-panel.js"
}
```

The path is relative to the add-on's root directory. During installation, the panel file is copied to `~/.crow/panels/` and its ID is added to `~/.crow/panels.json`. On uninstall, the panel is removed. This works for any add-on type, not just `panel`-type add-ons.

### SVG Logos

Official add-ons have inline SVG logos defined in `servers/gateway/dashboard/shared/logos.js`. These appear on the Extensions page and the launcher tiles. Community add-ons that are not in the built-in logo set fall back to an emoji icon (Extensions page) or an initial-letter circle (launcher tiles).

::: tip
If you are submitting an add-on to the registry, you can propose an SVG logo to be included in `logos.js`. Use a 24x24 viewBox, `stroke="currentColor"`, and no fills so the icon adapts to both dark and light themes.
:::

## File Structure

### Panel add-on

```
crow-weather-panel/
  manifest.json
  panel/
    index.js          # Panel manifest + handler
    assets/           # Optional static files
```

### MCP server add-on

```
crow-task-server/
  manifest.json
  server/
    server.js         # Factory function
    index.js          # Stdio entry point
  schema/
    init.sql          # Database tables (run during install)
  skills/
    tasks.md          # Optional companion skill
```

### Skill add-on

```
crow-pomodoro-skill/
  manifest.json
  skills/
    pomodoro.md       # Skill file
```

### Bundle add-on

```
crow-project-manager/
  manifest.json
  server/
    server.js
    index.js
  panel/
    index.js
  skills/
    project-manager.md
  schema/
    init.sql
```

## Testing Locally

1. Create your add-on directory with a `manifest.json`
2. For panels: symlink or copy to `~/.crow/panels/`
3. For servers: add to `scripts/server-registry.js` temporarily
4. For skills: copy to `skills/`
5. Restart the gateway and verify everything works

Test the manifest:

```bash
node -e "const m = JSON.parse(require('fs').readFileSync('manifest.json')); console.log(m.name, m.version, m.type);"
```

## Home Screen Tiles

When a bundle add-on is installed, it automatically appears as a tile on the Crow's Nest home screen. No extra configuration required.

### How it works

- Tiles appear after install, disappear after uninstall
- Tile label comes from `name` in your manifest
- Tile icon resolves in order: branded logo (for official add-ons) → `icon` field SVG → first-letter fallback
- Bundles with `webUI` configured open the web interface on click
- Bundles without `webUI` link to the Extensions panel

### Supported icon keys

The `icon` field in your manifest should be one of these feather-style icon names:

`brain`, `cloud`, `image`, `home`, `book`, `rss`, `mic`, `message-circle`, `gamepad`, `archive`

Unknown icon keys fall back to a first-letter circle.

### What doesn't get tiles

- **MCP servers** — headless, no click target
- **Skills** — pure markdown, no UI surface
- **Panels** — already appear via the panel registry (see [Creating Panels](/developers/creating-panels))

## Publishing

Once your add-on is tested:

1. Push it to a public Git repository
2. Tag a release with the version from your manifest
3. Submit it to the [Add-on Registry](/developers/addon-registry) for listing

See the [Registry documentation](/developers/addon-registry) for the full submission process.

## Guidelines

- Keep add-ons focused — one purpose per add-on
- Use environment variables for secrets, never hardcode them
- Follow the Zod `.max()` constraint pattern for any MCP tool parameters
- Use `sanitizeFtsQuery()` for any FTS5 queries
- Include a `LICENSE` file
- Test with both dark and light Crow's Nest themes if you're building a panel
