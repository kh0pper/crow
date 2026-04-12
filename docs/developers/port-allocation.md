# Port Allocation Registry

This document is the **single source of truth** for every host port consumed by Crow itself, by bundles in `bundles/`, and reserved by the MVP roadmap. Any new bundle PR that introduces a port binding must amend this file in the same PR. CI enforces that:

1. Every host port in any `bundles/**/docker-compose.yml` is listed here.
2. No two bundles map the same host port.

## Conventions

- All bundle ports bind to `127.0.0.1` unless the bundle is explicitly a reverse proxy (Caddy) or uses `network_mode: host` (browser, companion, coturn, plex, tailscale, crowdsec-firewall-bouncer).
- "Existing" rows are bundles already shipped before this registry was introduced — they are recorded here so future bundles avoid them.
- "Reserved" rows are claimed by upcoming Phase 2 bundles; do not consume them for unrelated work.
- "MVP" rows are claimed by the bundles in the current MVP plan.

## Known conflicts in current `bundles/`

These predate this registry and need follow-up resolution outside the MVP scope:

| Port | Conflict |
|---|---|
| 8080 | LocalAI and Nextcloud both bind 127.0.0.1:8080 — they cannot run simultaneously |

## Allocation table

| Port | Binding | Bundle / Service | Status |
|---|---|---|---|
| 22 | host | host sshd | reserved (system) |
| 25 | — | mail SMTP | reserved (Phase 2 mail) |
| 53 | host | host DNS / systemd-resolved | reserved (system) |
| 80 | 0.0.0.0 | Caddy (reverse proxy + ACME HTTP-01) | MVP PR 0.5 |
| 143 | — | mail IMAP | reserved (Phase 2 mail) |
| 443 | 0.0.0.0 | Caddy | MVP PR 0.5 |
| 465 | — | mail SMTPS | reserved (Phase 2 mail) |
| 587 | — | mail submission | reserved (Phase 2 mail) |
| 993 | — | mail IMAPS | reserved (Phase 2 mail) |
| 2222 | — | (avoid: common host anti-scan sshd port) | avoid |
| 2019 | 127.0.0.1 | Caddy admin API (host-local) | MVP PR 0.5 |
| 2223 | 127.0.0.1 | gitea (SSH) | MVP PR 5 |
| 2224 | 127.0.0.1 | forgejo (SSH) | MVP PR 5 |
| 2283 | 127.0.0.1 | immich (existing — verify in compose) | existing |
| 3001 | 127.0.0.1 | Crow gateway (HTTPS) | core |
| 3002 | 127.0.0.1 | Crow gateway (alt) | core |
| 3004 | 127.0.0.1 | Crow gateway (alt) | core |
| 3007 | 127.0.0.1 | uptime-kuma | MVP PR 1 |
| 3020 | 127.0.0.1 | adguard-home (admin UI) | MVP PR 3 |
| 3030 | 127.0.0.1 | homepage | MVP PR 1 |
| 3040 | 127.0.0.1 | gitea (web) | MVP PR 5 |
| 3050 | 127.0.0.1 | forgejo (web) | MVP PR 5 |
| 3080 | 127.0.0.1 | romm (existing) | existing |
| 3456 | 127.0.0.1 | vikunja (existing) | existing |
| 4533 | 127.0.0.1 | navidrome (existing) | existing |
| 5000 | 127.0.0.1 | kavita (existing) | existing |
| 5006 | 127.0.0.1 | actual-budget (existing) | existing |
| 5010 | 127.0.0.1 | changedetection | MVP PR 1 |
| 5042 | — | rotki (web/API) | reserved (Phase 2 finance) |
| 5080 | — | plausible | reserved (Phase 2 analytics) |
| 5335 | 127.0.0.1 | adguard-home (DNS, TCP+UDP) | MVP PR 3 |
| 5336 | — | pi-hole (DNS) | reserved (Phase 2 DNS) |
| 5337 | — | technitium (DNS) | reserved (Phase 2 DNS) |
| 6080 | 127.0.0.1 | browser (noVNC, existing) | existing |
| 6875 | 127.0.0.1 | bookstack (existing) | existing |
| 8000 | 127.0.0.1 | paperless (existing) | existing |
| 8080 | 127.0.0.1 | localai (existing) — **also nextcloud, conflict** | existing |
| 8081 | 127.0.0.1 | calibre-server (existing) | existing |
| 8083 | 127.0.0.1 | calibre-web (existing) | existing |
| 8084 | 127.0.0.1 | wallabag (existing) | existing |
| 8085 | 127.0.0.1 | miniflux (existing) | existing |
| 8086 | 127.0.0.1 | shiori (existing) | existing |
| 8088 | 127.0.0.1 | trilium (existing) | existing |
| 8091 | 127.0.0.1 | crowdsec (LAPI) | MVP PR 4 |
| 8092 | 127.0.0.1 | stirling-pdf | MVP PR 1 |
| 8094 | 127.0.0.1 | gatus | MVP PR 2 |
| 8095 | 127.0.0.1 | dozzle | MVP PR 2 |
| 8096 | 127.0.0.1 | jellyfin (existing) | existing |
| 8097 | 127.0.0.1 | vaultwarden | MVP PR 5 |
| 8098 | 127.0.0.1 | searxng | MVP PR 5 |
| 8530 | 127.0.0.1 | adguard-home (DNS-over-TLS) | MVP PR 3 |
| 9000 | 127.0.0.1 | minio (S3 API, existing) | existing |
| 9001 | 127.0.0.1 | minio (console, existing) | existing |
| 9090 | 127.0.0.1 | linkding (existing) | existing |
| 11434 | 127.0.0.1 | ollama (existing) | existing |
| 13378 | 127.0.0.1 | audiobookshelf (existing) | existing |
| 18789 | 127.0.0.1 | openclaw-old-docker (existing) | existing |
| 19999 | 127.0.0.1 | netdata | MVP PR 2 |
| 32400 | host | plex (host networking, existing) | existing |

## Host-networked bundles (no 127.0.0.1 binding — uses host stack directly)

These bundles use `network_mode: host`. They consume whatever ports their upstream service expects directly on the host:

- `browser` (Chrome DevTools — verify ports)
- `companion` (verify)
- `coturn` (3478 UDP, plus turnserver listen ports)
- `plex` (32400, plus discovery ports)
- `tailscale` (MagicDNS, peer connections)
- `crowdsec-firewall-bouncer` (deferred to PR 4.5 — upstream does not publish a Docker image; needs a custom Dockerfile and a tested unwind command verified on a throwaway host) — will need host network to manipulate iptables/nftables

## Process for amending this file

1. Pick an unallocated port in a sensible range (admin UIs in 3000-3099, backend APIs in 8000-8099, metrics in 19000-19999).
2. Add a row to the table with bundle name and PR/status.
3. CI port-collision check (`.github/workflows/port-allocation.yml`) verifies your new port doesn't clash.
4. Reference this file in your bundle's PR description.
