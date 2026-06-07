# User-Facing Port Registry (Settings → System)

**Date:** 2026-06-07
**Status:** Design approved; pending spec review → implementation plan
**Scope:** Sub-project #2 of 2 (follows the AI-model-extensions work). A runtime, user-facing view of host ports with reassignment for env-parameterized bundles.

## Problem

Crow has only *dev/CI-time* port tracking: `scripts/check-port-allocation.js` + `.github/workflows/port-allocation.yml` enforce that every published host port in `bundles/**/docker-compose.yml` is unique and documented in `docs/developers/port-allocation.md`. At runtime, a Crow operator has no way to see what app is on what port, no conflict visibility (e.g. the `faster-whisper-server` / `llamacpp-vulkan-qwen3-embed` `:8004` clash), and no way to move an app to a different port without hand-editing compose/.env and recreating the container.

## Goals

1. A dashboard view (Settings → System) listing every known host port: which installed bundle owns it, live up/down status, bound address, and any conflict.
2. **Reassign** a bundle's host port from the UI for the bundles that already parameterize their port via env var (42 of them), with server-side conflict validation.
3. Surface real conflicts grounded in OS reality (`ss`), not just declared values.

## Non-goals / out of scope

- **Auto-parameterizing the 20 hardcoded-port bundles** (rewriting their `docker-compose.yml` to use an env var). They render read-only with a reason. A later enhancement could add on-demand parameterizing.
- **Reassigning host-networked bundles** (3) or core Crow services (gateway `:3001`) — shown but locked.
- **Reserved/planned ports** from `port-allocation.md` — not merged into the runtime view in v1 (the "full map" option was declined).
- Changing the existing CI check or `port-allocation.md` workflow.

## Verified facts (basis for the design)

- Of the bundle compose files: **42 parameterize the host port via env var** (`"127.0.0.1:${KOLIBRI_HTTP_PORT:-8085}:8080"`), **20 hardcode** it, **3 host-network**, **8 publish no host port**.
- The install flow already writes a per-bundle `.env` and uses a managed-block writer (`appendManagedBlock`, `bundles.js`), opens/closes ufw ports best-effort (loopback bundles still work without sudo), and exposes `/bundles/api/status` (`docker compose ps`) for up/down.
- `ss -tlnH` runs as the gateway user **without root** and lists every listening `addr:port` (process names would need root, but we attribute ownership via declared ports, so they are not needed).
- `settings.js` is a thin orchestrator that registers self-contained section modules from `settings/sections/` via `registerSettingsSection(...)`. A section exports `{ id, group, icon, labelKey, navOrder, getPreview(), render() }` plus a POST action path. `group: "system"` places it in the existing "System" nav group.
- All bundle host ports bind `127.0.0.1` per the port-allocation conventions (relevant to the ufw best-effort path).

## Design

### 1. Placement & structure
- New section module `servers/gateway/dashboard/settings/sections/ports.js`, `group: "system"`, registered in `servers/gateway/dashboard/panels/settings.js` next to the other `registerSettingsSection(...)` calls.
- New backend helper `servers/gateway/port-inventory.js` — builds the port table and holds the pure, unit-testable parsers; the section module renders its output and dispatches reassign actions to it. Keeps `ports.js` focused on presentation and `port-inventory.js` on data + mutation.

### 2. Port inventory (`port-inventory.js`)
`buildPortInventory()` merges three sources into one row per port:
- **Declared (installed bundles only):** for each installed bundle, parse its `docker-compose.yml` host-port line with the same regex `check-port-allocation.js` uses; additionally capture the **env-var name + default** when the host port is `${VAR:-default}` (this is what marks a bundle reassignable). Also read the manifest `port`.
- **Live status:** reuse `/bundles/api/status` (`docker compose ps`) for per-bundle up/down (`running` may be `null` for containerless members — treat as "n/a").
- **OS listeners:** parse `ss -tlnH` → set of `{ port, boundAddr, listening:true }`.

Row shape:
```
{ port, bundleId|null, bundleName|null, envVar|null, defaultPort|null,
  reassignable: bool,
  kind: "parameterized"|"hardcoded"|"host-network"|"managed"|"core"|"foreign",
  listening: bool, boundAddr|null, status: "up"|"down"|"na"|"unknown" }
```

**Published host port vs service port — the key distinction.** A *published host port* actually binds the host and comes from the compose `ports:` mapping. A *service port* is the manifest `port` an orchestrator-managed bundle listens on **without** a compose host-port publish (the `vllm-rocm-*` / `llamacpp-*` model bundles — several deliberately share `:8003` via the `crow-strix-vram` swap-group mutex). Conflict logic must not treat these the same.

