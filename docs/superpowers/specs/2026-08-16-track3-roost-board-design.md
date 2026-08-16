# Track 3 — Roost on the Board: Perch launcher/roost rework (design)

**Date:** 2026-08-16 · **Status:** post adversarial review ×2 (r1 + r2 fixes applied)
**Arc:** board-as-truth + visual language (scope doc: Gitea `kh0pp/crow-engineering`,
`specs/2026-08-08-board-truth-and-visual-language-scope.md`). This spec is Track 3 —
the board × Perch merge, shape A (scope decisions 4, 5, 7) — entered through the
Perch launcher/roost complaint (memory `crow-perch-launcher-rework-brainstorm-queued`).

Implementation branches from **current `origin/main`** (Track 2 merged there —
`PERCH_TOKENS`, the drift test, and the token sweep this spec cites exist only on
main, not on older session bases).

## 1. Problem

The Perch "spawn on crow" button spawns pi in a detached tmux session
(`bundles/perch-hub/payload/lib/sessions.mjs` `spawnSession()`); the only "open"
affordance is a `tmux attach` string. "Roost — recent sessions" lists on-disk
`~/.pi/agent/sessions/*.jsonl` files, so a fresh (especially prompt-less) spawn is
invisible there. The launcher thinks in tmux + filesystem — pi-lab's personal
workflow — while the product now has perch-live interactive sessions with real UI
(P2: spawn-as-bot, streaming, ask_user over RPC, hibernation), a configurable board
with `board_*` verbs, plans-as-records, per-card autonomy, and mutation provenance
(Tracks 0/1), and the Perch palette owned Crow-side as `PERCH_TOKENS` (Track 2).

Verified structural facts this design builds on (re-verified in adversarial r1/r2):

- The tmux launcher is an island: `spawnSession`/`listTmuxPiSessions` are used only
  by the hub home lens itself (`payload/hub/server.mjs`). Nothing Crow-side depends
  on them.
- The Crow panel embeds only the bots lens (`/proxy/perch-hub/bots`,
  `servers/gateway/dashboard/panels/perch.js`); the home lens is a separate page
  reached through the proxy.
- `bot_sessions.card_id` exists and is rendered as a board deep-link by the bots
  lens, but the interactive engine (`servers/gateway/perch-interactive.js`) never
  writes it. The **job rail does** — `handleInbound` writes `kind='chat'` rows
  with `card_id` that deliberately rest at `waiting-user` when the turn didn't
  report a result (`bridge.mjs`).
- Tool narrowing on `kind='perch-live'` sessions is refused **client-side only**
  (the vendored lens gates it, `bots-page.mjs:316-325`); the gateway narrow route
  (`routes/perch.js:742`) already accepts perch-live rows. Narrowing binds at
  spawn (`--tools` is fixed per process; pi has no RPC set-tools command), so on
  an awake session a change takes effect at the next wake.
- The board lock rail (`routes/board-lock.js`) computes card locks from the
  newest `bot_sessions` row per card with status in `{active, waiting-user}` —
  and both the interactive engine's resting status **and** the job rail's
  no-result resting status are `waiting-user`.
- pi's bot-policy gate (`pi-lab extensions/permission-gating.ts`) is
  block-or-pass: `confirm[]` is a hard block with "surface in your reply," not an
  interactive ask. The interactive-UI path over RPC (`ctx.ui` → `hasUI` true in
  RPC mode) is real and already carries ask_user and destructive-op confirms.

## 2. Decisions

Kevin, this brainstorm, 2026-08-16 (T3-1…T3-8); r1/r2-marked rows were forced by
adversarial review and are called out for Kevin's spec review:

