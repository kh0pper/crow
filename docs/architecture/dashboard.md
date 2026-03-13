---
title: Crow's Nest
---

# Crow's Nest

The Crow's Nest (`servers/gateway/dashboard/`) is a server-rendered web interface for managing a Crow instance. (The code directory is still named `dashboard/` for backward compatibility; the user-facing name is "Crow's Nest.") It uses no frontend framework — HTML is generated server-side and served directly by the gateway.

## Brand Identity

The Crow's Nest uses a cool blue-black palette with indigo accents, defined as CSS custom properties in `servers/gateway/dashboard/shared/layout.js`.

### Color Tokens (Dark — `:root`)

| Token | Value | Usage |
|---|---|---|
| `--crow-bg-deep` | `#0f0f17` | Page background |
| `--crow-bg-surface` | `#1a1a2e` | Card/panel backgrounds |
| `--crow-bg-elevated` | `#2d2d3d` | Raised surfaces, hover states |
| `--crow-border` | `#3d3d4d` | Borders, dividers |
| `--crow-text-primary` | `#fafaf9` | Headings, body text |
| `--crow-text-secondary` | `#a8a29e` | Descriptions, labels |
| `--crow-text-muted` | `#78716c` | Hints, disabled text |
| `--crow-accent` | `#6366f1` | Primary accent (indigo) |
| `--crow-accent-hover` | `#818cf8` | Hover state for accent |
| `--crow-accent-muted` | `#2d2854` | Subtle accent backgrounds |
| `--crow-brand-gold` | `#fbbf24` | Active nav highlight, branding |
| `--crow-success` | `#22c55e` | Success states |
| `--crow-error` | `#ef4444` | Error states |
| `--crow-info` | `#38bdf8` | Informational highlights |

### Color Tokens (Light — `.theme-light`)

| Token | Value |
|---|---|
| `--crow-bg-deep` | `#fafaf9` |
| `--crow-bg-surface` | `#ffffff` |
| `--crow-bg-elevated` | `#f5f5f4` |
| `--crow-border` | `#e7e5e4` |
| `--crow-text-primary` | `#1c1917` |
| `--crow-text-secondary` | `#57534e` |
| `--crow-text-muted` | `#a8a29e` |
| `--crow-accent` | `#4f46e5` |
| `--crow-accent-hover` | `#6366f1` |
| `--crow-accent-muted` | `#e0e7ff` |

### Typography

- **Headings**: Fraunces (serif, variable weight)
- **Body**: DM Sans (sans-serif)
- **Code**: JetBrains Mono (monospace)

All three are loaded via Google Fonts in the layout `<style>` block.

### Visual Details

- Card depth via layered `box-shadow` (subtle glow on elevated surfaces)
- Gold accent (`--crow-brand-gold`) on the active sidebar navigation item
- Illustrated empty states with inline crow SVG icons
- Login page and setup page display a crow hero graphic

## Architecture

```
┌────────────────────────────────────────┐
│           Panel Registry               │
│  health │ messages │ memory │ blog    │
│  files │ extensions │ settings         │
│  + third-party panels from ~/.crow/    │
├────────────────────────────────────────┤
│           Layout System                │
│  layout(title, content, options)       │
│  Navigation, theme toggle, footer     │
├────────────────────────────────────────┤
│           Auth System                  │
│  scrypt hashing, session cookies      │
│  CSRF tokens, account lockout         │
├────────────────────────────────────────┤
│           Network Security             │
│  IP allowlist (LAN, Tailscale)        │
│  403 for disallowed origins            │
├────────────────────────────────────────┤
│           Express Router               │
│  GET/POST /dashboard/*                 │
└────────────────────────────────────────┘
```

## Panel Registry

Panels are modular sections of the Crow's Nest. Each panel registers itself with:

```js
{
  id: 'messages',          // Unique identifier
  name: 'Messages',        // Display name in navigation
  icon: 'mail',            // Icon identifier
  route: '/dashboard/messages',
  navOrder: 1,             // Position in the navigation bar
  handler: async (req, res, { db, layout }) => {
    // Render panel content
  }
}
```

Built-in panels live in `servers/gateway/dashboard/panels/`:

| Panel | File | Route | Purpose |
|---|---|---|---|
| Crow's Nest | `panels/health.js` | `/dashboard/nest` | App launcher tiles, CPU, RAM, disk usage, Docker containers, DB metrics |
| Messages | `panels/messages.js` | `/dashboard/messages` | View peer messages, threads, read status |
| Memory | `panels/memory.js` | `/dashboard/memory` | Browse, search, and manage persistent memories |
| Blog | `panels/blog.js` | `/dashboard/blog` | Manage posts, publish/unpublish, edit |
| Files | `panels/files.js` | `/dashboard/files` | Browse storage, upload, delete, preview |
| Extensions | `panels/extensions.js` | `/dashboard/extensions` | Browse marketplace, install/uninstall add-ons, resource warnings |
| Settings | `panels/settings.js` | `/dashboard/settings` | Configuration, quotas, network rules, contact discovery |

## Auth System

The Crow's Nest uses its own authentication layer, separate from the gateway's OAuth system.

### Password Hashing

Passwords are hashed with Node.js's built-in `crypto.scrypt`:

```js
crypto.scrypt(password, salt, 64, (err, derivedKey) => {
  // Store salt + derivedKey
});
```

