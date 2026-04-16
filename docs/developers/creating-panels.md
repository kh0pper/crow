---
title: Creating Panels
---

# Creating Crow's Nest Panels

Build custom panels that appear in the Crow's Nest alongside the built-in Messages, Blog, Files, and Settings panels.

## What is this?

A Crow's Nest panel is a small add-on that adds a new page to the Crow's Nest. Panels are server-rendered HTML — you write a handler function that receives the database and layout system, and returns HTML content.

## Why would I want this?

- **Custom views** — Build a panel that shows data from an integration (e.g., your calendar, task list, or analytics)
- **Workflow tools** — Add a panel for common actions specific to your setup
- **Share with others** — Publish your panel for the Crow community to use

## Panel Structure

A panel lives in `~/.crow/panels/your-panel/` and contains at minimum an `index.js` file:

```
~/.crow/panels/
  your-panel/
    index.js        # Panel manifest and handler
    assets/         # Optional static files (images, etc.)
```

## Panel Manifest

The `index.js` file exports a panel manifest object:

```js
export default {
  id: 'weather',
  name: 'Weather',
  icon: 'cloud',
  route: '/dashboard/weather',
  navOrder: 50,
  handler: async (req, res, { db, layout }) => {
    const content = `
      <h1>Weather Panel</h1>
      <p>Your custom content here.</p>
    `;
    return layout({ title: 'Weather', content });
  }
};
```

### Manifest Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier. Must match the directory name. |
| `name` | string | Display name in the navigation bar. |
| `icon` | string | Icon identifier (used in the nav). |
| `route` | string | URL path. Must start with `/dashboard/`. |
| `navOrder` | number | Position in the nav bar. Built-in panels use 1-10; use 50+ for add-ons. |
| `handler` | function | Express route handler. Receives `(req, res, context)`. |

### Home Screen Visibility

Panels automatically appear as tiles on the Crow's Nest home screen AND in the sidebar navigation. To hide a panel from both, set `hidden: true` in the manifest:

```js
export default {
  id: "my-panel",
  name: "My Panel",
  hidden: true, // Hidden from sidebar and home screen
  // ...
};
```

The panel route still works for direct URL access — `hidden` only affects navigation visibility.

## Handler Context

The `handler` function receives three arguments:

### req / res

Standard Express request and response objects. The request has already passed authentication and CSRF checks.

### context.db

The Crow database client. Use it to query any Crow table:

```js
const memories = await db.execute('SELECT * FROM memories ORDER BY created_at DESC LIMIT 10');
```

All standard `@libsql/client` methods are available (`execute`, `batch`, etc.).

### context.appRoot

The absolute path to the Crow source root directory. Use this to dynamically import shared modules like SVG logos or UI components:

```js
const { getAddonLogo } = await import(
  join(appRoot, 'servers/gateway/dashboard/shared/logos.js')
);
const logo = getAddonLogo('ollama', 32);
```

This is especially useful for third-party panels that need access to built-in shared components without hardcoding paths.

### context.layout

The layout function wraps your content in the Crow's Nest shell (navigation, theme, footer):

```js
return layout({ title: pageTitle, content: htmlContent });
```

Options:

| Option | Type | Description |
|---|---|---|
| `title` | string | Page title displayed in the header and browser tab. |
| `content` | string | Main HTML content for the page body. |
| `activePanel` | string | Panel ID to highlight in the nav. |
| `panels` | Array | Array of panel objects for the nav sidebar. |
| `theme` | string | Force `'dark'` or `'light'`. Usually omitted (uses user preference). |
| `scripts` | string | Additional inline JS to include on the page. |
| `afterContent` | string | HTML rendered after `</main>` inside the dashboard (e.g., fixed-position bars). |

### Global Player (`window.crowPlayer`)

Every dashboard page includes a persistent audio player bar. Your panel can use it to play audio without building its own player:

```js
// Play a single track
window.crowPlayer.load('/my-audio.mp3', 'Track Title', 'Subtitle');

// Queue multiple tracks
window.crowPlayer.queue([
  { src: '/track1.mp3', title: 'Track 1' },
  { src: '/track2.mp3', title: 'Track 2' },
]);
```

See [Platform Capabilities](/developers/platform-capabilities) for the full API reference.

