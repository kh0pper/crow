---
title: GitHub
---

# GitHub

Connect Crow to GitHub to manage repositories, issues, pull requests, and search code directly through your AI assistant.

## What You Get

- Browse and search repositories, issues, and pull requests
- Read and create issues, comments, and pull requests
- Search code across your repositories and organizations
- View commit history and file contents

## Setup

### Step 1: Sign in to GitHub

Go to [github.com](https://github.com) and sign in to your account.

### Step 2: Create a Personal Access Token

1. Navigate to [Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta) (or use [classic tokens](https://github.com/settings/tokens))
2. Click **Generate new token**
3. Give it a descriptive name like "Crow MCP"
4. Set an expiration (90 days recommended — you can always regenerate)
5. Select the scopes listed below under **Required Permissions**
6. Click **Generate token**
7. Copy the token immediately — GitHub only shows it once

### Step 3: Add to Crow

Paste your token in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variable is `GITHUB_PERSONAL_ACCESS_TOKEN`.

## Required Permissions

For classic tokens:

| Scope | Why |
|---|---|
| `repo` | Full access to public and private repositories |
| `read:org` | Read organization membership and teams |
| `read:user` | Read user profile information |

For fine-grained tokens, grant **Read** access to the specific repositories you want Crow to access, with permissions for Contents, Issues, Pull requests, and Metadata.

## Troubleshooting

### "Bad credentials" error

Your token may have expired or been revoked. Generate a new one at [github.com/settings/tokens](https://github.com/settings/tokens) and update it in Crow's Nest Settings.

### Can't see private repositories

Make sure the `repo` scope is selected (classic tokens) or the specific repository is granted access (fine-grained tokens).

### Rate limiting (403 errors)

GitHub allows 5,000 requests per hour for authenticated users. If you hit the limit, wait for the reset window (shown in the error response) or reduce the frequency of requests.
