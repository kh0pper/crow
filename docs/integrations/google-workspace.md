---
title: Google Workspace
---

# Google Workspace

Connect Crow to Google Workspace to access Gmail, Google Calendar, Docs, Sheets, and Slides through your AI assistant.

## What You Get

- Read and search Gmail messages
- View and create Google Calendar events
- Access Google Docs, Sheets, and Slides
- Search across your Google Drive
- Send and read Google Chat messages

## Prerequisites

This integration requires **uvx** (Python package runner). Install it with:

```bash
# macOS
brew install uv

# Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Setup

### Step 1: Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top and select **New Project**
3. Name it (e.g., "Crow") and click **Create**
4. Select your new project from the project dropdown

### Step 2: Enable APIs

1. Go to **APIs & Services** → **Library**
2. Search for and enable each API you want to use:
   - **Gmail API**
   - **Google Calendar API**
   - **Google Docs API**
   - **Google Sheets API**
   - **Google Slides API**
   - **Google Drive API**
   - **Google Chat API** (optional)

### Step 3: Create OAuth credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. If prompted, configure the **OAuth consent screen** first:
   - Choose **External** (or Internal if using Google Workspace)
   - Fill in the app name and your email
   - Add your email under **Test users**
   - Click **Save and Continue** through the remaining steps
4. Back in **Credentials**, click **Create Credentials** → **OAuth client ID**
5. Select **Desktop app** as the application type
6. Name it (e.g., "Crow Desktop")
7. Click **Create**
8. Copy the **Client ID** and **Client Secret**

### Step 4: Add to Crow

Paste both values in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variables are `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

On first use, a browser window will open to authorize the app. Sign in with your Google account and grant the requested permissions.

## Required Permissions

Scopes are requested during the OAuth authorization flow:

| Scope | Why |
|---|---|
| `gmail.readonly` | Read and search email messages |
| `calendar.events` | Read and create calendar events |
| `drive.readonly` | Search and read files in Drive |
| `documents` | Read Google Docs |
| `spreadsheets` | Read Google Sheets |
| `presentations` | Read Google Slides |

## Troubleshooting

### "Access blocked: This app's request is invalid"

Your OAuth consent screen may not have your email listed as a test user. Go to **APIs & Services** → **OAuth consent screen** → **Test users** and add your Google account email.

### "uvx: command not found"

Install uv first (see Prerequisites above), then restart your terminal.

### Authorization flow doesn't complete

Make sure you selected **Desktop app** (not Web application) as the OAuth client type. Desktop apps use a local redirect for the authorization callback.
