# Platform Capabilities

Crow provides several base capabilities that any bundle, panel, or skill can use. This page documents the APIs available for third-party developers.

## Media Playback (`window.crowPlayer`)

The Crow's Nest includes a persistent audio player bar that survives page navigation. Any panel can use it to play audio.

### API

```js
// Play a single track
window.crowPlayer.load(src, title, subtitle?)

// Queue multiple tracks (starts playing immediately)
window.crowPlayer.queue([
  { src: '/api/media/articles/1/audio', title: 'Article 1', subtitle: 'Source' },
  { src: '/api/media/articles/2/audio', title: 'Article 2' },
])

// Add to the end of the current queue
window.crowPlayer.addToQueue({ src, title, subtitle })

// Playback controls
window.crowPlayer.toggle()    // Play/pause
window.crowPlayer.next()      // Next track
window.crowPlayer.prev()      // Previous track (or restart if >3s in)
window.crowPlayer.close()     // Stop and hide player
window.crowPlayer.isPlaying() // Returns boolean

// Inspect queue
window.crowPlayer.getQueue()      // Returns [{src, title, subtitle}, ...]
window.crowPlayer.getQueueIndex() // Returns current index
```

### Features

- **Persistence**: Player state (track, position, queue) is saved to `localStorage` and restored on page load. Users can navigate between panels without losing playback.
- **Queue management**: Auto-advance to next track on `ended`. Previous button restarts the current track if more than 3 seconds in.
- **Seek bar**: Clickable progress bar with time display.
- **Responsive**: Adjusts position for mobile (sidebar hidden).

### Using from a Panel

Panels don't need to import anything. The player is injected into every dashboard page via the layout's `afterContent` slot:

```js
// In your panel handler:
export default {
  id: 'my-panel',
  async handler(req, res, { layout }) {
    const content = `
      <button onclick="window.crowPlayer.load('/my-audio.mp3', 'My Track')">
        Play Audio
      </button>
    `;
    return layout({ title: 'My Panel', content });
  }
};
```

## Notifications

Crow includes a notification system for surfacing reminders, media events, peer messages, and system alerts. Notifications appear in the header bell icon in the Crow's Nest and are queryable via MCP tools.

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/notifications` | GET | List notifications (query: `unread_only`, `type`, `limit`, `offset`) |
| `/api/notifications/count` | GET | Lightweight count + health data (for polling) |
| `/api/notifications/:id/dismiss` | POST | Dismiss or snooze (body: `snooze_minutes?`) |
| `/api/notifications/:id/read` | POST | Mark as read |
| `/api/notifications/dismiss-all` | POST | Bulk dismiss (body: `type?`) |

All endpoints require dashboard session authentication.

### MCP Tools

| Tool | Description |
|------|-------------|
| `crow_check_notifications` | Query pending notifications (unread_only, type, limit) |
| `crow_create_notification` | Create a notification (title, body, type, priority, action_url, metadata, expires_in_minutes) |
| `crow_dismiss_notification` | Dismiss or snooze by ID |
| `crow_dismiss_all_notifications` | Bulk dismiss (type, before) |
| `crow_notification_settings` | Get/set notification preferences |

### Creating Notifications from Bundles

Use the shared helper in `servers/shared/notifications.js`:

```js
import { createNotification } from "../../../servers/shared/notifications.js";

