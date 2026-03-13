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
