# F-CONTACT-1 + F-CONTACT-2 — contact deletion & name-in-handshake (design)

**Date:** 2026-07-09
**Findings:** `.superpowers/messages-plan/p4-findings.md` (F-CONTACT-1, F-CONTACT-2)
**Arc:** Crow Messages usability overhaul, P4/S10 follow-up round
**Base:** `781664df` (PR #154, F-HEALTH-1)
**Schema:** `SCHEMA_GENERATION` 5 → 6 (`contact_tombstones`, `processed_control_events`)
**Review:** R1 (REVISE — 1 CRITICAL, 3 MAJOR, 5 MINOR) and R2 (REVISE — 3 MAJOR, 7 MINOR),
both folded. Dispositions in §8.

---

## 1. The two findings

**F-CONTACT-1 [S2-MAJOR].** There is no product path to delete a `crow:` contact. The
Contacts panel's `delete_contact` action is `contact_type='manual'`-only
(`servers/gateway/dashboard/panels/contacts/api-handlers.js:259`), so clicking Delete on a
`crow:` contact is a **silent no-op** — no error, no row removed, no feedback.
`crow_revoke_access` operates on *shares*, not contact rows. A user who pairs with a box that
dies can never remove it. Live evidence on crow: contact `id=1`, `crow:1m5ughwje2` —
black-swan's defunct pre-wipe identity — has been un-removable since 2026-07-06.

**F-CONTACT-2 [S4-MINOR].** When B accepts A's invite, B names A (the `display_name`
argument to `crow_accept_invite`), but A's auto-add creates a contact whose display name is
the raw crowId. Root cause: the `invite_accepted` payload
(`servers/sharing/tools/contacts.js:63-69`) carries `type`, `crowId`, `ed25519Pub`,
`secp256k1Pub`, and optionally `inviteId` — **no name**. `handleInviteAccepted`
(`servers/sharing/boot.js:190`) *already reads* `payload.displayName` and threads it to
`upsertFullContact`; the sender simply never populates it. `upsertFullContact`'s CREATE branch
then falls back to `name || crowId` (`contact-promote.js:207-209`).

Live evidence on crow: `crow:3n6dimacvr` and `crow:1m5ughwje2` both carry their own crowId as
`display_name`.

---

## 2. Recon findings that shape the design

Established against live code and live probes. Two of them overturn assumptions written into
earlier plan documents.

### 2.1 Foreign keys ARE enforced. `ON DELETE CASCADE` fires.

`servers/gateway/dashboard/panels/messages/rooms-store.js:81` asserts:

> "FK ON DELETE CASCADE does not fire at runtime (foreign_keys pragma is off on the
> request-path client)"

**Stale and wrong.** It predates the migration off `@libsql/client` (which defaults
`foreign_keys` OFF) onto `better-sqlite3` (which enables them by default). Probed through the
real `createDbClient` factory (`servers/db.js`):

```
foreign_keys pragma via prod client: [{"foreign_keys":1}]
child rows surviving parent delete: 0   (0 = cascade fired)
```

R2 independently re-probed `better-sqlite3@12.9.0` and confirmed the pragma is per-connection
and set ON by the `Database` constructor on **every** handle — request client, the WAL keeper
(`db.js:266`), and `init-db`'s own. No connection has it off.

The `2026-07-06-messages-p4-e2e-campaign.md` plan (line ~388) states "its FK CASCADE
self-cleans on any contact delete anyway" as *reassurance*. It is true, and it is the central
hazard, not a reassurance.

**Deleting a contact row cascades:**

| Table | Column | Action |
|---|---|---|
| `messages` | `contact_id` (NOT NULL) | **CASCADE — destroys the entire DM history** |
| `message_retry_queue` | `contact_id` | CASCADE |
| `shared_items` | `contact_id` | CASCADE |
| `contact_group_members` | `contact_id` | CASCADE |
| `project_space_members` | `contact_id` | CASCADE |
| `project_spaces` | `owner_contact_id` | SET NULL |
| `project_space_members` | `granted_by_contact_id` | SET NULL |
| `room_messages` | `sender_contact_id` | SET NULL |
| `blog_shares` | `contact_id` | SET NULL |

Because `messages.contact_id` is `NOT NULL`, **a hard contact delete cannot preserve DM
history.** Architectural constraint, not a choice. On live crow, deleting the stale `id=1` row
would silently destroy **19 messages**.

The stale `rooms-store.js` comment is corrected as part of this work (its explicit deletes
remain correct and are left alone).

### 2.2 There is no tombstone. Deletes resurrect.

`_applyContact` (`instance-sync.js:1289-1304`) handles `op="delete"` as pure lamport LWW, and
when `!localRow` it simply `return`s, recording nothing. The insert/update branch (`:1341`)
upserts: an `update` for an unknown `crow_id` **INSERTs the row**.

