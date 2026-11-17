# Box Reservation

A **box reservation** tells the gateway's GPU orchestrator that this machine is spoken for. While one exists, no local model that the reservation did not allow gets started: on-demand escalations degrade to the resident fast model, dashboard and panel starts are refused with a clear reason, and the residency timers wait. It exists so unattended benchmark windows and on-demand bot model starts stop colliding.

The same system is also the box's **calendar**: model windows, manual holds, the nightly audit and render/video GPU jobs all book their time there, and at most one of those bookings is the active hold at a time. One module (`servers/gateway/box-reservation.js`) owns both layers and every read-modify-write of either file goes under one lock.

## The two layers

### 1. The active hold — one JSON file

One file, on tmpfs, read by the gateway before any model start:

- `$CROW_BOX_RESERVATION_PATH` when set;
- otherwise `/run/user/<uid>/crow-box-reservation.json`.

There is at most **one** active hold per box: one GPU lane. The pre-calendar shape is still valid and is what a legacy writer produces:

```json
{
  "owner": "dsv4-window-20260904-2005",
  "reason": "bench window (cap 3600s)",
  "started_at": "2026-09-04T20:05:11Z",
  "expires_at": "2026-09-04T21:15:11Z",
  "allow": []
}
```

The calendar adds optional fields, written only when they are given (a hold without them writes exactly the old JSON):

```json
{
  "owner": "gpujob:9d1f",
  "reason": "video render",
  "started_at": "2026-11-17T19:30:00Z",
  "expires_at": "2026-11-17T19:50:00Z",
  "allow": [],
  "mode": "beside",
  "kind": "gpu-job",
  "booking_id": "bk_4f1c2a9b7d30",
  "job_id": "9d1f",
  "gtt_mb": 50000,
  "host_ram_mb": 40000,
  "hip_procs": 1,
  "gtt_used_at_activation_mb": 3400,
  "mem_available_at_activation_mb": 96000
}
```

- `expires_at` is mandatory. A crashed writer can never wedge the box: the hold simply lapses.
- A missing `mode` means `exclusive`. An unknown mode string is treated like any other unreadable record.
- `allow` lists providers the holder permits to start anyway. The embed provider (`crow-embed`) is always allowed, so search and memory keep working during a window.
- A file that cannot be parsed, that has no readable expiry, or that carries an unknown mode counts as **reserved** (fail closed). The dashboard gets a notification saying so.
- tmpfs means a reboot clears the hold. That is still the right default: a reboot ends every window. The calendar file survives it.

### 2. The calendar of bookings — a persistent file

- `$CROW_BOX_SCHEDULE_PATH` when set;
- otherwise `$XDG_STATE_HOME/crow/box-schedule.json`;
- otherwise `<home>/.local/state/crow/box-schedule.json`.

On disk it is `{version: 1, bookings: [...]}`. Every write goes to a temp file and is renamed in the same directory, under the lock. A missing file is an empty calendar. A file that is not JSON, or that has no `bookings` array, is never reset or overwritten: the functions that write refuse with `calendar_corrupt` (a calendar that cannot be read is a calendar whose promises cannot be seen), and hold reads — the orchestrator's hot path — never touch this file at all.

A booking is:

```
{id, owner, kind, mode, start, end, reason, allow[], gtt_mb?, host_ram_mb?, hip_procs?, evict[]?,
 recur?: {daily: "HH:MM-HH:MM"}, until?, occurrences?,
 approval: {state: not_needed|pending|approved|declined, by?, at?},
 status: booked|active|done|cancelled|lapsed, job_id?, created_by, created_at}
```

`kind` is `window`, `gpu-job`, `manual` or `audit`; `mode` is `exclusive` or `beside`. `start` and `end` are stored as ISO-8601 UTC.

