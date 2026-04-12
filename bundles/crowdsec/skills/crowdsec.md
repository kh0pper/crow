---
name: crowdsec
description: Detect intrusion attempts by parsing container logs; record decisions for separate bouncers to enforce
triggers:
  - "intrusion"
  - "attack"
  - "brute force"
  - "port scan"
  - "crowdsec"
  - "ban ip"
  - "who is attacking"
tools:
  - crowdsec_status
  - crowdsec_alerts
  - crowdsec_decisions
  - crowdsec_delete_decision
---

# CrowdSec — log-driven intrusion detection

CrowdSec reads logs from every running Docker container on this host
(read-only socket access), matches them against published attack-pattern
"scenarios" (brute-force SSH, HTTP scanning, bot scraping, etc.), and
records a **decision** — e.g., "ban 203.0.113.45 for 4h."

**Important scope limit for MVP**: this bundle only *detects*. It does not
*enforce*. Decisions sit in the LAPI until a **bouncer** reads them and
actually blocks the IP. No bouncer is installed in the MVP; PR 4.5 will add
a firewall-bouncer bundle. Until then, CrowdSec is an observability tool —
you'll see attacks in the panel and via MCP tools, but traffic from banned
IPs is not yet blocked.

## Install-time notes (consent_required)

This bundle asks for read-only access to `/var/run/docker.sock` so
CrowdSec can tail logs from every container. PR 0's install modal surfaces
this; Crow's validator refuses any rw variant.

## First-run: generate the bouncer API key

The MCP server and the panel need a bouncer-type API key. One-time setup:

```bash
# After `docker compose up -d` has brought crow-crowdsec to healthy
docker exec crow-crowdsec cscli bouncers add crow-mcp
# Output ends with a line like:
#   API key for 'crow-mcp':
#     3a7f9c0b1e2d4a6b8c7f0e1d3a5b7c9e
```

Copy that key into `~/.crow/.env` as `CROWDSEC_API_KEY=...` and restart the
Crow gateway so it picks up the env.

## Common operator tasks

### What's happening right now?
```
crowdsec_status
```
LAPI reachability, API-key configured flag, active decisions count, alerts
in the last 24h. Use this as the first question.

### Who's been trying to attack?
```
crowdsec_alerts { "since": "24h", "limit": 50 }
```
Returns source IP, country, ASN, matched scenario, event count, timestamps.
Use `since` = `1h` for a tight triage window or `7d` for trends.

### Who is currently banned?
```
crowdsec_decisions
crowdsec_decisions { "scope": "Ip", "origin": "crowdsec" }
```
Without a bouncer installed, these are recorded but not enforced. When a
bouncer is installed (PR 4.5), it polls this same list.

### Lift a false-positive ban
```
crowdsec_delete_decision { "id": 42, "confirm": "yes" }
```
Destructive — removes the specific decision. Bouncers will stop enforcing
it on their next sync (seconds to minutes depending on the bouncer's
`update_frequency`).

## Collections (what CrowdSec will match on)

The compose file pre-installs:
- `crowdsecurity/linux` — sshd failed logins, auth failures
- `crowdsecurity/sshd` — explicit SSH brute-force scenarios
- `crowdsecurity/base-http-scenarios` — HTTP probing, bad-bot scraping,
  sensitive-path discovery (wp-admin, phpmyadmin, etc.)
- `crowdsecurity/whitelist-good-actors` — ignores localhost, RFC1918,
  well-known crawlers (Googlebot, etc.)

To add more collections (e.g., nginx, caddy, traefik specifics):
```bash
docker exec crow-crowdsec cscli collections install crowdsecurity/nginx
docker exec crow-crowdsec cscli collections install crowdsecurity/caddy
docker exec crow-crowdsec systemctl reload crowdsec  # or: docker restart crow-crowdsec
```

## Optional: Console enrollment

CrowdSec's hosted Console UI (https://app.crowdsec.net) gives a richer
dashboard and participation in the community blocklist. Enroll your agent:

```bash
docker exec crow-crowdsec cscli console enroll <token-from-console-ui>
```

This is optional and opt-in — CrowdSec functions fully without it.

## Why no firewall-bouncer in this PR

CrowdSec upstream does **not** publish a Docker image for their
firewall-bouncer; the upstream install path is a host apt package + systemd
service. Packaging it as a Crow bundle requires a custom Dockerfile + a
tested unwind command (so a botched install doesn't lock the operator out
of the host). That scope is tracked as PR 4.5 and will run end-to-end on a
throwaway Pi before shipping. Until then this bundle is detection-only.
