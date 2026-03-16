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

## Layout Extension

The `renderLayout()` function accepts an `afterContent` parameter for content rendered after `</main>` inside the dashboard container. The player bar uses this slot. If you need additional fixed-position UI elements, pass them via `afterContent` in your layout call.

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
