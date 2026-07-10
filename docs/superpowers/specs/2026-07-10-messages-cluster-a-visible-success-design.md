# Cluster A — "Make success visible" (Messages UI feedback) — Design

**Date:** 2026-07-10 · **Findings:** F-UI-1 (CRITICAL), F-UI-3, F-UI-4, F-UI-5, F-UI-6, F-UI-7 + two F-UI-1/3 addenda (P4 walkthrough ledger)
**Operator decisions (2026-07-10):** `data-turbo="false"` for the invite forms; client-owned EventSource nudge for live DMs; manual Retry only; both addenda in scope.

## Problem

Kevin's live P4 VNC walkthrough (2026-07-10) proved the messaging protocol layer works
end-to-end on a fresh install, while the dashboard fails to *show* it. Six findings share
one root theme: the UI never confirms a messaging action. The flagship contact-add UX
shipped a week ago and its generate buttons have never worked in a real browser — every
smoke ran via curl/MCP, which cannot see this failure class.

## Root causes (recon-verified, file:line)

| Finding | Root cause |
|---|---|
| F-UI-1 | 4 invite handlers `return false` → 200 HTML re-render (`panels/messages/api-handlers.js:106,126,150,171`; contacts equivalents `panels/contacts/api-handlers.js:146-205`). Turbo Drive requires POST responses to redirect; a 200 body is silently discarded. Forms live in shared `dashboard/shared/peer-invite-ui.js:56-67,114-125` (used by BOTH Messages and Contacts panels) with no `data-turbo` attribute. |
| F-UI-3 | accept success `redirectAfterPost("/dashboard/messages")` — same page, no feedback, contact not opened (`messages/api-handlers.js:146,190`). The `?open=<contactId>` conversation-opener already exists (`messages/client.js:149-155`) with in-repo precedent (`api-handlers.js:238,265`). |
| F-UI-4 | `/dashboard/streams/messages` is **badge-only by design** — "message-body live updates are deferred to a later plan" (`routes/streams.js:76-77`). The publisher (`sharing/nostr.js:511`), same-process bus (`shared/event-bus.js`), SSE plumbing (heartbeats + `X-Accel-Buffering: no`, survives Tailscale Serve), and Turbo element all work. The only body path is the 5-minute fallback poll (`messages/client.js:1430`). |
| F-UI-5 | Optimistic sent bubble has no `data-msg-id` and never advances `_messages` (`client.js:689,1073`); the poll's `afterId` fetch has no direction filter (`routes/peer-messages.js:137-146`) → re-appends the just-sent row as a second bubble. |
| F-UI-6 | (a) `.msg-delivery` is 0.7rem/muted/0.7-opacity (`messages/css.js:290-296`); `.msg-bubble-failed` has **no CSS rule** (inline styles only, `client.js:1193-1210`). (b) Reload gap: `GET /api/messages/peer/:id` never SELECTs `delivery_status` (`routes/peer-messages.js:138-156`); the column-aware `getPeerMessages` (`messages/data-queries.js:164-181`) is dead code — receipts render only at send time and vanish on reload. (c) Info panel Security block renders the raw asymmetric peer pubkey (`client.js:1365-1378`) where Contacts renders the symmetric safety number (`panels/contacts/html.js:226-240`, `computeSafetyNumber` in `sharing/identity.js:102-114`, needs BOTH ed25519 pubkeys — my key is not in the peer API response today). |
| F-UI-7 | 0-relay send → `delivery_status='failed'` row (`sharing/nostr.js:186`) but `shouldEnqueue` requires `publishedCount > 0` (`sharing/retry-queue.js:69-81`) → never enqueued; the `messages` table stores no raw signed event (`scripts/init-db.js:532-548`) so retry must re-enter `sendMessage` (new event id — fine, nothing was published). No per-bubble action UI exists on sent bubbles. |
| Addendum 1 | "Add by Crow ID (repair)" rejection (the I1 key-pinning guard, `sharing/contact-promote.js`) surfaces nowhere — no UI error, no journal line. A legit typo and an attack look identical: silence. |
| Addendum 2 | Short-code expiry (~10 min) is not stated near the code entry field; an expired code fails silently (fixed for visibility by F-UI-1's form fix, but the expectation should be set up front). |

## Design

### 1. F-UI-1 — `data-turbo="false"` on the four invite forms

Add `data-turbo="false"` to the generate/accept forms in `peer-invite-ui.js`
(`renderPeerInviteForms`, `renderShortCodeForms`). Classic full-page POST → the existing
200 re-render paints: generate results (link/QR/short code), accept errors, replay
rejections and expiry errors all become visible in both Messages and Contacts panels with
zero handler changes. The CSRF hidden input is already in every form and classic POSTs
are explicitly supported (`layout.js:420` comment). Cost accepted: full page load on
these four rare, dialog-launched actions.

Regression guard: renderer tests assert the attribute on all four forms (mutation-tested:
removing the attribute must redden them).

### 2. F-UI-3 — land in the new conversation

On accept success (both invite + short-code, Messages panel): resolve the new/promoted
contact row id (the accept path knows the peer's crow_id/pubkey; query the row after
`crow_accept_*` succeeds) and `redirectAfterPost("/dashboard/messages?open=<id>&connected=1")`.
The client's existing `?open=` handler opens the conversation; a new small handler for
`connected=1` fires `crowToast` (success) — the toast helper and `data-turbo-permanent`
container already exist (`layout.js:530-583`). If the contact id cannot be resolved,
fall back to `?connected=1` alone (toast still fires — never a silent success).

Contacts panel accept success: `redirectAfterPost("/dashboard/contacts?flash=peer_added")`
+ whitelisted inline banner, following the existing `?flash=` idiom (`panels/health.js:152`).

### 3. F-UI-4 — named-event SSE nudge + client fetch

- `routes/streams.js` messages handler: alongside the existing badge turbo-frame, emit a
  **named SSE event** `event: crow-msg` with `data: {"contactId":N}` per `messages:changed`.
  Named events are invisible to Turbo's `<turbo-stream-source>` `onmessage`, so badge
  behavior is untouched.
- `messages/client.js`: open a plain `EventSource('/dashboard/streams/messages')`
  (precedent: `shared/player.js:447-468`, including `session-expired` listener and
  swallow-errors reconnect). On `crow-msg` for the currently open peer conversation, run
  the existing `afterId` fetch+append (the same code path the 5-min poll uses — one
  renderer). Events for other contacts are ignored (badges already handle them).
- The 5-min poll stays as the fallback (Turbo disabled, EventSource unsupported, missed
  events during reconnect).
- Connection accounting: this adds one SSE connection per open Messages panel (cap 200,
  `CROW_SSE_MAX`), matching the pattern player.js already established.

### 4. F-UI-5 — id-keyed reconciliation

- `handlePeerSend` (`routes/peer-messages.js`) returns `{ok:true, id, nostr_event_id}` —
  after tool success, read back the just-inserted row (newest `direction='sent'` row for
  the contact).
- Client: on POST success, stamp the optimistic bubble's `data-msg-id`, push the message
  into `_messages` (advancing `lastId`).
- Defensive dedup: the shared append path (used by poll AND the new live nudge) skips any
  message whose `data-msg-id` already exists in the viewport. This single mechanism
  prevents the F-UI-5 duplicate and protects F-UI-4's new path from ever double-rendering.

### 5. F-UI-6 — legible receipts + one trust surface

- **CSS** (`messages/css.js`): real classes — `.msg-delivery` legible (≥0.75rem, non-muted;
  `delivered` variant gets the accent color, distinct from single-tick `relayed`);
  `.msg-bubble-failed` + `.msg-bubble-failed-note` promoted from inline styles to classes
  (error color, readable size, retry affordance slot).
- **Reload gap**: the live route (`routes/peer-messages.js:138-156`) switches to the
  column-aware `getPeerMessages` from `messages/data-queries.js` (today dead code) so
  there is exactly one owner of the peer-messages query and `delivery_status` reaches the
  client on reload. The `afterId` variant moves into the same module.
- **Safety number**: peer API response gains `safety_number` computed server-side via the
  existing `computeSafetyNumber(myEd, contact.ed25519_pubkey)` (identity load mirrors
  `panels/contacts.js:79-82`; omit the field when either key is missing). `showPeerInfo`
  renders it (grouped 8×5 format, same as Contacts) instead of the raw peer pubkey, with
  the existing `contacts.safetyNumber` label; keep "End-to-end encrypted" copy.

### 6. F-UI-7 — manual Retry on failed bubbles

- Failed bubbles get a **Retry** button (new markup in `markBubbleFailed` /
  the failed branch of `appendBubble` — both send-time and reload render paths).
- Click → re-POST `/api/messages/peer/:id/send` with the same content plus
  `retry_of=<msgId>`.
- Server: on send success with a valid `retry_of`, delete the old failed row — guarded:
  row must belong to the same contact, `direction='sent'`, `delivery_status='failed'`.
  Invalid/missing `retry_of` is ignored (plain send).
- Client: swap the failed bubble in place (pending → ✓ on success; re-apply failed state
  + Retry on another failure). The retried message is a new row/new event id (nothing was
  ever published, so there is no dedup concern).
- Auto-enqueue of 0-relay sends into the R5 retry loop: **out of scope** (follow-up pool)
  — it relaxes `shouldEnqueue` semantics that R5's security review hardened.

### 7. Addenda

- **Add-by-Crow-ID feedback:** the repair form's rejection path renders a visible error in
  the Contacts panel (same banner mechanics as invite errors) and writes one server
  journal line (`console.warn`, existing logging idiom) naming the refusal reason class
  (invalid key / key-pinning conflict). The guard's *behavior* is untouched — it only
  becomes legible.
- **Short-code expiry hint:** static helper text near the code entry field and on the
  generated-code result ("codes expire in ~10 minutes"), i18n EN+ES.

## Error handling

- Every new client feature is progressive enhancement: EventSource failure → poll still
  covers; toast helper missing → redirect still lands in the conversation; Retry POST
  failure → bubble returns to failed state with Retry still present.
- `retry_of` server guard fails closed (ignores the param) — it can never delete a row
  that isn't the caller's failed sent message on that contact.
- The safety-number field is omitted (not fabricated) when either identity key is
  unavailable; the client falls back to showing nothing rather than a wrong number.

## Testing

- **Handler-level** (existing `fakeRes` pattern, `tests/messages-room-actions.test.js:38`):
  accept success redirects to `?open=<id>&connected=1`; fallback without id; contacts
  `?flash=peer_added`; `retry_of` guard (wrong contact / not-failed / not-sent → row
  survives; valid → row deleted). Mutation-test the `retry_of` guard.
- **Renderer**: `data-turbo="false"` present on all 4 forms (mutation-tested); Retry
  button rendered for failed bubbles; safety number rendered + raw pubkey absent; expiry
  hint present; add-by-id error surfaced.
- **Stream route**: `crow-msg` named event emitted on `messages:changed` (extend
  `tests/messages-sync.test.js` territory); badge frame unchanged.
- **Client logic** (extracted-function pattern, `tests/message-delivery-render.test.js`):
  by-id dedup (append twice → one bubble); optimistic bubble stamped after POST;
  delivery_status renders from the live route's rows.
- **Route SELECT regression**: live peer-messages response includes `delivery_status`.
- **Full suite** baseline 1329/0/1 must hold.
- **HARD REQUIREMENT — browser-click verification via CDP** (this class is invisible to
  curl/MCP; that's how it shipped broken): scripted CDP run against the crow-browser
  container clicking through: generate invite link (result visible), generate short code
  (visible), accept invite (lands in conversation + toast), accept error (banner visible),
  live DM arrival without refresh, send (exactly one bubble), receipt ticks legible,
  failed send → Retry → success. Evidence (screenshots/DOM asserts) attached to the PR.

## Out of scope (follow-up pool)

Auto-enqueue 0-relay sends; "waiting for peer to confirm" pending-handshake indicator
(async inviter-side replay reject); room/group-send parity for receipts+retry; F-UI-2
invite-page CSS + F-SETTINGS-2 i18n keys (Cluster F); profile-name sync (Cluster B);
block teardown (Cluster C); relaysConnected liveness (Cluster D).