**Attribution** for each port (first match wins):
1. An installed bundle's **published compose host port** → that bundle (`kind` = `parameterized` if it has an env var, else `hardcoded`); host-networked bundles → `host-network`.
2. Else an installed bundle's **manifest `port`** with no compose publish → `kind: "managed"` (orchestrator-routed model server). Multiple bundles legitimately mapping to the same service port (swap group) are recorded as such, NOT as a conflict.
3. Else a known **core Crow service** (gateway `:3001`, and any other documented core listeners) → `kind: "core"`.
4. Else → `kind: "foreign"` (a listener Crow can't attribute).

**Conflict detection** flags a row when:
- (a) two installed bundles publish the **same compose host port** (true host-bind clash — e.g. the `:8004` faster-whisper/embed case once both are installed), or
- (b) a `listening` port resolves to `kind: "foreign"` (something outside Crow is squatting a port).
Shared *service* ports among swap-group `managed` bundles are explicitly **not** conflicts.

Pure functions to export & unit-test: `parseComposeHostPort(text) → {port, envVar, default}|null` (returns null for host-network / no-publish), `parseSsListeners(text) → [{port, boundAddr}]`, `attributeAndDetect(bundles, listeners, coreSet) → rows` (covers attribution + conflict rules above).

### 3. Reassign flow
Exposed as a POST action on the ports section (following the existing settings-section POST convention). Input: `{ bundleId, newPort }`. Steps in `port-inventory.js#reassignPort`:
1. **Guard:** the bundle must be installed and `reassignable` (kind `parameterized`). Reject otherwise.
2. **Validate `newPort`:** integer in 1024–65535; not equal to another installed bundle's declared host port; not currently in `ss` listeners (re-read `ss` at action time, authoritative). On failure return a clear error to the UI; make no changes.
3. **Write** `<envVar>=<newPort>` into the bundle's `.env` via the existing managed-block writer (idempotent; replaces any prior value).
4. **Recreate:** `docker compose up -d` for that bundle's compose (single-bundle, brief interruption). Capture failure and report it; do not proceed to firewall on failure.
5. **Firewall (best-effort):** close the old host port and open `newPort` on the relevant ufw interfaces, reusing the `bundles.js` ufw path. If sudo/ufw is unavailable, succeed anyway with a warning (all bundle ports are loopback).
6. **Persist** the new port to the installed-bundle record so the inventory reflects it and it survives restarts.
Concurrency: serialize reassigns per bundle; the step-2 re-read guards against races.

### 4. UI (`ports.js` render)
- `getPreview()` → e.g. `"37 ports · 1 conflict"`.
- A table: **Port · App/Service · Status · Bound address · Action**, sorted by port number. Status cell: ● up / ○ down / ⚠ conflict (with the reason as a tooltip).
- Reassignable rows: inline "Change…" control (a number input + confirm button) that POSTs `{bundleId, newPort}`; includes a short "this briefly restarts <bundle>" note.
- Non-reassignable rows: muted reason ("hardcoded port", "host-networked", "core service", "foreign listener").
- All interpolated values `escapeHtml`'d. Port validation is server-side and authoritative regardless of any client-side check.

### 5. Safety & edge cases
- **Locked:** gateway `:3001` and other core Crow services render as `kind: "core"` — shown, never reassignable.
- **Authoritative re-check:** validation re-reads `ss` and declared ports at action time, not from the cached table.
- **ufw best-effort:** mirrors install behavior; loopback bundles work without sudo, with a surfaced warning.
- **Containerless members** (`running: null`) display status "n/a" and are not reassignable via this flow.
- This section is the surfacing point for the deferred `:8004` faster-whisper/embed conflict (it appears as a same-port conflict once both are installed).

### 6. Testing
- `node:test` unit tests in `tests/port-inventory.test.js`:
  - `parseComposeHostPort`: parameterized (`${VAR:-8085}` → port 8085, envVar VAR), hardcoded (`127.0.0.1:8004:8000` → port 8004, no envVar), host-network / no-port → null.
  - `parseSsListeners`: fixture of real `ss -tlnH` output → correct `{port, boundAddr}` set.
  - `attributeAndDetect`: two bundles publishing the same compose host port → both flagged conflict; a listener attributable to a core service → `kind:"core"`, no conflict; an unattributable listener → `kind:"foreign"` + conflict; two `managed` bundles sharing a manifest service port (swap group) → both `kind:"managed"`, NOT flagged; clean set → no conflicts.
  - `reassignPort` validation: out-of-range / already-declared / already-listening all rejected with no side effects (inject the `ss`/declared inputs).
- Manual on crow: gateway boots; Settings → System → Ports renders the real table with live status; a dry-run reassign on a safe test bundle (e.g. a parameterized, low-stakes one) moves the port, recreates the container, and the table reflects the new port; attempting to reassign onto an in-use port is rejected.

## Files
- **New:** `servers/gateway/dashboard/settings/sections/ports.js`, `servers/gateway/port-inventory.js`, `tests/port-inventory.test.js`, this design doc + the plan.
- **Modify:** `servers/gateway/dashboard/panels/settings.js` (import + `registerSettingsSection(portsSection)`).
- **Reuse (unchanged):** `/bundles/api/status`, the `bundles.js` managed-block `.env` writer + ufw path + installed-bundle record, the compose host-port regex from `check-port-allocation.js`, settings section/i18n/components helpers.

## Open follow-ups (not v1)
- On-demand parameterizing of the 20 hardcoded-port bundles so they become reassignable.
- Optionally merge `port-allocation.md` reserved/planned ports into the view as a "reserved" layer.
- A "fix conflict" shortcut that proposes a free port for a conflicted reassignable bundle.
