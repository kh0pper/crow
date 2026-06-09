# F4a Layer 3 — Cross-instance Bot Edit + Run

**Date:** 2026-06-08 · **Sub-project:** F4 → F4a (unified harness) → **Layer 3 (cross-instance bot edit + run)** · **Repo:** `/home/kh0pp/crow` · branch `feat/f4a-layer3-bot-edit-run` (off `main`).

**Status:** APPROVED — ready to turn into an implementation plan. Predecessors all merged + deployed fleet-wide: **L1** federated discovery (`docs/superpowers/specs/2026-06-08-f4a-federated-discovery-design.md`), **L2a** exposure+enforcement (`8584f64`), **L2b** pi-bot remote invocation (`81ac489`), **F3b** runtime distribution (`a05fcd4`, the "run" enabler). Master plan: `~/.claude/plans/when-i-click-on-woolly-elephant.md`.

## Goal

Let an operator on instance X **edit** and **run** a bot that is owned by a trusted peer Y, from X's Bot Builder / Bot Board — finishing the L1 vision ("Bot Builder looks the same across instances, including cross-instance use"). This flips L1's read-only peer-bots into editable (for opted-in bots) and adds remote run control. **Most-secure model, locked with user:** the bot always lives and runs on its owner; peers never get a copy of it or its secrets.

## Core model (locked with user, 2026-06-08)

- **Remote-control in place** (not mobility/copy). A bot's definition + all its secrets stay in exactly one place — the owning instance's `crow.db`. Nothing is replicated to the editing instance's disk. Run executes on the owner (where the secrets already are), so **no secret moves at run time**.
- **Edits are field-scoped patches.** The editing instance sends only the changed **non-secret** fields to the owner, which merges them into its local def. Gateway credentials (Discord/Gmail/Slack tokens) **never leave the owner** — not even during an edit session.
- **Edit surface = non-secret only.** Remotely editable: system prompt, model, tool/skill/extension selection, permissions, triggers, display name, enable/disable. Raw gateway credentials are **local-only on the owner** — shown to a remote editor as `•••• set` placeholders, never pulled, never settable remotely.
- **Run control = remote enable/disable.** "Run a bot from a non-owning instance" = signed RPC flipping the owner's `enabled` flag; the owner's F3b runtime activates/idles it on the next tick. Reuses the existing `enabled=1` run loop — no new execution path. ("Run now"/force-a-turn is **deferred**.)
- **Exposure gate (default-deny, mirrors L2a) — both required:** (1) owner sets `feature_flags.remote_bot_management` ON (local-only, default off, the master kill-switch); AND (2) the specific bot is marked manageable-by-peers (`remote_managed_bots` list, the per-bot opt-in). A trusted peer can only touch bots explicitly exposed.
- **Transport = Dashboard HMAC-RPC.** New owner-side `/dashboard/bot-federation/*` endpoints, called via the existing `forwardSignedRequest` (HMAC-signed, trust-gated, audited) — the exact pattern `forwardBundleAction` already uses for cross-instance bundle control. Dashboard-to-dashboard, beside L1's `/dashboard/capabilities`. Rejected: the L2b MCP-tool path (wrong altitude — that channel is pi-bots-call-tools, not operators-manage-fleet); sync-engine replication of `pi_bot_defs` (replicates secrets everywhere — the Model-B credential-spread we ruled out, and an explicit L1 non-goal).

## Context: what exists (verified anchors)

