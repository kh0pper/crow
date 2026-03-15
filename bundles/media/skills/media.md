---
name: media
description: News aggregation, podcasts, YouTube tracking, TTS audio, briefings, playlists, smart folders, email digests
triggers:
  - news
  - articles
  - media
  - feed
  - podcast
  - briefing
  - digest
  - youtube
  - listen
  - playlist
  - smart folder
  - RSS
tools:
  - crow-media
  - crow-storage
---

# Media Management

## When to Activate

- User wants to subscribe to news sources (RSS, Google News, YouTube)
- User asks about their news feed, articles, or reading list
- User wants to listen to an article (TTS)
- User asks for a news briefing or summary
- User wants to manage playlists or smart folders
- User asks about podcasts or audio content
- User wants to set up email digests

## Core Workflows

### Subscribe to Sources

1. **RSS feed**: `crow_media_add_source` with `url`
2. **Google News**: `crow_media_add_source` with `query` (e.g. "artificial intelligence")
3. **YouTube channel**: `crow_media_add_source` with `youtube_channel` (e.g. "@mkbhd" or channel URL)
   - YouTube is notification/tracking only — videos link to YouTube for playback
   - No audio extraction or download (ToS compliance)

### Browse & Read

1. `crow_media_feed` — chronological or personalized (`sort: "for_you"`)
2. `crow_media_search` — full-text search across all articles
3. `crow_media_get_article` — full content for a specific article
4. `crow_media_article_action` — star, save, thumbs up/down to improve recommendations

### Listen (TTS)

1. `crow_media_listen` with `article_id` — generates audio via edge-tts
   - Requires: `npm install edge-tts` (optional dependency)
   - Audio cached by content hash, auto-cleaned when over size limit
   - Rate limited: 1 concurrent, daily cap via `CROW_MEDIA_TTS_DAILY_LIMIT`

### Briefings

1. `crow_media_briefing` — AI-generated narration script from top unread articles
   - Optional: `topic` filter, `voice` for TTS audio generation
   - Stored in `media_briefings` table for replay

### Playlists

1. `crow_media_playlist` action: create/list/rename/delete
2. `crow_media_playlist_items` action: add/remove/reorder/list
   - Item types: `article`, `briefing`, `episode`
   - Daily Mix auto-generated from top scored articles

### Smart Folders

1. `crow_media_smart_folders` action: create — saves a filter preset (category, search query, unread)
2. `crow_media_smart_folders` action: view — shows articles matching the folder's filters
3. Click into folders from the Crow's Nest to see filtered feed

### Email Digests

1. `crow_media_digest_settings` — configure email, schedule (daily_morning/daily_evening/weekly), enable
2. `crow_media_digest_preview` — preview what would be sent
   - Requires: `npm install nodemailer` + SMTP config in `.env`
   - SMTP vars: `CROW_SMTP_HOST`, `CROW_SMTP_PORT`, `CROW_SMTP_USER`, `CROW_SMTP_PASS`, `CROW_SMTP_FROM`

### Podcasts

- Podcast RSS feeds are auto-detected when added via `crow_media_add_source`
- Episodes appear in the unified feed with inline audio players
- Podcasts tab in the Crow's Nest shows subscriptions and recent episodes
- Legacy `podcast_subscriptions` table data appears alongside media-sourced podcasts

### Source Management

- `crow_media_list_sources` — view all subscriptions
- `crow_media_remove_source` — unsubscribe (with confirmation)
- `crow_media_refresh` — trigger immediate fetch
- `crow_media_stats` — overview of library

## Transparency

- [crow: subscribed to RSS feed "Example" — 15 articles imported]
- [crow: generated TTS audio for article #42 — 3:15 duration]
- [crow: briefing generated — 5 articles, "Tech Briefing"]
- [crow: YouTube channel resolved — @mkbhd -> UCBcRF18a7Qf58cCRy5xuWwQ]

## Important Notes

- YouTube is tracking-only: no audio extraction, no background playback, no ToS violations
- TTS uses edge-tts (CC BY-NC-SA license) — user installs separately
- Email digests use nodemailer — user installs separately
- Both are optional dependencies with graceful fallback
