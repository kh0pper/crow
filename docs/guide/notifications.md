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

### Automatic setup

Crow wires itself to the server — there is nothing to copy into `.env`:

1. After the extension installs (and once at gateway start, if it is installed but not set up yet), Crow creates its **own login** on the ntfy server — a publish-only user and a read-only user, each with a token — and a **private topic** named after this instance (`crow-<instance id>`). The server runs with deny-all default access and the topic is closed to anonymous users, so only Crow and your phone can use it.
2. The Crow Android app fetches the server address, topic and the **read-only** token from `GET /api/push/ntfy-config` after you sign in. The publish token never leaves the gateway.
3. **Settings › Notifications › Phone notifications** shows the channel, the address phones use, when a phone last fetched the settings, and whether the last notification was accepted — plus **Send test notification** and **Check and repair**.

Set **Address phones use** to the HTTPS address your phone reaches the server at (for example a Tailscale Serve port such as `https://your-computer.your-tailnet.ts.net:8445`). Left empty, Crow uses this gateway's address with the server's port, which matches the Tailscale HTTPS rule the installer adds.

Several Crow instances on one computer can share one ntfy server: each instance gets its own login, topic and tokens (keyed by its instance id). The settings live in `<data dir>/ntfy-push.json` (mode 0600) — outside the database on purpose, so corruption alerts can still be pushed when the database is damaged.

### Configuring by environment (advanced)

If `NTFY_TOPIC` is set in the gateway's environment, Crow uses the environment exactly as before and does not set anything up automatically:

| Variable | Default | Description |
|----------|---------|-------------|
| `NTFY_TOPIC` | *(unset)* | Topic to publish to; setting it turns automatic setup off |
| `NTFY_AUTH_TOKEN` | *(empty)* | Token used to publish (and handed to apps unless `NTFY_SUBSCRIBER_TOKEN` is set) |
| `NTFY_SUBSCRIBER_TOKEN` | *(empty)* | Read-only token handed to apps instead of `NTFY_AUTH_TOKEN` |
| `NTFY_EXTRA_TOPICS` | *(empty)* | Extra topics the app subscribes to (comma-separated; environment mode only) |
| `NTFY_EXTERNAL_URL` | *(derived)* | Address phones use; overrides the Settings field |
| `NTFY_HOST` / `NTFY_PORT` | `localhost` / `2586` | Where the gateway publishes |

`CROW_DISABLE_NTFY_AUTOWIRE=1` turns off the boot-time setup. Uninstalling the extension revokes this Crow's notification tokens.

### Other ntfy apps

The standalone ntfy app works too: add the server address, then subscribe to the topic shown in Settings with a read-only token (`docker exec crow-ntfy ntfy token list crow-<id>-app`).

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
