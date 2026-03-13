---
title: Scheduling
---

# Scheduling & Recurring Tasks

Crow can track scheduled and recurring tasks. Ask your AI to schedule reminders, recurring processes, or any time-based activity.

## How it works

Crow stores schedules in the database with [cron expressions](https://crontab.guru/) for timing. Schedules are accessible across all platforms — create a schedule on Claude Desktop, and it shows up when you connect from ChatGPT or Gemini.

**For self-hosted users (Crow OS):** The gateway can execute scheduled tasks automatically via system cron. The installer sets this up during installation.

**For cloud/web users:** Schedules are stored and tracked, but execution depends on the AI session. At the start of each session, the AI checks for due or overdue schedules and reminds you.

## Creating a schedule

Just ask naturally:

> "Remind me to back up my data every Sunday at 3am"

> "Schedule a weekly project review for Friday afternoons"

> "Set up a daily check-in at 9am"

Crow creates a schedule with the appropriate cron expression. You don't need to know cron syntax — the AI handles the translation.

## Managing schedules

### List schedules

> "Show me my scheduled tasks"

> "What recurring tasks do I have set up?"

### Pause or resume

> "Disable the daily backup schedule"

> "Re-enable schedule #3"

### Update timing

> "Change the project review to Mondays instead of Fridays"

### Remove

> "Delete the daily check-in schedule"

## Cron expression reference

For advanced users who want to specify exact timing:

| Expression | Meaning |
|---|---|
| `0 9 * * *` | Daily at 9:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 3 * * 0` | Every Sunday at 3:00 AM |
| `0 9 1 * *` | First of every month at 9:00 AM |
| `*/30 * * * *` | Every 30 minutes |

## Tools reference

The scheduling feature uses three MCP tools:

| Tool | Purpose |
|---|---|
| `crow_create_schedule` | Create a new schedule (task, cron expression, description) |
| `crow_list_schedules` | List all schedules, optionally filtering to enabled only |
| `crow_update_schedule` | Update or delete a schedule by ID |