| # | Question | Decision |
|---|---|---|
| T3-1 | Scope | **Full Track 3** — this design is the whole shape-A merge; execution phased. |
| T3-2 | Spawn model | **Card-optional.** Dispatch-onto-card is the primary, tracked path; free chat from the roost needs no card; a free chat can attach to a card later. |
| T3-3 | Old lens fate | **Retire in Crow.** The hub home lens (tmux spawn, filesystem roost, "On the wire" registry) stops being served under Crow; pi-lab keeps the personal workflow upstream. |
| T3-4 | Chat surface | **Crow-native on the board.** The chat client is rebuilt as board UI (session drawer); the iframe, the vendored bots lens, and the perch-hub bundle retire. |
| T3-5 | Dispatch rail | **Perch-live bound to the card.** Dispatch spawns an interactive session carrying `card_id`; the card bubble renders by `card_id`, so job-rail runs that carry it show there too. The batch job rail stays for channel-driven bots. |
| T3-6 | Capacity | **`MAX_AWAKE` default 3**, still a config knob. |
| T3-7 | Drawer parity | The drawer carries the full June/July session-web feature set (§4). |
| T3-8 | Per-turn perch channel | **Retire** `POST /bots/:id/turn` + per-turn SSE with the lens; `kind='perch'` history rows stay readable; the perch *attachment* concept stays (it gates dispatch/interactive). |
| T3-9 (r1/r2) | Which sessions lock cards against human moves? | **Only mid-turn ones.** Session-rail locks come from `status='active'` rows only, and `kind='perch-live'` rows never contribute. `waiting-user` *history* no longer locks human moves — a deliberate product change; today a card with any un-reported chat/job history is humanly immovable forever, which also breaks this design's Accept move. Job-rail (`bot_jobs`) locking unchanged. |
| T3-10 (r1/r2) | How do mode/narrowing changes bind? | **At spawn.** The engine owns session state and applies it when it builds the child. Mid-session changes bind via a **cycle** (hibernate → immediate wake, transcript preserved by resume) — **refused while a turn is in flight or an ask_user card is pending**; the drawer disables "apply now" then. Model changes are live via RPC `set_model`. |
| T3-11 (r2) | Permission-mode vocabulary | **guarded / ask / bypass** — not the personal UI's four. The bot-policy schema is block-or-pass; "accept-edits" and "auto" have no distinguishable representation there ("auto"'s classifier belongs to the personal permission-modes extension, which self-disables in bot processes). "ask" requires a pi-lab permission-gating change (§4.1.4). |

## 3. Product shape

The **bot-board panel** becomes the single surface for work and the birds that do
it. Perch survives as vocabulary (roost, birds, perch-live) and as the
`PERCH_TOKENS` palette, not as a place. Bot Builder stays a page (scope decision
7), reached from the roost.

### 3.1 Roost strip

One bird per bot def, in a horizontal strip across the top of the cards board
(birds-on-a-wire motif, drawn in `PERCH_TOKENS`). Replaces the bots lens. States:

- **idle** — no live session.
- **working** — awake, turn in flight (subtle animation).
- **waiting on you** — pending ask_user card, permission confirm, or gated result;
  loudest state (badge + push).
- **hibernating** — session exists, asleep; wakes on next message.
- **observing** — perch gateway not attached; dimmed; its action is "Attach in Bot
  Builder" (relocates the Track 2 callout).

One **primary action per bird, state-dependent**: idle → *Send out* (card picker →
dispatch); working/hibernating → *Open*; waiting → *Answer* (drawer scrolled to the
pending card). An overflow menu carries *Talk* (free chat), *Sessions* (history,
inside the drawer), *Recall* (stop a session — releases its card, §5.1), *Setup*
(Bot Builder deep link).

### 3.2 Birds on cards

A session carrying `card_id` renders the bird on that card's face with the same
state glyph; clicking opens the drawer with the card context header. Strip bird and
card bird are the same session, two vantage points. A bird can hold multiple
sessions (a card session + a free chat); the strip glyph reflects the most
attention-worthy one, in priority order **waiting-on-you > working > hibernating >
idle**; the drawer's session switcher lists the rest.

Two sessions of one bot share the bot's working directory (per-bot `sessionDir`,
`bot-world.mjs`). pi session files are distinct, but `.mcp.json` content varies
per world build (the job rail bakes this turn's job id into the board entry's
headers), so concurrent builds race: **in-gateway world builds are serialized per
bot** (async mutex). The residual cross-process race with the external bridge
tick is pre-existing and out of scope, named here so nobody assumes isolation.

