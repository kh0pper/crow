---
name: funkwhale
description: Funkwhale — federated music server. Library, upload, search, channels, playlists, moderation over ActivityPub.
triggers:
  - "funkwhale"
  - "federated music"
  - "music server"
  - "upload track"
  - "follow channel"
  - "playlist"
  - "fediverse audio"
tools:
  - fw_status
  - fw_list_library
  - fw_search
  - fw_upload_track
  - fw_follow
  - fw_unfollow
  - fw_playlists
  - fw_create_playlist
  - fw_get_playlist_tracks
  - fw_add_to_playlist
  - fw_remove_from_playlist
  - fw_delete_playlist
  - fw_now_playing
  - fw_block_user
  - fw_mute_user
  - fw_block_domain
  - fw_defederate
  - fw_media_prune
---

# Funkwhale — federated music on ActivityPub

Funkwhale is a self-hosted music + podcast server that federates over ActivityPub. Remote Mastodon/GoToSocial/Pixelfed users can follow your channels; your pod can subscribe to remote channels and libraries and keep local caches of the audio. The bundle runs six containers: api, celeryworker, celerybeat, an internal nginx (Funkwhale's file-server), postgres, redis.

## Hardware

Gated by F.0's hardware check. Refused below **1.5 GB effective RAM after committed bundles**, warned below 8 GB total. Disk grows with your library — expect 5-20 GB for 1000 tracks; federated caches add hundreds of MB. Celery workers and the Django API are the memory-hot paths.

## Storage: on-disk or S3

Default: audio files live in `~/.crow/funkwhale/data/media`. To route to MinIO or external S3, set these in `.env` before install:

```
FUNKWHALE_S3_ENDPOINT=https://minio.example.com
FUNKWHALE_S3_BUCKET=funkwhale-audio
FUNKWHALE_S3_ACCESS_KEY=...
FUNKWHALE_S3_SECRET_KEY=...
```

`scripts/post-install.sh` detects these and runs `scripts/configure-storage.mjs`, which uses F.0's `storage-translators.funkwhale()` to write the `AWS_*` env vars Funkwhale actually reads. MinIO presence alone is not enough — you must also set the bucket + credentials because Funkwhale needs per-bundle isolation.

## First-run bootstrap

1. After install, Caddy exposes Funkwhale:
   ```
   caddy_add_federation_site {
     domain: "music.example.com",
     upstream: "funkwhale-nginx:80",
     profile: "activitypub"
   }
   ```
2. Create the superuser:
   ```bash
   docker exec -it crow-funkwhale-api funkwhale-manage createsuperuser
   ```
3. Open https://music.example.com/ and log in.
4. Go to **Settings → Applications → New application** (grant all scopes), then create a **Personal Access Token**.
5. Paste that token into `.env` as `FUNKWHALE_ACCESS_TOKEN`, then restart the MCP server (`crow bundle restart funkwhale`).

## Common workflows

### Upload a local file

```
fw_list_library {}
# → grab a library UUID

fw_upload_track {
  "library_uuid": "3b2a…",
  "file_path": "/home/kev/music/my-song.flac",
  "import_reference": "my-own"
}
```

Uploads go through Celery for tagging/transcoding — check status via the web UI's **Library → Uploads** list.

### Search

```
fw_search { "q": "radiohead", "type": "artists" }
fw_search { "q": "no surprises", "type": "tracks" }
```

Searches hit the local catalog + any federated content your pod has cached. Channel/library searches surface remote actors.

### Follow a remote channel

```
fw_follow {
  "target_type": "channel",
  "target": "@label@music.remote-pod.example"
}
```

For libraries, use the library UUID shown on the remote pod's library page. First federation fetch can take 30+ seconds while Celery pulls the library contents.

### Building playlists

Five tools cover the full lifecycle: `fw_playlists` (list), `fw_create_playlist`, `fw_get_playlist_tracks`, `fw_add_to_playlist`, `fw_remove_from_playlist`, `fw_delete_playlist`. Track IDs are integers from `fw_search` with `type: "tracks"` (not UUIDs).

Canonical create-and-fill sequence:

```
1. fw_search { "q": "vashti bunyan", "type": "tracks", "page_size": 5 }
   → collect ids from results[].id

2. fw_create_playlist { "name": "Folk Sunday", "privacy_level": "me" }
   → returns { id: 7, name, privacy_level, ... }

3. fw_add_to_playlist {
     "playlist_id": 7,
     "track_ids": [18488, 18487, 18486]
   }
   → returns { added_count, added: [{ index, track_id, title }, ...] }

4. (optional) fw_get_playlist_tracks { "playlist_id": 7 }
   → reads back the playlist in order so you can confirm before reporting to the user
```

**privacy_level** must be one of `me` / `followers` / `instance` / `everyone`. Default to `"me"` (private). Only escalate when the user explicitly says "share with my followers", "let everyone on the pod see this", or "make it federated/public" — privacy upgrades on a personal music collection are sticky and embarrassing to undo.

**allow_duplicates** on `fw_add_to_playlist` defaults to `true` because Funkwhale 1.2.x returns 500 on duplicate tracks when the flag is unset. If the user explicitly says "don't add tracks that are already in there", call `fw_get_playlist_tracks` first, filter the new IDs against the existing `track_id`s, and pass `allow_duplicates: false`.

**Removing a track:** indices are 0-based and re-pack after each removal. Re-read with `fw_get_playlist_tracks` between removes if you're removing more than one — don't trust cached indices.

```
fw_remove_from_playlist { "playlist_id": 7, "index": 1 }
```

**Deleting a playlist** is permanent and requires `confirm: true` plus explicit conversational confirmation. Don't call this just because the user said "clear my playlist" — they may mean remove all tracks, not delete the playlist itself.

```
fw_delete_playlist { "playlist_id": 7, "confirm": true }
```

### Moderation

- **Inline (rate-limited, fires immediately):** `fw_block_user`, `fw_mute_user`
- **Queued (operator must confirm in the Nest panel within 72h):** `fw_block_domain`, `fw_defederate`
- **Manual prune:** `fw_media_prune { "older_than_days": 7, "confirm": "yes" }`

Queued moderation is the plan's human-in-the-loop enforcement — the rate limiter + `confirm: "yes"` are advisory; the real gate is the operator clicking "Apply" in the Nest. For single-user/channel bans, inline is fine; for instance-wide blocks, the 72h review window is load-bearing.

## Cross-app notes

- **Blog cross-posting**: Funkwhale doesn't write long-form posts, but audio tracks can be embedded in WriteFreely or GoToSocial posts by pasting the track page URL (their ActivityPub OEmbed preview works).
- **Sharing integration**: remote Funkwhale channels you follow appear as `contacts` with `external_source = 'funkwhale'` once F.11 identity attestation lands.

## Troubleshooting

- **"Cannot reach Funkwhale"** — `docker ps | grep crow-funkwhale`. First boot can take 2+ minutes while Django migrations run.
- **Federation tester green but remote pods can't see your content** — verify `FUNKWHALE_HOSTNAME` matches the public domain exactly (case-sensitive). ActivityPub actor URLs use this hostname.
- **Uploads fail with "413 Payload Too Large"** — bump `FUNKWHALE_NGINX_MAX_BODY_SIZE` in `.env` (default 100M) and restart the nginx container.
- **Celery queue piling up** — `docker logs crow-funkwhale-celeryworker`. Large library imports can saturate the worker; increase `FUNKWHALE_CELERYD_CONCURRENCY` if you have CPU headroom.
- **Disk filling** — federated cache. Run `fw_media_prune { older_than_days: 7, confirm: "yes" }` or lower the celerybeat prune schedule in the web UI's **Administration → Settings → Music**.