No external dependency required.

### Sessions

After login, a session cookie is set with:

- `httpOnly: true` — Not accessible to client-side JavaScript
- `sameSite: 'strict'` — Prevents CSRF via cross-origin requests
- `secure: true` — Only sent over HTTPS (when behind a reverse proxy)
- Configurable expiry (default: 24 hours)

### CSRF Protection

All state-changing requests (POST, PUT, DELETE) require a CSRF token. The token is embedded in forms as a hidden field and validated server-side.

### Account Lockout

After 5 failed login attempts within 15 minutes, the account is locked for 30 minutes. This prevents brute-force attacks on the Crow's Nest password.

## Layout System

The `layout()` function wraps panel content in a consistent page structure:

```js
function layout(title, content, options = {}) {
  return `<!DOCTYPE html>
  <html data-theme="${options.theme || 'dark'}">
  <head>
    <title>${title} — Crow's Nest</title>
    ${styles}
  </head>
  <body>
    ${navigation(options.activePanel)}
    <main>${content}</main>
    ${footer}
  </body>
  </html>`;
}
```

Everything is a template literal — no template engine dependency. CSS is inlined in the `<head>` to avoid a separate static file server.

## Network Security

Before any Crow's Nest route executes, middleware checks the request's source IP:

```js
const ALLOWED_RANGES = [
  '127.0.0.1/32',       // Localhost
  '::1/128',            // Localhost IPv6
  '10.0.0.0/8',         // LAN Class A
  '172.16.0.0/12',      // LAN Class B
  '192.168.0.0/16',     // LAN Class C
  '100.64.0.0/10',      // Tailscale CGNAT
];
```

Requests from outside these ranges receive a `403 Forbidden` response. To allow access from any IP (e.g., behind a reverse proxy), set `CROW_DASHBOARD_PUBLIC=true`.

The middleware reads `X-Forwarded-For` when the gateway is behind a reverse proxy, but only trusts it if the immediate connection comes from a known proxy IP.

## App Launcher

The Crow's Nest landing page (the "Crow's Nest" panel, `navOrder: 5`) includes a **Your Apps** grid showing installed add-ons as launcher tiles.

### How it works

1. Reads `~/.crow/installed.json` and filters entries with type `bundle` or `mcp-server`
2. Loads the add-on manifest to get the display name and `webUI` field
3. Calls `getAddonLogo(id, 48)` from `servers/gateway/dashboard/shared/logos.js` for the tile icon (falls back to an initial-letter circle)
4. For Docker-based add-ons, checks container status via `docker ps --filter name=<id>` with a **30-second module-level cache** (`_dockerStatusCache` Map) to avoid excessive shell commands
5. Renders a status dot (green = running, gray = stopped) and an "Open" button for add-ons with a `webUI` manifest field

### `webUI` manifest field

Add-on manifests can declare a `webUI` object to indicate the add-on has a browser-accessible interface:

```json
{
  "webUI": {
    "port": 8080,
    "path": "/",
    "label": "Open Nextcloud"
  }
}
```

Set `webUI` to `null` for headless add-ons (e.g., Ollama). The launcher only shows the "Open" button when `webUI` is non-null.

## Panel Auto-Installation

Add-ons that include a `panel` field in their `manifest.json` get their panel file automatically installed during add-on installation and removed during uninstallation. This works for any add-on type (bundle, mcp-server, skill), not just panel-type add-ons.

During install, `routes/bundles.js` copies the panel file from the add-on's source directory to `~/.crow/panels/` and adds its ID to `~/.crow/panels.json`. During uninstall, the panel file is removed and the ID is deleted from the JSON. Example manifest field:

```json
{
  "panel": "panels/podcast.js"
}
```

The Podcast panel (`bundles/podcast/panels/podcast.js`) is an example: it is installed as a third-party panel when the podcast add-on is installed.

| Panel | Type | Source |
|---|---|---|
| Podcast | Third-party (auto-installed) | `bundles/podcast/panels/podcast.js` |

## Third-Party Panels

Community-created panels live in `~/.crow/panels/`. Each panel is a directory or JS file. The Crow's Nest scans this directory on startup and registers any valid panels. Third-party panels receive the same `{ db, layout, appRoot }` context as built-in panels. The `appRoot` path points to the Crow source root, which panels can use for dynamic imports of shared components (e.g., `logos.js`, `components.js`).

Enable panels in `~/.crow/panels.json` (a JSON array of panel IDs):

```json
["my-panel", "weather"]
```

An object format with an `"enabled"` key is also accepted for backward compatibility.

See [Creating Panels](/developers/creating-panels) for a development tutorial.

## No Build Step

The Crow's Nest has no build step, no bundler, and no node_modules of its own. All HTML, CSS, and minimal JavaScript are generated inline by the server. This keeps the UI lightweight and avoids frontend toolchain complexity.

CSS uses custom properties for theming (see the full [Brand Identity](#brand-identity) table above):

```css
:root {
  --crow-bg-deep: #0f0f17;
  --crow-bg-surface: #1a1a2e;
  --crow-accent: #6366f1;
  --crow-text-primary: #fafaf9;
  --crow-brand-gold: #fbbf24;
}

.theme-light {
  --crow-bg-deep: #fafaf9;
  --crow-bg-surface: #ffffff;
  --crow-accent: #4f46e5;
  --crow-text-primary: #1c1917;
}
```