**Free-chat working directory:** a card-less spawn for a def with no resolvable
session directory (no project workspace, no `def.session_dir`) is **refused** with
a clear error pointing at Bot Builder — today's world builder would silently
create a literal `undefined/` directory under the gateway cwd (reproduced live).

### 3.3 Capacity behavior

With 3 awake slots, dispatch at capacity auto-hibernates the **idlest safe
victim**: an awake session that is not mid-turn and has no pending ask_user card,
longest-idle first. If no safe victim exists, dispatch refuses honestly with
`interactive_capacity` and the drawer explains who is busy. The host-wide pi
budget (`pi_capacity`) remains a separate, honest refusal — auto-hibernation
cannot free channel-turn pi processes. The free-then-reserve sequence holds the
slot **synchronously** before any await (the engine's reserveSlot doctrine);
likewise the per-card occupancy claim (§5.1) is a synchronous in-memory claim, not
a read-then-await check.

## 4. The session drawer

Right-side slide-over on the board panel; board stays visible behind it.
Crow-native client (template-literal emission rules; all new strings EN+ES via
the translation helpers — see §8 on why the parity gate alone is not coverage).
Deep links use the board client's existing **hash-based** state: `#bird=<sessionId>`
opens the drawer (the `?card=` query param keeps its current no-JS full-page
contract, untouched). Push click-URLs target `/dashboard/bot-board#bird=…` and
require `NTFY_CLICK_BASE_URL`/`CROW_GATEWAY_URL` to be set, else clicks fall back
to the nest.

**Header.** Bird name + state badge. Card-bound: card title (link), autonomy badge,
plan link if present. Free chat: **"Attach to card…"** — picking a card writes
`card_id` plus a provenance mutation row (actor = human). Session switcher for the
bird's other sessions.

**Transcript.** Streaming pane over the existing per-session SSE channel:
messages, tool activity lines, and system notes for every model / thinking /
permission-mode / plan-state change (mode overrides are always on the record).
Question cards render inline. Bot-produced images/files render as previews /
download links. Copy button on each bot response.

The SSE client **auto-reconnects** with the engine's subscribe-replay (current
state + pending card re-emitted on every subscribe), so a dropped stream or
gateway restart recovers without reload. Rows a shutdown parks mid-turn get a
**distinct interruption marker** (today they park as plain `waiting-user`,
indistinguishable from normal rest — the engine's stop path is changed to mark
them), and the drawer renders "turn interrupted by gateway restart" from it.

