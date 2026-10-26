---
title: Scheduling
---

# Scheduling & Recurring Tasks

Crow can track scheduled and recurring tasks. Ask your AI to schedule reminders, recurring processes, or any time-based activity.

## How it works

Crow stores schedules in the database with [cron expressions](https://crontab.guru/) for timing. Schedules are accessible across all platforms — create a schedule on Claude Desktop, and it shows up when you connect from ChatGPT or Gemini.

**For self-hosted users (Crow OS):** The gateway runs schedules itself, checking every minute.

Every schedule has a **type**:

| Type | What it does |
|---|---|
| **Reminder** | Sends you a notification (and speaks it on a paired device) at its time. Repeats at most once an hour. |
| **Bot routine** | Starts a bot job on a schedule. Made in Bot Builder. |
| **Briefing** | The daily news briefing. Set in the News app, in News's own time zone. |

Times follow your Crow's time zone unless you name another one ("every day at 9 Madrid time").

### When Crow was off

- A **repeating** schedule whose time passed while Crow wasn't running is **not made up** later. The miss is recorded and you get one notice about it.
- A **one-time** reminder still arrives when Crow is back, marked "(late)".

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

### Run now

> "Run the stretch reminder now"

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
| `*/30 * * * *` | Every 30 minutes (bot routines only; reminders repeat at most hourly) |

## Tools reference

The scheduling feature uses three MCP tools:

| Tool | Purpose |
|---|---|
| `crow_create_schedule` | Create a reminder: repeating (`cron_expression`) or one-time (`at`), optional `tz`, `description` |
| `crow_list_schedules` | List schedules with type, zone, next run, last run and missed runs; filter by `enabled_only` or `type` |
| `crow_update_schedule` | Pause/resume, `run_now`, change text/timing/zone, or delete (with its run history) by ID |
