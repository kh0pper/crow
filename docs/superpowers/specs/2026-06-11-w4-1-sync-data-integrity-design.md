# W4-1 — Instance-sync data integrity (atomic Lamport, durable checkpoints, conflict surfacing)

**Date:** 2026-06-11
**Finding:** W4-1 in [`2026-06-10-overhaul-findings.md`](./2026-06-10-overhaul-findings.md) — the only finding flagged as violating the vision's one absolute ("user data is substrate — zero loss, ever"). Last-write-wins silently drops user edits into a `sync_conflicts` table nobody reads; the Lamport counter is non-atomic; the per-peer checkpoint is written only after the whole batch.

Pre-work done: fresh snapshots of both DBs at `~/crow-overhaul-backups/2026-06-11-w4/` (crow.db 2.1 MB, crow-mpa.db 109 MB).

**Target file:** `servers/sharing/instance-sync.js` (816 LOC). All line anchors below verified against the live tree at `main` `cb3b082` (re-verified by both review rounds); they may drift a few lines — verify shape, not offsets.

## Defects (all verified against the live tree)

1. **D1 — Non-atomic Lamport counter** (`_ensureCounter` :134-157, `_nextLamport` :163-173, `_advanceCounter` :179-188). Three races on the in-memory `_localCounter`:
   - Two concurrent first-calls both run `_ensureCounter`'s load (the `_counterLoaded` flag is set only at the end); the second load's `this._localCounter = rows[0].local_counter` can clobber an increment that interleaved between them → **duplicate timestamps**.
   - `_advanceCounter` is read-check-write across an `await`; a concurrent `_nextLamport` increment between the read and the write is lost.
   - `_nextLamport` increments in memory, then awaits the persist `UPDATE`. Crash (or two in-flight UPDATEs landing out of order) → restart reloads a lower counter → **timestamps reused**, which corrupts LWW ordering on peers.
2. **D2 — Checkpoint written after the loop** (`_processNewEntries` :480-495). Crash mid-batch → the whole batch re-applies on restart. Re-application is *mostly* idempotent (`INSERT OR IGNORE`, same-data updates) but every re-applied update with `incomingTs <= localTs` takes the conflict path → **spurious `sync_conflicts` rows**, and once conflicts are surfaced (D5) those become false alarms to the operator.
3. **D3 — Checkpoint blob read-modify-write race** (`_setLastAppliedSeq` :757-778). `last_applied_seq_per_peer` is one JSON blob for ALL peers, updated via SELECT-then-UPDATE. Two peers checkpointing concurrently lose one of the two writes → that peer's batch re-applies next session (same blast as D2).
4. **D4 — No per-peer processing serialization** (`inFeed.on("append")` :249-251; eager catch-up :292-297). Hypercore fires `append` per replicated block; each handler runs a full `_processNewEntries` from the same `lastSeq`. Overlapping runs double-apply entries and interleave checkpoint writes. The same overlap exists between the eager catch-up and a live `append`.
5. **D5 — Conflicts are silent, and the log conflates real conflicts with noise** (`_checkConflict` :631-670).
   - Real concurrent-edit conflicts are INSERTed into `sync_conflicts` and never seen again — no notification, no UI, no MCP-driven review in practice (the `crow_list_sync_conflicts` tool at `servers/sharing/server.js:2474` exists but nothing prompts anyone to call it).
   - Noise: equal-`lamport_ts`-equal-data re-deliveries and stale re-orderings from the *same author instance* are logged as "conflicts" even though LWW is unambiguously correct there. With D2's fix (re-processing windows) this noise would grow.
