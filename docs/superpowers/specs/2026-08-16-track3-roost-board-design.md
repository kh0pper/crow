# Track 3 — Roost on the Board: Perch launcher/roost rework (design)

**Date:** 2026-08-16 · **Status:** draft for adversarial review ×2
**Arc:** board-as-truth + visual language (scope doc: Gitea `kh0pp/crow-engineering`,
`specs/2026-08-08-board-truth-and-visual-language-scope.md`). This spec is Track 3 —
the board × Perch merge, shape A (scope decisions 4, 5, 7) — entered through the
Perch launcher/roost complaint (memory `crow-perch-launcher-rework-brainstorm-queued`).

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

Verified structural facts this design builds on:

- The tmux launcher is an island: `spawnSession`/`listTmuxPiSessions` are used only
  by the hub home lens itself (`payload/hub/server.mjs`). Nothing Crow-side depends
  on them.
- The Crow panel embeds only the bots lens (`/proxy/perch-hub/bots`,
  `servers/gateway/dashboard/panels/perch.js`); the home lens is a separate page
  reached through the proxy.
- `bot_sessions.card_id` exists and is rendered as a board deep-link by the bots
  lens, but the interactive engine (`servers/gateway/perch-interactive.js`) never
  writes it — only the job-dispatch rail does.
- The gateway currently refuses tool narrowing on `kind='perch-live'` sessions
  (narrowing was built as a per-turn-session concept in P1).

## 2. Decisions (Kevin, this brainstorm, 2026-08-16)

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

### 3.3 Capacity behavior

With 3 awake slots, dispatching a 4th live bird auto-hibernates the idlest awake
session rather than refusing; the strip shows who went to sleep.

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

