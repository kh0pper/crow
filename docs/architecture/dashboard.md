---
title: Crow's Nest
---

# Crow's Nest

The Crow's Nest (`servers/gateway/dashboard/`) is a server-rendered web interface for managing a Crow instance. (The code directory is still named `dashboard/` for backward compatibility; the user-facing name is "Crow's Nest.") It uses no frontend framework — HTML is generated server-side and served directly by the gateway.

> User-facing walkthrough (panels, launcher, day-to-day use): [Crow's Nest guide](/guide/crows-nest). This page covers internals.

## Brand Identity

The Crow's Nest uses the Perch-derived light-first palette, defined as CSS custom properties in `servers/gateway/dashboard/shared/design-tokens.js`.

### Token architecture (Track 2, 2026-08-15)

`servers/gateway/dashboard/shared/design-tokens.js`'s `designTokensCss()` is light-first: base values live on a plain `:root` block, and dark values override inside a single `@media (prefers-color-scheme: dark)` block — there is no dashboard theme state (no `.theme-light`/`.theme-dark` class, no `theme`/`glass`/`serif` option on `renderLayout()`, no stored dashboard color-mode setting); light vs. dark follows the OS only. The same module exports `PERCH_TOKENS`, the authoritative copy of the Perch palette; `tests/perch-token-drift.test.js` parses the vendored `bundles/perch-hub/payload/hub/server.mjs` payload as text and fails, in either direction, if it and `PERCH_TOKENS` disagree — Crow owns the palette Perch renders with, not the other way around. `.theme-glass` is retired end-to-end (no glass CSS blocks or `theme_glass`/`theme_dashboard_mode` settings remain). The public blog, songbook, and knowledge-base pages don't run on this system yet: `design-tokens-legacy.js` is a frozen snapshot of the pre-rewrite tokens (minus glass) that `servers/gateway/routes/blog-public.js`, `servers/blog/songbook-renderer.js`, and `bundles/knowledge-base/routes/kb-public.js` import instead, so those surfaces keep today's palette until their own adoption wave.

### Color Tokens (Light — `:root`, base)

| Token | Value | Usage |
|---|---|---|
| `--crow-bg-deep` | `#eef1f3` | Page background |
| `--crow-bg-surface` | `#ffffff` | Card/panel backgrounds |
| `--crow-bg-elevated` | `#f5f7f8` | Raised surfaces, hover states |
| `--crow-border` | `#dde4e8` | Borders, dividers |
| `--crow-border-strong` | `#94a4ae` | Emphasized borders |
| `--crow-text-primary` | `#22303a` | Headings, body text |
| `--crow-text-secondary` | `#5c6d79` | Descriptions, labels |
| `--crow-text-tertiary` | `#6b7c88` | De-emphasized text |
| `--crow-text-muted` | `#8395a1` | Hints, disabled text |
| `--crow-accent` | `#0e6b62` | Primary accent |
| `--crow-accent-hover` | `#0b574f` | Hover state for accent |
| `--crow-accent-muted` | `#dcecea` | Subtle accent backgrounds |
| `--crow-accent-contrast` | `#ffffff` | Text/icon color on top of `--crow-accent` |
| `--crow-success` | `#1d7048` | Success states |
| `--crow-error` | `#b04a2b` | Error states |
| `--crow-warning` | `#8f5606` | Warning states |
| `--crow-info` | `#33688c` | Informational highlights |
| `--crow-brand-gold` | `#8f5606` | Active nav highlight, branding |

### Color Tokens (Dark — `@media (prefers-color-scheme: dark)`)

| Token | Value | Usage |
|---|---|---|
| `--crow-bg-deep` | `#131a1f` | Page background |
| `--crow-bg-surface` | `#1b242b` | Card/panel backgrounds |
| `--crow-bg-elevated` | `#232e36` | Raised surfaces, hover states |
| `--crow-border` | `#2a353d` | Borders, dividers |
| `--crow-border-strong` | `#46565f` | Emphasized borders |
| `--crow-text-primary` | `#e4ebef` | Headings, body text |
| `--crow-text-secondary` | `#8fa0ab` | Descriptions, labels |
| `--crow-text-tertiary` | `#7d8f9a` | De-emphasized text |
| `--crow-text-muted` | `#5f707b` | Hints, disabled text |
| `--crow-accent` | `#4fbdb0` | Primary accent |
| `--crow-accent-hover` | `#6fd0c4` | Hover state for accent |
| `--crow-accent-muted` | `#16322f` | Subtle accent backgrounds |
| `--crow-accent-contrast` | `#131a1f` | Text/icon color on top of `--crow-accent` |
| `--crow-success` | `#2fa36b` | Success states |
| `--crow-error` | `#d1633e` | Error states |
| `--crow-warning` | `#d9a521` | Warning states |
| `--crow-info` | `#6aa9cc` | Informational highlights |
| `--crow-brand-gold` | `#d9a521` | Active nav highlight, branding |

Light vs. dark follows the OS only — there is no dashboard theme-mode setting or class toggle (see the Track 2 paragraph above).

### Typography

- **Headings & body**: Inter (sans-serif, weights 400/500/600/700)
- **Code**: JetBrains Mono (monospace, weights 400/600)

Both are loaded via `FONT_LINKS` (`servers/gateway/dashboard/shared/layout.js`), a single Google Fonts `<link>` block shared across every page.

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
│  Navigation, footer                    │
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
| Bot Builder | `panels/bot-builder.js` | `/dashboard/bot-builder` | Create and configure bots (personas, skills, channels) |
| Bot Board | `panels/bot-board.js` | `/dashboard/bot-board` | Kanban cards + custom trackers; per-board statuses and fields from `board_defs` in tasks.db (Track 0), configured via the board's settings drawer. `routes/board-defs.js` is the single resolver/validator; a board with no def falls back to the builtin four statuses. Dispatch (execute/plan-dispatch) enqueues onto the job rail and never writes the card — "a bot is working this card" is the lock predicate (`routes/board-lock.js`); the old `stage` lifecycle and its un-strand machinery are gone (migration `0002-board-defs` drops the column and the status CHECK) |
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
  panels,       // panel registry (for nav rendering)
  scripts,      // extra page scripts
  afterContent, // markup appended after content (e.g. modals)
  headerIcons,  // extra header icon slots
  lang,         // 'en' | 'es'
  navGroups,    // grouped nav sections
  instanceTabs, // multi-instance tab bar
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
  --crow-bg-deep: #eef1f3;
  --crow-bg-surface: #ffffff;
  --crow-accent: #0e6b62;
  --crow-text-primary: #22303a;
  --crow-brand-gold: #8f5606;
}

@media (prefers-color-scheme: dark) {
  :root {
    --crow-bg-deep: #131a1f;
    --crow-bg-surface: #1b242b;
    --crow-accent: #4fbdb0;
    --crow-text-primary: #e4ebef;
    --crow-brand-gold: #d9a521;
  }
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
