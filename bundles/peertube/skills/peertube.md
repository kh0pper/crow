---
name: peertube
description: PeerTube — federated video platform over ActivityPub. Upload, transcode, federate channels, WebTorrent/HLS streaming.
triggers:
  - "peertube"
  - "upload video"
  - "federated video"
  - "video channel"
  - "fediverse video"
  - "youtube alternative"
  - "webtorrent"
tools:
  - pt_status
  - pt_list_channels
  - pt_list_videos
  - pt_upload_video
  - pt_search
  - pt_subscribe
  - pt_unsubscribe
  - pt_rate_video
  - pt_block_user
  - pt_block_server
  - pt_defederate
  - pt_review_reports
  - pt_report_remote
  - pt_media_prune
---

# PeerTube — federated video on ActivityPub

PeerTube is the fediverse's YouTube-alternative. Videos are served via a combination of HLS playlists (HTTP) and WebTorrent (P2P) — viewers both pull from your instance and seed to each other, which is the protocol's scaling story. This bundle runs three containers: peertube (app + transcoding + HLS generator) + postgres + redis.

## Hardware — this is the heaviest bundle in the track

Gated by F.0's hardware check. **Refused** on hosts with <16 GB total RAM and <500 GB disk. Warned below 32 GB / 2 TB. Transcoding spikes RAM to 3-5 GB PER concurrent upload (ffmpeg x264); keep `PEERTUBE_TRANSCODING_CONCURRENCY=1` on 16 GB hosts. Storage is unbounded without S3 — a single 1080p30 video is ~500 MB in transcoded variants.

**If you're on a Pi or sub-16 GB VPS, this bundle won't install.** Consider using an existing PeerTube instance (lots of good ones at [joinpeertube.org](https://joinpeertube.org)) instead.

## S3 is load-bearing, not optional

Set these in `.env` before install:

```
PEERTUBE_S3_ENDPOINT=https://minio.example.com
PEERTUBE_S3_BUCKET=peertube-media
PEERTUBE_S3_ACCESS_KEY=...
PEERTUBE_S3_SECRET_KEY=...
```

`scripts/post-install.sh` detects these and runs `scripts/configure-storage.mjs`, which uses F.0's `storage-translators.peertube()` to populate the full `PEERTUBE_OBJECT_STORAGE_*` envelope (videos + streaming_playlists + web_videos + originals + user_exports all share the bucket; operators can split via manual YAML later).

Without S3, a single active channel fills a 500 GB disk within months. This is not a slippery slope — this is the design constraint.

## First-run bootstrap

1. Populate `.env` with `PEERTUBE_WEBSERVER_HOSTNAME`, `PEERTUBE_DB_PASSWORD`, and `PEERTUBE_SECRET` (32+ random chars; generate via `openssl rand -hex 32`). Strongly recommended: `PEERTUBE_S3_*` and `PEERTUBE_SMTP_*`.
2. Install. First boot runs migrations + generates the initial admin password. **Capture it from the logs immediately:**
   ```bash
   docker logs crow-peertube 2>&1 | grep -A1 "Username"
   ```
3. Expose via Caddy:
   ```
   caddy_add_federation_site {
     domain: "video.example.com",
     upstream: "peertube:9000",
     profile: "activitypub-peertube"
   }
   ```
   The `activitypub-peertube` profile wires WebSocket upgrade on `/socket.io` (federation + live updates) and sets large-body limits for video upload chunking.
4. Log in at https://video.example.com/ as `root` with the captured password. **Change it immediately:**
   ```bash
   docker exec -it crow-peertube npm run reset-password -- -u root
   ```
5. Obtain an OAuth bearer token:
   ```bash
   CLIENT=$(curl -s https://video.example.com/api/v1/oauth-clients/local)
   CLIENT_ID=$(echo "$CLIENT" | jq -r .client_id)
   CLIENT_SECRET=$(echo "$CLIENT" | jq -r .client_secret)
   curl -s -X POST https://video.example.com/api/v1/users/token \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&grant_type=password&username=root&password=<your-pw>"
   ```
   Copy `access_token` into `.env` as `PEERTUBE_ACCESS_TOKEN`, then `crow bundle restart peertube`.

## Common workflows

### Upload a video

```
pt_list_channels {}
# → grab a channel ID

pt_upload_video {
  "channel_id": 1,
  "file_path": "/home/kev/videos/presentation.mp4",
  "name": "Crow platform overview",
  "description": "Walkthrough of the memory and sharing layers",
  "privacy": "public",
  "tags": ["crow", "mcp", "fediverse"]
}
```

Transcoding runs in the background after upload; the video publishes immediately (unless `wait_transcoding: true`) but playback quality improves as variants complete. Poll via `GET /api/v1/videos/{id}` and watch `state.label`.

### Search + subscribe

```
pt_search { "q": "peertube demo" }
pt_subscribe { "handle": "cool-channel@peertube.tv" }
pt_list_videos { "scope": "subscriptions", "count": 20 }
```

First federated subscription on a given remote host is slow (15-30s) — initial channel backfill + actor fetch. Subsequent channels from that host are fast.

## Moderation

PeerTube's moderation is more structured than Mastodon's — abuse reports have predefined category taxonomies, and admins can block at video / account / server scope.

- **Inline (rate-limited):** `pt_block_user` (user-scoped blocklist), `pt_rate_video` with rating=none (un-like), `pt_report_remote` (file abuse report with predefined_reasons like hatefulOrAbusive, privacy, rights).
- **Queued (operator confirms in Nest within 72h):** `pt_block_server` (instance-wide blocklist), `pt_defederate` (block + unfollow + purge cache).
- **Admin read-only:** `pt_review_reports` (open abuses).
- **Media management:** `pt_media_prune` surfaces the `node dist/scripts/prune-storage.js` command — PeerTube schedules this automatically via `PEERTUBE_VIDEOS_CLEANUP_REMOTE_INTERVAL`.

## Cross-app notes

- **Blog cross-posting**: Video URLs embed inline in WriteFreely / Pixelfed / Mastodon posts (ActivityPub OEmbed). Scheduled "post to X when video publishes" lands with F.12.
- **Legal DMCA pipeline**: PeerTube admins receive takedown requests at `PEERTUBE_ADMIN_EMAIL`. This bundle does NOT implement automated DMCA handling — you must respond manually within your jurisdiction's timeframe (US: 14 days counternotice, etc.). Keep backups of contested videos before removing.

## Troubleshooting

- **"Cannot reach PeerTube"** — `docker ps | grep crow-peertube`. First boot runs migrations + ffmpeg sanity check (2-3 min).
- **"401 auth failed"** — token expired (PeerTube bearer tokens default to 24h). Refresh via `POST /api/v1/users/token` with `grant_type=refresh_token`.
- **"413 Payload Too Large" on upload** — Caddy default body limit. The `activitypub-peertube` profile raises this; for >2 GB uploads use the web UI's resumable-upload flow instead.
- **Transcoding stuck** — ffmpeg OOM killer. Lower `PEERTUBE_TRANSCODING_CONCURRENCY` or add swap. `docker logs crow-peertube 2>&1 | grep ffmpeg`.
- **Disk filling at terminal velocity** — you didn't enable S3. Stop publishing, enable S3 via `configure-storage.mjs`, then migrate existing media: `docker exec -it crow-peertube node dist/scripts/migrate-videos-to-object-storage.js`.
- **Federation retries forever** — `PEERTUBE_SECRET` rotated. Don't rotate the secret; it signs every outgoing federation request and remote peers will reject mismatches.
