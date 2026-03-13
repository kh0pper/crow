---
title: Trello
---

# Trello

Connect Crow to Trello to manage boards, lists, and cards through your AI assistant.

## What You Get

- View and manage boards, lists, and cards
- Create, move, and archive cards
- Manage labels and checklists
- Assign members to cards

## Setup

### Step 1: Get your API key

1. Go to [trello.com/power-ups/admin](https://trello.com/power-ups/admin)
2. Click **New** to create a new Power-Up (or use an existing one)
3. Fill in the required fields (name, workspace, iframe connector URL can be any URL)
4. After creating, click on your Power-Up and go to the **API Key** tab
5. Click **Generate a new API Key**
6. Copy the **API Key**

### Step 2: Generate a token

1. On the same API Key page, click the **Token** link next to your API key
2. This opens an authorization page — click **Allow**
3. Copy the token displayed on the next page

### Step 3: Add to Crow

Paste both values in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variables are `TRELLO_API_KEY` and `TRELLO_TOKEN`.

## Required Permissions

| Permission | Why |
|---|---|
| Read access | View boards, lists, cards, and members |
| Write access | Create, update, move, and archive cards |
| Account access | Read your account information and board membership |

The token authorization page requests these permissions during the "Allow" step.

## Troubleshooting

### "invalid key" error

Make sure you're using the API Key (not the secret) from the Power-Up admin page. The key is a 32-character hexadecimal string.

### "invalid token" error

Tokens can expire or be revoked. Generate a new one by clicking the **Token** link on your Power-Up's API Key page.

### Can't see a specific board

The token grants access to all boards visible to your Trello account. If a board is missing, check that you're a member of that board in Trello.
