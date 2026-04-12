---
name: uptime-kuma
description: Host-side view into an Uptime Kuma instance — reachability ping and Prometheus metrics
triggers:
  - "uptime kuma"
  - "monitors up"
  - "which services are down"
  - "service monitoring"
  - "is my website up"
tools:
  - uptimekuma_status
  - uptimekuma_metrics
---

# Uptime Kuma

Uptime Kuma is a self-hosted uptime monitor. This bundle runs it as a local
container on `127.0.0.1:3007` and exposes two host-side tools for Crow.

## First-run setup (required)

Uptime Kuma stores its entire configuration (monitors, notifications, status
pages, users) in its own SQLite database. There is **no pre-seeded admin
account** — you must create one before any other tool call will work.

1. Install and start the bundle.
2. Open `http://localhost:3007/` in a browser.
3. Complete the wizard (create admin username + password).
4. Save the username / password in Crow settings as `UPTIMEKUMA_USERNAME`
   and `UPTIMEKUMA_PASSWORD`. These are used for Prometheus `/metrics`
   basic auth — nothing else.
5. Add monitors through the Uptime Kuma web UI.

## Why only two tools

Uptime Kuma's authoritative API is socket.io-based and undocumented. It
cannot be called cleanly with plain `fetch`. Rather than ship half-working
wrappers, this bundle exposes only what works over straight HTTP:

- `uptimekuma_status` — reachability ping against `/`. Confirms the
  container is up. No credentials required.
- `uptimekuma_metrics` — fetches the Prometheus `/metrics` endpoint with
  HTTP basic auth and returns a parsed summary (per-monitor status,
  response times, counts).

Monitor creation, pause/resume, notification channels, tags, incidents,
status pages — all happen in the web UI. A future enhancement could bridge
the `uptime-kuma-api` Python package, but that pulls Python into a
JavaScript bundle and is out of scope for MVP.

## Typical usage

### Quick health check

```
uptimekuma_status
```

Returns reachability + HTTP status. Run this if the user says "is Uptime
Kuma running?".

### Which monitors are down right now?

```
uptimekuma_metrics { "detail": "monitors" }
```

Returns every monitor with its current status and last response time. Use
this when the user asks "what's down?" or "show me the monitors".

### Summary counts

```
uptimekuma_metrics { "detail": "summary" }
```

Returns `{ total_monitors, counts: { up, down, pending, maintenance } }`.

## Error handling

- **"Cannot reach Uptime Kuma"** — container is not running or
  `UPTIMEKUMA_URL` is wrong. Check `docker ps` for `crow-uptime-kuma`.
- **"Authentication failed"** — `UPTIMEKUMA_USERNAME` / `UPTIMEKUMA_PASSWORD`
  don't match the admin account. Reset them in Crow settings.
- **"UPTIMEKUMA_USERNAME and UPTIMEKUMA_PASSWORD must be set"** — tool
  needs credentials for basic auth; direct the user to complete the
  first-run setup above.
