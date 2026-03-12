---
title: Blog Discovery
---

# Blog Discovery

Crow blogs can be discovered by other Crow instances and by a central registry. This enables a network of independent, self-hosted blogs that are findable without relying on a single platform.

## How It Works

Every Crow gateway exposes two JSON endpoints on the public blog:

| Endpoint | Gated? | Purpose |
|---|---|---|
| `/blog/discover.json` | No | Lightweight discovery for manual peer-to-peer lookup |
| `/blog/registry.json` | Yes (`blog_listed` setting) | Full metadata for the central Crow Blog Registry |

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

Only returns data if the blog owner has opted in by setting `blog_listed` to `"true"` in dashboard settings. Returns 404 otherwise.

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

This is the endpoint that the central Crow Blog Registry polls.

## Opting Into the Crow Blog Registry

To list your blog in the central registry:

1. Open the dashboard (Crow's Nest) and go to **Settings**
2. Set `blog_listed` to `true`
3. That's it -- the registry will pick up your blog on its next poll cycle

Or ask your AI:

> "List my blog in the Crow Blog Registry"

The AI will set the `blog_listed` dashboard setting for you.

To opt out later, set `blog_listed` to `false` (or delete the setting). The `/blog/registry.json` endpoint will immediately return 404, and the registry will remove your blog on its next poll.

### What gets shared

When you opt in, the registry stores only what `/blog/registry.json` returns:

- Blog title and tagline
- Author name
- Blog URL
- Post count and date of last publication

No post content, email addresses, or other private data is shared with the registry.

## The Crow Blog Registry

The central registry at `registry.crow.maestro.press` aggregates metadata from opted-in Crow blogs. It works as follows:

1. **Blog owners opt in** by setting `blog_listed` to `true`
2. **The registry polls** each known blog's `/blog/registry.json` endpoint periodically
3. **New blogs register** by submitting their gateway URL to the registry API
4. **The registry serves** a public directory of active Crow blogs with title, author, URL, and last-published date

### Registry API (planned)

| Endpoint | Method | Description |
|---|---|---|
| `/api/blogs` | GET | List all registered blogs (paginated) |
| `/api/blogs` | POST | Submit a new blog URL for inclusion |
| `/api/blogs/search` | GET | Search blogs by title, author, or tag |
| `/api/blogs/:url/refresh` | POST | Request an immediate re-poll of a blog |

The registry is a lightweight service -- it stores only the metadata returned by `/blog/registry.json` and re-polls blogs to keep the directory current. Blogs that return 404 for three consecutive polls are delisted automatically.

### Self-registration

When a blog owner opts in, their Crow instance can automatically submit their gateway URL to the registry:

```
POST https://registry.crow.maestro.press/api/blogs
Content-Type: application/json

{ "url": "https://example.com" }
```

The registry then polls `/blog/registry.json` at that URL to verify the blog exists and is opted in before adding it to the directory.

## Peer-to-Peer Discovery (Future)

Beyond the central registry, Crow blogs can be discovered through the existing P2P infrastructure:

### Hyperswarm announcements

Crow's sharing server already uses Hyperswarm for peer discovery. A future enhancement would allow blogs to announce themselves on a well-known topic hash derived from a Crow Blog discovery key. Other Crow instances listening on that topic would discover new blogs without any central server.

### How it would work

1. When `blog_listed` is enabled and the sharing server is running, Crow joins a Hyperswarm topic for blog discovery
2. Connected peers exchange `/blog/discover.json` payloads over the Hyperswarm connection
3. Each instance maintains a local directory of discovered blogs
4. The directory is available through MCP tools and the dashboard

This complements the central registry -- users who prefer fully decentralized discovery can use Hyperswarm alone, while the central registry provides a curated directory for broader visibility.

## Combining Discovery Methods

The discovery system is designed to be layered:

| Method | Requires internet? | Requires registry? | Decentralized? |
|---|---|---|---|
| Direct URL (`/blog/discover.json`) | Yes | No | Yes |
| Central registry (`registry.crow.maestro.press`) | Yes | Yes | No |
| Hyperswarm P2P (future) | Tailscale or LAN | No | Yes |

Users can participate in any combination. A blog that opts into the registry is also always discoverable via its direct URL and (in the future) via Hyperswarm.
