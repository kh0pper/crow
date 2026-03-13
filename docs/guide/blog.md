---
title: Blog
---

# Blog

Publish a personal blog managed entirely by your AI assistant. Write in Markdown, customize themes, and share posts with peers — all from a conversation.

## What is this?

Crow includes a built-in blogging platform. You write posts by talking to your AI, and Crow handles rendering, publishing, RSS feeds, and theming. Posts are served as public HTML pages from your gateway.

## Why would I want this?

- **Write by talking** — Describe what you want to write, and Crow drafts and publishes it
- **Own your content** — Posts live on your own server, not a third-party platform
- **Built-in RSS** — Readers can subscribe via RSS or Atom feeds without any extra setup
- **Share with peers** — Send posts directly to connected Crow users through P2P sharing
- **Export anytime** — Move your content to Hugo, Jekyll, or any static site generator

## Setup & Public Access

### Starting the blog server

Blog tools are available through two transport options:

- **Stdio (MCP)** — Run `npm run blog-server` to start the blog MCP server directly. This is what `.mcp.json` uses when Claude Code or another MCP client connects.
- **Gateway (HTTP)** — Run `npm run gateway` to start the HTTP gateway, which hosts all MCP servers including the blog. The gateway also serves the public blog pages.

The blog MCP tools (create, edit, publish, etc.) work in both modes. Public web access to your blog requires the gateway.

### Public blog routes

When the gateway is running, the blog is served at these public routes:

| Route | Description |
|---|---|
| `/blog` | Blog homepage listing all published public posts |
| `/blog/:slug` | Individual post page (e.g., `/blog/notes-on-local-first-software`) |
| `/blog/tag/:tag` | Posts filtered by tag |
| `/blog/feed.xml` | RSS 2.0 feed |
| `/blog/feed.atom` | Atom 1.0 feed |
| `/blog/sitemap.xml` | XML sitemap for search engine indexing |

RSS autodiscovery `<link>` headers are included automatically on all blog pages, so feed readers can find your feeds from any blog URL.

### Gateway configuration

Set `CROW_GATEWAY_URL` in your `.env` file to your public-facing URL:

```bash
CROW_GATEWAY_URL=https://blog.example.com
```

This controls how URLs are generated in RSS/Atom feeds, Open Graph meta tags, and the sitemap. Without it, all URLs default to `http://localhost:3001`, which will not work for external visitors or social media previews.

### Making it publicly accessible

The gateway listens on `localhost:3001` by default. To make your blog reachable from the internet:

