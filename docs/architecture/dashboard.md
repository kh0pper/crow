---
title: Crow's Nest
---

# Crow's Nest

The Crow's Nest (`servers/gateway/dashboard/`) is a server-rendered web interface for managing a Crow instance. (The code directory is still named `dashboard/` for backward compatibility; the user-facing name is "Crow's Nest.") It uses no frontend framework — HTML is generated server-side and served directly by the gateway.

> User-facing walkthrough (panels, launcher, day-to-day use): [Crow's Nest guide](/guide/crows-nest). This page covers internals.

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
| Projects | `panels/projects.js` | `/dashboard/projects` | Browse project spaces, sources, notes |
| Blog | `panels/blog.js` | `/dashboard/blog` | Manage posts, publish/unpublish, edit |
| Files | `panels/files.js` | `/dashboard/files` | Browse storage, upload, delete, preview |
| Extensions | `panels/extensions.js` | `/dashboard/extensions` | Browse marketplace, install/uninstall add-ons, resource warnings |
| Skills | `panels/skills.js` | `/dashboard/skills` | Browse and edit Crow skills |
| Settings | `panels/settings.js` | `/dashboard/settings` | Configuration, quotas, network rules, contact discovery, sync-conflict recovery |
| Contacts | `panels/contacts.js` | `/dashboard/contacts` | Peer contacts, invites, discovery |
| Orchestrator | `panels/orchestrator.js` | `/dashboard/orchestrator` | Run multi-agent teams, view runs and pipelines |
| Bot Builder | `panels/bot-builder.js` | `/dashboard/bot-builder` | Create and configure bots (personas, skills, channels) |
| Bot Board | `panels/bot-board.js` | `/dashboard/bot-board` | Monitor running bots, conversations, deliveries |
| Design System | `panels/design-system.js` | `/dashboard/design-system` | Living reference for tokens and components |
| Onboarding | `panels/onboarding.js` | (hidden) | First-run setup wizard |
| Connect | `panels/connect.js` | `/dashboard/connect` | Connect-a-client wizard + local MCP token management |
| Fediverse Admin | `panels/fediverse.js` | `/dashboard/fediverse` | Fediverse/ActivityPub administration |

The largest panels are **module directories** rather than single files: `panels/<name>/` holds `{css,data-queries,client,api-handlers,html}.js` (plus panel-specific modules like `editor.js`), with the top-level `panels/<name>.js` as a thin orchestrator that wires them together. `bot-builder`, `bot-board`, `extensions`, `contacts`, `messages`, and `nest` follow this pattern; smaller panels remain single files.

Settings sections live in `servers/gateway/dashboard/settings/sections/` — including `sync-conflicts.js`, the multi-instance sync-conflict recovery view that conflict notifications deep-link to (`/dashboard/settings?section=sync-conflicts`).

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

The layout function (`shared/layout.js`) wraps panel content in a consistent page structure. It takes a single options object:

```js
renderLayout({
  title,        // page title
  content,      // panel HTML
  activePanel,  // highlights the nav entry
  theme,        // 'dark' | 'light'
  lang,         // 'en' | 'es'
  scripts,      // extra page scripts
  // ...plus panels, glass, serif, afterContent, headerIcons, navGroups, instanceTabs
})
```

Panels receive it as `layout` in their handler context and call it as `layout({ title, content })`.

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

### Home Screen Tile Pipeline

The Nest home screen renders tiles from two sources:

1. **Panel Registry** — `getVisiblePanels()` returns non-hidden panels sorted by `navOrder`
2. **Installed bundles** — `getNestData()` reads `~/.crow/installed.json`, loads manifests, checks Docker status

Data flow:
```
Panel Registry ──→ getVisiblePanels() ──┐
                                        ├──→ buildNestHTML() ──→ Grid
~/.crow/installed.json ──→ getNestData() ──┘
```

**Tile ordering**: Built-in panels first (by `navOrder`), then bundles (by `installedAt` from installed.json).

**Icon resolution** (bundles): Branded SVG logo → manifest `icon` field → first-letter circle fallback.

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

Community-created panels live in `~/.crow/panels/`. Each panel is a single JS file named `<id>.js` (an optional companion `<id>-routes.js` file can register extra routes). Panel IDs must match `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`; anything else is rejected at load time. The Crow's Nest loads the panels listed in `~/.crow/panels.json` on startup and registers any valid ones. Third-party panels receive the same `{ db, layout, appRoot, lang }` context as built-in panels. The `appRoot` path points to the Crow source root, which panels can use for dynamic imports of shared components (e.g., `logos.js`, `components.js`); `lang` is the operator's dashboard language (`en`/`es`).

Enable panels in `~/.crow/panels.json` (a JSON array of panel IDs):

```json
["my-panel", "weather"]
```

An object format with an `"enabled"` key is also accepted for backward compatibility.

See [Creating Panels](/developers/creating-panels) for a development tutorial.

## Notification System

The Crow's Nest includes a notification system with a bell icon and tamagotchi-style dropdown in the top bar.

### Schema

The `notifications` table stores all notifications:

| Column | Type | Description |
|---|---|---|
| `type` | text | `reminder`, `media`, `peer`, or `system` |
| `source` | text | Origin identifier (e.g., `blog`, `sharing:message`, `bundle-installer`) |
| `title` | text | Short headline |
| `body` | text | Optional longer description |
| `priority` | text | `low`, `normal`, or `high` |
| `action_url` | text | Dashboard link for click-through |
| `is_read` | integer | Read status |
| `is_dismissed` | integer | Dismissed status |
| `expires_at` | text | Auto-expiry timestamp |

### Shared Helper

`servers/shared/notifications.js` exports two functions:

- **`createNotification(db, opts)`** — Creates a notification after checking user preferences. Returns `{ id }` or `null` if the type is disabled. Always wrap calls in `try/catch` to prevent notification failures from breaking primary actions.
- **`cleanupNotifications(db)`** — Removes expired notifications and enforces a 500-notification retention limit. Called by the scheduler tick and the REST GET endpoint.

### User Preferences

Users configure which notification types are enabled in Settings → Notifications. Preferences are stored as a JSON object in `dashboard_settings` under the key `notification_prefs`:

```json
{ "types_enabled": ["reminder", "media", "peer", "system"] }
```

All types are enabled by default. The `createNotification` helper checks this before inserting.

### Event Sources

| Event | Type | Source |
|---|---|---|
| Blog post published | `media` | `blog` |
| Incoming P2P share | `peer` | `sharing:share` |
| Incoming Nostr message | `peer` | `sharing:message` |
| Bundle installed | `system` | `bundle-installer` |
| Bundle uninstalled | `system` | `bundle-installer` |
| Scheduled reminder | `reminder` | `scheduler` |

### UI

The notification bell in the top bar shows an unread count badge. Clicking it opens a dropdown with recent notifications, each showing title, time, and source. Notifications can be dismissed individually or cleared in bulk. The REST API at `/api/notifications` provides JSON access for the dropdown's fetch calls.

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

## First-run onboarding (F6b)

`panels/onboarding.js` is a hidden dashboard panel (`hidden: true`, route `/dashboard/onboarding`) that renders a 5-step guided tour (Welcome, Integrations, Bot, Connect, Done) driven by a `?step=N` query param — server-rendered, no client JS. It is **orient-and-route**: each step explains one thing and deep-links (new tab) to the surface that does the work (Settings → Integrations, Bot Builder, the Connect wizard). It writes nothing.

It is shown automatically once: `POST /dashboard/login` redirects to it the first time a password is set (`wasFirstSetup` branch in `index.js`); normal logins go straight to `/dashboard`. It is replayable anytime via the "Replay setup guide" link in Settings → Help & Setup.

Copy is bilingual (EN/ES) via the `onboarding.*` keys in `shared/i18n.js`; the handler resolves language cookie-first (`crow_lang`) so a user who chose Spanish at setup gets Spanish onboarding. Tests: `tests/onboarding.test.js`.

## Connect wizard (F6c-1)

`panels/connect.js` is a hidden dashboard panel (`hidden: true`, route `/dashboard/connect`) that gives per-client, copy-paste MCP config — server-rendered, no client JS beyond the shared tabs/copy handlers. A `tabs()` strip covers the local clients that can reach a private Crow (Claude Code, Cursor, Cline, Gemini CLI, Claude Desktop), each with the two connection styles that work today with no token: **local stdio** (`npm run mcp-config`) and **remote HTTP via OAuth** (paste an `http` server entry; the client runs the OAuth handshake on first use). Configs embed the request-host endpoint `${req.protocol}://${req.get("host")}/router/mcp` (same base-URL derivation as the Connections settings section), so the snippet shows the address the operator is actually browsing from.

A sixth tab (claude.ai / ChatGPT) shows an honest reachability warning instead of a config: a private Crow is Tailnet-only and exposing MCP via Funnel is blocked by the network-exposure invariant, so cloud web clients cannot connect.

It is reached from onboarding step 3, the Help & Setup settings section, and the Connections settings section (all of which now point here rather than duplicating per-platform setup). Copy is bilingual (EN/ES) via the `connect.*` keys in `shared/i18n.js`, resolved cookie-first like onboarding. Tests: `tests/connect.test.js`.

### Local MCP token (F6c-2)

The connect panel also manages a single, per-instance, full-access static bearer token for headless / no-browser clients (the remote-HTTP path that cannot run the OAuth handshake). The gateway verifies it server-side via `servers/gateway/local-token.js`: `localTokenAuthMiddleware` mounts right after `instanceAuthMiddleware` (and reads the DB only on MCP-transport paths — `/mcp`, `/sse`, `/messages` — as a cost guard), and a branch in `routes/mcp.js`'s `skipAuthForInstance` calls `applyLocalTokenAuth(req)` to synthesize full local-operator `req.auth` (after the instance branch, before the OAuth fallback, and deliberately not run through the peer exposure gate).

Only `sha256(token)` is stored, in a local-scoped dashboard setting (`mcp_local_token_hash`, plus `mcp_local_token_created`) that never replicates to paired instances. The raw token is revealed exactly once on generate/rotate, embedded in a ready-to-paste `http` config with an `Authorization: Bearer …` header; the masked state shows only a `<YOUR-TOKEN>` placeholder. Generate/rotate/revoke are POST actions on the panel itself (CSRF + dashboardAuth gated) and need no gateway restart, because the verifier reads the hash per request. Comparison uses `crypto.timingSafeEqual`; under `--no-auth` the token branch is inert (dev-only). The Connections settings section links here for token generation. Tests: `tests/connect-token.test.js`. Spec: `docs/superpowers/specs/2026-06-10-f6c2-connect-token-design.md`.

This supersedes the earlier `CROW_LOCAL_MCP_TOKEN` env var, which only fed the `npm run mcp-config --http` build script and authenticated nothing server-side.
