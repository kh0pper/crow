# Port Allocation Registry

This document is the **single source of truth** for every host port consumed by Crow itself, by bundles in `bundles/`, and reserved by the MVP roadmap. Any new bundle PR that introduces a port binding must amend this file in the same PR. CI enforces that:

1. Every host port in any `bundles/<id>/docker-compose*.yml` (overlays such as `docker-compose.tailnet.yml` included) is listed here. A host port written as `${VAR:-N}` or `${VAR-N}` counts as `N`, the port a fresh install publishes. A host port that is a variable with no default (`${VAR}`) has no number to check.
2. No two bundles publish the same host port on overlapping addresses: the same host IP, or either side a wildcard (no IP, `0.0.0.0`, `::`). Two different specific addresses on one port (loopback and the tailnet IP, the 8004 case below) do not clash. A host-IP variable with no default (`${CROW_TAILSCALE_IP}`) is a wildcard, because unset publishes on every address; write it as `${CROW_TAILSCALE_IP:-127.0.0.1}` (unset means loopback) or `${CROW_TAILSCALE_IP:?…}` (required, so Compose refuses to start) to make it one specific address. Two services of one bundle are checked against each other too.
3. The repo-root `docker-compose.yml` is scanned as well. Its `garage` service (`--profile storage`, the default object storage) is the garage bundle's alternative deployment, and its `minio` service (`--profile minio-legacy`) is the minio bundle's (the two never run together), so their ports count as those bundles'. A ports entry the checker cannot read is printed as a WARNING.

## Conventions

