---
title: Podcast
---

# Podcast

Create and publish a podcast from your Crow instance. Episodes are managed through the Crow's Nest or by talking to your AI, and served as an iTunes-compatible RSS feed that works with Apple Podcasts, Spotify, and other directories.

## How it works

Podcast episodes are blog posts tagged with `podcast`. Each episode has audio metadata embedded in the post content, and Crow generates a standards-compliant podcast RSS feed at `/blog/podcast.xml`.

You don't need to understand any of this to use it — just ask your AI to create episodes, or use the Podcast panel in the Crow's Nest.

## Getting started

### 1. Install the podcast add-on

From the Crow's Nest, go to **Extensions** and install the **Podcast** add-on. This adds a **Podcast** panel to your sidebar.

Or ask your AI:

> "Install the podcast add-on"

### 2. Configure your podcast settings

Set your podcast's name, category, and contact info. These are required by Apple Podcasts and Spotify for directory submission.

> "Set my podcast settings: category is Technology, owner email is me@example.com"

Or use the `crow_blog_settings` tool directly:

| Setting | What it does | Example |
|---------|-------------|---------|
| `podcast_category` | iTunes category (supports subcategories with ` > `) | `Technology > Software How-To` |
| `podcast_type` | Show format | `episodic` (newest first) or `serial` (oldest first) |
| `podcast_owner_email` | Contact email (required by Apple) | `me@example.com` |
| `podcast_cover_url` | Show artwork (1400x1400 to 3000x3000, JPEG or PNG) | `https://example.com/cover.jpg` |
| `podcast_language` | Language code | `en`, `es`, `fr`, etc. |

These settings apply to the entire podcast. Per-episode settings (artwork, duration, etc.) are set when creating each episode.

### 3. Create your first episode

From the **Podcast** panel in the Crow's Nest, scroll to **New Episode** and fill in the form. Or ask your AI:

> "Create a podcast episode titled 'Welcome to My Show' with the audio at https://example.com/ep1.mp3, duration 15:30, episode 1"

## Uploading audio files

There are two ways to attach audio to an episode:

### Option A: Upload directly (recommended)

If you have [MinIO storage](/guide/storage) set up, the Podcast panel shows a **drag-and-drop upload zone** for audio files. You can:

- **Drag and drop** an audio file (MP3, M4A, OGG, or WAV) onto the upload zone
- **Click the upload zone** to open a file browser
- After uploading, you'll see the filename and size with a green checkmark

The uploaded file is stored in your MinIO storage and the URL is automatically filled in. You don't need to copy or paste anything.

::: tip
If you prefer to host audio elsewhere (e.g., on a CDN), you can still type a URL into the manual URL field below the upload zone. The manual URL overrides any uploaded file.
:::

### Option B: Enter a URL manually

If storage is not configured, the form shows a plain text field where you enter the URL to your audio file hosted elsewhere.

## Episode artwork

Each episode can have its own cover image, separate from the main podcast artwork. This is what shows up in podcast apps when someone browses your episodes.

When storage is available, the episode form shows an **Upload Image** button next to a small preview thumbnail. Click it to upload a JPEG or PNG image. The preview updates to show your artwork immediately.

The artwork URL is embedded in the episode's RSS entry as an `itunes:image` tag, so podcast apps display it alongside the episode title.

::: info
Episode artwork is optional. If you don't set one, podcast apps will fall back to your main podcast cover image (set in podcast settings).
:::

## Episode metadata

When you create an episode — whether through the panel or by talking to your AI — the following metadata is stored in the post content:

| Field | Format | Example | Required? |
|-------|--------|---------|-----------|
| **Audio** | URL to audio file | `https://example.com/ep1.mp3` | Yes |
| **Duration** | `MM:SS` or `HH:MM:SS` | `45:32` | Recommended |
| **Episode** | Episode number | `12` | Optional |
| **Season** | Season number | `2` | Optional |
| **Artwork** | URL to episode image | `https://example.com/ep1-cover.jpg` | Optional |

Everything after the metadata block becomes the **show notes**, which appear in podcast apps as the episode description.

## Publishing and managing episodes

### Publish an episode

From the Podcast panel, click **Publish** on any draft episode. Or:

> "Publish my latest podcast episode"

### Unpublish or delete

Click **Unpublish** to return an episode to draft status (it stays in the system but disappears from the feed). Click **Delete** to remove it permanently.

### Audio preview

Each episode in the list has an inline audio player so you can preview the audio directly from the Podcast panel without leaving the page.

## RSS feed

Your podcast feed is automatically generated at:

```
https://your-server/blog/podcast.xml
```

The feed URL is displayed prominently at the top of the Podcast panel with a **Copy** button for easy sharing.

### What's in the feed

The feed includes the full [iTunes podcast namespace](https://podcasters.apple.com/support/823-podcast-requirements), which means it works with:

- **Apple Podcasts** — Submit your feed URL at [podcastsconnect.apple.com](https://podcastsconnect.apple.com)
- **Spotify** — Submit at [podcasters.spotify.com](https://podcasters.spotify.com)
- **Google Podcasts**, **Pocket Casts**, **Overcast**, and any other app that accepts RSS

The feed includes:

| Tag | Source |
|-----|--------|
| `itunes:author` | Blog author setting |
| `itunes:owner` (name + email) | Podcast owner email setting |
| `itunes:category` | Podcast category setting (supports subcategories) |
| `itunes:type` | `episodic` or `serial` |
| `itunes:image` | Podcast cover URL (channel-level) and per-episode artwork |
| `itunes:duration` | Episode duration |
| `itunes:episode` / `itunes:season` | Episode and season numbers |
| `content:encoded` | Full show notes as HTML |
| `enclosure` | Audio file URL, MIME type, and file size |

### File size in enclosures

The RSS feed automatically detects the file size of each audio URL by sending a quick check to the server hosting the file. This populates the `length` attribute in the `<enclosure>` tag, which some podcast apps use to show download size. If the size can't be determined (e.g., the host doesn't report it), it defaults to 0 — this is harmless and won't prevent playback.

## Making your podcast public

Your podcast feed needs to be accessible from the public internet for directory submission. The same options that apply to [making your blog public](/guide/blog#making-your-blog-public) work for the podcast feed:

- **Tailscale Funnel** — Exposes your gateway publicly. Feed URL: `https://your-hostname.your-tailnet.ts.net/blog/podcast.xml`
- **Caddy reverse proxy** — Custom domain with auto-TLS. Make sure your Caddyfile includes `/blog*` routes.
- **Cloud deployment** — Feed is automatically public.

Set `CROW_GATEWAY_URL` in your `.env` so feed URLs point to the right place:

```bash
CROW_GATEWAY_URL=https://yourdomain.com
```

## Storage requirements

| What | Where | Notes |
|------|-------|-------|
| Episode metadata | Crow database | Negligible — text only |
| Audio files (if uploaded) | MinIO storage | Depends on episode length and format. A 60-minute MP3 at 128kbps is ~57 MB |
| Episode artwork (if uploaded) | MinIO storage | Typically 100 KB – 2 MB per image |

If you host audio externally (CDN, S3, etc.), no local storage is used for audio files.
