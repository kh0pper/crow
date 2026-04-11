---
title: Notifications & Push
---

# Notifications & Push

Crow has a unified notification system that delivers alerts for calls, messages, reminders, media updates, and system events. Notifications appear in the Crow's Nest dashboard, on your phone via push, and through AI chat.

## Notification Types

| Type | Icon | Examples |
|------|------|----------|
| `reminder` | Bell | Scheduled reminders, recurring tasks |
| `media` | Newspaper | New podcast episodes, RSS items, briefings |
| `peer` | Speech bubble | Incoming messages, shared items, call invites |
| `system` | Gear | Extension installs, updates, backup results |

Each notification has a **priority** (low, normal, high) that affects display order and push urgency.

## Where Notifications Appear

### Dashboard bell / Tamagotchi

The notification indicator in the Crow's Nest header shows the unread count. Click it to see recent notifications in a dropdown. Each notification can be clicked (navigates to `action_url`) or dismissed.

The poll runs every 60 seconds and piggybacks system health data (CPU, RAM, disk) to avoid extra requests.

### Incoming call toast

When someone calls you, a slide-down banner appears at the top of any Crow's Nest page with **Accept** and **Dismiss** buttons. The toast auto-dismisses after 60 seconds. See [Calls](/guide/calls) for details.

### AI chat

Ask Crow about your notifications:

> "Check my notifications"
> "Any new messages?"
> "Dismiss all read notifications"

The `crow_check_notifications` and `crow_dismiss_notification` tools handle this.

## Notification Preferences

Go to **Settings > Notifications** in the Crow's Nest to control which types you receive:

- Enable/disable each type independently (reminder, media, peer, system)
- Disabled types are silently dropped before reaching the database

## Web Push

Browser push notifications deliver alerts even when the Crow's Nest tab is closed. Setup:

1. Go to **Settings > Notifications** in the Crow's Nest
2. Click **Enable Push Notifications**
3. Accept the browser permission prompt
4. Done. Notifications arrive as native OS notifications.

Web Push uses the VAPID protocol. Generate keys once:

```bash
npx web-push generate-vapid-keys
```

Add the keys to your `.env`:

```
VAPID_PUBLIC_KEY=BLx...
VAPID_PRIVATE_KEY=abc...
VAPID_EMAIL=mailto:you@example.com
```

### How it works

When `createNotification()` runs (any MCP tool, scheduler, or peer message handler), it:

1. Inserts the notification into the database
2. Sends a Web Push to all registered browser subscriptions
3. Sends an ntfy push if configured (see below)

All push delivery is non-blocking and fire-and-forget. A failed push never blocks the primary action.

## ntfy Bundle

[ntfy](https://ntfy.sh) is a lightweight push notification server. Crow's ntfy bundle runs a self-hosted instance alongside your gateway, delivering instant notifications to any device with the ntfy app.

### Why ntfy?

- Works when the browser is closed and the Crow app is in the background
- No Google/Apple push infrastructure required (self-hosted)
- Sub-second delivery
- Install the free ntfy app on Android (Play Store / F-Droid) or iOS (App Store)

### Installation

Install from the Extensions page or via CLI:

```bash
crow bundle install ntfy
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NTFY_TOPIC` | `crow` | Topic name (unique to your instance) |
| `NTFY_PORT` | `2586` | Server port (localhost only) |
| `NTFY_AUTH_TOKEN` | *(empty)* | Access token for private topics |

### Phone setup

1. Install the ntfy app on your phone
2. In the app, add a server: `http://<your-tailscale-ip>:2586`
3. Subscribe to your topic (default: `crow`)
4. All Crow notifications now push instantly to your phone

### Priority mapping

Crow notification priorities map to ntfy urgency levels:

| Crow | ntfy | Behavior |
|------|------|----------|
| `low` | 2 (low) | Silent delivery |
| `normal` | 3 (default) | Standard notification |
| `high` | 5 (urgent) | Bypasses Do Not Disturb |

### Tags

Notification types are mapped to ntfy emoji tags:

| Type | Tag | Emoji |
|------|-----|-------|
| `peer` | `incoming_envelope` | Envelope |
| `reminder` | `alarm_clock` | Alarm clock |
| `system` | `gear` | Gear |
| `media` | `musical_note` | Music note |

### Click actions

Each ntfy notification includes a click URL that opens the relevant page in your Crow's Nest (the notification's `action_url` prepended with your gateway URL).

## Notification Retention

- Maximum 500 notifications retained
- Expired notifications are cleaned up automatically
- When over the limit, dismissed notifications are removed first, then oldest read notifications

## Notification API

The Crow's Nest exposes a REST API for notifications (authenticated via dashboard session):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/notifications` | GET | List notifications (query: `unread_only`, `type`, `limit`, `offset`) |
| `/api/notifications/count` | GET | Lightweight count + system health (for polling) |
| `/api/notifications/:id/dismiss` | POST | Dismiss or snooze (body: `snooze_minutes`) |
| `/api/notifications/:id/read` | POST | Mark as read |
| `/api/notifications/dismiss-all` | POST | Bulk dismiss (body: `type` for filtering) |
