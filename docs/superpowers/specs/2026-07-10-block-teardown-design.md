# Block actually blocks — Cluster C design (F-BLOCK-1 + addendum)

Date: 2026-07-10 · Arc: Crow Messages usability overhaul, P4 walkthrough Cluster C
Finding: F-BLOCK-1 [S5-MAJOR] — blocking a contact does not stop inbound messages
until the next gateway restart; addendum: the blocked inbound lands `is_read=0`
and bumps the unread badge. Independent of Clusters B/D.

## 1. Problem

`WHERE is_blocked = 0` is applied only when subscriptions are BUILT
(`subscribeToIncoming` / boot-time contact iteration). Blocking an
already-subscribed contact flips the row but never tears down its live
per-contact Nostr relay subscription, so `subscribeToContact.onevent` keeps
INSERTing inbound rows (with `is_read=0` → unread bump) until a restart rebuilds
subscriptions with the filter. Verified live in the S5.4 walkthrough: a second DM
from a blocked (accepted-stranger) contact was stored, `messages` count 1→2.

What the block handlers DO already tear down (both the contacts panel and the
messages panel have one): Hypercore feeds (`syncManager.closeContactFeeds`) and
the DHT topic (`peerManager.leaveContact`) — inline, with a stale comment
claiming "no lazy re-init path exists for contacts. A restart or re-invite is
needed to reopen feeds after an unblock." That was true when written; since
R4/#155 the lazy re-init exists (`wireFullContact` = `initContact` +
`joinContact` + `subscribeToContact`, and `wireSyncedContact` wraps it with the
blocked/local-bot/keyless guards).

The missing pieces:
1. Neither block handler tears down the **Nostr subscription** — the exact
   channel the walkthrough proved still delivers.
2. Neither unblock handler re-wires anything (and the sync-applied unblock DOES
   re-wire via `onContactSynced` → `wireSyncedContact` — the local product
   action is strictly worse than the synced echo of it).
3. The sync-apply blocked branch (`wireSyncedContact`, contact-promote.js:101)
   closes feeds + leaves the DHT but ALSO leaves the live Nostr sub — the same
   gap on the cross-instance leg (blocks follow the user since Phase 3; S7 7.2
   proved the `is_blocked` mirror lands in ~2s, but the mirrored instance keeps
   receiving until restart too).
4. `handleIncomingRequest` (boot.js) reuses an existing `pending`/`accepted`
   request contact and stores the DM with **no `is_blocked` check** — the S5.4
   store path for blocked request contacts, alive even after (1)-(3) tear down
   per-contact subs, because the catch-all incoming subscription still fires.

## 2. Non-goals

