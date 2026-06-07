# User-Facing Port Registry (Settings → System) — view-only v1

**Date:** 2026-06-07
**Status:** Design (v2, post adversarial review) — pending spec review → implementation plan
**Scope:** Sub-project #2 of 2. A **read-only** runtime view of host ports with address-aware conflict detection. Reassignment is explicitly deferred (see "Deferred").

> **v2 note:** v1 of this spec rested on a mis-survey of the bundle landscape (it claimed 42 port-parameterized bundles, that model bundles publish no host port and bind loopback, and that faster-whisper/embed `:8004` is a conflict). An adversarial review + direct inspection disproved all of those. This version corrects the facts and narrows v1 to view-only, which the user chose.

## Problem

Crow has only dev/CI-time port tracking (`scripts/check-port-allocation.js` + `docs/developers/port-allocation.md`). At runtime an operator can't see what is bound to which port, on which address, whether it's actually listening, or whether two things genuinely collide.

## Goals

1. A **read-only** dashboard view (Settings → System → Ports) listing every host port Crow can account for: which installed bundle declares it, the bind address, live up/down, and conflicts.
2. **Address-aware** attribution and conflict detection grounded in `ss` reality — no false positives from same-port-on-different-interfaces, and no flood from unrelated host listeners.

## Non-goals / explicitly deferred

