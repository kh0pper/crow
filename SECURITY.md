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

## What's Public by Default

Crow follows a simple principle: **your blog is the storefront, the Crow's Nest is the locked back office**. Here's what's accessible at each level:

| Component | Default Access | Why |
|---|---|---|
| Blog (`/blog/*`) | Public — anyone with the URL | Publishing is the whole point. Only posts you explicitly publish with `public` visibility appear here. |
| Crow's Nest (`/dashboard`) | Private — local network + Tailscale only | Full control over your data — messages, files, settings. |
| MCP endpoints (`/memory/mcp`, etc.) | Private — requires OAuth 2.1 | AI tool access needs authentication to prevent unauthorized use. |
| Setup page (`/setup`) | Accessible but safe | Shows which integrations are connected, never shows API keys or secrets. |
| Health check (`/health`) | Accessible | Returns server status — no sensitive data. |

Think of it like a store: customers can see the front window (blog), but only you can get into the back office (Crow's Nest). If you never publish a blog post, nothing personal is visible to the outside world.

For details on network restrictions and allowed IP ranges, see the [Crow's Nest guide](docs/guide/crows-nest.md#network-security).

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

## Managed Hosting Security

If you use [managed hosting](https://maestro.press/hosting/) ($15/mo), these additional protections apply:

- **Instance isolation** — Each customer gets a separate Docker container and separate database. Up to 5 instances per shared server, with no cross-instance access.
- **OAuth tokens hashed** — All OAuth access and refresh tokens are SHA-256 hashed before storage. If the database were compromised, tokens cannot be reused.
- **Crow's Nest passwords hashed** — Passwords are hashed with scrypt (N=16384, r=8, p=1) using a unique random salt.
- **24-hour session duration** — Crow's Nest sessions expire after 24 hours in hosted mode (vs. 7 days for self-hosted).
- **Secure cookies** — Session cookies are set with `HttpOnly`, `SameSite=Strict`, and `Secure` flags in production.
- **Audit logging** — Authentication events (login success/failure, lockout, token issuance, password changes) are logged with 90-day retention.
- **API keys as env vars only** — Your API keys are stored only as environment variables, never in the database.
- **No data access** — Maestro Press does not access customer data except for maintenance, support, or legal obligation.

## How Crow Protects Your Data

A summary of the technical measures protecting your data across all deployment modes:

| Layer | Protection |
|---|---|
| API keys | Stored as environment variables only, never in the database or logs |
| OAuth tokens | SHA-256 hashed before database storage |
| Crow's Nest password | scrypt-hashed with unique random salt |
| Session cookies | `HttpOnly`, `SameSite=Strict`, `Secure` (production) |
| Auth endpoints | Rate-limited (20 requests per 15 minutes) |
| Account lockout | 5 failed attempts triggers 15-minute lockout |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options`, HSTS |
| CORS | Restricted to configured origins only |
| Audit log | Auth events logged, 90-day retention, auto-cleaned at startup |
| P2P encryption | Ed25519 + NIP-44 encrypted messaging between peers |

## Reporting Security Issues

If you find a security vulnerability in Crow:

- **Do not** post it publicly as a GitHub issue
- Instead, use [GitHub Security Advisories](https://github.com/kh0pper/crow/security/advisories/new) to report it privately
- Include steps to reproduce the issue if possible

We take security reports seriously and will respond as quickly as we can.
