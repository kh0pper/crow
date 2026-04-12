---
name: dozzle
description: Browser-based live Docker container log viewer
triggers:
  - "logs"
  - "container logs"
  - "tail logs"
  - "debug container"
  - "dozzle"
tools:
  - dozzle_status
  - dozzle_container_url
---

# Dozzle — live container log viewer

Dozzle is a lightweight web UI that streams Docker container logs in real
time. It reads the Docker socket (read-only) and renders a browser-native
log viewer with search, filtering, and a tail-follow mode.

## Install-time notes (consent_required)

This bundle asks for read-only access to `/var/run/docker.sock`. The install
modal surfaces this. The socket is mounted `:ro` and Crow's validator
refuses any writable variant.

Dozzle's action mode (`DOZZLE_ENABLE_ACTIONS`) and shell mode
(`DOZZLE_ENABLE_SHELL`) are **disabled** in the compose file — with those
enabled, Dozzle could start/stop containers and open shells through the
browser. Keep them off unless you intentionally want that.

## Using Dozzle

Dozzle is a UI-first tool, not an API. The MCP tools give minimal
affordances:

```
dozzle_status
```
Confirms Dozzle is up. Use this when the web UI looks stuck.

```
dozzle_container_url { "container": "crow-caddy" }
```
Returns a direct URL into Dozzle's live-tail view for that container.
Open it in a browser.

## When to use Dozzle vs other tools

- **Dozzle** — interactive investigation, live tailing, search across a
  single container's log stream.
- **Netdata** — metrics (CPU, memory, disk, network), not logs.
- **`docker logs <container>`** — scripting, one-shot extraction, grepping.
- **Alloy / Loki (not installed)** — long-term log retention and querying
  across many containers. Future bundle.

## Security

**Never expose Dozzle publicly without enabling its built-in auth.** Logs
routinely contain stack traces, connection strings, and occasionally secrets
that were accidentally logged. Dozzle binds to 127.0.0.1 by default — if you
front it with Caddy and publish to a domain, add an auth provider via
`DOZZLE_AUTH_PROVIDER`. See https://dozzle.dev/guide/authentication.