## Example: Memory Stats Panel

A panel that shows memory storage statistics:

```js
export default {
  id: 'memory-stats',
  name: 'Memory Stats',
  icon: 'bar-chart',
  route: '/dashboard/memory-stats',
  navOrder: 51,
  handler: async (req, res, { db, layout }) => {
    const stats = await db.execute(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 END) as this_week,
        COUNT(CASE WHEN created_at > datetime('now', '-1 day') THEN 1 END) as today
      FROM memories
    `);

    const row = stats.rows[0];

    const content = `
      <h1>Memory Statistics</h1>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-value">${row.total}</span>
          <span class="stat-label">Total Memories</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${row.this_week}</span>
          <span class="stat-label">This Week</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${row.today}</span>
          <span class="stat-label">Today</span>
        </div>
      </div>
      <style>
        .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
        .stat-card { background: var(--crow-bg-elevated); padding: 1.5rem; border-radius: 8px; text-align: center; }
        .stat-value { display: block; font-size: 2rem; font-weight: bold; color: var(--crow-accent); }
        .stat-label { display: block; margin-top: 0.5rem; color: var(--crow-text-secondary); }
      </style>
    `;

    return layout({ title: 'Memory Stats', content });
  }
};
```

## Handling Forms

Panels can include forms for user interaction. POST routes are supported:

```js
export default {
  id: 'quick-note',
  name: 'Quick Note',
  icon: 'edit',
  route: '/dashboard/quick-note',
  navOrder: 52,
  handler: async (req, res, { db, layout }) => {
    if (req.method === 'POST') {
      const { note } = req.body;
      await db.execute({
        sql: 'INSERT INTO memories (content, context) VALUES (?, ?)',
        args: [note, 'quick-note-panel']
      });
      return res.redirect('/dashboard/quick-note?saved=1');
    }

    const saved = req.query.saved ? '<p class="success">Note saved.</p>' : '';

    const content = `
      <h1>Quick Note</h1>
      ${saved}
      <form method="POST" action="/dashboard/quick-note">
        <input type="hidden" name="_csrf" value="${req.csrfToken}" />
        <textarea name="note" rows="4" placeholder="Type a note..."></textarea>
        <button type="submit">Save</button>
      </form>
    `;

    return layout({ title: 'Quick Note', content });
  }
};
```

Note the `_csrf` hidden field — all POST requests require a valid CSRF token.

## Creating Notifications

Panels can create notifications via the shared helper. This is useful for confirming user actions or alerting about background events:

```js
import { createNotification } from "../../shared/notifications.js";

// Inside your handler:
await createNotification(db, {
  title: "Report generated",
  type: "system",
  source: "my-panel",
  action_url: "/dashboard/my-panel",
});
```

The helper respects user notification preferences set in Settings.

## Enabling Your Panel

After placing your panel in `~/.crow/panels/`, add it to `~/.crow/panels.json` (a JSON array of panel IDs):

```json
["memory-stats", "quick-note"]
```

Restart the gateway to pick up new panels.

## Styling

Use the Crow's Nest CSS custom properties for consistent theming:

- `--crow-bg-deep` / `--crow-bg-surface` / `--crow-bg-elevated` — Background layers (page, card, raised)
- `--crow-text-primary` / `--crow-text-secondary` / `--crow-text-muted` — Text hierarchy
- `--crow-accent` / `--crow-accent-hover` / `--crow-accent-muted` — Indigo accent and variants
- `--crow-brand-gold` — Gold accent for branding highlights
- `--crow-border` — Border color
- `--crow-success` / `--crow-error` / `--crow-info` — Semantic colors

These automatically adapt to dark and light modes. See the [Brand Identity](/architecture/dashboard#brand-identity) section for the full token table.

## Testing Locally

1. Create your panel directory in `~/.crow/panels/`
2. Add the `index.js` file
3. Enable it in `panels.json`
4. Start the gateway: `npm run gateway`
5. Open `http://localhost:3001/dashboard/your-panel-id`

## Turbo Drive compatibility

The Crow's Nest navigates between panels with [Turbo Drive](https://turbo.hotwired.dev/) when `CROW_ENABLE_TURBO=1` is set on the gateway. Turbo does an HTTP fetch, body-swaps the `<main>` content, and keeps the `<head>` + sidebar + persistent player bar in place. Normal panels work unchanged, but a few patterns need care:

