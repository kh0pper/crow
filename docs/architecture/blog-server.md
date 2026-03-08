---
title: Blog Server
---

# Blog Server

The blog server (`servers/blog/`) provides a publishing platform through MCP tools and public HTTP routes. Posts are written in Markdown, rendered to HTML, and served with RSS/Atom feeds.

## Architecture

```
┌──────────────────────────────────────┐
│           MCP Tools Layer            │
│  crow_create_post   crow_list_posts  │
│  crow_edit_post     crow_get_post    │
│  crow_publish_post  crow_unpublish   │
│  crow_delete_post   crow_share_post  │
│  crow_export_blog   crow_blog_stats  │
│  crow_blog_settings                  │
│  crow_blog_customize_theme           │
├──────────────────────────────────────┤
│         Public HTTP Routes           │
│  GET /blog              (post list)  │
│  GET /blog/:slug        (single)     │
│  GET /blog/feed.xml     (RSS 2.0)    │
│  GET /blog/feed.atom    (Atom)       │
├──────────────────────────────────────┤
│  renderer.js         │  rss.js       │
│  Markdown → HTML     │  Feed gen     │
├──────────────────────────────────────┤
│         SQLite (blog_posts)          │
│    FTS5 index (blog_posts_fts)       │
└──────────────────────────────────────┘
```

## Factory Pattern

```js
// servers/blog/server.js
export function createBlogServer(dbPath) {
  const server = new McpServer({ name: "crow-blog", version: "1.0.0" });
  // ... tool registrations
  return server;
}
```

- `server.js` — Factory function and tool definitions
- `index.js` — Stdio transport binding
- `renderer.js` — Markdown rendering and HTML sanitization
- `rss.js` — RSS 2.0 and Atom feed generation

## renderer.js

Converts Markdown post content to safe HTML:

```js
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

export function renderPost(markdown) {
  const rawHtml = marked.parse(markdown);
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt'] }
  });
}
```

The sanitizer strips scripts, iframes, and event handlers while preserving standard formatting, images, and code blocks.

## rss.js

Generates RSS 2.0 and Atom feeds from published posts:

```js
export function generateRssFeed(posts, blogConfig) { }
export function generateAtomFeed(posts, blogConfig) { }
```

Feeds include the 20 most recent published posts with full rendered HTML content. Blog metadata (title, description, author) comes from environment variables.

## Database

### blog_posts table

```sql
CREATE TABLE blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,            -- Raw Markdown
  excerpt TEXT,                     -- Short excerpt (auto-generated or manual)
  author TEXT,                      -- Author name
  status TEXT DEFAULT 'draft',      -- 'draft', 'published', or 'archived'
  visibility TEXT DEFAULT 'private', -- 'private', 'public', or 'peers'
  cover_image_key TEXT,             -- S3 key for cover image
  tags TEXT,                        -- Comma-separated tags
  nostr_event_id TEXT,              -- For P2P sharing
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### FTS5 index

```sql
CREATE VIRTUAL TABLE blog_posts_fts USING fts5(
  title, content, excerpt, tags,
  content=blog_posts,
  content_rowid=id
);
```

Triggers keep the FTS index in sync on insert, update, and delete — the same pattern used by the memory and research servers.

## Slug Generation

Slugs are generated from titles:

1. Convert to lowercase
2. Replace spaces and special characters with hyphens
3. Remove consecutive hyphens
4. Trim to 80 characters
5. If a slug already exists, append a numeric suffix (`-2`, `-3`, etc.)

## Public Routes

These routes are served by the gateway without authentication:

### GET /blog

Renders an HTML page listing all published posts, newest first. Uses the Dark Editorial theme template.

### GET /blog/:slug

Renders a single post as a full HTML page with:

- Post title and publication date
- Rendered Markdown content
- Open Graph meta tags for social sharing
- Structured data (JSON-LD) for search engines
- Navigation links to previous/next posts

### GET /blog/tag/:tag

Posts filtered by a specific tag.

### GET /blog/feed.xml

RSS 2.0 feed of published public posts.

### GET /blog/feed.atom

Atom feed of published public posts.

## Dark Editorial Theme

The blog's visual design uses server-side HTML templates (no client-side JavaScript framework). Key characteristics:

- Serif typography for body text, sans-serif for headings
- Generous whitespace and readable line lengths
- Dark mode by default, light mode via CSS `prefers-color-scheme`
- Syntax highlighting for code blocks
- Responsive layout for mobile and desktop

Templates are embedded in the server code — no external template files or build step.

## Open Graph Meta

Every published post includes Open Graph tags:

```html
<meta property="og:title" content="Post Title" />
<meta property="og:description" content="First 200 characters..." />
<meta property="og:type" content="article" />
<meta property="og:url" content="https://your-server/blog/post-slug" />
```

This ensures proper previews when posts are shared on social media or messaging apps.

## Export

The export tool generates Markdown files with platform-specific frontmatter:

**Hugo format:**
```yaml
---
title: "Post Title"
date: 2026-03-01T12:00:00Z
tags: ["tag1", "tag2"]
draft: false
---
```

**Jekyll format:**
```yaml
---
layout: post
title: "Post Title"
date: 2026-03-01
categories: [tag1, tag2]
---
```
