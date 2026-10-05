---
title: News briefing
---

# News briefing

The Media Hub extension can make a spoken news briefing every day: a short, dated script of the newest stories from your site feeds, read aloud by your **local** voice, ready at the time you set. A show you subscribe to can play right after it.

## What you need

- The **Media Hub** extension, with at least one site feed (RSS or Atom) added.
- A **local voice profile** under Settings → Text-to-Speech: a self-hosted engine (for example the Kokoro extension) on this host or on your own network. The briefing never uses a cloud voice, even when a cloud profile is your default. With no local voice the briefing is still written and you are told it is ready to read, with the reason there is no audio.

## Set it up

Open **Media → Briefings**.

- **Daily briefing**: choose the time, how many stories, and turn it on. The time is in the time zone shown beside it (your host's, by name, so it stays at the same local time when the clocks change). Work starts 15 minutes earlier so the briefing is ready on time.
- **Then play**: optionally pick one of your shows (a podcast source). On Monday to Friday its episode of the day is queued after the briefing. If the episode is not published yet when the narration ends, playback stops, the card says it is still being checked for, and you get a notice when it lands.
- **Make a briefing now**: makes one at once, optionally about a topic.

You can also ask your assistant: "schedule my news briefing for 8 AM" (`crow_media_schedule_briefing`), or "give me a news briefing" (`crow_media_briefing`).

## What is in a briefing

- Site feeds only. Search feeds (Google News style), video channels and shows are never read into a briefing.
- The newest stories since the last daily briefing, one per source first, at most two per source, the same headline only once.
- Each story names its source and uses the feed's own first sentences. No model writes or rewrites anything.
- The first sentence says the day and date.

## Listening

Press **Play** on a briefing card: the narration plays in the player bar at the bottom of every page, followed by the show when there is one. **Read** shows the script and links to the stories.

## When something is missing

| You see | It means |
|---|---|
| "Ready to read. No audio: …" | The script was made; the local voice was not available. Nothing was sent anywhere else. |
| "not published yet, checking until …" | The show's episode of the day has not appeared in its feed yet. |
| "The … briefing was skipped" | Crow was not running in the four hours after the scheduled time. |
| "The scheduler has not checked in since …" | The Media add-on's background process is not running. Restart the gateway. |

## For other parts of Crow

The newest briefing is available three ways with the same answer: the function `getLatestBriefing(db, { withAudio, maxAgeHours, kind })` in the bundle, `GET /api/media/briefings/latest` (dashboard session), and the `media_briefings` table itself, where `audio_path` is set only while a complete audio file exists under the instance's `media/audio` directory. None of this is reachable from outside your network.
