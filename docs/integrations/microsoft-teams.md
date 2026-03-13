---
title: Microsoft Teams
---

# Microsoft Teams

Connect Crow to Microsoft Teams to read and send messages in your Teams channels and chats through your AI assistant.

::: warning Experimental
This integration is experimental. Azure AD app registration and admin consent may be required by your organization.
:::

## What You Get

- Read messages from Teams channels and chats
- Send messages to channels
- List teams and channels
- Browse message threads

## Setup

### Step 1: Register an Azure AD application

1. Go to the [Azure Portal — App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
3. Name it (e.g., "Crow")
4. Under **Supported account types**, select **Single tenant** (your organization only)
5. Leave **Redirect URI** blank for now
6. Click **Register**
7. On the app overview page, copy the **Application (client) ID** and **Directory (tenant) ID**

### Step 2: Create a client secret

1. In your app registration, go to **Certificates & secrets**
2. Click **New client secret**
3. Add a description (e.g., "Crow MCP") and choose an expiration
4. Click **Add**
5. Copy the **Value** immediately — Azure only shows it once

### Step 3: Add API permissions

1. Go to **API permissions** in the left sidebar
2. Click **Add a permission** → **Microsoft Graph**
3. Select **Application permissions**
4. Search for and add each permission listed in **Required Permissions** below
5. Click **Grant admin consent for [your organization]** (requires admin role)

### Step 4: Add to Crow

Paste all three values in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variables are `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, and `TEAMS_TENANT_ID`.

## Required Permissions

| Permission | Type | Why |
|---|---|---|
| `Chat.Read` | Application | Read chat messages |
| `ChannelMessage.Read.All` | Application | Read messages in all channels |
| `ChannelMessage.Send` | Application | Send messages to channels |
| `Team.ReadBasic.All` | Application | List teams |
| `Channel.ReadBasic.All` | Application | List channels within teams |

## Troubleshooting

### "Insufficient privileges" error

An Azure AD admin must click **Grant admin consent** on the API permissions page. Without admin consent, the app cannot use application-level permissions.

### "AADSTS700016: Application not found"

Double-check that your `TEAMS_CLIENT_ID` and `TEAMS_TENANT_ID` are correct. The client ID is the **Application (client) ID** on the app overview page, not the Object ID.

### Client secret expired

Azure client secrets have a maximum lifetime (typically 24 months). Create a new secret in **Certificates & secrets** and update it in Crow.
