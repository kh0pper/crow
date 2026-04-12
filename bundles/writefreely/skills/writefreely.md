---
name: writefreely
description: WriteFreely — federated blogging via ActivityPub. Long-form posts with Markdown, publish-drafts workflow, fediverse reach.
triggers:
  - "writefreely"
  - "blog post"
  - "long form"
  - "publish to fediverse"
  - "federated blog"
  - "draft post"
  - "medium alternative"
tools:
  - wf_status
  - wf_list_collections
  - wf_create_post
  - wf_update_post
  - wf_publish_post
  - wf_unpublish_post
  - wf_delete_post
  - wf_list_posts
  - wf_get_post
  - wf_export_posts
---

# WriteFreely — federated blog

WriteFreely is a minimalist ActivityPub blogging platform — single-binary, single-SQLite footprint, no comment system, no likes, no analytics. Posts are Markdown. Publish to a "collection" (blog) and the post federates to any Mastodon / GoToSocial / other ActivityPub account that follows the blog's actor.

Crow's own `crow-blog` and WriteFreely overlap conceptually; the difference is federation: `crow-blog` is private-by-default (share via invite), WriteFreely is public-federated.

## Prerequisites

1. **Caddy must be installed** (declared dependency; install refused otherwise).
2. **Subdomain with A/AAAA record.** ActivityPub actors are URL-keyed; `example.com/blog` does not federate. Use `blog.example.com` or similar.
3. Ports 80/443 reachable for ACME. Hardware gate is cheap for this one — 256 MB min RAM.

## First-run setup

The container seeds a default config on first boot. To finish setup:

1. `caddy_add_federation_site { "domain": "blog.example.com", "upstream": "writefreely:8080", "profile": "activitypub" }`
2. Open `https://blog.example.com/` and create the admin account via the web UI. There is **no** CLI bootstrap — WriteFreely requires a human at the browser for initial admin creation.
3. Generate an API token:
   ```bash
   curl -X POST https://blog.example.com/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"alias":"<admin>","pass":"<password>"}'
   ```
   Paste the `access_token` into `.env` as `WF_ACCESS_TOKEN`.
4. Note the collection alias (shown in the web UI). Set `WF_COLLECTION_ALIAS` if you want a default.
5. Restart the MCP server so it picks up the token.

## Common workflows

### Draft → publish

```
wf_create_post { "title": "Hello fediverse", "body": "# Hi there\n\nFirst post." }
→ returns { id, slug, published: false }

wf_publish_post { "post_id": "<id>", "collection": "myblog" }
→ the post is now public at https://blog.example.com/myblog/<slug>
  and federates to any remote follower
```

Published posts show on the blog's collection page and in the collection's ActivityPub outbox. Unpublish (without deleting) via `wf_unpublish_post` — the post returns to drafts but is NOT federated out as a `Delete` activity (WriteFreely treats unpublish as "hide", not "retract"). To really retract, `wf_delete_post` (destructive).

### Single-user mode shortcut

If `WF_SINGLE_USER=true` and `WF_COLLECTION_ALIAS` is set, you can skip the `collection` arg on `wf_create_post` — the tool publishes straight to the default blog:

```
wf_create_post { "title": "Quick thought", "body": "..." }
→ published to WF_COLLECTION_ALIAS
```

### List + fetch

```
wf_list_posts { "collection": "myblog", "page": 1 }
wf_get_post  { "collection": "myblog", "slug": "hello-fediverse" }
```

Public collection endpoints need no auth — the AI can browse public fediverse blogs via WriteFreely's API.

### Export / backup

```
wf_export_posts { "format": "json" }
```

Dumps the authenticated user's full post set. `scripts/backup.sh` does this plus a SQLite dump.

## What WriteFreely doesn't do

- **No comments.** By design. Remote Mastodon replies appear in your mentions on the instance running WriteFreely's outbox, not on the blog page.
- **No moderation queue.** WriteFreely publishes outbound; inbound federation is limited to follow events. There are no `block_user` / `defederate` tools because there's nothing inbound to moderate at the post level. If a remote admin reports your instance, handle it at the Caddy layer (`caddy_remove_site` the whole domain in extreme cases).
- **No reblogs / favorites.** Posts federate out; reblogs of your posts on Mastodon don't flow back as engagement data.

## Troubleshooting

- **"401 auth failed"** — token expired or revoked. Re-login at `POST /api/auth/login`.
- **Publishing fails with "collection not found"** — collection alias is case-sensitive and not the human title. Get exact alias via `wf_list_collections`.
- **Post is public but doesn't appear on Mastodon** — check the blog's ActivityPub actor is reachable: `curl -H 'Accept: application/activity+json' https://blog.example.com/api/collections/<alias>` should return a JSON actor. If not, Caddy site config is wrong (missing headers). Re-run `caddy_add_federation_site` with profile activitypub.
- **Want analytics / likes / reblogs** — wrong tool. WriteFreely is a minimalist publisher. Consider GoToSocial (F.1) or Mastodon (F.7) for that behavior.
