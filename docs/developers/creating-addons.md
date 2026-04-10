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
| `mcp-server` | MCP server (factory + stdio) | Registered in `~/.crow/mcp-addons.json` |
| `skill` | Skill markdown file | `~/.crow/skills/` |
| `bundle` | Multiple components | Each to its respective location |

## manifest.json

Every add-on has a `manifest.json` at its root:

```json
{
  "id": "weather",
  "name": "Weather Panel",
  "version": "1.0.0",
  "type": "panel",
  "description": "Weather panel showing local forecast",
  "author": "Your Name",
  "license": "MIT",
  "category": "productivity",
  "tags": ["weather", "dashboard"],
  "icon": "cloud",
  "panel": "panel/index.js",
  "requires": {
    "env": ["WEATHER_API_KEY"]
  },
  "env_vars": [
    {
      "name": "WEATHER_API_KEY",
      "description": "API key from openweathermap.org",
      "required": true,
      "secret": true
    }
  ]
}
```

Here is a more complete example (a bundle with Docker, an MCP server, a panel, and a skill):

```json
{
  "id": "jellyfin",
  "name": "Jellyfin",
  "version": "1.0.0",
  "type": "bundle",
  "description": "Self-hosted media server with AI-powered library management",
  "author": "Crow",
  "category": "media",
  "tags": ["media", "movies", "tv", "music", "streaming"],
  "icon": "film",
  "docker": { "composefile": "docker-compose.yml" },
  "server": {
    "command": "node",
    "args": ["server/index.js"],
    "envKeys": ["JELLYFIN_URL", "JELLYFIN_API_KEY"]
  },
  "panel": "panel/jellyfin.js",
  "skills": ["skills/jellyfin.md"],
  "requires": { "env": ["JELLYFIN_API_KEY"], "min_ram_mb": 1024, "min_disk_mb": 2000 },
  "env_vars": [
    { "name": "JELLYFIN_URL", "description": "Jellyfin server URL", "default": "http://localhost:8096", "required": true },
    { "name": "JELLYFIN_API_KEY", "description": "Jellyfin API key", "required": true, "secret": true }
  ],
  "ports": [8096],
  "webUI": { "port": 8096, "path": "/", "label": "Jellyfin" },
  "notes": "Self-host via Docker or connect to an existing Jellyfin instance."
}
```

### Manifest Fields

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique identifier (lowercase, hyphens only) |
| `name` | Yes | Human-readable name |
| `version` | Yes | Semver version string |
| `type` | Yes | One of: `panel`, `mcp-server`, `skill`, `bundle` |
| `description` | Yes | Short description (under 200 characters) |
| `author` | Yes | Author name or handle |
| `license` | Yes | SPDX license identifier |
| `category` | Yes | Category: `ai`, `media`, `productivity`, `storage`, `smart-home`, `networking`, `gaming`, `data`, `finance` |
| `tags` | No | Array of searchable tags (max 10) |
| `icon` | No | Icon key (see [Supported icon keys](#supported-icon-keys) below) |
| `docker` | No | Docker config: `{ "composefile": "docker-compose.yml" }` |
| `server` | No | MCP server config: `{ "command", "args", "envKeys" }` |
| `panel` | No | Path to Crow's Nest panel module (relative to add-on root) |
| `panelRoutes` | No | Path to additional Express routes for the panel |
| `skills` | No | Array of skill markdown file paths (relative to add-on root) |
| `requires` | No | Requirements: `env` (array), `min_ram_mb`, `min_disk_mb`, `gpu` (boolean) |
| `env_vars` | No | Detailed env var definitions (name, description, required, secret, default) |
| `ports` | No | Ports used by the add-on |
| `webUI` | No | Web interface config (see below), or `null` for headless add-ons |
| `notes` | No | Additional notes shown on the Extensions page |

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

Set `webUI` to `null` for headless add-ons (no web interface). The Crow's Nest home screen tile uses this logic for click targets:

1. If the bundle has a **panel**, the tile links to the panel (`/dashboard/<id>`)
2. If the bundle has **webUI but no panel**, the tile opens the web interface
3. If the bundle has **neither**, the tile links to the Extensions page

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
  manifest.json              # "panel": "panel/index.js"
  panel/
    index.js                 # Panel manifest + handler
    assets/                  # Optional static files
```

### MCP server add-on

```
crow-task-server/
  manifest.json              # "server": { "command": "node", "args": ["server/index.js"], "envKeys": [...] }
  server/
    server.js                # Factory function
    index.js                 # Stdio entry point
  schema/
    init.sql                 # Database tables (run during install)
  skills/
    tasks.md                 # Optional companion skill
```

### Skill add-on

```
crow-pomodoro-skill/
  manifest.json              # "skills": ["skills/pomodoro.md"]
  skills/
    pomodoro.md              # Skill file
```

### Bundle add-on (Docker + server + panel + skill)

```
crow-media-manager/
  manifest.json              # All fields: docker, server, panel, skills
  docker-compose.yml         # Referenced by "docker": { "composefile": "docker-compose.yml" }
  server/
    server.js
    index.js
  panel/
    index.js
  skills/
    media-manager.md
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

`brain`, `cloud`, `image`, `home`, `book`, `rss`, `mic`, `music`, `message-circle`, `gamepad`, `archive`, `file-text`

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

## Notifications

Add-ons can create notifications that appear in the Crow's Nest bell icon and tamagotchi dropdown. Import the shared helper:

```js
import { createNotification } from "../../shared/notifications.js";
// or adjust the relative path based on your add-on's location
```

Create a notification after user-visible actions:

```js
try {
  await createNotification(db, {
    title: "Task completed: Build report",
    type: "system",       // "reminder", "media", "peer", or "system"
    source: "my-addon",   // identifies the origin
    action_url: "/dashboard/my-panel",  // optional click target
  });
} catch {}
```

Always wrap in `try/catch` so notification failure never breaks the primary action. The helper respects user preferences — if a user disables the notification type in Settings, the call returns `null` silently.

## Guidelines

- Keep add-ons focused — one purpose per add-on
- Use environment variables for secrets, never hardcode them
- Follow the Zod `.max()` constraint pattern for any MCP tool parameters
- Use `sanitizeFtsQuery()` for any FTS5 queries
- Include a `LICENSE` file
- Test with both dark and light Crow's Nest themes if you're building a panel