- **Reassignment** (writing a bundle's `.env`, recreating the container, ufw). Deferred to a future iteration. Removing it also removes the CSRF-form, `--force-recreate`, and firewall concerns from v1.
- Auto-parameterizing hardcoded-port bundles.
- Merging `port-allocation.md` reserved/planned ports.

## Verified facts (from direct inspection — supersede the v1 spec)

- **Compose host-port forms in `bundles/*/docker-compose.yml`** (a mapping is `[BIND:]HOSTPORT:CONTAINER[/proto]`, and env vars can sit in *either* the bind or the host-port position):
  - Loopback + port-env: `"127.0.0.1:${KOLIBRI_HTTP_PORT:-8085}:8080"` (kolibri, ntfy, scratch-offline, vllm, maker-lab-advanced).
  - Both bind+port env: `"${FUNKWHALE_NGINX_BIND_ADDR:-127.0.0.1}:${FUNKWHALE_NGINX_BIND_PORT:-8600}:80"`.
  - Port-env, no bind (→ all interfaces): `"${NOMINATIM_PORT:-8088}:8080"`, `"${SDXL_PORT:-3005}:3005"`.
  - **Routable-IP-env + literal port:** `"${CROW_TAILSCALE_IP}:8003:8000"` — ~14 model bundles + minio (`${MINIO_BIND_ADDR:-127.0.0.1}:...`). The env var is the **bind address**, the port is **literal/fixed**.
  - Hardcoded loopback: `"127.0.0.1:8004:8000"` (faster-whisper).
  - Multi-port bundles: frigate (`8971`, `8554`, `8555/tcp`, `8555/udp`), minio (`9000`, `9001`).
- **Only 8** compose files have a port-position `${VAR:-default}` (the *potentially* reassignable set, were reassign in scope); of those, 5 bind loopback, funkwhale's bind is also env (defaults loopback), and nominatim/sdxl bind **all interfaces**. (Informs the deferred reassign work, not v1.)
- **`:8004` is not a conflict:** faster-whisper binds `127.0.0.1:8004`; llamacpp-vulkan-qwen3-embed binds `${CROW_TAILSCALE_IP}:8004`. Different addresses → they coexist. Conflict detection MUST be address-aware.
- **`ss -tlnH` returns ~40 listeners on crow**, mostly non-Crow host services (sshd `:22`, smbd `:445/:139`, CUPS `:631`, systemd-resolved `:53`, Tailscale `100.118.41.122:*`, VNC, adb, IPv6 mirrors). These are NOT conflicts; treating every unattributed listener as a conflict would paint the table red.
- `ss -tlnH` runs as the gateway user without root and emits `STATE Recv-Q Send-Q Local Peer` rows where `Local` is `addr:port` (incl. `[::]:8880`, `127.0.0.53%lo:53`).
- Settings sections live in `settings/sections/`, register via `registerSettingsSection`, export `{ id, group, icon, labelKey, navOrder, getPreview, render }`. `group:"system"` → System nav group. `t()` returns the key on miss (so a new label key is needed). `render` receives `{req,res,db,lang}`. (No POST/`handleAction`/CSRF needed in view-only v1.)
- `renderSettingsMenu` calls every visible section's `getPreview` on every settings-menu load — so `getPreview` must be cheap.

## Design

### 1. Placement & structure
- New section module `servers/gateway/dashboard/settings/sections/ports.js`, `group:"system"`, registered in `panels/settings.js`. **Read-only** (no `handleAction`).
- New backend `servers/gateway/port-inventory.js` — pure, unit-tested parsers + attribution/conflict; plus thin host wiring (`listInstalledBundles`, `readListeners`, `buildPortInventory`). No mutation code in v1.

### 2. Parser (`parseComposeHostPorts`, returns an array)
Parse **every** entry under a service's `ports:` block (multi-port bundles return multiple). For each mapping `[BIND:]HOSTPORT:CONTAINER[/proto]`:
- Tokenize on `:` while treating `${...}` as opaque (env defaults contain `:`), then take CONTAINER = last segment, HOSTPORT = second-to-last, BIND = first of three (else unspecified).
- Classify HOSTPORT: literal number → `{port:N, portEnvVar:null}`; `${VAR:-N}` → `{port:N, portEnvVar:VAR}`; `${VAR}` (no default) → `{port:null, portEnvVar:VAR}`.
- Classify BIND: literal `127.0.0.1`/`0.0.0.0`/IP → that string; `${VAR:-127.0.0.1}` → its default; `${VAR}` (e.g. `${CROW_TAILSCALE_IP}`) → a **template marker** `{ bindTemplate:"CROW_TAILSCALE_IP" }` (a distinct, non-loopback address identity); absent → `"0.0.0.0"` (all interfaces).
- Capture `proto` (`tcp` default).
Row per mapping: `{ port, portEnvVar, bind, bindKind: "loopback"|"all"|"specific"|"template", proto }`.

### 3. Inventory (`buildPortInventory`)
- `listInstalledBundles()` reads `~/.crow/installed.json`, and for each id reads `~/.crow/bundles/<id>/docker-compose.yml` (→ all declared port rows) and `manifest.json` (→ name; manifest `port` only used as a fallback for bundles that publish nothing). Produces declared endpoints `{ bundleId, bundleName, port, bind, bindKind, portEnvVar, proto, source:"compose"|"manifest" }`.
- `readListeners()` runs `ss -tlnH` → `[{port, boundAddr, proto?}]`.
- `attributeAndDetect(endpoints, listeners, coreSet)` → rows.

### 4. Attribution & conflict (address-aware)
Row per distinct **(port)** with the endpoints/listeners that touch it:
- **Status:** a declared endpoint is `up` if `ss` shows any listener on its port (and, when the endpoint bind is a specific literal, the bound addr matches or is `0.0.0.0`); else `down`.
- **kind:** `parameterized` (compose port-env), `hardcoded` (compose literal port), `managed` (manifest-only `port`, no compose publish — now rare), `core` (gateway `:3001`), `foreign` (a listener with no Crow declaration).
- **Conflict** is flagged ONLY when binds actually overlap:
  - (a) two installed bundles declare the same `port`+`proto` with **overlapping binds** — same specific addr, or either binds `all`. Different specific/template addrs (the `:8004` case) → **no conflict**.
  - (b) a Crow-declared `port` is also held by a `foreign` listener on an overlapping addr.
  - A `foreign` listener that collides with nothing Crow declares is **informational, not a conflict.**
- Swap-group model bundles that share a literal port on the same template bind (e.g. several `${CROW_TAILSCALE_IP}:8003`) are mutexed by design and are **not** flagged (they never run simultaneously); represent them as a single attributed row listing the members, kind `managed`-like, no conflict.

### 5. UI (`ports.js` render — read-only)
- Two parts: a **Crow ports** table (declared + attributed), and a compact **Other listeners** disclosure (foreign, non-conflicting) so the host's other services are visible without cluttering/red-flagging.
- Columns: Port · App/Service · Bind · Status (● up / ○ down / ⚠ conflict-with-reason) · Type.
- `getPreview` returns a **cheap** summary using a short in-process TTL cache (e.g. 15 s) over `buildPortInventory`, so repeated settings-menu loads don't re-spawn `ss` + re-read every bundle each time. On cache miss in `getPreview`, return a static label and let `render` populate.
- All values `escapeHtml`'d.

### 6. Testing
- `tests/port-inventory.test.js` (`node:test`), pure functions:
  - `parseComposeHostPorts`: loopback+port-env; bind-env+port-env (funkwhale); routable-IP-env + literal port (`${CROW_TAILSCALE_IP}:8003:8000` → port 8003 literal, bind template, NOT port-env); no-bind port-env (→ all); hardcoded loopback; bare `host:container`; `8555:8555/udp` (proto); multi-port (frigate → array of 4); host-network/none → `[]`.
  - `attributeAndDetect`: parameterized up/down; **same port different specific binds → NOT a conflict** (the `:8004` case); two bundles same port + one binds all → conflict; swap-group same-template-port managed → not conflict; core shown+locked; foreign-only listener → informational, `conflict:false`; foreign colliding with a declared port → conflict.
- Manual on crow: Settings → System → Ports renders; the real `:8004` rows show faster-whisper (127.0.0.1) and the model bundle (tailscale) as **separate, non-conflicting**; host services appear under "Other listeners", not as conflicts; gateway `:3001` shown as core.

## Files
- **New:** `servers/gateway/dashboard/settings/sections/ports.js`, `servers/gateway/port-inventory.js`, `tests/port-inventory.test.js`, this doc + the plan.
- **Modify:** `servers/gateway/dashboard/panels/settings.js` (register section), `servers/gateway/dashboard/shared/i18n.js` (label key).
- **Reuse:** `~/.crow/installed.json` + `~/.crow/bundles/<id>` layout, settings section/i18n/components helpers.

## Deferred (future iteration)
- **Reassignment** for the (≤8) loopback port-env bundles: write the port env var to the bundle `.env`, `docker compose up -d --force-recreate`, CSRF-protected form, and (for any non-loopback target) a ufw rule move. Address-aware validation reused from v1's conflict logic.
- Correcting `scripts/check-port-allocation.js`, which also fails to parse `${IP}:port` mappings (separate cleanup).
- A "fix conflict" suggestion that proposes a free port.
