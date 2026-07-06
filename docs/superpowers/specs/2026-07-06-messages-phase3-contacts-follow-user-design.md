# Messages Phase 3 — Contacts follow the user (D1) — design spec

> **Status: DESIGN (approved by operator 2026-07-06).** Next: writing-plans →
> execution plan per PR in `docs/superpowers/plans/` (PR3-plan format) →
> 2-round adversarial SECURITY review (crosses the sync trust boundary) →
> subagent-driven execution → final security review → PR (operator-gated) →
> deploy fleet-wide. This is **Phase 3** of the Crow Messages usability arc.
> Master plan: `docs/superpowers/plans/2026-07-01-crow-messages-usability-arc.md` (§ Phase 3).
> Phase 2 (contact-add UX) is COMPLETE (PR1 #135, PR2 #136, PR3 #140, deployed 2026-07-06).

## Why

Contacts are **per-instance** today. A user running Crow on more than one machine
(the operator runs crow + grackle, same identity `crow:kdq7zskhat`) must add every
contact separately on each instance, and a contact added on grackle is invisible on
crow. Per locked decision **D1** ("contacts follow the user"), the user's contact
list — plus blocks — should sync across all of their own paired instances via the
existing instance-sync mesh, so adding/blocking a contact anywhere applies everywhere.
The bar remains "stupidly simple" for a non-technical multi-device user.

D1 as written also names **groups**, and the shared-identity model surfaces a second
gap the operator chose to close in this phase: **conversation coherence** (S3) — with
one identity, inbound DMs land on every online instance but outbound (sent) messages
exist only where typed, so threads read half-mirrored. That looks like a bug.

## Scope (locked with operator 2026-07-06)

| # | Decision |
|---|---|
| S-SCOPE | **Contacts + conversation coherence.** Phase 3 = contact list + blocks follow the user (PR-A) **and** message coherence — outbound mirroring + notification dedupe (PR-B). This deliberately revisits D1's "no message-history mirroring" line with better information: with a shared identity, coherent threads are what "stupidly simple" implies. |
| S-VERIFIED | **`verified` does NOT sync** (added to `EXCLUDED_COLUMNS.contacts`). "verified" means "I compared the safety number on THIS device" — a per-device attestation; a synced `verified=1` would assert a check the receiving device never performed. Each device verifies independently. Consistent with PR3's reset-to-0-on-key-change. |
| S-GROUPS | **Groups deferred to a dedicated follow-up PR** (after PR-A proves out). Ordinary `contact_groups` have no stable cross-instance key (`id` is per-instance `AUTOINCREMENT`, `room_uid` is NULL for non-rooms) and `contact_group_members` joins two per-instance FKs; and `room_uid` groups **are** the multi-party rooms (their own Nostr sync). Groups need a new `group_uid` + wire-mapped membership + a rooms carve-out — enough surface to warrant its own reviewable PR. D1's groups clause is honored, just sequenced. |
| S-BOTS | **Sync non-local bots only.** Contacts with `origin='local-bot'` (a Bot-Builder bot hosted on THIS instance — it doesn't run on the peer and its secp key is instance-local) are excluded both directions. Advertised/remote bot contacts (`is_bot=1`, real cross-instance peers) sync like any human contact. |
| S-REQUESTS | **Sync established only: `request_status` NULL + `accepted`.** Pending message-requests are a per-instance inbox each instance forms independently from the SAME shared inbound Nostr stream, so syncing `pending` is redundant and race-prone. When one instance accepts/promotes, the accepted state converges by `crow_id`. |
| S-LASTSEEN | **`last_seen` does NOT sync** (added to `EXCLUDED_COLUMNS.contacts`). `boot.js:779` bumps `last_seen` on every inbound DM — syncing it would turn the sync feed into a per-message firehose for zero user value. |
| S-DELETE | **Deletes propagate by `crow_id`, lamport-gated.** An explicit contact deletion on one instance removes it fleet-wide; a stale delete with a lower `lamport_ts` cannot destroy a newer local edit (existing `_checkConflict` update/delete gating). |
| S-COHERENCE-DIR | **Mirror messages in BOTH directions.** Emitting inbound rows too lets sync backfill whatever an instance missed while offline (relay-retention gaps), not just outbound coherence. Store-dedupe by `nostr_event_id UNIQUE` makes this safe. |
| S-NOTIFY | **Notification dedupe is per-event, not per-instance.** `is_home` is unset across the live fleet and documented as unreliable, so no primary-notifier. Layer (a): suppress notify when the message row already existed (`INSERT OR IGNORE` rowsAffected=0). Layer (b): carry `nostr_event_id` as a client-collapse key in the notification payload for the simultaneous-Nostr-receipt case. |

## Non-goals

- **Full account model / message-history bulk backfill** beyond forward-mirroring new rows. (Explicitly declined in D1. Sync carries rows created after the feature ships; there is no historical replay job.)
- **Groups in this phase** (deferred — see S-GROUPS).
- **Cross-*user* sync.** This is one user's own instances (shared seed). The wife's MacBook is a separate identity and is NOT in this sync domain. black-swan (`crow:1m5ughwje2`) is a distinct identity — a peer you'd add, not a sync target.
- **A rich sync-status/conflict UI.** S4 is minimal (surface via the existing `sync_conflicts` path; optional subtle origin marker on contact rows). No new dashboard panel.

## Fleet precondition (verified live 2026-07-06)

- crow identity `crow:kdq7zskhat`; grackle shares it; both paired `trusted=1`, `last_seen` today.
- crow gateway log: `[instance-sync] eagerly opened 2 peer feed(s) — emit pipeline armed` + `[sharing] Initialized sync feeds for 2 instance(s)`. grackle carries crow as a trusted peer. **Instance-sync replication is live crow↔grackle** — the real Phase 3 test target.
- ⚠️ grackle is on `user_version=3` (has not restarted since PR3 #140 merged); it will apply PR3's `verified` migration on its next gateway restart, which Phase 3's deploy performs anyway.

## Architecture — what exists, what changes

**Existing sync machinery (`servers/sharing/instance-sync.js`, verified @ `996a0d42`):**

- `SYNCED_TABLES` already lists `contacts` (line 52) and `messages` (line 54) — but **nothing emits** either today (the only `emitChange` callers are memories, crow_context, providers, dashboard_settings). The pull side is wired; the push side was never built. Phase 3 builds the push side and the correct pull-apply.
- The generic inbound apply (`_applyInsert`/`_applyUpdate`/`_applyDelete`/`_checkConflict`) keys entirely on `row.id` (`WHERE id = ?`). Contacts' and messages' `id` are per-instance `AUTOINCREMENT`; copying a source `id` into a peer is wrong/colliding.
- **In-repo precedent for a natural-key apply:** `crow_context` (composite key) routes through `_applyCrowContext` and `dashboard_settings` (keyed on `key`) routes through `_applyDashboardSetting`, both dispatched in `_applyEntry` *before* the generic id-path (lines 637, 658). Phase 3 adds analogous handlers.
- `EXCLUDED_COLUMNS` strips columns from the wire payload before broadcast/signature; `OUTBOUND_TRANSFORMS` rewrites a row on the wire (precedent: `research_notes` NULLs `project_id`); `shouldSyncRow(table, row)` gates whole rows both directions (precedent: `dashboard_settings` allowlist). All three are the extension points Phase 3 uses.
- `contacts` has `lamport_ts INTEGER DEFAULT 0` (init-db:1717) and `crow_id TEXT NOT NULL UNIQUE` (init-db:457). `messages` has `nostr_event_id TEXT UNIQUE` (init-db:536). These are the stable keys the natural-key apply uses.
- `upsertFullContact` (`servers/sharing/contact-promote.js`) is already a `crow_id`/secp-keyed idempotent insert/promote/merge/noop — the natural inbound-apply primitive for contacts, and the shape `_applyContact` should delegate to rather than re-implement.

### PR-A — Contacts + blocks follow the user

**A1. Push side (emit).** Add `emitChange("contacts", op, row)` at every mutation site that changes *synced* contact state:
- `servers/sharing/contact-promote.js` — `upsertFullContact` outcomes (insert / promote / merge / delete-loser).
- `servers/sharing/boot.js` — the auto-add on authenticated `invite_accepted` (emits only when the resulting row is `accepted`/NULL).
- `servers/gateway/dashboard/panels/contacts/api-handlers.js` — manual insert, edit, block, unblock, delete.
- `servers/gateway/dashboard/panels/messages/api-handlers.js` — block, unblock, accept-request (→ promote path), decline-delete.
- `servers/sharing/tools/contacts.js` — MCP `crow_add_contact`/`crow_find_contacts` inserts.

**Not emitted:** the `verified` toggle (S-VERIFIED), the `last_seen` bump (S-LASTSEEN), and any write to a local-bot row (S-BOTS). Emit is wrapped so a sync failure never breaks the local write (the established `.catch(()=>{})` / `try{}catch{}` pattern at existing emit sites).

**A2. Pull side — `_applyContact`, keyed on `crow_id`.** New handler dispatched in `_applyEntry` before the generic id-path (alongside the `crow_context`/`dashboard_settings` special-cases). It:
- Resolves the local row by `crow_id` (never `id`).
- Applies LWW via `lamport_ts`: incoming `> local` → apply; `<= local` and equal → skip; `<= local` and differ (incl. tie) → conflict, local kept (matches `_checkConflict`/`_applyCrowContext` W4-1 semantics).
- Delegates insert/merge to `upsertFullContact`-style logic so promote/merge/rebind is handled identically to the local path.
- Honors `shouldSyncRow("contacts", row)` on the inbound side too (defense-in-depth: drop a local-bot or non-established row a peer shouldn't have sent).

**A3. Carve-outs.**
- `EXCLUDED_COLUMNS.contacts = ["verified", "last_seen"]` (plus `id`, never on the wire).
- `shouldSyncRow` extended: for `contacts`, return false when `origin === 'local-bot'` OR `request_status` is a value other than NULL/`'accepted'` (i.e. `'pending'`). Applied on emit AND apply.
- The wire row carries the established contact columns: `crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, relay_url, is_blocked, is_bot, origin, request_status, avatar_url, bio, notes, contact_type, email, phone, email_hash, external_handle, external_source, feed_key`. (`feed_key`/`external_*` inclusion confirmed harmless-or-useful at plan time; when in doubt, exclude — a follow-up can add.)

**A4. Post-apply hook — `onContactSynced` (load-bearing).** A synced-in contact must become *live* on the receiver, or it appears in the list but never receives messages — defeating the point. Inject an `onContactSynced(localContactRow)` callback into `InstanceSyncManager` at boot (same injection style as `createNotification`), which runs `syncManager.initContact` + `subscribeToContact` + topic-join — **only if** the contact is not blocked and not a local-bot. A synced update that newly sets `is_blocked=1` unsubscribes. Correct because the fleet shares one identity: the contact's DMs address the shared pubkey, so every instance is entitled to subscribe.

**A5. Delete/tombstone.** `_applyContact` handles `op:"delete"` by `crow_id`, lamport-gated (a stale lower-`lamport_ts` delete is skipped by the conflict check — no destroying a newer local edit). A blocked-then-deleted contact must not be resurrected by a re-delivered stale insert; the LWW gate covers the common case. **Open for plan-time:** confirm whether an explicit `deleted_at` tombstone column is needed to defeat insert-after-delete resurrection, or whether lamport ordering suffices given emit ordering. If a column is added → `SCHEMA_GENERATION 4→5`.

### PR-B — Conversation coherence (S3)

**B1. `messages` emit + `_applyMessage`.** Emit `messages` inserts in both directions (S-COHERENCE-DIR). New `_applyMessage` handler (dispatched before the generic id-path):
- Keyed on `nostr_event_id`; the `UNIQUE` constraint gives free store-dedupe (same event via direct Nostr AND via sync → exactly one row, via `INSERT OR IGNORE`).
- Resolves `contact_id` locally from a **wire-carried `crow_id`**: an `OUTBOUND_TRANSFORMS.messages` joins `contact_id → crow_id` on emit; `_applyMessage` maps `crow_id → local contact_id` on apply. If the local contact doesn't exist yet (message synced before contact), skip — the row will also arrive via direct Nostr once subscribed, or on a later re-sync. (Rows with a null/unresolved `nostr_event_id`, if any, are not emitted.)

**B2. Notification dedupe (S-NOTIFY).** Layer (a): the existing inbound-notify path fires only when a *new* message row was actually created (guard on `INSERT OR IGNORE` rowsAffected) — this suppresses the sync-arrival duplicate. Layer (b): include `nostr_event_id` in the notification payload as a client-side collapse/dedup key so a device receiving pushes from two simultaneously-online instances shows one. No `is_home` dependency.

**B3. Existing hook.** `instance-sync.js:698` already emits `messages:changed` on a synced-in message insert (for live badge updates). `_applyMessage` must preserve that behavior (fire once, on a real insert, with the *locally-resolved* `contact_id`).

### Deferred follow-up — Groups (D1's groups clause)

Own scoped PR after PR-A: add `group_uid TEXT UNIQUE` to `contact_groups` (backfilled); a `contact_groups`/`contact_group_members` apply keyed on `group_uid` + `(group_uid, contact_crow_id)` with wire-mapping back to local ids; **exclude `room_uid IS NOT NULL` groups** (multi-party rooms, own Nostr sync). Bumps `SCHEMA_GENERATION` for `group_uid`.

## Trust boundary (adversarial-review focus)

Phase 3 crosses the **sync** trust boundary — inbound rows from a paired instance become local contacts/messages that then drive subscriptions and notifications. Review must verify:

1. **Signature binding.** `_applyEntry` verifies the ed25519 signature against the shared identity (`this.identity.ed25519Pubkey`, line 624) before any apply. `_applyContact`/`_applyMessage` must operate only on the verified wire row; a row failing verification is dropped (existing behavior — must not be bypassed by the new dispatch).
2. **No trust-surface bypass.** A synced contact must obey L6's rules: only NULL/`accepted` `request_status` rows exist post-apply; a peer cannot inject a `pending` (stranger) row into a trust surface, nor a local-bot row. `shouldSyncRow` enforces this on apply, not just emit.
3. **Key/identity integrity.** `_applyContact` keys on `crow_id`/secp from the signed row; it must not let a synced update rebind an existing contact's keys in a way that hijacks a conversation (reuse `upsertFullContact`'s existing merge/rebind guards, which reset `verified=0` on key-change — and `verified` is local-only here, so a synced key-change resets local trust correctly).
4. **No resurrection.** A stale insert must not revive a deliberately blocked/deleted contact (S-DELETE lamport gating; tombstone question in A5).
5. **Subscribe-hook safety.** `onContactSynced` must not subscribe to a blocked or local-bot contact, and must never throw into the sync apply loop (never-throw, like `createNotification`).

## Testing

- **Unit:** `_applyContact` keys on `crow_id` not `id` (forged-`id` collision test); LWW resolution (newer applies, older skips, tie keeps local); carve-outs (`verified`/`last_seen` stripped; local-bot + `pending` dropped both directions); delete lamport gating + no-resurrection; `onContactSynced` fires for non-blocked/non-bot only and never throws. `_applyMessage` keys on `nostr_event_id`, resolves `contact_id` by `crow_id`, dedupes, defers on missing contact. Forged-signature rejection preserved through the new dispatch.
- **Live E2E (crow↔grackle, shared seed):** add a contact on crow → appears on grackle (and is subscribed/live); block on crow → blocked on grackle; delete on crow → gone on grackle; DM both directions reads coherently on both; a DM received while grackle was offline backfills on reconnect; one notification per inbound DM. black-swan excluded (distinct identity).
- Full suite must stay green (baseline 1083/1083 @ `996a0d42`).

## Deploy

Per-PR, operator-gated merge (merge commit), then deploy **both** crow and grackle (contacts-follow-user needs the whole pair on the new code): `git checkout main && git pull --rebase && sudo systemctl restart crow-gateway`. Verify on each: `/health` 200, `PRAGMA user_version` (=4, or =5 if a schema bump lands), `integrity_check ok`, `[nostr] Subscribed to incoming on 4 relay(s)`, `[sharing] Subscribed to incoming Nostr messages`, sync feeds initialized. Deploys are plain restarts (low-risk); no prod-degrading window, so no deadman required. Fleet (MPA/black-swan) self-updates via pull-only auto-update on next restart.

## Open questions for plan-time (not blocking the spec)

- **A5 tombstone:** does defeating insert-after-delete resurrection need a `deleted_at` column, or does lamport ordering + emit ordering suffice? (Decides whether PR-A bumps the schema.)
- **A3 wire columns:** confirm `feed_key` / `external_handle` / `external_source` are safe/useful to sync or should be excluded.
- **B1 unresolved-contact ordering:** confirm skip-and-let-Nostr-fill is acceptable vs. a small deferred-apply buffer.
- **PR packaging:** PR-A and PR-B as two PRs within Phase 3 (recommended, mirrors Phase 2); groups as a third, later PR.
