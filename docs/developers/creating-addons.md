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
| `panel` | Dashboard panel | `~/.crow/panels/` |
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
  "description": "Weather dashboard panel showing local forecast",
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
- Test with both dark and light dashboard themes if you're building a panel
