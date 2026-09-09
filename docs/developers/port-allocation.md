# Port Allocation Registry

This document is the **single source of truth** for every host port consumed by Crow itself, by bundles in `bundles/`, and reserved by the MVP roadmap. Any new bundle PR that introduces a port binding must amend this file in the same PR. CI enforces that:

1. Every host port in any `bundles/**/docker-compose.yml` is listed here.
2. No two bundles map the same host port.

## Conventions

- All bundle ports bind to `127.0.0.1` unless the bundle is explicitly a reverse proxy (Caddy) or uses `network_mode: host` (browser, companion, coturn, plex, tailscale, crowdsec-firewall-bouncer).
- "Existing" rows are bundles already shipped before this registry was introduced — they are recorded here so future bundles avoid them.
- "Reserved" rows are claimed by upcoming Phase 2 bundles; do not consume them for unrelated work.
- "MVP" rows are claimed by the bundles in the current MVP plan.
- This doc alone is not authoritative. A port is only actually free when it's free across all three registries: this table, every `docker-compose.yml` under `crow-addons/` AND `crow/bundles/` (not just the one you're editing), and live listeners on the host. A same-port/different-bind-address pair (e.g. `127.0.0.1:4210` vs. the tailnet IP on `4210`) can pass both `check-port-allocation.js` and a naive "is anything listening?" check, then show up later as a silent double-allocation — check all three before claiming a number.

## External ports (not Crow's to allocate)

