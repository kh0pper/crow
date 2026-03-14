---
name: blog
description: Blog management — create, edit, publish, theme, RSS, export, share
triggers:
  - blog post
  - write a post
  - publish
  - blog settings
  - blog theme
  - export blog
  - RSS feed
tools:
  - crow-blog
  - crow-storage
---

# Blog Management

## When to Activate

- User wants to create, edit, or publish a blog post
- User asks about blog settings, themes, or RSS feeds
- User wants to export their blog for Hugo/Jekyll
- User wants to share a post with a Crow peer
- User asks about customizing the blog's appearance

## Workflow

### Create and Publish a Post

1. `crow_create_post` — draft with title, markdown content, tags, visibility
   - Slug auto-generated from title (or provide custom slug)
   - Excerpt auto-generated from content (or provide custom excerpt)
   - Set visibility: `private` (default), `public`, or `peers`
2. Review with `crow_get_post` — check content renders correctly
3. `crow_publish_post` — make it live
4. If public: accessible at `/blog/:slug`

### Edit and Manage Posts

- `crow_list_posts` — filter by status, tag, or search
- `crow_edit_post` — update any field (title, content, tags, visibility, slug)
- `crow_unpublish_post` — revert to draft
- `crow_delete_post` — permanent deletion

### Theming

- `crow_blog_settings` — get/set blog title, tagline, author, theme
- Built-in themes: `dark` (default), `light`, `serif`
- `crow_blog_customize_theme` — write custom CSS overrides
  - AI can translate natural language to CSS: "make the accent color blue" → write appropriate CSS custom property overrides
  - Custom CSS is applied on top of the selected theme
  - Example: `--crow-accent: #3b82f6; --crow-accent-hover: #60a5fa;`

### RSS/Atom Feeds

- Published public posts are automatically available at:
  - `/blog/feed.xml` (RSS 2.0)
  - `/blog/feed.atom` (Atom)
- No manual action needed — feeds update automatically

### Export

- `crow_export_blog` — export published posts as Hugo or Jekyll compatible markdown
- Output includes frontmatter (title, date, tags, author) + content
- User can copy output to their static site generator

### Share with Peers

- `crow_share_post` — share a post with a Crow contact via P2P
- Works with the sharing server's delivery system

## Tips

- Use tags consistently for cross-referencing (same tags across blog and research)
- Cover images: upload with `crow_upload_file` (reference_type: `blog_post`), then set the `cover_image_key`
- The Blog panel in the Crow's Nest at `/dashboard/blog` provides a visual editor
- `crow_blog_stats` shows post counts and tag distribution
- Open Graph meta tags are automatically generated for public posts

Posts default to `private`. Nothing appears on your public blog at `/blog` until you explicitly publish a post with `public` visibility. This is by design — your blog stays empty until you're ready.

## Safety

Publishing and deleting posts require user confirmation. See `skills/safety-guardrails.md` Tier 1 for the checkpoint protocol.

## Post Visibility Guide

| Visibility | Who can see it | URL accessible? |
|-----------|----------------|-----------------|
| `private` | MCP tools + Crow's Nest only | No |
| `public` | Anyone with the URL | Yes, at `/blog/:slug` |
| `peers` | Crow contacts only | Requires auth |
