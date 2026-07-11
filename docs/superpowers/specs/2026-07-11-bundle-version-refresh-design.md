# Bundle version-aware refresh + maker-lab revival — design (BH-4)

Date: 2026-07-11 · Operator directive: "do the bundle migrating; don't worry
about learner data in the backups."

## 1. Problem

`/dashboard/maker-lab` hard-500s on prod crow: `no such table:
research_projects`. Root cause is TWO layers:

1. **The bundle source was already fixed** — W2-5 (June) migrated
   `bundles/maker-lab/` in-repo to `project_spaces` (fe0fe925 et al.;
   sessions.js reads `FROM project_spaces`, init-tables.js carries the FK
   rebuild research_projects(id)→project_spaces(id); the only remaining
   `research_projects` strings are comments and the rebuild-detection probe
   at init-tables.js:124).
2. **Installed copies never receive repo updates (the PRODUCT bug).**
   Install copies the bundle to `~/.crow/bundles/<id>/` and the panel to
   `~/.crow/panels/<id>.js` + `<id>-routes.js` (bundles.js:1016,1175,1181).
   The only ongoing reconciliation, `repairInstalledBundleAssets()`
   (bundles.js:273, runs every boot), copies ONLY MISSING files
   (`!existsSync(dst)` guards at :302,:310,:318) — a stale-but-present file
   is never refreshed. crow's installed maker-lab is an April snapshot; the
   June migration never reached it, and the April `~/.crow/panels/maker-lab.js`
   is what 500s today. Every future first-party bundle change has the same
   fate. Compounding: W2-5 changed bundle code WITHOUT bumping the bundle
   version (repo manifest still 0.1.0 == installed 0.1.0), so even a
   version-keyed updater would not have fired.

Data disposition (operator-decided): NO recovery of learner data from June
backups. The `project_spaces` Bluebird×5 duplicate rows are left as-is (the
revived panel may list them; cosmetic; cleanup is the operator's later call
via the product UI).

## 2. Design

### D1 — Version-keyed refresh phase in `repairInstalledBundleAssets()`

For each installed first-party bundle (`APP_BUNDLES/<id>` exists), BEFORE the
existing missing-file repair:

