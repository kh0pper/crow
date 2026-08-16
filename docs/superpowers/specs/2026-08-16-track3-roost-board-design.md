# Track 3 — Roost on the Board: Perch launcher/roost rework (design)

**Date:** 2026-08-16 · **Status:** post round-1 adversarial review (r1 fixes applied)
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

Verified structural facts this design builds on (re-verified in adversarial r1):

- The tmux launcher is an island: `spawnSession`/`listTmuxPiSessions` are used only
  by the hub home lens itself (`payload/hub/server.mjs`). Nothing Crow-side depends
  on them.
- The Crow panel embeds only the bots lens (`/proxy/perch-hub/bots`,
  `servers/gateway/dashboard/panels/perch.js`); the home lens is a separate page
  reached through the proxy.
- `bot_sessions.card_id` exists and is rendered as a board deep-link by the bots
  lens, but the interactive engine (`servers/gateway/perch-interactive.js`) never
  writes it — only the job-dispatch rail does.
- Tool narrowing on `kind='perch-live'` sessions is refused **client-side only**
  (the vendored lens gates it, `bots-page.mjs:316-325`); the gateway narrow route
  (`routes/perch.js:742`) already accepts perch-live rows — its only refusal is
  foreign channels. The real gateway perch-live refusal is on the per-turn route
  (`perch.js:661`). Narrowing binds at spawn (`--tools` is fixed per process; pi
  has no RPC set-tools command), so on an awake session a change takes effect at
  the next wake.
- The board lock rail (`routes/board-lock.js`) computes card locks from the
  newest `bot_sessions` row per card with status in `{active, waiting-user}` —
  and the interactive engine's resting status is `waiting-user`.

## 2. Decisions

Kevin, this brainstorm, 2026-08-16 (T3-1…T3-8); r1-marked rows were forced by
adversarial round 1 and are called out for Kevin's spec review:

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
| T3-9 (r1) | Do birds lock cards? | **No.** `kind='perch-live'` rows are excluded from the board lock rail. An interactive session is operator-supervised; the perched bird is the signal, and the human must stay able to move the card (the result gate depends on it). Job-rail locking semantics unchanged. |
| T3-10 (r1) | How do mode/model/narrowing changes bind? | **At spawn.** The engine owns session state (model, permission mode, narrowing) and applies it when it builds the child. Mid-session changes to spawn-bound state take effect via a **cycle** (hibernate → immediate wake, transcript preserved by resume); the drawer says so and offers "apply now". Model changes are the exception — live via RPC `set_model`. |

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
  Builder" (relocates the Track 2 unattached callout).

One **primary action per bird, state-dependent**: idle → *Send out* (card picker →
dispatch); working/hibernating → *Open*; waiting → *Answer* (drawer scrolled to the
pending card). An overflow menu carries *Talk* (free chat), *Sessions* (history,
inside the drawer), *Setup* (Bot Builder deep link).

### 3.2 Birds on cards

A session carrying `card_id` renders the bird on that card's face with the same
state glyph; clicking opens the drawer with the card context header. Strip bird and
card bird are the same session, two vantage points. A bird can hold multiple
sessions (a card session + a free chat); the strip glyph reflects the most
attention-worthy one, in priority order **waiting-on-you > working > hibernating >
idle**; the drawer's session switcher lists the rest.

Two sessions of one bot share the bot's working directory (per-bot `sessionDir`,
`bot-world.mjs`). pi session files are distinct and `.mcp.json` rewrites are
idempotent per def, so concurrent sessions are safe; the shared-cwd fact is named
here so nobody assumes per-session isolation of the working tree.

### 3.3 Capacity behavior

With 3 awake slots, dispatch at capacity auto-hibernates the **idlest safe
victim**: an awake session that is not mid-turn and has no pending ask_user card,
longest-idle first (the engine already treats destroying an unanswered question as
forbidden). If no safe victim exists, dispatch refuses honestly with
`interactive_capacity` and the drawer explains who is busy. The host-wide pi
budget (`pi_capacity`) remains a separate, honest refusal — auto-hibernation
cannot free channel-turn pi processes.

## 4. The session drawer