- All bundle ports bind to `127.0.0.1` unless the bundle is explicitly a reverse proxy (Caddy) or uses `network_mode: host` (browser, companion, coturn, plex, tailscale, crowdsec-firewall-bouncer).
- A bundle port whose host IP is a variable must carry a non-empty default — `${CROW_TAILSCALE_IP:-127.0.0.1}` — or be a REQUIRED variable (`${CROW_TAILSCALE_IP:?…}`), which Compose refuses to start without. A bare `${CROW_TAILSCALE_IP}`, `$VAR` or `${VAR:-}` publishes on every interface when the variable is unset — which is how an unauthenticated model, STT or TTS server ends up on the LAN. Bundle host-IP variables therefore default to `127.0.0.1`: unset means loopback, never `0.0.0.0`. `tests/compose-port-bind-defaults.test.js` enforces this; the one deliberate exception is the reverse proxy's public 80/443, listed in `scripts/port-bind-allowlist.txt`.
- The Crow gateway is not one of those loopback-only processes: it listens on `0.0.0.0` (every interface) unless `CROW_GATEWAY_BIND` is set (`servers/gateway/listen-host.js`). The docker install publishes it on `127.0.0.1` only; a bare-metal/native install binds every interface and is protected by the host firewall and Tailscale, not by the bind address.
- "Existing" rows are bundles already shipped before this registry was introduced — they are recorded here so future bundles avoid them.
- "Reserved" rows are claimed by upcoming Phase 2 bundles; do not consume them for unrelated work.
- "MVP" rows are claimed by the bundles in the current MVP plan.
- This doc alone is not authoritative. A port is only actually free when it's free across all three registries: this table, every `docker-compose.yml` under `crow-addons/` AND `crow/bundles/` (not just the one you're editing), and live listeners on the host. A same-port/different-bind-address pair (e.g. `127.0.0.1:4210` vs. the tailnet IP on `4210`) can pass both `check-port-allocation.js` and a naive "is anything listening?" check, then show up later as a silent double-allocation — check all three before claiming a number.
- The peer relay (`/peer-relay/<instance>/<mount>/mcp`, how a pi bot's remote-tools proxy reaches a paired peer) is a route on the gateway's own loopback port. No new port.
- Docker subnets: `crow-workspace` pins 10.89.70.0/24 (scratch: 10.89.71.0/24 smoke, 10.89.72.0/24 restore). Do not reuse.

## External ports (not Crow's to allocate)

- **4200/4201, pool 4101-4139** — the standalone lab `pi-hub` service (upstream, not a Crow bundle, not gateway-supervised, runs outside this repo's control). Do not "tidy" a future bundle onto these numbers.

## Known conflicts in current `bundles/`

These predate this registry and need follow-up resolution outside the MVP scope:

| Port | Conflict |
|---|---|
| — | none. The 8080 LocalAI/Nextcloud collision was resolved 2026-10-02 (the nextcloud bundle no longer deploys; Crow Workspace uses 3070/3071). |

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
| 2019 | — | (retired: the Caddy admin API is a unix socket, ~/.crow/caddy/run/admin.sock; keep free) | retired |
| 2223 | 127.0.0.1 | gitea (SSH) | MVP PR 5 |
| 2224 | 127.0.0.1 | forgejo (SSH) | MVP PR 5 |
| 2586 | 127.0.0.1 | ntfy (`NTFY_PORT`; tailnet reaches it through `tailscale serve 2586`, never Funnel) | existing |
| 2283 | 127.0.0.1 | immich (existing — verify in compose) | existing |
| 3001 | every interface (`0.0.0.0`, unless `CROW_GATEWAY_BIND` is set — `servers/gateway/listen-host.js`); the container install publishes the port on `127.0.0.1` only | Crow gateway (HTTPS) | core |
| 3002 | same as 3001 (the process binds every interface unless `CROW_GATEWAY_BIND` is set) | Crow gateway (alt) | core |
| 3004 | same as 3001 (the process binds every interface unless `CROW_GATEWAY_BIND` is set) | Crow gateway (alt) | core |
| 3005 | 127.0.0.1 | sdxl (overridable via `SDXL_PORT`; companion reaches it at localhost over host networking) | existing |
| 3007 | 127.0.0.1 | uptime-kuma | MVP PR 1 |
| 3008 | same as 3001 (the process binds every interface unless `CROW_GATEWAY_BIND` is set) | Crow gateway (alt) | core |
| 3014 | 127.0.0.1 | Satellite Crow agent (satellite host only, `CROW_SATELLITE_PORT`; tailnet reach through Tailscale Serve, never Funnel) | SAT-3 |
| 3020 | 127.0.0.1 | adguard-home (admin UI) | MVP PR 3 |
| 3030 | 127.0.0.1 | homepage | MVP PR 1 |
| 3040 | 127.0.0.1 | gitea (web) | MVP PR 5 |
| 3050 | 127.0.0.1 | forgejo (web) | MVP PR 5 |
| 3061 | 127.0.0.1 | rookery (OpenScience reviewer) | PR #157 |
| 3065 | 127.0.0.1 (host network) | phone (crow-phone-runner, assistant calls; binds loopback only) | Phone plan A |
| 3070 | 127.0.0.1 | workspace (Crow Workspace: Nextcloud web; tailnet via Serve :8456) | W1 2026-10 |
| 3071 | 127.0.0.1 | workspace (Crow Workspace: ONLYOFFICE Docs; tailnet via Serve :8457) | W1 2026-10 |
| 3075 | 127.0.0.1 | unsloth (Unsloth Studio web UI; `webUI.proxyMode: direct`, so the installer also adds Tailscale Serve HTTPS on the same port number on the tailnet interface, never Funnel) | item 3 (store: Unsloth) |
| 3076 | 127.0.0.1 | unsloth (JupyterLab; loopback only, no Serve route) | item 3 (store: Unsloth) |
| 3080 | 127.0.0.1 | romm (existing) | existing |
| 3090 | 127.0.0.1 | Crow Artifacts: main instance artifact origin (`CROW_ARTIFACT_ORIGIN_PORT=3090`). A gateway-internal listener, not a compose port; reached through its own sidecar Tailscale node's Serve (443 on its own hostname), never Funnel | Artifacts step 1 |
| 3091 | 127.0.0.1 | Crow Artifacts: second co-hosted instance artifact origin (`CROW_ARTIFACT_ORIGIN_PORT=3091`). A gateway-internal listener, not a compose port | Artifacts step 1 |
| 3092 | 127.0.0.1 (container publish) | Crow Artifacts: household container instance artifact origin (`CROW_ARTIFACT_ORIGIN_PORT=3092`); behind the same DOCKER-USER fence rule as that container's other published ports. A gateway-internal listener, not a compose port | Artifacts step 1 |
| 3093 | 127.0.0.1 | Crow Artifacts: main instance public-link listener (later step; the only artifacts port ever mapped to Funnel, through the sidecar node's own 8443). A gateway-internal listener, not a compose port | reserved (Artifacts step 6) |
| 3456 | 127.0.0.1 | vikunja (existing) | existing |
| 3900 | 127.0.0.1 (default; `GARAGE_BIND_ADDR` = the tailnet IP to share storage with paired instances) | garage (S3 API) | Garage migration PR 1 |
| 3901 | container-internal | garage (RPC between Garage processes; never published) | Garage migration PR 1 |
| 3902 | — | garage (web endpoint, reserved; not configured or published) | reserved (Garage) |
| 3903 | 127.0.0.1 | garage (admin API; loopback only, never tailnet or Funnel) | Garage migration PR 1 |
| 4533 | 127.0.0.1 | navidrome (existing) | existing |
| 5000 | 127.0.0.1 | kavita (existing) | existing |
| 5006 | 127.0.0.1 | actual-budget (existing) | existing |
| 5010 | 127.0.0.1 | changedetection | MVP PR 1 |
| 5042 | — | rotki (web/API) | reserved (Phase 2 finance) |
| 5080 | — | plausible | reserved (Phase 2 analytics) |
| 5335 | 127.0.0.1 | adguard-home (DNS, TCP+UDP) | MVP PR 3 |
| 5336 | — | pi-hole (DNS) | reserved (Phase 2 DNS) |
| 5337 | — | technitium (DNS) | reserved (Phase 2 DNS) |
| 6080 | 127.0.0.1 | browser (noVNC, existing) — since 1.4.0 noVNC binds 127.0.0.1 only and needs the per-instance `CROW_BROWSER_VNC_TOKEN` that the gateway's `/proxy/browser/` adds server-side; RFB is a unix socket inside the container, no TCP port (5900/5901 are no longer used; the entrypoint refuses to start otherwise). Overridable via `CROW_BROWSER_VNC_PORT`. Secondary instances on one host pick +1 offsets (6081/9223), and MUST also set a distinct X display number via `CROW_BROWSER_DISPLAY` (default 99, secondary 98) — under `network_mode: host` two instances on the same display collide | existing |
| 9222 | 127.0.0.1 | browser (CDP relay) — since 1.5.0 this is the container's **relay**, not Chromium: Chromium runs on `--remote-debugging-pipe` and opens no port, and the relay answers only a caller with `CROW_BROWSER_CDP_TOKEN` as a bearer token. No compose `ports:` entry (the container is `network_mode: host`), so no `check-ports` mapping; the row is here because the number is a host allocation. Overridable via `CROW_BROWSER_CDP_PORT`; a co-hosted instance (r4) takes 9223 alongside its 6081/98. The browser manifest no longer lists 9222 in `ports`, so an install from before 1.5.0 still has a stale `ufw allow … port 9222` from the tailnet that the new one does not create | existing |
| 6875 | 127.0.0.1 | bookstack (existing) | existing |
| 8000 | 127.0.0.1 | paperless (existing) | existing |
| 8002 | tailscale IP | ~~ed-jobs-scraper backend~~ — freed 2026-07-26 (stack migrated to the home server :8002) | external, freed |
| 8003 | tailscale IP (`CROW_TAILSCALE_IP`; unset → `127.0.0.1`) | llamacpp-vulkan-qwen36-35b-a3b (crow-chat) | existing |
| 8004 | 127.0.0.1 | faster-whisper-server (local STT) | existing |
| 8004 | tailscale IP | llamacpp-vulkan-qwen3-embed (crow-embed; same port as faster-whisper, different interface) | existing |
| 8005 | tailscale IP (`CROW_TAILSCALE_IP`; unset → `127.0.0.1`) | faster-whisper-server tailnet overlay (`docker-compose.tailnet.yml`, opt-in cross-instance STT; moved off 8004, which crow-embed holds on the tailnet IP) | existing |
| 8007 | 127.0.0.1 | llamacpp-cpu-qwen3-embed (CPU embeddings) | PR #111 |
| 8011 | tailscale IP (`CROW_TAILSCALE_IP`; unset → `127.0.0.1`) | vllm-rocm-qwen35-4b (crow-voice classifier / fast route) | existing |
| 8012 | 127.0.0.1 | llamacpp-vulkan-qwen3-vl-4b (crow-vision: dedicated vision model for vision profiles, Meta Glasses look turns and the vision role; loopback only, no ufw rule) | glasses vision |
| 8018 | 127.0.0.1 | design-kit (renderer door: Vega-Lite / Mermaid / D2 → SVG; the render container itself sits on an internal-only Docker network with no egress; no ufw rule) | Design kit v1 |
| 8040 | 127.0.0.1 | lemmy (API for Crow's host-run MCP server and panel, `LEMMY_API_PORT`; the public site goes through Caddy) | item 30 |
| 8041 | 127.0.0.1 | kolibri (`KOLIBRI_HTTP_PORT`; default moved from 8085, which miniflux holds) | existing (moved 2026-10) |
| 8042 | 127.0.0.1 | nominatim (`NOMINATIM_PORT`; default moved from 8088, which trilium holds) | existing (moved 2026-10) |
| 8043 | 127.0.0.1 | maker-lab-advanced (JupyterHub, `MLA_HTTP_PORT`; default moved from 8088, which trilium holds) | existing (moved 2026-10) |
| 8044 | 127.0.0.1 | vllm (`VLLM_HTTP_PORT`; default moved from 8089, which the external edjobs nominatim holds on the primary host; maker-lab probes this port for vLLM) | existing (moved 2026-10) |
| 8080 | 127.0.0.1 | localai (existing) | existing |
| 8081 | 127.0.0.1 | calibre-server (existing) | existing |
| 8083 | 127.0.0.1 | calibre-web (existing) | existing |
| 8084 | 127.0.0.1 | wallabag (existing) | existing |
| 8085 | 127.0.0.1 | miniflux (existing) | existing |
| 8086 | 127.0.0.1 | shiori (existing) | existing |
| 8087 | 127.0.0.1 | scratch-offline (`SCRATCH_HTTP_PORT`) | existing |
| 8088 | 127.0.0.1 | trilium (existing) | existing |
| 8089 | 127.0.0.1 + tailscale IP | edjobs nominatim (external, ~/ed-jobs-scraper) — R4 GIS tools + the home server scraper stack (ufw-scoped). The vllm bundle's default used to be 8089 too; it moved to 8044 | external |
| 8090 | 127.0.0.1 | (reserved — a private bundle maintained outside this repo) | reserved |
| 8091 | 127.0.0.1 | crowdsec (LAPI) | MVP PR 4 |
| 8092 | 127.0.0.1 | stirling-pdf | MVP PR 1 |
| 8094 | 127.0.0.1 | gatus | MVP PR 2 |
| 8095 | 127.0.0.1 | dozzle | MVP PR 2 |
| 8096 | 127.0.0.1 | jellyfin (existing) | existing |
| 8097 | 127.0.0.1 | vaultwarden | MVP PR 5 |
| 8098 | 127.0.0.1 | searxng | MVP PR 5 |
| 8456 | tailnet (Serve) | Tailscale Serve HTTPS → 127.0.0.1:3070 (Workspace; never Funnel) | W1 2026-10 |
| 8457 | tailnet (Serve) | Tailscale Serve HTTPS → 127.0.0.1:3071 (Workspace editor; never Funnel). Plus one Serve PATH on the same port, no new port: `/crow-live` → `http://127.0.0.1:<gateway port>/api/workspace/live` (W2 K5 live-edit plugin; set up by the operator from Office › For the admin) | W1 2026-10, W2 path |
| 8010 | 100.64.20.1 (tailscale) | llamacpp-vulkan-qwen36-27b-copilot — co-resident critic refute/probe model, 65536 ctx, text-only (crow-addons) | existing (2026-07-06) |
| 8600 | 127.0.0.1 | funkwhale (nginx, `FUNKWHALE_NGINX_BIND_PORT`; bind address `FUNKWHALE_NGINX_BIND_ADDR`) | existing |
| 8530 | 127.0.0.1 | adguard-home (DNS-over-TLS) | MVP PR 3 |
| 8554 | 127.0.0.1 | frigate (RTSP restream) | existing |
| 8555 | 127.0.0.1 | frigate (WebRTC) | existing |
| 8765 | 127.0.0.1 | motioneye | existing |
| 8880 | 127.0.0.1 (the opt-in tailnet overlay adds the same port on the tailnet IP, `CROW_TAILSCALE_IP`; unset → `127.0.0.1`) | kokoro-tts (local TTS) | existing |
| 8971 | 127.0.0.1 | frigate (authenticated UI) | existing |
| 9000 | 127.0.0.1 | minio (S3 API, existing; deprecated, superseded by garage 3900) | existing |
| 9001 | 127.0.0.1 | minio (console, existing) | existing |
| 9090 | 127.0.0.1 | linkding (existing) | existing |
| 9100 | CUDA host tailscale IP (`GRACKLE_TAILSCALE_IP`; unset → `127.0.0.1`; runs on the CUDA host, not the primary host) | vllm-cuda-embed | existing |
| 9101 | CUDA host tailscale IP (`GRACKLE_TAILSCALE_IP`; unset → `127.0.0.1`; runs on the CUDA host, not the primary host) | vllm-cuda-rerank | existing |
| 9102 | CUDA host tailscale IP (`GRACKLE_TAILSCALE_IP`; unset → `127.0.0.1`; runs on the CUDA host, not the primary host) | vllm-cuda-vision | existing |
| 11434 | 127.0.0.1 | ollama (existing) | existing |
| 13011 | 127.0.0.1 | (reserved on the satellite host: reverse ssh tunnel to the primary) | reserved (SAT) |
| 13378 | 127.0.0.1 | audiobookshelf (existing) | existing |
| 18018 | 127.0.0.1 | design-kit renderer SMOKE instance (`scripts/design-kit/smoke-renderer.sh`; transient, tests only, never left running) | Design kit v1 |
| 18100-18199 | gateway-internal loopback | native model servers (per-CROW_HOME dynamic range, not bundle ports — managed by servers/gateway/models/state.js) | informational |
| 19999 | 127.0.0.1 | netdata | MVP PR 2 |
| 32400 | host | plex (host networking, existing) | existing |

## Host-networked bundles (no 127.0.0.1 binding — uses host stack directly)

These bundles use `network_mode: host`. They consume whatever ports their upstream service expects directly on the host:

- `browser` (noVNC 6080 and the CDP relay 9222, both `127.0.0.1`; Chromium itself opens no port)
- `companion` (verify)
- `coturn` (3478 UDP, plus turnserver listen ports)
- `plex` (32400, plus discovery ports)
- `tailscale` (MagicDNS, peer connections)
- `crowdsec-firewall-bouncer` (deferred to PR 4.5 — upstream does not publish a Docker image; needs a custom Dockerfile and a tested unwind command verified on a throwaway host) — will need host network to manipulate iptables/nftables

## Process for amending this file

1. Pick an unallocated port in a sensible range (admin UIs in 3000-3099, backend APIs in 8000-8099, metrics in 19000-19999).
2. Add a row to the table with bundle name and PR/status.
3. CI port-collision check (the `static-checks` job in `.github/workflows/test.yml`) verifies your new port doesn't clash.
4. Reference this file in your bundle's PR description.

## Second host: box-b

Box-b (`box-b.example.ts.net`) is the second Strix Halo box. Its ports live in their own namespace. The first column is `box-b:<port>`, not a bare number, because `scripts/check-port-allocation.js` reads bare numbers in the first cell as **crow** allocations; rows starting `box-b:` are skipped. A box-b port is verified only by checking box-b itself (`ss -ltn`). Making the checker host-aware is follow-up work.

| port | bind | what | status |
|---|---|---|---|
| box-b:3009 | 127.0.0.1 | Crow gateway (user unit `crow-gateway.service`, `CROW_DISABLE_MODEL_ORCHESTRATION=1`); reached only through Tailscale Serve `box-b:8444` | planned |
| box-b:8444 | tailnet (Serve) | Tailscale Serve HTTPS → `127.0.0.1:3009` (fleet `:8444` convention; never Funnel) | planned |
| box-b:8030 | 0.0.0.0 (ufw: crow + the home server only) | halogen Flash-Next production (`flash-next.service`), an external engine Crow never manages | live |
| box-b:8031–8033 | 0.0.0.0 | two-box masters (window mode, pi-lab) | reserved |
| box-b:13305 | 127.0.0.1 | Lemonade server (`lemond`, installed but disabled since the 2026-09-24 NPU spike) | disabled |
| box-b:9000 | 127.0.0.1 | Lemonade websocket | disabled |