- Read `version` from the repo manifest and the installed manifest. If both
  are readable and **differ** (string inequality — repo is the source of
  truth in either direction; installed copies are snapshots, not forks), do a
  refresh:
  - Copy the bundle's CODE artifacts from repo → `~/.crow/bundles/<id>/`,
    overwrite: `manifest.json`, `package.json`, `package-lock.json`,
    `settings-section.js`, and the `server/`, `panel/`, `skills/`,
    `curriculum/`, `public/`, `scripts/` dirs (each only if present in the
    repo bundle). EXPLICIT-INCLUDE list — never a blanket dir copy — so
    instance-local files (`.env`, `node_modules/`, `data/`, anything the repo
    doesn't ship) are structurally untouchable.
  - Re-copy the SERVED panel artifacts exactly as install does
    (bundles.js:1170-1184): `resolvePanelPath(manifest,id)` →
    `~/.crow/panels/<id>.js`, and `manifest.panelRoutes` →
    `~/.crow/panels/<id>-routes.js`.
  - If the repo `package.json` content differs from the previously-installed
    one (compare BEFORE overwriting), run `npm install --omit=dev` in the
    bundle dir (5-min timeout, warn-only on failure — same posture as
    auto-update's npm step). Deps-removed (maker-lab's actual case: repo
    dropped `@libsql/client`) needs no install — a superset node_modules is
    harmless — but content-difference is the honest general trigger.
  - Log one `[bundles] refreshed <id> <oldV> -> <newV>` line; include in the
    function's `repaired` return.
- Version equal or either manifest unreadable → existing missing-only repair
  behavior, unchanged.
- mcp-server bundles' running processes: the refresh happens at boot before
  MCP mounts spawn bundle servers, so the new server code is what starts.

### D2 — maker-lab version bump 0.1.0 → 0.1.1

`bundles/maker-lab/manifest.json` + the registry entry. Registry is
generated: run `node scripts/build-registry.mjs` and commit the regenerated
`registry/add-ons.json`. INSPECT the regen diff — if it also reconciles the
pre-existing rookery drift (the known failing bundle-contract test on main),
that is a separate concern: commit ONLY the maker-lab hunk (positional-path
staging can't split hunks — use `git add -p`-equivalent care or regenerate,
then `git checkout -p`-style restore of foreign hunks; simplest: if the regen
touches non-maker-lab entries, report and commit the full honest regen in its
OWN commit explaining why, since the generator is the source of truth).
Process discipline: whichever way, `git show --stat` + diff review before
push.

### D3 — Instance activation (deploy)

Deploy = normal fleet pull + restart. On crow's boot, D1 sees 0.1.1 ≠ 0.1.0 →
refreshes `~/.crow/bundles/maker-lab/` + `~/.crow/panels/maker-lab.js` +
`-routes.js`. The revived panel queries `project_spaces`; the bundle server's
init-tables FK rebuild runs on its next spawn. Other instances without
maker-lab installed are no-ops (`APP_BUNDLES` check + installed.json gate).

## 3. Non-goals

- No learner-data recovery (operator-decided). No project_spaces dedupe.
- No general add-on store update UX (Extensions overhaul theme owns that).
- No change to install/uninstall flows; refresh is boot-side only.
- No touching non-first-party bundles (no `APP_BUNDLES/<id>` → skip, as today).
- NO SCHEMA_GENERATION bump (maker-lab's own tables are bundle-managed via
  its init-tables.js; the crow schema is untouched).

## 4. Tests (TDD; mutation-test the guards)

Fixture: temp APP_BUNDLES-like dir + temp BUNDLES_DIR/PANELS_DIR via the
module's path seams (check how bundles.js resolves CROW_HOME/APP_BUNDLES —
env-keyed CROW_HOME? verify; if consts, add a test seam consistent with the
file's existing test hooks or use CROW_HOME env if respected).

1. Version differs → code files overwritten (a stale server/server.js gets
   the repo content), PANELS_DIR `<id>.js` + `<id>-routes.js` refreshed —
   **mutation**: removing the version-compare (always-equal) reddens.
2. Version equal → a deliberately-different installed file is NOT touched
   (missing-only behavior preserved) — **mutation**: unconditional refresh
   reddens this.
3. Instance-local preservation: `.env` + `data/marker.txt` + an extra
   node_modules file survive a refresh byte-identical — **mutation**:
   swapping explicit-include for a blanket dir copy reddens.
4. package.json changed → the npm step is invoked (injectable runner seam or
   recorded exec; NOT a real npm install in tests); unchanged → not invoked.
5. Unreadable/missing installed manifest → falls back to missing-only repair,
   no throw.
6. Full suite ≥ baseline; boot clean.

## 5. Verification beyond the suite

- Deploy to crow → boot log shows `refreshed maker-lab 0.1.0 -> 0.1.1`;
  `~/.crow/panels/maker-lab.js` contains `project_spaces` (not the April
  `research_projects` query); CDP: `/dashboard/maker-lab` renders 200 with
  the learner UI (BH-4's repro is the red case) — screenshot.
- `diff` of `.env`/instance files before/after refresh on crow: untouched.
- grackle/MPA/black-swan: no maker-lab installed → boot log shows no refresh
  line, no errors.

## 6. Risks / review focus

- Explicit-include list completeness vs the bundle contract (a first-party
  bundle shipping a top-level file outside the list would silently not
  refresh it — enumerate the contract's allowed artifacts and align).
- Boot-time npm install: bounded, warn-only, and only on package.json change
  — review the blast radius of a hung npm on gateway boot (timeout enforced
  by the runner; boot must not block indefinitely — run the refresh phase
  awaited but with the npm step's own timeout, matching auto-update's).
- The version-inequality trigger refreshes DOWNGRADES too (repo rollback →
  installed rolls back) — intended: repo is the source of truth.
- D2's registry regen may drag the rookery drift — handle per D2's process
  note, honestly and in its own commit if so.
