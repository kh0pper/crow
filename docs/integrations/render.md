---
title: Render
---

# Render

Connect Crow to Render to manage deployments and monitor service status through your AI assistant.

## What You Get

- View and manage web services, static sites, and databases
- Trigger manual deploys
- Monitor service status and recent deploy history
- View environment variables and service configuration

## Setup

### Step 1: Sign in to Render

Go to [dashboard.render.com](https://dashboard.render.com) and sign in to your account.

### Step 2: Create an API key

1. Click your profile avatar in the top-right corner
2. Select **Account Settings**
3. Go to the [API Keys](https://dashboard.render.com/account/api-keys) section
4. Click **Create API Key**
5. Name it (e.g., "Crow")
6. Copy the API key

### Step 3: Add to Crow

Paste your key in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variable is `RENDER_API_KEY`.

## Required Permissions

| Permission | Why |
|---|---|
| API key access | Full access to your Render account's services, deploys, and configuration |

Render API keys grant full account access. There are no granular scopes — the key can do anything your account can do.

## Troubleshooting

### "401 Unauthorized" error

Your API key may have been revoked or deleted. Create a new one at [dashboard.render.com/account/api-keys](https://dashboard.render.com/account/api-keys).

### Can't see a service

API keys have access to all services in your Render account. If a service is missing, check that it exists in your Render dashboard.

### Deploy stuck in "In Progress"

This is a Render platform issue, not a Crow issue. Check the deploy logs in the Render dashboard for the specific service.
