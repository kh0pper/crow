---
title: Brave Search
---

# Brave Search

Connect Crow to Brave Search for web, news, and local search capabilities through your AI assistant.

## What You Get

- Web search with summarized results
- Local business and place search
- News article search

## Setup

### Step 1: Create a Brave Search API account

Go to [brave.com/search/api](https://brave.com/search/api/) and click **Get Started**.

### Step 2: Get your API key

1. Sign in or create a Brave account
2. Subscribe to the **Free** plan (2,000 queries/month) or a paid plan
3. Go to your [API Keys dashboard](https://api.search.brave.com/app/keys)
4. Copy your API key

### Step 3: Add to Crow

Paste your key in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variable is `BRAVE_API_KEY`.

## Required Permissions

| Permission | Why |
|---|---|
| Web Search API access | Perform web, news, and local searches |

No additional scopes are needed — the API key grants access to all search endpoints included in your plan.

## Troubleshooting

### "Unauthorized" (401) error

Double-check that your API key is correctly copied with no extra spaces. Regenerate it from the [API Keys dashboard](https://api.search.brave.com/app/keys) if needed.

### Rate limit exceeded (429)

The free plan allows 1 request per second and 2,000 queries per month. Upgrade your plan at [brave.com/search/api](https://brave.com/search/api/) for higher limits.
