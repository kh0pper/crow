---
title: BookStack
---

# BookStack

Connect Crow to BookStack to search, browse, create, and edit wiki pages organized in shelves, books, and chapters through your AI assistant.

## What You Get

- Full-text search across all wiki content
- Browse shelves, books, and chapters
- Read page content (HTML and Markdown)
- Create new pages in books or chapters
- Edit existing pages
- Manage wiki structure

## Setup

Crow supports two modes for BookStack: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install BookStack as a Crow bundle. This runs BookStack in Docker alongside your Crow gateway.

> "Crow, install the BookStack bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the database password:

```bash
# In your .env file
BOOKSTACK_DB_PASSWORD=your-secure-password
```

Restart the bundle for changes to take effect:

> "Crow, restart the BookStack bundle"

BookStack will be available at `http://your-server:6875` for initial setup. The default credentials are `admin@admin.com` / `password`. Change these immediately after first login.

::: warning Port mapping
BookStack's default port (80) is remapped to **6875** to avoid conflicts with other services.
:::

::: warning Default credentials
Change the default login (`admin@admin.com` / `password`) immediately after first login.
:::

### Option B: Connect to existing BookStack

If you already run a BookStack instance, connect Crow to it directly.

#### Step 1: Create an API token

1. Open your BookStack web interface
2. Go to **Settings** > **API Tokens**
3. Create a new token
4. Copy the **Token ID** and **Token Secret**

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
BOOKSTACK_URL=http://your-bookstack-server:6875
BOOKSTACK_TOKEN_ID=your-token-id
BOOKSTACK_TOKEN_SECRET=your-token-secret
```

BookStack uses a composite token format (ID:SECRET) for API authentication. Crow combines these automatically.

## AI Tools

Once connected, you can interact with BookStack through your AI:

> "Search my wiki for deployment guide"

> "Show me all books on the DevOps shelf"

> "Create a new page in the Architecture book"

> "Update the Getting Started page with this content"

> "What chapters are in that book?"

## Docker Compose Reference

If you prefer manual Docker setup instead of the bundle installer:

```yaml
services:
  bookstack:
    image: lscr.io/linuxserver/bookstack:latest
    container_name: crow-bookstack
    ports:
      - "6875:80"
    volumes:
      - bookstack-config:/config
    environment:
      DB_HOST: bookstack-db
      DB_PORT: 3306
      DB_USER: bookstack
      DB_PASS: ${BOOKSTACK_DB_PASSWORD}
      DB_DATABASE: bookstack
    depends_on:
      - bookstack-db
    restart: unless-stopped

  bookstack-db:
    image: mariadb:11
    container_name: crow-bookstack-db
    volumes:
      - bookstack-dbdata:/var/lib/mysql
    environment:
      MYSQL_ROOT_PASSWORD: ${BOOKSTACK_DB_PASSWORD}
      MYSQL_DATABASE: bookstack
      MYSQL_USER: bookstack
      MYSQL_PASSWORD: ${BOOKSTACK_DB_PASSWORD}
    restart: unless-stopped

volumes:
  bookstack-config:
  bookstack-dbdata:
```

## Troubleshooting

### "Connection refused" or timeout

Make sure the `BOOKSTACK_URL` is reachable from the machine running Crow. If BookStack is on a different machine, use the correct IP or hostname.

### "401 Unauthorized"

The API token may have been deleted or expired. Regenerate a new token from BookStack **Settings** > **API Tokens**.

### Pages not editable

Check that the API token has the correct permissions. BookStack API tokens inherit the permissions of the user who created them. Make sure that user has edit access to the books and pages you want to modify.
