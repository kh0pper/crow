---
name: lemmy
description: Lemmy — federated link aggregator + discussion platform. Posts, comments, communities, votes, moderation over ActivityPub.
triggers:
  - "lemmy"
  - "link aggregator"
  - "reddit alternative"
  - "subscribe community"
  - "post link"
  - "fediverse discussion"
  - "upvote"
tools:
  - lemmy_status
  - lemmy_list_communities
  - lemmy_follow_community
  - lemmy_unfollow_community
  - lemmy_post
  - lemmy_comment
  - lemmy_feed
  - lemmy_search
  - lemmy_block_user
  - lemmy_block_community
  - lemmy_block_instance
  - lemmy_defederate
  - lemmy_review_reports
  - lemmy_media_prune
---

# Lemmy — federated link aggregator

Lemmy is the fediverse's Reddit-alternative: link posts, threaded comments, community subscriptions, upvotes. Federation is **community-scoped** (not user-scoped like Mastodon) — following a community on a remote Lemmy/Kbin pulls all its posts and comments to your instance.

## Hardware

Gated by F.0's hardware check. Refused below **1 GB effective RAM after committed bundles**, warned below 4 GB total. Pi-class hosts (4-8 GB) handle Lemmy fine when it's the only federated bundle. Disk growth is driven by pict-rs federated image cache — 5-20 GB within weeks of active federation.

## First-run bootstrap

1. After install, expose via Caddy:
   ```
   caddy_add_federation_site {
     domain: "lemmy.example.com",
     upstream: "lemmy-ui:1234",
     profile: "activitypub"
   }
   ```
2. Open https://lemmy.example.com/ and complete the setup wizard (admin username + password + site name). The compose entrypoint writes a placeholder `admin_pending` account; the web wizard replaces it.
3. Obtain an auth JWT:
   ```bash
   curl -X POST https://lemmy.example.com/api/v3/user/login \
     -H 'Content-Type: application/json' \
     -d '{"username_or_email":"admin","password":"<pw>"}'
   ```
   Copy `jwt` from the response into `.env` as `LEMMY_JWT`, then `crow bundle restart lemmy`.

## Common workflows

### Follow a federated community

```
lemmy_follow_community { "community": "technology@lemmy.world" }
```

First follow against a given remote instance takes 30+ seconds (WebFinger + ActivityPub inbox handshake + initial post backfill). Subsequent follows to that same instance are fast.

### Post a link

```
lemmy_post {
  "community": "technology@lemmy.world",
  "name": "New Rust release notes",
  "url": "https://blog.rust-lang.org/2026/04/10/Rust-1.99.0.html",
  "nsfw": false
}
```

Text-post variant: omit `url`, add `body` (Markdown supported).

### Comment

```
lemmy_feed { "type_": "Subscribed", "sort": "Hot", "limit": 10 }
# → find a post_id

lemmy_comment {
  "post_id": 12345,
  "content": "Interesting take — have you seen the follow-up..."
}
```

For threaded replies, pass `parent_id` as well.

### Search

```
lemmy_search { "q": "climate", "type_": "Posts" }
lemmy_search { "q": "rust", "type_": "Communities" }
```

## Moderation

Lemmy's moderation is layered: **community mods** handle their community; **instance admins** handle everything on the local server. This bundle's moderation verbs operate at the instance-admin level (assuming `LEMMY_JWT` belongs to an admin).

- **Inline (rate-limited, fires immediately):** `lemmy_block_user`, `lemmy_block_community` (user-scoped; hides content from your view).
- **Queued (operator confirms in Nest within 72h):** `lemmy_block_instance`, `lemmy_defederate` (instance-wide; admin-only).
- **Read-only:** `lemmy_review_reports` lists open post + comment reports for mods/admins.
- **Media management:** `lemmy_media_prune { "older_than_days": 7, "confirm": "yes" }` triggers pict-rs to drop remote cached images older than N days.

## Cross-app notes

- **Posting Lemmy links from other fediverse apps**: Mastodon/GoToSocial users can boost Lemmy posts by pasting the post URL — federation translates this into a share event. Lemmy's comment threads remain authoritative; boosts don't pull comments back.
- **Blog cross-posting**: a WriteFreely post can be submitted to a Lemmy community as a link post (`lemmy_post` with `url` set to the WF post URL). Full-text cross-post (text post body) lands with F.12.

## Troubleshooting

- **"Cannot reach Lemmy"** — `docker ps | grep crow-lemmy`. First-boot migrations take 60+ seconds; the healthcheck has a 60s start period.
- **Federation not working** — check `LEMMY_FEDERATION_ENABLED` is true (default). Also verify `federation.enabled` is true in `/config/config.hjson` inside the container (`docker exec crow-lemmy cat /config/config.hjson`).
- **Images not loading** — pict-rs container health check. `docker logs crow-lemmy-pictrs` and verify `LEMMY_PICTRS_API_KEY` matches between the two containers.
- **Disk filling fast** — federated community caching. Run `lemmy_media_prune` and reduce follow count on heavy communities.
- **Admin endpoints returning 404** — your `LEMMY_JWT` may belong to a regular user rather than admin. Verify in the web UI's **Admin** dropdown — if absent, log out, promote the account via DB, and re-login.
