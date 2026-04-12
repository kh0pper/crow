---
name: netdata
description: Real-time system and container metrics via the Netdata agent
triggers:
  - "cpu"
  - "memory"
  - "disk usage"
  - "metrics"
  - "monitoring"
  - "netdata"
  - "slow"
  - "alarm"
tools:
  - netdata_status
  - netdata_charts
  - netdata_query
  - netdata_alarms
---

# Netdata — real-time observability

Netdata collects per-second metrics for CPU, memory, disk, network, and every
running Docker container. The agent's web UI (http://localhost:19999) is the
richest view; the MCP tools below give the AI enough visibility to answer
operator questions without leaving the chat.

## Install-time notes (consent_required)

This bundle asks for read-only access to `/var/run/docker.sock`. PR 0's
install modal surfaces this at install time. The socket is mounted `:ro`
and Crow's compose validator refuses any writable variant.

**Not included in the MVP** (deliberate scope limit):
- `SYS_PTRACE` capability and `pid:host` — would give netdata per-process
  stats but would require `privileged: true`. The PR 4 bundle (crowdsec) is
  the first privileged path; observability stays in the consent_required
  tier. Per-process stats are unavailable until someone opts in manually.
- `/etc` mounts (`/etc/passwd`, `/etc/os-release`) — blocked by Crow's
  sensitive-path validator. Netdata will show "unknown" hostname/OS
  metadata. Acceptable trade-off.

## Common tasks

### Quick health check
```
netdata_status
```
Returns version, uptime, chart count, collector count, raised-alarm count.
If this errors, netdata is down or unreachable.

### Find a chart

```
netdata_charts { "filter": "cpu" }
netdata_charts { "filter": "docker" }
netdata_charts { "filter": "mem" }
```
Chart IDs look like `system.cpu`, `system.ram`, `disk_space._`,
`cgroup_crow-caddy.cpu`, `net.eth0`, etc.

### Read a chart's recent values
```
netdata_query { "chart": "system.cpu", "after_seconds": 300, "points": 10 }
```
Returns the most recent 10 points averaged over the last 5 minutes.

### Triaging alarms
```
netdata_alarms
```
Returns only raised alarms by default. Pass `include_all: true` for the full
list (large response). Walk through each by severity: critical > warning.

## Common gotchas

- **Chart IDs change when containers restart**: cgroup-based chart IDs include
  the container name. If `netdata_query` 404s, re-run `netdata_charts` with a
  filter to find the current ID.
- **Data volume**: Netdata keeps ~1 hour of in-memory history by default. For
  longer retention, edit `/etc/netdata/netdata.conf` inside the container
  (via `docker exec -it crow-netdata nano /etc/netdata/netdata.conf`).
- **Startup time**: First boot takes ~30s while netdata autodiscovers
  collectors. The healthcheck `start_period` accounts for this.
