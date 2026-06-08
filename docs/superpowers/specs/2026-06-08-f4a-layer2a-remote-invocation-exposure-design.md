# F4a Layer 2a — Remote Invocation Exposure + Enforcement

**Date:** 2026-06-08 · **Sub-project:** F4 → F4a → Layer 2 (cross-instance invocation) → **Layer 2a (exposure + enforcement substrate)** · **Repo:** `/home/kh0pp/crow`.

**Status:** SPEC ONLY. Build deferred to a fresh session (this session already shipped F3, the markdown viewer, and F4a Layer 1; deferring keeps build quality high). Predecessors: Layer 1 spec/plan `docs/superpowers/{specs,plans}/2026-06-08-f4a-federated-discovery*` (shipped + deployed `a05c6fa`). Master plan `~/.claude/plans/when-i-click-on-woolly-elephant.md`.

## Context: most of the invocation plumbing already exists

Cross-instance tool *invocation* is already partly built at the gateway level (verified anchors):
- `servers/gateway/proxy.js:554-701` — `loadRemoteInstances()` connects to peer instances over authenticated HTTP MCP (`StreamableHTTPClientTransport`, Bearer peer token) and discovers their tools.
- `servers/gateway/router.js:202-227` — `crow_tools` with an `instance_id` param already routes a tool call to a remote instance via `connectedServers...client.callTool()`.
- `servers/orchestrator/mcp-bridge.js:171-220` — already registers + invokes remote-instance tools namespaced `{instance}:{tool}`.
- `servers/gateway/routes/mcp.js:223-233` — the instance-auth bypass: a trusted peer (`req.instanceAuth.instance`) is synthesized auth with scope `mcp:tools`, letting it call the gateway's mounted MCP tools.
- `client.callTool({name, arguments})` is the reusable server-side execution primitive (router.js:228, tool-executor.js:262).
- Destructive tools are gated **in-tool** by single-use confirm-tokens (`servers/shared/confirm.js`; e.g. `crow_delete_memory` at `servers/memory/server.js:704`), which work cross-instance unchanged.

**The gap this layer closes:** today the instance-auth bypass grants a trusted peer access to **all** mounted tools (`mcp:tools` scope, no per-tool restriction). Layer 2a adds a **default-deny, operator-controlled exposure allowlist** enforced server-side, so a peer can invoke only the tools the owning instance has explicitly exposed. This makes remote invocation **safe** over the existing plumbing, and marks which tools are selectable for the pi-bot wiring (Layer 2b).

## Scope decision (locked with user, 2026-06-08)

- **Authorization model: per-instance exposure allowlist, default-deny.** An instance explicitly marks which capabilities are remotely-invocable; nothing is invocable by a peer until exposed.
- **Granularity: per-category/server** (matching Layer 1's catalog, which advertises one entry per category/bundle, not per individual tool). Exposing `crow-memory` makes all memory tools peer-invocable; destructive ones remain confirm-token-gated in-tool. Per-individual-tool exposure is a possible future tightening (noted, not built).

## Layer 2 decomposition

- **L2a (this spec):** exposure allowlist setting + catalog `exposed` flag + server-side enforcement gate. Makes remote invocation safe over the existing gateway invocation paths. No pi-bot changes.
- **L2b (next spec):** pi-bot wiring — flip Layer 1's read-only remote-tools group to selectable (only `exposed` ones), record remote selections in the bot def, mint the invocation path in `mcp_writer` (URL-to-peer `/router/mcp` vs a local stdio forward-proxy — decided then, after confirming `pi`'s MCP transport support), allowlist in the bridge.

## Non-goals (L2a)

- Pi-bot selection/invocation of remote tools (L2b).
- Per-individual-tool exposure granularity (category/server granularity only).
- Changing the confirm-token model (destructive tools stay in-tool gated; remote calls inherit it).
- Cross-instance bot edit/run (Layer 3 / F3b).

## Design

### 1. Exposure allowlist setting

A per-instance, **local-only (non-synced)** setting `remote_exposed_tools`: a JSON array of canonical capability ids (`"crow-memory"`, `"crow-projects"`, addon/bundle ids like `"texas-gov-data"`). **Default `[]` = deny all.** Stored in `dashboard_settings` and deliberately **absent from `sync-allowlist.js`** (each instance controls its own exposure, never replicated) — the same pattern as `feature_flags`.

Read/write via the existing `readSetting`/`writeSetting` (`settings/registry.js`). A tiny helper `getExposedCapabilities(db)` → `Set<canonicalId>` (parse + tolerate malformed → empty set).

### 2. Settings UI

A new section (or a card in the existing System group) listing this instance's capabilities (from Layer 1's `getLocalCatalog`) with a toggle per category/bundle: "Allow peers to invoke." Saving writes `remote_exposed_tools`. Default all-off, with a one-line caution that exposing a capability lets trusted peer instances run its tools on this instance (destructive tools still require their confirm-token). Local-only setting (per the scope override pattern; never synced).

