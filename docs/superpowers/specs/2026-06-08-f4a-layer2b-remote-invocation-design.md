# F4a Layer 2b — Cross-instance Tool Invocation (pi-bots)

**Date:** 2026-06-08 · **Sub-project:** F4 → F4a → Layer 2 (cross-instance invocation) → **Layer 2b (pi-bot wiring)** · **Repo:** `/home/kh0pp/crow` · branch `feat/f4a-layer2b-remote-invocation` (off `main`).

**Status:** APPROVED — ready to turn into an implementation plan. Predecessor L2a (exposure allowlist + server-side enforcement gate) is **built, merged, and deployed fleet-wide** (`main`@`8584f64`; spec `docs/superpowers/specs/2026-06-08-f4a-layer2a-remote-invocation-exposure-design.md`). Master plan `~/.claude/plans/when-i-click-on-woolly-elephant.md`.

## Goal

Let a pi-bot on instance X actually **call** a tool whose MCP server lives on a trusted peer Y — restricted to the capabilities Y has exposed (enforced by L2a's server-side gate on Y) — and surface that selection in the Bot Builder. This flips Layer 1's read-only remote-tools group to **selectable**. Gated behind a feature flag, **off by default**, so the live MPA pi-bots are untouched until an operator opts in.

## Context: what already exists (verified anchors)

- **L2a enforcement gate (the security backstop):** `servers/gateway/peer-exposure.js` — a peer `tools/call` is allowed only if the called tool's owning `canonicalId ∈ remote_exposed_tools` on the *executing* instance; default-deny; audited. Wired into `routes/mcp.js` `skipAuthForInstance` for all 10 authed MCP mounts. **This is the trust boundary; L2b's forward-proxy is a dumb pipe that inherits it.**
- **Catalog `exposed` flag (L2a):** `toPublicTool`/`getLocalCatalog` (`capability-registry.js`) emit `exposed:boolean` per tool; `vTool` (`capabilities-cache.js`) preserves it across the mesh. Peers' Bot Builders read this to know which remote capabilities are selectable.
- **Peer MCP client + auth:** `servers/gateway/proxy.js` `loadRemoteInstances()` (`:554-701`) connects to a peer via `StreamableHTTPClientTransport` at `${inst.gateway_url}/<mount>/mcp` with `Authorization: Bearer <creds.auth_token>`, where the token comes from the **`peer-tokens.json`** store (`creds.auth_token`). Peer `gateway_url` lives in the local `crow_instances` table (`status != 'revoked' AND gateway_url IS NOT NULL`). This exact client pattern is what the forward-proxy reuses.
- **Per-bot MCP config writer:** `scripts/pi-bots/mcp_writer.mjs` — pi reads `~/.pi/agent/mcp.json` (homedir-wins) merged with the cwd `<session_dir>/.mcp.json`. `writeBotMcp(def, opts)` mints the per-bot `.mcp.json`; `serversForBot(def)` reads `def.tools.crow_mcp` (`"server/tool"` → server). **All canonical blocks are stdio** (`{command,args,cwd,env}` — e.g. `node servers/memory/index.js`); pi's core ships no MCP SDK and no HTTP/streamable transport, so **stdio is the only proven transport** (this is why L2b uses a local stdio forward-proxy, not a URL-to-peer HTTP block — decision locked 2026-06-08).
- **Bridge tool allowlist:** `scripts/pi-bots/bridge.mjs:54` builds `--tools` as `("mcp__" + s.replace("/","__"))` over `def.tools.crow_mcp`, joined with builtins. pi's `--tools` filters built-in, extension, and MCP tools (bridge.mjs:74-81 cites `dist/cli/args.js`).
- **Feature flags:** `feature_flags` settings object with a `readFeatureFlag(db, name)` helper (used in `llm/profiles-tab.js`, `ai/smart-router.js` for `feature_flags.smart_chat`, `bot_runtime`). Local-only (per-instance) setting.
- **Layer 1 Bot Builder remote group:** `bot-builder.js` renders a collapsed read-only "Available on N peer instance(s)" group from `gatherPeerTools(db)` (peer catalogs via `capabilities-cache`). This is what L2b makes selectable.

## Scope decision (locked with user, 2026-06-08)

- **Architecture: dedicated local stdio forward-proxy** (`crow-remote-proxy.mjs`). pi spawns it stdio (its only proven transport); it bridges to the peer over authenticated HTTP MCP. Reuses `loadRemoteInstances`' client + the `peer-tokens.json` Bearer token. Rejected alternatives: URL-to-peer HTTP block (pi HTTP-transport support unverified, pushes auth into pi); routing through the local gateway's `crow_tools instance_id` (still needs a stdio↔HTTP bridge, exposes action-dispatch not real tool names).
- **Granularity: per-capability** (matches L2a exposure + the Layer 1 catalog, which advertises one entry per capability). Selecting "Memory @ grackle" gives the bot grackle's memory tools.
- **Core capabilities only this slice:** the five with dedicated mounts — `crow-memory`→`/memory`, `crow-projects`→`/projects`, `crow-sharing`→`/sharing`, `crow-storage`→`/storage`, `crow-blog`→`/blog-mcp`. **Remote addon/bundle invocation is deferred** (those route through the peer's `/tools` proxy aggregator and need per-tool canonicalId resolution) — `mcp_writer` skips a non-core remote selection with a warning.
- **Rollout: flag-gated slice, off by default.** `feature_flags.remote_invocation` (local-only). Flag off → byte-identical behavior to today (Layer 1 read-only, no remote blocks minted). Acceptance = one verified crow→grackle tool call end-to-end after deploy.

## Non-goals (L2b)

- Remote **addon/bundle** invocation (core-mount capabilities only this slice).
- Per-individual-tool remote selection (per-capability only).
- Cross-instance bot **edit or run** (Layer 3 / F3b).
- Changing the L2a exposure model or the confirm-token model (destructive remote tools still hit the peer's in-tool confirm gate, unchanged).
- Auto-discovery/auto-selection of remote tools — selection stays an explicit operator action in the Bot Builder.

## Design

### 1. Feature flag (the master gate)

`feature_flags.remote_invocation` — local-only, default **off**. A single helper `remoteInvocationEnabled(db)` (thin wrapper over `readFeatureFlag(db, "remote_invocation")`) is consulted in exactly three places: the Bot Builder (makes the remote group selectable), `mcp_writer` (mints forward-proxy blocks), and the bridge (adds remote entries to `--tools`). Off ⇒ all three are inert; a bot def that already carries `remote_mcp` selections produces **no** remote blocks and **no** allowlist entries — its generated `.mcp.json` and `--tools` are identical to pre-L2b. A small Settings toggle (Multi-Instance group, mirroring `unified-dashboard.js`) flips it; reuses the L2a-adjacent settings-section pattern.

### 2. Bot-def schema

Add `def.tools.remote_mcp: ["<instanceId>::<canonicalId>", …]` — a flat array of per-capability remote selections (peer instance id + the capability's canonicalId, `::`-joined). Kept **separate** from the local `def.tools.crow_mcp` so the existing local writer/allowlist paths are untouched. The Layer 1 catalog already carries the `(instance, canonicalId, exposed)` triples the UI needs to build these entries.

### 3. `crow-remote-proxy.mjs` (the forward-proxy)

A standalone stdio MCP server in `scripts/pi-bots/`, started by pi like any other stdio block. Configuration via env (set in the minted block):
- `CROW_REMOTE_INSTANCE_ID` — the peer's instance id (for token lookup + audit/log labeling).
- `CROW_REMOTE_GATEWAY_URL` — the peer's `gateway_url`.
- `CROW_REMOTE_MOUNT` — the capability's mount path (e.g. `/memory`).

On startup it resolves the **Bearer peer token** from `peer-tokens.json` (same store `loadRemoteInstances` reads — keyed by instance id), opens a `StreamableHTTPClientTransport` to `${CROW_REMOTE_GATEWAY_URL}${CROW_REMOTE_MOUNT}/mcp` with `Authorization: Bearer <token>`, and exposes a **verbatim passthrough**: its own `tools/list` returns the peer mount's tools (just that capability's tools, since we connect to a single mount); its `tools/call` forwards to the peer client and returns the result/error unchanged. The token is **never written into the bot's `.mcp.json`** — resolved at runtime by id (matches `loadRemoteInstances`; the written block carries only the id/url/mount). The peer's L2a gate is the authoritative allow/deny; the proxy adds no policy of its own. Built dependency-free where practical, reusing the MCP SDK already vendored for the gateway.

### 4. `mcp_writer.mjs` extension

- **Mount map (core-only):** `REMOTE_CANON_MOUNT = { "crow-memory":"/memory", "crow-projects":"/projects", "crow-sharing":"/sharing", "crow-storage":"/storage", "crow-blog":"/blog-mcp" }`.
- `remoteServersForBot(def)` → parse `def.tools.remote_mcp` into `[{ instanceId, canonicalId }]` (tolerate malformed entries).
- `mintRemoteBlocks(def, db, { enabled })` → for each remote selection, when `enabled`: look up the peer `gateway_url` from `crow_instances` (skip + warn if the peer is unknown/revoked or has no `gateway_url`); skip + warn if `canonicalId` is not in `REMOTE_CANON_MOUNT` (addon — deferred); else mint a stdio block keyed `crow-remote-<instanceId8>-<canonicalId>` (hyphens only — keeps pi's `mcp__<server>__<tool>` delimiter unambiguous) with `command:<node>`, `args:[<abs path to crow-remote-proxy.mjs>]`, and the three `CROW_REMOTE_*` env vars. Returns `{ blocks, warnings }`.
- `writeBotMcp` merges these remote blocks into the per-bot `.mcp.json` **only when `remoteInvocationEnabled(db)`** — flag off ⇒ `mintRemoteBlocks` returns nothing. Remote blocks never collide with canonical names (the `crow-remote-` prefix is reserved) and never touch crow.db, so the journal guard is N/A.

### 5. Bridge allowlist (`bridge.mjs`)

`toolAllowlist(def)` gains, **when `remoteInvocationEnabled(db)`**, a server-level entry per remote selection: `mcp__crow-remote-<instanceId8>-<canonicalId>` (no tool suffix = all of that capability's tools — matching per-capability granularity; the peer's L2a gate is the real per-call check). Flag off ⇒ no remote entries, `--tools` identical to today. (Plan must confirm pi's `--tools mcp__<server>` server-level-allow semantics against the installed pi; if pi requires explicit `mcp__server__tool`, the writer/bridge expands to the peer mount's live tool list instead — a bounded fallback noted for the plan.)

### 6. Bot Builder UI (`bot-builder.js`)

The Layer 1 collapsed remote group becomes **selectable** when `remoteInvocationEnabled(db)` is true AND a peer tool's `exposed === true` (the L2a catalog boolean). Rendered as checkboxes that write `def.tools.remote_mcp` entries (`<instanceId>::<canonicalId>`), labeled by owning instance. Non-exposed remote capabilities remain shown-but-disabled with a hint ("not exposed by that instance"). When the flag is off, the group renders exactly as Layer 1 (read-only) — no false affordance. De-dup by `(instanceId, canonicalId)`; group by capability the same way the local picker groups.

### 7. Components

| Unit | Responsibility | Reuses |
|---|---|---|
| `remoteInvocationEnabled(db)` + Settings toggle | Master flag (local-only, default off) | `readFeatureFlag`, settings-section pattern |
| `def.tools.remote_mcp` schema | Record per-capability remote selections | — |
| `crow-remote-proxy.mjs` | stdio↔HTTP passthrough to a peer mount | `loadRemoteInstances` client, `peer-tokens.json`, MCP SDK |
| `mcp_writer` remote minting | Mint forward-proxy blocks (flag-gated, core-only) | `writeBotMcp`, `crow_instances` |
| bridge allowlist | Add remote tools to `--tools` (flag-gated) | `toolAllowlist` |
| Bot Builder flip | Exposed remote caps selectable (flag-gated) | Layer 1 `gatherPeerTools`, catalog `exposed` |

## Data flow (happy path)

1. Operator on grackle exposes "Memory" (L2a). 2. Operator on crow enables `feature_flags.remote_invocation`, opens Bot Builder, selects "Memory @ grackle" for bot X → `def.tools.remote_mcp += ["<grackleId>::crow-memory"]`. 3. Bridge spawns pi: `writeBotMcp` mints `crow-remote-<grackleId8>-crow-memory` into `.mcp.json`; `--tools` includes `mcp__crow-remote-<grackleId8>-crow-memory`. 4. pi spawns the forward-proxy (stdio) → it connects to `https://grackle…/memory/mcp` with crow's Bearer peer token → lists memory tools. 5. Bot calls `crow_store_memory` → proxy forwards → grackle's instance-auth + **L2a gate** checks `crow-memory ∈ grackle.remote_exposed_tools` → allowed → runs on grackle → result back through the proxy. 6. grackle's L2a audit logs the inbound call.

## Error handling

- Peer unavailable / unpaired / token missing → proxy connects-fails → returns empty `tools/list` + logs; bot simply has no remote tools (graceful, never crashes the turn).
- Peer denies (capability not exposed) → L2a JSON-RPC `-32001` → proxy surfaces it as the tool-call error to the bot.
- Flag off → no remote blocks, no allowlist entries → fully inert.
- Non-core (addon) remote selection → `mcp_writer` skips with a warning (deferred scope).
- Unknown/revoked peer in `remote_mcp` → skipped with a warning.

## Testing & verification

No framework; `node:test` + isolated-DB/import checks + stub peers (L2a/L1 conventions). All tests use stubs — never spawn live peer connections in unit tests.

1. **`tests/remote-invocation-flag.test.js`** — `remoteInvocationEnabled` reads the flag; default/absent → false; `mcp_writer` + bridge produce zero remote artifacts when off (the safety invariant).
2. **`tests/remote-mcp-writer.test.js`** — `remoteServersForBot` parse (incl. malformed); mount-map resolution; `mintRemoteBlocks` mints the right block (name, env, no token embedded), skips addon/unknown-peer with warnings; flag-off ⇒ empty.
3. **`tests/crow-remote-proxy.test.js`** — against a stub peer MCP server: `tools/list` passthrough; `tools/call` forwards + returns result; peer-deny (`-32001`) surfaced; peer-unavailable → empty list, no throw; token resolved by id (stub `peer-tokens.json`).
4. **`tests/bridge-remote-allowlist.test.js`** — `--tools` includes `mcp__crow-remote-…` only when flag on; off ⇒ unchanged.
5. **Bot Builder render smoke** — flag-off ⇒ Layer 1 read-only; flag-on ⇒ exposed remote caps selectable, non-exposed disabled; saving round-trips to `def.tools.remote_mcp`.
6. **Invariants** — `node tests/auth-network.test.js` green; `feature_flags.remote_invocation` default off; a bot def WITHOUT `remote_mcp` produces a byte-identical `.mcp.json` and `--tools` vs pre-L2b (regression guard); L2a tests still green.
7. **Acceptance (manual/scripted, post-deploy, NOT in unattended fan-out)** — one real crow→grackle `crow_store_memory` (or a read tool) call end-to-end, with grackle's L2a exposure on and the flag on for one test bot; verify grackle's audit row.

## Build order (for the plan)

1. `remoteInvocationEnabled` helper + Settings toggle + flag test.
2. Mount map + `remoteServersForBot` + `mintRemoteBlocks` (flag-gated) + writer test.
3. `crow-remote-proxy.mjs` + stub-peer test.
4. `writeBotMcp` integration of remote blocks (flag-gated) + bridge allowlist (flag-gated) + tests.
5. Bot Builder UI flip (flag-gated, exposed-only) + render smoke.
6. Invariant + regression sweep (flag-off byte-identical), then post-deploy manual e2e acceptance.

## Conventions / safety

- Commit with explicit path args; verify `git show --stat HEAD`; never add Claude as co-author; `git pull --rebase` before push; branch off `main`.
- **The feature flag is the blast-radius control:** default off, and every L2b code path is a no-op when off, so the live MPA pi-bots are provably unaffected until an operator opts in.
- **The peer's L2a gate is the security boundary** — the forward-proxy carries no policy; it cannot widen what a peer exposes. The proxy never embeds the peer token in written config (resolved at runtime by id).
- Destructive remote tools keep the peer's in-tool confirm-token gate (unchanged; works cross-instance).
- **Build-session resource note:** crow froze twice during the L1 build from subagent fan-out on the always-on inference stack. Before heavy multi-agent execution, `docker stop` the model stack (`vllm-rocm-qwen35-4b llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed crow-companion faster-whisper-server kokoro-tts`) and `docker start` after.
- **Two items to pin in the plan (not blockers):** (a) pi's exact `--tools mcp__<server>` server-level-allow semantics (else expand to live tool names); (b) the precise `readFeatureFlag` signature/return shape.
