---
title: Blog Discovery
---

# Blog Discovery

Crow blogs can be discovered by other Crow instances through lightweight JSON endpoints. This enables a network of independent, self-hosted blogs that are findable without relying on a single platform.

## How It Works

Every Crow gateway exposes two JSON endpoints on the public blog:

| Endpoint | Gated? | Purpose |
|---|---|---|
| `/blog/discover.json` | No | Lightweight discovery for manual peer-to-peer lookup |
| `/blog/registry.json` | Yes (`blog_listed` setting) | Full metadata for future registry integration |

Both endpoints are read-only and cache responses for one hour.

### `/blog/discover.json`

Always available on any Crow gateway with the blog server running. Returns a minimal payload:

```json
{
  "crow_blog": true,
  "title": "My Blog",
  "rss_url": "https://example.com/blog/feed.xml",
  "atom_url": "https://example.com/blog/feed.atom",
  "post_count": 12
}
```

Use cases:

- A peer shares their gateway URL and you want to check if they have a blog
- Feed readers or aggregators can detect Crow blogs by checking for `crow_blog: true`
- Scripts that build a personal blogroll from a list of known Crow URLs

### `/blog/registry.json`

Only returns data if the blog owner has opted in by setting `blog_listed` to `"true"` in the Crow's Nest settings. Returns 404 otherwise.

```json
{
  "title": "My Blog",
  "tagline": "Thoughts on technology",
  "author": "Alice",
  "url": "https://example.com/blog",
  "post_count": 12,
  "last_published": "2026-03-10T14:30:00.000Z"
}
```

This endpoint is designed to be polled by a future central registry service.

## Opting Into Discovery

To make your blog's full metadata available:

1. Open the Crow's Nest and go to **Settings**
2. Set `blog_listed` to `true`
3. The `/blog/registry.json` endpoint will start returning data

Or ask your AI:

> "List my blog in the Crow Blog Registry"

The AI will set the `blog_listed` setting for you.

To opt out later, set `blog_listed` to `false` (or delete the setting). The `/blog/registry.json` endpoint will immediately return 404.

### What gets shared

When you opt in, the endpoint returns only:

- Blog title and tagline
- Author name
- Blog URL
- Post count and date of last publication

No post content, email addresses, or other private data is shared.

## Future: Central Blog Registry

::: info PLANNED
A central Crow Blog Registry is on the [roadmap](/roadmap) but has not been built yet. The discovery endpoints above are available now and work independently of any registry.
:::

The planned registry would aggregate metadata from opted-in Crow blogs into a browsable directory. It would:

1. Poll each known blog's `/blog/registry.json` endpoint periodically
2. Serve a public directory of active Crow blogs
3. Support search by title, author, or tag
4. Automatically delist blogs that return 404 for consecutive polls

## Future: Peer-to-Peer Discovery

::: info PLANNED
Hyperswarm-based blog discovery is a future enhancement and has not been implemented.
:::

A future enhancement would allow blogs to announce themselves via Hyperswarm, enabling discovery without any central server. Crow instances listening on a well-known topic would discover new blogs over the P2P network.

## Discovery Methods Summary

| Method | Status | Requires internet? | Decentralized? |
|---|---|---|---|
| Direct URL (`/blog/discover.json`) | **Available now** | Yes | Yes |
| Central registry | Planned | Yes | No |
| Hyperswarm P2P | Planned | Tailscale or LAN | Yes |

The direct URL discovery works today. A blog that opts into registry discovery in the future will also always be discoverable via its direct URL.