- **Conflicts.** Two bookings conflict when their `[start, end)` intervals overlap, so adjacent windows `[a, b)` and `[b, c)` sit side by side. `book` refuses a conflicting booking and names the one in the way.
- **As soon as possible.** `--start asap` takes the first free gap long enough for the requested duration, searching 14 days ahead, and refuses with `no_gap` when nothing fits.
- **Daily bookings.** `--daily HH:MM-HH:MM [--until YYYY-MM-DD]` creates one series row: `start` is the first occurrence at or after now, `end` is null while the series is open-ended, and each occurrence is `<series id>@YYYY-MM-DD` (the local date its start falls on). Occurrences expand in local wall-clock time, so a window keeps its clock across a DST change; a wall time that does not exist becomes the top of the next hour; a window whose end is not after its start crosses midnight. The series row is kept for as long as it is not cancelled, so its occurrences stay addressable.
- **Pruning.** Done, cancelled and lapsed bookings are dropped once they ended more than 30 days ago; a series' occurrence entries age out the same way.
- **A legacy hold occupies time.** An unexpired active hold with no `booking_id` (or one naming a booking that is no longer live) is treated as the occupied interval `[started_at, expires_at)` in conflict and gap checks. A hold that names a live booking is represented by that booking and is not counted twice.

## Modes

### `exclusive`

The box is the holder's. A start is allowed only for a provider on `allow[]` (which always includes `crow-embed`); nothing else is read — no live counters, no host profile. This is today's behaviour, and it is what a legacy record gets.

### `beside`

A render/video job is sharing the card. A start is allowed when:

- the provider is on `allow[]`; or
- its **declared peak** (from the host profile) fits next to the job's *remaining* footprint under the live readings.

The host profile is `$CROW_GPU_HOST_PROFILE_PATH`, else `$XDG_STATE_HOME/crow/gpu-host-profile.json`, else `<home>/.local/state/crow/gpu-host-profile.json`, and it supplies `safety_margin_mb` (8192 by default) and `ram_floor_mb` (12288 by default) per provider `gtt_peak_mb` / `host_ram_peak_mb`. A missing or malformed profile yields those defaults and never throws.

Live readings come from `/sys/class/drm` (`mem_info_gtt_used`, `mem_info_gtt_total`) and `MemAvailable` in `/proc/meminfo`, read by a background sampler every 5 s (each read under a 2 s timeout, sysfs only, never `rocm-smi`). The gate stays synchronous and reads only the sampler's last snapshot.

The decision, once the job's remaining footprint is known:

```
gttUsedMb + remainingGtt + peak.gtt_peak_mb        <= gttTotalMb - safety_margin_mb
memAvailableMb - remainingRam - peak.host_ram_peak_mb >= ram_floor_mb
```

**Fail closed** for a beside hold: no declared peak for the provider, no snapshot at all, or a snapshot older than 15 s all refuse the start. Only beside holds read any of this; an exclusive hold is decided from the record alone.

**Admitted-peak accounting.** A beside hold records `gtt_used_at_activation_mb` and `mem_available_at_activation_mb` when it is activated (filled from one synchronous read if the writer did not supply them). The job's own growth is the live counters' movement since that baseline, *minus* the declared peaks of the providers this gateway started beside the hold — that growth is those providers', not the job's progress. The job's remaining footprint is its booked `gtt_mb` / `host_ram_mb` minus its own growth; with no baseline the whole booked amount is assumed still to come.

That tally of admitted providers is **per gateway process**, keyed by the hold's notice key (`owner@started_at`), and only the live hold's tally is kept. A gateway restart under a live hold loses it, and then:

- the growth of models started beside the job is read as the job's own, so the job's remaining footprint is counted too **small** — the gate can admit a start that does not truly fit;
- the same reading can make the job look like it outgrew its booking, so the over-budget refusal below can fire wrongly.

Neither can be recovered from inside the process: the tally only ever holds what this process itself admitted.

**`job_over_budget`.** A job whose own growth exceeds its booked `gtt_mb` is outgrowing its booking. Every start that is not on `allow[]` is then refused with `job_over_budget: true`, whether or not the provider's peak would fit, so the operator can re-book or extend the job. The orchestrator logs that once per hold.

A beside refusal uses the existing `box_reserved` code with `reason: "gpu_job_beside"`; the fallback path is unchanged (degrade to the fast model, or `503` with `Retry-After`).

## Lease, renew and the 8 h cap

