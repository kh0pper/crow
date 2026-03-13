---
title: Canvas LMS
---

# Canvas LMS

Connect Crow to Canvas LMS to access courses, assignments, grades, and submissions through your AI assistant.

## What You Get

- Browse courses and their content
- View assignments, due dates, and rubrics
- Check grades and submission status
- Access course announcements and discussions

## Setup

### Step 1: Find your Canvas instance URL

Your Canvas base URL is the domain you use to access Canvas, for example:
- `https://canvas.instructure.com`
- `https://myschool.instructure.com`
- `https://canvas.myuniversity.edu`

### Step 2: Generate an access token

1. Log in to your Canvas account
2. Click your profile picture or avatar in the left sidebar
3. Click **Settings**
4. Scroll down to **Approved Integrations**
5. Click **+ New Access Token**
6. Enter a purpose (e.g., "Crow") and optionally set an expiration date
7. Click **Generate Token**
8. Copy the token — Canvas only shows it once

### Step 3: Add to Crow

Paste your token and base URL in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variables are `CANVAS_API_TOKEN` and `CANVAS_BASE_URL`.

## Required Permissions

| Permission | Why |
|---|---|
| User-level access token | The token inherits the permissions of your Canvas account |

The token can access everything your Canvas account can access. If you're a student, it sees your courses and grades. If you're an instructor, it also sees rosters and submission details.

## Troubleshooting

### "Invalid access token" error

Tokens can be revoked by you or your institution's Canvas administrator. Generate a new one in **Settings** → **Approved Integrations**.

### "Not Found" (404) for API calls

Double-check your `CANVAS_BASE_URL`. It should be the full URL including `https://` with no trailing slash (e.g., `https://canvas.instructure.com`).

### Some courses are missing

Canvas tokens only grant access to active courses. Concluded or unpublished courses may not appear in API results depending on your institution's settings.
