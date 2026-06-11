# W4-1b — crow_context update/delete replication dead-zone

**Date:** 2026-06-11
**Finding:** confirmed live bug during the W4-1 plan review (round 1, Q2): `crow_context` **updates and deletes never replicate** between paired instances. Spun out of [`2026-06-11-w4-1-sync-data-integrity-design.md`](./2026-06-11-w4-1-sync-data-integrity-design.md) as its own slice. Inserts DO replicate (via the generic `_applyInsert`).

Anchors verified at `main` `b843241`. Verify shape, not offsets.

## Defects (verified against the live tree)

1. **D1 — apply dead-zone.** `memory/server.js:983` (update) and `:1107` (delete) emit `crow_context` entries WITHOUT `id` — the table is keyed by the composite `(section_key, device_id, project_id)` with four NULL-aware partial unique indexes (`idx_crow_context_{global,device,project,device_project}`, `init-db.js:1084-1110`). But `_applyUpdate` (~:918) and `_applyDelete` (~:945) early-return on `row.id === undefined`, and `_applyEntry`'s conflict gate (~:621) also requires `row.id !== undefined`. Net: every MCP context edit/delete silently no-ops on the receiving instance.
2. **D2 — local rows never stamped.** `emitChange`'s local `lamport_ts` stamping (~:495-511) handles id-keyed rows and the `dashboard_settings` key special-case only — local `crow_context` edits (and inserts) leave their own row at `lamport_ts = 0`. Even with D1 fixed, a peer's STALE edit (any ts > 0) would then beat a NEWER local edit on arrival. Both halves must ship together.
3. **D3 — the update emit is incomplete (review round 1, C1).** `:983` emits only `{section_key, content, section_title, device_id, project_id}`; `enabled` and `sort_order` are accepted tool params (`:933-934`, written to the DB `:965-966`) but never emitted. An enabled-toggle edit would emit a row that (after `JSON.stringify` drops `undefined`) carries only the key fields — the receiver would bump `lamport_ts` and change nothing, and the divergence becomes permanently invisible to the equivalence check. `enabled=false` is the documented way to disable protected sections (`:1084`).
4. **D4 — dashboard skills panel bypasses sync entirely (review round 1, S1).** `servers/gateway/dashboard/panels/skills.js:109` (`save-writing-rules`) and `:129` (`save-context-section`) UPDATE `crow_context` directly with no `emitChange` — dashboard edits to `writing_style`/identity/etc. don't replicate AND leave `lamport_ts` stale, skewing later conflict accounting.

Non-goals: composite-key RESTORE in the recovery UI (refused with a note, like `op='insert'` — the losing data stays visible and `crow_update_context_section` is the manual recovery path); tombstones for deletes (see "resurrection trade-off" below); retrofitting the MAX-stamping onto other tables' branches.

## Design

Scope key throughout: `device_id ?? null`, `project_id ?? null`, matched with SQLite's NULL-aware `IS ?` binding (`WHERE section_key = ? AND device_id IS ? AND project_id IS ?`) — verified working through the better-sqlite3 wrapper, including the INTEGER `project_id`.

### 1. Senders emit the full post-update row (D3, D4)

**Wire row allowlist (everywhere a crow_context change is emitted):** `{section_key, section_title, content, sort_order, enabled, device_id, project_id}` — **never `id`** (it's an instance-local AUTOINCREMENT; an emitted `id` would make OLD receivers' `_applyUpdate` run `UPDATE … WHERE id = N` against an unrelated row — a mixed-version cross-row clobber), never `lamport_ts`/`updated_at`. `enabled` comes from the DB row (INTEGER 0/1 — never the zod boolean param; better-sqlite3 throws on boolean binds).

**Single-source the allowlist (round-2 review S4):** export `buildCrowContextWireRow(dbRow)` from `servers/sharing/instance-sync.js` (next to `SYNCED_TABLES`) — takes a re-selected DB row, returns the allowlisted wire object. All four emit sites use it; test 22 unit-tests it directly.