- **Activate** is owner-checked: an unexpired hold by another owner (or an unreadable file) is a `box_held` conflict. Only the legacy `writeReservation` entry point takes over unconditionally, which is what an overwriting legacy writer needs.
- **Renew** extends the caller's own unexpired hold and keeps `started_at`, so the notice key `owner@started_at` does not change and no second notice goes out. A renew by a non-holder is `box_held`; renewing a hold that is missing or already expired is `box_held` with `holder: null` and never recreates the hold (a legacy `rm -f` teardown ends the lease). A renew that would run into the next booking fails with `renew_past_next_booking`, and the holder has to wind down and resume in a later gap.
- **The 8 h cap.** A single `minutes` over 8 h needs `force`, and for every hold except `kind: "gpu-job"` the *total span* from `started_at` also may not exceed 8 h without `force`. A GPU job's hold is exempt from the total-span limit: its holder renews a short lease often enough that a dead holder's hold lapses on its own, and no long TTL is guessed up front.
- **Release** is owner-checked too: only the holder's own hold is removed unless `force`. Releasing marks the booking the hold named `done`.

## The lock

Every read-modify-write of either file runs under one lock file beside the **calendar**: `<calendar dir>/crow-box-schedule.lock`. Locking beside the calendar (never beside the hold) means two processes with different hold paths still serialise on one calendar.

- It is a pid file created with `O_CREAT|O_EXCL`.
- A lock whose pid is gone is stale. The break is rename-atomic (the same primitive `models/native-lock.js` uses), so two processes that both decide to steal cannot both end up holding it.
- A lock file with no readable pid may belong to a process that has just created it and not yet written its pid: younger than 2 s it is left alone, older it is stale.
- Waiting is capped (5 s by default) and a timeout is an error with `code: "box_lock_timeout"`. The gateway uses the async form, which polls with `setTimeout` so the event loop keeps running; the synchronous form is for the CLI and tests.
- The lock is not re-entrant. A composed operation (book + activate, renew + extend its booking) calls the lock-free inner functions, not a second acquire.

## Approval

A booking that evicts anything (`evict[]` non-empty) or that is explicitly marked `needs_approval` starts with `approval.state = "pending"`.

- A **pending** booking occupies its slot exactly like an approved one, so nothing can take the time it is waiting for while the owner decides.
- A **pending approval older than 12 h** reads as declined, without writing the file, so a stale request can never be approved by waiting.
- A **declined** booking occupies no time at all.
- **Approve** re-checks the slot under the same lock before it clears: if another live booking or the live hold took the time while the request waited, the approval stays pending and the blocker is named.
- Activating a booking whose approval is pending or declined refuses with `booking_not_approved`.

The owner approves, declines and cancels from the dashboard: the Models panel's **Box schedule** section shows the active hold and the next 48 hours of bookings on one timeline, with Approve/Decline on pending rows and Cancel on booked ones.

Those buttons call a read route and three mutating ones, which are the same calendar functions the CLI uses:

```
GET  /api/box/schedule?from&to
POST /api/box/bookings/:id/approve
POST /api/box/bookings/:id/decline
POST /api/box/bookings/:id/cancel
```

- Session: the same JSON session gate the models API uses (not the redirect-based one), so an unauthenticated request is `401`, not a login page.
- CSRF: every mutating route runs the double-submit check.
- `approval.by` is `"owner:"` plus the first 8 hex characters of the SHA-256 of the session id, so the calendar says a dashboard session approved it without the token ever reaching the file.
- A cancel from the dashboard is the owner's: it is forced, with the booking's own owner read first in the same critical section.
- These routes are **never reachable over Funnel**: a request carrying `Tailscale-Funnel-Request` is answered `403 NETWORK_DENIED` before the session check, whatever `CROW_DASHBOARD_PUBLIC` says. `/api/box` is not a public Funnel prefix.

Approval is per series: an occurrence id resolves to its series row for approve/decline, while cancel and activation accept an occurrence id to touch that one day.

## The CLI

`scripts/ops/box-reserve.mjs` is the operator's door onto both layers.

