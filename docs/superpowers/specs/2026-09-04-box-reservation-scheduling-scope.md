# Box-reservation scheduling for the gpu-orchestrator — SCOPE (2026-09-04)

Status: **BUILT 2026-09-04** — decisions in §6 accepted (reservations win; 8 h default hold; crow-embed exempt); shipped as PR #299 (attribution), PR #301 (gateway), pi-lab `9502dc6` (window side). Kept as the design record.
Predecessor: `RESERVATION-SCHEDULING-2026-08-29.md` (incident forensics) and
`/home/kh0pp/CROW-SCHEDULE.md` (the human-side schedule + automations inventory).

## 1. Problem, restated from the code

Two benchmark windows (pi-lab `dsv4-window.sh`, prod evicted, deadman armed) were
aborted on 2026-08-29 because something asked the gateway's `/llm/v1` router for
the 35b, the router called `maybeAcquireLocalProvider()`, and the orchestrator
`docker start`ed the model into a box the window owned. The window's 2-strike
ownership guard (`dsv4-deadman.sh` mem mode, ~line 220) stopped it; the caller
retried; strike two; window aborted.

What the code says about each piece:

- **`/llm/v1/chat/completions` is deliberately unauthenticated** (`llm-router.js`
  header comment: mounted without `dashboardAuth` because the host-networked
  companion arrives as loopback). So the requester is anonymous *by design*, not
  by omission — attribution has to come from what the request itself carries.