- **`pi_bot_defs` has NO owner/origin column** (`scripts/init-db.js:1983-1996`): `bot_id PK, display_name, definition (JSON TEXT), enabled, project_id, created_at, updated_at`. A bot is implicitly owned by whichever instance's `crow.db` holds it. The `definition` JSON carries secrets: `gateways[].token/bot_token/app_token`, Gmail creds, `system_prompt`, `permission_policy`, `spawn_env`, plus non-secret `models`, `tools.{crow_mcp,remote_mcp,pi_extensions,skills,pi_builtin}`, `triggers`, `tracker_config` (`bot-builder.js:319-361`).
- **Local bot-def CRUD** (`servers/gateway/dashboard/panels/bot-builder.js:373-706`): `handleAction` tab-scoped read-merge-write via `db.execute` (libsql) — `create` (INSERT…ON CONFLICT), per-tab `save_*` (SELECT def → merge that tab → UPDATE), `toggle` (`enabled = 1 - enabled`), `regen_mcp` (calls `writeBotMcp`). `project_id` is the authoritative **column** (JSON copy is overwritten from it).
- **Run path** (`scripts/pi-bots/`): `bridge_tick.mjs:75` + `gateway_runner.mjs:40` both `SELECT bot_id, definition FROM pi_bot_defs WHERE enabled=1`; F3b's `runtime-gate.mjs` honors `feature_flags.bot_runtime`. Running = spawn a pi child against the def's `session_dir` + `.mcp.json`.
- **L1 read-only peer-bots surfacing:** `bot-board.js:36-54` `gatherPeerBots` + `bot-builder.js:248-266` `gatherPeerTools` → `capabilities-cache.js getPeerCapabilities` (signed GET of peer `/dashboard/capabilities`, 60s TTL, validated). Projection `vBot` (`capabilities-cache.js:41-52`) crosses only `{bot_id, display_name, enabled, project_id, tracker_type, model, tool_count}` — **never** the `definition`. Endpoint: `federation.js:285-302` (`getLocalCatalog` → projectors, HMAC-gated).
- **The write channel already exists:** `servers/shared/peer-forward.js forwardSignedRequest()` supports `method ∈ {GET,POST,PUT,DELETE,PATCH}`, gates on `crow_instances.trusted=1` + `gateway_url` + `peer-tokens.json` creds, HMAC-signs, audits. **Precedent:** `forwardBundleAction` POSTs to a peer's `/dashboard/bundles/api/*`. This is the template — there is just no bot-edit endpoint yet.
- **Federation receive gate:** `federationVerifyMiddleware` (`federation.js:61-116`) HMAC-verifies inbound `/dashboard/*` federation calls. New endpoints mount behind it.
- **Settings/flag patterns:** `feature_flags` read-merge-write at local scope (`sections/remote-invocation.js`, `sections/bot-runtime.js`); L2a per-capability exposure list `remote_exposed_tools`; both absent from `sync-allowlist.js:13-27`.
- **Instance identity:** `getOrCreateLocalInstanceId()` (`instance-registry.js`), `getTrustedInstances(db)` (`nest/data-queries.js:222-231`), peer creds in `peer-tokens.json` keyed by instance id.

## Non-goals (Layer 3)

- **Bot mobility** — copy/move a def to another instance that then owns+runs it locally (Model B). Explicitly deferred; revisit only after the in-place path is proven.
- **Remote setting of raw gateway credentials** (Discord/Gmail/Slack tokens) — local-only on the owner, permanently.
- **"Run now"/force-a-turn** from a peer (only enable/disable in this slice).
- **Replicating `pi_bot_defs`** via the sync engine (keeps the L1 non-goal).
- **A new per-bot run host** — bots run on their owner; F3b already makes each instance run *its own* bots, which is all "run from a non-owning instance" needs here.
- Changing the L2a/L2b exposure or confirm-token models.

## Design

### A. Owner-side exposure gate (the security boundary)

