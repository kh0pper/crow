# W2-5 Stage A — Project-spaces coherence (slug parity, shared create helper, trigger robustness)

**Date:** 2026-06-11
**Finding:** W2-5 in [`2026-06-10-overhaul-findings.md`](./2026-06-10-overhaul-findings.md), **re-scoped after the 2026-06-11 writer/reader inventory**: legacy readers (research server tools, projects panel, context) still read `research_projects`, so migrating writers now would require reverse-sync triggers — more fragmentation, not less. Stage A instead makes `project_spaces` internally coherent; **Stage B (per-component reader+writer migration, then trigger/table retirement) moves to Wave 4**, where each component is being opened anyway.

Pre-work done: fresh snapshots of both DBs at `~/crow-overhaul-backups/2026-06-11-w25/`; live counts rp=ps on both instances (7/7, 3/3 — triggers healthy).

## Problems being fixed (all verified against the live tree)

1. **Slug divergence:** the `tr_rp_to_ps_ins` trigger builds slugs with a 5-character SQL replace-chain (`init-db.js:371`) while JS uses NFKD+diacritic-strip (`servers/shared/slugify.js:19-33`). "Café Münze" → SQL `café-münze-7` vs JS `cafe-munze-7`. Latent (no slug-keyed lookups break today) but it poisons future slug-keyed features and share URLs.
2. **No shared create helper:** `bot-board-api.js:490-495` and `sharing/server.js:1253` each hand-roll `INSERT INTO project_spaces` + slug + `workspace_dir` computation (bot-board doesn't even use `slugify.js`). Two sources of drift.
3. **Trigger abort risk (corrected by plan review):** trigger bodies are statement-ATOMIC in SQLite, so partial mirroring can't happen. The REAL latent failure: the spaces insert's `ON CONFLICT(id) DO NOTHING` doesn't cover slug/uuid UNIQUE conflicts — such a conflict raises and **aborts the legacy writer's INSERT entirely**. Robustness = handle that abort case (and rely on init-db's `migrateLegacyProjectsToSpaces` backstop, which self-heals missing mirrors); `INSERT OR IGNORE` on the members statement is cheap insurance only (the WHERE NOT EXISTS guard already mirrors the partial unique index).
4. **Trigger-created rows are second-class:** `workspace_dir`/`storage_prefix` stay NULL for legacy-path projects (acceptable for Stage A — they're filled on first real use — but the slug must at least be canonical).

## Design

### 1. `servers/shared/project-spaces.js` (new, ~90 LOC)

```js
createProjectSpace(db, { name, description, type, status, tags, ownerContactId, originInstanceId, slugBase })
```
- **Two slug modes (required by plan review — the existing shapes differ):** (a) default `<slugify(name)>-<id>` — the id isn't known pre-insert, so the helper inserts then sets `slug = ?||'-'||id` + workspace_dir **inside one `db.batch()`** (a real transaction per `servers/db.js:247-254`; eliminates bot-board's observable `name-<Date.now()>` temp-slug hack); (b) `explicitSlug` mode for sharing's `-clone-N` counter shape — the caller passes the final slug it computed (preserving the load-bearing path-containment assertion at `sharing/server.js:1240-1246`, which stays in the caller).
- Computes `workspace_dir` via `workspacePathFor(dataDir, slug)` and `storage_prefix` via `storagePrefixFor(slug)` (both already exported by `slugify.js`).
- Inserts the `project_spaces` row + the owner `project_members` row in one transaction (or sequential with cleanup-on-failure — match the DB client's transaction capability; read how other code does multi-statement atomicity with this client).
- `updateProjectSpaceMeta(db, id, {name?, description?, status?, tags?})` for the bot-board update path (does NOT re-slug — slug is stable after creation).

Migrate the two hand-rolled writers onto the helper. Same response shapes and slug outcomes for ASCII names, with **two deliberate behavior changes at bot-board** (claimed, not accidental): (1) a created space now gets an owner `project_members` row (it got none before); (2) `workspace_dir` is computed via `workspacePathFor(resolveDataDir(), slug)` instead of the **hardcoded `/home/kh0pp/.crow-mpa/...`** — fixing a live bug where the primary instance's bot board wrote `.crow-mpa` paths (cf. `pi-bots-no-mpa-coupling.test.js` precedent).

### 2. Canonical-slug normalization pass (idempotent, in init-db)

After the triggers section in `scripts/init-db.js`: for every `project_spaces` row where `workspace_dir IS NULL` (i.e. trigger-created, no filesystem coupling) and `slug != canonical(name, id)`, update the slug to canonical. Implemented in JS (init-db already runs JS migrations). Idempotent; runs on every `npm run init-db`. Rows WITH a workspace_dir keep their slug (filesystem coupling wins). **Documented semantics:** for workspace-less rows the slug intentionally FOLLOWS the current name (a renamed legacy project re-slugs on next init-db — the "slug stable after creation" rule applies only to helper-created spaces with a workspace_dir). Verified no-op on all 10 live rows (7 `bluebird-N` already canonical; 3 mpa rows all have workspace_dir).

### 3. Trigger slug + robustness fix (DROP + CREATE, idempotent DDL)

- Recreate `tr_rp_to_ps_ins`: slug expression unchanged in shape (the normalization pass (#2) guarantees eventual canonical form; the trigger only needs uniqueness via `... || '-' || NEW.id` — document this contract in the trigger comment). Spaces insert becomes `INSERT OR IGNORE` so a slug/uuid UNIQUE conflict can no longer abort the legacy writer's INSERT (trade-off: a silently skipped mirror, self-healed by the init-db backstop — documented). Members insert gains `OR IGNORE` as insurance.
- **The DROP + CREATE TRIGGER DDL must be wrapped in an explicit `BEGIN IMMEDIATE; … COMMIT;`** inside the exec string (new pattern — `initTable`'s executeMultiple autocommits per statement, and gateways are still running during the deploy's init-db; busy_timeout 30s already set).
- `tr_rp_to_ps_del`: also archive (not delete) the `project_members` rows? NO — out of scope; members of an archived space are harmless and Stage B owns lifecycle. Note it.

### 4. Out of scope (Stage B / Wave 4)

Migrating the 12 production `research_projects` writers and their readers; retiring the triggers and the legacy table; filling `workspace_dir` for legacy rows; `tasks_db_uri` (nobody writes it; bot-board owns that concept).

## Fleet/deploy

Schema: no new tables/columns; trigger recreation is idempotent DDL; the normalization pass is idempotent JS. Deploy = pull + `npm run init-db` + restart on each host (same as the fediverse merge).

## Testing

- `tests/project-spaces-helper.test.js`: createProjectSpace on a temp DB (init-db'd) → row + member row + canonical slug + workspace_dir/storage_prefix populated; ensureUniqueSlug branch; updateProjectSpaceMeta.
- `tests/project-slug-normalization.test.js`: insert a legacy-style row via `INSERT INTO research_projects` (fires trigger) with an accented name on a temp DB → run the normalization fn → slug becomes canonical; second run is a no-op; a row WITH workspace_dir is untouched.
- **NEW `tests/project-clone-apply.test.js`** (plan review: no clone tests exist today and the clone path is the riskiest migration): build a minimal clone-bundle object and run `applyProjectCloneBundle` (or its testable core) against a temp DB — slug `-clone-N` shape preserved, path containment enforced, member rows created.
- Existing suite stays green.
- Live verification post-deploy: `sqlite3` check that the 10 live rows' slugs are canonical (or already were), counts unchanged, dashboards render.