- No change to ROOM inbound (`room-inbound.js` hub-and-spoke path) — out of
  scope. NOTE (R1 MAJOR-1 correction): the original rationale here ("blocked
  members are filtered at send-time fan-out") was WRONG — a sender-side filter
  (tools/messaging.js:181 filters *my* blocked members when *I* fan out) does
  nothing about what a blocked contact sends *to me*. The legacy
  `group_message` receive path is therefore IN scope now (D4c below).
- No new unread-badge code: the badge bump WAS the stored row. The conversation
  list + `totalUnread` already filter `c.is_blocked = 0`
  (messages/data-queries.js:51), and the live `messages:changed` unread emit is
  gated on `rowsAffected > 0`. Once blocked inbound never stores, nothing bumps.
- No schema change — **SCHEMA_GENERATION stays 6** (verified: no DDL).
- No sync-protocol change — block/unblock already emit `contact` updates
  (Phase 3, live-proven in S7 7.2).
- Receipts/acks FROM a blocked contact for messages we previously sent still
  process (`handleDeliveryReceipt` is contact-bound and harmless); only their
  inbound DMs are silenced. Likewise `handleHandshakeComplete` (boot.js:285)
  from a blocked contact can still apply a sanitized display name over a
  PLACEHOLDER name (R2 F5) — cosmetic, placeholder-only, and the conversation
  is `is_blocked`-filtered out of the list; dispositioned harmless, not gated.

## 3. Design

### D1 — Block tears down ALL live wiring (both panels)

In both block handlers (contacts/api-handlers.js `action === "block"`,
messages/api-handlers.js `action === "block"`): after the `is_blocked = 1`
UPDATE, fetch the row once and replace the inline feeds+DHT teardown with
`unwireContact(managers, row)` (contact-delete.js:94 — the #155 delete-path
primitive: `nostrManager.unsubscribeFromContact(crow_id)` +
`syncManager.closeContactFeeds(id)` + `peerManager.leaveContact(crow_id)`,
each independently guarded, never throws). One teardown owner; the block
handlers stop owning a hand-rolled subset. Then `emitContactChange("update",
row)` as today. The stale "no lazy re-init path exists" comments are deleted
(superseded by D2).

`unsubscribeFromContact` keys handles as `${crowId}:${url}` and iterates
`this.relays` — it works for `crow:`, `req:` and `manual:` ids alike (the S5.4
contact was a `req:`-rooted accepted stranger; `accept_request` wires a
per-contact sub at messages/api-handlers.js:319, so blocking one MUST unwire).

### D2 — Unblock re-wires (both panels)

In both unblock handlers: after the `is_blocked = 0` UPDATE, fetch the row and
call `wireSyncedContact(managers, row)` (contact-promote.js:97). Its internal
guards do the right thing for every contact class: now-unblocked keyed contact →
`wireFullContact` (feeds + DHT + Nostr sub); `local-bot` → no-op; keyless
`manual:` → no-op. Fully guarded, never throws — safe in a request handler.
Unblock is now symmetric with block, no restart needed, and the local action
matches what the sync-applied echo already did.

### D3 — Sync-apply leg: the blocked branch uses the full teardown

`wireSyncedContact`'s blocked branch (contact-promote.js:101-105) replaces its
two inline calls (closeContactFeeds + leaveContact) with
`unwireContact(managers, row)` — adding the missing `unsubscribeFromContact`.
Import is clean: contact-promote.js already imports from contact-delete.js
(readTombstone/clearTombstone), no new cycle. With this, a block placed on any
of the user's instances tears down the live sub on ALL of them within the ~2s
sync window, and a synced unblock re-wires via the same hook (already routed:
`_applyContact` update → `onContactSynced` → `wireSyncedContact` →
`wireFullContact` once `is_blocked=0` — the S7-proven path).

### D4 — Receive-time guards (the race window + regression insurance)

Teardown is the fix; these make the receive path *unable* to store blocked
inbound even during the block→teardown race, an in-flight event, or a future
wiring path that forgets teardown:

- **(a) `subscribeToContact.onevent`** (nostr.js:~482, before the messages
  INSERT): fresh single-row check `SELECT is_blocked FROM contacts WHERE id = ?`
  — if blocked: return early. No store, no notification, no unread emit, no
  instance-sync mirror emit, no delivery receipt, no `onMessage` callback.
  Blocking is SILENT toward the blocked party (matching the delete path's
  no-reconnect posture): we deliberately stop confirming receipt. One indexed
  point-SELECT per inbound DM from that contact — negligible, and only until the
  teardown lands (normally milliseconds later).
- **(b) `handleIncomingRequest`** (boot.js:83-90): after `findContactByPubkey`,
  `if (existing && Number(existing.is_blocked) === 1) return;` — before contact
  reuse and before the store. A blocked contact of ANY request_status (full,
  pending, accepted) is silently dropped on the catch-all path. This kills the
  S5.4 store path.
- **(c) `group_message` handler** (boot.js:548-577, R1 MAJOR-1): the
  `onSocialMessage` branch fires a notification UNCONDITIONALLY (:552) and
  stores a `direction='received'` row (:573) with no `is_blocked` check — a
  blocked contact who shares a group can still ping the notification tray via
  `crow_send_group_message` (they didn't block us; their fan-out includes us).
  Fix (R2 F2 — this is a REORDER, not an in-place extension: the sender lookup
  currently sits at :567, AFTER the notification): move the sender resolve
  (`SELECT id, is_blocked FROM contacts WHERE crow_id = ?`) ABOVE the
  notification, and early-return ONLY when the resolved row exists AND
  `is_blocked === 1`. An UNKNOWN (non-contact) group sender must still notify
  exactly as today — the guard is `found && blocked`, never `!found` (test
  pins this).
- **(d) blocked re-wire guard (R1 MINOR-2):** a blocked contact's
  `invite_accepted` (or its ~60h retry re-send) currently flows
  `handleInviteAccepted` → `upsertFullContact` → `wireFullContact`, recreating
  the sub/feeds/DHT state this design tears down. Fix in two layers:
  `handleInviteAccepted` early-returns (no upsert, no ack — silence toward the
  blocked party) when the resolved sender contact is blocked, AND
  `wireFullContact` itself skips wiring when `row.is_blocked` (belt: no upsert
  path — tool, accept, handshake — can wire a blocked contact; the wiring
  returns on unblock via D2).
  **Placement is load-bearing (R2 F1 MAJOR):** the early-return (resolve via
  `findContactByPubkey(senderPubkey)` + blocked check) goes IMMEDIATELY after
  the R4 auth check (boot.js:182) and BEFORE the `wasProcessed` replay branch
  (:190) and the short-code `"replayed"` branch (:209) — both of those branches
  ACK. The common blocked case is "added via a processed invite_accepted, then
  blocked": its ~60h retry re-sends the same event.id, which hits `wasProcessed`
  → ack. Placed after :190, the guard's sole unique contribution (ack silence)
  silently fails. Mutation test: a blocked sender whose event.id is already in
  processed_control_events produces NO sendControl/ack call.
  **Ledger note (R2 F6):** skipping `consumeShortInvite` for a blocked sender is
  safe — the invite was consumed on the pre-block accept (a retry verdicts
  "replayed" and changes nothing) and any genuinely-unconsumed row expires at
  the 72h ledger TTL. No outstanding-forever leak.
  **Export note (R2 F3):** `wireFullContact` is currently module-private —
  export it so the belt-guard test can drive it directly.

### D5 — Testability seam

`handleContactAction` (contacts) gains `managers` in its options object
(`{ sharingClientFactory, managers = getManagersOrNull() }`), mirroring the
messages handler's existing `_managers` seam (api-handlers.js:56-57). Tests
inject stub managers and assert the teardown/re-wire calls; production behavior
unchanged.

## 4. Tests (TDD; mutation-test every guard)

1. Contacts-panel block: stub managers → `unsubscribeFromContact(crow_id)`,
   `closeContactFeeds(id)`, `leaveContact(crow_id)` all called; row
   `is_blocked=1`; `emitContactChange` still fires (existing S7 suite must stay
   green). **Mutation:** reverting the handler to the old inline pair (dropping
   unsubscribe) reddens exactly the Nostr-teardown assertion.
2. Contacts-panel unblock: stub managers → `initContact` + `joinContact` +
   `subscribeToContact` called (via `wireSyncedContact`); keyless `manual:`
   contact → none called, no throw.
3. Messages-panel block/unblock: same pair through `handlePostAction` with
   `_managers`, keyed by `crow_id`, including a `req:` accepted-stranger row
   (the S5.4 shape).
4. `wireSyncedContact` blocked row → `unsubscribeFromContact` called (the D3
   leg). **Mutation:** restoring the old inline pair reddens it.
5. `handleIncomingRequest`: blocked pending / blocked accepted / blocked full →
   NO message row, NO notification; unblocked pending still stores (existing
   behavior green). **Mutation:** removing the guard reddens the blocked-accepted
   case on the message-count assertion.
6. `onevent` guard: drive a real `NostrManager` instance with a stub relay that
   captures the subscription's `onevent` — mirror `tests/nostr-receive-health-hooks.test.js`
   / `tests/nostr-resubscribe.test.js` (`mgr.relays.set("wss://stub", relay)` +
   captured `subscribeCalls[0].onevent` + `encryptToUs`; R1 MINOR-6 corrected the
   earlier citation) — deliver a NIP-44-encrypted event for a contact flipped to
   `is_blocked=1` AFTER subscribe → no messages row, no receipt attempt; flip
   back → stores. **Mutation:** removing the fresh check reddens the blocked case.
7. D4c group_message guard: blocked sender's group_message → no notification, no
   stored row; unblocked sender's still notifies+stores; **unknown (non-contact)
   sender still notifies** (pins the reorder against a `!found` mistake).
   **Mutation:** removing the guard reddens the blocked case on both assertions.
8. D4d blocked re-wire: `handleInviteAccepted` from a blocked sender → no upsert
   mutation, no ack, no wiring — INCLUDING the replay case: blocked sender +
   event.id already recorded in processed_control_events → NO sendControl/ack
   (pins the guard's placement before the ack branches). `wireFullContact`
   (exported) with a blocked row → none of initContact/joinContact/
   subscribeToContact called. **Mutation:** each layer's removal reddens its
   own test.
9. Full suite ≥ current baseline (1385/1 pre-existing/1 skip); gateway boots
   clean.

## 5. Verification beyond the suite

- **CDP scratch gateway:** click Block on a seeded contact in the real messages
  UI → conversation disappears from the list, row `is_blocked=1`; Unblock →
  reappears. (Subscription behavior needs a live peer — next bullet.)
- **Post-deploy live E2E (crow ↔ black-swan, the kept test pairing):** block the
  Black Swan contact on crow via the product UI; send a DM from black-swan →
  assert NO new messages row on crow, unread badge unchanged, and (bonus) the
  sender's message stays `relayed` (never `delivered` — receipts are silenced).
  Unblock on crow; send again → arrives live. This reproduces the exact S5.4
  walkthrough failure and proves it dead. Cross-instance leg: verify grackle/MPA
  mirrored `is_blocked` AND their subscription maps no longer hold the contact's
  keys (via a one-shot inspection or a second DM while blocked).

## 6. Risks / review focus

- `wireSyncedContact` on unblock re-runs `initContact` — verify re-init of an
  already-torn-down feed pair is clean (it is the same call the sync-applied
  unblock already makes today).
- D4a adds a per-event DB read on the hot receive path — bounded (indexed PK
  lookup), and only for per-contact subs.
- Silencing delivery receipts to blocked senders is an intentional behavior
  change (documented above).
- The block→teardown ordering leaves a millisecond-scale race where an
  in-flight event could store — closed by D4a's fresh check.
- `unwireContact` also closes sync feeds; a blocked contact therefore stops
  message-mirroring too — same semantics the block handlers already had
  (closeContactFeeds was already inline).
- **R1 MINOR-3 + R2 F4 (accepted):** unblock over-wires `req:` rows —
  `wireFullContact` creates an out-feed + DHT topic where `accept_request` only
  ever subscribed, and a keyed PENDING request row gains a per-contact sub that
  boot deliberately omits (boot.js:479 skips pending). Harmless: all steps
  guarded, the stranger can't replicate, and `INSERT OR IGNORE` on
  nostr_event_id dedupes any double-store vs the incoming catch-all; block on a
  pending row is not reachable from the UI (only Accept/Decline render).
  Documented asymmetry, not engineered around. Note `req:` rows have no synced
  echo (they don't sync), so the "matches the sync-applied echo" argument
  applies only to full contacts.
- **R1 MINOR-4 (precision):** unblock restores the out feed only —
  `initContact(row.id, null)` cannot restore a peer in-feed without a fresh
  handshake (`theirFeedKey`). Identical to what a boot restart produces; DMs
  (the finding's scope) are fully restored via the Nostr sub.
- **R1 MINOR-5 (disclosure):** on a multi-own-instance fleet,
  `_applyMessage` (instance-sync.js:1510) deliberately STORES a mirrored row
  for a locally-blocked contact ("converged-block semantics") while suppressing
  the badge + notification — so during the ~2s block-mirror window a peer's
  store can still mirror in, invisibly. "Blocked inbound never stores" is
  strictly true per-instance for relay inbound; fleet-wide invisibility is
  row-suppression. §5's "no new messages row on crow" assertion is valid for
  crow↔black-swan precisely because distinct identities have no instance-sync
  mirror.