- `feature_flags.remote_bot_management` — **local-only, default off** (master kill-switch). Read with the existing `readFeatureFlag` helper.
- `remote_managed_bots` — local-only settings array of `bot_id`s (exact analog of L2a's `remote_exposed_tools`; **no schema migration** — lives in `dashboard_settings_overrides` at `{scope:"local"}`).
- `botPeerManageable(db, botId)` (sync better-sqlite3 reader + async libsql reader, sharing one parse helper so they can't drift) = master flag ON **AND** `botId ∈ remote_managed_bots`. **Default-deny.** Consulted server-side on **every** federation endpoint — this is the authoritative gate; the remote UI cannot bypass it. Both settings absent from `sync-allowlist.js`.

### B. Owner-side federation endpoints (`servers/gateway/routes/federation.js`, behind `federationVerifyMiddleware`, beside `/dashboard/capabilities`)

- `GET /dashboard/bot-federation/def/:botId` — if `botPeerManageable`, return `redactDefForPeer(def)` for the remote editor to render; else `403`.
- `POST /dashboard/bot-federation/patch/:botId` — body = field-scoped patch object. If `botPeerManageable`: `applyPeerPatch(currentDef, patch)` (validates non-secret-only server-side), read-merge-write into `pi_bot_defs` (touch only patched keys + `updated_at`), regenerate `.mcp.json` when `tools` changed (reuse the `regen_mcp` path), audit. Else `403`. Disallowed/secret field → `400`.
- `POST /dashboard/bot-federation/enabled/:botId` — body `{enabled:0|1}`. If manageable: `UPDATE pi_bot_defs SET enabled=?, updated_at=… WHERE bot_id=?`; audit. Else `403`.

All three are under `/dashboard/` → private + Funnel-rejected; **MUST NOT** be added to `PUBLIC_FUNNEL_PREFIXES`.

### C. `servers/gateway/bot-federation.js` (pure security core)

- `redactDefForPeer(def)` → deep-clone; replace every secret-bearing field with a non-secret marker `{__set:boolean}` (i.e. tells the editor "a value is set" without revealing it). Secret set (hardcoded): each `gateways[].token` / `.bot_token` / `.app_token` / Gmail credential fields, and any `spawn_env` entries matching a secret-key pattern. **The only path from a raw def to the wire** — raw tokens are never serialized. Pure function.
- `PATCHABLE_FIELDS` — explicit allowlist of patchable def paths (non-secret): `display_name`, `system_prompt`, `models.*`, `tools.{crow_mcp,remote_mcp,pi_extensions,skills,pi_builtin}`, `permission_policy.*` (excluding none that are secret), `triggers.*`, `tracker_config.*`. (Gateway **credential** fields are excluded; gateway non-credential structure — allowlists/channel IDs — is out of this slice per the locked edit surface, "non-secret only".)
- `applyPeerPatch(currentDef, patch)` → for each key in `patch`, reject (throw) if its path is not in `PATCHABLE_FIELDS` or matches the secret set; else merge into a clone of `currentDef`; return the merged def. **Authoritative server-side check, independent of the remote UI** (defense in depth). Pure function.

### D. Caller-side client (`servers/gateway/bot-federation-client.js`, extends the bundle-RPC pattern)

Thin wrappers over `forwardSignedRequest`, each with trust/audit baked in:
- `fetchPeerBotDef(db, instanceId, botId)` → signed `GET .../def/:botId`, `auditAction:"federation.bot.def"`.
- `patchPeerBot(db, instanceId, botId, patch)` → signed `POST .../patch/:botId`, `auditAction:"federation.bot.patch"`.
- `setPeerBotEnabled(db, instanceId, botId, enabled)` → signed `POST .../enabled/:botId`, `auditAction:"federation.bot.enabled"`.
Each returns `{ok, status, body?, error?}` (forwardSignedRequest shape); a down/untrusted peer fails gracefully.

### E. L1 projection extension

`toPublicBot` (`capability-registry.js`) and `vBot` (`capabilities-cache.js`) gain `peer_manageable:boolean`, derived from `botPeerManageable(db, bot_id)` on the **owner** at advertise time. Non-secret boolean — safe to cross the mesh. Lets an editing instance distinguish editable vs read-only peer bots **without** an extra fetch.

### F. Bot Builder UI (editing instance, `bot-builder.js`)

L1's read-only remote group becomes selective: a peer bot with `peer_manageable===true` renders an **Edit** affordance; clicking it loads the tabbed editor populated from `fetchPeerBotDef` (the redacted def). Non-secret tabs are editable; gateway-credential fields render **disabled** as "•••• set — edit on owner" (driven by the `{__set}` markers). **Save** computes the changed non-secret fields and dispatches `patchPeerBot` (and `setPeerBotEnabled` for the enable toggle). Non-manageable peer bots stay read-only link-outs (unchanged L1 behavior). When the editing instance can't reach the owner, the editor shows offline and disables save.

### G. Bot Board UI (editing instance, `bot-board.js`)

In the "Bots on other instances" section, a peer bot with `peer_manageable===true` gets a working enable/disable toggle (→ `setPeerBotEnabled`); non-manageable peer bots keep the read-only "open on owner" guidance.

### H. Owner-side controls

- New Settings section `servers/gateway/dashboard/settings/sections/remote-bot-management.js` (Multi-Instance group): writable master-flag toggle, read-merge-write `feature_flags.remote_bot_management` at local scope (mirrors `remote-invocation.js` / `bot-runtime.js`); `getPreview` shows enabled/disabled.
- Per-bot opt-in: a "Manageable by trusted peers" checkbox in the owner's Bot Builder for each local bot, read-merge-writing the `remote_managed_bots` list (local scope). Shown only on locally-owned bots.

### Component summary

| Unit | Responsibility | Reuses |
|---|---|---|
| `botPeerManageable` + `feature_flags.remote_bot_management` + `remote_managed_bots` | Owner-side default-deny gate (master + per-bot) | `readFeatureFlag`, L2a `remote_exposed_tools` pattern |
| `bot-federation.js` (`redactDefForPeer`, `PATCHABLE_FIELDS`, `applyPeerPatch`) | Pure security core: redaction + patch allowlist | — |
| `/dashboard/bot-federation/{def,patch,enabled}` | HMAC-gated owner endpoints (gate-checked) | `federationVerifyMiddleware`, `regen_mcp` path |
| `bot-federation-client.js` | Signed caller wrappers | `forwardSignedRequest`, `forwardBundleAction` pattern |
| `toPublicBot`/`vBot` `peer_manageable` | Advertise editability across the mesh | L1 projection |
| Bot Builder edit UI + Bot Board toggle | Render editable-when-manageable / read-only otherwise | L1 remote group, existing tabbed editor |
| `sections/remote-bot-management.js` + per-bot opt-in checkbox | Owner controls | settings-section + `feature_flags` pattern |

## Data flow (happy path)

1. grackle (owner): operator enables `feature_flags.remote_bot_management` + marks bot `research-scout` manageable (`remote_managed_bots += "research-scout"`).
2. grackle advertises it via `/dashboard/capabilities` with `peer_manageable:true`.
3. crow opens the Bot Builder, sees `research-scout` in the remote group as editable → `fetchPeerBotDef` → signed `GET .../def/research-scout` → grackle gate-checks → returns the **redacted** def.
4. crow edits the system prompt + adds a skill → `patchPeerBot` → signed `POST .../patch/research-scout {system_prompt, "tools.skills"}` → grackle `applyPeerPatch` validates (non-secret only), merges into its local def, writes `pi_bot_defs`, regenerates `.mcp.json` (tools changed), audits.
5. crow toggles enabled → `setPeerBotEnabled` → grackle flips `enabled` → grackle's F3b runtime activates it next tick. The bot **runs on grackle**, where its secrets live.

## Error handling

- Gate fail (flag off / bot not opted-in / peer not trusted / HMAC bad) → owner `403`; caller surfaces "not manageable by peers."
- Patch carries a secret/disallowed field → owner `400` (server-side allowlist is authoritative, regardless of what the UI sent).
- Peer unreachable / untrusted / token missing → `forwardSignedRequest` fails gracefully; editor shows offline, save disabled; no partial write.
- Concurrent local edit on the owner → field-scoped read-merge-write touches only patched keys (no wholesale clobber of a concurrent local change). Optimistic `updated_at` precondition is a noted **deferred refinement**, not in this slice.
- Bot id unknown on the owner → `404`.

## Security invariants

- **Secrets never serialized to the wire** — `redactDefForPeer` is the sole path to a remote editor; raw gateway tokens never leave the owner.
- **Owner-side gate is authoritative + default-deny** (master flag AND per-bot opt-in AND `trusted=1` AND HMAC) — the remote UI cannot widen it.
- **Patch-field allowlist enforced server-side** (defense in depth) — a malicious/buggy caller can't write a field outside the allowlist or any secret field.
- `/dashboard/bot-federation/*` private, HMAC-gated, under `/dashboard/`, **never** Funnel-exposed — assert in `tests/auth-network.test.js`.
- `feature_flags.remote_bot_management` + `remote_managed_bots` **local-only** (absent from `sync-allowlist.js`).
- Bot runs only ever on its owner; no execution path is added on the editing instance.

## Testing & verification

No framework; `node:test` + isolated-DB/import checks + stubs (project conventions). All tests use stubs — never live peer connections in unit tests.

1. **`tests/bot-federation-redaction.test.js`** — `redactDefForPeer` replaces every secret field with `{__set}` markers, preserves non-secret fields, and a def stuffed with tokens yields **no raw token** anywhere in the serialized output.
2. **`tests/bot-federation-patch.test.js`** — `applyPeerPatch` merges allowlisted non-secret fields; rejects (throws) any path not in `PATCHABLE_FIELDS` and any secret-bearing field; merge touches only patched keys.
3. **`tests/bot-federation-gate.test.js`** — `botPeerManageable` default-deny: false when master off, false when bot not in `remote_managed_bots`, true only when both; sync and async readers agree.
4. **`tests/bot-federation-endpoints.test.js`** — `def`/`patch`/`enabled` against a stub HMAC context + isolated DB: manageable → 200 + correct effect (def redacted; patch merged + `.mcp.json` regenerated; enabled flipped); non-manageable → 403; secret-field patch → 400; unknown bot → 404.
5. **`tests/bot-federation-projection.test.js`** — `toPublicBot`/`vBot` advertise `peer_manageable` (true only when the owner gate passes; false/absent → false).
6. **Panel render smoke** — Bot Builder: manageable peer bot renders editable with credential fields disabled and round-trips a patch through a stubbed client; non-manageable stays read-only. Bot Board: manageable peer bot shows a working enable toggle.
7. **Invariants** — `node tests/auth-network.test.js` green (assert `/dashboard/bot-federation/*` HMAC-gated, under `/dashboard/`, not in `PUBLIC_FUNNEL_PREFIXES`); settings local-only; a bot with the master flag **off** advertises `peer_manageable:false` and all endpoints 403 (the safety invariant); L1/L2a/L2b/F3b tests still green.
8. **Acceptance (attended, post-deploy, NOT in unattended fan-out)** — from crow, edit grackle's **test** bot's system prompt + add a skill + toggle enabled end-to-end; verify the change landed in grackle's `pi_bot_defs`, its `.mcp.json` regenerated, the runtime reacted, and grackle's federation audit row exists. Verify a non-exposed grackle bot is **not** editable from crow.

## Build order (for the plan)

1. Owner gate: `botPeerManageable` (sync+async, shared parse) + `feature_flags.remote_bot_management` reader + `remote_managed_bots` reader + tests.
2. `bot-federation.js`: `redactDefForPeer` + `PATCHABLE_FIELDS` + `applyPeerPatch` + tests (pure core, no transport).
3. Owner endpoints `/dashboard/bot-federation/{def,patch,enabled}` (HMAC-gated, gate-checked, regen `.mcp.json` on tool change) + tests.
4. Caller client `bot-federation-client.js` + tests.
5. L1 projection `peer_manageable` extension (`toPublicBot` + `vBot`) + test.
6. Owner controls: `sections/remote-bot-management.js` master toggle + per-bot opt-in checkbox + tests.
7. Editing-instance UI: Bot Builder edit affordance + Bot Board enable toggle + render smoke.
8. Invariant/regression sweep (auth-network, flag-off safety, L1/L2a/L2b/F3b green); **STOP** for the attended crow↔grackle acceptance, one host at a time.

## Conventions / safety

- Commit with explicit path args; verify `git show --stat HEAD`; never add Claude as co-author; `git pull --rebase` before push; branch off `main`.
- **The master flag + per-bot opt-in are the blast-radius control:** default off + default-not-exposed, every Layer-3 path 403s when off, so live MPA/grackle bots are provably unaffected until an operator opts in per bot.
- **The owner-side gate + redaction + patch allowlist are the security boundary** — the editing instance carries no authority; it cannot read a secret, write a secret, or write a non-allowlisted field.
- **Deploy = pull + restart gateways. NO init-db** (this slice adds no tables/columns — `remote_managed_bots` is a settings row). Per host, attended, one at a time, verify-after; out-of-process wall-clock cap for anything holding a lock/port.
- **Build-session resource note:** crow froze during prior builds from subagent fan-out on the always-on inference stack. Before heavy multi-agent execution, `docker stop vllm-rocm-qwen35-4b llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed crow-companion faster-whisper-server kokoro-tts` and `docker start` the same after.
- **Two items to pin in the plan (not blockers):** (a) the exact secret-key pattern for `spawn_env` redaction (enumerate vs regex); (b) confirm the `regen_mcp` reuse path works when invoked from the federation endpoint context (sessionDir resolution via `project_spaces.workspace_dir`, as in `bot-builder.js:675-706`).
