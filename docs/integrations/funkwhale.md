---
title: Funkwhale
---

# Funkwhale

Connect Crow to [Funkwhale](https://funkwhale.audio/), a self-hosted music and podcast server that federates over ActivityPub. Browse and search your library, upload tracks, manage playlists, follow remote channels across the fediverse, and moderate your pod — all through your AI assistant.

## What You Get

- Browse and search your music library
- Upload tracks
- Create and manage playlists (add, remove, reorder, delete)
- Follow and unfollow remote channels and libraries over ActivityPub
- See what's currently playing
- Moderation: block/mute users, block or defederate domains, prune cached media

## Setup

Funkwhale is installed as a Crow bundle. It runs six containers (api, celeryworker, celerybeat, an internal nginx file-server, postgres, redis) alongside your Crow gateway.

> "Crow, install the Funkwhale bundle"

Or install from the **Extensions** panel in the Crow's Nest.

### Hardware

The bundle is gated by a hardware check: it refuses to install below **1.5 GB effective RAM** (after already-committed bundles) and warns below 8 GB total. Disk grows with your library — expect roughly 5–20 GB per 1,000 tracks, plus hundreds of MB for federated caches.

### Storage: local disk or Shared Storage

By default, audio files live in `~/.crow/funkwhale/data/media`. If **Settings → Shared Storage** is set up when you install, the installer points Funkwhale at a `<prefix>-funkwhale` bucket there instead. The install form has no per-bundle S3 fields.

### Federation

Funkwhale federates over ActivityPub: remote Mastodon / GoToSocial / Pixelfed users can follow your channels, and your pod can subscribe to remote channels and libraries (keeping local caches of the audio). Expose it on its own domain via Caddy as part of first-run bootstrap.

## AI Tools

Once installed, you can interact with Funkwhale through your AI:

> "What's in my Funkwhale library?"

> "Search my music for ambient"

> "Upload this track to Funkwhale"

> "Follow that channel"

> "Create a playlist called Focus"

> "What's playing right now?"

## Troubleshooting

### Bundle won't install

Check the hardware gate — Funkwhale refuses to install below 1.5 GB of effective RAM after other bundles are accounted for. Free up memory or stop another bundle and retry.

### Uploads fail or audio doesn't play

If Shared Storage was set up at install, confirm it is reachable (Settings → Shared Storage) and that the `<prefix>-funkwhale` bucket exists and is writable. Without Shared Storage, Funkwhale keeps media on disk under `~/.crow/funkwhale/data/media`.

### Federation not working

Funkwhale must be reachable on its own public domain over HTTPS for ActivityPub to work. Confirm the Caddy federation site is configured and the domain resolves.
