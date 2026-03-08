# Self-Hosted Bundles

Bundles are pre-configured Docker Compose setups that package Crow with a curated set of integrations for a specific use case.

## What is a Bundle?

A bundle is a `docker-compose.yml` file plus configuration that makes it easy to deploy Crow with specific integrations enabled. Instead of configuring each service individually, users deploy a bundle and get a working setup immediately.

## Example Use Cases

- **Academic Bundle** — Crow + arXiv + Zotero + Google Workspace + Canvas LMS
- **Business Bundle** — Crow + Gmail + Calendar + Slack + Trello + Notion
- **Creative Bundle** — Crow + Notion + filesystem + GitHub
- **Minimal Bundle** — Crow core only (memory + research + sharing)

## Creating a Bundle

### 1. Define the Integration Set

Choose which integrations to include. Each integration needs its environment variables documented.

### 2. Create docker-compose.yml

Start from the existing `docker-compose.yml` in the Crow repo and customize:

```yaml
services:
  crow-gateway:
    build: .
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - TURSO_DATABASE_URL=${TURSO_DATABASE_URL}
      - TURSO_AUTH_TOKEN=${TURSO_AUTH_TOKEN}
      # Bundle-specific integrations
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - TRELLO_API_KEY=${TRELLO_API_KEY}
      - TRELLO_TOKEN=${TRELLO_TOKEN}
```

### 3. Create a .env.example

List all required environment variables with comments:

```env
# Required — Database
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

# Google Workspace
GOOGLE_CLIENT_ID=         # From https://console.cloud.google.com
GOOGLE_CLIENT_SECRET=

# Trello
TRELLO_API_KEY=           # From https://trello.com/power-ups/admin
TRELLO_TOKEN=
```

### 4. Write a README

Include:
- What the bundle is for
- Prerequisites (Docker, API keys)
- Step-by-step setup instructions
- Which integrations are included and what they enable

### 5. Structure

```
bundles/your-bundle/
├── docker-compose.yml
├── .env.example
└── README.md
```

## Publishing

1. Create a `bundles/your-bundle/` directory in your fork
2. Submit a PR with the bundle
3. Once merged, it will appear in the [Community Directory](./directory)

Users can then deploy with:

```bash
cd bundles/your-bundle
cp .env.example .env
# Edit .env with API keys
docker compose up -d
```

## Submit

Fork the repo, create your bundle, and submit a PR.
