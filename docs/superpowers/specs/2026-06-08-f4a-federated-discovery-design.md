# F4a Layer 1 — Federated Capability + Bot Discovery

**Date:** 2026-06-08 · **Sub-project:** F4 of the Crow v1 refoundation → F4a (unified harness) → **Layer 1 (federated discovery)** · **Repo:** `/home/kh0pp/crow` · branch `feat/f4a-federated-discovery` (off `main` @ `e6e7bd0`).

Master plan: `~/.claude/plans/when-i-click-on-woolly-elephant.md`.

## Goal

Make the Bot Builder present **one view of the whole instance mesh**: every instance shows not just its own capabilities (tools/bundles) and bots, but also those of its peers — so "build a bot on crow → see it on grackle" and "a bundle installed on black-swan is visible in crow's Bot Builder" both hold. This is **discovery/visibility only**; actually *calling* a remote tool or *running* a remote bot are later layers.

## Scope decomposition (locked with user, 2026-06-08)

The user's full vision ("Bot Builder looks the same across instances, including cross-instance use") is three subsystems in dependency order:

- **Layer 1 — Federated discovery** *(this spec)*: mesh-wide visibility of capabilities + bots. Buildable now on the existing F5 mesh substrate. The foundation the others require.
- **Layer 2 — Cross-instance tool invocation** *(follow-on; independent of F3b)*: a bot on crow actually *calls* a tool whose MCP server lives on a peer, via authenticated cross-instance MCP routing. Flips Layer 1's read-only remote tools to selectable.
- **Layer 3 — Cross-instance bot edit + run** *(latest; "run" half needs F3b)*: edit a remote-owned bot from another instance (write-federation of `pi_bot_defs`); run a bot from a non-owning instance (needs the F3b distributed runtime).

This spec is **Layer 1 only**. Layers 2 and 3 get their own spec→plan cycles.

## Non-goals (Layer 1)

- Cross-instance tool *invocation* (Layer 2). Remote tools are shown read-only, **not selectable** for a bot.
- Cross-instance bot *edit or run* (Layer 3). Peer bots are read-only link-outs.
- Replicating `pi_bot_defs` via the sync engine. Federation is the discovery path (the sync allowlist deliberately omits `pi_bot_defs`); we do **not** add it.
- Changing each surface's tool *invocation* path (that's already shared via server factories; untouched here).
- The bundle-contract formalization + extensions audit (the other half of F4, "F4b" — deferred).

## Existing substrate this reuses (verified anchors)

- **Advertisement endpoint pattern:** `/dashboard/overview` (`servers/gateway/routes/federation.js:245-280`), HMAC-gated (`federationVerifyMiddleware` `:61-116`), returns `{instance, tiles, peers, health}`; the gossip `peers` roster is `buildPeerRoster()` `:218-237` (public metadata only).
- **Peer pull + cache:** `servers/gateway/dashboard/overview-cache.js` — `getPeerOverview(db, id, {source})` `:233`, stampede-protected, validated (`validateEnvelope` `:133-165`), TTL 30s `:37`, 2s timeout `:40`, 64 KB cap `:39`, event-bus invalidation on trust/status flip `:293-298`.
- **Authenticated peer client:** `servers/shared/peer-forward.js` `forwardSignedRequest()` `:75-200` — trust gate `:99-114`, HMAC signing `:148-156`, size-capped read `:34-53`, audit `:187-191`.
- **Peer discovery + merge:** `getTrustedInstances()` (`panels/nest/data-queries.js:222-231`) + `mergeDiscoveredPeers()` `:250-274` (F5 local+gossip merge; remote items flagged `discovered:true`).
- **Vocab bridge to retire/promote:** `CANONICAL_TO_VOICE_CATEGORY` (`scripts/pi-bots/ext_registry.mjs:272`) — one-way today; becomes the registry's authoritative bidirectional map.
- **Sync allowlist (confirming federation, not replication):** `servers/gateway/dashboard/settings/sync-allowlist.js:13-27` — `pi_bot_defs` and capability metadata are intentionally absent.
- **Bot Builder list builders:** `loadModelOptions` (`bot-builder.js:239-256`), `probeAll` (MCP tools, `:182-204`), `probeExtensions` (`:211-221`), `loadSkills` (`:260-270`).
- **Bot Board bot list:** `bot-board.js:405` (`pi_bot_defs WHERE enabled=1`), switcher render `:448-456`.

