---
name: mastodon
description: Mastodon — flagship federated microblog over ActivityPub. Toot, timelines, follow remote accounts, moderation, admin.
triggers:
  - "mastodon"
  - "toot"
  - "fediverse"
  - "activitypub"
  - "follow @user@"
  - "federated timeline"
  - "mastodon instance"
tools:
  - mastodon_status
  - mastodon_post
  - mastodon_post_with_media
  - mastodon_feed
  - mastodon_search
  - mastodon_follow
  - mastodon_unfollow
  - mastodon_block_user
  - mastodon_mute_user
  - mastodon_block_domain
  - mastodon_defederate
  - mastodon_import_blocklist
  - mastodon_review_reports
  - mastodon_report_remote
  - mastodon_media_prune
---

# Mastodon — the flagship ActivityPub microblog

Mastodon is the reference Mastodon-API implementation. This bundle runs a full-fat instance — web (Rails/Puma), streaming (Node), sidekiq (background jobs), postgres, redis — on the shared `crow-federation` network. If you already ran F.1 GoToSocial, many tools here will look familiar: the verb taxonomy is identical, and Mastodon just exposes a larger admin surface.

## Hardware — this is the heaviest small-AP bundle

Gated by F.0's hardware check. Refused below **3 GB effective RAM after committed bundles**; warns below 8 GB total. Typical idle ~3 GB; under active federation 6 GB+. Media cache grows 10-100 GB within weeks without S3 storage. If you're running on a Pi or a 4 GB VPS, this bundle is not a good fit — consider F.1 GoToSocial instead.

## LOCAL_DOMAIN is immutable

`MASTODON_LOCAL_DOMAIN` appears in user handles (`@user@example.com`) and in every ActivityPub actor/object URL. **Once the instance federates with anyone, changing LOCAL_DOMAIN abandons every federated identity.** Pick the domain you intend to keep forever before first boot. If you need domain-delegation (federation on the apex, web UI on a subdomain), set `MASTODON_WEB_DOMAIN` and use Caddy's `matrix-server`-style `.well-known/webfinger` delegation (the F.0 caddy helper supports it).

## Generate the crypto secrets

Mastodon needs three secrets in `.env` before first boot. Generate them with the image itself:

```bash
# SECRET_KEY_BASE + OTP_SECRET (128 hex chars each):
docker run --rm ghcr.io/mastodon/mastodon:v4.3.0 bundle exec rake secret
docker run --rm ghcr.io/mastodon/mastodon:v4.3.0 bundle exec rake secret

# VAPID keypair (for Web Push):
docker run --rm ghcr.io/mastodon/mastodon:v4.3.0 bundle exec rake mastodon:webpush:generate_vapid_key
# → paste the two lines into MASTODON_VAPID_PRIVATE_KEY + MASTODON_VAPID_PUBLIC_KEY
```

## First-run bootstrap

1. Populate `.env` with all six required secrets + `MASTODON_LOCAL_DOMAIN` + `MASTODON_DB_PASSWORD`. Optionally add `MASTODON_SMTP_*` for registration email.
2. Install. The entrypoint runs `db:migrate` + `assets:precompile` on first boot (2-3 minutes).
3. Expose via Caddy:
   ```
   caddy_add_federation_site {
     domain: "mastodon.example.com",
     upstream: "mastodon-web:3000",
     profile: "activitypub-mastodon"
   }
   ```
   The `activitypub-mastodon` profile wires `/api/v1/streaming` → `mastodon-streaming:4000` and sets the static-asset cache headers Mastodon expects.
4. Create the admin account:
   ```bash
   docker exec -it crow-mastodon-web \
     bin/tootctl accounts create admin \
       --email you@example.com --confirmed --role Admin
   ```
5. Log in at https://mastodon.example.com/. Go to **Settings → Development → New Application**, grant `read write follow push admin:read admin:write`, copy the access token into `.env` as `MASTODON_ACCESS_TOKEN`, then:
   ```
   crow bundle restart mastodon
   ```

## Storage: on-disk or S3

On-disk by default (`~/.crow/mastodon/system/`). To route to MinIO / external S3, set these in `.env` before install:

