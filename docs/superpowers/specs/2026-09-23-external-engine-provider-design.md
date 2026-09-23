# External-engine provider kind (design, 2026-09-23)

Strix Halo track, sub-project 4. Sources:
- the decision doc (Gitea `backlog/2026-09-22-strix-halo-profile-and-external-engines.md`): halogen is a stopgap that Crow manages **as an external engine** on raven;
- the two-host spec, PR #344 (§3.1, §3.3, §7): "Crow's side should treat this row as an externally managed engine on a dedicated host".

Autonomous cycle: the **(D#)** decisions below are mine, made under Kevin's standing grant.

## 1. Where things stand (main @ 7c9344dc)

- **The rows.** `raven-flash-next` and `raven-halogen-smoke` exist on crow and r4 with `host='cloud'`, no `bundle_id`, no `gpu_policy.runtime` and a LAN `base_url` (`http://10.0.0.126:8030/v1`). They replicate to every paired peer.
- **"Never spawned" is incidental.** Crow never starts, warms or evicts them, but only because they carry no bundle and no native runtime (`maybeAcquireLocalProvider` returns null at `gpu-orchestrator.js:584`). A later edit adding `bundleId` or `runtime:"native"`, or a local bundle sharing the base_url, would make them warmable. Nothing records "externally managed by raven".
- **No continuous health.** `provider-health.js` and the nest `providersSignal` track only locally owned `alwaysResident` bundle/native rows. raven is probed only when someone opens the Settings > LLM Health tab or the bot model picker. There is no outage clock and no warning.
- **The Providers tab** shows a "network" host badge (display only, `provider-host.js:87`). Its status dot reflects enabled/disabled, not reachability.

## 2. Design

### 2.1 The marker (D1)

A provider row is an **external engine** when
`gpu_policy.engine = { managed: "external", host: "<label>", label?: "<engine name>" }`:

- `managed` is exactly `"external"`, and is the only value defined.
- `host` is a short free-text label for the machine that runs it (`"raven"`). It is display and documentation only, never used for routing. `providers.host` stays `cloud`, following PR #382: an unmanaged LAN endpoint is `cloud` and displays as "network".
- `label` is an optional engine name (`"halogen"`).

`gpu_policy` already replicates, so the marker travels with the row, which is what we want: every instance should know it must never manage it.

**Helper:** `isExternalEngine(p)` in `servers/shared/provider-engine.js`. It is pure, has no imports, and returns `p?.gpuPolicy?.engine?.managed === "external"`.

### 2.2 Never orchestrated (D2)

Every orchestrator path treats an external engine as not orchestratable here, **before** any other check:

- `maybeAcquireLocalProvider` returns `null`, the same "not mine to manage" outcome a cloud row gets today;
- `acquireProvider` throws a typed `ExternalEngineError` (`code "external_engine"`);
- `resolveWarmableProviderName` returns `null`;
- `ensureResident` skips it, logging once;
- `getMutexSiblings` / sibling eviction never includes it;
- idle-revert never reverts to it;
- it is never "always resident" (`isAlwaysResident` is false for it), so it never enters the boot/deferred residency sets;
- the legacy `servers/shared/lifecycle.js` `ensureModelWarm` refuses it and `releaseModel` is a no-op for it.

**Validation (transition-only; revised after review round 1).** `upsertProvider` rejects a write only when it **changes** `gpu_policy.engine`, `bundleId` or `gpu_policy.runtime` relative to the stored row **and** the resulting row is invalid. Invalid means one of three things:
- a malformed marker (`EXTERNAL_ENGINE_INVALID`);
- a marker combined with a `bundleId` or `runtime: "native"` (`EXTERNAL_ENGINE_CONFLICT`);
- a marked row converted in one step into an orchestratable one (`EXTERNAL_ENGINE_CONFLICT`: unmark first).

A malformed incoming `gpu_policy` JSON string is rejected as invalid, not read as "keep the stored policy".

A write that leaves those three fields as stored always passes, even if the stored row is contradictory. Replication writes rows directly, never through `upsertProvider`, so a contradictory or malformed row can arrive from a peer. Today's re-enable, host-repair and reconciler writes must keep working on such a row.

The models.json reconciler also changes in two ways:
- It keeps a stored `engine` when it re-asserts a row's `gpu_policy`.
- It isolates each row in its own try/catch, so one refused row cannot abort the pass.

### 2.3 Continuous read-only health (D3)

- A new tick, `pollExternalEngines`, arms next to the residency poll with its own interval. It defaults to 60 s and is set by `CROW_EXTERNAL_ENGINE_POLL_MS`.
- Each tick, for every enabled external-engine row, it sends `GET <base_url>/models`: no auth header, a 3 s timeout, and HTTP 2xx means ready. It records the result in `provider-health` under a new, separate map `external`: `{ baseUrl, engineHost, label, ready, firstSeenAt, lastReadyAt, lastError, checkedAt }`.
- **Rows that disappear or are disabled** are pruned from the map.
- **Only a DB-sourced config counts (review round 1).** `loadProviders()` falls back to models.json when its cache is empty or the DB read fails, and that fallback carries no markers. A tick probes and prunes only when `cfg._source === "db:providers"`; any other tick is a no-op. Otherwise, a tick after `invalidateProvidersCache()` would wipe every clock.
- **Read-only.** A GET on `/models` changes nothing on the engine. The probe never retries within a tick and never reacts to a result.
- **Per instance, by construction.** Each instance probes from its own network position. A peer the firewall blocks (black-swan off-LAN) reports its own truth: the engine is unreachable from there. A peer on a different LAN could even reach a different device at the same private IP. That is harmless, because the result is info-only and the probe is a GET on `/models`. The two-host spec §7 already chose the firewall, not sync filtering, as the fix for reachability, and this design does not change sync.

### 2.4 Surfacing (D4)

- **The nest `providersSignal`** gains the external engines, at severity **info only, never warn** (revised after review round 1):
  - `"<label> on <host>: up"`;
  - `"down for <age> (externally managed)"` for an engine that answered at least once in this process;
  - `"not reachable from this instance"` for one that never answered.

  **Why info and not warn:**
  - A nest warn becomes a high-priority push through the health monitor.
  - These engines are operated from outside Crow: raven's production windows stop halogen for hours by design, so every window would page the operator for something they did on purpose.
  - Crow can do nothing about it (D5: no route-away).

  The resident-model warn path is byte-identical to before. When it fires, it is the signal's one issue.
- **The Providers tab** status dot for an external-engine row uses the health state: up, down, or not probed yet. The row also gets an "external · <host>" badge.
- **`GET /api/providers/health`** is unchanged. The Health tab's on-demand matrix already probes everything.
- **i18n:** every new string in both `en` and `es`.

### 2.5 No route-away, no sync change (D5)

- The llm-router and chat do not consult external-engine health. A down engine returns a connection error quickly, and falling back silently to another model is a product decision this sub-project does not make.
- Sync is untouched: the reachability fix stays the firewall's job, per the two-host spec §7.

### 2.6 Rollout (D6)

- Code ships first. After deploy, no row carries the marker, so nothing new is probed.
- **pi-lab cleared the probe (Question A, answered 2026-09-23 ~14:30):** "fine at any time, windows included", because a GET against a stopped service costs nothing.
- Right after deploy, mark **only `raven-flash-next`** (`http://10.0.0.126:8030/v1`, which answered 200 on 2026-09-23) on crow through the normal provider-update path (`engine: {managed:"external", host:"raven", label:"halogen"}`). The marker then replicates, and each instance starts its own 60 s read-only probe.
- `raven-halogen-smoke` points at `:8731`, which is dead, so it is **not** marked. That row is raised with Kevin separately.

## 3. Out of scope

- Remote lifecycle (starting, stopping or restarting halogen). The two-host spec §3.3 puts it in the window script over ssh.
- Route-away or fallback when an engine is down.
- Filtering sync by per-peer reachability.
- Authentication to the engine. halogen has none, and the ufw scope carries that weight.

## 4. Testing

- `isExternalEngine` truth table.
- **Orchestrator** (native harness seams), for a marked row:
  - `maybeAcquireLocalProvider` → `null`, and nothing spawns;
  - `acquireProvider` throws `ExternalEngineError`;
  - `resolveWarmableProviderName` → `null`;
  - `ensureResident` skips it, logging once;
  - a sibling with a shared `mutexGroup` is never stopped for it;
  - idle-revert never targets it.
- **Validation:** a write that newly introduces marker + `bundleId` or marker + native runtime is rejected. A write that leaves the stored engine, bundle and runtime unchanged passes even on a contradictory row seeded directly (re-enable, host repair, reconciler). The reconciler keeps a stored `engine`.
- **Poll source gate:** a non-DB config never probes or prunes.
- **`pollExternalEngines`** with an injected fetch and clock:
  - 2xx → ready; a non-2xx or throw → not-ready with `lastError`;
  - pruning on disable and removal;
  - no auth header is sent;
  - the timeout is honoured.
- **`provider-health`:** `external` map semantics, first-seen and last-ready clocks.
- **Nest signal:** external engines are info only, never warn, including one that was ready once and has been down for hours; the copy names the host; the resident-model warn is unchanged; es parity.
- **Providers tab:** the dot reflects external health; the badge renders.