## Design

### 1. Local capability registry

New module `servers/gateway/capability-registry.js` exporting `getLocalCatalog(db, { crowHome })` → a normalized object built by **live aggregation** (so a local install appears with no restart):

```
{
  instanceId, instanceName,
  tools:      [{ canonicalId, category, name, bundleId, toolCount }],   // core TOOL_MANIFESTS + installed addons
  skills:     [{ name }],                                               // skillDirs(crowHome)
  bots:       [ <public bot projection, see §2> ],                      // from pi_bot_defs
}
```

- Vocabulary is unified **here**: every tool entry carries both `canonicalId` (`crow-memory`) and `category` (`memory`). The `CANONICAL_TO_VOICE_CATEGORY` map is promoted into this module as the single authority (callers stop importing the one-way version from `ext_registry`).
- Tool sources: core from `TOOL_MANIFESTS` (`gateway/tool-manifests.js`); installed-addon tools from the same source `probeExtensions`/`mcp-addons.json` already uses.

### 2. Public-safe projection (security boundary — strict)

Only metadata crosses the mesh. Dedicated **whitelist projectors**, each a pure function:

- `toPublicBot(row)` → `{ bot_id, display_name, enabled, project_id, tracker_type, model, tool_count }`. **Never** the full `definition` JSON (it holds prompts, allowlists, gateway addresses, `permission_policy`). `model` is the resolved model *name* string; `tool_count` is a number.
- `toPublicTool(entry)` → `{ canonicalId, category, name, bundleId, toolCount }`. **Never** env values, API keys, args, or command paths.
- `toPublicSkill(s)` → `{ name }`.

The advertised payload is built **only** from these projectors — there is no path from a raw `definition`/addon block to the wire. This mirrors F5's public-metadata-only roster rule.

### 3. Advertisement endpoint

New `GET /dashboard/capabilities` (in `servers/gateway/routes/federation.js`, beside `/dashboard/overview`), **reusing the same `federationVerifyMiddleware` HMAC gate**. Returns:

```
{ instance: {id, name}, capabilities: { tools:[...], skills:[...], bots:[...] }, generatedAt }
```

Built from `getLocalCatalog` → projectors. Separate from `/dashboard/overview` (decision: keep the hot overview lean; capabilities are larger + fetched lazily). Under `/dashboard/` → already private + Funnel-rejected; **MUST NOT** be added to `PUBLIC_FUNNEL_PREFIXES`.

### 4. Federated fetch + cache

New `servers/gateway/dashboard/capabilities-cache.js`, mirroring `overview-cache.js`:

- `getPeerCapabilities(db, instanceId, { source })` — stampede-protected cached signed fetch of the peer's `/dashboard/capabilities` via `forwardSignedRequest()` (`auditAction: "federation.capabilities"`), 2s timeout, size-capped, **TTL ~60s** (catalogs change rarely — only on install/uninstall).
- A receive-side `validateCapabilitiesEnvelope()` (same discipline as `validateEnvelope`): reject malformed/oversized/extra-field payloads before caching, so a compromised peer can't inject unexpected data.
- Subscribe to the same `crow_instances:row_updated` event bus to invalidate a peer's cached capabilities on trust/status flip.

### 5. Federated aggregation

`mergeFederatedCatalog(localCatalog, peerCatalogs, localId)` (mirrors `mergeDiscoveredPeers`): returns the mesh view — local items tagged `{ instance: localId }`; each peer's items tagged `{ instance: peerId, instanceName, remote: true }`. Peer set = `getTrustedInstances()` + gossip-discovered peers (from the overview roster), so federation covers exactly the instances the F5 carousel shows. Fan out with `Promise.allSettled` under the existing ~1500ms budget; a down/slow peer contributes nothing and never blocks (failures aren't cached, so it reappears when back).

