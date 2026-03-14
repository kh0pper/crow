---
name: podcast
description: Podcast publishing — upload audio, create episodes, iTunes-compatible RSS
triggers:
  - podcast
  - episode
  - audio content
  - record
tools:
  - crow-blog
  - crow-storage
---

# Podcast Publishing

## When to Activate

- User wants to publish a podcast episode
- User mentions podcast, episode, audio content, or recording
- User asks about podcast RSS feeds or iTunes submission
- User wants to manage their podcast series

## Concepts

Podcast episodes are blog posts with the tag `podcast` and specific metadata conventions stored in the post content's frontmatter block. No separate database tables are needed — the blog server handles everything.

### Episode Metadata Conventions

When creating a podcast episode, include a metadata block at the top of the post content (before the show notes):

```
**Audio:** <audio_url>
**Duration:** <duration>
**Episode:** <episode_number>
**Season:** <season_number>
```

- `audio_url` — URL to the audio file (uploaded via `crow_upload_file`)
- `duration` — Episode length in HH:MM:SS or MM:SS format (e.g., "45:32" or "1:02:15")
- `episode_number` — Sequential episode number (e.g., 1, 2, 3)
- `season` — Optional season number (omit the line if not using seasons)

## Workflow

### Publish a Podcast Episode

1. **Upload audio file**
   - Use `crow_upload_file` to upload the MP3/M4A file
   - Note the returned file URL — this becomes the `audio_url`

2. **Create the episode post**
   ```
   crow_create_post:
     title: "Episode 12: Interview with Jane Doe"
     content: |
       **Audio:** https://your-domain.com/files/episode-12.mp3
       **Duration:** 45:32
       **Episode:** 12
       **Season:** 2

       ## Show Notes

       In this episode, we talk with Jane Doe about...

       ### Timestamps
       - 00:00 — Introduction
       - 05:30 — Topic discussion
       - 40:00 — Wrap-up
     tags: "podcast, interviews, season-2"
     visibility: "public"
   ```

3. **Publish the episode**
   - `crow_publish_post` with the post ID
   - The episode is now live at `/blog/:slug`
   - The podcast RSS feed at `/blog/podcast.xml` updates automatically

### Manage Episodes

- `crow_list_posts` with `tag: "podcast"` — list all episodes
- `crow_edit_post` — update show notes, fix metadata
- `crow_unpublish_post` — take an episode offline
- `crow_blog_stats` — see podcast episode count in tag distribution

### Podcast Settings

Podcast-level metadata comes from blog settings:

- **Podcast title** — uses `blog_title` from `crow_blog_settings`
- **Author** — uses `blog_author`
- **Description** — uses `blog_tagline`
- **Cover art** — upload via `crow_upload_file`, then set as blog cover image

### RSS Feed

- The iTunes-compatible podcast feed is served at `/blog/podcast.xml`
- Includes iTunes namespace tags for directory submission
- Each episode's `<enclosure>` tag points to the audio file
- Submit `/blog/podcast.xml` to Apple Podcasts, Spotify, etc.

## Subscriber Workflows

### Subscribe to a Podcast

The Podcasts panel in the Crow's Nest (`/dashboard/podcast`) lets users subscribe to RSS feeds:

1. User provides an RSS feed URL
2. Crow fetches the feed, parses channel info and episodes
3. Episodes are cached in the `podcast_episodes` table
4. The panel shows an audio player for each episode

Use these AI triggers:
- "subscribe to [podcast name/URL]" → direct user to the Podcasts panel
- "what's new in my podcasts" → check for new episodes by directing to the panel
- "create a playlist" → future feature, tracked via `podcast_playlists` table

### AI Digest

Combine with the scheduling skill to create a recurring podcast digest:

> "Every Monday, check my podcast subscriptions and summarize new episodes"

This creates a scheduled task that reviews new (unlistened) episodes and presents a summary.

## Tips

- Always include the `podcast` tag — this is how published episodes are identified
- Use consistent tag naming: `podcast, topic-name, season-N`
- Audio files should be MP3 for maximum compatibility (M4A/AAC also work)
- Keep episode numbers sequential for proper feed ordering
- The duration field helps podcast apps display episode length
- Write detailed show notes with timestamps for better discoverability
- The standard blog RSS at `/blog/feed.xml` also includes podcast episodes (they are regular posts)
- For podcast-only RSS (what you submit to directories), use `/blog/podcast.xml`
