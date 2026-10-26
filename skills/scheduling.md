# Scheduling Skill

Manage the user's reminders and recurring schedules.

## Trigger Phrases

- "Schedule...", "remind me to...", "every day at...", "set up a recurring..."
- "What's scheduled?", "show my schedules", "cancel the...", "pause the...", "run it now"
- "Run this every hour/day/week"

## Types

Every schedule has a type, which comes from what it does:

| Type | What it does | Made with |
|---|---|---|
| **Reminder** | Sends a notification (and speaks it on paired devices) at its time | `crow_create_schedule` |
| **Bot routine** | Starts a bot job on a schedule | Bot Builder (or `crow_schedule_bot`) |
| **Briefing** | The daily news briefing | the News app (`crow_media_schedule_briefing`) |

## Workflow

### Creating a reminder

1. Clarify what the user wants and when.
2. For a **one-time** reminder, pass `at` (an ISO date-time with the user's offset, e.g. `2026-11-03T10:00:00-06:00`).
   For a **repeating** one, pass `cron_expression`:
   - "every morning" → `0 8 * * *`
   - "every hour" → `0 * * * *`
   - "weekdays at 9" → `0 9 * * 1-5`
   - "Mondays at 9" → `0 9 * * 1`
3. Pass `tz` only when the user names a zone other than this Crow's own; otherwise leave it out and the schedule follows the instance's time zone.
4. Call `crow_create_schedule`, then confirm in plain words ("Every weekday at 9:00 AM").

Reminders repeat at most once an hour. The daily news briefing is set in the News app, not here.

### Checking, pausing, running, deleting

- `crow_list_schedules` shows each schedule's type, zone, next run, last run status and any missed runs (filter with `type`).
- Pause/resume: `crow_update_schedule { id, enabled }`. A one-time reminder whose time has passed cannot be resumed; create a new one.
- Run a reminder now: `crow_update_schedule { id, run_now: true }` (Crow runs it within a minute; its next time is unchanged).
- Delete: `crow_update_schedule { id, delete: true }` (its run history goes too). Confirm with the user first.

### Missed runs

When Crow was not running at a schedule's time:
- a **repeating** schedule is not made up later: the miss is recorded and the user gets one notice;
- a **one-time** reminder still arrives when Crow is back, marked "(late)".

## Cron Expression Reference

| Expression | Meaning |
|---|---|
| `0 * * * *` | Every hour |
| `0 8 * * *` | Daily at 8am |
| `0 8 * * 1-5` | Weekdays at 8am |
| `0 9 * * 1` | Mondays at 9am |
| `0 3 * * 0` | Sundays at 3am |
| `0 9 1 * *` | The 1st of every month at 9am |

## Notes

- Schedules run on a self-hosted Crow with its gateway running.
- Always confirm with the user before creating a schedule that would trigger automated actions.
