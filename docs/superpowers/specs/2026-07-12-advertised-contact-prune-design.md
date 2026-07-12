# Item 2a — `pruneStaleAdvertisedContacts` resurrection: design

**Status:** spec **v5** — BUILT and shipped on `fix/advertised-contact-prune-impl`.
**History:** v1 → R1 **REVISE** (4 CRIT) → v2 → R2 **REJECT** (4 CRIT) → v3 → R3 **REJECT**
(2 CRIT, *spine confirmed*) → v4 → **its convergence proof was found FALSE during the build**
(R4, below) → **v5** (adds `contact_tombstones.kind`; architecture otherwise unchanged).
**Branch:** `fix/advertised-contact-prune-impl`. **Plan:** `2026-07-11-opus-autonomous-arc.md` §4 Item 2a.

> ### 🔴 R4 — v4's convergence proof was FALSE. Read this before touching the tombstone.
> v4 (§3 F4) claimed: *"a genuine re-add is emitted at the re-adder's next lamport, which is
> necessarily `> R.lamport_ts` (its counter advanced past that row when it applied it) ⇒
> **applies and clears the tombstone.**"*
>
> **That clause is false, and it is a fourth permanent-divergence bug** — found by the
> two-instance durability suite (§5.6's harness) *during the build*, not by any of the three
> adversarial review rounds. The gate runs on the **PEER**, against the **PEER's** tombstone —
> which sits at the **PEER's** row lamport. Two instances' row lamports are equal **only when
> every emit has been applied on both sides.**
>
> | step | A | B |
> |---|---|---|
> | A adds the bot, emits `insert@1` | row 1, counter 1 | row 1 |
> | B renames/blocks it → emits `update@3`. **A never receives it** (offline / feed lag) | counter still 1 | row **3** |
> | advertiser un-advertises ⇒ **both prune** | tombstone **@1** | tombstone **@3** |
> | user re-adds on A ⇒ `acceptBotInvite` emits `insert@2` | row back | — |
> | B applies: `2 <= 3` ⇒ **DROPPED** (`instance-sync.js:1549`) | has the bot | **no row, tombstone stands** |
>
> **Permanent:** every later emit from A is `op="update"`, dropped *unconditionally* by the
> tombstone. `sync_conflicts` stays 0. Nothing is logged. Only a manual re-add on B recovers it.
>
> Neither existing counter-floor saves it (both verified in code): `emitChange:980-983` floors
> at the **outgoing row's** lamport — but a re-added row is a **fresh INSERT** (`lamport_ts` 0),
> so there is nothing to floor against; `_applyEntry:1127` advances on receipt — but A never
> *received* the update.
>
> **Root cause:** a prune tombstone's lamport is a **LOCAL row lamport**. Comparing a **global**
> insert lamport against it compares **incommensurable things**. An authoritative user delete
> (#155) is different: it was **BROADCAST**, so its lamport *is* a global emit lamport and the
> stale-replay gate is correct there.
>
> **v5's fix — `contact_tombstones.kind`** (gen 7 covers it; no second bump):
> - `NULL` = **authoritative** (a user delete) — keeps the `insert <= tomb.lamport_ts ⇒ drop` gate.
> - `'prune'` = **garbage collection** — blocks `op="update"` (which is *all* of defect D3, since
>   every resurrection vector is an update) but **never gates an `insert` on lamport.**
> - `ON CONFLICT` resolves **authoritative-always-wins**, so a GC write can never weaken a real
>   user delete into a permissive gate.
>
> Worst case under v5: a redelivered *original* insert re-creates the row, and the next render
> simply **re-prunes it** — self-healing, no divergence. Safe because *every* `op="insert"`
> emitter was enumerated: `accept-bot-invite.js:124` (a genuine re-add — **must** land);
> `contact-promote.js:237` (an accepted message-request — should land); `contacts/api-handlers.js:124,414`
> (manual/vCard — `advertised_by` NULL ⇒ never prunable ⇒ unreachable); `backfillContactsOnce`
> (excludes `is_bot=1` **and** emits `op="update"` — doubly unreachable).
>
> **The lesson, again:** the unit test that *names* the property ("tombstone lamport === the row's
> own") stayed **GREEN** under the fresh-counter mutation, because its harness passes a null
> `managers` and has no SyncManager. Only a **two-instance mutual prune** can see this class of
> bug. §5.6 was right to be mandatory — and it was still not enough on its own.
**Constrains this:** `2026-07-09-contact-deletion-and-handshake-name-design.md` (PR #155) §2.6 + R2/MAJOR-2.

> **⚠️ Two scope changes vs the plan, both forced by review:**
> 1. **2a carries a SCHEMA BUMP** (`SCHEMA_GENERATION` 6→7). The plan assumed it was
>    schema-free; three rounds proved every schema-free design unsound (§2).
> 2. **The plan's migration rail is INSUFFICIENT — and this affects 2b, not just 2a.**
>    See §7. Fix the rail before *any* schema-bumping PR ships.

---

## 0. Live-fleet measurement (corrected — R3 caught §0 measuring the wrong DB, again)

Every previous round caught the *previous* §0 measuring the wrong thing: v2 never read
`crow_instances`; v3 never read **MPA's `contacts`** — a CROW_HOME that §0 itself names as a
trusted peer. All four production DBs are measured here (2026-07-12).

| host | DB | contacts | `origin='advertised'` | `origin='local-bot'` | tombstones | `user_version` | lamport |
|---|---|---|---|---|---|---|---|
| crow | `~/.crow` | 4 | 0 | 0 | 4 | 6 | 4385 |
| **MPA** | `~/.crow-mpa` | **5** | 0 | **1** | 4 | 6 | **4384** |
| grackle | `~/.crow` | 3 | 0 | 0 | 4 | 6 | 4385 |
| black-swan | `~/.crow` | 1 | 0 | 0 | 0 | 6 | — |

**`crow_instances` (crow):** Grackle + **MPA**, both `trusted=1, active`. black-swan not paired.
**Instance ids are PORTABLE** (R3 verified against all three registries: one id per instance,
persisted in `$CROW_DATA_DIR/instance-id`, propagated verbatim by pairing) — this is the
load-bearing assumption of F2 and it holds.

**`pi_bot_defs` — what is actually advertised** (`listAdvertisedBots` = `enabled=1` AND a
`crow-messages` gateway with `allow_paired_instances=true`, `bot-builder/crow-messages-admin.js:139`):
crow `crow-home`; grackle `grackle-home`, `crow-glasses`. **`allow_paired_instances` is set on
NONE of them.**

**Six facts that shape everything:**

1. **Not one bot on the fleet is advertised** ⇒ the directory is empty ⇒ `live.size === 0` ⇒
   **the prune has never fired.** The defect is doubly latent. **There is no urgency**; the bar
   is `fix-the-product` (correct on a fresh install), not incident response.
2. **`origin='local-bot'` exists on exactly one row fleet-wide (MPA).** A bot's host usually has
   **no contacts row for its own bot at all** (`ensureLocalBotContact`'s only caller is
   `routes/peer-messages.js:373`, room hosting). Guards keyed on that column are near-inert —
   which is what killed v1.
3. Every contact is `origin=NULL`, `advertised_by` will start NULL everywhere ⇒ the new column
   is a no-op on real data.
4. **The fleet's lamport counters sit at 4385 / 4385 / 4384** — inside the ±1 tie regime that
   produced R3's CRITICAL-1. Not hypothetical.
5. **All four DBs are `user_version = 6`**, and a bump re-runs the *entire* `init-db.js` — which
   contains **8 `DROP TABLE`** rebuild-migrations (§7).
6. The live proof must **create** a throwaway advertised bot on grackle (fact 1). Kevin's three
   existing bot definitions are not touched.

---

## 1. The defect chain

**D1 — `origin` is classified AFTER the row is on the wire.** `crow_accept_bot_invite`
(`tools/contacts.js:385`) inserts with no `origin`, then emits `insert` (`:406`). The *caller*
stamps it afterwards: `contacts/api-handlers.js:432` (UPDATE → `markContactIsBot` → a **second**
emit at `:437`) and `messages/api-handlers.js:264` (same UPDATE, **no emit** — asymmetric). Peers
get `origin=NULL`, and whether they learn otherwise depends on *which panel the user clicked*.
This is why #155's `shouldSyncRow` carve-out was **inert** (its R2/MAJOR-2).

**D2 — `origin` rides the wire; apply writes the sender's value verbatim.**
`EXCLUDED_COLUMNS.contacts` (`instance-sync.js:101`) omits it; `_applyContact` writes it on INSERT
(`:1590`) and LWW UPDATE (`:1612`). `origin` is a **judgment** ("I may GC this"), true only
relative to the holder. Replicating it is dangerous both ways: *toward the host* (a peer's emit
creates/relabels the host's own bot row `'advertised'`; a host's own bots are never in its own
`live` set, `data-queries.js:243` ⇒ **the host prunes its own bot**), and *toward a peer that
cannot see the advertisement* (it inherits `'advertised'` for a bot it never sees advertised ⇒
**it prunes a live bot on its next render**).

**D3 — the prune deletes locally, with no emit and no tombstone (the reported bug).**
`pruneStaleAdvertisedContacts` (`messages/data-queries.js:284-301`) issues a bare `DELETE`
(`:297`). The row survives on every peer, so any later emit — **all of which are `op="update"`**
(block/unblock `contacts/api-handlers.js:61,80`; profile edit `:257`; accept-request
`messages/api-handlers.js:317`; `backfillContactsOnce:651`) — arrives with no local row and no
tombstone → `_applyContact` takes `!localRow` (`:1543`) → **re-INSERT**. Resurrection.

**D4 — the trigger is unsound, two independent ways.**
(1) *Absent ≠ unavailable*: a peer that errors or exceeds the **2 s** timeout yields
`{status:"unavailable"}` (`advertised-bots-cache.js:11,51`), cached **60 s**; the loop skips it
silently (`data-queries.js:251`); the prune fires if **any single** peer answered
(`live.size > 0`, `:275`).
(2) *A peer answers **200 with a bot missing***: `buildAdvertisementPayload` `catch`es **per bot**
and `continue`s (`bot-builder/crow-messages-admin.js:194-197`); the route still 200s
(`federation.js:272`). A **"database is locked"** on `getOrCreatePairedRosterInvite`'s INSERT (a
*documented recurring* failure here), an unreadable `identity.json` (⇒ **every** bot skipped,
`{bots:[]}`, 200), or a bot merely **disabled** all produce a healthy-looking, incomplete list.

**D4 is why D3 cannot be fixed alone.** Today the resurrection *is* the self-heal for a mis-fire.

---

## 2. Three designs died here (do not resurrect them)

**v1 — the prune broadcasts a delete-wins tombstone.** R1, all re-verified: `emitChange` appends
inside `for (…of this.outFeeds)` and **returns `lamportTs` unconditionally**
(`instance-sync.js:1027-1036`) — with zero feeds it broadcasts to nobody and reports success
(`backfillContactsOnce:612` guards exactly this window; its comment records it **observed live on
grackle**); the `origin='local-bot'` host guards are **inert** (§0 fact 2) so the delete
cascade-destroys the host's own bot's `messages` via FK; and delete-vs-update LWW is **asymmetric**
(`:1506-1525` conflict-logs a losing delete, while `:1537` drops updates unconditionally) ⇒
permanent divergence **and** `sync_conflicts` growth in a non-complete pairing graph.

**v2 — strip `origin`, local-only tombstone, accept divergence.** R2, all re-verified: `deferEmit`
**cannot cross the MCP boundary** (panels call `client.callTool`; zod `z.object()` strips unknown
keys); v2's helper read `row.crow_id`/`row.lamport_ts` from a SELECT that fetches **neither**
(`data-queries.js:286-292`) while `writeTombstone` **no-ops on a falsy crowId and swallows errors**
(`contact-delete.js:29,37`) ⇒ the headline fix would have shipped as a **silent no-op**; and a
durable tombstone on D4's trigger is a **net regression** vs today's self-healing bug.

**v3 — as below, but with a `_nextLamport()` tombstone and a *negative* `partial` flag.** R3, both
re-verified: the tombstone lamport produced a **permanent, unrecoverable divergence on a lamport
tie** (the fleet sits at 4385/4385/4384 — §0 fact 4), and `partial` being a *negative* signal meant
an old, drifted, or unlucky peer's `200 {bots:[]}` read as **complete** — reintroducing the exact
regression that killed v2.

### The insight that survived all three rounds

> `origin` is a **judgment** — view-relative; it must not sync.
> *"Instance X advertised this bot"* is a **FACT** — true everywhere; it syncs safely.

Sync the fact; let every instance re-derive the judgment **from its own view**. Convergence then
needs **no broadcast, no delete on the wire, and no host authority** — so v1's failure modes cannot
arise and `sync_conflicts` cannot grow. R3 attacked this spine directly and **could not break it**:
instance ids are portable, rule 1 does protect the host, and the per-advertiser trigger is strictly
better than any denominator tweak.

---

## 3. The design (v4)

### F1 — completeness is a POSITIVE assertion, checked on BOTH sides (fixes D4.2)

*(R3/CRITICAL-2: v3's `partial:true` was a negative signal — absence of the key meant "trust me",
so an old peer mid-rolling-deploy, a receiver-side validation drop, or a malformed body all read as
complete.)*

- **Sender:** `buildAdvertisementPayload` returns `complete: true` **only when zero bots were
  skipped** (i.e. the `catch` at `:194` never fired).
- **Receiver:** `doFetch` (`advertised-bots-cache.js:48-56`) downgrades to `complete: false` when
  `raw.length !== bots.length` (a `validateBot` drop, `:54`), and returns
  **`status:"unavailable"`** — not `ok` with an empty list — when the body is not `{bots:[…]}`.
- **The prune requires `status === "ok" && complete === true`.** An old peer sends no key ⇒
  `complete` is falsy ⇒ **never prunes**. Fail-safe by construction, across the whole rolling
  deploy window.

An **intentionally** un-advertised bot (deleted, disabled, `allow_paired_instances` off) is simply
absent and *is* prunable — that is the product semantic, and it is documented: *disabling or
un-advertising a bot removes it from paired instances' directories and prunes the zero-message
contacts auto-added from it.* F1 draws the line at **error vs intent**, which is the distinction the
code currently loses. (A6 in §4 is the precise long-term fix.)

### F2 — `contacts.advertised_by_instance_id` (the FACT) — ⚠️ **SCHEMA BUMP 6 → 7**

`init-db.js`: `addColumnIfMissing("contacts", "advertised_by_instance_id", "TEXT")`.
`servers/shared/schema-version.js:13`: `SCHEMA_GENERATION = 7`.

- **Set at INSERT only** (F5) = the instance_id of the peer whose directory the bot was added from.
- **Synced** (deliberately *not* in `EXCLUDED_COLUMNS`) — a portable fact (§0).
- **`NULL` ⇒ never prunable.** Manual and pasted-invite contacts are structurally safe, which
  *dissolves* #155 §2.6's objection instead of arguing around it.
- Every existing row is NULL (§0 fact 3) ⇒ no data migration.

### F3 — `origin` is a judgment: strip it from the wire (fixes D2)

Add `"origin"` to `EXCLUDED_COLUMNS.contacts` (`instance-sync.js:101`) **and** `ALWAYS_DROP`
(`:1453`). R3 verified this is safe: **`shouldSyncRow` runs on the raw row at `:962`, *before* the
strip at `:979`**, so the `origin='local-bot'` sync gate is unaffected. `origin` remains a local
marker (it still drives the `is_bot` backfill at `init-db.js:2748`), but **the prune no longer keys
on it** — it keys on F2's fact.

### F4 — the prune, rewritten (fixes D3 + D4)

**Call-site split (R3/MAJOR-6 — this is a real bug today):** `getBotDirectory` currently *calls the
prune as a side effect* (`data-queries.js:275`). F5's handler needs the directory to resolve the
advertiser, which would make **clicking "Add" durably delete other contacts**. So `getBotDirectory`
gains `{ prune: false }` (default for every non-render caller) and **returns the per-instance map**;
only the Messages/Contacts **render** invokes the prune.

`perInstance: Map<instanceId, { ok, complete, pubkeys: Set }>`.

```sql
SELECT c.id, c.crow_id, c.lamport_ts, c.secp256k1_pubkey, c.advertised_by_instance_id
FROM contacts c LEFT JOIN messages m ON m.contact_id = c.id
WHERE c.advertised_by_instance_id IS NOT NULL
GROUP BY c.id HAVING COUNT(m.id) = 0
```
*(`crow_id` and `lamport_ts` are called out because v2's helper read them from a SELECT that
fetched neither — R2/C4. A missing `crow_id` must **warn and skip**, never rely on
`writeTombstone`'s silent no-op.)*

Prune row R **iff all** hold:
1. `R.advertised_by_instance_id !== localInstanceId` — **the host never prunes its own bot** (a
   fact, replacing the near-inert `origin='local-bot'` guard);
2. that instance is a **trusted peer queried this cycle**;
3. it answered **`ok` AND `complete`** (F1);
4. R's x-only pubkey is absent from **that instance's** advertised set **and** from every other
   `ok`+`complete` peer's set *(the second clause closes R3/MINOR-7: `getBotDirectory:250` dedups
   on first-seen pubkey, so a bot advertised by two instances could otherwise be pruned while still
   live)*;
5. R has **zero messages** — the prune never destroys history.

Then, via a new `servers/sharing/contact-prune.js`: `unwireContact` (`contact-delete.js:94` — also
fixes a pre-existing Nostr-subscription leak) → `DELETE FROM contacts WHERE id = ?` →
**`writeTombstone(db, R.crow_id, R.lamport_ts)` — LOCAL, no emit.**

> **Tombstone lamport = `R.lamport_ts` (the pruned row's own), NOT a fresh counter value.**
> This is R3/CRITICAL-1's fix, and it is the whole of it. v3 wrote `_nextLamport()`, which burns a
> **local** counter invisible to the fleet (the prune emits nothing) — so two instances pruning
> independently landed on tombstones the *re-adder's* insert could tie with, and the gate drops
> ties (`:1538` `lamportTs <= tomb.lamport_ts`). At 4385/4385/4384 (§0 fact 4) that is a coin flip
> ending in **permanent, unrecoverable divergence**. Using the row's own lamport makes the gate
> exactly right with **no new column and no manager access**: a replay of an already-seen `insert`
> is `<= R.lamport_ts` ⇒ dropped; a genuine re-add is emitted at the re-adder's next lamport, which
> is necessarily `> R.lamport_ts` (its counter advanced past that row when it applied it) ⇒
> **applies and clears the tombstone.** The existing gate needs no `kind` column: `op="update"` is
> dropped unconditionally (`:1537`), and **every** D3 resurrection vector is an `update`.

**Why this converges with no broadcast:** every instance paired with X evaluates the same rule
against its own view of X and prunes independently ⇒ **"gone on both sides", the plan's acceptance
criterion.** An instance *not* paired with X fails rule 2, keeps its copy (fail-safe), and its
updates are dropped by the pruner's tombstone — so the pruner stays clean either way.

### F5 — one shared `acceptBotInvite()`; classification never crosses the MCP surface

Extract `acceptBotInvite(db, managers, { inviteCode, displayName, advertisedByInstanceId })` into
`servers/sharing/accept-bot-invite.js`. **Both** the MCP tool (`tools/contacts.js:358`, **schema
unchanged**) and the two panel handlers call it **directly** — the panels already import from
`servers/sharing/`, so no MCP round-trip. This kills v2's unbuildable `deferEmit` *and* R1/M3 (a
model must never be able to stamp a contact prunable).

On the create branch, in one place: INSERT carrying `origin='advertised'`, `is_bot=1`,
`advertised_by_instance_id=X` when the caller supplies X (panels) — or plain `origin=NULL,
is_bot=0, advertised_by=NULL` when not (MCP paste: **byte-identical to today**) → `clearTombstone`
→ **exactly one** `emitContactChange("insert", row)`. `insert` is load-bearing: it is the only op
that passes a peer's tombstone gate (`:1538-1539`), so a re-add after a prune actually lands.
`markContactIsBot` is retained on the already-a-contact branch (unchanged).

**Where the panel gets X:** from a **prune-free** `getBotDirectory({prune:false})` read — parse the
invite → x-only pubkey → the instance advertising it. Authoritative and unspoofable (never from the
form).

### F6 — dropped by R3, **RESTORED by R5/CRITICAL-2** (the premise had been deleted)

> #### 🔴 R5 — "F6 is unreachable" was true of v3 and FALSE of v5. Nobody re-derived it.
> R3 dropped F6 (a guard on the same-secp rebind) as **unreachable**, and it was right *at the time*:
> the tombstone gate returned for `op="update"` **and** for `insert <= tomb.lamport_ts`, so by the
> time control reached the rebind, "a tombstone is standing" was **false by construction**.
>
> **`kind='prune'` deleted exactly that premise.** A prune tombstone deliberately does **not** gate an
> `insert` on lamport (that is R4's whole fix) — so a standing GC tombstone now coexists with a
> reachable rebind, and F6's clause went from dead code to a live hole in one commit. **The dropped
> finding was never re-derived against the design that replaced it.**
>
> **The resurrection, on top of §5 test 10's own state:**
> 1. the contact is pruned (GC tombstone standing, row gone);
> 2. the bot is un-advertised, **not dead** — it DMs us, and §5.10 files that under a `req:<secp>`
>    placeholder row **carrying the message**;
> 3. a **replayed ORIGINAL `insert`** arrives (feed replay after a re-pair or a DB restore — this
>    fleet has had both). It misses on `crow_id`, matches the placeholder on **secp**, and **REBINDS
>    it**: the pruned bot is back, **carrying that DM**.
> 4. And now it *has* a message ⇒ prune **rule 5** (`HAVING COUNT(m.id) = 0` — "the prune never
>    destroys history") **blocks it from EVER being re-pruned.**
>
> So the claim that licenses letting replayed inserts through — *"worst case a redelivered ORIGINAL
> insert re-creates the row and the next render simply RE-PRUNES it. Self-healing."* — was **FALSE**.
> Defect **D3**, restored.
>
> **The fix (narrow, and verified against the schema):** `contacts` is `UNIQUE` on **`crow_id` only**
> — there is no unique index on `secp256k1_pubkey` — so a `crow:<botid>` row and a `req:<secp>` row
> may coexist. When a **`kind='prune'`** tombstone stands **and** the same-secp match is a **`req:`**
> placeholder, skip the rebind and fall through to a plain INSERT. The re-add lands **fresh,
> zero-message, and RE-PRUNABLE** (self-healing genuinely restored) and the DM stays on the message
> request — which is exactly the semantic §5.10 documents. The rebind is **not** disabled generally:
> it remains load-bearing for the ordinary `req:` → `crow:` handshake promotion.
>
> **The lesson:** a finding dropped as *unreachable* is only as good as the premise that made it so.
> When a later change deletes that premise, the dropped finding is **live again** — and nothing in
> the process re-opens it. Record the premise *with* the dismissal, and re-check it on every change
> that touches the gate it depends on.

The *other* half — the rebind promoting a `req:` pending row to a full contact because
`request_status` is not in `EXCLUDED_COLUMNS` — is, **for a live (un-pruned) contact**, still
**arguably correct** Phase-3 behaviour (only the operator's own instances can emit, so the `insert`
means *the user accepted this bot on another instance*, and contacts follow the user). That path is
untouched. **Filed for investigation (§6.4)** rather than "hardened" on a hunch.

---

## 4. Rejected alternatives

| # | Alternative | Why rejected |
|---|---|---|
| A1 | Exclude `origin='advertised'` from `shouldSyncRow` | **Inert** (D1); loses pasted-invite bots (#155 R2/MAJOR-2). Forbidden by the plan. |
| A2 | Prune broadcasts a delete-wins tombstone (**v1**) | §2 — zero-feed silent no-broadcast; inert host guards ⇒ cascades the host's own bot's DM history; LWW asymmetry ⇒ divergence + conflict growth. |
| A3 | Local-only tombstone, accept divergence (**v2**) | §2 — unbuildable `deferEmit`; silent-no-op helper; durable tombstone on an unsound trigger = net regression. |
| A4 | Delete the prune entirely | Honest; abandons a shipped feature and lets dead contacts accumulate. Fallback only if F4 fails review again. |
| A5 | Derive `origin='advertised'` per-render from the live set | Also stamps **manually-added** invite-code bots that happen to be advertised ⇒ prunable ⇒ re-introduces the §2.6 loss. |
| A6 | Host-authoritative bot-deletion propagation | Sound and strictly more precise (distinguishes *deleted* from *disabled*), but a **new mechanism** (bot-delete hook + wire delete + a DM-history-cascade decision) that needs F1/F2 anyway. **Filed (§6.1).** F2+F4 deliver the plan's acceptance without it. |

---

## 5. Test plan (TDD — RED first; every rule gets a mutation check)

Scratch env: `CROW_HOME`+`CROW_DATA_DIR` (mkdtemp), `CROW_DISABLE_NOSTR=1`,
`CROW_DISABLE_INSTANCE_SYNC=1`. Gate = the 3 known pre-existing scratch failures, zero others.

1. **F1.** Sender: a bot whose identity throws ⇒ **no** `complete` key (and still 200); a clean
   payload ⇒ `complete:true`. Receiver: a `validateBot` drop (`raw.length !== bots.length`) ⇒
   `complete:false`; a non-`{bots:[…]}` body ⇒ `status:"unavailable"`. **An old peer (no key) ⇒
   never prunes** — the rolling-deploy guard. *Mutation: make `complete` default-true ⇒ named test red.*
2. **F5 / D1.** Panel add ⇒ **exactly one** emit, `op="insert"`, payload carries `is_bot=1` **and**
   `advertised_by_instance_id=X`; row has `origin='advertised'`. MCP-tool path ⇒ still emits its own
   `insert`; row is `origin=NULL, is_bot=0, advertised_by=NULL` (**emit-coverage regression guard**).
   *Mutation: drop the panel emit ⇒ red.*
3. **F3 / D2.** An emitted payload has **no `origin` key**. An inbound entry carrying
   `origin:'advertised'` never writes `origin` locally — in **both** shapes: local row is
   `'local-bot'` (unchanged) and **local row absent** (inserts with `origin` NULL — the real fleet
   shape). *Mutation: remove `origin` from `EXCLUDED_COLUMNS` ⇒ all red.*
4. **F4 — the trigger matrix.** Advertiser `ok`+`complete`, bot absent ⇒ pruned. Advertiser
   `unavailable` ⇒ **not**. Advertiser `ok` but **not `complete`** ⇒ **not** *(the R3/CRITICAL-2
   case)*. Bot absent from a *different* peer's list but present in its advertiser's ⇒ **not**. Bot
   advertised by a **second** peer ⇒ **not** *(R3/MINOR-7)*. `advertised_by == me` ⇒ **not**
   *(host protection)*. `advertised_by IS NULL` ⇒ **not** *(manual contact)*. Row **with messages**
   ⇒ **not**. *Mutation: each of the seven conditions individually ⇒ a named test red.*
5. **F4 — the headline (D3).** Two in-process instances on a shared feed. A prunes ⇒ row gone,
   tombstone at **`row.lamport_ts`**; B emits `update` ⇒ **A does not resurrect**; restart A ⇒ still
   gone. Negative control: a still-advertised contact syncs normally throughout.
   *Mutation: bare DELETE ⇒ the resurrection assertion goes red.*
6. **F4 — the lamport-tie regression (R3/CRITICAL-1). MANDATORY — v3's §5 was structurally
   incapable of catching this.** **BOTH** instances prune (mutual GC, the case v3's plan omitted),
   *then* the one with the **lower** counter re-adds and emits `insert`. The other **must** apply it
   and clear its tombstone. Assert with counters deliberately set to a **tie** and to
   **re-adder < peer**. *Mutation: write the tombstone at a fresh `_nextLamport()` instead of
   `row.lamport_ts` ⇒ this test goes red (and every other test stays green — which is precisely why
   v3 shipped the bug).*
7. **F4 — convergence (the plan's acceptance).** Two instances **both** paired with advertiser X,
   both holding the contact (one added it; the other got it by sync **with `advertised_by=X` on the
   wire**). X un-advertises ⇒ **both** prune independently, **no delete on the wire**, `sync_conflicts`
   unchanged on both.
8. **R3/MAJOR-6.** `getBotDirectory({prune:false})` performs **zero** deletes (the add path must
   never GC). *Mutation: default `prune` to true ⇒ red.*
9. **`sync_conflicts` byte-identical** before/after every scenario (baselines: crow 219 / MPA ? /
   grackle 162 / black-swan 0 — re-measure MPA).
10. **Documented, not fixed (R1/M4).** After a prune, a DM from the still-running bot creates a
    `req:<secp>` message-request row. Asserted so the behaviour is *chosen*, not discovered.

**Live (crow ↔ grackle ↔ MPA).** Per §0 fact 1 nothing is advertised: create a **throwaway** bot on
grackle with `allow_paired_instances=true` (Kevin's three defs untouched) → add it on crow from the
directory → confirm the contact **and its `advertised_by_instance_id`** reach MPA over the wire →
un-advertise on grackle → force a render → confirm it is pruned on crow **and independently on
MPA**, with **no delete on the wire** → confirm crow does not resurrect on a grackle update →
restart both → still gone → `sync_conflicts` unchanged on all four → delete the throwaway bot.
**Before starting: `fuser ~/.crow/data/crow.db` and kill stale stdio MCP children** — `_contactCols`
is memoized for the SyncManager's lifetime (`instance-sync.js:1440-1446`), so a process started
before the migration silently drops the new column from every entry it applies (R3/MINOR-8).
Evidence → `~/.crow/p4/2a-prune/`.

---

## 6. Follow-ups filed (append to the plan queue)

1. **A6 — host-authoritative bot-deletion propagation.** The only mechanism that distinguishes
   *deleted* from *disabled*.
2. **[REAL BUG in shipped code — R1/C1] `emitChange` returns a valid lamport with
   `outFeeds.size === 0`** (`instance-sync.js:1027-1036`). So **#155's user-initiated contact
   delete**, if it lands in the boot window, writes a tombstone, broadcasts to **nobody**, and
   thereafter silently drops the peer's updates (`:1537`) ⇒ permanent divergence, no error.
   `backfillContactsOnce:612` already guards that window — comment records it **observed live on
   grackle**. **→ Item 2c.**
3. **[LATENT — R1/C2] Every `origin='local-bot'` guard is weaker than it reads**
   (`shouldSyncRow:204`, `deleteContactLocal:143`, `wireSyncedContact:111`), because a host usually
   has no row for its own bot (§0 fact 2). F2's fact protects the *prune* path; the others remain
   exposed — e.g. #155's user delete can cascade-delete a host's own bot contact. Fix = recognise
   own bots **by key** (`deriveBotIdentity`), or materialise the `local-bot` row at boot.
4. **[INVESTIGATE — R2/M3, R3/MAJOR-3] The same-secp rebind promotes a `req:` pending row** to a
   full contact (`request_status` is not in `EXCLUDED_COLUMNS`). Probably correct (contacts follow
   the user), but undecided — decide it deliberately rather than by omission.

**Residual, accepted:** *disable ≠ delete* (an intentionally disabled bot prunes zero-message
contacts on paired instances — no history is ever destroyed, and re-advertising makes it re-addable);
a peer not paired with the advertiser keeps its copy (fail-safe); a pruned-but-running bot's DM
appears as a *message request*, not a resurrection.

---

## 7. ⚠️ The migration rail is INSUFFICIENT — and this blocks **2b**, not just 2a (R3/MAJOR-4)

**Verified:** `needsSchemaInit` (`schema-version.js:21-25`) → `userVersion < SCHEMA_GENERATION` →
`gateway/index.js:134` runs **the entire `scripts/init-db.js`**, not just the new column. That file
contains **8 `DROP TABLE`** statements — `shared_items` (`:493`), `crow_context` (`:1275`),
`dashboard_settings` (`:1834`), `research_projects` (`:2696`), a generic `DROP TABLE ${tableName}`
(`:926`), plus `DELETE FROM schedules` (`:2726`) and `DELETE FROM project_spaces` (`:1023`).

These are *guarded rebuild-migrations*, but **they have not run since gen 6 was stamped**, and a bump
re-arms every one of them against **four** live production DBs (crow, MPA, grackle, black-swan — all
at `user_version = 6`).

**The plan's rail cannot detect the damage it exists to prevent.** `PRAGMA integrity_check` reports
*page-level* integrity — it returns `ok` for a table that was rebuilt having silently lost rows.
`user_version = 7` proves only that the script reached its last line.

**Required rail addition, before ANY schema-bumping PR (2a or 2b) merges:**
> Run `node scripts/init-db.js` against a **COPY** of each of the four prod DBs and **diff
> `sqlite_master` + per-table `COUNT(*)` pre/post**. Zero unexplained deltas is a merge gate. Ship
> the diff as evidence. (Also: init-db does heavy DDL against a DB the gateway holds open —
> `"database is locked"` is a documented recurring failure on this fleet. Stop the gateway first.)

---

## 8. Status: BUILT (2026-07-12) — see the R4 block at the top

The build shipped F1–F5 as five commits plus a sixth carrying the **R4 fix** (`contact_tombstones.kind`)
and the two-instance durability suite that found it. F6 stayed dropped. The dry-run gate was re-run
**from the bump-bearing branch** and passed on all four prod DBs (`~/.crow/p4/2a-prune/dryrun-branch-gen7.txt`):
`user_version` 6→7, zero row-count deltas, nothing lost, and all four *existing* tombstones migrate to
`kind = NULL` (**authoritative** — the safe direction; a `'prune'` default would have weakened Kevin's
real user-deletes).

**A blind spot in the gate itself, found here and filed:** `scripts/schema-migration-dryrun.sh` diffs
`sqlite_master` **object names**, so `ALTER TABLE … ADD COLUMN` is **invisible** to it. It proves nothing
was *lost*; it cannot prove your migration *happened*. Both new columns were therefore verified positively
against a migrated copy by hand. **Fix: add a per-table `PRAGMA table_info` diff.**

<details><summary>Original v4 stop-note (kept — its reasoning was right)</summary>

### Design complete, implementation deliberately NOT started

Three adversarial rounds killed three designs; **v4's architecture was attacked directly by R3 and
held.** What remains is a build with a genuinely dangerous tail: a `SCHEMA_GENERATION` bump against
four production databases whose migration rail I have just proven insufficient (§7).

Starting that build at the end of a long session — with the rail unfixed, the dry-run diff not yet
run, and a live proof that requires creating and then removing a throwaway advertised bot on
grackle — is exactly the unattended risk the plan's own rules exist to prevent. **The honest
deliverable of this session is the vetted design plus three production bugs found on the way** (§6.2,
§6.3, §7). The build is a clean, well-specified fresh-session job.

**Sequencing recommendation:** fix the rail (§7) **first**, as its own small PR — it gates 2b as
much as 2a. *(Done — PR #176.)*

</details>

---

## 9. Review record

- **R1 (Opus) — REVISE, 4 CRIT.** Killed v1. Its structural advice ("take A4, the fact-column") was
  right, though not for its stated reason (a sounder *trigger*): the fact-column is right because it
  moves the *judgment* to the only instance entitled to make it.
- **R2 (Opus) — REJECT, 4 CRIT + 3 MAJOR.** Killed v2 and proposed the fact/judgment split.
- **R3 (Opus) — REJECT, 2 CRIT + 4 MAJOR.** Killed v3's *mechanisms* while **confirming its spine**
  under direct attack (portable instance ids; host protection; per-advertiser trigger; the schema
  bump is load-bearing, not theater). Found the lamport-tie divergence, the negative-`partial`
  regression, the unreachable F6 clause, the **init-db rail hazard (§7)**, the un-measured MPA DB,
  and that `getBotDirectory` prunes as a side effect of an *add*.

- **R4 (the build's own two-instance durability suite) — v4's convergence proof FALSE, 1 CRIT.**
  Killed v4's *tombstone semantics* (not its spine). **No review round caught this** — three
  adversarial Opus rounds read the proof and accepted it. Only executable, two-instance,
  *mutual-prune* code found it. See the 🔴 R4 block at the top of this document.

Every CRITICAL from every round was **independently re-verified by the authoring session against the
code and the live DBs before folding** — the reviewers are not trusted either. Three separate times a
reviewer caught §0 measuring the wrong table; that is the Item-1 lesson (*compute host-state rules
against the real host*) refusing to be learned cheaply.

**And the R4 lesson, which is sharper:** three rounds of adversarial *prose* review signed off on a
convergence proof that a *test* demolished in one run. Prose review is necessary here and it is not
sufficient. For any distributed-state change, the acceptance gate must be **executable and
multi-instance** — and it must exercise the *mutual* case, because the single-actor case is exactly
where these bugs hide (the unit test that names the property stayed green under the mutation that
breaks it).