- **Escalation is decided per request** (`escReason` = `manual` on a leading
  `!escalate`, or `tool-intent` from the fast 4B's tool narration), and every
  escalated request calls `maybeAcquireLocalProvider(providerId)` before
  forwarding. There is **no retry loop inside the orchestrator**: `acquireProvider`
  starts once, waits `READINESS_TIMEOUT_MS = 240 s`, logs "did NOT become ready",
  and returns `false`. The "retry" that produced strike two was the *client*
  sending a second escalating request. Any client that retries (companion,
  a pibot, a PWA) reproduces the incident.
- **Six actors can start a model** (all funnel through `acquireProvider` /
  `ensureResident` in `gpu-orchestrator.js`):
  1. `/llm/v1` router (anonymous; companion, glasses, bots' voice loop)
  2. dashboard chat (`routes/chat.js:703`, authed session)
  3. models panel start (`routes/models.js:588`, authed)
  4. boot residency (`initOrchestrator` → `ensureResident` for always-resident providers)
  5. residency monitor / `retryDeferredResidents` / idle-revert (`checkIdleRevert`,
     `IDLE_REVERT_MS` = 20 min) — timers, no human
  6. pi-bots `warm.mjs` → `POST /llm/acquire` (bots warming their model before a turn)
  Actor 5 is the one nobody thinks of: idle-revert swaps *back to the default
  member* (the 35b) 20 min after a non-default sibling goes idle — inside a window
  that has evicted prod, this is a model start with no request behind it.
- **The window already has a marker convention**: `--teardown-marker <path>`
  (`dsv4-deadman.sh:46`), raised first thing in teardown; the guard treats "marker
  present or unreadable" as STAND DOWN. The reservation should live next to it.

## 2. Goal and non-goals

Goal: while the box is reserved, **no actor starts a model that the reservation
did not allow**, and requests that would have started one get a defined, fast,
non-retrying answer instead of a 240 s stall + start.

Non-goals (this pass): scheduling future reservations (CROW-SCHEDULE.md stays the
human calendar), multi-box arbitration, changing the deadman's 2-strike shape
(keep it — give it a way to *win*, not to fight longer), bot model fallback
quality (a degraded answer is acceptable; a silent start is not).

## 3. Design

### 3.1 Reservation record (the shared signal)
- Path: `/run/user/1000/crow-box-reservation.json` (tmpfs; vanishes on reboot,
  which is the right default — a reboot ends every window).
- Shape: `{ owner, reason, started_at, expires_at, allow: [providerName…] }`.
  `expires_at` is **mandatory** (a crashed window can't wedge prod); `allow` lists
  providers the reservation holder itself may start (e.g. the window's own heavy
  model when it goes through the gateway, or `[]`).
- Writer: `dsv4-window.sh` at open (cap = `expires_at`), removed at teardown;
  also a tiny CLI `scripts/ops/box-reserve.mjs {hold|release|status}` for manual
  serving sessions (Kevin's `--serve` use) so "I'm using the box tonight" is one
  command.
- Reader: `gpu-orchestrator.js` `readReservation()` — pure, cached ≤2 s, treats
  parse errors as **reserved** (fail closed: a corrupt file means someone was
  mid-write).

### 3.2 Orchestrator behavior while reserved
- `acquireProvider(name)`: if the provider is already ready → proceed (no start
  involved). Else if `name ∉ allow` → **refuse without starting**: throw
  `ReservedError { owner, expires_at }` (typed, so callers can branch).
- `ensureResident`/`retryDeferredResidents`/`checkIdleRevert`: skip starts while
  reserved, log once per reservation ("residency deferred: box reserved by X until
  T"), and re-run on the next residency tick after expiry.
- `waitForReady` is untouched.

### 3.3 Caller behavior on `ReservedError`
- `/llm/v1` router: **degrade, never stall**. Serve the request from the fast
  resident model (`crow-voice` 4B) with a system note that escalation is
  unavailable, or return `503 {error:{code:"box_reserved", retry_after}}` if even
  the fast model is not resident. Either way the client gets an answer in
  milliseconds and has no reason to retry into a second strike.
- dashboard chat + models panel: surface the reservation (owner, until) in the
  existing error path; no start.
- `POST /llm/acquire` (bots warming): 409 `box_reserved`; the bridge already
  treats warm failure as "proceed without warm", so bots degrade the same way.
- Companion/glasses: nothing to change client-side — they see a normal reply.

### 3.4 Attribution (do first, independent of the rest)
Log with every route decision in `llm-router.js` and every start in
`acquireProvider`: `ip`, `user-agent`, `x-crow-client` (new optional header the
companion, glasses server, bridge `warm.mjs` and dashboard clients set to a
short id), and for the router the `escReason` + first 80 chars of the last user
message. This is a log-only change with zero behavior risk and answers "who
asked for the 35b at 19:57" on the next occurrence. Ship it alone as PR 1.

### 3.5 Visibility
- Dashboard health card: "Box reserved by <owner> until <time>" while the file
  exists; ntfy on `kevin-r4`/`pi` when a reservation is *refused* a start for the
  first time (so a stuck reservation is visible from the phone), throttled 1/10 min.
- `CROW-SCHEDULE.md` stays the human calendar; the file is the machine truth for
  *now*. A later pass can generate the Reservations table from it.

### 3.6 pi-lab side (separate PR, same day)
- `dsv4-window.sh`: write/remove the reservation beside the teardown marker;
  `--serve` sessions too.
- Teardown-note mislabel ("ABORTED BY THE MEMORY WATCHDOG" printed for ownership
  losses) → echo the marker's actual reason.

## 4. Suite / tests to write
- `tests/gpu-orchestrator-reservation.test.js`: reserved + provider ready → ok;
  reserved + not ready + not allowed → `ReservedError`, `bundleUp` **never
  called**; expired file → treated as unreserved; corrupt file → reserved;
  idle-revert skips while reserved and resumes after.
- `tests/llm-router.test.js` additions: escalate under reservation returns a fast
  reply / 503 within the connect timeout, no acquire call.
- pi-lab `test/dsv4-window-ownership.test.mjs`: reservation written at open,
  removed at teardown, present after a simulated crash until expiry.

## 5. Sizing
PR 1 attribution: ~½ day incl. tests. PR 2 orchestrator + router + panel copy:
~1.5 days. PR 3 pi-lab window side: ~½ day. No schema change, no migration rail.

## 6. Operator decisions needed before build
1. **Precedence.** Recommendation: **reservations win**, bounded by `expires_at`
   and the ntfy in §3.5. Bots degrade to the fast model rather than wait. The
   alternative (bots win) is today's behavior and cannot coexist with unattended
   windows.
2. **Max reservation duration.** Recommendation: cap at 8 h by default (`--force`
   to exceed, mirroring `dsv4-window.sh`'s own `--force` semantics), so a
   forgotten manual hold auto-releases before a work morning.
3. (minor) Should the always-resident embed model (`crow-embed`) be exempt from
   reservations? Recommendation: yes — add it to a default `allow` so search and
   memory keep working during windows; it is small and never evicted today.
