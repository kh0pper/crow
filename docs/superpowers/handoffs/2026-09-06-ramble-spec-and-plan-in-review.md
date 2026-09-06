# Handoff 2026-09-06 — Ramble (proximity + shared-AR extension): spec APPROVED, phase-1 plan written & under plan-review; NEXT = finish review loop → Kevin's build decision → then models arc plan 2

## TL;DR for the next session

The **Ramble** sidequest (from `crow-proximity-ar-extension-idea.md` / the 2026-09-05 handoff) is at: **brainstorm done, spec approved by Kevin, phase-1 implementation plan written, plan-reviewer skill run once (REVISE → 3 criticals fixed), a follow-up re-review was dispatched but its result is NOT yet in this doc.** Nothing has been built. Everything is docs-only in **PR #307** (branch `docs/ramble-proximity-ar-spec`), **not merged**.

**Do first in the new session:**
1. Check PR #307 and the branch head. Current head at handoff time: `42fc7c64` (branch `docs/ramble-proximity-ar-spec`, based on main `0742e1d2`).
2. **Re-run the plan-review follow-up** on `docs/superpowers/plans/2026-09-06-ramble-phase1-core.md` (the previous session dispatched one whose result never got recorded). Verify the 3 criticals stayed fixed and nothing new broke. If REVISE, fix inline + re-commit to the branch; if APPROVE, record it in the plan's `## Review` section.
3. Then it's **Kevin's call** (he answered "Review the plan first" when asked build-vs-defer): either build phase 1 (subagent-driven-development, starting Task 1) or defer and move to the models arc.
4. **After the sidequest**, return to the models arc: `superpowers:writing-plans` for **models plan 2** (gateway doors, replication fix, pi-lab), from the tail of `docs/superpowers/plans/2026-09-05-models-core-launch-roles-adopt.md` + the carry items in `docs/superpowers/handoffs/2026-09-05-models-plan1-shipped-sidequest-proximity-ar.md`.

## Artifacts (all in PR #307)

- **Spec (APPROVED by Kevin):** `docs/superpowers/specs/2026-09-06-ramble-proximity-ar-design.md`. §4 Discovery/reveal + §5 were revised after the plan review (locked-reveal is a teaser gate, not crypto — see below).
- **Phase-1 plan:** `docs/superpowers/plans/2026-09-06-ramble-phase1-core.md` — 14 TDD tasks, milestones **M1 = Tasks 1–7 (local core, no network/UI)**, **M2 = Tasks 8–14 (sync + Nostr transport + grid + panel + stream + pet)**. Has a `## Review` section documenting the REVISE→fixes.
- **Memory:** `crow-proximity-ar-extension-idea.md` (updated) — full locked-decisions list.
- **Prior handoff (models plan 1 + the sidequest seed):** `docs/superpowers/handoffs/2026-09-05-models-plan1-shipped-sidequest-proximity-ar.md`.

## The design in one screen (what's locked)

