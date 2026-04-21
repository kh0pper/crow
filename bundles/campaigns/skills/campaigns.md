---
name: campaigns
description: Social media campaign management — create campaigns, draft posts, schedule, publish to Reddit
triggers:
  - campaign
  - reddit post
  - social media
  - schedule post
  - publish to reddit
  - subreddit
tools:
  - crow-campaigns
---

# Campaign Management

## When to Activate

- User wants to create or manage a social media campaign
- User wants to draft, schedule, or publish Reddit posts
- User asks about subreddit rules, flairs, or posting strategy
- User wants to generate AI-tailored posts for multiple subreddits
- User asks about Reddit credentials or campaign setup

## Workflow

### First-Time Setup

1. Register a Reddit "script" app at reddit.com/prefs/apps (or apply via the developer support form)
2. `crow_campaign_set_credentials` — store Reddit username, client ID, client secret, and password (validated and encrypted)
3. Credentials can also be added via the Campaigns dashboard Setup tab

### Create a Campaign

1. `crow_campaign_create` — name, brief (for AI drafting), credential_id (optional for drafts), require_approval
2. `crow_campaign_update` — adjust settings, change status (draft, active, paused, completed, archived)
3. A campaign must be set to "active" for scheduled posts to publish automatically

### Add Posts

**Manual drafting:**
- `crow_campaign_draft_post` — create a post for a specific subreddit with title, body, type, flair

**AI-powered drafting:**
1. First, crawl target subreddits: `crow_campaign_crawl_subreddit` — fetches rules, flairs, metadata
2. `crow_campaign_generate_posts` — given a campaign ID and list of subreddits, generates tailored drafts using the campaign brief + subreddit rules + writing rules
3. Review generated drafts and edit with `crow_campaign_update_post`

### Schedule and Publish

**Immediate publishing:**
- `crow_campaign_publish_post` — publish a single post now (requires confirmation)

**Scheduled publishing:**
1. `crow_campaign_schedule_post` — set a publish time. Status moves to "pending_approval" (if approval required) or "approved"
2. `crow_campaign_approve_posts` — batch approve pending posts
3. The scheduler automatically publishes approved posts at their scheduled time

**Rate limiting:** 10-minute cooldown per subreddit (enforced automatically)

### Monitor and Manage

- `crow_campaign_list` — view all campaigns with post counts by status
- `crow_campaign_get_subreddit` — retrieve cached subreddit intelligence
- Dashboard at /dashboard/campaigns shows campaigns, posts, pending approvals, and setup

### Retry Failed Posts

- Failed posts can be retried by setting status back to "approved" via `crow_campaign_update_post` or the dashboard Retry button
- Check the error field for what went wrong

## Safety

- All credentials are encrypted at rest (AES-256-GCM)
- Publishing requires explicit confirmation
- Approval gate (configurable per campaign) prevents auto-publish without review
- Campaign must be "active" for scheduled posts to publish
- 10-minute per-subreddit rate limit prevents Reddit API throttling

## Status Flow

```
draft -> scheduled -> pending_approval -> approved -> publishing -> published
                                                                 -> failed (retryable)
```

Posts can also go directly from draft to approved (if approval not required) or be published immediately via `crow_campaign_publish_post`.
