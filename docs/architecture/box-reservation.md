# Box Reservation

A **box reservation** tells the gateway's GPU orchestrator that this machine is spoken for. While one exists, no local model that the reservation did not allow gets started: on-demand escalations degrade to the resident fast model, dashboard and panel starts are refused with a clear reason, and the residency timers wait. It exists so unattended benchmark windows and on-demand bot model starts stop colliding.

## The record

One JSON file on tmpfs, at `$CROW_BOX_RESERVATION_PATH` or `/run/user/<uid>/crow-box-reservation.json` by default:

```json
{
  "owner": "dsv4-window-20260904-2005",
  "reason": "bench window (cap 3600s)",
  "started_at": "2026-09-04T20:05:11Z",
  "expires_at": "2026-09-04T21:15:11Z",
  "allow": []
}
```

- `expires_at` is mandatory. A crashed writer can never wedge the box: the reservation simply lapses.
- `allow` lists providers the holder permits to start anyway. The embed provider (`crow-embed`) is always allowed, so search and memory keep working during a window.
- A file that cannot be parsed, or that has no expiry, counts as **reserved** (fail closed). The dashboard gets a notification saying so.
- tmpfs means a reboot clears every reservation, which is the right default: a reboot ends every window.

## Who writes it

- **Unattended windows** (pi-lab `dsv4-window.sh`) write it when they open and remove it at teardown. The window's deadman also removes it when it restores production after a crash. The expiry is the window's wall-clock cap plus ten minutes of slack.
- **Manual holds** use the CLI:

```bash
node ~/crow/scripts/ops/box-reserve.mjs hold --owner kevin --reason "serving dsv4 tonight" [--minutes 480] [--allow p1,p2] [--force]
node ~/crow/scripts/ops/box-reserve.mjs status
node ~/crow/scripts/ops/box-reserve.mjs release
```

The default hold is eight hours. A longer hold needs `--force`, so a forgotten manual hold auto-releases before a work morning.

## What the gateway does while reserved

| Actor | Behavior |
|---|---|
| `/llm/v1/chat/completions` escalation (companion, glasses, voice bots) | If the fast model is resident, the request is served by it with a system note that the larger model is unavailable. Otherwise `503` with `error.code = "box_reserved"` and a `Retry-After`. Never a 240-second stall, never a start. |
| `POST /llm/acquire` (bots warming a model) | `409 box_reserved`. The bridge already treats a failed warm as "proceed without warming". |
| Dashboard chat | An error event naming the owner and the expiry instead of a generic "model did not load". |
| Models panel start | `409 BOX_RESERVED` with owner and expiry. |
| Boot residency, deferred-resident retries, idle-revert timer | Skipped while reserved, logged once per reservation, resumed on the next residency tick after expiry. |
| A provider that is **already running** | Untouched. Reservations only gate starts. |

Every refused start is logged with the requester tag (`ip ua=… client=…`), and the first refusal per reservation raises a high-priority notification so a stale reservation is visible from the phone.

## Precedence

Reservations win. Bots degrade rather than wait. This was decided on 2026-09-04 after two benchmark windows in one evening were aborted by anonymous escalations to the 35B model: the window's ownership guard stopped the container, the client retried, and the second strike aborted the run. The design gives the guard a way to win instead of a way to fight longer.

## Files

- `servers/gateway/box-reservation.js` — reader, writer, `ReservedError`, defaults.
- `servers/gateway/box-reservation-notify.js` — once-per-reservation notices.
- `servers/gateway/gpu-orchestrator.js` — the gate before every start.
- `servers/gateway/routes/llm-router.js` — degrade or `503`.
- `scripts/ops/box-reserve.mjs` — the CLI.
- pi-lab `scripts/dsv4-window.sh` — the window-side writer.