6. **D6 — Deletes bypass conflict detection entirely** (`_applyEntry` :542-544 gates `_checkConflict` on `op === "update"`; `_applyDelete` :726-733 deletes unconditionally). A stale remote delete (lower `lamport_ts` than the local row's) **destroys a newer local edit with no trace** — the most direct "user data is absolute" violation in the file.

7. **D7 — Insert id-collisions are silently dropped, then cause cross-row clobbering** (found by plan review). Both instances allocate AUTOINCREMENT ids from 1; `_applyInsert` is `INSERT OR IGNORE` (:691), so a colliding remote insert vanishes with no trace — and the peer's *subsequent updates* for its row N then conflict-check against an unrelated local row N and, when the peer's ts is higher, **overwrite the unrelated local row**. Minimal in-scope fix: detect-and-surface (below). The structural fix (uuid/origin-scoped identity for synced tables, cf. the research-tables migration `init-db.js:180-196`) is a named follow-up, not this slice — and it MUST land before anyone wires outbound emitters for the currently-emitterless synced tables (`contacts`, `messages`, `shared_items`, `relay_config` have no `emitChange` callers today; only memories/crow_context/providers/orchestrator_role_overrides/dashboard_settings emit).

Non-goals (explicitly out of scope): sparse-feed `feed.get` semantics, signature/identity model (`:516-518` note), the `shouldSyncRow` allowlist, Hypercore feed lifecycle/FD caps (that's W4-4), any change to what tables sync, multi-writer CRDT semantics (LWW stays; we make it honest and recoverable), the uuid identity migration for D7 (follow-up), and the **`crow_context` update/delete replication dead-zone** (live bug confirmed during review: `memory/server.js:983/:1107` emit without `id`, and `_applyUpdate`/`_applyDelete` early-return on `row.id === undefined`, so context updates/deletes never replicate — needs its own composite-key apply design mirroring `_applyDashboardSetting`; spun out as **W4-1b**, executed immediately after this slice).

## Design

### 1. Atomic Lamport counter (D1)

Drop the in-memory counter as the authority; the DB row IS the counter. Keep `_ensureCounter` only as an idempotent seeder (`INSERT OR IGNORE ... VALUES (?, 0)` — atomic, safe to race; keep the `_counterSeeded` fast-path flag).

```js
// _nextLamport
const { rows } = await this.db.execute({
  sql: `UPDATE sync_state SET local_counter = local_counter + 1, updated_at = datetime('now')
        WHERE instance_id = ? RETURNING local_counter`,
  args: [this.localInstanceId],
});
return Number(rows[0].local_counter);

// _advanceCounter(incomingTs)
await this.db.execute({
  sql: `UPDATE sync_state SET local_counter = MAX(local_counter, CAST(? AS INTEGER) + 1), updated_at = datetime('now')
        WHERE instance_id = ?`,
  args: [Number(incomingTs) || 0, this.localInstanceId],
});
```

Verified through `servers/db.js`'s better-sqlite3 wrapper: `UPDATE ... RETURNING` has `stmt.reader === true` so `executeOne` routes it through `.all()` and returns rows (`db.js:165-184`). better-sqlite3 is synchronous, so each statement is atomic with respect to all JS interleavings — no transaction needed.

**Seeding is required by ALL THREE `sync_state` writers** (plan-review C6): `_nextLamport`, `_advanceCounter`, AND `_setLastAppliedSeq` each call `_ensureCounter()` (the cheap flag-guarded idempotent seeder) before their UPDATE — otherwise a fresh receive-only instance whose row was never seeded silently no-ops its counter advances (later emitting Lamport timestamps *below* already-seen remote ones → silent LWW losses on peers) and never persists checkpoints (full re-apply every boot). Belt-and-braces: if `_nextLamport`'s `RETURNING` yields no row, seed and retry once.

The `this._localCounter` field is removed (or kept solely as a debug mirror, never read for decisions). `getSyncStatus` doesn't use it; nothing else reads it (verified: only uses are inside the three methods above).

### 2. Durable, atomic per-entry checkpointing (D2 + D3)

`_setLastAppliedSeq` becomes a single atomic statement (fixes D3):

```js
await this.db.execute({
  sql: `UPDATE sync_state
        SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer, '{}'), ?, CAST(? AS INTEGER)),
            updated_at = datetime('now')
        WHERE instance_id = ?`,
  args: [`$."${remoteInstanceId}"`, seq, this.localInstanceId],
});
```

