# Scheduling Skill

Manage scheduled and recurring tasks for the user.

## Trigger Phrases

- "Schedule...", "remind me to...", "every day at...", "set up a recurring..."
- "What's scheduled?", "show my schedules", "cancel the..."
- "Run this every hour/day/week"

## Workflow

### Creating a Schedule

1. Clarify what the user wants scheduled and how often
2. Translate natural language to a cron expression:
   - "every morning" → `0 8 * * *`
   - "every hour" → `0 * * * *`
   - "weekly on Monday" → `0 9 * * 1`
   - "every day at 3am" → `0 3 * * *`
3. Store using `crow_memory` with category `goal` and include the cron expression
4. Confirm the schedule with the user, showing the human-readable interpretation

### Checking Schedules

When the user asks what's scheduled:
1. Search memories with category `goal` for scheduling-related entries
2. Present them in a clear list with next expected run time

### Session Start Reminder

At session start, check if any scheduled tasks are due:
1. Search memories for scheduling entries
2. If any tasks are overdue or due soon, mention them proactively

## Cron Expression Reference

| Expression | Meaning |
|---|---|
| `0 * * * *` | Every hour |
| `0 8 * * *` | Daily at 8am |
| `0 8 * * 1-5` | Weekdays at 8am |
| `0 9 * * 1` | Mondays at 9am |
| `0 3 * * 0` | Sundays at 3am |
| `*/15 * * * *` | Every 15 minutes |

## Notes

- For self-hosted Crow instances with the gateway running, schedules can be executed automatically
- For cloud/web users, schedules are stored as reminders — the AI checks them at session start
- Always confirm with the user before creating a schedule that would trigger automated actions