- `servers/memory/server.js` update path (~:983): **after the UPDATE (~:975-978), re-SELECT the row by the same WHERE clause and emit `buildCrowContextWireRow(<that result>)`.** The pre-update SELECT at ~:951-954 is an existence check only and **MUST NOT be the emit source** — emitting it would broadcast the OLD values under a fresh lamport_ts while §2 stamps the sender's row to the same ts: receiver applies stale content as newest, sender keeps new content at equal ts → silent divergence, undetectable afterward (round-2 review CR-1). Full-row emit also makes re-delivery equivalence checks strictly stronger and lets receivers materialize sections they're missing regardless of which field was edited.
- `servers/memory/server.js` insert path (~:1018): re-select after the INSERT and emit via the helper (currently omits `enabled`; the helper sources it from the row).
- Delete path (~:1107): unchanged (`{section_key, device_id, project_id}` is sufficient and correct).
- `servers/gateway/dashboard/panels/skills.js:109/:129` (both write GLOBAL rows — `device_id IS NULL AND project_id IS NULL`): after the UPDATE, re-select the row; **zero rows → skip the emit** (section absent; don't broadcast a junk entry); else `getInstanceSyncManager()?.emitChange("crow_context", "update", buildCrowContextWireRow(row))`, fire-and-forget with `.catch(() => {})` like the memory server. Null manager (sharing not initialized) → skip silently.

Mixed-version safety: old receivers no-op on these entries exactly as today (no `id`); new receivers apply. No init-db needed.

### 2. Stamp local rows on emit (D2)

In `emitChange`'s stamping block (~:495-511), add a branch **before the generic `row.id !== undefined` branch** (structural guard: even if a crow_context wire row ever carried an `id`, it must never reach the generic `UPDATE … WHERE id = N` stamp — that id is the sender-local AUTOINCREMENT; round-2 review S3):

```js
} else if (table === "crow_context" && row.section_key !== undefined) {
  await this.db.execute({
    sql: `UPDATE crow_context SET lamport_ts = MAX(COALESCE(lamport_ts, 0), ?)
          WHERE section_key = ? AND device_id IS ? AND project_id IS ?`,
    args: [lamportTs, row.section_key, row.device_id ?? null, row.project_id ?? null],
  });
}
```

`MAX(COALESCE(...))` (review S2): two interleaved emitChange calls or a concurrent peer apply can write out of order; the monotonic guard makes the stamp race-proof. (Plain `MAX(NULL, x)` is NULL in SQLite — the COALESCE is load-bearing.) Existing non-fatal catch semantics unchanged.

### 3. Composite-key apply path (D1)

In `_applyEntry`, immediately after the `dashboard_settings` special-case, route ALL `crow_context` ops (insert/update/delete — insert too, so a colliding insert gets LWW upsert instead of W4-1's D7 null-id warn dead-end) to a new `_applyCrowContext(op, row, lamportTs)`, wrapped in try/warn like the dashboard_settings case, then invalidate the context cache (move the existing `invalidateContextCache()` dynamic-import block, ~:646-651, into the special-case — note: that block IS currently reached by id-less entries falling through the no-op switch; after this change the special-case returns early, so the invalidation must move WITH it).

`_applyCrowContext` semantics (shape mirrors `_applyDashboardSetting`; conflict rules follow W4-1's `_checkConflict`, NOT `_applyDashboardSetting`'s tie-incoming-wins — **tie + different data = conflict, local kept**, stated explicitly because the two patterns disagree):

- Guard: `!row || row.section_key == null` → warn + return.
- Key-filter the incoming row: drop `id`, `lamport_ts`, `instance_id`, and any key not in the table's actual columns (PRAGMA `table_info` intersection, cached per-process — an unexpected wire key must not throw the whole apply into the warn-catch; review S4).
- Read local: `SELECT * FROM crow_context WHERE section_key = ? AND device_id IS ? AND project_id IS ?`. `localTs = localRow?.lamport_ts || 0`.
- **delete:** no local row → no-op. `incomingTs > localTs` → `DELETE` by composite key. Else → **conflict** (`op='delete'`) via `_insertConflictRow` + `_notifyConflict`, local kept.
- **insert/update:**
  - No local row → INSERT the filtered fields **plus `lamport_ts = incomingTs`** and `updated_at = datetime('now')` (review C2 — landing at the column default 0 would let a later STALE entry overwrite the just-applied one). NOT NULL columns (`section_title`, `content`) absent → warn + skip (can't materialize a half-row; with the full-row emit of §1 this only happens for old-sender partial entries).
  - Local row exists, `incomingTs > localTs` → UPDATE the filtered present keys + `lamport_ts = incomingTs` + `updated_at = datetime('now')`.
  - `incomingTs <= localTs`: `rowsEquivalent(localRow, filteredRow)` → equal: silent skip; differ: **conflict** (`op` = the entry's op) + notify, local kept.
- Conflict rows: `table_name = 'crow_context'`, `row_id` = compact JSON `{"section_key":…,"device_id":…,"project_id":…}` (readable; the section already escapes `row_id` via `escapeHtml`). `winning_data` = local row JSON, `losing_data` = incoming filtered row JSON.

**Resurrection trade-off (review C4, decided):** upsert-on-missing applies to `op='update'` too. A re-delivered pre-delete update (checkpoint loss, sync_state restored from backup) can therefore resurrect a deleted section on one side. There are no tombstones; the alternative (skip missing-row updates) silently loses legitimate catch-up edits for sections an instance never had. Under "user data is absolute," **resurrection-over-loss is the correct failure direction** — a resurrected section is visible and re-deletable; a dropped edit is gone. Documented here, covered by a test.

### 4. Recovery UI: restore refused for composite-key conflicts

`servers/sharing/sync-conflict-resolve.js`: the `table_name === "crow_context"` refusal goes **immediately after the `op === 'insert'` refusal (~:113-121), BEFORE the stale-snapshot guard** (review C3 — placed after the guard, the guard's id-keyed SELECT with a JSON `row_id` finds nothing, declares stale, and **overwrites `winning_data` with `'null'`**, destroying the recorded local snapshot). Return `{ status: "refused", message: <plain language> }`.
`sync-conflicts.js` section: disable the restore button for `table_name === 'crow_context'` rows with the existing disabled-note pattern; new i18n key `syncConflicts.compositeRestoreDisabled` (EN+ES). Widen the `row_id` column (70px → ~140px) in the same diff — the JSON composite key wraps hard otherwise (round-2 Q2).

### 5. Tests (extend `tests/instance-sync.test.js`, same harness)

15. **Update replicates:** full-row update entry for an existing global section applies (content + `enabled` + `sort_order` changed, `lamport_ts` stamped to incomingTs); a device-scoped row with the same `section_key` is untouched; a **project-scoped** variant applies via the INTEGER `IS ?` path (the fourth-index case).
16. **Delete replicates + delete conflict:** newer delete removes the row; stale delete vs newer-stamped local → row survives + `op='delete'` conflict logged.
17. **Stale update:** non-equivalent → conflict logged + local kept; equivalent re-delivery → silent skip, no conflict row. **Tie (incomingTs == localTs) + different data → conflict, local kept.**
18. **Emit stamps local row:** `emitChange("crow_context","update",…)` sets the composite-keyed row's `lamport_ts` (global AND device-scoped); stamping is monotonic (a second emit with a lower forced ts cannot lower it — exercise the MAX guard via direct UPDATE of sync_state or sequential emits).
19. **Upsert:** update entry for a section absent locally → row created with `lamport_ts = incomingTs` (assert the column, not just existence — C2); then a STALE follow-up entry → conflict/skip, NOT applied. Partial old-sender entry missing `content` for an absent section → skipped, no row, no throw. **Resurrection case:** delete locally, re-deliver the older update → row recreated (documents the C4 decision).
20. **Insert LWW routing:** insert entry colliding with an existing older row → applied as update (newer wins); colliding with a newer local row + different data → conflict, local kept.
21. **Restore refused:** crow_context conflict → `restoreConflict` returns refused AND `winning_data` is byte-identical to before the call (C3); `resolveConflict` still works.
22. **Sender emits — VALUES, not just shape (round-2 CR-1):** (a) unit test `buildCrowContextWireRow` directly (allowlist fields present, `id`/`lamport_ts`/`updated_at` absent, `enabled` integer); (b) through the memory server with an emitChange spy (`createMemoryServer(dbPath, { syncManager: spy })` + `InMemoryTransport.createLinkedPair()`, precedent in `tests/crow-remote-proxy.test.js`): call `crow_update_context_section` changing `content` AND `enabled`, assert the captured emit carries the **post-update values** (a pre-update-SELECT emit has identical shape and must fail this test). The helper unit test covers the skills.js sites' wire contract (they use the same helper).

## Verification & deploy

Suite green (baseline 461 + new). No wire-format BREAK (additive fields in the emitted row; no `id`); no schema change → per-host deploy = pull + restart gateways only (memory server runs inside the gateways). Boot check via disposable instance. Old receivers keep the dead-zone until updated (status quo).

## Risk notes

- `_applyCrowContext` must never throw into the apply loop (wrap like `_applyDashboardSetting`).
- The moved `invalidateContextCache()` must fire on every applied crow_context change.
- `emitChange` signature/return unchanged; `SYNCED_TABLES` unchanged.
- W4-1's D7 null-id warn branch becomes unreachable for crow_context (routed earlier) — fine; it still serves other tables.
- skills.js emits must not break when sharing isn't initialized (`getInstanceSyncManager()` null → skip silently).

## Review

**Round 1 (Plan subagent, adversarial, live tree b843241): REVISE → resolved.** Verification ledger confirmed D1/D2 anchors, the four partial indexes, `IS ?` through the wrapper (empirical), no `updated_at` false-conflict (emits never carry it), and the restore-refusal pattern. Four criticals fixed:
- **C1:** `enabled`/`sort_order` never emitted — "wire shape already correct" was false; an enabled-toggle would silently never replicate and become invisible to equivalence. → Full-row allowlisted emit (D3), including the skills-panel bypass (D4, promoted from S1).
- **C2:** upsert INSERT landing at `lamport_ts` default 0 would let a later stale entry overwrite it — the D2 failure mode reintroduced. → INSERT sets `lamport_ts = incomingTs` + `updated_at`; asserted by test 19.
- **C3:** restore-refusal placed after the stale guard would overwrite `winning_data` with `'null'` (id-keyed SELECT misses the JSON row_id). → Placement pinned before the guard; test 21 asserts `winning_data` untouched.
- **C4:** upsert-on-missing can resurrect deleted sections (no tombstones). → Decided: resurrection-over-loss, documented + tested (test 19).
Suggestions adopted: S2 MAX(COALESCE) monotonic stamping; S3 corrected the false "unreachable invalidateContextCache" justification (it IS reached today via fall-through; it must move because the new special-case returns early); S4 PRAGMA column intersection for incoming keys; S5 tests for enabled/sort_order round-trip, insert-LWW routing, upsert lamport assertion, project-scoped index path, winning_data-untouched, row_id shape. Questions resolved: Q1 → C4 decision above; Q2 → full-row emit makes partial-materialization moot (old-sender partials still warn+skip); Q3 → tie+differ = conflict (W4-1 standard, NOT `_applyDashboardSetting`'s tie-incoming-wins), stated in §3.

**Round 2 (focused re-pass, live tree): REVISE → resolved.** Resolution ledger confirmed all round-1 fixes incorporated and the C3 hazard re-verified live (`winning_data` would be overwritten with `'null'` if the refusal sat after the guard). One blocker fixed:
- **CR-1:** §1 falsely claimed "the handler already has the post-update row available" anchored at the PRE-update existence-check SELECT (`servers/memory/server.js:951-954`, which runs before the UPDATE at :975-978) — an implementer emitting that row would broadcast OLD values under a fresh ts while the stamp raises the sender's row to the same ts: silent, undetectable divergence. → §1 rewritten (post-UPDATE re-select MANDATORY, the pre-update SELECT explicitly forbidden as emit source); test 22 upgraded from shape-only to post-update VALUE assertions (a stale emit now fails it).
Suggestions adopted: skills.js zero-match → skip emit; insert path re-selects (helper sources `enabled` from the row); stamping branch ordered BEFORE the generic id branch (structural, not conventional); shared `buildCrowContextWireRow` helper exported from instance-sync.js (single-sources the allowlist across all four emit sites, unit-tested); path nit fixed. Questions: skills.js wire contract pinned via the shared-helper unit test; `row_id` column widened in the same diff.

**Round 3: APPROVE** — confirmed CR-1's resolution (post-UPDATE re-select unambiguous, test 22 value assertions), all round-2 suggestions incorporated, no new contradictions (verdict recorded after the round-3 pass below).
