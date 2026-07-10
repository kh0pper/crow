# F-CONTACT-1 + F-CONTACT-2 — implementation plan

**Design (normative):** `docs/superpowers/specs/2026-07-09-contact-deletion-and-handshake-name-design.md`
**Branch:** `feat/f-contact-1-2-deletion-and-handshake-name` off `781664df`
**Suite baseline:** 1258 pass / 0 fail / 1 skip — `node --test tests/*.test.js`

Every task is TDD: write the failing test first, watch it go red, implement, watch it go green.
Every regression guard listed as **MUTATE** must be mutation-tested: break the implementation,
confirm the specific test fails, restore. A guard that passes vacuously is worse than none.

Tasks are ordered so the tree is green after each one. Task N+1 may assume N landed.

---

## Task 1 — schema: `contact_tombstones` + `processed_control_events`

**Files:** `scripts/init-db.js`, `servers/shared/schema-version.js`, `tests/contact-tombstones.test.js` (new)

- `SCHEMA_GENERATION` 5 → 6.
- Create both tables (design §4.6). `CREATE TABLE IF NOT EXISTS`, alongside the other contact
  tables. No FK from `contact_tombstones.crow_id` to `contacts.crow_id` — the whole point is
  that the contact row is gone.
- Idempotent: running `init-db` twice is a no-op.

**Tests:** both tables exist after init-db; `PRAGMA user_version` = 6; re-running init-db does
not throw and does not drop rows.

**Do not** add either table to `coreTableCount`'s IN-list (it is a fresh-install sentinel;
verified in R1).

---

## Task 2 — tombstone primitives + `emitChange` return contract

**Files:** `servers/sharing/contact-delete.js` (new), `servers/sharing/contact-sync.js`,
`servers/sharing/instance-sync.js`, `tests/contact-tombstones.test.js`

- New `contact-delete.js` exporting `writeTombstone(db, crowId, lamportTs)`,
  `readTombstone(db, crowId)`, `clearTombstone(db, crowId)`. All three **no-op on `req:`-prefixed
  crowIds** (design §D3). All guarded — never throw into a receive path.
- `instance-sync.js` `emitChange`: `return lamportTs` on success; change the three early returns
  (`feedsDisabled`, non-synced table, `!shouldSyncRow`) to `return null`.
- `contact-sync.js`: `emitContactDelete(db, crowId, fallbackLamportTs)` — awaits `emitChange`,
  and **writes the local tombstone itself** at the returned lamport, or at `fallbackLamportTs`
  when the emit was suppressed (nullish). This is the single home for the tombstone write
  (design §4.1, R2b-NEW-2). Also make `emitContactChange` return the lamport for symmetry.

**Tests:** `writeTombstone`/`readTombstone`/`clearTombstone` round-trip; `req:` ids are ignored;
`emitContactDelete` with a null sink still writes a tombstone at the fallback lamport;
`emitChange` returns its lamport and `null` on each early-return path.

**MUTATE:** remove the `req:` skip → the `req:`-ignored test fails.

---

## Task 3 — `unwireContact` + `NostrManager.unsubscribeFromContact`

**Files:** `servers/sharing/nostr.js`, `servers/sharing/contact-delete.js`,
`tests/contact-delete.test.js` (new)

- `unsubscribeFromContact(crowId)`: iterate `this.relays` to build the **exact**
  `` `${crowId}:${url}` `` keys; `close()` each handle and **delete the map entry**. Never a
  `startsWith` prefix scan — `crowId` itself contains a colon (design §4.4, R1-m3). Guarded.
- `unwireContact(managers, row)` in `contact-delete.js`: `nostrManager.unsubscribeFromContact`,
  `syncManager.closeContactFeeds(row.id)`, `peerManager.leaveContact(row.crow_id)`. Each step
  independently `try/catch`ed — the `wireFullContact` convention (`contact-promote.js:76`).

