# Phone calls inside the Perch chat: approval + live-call card

Status: design approved by Kevin 2026-10-01 ("Yes that matches. Go ahead").
Parent spec: `docs/superpowers/specs/2026-09-30-assistant-calls-design.md` (plan A shipped in PR #392).

## 1. Problem

Live acceptance on crow (2026-10-01, Android phone): the owner chats with a bot in a Perch hub
session, the bot proposes a call with `phone_plan_call`, and the owner must then leave the chat for
**Crow's Nest → Phone** to approve it and to type the business's lines on the simulated line. On a
phone you cannot have both open, so the flow is unusable. The first live call also failed because
the simulated line gave the owner only 20 s to type the first business line after "answered".

## 2. Goal

The whole call happens inside the Perch chat that asked for it:

1. A **call card** appears in the chat when the bot proposes a call.
2. The owner approves (or rejects, or schedules) from the card, with the **same gates** as the Phone panel.
3. The card becomes the **live call view**: transcript, "Business says…" input (simulated line), Stop.
4. The card ends showing the outcome; the bot receives the structured result as today.

The Phone panel stays as the full view (settings, history, calls proposed from non-Perch channels).

Non-goals: approving from non-Perch channels (Gmail/Discord/Telegram); the real Bluetooth line (plan B);
take-over (plan C).

## 3. Security invariants (must hold; each gets a test)

- **I1 — Gates unchanged.** Card actions POST to the existing `/api/phone/calls/:id/{approve,reject,farend,stop}`
  routes. Approve/reject/farend keep: local dashboard session only (`isLocalDashboardSession`, SSO/peer
  sessions refused), TOTP step-up (when 2FA is on), CSRF, business_confirmed. Never route approval
  through the Perch `ask_user`/`/interactive/:sid/answer` channel (that path admits SSO sessions and is
  driven by child-originated UI requests).
- **I2 — Card content is gateway-built.** The card is rendered from the `phone_calls` row (fetched by
  `call_id` through the phone API), never from bytes the pi child emitted. No `crow-phone:` notify
  prefix or any child-originated card frame. The SSE frame only carries `{type:"phone_call", call_id}`
  (a pointer); the client fetches the row.
- **I3 — Delivery target verified.** Before pushing a card into a Perch session, the gateway checks
  that the session exists in the engine AND `session.botId === created_by.id` (a child with shell
  access could forge `X-Crow-Actor-Thread`/`-Id` against `/phone/mcp`). Mismatch → no card (the call
  still appears in the Phone panel; an audit row records the mismatch).
- **I4 — Approve exactly what was shown.** The card sends the `plan_hash` it rendered; `approveCall`'s
  CAS adds `AND plan_hash = ?` so an edit or approval made elsewhere in between cannot be approved
  blind (409 `plan_changed` → card refetches). The Phone panel sends `plan_hash` too.
- **I5 — Per-session scoping.** A new read route returns only calls whose `deliver_to.session_id`
  equals the requested Perch session AND whose `created_by.id` equals that session's bot. Local
  session only. No cross-session listing.
- **I6 — Rendering.** Perch client builds the card with createElement/textContent only (house rule:
  `setSanitizedHtml` is the single innerHTML site). Bot-controlled fields (business_name, goal,
  shareable, transcript text) are never HTML. The Perch client is emitted inside a template literal:
  no backticks, no `${` in client code.
- **I7 — Non-local viewers.** An SSO/peer viewer of the same Perch session sees the card read-only
  (status, transcript); approve/reject/farend controls are not rendered for them. Stop stays
  available (the server already allows it to any dashboard session).

## 4. Design

### 4.1 Engine hook (core)
Add `notifyCard(sessionId, frame)` to the interactive engine's public object
(`servers/gateway/perch-interactive.js` export block). It looks up `sessions.get(sid)` WITHOUT
`resolveSession` (never adopts or wakes a hibernating session just to show a card) and `emit`s the
frame; returns `{delivered:boolean, botId}`. Frames are not persisted (cards are rebuilt from the DB
on load, §4.4). The SSE route already forwards any frame type as the SSE event name.

### 4.2 Phone bundle: push points
- `phone_plan_call` (`bundles/phone/server/mcp.js`, after `createPlan`): if `deliver_to.kind === "perch"`,
  call an injected `notifyCard` dep with `{type:"phone_call", call_id, status:"pending"}` after the I3
  check. Dep injected at the `/phone` mount (`servers/gateway/boot/mcp-mounts.js`) the same way
  `notify` is.
- Dispatcher (`bundles/phone/server/dispatcher.js`): on each status change (approved/queued → live →
  terminal) and on new transcript events, push `{type:"phone_call", call_id, status, event_seq}` to
  the call's Perch session (same I3 check). The client treats every frame as "refetch this call".
- Approve/reject/edit routes push the same frame after a successful state change.

### 4.3 Phone bundle: routes
- `GET /api/phone/perch/:sid/calls` — I5-scoped list (local only), newest first, max 20, includes
  `plan_hash`, status, outcome, summary, transcript (structured events), `allow_cloud`,
  `business_confirmed`. Strips token_hash / approved_by_session as `/calls` does.
- `GET /api/phone/calls/:id` already exists; the card uses it for refetches.
- `POST /api/phone/calls/:id/approve` gains required `plan_hash` (I4). Missing → 400; mismatch → 409.
- `GET /api/phone/whoami` → `{local:boolean, totp_required:boolean, cloud_model:string|null}` so the
  card knows whether to render controls (I7), the 2FA field, and the cloud label.

### 4.4 Perch client card (`servers/gateway/dashboard/perch-hub/client.js`)
- `on('phone_call', …)` → upsert a card keyed by `call_id` in `#perch-transcript` (fetch
  `/api/phone/calls/:id`; render).
- `loadHistory` also fetches `/api/phone/perch/:sid/calls` (when the phone bundle is installed — a 404
  is ignored) and renders those cards, deduped by call_id, like file cards.
- States:
  - **pending**: business, number, goal, limits, shareable fields (editable; clear to withhold),
    `This is a business` checkbox, `Allow cloud model for this call (<model>)` checkbox, 2FA field
    (when required), `Approve now`, `Approve for…` (datetime), `Reject`.
  - **approved/queued**: "Approved — calling at …" / "Starting call…".
  - **live**: transcript lines (assistant / business / state / digits), "Business says…" input +
    Send (simulated line only), `Stop call`. When the line state is `answered` and no business line
    has been typed, show the prompt "The business answered — type what they say."
  - **terminal**: outcome + summary (+ booking) and a link to the Phone panel history.
- While a card is `live` it polls `/api/phone/calls/:id` every 1.5 s (frames are hints; polling is
  the source of truth for the transcript, matching the Phone panel).
- The bot-board drawer (`panels/bot-board/drawer.js`) is out of scope (it shows the session; the Phone
  panel remains available there).
- i18n: en + es strings for every label (global i18n parity gate).

### 4.5 Simulated line timing (runner, `bundles/phone/runner/src/crow_phone/controller.py`)
- `farend_timeout` becomes per-line: InteractiveFakeLine (the owner types) waits **120 s** per
  business line; FakeLine (scripted tests) keeps 20 s. Passed from the gateway on `/calls/:id/start`
  (or derived from `line:"interactive"`).
- **Assistant speaks first on initial silence:** after `answered`, if no far-end line arrives within
  **6 s**, the controller speaks the disclosure followed by a greeting ("Hello?" / "¿Hola?") and keeps
  waiting with the normal timeout. If the business speaks first, current behaviour (disclose on the
  first human line) is unchanged. Nothing model-generated is ever spoken before the disclosure
  (existing `_ensure_disclosed` invariant holds).

### 4.6 Result delivery hardening (`bundles/phone/server/deliver.js`)
Today `deliverPhoneResult` injects the result as a user turn via `eng.message`, which throws
`turn_in_progress` if the bot is mid-turn, and gives up after 5 retries (~10 s). Change: on
`turn_in_progress`, keep the delivery pending and retry on the sweep with a longer window (up to
10 min, backoff), and always push the terminal card frame immediately so the owner sees the outcome
even before the bot hears about it.

### 4.7 Versioning
Bump `bundles/phone/manifest.json` version (0.1.0 → 0.2.0) so installed copies refresh. Runner image
rebuild happens on Start/restart (compose has `build:`).

## 5. Testing
- Node (bundle + core): I1 (card approve path hits the same route; SSO session refused), I3 (forged
  actor → no card, audit row), I4 (stale plan_hash → 409; Phone panel path sends hash), I5 (scoping:
  other session/bot calls never listed), engine `notifyCard` (no wake of hibernating sessions;
  emitted frame reaches subscribers), dispatcher pushes on transitions, deliver retry on
  `turn_in_progress`.
- Client: static checks that the Perch client has no innerHTML outside `setSanitizedHtml`, no
  backticks, and handles `phone_call`; i18n parity.
- Python runner: interactive 120 s timeout; speak-first after 6 s silence (disclosure precedes the
  greeting); business-first path unchanged; FakeLine keeps 20 s.
- Live acceptance on crow: in a Perch chat with hank, ask for a call → card appears → approve in the
  card (2FA if on) → card goes live → assistant speaks first after ~6 s → type business lines →
  outcome on the card → bot reports the result in the chat.

## 6. Dependencies / ordering
Implement after the fixes PR (`fix/phone-install-and-perch-polish`) merges — it also touches
`perch-interactive.js` and the Perch client (error surfacing). Rebase this branch onto main first.
