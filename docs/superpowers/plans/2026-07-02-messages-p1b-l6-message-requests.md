# Messages Phase 1b — L6 fix: Message Requests (no more silently-dropped DMs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix **L6** — the confirmed root cause of the operator's "message never received" bug. Today a decrypted plaintext DM from a sender who isn't a contact is **silently dropped** (`servers/sharing/nostr.js:379-393`: `subscribeToIncoming`'s `onevent` only acts on JSON `invite_accepted`/`crow_social`; plaintext falls through). After this: such a DM becomes a **message request** — stored, surfaced in the Messages UI with Accept/Decline, and (first-message-only) notified — so nothing vanishes and a half-completed contact handshake is recoverable in one click.

**Architecture:** No new table. A minimal `contacts` row tagged with a new `request_status` column (three states: **NULL** = full contact; **'pending'** = unaccepted request; **'accepted'** = accepted-but-partial, secp-only) holds the unknown sender; the DM is stored as a normal `messages` row. A cold DM carries ONLY the 32-byte secp pubkey — no ed25519 key, no crow_id — so an accepted request is a **partial** contact that can receive/send DMs (`subscribeToContact` works off the secp key) but CANNOT do peer/DHT sync or be room-trusted until R4 supplies its real identity. Accept therefore moves 'pending'→**'accepted'** (NOT NULL — flipping to NULL would make the malformed-identity row masquerade as a full contact in the boot peer-join loop, sync, and room trust). The `request_status` gate is applied at the **complete** set of surfaces a partial row must be excluded from (see Task 3 — 7 surfaces, security-relevant).

**Tech Stack:** Node 20, `servers/sharing/{nostr.js,boot.js}`, `servers/gateway/dashboard/panels/messages/{data-queries.js,html.js,api-handlers.js,client.js}`, `scripts/init-db.js`, `servers/shared/notifications.js`, `node --test`.

## Verified facts (explored 2026-07-02)

