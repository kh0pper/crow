# Crow Messages Usability Arc — "Stupidly Simple" (master plan)

> **Status: MASTER PLAN (phase-level).** Each phase gets its own execution plan
> (writing-plans format, 2-round adversarial review) before code, like Theme 8.
> Operator directive 2026-07-01: broad authority for big changes; the bar is
> "stupidly simple to use and intuitive" for a non-technical user.

## Why (operator experience, 2026-07-01)

Kevin installed Crow on his wife's MacBook. Three failures:
1. **Adding each other as contacts was painful** — generate an opaque code, copy it out to another app, paste it into a collapsed tray on the other side, with a timing-fragile automatic completion step.
2. **A DM sent from grackle was never received** — and the sender had no way to know it failed.
3. **Contacts are per-instance** — a contact added on one of your instances doesn't exist on the others.

## Scope decisions (locked with operator 2026-07-01)

| # | Decision |
|---|---|
| D1 | Identity model = **"contacts follow the user"** — contact list (+ blocks/groups) syncs across the user's own paired instances. NOT the full account model; NOT message-history mirroring (but see Phase 3 — with a shared fleet identity, inbound messages already land everywhere, so one honest sub-decision on outbound mirroring returns to the operator). |
| D2 | Delivery bug: **reproduce fresh** (crow↔black-swan test pair); do NOT forensically chase the original failure on the MacBook. |
| D3 | Contact-add UX = **share link + QR + short code**, all three. No LAN auto-discovery. |
| D4 | Priority: **interleave** — this arc now; Theme 10 (iOS PWA docs) rides along as a quick win; Themes 9 (Bot Builder UX) and 7 (black-swan E2E) wait, though Phase 4 here absorbs most of Theme 7's intent. |

## Groundwork (explored 2026-07-01, anchors verified @ main cbb7ea6)

Two full maps live beside this plan — read them before executing any phase:
- `~/crow/.superpowers/messages-plan/delivery-failure-map.md` — the DM send/receive trace and **12 silent-loss modes (L1-L12)**.
- `~/crow/.superpowers/messages-plan/contact-flow-map.md` — the pairing flow, friction points, data model, and the instance-sync fabric.

Headline facts the phases are built on:
- DMs are Nostr kind:4, NIP-44, published to **two hardcoded public relays** (`nostr.js:34`); user-configured relays are dead code (L4). No delivery receipt, no `delivery_status` column, sender UI reports success even when 0 relays accepted (`messaging.js:47`, `api-handlers.js:51-54`).
- No store-and-forward on the DM path: offline delivery = public-relay retention roulette (L1); the resubscribe window can drop out-of-order/older events (L2); a MacBook asleep at send time compounds both (L10).
- Plain DMs from a sender who isn't a contact row are **silently dropped** in `subscribeToIncoming` (`nostr.js:379-390`) — a half-completed contact handshake (L6, likely the real-world failure) makes all subsequent messages vanish.
- The whole receive path is wired inside `peerManager.start().then()` (`boot.js:164-240`; catch at :377-379) — if Hyperswarm start fails, the gateway runs **deaf forever** with no error surfaced (L11).
- The invite handshake's completion depends on the inviter being online at accept time (`boot.js:214-232`); no repair path exists.
- Contacts ARE in `SYNCED_TABLES` (`instance-sync.js:52`) with `lamport_ts` — as are `messages` and `relay_config` (`instance-sync.js:49-71`); the pull side of sync is wired for all three, but **no write path emits** `emitChange` for any of them.
- **Identity — fleet reality (checked live 2026-07-01):** the sync architecture REQUIRES paired instances in a chain to share one master seed (`docs/architecture/instances.md:164`; inbound sync entries are signature-verified against the LOCAL identity, `instance-sync.js:624-626`; the sync Hyperswarm topic derives from the local crowId, `peer-manager.js:99,128`). On the actual fleet: **crow and grackle share `crow:kdq7zskhat`; black-swan has its own `crow:1m5ughwje2`** — so crow↔grackle can sync tables today, black-swan cannot (its inbound entries would be dropped), and black-swan is a genuine *distinct-identity* DM peer, which Phase 1's harness needs anyway.
- QR-of-a-share-URL already exists for BOT invites (`bot-builder/editor.js:425-444`) — but note its own comment (:433-435): the link only opens on the *owner's* devices; it is not a cross-user path. Person invites have no URL, no QR, no short code, and can't be initiated from the Contacts panel at all.

