# Bundle version-aware refresh + maker-lab revival — design (BH-4)

Date: 2026-07-11 · Operator directive: "do the bundle migrating; don't worry
about learner data in the backups."
Review: R1 (adversarial, opus) REVISE — 4 MAJOR (D2 inversion: full regen is
MANDATORY for a green suite, absorbing the rookery drift which R1 verified is
the ONLY other diff; async call-site integration at mcp-mounts.js:144;
npm-at-boot needless-trigger + listen-blocking; include-list doesn't
generalize to Python bundles) + 3 minors — ALL FOLDED. R1 also verified: boot
ordering HOLDS (refresh at index.js:490 precedes listen, panel load AND MCP
child spawn are post-listen); cpSync is additive (dest-only files survive);
crow's served panels are SYMLINKS into the bundle dir (legacy state) and
cpSync-over-symlink is safe on Node 20 but rmSync-first is specified for
determinism; on THIS deploy only maker-lab refreshes (every other installed
bundle is version-equal — verified against crow's installed.json).

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

- Read `version` from the repo manifest and the installed manifest. Compare
  as strings with **both-undefined treated as equal** (R1: crow's vllm/llama
  bundles carry no version — they must never churn). If both readable and
  they **differ** (either direction — repo is the source of truth; installed
  copies are snapshots, not forks), do a refresh:
  - Copy the bundle's CODE artifacts from repo → `~/.crow/bundles/<id>/`,
    overwrite. EXPLICIT-INCLUDE set, generalized per R1 MAJOR-4 so it covers
    JS AND Python first-party bundles: top-level files `manifest.json`,
    `package.json`, `package-lock.json`, `pyproject.toml`, `uv.lock`,
    `settings-section.js`, `main.py`, `run.sh`, `config.py`; dirs `server/`,
    `panel/`, `skills/`, `curriculum/`, `public/`, `scripts/`, `templates/`,
    `routes/`, `config/`, `src/` (each only if present in the repo bundle);
    PLUS any file/dir roots the manifest itself declares (`server.args[0]`'s
    first path segment, `panel`, `panelRoutes`, each `skills[]` entry) — the
    bundle contract is manifest-declaration-driven, so declared paths are
    always code. **Each manifest-declared root is validated to a single
    plain path segment (no `/`, not `.`/`..`) before any join (R2 minor —
    no existing guard confines these; F-HEALTH-1 already fixed a
    `bundleId: ".."` traversal in this file's neighborhood; same class).**
    **TYPE-AWARE restriction (R2 MAJOR-2):** for bundles whose manifest
    declares docker surfaces, the refresh set is ONLY `manifest.json`,
    `settings-section.js`, `server/`, `panel/`, `skills/` + the validated
    manifest-declared paths — NEVER `config/`, `scripts/`, `templates/`,
    `src/` or other roots: existing bundles bind-mount exactly those into
    LIVE containers (lemmy `./config:ro`, maker-lab-advanced
    `./config`+`./scripts` — R2 verified), and containers survive gateway
    restarts; a refresh must never mutate a running container's mounts and
    never restarts containers. Non-docker (mcp-server) bundles get the full
    set above. NEVER copied for ANY type (stated, deliberate):
    `docker-compose.yml`, `Dockerfile`, `entrypoint.sh`, `.env*`,
    `node_modules/`, `data/`. cpSync is additive — dest-only files
    (operator lesson packs, .env) survive structurally.
  - Re-copy the SERVED panel artifacts exactly as install does
    (bundles.js:1170-1184): `resolvePanelPath(manifest,id)` →
    `~/.crow/panels/<id>.js`, and `manifest.panelRoutes` →
    `~/.crow/panels/<id>-routes.js` — with `rmSync(dest, {force:true})`
    BEFORE each cpSync (R1 minor: crow's live panel files are legacy
    SYMLINKS into the bundle dir; copy-over-symlink is safe on Node 20 but
    rm-first is deterministic across versions; post-refresh they are regular
    files, and every future bump re-copies them).
  - npm step (R1 MAJOR-3 — narrow trigger; delta narrative corrected by R2
    MAJOR-1): run `npm install --omit=dev` in the bundle dir ONLY when the
    repo `package.json` declares a dependency NAME absent from the installed
    bundle's `node_modules/` (added dep; `existsSync(join(nm, depName))`
    handles @scope/name naturally). Removed-dep-only or version-range-only
    changes do NOT trigger. **Maker-lab's real delta is BOTH kinds**: repo
    dropped `@libsql/client` AND added `qrcode` — so npm DOES fire on this
    deploy, awaited pre-listen, bounded by run()'s 300s timeout, warn-only
    (bundles.js:361). Accepted and stated: one bounded first-boot delay on
    the refreshing instance; §5 verifies the npm log line and the bounded
    boot. Resolution facts (R2+controller-verified): the SERVED panel
    resolves imports via the PANELS_DIR `node_modules` symlink → GATEWAY
    node_modules (qrcode present at root package.json:77 from Phase 2), and
    the maker-lab server never imports qrcode — so the bundle npm step is
    hygiene, not load-bearing, for THIS deploy. The refresh must ALSO ensure
    the PANELS_DIR `node_modules` link exists (install-parity,
    bundles.js:1186) — an April-era install may predate it.
  - Log one `[bundles] refreshed <id> <oldV> -> <newV>` line; include in the
    function's `repaired` return.
- Version equal or either manifest unreadable (getManifest→null,
  bundles.js:351-357) → existing missing-only repair behavior, unchanged.
  The `APP_BUNDLES/<id>` existence guard (:292) stays first — foreign
  bundles skipped as today.
- **Async integration (R1 MAJOR-2 — load-bearing):** the function becomes
  `async` (the npm step awaits); its call site `mcp-mounts.js:144` becomes
  `await repairInstalledBundleAssets()` — WITHOUT this, `repaired` is a
  Promise, `:145` throws into the `:151` catch and logging breaks while npm
  runs unhandled. `mountMcpServers` is already awaited at index.js:490,
  BEFORE `server.listen` — which is exactly the ordering D3 needs (panel
  load at post-listen.js:111 and the MCP child spawn at :168 both run
  post-listen). The npm step is the only boot-time cost; its narrow trigger
  (added-dep-only) keeps the common refresh path file-copy-fast, satisfying
  the global unattended-window posture.

### D2 — maker-lab version bump 0.1.0 → 0.1.1

`bundles/maker-lab/manifest.json` + the registry entry. Registry is
generated (`scripts/build-registry.mjs`). **The FULL regen is MANDATORY, not
a fallback (R1 MAJOR-1 — the spec's first draft had this inverted):**
`tests/bundle-contract.test.js:212` ("committed registry matches generated")
is ALREADY RED on main from the rookery drift; committing only a maker-lab
hunk leaves it red. R1 ran `build-registry.mjs --check` and verified the
regen delta is 170 lines touching ONLY the rookery entry (+ maker-lab's bump
once the manifest changes) — so the honest full regen, in its OWN commit,
both carries the bump AND turns the long-red drift test green. Diff review +
`git show --stat` before push; the commit message states it absorbs the
rookery reconciliation. (No CI workflow runs the drift check — R1 verified —
so local suite green is the gate that matters.)

### D3 — Instance activation (deploy)

Deploy = normal fleet pull + restart. On crow's boot, D1 sees 0.1.1 ≠ 0.1.0 →
refreshes `~/.crow/bundles/maker-lab/` + `~/.crow/panels/maker-lab.js` +
`-routes.js`. R1 verified the fix is MORE self-contained than first drafted:
the 500 comes from the served `-routes.js` (April copy, `JOIN
research_projects` at :117) importing against crow's main DB — the panel
refresh ALONE fixes it; it does not depend on the bundle server's
init-tables rebuild. CAUTION recorded (R1): maker-lab's tables live in the
shared prod `crow.db` (bundle db.js honors CROW_DB_PATH → main DB), and its
init-tables.js performs a PRAGMA foreign_keys=OFF table REBUILD there on the
MCP child's next spawn — a DDL migration on a DB with two prior corruption
incidents; deploy verification includes a post-spawn `PRAGMA
integrity_check`. Only maker-lab refreshes on this deploy (all other
installed bundles version-equal — verified); other instances have no
maker-lab → no-op.

## 3. Non-goals

- No learner-data recovery (operator-decided). No project_spaces dedupe.
- No general add-on store update UX (Extensions overhaul theme owns that).
- No change to install/uninstall flows; refresh is boot-side only.
- No touching non-first-party bundles (no `APP_BUNDLES/<id>` → skip, as today).
- NO SCHEMA_GENERATION bump (maker-lab's own tables are bundle-managed via
  its init-tables.js; the crow schema is untouched).

## 4. Tests (TDD; mutation-test the guards)

Fixture seams (R1 answered concretely): CROW_HOME **is** env-keyed
(bundles.js:116) so the DEST side (BUNDLES_DIR/PANELS_DIR) redirects via
env; the SOURCE (`APP_BUNDLES = join(APP_ROOT,"bundles")`, :123-124) is
hardcoded. The function therefore gains injectable params —
`repairInstalledBundleAssets({ appBundles = APP_BUNDLES, run = defaultRun } = {})`
— solving the source seam AND the npm-runner seam (test 4) in one shape.

1. Version differs → code files overwritten (a stale server/server.js gets
   the repo content), PANELS_DIR `<id>.js` + `<id>-routes.js` refreshed —
   **mutation**: removing the version-compare (always-equal) reddens.
2. Version equal → a deliberately-different installed file is NOT touched
   (missing-only behavior preserved) — **mutation**: unconditional refresh
   reddens this.
3. Instance-local preservation: `.env` + `data/marker.txt` + an extra
   node_modules file survive a refresh byte-identical — **mutation**:
   swapping explicit-include for a blanket dir copy reddens.
4. npm trigger (R2-reworded to pin the M3 guard): an ADDED dep name absent
   from the installed node_modules → npm invoked (injectable runner records
   the call; never a real npm in tests); a removed-dep-only change AND a
   version-range-only change → NOT invoked — **mutation**: reverting the
   trigger to any-package.json-byte-diff reddens the removed-only case.
4b. Docker-type bundle → `config//scripts/` NOT copied even when present in
   repo; mcp-server type → copied — **mutation**: dropping the type gate
   reddens. Manifest-declared root `"../x"` → rejected, no copy outside the
   bundle dir — **mutation**: dropping the segment validation reddens.
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