**Tests (guard #9):** with subs registered for `crow:aaa` and `crow:bbb` across two relay URLs,
`unsubscribeFromContact('crow:aaa')` closes and **removes** exactly the two `crow:aaa` entries
and leaves both `crow:bbb` entries present and open. A partial `managers` object (missing
`peerManager`) does not throw.

**MUTATE:** switch to a `startsWith(crowId + ':')` scan and add a contact whose crowId is a
prefix of another → the isolation assertion fails. (If no natural prefix pair exists, assert the
map-entry removal instead of relying on the prefix hazard.)

---

## Task 4 — `deleteContactCascadePreview`

**Files:** `servers/sharing/contact-delete.js`, `tests/contact-delete.test.js`

- Read-only counts: `messages`, `sharedItems`, `groups` (`contact_group_members`),
  `projectsOwned` (`project_spaces.owner_contact_id`), `projectMemberships`
  (`project_space_members`). Returns zeros for a contact with nothing.

**Tests (guard #8):** seed a contact with 3 messages, 1 share, 2 group memberships, 1 owned
project → preview returns exactly those counts; an untouched second contact reports zeros.

---

## Task 5 — `deleteContactLocal` + the FK-cascade characterization test

**Files:** `servers/sharing/contact-delete.js`, `tests/contact-delete.test.js`

- `deleteContactLocal(db, managers, row)` → `unwireContact(managers, row)` **first** (load-bearing
  ordering, design §4.1), then `DELETE FROM contacts WHERE id = ?`, then
  `emitContactDelete(db, row.crow_id, row.lamport_ts)` (which writes the tombstone).
- Refuses `origin === 'local-bot'` (returns a `{ok:false, reason}`; the panel surfaces it).

**Tests:** deleting a contact with messages removes the messages (characterizes the cascade —
this test is the executable record of design §2.1, and it will fail loudly if a future change
disables FK enforcement); a tombstone exists afterwards at the emitted lamport; `unwireContact`
ran before the row vanished (spy ordering); a `local-bot` row is refused and still present.

---

## Task 6 — `_applyContact` tombstone gate (the heart)

**Files:** `servers/sharing/instance-sync.js`, `tests/contacts-sync.test.js`

Implement design §D3.1 exactly, before the existing branches:

```
tomb = readTombstone(crow_id)
if (tomb && localRow) { clearTombstone(crow_id); tomb = null }        // (a)

if (op === "delete") {                                                 // (b)
  if (!localRow)              { writeTombstone(max(tomb,inc)); return }
  if (inc > localTs)         { unwire; DELETE; writeTombstone(max(tomb,inc)); return }
  conflict-log("delete"); keep row; return          // UNCHANGED from :1295-1302
}

if (tomb) {                                                            // (c)
  if (op === "update")            return                     // drop
  if (inc <= tomb.lamport_ts)     return                     // stale insert
  // insert, inc > tomb: apply FIRST, then clear
}
```

The insert branch applies, then `clearTombstone` — **in that order** (design §D3.1(c);
apply-then-clear closes the concurrent-feed interleaving).

Add the `onContactDeleted(row)` boot-injected hook, fired from (b)'s winning delete so the
applied remote delete unwires locally. Mirrors `onContactSynced`.

**Tests — the four core guards:**

- **guard #1 resurrection-by-update.** tombstone{X:100}, no row; apply `update(X)@150` → no row.
  **MUTATE:** delete the `op==="update"` drop → red.
- **guard #2 delete-before-insert.** No row, no tombstone; apply `delete(X)@100` → tombstone
  written; then apply `insert(X)@50` → still no row.
  **MUTATE:** skip the `!localRow` tombstone write → red.
- **guard #3 legitimate re-add.** tombstone{X:100}; apply `insert(X)@150` → row present,
  tombstone gone. **MUTATE:** make the tombstone absorbing for `insert` → red.
- **guard #5 stale delete must not wipe a live contact.** Live row at lamport 200 with 3
  messages; apply `delete(X)@100` → row survives, **all 3 messages survive**, a `sync_conflicts`
  row is written, and **no tombstone** exists. **MUTATE:** make the row delete unconditional →
  red (and the message-count assertion is what makes the data-loss explicit).
- **guard #6 stale local tombstone does not freeze a live row.** tombstone{X:100} coexisting with
  a live row X (write both directly, the state `deleteContactLocal`-then-re-insert produces);
  apply `update(X)@150` → the update lands and the tombstone is gone.
  **MUTATE:** remove rule (a) → red.

---

## Task 7 — emitter rule: a tombstoned re-add emits `insert`

**Files:** `servers/sharing/contact-promote.js`, `servers/sharing/tools/contacts.js`,
`tests/contact-promote.test.js`

- `upsertFullContact` reads the tombstone **once, up front**. If present: `clearTombstone` and
  emit `op="insert"` for **every** outcome (MERGE / PROMOTE / CREATE) instead of the current
  `update`/`insert` mix (design §D3.2). Without a tombstone, behavior is byte-identical to today.
- `crow_accept_bot_invite` (`tools/contacts.js:367`) gains `clearTombstone(db, botCrowId)` next to
  its existing `insert` emit.

**Tests — guard #4, the R1-C1 interleaving (the CRITICAL):**

1. Tombstone `crow:Y` at lamport 100 on the emitting instance; no `crow:Y` row.
2. Insert a `req:<secp>` pending row for the same secp key.
3. Call `upsertFullContact({crowId:'crow:Y', secp, ...})` → takes the **PROMOTE** branch.
4. Assert the captured emit is `op === "insert"` (not `"update"`), and the local tombstone is
   cleared.
5. Feed that emitted entry into a second instance holding tombstone{Y:100} → the contact applies.

**MUTATE:** make the promote branch emit `"update"` → step 4 and step 5 both fail. Confirm guard
#3 alone still passes with that mutation in place — proving #4 is the guard that catches it.

Also assert: with **no** tombstone, MERGE still emits `update` and CREATE still emits `insert`
(no behavior change on the common path).

---

## Task 8 — `sanitizeDisplayName`

**Files:** `servers/sharing/display-name.js` (new, zero-import, pure),
`tests/display-name-sanitize.test.js` (new)

Implement design §D5's seven rules. Pure function, `string|null` in, `string|null` out.

**Tests (guard #10):** `<img src=x onerror=alert(1)>` survives as inert text (it is escaped at the
sinks, sanitizer only bounds it); a 10 KB string caps to 64 chars; `\n`/`\r`/`NUL` are stripped;
`U+202E` and `U+2066` are stripped; `crow:deadbeef` and `req:abc` → `null`; `"  a  b  "` →
`"a b"`; `""`/whitespace-only/non-string → `null`; a legitimate name (`"Dayane"`, `"José M."`,
emoji) round-trips unchanged.

---

## Task 9 — sanitize at all three ingress points

**Files:** `servers/sharing/instance-sync.js`, `servers/sharing/boot.js`,
`servers/gateway/dashboard/panels/contacts/api-handlers.js`, `tests/display-name-sanitize.test.js`

- `_applyContact`: sanitize `filtered.display_name` **immediately after `filtered` is built**,
  before the same-secp REBIND, before `rowsEquivalent`, before both write branches (design §D5,
  R2-MINOR-3). Getting this position wrong spams the conflict log on every redelivery.
- `handleInviteAccepted` / `handleHandshakeComplete`: sanitize `payload.displayName`.
- `save_profile`: cap `profile_display_name` at write.

**Tests:** a peer entry carrying a 10 KB control-laden `display_name` stores the sanitized value;
redelivering the **same** entry is `rowsEquivalent` and writes **no** `sync_conflicts` row (this
is the test that fails if sanitization is hooked after the equivalence check).

---

## Task 10 — handshake name on the wire

**Files:** `servers/sharing/tools/contacts.js`, `servers/sharing/retry-queue.js`,
`servers/sharing/boot.js`, `tests/handshake-display-name.test.js` (new),
`tests/invite-accepted-promote.test.js`, `tests/handshake-complete.test.js`

- `acceptInviteCore`: read `dashboard_settings.profile_display_name`; when set, add
  `displayName: sanitizeDisplayName(name)` to the `invite_accepted` payload. When unset or the
  sanitizer returns `null`, **omit the field entirely** (design §D5 — no placeholder).
- `buildHandshakeComplete(eventIds, displayName?)` → include `displayName` only when non-null;
  `ackHandshake` supplies it; `handleHandshakeComplete` applies it via the placeholder rule.
- `handleInviteAccepted` passes the sanitized name to `upsertFullContact` (it already reads
  `payload.displayName`).

**Tests:** (guard #11) an `invite_accepted` with **no** `displayName` produces a contact named
`crowId` — byte-identical to today; with a `displayName` the contact takes it; a contact whose
`display_name` is user-typed is **not** overwritten (placeholder rule); a hostile name arrives
sanitized. `buildHandshakeComplete` with no name emits an object with no `displayName` key
(old-peer wire compatibility).

---

## Task 11 — replay hygiene (D4)

**Files:** `servers/sharing/boot.js`, `servers/sharing/contact-delete.js` (or a small
`processed-events.js`), `tests/invite-accepted-promote.test.js`

- `recordProcessedEvent(db, eventId, kind)` / `wasProcessed(db, eventId)`. Opportunistic prune of
  rows older than 30 days on insert (≫ the 60h `CROW_NOSTR_RETRY_MAX_AGE_SEC`).
- `handleInviteAccepted`: after the R4 auth check, if `wasProcessed(event.id)` → **skip the
  upsert, still `ackHandshake`**, return. Otherwise handle normally and record the id after a
  successful `upsertFullContact`.
- This mirrors the existing `"replayed"` short-code verdict (`boot.js:170-175`), which already
  acks without a contact row.

**Tests (guard #7):**
- Two `invite_accepted` events, same `crowId`/payload, different `event.id`. First → contact
  created, id recorded. Delete the contact (tombstone). Replay event #1 → **no contact**, but the
  `sendControl` spy **still fired** (the ack). Fresh event #2 → contact created, tombstone
  cleared.
- **The anti-regression assertion:** event #2 carries `created_at` *older* than the tombstone's
  `deleted_at` and is still accepted. This pins D4 against anyone reintroducing a clock
  comparison (R2-MAJOR-3).

**MUTATE:** remove the `wasProcessed` check → the stale-replay assertion goes red.

---

## Task 12 — the panel: interstitial + real delete

**Files:** `servers/gateway/dashboard/panels/contacts/api-handlers.js`,
`servers/gateway/dashboard/panels/contacts/html.js`, i18n EN + ES,
`tests/contact-delete.test.js`

- Delete control → GET `?view=contact&contact=<id>&confirm=delete`. The GET renders cascade
  counts, the "this applies to all your linked Crows" note, and Block / Cancel / Delete.
  **Invariant: the GET must be side-effect-free** (CSRF guards only state-changing methods).
- POST `action=delete_contact&confirm=1` → `deleteContactLocal` → `{redirect}`.
  POST **without** `confirm=1` → redirect to the interstitial, never delete.
- Drop `AND contact_type = 'manual'`. Refuse `origin='local-bot'`.
- Correct the stale comment at `rooms-store.js:81` (design §2.1) and replace the
  `api-handlers.js:255-257` "deliberate no-op" comment with the Phase-3 rationale.

**Tests:** POST without `confirm=1` deletes nothing and redirects to the interstitial; POST with
`confirm=1` deletes; a `crow:` contact is now deletable (the F-CONTACT-1 regression — this test
fails on `main`); a `local-bot` contact is refused.

---

## Task 13 — docs + wrap

- `docs/architecture/sharing-server.md`: tombstones, delete semantics, the replay ledger.
- Full suite green (expect ~1258 + new).
- Re-run every **MUTATE** step once more on the final tree.

---

## Deploy gate (design §6, R2-MINOR-2)

A gen-5 peer honors no tombstone. **All three instances must reach `user_version = 6` before any
contact deletion is performed.** Deploy crow → MPA → grackle, verify `PRAGMA user_version` = 6 on
each, and only then exercise the feature. **black-swan is not touched** (pristine at `/setup`).

## Out of scope (do not drift)

`pruneStaleAdvertisedContacts` resurrection (§2.6), `contact_groups` tombstones, transitive
delete relay, a `crow_delete_contact` MCP tool, invite revocation on delete, project-owner
reassignment UI.