- **Drop site:** `nostr.js:369-393` `onevent` — decrypt succeeds, then `if (decrypted.startsWith("{"))` routes JSON only; plaintext (a real human DM) is discarded. `senderPubkey = event.pubkey` is 32-byte x-only (64 hex); stored `contacts.secp256k1_pubkey` is 33-byte compressed (66 hex, `02`/`03` prefix). **Any pubkey match must normalize to trailing-64 lowercase** (the existing pattern at `data-queries.js:171`).
- **`messages`** (`init-db.js:531-547`): `contact_id INTEGER NOT NULL` FK → a message REQUIRES a contacts row (hence the minimal request contact). Received insert shape at `nostr.js:252-256` (`INSERT OR IGNORE`, `nostr_event_id UNIQUE` dedup).
- **`contacts`** (`init-db.js:454-464` + migrations): `crow_id NOT NULL UNIQUE`, `ed25519_pubkey NOT NULL`, `secp256k1_pubkey NOT NULL`. A cold sender gives only the secp key → synthesize `crow_id='req:<pubkey16>'`, `ed25519_pubkey=''` placeholder. `origin` column already models discovery-source ('advertised'); a dedicated `request_status` column is cleaner than overloading it (chosen).
- **Gating points (COMPLETE set — review found the plan's original "3 gates" incomplete, incl. a security bypass):**
  1. `getUnifiedConversationList` (`data-queries.js:51`) — exclude 'pending' (show NULL + 'accepted').
  2. `getBotDirectory` pubkey map (`data-queries.js:168`) — exclude non-NULL.
  3. Boot subscribe loop (`boot.js:180`, `WHERE is_blocked=0`) — SPLIT: NULL → `initContact`+`joinContact`+`subscribeToContact`; 'accepted' → `subscribeToContact` ONLY (no ed25519 → joinContact('')  is a no-op error every boot); 'pending' → skip (broad `subscribeToIncoming` covers it).
  4. **`room-inbound.js:27` (SECURITY, C1)** — `room_join` trust reads `SELECT secp256k1_pubkey FROM contacts WHERE is_blocked=0`; a bare request row would PASS → a stranger who DMs (creates a request) then sends `room_join` gains room-host trust. Gate on `request_status IS NULL`. Same for the member/host matches at `:52`/`:55`.
  5. Contacts panel `getContacts` (`servers/gateway/dashboard/panels/contacts/data-queries.js:41`) — exclude non-NULL (else `req:` rows show as bare contacts).
  6. `crow_list_contacts` MCP tool (`servers/sharing/tools/contacts.js:245`) — exclude non-NULL.
  7. **Sync:** `contacts` is in `SYNCED_TABLES` (`instance-sync.js:52`) BUT there is **no `emitChange("contacts")` anywhere** (grep-confirmed) → contacts do NOT push-sync today, so request rows won't propagate. Defensive: if an outbound/`shouldSyncRow` filter exists, exclude non-NULL `request_status`; the new column is nullable so a not-yet-upgraded peer's apply self-heals (`instance-sync.js:595-597`).
- **Wiring:** `subscribeToIncoming(onInviteAccepted, onSocialMessage)` (`nostr.js:357`) is wired once at `boot.js:211`; add a 3rd `onMessageRequest` callback.
- **UI:** Messages panel `messages.js` → `buildMessagesHTML` (`html.js`); a "Requests (N)" block slots at `html.js:126` next to `botInviteCard`; the `msg-bot-invite-card` form (`html.js:39-47`) is the Accept-button template. POST actions handled in `api-handlers.js` (`send_peer`/`block`/`accept_invite` pattern), each `res.redirectAfterPost("/dashboard/messages")`.
- **Notifications:** `createNotification` (`notifications.js:28`) has NO per-sender cap — the request path must cap itself (first message only).

## Global Constraints

- Branch `fix/messages-l6-requests`. Positional-path commits; `git show --stat HEAD` after each.
- Tests: `node --test tests/<file>.test.js`. Gateway must boot: `node servers/gateway/index.js --no-auth`.
- The receive path is live-messaging-critical: every new branch is defensively try/caught and must NEVER throw out of `onevent` (a throw kills the subscription). Preserve the existing "never break delivery" contract.
- FTS/schema: `contacts` has no FTS shadow; `request_status` is a plain nullable column via `addColumnIfMissing` (idempotent, matches `init-db.js:1818` style).
- Deploy note: after merge, crow's gateway restart picks it up; fleet via pull-only auto-update.

---

### Task 1: Schema + shared pubkey/lookup helpers

**Files:**
- Modify: `scripts/init-db.js` — `addColumnIfMissing("contacts", "request_status", "TEXT")` (nullable; NULL = normal contact, 'pending' = unaccepted request), near the other contacts `addColumnIfMissing` calls (~:1818-1822).
- Create: `servers/sharing/pubkey-util.js` — `normalizePubkey(pk)` → trailing-64 lowercase (`String(pk).slice(-64).toLowerCase()`); `findContactByPubkey(db, pk)` → `SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?` bound to `normalizePubkey(pk)`, returns row or null.
- Test: `tests/pubkey-util.test.js`

**Interfaces:**
- Produces: `normalizePubkey(pk:string):string`, `findContactByPubkey(db, pk):Promise<row|null>`.

- [ ] **Step 1:** Test `normalizePubkey`: 66-hex-with-02prefix and the same 64-hex-x-only normalize equal; case-insensitive. Test `findContactByPubkey` against a temp init-db DB: insert a contact with a 66-hex secp key, look it up by the 64-hex x-only form → found; unknown key → null.
- [ ] **Step 2:** Run → FAIL (module/column absent).
- [ ] **Step 3:** Add the migration + implement `pubkey-util.js`.
- [ ] **Step 4:** Run → PASS. Verify migration idempotent: run `CROW_DB_PATH=<tmp> node scripts/init-db.js` twice, no error, column present once.
- [ ] **Step 5:** Commit `feat(messages): request_status column + pubkey normalize/lookup helpers (L6 groundwork)`.

### Task 2: Receive-path — plaintext-from-unknown becomes a request (the core fix)

**Files:**
- Modify: `servers/sharing/nostr.js` — `subscribeToIncoming` gains a 3rd param `onMessageRequest`. **The onevent restructure (M1): thread a `handled` flag that tracks "a handler was ACTUALLY INVOKED" (not merely "type string matched")** through the `if (decrypted.startsWith("{"))` block — set `handled=true` ONLY on the exact conditions the current code invokes a handler: `payload.type==='invite_accepted' && onInviteAccepted` → invoke, handled=true; `payload.type==='crow_social' && payload.subtype && onSocialMessage` → invoke, handled=true. A `crow_social` WITHOUT a subtype, an unknown type, and a `JSON.parse` throw (starts with `{` but malformed) all leave `handled=false`. After the block, `if (!handled) await onMessageRequest(senderPubkey, decrypted, event)` — so plaintext, malformed JSON, AND a subtype-less crow_social all route to the request path (never silently dropped) without double-firing on a real handled envelope. This covers plaintext (never entered the block) AND unknown/malformed JSON, and MUST NOT double-fire for a matched type. Guard the call in its own try/catch; never throw out of onevent.
- Modify: `servers/sharing/boot.js` — at the `subscribeToIncoming(...)` wiring (:211), pass `onMessageRequest`. Prefer an exported testable `handleIncomingRequest(db, managers, {senderPubkey, content, eventId})`: (a) `findContactByPubkey`; if a contact with `request_status IS NULL` exists → do nothing (the per-contact sub already stores it — avoids double-store); if a `request_status IN ('pending','accepted')` contact exists → reuse its id; else INSERT a minimal request contact — **`crow_id='req:'+normalizePubkey(pk)` (FULL 64-hex, not truncated — a 16-hex prefix can collide → UNIQUE violation → the colliding sender's DM re-dropped, reintroducing L6)**, `secp256k1_pubkey=pk`, `ed25519_pubkey=''`, `display_name=NULL`, `request_status='pending'`, `contact_type='crow'`. Capture whether the row was NEWLY created. (b) `INSERT OR IGNORE INTO messages (...)` direction='received', is_read=0, keyed by `event.id`. (c) **Notify only when the request contact row was NEWLY created this call** (deterministic first-contact signal — NOT a post-insert `count==1`, which races at the async INSERT/COUNT boundary), `source:"sharing:message_request"`, `action_url:"/dashboard/messages"`. All best-effort/try-caught.
- Test: `tests/message-request-receive.test.js`

**Interfaces:**
- Consumes: `findContactByPubkey`, `normalizePubkey` (Task 1). Produces: an `onMessageRequest(senderPubkey, plaintext, event)` handler (exported from a small module or defined inline in boot with a testable helper `handleMessageRequest(deps)` — prefer a pure-ish exported `handleIncomingRequest(db, managers, {senderPubkey, content, eventId})` so it's unit-testable without live relays).

- [ ] **Step 1:** Write `tests/message-request-receive.test.js` against a temp init-db DB with injected deps: calling `handleIncomingRequest` with an unknown pubkey creates ONE `request_status='pending'` contact + ONE received message + fires ONE notification (stub); a second message from the same pubkey adds a message but does NOT create a second contact and does NOT re-notify; a pubkey that matches an EXISTING accepted contact creates NO request row (returns early). Assert the event-id dedup (same event.id twice → one message).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `handleIncomingRequest` + wire `onMessageRequest` in boot.js + the 3rd branch in nostr.js. Verify `onevent` still can't throw (wrap the new call).
- [ ] **Step 4:** Run → PASS. Boot smoke: `node servers/gateway/index.js --no-auth` starts clean (subscribeToIncoming wires with 3 args).
- [ ] **Step 5:** Commit `fix(messages): unknown-sender DMs become message requests instead of being silently dropped (L6)`.

### Task 3: Gate request rows out of ALL normal surfaces (7 gates incl. the security bypass)

**Files (the COMPLETE gate set — a missed gate leaks a bare/partial row into normal flows; gate #4 is a security fix):**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js` — `getUnifiedConversationList` (:51): `AND (c.request_status IS NULL OR c.request_status='accepted')` (show full + accepted; hide 'pending'). `getBotDirectory` (:168): exclude `request_status IS NOT NULL`.
- Modify: `servers/sharing/boot.js` — startup loop (:180): SELECT `request_status` too, then SPLIT per row: `request_status IS NULL` → `initContact`+`joinContact`+`subscribeToContact`; `'accepted'` → `subscribeToContact` ONLY; `'pending'` → skip.
- Modify: `servers/sharing/room-inbound.js` — **SECURITY (C1, expanded round-2). Trust surfaces = NULL ONLY:** (a) :27 `room_join` host-trust `SELECT` → `AND request_status IS NULL`; (b) **:36 member-add** `SELECT id FROM contacts WHERE crow_id=?` → `AND request_status IS NULL` (else a `room_join` payload naming a partial `req:<pubkey>` crow_id injects it into `contact_group_members`); (c) :55 host match → `AND request_status IS NULL`.
- Modify: `servers/gateway/dashboard/panels/messages/rooms-store.js` `listRoomMembers` (:54-57) — add `AND c.request_status IS NULL` so a partial row that somehow became a member can NOT pass the `room_message` signer-auth `.find()` at `room-inbound.js:52` (the round-2 escalation path).
- Modify: `servers/sharing/tools/messaging.js` `crow_send_message` (:28) — the target lookup `WHERE (crow_id=? OR display_name=?) AND is_blocked=0` → add `AND (request_status IS NULL OR request_status='accepted')` so a **'pending'** (not-yet-accepted) request can't be messaged by guessing its `req:<pubkey>` id, while an **accepted** one CAN (you replied to it). (Messaging surface = NULL + accepted.)
- Modify: `servers/gateway/dashboard/panels/contacts/data-queries.js` (:41 `getContacts`) — add `request_status IS NULL` to its WHERE so `req:` rows don't show as bare contacts.
- Modify: `servers/sharing/tools/contacts.js` (:245 `crow_list_contacts`) — exclude `request_status IS NOT NULL`.
- Modify (defensive): the `contacts` outbound-sync filter IF one exists (`instance-sync.js` `shouldSyncRow`/emit path) — exclude non-NULL `request_status`. (Contacts don't push-sync today — no `emitChange("contacts")` — so this is belt-and-braces; confirm during impl and note.)
- Test: extend `tests/message-request-receive.test.js` + a room-inbound security test.

- [ ] **Step 1:** Failing assertions: (a) a 'pending' contact absent from `getUnifiedConversationList`, an 'accepted' one present; (b) **security:** a `room_join` from a pubkey that only has a 'pending'/'accepted' request row is REJECTED (no room created) AND its member-list injection (:36) does NOT add a partial contact to `contact_group_members` AND `listRoomMembers` excludes partial rows AND a NULL contact IS accepted; (c) 'pending'/'accepted' absent from `getContacts` + `crow_list_contacts`; (d) `crow_send_message` refuses a 'pending' target but allows an 'accepted' one.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Apply all gates.
- [ ] **Step 4:** Run → PASS; grep for ANY OTHER `FROM contacts` reads that assume full contacts (report the full list; gate any that would act on a partial row).
- [ ] **Step 5:** Commit `fix(messages): gate request rows out of conversation list, sync loop, bot directory, Contacts panel, crow_list_contacts, and room-join trust (security)`.

### Task 4: Messages UI — "Requests (N)" block + Accept/Decline actions

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js` — new `getMessageRequests(db)` → pending-request rows with a preview (latest message content + count + created_at), ordered newest-first.
- Modify: `servers/gateway/dashboard/panels/messages/messages.js` — fetch requests, pass to `buildMessagesHTML`.
- Modify: `servers/gateway/dashboard/panels/messages/html.js` — render a "Requests (N)" collapsible block at ~:126 (template: `msg-bot-invite-card` :39-47), each with the sender (`req:<id>` / short pubkey), the message preview, an **Accept** and a **Decline** button (both `<form method="POST">` with CSRF via `csrfInput(req)`, hidden `action=accept_request`/`decline_request`, hidden `request_id`). i18n keys EN+ES for the labels.
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js` — `accept_request`: set `request_status='accepted'` (NOT NULL — keeps the partial-identity row gated from peer-join/sync/room-trust until R4 upgrades it), mark its messages read, call `nostrManager.subscribeToContact({id, crow_id, secp256k1_pubkey})` (best-effort). `decline_request`: delete the request contact (CASCADE drops its messages). Decline-delete is safe because request rows don't sync (no re-sync race). Both `res.redirectAfterPost("/dashboard/messages")`, guarded.
- Test: `tests/message-request-actions.test.js` (handlePostAction with a stubbed managers/db — accept flips status + subscribes; decline removes the row).

- [ ] **Step 1:** Test the two actions via `handlePostAction` (reuse the injectable `sharingClientFactory`/managers pattern from the QW2 work): `accept_request` sets `request_status='accepted'` + calls `subscribeToContact`; `decline_request` removes the contact. Assert unknown/blocked request_id is a safe no-op redirect.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `getMessageRequests`, the HTML block (+ i18n EN/ES), and the two handlers.
- [ ] **Step 4:** Run → PASS. Live-render check: `node servers/gateway/index.js --no-auth`, open Messages with a seeded pending request, confirm the block + buttons render (or assert via the render path).
- [ ] **Step 5:** Commit `feat(messages): Requests (N) inbox with Accept/Decline (EN+ES)`.

### Task 5: End-to-end proof via the harness (L6 no longer drops)

**Files:**
- Modify (on this branch, cherry-pick or note): the messages-e2e harness `half-handshake-drop` scenario asserts what CHANGED — after the fix, a DM from a non-contact must produce a `request_status='pending'` row + a stored message on the recipient (NOT zero delivery). (The harness lives on `feat/messages-p1a-harness`/Gitea; here just add a focused integration-style test, `tests/message-request-e2e.test.js`, that drives `handleIncomingRequest` + `accept_request` end-to-end against a temp DB and asserts the message is retained + surfaces after accept.)

- [ ] **Step 1:** Integration test: simulate the L6 sequence (unknown pubkey DM → request created + message stored → accept → message now in the normal thread via `getPeerMessages`, contact `request_status='accepted'`). Assert the message was NEVER lost.
- [ ] **Step 2:** **Negative security assertion (so C1 can't ship green):** the SAME unknown pubkey, while only a 'pending' request (and again while 'accepted'), sends a `room_join` `crow_social` envelope → `handleInboundRoomEnvelope` must REJECT it (no room row created). Only a NULL contact passes.
- [ ] **Step 3:** Run → PASS (green proves L6 closed AND the trust boundary held).
- [ ] **Step 4:** Full suite `node --test tests/` stays green (no regression). Commit `test(messages): end-to-end request retention + room-join trust-boundary proof (L6 closed, no bypass)`.

---

## Follow-on Phase 1b (outline — separate plans/PRs after L6 ships)

- **R2 — honest sender feedback**: add `delivery_status` to `messages` (`pending`/`relayed(n)`/`failed`); `crow_send_message` returns `isError` on 0 relays; dashboard surfaces failures instead of `console.error`+redirect (`api-handlers.js:51-54`); bubble state in `client.js`.
- **Relay-SPOF fix** (found in P1a run: crow publishes to only 1 of 2 default relays — damus.io silently skipped): root-cause `connectRelays`/`safeRelayPublish` (why one default relay never connects on crow), + wire `getConfiguredRelays` (dead code, L4) so relay set is configurable/observable.
- **R4 handshake de-fragilize**: idempotent persisted `invite_accepted` processing (kill the 24h `initialSince` cliff, L3) + "add by crow_id + ed25519 + secp" repair primitive (promotes a request to a full peer-synced contact once identity is known).
- **R6/R8**: `ss -K` L2 reconnect-window test; decouple Nostr subscription wiring from Hyperswarm start (L11).

## Review

**Round 2 (2026-07-02, adversarial subagent): REVISE — more room-trust surfaces + a send gap + an M1 edge, all fixed:**
- room-inbound.js:36 member-add and `rooms-store.js listRoomMembers` (the `room_message` signer-auth source at :52) were ungated → a partial contact could be injected as a room member and pass signer auth. Both now gated `request_status IS NULL`.
- `crow_send_message` (messaging.js:28) could message a still-'pending' request by guessing `req:<pubkey>` → gated to NULL + 'accepted' (crisp model: **trust/peer surfaces = NULL only; messaging surfaces = NULL + accepted**).
- M1 `handled` clarified to mean "handler actually invoked" (a `crow_social` with no subtype now routes to the request path instead of being dropped — would've been a narrow L6 recurrence).
- Task 5 security assertions expanded to cover member-injection + listRoomMembers + send-to-pending. Round 2 positively confirmed the three-state predicates are internally consistent across all gates and the CASCADE deletes are safe.

**Round 1 (2026-07-02, adversarial subagent, opus): REVISE — all criticals fixed:**
- **C1 (security bypass):** an unknown sender who DMs (auto-creating a request row) then sends `room_join` would satisfy `room-inbound.js:27`'s `is_blocked=0` trust check → room-host trust. Added gate #4 (`request_status IS NULL` on the room-join trust query) + a negative security test (Task 5 Step 2).
- **C2 (contacts is SYNCED_TABLE):** verified NO `emitChange("contacts")` exists → contacts don't push-sync, so request rows won't propagate; nullable column self-heals on peers. Added a defensive outbound-sync exclusion (gate #7).
- **C3/S3 (incomplete gating):** Contacts panel `getContacts` + `crow_list_contacts` also read the raw table → added as gates #5/#6. Total gate set now 7 (was 3).
- **M1:** onevent restructure now threads a `handled` flag through all 3 JSON sub-paths (matched / unmatched-type / parse-throws) so plaintext AND malformed JSON route to the request path without double-firing on matched types.
- **M2:** accept → `'accepted'` (a distinct GATED state), NOT NULL — prevents the partial-identity row from masquerading as a full contact in the boot peer-join loop, sync, and room trust.
- **M3:** `crow_id='req:'+FULL 64-hex` (not 16) — no UNIQUE-collision that would re-drop a colliding sender's DM.
- **S1:** notify on request-row-newly-created (deterministic), not a racy post-insert `count==1`.
Scope (Q7): closing L6 with a *partial* accept (messaging restored, full peer-sync deferred to R4) is a legitimate honest cut — it stops losing the DMs and lets the operator reply, without the C1/M2 fallout of a fake-full contact.

## Self-review notes
- Closes L6 (the confirmed operator bug) end-to-end AND holds the room-join trust boundary: no silent drop, visible request, one-click accept, first-contact notification, message retained through accept, and a partial row can never gain peer/sync/room trust.
- Three-state `request_status` (NULL/pending/accepted) with a COMPLETE 7-surface gate set; accept produces a deliberately-partial contact (documented) pending R4 identity upgrade.
- Receive path stays throw-proof (guarded new branch; the whole point is to not break delivery).