await createNotification(db, {
  title: "My event happened",
  body: "Details here",
  type: "system",        // reminder, media, peer, system
  source: "my-bundle",
  priority: "normal",    // low, normal, high
  action_url: "/dashboard/my-panel",
  expires_in_minutes: 60,
});
```

The helper checks user preferences (`notification_prefs` in `dashboard_settings`) and skips disabled types.

### Notification Types

| Type | Source | Description |
|------|--------|-------------|
| `reminder` | scheduler, MCP | Schedule-triggered or AI-created reminders |
| `media` | media bundle | Briefing ready, new content |
| `peer` | sharing server | New peer message received |
| `system` | scheduler, media | Feed errors, system alerts |

### Retention

- Max 500 notifications. The scheduler cleans up oldest dismissed, then oldest read when over limit.
- Expired notifications (those with `expires_at`) are removed on each query.
- Snoozed notifications are hidden until `snoozed_until` passes.

### Future Extension Points (v2)

**Notification Themes:** Custom bell/health icon rendering. Interface:

```js
// Future: register a custom notification theme
registerNotificationTheme({
  id: 'tamagotchi',
  renderBadge(count) { /* return HTML */ },
  renderDropdown(notifications) { /* return HTML */ },
});
```

**Notification Channels:** Delivery beyond the dashboard (email, webhook, Slack). Interface:

```js
// Future: register a delivery channel
registerNotificationChannel({
  id: 'email',
  async deliver(notification, config) { /* send email */ },
});
```

## Layout Extension

The `renderLayout()` function accepts several extension slots:

- `afterContent` — HTML rendered after `</main>` (used by the player bar at `position:fixed;bottom:0`)
- `headerIcons` — HTML rendered inside `.content-header`, right of the page title (used by notification bell and health status)
- `scripts` — Additional inline JS appended to the page

If you need additional fixed-position UI elements, pass them via `afterContent` in your layout call.

## Turbo Drive

The Crow's Nest uses [Turbo Drive](https://turbo.hotwired.dev/) to turn panel navigation into a body-swap instead of a full page reload. This is what keeps the player bar visible (and the audio playing) when the user clicks between panels. It also lets forms update the URL correctly after submit, without the white flash of a full reload.

### Enabling

Set `CROW_ENABLE_TURBO=1` on the gateway:

```bash
# systemd drop-in
sudo tee /etc/systemd/system/crow-gateway.service.d/turbo.conf > /dev/null <<'EOF'
[Service]
Environment=CROW_ENABLE_TURBO=1
EOF
sudo systemctl daemon-reload && sudo systemctl restart crow-gateway
```

Remove the drop-in to roll back. With the flag off, the dashboard renders exactly as before — all navigation is full page loads. Every piece of Turbo-specific code in the platform is either behaviour-neutral (e.g., `window.__*` idempotency guards) or gated on the flag (e.g., the `<script src="/vendor/turbo-8.0.5.umd.js">` injection).

### What the platform provides

- **Turbo 8.0.5 UMD** is vendored at `servers/gateway/public/vendor/turbo-8.0.5.umd.js`. When the flag is on, the layout's `<head>` injects it alongside `<meta name="turbo-cache-control" content="no-cache">` and `<meta name="view-transition" content="same-origin">`.
- **`res.redirectAfterPost(url)` helper** is mounted as gateway middleware and emits a `303 See Other` so Turbo correctly updates the browser URL after a form POST. (A plain `302 Found` after POST makes Turbo stay on the old URL.)
- **Persistent player bar**: `#crow-player-bar` and its nested `<audio>` carry `data-turbo-permanent`. Turbo preserves them across every panel nav, so audio state (queue, position, `window.crowPlayer`) survives.
- **Auth boundary interception**: a `turbo:before-fetch-response` listener forces a full `window.location.href` navigation on any `401` response or redirect to `/dashboard/login`, preventing a login page from being body-swapped into the authenticated layout.
- **Media-session iframe permanence**: the Jellyfin, Navidrome, and Audiobookshelf panels mark their iframes `data-turbo-permanent id="<panel>-iframe"` so media sessions survive same-panel tab switches (narrow scope — inter-panel nav still discards them; steer users toward native panels like the Music bundle for persistent playback).

### What panel authors need to know

See [Creating Panels → Turbo Drive compatibility](/developers/creating-panels#turbo-drive-compatibility) for the full guide. Key points:

- Any inline `<script>` inside the panel body re-executes on every Turbo nav into the panel. Track `setInterval` / document-level `addEventListener` resources on `window.__*` globals and clear the prior handle on re-entry, or they'll stack.
- Form handlers in `POST`/`PUT`/`PATCH`/`DELETE`/`all`/`use` routes should emit `res.redirectAfterPost(url)` instead of `res.redirect(url)`. The gateway's `scripts/migrate-redirect-303.js` codemod did this across the tree — run it again if you add new routes and want to stay consistent.
- Pages that cross the auth boundary (e.g., logout) should put `data-turbo="false"` on the link.

### Debugging

Append `?diag=turbo` to any dashboard URL (with the flag on) to open a fixed-position overlay that shows Turbo boot state, `window.crowPlayer` availability, permanent-element init flags, recent `turbo:*` lifecycle events, and any uncaught errors. The setting is persisted in `localStorage.crowDiagTurbo`. Append `?diag=off` to dismiss.

## Persistent Memory

All panels have access to the database via the `db` parameter passed to panel handlers. Use the `crow_context` table for settings and the `memories` table for stored data.

## Scheduling

Crow has a built-in scheduling system (`schedules` table). Register tasks with cron expressions:

```sql
INSERT INTO schedules (task, cron, config, enabled, created_at)
VALUES ('my-bundle:task', '0 8 * * *', '{"key":"value"}', 1, datetime('now'));
```

Your task runner polls the `schedules` table for due entries (`next_run <= now()`).

## Web Search (Brave)

When `BRAVE_API_KEY` is set, the Brave Search MCP server is available as an external integration. You can also call the Brave API directly:

```js
const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=query', {
  headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY }
});
```

## Storage (S3/MinIO)

When MinIO is configured, the storage server provides file upload, listing, presigned URLs, and deletion. See the [Storage API](/developers/storage-api) docs.

## P2P Sharing

The sharing server provides Hyperswarm-based peer discovery, Hypercore data replication, and Nostr encrypted messaging. Bundles can share data with peers using the `crow_share` tool.

## AI Chat (BYOAI)

The gateway includes an AI chat system that supports multiple providers (OpenAI, Anthropic, Google, Ollama). Configure via `.env` and use the `/api/chat/*` endpoints. See `servers/gateway/ai/` for the adapter pattern.