With contacts syncing fleet-wide (Phase 3 / PR #148):

1. crow deletes contact X, emits `{op:"delete", row:{crow_id}}` at lamport `D`.
2. grackle applies it. Contact gone on both.
3. MPA was offline. Its user renames X locally, emitting `op="update"` at lamport `> D`.
4. crow and grackle apply MPA's update, hit `!localRow`, and **INSERT X back**.

The contact resurrects fleet-wide. Kevin's brief names this exactly: *"a delete that
resurrects is worse than no delete."* Any deletion feature must ship a tombstone.

`contact_groups` (`emitGroupDelete`) has the identical gap. Out of scope; follow-up.

### 2.3 `lamport_ts` is a true Lamport clock, and it advances on every applied entry.

`_nextLamport()` increments `sync_state.local_counter`; `_advanceCounter()` —
`local_counter = MAX(local_counter, incoming + 1)` — is invoked at `instance-sync.js:940`,
**before** the per-table dispatch (`:978`) and therefore regardless of any early return inside
`_applyContact`. So an instance that has applied a delete at lamport `D` has a counter ≥ `D+1`,
and any subsequent emit from it necessarily carries lamport `> D`. (Verified in R1.)

### 2.4 Propagation is direct-paired. There is no relay.

`emitChange` appends **only local-origin** entries to `this.outFeeds` (`instance-sync.js:850`);
`_applyEntry` never re-emits. Instance X observes D's delete **iff X reads D's feed**. The mesh
is whatever `crow_instances` pairing makes it; a star or chain is expressible. This is a
precondition of the convergence argument in §D3, stated rather than assumed away. (R1-M1.)

### 2.5 There is no per-contact Nostr unsubscribe.

`NostrManager.subscriptions` is a `Map` keyed `` `${crowId}:${relayUrl}` `` (`nostr.js:547`).
Handles are closed only by being overwritten with the same key (`:546`), or by a whole-manager
`destroy()` (`:753`). **No `unsubscribeFromContact` exists.** Deleting a contact today would
leave a live relay subscription against a key that maps to no row.

The blocked-contact path (`wireSyncedContact`, `contact-promote.js:96`) closes sync feeds and
leaves the DHT topic — but does **not** close the Nostr sub either. Deletion needs a real
teardown, and the synced-delete path needs to run it too (today `_applyContact`'s delete branch
returns before `_afterContactApplied`, so no hook fires at all).

### 2.6 A pre-existing, unrelated resurrection: `pruneStaleAdvertisedContacts`

`pruneStaleAdvertisedContacts` (`messages/data-queries.js:281`) hard-deletes
`origin='advertised'` rows with no emit and no tombstone. Those rows sync (full contacts,
`request_status` NULL), and `contacts/api-handlers.js:399` emits `update` for them. So a peer's
roster refresh already resurrects a locally-pruned advertised contact **today**, on a
background timer, with no user action.

**This is not caused or worsened by this work, and it is not fixed here.** An earlier draft
tried to fix it by excluding `origin='advertised'` from `shouldSyncRow`. R2 proved that fix
inert: `crow_accept_bot_invite` inserts the row and emits `insert` with `origin=NULL`
(`tools/contacts.js:367,385`); the caller sets `origin='advertised'` only afterwards
(`contacts/api-handlers.js:395`). The carve-out would gate the flag-update while the base
contact still syncs — leaving peers a permanent, un-prunable phantom that also lacks `is_bot`
and so reads as a human contact. Worse, the justification ("re-derived per-instance") is false
for invite-code bots: a peer never held the invite code and cannot re-derive them, so
suppressing the sync would *lose* the bot contact on every other instance, regressing Phase 3.

Fixing it correctly means moving where `origin` is set and reasoning about a
materialize/prune flap between instances. Scoped out as its own PR (§7). The tombstone
machinery here touches none of it: prune writes no tombstone and emits nothing, so its behavior
is byte-for-byte what it is today.

---

## 3. Decisions

### D1 — Delete is a hard delete, and it destroys the conversation. Say so, loudly.

Given §2.1, "delete the contact but keep the messages" is unavailable. The choice is between a
hard delete and a soft delete (`deleted_at` column, row retained).

**Chosen: hard delete**, behind a confirmation that enumerates the exact blast radius.

*Why not soft delete.* A retained row keeps satisfying every "is this a known contact?"
predicate. Those predicates are **trust decisions**, not display filters: `room-inbound.js:27`
(who may speak into a room), `rooms.js:44/142/181` (room join / invite / member),
`messages/data-queries.js:51`, `projects.js:334` (member picker), `tools/contacts.js:429`
(`crow_list_contacts`), and the peer/signer-auth paths. Soft delete requires
`AND deleted_at IS NULL` on all of them; one miss is a **security** leak (a "deleted" peer
still admitted to a room), not a cosmetic one. The L6 work already had to enumerate and gate
nine such surfaces via `request_status IS NULL`. Hard delete is safe *by construction*: the row
is gone, so every predicate fails naturally.

*The cost is real and disclosed.* The confirmation names counts and states that the deletion
propagates to the user's other Crows.

### D2 — Delete ≠ block, and the confirmation says which one you probably want.

`is_blocked` already exists, already syncs (Phase 3 PR-A), already hides the contact from
messages, rooms, room-inbound and the project picker, and is **reversible and
non-destructive**. It is the right tool for "stop hearing from this person."

Delete means "remove this entry from my address book." The confirmation offers Block as the
non-destructive alternative in-line, so a non-technical user does not reach for the destructive
verb when they want the reversible one.

### D3 — Tombstones make deletion durable.

```sql
CREATE TABLE IF NOT EXISTS contact_tombstones (
  crow_id     TEXT PRIMARY KEY,
  lamport_ts  INTEGER NOT NULL,
  deleted_at  INTEGER NOT NULL          -- unix seconds; informational only
);
```

Tombstones are **local state, never synced**, and **never pruned**. One small row per contact a
user has ever deleted. A retention window would reintroduce resurrection for any instance
offline longer than the window — Hypercore feeds are append-only and replay in full from
`last_applied_seq`, so a long-offline peer *will* eventually deliver its stale update. Bounded
size, unbounded correctness.

Tombstones are never written for `req:`-prefixed crow_ids: those rows are per-instance
message-request state and never sync (`shouldSyncRow` drops `request_status != null`).

`deleted_at` is stored for diagnostics only. **No decision anywhere compares wall clocks
across instances** (see D4).

#### D3.1 — Applier rule (`_applyContact`, before the existing branches)

```
tomb = readTombstone(crow_id)

// (a) A local row means some local path re-created the contact. The tombstone is
//     stale; the local re-create wins. Clear it and fall through to normal LWW.
if (tomb && localRow) { clearTombstone(crow_id); tomb = null }

// (b) delete. The tombstone is written whenever the delete is AUTHORITATIVE;
//     the ROW delete keeps today's LWW guard.
if (op == "delete") {
    if (!localRow) {
        writeTombstone(crow_id, max(tomb?.lamport ?? 0, incoming))   // delete-before-insert
        return
    }
    if (incoming > localTs) {
        unwireContact(row); DELETE the row
        writeTombstone(crow_id, max(tomb?.lamport ?? 0, incoming))
        return
    }
    conflict-log (op="delete"); KEEP the row        // exactly as instance-sync.js:1295-1302
    return
}

// (c) tombstone still standing (no local row):
if (tomb) {
    if (op == "update")                       -> drop
    if (op == "insert" && ts <= tomb.lamport) -> drop            // stale replay
    if (op == "insert" && ts >  tomb.lamport) -> apply, THEN clearTombstone
}
```

**(b) preserves today's LWW on the row.** An earlier draft's pseudocode deleted whenever
`localRow` existed, which would let a *stale* delete wipe a live contact — and, via §2.1's
cascade, its entire DM history. (R2-MAJOR-1.)

Precisely: the tombstone is written when the delete is **authoritative** — either there is no
local row (the delete-before-insert race), or it wins LWW. It is **not** written when a stale
delete loses to a fresher live row: the row won, so no tombstone is warranted, and writing one
would leave a pointless tombstone-beside-live-row that D3.1(a) merely has to clear again. The
destructive row removal keeps `incoming > localTs` exactly as `instance-sync.js:1290` does
today. (R2b-NEW-1: an earlier phrasing said "unconditional" and misled two readers, including a
reviewer.)

**(a)** is what makes the design robust against the many local write paths that create contacts
(`ensure-local-bot-contact.js:44`, advertised materialize, vCard import, `upsertFullContact`).
Rather than requiring each to remember to `clearTombstone` — a rule the next contributor will
forget — the applier treats "a row exists" as proof the tombstone is obsolete. (R1-M4.)

> **Caveat (R2).** (a)'s safety rests on the fact that no *automatic* path re-materializes a
> normal synced contact today: the only automatic re-create is `ensureLocalBotContact`, whose
> rows are `origin='local-bot'` and never sync, so no peer ever emits an update that could
> trigger a spurious clear. **Any future auto-materialize of a normal contact would let (a)
> silently undo remote deletes.** This constraint must be restated if such a path is added.

**(c) applies before it clears.** Ordering matters: `_processNewEntries` locks per *remote
instance* (`instance-sync.js:868`), so two peers' feeds interleave across `await`s. If we
cleared first, a concurrent stale `update` from another feed could observe `tomb=null` and
`localRow=null` and INSERT stale state, while our own INSERT then loses on `UNIQUE`. Applying
first means a concurrent reader sees either the tombstone (drop) or the row (rule (a), then
normal LWW) — never neither. (R2-MINOR-1.)

"Delete wins over a concurrent update" is a deliberate departure from plain LWW. Plain LWW lets
a concurrent rename resurrect a deleted contact — the failure mode the feature exists to
prevent. The rule is a function of `(op, tomb.lamport, localRow?)` only, so every instance
evaluates it identically.

#### D3.2 — Emitter rule: a re-add must emit `insert`

**This is the correction R1-C1 forced, and it is the crux of the design.**

The applier can only distinguish "a genuine re-add" from "a stale rename by an instance that
has not yet applied the delete" by the op. But `upsertFullContact` emits `update` for two of its
three outcomes — MERGE (`contact-promote.js:158`) and PROMOTE (`:201`) — and only CREATE
(`:213`) emits `insert`. The realistic re-pair path takes PROMOTE: the deleted peer DMs the
user, the L6 path creates a `req:<secp>` row, the user re-invites, and `upsertFullContact` finds
`byCrow = null` plus a same-secp `req:` row and **rebinds it**, emitting `update`. Under a naive
rule every peer drops that update and stays deleted forever while the local instance has the
contact back: permanent divergence, from the blessed flow.

**Rule:** any local write path that (re)creates or rebinds a contact whose `crow_id` carries a
local tombstone MUST `clearTombstone(crow_id)` and emit `op="insert"` — *regardless of the
merge/promote/create outcome*. By §2.3 the emitting instance had applied the delete (that is why
it holds a tombstone), so its counter exceeds the tombstone's lamport and its `insert` clears
peers' tombstones under D3.1(c).

An `insert` arriving where the row already exists falls through to the update branch —
`_applyContact` branches on `localRow` presence, not on op (`:1307`, `:1360`; op is read only by
the delete branch and the conflict-row label). So re-using `insert` is wire-safe and needs no
format change or version negotiation. (Confirmed in R2.)

Coverage (R2-MINOR-6 corrected the earlier wording):

- `upsertFullContact` (`contact-promote.js`) reads the tombstone once, up front, and covers
  MERGE / PROMOTE / CREATE. `crow_add_contact` and both accept-invite tools route through it.
- `crow_accept_bot_invite` (`tools/contacts.js:367`) has its own INSERT and already emits
  `insert` (`:385`); it gains a `clearTombstone` call.
- `accept_request` (`messages/api-handlers.js:287`) touches only `req:` ids — tombstone-exempt.
- vCard/CSV import (`api-handlers.js:358`) mints fresh `manual:<uuid>` ids that cannot collide
  with a `crow:` tombstone. No change.

#### D3.3 — Every delete-emitting site writes a local tombstone

The originating instance never applies its own feed entry, so it must write its tombstone
explicitly. `emitContactDelete(db, crowId)` is changed to co-write the local tombstone so the
two cannot drift. R2 confirmed the caller set is exactly two.

| Site | Emits delete | Local tombstone |
|---|---|---|
| `deleteContactLocal` (panel) — `contacts/api-handlers.js:262` | yes | yes, inside `emitContactDelete` |
| `upsertFullContact` MERGE fold — `contact-promote.js:157` | yes | yes, inside `emitContactDelete` (skipped for `req:` ids) |
| `_applyContact` remote delete | n/a (inbound) | yes, per D3.1(b) |
| `decline_request` (`messages/api-handlers.js:311`) | no (a `req:` row) | no |
| `pruneStaleAdvertisedContacts` | no | no — unchanged, see §2.6 |

### D4 — Replay hygiene, not clocks: a deleted contact cannot resurrect itself.

`handleInviteAccepted` (`boot.js:152`) creates a contact from a remote, authenticated
`invite_accepted`. Per R5 the retry loop re-publishes **the exact stored signed event** for up
to ~60h (`retry-queue.js:12-13`; `event` is threaded via `nostr.js:644 → boot.js:152`). So: A
deletes B, B's un-acked retry fires, A silently re-adds B. A remote party reversing a local
user's deletion.

An earlier draft refused when `event.created_at <= tombstone.deleted_at`. **R2-MAJOR-3 killed
that.** `deleted_at` is the deleter's clock; `created_at` is the accepting peer's. There is no
NTP guarantee between two Crows. In the blessed re-pair flow — delete a dead box, immediately
re-invite its replacement — a peer whose clock trails by more than the delete→accept gap has its
honest, fresh acceptance refused; `ackHandshake` never runs, so its retry loop re-fires the same
refused event for 60h. The user sees "I re-invited them and they never appeared," with no error
anywhere. That is precisely the silent-failure class this arc exists to eliminate.

**Rule (clock-free).** A stale retry is not "old" — it is *the same event*. Record the
`event.id` of every successfully-handled `invite_accepted`:

```sql
CREATE TABLE IF NOT EXISTS processed_control_events (
  event_id  TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,       -- 'invite_accepted'
  seen_at   INTEGER NOT NULL     -- unix seconds
);
```

`handleInviteAccepted`: if `event.id` is already recorded, **skip the contact upsert but still
send the `handshake_complete` ack**, then return. Otherwise handle normally and record the id.

- Stale 60h retry after a deletion → same `event.id` → recorded → no contact created. The ack
  still fires, which stops the acceptor's retry loop instead of letting it hammer for 60h.
- A genuinely new acceptance (the user re-invited them; they accepted afresh) → new `event.id` →
  handled → `upsertFullContact` clears the tombstone and emits `insert` (D3.2).
- Ack-lost self-heal (PR3's I4 hard requirement: re-ack on the `"replayed"` verdict) is
  preserved — a replay still acks. The skipped upsert was a no-op in that case anyway, since the
  contact already exists.

This needs no tombstone lookup, no wall clock, and no comparison across machines. It also closes
a **pre-existing gap**: plain invite codes carry no `inviteId` (`identity.js:303` sets it only
for short codes), so today an `invite_accepted` for a plain invite has *no* replay protection at
all. Rows older than 30 days are pruned opportunistically on insert (the retry window is ~60h).

*Residual, documented:* a peer that still holds a live invite code (24h TTL, enforced at
`identity.js:330`) can re-accept it after being deleted and will be re-added. An invite code is a
bearer credential; anyone holding one can already create a contact. Revoking outstanding invites
on delete is a coherent follow-up, deliberately unscoped. Also, acceptances handled *before* this
ships were never recorded, so one post-deploy retry could resurrect once; negligible and noted.

Deletion does **not** block. If a deleted peer DMs afterwards, the L6 path creates a fresh
`req:<secp>` partial contact in the Requests inbox. Tombstones key on `crow_id` and `req:` rows
carry a different `crow_id`, so they are unaffected — by design. Removing someone from the
address book should not silently mute them forever; blocking does that, one click away.

### D5 — The handshake name is optional, additive, and treated as hostile.

Both directions gain an optional `displayName`:

- Acceptor → inviter on `invite_accepted` (F-CONTACT-2's reported case).
- Inviter → acceptor on `handshake_complete` (the symmetric case: the acceptor may omit
  `display_name`, leaving the inviter shown as a raw crowId).

Source is `dashboard_settings.profile_display_name` (`contacts/api-handlers.js:329`).

**It is unset on live crow.** When unset the field is **omitted entirely** and behavior is
byte-identical to today (`upsertFullContact` falls back to `crowId`). No invented placeholder.

Wire compatibility: an old peer ignores an unknown field; a new peer treats a missing field as
today. `handleInviteAccepted` already reads `payload.displayName`. No version negotiation.

The name is applied only where `isPlaceholderName()` holds (`contact-promote.js:111`) — a remote
name never overwrites a name the user typed.

**The value is remote-controlled and renders in the dashboard.** `sanitizeDisplayName()`:

1. Reject non-strings.
2. Strip C0/C1 controls and `NUL` — this necessarily removes `\n`/`\r`, closing log injection.
3. Strip Unicode bidi overrides and isolates (`U+202A`–`U+202E`, `U+2066`–`U+2069`); an RTL
   override rewrites how the surrounding row reads.
4. Collapse remaining whitespace, trim.
5. Reject `^(crow|req):` — otherwise a peer names itself `crow:deadbeef` and impersonates an
   identity string. (Also matters because `isPlaceholderName` keys on those prefixes.)
6. Cap at 64 characters. `display_name` is unbounded `TEXT` and the value **syncs to every one of
   the user's instances**, so an uncapped name is fleet-wide storage amplification.
7. Empty after all of the above → `null` → caller omits the field.

**Three ingress points, not two** (R1-m4). `display_name` enters the DB from the two handshake
handlers *and* from `_applyContact` insert/update. The sync signature check proves *same key*,
not *honest content* — an older or buggy peer on the shared identity can carry an uncapped,
control-laden name straight in.

The sync-apply hook point is exact (R2-MINOR-3): sanitize `filtered.display_name` immediately
after `filtered` is built (`instance-sync.js:~1280`), **before** the same-secp REBIND (`:1338`),
before the `rowsEquivalent(localRow, filtered)` check (`:1380`), and before both write branches —
all of which read `filtered`. Sanitizing after the equivalence check would make every redelivery
of a name-needing-sanitization mismatch the stored (sanitized) row and spam
`_insertConflictRow`/`_notifyConflict`. There is no sync-loop risk: `_applyEntry` never re-emits
(§2.4), so storing a value different from the one received cannot thrash lamports.

Separately, `save_profile` (`contacts/api-handlers.js:335`) stores the user's own
`profile_display_name` uncapped, and that value is *sent* on every handshake — cap it at write.

Every existing HTML sink was audited and is already safe: the Contacts panel is server-rendered
through `escapeHtml` (`contacts/html.js:37,166,170,204,368`), which escapes `"` and so makes the
`data-name="…"` attribute context safe (`components.js:5`); the Messages panel uses `escapeHtml`
server-side and `textContent` client-side (`messages/client.js:850,915,935,1336`).
`client.js:1116` uses `innerHTML`, but for message *content* via `renderMd`, never a contact
name. Sanitization is defense in depth for the non-HTML sinks (notification titles, logs, MCP
tool text) and to bound the stored value.

---

## 4. What gets built

### 4.1 `servers/sharing/contact-delete.js` (new)

One delete path, so the panel and the sync-apply path cannot diverge.

- `deleteContactCascadePreview(db, contactId)` → `{ messages, sharedItems, groups, projectsOwned, projectMemberships }`. Read-only; drives the confirmation copy.
- `unwireContact(managers, row)` → close the Nostr sub, close sync feeds, leave the DHT topic. Each step independently guarded (the `wireFullContact` convention). Runs **before** the row is removed — load-bearing: an in-flight `subscribeToContact` `onevent` INSERT against a deleted `contact_id` raises `FOREIGN KEY constraint failed`. R1 confirmed that throw is swallowed at `nostr.js:519`, so it cannot crash the receive path; unwire-first plus `stopped=true` prevents it arising at all.
- `deleteContactLocal(db, managers, row)` → `unwireContact`, `DELETE FROM contacts WHERE id = ?`, then `emitContactDelete(db, row.crow_id, row.lamport_ts)`.
- `writeTombstone` / `readTombstone` / `clearTombstone`, all skipping `req:` ids.

**Single source of truth for the local tombstone write (R2b-NEW-2):** it lives *inside*
`emitContactDelete` (`contact-sync.js`), never in its callers. That helper already has `db`, and
it is the one place that learns the emitted lamport. So `deleteContactLocal` and the
`upsertFullContact` MERGE fold each get the tombstone for free by calling it, and the two can
never drift (R1-M2). The `_applyContact` remote-delete path writes its own tombstone directly at
the incoming lamport — it does not emit.

`emitChange` is changed to **return** its `lamportTs` (verified: it currently returns
`undefined`, and no production caller or test inspects the return). Its early-return paths
(`feedsDisabled`, non-synced table, `shouldSyncRow` false) are changed from bare `return;` to
`return null;` so the contract is explicit (R2b-NEW-3). On a nullish return `emitContactDelete`
falls back to the row's own `lamport_ts` for the tombstone — no delete was broadcast, so only
local resurrection needs guarding. See §6 for the shared-DB caveat.

### 4.2 Panel: a real confirmation, then a real delete

The action handler's return contract is `{ redirect | download | inviteError | … }`
(`contacts/api-handlers.js:34`) — it **cannot render a view** (R1-m2). So the confirmation is a
GET interstitial:

- The Delete control links to `?view=contact&contact=<id>&confirm=delete`, rendered by the
  contacts GET view with the cascade counts, the "this applies to all your linked Crows" note,
  and Block / Cancel / Delete.
- Delete POSTs `action=delete_contact&confirm=1` → `deleteContactLocal` → `{redirect}`.
- A POST without `confirm=1` redirects to the interstitial rather than deleting.

**Invariant:** the interstitial GET must remain side-effect-free. `csrf.js` only guards
state-changing methods (`POST/PUT/DELETE/PATCH`), so a GET that mutated would be a CSRF hazard.
The destructive step is the POST, which passes through `csrfMiddleware` (`index.js:615`).
(Verified in R2.)

Also: drop the `AND contact_type = 'manual'` restriction, and **refuse** `origin='local-bot'`
rows (this instance recreates them at boot; `ensure-local-bot-contact.js`).

This reverses the comment at `api-handlers.js:255-257` ("a crow: contact delete is a deliberate
no-op so a local delete never propagates a destructive delete to peers"). Phase 3 decided
contacts follow the user; a delete that does not follow is a divergence bug. The reversal is
deliberate and recorded here.

i18n EN + ES for all new copy.

### 4.3 Sync

- `_applyContact`: the D3.1 rule, before the existing branches.
- `sanitizeDisplayName` at the exact hook point named in D5.
- A new boot-injected `onContactDeleted(row)` hook mirroring `onContactSynced`, so an applied
  remote delete also runs `unwireContact` locally. Today the delete branch returns before
  `_afterContactApplied` and no hook fires at all.

### 4.4 Nostr teardown

`NostrManager.unsubscribeFromContact(crowId)` closes **and removes** the map entries, iterating
`this.relays` to build exact `` `${crowId}:${url}` `` keys. Not a `startsWith` prefix scan:
`crowId` itself contains a colon (`crow:1m5ughwje2`), so prefix matching is a latent
cross-contact hazard (R1-m3). Close-only would leave dead handles the health loop keeps
iterating; `close()` sets `stopped=true`, so `ensureHealthy()` is already a no-op on them.

### 4.5 Handshake name + replay hygiene

- `sanitizeDisplayName()` in `servers/sharing/display-name.js` (new, zero-import, pure).
- `acceptInviteCore` adds `displayName` to `invite_accepted` when `profile_display_name` is set.
- `buildHandshakeComplete` gains an optional `displayName`; `ackHandshake` supplies it;
  `handleHandshakeComplete` applies it through the placeholder rule.
- `handleInviteAccepted` sanitizes `payload.displayName` and applies the D4 event-id rule.
- `save_profile` caps `profile_display_name` at write.

### 4.6 Schema

`SCHEMA_GENERATION` 5 → 6; `contact_tombstones` and `processed_control_events` in
`scripts/init-db.js`. The boot drift gate (`schema-version.js:29`, `needsSchemaInit` on
`userVersion < SCHEMA_GENERATION`) applies both on a plain restart — validated live five times
across this arc. `coreTableCount` is a fresh-install sentinel and needs no new entry.
`recover-crow-db.mjs` enumerates tables from `sqlite_master` (`:193`), so both survive recovery.
(All verified in R1.)

---

## 5. Testing

New: `tests/contact-delete.test.js`, `tests/contact-tombstones.test.js`,
`tests/display-name-sanitize.test.js`, `tests/handshake-display-name.test.js`.
Extended: `tests/contacts-sync.test.js`, `tests/contact-promote.test.js`,
`tests/invite-accepted-promote.test.js`, `tests/handshake-complete.test.js`.

Named regression guards. Each **must be mutation-tested** — break the code, confirm the test goes
red (the F-HEALTH-1 lesson; a vacuously-passing guard is worse than none):

1. **Resurrection-by-update.** Apply delete, then `update` at a higher lamport → row stays gone.
   *Mutation:* remove the tombstone `update` drop → red.
2. **Delete-before-insert.** Apply delete with `!localRow`, then the matching `insert` at a
   *lower* lamport → stays gone. *Mutation:* skip the `!localRow` tombstone write → red.
3. **Legitimate re-add via CREATE.** Apply delete, then `insert` at a higher lamport → row
   present, tombstone cleared. *Mutation:* make the tombstone absorbing for `insert` → red.
4. **Legitimate re-add via PROMOTE (the R1-C1 interleaving).** Delete `crow:Y`; create a
   `req:<secp>` row; re-accept an invite for `crow:Y` so `upsertFullContact` takes the PROMOTE
   branch; assert it emits `op="insert"` and that a peer holding tombstone{Y} applies it.
   *Mutation:* emit `update` from the promote branch → red. **This guard catches the CRITICAL;
   guard #3 alone does not.**
5. **Stale delete must not wipe a live contact (R2-MAJOR-1).** Local row at lamport 200 with
   messages; apply `delete@100` → row and messages survive, conflict row logged, tombstone
   recorded. *Mutation:* make the row delete unconditional → red.
6. **Stale local tombstone does not freeze a live row.** Tombstone{X} and a live row X coexist
   (the real path: `deleteContactLocal` then `crow_accept_bot_invite` re-inserts X); apply a peer
   `update(X)` → the update lands. *Mutation:* remove D3.1(a) → red.
7. **Replay hygiene.** `handleInviteAccepted` with a previously-recorded `event.id` → no contact
   created, ack still sent. A fresh `event.id` for the same crowId → contact created, tombstone
   cleared. *Mutation:* drop the recorded-id check → the stale-retry resurrection test goes red.
   A skew case is explicitly asserted: a fresh event whose `created_at` is *older* than
   `deleted_at` is still accepted (guards against reintroducing the clock comparison).
8. **Cascade disclosure.** `deleteContactCascadePreview` returns true counts against a DB seeded
   with messages/shares/groups/projects.
9. **Unwire.** Deleting a contact closes and **removes** exactly its `${crowId}:${url}` entries
   and leaves other contacts' entries untouched.
10. **Hostile name.** `<img src=x onerror=...>`, a 10 KB string, an RTL override, a `NUL`, a
    `\n`-bearing string, and `crow:deadbeef` each round-trip to a safe stored value or `null` —
    through the handshake path *and* the sync-apply ingress.
11. **Old-peer compatibility.** An `invite_accepted` with no `displayName` behaves exactly as
    today (contact named `crowId`).

Full suite must stay green: baseline **1258 pass / 0 fail / 1 skip**
(`node --test tests/*.test.js`).

---

## 6. Known limitations (accepted, documented)

- **Deploy order is load-bearing (R2-MINOR-2).** During a pull-only rollout a gen-5 peer applies
  a delete with no tombstone, and its later update resurrects on itself while the gen-6 deleter
  stays deleted. **All three instances must be on gen 6 before any contact deletion is
  performed.** The deploy step verifies `user_version = 6` on crow, grackle and MPA before the
  feature is exercised.
- **Incomplete pairing mesh (R1-M1).** §2.4: propagation is direct-paired, no relay. An instance
  that holds the contact but is not paired with the deleter never drains the delete. It keeps the
  row; tombstone-holders keep dropping its updates. Result is **divergence without
  resurrection** — strictly better than today, where the same topology resurrects everywhere.
  Transitive relay is an instance-sync-wide change (it applies equally to groups and settings).
- **Concurrent re-add can be swallowed (R1-m1).** A deletes X at lamport 100 while B (which
  deleted X at 50) re-adds it at 51 without having seen A's delete. B's `insert(51)` loses to A's
  tombstone(100); A's `delete(100)` reaches B and removes it. Both converge on *deleted*, but B's
  legitimate re-add is silently lost. Inherent to delete-wins semantics.
- **Cross-feed atomicity (R2-MINOR-1).** `_applyContact` yields at every `await`, and feeds lock
  per remote instance. Apply-then-clear ordering (D3.1(c)) closes the interleaving R2 found; the
  residual `UNIQUE`-throw-on-concurrent-insert is pre-existing and swallowed at `:901`. The
  convergence claim is stated for serialized application.
- **Shared-DB deployments (R2-MINOR-4).** grackle runs a `--no-auth` bridge co-resident with the
  primary gateway on the same `crow.db` (the PR #142/#143 lock history). A delete executed by the
  feeds-disabled process writes a tombstone and removes the row, but the feeds-enabled sibling
  never re-broadcasts it. The dashboard delete only runs on the authed, feeds-enabled gateway, so
  the trigger is narrow — but "correct" in §4.1 holds only for an isolated instance.
- **Advertised-contact prune resurrection (§2.6)** — pre-existing, untouched, its own PR.
- **Orphaned project spaces (R1-m5).** `project_spaces.owner_contact_id` is `SET NULL`. Deleting
  an owning contact leaves an ownerless shared space with no reassignment UI. The preview
  surfaces `projectsOwned` so it is disclosed, but not remediated.
- **D3.1(a) depends on no auto-materialize of normal contacts** — see the caveat under D3.1.

---

## 7. Scope boundaries

**In:** everything in §4.

**Out, recorded as follow-ups:**
- `pruneStaleAdvertisedContacts` resurrection (§2.6) — needs `origin` set at insert time inside
  `crow_accept_bot_invite`, plus a story for the materialize/prune flap between instances.
- `contact_groups` has the identical no-tombstone resurrection gap (`emitGroupDelete`).
- Transitive delete relay for an incomplete mesh (§6).
- No `crow_delete_contact` MCP tool. The finding is about the product surface; a new tool means a
  new kiosk-guarded, confirm-token destructive surface. YAGNI.
- Revoking outstanding invite codes when a contact is deleted (D4).
- Project-space owner reassignment UI (§6).
- Seeding `profile_display_name` during the setup wizard. Belongs to the onboarding/first-run
  theme alongside F-ONBOARD-1.

**Explicitly not touched:** black-swan (pristine at `/setup`), the Funnel exposure invariant,
`request_status` trust gating, `verified`/safety-number semantics.

---

## 8. Review disposition

### R1 (adversarial, Opus) — REVISE

| # | Sev | Finding | Disposition |
|---|---|---|---|
| C1 | CRITICAL | Re-pair takes `upsertFullContact`'s PROMOTE branch and emits `update`, which the tombstone drops → permanent divergence on the blessed flow | **Folded.** D3.2 emitter rule. Guard #4 reproduces the interleaving. |
| M1 | MAJOR | Convergence assumed a complete mesh; propagation is direct-paired | **Folded as precondition.** §2.4 + §6. Degrades to divergence-without-resurrection. |
| M2 | MAJOR | Every delete-emitting site must write a local tombstone; MERGE fold did not | **Folded.** D3.3; `emitContactDelete` co-writes. |
| M3 | MAJOR | `pruneStaleAdvertisedContacts` resurrects synced rows (pre-existing) | **Attempted fix withdrawn after R2-MAJOR-2 proved it inert.** Documented as pre-existing and scoped out (§2.6, §7). |
| m1 | MINOR | Delete-wins can swallow a concurrent legitimate re-add | Accepted + documented (§6). |
| m2 | MINOR | POST-action contract cannot render a confirmation view | **Folded.** §4.2 GET interstitial. |
| m3 | MINOR | `unwireContact` must delete map entries by exact key (`crowId` contains `:`) | **Folded.** §4.4. |
| m4 | MINOR | Sanitization missed the sync-apply ingress and the uncapped `save_profile` | **Folded.** D5, three ingress points. |
| m5 | MINOR | Orphaned project space; emit must precede the tombstone write | **Folded.** §6, §4.1. |

### R2 (adversarial, Opus — attacking the folds) — REVISE

| # | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MAJOR | D3.1(b) pseudocode dropped the `lamportTs > localTs` guard → a stale delete wipes a live contact **and cascades away its DM history** | **Folded.** D3.1(b) rewritten: tombstone write unconditional, row delete keeps LWW. New guard #5. |
| M2 | MAJOR | The `advertised` sync carve-out is inert — `origin` is set *after* the base `insert` is emitted with `origin=NULL`; and "re-derived per-instance" is false for invite-code bots | **Folded by withdrawal.** D3.4 removed; §2.6 documents the pre-existing bug and why the fix is its own PR. |
| M3 | MAJOR | D4's `created_at ≤ deleted_at` refuses honest re-pairs under routine clock skew, silently, for 60h | **Folded.** D4 rewritten around `event.id` replay hygiene — clock-free. Also closes a pre-existing replay gap for plain invites. Guard #7 asserts the skew case. |
| m1 | MINOR | Clear-then-apply is not atomic across concurrent peer feeds | **Folded.** D3.1(c) applies *then* clears; residual documented (§6). |
| m2 | MINOR | Rollout-order divergence (gen-5 peer honors no tombstone) | **Folded.** §6; deploy gate on `user_version = 6`. |
| m3 | MINOR | D5 sanitize hook point unspecified; wrong placement thrashes conflict logs | **Folded.** Exact hook point named in D5. |
| m4 | MINOR | Feeds-disabled process on a shared DB never propagates its delete | **Documented** (§6). |
| m5 | MINOR | Deleting a still-advertised bot may reappear | **Folded partly.** `crow_accept_bot_invite` gains `clearTombstone` (D3.2); reappearance is user-triggered, not automatic. |
| m6 | MINOR | D3.2's "manual `add_contact` handler" is a misnomer | **Folded.** D3.2 coverage list corrected. |
| m7 | MINOR | Tests #5/#7 vacuous or unrealizable | **Folded.** Old #7 deleted with D3.4; #6 now uses the real coexistence path. |

### R2b (focused confirm on the folds) — CONFIRMED

No CRITICAL or MAJOR introduced by the rewrites. All five folds verified faithful to the code:
D3.1(b) is a superset of today's delete branch (only the tombstone write + `unwireContact` are
new; `_insertConflictRow` needs no new arguments); D4 is implementable because
`ackHandshake` → `sendControl({secp256k1_pubkey: senderPubkey})` reads the key off a **synthetic
object** and never touches the DB (`nostr.js:321-327`) — the existing `"replayed"` verdict at
`boot.js:174` already acks with no contact row, so D4 generalizes a reviewed precedent rather
than inventing one; the D3.4 withdrawal leaves no dangling reference and nothing depends on
advertised contacts not syncing; apply-then-clear leaves only a benign row+tombstone state on a
mid-write crash, which D3.1(a) neutralizes on the next inbound entry; and no caller or test
inspects `emitChange`'s return. `CROW_NOSTR_RETRY_MAX_AGE_SEC` = 216000s (60h) ≪ the 30-day
prune, so no still-retryable event id can be pruned.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| NEW-1 | MINOR | Prose said the tombstone write is "unconditional"; the pseudocode correctly omits it from the loss branch. Misled a reviewer — would have been miscoded. | **Folded.** D3.1(b) prose rewritten around "authoritative". |
| NEW-2 | MINOR | Tombstone-write ownership read two ways (inside `emitContactDelete` vs. in `deleteContactLocal`) | **Folded.** §4.1 names one home: inside `emitContactDelete`. |
| NEW-3 | MINOR | `emitChange` early-returns `undefined`, not `null` | **Folded.** Early returns become `return null;`. |

Claims all three rounds verified against code: the FK cascade table and `better-sqlite3`'s per-
connection `foreign_keys=1` on every handle; `_advanceCounter` firing before dispatch (§2.3);
`event` threading and byte-identical retry replay; `escapeHtml` escaping `"`; `_applyContact`
branching on `localRow` not op; the gen-5→6 boot gate and `recover-crow-db.mjs` table
enumeration; CSRF covering the POST but not the GET; `emitContactDelete`'s complete caller set;
and that the in-flight-delete FK throw is swallowed at `nostr.js:519`.

---

## 9. Operator-visible behavior change

Deleting a contact now works, and it **permanently destroys the conversation with that contact on
every Crow you own**. That is disclosed on the confirmation screen with exact counts, and Block is
offered as the reversible alternative. This is the one decision in this design that is a product
judgment rather than a consequence of the code (§D1); it is called out here so it can be reversed
cheaply if the walkthrough shows users expect otherwise.

No other user-visible behavior changes. Advertised bot contacts continue to sync exactly as they
do today (§2.6).
