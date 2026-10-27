---
title: Schedule page
---

# The Schedule page

**Crow's Nest → Schedule** (`/dashboard/schedule`) shows everything that will happen on its own, and when, in one agenda:

- **Crow's own schedules**: reminders, bot routines and the daily briefing. You can change these here (see [Scheduling](./scheduling)).
- **Read-only sources**, when you set them up: the box's current **hold**, the **box windows** from a ledger file, and the **timers on your machines** (systemd timers and cron lines). The page only shows these. It never changes, starts or stops them.

At the top, a strip lists anything that needs a look, each item with a fix. With nothing to show it reads "Everything is on schedule". The chips **All · Crow · Box · Machines** narrow the agenda; Box and Machines appear only when that source exists. The strip always shows every problem.

Only the owner's own session sees the read-only sources: someone signed in from a paired Crow sees Crow's schedules only.

A fresh install has none of the read-only sources. Nothing about them shows until you set the variables below in the gateway's environment, for example in a systemd drop-in.

## Box hold

When a long job holds the machine (see [Box reservation](../architecture/box-reservation)), the hold shows under **Now**: who holds it, why, and until when. This needs no setup.

If the hold file can't be read, model starts are refused until it is fixed or released, and the strip says **Box hold unreadable**. Its fix copies the release command, `node scripts/ops/box-reserve.mjs release`, so you can run it yourself.

## Box ledger

Some operators keep a markdown ledger of planned windows on a shared machine. To show it, point the gateway at the file:

```bash
CROW_BOX_LEDGER_PATH=/path/to/your/ledger.md
```

- There is **no default path**. Without the variable, no ledger is read. Set it only for the instance that should show it. Another Crow instance running as the same user doesn't see the ledger unless its own environment sets the variable too.
- The path must be absolute and point at a **regular file**: symlinks, FIFOs and directories are refused. At most 1 MB and 2,000 table lines are read; a line over 4 KB is skipped, and only a cell's first 1 KB is read.
- Only the table under a heading that starts `## Reservations` is read. Its first three columns are **when**, **what** and **owner**. Other columns and other sections are ignored.

```markdown
## Reservations

| when | what | owner | notes |
|---|---|---|---|
| **2026-10-27 (Tue) 21:00 → 04:00 Wed** | **Overnight benchmark** | alex | capped unit |
| 2026-10-28 09:30 → cap 45 min | Full test suite | alex | |
| ~~2026-10-26 10:00 → 11:00~~ | ~~A finished window~~ | alex | |
```

How a row's **when** cell is read, in the instance's time zone (the first rule that matches wins):

| The cell says | Read as |
|---|---|
| A row starting `~~\|`, or `~~` in its when or what cell | **cleared**: not shown |
| `ONGOING`, `standing`, `until …` (words, not a time), `HELD`, `multi-session` | **ongoing**: listed together, never stale |
| `hard stop [YYYY-MM-DD] HH:MM` | ends then |
| `→ HH:MM [Day]` | ends then. If that is earlier than the start, the end is the next day |
| `→ cap N h` / `→ cap N min` / `→ est. N h` | ends N after the start. If the start is `now`, it ends at 23:59 that day |
| `→ end of day`, or anything else with a date | ends at 23:59 that day |
| no `YYYY-MM-DD` at all | **no date**: listed together, never stale |

Upcoming windows appear in the agenda as **Box window** rows, and running ones under **Now**. A row that is still open **more than an hour after it ended** is **stale**: the strip shows it, with a link to open the ledger in the dashboard's file viewer (or a button that copies its path when the viewer can't open it). Clear the row in the ledger to resolve it.

## Machine timers

Crow can list the timers that run on your machines. **The gateway never connects to them.** It doesn't SSH, run commands or open network connections for this. It only reads JSON files from one folder:

```bash
CROW_HOST_TIMERS_DIR=/path/to/host-timers   # default: <CROW_HOME>/host-timers/
```

With no folder, nothing shows: a generic install costs one `stat` per page view. Writing the files is up to you. Use any tool you like (a cron job, a configuration-management run, a script that runs over SSH from somewhere else). Write each file atomically (write to a temporary file, then rename it), one file per machine.

### File format: `crow.host-timers/1`

```json
{
  "schema": "crow.host-timers/1",
  "host": "box-1",
  "tz": "America/Chicago",
  "collected_at": "2026-10-26T13:45:01Z",
  "timers": [
    { "id": "user:backup.timer", "kind": "systemd-user", "name": "backup",
      "schedule": "every 2 h", "next": "2026-10-26T15:00:00Z",
      "last": "2026-10-26T13:00:00Z", "last_result": "success" },
    { "id": "cron:3", "kind": "cron", "name": "collect.sh", "schedule": "*/15 * * * *" }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | Exactly `crow.host-timers/1`. Any other value and the file is skipped |
| `host` | yes | The machine's name as you want it shown (up to 64 characters) |
| `tz` | no | The machine's IANA time zone, used to work out cron times. Default `UTC` |
| `collected_at` | yes | When the file was written (ISO 8601 with a zone) |
| `timers[].id` | yes | Unique within the file. For systemd: the unit, optionally prefixed `user:` or `system:` |
| `timers[].kind` | yes | `systemd-system`, `systemd-user` or `cron` |
| `timers[].name` | no | What to show (up to 80 characters). For `cron`, only the command's file name is kept |
| `timers[].schedule` | no | For `cron`: the 5-field expression, which Crow uses to work out the next run. For systemd: any text, shown as is |
| `timers[].next`, `timers[].last` | no | For systemd: the next and last run (ISO 8601) |
| `timers[].last_result` | no | `success`, or anything else to mark the last run failed |

Rules the gateway applies:

- It reads at most **50** `*.json` files of up to **256 KB** each (it stops listing the folder there, or after 1,000 entries of any name), and up to 2,000 timers in all, cached for 60 seconds; an unchanged file is reused. Ids longer than 255 characters are dropped. Anything past these limits, or past a short time budget per read, is counted as "not shown" under **On the machines**. It works out at most 200 cron next runs per read, looking 35 days ahead: past that, a timer shows "no next run". Symlinks, FIFOs and files with leading dots are skipped. Unknown fields are dropped. A file that doesn't match the schema is skipped, not fatal.
- **Don't put secrets in the files.** Crontab lines can hold tokens, so emit only the schedule and the command, never its arguments. As a second guard, Crow keeps only a cron command's file name: it skips leading `VAR=value` words, `cd … &&` and wrappers such as `env` or `nice`.
- Everything from a file is escaped on the page.
- A timer whose `last_result` isn't `success` shows in the strip. Its fix copies a check command (`systemctl [--user] status -- <unit>`) only when the unit name starts with a letter or digit and uses systemd's own characters (`A–Z a–z 0–9 @ . _ : -`). Any other name is shown as text with no copy button. Crow never runs the command.
- A file whose `collected_at` is **more than an hour old** shows in the strip as **Machine data is old**. Run your collector again, or check that it is still scheduled.

Timers that run more often than hourly go in the agenda's **Runs all the time** fold. Every machine's full list is under **On the machines**, grouped by host.
