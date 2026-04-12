---
name: changedetection
description: Watch webpages for changes — price drops, stock appearing, content updates — via changedetection.io
triggers:
  - "change detection"
  - "watch a webpage"
  - "notify when this page changes"
  - "price drop"
  - "track website"
tools:
  - changedetection_list_watches
  - changedetection_get_watch
  - changedetection_create_watch
  - changedetection_recheck
  - changedetection_list_changes
---

# Change Detection

changedetection.io tracks webpage changes and alerts the user when content
shifts. This bundle wraps its REST API with five MCP tools.

## First-run setup

1. Install and start the bundle. The UI comes up at `http://localhost:5010`.
2. Open it, go to **Settings > API**, and copy the API key.
3. Paste the key into Crow settings as `CHANGEDETECTION_API_KEY`.
4. Use the web UI or `changedetection_create_watch` to add watches.

Without an API key, every tool call fails with "authentication failed" —
this is expected. Direct the user to complete step 3.

## Workflows

### Add a watch

```
changedetection_create_watch {
  "url": "https://example.com/product/widget",
  "title": "Widget availability",
  "tag": "shopping"
}
```

Change Detection assigns a UUID. The first check happens on the next
scheduler tick (default 180 minutes); call `changedetection_recheck`
with the returned id to fetch immediately.

### "What changed recently?"

```
changedetection_list_changes { "limit": 20 }
```

Returns the 20 most recently changed watches, newest first.

### Review one watch

```
changedetection_get_watch { "id": "<uuid>" }
```

Returns full configuration plus last-check status and any error message.

### Recheck a single watch

```
changedetection_recheck { "id": "<uuid>" }
```

Queues a fetch immediately. The response may return before the fetch
finishes — poll `changedetection_get_watch` to see the updated
`last_checked` timestamp.

## Notifications

Notification URLs (ntfy, Discord, email, etc.) are configured per-watch
in the web UI under the **Notifications** tab. This bundle does not wrap
notification CRUD — it's a rarely-changed setting that's clumsy in an
MCP call.

## Error handling

- **"authentication failed"** — API key is wrong or unset; point the user
  at Settings > API.
- **"cannot reach Change Detection"** — container is down; check
  `docker ps` for `crow-changedetection`.
- **"not found"** — the watch UUID doesn't exist; list first.
