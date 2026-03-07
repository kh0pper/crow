# Security Guide

This guide is written for everyone — even if you've never used an API key before.

## What Are API Keys?

An **API key** is like a password that lets Crow talk to other services (like Gmail, GitHub, or Slack) on your behalf. Anyone who has your API key can use that service **as if they were you**.

Think of it this way: if you give someone your house key, they can walk in anytime. API keys work the same way — keep them private.

## Golden Rules

1. **Never share API keys** in screenshots, text messages, emails, or social media posts
2. **Never paste them into websites** you don't trust — only enter them in your hosting provider (Render, Railway) or your local `.env` file
3. **Never commit them to GitHub** — your `.env` file is already in `.gitignore`, but double-check before pushing code
4. **Treat them like passwords** — if you think one has been seen by someone else, revoke it immediately and create a new one
5. **Each service has its own key** — if your GitHub key leaks, your Gmail key is still safe (but revoke the leaked one right away)

## How Crow Stores Your Keys

### Desktop (local) setup

Your API keys live in a `.env` file on your own computer. They are:
- **Never uploaded** to the internet
- **Never stored** in the database
- **Never visible** in logs or error messages
- **Ignored by git** so they won't accidentally end up in your code repository

### Cloud deployment (Render, Railway, etc.)

Your API keys are stored as **environment variables** in your hosting provider's dashboard. They are:
- **Encrypted at rest** by your hosting provider
- **Never stored** in Crow's database or code
- **Never exposed** through the `/setup` status page (it shows which services are connected, but never shows the keys themselves)

## Cloud Deployment Security

If you deploy Crow to the cloud (Render, Railway, etc.):

- **Always use HTTPS** — Render and Railway provide this automatically. Never access your Crow instance over plain `http://` in production
- **Never run with `--no-auth`** on the internet — this flag disables all login requirements and is for local development only
- **OAuth 2.1** protects your MCP endpoints — only authorized AI clients can access your tools
- The **`/setup` page** is safe to visit — it shows connection status but never displays secrets

## What to Do if a Key Leaks

If you accidentally shared an API key (posted it publicly, committed it to GitHub, etc.):

1. **Don't panic** — but act quickly
2. **Go to the service** where the key was created
3. **Revoke or regenerate** the key (this instantly makes the old key stop working)
4. **Update the new key** in your `.env` file or hosting provider's environment variables
5. **Restart Crow** so it picks up the new key

### Where to revoke keys for each service

| Service | Where to revoke |
|---|---|
| Turso | [Turso Dashboard](https://turso.tech) → Database → Settings |
| GitHub | [GitHub Settings](https://github.com/settings/tokens) → Personal Access Tokens |
| Slack | [Slack API](https://api.slack.com/apps) → Your App → OAuth & Permissions |
| Google | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| Brave Search | [Brave Search API](https://brave.com/search/api/) → Dashboard |
| Notion | [Notion Integrations](https://www.notion.so/my-integrations) |
| Trello | [Trello Power-Ups](https://trello.com/power-ups/admin) |
| Discord | [Discord Developer Portal](https://discord.com/developers/applications) |

## Only Add What You Need

You don't need to set up every integration. Each API key you add is one more thing to keep safe. Start with just the services you actually use, and add more later if you need them.

## Reporting Security Issues

If you find a security vulnerability in Crow:

- **Do not** post it publicly as a GitHub issue
- Instead, use [GitHub Security Advisories](https://github.com/kh0pper/crow/security/advisories/new) to report it privately
- Include steps to reproduce the issue if possible

We take security reports seriously and will respond as quickly as we can.
