---
title: Wallabag
---

# Wallabag

Connect Crow to Wallabag, a self-hosted read-it-later service, to save articles, read offline, and organize your reading list through your AI assistant.

## What You Get

- Save any URL for later reading
- Search saved articles by text
- Browse articles with filters (archived, starred, tags)
- Read full article content
- Organize with tags
- Mark articles as read or starred

## Setup

Crow supports two modes for Wallabag: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Wallabag as a Crow bundle. This runs Wallabag in Docker alongside your Crow gateway.

> "Crow, install the Wallabag bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the database password:

```bash
# In your .env file
WALLABAG_DB_PASSWORD=your-secure-password
```

Restart the bundle for changes to take effect:

> "Crow, restart the Wallabag bundle"

Wallabag will be available at `http://your-server:8084` for initial setup. Create an account via the web UI, then create an API client from the **Developer** menu.

::: warning Port mapping
Wallabag's default port (80) is remapped to **8084** to avoid conflicts with other services.
:::

### Option B: Connect to existing Wallabag

If you already run a Wallabag instance, connect Crow to it directly. Wallabag uses OAuth2 authentication, so you need four credentials.

#### Step 1: Create an API client

1. Open your Wallabag web interface
2. Go to **Developer** > **API clients management**
3. Create a new client
4. Copy the **Client ID** and **Client Secret**

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
WALLABAG_URL=http://your-wallabag-server:8084
WALLABAG_CLIENT_ID=your-client-id
WALLABAG_CLIENT_SECRET=your-client-secret
WALLABAG_USERNAME=your-username
WALLABAG_PASSWORD=your-password
```

All five variables are required. Crow uses the Client ID and Secret together with your username and password to authenticate via OAuth2.

## AI Tools

Once connected, you can interact with Wallabag through your AI:

> "Save this article: https://example.com/great-article"

> "Show me my unread articles"

> "Star that article"

> "Search my saved articles for machine learning"

> "Archive all read articles"

## Docker Compose Reference

If you prefer manual Docker setup instead of the bundle installer:

```yaml
services:
  wallabag:
    image: wallabag/wallabag:latest
    container_name: crow-wallabag
    ports:
      - "8084:80"
    volumes:
      - wallabag-data:/var/www/wallabag/data
      - wallabag-images:/var/www/wallabag/web/assets/images
    environment:
      SYMFONY__ENV__DATABASE_DRIVER: pdo_mysql
      SYMFONY__ENV__DATABASE_HOST: wallabag-db
      SYMFONY__ENV__DATABASE_PORT: 3306
      SYMFONY__ENV__DATABASE_NAME: wallabag
      SYMFONY__ENV__DATABASE_USER: wallabag
      SYMFONY__ENV__DATABASE_PASSWORD: ${WALLABAG_DB_PASSWORD}
    depends_on:
      - wallabag-db
      - wallabag-redis
    restart: unless-stopped

  wallabag-db:
    image: mariadb:11
    container_name: crow-wallabag-db
    volumes:
      - wallabag-dbdata:/var/lib/mysql
    environment:
      MYSQL_ROOT_PASSWORD: ${WALLABAG_DB_PASSWORD}
      MYSQL_DATABASE: wallabag
      MYSQL_USER: wallabag
      MYSQL_PASSWORD: ${WALLABAG_DB_PASSWORD}
    restart: unless-stopped

  wallabag-redis:
    image: redis:7-alpine
    container_name: crow-wallabag-redis
    restart: unless-stopped

volumes:
  wallabag-data:
  wallabag-images:
  wallabag-dbdata:
```

## Troubleshooting

### OAuth2 login failed

Verify all four credentials (Client ID, Client Secret, username, password) are correct. If you changed your Wallabag password, update `WALLABAG_PASSWORD` in your `.env` file as well.

### "Connection refused" or timeout

Make sure the `WALLABAG_URL` is reachable from the machine running Crow. If Wallabag is on a different machine, use the correct IP or hostname.

### Articles not saving

Check that the target URL is accessible from the server running Wallabag. Wallabag fetches and parses the page content server-side, so it needs network access to the article URL.
