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
   *Amendment:* summary (≤300 chars, untrusted) added per owner decision 2026-10-02.

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
- **I3 — Delivery target verified (scoped; see "Known limits").** Before pushing a card into a Perch
  session, the gateway checks that the session exists in the engine AND
  `session.botId === created_by.id`. Mismatch → no card (the call still appears in the Phone panel;
  an audit row records the mismatch).
  - **Result delivery gets the same check:** the session's bot, per `bot_sessions`, must be
    `created_by.id`. Otherwise `notify_only` and an audit row (`deliver_target_mismatch`).
  - **What this stops:** a child that forges only `X-Crow-Actor-Thread`, and accidental mismatches.
  - **What it does not stop:** a child with shell access that forges *both* `X-Crow-Actor-Id` and
    `X-Crow-Actor-Thread`. The only things guarding `/phone/mcp` are those two headers and the shared
    local-mcp token.
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
- **I7 — Non-local viewers (amended 2026-10-01 after staff review, strict reading).**
  - **What they see:** an SSO/peer viewer of the same Perch session sees a **status-only pointer card**. It is built
    from the gateway's own `phone_call` frame: status, a "sign in with your password on this Crow"
    note, and Stop while the call is live.
  - **Transcript and history:** they never see the transcript. Call transcripts stay
    local-session-only, the same as `GET /api/phone/calls/:id`, for privacy. They also see **no
    history cards**: the I5 list is local-only, so after a reload they see nothing until a frame
    arrives.
  - **Controls:** approve/reject/farend are never rendered for them. Stop stays available (the
    server already allows it to any dashboard session).

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
  It also gains explicit `run_after` semantics (amended 2026-10-01):
  - `null` = **now**, which clears a bot-proposed time;
  - an ISO string = scheduled;
  - absent = keep the stored time;
  - unparseable = 400.
- `GET /api/phone/whoami` → `{local:boolean, totp_required:boolean, cloud_model:string|null}` so the
  card knows whether to render controls (I7), the 2FA field, and the cloud label.

### 4.4 Perch client card (`servers/gateway/dashboard/perch-hub/client.js`)
- `on('phone_call', …)` → upsert a card keyed by `call_id` in `#perch-transcript` (fetch
  `/api/phone/calls/:id`; render).
- `loadHistory` also fetches `/api/phone/perch/:sid/calls` (when the phone bundle is installed — a 404
  is ignored) and renders those cards, deduped by call_id, like file cards.
- States:
  - **pending** shows:
    - the business, number, goal and limits;
    - the call **language** ("English" / "Español"; it is part of the plan hash);
    - a bot-proposed time ("Proposed time: …");
    - the shareable fields (editable; clear to withhold);
    - a `This is a business` checkbox and an `Allow cloud model for this call (<model>)` checkbox;
    - a 2FA field (when required);
    - the actions: `Approve now` (means now, and sends `run_after: null`), `Approve for…` (datetime,
      prefilled with the proposed time) and `Reject`.

    If the plan changes while the card is open, it redraws with "The plan changed — review it again".
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
`turn_in_progress` if the bot is mid-turn, and gives up after 5 retries (~10 s).

Change: on a **transient** failure, keep the delivery pending and retry on the sweep with a longer
window (up to 10 min, backoff). Transient failures are:
- `turn_in_progress` and `cycle_busy`;
- `interactive_capacity` and `pi_capacity` (a full box);
- `no_engine` (the engine singleton is created lazily by the first Perch request, so after a gateway
  restart it can be missing for a while). This list was widened 2026-10-01 after staff review.

Always push the terminal card frame immediately, so the owner sees the outcome even before the bot
hears about it. The owner notification fires once.

### 4.7 Versioning
Bump `bundles/phone/manifest.json` version (0.1.0 → 0.2.0) so installed copies refresh. On the
version change the gateway's refresh (`refreshVersionedBundle`) copies `server/`, `panel/` and the
compose `build:` context directories (here `runner/`) into the installed copy; it does not rebuild
anything. A gateway restart does not run compose, and `restart: unless-stopped` keeps the old image,
so after upgrading Crow the Phone runner is rebuilt the next time you Restart/Start Phone in
Extensions (`up -d --build`). Do that once after an upgrade, when no call is live (recreating the
container ends a running call).

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

## 6. Known limits / follow-up
- **Actor headers are not bound to the session.** `/phone/mcp` trusts `X-Crow-Actor-Id` and
  `X-Crow-Actor-Thread` under the shared local-mcp token.
  - I3 (cards) and the delivery check stop a forged thread and accidental mismatches, but not a
    child that forges both headers. That child could get a card into, or a result delivered to,
    another session of the bot it impersonates.
  - Approval still needs the owner's local password session, 2FA and `plan_hash`, so no call can be
    placed this way.
  - **Follow-up, queued as its own item:** real per-session binding. The engine mints a per-session
    secret into the child's MCP headers, and `/phone/mcp` resolves the actor from that secret instead
    of trusting the headers. Plan A's delivery path has the same exposure.
  - **Done 2026-10-02 (S2, phone 0.2.2).** The bot catalog adds `X-Crow-Actor-Sig`, an HMAC of
    (kind, bot, thread, gateway) under a per-boot key that lives only in gateway memory
    (`scripts/pi-bots/actor-sig.mjs`; the Discord child gets it on stdin, never env). `/phone/mcp`
    attributes a bot only when the signature verifies. A missing or wrong signature, or the phone
    token with no actor, is `unattributed`: it can propose a call (owner notification only, no
    card, no thread reply) but cannot read or cancel any call, and such callers are
    rate-limited per claimed id, under a global cap.
  - **What S2 stops:** forging only the thread/gateway (or a bot id without that bot's
    signature); owner access through the bare phone token; impersonation by bots with neither a
    file-read tool nor an open shell.
  - **What S2 does not stop:** a bot that can read another bot's world files. Signed headers rest
    in each bot's `.mcp.json` (same uid; pi's `read` tool is not path-confined), so they can be
    replayed. A docker-group shell is root-equivalent. Queued as S6: pi-lab read confinement or
    fd-based delivery of the per-turn MCP config.
  - Bot worlds built outside the gateway process (`pibot-gateways@`, the CLI) hold no key, so their
    plans are unattributed. Generic scheduled jobs are signed as gateway `job` (no delivery
    target) when they run in the gateway process.
  - **S5 (done, fix/bot-isolation):** the board actor headers are signed the same way (MAC kind
    `board`, bound to bot + job id). /board/mcp attributes a mutation, and grants the lock
    exemption (job rail by job id, session rail by bot id, which covers scheduled jobs), only on
    a valid signature; unsigned or forged headers, and the board token with no headers, become an
    unattributed bot (`actor_kind` bot, no id). Bots run by key-less hosts (`pibot-gateways@`)
    therefore lose the lock exemption: a job-rail card they finish stays locked for the owner.
  - **S3 (fix/bot-isolation, defense in depth, NOT closed):** pi children run under bubblewrap
    where usable. The docker socket and the user session (D-Bus, systemd user manager, tmux) are
    masked, user units are read-only, and no_new_privs blocks sudo. This removes the casual
    docker/sudo routes but is not containment: the writable filesystem (rc files, `~/crow`) and
    `ssh localhost` remain escape routes until a dedicated bot user exists. See
    `scripts/pi-bots/pi_sandbox.mjs`.

## 7. Dependencies / ordering
The fixes PR (`fix/phone-install-and-perch-polish`, #393) has merged, and this branch is rebased
onto main 9750e84f, which includes it.