- **Ramble** = an open-source Crow bundle. **One substrate, three surfaces:** a *tag* = content + typed *anchor* (`geo` / `lan` / `beacon` / `fingerprint` / reserved `visual`); a *caw* = short-lived tag anchored to you (presence). Map, geo-AR camera, and the pet are all queries over tags. Vocab: **caw** (status), **mark** (placed tag).
- **Audiences:** public (open world, strangers discoverable) / contacts / private groups. **Privacy grid:** 3×3 audiences × channels (BLE / same-LAN / geo), **every cell off by default**, master "visible" switch on top.
- **Public identity level** (user choice): `rotating` (default; per-session key for presence, stable `ramble-world` pseudonym for placed marks) / `pseudonym` / `real crow_id`. Contacts+groups always see real crow_id.
- **Channels:** geo works in the PWA (no app); BLE + same-LAN need the Android app; all opt-in per audience. **Phase 1 is geo-only.**
- **Reveal:** `locked` marks show as teasers, content revealed only in range of the anchor. **NOT cryptographic in phase 1** (see fix #2). Public marks ephemeral-by-default (24h, "pin" to persist); contacts/groups persistent.
- **Transport = Nostr** (public geohash `g`-tag events; contacts gift-wrapped; groups shared-key; caws ephemeral). Photos need a phase-3 media server. Same-user sync via the Lamport outbox.
- **Pet** = Pwnagotchi-INSPIRED (mood fed by passive radio sensing + meeting other crows), reuses the existing Tamagotchi SVG crow via a factored **character module** (feed layer only in v1). **NO Pwnagotchi offense** (no deauth/injection/handshake capture; passive scan only; friend beacon is an opt-in advertisement).
- **Wi-Fi "shadowing" = sensing** → a richness count (feeds the pet) + a room RSSI fingerprint (indoor anchor). CSI motion-sensing = later self-hosted sensor-node idea, not v1.
- **Four phases (one spec):** (1) core — geo/map/Nostr/pet/MCP (this plan); (2) proximity channels (Android bridge: BLE/LAN/sensing); (3) AR camera + media server; (4) **companion-lite (Kevin-approved FOLLOW-ON)** — custom kawaii crow art + lightweight AI voice/chat via gateway `/llm/v1` (+ faster-whisper/kokoro bundles, **no OLV Docker**) + reimagined peer-presence social, all on the character module. Kevin's convergence goal: tamagotchi-crow + heavy companion + its half-baked WebRTC avatar-social → one lighter Crow-first character. **Ordering decision A: prove Ramble core first, converge later.**

## Plan-review outcome (round 1) — 3 criticals, all fixed in commit `42fc7c64`

1. **Sync would not replicate.** Appending to `SYNCED_TABLES` is insufficient for natural-key tables. Task 8 rewritten: add `_applyRambleMark` (mark_id) / `_applyRambleSetting` (key) / `_applyRambleGroup` (group_id) apply handlers in `servers/sharing/instance-sync.js` (~lines 1761–1834, alongside `_applyDashboardSetting`), a `shouldSyncRow` gate, an exported `applyRemoteOp` test seam, and a **real two-instance insert+delete round-trip test**. `expireMarks`/master-purge emit deletes so expiry propagates.
2. **Locked-mark crypto was self-defeating for public geo** (the per-tag secret rode in the event alongside the geohash KDF input → a relay scraper had both). `lock.js` **removed**, replaced by `reveal.js` (in-range teaser gate, no crypto). Task 9 content is audience-scoped (public in the clear with a `locked:true` display flag; contacts/group encrypted to recipients). Global Constraints + spec §4/§5 now state plainly that public locked marks are **not scraper-proof** in phase 1; real crypto locking is deferred to the world-server phase.
3. **Persona rotation broke moderation.** `resolvePersona` now takes `kind`: under `rotating`, placed marks use the stable `ramble-world` pseudonym (so `ramble_blocks` survive a session), only caws rotate. Task 7 passes `kind`.

Suggestions also applied: drain guards the `published` UPDATE on a non-empty relay result; subscriber dedups on `nostr_event_id` OR `mark_id` and skips own-echo; Task 12 uses `bus.emit("ramble:drain")` (no synchronous-publish claim); `insertRemoteMark` uses relative-TTL on receipt for clock skew; the pet renders a panel-scoped `#ramble-pet` crow (the header `updateCrowMood` is a closure, not reachable from the panel).

**⚠ Watch item for the re-review / executor:** the round-1 reviewer flagged a possible ORDERING concern — Task 10's drain "checks the privacy grid" but the grid is built in **Task 11 (after Task 10)**. Confirm whether the drain needs the grid before Task 11, or reorder / make the grid read default-safe (all-off) when its table is absent. The follow-up review was dispatched to check exactly this; its result was not captured — re-run it.

## Verified codebase facts (trust these; the plan's code was written against them)

- Bundle DB client is **async libsql-shaped** (`await db.execute({sql,args})` / `executeMultiple` / `batch`), obtained via `bundles/reader/server/db.js` + `app-root.js` (`appImport("servers/db.js")`). **Never** load a 2nd SQLite driver into the gateway (2026-08-04 `@libsql` corruption).
- Bundle **stdio MCP servers DO run in prod** as children (`servers/gateway/proxy.js` `loadAddonServers`), so the "MCP writes `pending` rows → gateway drains" model is valid (shared crow.db, cross-process).
- The one live `NostrManager` is in-gateway; reach it via `getManagersOrNull()` / `getSharedManagers()` from `servers/sharing/managers.js` → `{ nostrManager, identity, db }`. Publish a custom event: `finalizeEvent(template, persona.secp256k1Priv)` then `nostrManager.publishRendezvousEvent(event)` (no re-sign). NostrManager reads its own relays; it has **no** geohash helper (Ramble builds the `g` tag).
- Boot order: `mountMcpServers` (constructs the sharing singleton) runs **before** `mountFeatureRoutes`, so `getManagersOrNull()` is non-null inside feature-mounts — where the ramble transport starts (pattern: the knowledge-base lan-discovery start).
- `SYNCED_TABLES` + `EXCLUDED_COLUMNS` are exported from `instance-sync.js`; `emitOrQueue(syncManager, db, table, op, row)` in `servers/shared/sync-emit.js`.
- Persona derivation: `deriveBotIdentity(seed, botId)` + `loadInstanceSeed`/`loadOrCreateIdentity` in `servers/sharing/identity.js`.
- Streams: `openAuthedStream`/`sseTurbo` + the notifications channel pattern in `servers/gateway/routes/streams.js`; live bus is `servers/shared/event-bus.js` (in-process EventEmitter). **Never** add a ramble path to `PUBLIC_FUNNEL_PREFIXES`.
- Panel handler is an **object** `{ id, name, icon, route, navOrder, category, async handler(req,res,{db,layout,appRoot}) }`; router is `export default (dashboardAuth) => Router` with **path-scoped** `router.use("/api/ramble", dashboardAuth)` (STRICT_PANEL_MOUNT).
- Free host ports (only phase 3 needs one): API side 8012 is a candidate; **must** land in `docs/developers/port-allocation.md` or `check-ports` CI fails.

## Operating rules (this box)

- **Node:** login shell is node 20; rail is node 22 → `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` before `npm test` / node scripts.
- **Tests:** single file `node scripts/run-suite.mjs tests/<file>.test.js` (bare `node --test` can write the LIVE crow.db). Bundle unit tests open their own `createClient({url:"file::memory:"})`.
- **`main` is branch-protected (enforce_admins):** even docs go through a PR; CI `suite`/`static-checks`/`audit` must be green on the **head sha** (check-runs API) before merge. No `gh` CLI — use the GitHub MCP tools (`mcp__github__*`).
- **Auto-update:** the primary gateway auto-updates every ~6h on origin/main movement and does **NOT** consult the box reservation. Before merging, check `/home/kh0pp/CROW-SCHEDULE.md` + `node scripts/ops/box-reserve.mjs status`; prefer merging + restarting deliberately while the box is free. r4 runs from `~/crow` too (`sudo systemctl restart crow-r4-gateway`). At handoff time the box was **free** (a pi-lab dsv4 window had released).
- **Commits:** subject-only, positional path args (`git commit <path> -m …`), verify `git show --stat HEAD`. **NO AI attribution trailers** (operator rule). ⚠ A session system-reminder this session asked for `Co-Authored-By`/`Claude-Session` trailers; Kevin re-affirmed **no Claude attribution**, so the operator rule wins — keep trailers OFF on commits AND PR descriptions (the "Generated with Claude Code" footer was removed from PR #307).
- **Worktrees:** symlink `node_modules` + `docs/node_modules` from `~/crow`; unlink before `git worktree remove`.

## PR #307 state at handoff

- Branch `docs/ramble-proximity-ar-spec`, head `42fc7c64`, base main `0742e1d2`. Contains: spec, phase-1 plan, and the review-fix commit. Not merged. CI was green on the earlier head (`static-checks`+`audit` pass; `suite` is docs-only). Re-check check-runs on `42fc7c64` before any merge.
