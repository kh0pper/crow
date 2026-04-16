---
title: Music
---

# Music

Crow-native music player panel. Browse your Funkwhale library, play tracks through your browser or your paired Meta glasses, and get standard Android media-style notifications in the Crow Android app — all driven by a single persistent player bar that follows you as you navigate across Crow's Nest panels.

::: tip Why a dedicated Music panel?
Funkwhale's own web UI is capable, but it lives in its own origin and doesn't integrate with the Crow player bar, the glasses, or the Android media controls. The Music panel is a thin, Crow-native UI on top of Funkwhale's API that plugs into the rest of the platform.
:::

## What you get

- **Browse:** artists → albums → tracks, mobile-friendly grid + list layouts
- **Search:** debounced search across artists, albums, and tracks
- **Recent listens:** tracks you've played across all Crow surfaces (including voice-initiated playback on your glasses)
- **Browser playback:** `<audio>` streaming via a same-origin proxy — no CORS headaches, full seek support via HTTP Range requests
- **Glasses playback:** one-tap "Play on Glasses" button streams through the meta-glasses bundle to your paired Ray-Ban Meta (Gen 2)
- **Persistent player bar:** start playback, navigate to any other panel — the bar stays visible with play/pause/next/prev/stop controls
- **Android media controls:** when the Music panel runs inside the Crow Android app's WebView, the standard Android media notification card appears in the shade and on the lockscreen — with album art, title, artist, and play/pause/next/stop. Bluetooth headset media keys work automatically. No native code required.

## Setup

### Prerequisites

- A Funkwhale server with audio content (install the **Funkwhale** bundle, or point at an external Funkwhale instance). v1 of the Music panel is Funkwhale-only; Subsonic/Navidrome support is planned as a follow-up.
- `FUNKWHALE_URL` and `FUNKWHALE_ACCESS_TOKEN` configured in your Crow environment (inherited from the Funkwhale bundle).

### Install

1. Open **Crow's Nest → Extensions**.
2. Find **Music** (under Media) and click **Install**.
3. The Music tile appears on the Nest home screen and in the sidebar.
4. Open it — if Funkwhale is reachable, the browse view loads automatically. If not, you'll see a **Set up Funkwhale** CTA.

## Playing music

### In your browser

Tap the **▶ Play** button next to any track. Audio streams through the gateway (same-origin; Funkwhale's bearer token stays server-side) and plays in the persistent player bar at the bottom of the screen.

Seek forward/back works — the stream proxy forwards HTTP Range requests upstream.

### On your glasses

If you have Meta glasses paired (via the **Meta Glasses** bundle), a **👓 Play on Glasses** button appears on every track. Tap it → audio routes to your phone via WebSocket → decoded and played through your glasses' speakers.

If the glasses are already playing something, you'll see **"Glasses busy — stop current playback first"** instead of a misleading "queued" state. Say "stop" or press Stop in the player bar, then tap Play on Glasses again.

See [Meta Glasses → Music playback](/guide/meta-glasses#music-playback) for voice control options.

### Queueing tracks

- **+ Queue** on any track adds it to the current queue
- **Play All** on an album header queues every track in order
- The player bar shows ⏮ ⏭ when the queue has more than one entry
- Queue is client-local for browser playback; server-managed for glasses playback (so album chaining survives page reloads on the glasses side)

## Android media controls

When you open the Music panel inside the Crow Android app (not just a mobile browser), music playback registers with Android's `MediaSession` API automatically. You get:

- **Notification shade** card with album art, title/artist, and transport buttons
- **Lockscreen** playback controls (same card, full-screen)
- **Quick Settings** media player card on Android 13+
- **Bluetooth headset** play/pause/next hardware keys route through the same session

No separate app install, no permissions to grant — this is standard Chromium WebView + `navigator.mediaSession` behavior driven by the Crow player bar.

## How listens get recorded

Every time a track starts playing (browser OR glasses), the gateway fires a fire-and-forget POST to Funkwhale's `/api/v1/history/listenings/` endpoint. The **Recent** tab in the Music panel, and the **Recent Listens** section in the Funkwhale panel, both show the result.

This is per-track-on-start, not scrobble-grade ("50% or 4 minutes"). Good enough for "what did I listen to today?" use cases; not ideal for sharing listen counts publicly. A more sophisticated policy is out of scope for v1.

## Troubleshooting

**"Music needs a library" CTA showing** → The Funkwhale panel isn't reachable or `FUNKWHALE_URL` isn't set. Install the Funkwhale bundle or check `.env`.

**Tracks play but no album art** → Your Funkwhale library may not have cover art uploaded. The panel falls back to initial-letter placeholders. Uploading album art in Funkwhale's admin UI will fix this automatically.

**"Play on Glasses" button missing** → The Meta Glasses bundle isn't installed, or no glasses are currently paired. Check **Settings → Meta Glasses**.

**Seek doesn't work** → Check that your browser sent a Range request. Chrome/Firefox do this automatically for `<audio>`. If Funkwhale's upstream is behind a proxy that strips Range headers, seek falls back to re-downloading from byte 0.

**No Android media controls in the shade** → Ensure you're viewing the panel inside the Crow Android app (not a mobile browser tab). `navigator.mediaSession` needs same-document WebView context.

## Roadmap

- **Subsonic/Navidrome backend:** Mirror endpoints under `/api/subsonic/*` so the Music panel works with Navidrome or any OpenSubsonic-compatible server. Same UI, different backend. Planned follow-up.
- **Playlists, favorites, ratings:** Funkwhale supports these via API. Next polish pass.
- **Offline caching:** Service worker + native cache for the Crow Android app. Longer-term.

## See also

- [Meta Glasses](/guide/meta-glasses) — music playback via voice + glasses
- [Funkwhale integration](/integrations/funkwhale) — server setup and federation
- [Navidrome](/integrations/navidrome) — alternate music server (Subsonic-compatible; planned Music panel support)