**Composer.** Textarea + file/image upload + send. While a turn runs, the composer
stays live as **steer** (pi's native steer, labeled so) with Abort beside it. Stop
(end session) in the header overflow.

**Controls row** (compact, above the composer): model picker, thinking level,
permission mode (guarded / ask / bypass — T3-11), plan mode toggle. Collapsible
**controls pane**: envelope view (tools/model/skills) + per-session narrowing
checkboxes with the existing tri-state saved-narrowing semantics. Spawn-bound
controls (permission mode, narrowing) are labeled with when they bind (T3-10) and
offer "apply now" (cycle; disabled mid-turn or with a pending question).

**Result gate — explicitly two-step.** When the bird calls `board_report_result`
on a gated card, drawer and card face show the result awaiting decision.
**Accept** = `board_decide_result(accept)` **then the client moves the card** to
its terminal status as the human actor (`board_decide_result` never moves cards —
Track 1's contract; T3-9 is what keeps the move possible). **Reject** =
`board_decide_result(reject)`; the card stays and the bird remains available for
follow-up. Auto-autonomy cards show the outcome; the bot self-closes per Track 1.
Card-face mechanics: the kanban SSR result join must additionally project the
**result id** the decide POST needs; face buttons are excluded from the card's
click-to-open and dragstart handlers; the existing pinned result-gate substrings
test is preserved through any shared-code refactor.

**Hibernation.** A hibernating session opens instantly showing its transcript with
an "asleep — sending will wake it" banner; sending wakes it with state re-applied
(§5.3).

### 4.1 Feature parity list (carried from the June/July session-web UI)

1. **Question cards** — select / input / confirm / editor via the P2 gateway API.
   Binding contract preserved: select options are pre-rendered verbatim strings,
   echoed back untouched, never parsed or re-composed; multi-select is one call per
   pick; answered cards collapse to "Answered: <label>".
2. **Model picker** — `get_available_models` / `set_model` over RPC (live). The
   **engine tracks the current model** by consuming pi's `model_select` RPC
   events (the only observable event; `model_change` is a session-file entry
   type), and:
   - re-applies the tracked model at every wake (pi restores the session-file
     model only when no CLI model is passed, and `PiRpc` always passes one — so
     wake passes the *tracked* model, which also avoids the bridge's unproven
     resume-across-model-change path);
   - updates the metering basis (`s.resolved`) so usage/audit rows price the
     model actually serving the turn;
   - **warms cold local models itself** via the gateway's existing
     `warmModel`/acquire path before issuing `set_model` — pi-lab's local-models
     extension self-disables in bot processes ("bots must not manage model
     servers"), so pi will not start the server for us.
3. **Plan mode** — the pi-lab extension runs fine in bot processes (verified: no
   bot gate; state persists in the session file and restores on resume). The
   drawer mirrors live plan state via the **rpc-state-bridge** (§5.2, a committed
   deliverable). Plan-step / plan-next cards render as question cards.
4. **Permission modes (T3-11)** — guarded / ask / bypass, **engine-owned** (the
   pi-lab permission-modes extension self-disables whenever
   `PI_BOT_PERMISSION_POLICY` is set, i.e. every bot spawn, and never overrode
   the pinned policy anyway). The engine composes the policy environment per mode
   at spawn/wake; changes bind via cycle (T3-10). The modes, honestly scoped to
   what the policy schema plus one pi-lab change can express:
   - **guarded** (default): the bot's configured policy as-is — blocks are final
     and surfaced in the reply, exactly today's behavior.
   - **ask**: policy blocks convert to interactive confirms in the drawer. This
     requires a **pi-lab permission-gating change** (second committed pi-lab
     deliverable): under `PI_BOT_INTERACTIVE=1`, a would-be policy block raises
     `ctx.ui.confirm` instead — the RPC UI path is verified real and already
     carries ask_user and destructive-op confirms. Fail-closed: no answer =
     block.
   - **bypass**: relaxes the *policy* protections for that session only —
     `write_paths` confinement and draft-only-send gating — nothing else.
   - `--no-approve` stays pinned in **every** mode — the GHSA-mqxh vector is
     never reopened, including under "bypass".
   - Dashboard-authed operator only; every mode change is a visible system note
     in the transcript.
5. **Thinking level** — `get_available_thinking_levels` / `set_thinking_level`
   (live over RPC).
6. **Files & images, both directions** — uploads land in a **per-session**
   directory (`<botDir>/.pi/uploads/<sessionId>/`) so concurrent sessions never
   collide; images ride the next prompt inline (RPC `prompt.images`, base64 — no
   path dependence for vision). Bot-produced deliverables go to a named
   per-session outputs directory (`<botDir>/outputs/<sessionId>/`) that the
   dispatch/system context tells the bot about; the transcript renderer links
   files under it. The engine **appends the outputs directory to the session's
   `write_paths` policy copy at spawn/wake** (selfAuthoringDir-style) — without
   that, default policies block the bot from writing its own deliverables.
7. **Copy buttons** on bot responses (client-side).
8. **Envelope + narrowing controls** — on perch-live: server-side acceptance
   already exists (§1); the change is the client plus honest binding semantics —
   narrowing binds at wake (T3-10), and the engine already re-applies saved
   `narrowed_tools` at every world rebuild.
9. **Push notifications** — via Crow's existing push subsystem, as a **new
   notification type** (`attention`; agent-end rides it at normal priority,
   blocking events at high). Adding a type is a registry change with named
   touch-points: `servers/shared/notifications.js` (type gate),
   the notifications settings section (per-type UI, hand-unrolled),
   `servers/memory/server.js` + `tool-manifests.js` type lists, i18n labels
   EN+ES, and an ntfy `TAG_MAP` entry. **Back-fill migration** (guard-flagged,
   idempotent): append the new type to every persisted `types_enabled` whitelist
   — without it, every install that ever saved notification settings silently
   never receives these. Email: the new type is **excluded from email** (a type
   filter in the email decision — today any high-priority push also emails on
   MPA-configured instances). Web-push ignores priority; acceptable, noted.
   Click-URLs deep-link per §4. pi-lab's `notify.ts` self-disables in bot
   processes and stays out.

## 5. Engine & API changes

### 5.1 Card binding, occupancy, and the lock rail

- `spawn` accepts an optional card; the engine writes `card_id` on the
  `bot_sessions` row. Dispatch sets `assigned_bot` on the card with a provenance
  mutation (actor = human).
- **Lock rail (T3-9):** session-rail locks are computed from `status='active'`
  rows only, and `kind='perch-live'` rows are excluded entirely. This (a) keeps
  the human Accept move possible on dispatched cards, (b) unfreezes cards whose
  only "lock" is stale `waiting-user` history (named product change), and (c)
  removes the newest-row shadowing order-dependence. Job-rail (`bot_jobs`)
  locking unchanged.
- **Occupancy (one bird per card):** dispatch and attach-card refuse (409) when
  the card has (a) any `status='active'` session row (any kind/rail — never two
  pi processes on one card), (b) an active job-rail lock, or (c) a non-stopped
  (`awake` or `hibernating`) perch-live session already carrying this `card_id`.
  Defined over **statuses, not rails** — `waiting-user` history never blocks.
  The claim is a **synchronous in-memory per-card claim** (the engine's
  `adopting`-map pattern), not a read-then-await check — two concurrent
  dispatches must not both pass.
- **Release:** *Recall* (stop) on the strip/card ends a session and releases its
  card — the affordance that prevents an abandoned hibernating bird holding a
  card forever.
- The dispatch opening context (card title/description, plan record, briefings)
  is composed by a **shared card-brief builder** extracted from the job rail's
  dispatch prompt. Byte-identity is scoped to the shared card/plan/project block;
  the per-gateway hint and the "User said:" line are parameterized inputs that
  legitimately differ per rail (golden-tested at that scope, §8).

### 5.2 Control passthrough & state mirror

- Engine methods for `set_model`, `set_thinking_level`, and listing options ride
  the native RPC commands — `PiRpc.send()` is already generic; the work is
  correlated response waiters for the new command types.
- **Slash commands are ack-only.** A prompt-routed extension command (e.g.
  `/plan`) is handled at preflight and produces a correlated command ack but
  **no agent loop and no `agent_end`** — the engine sends them outside
  `promptTurn`'s turn-correlation (fire, confirm ack, done). Routing one through
  a normal turn would hang the stall watchdog and kill a healthy child.
- **rpc-state-bridge (committed pi-lab deliverable):** a small `crow-mode`
  extension forwarding the extension-bus states the drawer needs (today:
  `plan-mode:state`) to RPC stdout over the extension-UI channel, using a
  **distinct method name** the engine routes as state events — never as
  transcript log lines (the engine currently renders unknown notify frames into
  the transcript; the discriminator is part of the contract). The extension bus
  is in-process only — without this bridge no bus state reaches the engine.
  Permission-mode state does **not** ride the bus: the engine owns it (§4.1.4)
  and emits it directly.
- Mode / plan / model state changes stream to the drawer over the existing SSE
  channel as state events; current state is re-emitted on every subscribe
  (existing replay pattern), so a reopened drawer is never stale.

### 5.3 Wake fidelity

A wake restores model, permission mode, plan state, and narrowing — each by its
actual mechanism, none by assumption:

- **Model:** engine-tracked and re-applied (spawned with the tracked model —
  §4.1.2; pi's session-file restore is overridden by CLI model flags, so the
  engine is the source of truth).
- **Permission mode:** engine-owned; composed into the policy environment at
  every spawn/wake (§4.1.4).
- **Plan state:** persists in pi's session file and restores on resume
  (verified); live mirror via rpc-state-bridge.
- **Narrowing:** the engine re-applies saved `narrowed_tools` at every world
  rebuild (existing behavior, verified).

### 5.4 Capacity & notifications

`DEFAULT_MAX_AWAKE` 1 → 3 (knob stays). Dispatch at capacity follows §3.3
(safe-victim auto-hibernate with synchronous slot handover, honest refusal
otherwise). Engine events feed the push subsystem (§4.1.9).

### 5.5 Gateway API surface

All under the existing dashboard-authed mounts (`/dashboard/perch-api` rails):

- `POST /interactive/:sid/control` — model / thinking / permission mode / plan
  mode; `GET /interactive/:sid/options` — models, thinking levels.
- `POST /interactive/:sid/files` — upload into the session's per-session uploads
  directory (§4.1.6).
- `GET /interactive/:sid/workspace/<path>` — serves **only** the per-session
  outputs directory (§4.1.6), realpath-jailed there, dotfiles excluded. The
  bot's working directory at large — `.mcp.json` (carries minted tokens),
  `sessions/*.jsonl` transcripts, `.pi/` — is **never servable**.
- `POST /bots/:id/dispatch` `{card_id}` — spawn bound session (occupancy rules,
  §5.1).
- `POST /interactive/:sid/attach-card` `{card_id}` — free chat → card, with
  provenance; same occupancy rules as dispatch.
- Narrowing route: no server change needed (already accepts perch-live); the
  drawer becomes its client.
- **Retired:** `POST /bots/:id/turn`, `GET /turns/:turnId/events` (T3-8).
- Kept and reused by the new UI: `GET /bots`, `GET /bots/:id/sessions`,
  `GET /bots/:id/envelope`, transcript reads, interactive
  message/events/answer/abort/stop.

### 5.6 Board side

Live bird state is **engine-sourced, not DB-derivable**: awake-at-rest,
hibernated, and interrupted rows can all read `waiting-user`, and "waiting on
you" (pending ask) is in-memory only — so the strip/card state endpoint and the
board payload merge `bot_sessions` rows with the engine singleton's live state.
The board's realtime channel gains a **named SSE event** for bird-state
transitions with a real DOM patcher (the `board-config` event precedent) — bird
changes must NOT ride the existing snapshot-diff event, whose client response is
a full `location.reload()` (reload storms). Board API contract holds: def
envelopes are JSON strings; items expose title as label. SSE budget note: board
stream + one drawer stream per open session share `CROW_SSE_MAX` (default 200) —
roughly double today's per-tab use; the default holds, noted for tuning.

## 6. Retirement & migration

**Deleted:** the perch-hub bundle wholesale (vendored payload: home lens, bots
lens, hub daemon, registry), the `perch-runtime.js` supervisor, the
extension-proxy mount for it, the Perch panel + nav entry, the per-turn chat
endpoints, `scripts/vendor-perch.mjs` and the vendoring dance.

**Retirement inventory (r2 — wave 3 is red without every item):**

- **Importers of the deleted modules:** `routes/bundles.js` (top-level import of
  perch-runtime), `index.js` gracefulShutdown (`stopPerchRuntimeBounded`),
  `boot/post-listen.js` (`initPerchRuntime`), and `panels/perch.js` consumers —
  `bot-builder.js`, `bot-builder/wizard.js`, `bot-builder/api-handlers.js`,
  `dashboard/index.js`. The bot-builder "perch not installed" banner/gate
  feature **retires with the bundle**: with no bundle to install, Bot Builder's
  perch affordance reduces to the attachment state (attach/detach the perch
  gateway), which the roost already surfaces.
- **Tests:** retire whole-file `tests/perch-runtime.test.js`,
  `tests/perch-panel.test.js`, `tests/vendor-perch.test.js`,
  `tests/perch-attach-warning.test.js`, `tests/perch-token-drift.test.js`;
  excise the perch sections of `tests/gateway-shutdown.test.js` and
  `tests/bundles-webui-lifecycle.test.js`; remove the per-turn tests in
  `tests/perch-routes.test.js` (incl. its `docs/developers/perch-hub.md`
  existence assertion) and the per-turn refusal case in
  `tests/perch-interactive-routes.test.js`. Suite floor is re-baselined by
  the replacement coverage in §8.
- **CI static checks:** edit `tests/i18n-global-parity.test.js`'s
  `IDENTICAL_OK` (`nav.perch`), remove the ~22 orphaned `perch.*` i18n keys +
  `nav.perch` in both languages, and **regenerate `registry/add-ons.json` via
  `npm run build-registry` in the same commit** (`--check` fails CI on drift).
- **Docs:** remove the `developers/perch-hub` sidebar link from
  `docs/.vitepress/config.ts` and retire the page (dead links fail the docs
  build); rewrite the Perch walkthroughs in `docs/guide/bot-builder.md` **and**
  `docs/es/guide/bot-builder.md`; sweep inbound references in
  `docs/developers/bot-engine.md`. A final repo-wide sweep for
  `perch-hub|perch-runtime|panels/perch` closes the wave.

**Ports:** Crow's perch-hub allocation is **4210 / 4211, registry pool
4141–4179** (`perch-runtime.js`). Those rows are removed from
`docs/developers/port-allocation.md` by hand — `check-ports` verifies compose
ports are documented, it does **not** flag stale doc rows, so this is a manual
edit, not gate-enforced. The standalone lab pi-hub numbers (4200-family) appear
only in that doc's prose bullet and are not touched.

**Drift test:** `tests/perch-token-drift.test.js` retires with the payload.
`PERCH_TOKENS` survives as the palette for strip/birds/drawer; the token-bypass
sweep covers the new Crow-native files automatically (it walks the dashboard
render tree).

**Migration:** `perch-runtime` keys "installed" on the payload directory existing
on disk, not on `installed.json` — and on crow the bundle is present in neither
(verified live). The guard-flagged, idempotent boot migration therefore: removes
the stale payload directory and the minted perch-token file **where present**, and
removes any `installed.json` entry if one exists. r4's install state must be
checked during implementation before finalizing the guard. The notifications
back-fill (§4.1.9) rides the same migration pass. History rows (`kind='perch'`
and old sessions) stay readable; nothing is deleted from the database.

**Deploy:** rides routine fleet deploys + r4 auto-update. Wave ordering (§7)
means the new door exists before the old panel disappears; an old panel iframe
open across the deploy dies with the bundle — acceptable, it reloads into the new
board surface. No schema change expected (`card_id` exists; the interruption
marker of §4 uses the existing status/control fields); if that changes, the
manual migration rail rule applies (`scripts/schema-migration-dryrun.sh` from the
branch).

**pi-lab upstream** keeps its hub and personal tmux/filesystem workflow; Crow
stops embedding it. This track requires **two pi-lab `crow-mode` deliverables**:
the rpc-state-bridge extension (§5.2) and the permission-gating interactive-ask
change (§4.1.4) — both follow the pi-lab commit discipline (edit in `~/pi-lab`
on `crow-mode`, push to Gitea). No payload vendoring is involved since the
payload is being deleted.

## 7. Phasing (one branch from origin/main, SDD tasks in three waves)

1. **Engine + API** — lock-rail change, card binding + synchronous occupancy,
   control passthrough (ack-only commands), model tracking + warm-on-switch +
   metering, engine-owned permission modes + pi-lab interactive-ask,
   rpc-state-bridge, cycle guards, capacity safe-victim, per-bot world-build
   mutex, free-chat cwd refusal, outputs write_paths append, notifications type
   + back-fill, shared card-brief builder, interruption marker. Fully testable
   headless.
2. **Board UI** — roost strip, birds on cards (named SSE event + DOM patcher),
   drawer with the full parity list.
3. **Retirement** — the full §6 inventory: bundle, panel + importers, per-turn
   channel, tests, i18n keys + parity allowlist, registry regen, docs (EN+ES),
   ports doc, migration.

The new door opens before the old one closes; no dead window.

## 8. Testing

**Engine, headless** (P2 mock-pi harness pattern): control passthrough
round-trips including correlated waiters for new command types; ack-only command
send (a `/plan` never enters turn correlation — asserted by a test that would
hang/watchdog if it did); state re-emit on every subscribe; wake fidelity
(hibernate → wake → assert model/mode/narrowing actually re-applied to the
respawned child's argv/env, not just recorded); model tracking updates metering
basis after `set_model`, and switch-to-cold-local-model warms via the gateway
path; **cycle guards** — "apply now" refused mid-turn and with pending ask;
capacity — safe-victim selection skips mid-turn and pending-ask sessions,
refuses honestly when no victim, slot handover synchronous; card binding —
occupancy 409s per §5.1 on active-session, job-lock, and live-bird cases, and a
**concurrent double-dispatch test** proves the synchronous claim; **lock-rail
change** — a perch-live `waiting-user` row does not lock its card, a stale chat
`waiting-user` row no longer locks human moves, an `active` row still does;
free-chat spawn refused without a resolvable cwd; rpc-state-bridge frames route
to state events, never transcript lines; golden test for the shared card-brief
block (byte-identical across rails at the scoped block, hint/user-message
parameterized).

**API:** confinement tests that attack (traversal, symlink, absolute-path,
dotfile requests against the upload and outputs-serve jails; `.mcp.json` and
`sessions/*.jsonl` explicitly unreachable); attach-card writes the provenance
mutation row and honors occupancy.

**Client:** parse-the-emitted-script test for strip + drawer client (Track 0
lesson); SSE tests parse frames by event name; reconnect test (drop the stream,
assert replay restores state); bird-state transitions ride the named event and
never trigger the reload path; verbatim-echo contract test for question-card
options; result-gate substrings test preserved.

**System rails:** the i18n parity gate is dictionary-only — it never scans panel
sources — so new-string coverage is enforced by translation-helper discipline
plus a **source-scanning literal check for the new strip/drawer client files**
(new test); token-bypass sweep; migration idempotence (runs-twice-safe,
present-and-absent cases, notifications back-fill included); suite floor
re-baselined per §6's retirements with CI green on `suite`/`static-checks`/
`audit`; every new test mutation-tested, restores by edit (never `git
checkout`).

**Live acceptance** (once, by hand, on r4): dispatch a real bird onto a real card,
steer it, answer an ask_user card, receive the push, gate a result — and move
the accepted card, proving T3-9 end-to-end.

## 9. Out of scope

Track 2's later waves (inline-CSS long tail, bundle UIs, blog); the models-manager
resume flake; r4-assistant's stale tool list; anything touching the Funnel /
network-exposure invariant (requires named approval); voice/companion channels
(they keep their own loop); the pre-existing cross-process `.mcp.json` race with
the external bridge tick (§3.2).

## 10. Revision log

- **r1 (2026-08-16):** 14 findings fixed — lock-rail exclusion + two-step result
  gate; engine-owned permission modes; rpc-state-bridge promoted to deliverable +
  ack-only command sends; capacity safe-victim + honest refusals; engine-tracked
  model + metering; narrowing facts corrected; ports corrected; occupancy
  unified; card-brief golden rescoped; per-session uploads/outputs + tightened
  jail; migration keyed on payload-dir presence; drawer reconnect; branch note.
- **r2 (2026-08-16):** 21 findings fixed — permission modes rescoped to
  guarded/ask/bypass (T3-11) with the pi-lab interactive-ask deliverable (the
  policy schema is block-or-pass; "ask"/"auto" were unimplementable as specced);
  lock rail redefined over statuses (`active`-only session locks, perch-live
  excluded; stale `waiting-user` history unfrozen — named product change) and
  occupancy made a synchronous claim (TOCTOU); full retirement inventory added
  (boot/shutdown importers, bot-builder banner retirement, test/i18n/registry/
  docs sweep — wave 3 was boot- and CI-breaking as written); notifications
  rewritten as a typed registry change + `types_enabled` back-fill + email
  exclusion; cycle guards (pending-ask/mid-turn refusal); warm-on-switch for
  local models (pi-lab's starter self-disables in bots); board realtime as a
  named SSE event + engine-sourced state (not DB-derivable, no reload storms);
  interruption marker (parked rows were indistinguishable); per-bot world-build
  mutex (`.mcp.json` job-id race); outputs dir added to `write_paths`; free-chat
  cwd refusal (`undefined/` reproduced); hash-based deep links + click-URL env
  requirement; i18n gate honestly scoped + source-scan test; Recall release
  affordance; `model_select` event name; ports paragraph corrected (manual edit,
  not gate-enforced); SSE budget note; bridge-frame discrimination.
