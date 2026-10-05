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

### Listen

1. `crow_media_listen` with `article_id`: the local voice reads the article aloud
   - Local voice only (a self-hosted voice profile such as Kokoro on this host or your own network). Nothing is sent to a cloud voice. With no local voice the tool says so and makes no audio.
   - One file per article, reused until the article's text changes; cleaned up when the cache is over its size limit
   - A `voice` argument is used only when the local engine lists that voice id

### Briefings

1. `crow_media_briefing`: a briefing now. A dated script ("Good morning. It's Tuesday, October 6th…") of the newest stories from the site feeds, at most two per source, each named with its source. No model writes it: every sentence comes from the feed item it names.
   - Site feeds only. Search feeds (Google News style), video channels and shows are never read into a briefing.
   - The tool answers with the script at once; the local voice finishes in the background and the audio appears on the Briefings tab
   - Optional: `topic`, `max_articles` (default 8), `audio: false` for text only
2. `crow_media_schedule_briefing`: the daily briefing
   - No arguments: report the schedule. `time: "08:00"` sets it (ready at that time; work starts 15 minutes earlier). `enabled: false` turns it off.
   - `show_source_id`: a subscribed show (a podcast source, see `crow_media_list_sources`) whose episode of the day plays after the briefing, Monday to Friday by default. If the episode is not out when the narration ends, playback stops and the Briefings tab shows it is still being checked for; a notice follows when it lands.
   - `show_title_prefix`: only an episode whose title starts with this counts (for feeds that also carry extras). Omitted, the stored one is kept; "" clears it. Without one, a feed that dates its episode titles must carry today's date in the title
   - The schedule is one row in Crow's schedules (`media:briefing`), so `crow_list_schedules` shows it

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
- Spoken audio uses the local voice profile only; there is no cloud voice in this bundle
- Email digests use nodemailer — user installs separately
- Both are optional dependencies with graceful fallback