**Composer.** Textarea + file/image upload + send. While a turn runs, the composer
stays live as **steer** (pi's native steer, labeled so) with Abort beside it. Stop
(end session) in the header overflow.

**Controls row** (compact, above the composer): model picker, thinking level,
permission mode (ask / accept-edits / auto / bypass), plan mode toggle. Collapsible
**controls pane**: envelope view (tools/model/skills) + per-session narrowing
checkboxes with the existing tri-state saved-narrowing semantics.

**Result gate.** When the bird calls `board_report_result` on a gated card, drawer
and card face show the result awaiting decision — Accept / Reject wired to
`board_decide_result`. Auto-autonomy cards show the outcome.

**Hibernation.** A hibernating session opens instantly showing its transcript with
an "asleep — sending will wake it" banner; sending wakes it with state re-applied
(§5.3).

### 4.1 Feature parity list (carried from the June/July session-web UI)

1. **Question cards** — select / input / confirm / editor via the P2 gateway API.
   Binding contract preserved: select options are pre-rendered verbatim strings,
   echoed back untouched, never parsed or re-composed; multi-select is one call per
   pick; answered cards collapse to "Answered: <label>".
2. **Model picker** — `get_available_models` / `set_model` over RPC. If a managed
   local model's server is down, pi's own local-models machinery starts it (the
   session owns its model; the gateway's models-manager is not involved).
3. **Plan mode** — pi-lab extension; drawer mirrors `plan-mode:state` bus state and
   drives it via slash commands over RPC. Plan-step / plan-next cards render as
   question cards.
4. **Permission modes** — ask / accept-edits / auto / bypass, mirroring
   `perm-mode:state`. A drawer mode change is an **operator override** of the bot's
   pinned policy for that one session: dashboard-authed only, and every change is a
   visible system note in the transcript.
5. **Thinking level** — `get_available_thinking_levels` / `set_thinking_level`.
6. **Files & images, both directions** — uploads land in the session's
   `.pi/uploads/`; images ride the next prompt inline (RPC `prompt.images`) so
   vision models see them. Bot-produced files serve through a new gateway endpoint
   strictly confined to the session workspace.
7. **Copy buttons** on bot responses (client-side).
8. **Envelope + narrowing controls** — now working on perch-live (§5.3).
9. **Push notifications (ntfy)** — via Crow's existing push subsystem
   (`servers/gateway/push/ntfy.js` + `servers/shared/notifications.js`): agent-end
   with a min-run threshold; high-priority on attention (ask_user, permission
   confirm, gated result awaiting decision). pi-lab's `notify.ts` correctly
   self-disables in bot processes and stays out.

## 5. Engine & API changes

### 5.1 Card binding & dispatch

- `spawn` accepts an optional card; the engine writes `card_id` on the
  `bot_sessions` row. Dispatch sets `assigned_bot` on the card with a provenance
  mutation (actor = human). One **active** session per card — active means awake
  or hibernating, i.e. any non-stopped session — and a second dispatch 409s.
- The dispatch opening context (card title/description, plan record, briefings) is
  composed by the **same dispatch-prompt builder the job rail uses** — extracted
  and shared so both rails read the same brief (golden-tested, §8).

### 5.2 Control passthrough & state mirror

- Engine methods for `set_model`, `set_thinking_level`, and listing options
  (native RPC commands), plus slash-command invocation for `/mode` and `/plan`
  (prompt-routed commands; pi's RPC documents commands as "available for
  invocation via prompt").
- Mode / plan / model state changes stream out over the existing SSE channel as
  state events; current state is re-emitted on every subscribe (existing replay
  pattern), so a reopened drawer is never stale.
- **Verification task with named fallback:** confirm on the deployed pi version
  that slash commands route when sent as RPC `prompt` text. If they do not, the
  fallback is a small pi-lab `crow-mode` extension bridging bus commands to the
  extension-UI RPC channel (the ask_user precedent). Either way the drawer API is
  unchanged.

### 5.3 Wake fidelity

A wake restores model, permission mode, plan state, and narrowing. Model and
plan/mode state persist in pi's session file and restore on resume (verify on the
deployed pi version; if any does not persist, the engine re-applies it after
resume from its own recorded state — it sees every change event, so it can). The
engine re-applies saved `narrowed_tools` at every world rebuild, and the gateway's
perch-live narrowing refusal is lifted. Mid-session narrowing applies from the
next turn, as today.

### 5.4 Capacity & notifications

`DEFAULT_MAX_AWAKE` 1 → 3 (knob stays). At capacity, dispatch auto-hibernates the
idlest awake session instead of returning `interactive_capacity`. Engine events
feed the push subsystem (§4.1.9).

### 5.5 Gateway API surface

All under the existing dashboard-authed mounts (`/dashboard/perch-api` rails):

- `POST /interactive/:sid/control` — model / thinking / permission mode / plan
  mode; `GET /interactive/:sid/options` — models, thinking levels.
- `POST /interactive/:sid/files` — upload into the session's `.pi/uploads/`.
- `GET /interactive/:sid/workspace/<path>` — bot-produced file serving,
  realpath-jailed to the session cwd.
- `POST /bots/:id/dispatch` `{card_id}` — spawn bound session.
- `POST /interactive/:sid/attach-card` `{card_id}` — free chat → card, with
  provenance.
- Narrowing route accepts perch-live.
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
endpoints, `scripts/vendor-perch.mjs` and the vendoring dance. Hub ports (4200 /
4201 / registry pool 4101–4139) freed; `docs/developers/port-allocation.md`
updated in the same PR (`check-ports` gate).

**Drift test:** `tests/perch-token-drift.test.js` retires with the payload.
`PERCH_TOKENS` survives as the palette for strip/birds/drawer; the token-bypass
sweep covers the new Crow-native files automatically.

**Migration:** a guard-flagged boot migration (Track 2 settings-migration
precedent, idempotent) removes `perch-hub` from `installed.json` and stops the
supervisor where installed. History rows (`kind='perch'` and old sessions) stay
readable; nothing is deleted from the database.

**Deploy:** rides routine fleet deploys + r4 auto-update. No schema change
expected (`card_id` exists); if that changes, the manual migration rail rule
applies (`scripts/schema-migration-dryrun.sh` from the branch).

**pi-lab upstream** keeps its hub and personal tmux/filesystem workflow; Crow
stops embedding it.

## 7. Phasing (one branch, SDD tasks in three waves)

1. **Engine + API** — card binding, control passthrough, wake fidelity, capacity,
   notifications, shared dispatch-prompt builder. Fully testable headless.
2. **Board UI** — roost strip, birds on cards, drawer with the full parity list.
3. **Retirement** — bundle, panel, per-turn channel, migration, ports, docs.

The new door opens before the old one closes; no dead window.

## 8. Testing

**Engine, headless** (P2 mock-pi harness pattern): control passthrough
round-trips; state re-emit on every subscribe; wake fidelity (hibernate → wake →
assert model/mode/narrowing survived); capacity (4th dispatch hibernates idlest,
never 409s); card binding (one active session per card; second dispatch 409s);
golden test asserting the interactive dispatch prompt is **byte-identical** to the
job rail's for the same card.

**API:** confinement tests that attack (traversal, symlink, absolute-path against
the upload and workspace-serve jails); narrowing accepted on perch-live;
attach-card writes the provenance mutation row.

**Client:** parse-the-emitted-script test for strip + drawer client (Track 0
lesson); SSE tests parse frames by event name; verbatim-echo contract test for
question-card options.

**System rails:** i18n EN+ES parity gate; token-bypass sweep; `check-ports` on
freed ports; migration idempotence (runs-twice-safe); suite floor 3423/0; every
new test mutation-tested, restores by edit (never `git checkout`).

**Live acceptance** (once, by hand, on r4): dispatch a real bird onto a real card,
steer it, answer an ask_user card, receive the ntfy push, gate a result.

## 9. Out of scope

Track 2's later waves (inline-CSS long tail, bundle UIs, blog); the models-manager
resume flake; r4-assistant's stale tool list; anything touching the Funnel /
network-exposure invariant (requires named approval); voice/companion channels
(they keep their own loop).