### Idempotent inline scripts

Any `<script>` tag your panel emits inside the body **re-executes on every Turbo navigation into the panel**. If it attaches listeners to `document` / `window`, starts a `setInterval`, opens a `WebSocket`, or allocates any resource not owned by an element inside the panel root, it will leak (stacked listeners, multiplied pollers) every time the user visits.

The idiomatic fix is to track the resource on a `window.__myPanel*` global and clear the prior one on re-entry:

```js
<script>
(function() {
  // Clear any prior interval (from a previous nav into this panel)
  if (window.__myPanelPollInterval) {
    clearInterval(window.__myPanelPollInterval);
    window.__myPanelPollInterval = null;
  }

  async function poll() {
    var root = document.getElementById('my-panel-root');
    if (!root || !root.isConnected) {
      // Panel was swapped out — self-cancel
      clearInterval(window.__myPanelPollInterval);
      window.__myPanelPollInterval = null;
      return;
    }
    // ... fetch + render
  }

  poll();
  window.__myPanelPollInterval = setInterval(poll, 10000);
})();
</script>
```

**Element-level listeners** (click handlers on buttons inside the panel root) don't need any guard — they're attached to a fresh DOM on each nav and auto-GC with the old body when Turbo swaps.

**Document-level listeners** (e.g., `document.addEventListener('keydown', ...)` for a modal-closes-on-escape handler) should be attached once per document lifetime with a `window.__myBound` flag, and the callback should look up the current DOM via IDs rather than closing over specific elements.

### 303-after-POST for form responses

Turbo treats `302 Found` after a form POST as "stay on the current URL". For a submit to update the browser URL correctly, respond with `303 See Other`. The gateway exposes `res.redirectAfterPost(url)` as a helper:

```js
if (req.method === "POST" && req.body.action === "save") {
  await saveIt(req.body);
  return res.redirectAfterPost("/dashboard/my-panel?saved=1");
}
```

For `router.get(...)` routes (GET-after-GET redirects), plain `res.redirect(url)` is fine — Turbo treats a 302 after a GET correctly.

### Escape hatch: `data-turbo="false"`

To opt a specific link or form out of Turbo entirely, set `data-turbo="false"`:

```html
<a href="/dashboard/logout" data-turbo="false">Logout</a>
```

This is the pattern for auth-boundary links (logout, login). The gateway also intercepts `401` responses and redirects-to-`/dashboard/login` and forces a full reload via `turbo:before-fetch-response`, so session expiry is always handled safely.

### Iframe-embedding panels

A number of bundle panels (Jellyfin, Navidrome, Audiobookshelf, Paperless, Vaultwarden, Calibre-Web, Gitea, Stirling-PDF, Netdata, etc.) embed a third-party web UI inside an `<iframe>`. **Under Turbo, navigating to a different panel discards the iframe**, and coming back re-creates it — which means Jellyfin video restarts at 0:00, Vaultwarden's session can drop, Navidrome's in-browser player stops.

The pre-Turbo behavior was identical (full page reload also killed the iframe), but Turbo makes panel toggling feel instant, which encourages users to flip between panels more. Three media-session iframes (`jellyfin`, `navidrome`, `audiobookshelf`) are marked `data-turbo-permanent id="<panel>-iframe"` so the iframe survives in narrow same-panel scenarios (e.g., switching between the Overview and Web UI tabs of the same bundle). For broader persistence across panels, use the native Crow panel instead — the Music bundle's panel uses `window.crowPlayer` and the persistent player bar, which keeps audio playing across any panel navigation.

If you build an iframe-based panel, treat it as "visit once, stay focused" and steer users toward native equivalents for media playback.

### Debugging Turbo issues

The gateway ships an opt-in diagnostic overlay when `CROW_ENABLE_TURBO=1`. Append `?diag=turbo` to any dashboard URL to turn it on (persisted per browser via `localStorage.crowDiagTurbo`). The overlay shows Turbo boot state, `window.crowPlayer` availability, permanent-element init flags, recent `turbo:*` lifecycle events, and any uncaught errors or unhandled promise rejections. Append `?diag=off` to dismiss.
