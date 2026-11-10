---
title: Creating Add-ons
---

# Creating Add-ons

> The bundle contract (manifest fields + surfaces) is documented in [bundles.md](./bundles.md).

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
| `license` | No | SPDX license identifier — optional, but include it when distributing so usage rights are clear |
| `category` | Yes | Category: `ai`, `media`, `productivity`, `storage`, `smart-home`, `networking`, `social`, `gaming`, `data`, `finance`, `other` |
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
| `firstAdmin` | **Yes when there is a `webUI`** | How the app's own first admin is created (see below) — `build-registry` refuses a web UI without it |
| `notes` | No | Additional notes shown on the Extensions page |
| `featured` | No | `true` surfaces the add-on in the Extensions page's Featured section (Browse view) |
| `sandbox` | No | What the MCP server may reach when Crow runs it inside a wall (see below) |

### The sandbox block

When Crow runs your MCP server inside a wall, what it can reach comes from your manifest's `sandbox` block, the values the owner enters, and your compose file. Without the block, an add-on gets the internet and every `*_URL`/`*_HOST`/`*_BASE_URL` field it declares; the block says exactly what it gets instead. The wall is described in [Add-on Walls](../architecture/addon-walls.md).

```json
{
  "id": "weather-mcp",
  "name": "Weather MCP",
  "version": "1.0.1",
  "type": "mcp-server",
  "description": "Forecasts and alerts",
  "author": "Your Name",
  "category": "productivity",
  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["WEATHER_URL"] },
  "env_vars": [
    { "name": "WEATHER_URL", "description": "Weather API base URL", "required": true },
    { "name": "WEATHER_CACHE_DIR", "description": "Folder of downloaded forecasts", "required": false },
    { "name": "WEATHER_STATE_FILE", "description": "File of alert thresholds", "required": false },
    { "name": "WEATHER_TOKEN_FILE", "description": "Token file for the account", "required": false }
  ],
  "sandbox": {
    "network": { "internet": true, "hosts": ["env:WEATHER_URL"] },
    "files": {
      "read": ["env:WEATHER_CACHE_DIR"],
      "write": ["env:WEATHER_STATE_FILE"],
      "oauthDir": "env:WEATHER_TOKEN_FILE"
    },
    "ownEnvFile": true
  }
}
```

| Field | Rule |
|---|---|
| `network` | `"none"`, `"internet"`, or `{ "internet": true, "hosts": ["env:NAME", ...] }`. `"internet"` is HTTPS CONNECT on port 443 to public addresses only. |
| `network.hosts` | `env:` names only — never a literal host. Each field the owner fills in becomes one exact `host:port` entry; a private address is allowed there because the owner typed it. |
| `doors` | Only your own id's door set, and only if Crow ships one for it. **An add-on cannot name another add-on's doors.** First-party only. |
| `files.read` | Paths bound read-only. Values are `env:NAME`, and only a value the owner typed is bound. |
| `files.write` | Paths bound read-write, same rule. |
| `files.oauthDir` | One `env:NAME` naming a token file. Its folder is bound read-write, so your app can add files beside the token. |
| `ownEnvFile` | `true` binds your bundle's own `.env` (read-only) on top of the mask that hides every other `.env`. The file must be `<CROW_HOME>/bundles/<id>/.env`, a real file: a symlinked `.env` is refused. |

State folders are not part of this block. A few add-ons keep state directly in the Crow home, and those folder names come from Crow's core table (`ADDON_STATE_DIRS` in `servers/shared/addon-doors.js`), only for a first-party id. A manifest cannot choose one.

Finally, a first-party bundle's policy is read from Crow's own copy of the manifest, not from the installed one. An installed `sandbox` block that differs from it keeps the add-on off with the card "its installed files changed; reinstall it to wall it" — so do not edit the installed copy, and bump `version` when you change the block.

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

### `firstAdmin` Field

An app with a web UI has an admin account, and until it exists the app's own
first-run page belongs to whoever reaches it first — anything else on this
machine can answer that page on `127.0.0.1` before you do. So a manifest with a
`webUI` **must** say how the account comes to exist:

```json
"webUI": { "port": 8085, "path": "/", "label": "Miniflux" },
"firstAdmin": { "mode": "crow", "via": "env", "secretEnv": "MINIFLUX_ADMIN_PASSWORD", "userEnv": "MINIFLUX_ADMIN_USER" }
```

