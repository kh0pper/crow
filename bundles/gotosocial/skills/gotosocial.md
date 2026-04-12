---
name: gotosocial
description: GoToSocial — lightweight ActivityPub microblog. Post, follow, search, moderate across the fediverse.
triggers:
  - "gotosocial"
  - "gts"
  - "fediverse"
  - "activitypub"
  - "toot"
  - "post to mastodon"
  - "federated social"
  - "follow @"
tools:
  - gts_status
  - gts_post
  - gts_feed
  - gts_search
  - gts_follow
  - gts_unfollow
  - gts_block_user
  - gts_mute_user
  - gts_block_domain
  - gts_defederate
  - gts_review_reports
  - gts_report_remote
  - gts_import_blocklist
  - gts_media_prune
---

# GoToSocial — fediverse microblog

GoToSocial is a lightweight, Pi-friendly ActivityPub server. It speaks the
Mastodon-compatible API, so every fediverse client (Tusky, Elk, Ivory,
Mastodon web) works against it out of the box. Crow's Nest adds AI-facing
tools to post, browse, follow, and moderate.

## Prerequisites (once, before first install)

1. **Caddy must be installed** — GoToSocial declares `requires.bundles: ["caddy"]` so the dependency gate will refuse install otherwise.
2. **Subdomain with an A/AAAA record pointing at this host.** ActivityPub actors are URL-keyed; `example.com/gotosocial` does not work. Use `gts.example.com` or similar.
3. **Ports 80/443 reachable** — Caddy's ACME HTTP-01 challenge needs :80 inbound.
4. **Sufficient headroom** — the hardware gate refuses when effective RAM < 512 MB; 1 GB recommended. On a Pi set `GTS_MEDIA_RETENTION_DAYS=7`.

## After install — expose via Caddy

The bundle does not publish a host port. Caddy reaches GoToSocial over the shared `crow-federation` docker network by service name.

```
caddy_add_federation_site {
  "domain": "gts.example.com",
  "upstream": "gotosocial:8080",
  "profile": "activitypub",
  "wellknown": {
    "nodeinfo": { "href": "https://gts.example.com/nodeinfo/2.0" }
  }
}
```

Caddy validates the block via `/load` before writing the Caddyfile, then issues a real Let's Encrypt cert on first request (usually within 60 seconds). Confirm with `caddy_cert_health { "domain": "gts.example.com" }` — status should be `ok`.

If the account domain differs from the host domain (e.g. `@alice@example.com` where the server is at `gts.example.com`), also delegate WebFinger on the apex:

```
caddy_set_wellknown {
  "domain": "example.com",
  "kind": "webfinger",
  "body_json": "{\"links\":[{\"rel\":\"lrdd\",\"template\":\"https://gts.example.com/.well-known/webfinger?resource={uri}\"}]}"
}
```

## Generating an access token

The first admin user creates themselves via the web UI at `https://<GTS_HOST>/`. To generate an API token for the Crow MCP server:

```bash
docker exec crow-gotosocial ./gotosocial admin account create-token \
  --username <admin>
```

Paste the returned token into `.env` as `GTS_ACCESS_TOKEN`, then restart the MCP server.

Without a token, the Crow tools are limited to the public instance read surface (public timelines, instance info, unresolved search).

## Common workflows

### Post a status

```
gts_post { "status": "Hello from Crow!", "visibility": "public" }
```

Visibility values mirror Mastodon's: `public` (federated + public timelines), `unlisted` (federated, not on timelines), `private` (followers only), `direct` (DM-like).

Rate-limited to 10 posts per hour per conversation — the limiter is SQLite-persisted, so restarting the bundle does not reset the window.

### Follow a remote account

```
gts_follow { "handle": "@Gargron@mastodon.social" }
```

The tool resolves the handle via WebFinger, then calls the follow API. Rate-limited to 30/hour.

### Check what's new

```
gts_feed { "source": "notifications", "limit": 10 }
gts_feed { "source": "home", "limit": 20 }
```

### Inbox hygiene

```
gts_review_reports { "limit": 20 }
gts_block_user { "handle": "@spammer@badinstance.com", "confirm": "yes" }
```

`block_user` / `mute_user` fire inline (single-account scope, rate-limited). `block_domain` / `defederate` / `import_blocklist` do NOT — they queue a pending action and raise a Crow notification. The operator confirms from the Nest panel before the action actually runs. The `confirm: "yes"` arg is advisory for the AI only; the authorization is the operator's click.

### Media cache management

Remote media caches grow substantially under active federation. Automatic pruning runs daily via `scripts/media-prune.sh`; the retention window (days) comes from `GTS_MEDIA_RETENTION_DAYS` (default 14, or 7 on Pi).

Force a prune:

```
gts_media_prune { "older_than_days": 7 }
```

## Federation etiquette — not optional

- Never spam public timelines. The rate limiter is a floor, not a license.
- Moderation is your problem. A hosted instance that doesn't moderate gets defederated by major hubs within days; rehab is not easy.
- Consider importing a starter blocklist at install (IFTAS or The Bad Space). This is opt-in via the install consent modal.
- Published content is effectively permanent — delete activities propagate asynchronously and inconsistently. Treat every post as public archive material.

## Troubleshooting

- **"Cannot reach GoToSocial at http://gotosocial:8080"** — the MCP server runs on the host but the container is named on the `crow-federation` docker network. Fix: either run the MCP server inside that network, or set `GTS_URL=http://127.0.0.1:<published-port>` and add a `profiles: ["debug"]` host-port publish to the compose (then `docker compose --profile debug up -d`).
- **"401 — auth failed"** — `GTS_ACCESS_TOKEN` is unset or revoked. Regenerate via the admin CLI command above.
- **"Let's Encrypt rate-limited"** — hitting LE's 5-duplicate-certs-per-week limit. Wait for the reset or use a different domain.
- **Federation not working (local posts fine, remotes don't see them)** — check `caddy_cert_health`; if staging cert or expiry problems, remote servers reject TLS.