### 6. Surfacing in the panels

- **Bot Board (`bot-board.js`):** local query unchanged. Add a **"Bots on other instances"** section below local bots, rendering federated peer bots labeled with owning instance, **read-only**, each linking out to that peer's gateway via `gateway_url` (the F5 discovered-tile link-out pattern). Absent when there are no peers (single-instance unaffected).
- **Bot Builder (`bot-builder.js`):** local tool/extension/skill pickers stay selectable (local items are the ones a bot here can call today). Federated peer capabilities render in a separate **read-only** group, **collapsed with a count** ("Available on N peer instances ▸"), each labeled with owning instance, **not selectable**, with an inline note ("usable once cross-instance calling lands" — Layer 2). No false affordance; clean seam for Layer 2 to flip remote items selectable.

### Component summary

| Unit | Responsibility | Reuses |
|---|---|---|
| `capability-registry.js` | Local normalized catalog (vocab-unified, fresh-on-install) | TOOL_MANIFESTS, probeExtensions, skillDirs, pi_bot_defs |
| projectors (`toPublicBot/Tool/Skill`) | Strict public-safe metadata projection | — |
| `/dashboard/capabilities` route | Advertise local catalog (HMAC-gated) | federationVerifyMiddleware |
| `capabilities-cache.js` | Cached, validated peer pull | overview-cache pattern, forwardSignedRequest |
| `mergeFederatedCatalog` | Local + peer merge with ownership tags | mergeDiscoveredPeers pattern, getTrustedInstances |
| panel edits (board + builder) | Render local-editable + remote-read-only | existing list builders |

## Testing & verification

No framework; `node:test` + isolated-DB/import checks.

1. **`tests/capability-registry.test.js`** — local aggregator over stub sources: catalog carries `canonicalId`+`category`, includes addon tools, reflects a newly-"installed" addon without restart.
2. **`tests/public-bot-projection.test.js`** — security guard: `toPublicBot()` on a `definition` stuffed with secrets/prompts/allowlists/gateway addresses/`permission_policy` yields **only** whitelisted fields; `toPublicTool` drops env/keys/command paths.
3. **`tests/capabilities-envelope.test.js`** — receive-side validation rejects malformed/oversized/extra-field peer payloads (mirrors overview-cache validation tests).
4. **`tests/merge-federated-catalog.test.js`** — local tagged self, peer items tagged owner+`remote:true`, a rejected peer fetch contributes nothing and never throws.
5. **Panel render smoke** — Bot Board + Bot Builder handlers against an isolated DB with a stubbed peer-catalog source: "Bots on other instances" + collapsed "Available on N peer instances ▸" render with peer data; absent with no peers.
6. **Invariants** — `node tests/auth-network.test.js` green; confirm `/dashboard/capabilities` is HMAC-gated, under `/dashboard/`, and **not** in `PUBLIC_FUNNEL_PREFIXES`.

## Build order

1. `capability-registry.js` + projectors + their tests (the pure core; no federation yet).
2. `/dashboard/capabilities` advertisement route (HMAC-gated) + envelope validator + test.
3. `capabilities-cache.js` (peer pull, mirror overview-cache) + test.
4. `mergeFederatedCatalog` + test.
5. Bot Board surfacing (peer bots section).
6. Bot Builder surfacing (collapsed remote group).
7. Invariant sweep.

## Conventions / safety

- Commit with explicit path args; verify `git show --stat HEAD`; never add Claude as co-author; `git pull --rebase` before push; branch off `main`.
- Public-metadata-only across the mesh — the projectors are the only path to the wire; receive-side validation enforces the boundary both ways.
- Network-exposure invariant intact: `/dashboard/capabilities` private + HMAC-gated, never Funnel-exposed.
- Reuse the proven federation machinery (`forwardSignedRequest`, overview-cache pattern, `mergeDiscoveredPeers`) rather than inventing new transport.
