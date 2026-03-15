---
name: podcast
description: Podcast subscriber (listen to RSS feeds) and publisher (create podcast episodes as blog posts)
triggers:
  - podcast
  - episode
  - subscribe podcast
  - listen
  - audio content
tools:
  - crow-blog
  - crow-storage
---

# Podcast Management

## When to Activate

- User wants to subscribe to or listen to podcasts
- User asks about podcast episodes or subscriptions
- User wants to create/publish podcast episodes (as blog posts)

## Subscriber Workflow

The Podcast Player panel (installed with this add-on) lets users:
1. Subscribe to podcast RSS feeds
2. Browse and play episodes with inline audio player
3. Mark episodes as listened
4. Refresh feeds for new episodes

## Publisher Workflow

The Podcast Publisher panel creates podcast episodes as blog posts with audio metadata:

1. **Create episode**: Title, audio URL, show notes, duration, episode/season numbers
2. **Publish**: Episodes become blog posts tagged "podcast" with iTunes-compatible RSS
3. **Manage**: Edit metadata, reorder, archive

### Publishing an Episode

1. Navigate to the Podcast panel in the Crow's Nest
2. Fill in: title, audio URL (upload via Storage or paste external URL), show notes
3. Set optional metadata: duration, episode number, season number, artwork
4. Click Create — this creates a draft blog post
5. Publish when ready — the episode appears in your podcast RSS feed

### Podcast RSS Feed

Published episodes are available at:
- `/blog/podcast.xml` — iTunes-compatible RSS feed
- Share this URL with podcast directories (Apple Podcasts, Spotify, etc.)

## Notes

- The subscriber and publisher are independent features
- Subscriber uses `podcast_subscriptions` / `podcast_episodes` tables
- Publisher uses `blog_posts` table (episodes are blog posts tagged "podcast")
- No cross-dependency between the two