- **4200/4201, pool 4101-4139** — the standalone lab `pi-hub` service (upstream, not a Crow bundle, not gateway-supervised, runs outside this repo's control). Do not "tidy" a future bundle onto these numbers.

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
| 3008 | 127.0.0.1 | Crow gateway (alt) | core |
| 3020 | 127.0.0.1 | adguard-home (admin UI) | MVP PR 3 |
| 3030 | 127.0.0.1 | homepage | MVP PR 1 |
| 3040 | 127.0.0.1 | gitea (web) | MVP PR 5 |
| 3050 | 127.0.0.1 | forgejo (web) | MVP PR 5 |
| 3061 | 127.0.0.1 | rookery (OpenScience reviewer) | PR #157 |
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
| 6080 | 127.0.0.1 | browser (noVNC, existing) — overridable via `CROW_BROWSER_VNC_PORT`; RFB 5900 via `CROW_BROWSER_RFB_PORT`, CDP 9222 via `CROW_BROWSER_CDP_PORT`. Secondary instances on one host pick +1 offsets (6081/5901/9223), and MUST also set a distinct X display number via `CROW_BROWSER_DISPLAY` (default 99, secondary 98) — under `network_mode: host` two instances on the same display collide | existing |
| 6875 | 127.0.0.1 | bookstack (existing) | existing |
| 8000 | 127.0.0.1 | paperless (existing) | existing |
| 8002 | tailscale IP | ~~ed-jobs-scraper backend~~ — freed 2026-07-26 (stack migrated to grackle :8002) | external, freed |
| 8004 | 127.0.0.1 | faster-whisper-server (local STT) | existing |
| 8007 | 127.0.0.1 | llamacpp-cpu-qwen3-embed (CPU embeddings) | PR #111 |
| 8080 | 127.0.0.1 | localai (existing) — **also nextcloud, conflict** | existing |
| 8081 | 127.0.0.1 | calibre-server (existing) | existing |
| 8083 | 127.0.0.1 | calibre-web (existing) | existing |
| 8084 | 127.0.0.1 | wallabag (existing) | existing |
| 8085 | 127.0.0.1 | miniflux (existing) | existing |
| 8086 | 127.0.0.1 | shiori (existing) | existing |
| 8088 | 127.0.0.1 | trilium (existing) | existing |
| 8089 | 127.0.0.1 + tailscale IP | edjobs nominatim (external, ~/ed-jobs-scraper) — R4 GIS tools + grackle scraper stack (ufw-scoped) | external |
| 8090 | 127.0.0.1 | capstone-tracker | shipped |
| 8091 | 127.0.0.1 | crowdsec (LAPI) | MVP PR 4 |
| 8092 | 127.0.0.1 | stirling-pdf | MVP PR 1 |
| 8094 | 127.0.0.1 | gatus | MVP PR 2 |
| 8095 | 127.0.0.1 | dozzle | MVP PR 2 |
| 8096 | 127.0.0.1 | jellyfin (existing) | existing |
| 8097 | 127.0.0.1 | vaultwarden | MVP PR 5 |
| 8098 | 127.0.0.1 | searxng | MVP PR 5 |
| 8010 | 100.118.41.122 (tailscale) | llamacpp-vulkan-qwen36-27b-copilot — co-resident critic refute/probe model, 65536 ctx, text-only (crow-addons) | existing (2026-07-06) |
| 8530 | 127.0.0.1 | adguard-home (DNS-over-TLS) | MVP PR 3 |
| 8554 | 127.0.0.1 | frigate (RTSP restream) | existing |
| 8555 | 127.0.0.1 | frigate (WebRTC) | existing |
| 8765 | 127.0.0.1 | motioneye | existing |
| 8880 | 127.0.0.1 | kokoro-tts (local TTS) | existing |
| 8971 | 127.0.0.1 | frigate (authenticated UI) | existing |
| 9000 | 127.0.0.1 | minio (S3 API, existing) | existing |
| 9001 | 127.0.0.1 | minio (console, existing) | existing |
| 9090 | 127.0.0.1 | linkding (existing) | existing |
| 11434 | 127.0.0.1 | ollama (existing) | existing |
| 13378 | 127.0.0.1 | audiobookshelf (existing) | existing |
| 18100-18199 | gateway-internal loopback | native model servers (per-CROW_HOME dynamic range, not bundle ports — managed by servers/gateway/models/state.js) | informational |
| 18789 | 127.0.0.1 | openclaw-old-docker (pre-existing external process) | existing |
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

## Second host: raven

Until 2026-09-09 this registry described one machine. The two-host production design
(`docs/superpowers/specs/2026-09-09-two-host-production-and-heavy-model-modes.md`) makes **raven** a production
host, so ports now need a host qualifier to mean anything.

Raven's ports live in their own namespace and do not collide with crow's. The first column below is deliberately
`raven:<port>` rather than a bare number, because `scripts/check-port-allocation.js` reads bare numbers in the
first cell as **crow** allocations. Keeping raven rows unparseable to it is correct today and is a stopgap:
**making the checker host-aware is follow-up work**, and until it lands, a raven port is only verified by looking
at raven.

### Production and reserved (raven)

| port | bind | what | status |
|---|---|---|---|
| raven:8030 | 0.0.0.0 | Qwen3.8-Flash-Next @1M, production (native systemd, not a container) | planned |
| raven:8031 | 0.0.0.0 | Flash-Next two-box master (window mode) | reserved |
| raven:8032 | 0.0.0.0 | DeepSeek-V4-Flash two-box master (window mode) | reserved |
| raven:8033 | 0.0.0.0 | GLM-5.3-Flash two-box master (window mode) | reserved |

### Benchmark-transient, held only inside a window

Bound by `pi-lab/scripts/`, never by a compose file, so `check-port-allocation.js` cannot see any of them. Listed
because a registry that covers a host while omitting ports in regular use is worse than one that omits the host.

| port | bind | what |
|---|---|---|
| raven:8021 | 127.0.0.1 | **two-box master port**, the standard across R1 to R26 (25 `raven-*` scripts). Thursday's W0 binds it |
| raven:8035 | 127.0.0.1 | R24 result-check server |
| raven:8036 | 127.0.0.1 | R25 / R25b single-box stack runs. This is the Flash-Next config chosen for production, so 8030 and 8036 are the same shape on different ports |
| raven:8037 | 127.0.0.1 | R23 knob-sanity (`KS_PORT`), moved here off 8031 when this section reserved that range |
| raven:8098 | 0.0.0.0 | zoo arm endpoint, two-box master and single-box arms (`ZOO_PORT`) |
| raven:8099 | 127.0.0.1 | Q4 MTP smoke |
| raven:50052 | 10.99.0.2 (USB4) | `ggml-rpc-server` when **raven** is the worker |
| raven:50053 | 127.0.0.1 | second `ggml-rpc-server`, for arms running two workers on raven's one GPU |
| crow:8012, 8013 | 127.0.0.1 | GLM-5.2 IQ2 and IQ4 windows (`glm52-window.sh` and friends) |
| crow:8020 | 127.0.0.1 | DeepSeek-V4-Flash windowed serve (`dsv4-window.sh`). The `crow-dsv4` provider row points here |
| crow:8021 | 127.0.0.1 | phase-0 Vulkan probes, run as duties under `dsv4-window.sh` (`PHASE0_PORT`) |
| crow:8022, 8024, 8025, 8026, 8027 | 127.0.0.1 | DSv4 Vulkan hyper-connection investigation duties (`dsv4-vk-hc-*`, `dsv4-ubatch-confirm`) |
| crow:8023 | 127.0.0.1 | DSv4 top-k A/B and HC verify (`TOPK_PORT`, `HCV_PORT`) |
| crow:8099 | 127.0.0.1 | GTT ladder duty under `dsv4-window --duty` |

### Three ports bind on BOTH machines

`8021`, `8099` and `50052` each mean two different things depending on the box. 8021 and 8099 are the same number
on the same loopback on two hosts, so nothing about the number distinguishes them; 50052 at least differs by bind
address (`10.99.0.1` is crow, `10.99.0.2` is raven). This is the whole argument for the `raven:`/`crow:` prefix,
and it is why the prefix is worth keeping even after the checker learns host-awareness. A bare number here is not
an allocation, it is an ambiguity.

Verified free on raven 2026-09-09: 8030 through 8033, 8035, 8036, 8037, 8098 and 8099. Raven listens only on 22,
53, 631 and two ephemeral ports.

### A constraint this registry cannot express

**Raven cannot host 8030 and 8036 at the same time, however free both ports are.** They are the same Flash-Next
single-box config, one as the proposed production port and one as the R25/R25b benchmark port, and each wants
about 92.6 GiB on a 124 GiB box. Two free ports, one machine's worth of memory. Allocating a port is not the same
as being able to run the thing, and no port table can say so.

Read it as the general case rather than one awkward pair: on a single-tenant box, port availability is a necessary
condition and never a sufficient one. Same class as the ordering constraint in
`docs/superpowers/specs/2026-09-09-two-host-production-and-heavy-model-modes.md` §3.0, where the port would have
been free and the arm would still have been unsafe.

### Three gaps this section exposes, all worth closing

1. **Crow's own model ports are largely unlisted.** 8003 (35b), 8006 (27b solo) and 8014 (27b 512k) are absent
   from the allocation table; only 8010 (27b copilot) is recorded. They bind the tailnet IP from `crow-addons/`
   composes, which the conventions above already flag as a separate registry, so nothing catches them.
2. **Crow's own benchmark ports were unlisted too**, and are now in the table above rather than the main one,
   because they are script-bound and transient. There are eleven of them.
3. **8098 is ambiguous across hosts.** The table allocates it to searxng on crow's loopback, while the two-box
   benchmark zoo arms conventionally use 8098 on raven. Both are correct today because they are different
   machines, and neither the table nor the checker can say so. This is precisely the class of silent
   double-allocation the conventions section warns about, one host further out.

### How this list was built, because the method outlasts the list

Four passes each found more, and the last two were humans reading their own trees:

1. `PORT=` assignments: four ports.
2. Adding `--port` and `host:port` forms: five more (8022, 8024 through 8027).
3. Adding the shell-default form `${VAR:-NNNN}`: this is the easiest to miss, because a scan for `PORT=8021`,
   `port 8021` or `:8021` returns **nothing** on a file that binds 8021 all day via `PORT="${PHASE0_PORT:-8021}"`.
   That form is also multiplying, since parameterising a hardcoded port is the right fix for the ambiguities above
   and creates a new hiding place every time.
4. Two people reading their own trees: four more ports, one wrong host attribution, and one live collision inside
   a range this section had just reserved.

Two failure modes worth naming, because both happened here and neither is a missing grep. A scan **surfaced** a
colliding port and its author read the hit as confirming their own reservation rather than as a conflict, which
turns evidence into confirmation and is worse than missing it. And a categorical negative, "not one script on that
host uses it", was asserted from a pattern that could not have matched the files in question. **Treat any scan of
this kind as a lower bound.** If the checker grows host-awareness, its companion should read invocations and
shell defaults as well as assignments.

## Process for amending this file

1. Pick an unallocated port in a sensible range (admin UIs in 3000-3099, backend APIs in 8000-8099, metrics in 19000-19999).
2. Add a row to the table with bundle name and PR/status.
3. CI port-collision check (the `static-checks` job in `.github/workflows/test.yml`) verifies your new port doesn't clash.
4. Reference this file in your bundle's PR description.
