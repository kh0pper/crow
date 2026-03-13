---
title: Crow's Nest (Dashboard)
---

# Crow's Nest

The Crow's Nest (`servers/gateway/dashboard/`) is a server-rendered web interface for managing a Crow instance. (The code directory is still named `dashboard/` for backward compatibility; the user-facing name is "Crow's Nest.") It uses no frontend framework — HTML is generated server-side and served directly by the gateway.

## Architecture

```
┌────────────────────────────────────────┐
│           Panel Registry               │
│  messages │ blog │ files │ settings    │
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
| Messages | `panels/messages.js` | `/dashboard/messages` | View peer messages, threads, read status |
| Blog | `panels/blog.js` | `/dashboard/blog` | Manage posts, publish/unpublish, edit |
| Files | `panels/files.js` | `/dashboard/files` | Browse storage, upload, delete, preview |
| Extensions | `panels/extensions.js` | `/dashboard/extensions` | Manage integrations and MCP server connections |
| Settings | `panels/settings.js` | `/dashboard/settings` | Configuration, quotas, network rules |

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

## Third-Party Panels

Community-created panels live in `~/.crow/panels/`. Each panel is a directory containing:

```
~/.crow/panels/
  my-panel/
    index.js        # Exports panel manifest + handler
    assets/         # Optional static assets
```

The Crow's Nest scans this directory on startup and registers any valid panels. Third-party panels receive the same `{ db, layout }` context as built-in panels.

Enable or disable panels in `~/.crow/panels.json`:

```json
{
  "enabled": ["my-panel"],
  "disabled": []
}
```

See [Creating Panels](/developers/creating-panels) for a development tutorial.

## No Build Step

The Crow's Nest has no build step, no bundler, and no node_modules of its own. All HTML, CSS, and minimal JavaScript are generated inline by the server. This keeps the UI lightweight and avoids frontend toolchain complexity.

CSS uses custom properties (variables) for theming:

```css
:root[data-theme="dark"] {
  --bg-primary: #1a1a1a;
  --text-primary: #e0e0e0;
  --accent: #6b9bd2;
}

:root[data-theme="light"] {
  --bg-primary: #fafafa;
  --text-primary: #1a1a1a;
  --accent: #2a6496;
}
```
