---
name: pixelfed
description: Pixelfed — federated photo-sharing on ActivityPub. Post photos, browse timelines, follow remote accounts, moderate.
triggers:
  - "pixelfed"
  - "photo post"
  - "fediverse photo"
  - "share photo"
  - "instagram alternative"
  - "photo feed"
  - "post picture"
tools:
  - pf_status
  - pf_post_photo
  - pf_feed
  - pf_search
  - pf_follow
  - pf_unfollow
  - pf_block_user
  - pf_mute_user
  - pf_block_domain
  - pf_defederate
  - pf_review_reports
  - pf_report_remote
  - pf_import_blocklist
  - pf_media_prune
---

# Pixelfed — federated photo-sharing

Pixelfed is the fediverse's Instagram-alternative: upload photos, browse a chronological feed, follow accounts on any ActivityPub-compatible server (Mastodon, GoToSocial, Funkwhale, other Pixelfed pods). Its REST API is Mastodon v1/v2 compatible, so tool patterns match the GoToSocial bundle closely.

## Hardware

Gated by F.0's hardware check. Refused below **1.5 GB effective RAM after committed bundles**, warned below 8 GB total. Disk grows with your library + remote-media cache: 10-50 GB within weeks of active federation is typical. The horizon queue worker is memory-hot when processing image transforms.

## Storage: local disk

Media lives on local disk (`~/.crow/pixelfed/storage/` + `~/.crow/pixelfed/uploads/`). Crow does not set up object storage for this bundle: Pixelfed hands out bucket URLs (`AWS_URL`) to browsers and remote servers, so the bucket must be publicly reachable. A host-local MinIO is not reachable that way, so the install form no longer offers S3 fields.

To move to a public S3 bucket by hand: add `PIXELFED_S3_ENDPOINT`, `PIXELFED_S3_BUCKET`, `PIXELFED_S3_ACCESS_KEY` and `PIXELFED_S3_SECRET_KEY` to the installed bundle's `.env` (`~/.crow/bundles/pixelfed/.env`), run `node ~/.crow/bundles/pixelfed/scripts/configure-storage.mjs` (it writes the `storage-translators.pixelfed()` envelope into the same `.env`), then recreate the containers from Extensions (Restart).

## First-run bootstrap

1. Nothing to generate: Crow creates `PIXELFED_APP_KEY` (Laravel `base64:` form) and the database password at install.
2. After install, expose via Caddy:
   ```
   caddy_add_federation_site {
     domain: "photos.example.com",
     upstream: "pixelfed:80",
     profile: "activitypub"
   }
   ```
3. Create the admin user:
   ```bash
   docker exec -it crow-pixelfed php artisan user:create
   ```
4. Log in at https://photos.example.com/, go to **Settings → Development → New Application** (grant `read write follow push`), then generate a Personal Access Token.
5. Paste that token into `.env` as `PIXELFED_ACCESS_TOKEN` and restart:
   ```
   crow bundle restart pixelfed
   ```

## Common workflows

### Post a photo

```
pf_post_photo {
  "file_path": "/home/kev/photos/2026/sunset.jpg",
  "caption": "Dusk over the ridge",
  "alt_text": "Orange and purple sky over a forested ridge at sunset",
  "visibility": "public"
}
```

Pixelfed enforces EXIF stripping by default (privacy). Alt text is strongly encouraged — screen readers and search rely on it.

### Browse + search

```
pf_feed { "source": "home", "limit": 20 }
pf_search { "query": "landscape", "type": "hashtags" }
pf_search { "query": "@alice@mastodon.social", "resolve": true }
```

### Follow remote accounts

```
pf_follow { "handle": "@bob@photog.example" }
```

First federated follow on a given remote server takes several seconds (WebFinger + actor fetch); subsequent follows to that server are fast.

## Moderation

**Moderation is not optional on a federated photo server.** Before opening registration or joining large hubs:

1. Import a baseline blocklist:
   ```
   pf_import_blocklist { "source": "iftas", "confirm": "yes" }
   ```
   QUEUED — confirm in the Nest panel within 72h.

2. Configure IFTAS / Bad Space feed refresh (operator task until F.11 exposes schedule hooks).

- **Inline (rate-limited, fires immediately):** `pf_block_user`, `pf_mute_user`, `pf_report_remote`.
- **Queued (operator confirms in Nest within 72h):** `pf_block_domain`, `pf_defederate`, `pf_import_blocklist`.
- **Disk management:** `pf_media_prune { older_than_days: 7, confirm: "yes" }` forces an aggressive pass beyond the scheduled horizon job.

**CSAM / illegal imagery**: zero tolerance. The instance admin has legal liability in most jurisdictions. If you receive a federated post containing such material, take the instance offline (`crow bundle stop pixelfed`), preserve logs, and contact a lawyer + the relevant national cybertip hotline before taking any other action.

## Cross-app notes

- **Blog cross-posting**: Pixelfed's API surfaces post URLs that WriteFreely and GoToSocial can embed (OEmbed preview works). For scheduled crosspost: wait for F.12's cross-app bridge work.
- **Sharing integration**: remote Pixelfed accounts you follow will appear as `contacts` with `external_source = 'pixelfed'` once F.11 identity attestation lands.

## Troubleshooting

- **"Cannot reach Pixelfed"** — `docker ps | grep crow-pixelfed`. First boot runs Laravel migrations + key-generate; can take 2+ minutes.
- **Horizon not processing uploads** — `docker logs crow-pixelfed-horizon`. Redis connectivity is the usual culprit.
- **"413 Payload Too Large"** — bump `PIXELFED_MAX_PHOTO_SIZE` (KB, default 15000 = 15 MB) and restart. The internal nginx in the `zknt/pixelfed` image honors the env var.
- **Disk filling** — federated cache. Lower `PIXELFED_MEDIA_RETENTION_DAYS` or run `pf_media_prune` manually.
- **Federation posts take forever** — horizon queue backlog. Check queue depth in the web UI's **Admin → Horizon** dashboard.