- **Tailscale Funnel** — Easiest option for Tailscale users. No port forwarding or domain registration needed. See [details below](#tailscale-funnel-recommended-for-self-hosted).
- **Caddy or nginx reverse proxy** — Use a reverse proxy with automatic Let's Encrypt certificates for a custom domain. See [Caddy example below](#custom-domain-with-caddy).
- **Direct port forwarding** — Forward port 3001 on your router. Not recommended: exposes the full gateway (Crow's Nest, MCP endpoints) without TLS.

For a full deployment comparison, see the [Making Your Blog Public](#making-your-blog-public) section further down.

## Writing a Post

Ask Crow to create a post:

> "Write a blog post about my garden project this weekend"

> "Create a draft post titled 'Notes on Local-First Software'"

Crow creates the post in Markdown, generates a URL-friendly slug, and saves it as a draft.

### Post Fields

Each post has:

- **Title** — Displayed as the page heading and in feeds
- **Slug** — The URL path (e.g., `/blog/notes-on-local-first-software`)
- **Content** — Markdown body, rendered to HTML on publish
- **Tags** — Optional categories for organization
- **Status** — `draft` or `published`
- **Visibility** — Controls who can see the post:
  - `private` — Only you (default)
  - `public` — Anyone with the URL
  - `peers` — Only connected Crow peers

## Publishing

When you're happy with a draft:

> "Publish my post about local-first software"

The post becomes publicly accessible at `http://your-server:3001/blog/notes-on-local-first-software`.

To unpublish:

> "Unpublish the garden project post"

## Editing Posts

> "Update my garden post — add a section about the raised beds"

> "Change the title of my latest post to 'Weekend Garden Notes'"

Crow modifies the post in place. Published posts update immediately.

## Listing and Searching

> "Show me all my blog posts"

> "Find posts tagged 'research'"

> "Search my blog for 'neural networks'"

Blog posts are indexed with FTS5 full-text search, so keyword searches are fast even with hundreds of posts.

## Themes

The blog uses the **Dark Editorial** theme by default — a clean, reading-focused design with dark and light mode support.

The theme controls:

- Typography and layout
- Code block syntax highlighting
- Header and footer styling
- Open Graph meta tags for social sharing previews

## RSS and Atom Feeds

Feeds are generated automatically:

- **RSS 2.0**: `http://your-server:3001/blog/feed.xml`
- **Atom**: `http://your-server:3001/blog/feed.atom`

Feeds include the 20 most recent published posts with full content.

## Exporting

Move your content to a static site generator:

> "Export my blog posts for Hugo"

> "Export all posts as Jekyll-compatible Markdown"

Crow generates Markdown files with the appropriate frontmatter format for your target platform.

## Sharing Posts with Peers

If you have connected peers (see the [Sharing guide](/guide/sharing)), you can send posts directly:

> "Share my latest blog post with Alice"

The recipient gets the full post content in their Crow inbox.

## Blog Configuration

Set blog metadata in your `.env`:

```bash
CROW_BLOG_TITLE=My Blog
CROW_BLOG_DESCRIPTION=Thoughts on technology and gardening
CROW_BLOG_AUTHOR=Your Name
```

These values appear in the RSS feed and page headers.

## Making Your Blog Public

Your blog has no web presence without the gateway running. How your blog becomes accessible depends on your deployment:

| Deployment | Blog accessible? | How |
|---|---|---|
| **Desktop (stdio)** | No | Gateway not running — no web blog |
| **Self-hosted (Pi/server)** | LAN only by default | Available at `http://<server-ip>:3001/blog` on your local network |
| **Cloud (Render/Oracle)** | Yes — public internet | Blog at `https://your-service.onrender.com/blog` |
| **Managed hosting** | Yes — public internet | Blog at `username.crow.maestro.press/blog` |

For self-hosted setups, see the sections below to make your blog accessible from the internet.

### Tailscale Funnel (Recommended for Self-Hosted)

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) exposes your gateway to the public internet through Tailscale's infrastructure — no port forwarding, no dynamic DNS, no domain registration needed.

```bash
# Enable Funnel in your Tailscale admin console first:
# https://login.tailscale.com/admin/dns → Enable Funnel

# Then expose your gateway
tailscale funnel --bg --https=443 http://localhost:3001
```

Your blog is now publicly accessible at `https://<hostname>.your-tailnet.ts.net/blog`.

The Crow's Nest remains private — requests from public IPs get a 403 response because they don't fall within the allowed network ranges. Only the blog (and other unauthenticated routes like `/health` and `/setup`) are effectively visible to the public.

### Custom Domain with Caddy

If you want a custom domain that only serves your blog (not the full gateway), you can configure Caddy as a reverse proxy with path restrictions.

::: warning
This Caddyfile replaces the default full-gateway proxy. If you're using Caddy to serve the Crow's Nest over Tailscale, you'll need separate Caddy configurations or a combined Caddyfile.
:::

```
yourdomain.com {
    # Only proxy blog and health routes
    handle /blog* {
        reverse_proxy localhost:3001
    }
    handle /health {
        reverse_proxy localhost:3001
    }

    # Block everything else
    handle {
        respond "Not Found" 404
    }
}
```

Caddy automatically provisions Let's Encrypt certificates for your domain.

### Setting `CROW_GATEWAY_URL`

For RSS feed links, Open Graph meta tags, sitemap URLs, and social media previews to work correctly, set the public URL of your gateway:

```bash
# In your .env file
CROW_GATEWAY_URL=https://yourdomain.com
```

Without this, links in feeds and social previews will point to `http://localhost:3001`, which won't work for external visitors.