(`json_set` accepts the path as a bound parameter; verified against the live better-sqlite3. Instance ids are UUIDs — no `"` or `\` to escape — but defensively reject/skip ids containing `"` since they'd corrupt the JSON path.)

`_processNewEntries` checkpoints **after every attempted entry** (`seq + 1`, preserving the "next unprocessed seq" semantics — the checkpoint advances past failed entries too, by design; keep it OUTSIDE the try):

```js
for (let seq = lastSeq; seq < feed.length; seq++) {
  try {
    const entry = await feed.get(seq);
    await this._applyEntry(remoteInstanceId, entry);
  } catch (err) { console.warn(...); }            // skip-and-continue stays (see below)
  await this._setLastAppliedSeq(remoteInstanceId, seq + 1);
}
```

The trailing whole-batch checkpoint is removed. **Failed-entry semantics deliberately unchanged** (skip, log, advance): halting on a poison entry would freeze the peer's entire feed — a worse integrity outcome than skipping one entry. Documented in a comment.

Cost note: one extra UPDATE per entry. Sync batches are small (human-scale edits); this is not a hot path. No batching tier unless review demands one.

### 3. Per-peer processing lock (D4)

Same promise-chain pattern as `_initLocks` (:211-225): a `_processLocks` Map keyed by `remoteInstanceId`. `_processNewEntries` becomes the public wrapper that chains onto the prior run's promise (`.catch(() => {})` so a failed run doesn't block) and calls `_processNewEntriesInner`. Re-reading `lastSeq` happens INSIDE the inner run (after acquiring the chain), so a queued run naturally no-ops the range the prior run already covered. Same Map-cleanup discipline as `_initLocks` (delete when still the tail).

### 4. Honest conflict detection (D5 detection + D6)

`_checkConflict` (:631-670) is reworked:

- `incomingTs > localTs` → `"apply"` (unchanged).
- Otherwise, before logging:
  - **Equivalence check:** if the incoming row's values match the local row on every key present in the incoming row (per key: both `null`/`undefined` → equal; exactly one nullish → NOT equal — never alias `null` with `""`; otherwise `String(a) === String(b)`; ignore `lamport_ts`/`instance_id`) → `"skip"` silently. This kills re-delivery noise (re-applied entries after a checkpoint gap are byte-identical). **Transform-aware** (plan-review S1): the local row is passed through the table's `OUTBOUND_TRANSFORMS` entry (e.g. `research_notes.project_id` → null, :64-66) before comparing, so a locally-assigned transformed column never manufactures a false conflict.
  - Otherwise → log to `sync_conflicts` (now with `op`), **fire the operator notification (§5)**, return `"skip"`.
  - **NO same-author heuristic** (plan-review C4): `instance_id` on rows is the ORIGIN instance, not the last editor (`_applyInsert` stamps it at creation, :679-683; local edits never update it — `memory/server.js:624-640`), so "incoming author == local instance_id" does NOT mean "stale self re-order" — it would silently drop a real concurrent edit of a row both sides received from the same origin. Every non-equivalent stale arrival logs a conflict. Period. **Consciously accepted noise case:** two rapid local edits to the same row can append out of ts-order (the `_nextLamport` → `feed.append` window), so a peer may log a conflict for the older self-edit. Log-and-preserve is the right failure direction (the alternative is a silent-drop heuristic), and the notification dedupe caps the cost at one standing bell item.