```bash
# book (the id it prints is what activate/approve/cancel take)
node scripts/ops/box-reserve.mjs book --owner window-nightly --kind window --mode exclusive \
  --start 2026-11-17T19:30:00-06:00 --minutes 75 --reason "nightly window" --allow crow-chat

# a daily series (no --start, no --minutes; --until is optional)
node scripts/ops/box-reserve.mjs book --owner pi-lab-nightly-audit --kind audit --mode exclusive \
  --daily 02:15-04:15 --reason "pi-lab nightly audit"

# the calendar: a table, or JSON
node scripts/ops/box-reserve.mjs calendar --markdown
node scripts/ops/box-reserve.mjs calendar --from 2026-11-17T00:00:00Z --to 2026-11-20T00:00:00Z --json

# drop a booking
node scripts/ops/box-reserve.mjs cancel bk_4f1c2a9b7d30 --owner window-nightly

# clear or refuse a pending approval
node scripts/ops/box-reserve.mjs approve bk_4f1c2a9b7d30
node scripts/ops/box-reserve.mjs decline bk_4f1c2a9b7d30

# a manual hold: book + activate in one operation
node scripts/ops/box-reserve.mjs hold --owner alex --reason "serving tonight" --minutes 90

# activate a booking that already exists
node scripts/ops/box-reserve.mjs hold --booking bk_4f1c2a9b7d30

# extend the caller's own hold
node scripts/ops/box-reserve.mjs renew --owner alex --minutes 20

# free the box
node scripts/ops/box-reserve.mjs release                     # a legacy or manual hold
node scripts/ops/box-reserve.mjs release --owner alex
node scripts/ops/box-reserve.mjs release --owner alex --force # any hold

# the active hold plus the next 3 bookings
node scripts/ops/box-reserve.mjs status
```

- `book` needs `--minutes` unless it is a `--daily` series, and `--until` only goes with `--daily`. `--start` is an ISO time, `now` (the default) or `asap`.
- `calendar` defaults to the next 14 days. `--markdown` prints `| when (local) | owner | kind | mode | status | approval |`; `--json` prints the expanded bookings; neither flag prints plain columns.
- `hold` is one operation under the lock: it marks its own overlapping bookings `done`, preempts a `gpujob:` booking or live hold (see below), refuses to overlap anyone else's booking or hold, then books and activates. If activation fails after the booking was written the booking is cancelled, so a refused hold never leaves a ghost booking.
- `hold --booking <id>` derives the owner from the booking when `--owner` is not given.
- `renew` extends the booking the hold names along with the hold, so the calendar's `end` moves with the lease and a gap search does not hand out the running job's time. A hold with no booking is renewed on its own.
- `release` with no `--owner` frees the current hold when its `kind` is null (a legacy writer) or `manual`, and refuses a `gpu-job` hold without `--force`. The release marks the booking the hold named `done`.
- `status` prints the active hold plus the next 3 bookings as JSON (`none` when there is neither).

Exit codes: **0** ok · **1** refused (a booking conflict, a foreign holder, an approval that is not pending or is expired, a hold over the max, a corrupt calendar, a lock timeout) · **2** usage.

## Model windows, manual holds, the nightly audit and GPU jobs share one calendar

The calendar is the single arbiter of who gets the box when:

- **model windows** book their span and activate it when the window opens;
- **manual holds** are a plain `hold`, which books and activates at once;
- **the nightly audit** is a daily `audit` booking (`--daily 02:15-04:15`), so a GPU job sees it as an ordinary conflict instead of a hard-coded rule;
- **GPU jobs** book their plan's estimate (taking the first free gap when they ask "as soon as possible") and activate their own booking.

A plain `hold` by the owner may **preempt** a GPU job: a booking (or live hold) of kind `gpu-job` whose owner starts with `gpujob:` is marked `lapsed` and its hold replaced, so an operator who needs the box is never blocked by a job. The runner sees the foreign hold and winds the job down at its checkpoint. A plain `hold` never preempts a `window`, `manual` or `audit` booking or hold — it refuses instead.

## What the gateway does while held