---

## Phase 0 — Quick wins (independent; ship first, one small PR each)

**QW1 — A `--no-auth` gateway must never run the health monitor.**
Root cause of the "password requirement is turned off" push spam on Kevin's phone: grackle's hand-made loopback `crow-mcp-bridge.service` (127.0.0.1:3004, `--no-auth`) runs the full W2 health monitor and pushes its own exposure warn every dedupe cycle. Product fix: in `servers/gateway/boot/post-listen.js:169`, the monitor start condition also excludes no-auth mode — use the `noAuth` value already passed in the boot deps (`post-listen.js:23`), not a fresh argv parse. Log one line stating why the monitor is off. Test: boot-level or health-signals test case. Instance mitigation (drop-in `CROW_DISABLE_HEALTH_MONITOR=1` on grackle's unit) already handed to operator; the product fix supersedes it.
*Carry the product principle forward: give grackle's companion a first-class path (primary gateway `/llm/v1` + MCP token) so the band-aid bridge service can be retired.*

**QW2 — Fix the leaky test that hangs the whole suite.**
`tests/crow-accept-bot-invite.test.js` passes its assertions but its import chain spins up the real in-memory sharing client → live relay sockets keep the process alive forever (hung a bare `node --test tests/` for 44 min on 2026-07-01). `handlePostAction` already accepts an injectable `sharingClientFactory` (`api-handlers.js:32`) — use it in the test; while there, fix the latent bug that the `send_peer` path calls `getSharingClient()` directly and ignores that injection param. Also fix the pre-existing env-dependent failure in `tests/health-signals.test.js:57` ("no backup dir → info" asserts `result.ok===true` while unrelated live signals can warn on real hosts — stub the environment deterministically).

**QW3 — Theme 10: iOS PWA docs (interleaved per D4).**
`docs/platforms/ios.md` (EN + ES): Tailscale iOS app → Safari → gateway URL → Add to Home Screen → enable notifications; cross-link from platforms index + README. Verify-while-there: `apple-touch-icon` PNG (manifest has only SVG), `sw.js` push/notification-click on iOS, safe-area/viewport. Scope was locked documentation-first on 2026-06-12 (PWA confirmed working on iPhone).

## Phase 1 — Delivery reliability: reproduce, instrument, harden

Goal: a DM either **arrives** or the sender **sees that it didn't**. Fresh reproduction on crow↔black-swan per D2 — black-swan's distinct identity makes it a real DM peer (two instances sharing a seed are ONE identity and cannot meaningfully invite/DM each other; any additional harness instances must be provisioned with isolated data dirs + fresh seeds).

- **R1 — Two-instance DM E2E harness** (the reproduce-fresh vehicle, and the arc's permanent regression net). Drives two real gateways (crow + black-swan), performs the full invite→accept→DM round trip over live relays, and asserts receipt. Instrument exactly what the failure-map calls for: both sides' connected-relay sets at send/subscribe time, recipient's contact row (exact 64-hex pubkey), sender's `published[]` count, recipient sub liveness. Scenario matrix: both-online; recipient-offline-brief (reconnect window); recipient-offline-long (relay retention); half-completed handshake (inviter offline at accept). Opt-in network test (env-gated), not part of the default suite.
- **R2 — Honest sender feedback.** Add `delivery_status` to `messages` (`pending` → `relayed(n)` → `delivered` → or `failed`); `crow_send_message` returns `isError` when `published.length === 0`; the dashboard send handler surfaces failures instead of `console.error`+redirect (`api-handlers.js:51-54`); message bubble shows state (single check = relayed; double = delivered via R5's ack; red = failed with retry affordance).
- **R3 — Resurrect configured relays (L4).** Wire `getConfiguredRelays()` into `connectRelays()`; make `crow_add_relay` real; show connected/failed relay state in Messages settings. This is also the L9 escape hatch (blocked default relays on a new network). Note `relay_config` is already in `SYNCED_TABLES` — once its writes emit (Phase 3 pattern), the user's relay set propagates across their instances for free.
- **R4 — Stop dropping unknown-sender DMs (L6) + de-fragilize the handshake (L3).** Plain DMs decrypted in `subscribeToIncoming` from a non-contact become **message requests** (stored, surfaced as "message request from crow:xyz — accept?") instead of vanishing. Abuse controls at the design level: check `is_blocked` first, cap stored requests per sender and in total, no per-request push (digest at most) — the `#p` filter accepts from anyone who learns your pubkey. `invite_accepted` processing gets an idempotent, persisted marker instead of the 24h `initialSince` cliff; add a manual "add by Crow ID + pubkey" repair path (tool + UI) so a half-state is recoverable without a fresh invite.
- **R5 — Offline delivery (the structural fix for L1/L10).** **Committed: delivery receipts + sender retry queue** — a `crow_social` ack envelope from the recipient; the sender re-publishes unacked DMs on a backoff schedule until acked or expired. (R2's `delivered` state and C4's robust handshake completion both depend on this; it is not optional.) **Open option, operator's call:** additionally run a **self-hosted always-on relay** to shrink the retry window to near-zero. Honest caveats: it only helps if BOTH sides use it — so the invite/contact handshake must start carrying relay hints (today it carries none) — and a relay reachable by non-tailnet contacts is a new public network surface (tailnet-only serves the household case; public serves the general case — invariant decision at phase design). Explicitly NOT chosen: repurposing the Hyperswarm peer-relay (`relay_blobs`) for DMs — a third path duplicating the receipts mechanism with more moving parts.
- **R6 — Reconnect-window correctness (L2/L7).** Persist per-contact last-received `created_at`; on resubscribe, backfill with generous overlap (dedupe is already safe via `nostr_event_id` UNIQUE); widen/replace the `lastSeen−120s` heuristic.
- **R7 — Observability.** Decrypt failures (L8) logged with a counter; a `messages` nest health signal (relays connected, last inbound event age, unacked outbound count) — reusing the W2 signal pattern.
- **R8 — Never run deaf (L11).** Decouple Nostr subscription wiring from Hyperswarm start success: wire subscriptions independently of `peerManager.start()`, retry failed starts with backoff, and surface a loud health-signal/notification when the receive path is down. Today a single Hyperswarm failure at boot silently kills all message receipt until restart.

## Phase 2 — Contact adding: no more copy-paste gymnastics

- **C1 — Invite links + QR.** `crow_generate_invite` output gets a URL wrapper + QR (generalizing the bot-invite QR plumbing) and a proper share sheet in the UI. **Open design decision (phase design, flagged for the invariant):** where does a cross-user link land? (a) *Recipient-side accept*: the link/QR payload is the code; scanning/opening it on a device with the recipient's own Crow (PWA/dashboard) routes to THEIR pre-filled accept screen — honest, zero new public surface, but "one tap" only when their Crow is installed where they open it; (b) *Public landing page on the inviter's gateway* under a funnel-safe prefix (the fragment keeps the code off the server logs) that walks the recipient through accepting on their own Crow — smoother for first-timers, but a new public surface requiring an explicit network-exposure-invariant decision. Either way: fragments don't protect the code in transit through whatever messenger carries the link — short expiry does the real work; say so in the UI copy.
- **C2 — Short codes without a rendezvous server.** 8+ char (≥40-bit-entropy) one-time code; both sides derive a keypair from the code (KDF), inviter publishes the encrypted invite payload as a replaceable Nostr event, acceptor types the code, derives the same key, fetches and completes. **Security guardrails set NOW (the event sits on public relays and the code-derived key is also the event's signing key — a cracked code enables a pairing MITM, not just a privacy leak):** entropy floor ≥ ~40 bits (8+ chars of a real alphabet — "6-8" is not acceptable at the low end), memory-hard KDF (argon2id-class), expiry in **minutes**, inviter-side single-use rejection, and C4's safety-number verification named in the UI as the explicit MITM backstop. Adversarially review this component hardest at phase design.
- **C3 — One surface.** The Contacts panel gets the full peer-add flow (it's the natural place and today can't add peers at all); Messages keeps its entry point. Both funnel to the same component. Kiosk guards stay.
- **C4 — Robust completion + trust UI.** Accept becomes idempotent and repairable (pairs with R4's message-requests + add-by-id). The inviter-offline case completes via R5's committed retry/ack machinery instead of one fire-and-forget DM. Surface the safety number (computed today, shown nowhere) on the contact detail view with a "verified" checkmark the user can set.

## Phase 3 — Contacts follow the user (D1)

**Fleet precondition (from the identity fact above):** contact sync rides instance-sync, which only works between instances sharing one seed. crow+grackle already qualify; **black-swan (and any future instance meant to be "the same user") needs the documented `identity:export`/`identity:import` unification first** — OR stays a deliberately separate identity (it's the Phase-1 test peer; unify it only after Phase 4's wipe/rebuild). The wife's MacBook is its own person/identity and is NOT part of this sync domain.

- **S1 — Emit + apply.** Add `emitChange("contacts", …)` at every contact-write site (`contacts.js` inserts, `boot.js:220` auto-add, `contacts/api-handlers.js` manual/edit/block); `contacts` is already in `SYNCED_TABLES` with `lamport_ts` conflict resolution. Post-apply hook: a synced-in contact must also get `syncManager.initContact` + `subscribeToContact` + topic join on the receiving instance (correct because the fleet shares one identity — the contact's DMs are addressed to the shared pubkey). Named test case: multi-instance `invite_accepted` races — several instances auto-add and emit the same contact; `crow_id UNIQUE` + lamport resolution must converge without conflict spam.
- **S2 — Groups + blocks ride along.** Add `contact_groups`/`contact_group_members` to the synced set. Blocks propagate (a block on one instance is a block everywhere — which also strengthens R4's abuse controls fleet-wide).
- **S3 — Conversation coherence (the honest consequence of shared identity).** Because the fleet is one identity, once S1 subscribes every instance to every contact, **inbound** messages land on ALL instances — while **outbound** messages exist only where they were typed. Conversations read half-mirrored, which will look like a bug. `messages` is already in `SYNCED_TABLES`, so outbound mirroring is one `emitChange` away. **Operator decision (revisits the D1 "no message mirroring" line with better information):** (a) mirror outbound too → every instance shows the same coherent conversation (recommended — this is what "stupidly simple" implies); (b) keep outbound local → document the asymmetry and mark remote-sent messages in the UI. Also design the duplicate-processing story: multiple online instances receiving the same inbound DM must produce ONE notification to the user's devices, not one per instance (dedupe by `nostr_event_id` at the push layer, or a primary-notifier flag).
- **S4 — UI.** Contact rows show origin/sync state subtly; conflicts surface through the existing `sync_conflicts` path.

## Phase 4 — E2E campaign (absorbs Theme 7's intent for messages)

Wipe black-swan (operator: no backup needed, per 2026-06-12), fresh install as a guided walkthrough with Kevin, then crow drives the `browser` bundle against black-swan's dashboard — watchable over VNC — through the NEW flows: onboarding → pair instances → add contact via link/QR/short-code → DM both directions → offline/wake scenarios → contact visible on second instance. Findings feed a fix list. R1's harness runs headless alongside as the repeatable regression. Deadman-cap rule applies to any stage that degrades a prod service. **Sequencing note:** the wipe destroys the Phase-1 harness peer and any R5(a) relay hosted there — schedule Phase 4 after Phase 1-3 regressions are green, re-provision the harness peer as part of the fresh install, and only consider black-swan seed-unification (Phase 3 precondition) AFTER the wipe, not before.

---

## Sequencing & delivery

Phase 0 (three small PRs, immediately) → Phase 1 → Phase 2 → Phase 3 → Phase 4.
Each phase: exploration is DONE (maps above) → execution plan (writing-plans format) → 2-round adversarial review → subagent-driven execution → per-task + final review → PR (operator gate) → deploy fleet-wide (auto-update is pull-only; push main to origin + verify instances pulled).

Open decisions for the operator (none block Phase 0; the first two land at their phase's design time):
1. **R5(a)** — add a self-hosted always-on relay (and if so, tailnet-only vs public — invariant call)? The receipts+retry mechanism ships regardless.
2. **C1** — recipient-side accept only, or also a public invite landing page (invariant call)?
3. **S3** — mirror outbound messages for coherent conversations (recommended), or document the asymmetry?
4. **Black-swan seed unification** — after Phase 4's wipe, should black-swan join the user's identity domain, or stay a permanent distinct-identity test peer?

Standing constraints: fix-the-product-not-the-instance (everything must work on a fresh single-click install); network-exposure invariant (no new public surfaces without an explicit decision — two candidates are flagged above); commit with positional paths; check-runs gate before merges.

## Review

**Round 2 (2026-07-01, adversarial subagent): one leftover — C2's lead-in still said "6+ char" while its own guardrail requires 8+; fixed. Everything else verified internally consistent (identity story across all phases, R5-commitment dependencies, C1/C2 coherence, Phase-0 code claims re-verified against source).**

**Round 1 (2026-07-01, adversarial subagent, fable): REVISE — all 5 criticals addressed:**
1. S3's "each instance has its own keypair" premise was WRONG — the architecture mandates shared seeds per sync chain (`instances.md:164`, `instance-sync.js:624-626`), and a live fleet check confirmed crow+grackle share `crow:kdq7zskhat` while black-swan is distinct. Phase 3 rewritten around the real model (precondition, coherence consequence, notification dedupe); the false (a)/(b) identity dichotomy removed.
2. C1's cross-user invite link contradicted the network-exposure invariant (inviter's gateway is private; the bot-QR precedent is owner-devices-only by its own comment). Rewritten as an explicit two-option invariant decision; "three taps" de-oversold; fragment-in-transit honesty added.
3. R5's receipts+retry was optional-on-paper but hard-required by R2 (`delivered`) and C4 (offline completion) — now committed; only the self-hosted relay remains an option, with the relay-hints-in-handshake gap and public-surface tension stated.
4. L11 (receive path dies silently with Hyperswarm) — one of the map's four most-likely real-world causes — had no fix item; R8 added.
5. C2's 6-char floor (~31 bits) was brute-forceable on public relays within its own expiry, and a cracked code = pairing MITM (the code-derived key signs the replaceable event). Guardrails set at master level: ≥40-bit entropy, memory-hard KDF, minutes-scale expiry, single-use, safety-number backstop.
Suggestions adopted: QW1 uses the existing `noAuth` boot dep; QW2 notes the injectable `sharingClientFactory` + the latent `send_peer` injection bug; R1 requires distinct-seed provisioning (black-swan qualifies today); `messages`/`relay_config` already-synced facts surfaced (R3 free propagation; S3 one-emit-away decision); R4 abuse controls named; S1 idempotency race named as a test case; Phase 4 wipe vs harness-peer/relay roles sequenced; reviewer question about the fleet's seed state answered by direct fleet check instead of deferring to the operator.