```
MASTODON_S3_ENDPOINT=https://minio.example.com
MASTODON_S3_BUCKET=mastodon-media
MASTODON_S3_ACCESS_KEY=...
MASTODON_S3_SECRET_KEY=...
```

`scripts/post-install.sh` detects these and runs `scripts/configure-storage.mjs`, which uses F.0's `storage-translators.mastodon()` to emit the `S3_*` envelope Mastodon actually reads. This is load-bearing on any active instance — without S3, local disk consumption scales with follow count.

## Common workflows

### Toot

```
mastodon_post {
  "status": "Hello from Crow",
  "visibility": "public"
}
```

### Post a photo

```
mastodon_post_with_media {
  "file_path": "/home/kev/photos/sunset.jpg",
  "caption": "Dusk over the ridge",
  "alt_text": "Orange and purple sky over a forested ridge",
  "visibility": "public"
}
```

Mastodon 4.x uses async media upload (`POST /api/v2/media` returns 202 for large files); the tool polls for completion before publishing the status. Timeout ~30s.

### Follow remote accounts

```
mastodon_follow { "handle": "@alice@mastodon.social" }
```

First follow against a given remote instance does WebFinger + actor fetch (5-30s); subsequent follows are fast.

### Timelines + search

```
mastodon_feed { "source": "home", "limit": 20 }
mastodon_feed { "source": "local", "limit": 10 }
mastodon_search { "query": "#photography", "type": "hashtags" }
mastodon_search { "query": "@bob@example.com", "resolve": true }
```

## Moderation

- **Inline user-level (rate-limited):** `mastodon_block_user`, `mastodon_mute_user`, `mastodon_block_domain` (user-scoped — hides all accounts from a domain for THIS user, not instance-wide).
- **Queued instance-level (operator confirms in Nest within 72h):** `mastodon_defederate` (admin `/api/v1/admin/domain_blocks` — choose severity: `silence`, `suspend`, or `noop`), `mastodon_import_blocklist` (IFTAS / Bad Space / custom URL).
- **Admin read-only:** `mastodon_review_reports` (open reports), `mastodon_report_remote` (file a report against a remote account, optionally with status_ids attached).
- **Media management:** `mastodon_media_prune` surfaces the `bin/tootctl media remove --days N` recipe — Mastodon keeps media prune as CLI rather than HTTP API to prevent accidental mass deletion.

## Cross-app integration

- **F.1 GoToSocial, F.5 Pixelfed**: all three speak the same Mastodon API. Crow contacts discovered on any of them federate together. F.7 validates the verb taxonomy scales; duplicate `resolveAccount()` code across the three bundles is deliberate for installed-standalone deployments.
- **F.3 Matrix-Dendrite**: no direct federation (AP vs Matrix are different protocols), but F.12's `matrix-bridges` bundle can bridge Mastodon toots into Matrix rooms via `mautrix-twitter`-style bridges (lands with F.12).
- **Blog cross-posting**: WriteFreely / Pixelfed / Funkwhale content URLs Mastodon can embed inline (ActivityPub OEmbed).

## Troubleshooting

- **"Cannot reach Mastodon"** — first boot runs migrations + asset precompile (2-3 min). `docker logs crow-mastodon-web`. Healthcheck has 180s start_period for this reason.
- **"401 auth failed"** — your token doesn't have the right scopes. For admin tools (`mastodon_defederate`, `mastodon_review_reports`), the OAuth application must include `admin:read` + `admin:write`.
- **"413 Payload Too Large" on media upload** — Mastodon's default is 10 MB images / 40 MB video. Override via nginx / Caddy `request_body_max`. The bundled compose doesn't override it.
- **Sidekiq queue growing** — `docker logs crow-mastodon-sidekiq`. DB performance is the usual bottleneck; check postgres memory / disk.
- **Federation delivery retrying forever** — classic fediverse failure mode. `bin/tootctl accounts cull` prunes dead remote accounts; scheduled sidekiq job also handles this.
- **Disk filling fast** — remote media cache. Run `mastodon_media_prune`, lower `MASTODON_MEDIA_RETENTION_DAYS` (default 14), or enable S3 storage.