| Actor | Behavior |
|---|---|
| `/llm/v1/chat/completions` escalation (companion, glasses, voice bots) | If the fast model is resident, the request is served by it with a system note that the larger model is unavailable. Otherwise `503` with `error.code = "box_reserved"`, an `error.reason`, and a `Retry-After`. Never a 240-second stall, never a start. |
| `POST /llm/acquire` (bots warming a model) | `409` with `box_reserved` and the same `reason`. The bridge already treats a failed warm as "proceed without warming". |
| Dashboard chat | An error event naming the owner and the expiry (`box_reserved`) instead of the generic "model did not load". |
| Models panel start | `409 BOX_RESERVED` with the owner and the expiry. |
| Boot residency, deferred-resident retries, idle-revert timer | Skipped while held, logged once per hold, resumed on the next residency tick after it ends. Under a beside hold only the starts that do not fit are skipped. |
| A provider that is **already running** | Untouched. Holds gate starts, not residency. |
| Session-summary completions (`completeText`) | Sends nothing while a hold exists, whatever the allow list says: it is optional background work that waits. |

Every refused start is logged with the requester tag (`requested-by=…`) and the reason (`gpu_job_beside` names the job), and the first refusal per hold raises a high-priority notification so a stale hold is visible from the phone.

## Other readers

- **Notices** (`box-reservation-notify.js`): one "start" notice per hold and at most one "refused" notice per hold. A beside hold sends no start notice — it never stops the box — and only the refusal one, worded "a render/video job is using part of the GPU until about <time>; large model starts that don't fit wait. They start by themselves when it ends." It never asks for `box-reserve release`.
- **Model catalog status**: a provider `startDecision` refuses under a beside hold gets `beside_job` ("Waiting: a render or video job is using the GPU"); one that fits keeps its normal status. An exclusive (or corrupt) hold keeps `blocked_by_reservation`.
- **Health signal**: the Nest's box reservation card appears while a hold exists (info, never a warn) and uses the beside wording for a beside hold; a corrupt file says it counts as reserved.
- **The Crow Artifacts sweep** (`sweepReserved`): an **exclusive** hold pauses the queued retries; a beside hold does not, because the sweep's starts fit beside it or are refused by the gate. A corrupt hold has no mode and counts as exclusive.

## Legacy writers

A writer that still writes the old hold shape keeps working:

- no `mode`, `kind` or `booking_id` reads as `exclusive` with those fields null, and `allow` behaves as before;
- such a hold occupies `[started_at, expires_at)` in the calendar's conflict and gap checks, so a booking cannot be laid over a live legacy hold;
- `release` with no `--owner` frees it (kind null is treated like `manual`);
- a legacy `rm -f` teardown is honoured: `renew` on a missing hold is `box_held` and never recreates it.

While such a writer exists it can overwrite a GPU job's hold; a job that finds a foreign holder at its next renew winds down and re-books rather than overwrite the other holder. Writers are expected to move to the CLI.

## Precedence

Holds win over on-demand starts. Bots degrade rather than wait; a beside hold only stops the starts that do not fit. This was decided on 2026-09-04 after two benchmark windows in one evening were aborted by anonymous escalations to the 35B model: the window's ownership guard stopped the container, the client retried, and the second strike aborted the run. The design gives the guard a way to win instead of a way to fight longer.

## Files

- `servers/gateway/box-reservation.js` — the active hold: reader, writer, the lock, owner-checked activate/renew/release, `startDecision`, `ReservedError`, defaults.
- `servers/gateway/box-schedule.js` — the booking calendar: book/conflicts/gaps, daily series, approve/decline/cancel, activate, renew-from-booking.
- `servers/gateway/models/gpu-peaks.js` — the host profile and each provider's declared peak.
- `servers/gateway/models/live-sampler.js` — the background GTT / `MemAvailable` sampler and its one-shot sync form.
- `servers/gateway/gpu-orchestrator.js` — the gate before every start, the admitted-peak tally, the over-budget report.
- `servers/gateway/routes/llm-router.js` — degrade or `503`/`409` with the reason.
- `servers/gateway/routes/box-schedule.js` — the owner routes; `servers/gateway/dashboard/panels/model-catalog-box-schedule.js` — the Box schedule section.
- `servers/gateway/box-reservation-notify.js` — once-per-hold notices, and `sweepReserved`.
- `servers/gateway/dashboard/panels/nest/health-signals.js` — the box reservation health card.
- `scripts/ops/box-reserve.mjs` — the CLI.