### 3. Catalog `exposed` flag (Layer 1 extension)

Extend `toPublicTool` (`servers/gateway/capability-registry.js`) to add `exposed: boolean` — `canonicalId ∈ getExposedCapabilities(db)`. This requires `getLocalCatalog` to consult the exposure set when building tool entries. The advertised `/dashboard/capabilities` payload then carries `exposed` per tool, and the receive-side validator (`vTool` in `capabilities-cache.js`) must accept + preserve the boolean (extend the field set — keep producer↔validator parity, the invariant Layer 1 established). Peers' Bot Builders read this to know which remote tools are selectable (consumed in L2b).

### 4. Server-side enforcement gate (the security boundary)

The authoritative check, on the **executing** instance. When an MCP `tools/call` arrives from a **peer instance** (`req.instanceAuth?.instance` is set — i.e. not the local operator session), the call is allowed only if the called tool's owning capability `canonicalId ∈ remote_exposed_tools`; otherwise reject (JSON-RPC error) and audit. **Default-deny.** Local-operator calls are unaffected (this gate applies only to peer-instance callers).

**Where:** a gate at the MCP HTTP entry for the instance-auth path (`routes/mcp.js`, where `req.instanceAuth.instance` is recognized). It inspects the JSON-RPC body: if `method === "tools/call"`, resolve the called tool's `canonicalId` from (a) the mount prefix (`/memory/mcp` → `crow-memory`, `/projects/mcp` → `crow-projects`, etc.), or (b) for `/router/mcp` the category tool name (`crow_memory` → `crow-memory`), or (c) for addon endpoints the server id; then check membership. Non-`tools/call` MCP methods (`initialize`, `tools/list`) are allowed (discovery), but `tools/list` for a peer SHOULD be filtered to exposed tools so a peer can't even enumerate non-exposed tools (defense-in-depth; optional if it complicates — the hard gate is on `tools/call`).

**Audit:** reuse `auditCrossHostCall` / the existing inbound-call audit so every allowed/denied remote invocation is logged with the source instance + tool.

### 5. Components

| Unit | Responsibility | Reuses |
|---|---|---|
| `getExposedCapabilities(db)` | Read `remote_exposed_tools` → `Set` | readSetting |
| exposure Settings section | Operator toggles per-capability exposure | Layer 1 `getLocalCatalog`, settings registry |
| `toPublicTool` `exposed` flag + `vTool` parity | Advertise which remote tools are invocable | Layer 1 catalog + validator |
| MCP peer-call enforcement gate | Default-deny `tools/call` for peer callers | `req.instanceAuth`, routes/mcp.js, auditCrossHostCall |

## Testing & verification

No framework; `node:test` + isolated-DB/import checks (Layer 1 conventions).

1. **`tests/exposure-allowlist.test.js`** — `getExposedCapabilities` parses the setting → Set; malformed/absent → empty set (deny-all).
2. **`tests/capability-exposed-flag.test.js`** — `toPublicTool`/`getLocalCatalog` set `exposed:true` only for canonicalIds in the exposure set; `vTool` preserves the boolean (producer↔validator parity); a tool not exposed has `exposed:false`.
3. **`tests/peer-invocation-gate.test.js`** — the enforcement gate: a peer-instance `tools/call` for a non-exposed capability is rejected (default-deny) with an audit entry; an exposed capability passes; a local-operator call is unaffected; non-`tools/call` methods aren't blocked. Use a stub req with/without `req.instanceAuth.instance` and a stub exposure set.
4. **Invariant** — `node tests/auth-network.test.js` green; exposure setting confirmed **not** in `sync-allowlist.js`.

## Build order (for the deferred build session)

1. `getExposedCapabilities` helper + test.
2. `toPublicTool`/`getLocalCatalog` `exposed` flag + `vTool` parity + test (extends deployed Layer 1 — re-verify Layer 1 tests still pass).
3. Enforcement gate on the instance-auth MCP path + test (the security keystone — review hard).
4. Settings exposure section.
5. Invariant sweep.

## Conventions / safety

- Commit with explicit path args; verify `git show --stat HEAD`; never add Claude as co-author; branch off `main`; `git pull --rebase` before push.
- Exposure is **local-only**, never synced — each instance is sovereign over what it exposes.
- The enforcement gate is the trust boundary: server-side, default-deny, audited. UI filtering (the `exposed` flag) is a convenience, **not** the security boundary — the gate must enforce independently even if a peer crafts a raw call.
- Destructive tools keep their in-tool confirm-token gate (unchanged); remote calls inherit it.
- **Build-session resource note:** crow froze twice during the Layer 1 build from subagent fan-out on top of the always-on inference stack (`vllm`/`llama-server`/`crow-companion` Docker, ~62 GiB). Before heavy multi-agent execution, `docker stop` the model stack (`vllm-rocm-qwen35-4b llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed crow-companion faster-whisper-server kokoro-tts`) and `docker start` them after.