- **Deletes route through conflict detection** (fixes D6): in `_applyEntry`, the `op === "update"` gate becomes `(op === "update" || op === "delete") && row.id !== undefined`. For deletes: no local row → `"apply"` (no-op delete); local row with `localTs >= incomingTs` → log conflict with `op = 'delete'` (losing_data = the delete entry's `{ id }` row, winning_data = the local row) and `"skip"`; local row older → `"apply"`. The equivalence check does not apply to deletes (a delete vs a live row is never equivalent).
- **Insert collisions surfaced** (fixes D7, minimal form): in `_applyInsert`, when `INSERT OR IGNORE` reports `rowsAffected === 0`, fetch the local row at `row.id` (**guard first: `row.id == null` → straight to the warn-log branch** — binding `undefined` throws in better-sqlite3 and would land in `_applyEntry`'s generic catch as a confusing error):
  - **No local row at that id** (round-2 review C1): the ignore came from a *secondary* UNIQUE constraint (`contacts.crow_id`, `messages.nostr_event_id`, `relay_config.relay_url`, `research_notes.uuid` — all in SYNCED_TABLES) or a NOT NULL/CHECK violation that OR IGNORE swallows — NOT an id collision. Warn-log with table+id and do NOT create a conflict row or notification (a garbage conflict here would be noise; the dual-path `messages` Nostr+sync delivery is the live example).
  - **Local row exists and is equivalent** → benign re-delivery, done.
  - **Local row exists and differs → log a conflict with `op = 'insert'`** (winning = local row, losing = incoming row) + notification. This makes the id-collision clobber-precursor visible instead of silent. (The incoming insert is still not applied — same behavior as today, now with a trace.)
  - The equivalence check here and in `_checkConflict` MUST be one shared helper (one function, two call sites) so the two checks can't drift.
- Error path unchanged: on exception, warn + `"apply"` (availability over strictness, as today).

**Schema (additive):** `sync_conflicts` gains `op TEXT DEFAULT 'update'` via `addColumnIfMissing` in `scripts/init-db.js`, placed AFTER the `sync_conflicts` CREATE block (:1305-1323) to respect fresh-DB ordering (cf. the known init-db ordering-warning class in the handoff carry-forwards).

### 5. Operator notification (D5 surfacing, part 1)

On each *logged* (real) conflict, call `createNotification` (`servers/shared/notifications.js:28`) with:
- `type: "system"`, `source: "instance-sync"`, `priority: "high"`,
- `title`/`body`: plain language ("A sync conflict was recorded — one version of an item was kept, the other saved for review"), count-aware,
- `action_url: "/dashboard/settings?section=sync-conflicts"` (kebab-case — section lookup is exact-match on the section `id`, `panels/settings.js:114-122`; camelCase silently redirects to the menu).

**Dedupe (no notification storms):** check-then-insert is TOCTOU-racy across peers (per-peer locks don't serialize across different peers), so the existence check is a `SELECT` for an unread+undismissed `source = 'instance-sync'` notification followed by `createNotification` only when absent — and a duplicate slipping through the race window is acceptable (harmless; plan-review S3 noted `WHERE NOT EXISTS` can't be pushed into `createNotification` without changing its API — keep the helper untouched, tolerate the rare dupe). `createNotification` may also return `null` (type filtered by prefs) — fine, ignore the return. Notification failure is non-fatal (wrap in try/catch — the conflict row is already safely logged). Import `createNotification` lazily (dynamic `import()`) to match the file's existing pattern for cross-server imports (:88, :569) and avoid loading gateway push modules in non-gateway contexts.

### 6. Recovery UI (D5 surfacing, part 2)

**New settings section** `servers/gateway/dashboard/settings/sections/sync-conflicts.js`, `id: "sync-conflicts"` (kebab-case per convention, cf. `paired-instances.js:18`), registered in the `multiInstance` group next to `paired-instances.js` (follow its registration/rendering pattern exactly — table + status badges + actions; it's the established template). Server-rendered list of conflicts (unresolved first, resolved collapsed/secondary), each row showing: table, row id, when, winning vs losing instance (short ids), op, and an expandable side-by-side of `winning_data` / `losing_data` (pretty-printed JSON, HTML-escaped, in `<details>`). **Label the losing side "fields in the other version"** (plan-review S5): `losing_data` for updates is the *partial* incoming row (only the keys the entry carried), and the UI must not imply absent fields were deleted.

**Actions use the settings-section `handleAction` POST dispatch** (plan-review C5 — this is what actually gets auth + CSRF for free): form POSTs to `/dashboard/settings` with the `_csrf` hidden field, dispatched via the section's `handleAction` (`panels/settings.js:107-111`, `registry.js:75-80`), exactly as `paired-instances.js:108-117` does. **No new `/api` route file** — `routes/notifications.js` is NOT a CSRF-protected template (it has no CSRF and no `jsonError`; `csrfMiddleware` is mounted only on `/dashboard`, `dashboard/index.js:613`). These actions stay private under the default-deny middleware; no change to the funnel allowlist.

Actions:
- **Keep current version** → `UPDATE sync_conflicts SET resolved = 1, resolved_at = datetime('now') WHERE id = ?`.
- **Restore other version** → recover the losing data as a NEW local edit. **NEVER `INSERT OR REPLACE`** (plan-review C1/C2/C3 — REPLACE's implicit delete (a) corrupts the external-content `memories_fts` index because `recursive_triggers` is OFF so the delete-triggers don't fire, verified empirically; (b) cascade-deletes FK children — `foreign_keys` is ON by default in better-sqlite3, and `messages`/`shared_items`/`memory_embeddings_blob` CASCADE off synced parents; (c) with partial `losing_data`, would null every column the entry didn't carry). Instead, mirror `_applyUpdate`'s semantics:
  1. **Stale-snapshot guard (round-3 review C1 — applies to EVERY destructive restore, update and delete alike):** `winning_data` was snapshotted at conflict-logging time, and the conflict may sit unresolved for days while the live row keeps changing (note: local edits to most synced tables never bump `lamport_ts`, so only a content comparison is robust). Before applying anything, **re-read the live row and compare it to the stored `winning_data`** (same equivalence helper). The guard compares the two raw local snapshots directly — do NOT apply `OUTBOUND_TRANSFORMS` here (transforms are wire-form preprocessing for the conflict-detection call sites; applying one here would make a `research_notes` row with a set `project_id` falsely trip the guard forever). If they differ (including row-now-gone when the snapshot had one): do NOT apply — re-snapshot `winning_data` to the current live row (`null` when the row is gone), and redisplay with a plain-language notice ("this item has changed since the conflict was recorded — please review the current version and confirm again"). The operator's next confirm acts on what they actually saw. (The remaining same-request TOCTOU window is single-threaded better-sqlite3 within one handler — negligible; noted, not guarded.)
  2. Parse `losing_data`; intersect its keys with the live table's columns (`PRAGMA table_info`), excluding `lamport_ts`. Validate the table name against `SYNCED_TABLES` (export the const from instance-sync.js) before any SQL interpolation; column names must come from the PRAGMA intersection only (never raw JSON keys).
  3. If the row exists → `UPDATE` only the present keys, **excluding `id` from the SET list** (mirroring `_applyUpdate`'s `if (key === "id") continue`, :706; fires the FTS5 `memories_au` trigger correctly, touches no absent columns, no FK churn). If the row is gone → plain `INSERT` of the present keys.
  4. **The ENTIRE restore application is wrapped in one catch — both branches** (round-2 review C2 + round-3 review C2): `losing_data` values were never validated locally, so the UPDATE branch can hit CHECK/secondary-UNIQUE/FK violations just like the INSERT branch can hit NOT NULL (partial `losing_data` + row since deleted). Single statement either way, so nothing partial lands — on failure, surface a plain-language error in the section ("this version can't be restored automatically; its data remains visible below") and leave the conflict **unresolved**. An uncaught throw would 500 out of `dispatchAction` (no catch in `registry.js:75-80`).
  5. Call `getInstanceSyncManager()?.emitChange(table, op', row)` (`servers/sharing/server.js:96`) so the restoration propagates to peers with a fresh Lamport ts — **`op'` is `"update"` when the restore UPDATEd, `"insert"` when it re-INSERTed a since-deleted row** (round-3 Q1: emitting "update" for a re-insert would silently no-op on peers that also lack the row — `_applyUpdate` matches 0 rows without error — and the restoration would never propagate). Null manager (sharing not initialized) → still restore locally, note in response.
  6. Mark the conflict resolved.
  - For `op = 'delete'` conflicts, "restore other version" means applying the delete (the losing side was a delete): the stale-snapshot guard (step 1) is MANDATORY here — this is the one deliberately destructive action in the feature — then `DELETE` the row + `emitChange(table, "delete", { id })`.
  - For `op = 'insert'` conflicts (D7 collisions), "restore other version" is **disabled** with an explanatory note — the colliding incoming row CANNOT safely overwrite the unrelated local row that owns that id; the operator's recourse is manual (the data is visible in the JSON view). Resolve-only.
- **Resolve all** (bulk mark-resolved, with confirm).

**i18n:** all user-facing strings via `t()` with EN+ES keys added to `servers/gateway/dashboard/shared/i18n.js` — section label as `settings.section.syncConflicts` (the `settings.section.*` convention uses camelCase suffixes, cf. `settings.section.pairedInstances` — the *section id* stays kebab `sync-conflicts`; the two are different namespaces), body strings under `syncConflicts.*`. Plain-language first (vision §4.1 layered disclosure): the headline copy explains in human terms; the JSON diff is the opt-in layer down.

**Health signal:** add an unresolved-conflicts signal to the Nest health strip (`servers/gateway/dashboard/panels/nest/health-signals.js`, pattern at :64-82): warn state when `COUNT(*) FROM sync_conflicts WHERE resolved = 0` > 0, `actionHref: "/dashboard/settings?section=sync-conflicts"`. **Also fix the latent bug at `health-signals.js:198`** while there: `section=pairedInstances` → `section=paired-instances` (same exact-match lookup failure this spec just avoided).

### 7. Tests (new `tests/instance-sync.test.js`, node:test, throwaway tmp-dir DB)

Construct `InstanceSyncManager` with a real `createDbClient` on a temp file whose schema comes from **running `scripts/init-db.js` against the tmp DB** (the `init-db-bot-tables.test.js` pattern — plan-review S2: hand-seeded schemas omit the FTS5 shadow tables, triggers, and FK graph, which is exactly what makes the C1/C2 failure modes invisible to tests), and **stub feeds** (plain objects `{ length, get(seq) }`) — no Hypercore, no network. Identity from `sign`/`verify` in `servers/sharing/identity.js` (or stub the verify path by constructing entries with the manager's own `emitChange`-shaped signing).

1. **Counter atomicity:** fire 50 concurrent `_nextLamport()` → 50 unique, strictly increasing values; persisted `local_counter` equals the max. Interleave `_advanceCounter(bigTs)` mid-flight → no lost update, all subsequent values > bigTs.
2. **Counter durability:** new manager instance on the same DB → next value continues from persisted max (no reuse).
3. **Per-entry checkpoint:** feed of 5 entries (seqs 0-4) where the apply at seq 2 throws once (stub) → checkpoint advances past each attempted entry; a "crash" (abort after processing seqs 0-1, new manager) resumes at seq 2, and seqs 0-1 are NOT re-applied (assert no spurious conflict rows, unchanged data).
4. **Checkpoint blob concurrency:** concurrent `_setLastAppliedSeq` for two different peers → both survive in the JSON.
5. **Per-peer serialization:** trigger `_processNewEntries` twice concurrently on the same feed → each entry applied exactly once (count via a wrapped apply spy or row state).
6. **Real conflict:** local row with higher `lamport_ts` + different data + different author → incoming update skipped, `sync_conflicts` row written with correct winner/loser, notification row created; second conflict → no second notification (dedupe).
7. **Noise suppression:** (a) equal-ts equal-data re-delivery → no conflict row; (b) transform-aware equivalence: a re-delivered `research_notes` row whose local copy has a locally-assigned `project_id` → no false conflict.
8. **Delete conflict:** stale delete vs newer local row → row survives, conflict logged with `op='delete'`; newer delete → row deleted.
9. **Insert collision (D7):** (a) remote insert colliding with a different local row at the same id → not applied, conflict logged with `op='insert'`; (b) colliding equivalent row → no conflict; (c) **no-row-at-id branch** (round-3 C3): remote `contacts` insert with a fresh id but duplicate `crow_id` → warn-log only, NO conflict row, NO notification, no throw; (d) insert entry with `row.id == null` → warn branch, no throw.
10. **Restore path (happy):** factor the restore logic into a small exported helper and test it directly → losing data re-applied via UPDATE-of-present-keys, absent columns untouched (assert `created_at`/`access_count` survive), conflict resolved, `emitChange("update", ...)` invoked (spy); row-since-gone variant → plain INSERT + `emitChange("insert", ...)`. **FTS integrity** (plan-review S2): after restoring a `memories` row, `INSERT INTO memories_fts(memories_fts, rank) VALUES('integrity-check', 1)` passes and a `MATCH` on the pre-restore content returns nothing. **FK survival**: restoring a `contacts` row leaves its `messages` children intact.
11. **Restore path (failure, round-3 C3):** partial `losing_data` (e.g. `{id, tags}`) + row since deleted → INSERT fails on `content NOT NULL` → plain-language error surfaced, conflict still `resolved = 0`, no partial write.
12. **Stale-snapshot guard (round-3 C1):** log a conflict, then edit the live row again; "restore other version" → NOT applied, `winning_data` re-snapshotted to the current row, notice returned; second confirm (snapshot now current) → applies. Delete-restore variant: stale snapshot blocks the DELETE.
13. **Delete-restore + insert-restore-disabled:** `op='delete'` conflict restore (with current snapshot) → row deleted + `emitChange("delete", ...)`; `op='insert'` conflict → restore action rejected/absent.

Suite invariant: `node --test tests/` stays green (432 baseline + new); `tests/auth-network.test.js` is not in scope (no boundary change) but runs as part of the suite anyway.

## Verification & deploy

- Full suite + new tests green.
- Disposable-instance boot check (`env -i ... node servers/gateway/index.js --no-auth` per ROE) — gateway boots clean, settings section renders, routes respond.
- `npm run init-db` on a COPY of the live DB → `op` column added, no warnings for this change.
- Loopback two-instance repro (disposable, per ROE): pair two throwaway instances on localhost ports, force a conflict (edit the same memory row on both with sync paused, then reconnect) → conflict logged once, notification fires, recovery view lists it, "restore other version" round-trips. This is the acceptance test for the finding.
- Fleet deploy per runbook (init-db needed: YES — additive column). Watch black-swan's 18s health lag; verify pi-bot units stay active after crow restarts.

## Risk notes for review

- `emitChange` is called by other servers (memory/context/sharing) — its signature and return value (`lamportTs`) must not change.
- `_setLastAppliedSeq`'s signature/semantics ("next unprocessed seq") must not change — `getSyncStatus` (:783-800) and `_getLastAppliedSeq` consume the same blob.
- The conflict-notification path runs inside `_applyEntry`'s flow — it must never throw into the apply loop (swallow + warn).
- `SYNCED_TABLES` export: additive; instance-sync.js stays the single source of truth for the allowlist.
- No change to entry wire format, signatures, or feed layout — old and new instances interoperate mid-fleet-rollout (mixed-version fleet is the normal deploy state).

## Review

**Round 1 (Plan subagent, adversarial, against live tree at `cb3b082`): REVISE → resolved.** D1–D4 race analysis and the SQL atomicity claims were verified correct (including empirically against better-sqlite3 12.9.0: `RETURNING` routes through `.all()`; `json_set` bound-path works and is byte-compatible with the old writer). Six critical fixes applied:

- **C1 (FTS corruption):** restore used `INSERT OR REPLACE`; REPLACE's implicit delete doesn't fire the external-content `memories_fts` delete-triggers (`recursive_triggers` OFF — reproduced: old content stayed MATCHable, index corrupted). → Restore is now UPDATE-of-present-keys-if-exists / plain INSERT-if-gone.
- **C2 (FK cascade wipe):** better-sqlite3 defaults `foreign_keys = ON`; REPLACE on `contacts` would cascade-delete all `messages`/`shared_items` for that contact. → Same fix as C1.
- **C3 (partial-row nulling):** `losing_data` is the *partial* incoming row; full-row REPLACE would null `created_at`/`access_count`/etc. → Same fix; UI labels the losing side as partial (S5).
- **C4 (same-author heuristic = new silent-loss path):** row `instance_id` is the ORIGIN instance, not last editor — the heuristic would silently drop real concurrent edits of rows both sides got from one origin, a regression vs today's log-and-preserve. → Heuristic REMOVED; only the equivalence check suppresses noise.
- **C5 (wrong security templates):** `routes/notifications.js` has no CSRF/jsonError (CSRF is mounted only on `/dashboard`); `section=syncConflicts` would never resolve (exact-match kebab-case ids). → Actions moved to the settings `handleAction` POST dispatch (auth+CSRF for free); section id `sync-conflicts`; also fix the same latent bug at `health-signals.js:198`.
- **C6 (unseeded sync_state no-ops):** the new single-statement UPDATEs silently no-op without the seed row; a fresh receive-only instance would never advance its counter (→ later LWW losses) nor persist checkpoints. → All three writers seed first.

Suggestions adopted: S1 transform-aware equivalence (OUTBOUND_TRANSFORMS), S2 tests run init-db on the tmp DB + FTS/FK assertions, S3 dedupe TOCTOU tolerated (documented), S4 `settings.section.*` labelKey, S5 partial-row UI labeling. Review questions resolved: Q1 (AUTOINCREMENT id collisions) → minimal detect-and-surface in scope as D7 (`op='insert'` conflicts, restore disabled), uuid migration named follow-up; Q2 (`crow_context` update/delete replication dead-zone) → confirmed live bug (`memory/server.js:983/:1107` emit without `id`), spun out as W4-1b immediately after this slice; Q3 (suite baseline) → verify at implementation time.

**Round 2 (focused re-review, same adversarial bar): REVISE → resolved.** All six round-1 resolutions verified correct against the live tree (UPDATE-of-present-keys fires `memories_au` safely even with absent `content` since `new.content = old.content`; settings dispatch mechanism accurate; seeding unambiguous; `rowsAffected` reliable through the wrapper; transform direction correct). Two new gaps fixed:
- **C1 (D7 no-row branch):** `rowsAffected === 0` with no local row at `row.id` = secondary-UNIQUE dedupe (`contacts.crow_id`, `messages.nostr_event_id`, `relay_config.relay_url`, `research_notes.uuid`) or an OR-IGNORE-swallowed NOT NULL/CHECK — not an id collision; as previously specced it would TypeError or log garbage. → Warn-log only; no conflict, no notification; equivalence logic mandated as ONE shared helper for both call sites.
- **C2 (restore-INSERT failure):** partial `losing_data` + row-since-deleted → plain INSERT can hit NOT NULL/CHECK/FK; unhandled it would 500 out of `handleAction` on the exact recovery path. → Catch, plain-language error, conflict stays unresolved.
Suggestions adopted: checkpoint "after every attempted entry" wording (advance stays outside the try), `settings.section.syncConflicts` camelCase labelKey (section id stays kebab), `id` excluded from restore UPDATE SET, anchor commit pinned to `cb3b082`. Questions resolved: self-reorder conflict noise consciously accepted (documented in §4); D7 follow-up note now requires the uuid migration before wiring emitters for the currently-emitterless synced tables.

**Round 3 (final adversarial pass): REVISE → resolved.** Both round-2 revisions verified mechanically sound; three new gaps fixed:
- **C1 (stale-snapshot restore = data-loss path):** `winning_data` is snapshotted at logging time; a conflict can sit for days while the live row changes (and most synced tables never bump `lamport_ts` on local edits, so ts comparison is useless). The delete-restore would have destroyed content newer than what the operator was shown, preserved nowhere. → Mandatory stale-snapshot guard before EVERY destructive restore: re-read live row, content-compare to snapshot; differ → re-snapshot + refuse + redisplay; confirm acts only on current data.
- **C2 (catch only on the INSERT branch):** the UPDATE branch can equally throw (CHECK/secondary-UNIQUE/FK — `losing_data` was never locally validated) and would 500 out of `dispatchAction`. → The entire restore application is one catch, both branches.
- **C3 (round-2 branches untested):** test list extended — tests 9c/9d (no-row-at-id, null-id guards), 11 (restore failure), 12 (stale-snapshot guard), 13 (delete-restore + insert-restore-disabled).
Suggestions adopted: `row.id == null` guard in D7 (S1), equivalence comparison pinned (null≡null only, never alias null/"" — S2), checkpoint-test indexing clarified (S3). Q1 resolved: restore emits `"insert"` when it re-INSERTed a since-deleted row (an `"update"` emit would silently no-op on peers also lacking the row).

**Round 4: APPROVE.** All round-3 resolutions verified incorporated; every new factual claim re-verified against the live tree (no `lamport_ts` writes in memory/server.js local-edit paths; `dispatchAction` has no catch; better-sqlite3 throws on `undefined` binds; `_applyUpdate` 0-row no-op). Two non-blocking clarifications folded in: the stale-snapshot guard compares raw local snapshots without transforms, and row-now-gone re-snapshots `winning_data` to `null`.