| `mode` | When | What Crow does |
|---|---|---|
| `crow` | Crow can create the admin at install | the password is generated and saved in the keychain |
| `finish-setup` | the app has its own first-run admin page | shows "Finish &lt;app&gt;'s setup now" (with a link) until the operator presses Done, and rings the bell once |
| `default-login` | the app ships a documented default login | the same notice, naming the default user |
| `external` | it connects to an app you already run | nothing: the login is that app's |
| `none` | no login of its own | nothing |

| Field | Required | Description |
|---|---|---|
| `mode` | Yes | one of the five above |
| `path` | No | the app page to open (starts with `/`): the setup or login page, when it is not the root |
| `user` | Only with `default-login` | the documented default username |
| `note` | No | one short plain sentence added to the notice, e.g. where the app prints its first password |
| `via` | With `crow` | `"env"` (the app reads it from its environment) or `"postInstall"` (a hook sets it) |
| `secretEnv` | With `crow` + `via: "env"` | the `env_vars` entry Crow generates and keeps in the keychain |
| `userEnv` | No, with `crow` + `via: "env"` | the `env_vars` entry holding the admin username |

- `crow` must name a mechanism that really creates the admin, wired to this app:
  - `via: "env"`: `secretEnv` names an `env_vars` entry with `generate: "secret"` and `keychain: true`, **and** the compose file interpolates it (`${THAT_NAME…}`). A generated secret the app never reads does not create its admin.
  - `via: "postInstall"`: a `postInstall` script must exist and name at least one `generate: "secret"` + `keychain: true` env var — that is what the hook sets.
  - Without either, the build refuses it — declare `finish-setup` instead.
- `default-login` needs `user`, and `user` is only allowed with that mode.
- `via`, `secretEnv` and `userEnv` are only allowed with `crow`.
- Prefer `crow`: it is the only mode where nothing can claim the account between the install and the operator's first visit.

A web UI bundle that declares nothing is not silently ignored: at runtime it is
treated as `finish-setup`, so the operator still sees the card and gets the
bell. Only an explicit `crow`, `external` or `none` is silent.

`docs/developers/bundles.md` has the same rules in more detail.

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

## Featured add-ons and starter collections

Set `"featured": true` in your manifest to surface the add-on in the Extensions page's Featured section — a small, curated set of add-ons shown above the regular Browse grid. Featured is orthogonal to `category`; it doesn't move or remove the add-on from its category section.

Getting into a **starter collection** (the one-click "Home Server" / "Education" / "Research" / "Development" bundles on the Browse view) is a separate, higher bar than `featured`: collections are curated in `registry/collections.json` and every member must be official, non-privileged, non-`consent_required`, non-GPU, and (if it ships Docker) not use host networking or mount the Docker socket. See [Collections](./bundles.md#collections) in the Bundles doc for the full rule set and how to propose an addition.

## Post-install configuration and MCP add-ons

When a user fills in an add-on's `env_vars` after install (the post-install configuration checklist), the gateway writes those values to the bundle's own `.env` file. For MCP-server add-ons, it now **also** updates the entry in `~/.crow/mcp-addons.json` — the MCP child process reads its environment from `mcp-addons.json`, not from `bundles/<id>/.env`, so without this a saved env value would never reach a running server. A gateway restart is what actually applies the new value to the MCP child.

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
2. Run `npm run build-registry` to regenerate `registry/add-ons.json` (never hand-edit it — the registry is generated from manifests)
3. For panels: symlink or copy to `~/.crow/panels/` and add the ID to `~/.crow/panels.json`
4. For servers: add to `scripts/server-registry.js` temporarily
5. For skills: copy to `skills/`
6. Restart the gateway and verify everything works

::: tip
If you use a new `category` or `icon` value, you also need to update the Extensions panel infrastructure. See the [Maintainer Checklist](/developers/addon-registry#_6-listing) in the registry docs for the full list of files.
:::

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

`brain`, `cloud`, `image`, `home`, `book`, `rss`, `mic`, `music`, `message-circle`, `gamepad`, `archive`, `file-text`, `phone-video`

Unknown icon keys fall back to a first-letter circle. To add a new icon key, add an entry to `ICON_MAP` in `servers/gateway/dashboard/panels/extensions.js`.

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