Right-side slide-over on the board panel; board stays visible behind it.
Crow-native client (template-literal emission rules; all new strings EN+ES).
Deep-linkable: `?bird=<sessionId>` and the existing `?card=<id>` both open it, so a
push notification lands directly in the waiting session.

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
gateway restart recovers without reload. A turn interrupted by restart renders as
a system note ("turn interrupted by gateway restart") derived from the parked row
status; the reply, if any survived, is recoverable via the transcript read.

**Composer.** Textarea + file/image upload + send. While a turn runs, the composer
stays live as **steer** (pi's native steer, labeled so) with Abort beside it. Stop
(end session) in the header overflow.

**Controls row** (compact, above the composer): model picker, thinking level,
permission mode (ask / accept-edits / auto / bypass), plan mode toggle. Collapsible
**controls pane**: envelope view (tools/model/skills) + per-session narrowing
checkboxes with the existing tri-state saved-narrowing semantics. Spawn-bound
controls (permission mode, narrowing) are labeled with when they bind (T3-10) and
offer "apply now" (cycle).

**Result gate — explicitly two-step.** When the bird calls `board_report_result`
on a gated card, drawer and card face show the result awaiting decision.
**Accept** = `board_decide_result(accept)` **then the client moves the card** to
its terminal status as the human actor (`board_decide_result` never moves cards —
that is Track 1's contract, and T3-9 is what keeps the move possible). **Reject**
= `board_decide_result(reject)`; the card stays where it is and the bird remains
available for follow-up. Auto-autonomy cards show the outcome; the bot self-closes
per Track 1 semantics.

**Hibernation.** A hibernating session opens instantly showing its transcript with
an "asleep — sending will wake it" banner; sending wakes it with state re-applied
(§5.3).

### 4.1 Feature parity list (carried from the June/July session-web UI)

1. **Question cards** — select / input / confirm / editor via the P2 gateway API.
   Binding contract preserved: select options are pre-rendered verbatim strings,
   echoed back untouched, never parsed or re-composed; multi-select is one call per
   pick; answered cards collapse to "Answered: <label>".
2. **Model picker** — `get_available_models` / `set_model` over RPC (live, no
   cycle needed). The **engine tracks the current model** by consuming pi's
   `model_select`/`model_change` events (currently ignored), and:
   - re-applies the tracked model at every wake (pi restores the session-file
     model only when no CLI model is passed, and `PiRpc` always passes one — so
     wake passes the *tracked* model, which also avoids the bridge's unproven
     resume-across-model-change path);
   - updates the metering basis (`s.resolved`) so usage/audit rows price the
     model actually serving the turn.
   If a managed local model's server is down, pi's own local-models machinery
   starts it (the session owns its model; the gateway's models-manager is not
   involved).
3. **Plan mode** — the pi-lab extension runs fine in bot processes (verified: no
   bot gate; state persists in the session file and restores on resume). The
   drawer mirrors live plan state via the **rpc-state-bridge** (§5.2, a committed
   deliverable, not a fallback). Plan-step / plan-next cards render as question
   cards.
4. **Permission modes** — ask / accept-edits / auto / bypass. **Not** the pi-lab
   `permission-modes` extension: that extension provably self-disables whenever
   `PI_BOT_PERMISSION_POLICY` is set (which is every bot spawn), and it never
   overrode the pinned policy anyway. Instead the **engine owns the mode**: it
   composes the policy environment per mode at spawn/wake, and pi-lab's
   `permission-gating` (the thing that actually enforces the policy) honors it.
   Mid-session changes bind via cycle (T3-10). Scope of the override, on the
   record:
   - `--no-approve` stays pinned in **every** mode — the GHSA-mqxh vector is
     never reopened, including under "bypass";
   - "bypass" relaxes the *policy* protections for that session only —
     `write_paths` confinement and draft-only-send gating — nothing else;
   - dashboard-authed operator only; every mode change is a visible system note
     in the transcript.
5. **Thinking level** — `get_available_thinking_levels` / `set_thinking_level`
   (live over RPC).
6. **Files & images, both directions** — uploads land in a **per-session**
   directory (`<botDir>/.pi/uploads/<sessionId>/`) so concurrent sessions never
   collide; images ride the next prompt inline (RPC `prompt.images`) so vision
   models see them. Bot-produced deliverables go to a named per-session outputs
   directory (`<botDir>/outputs/<sessionId>/`) that the dispatch/system context
   tells the bot about; the transcript renderer links files under it.
7. **Copy buttons** on bot responses (client-side).
8. **Envelope + narrowing controls** — on perch-live: server-side acceptance
   already exists (§1); the change is the client (checkboxes in the drawer) plus
   honest binding semantics — narrowing binds at wake (T3-10), and the engine
   already re-applies saved `narrowed_tools` at every world rebuild.
9. **Push notifications (ntfy)** — via Crow's existing push subsystem
   (`servers/gateway/push/ntfy.js` + `servers/shared/notifications.js`): agent-end
   with a min-run threshold; high-priority on attention (ask_user, permission
   confirm, gated result awaiting decision), with click-URLs deep-linking into the
   drawer. pi-lab's `notify.ts` correctly self-disables in bot processes and
   stays out.

## 5. Engine & API changes

### 5.1 Card binding, occupancy, and the lock rail

- `spawn` accepts an optional card; the engine writes `card_id` on the
  `bot_sessions` row. Dispatch sets `assigned_bot` on the card with a provenance
  mutation (actor = human).
- **Lock rail (T3-9):** `kind='perch-live'` rows are excluded from
  `board-lock.js`'s lock computation. Without this, the engine's `waiting-user`
  resting status would lock every dispatched (or attached) card against all human
  moves for the life of the session — including the Accept move in the result
  gate. Job-rail locking is untouched.
- **Occupancy (one bird per card):** interactive dispatch refuses (409) when
  (a) the existing lock rail reports the card locked by a **job-rail** session, or
  (b) a non-stopped (`awake` or `hibernating`) **perch-live** session already
  carries this `card_id`. This delegates rail-vs-rail exclusion to the one
  existing definition instead of inventing a second one, and confines the
  new rule to perch-live rows (job-rail rows commonly rest at `waiting-user`
  forever and must not block dispatch by mere history).
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
  `/plan`) is handled at preflight and produces **no agent loop and no
  `agent_end`** — so the engine must send them outside `promptTurn`'s
  turn-correlation (fire, confirm ack, done). Routing one through a normal turn
  would hang the stall watchdog and kill a healthy child.
- **rpc-state-bridge (committed deliverable):** a small pi-lab `crow-mode`
  extension that forwards the extension-bus states the drawer needs (today:
  `plan-mode:state`) to RPC stdout over the extension-UI channel as notify-only
  events. The extension bus is in-process only — without this bridge no bus state
  reaches the engine, regardless of how commands are sent. Permission-mode state
  does **not** ride the bus: the engine owns it (§4.1.4) and emits it directly.
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
(safe-victim auto-hibernate, honest refusal otherwise). Engine events feed the
push subsystem (§4.1.9).

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

The board payload joins live session state by `card_id` so card faces render the
perched bird + state and result-gate buttons; the strip gets a small state
endpoint. Board API contract holds: def envelopes are JSON strings; items expose
title as label.

## 6. Retirement & migration

**Deleted:** the perch-hub bundle wholesale (vendored payload: home lens, bots
lens, hub daemon, registry), the `perch-runtime.js` supervisor, the
extension-proxy mount for it, the Perch panel + nav entry, the per-turn chat
endpoints, `scripts/vendor-perch.mjs` and the vendoring dance.

**Ports:** Crow's perch-hub allocation is **4210 / 4211, registry pool
4141–4179** (`perch-runtime.js`; the 4200/4201/4101–4139 numbers are the
standalone lab `pi-hub.service`, which the port doc deliberately sits clear of —
those rows are not ours to touch). The 4210-family rows are removed from
`docs/developers/port-allocation.md` in the same PR (`check-ports` gate).

**Drift test:** `tests/perch-token-drift.test.js` retires with the payload.
`PERCH_TOKENS` survives as the palette for strip/birds/drawer; the token-bypass
sweep covers the new Crow-native files automatically (it walks the dashboard
render tree).

**Migration:** `perch-runtime` keys "installed" on the payload directory existing
on disk, not on `installed.json` — and on crow the bundle is present in neither
(verified live). The guard-flagged, idempotent boot migration therefore: removes
the stale payload directory and the minted perch-token file **where present**, and
removes any `installed.json` entry if one exists. r4's install state must be
checked during implementation before finalizing the guard. History rows
(`kind='perch'` and old sessions) stay readable; nothing is deleted from the
database.

**Deploy:** rides routine fleet deploys + r4 auto-update. Wave ordering (§7)
means the new door exists before the old panel disappears; an old panel iframe
open across the deploy dies with the bundle — acceptable, it reloads into the new
board surface. No schema change expected (`card_id` exists); if that changes, the
manual migration rail rule applies (`scripts/schema-migration-dryrun.sh` from the
branch).

**pi-lab upstream** keeps its hub and personal tmux/filesystem workflow; Crow
stops embedding it. The only pi-lab `crow-mode` change this track requires is the
rpc-state-bridge extension (§5.2) — no payload vendoring is involved since the
payload is being deleted, but the extension change follows the pi-lab commit
discipline (edit in `~/pi-lab` on `crow-mode`, push to Gitea).

## 7. Phasing (one branch from origin/main, SDD tasks in three waves)

1. **Engine + API** — lock-rail exclusion, card binding + occupancy, control
   passthrough (ack-only commands), model tracking + metering, engine-owned
   permission mode, rpc-state-bridge, capacity safe-victim, notifications, shared
   card-brief builder. Fully testable headless.
2. **Board UI** — roost strip, birds on cards, drawer with the full parity list.
3. **Retirement** — bundle, panel, per-turn channel, migration, ports, docs.

The new door opens before the old one closes; no dead window.

## 8. Testing

**Engine, headless** (P2 mock-pi harness pattern): control passthrough
round-trips including correlated waiters for new command types; ack-only command
send (a `/plan` never enters turn correlation — asserted by a test that would
hang/watchdog if it did); state re-emit on every subscribe; wake fidelity
(hibernate → wake → assert model/mode/narrowing actually re-applied to the
respawned child's argv/env, not just recorded); model tracking updates metering
basis after `set_model`; capacity — safe-victim selection skips mid-turn and
pending-ask sessions, refuses honestly when no victim; card binding — occupancy
409s per §5.1 on both the perch-live and job-rail-locked cases; **lock-rail
exclusion** — a perch-live `waiting-user` row does not lock its card (and a
job-rail row still does); golden test for the shared card-brief block
(byte-identical across rails at the scoped block, hint/user-message
parameterized).

**API:** confinement tests that attack (traversal, symlink, absolute-path,
dotfile requests against the upload and outputs-serve jails; `.mcp.json` and
`sessions/*.jsonl` explicitly unreachable); attach-card writes the provenance
mutation row and honors occupancy.

**Client:** parse-the-emitted-script test for strip + drawer client (Track 0
lesson); SSE tests parse frames by event name; reconnect test (drop the stream,
assert replay restores state); verbatim-echo contract test for question-card
options.

**System rails:** i18n EN+ES parity gate; token-bypass sweep; `check-ports` after
the port-doc edit; migration idempotence (runs-twice-safe, present-and-absent
cases); suite floor 3423/0; every new test mutation-tested, restores by edit
(never `git checkout`).

**Live acceptance** (once, by hand, on r4): dispatch a real bird onto a real card,
steer it, answer an ask_user card, receive the ntfy push, gate a result — and
move the accepted card, proving T3-9 end-to-end.

## 9. Out of scope

Track 2's later waves (inline-CSS long tail, bundle UIs, blog); the models-manager
resume flake; r4-assistant's stale tool list; anything touching the Funnel /
network-exposure invariant (requires named approval); voice/companion channels
(they keep their own loop).

## 10. Revision log

- **r1 (2026-08-16):** adversarial round 1 — 4 Critical, 7 Important, 3 Minor,
  all addressed: lock-rail exclusion (T3-9) + two-step result gate; engine-owned
  permission modes replacing the self-disabled extension, with the bypass scope
  named; rpc-state-bridge promoted from fallback to deliverable + ack-only
  command sends; capacity safe-victim + honest refusals; engine-tracked model
  (session-file restore is CLI-overridden) + metering basis; narrowing facts
  corrected (client-side-only refusal, binds at wake); ports corrected to
  4210/4211/4141–4179; occupancy unified with the lock rail; card-brief golden
  rescoped; per-session uploads/outputs dirs + tightened serve jail; migration
  keyed on payload-dir presence; drawer reconnect + interrupted-turn rendering;
  branch-from-origin/main note.
