# Opus-autonomous improvement arc — master plan (2026-07-11)

**Audience: a Claude Opus session executing autonomously under Kevin's standing blanket
authorization (granted 2026-07-11).** This document is self-contained: it carries the
work queue, per-item specs and acceptance criteria, the rigor pipeline, the standing
rules, and the fleet/deploy runbook. You should not need to excavate memory files or
old sessions to execute it — but you MUST re-verify each item against current code and
live state before building (see "Anti-archaeology rule").

---

## 0. Authorization and scope

- **Grant (Kevin, 2026-07-11, verbatim intent):** "i give you authorization to do any
  and all of these, but do those that you can drive autonomously. you have full
  autonomy and I approve your recommendations in advance." This covers every item in
  this plan: PR merges and fleet deploys are pre-approved — no per-PR merge gate.
- **The rigor pipeline (§2) is how the autonomy stays safe. It is not optional.**
- **Out of scope — do NOT start without Kevin:** FERPA Phase 1.5 reconciliation
  (blocked on a real Together invoice); Wave-3 Android operator actions (Meta DAT
  fingerprint, APK attach, keystore password); v1-refoundation social-preview PNG;
  maker-lab learner-data recovery (Kevin decided 2026-07-11: **no recovery**);
  black-swan↔grackle re-pair ceremony (operator matter — grackle's providers backfill
  sits in its feed pending re-pair).
- **One item at a time**, in queue order (§4). Each item is independently shippable.
  Do not interleave items; finish (merge + deploy + live verify + record) before
  starting the next.

## 1. Anti-archaeology rule (run this before every item)

Memory and this plan are point-in-time. Parallel/delegated sessions ship things.
Before building any item:

1. `git fetch origin && git log --oneline -15 origin/main` — has someone already
   shipped it? Search the log for the item's keywords.
2. Re-verify the defect/gap exists in CURRENT code (grep the cited files) and, where
   relevant, live (curl / sqlite3 / CDP). If it's gone, record "already landed" in the
   ledger and move on.
3. Check for open branches touching the same files: `git branch -a`.

**This rule is global — it applies to EVERY item, not just the ones whose text repeats
it.** Work items rot: F-INSTALL-11 ("installer renames the OS hostname") was already
fixed before this plan was written (`scripts/crow-install.sh:209` defaults to N, and
`ask_yn` returns No in the headless path too) and has been struck from Item 4c. Assume
others have rotted the same way.

Baseline state when this plan was written (**2026-07-11 night** — anchor on the date,
not the sha; main moves): fleet healthy on the then-current main; suite 1604 pass / 0
fail / 1 skip; sync_conflicts crow 219 / grackle 162 / black-swan 0 (decreases are
#124 retention-prune — only GROWTH is a red flag); stash baselines crow 4 / grackle 17
(growth = auto-update stash regression); PRs #163–#173 all merged (settings-scope,
bug-hunt squash, bundle version-refresh, maker-lab location-independence, auto-update
hardening, providers owner-asserts, follow-up minors, tailnet-dial minors, docs,
extensions overhaul).

## 2. The rigor pipeline (per PR)

Every item ships through this sequence. Larger items (marked THEME) add a planning
session at the front.

1. **Spec** — write `docs/superpowers/specs/<date>-<slug>-design.md` for anything
   design-shaped. Run a **2-round adversarial review** (fresh Opus subagent per round,
   prompted to find critical flaws, not to approve). Fold findings between rounds.
   Small mechanical items may skip the spec but never skip review of the diff.
2. **Plan → SDD tasks** — SDD = subagent-driven development (the
   `superpowers:subagent-driven-development` skill): break the work into independent
   TDD tasks and dispatch one subagent per task. TDD means RED test first, then code;
   every guard/branch you add gets a **mutation check** — comment the guard out, watch
   a NAMED test go red, restore it. SDD helper scripts live under the installed
   superpowers plugin, version-agnostic path:
   `~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/subagent-driven-development/scripts/`
   (`sdd-workspace`, `task-brief`, `review-package`; the installed version was 6.0.3 on
   2026-07-11 — glob it, don't hardcode).
   **Ledger** = the running execution log at `~/crow/.superpowers/sdd/progress.md` —
   **git-IGNORED, never `git add` it**; task-N brief/report paths are REUSED across
   runs — overwrite them, never trust the provenance of a file you find there.
3. **Per-task review** — a fresh reviewer subagent per completed task.
4. **Final whole-branch review** — fresh Opus subagent over the full branch diff;
   verdict must be READY TO MERGE (fix and re-review otherwise).
5. **PR → merge** — `gh` is ABSENT on crow; use the GitHub MCP tools
   (`mcp__github__create_pull_request`, `mcp__github__merge_pull_request`; repo
   `kh0pper/crow`). Check-runs via
   `curl https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` —
   `total_count: 0` is NORMAL (workflows are path-filtered); the REAL gates are local
   and you must run all three:
   - full suite: `node --test tests/*.test.js` (there is NO `npm test` script; the
     per-file `test:*` scripts in package.json are shortcuts, not the suite),
   - `node scripts/check-port-allocation.js` (any new bundle host port must be added
     to `docs/developers/port-allocation.md` or this fails),
   - `node scripts/build-registry.mjs --check`.

   **⚠️ The suite runs against PROD unless you isolate it.** There is NO CI test
   workflow (`.github/workflows/` has only deploy-docs, image-freshness,
   pet-mode-appimage, port-allocation) — this local run, on the prod box, is the only
   execution the code ever gets. And `CROW_HOME` / `CROW_DATA_DIR` default to the real
   `~/.crow` (`routes/bundles.js:118`, `panels/extensions/data-queries.js:19`,
   `panel-registry.js:40`, `servers/db.js:72` — all `process.env.CROW_HOME ||
   join(homedir(), ".crow")`), 261 test files run in PARALLEL, and a throwaway clone
   does NOT help because the path is homedir-derived, not repo-derived. This is the
   exact mechanism behind both incidents in §3 (a suite run refreshed prod maker-lab;
   an install test installed a real container on prod). **Run the suite with scratch
   env:**
   ```
   T=$(mktemp -d); CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_DISABLE_NOSTR=1 \
     CROW_DISABLE_INSTANCE_SYNC=1 node --test tests/*.test.js
   ```
   and `fuser ~/.crow/data/crow.db` first to confirm no stale writer. Individual tests
   that need prod-shaped state must set it up in the scratch dir themselves.

   **Check-ports has a known permanent error — make the check mechanical, not
   eyeball-based.** Kevin's untracked `bundles/capstone-tracker/` WIP (0 tracked files,
   invisible to CI on the merged tree) makes `check-port-allocation.js` exit 1. The
   gate is green iff the error block contains **exactly one** line and it is
   `Port 8090 (capstone-tracker)`. Any second line, or a different port, is real drift
   — stop. Do not "fix" or touch his WIP.
   **Post-merge, watch the docs deploy.** `.github/workflows/deploy-docs.yml` fires on
   any push to main touching `docs/**` → rebuilds the **public** VitePress site on
   GitHub Pages. §5 asks you to update THIS plan doc (which lives under `docs/`) as part
   of each item, so **every item ships a public docs rebuild.** The `total_count: 0`
   check-runs result on the PR sha does NOT cover it — after merging, poll the
   `deploy-docs` run on main and confirm it succeeded. (A known-flaky Pages-publish step
   has failed cosmetically before with the build green; distinguish the two.)

6. **Deploy fleet** (§3 runbook — read the auto-update migration rail first if the PR
   bumps the schema) → **live verify** — CDP browser proof for anything UI-facing (a
   curl 200 is not proof a page works), plus the item's own acceptance checks. Evidence
   under `~/.crow/p4/<item-slug>/` (screenshots + assertions.jsonl).
7. **Record** — append outcome to the ledger; update the memory file for the arc.

## 3. Standing rules + fleet runbook

### Git hygiene (parallel sessions are common)
- Commit with a **positional path arg**: `git commit <paths> -m "..."` — never
  `git add` + bare `git commit`. Verify with `git show --stat HEAD` after every commit.
- `git pull --rebase` before pushing. **Never `--amend`** after a commit may have been
  seen elsewhere. Never force-push shared branches.
- **Never attribute Claude** as co-author/contributor in commits, PRs, or the repo.
- `~/crow` is the PROD working tree on crow: it must be back on `main` (clean of your
  branch) before you restart services. Prefer a throwaway clone for scratch gateways.
- Leave Kevin's WIP alone: `scripts/bench/*` modification + all untracked dirs listed
  in `git status` at session start (incl. `bundles/capstone-tracker/`, a stray file
  literally named `undefined`).

### Test isolation (incident-hardened — violations have contaminated prod)
- Any test or scratch gateway that touches install/bundle/gateway-boot paths MUST run
  on a scratch `CROW_HOME` + `CROW_DATA_DIR` (mkdtemp). Modules that resolve paths
  from CROW_HOME **at load time** need the scratch env set BEFORE a **dynamic
  `await import()`** (pattern: commit `71ad6104`; examples
  `tests/install-set-e2e.test.js`, `tests/extensions-client-contract.test.js`).
- Full scratch-offline env: `CROW_HOME=<tmp> CROW_DATA_DIR=<tmp>/data
  CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1` (boots with no relay/mesh I/O).
- Incident history to respect: a suite run once refreshed prod maker-lab; an install
  test once installed a real container on prod (Kevin had to remove it). "Empty-find
  proof": assert the scratch dirs are what the code actually touched.
- Before any live messaging/sync E2E: `fuser ~/.crow/data/crow.db` and kill stale
  session-spawned stdio MCP subprocesses — they run session-start code, do NOT
  hot-reload after deploys, and will write into the shared prod DB (cost a false
  "block leak" diagnosis once).

### CDP browser verification
- CDP = Chrome DevTools Protocol: you drive the real dashboard in the real browser as
  a user would, and assert on what the page actually renders/does. A curl 200 or a
  string match in source is NOT proof — CSS needs resolved computed values, client JS
  needs executed behavior. This class of proof has repeatedly caught bugs the (now
  1600+) test suite could not see.
- crow-browser CDP endpoint: `127.0.0.1:9222`. Reusable helpers:
  `~/.crow/p4/ext-overhaul/cdp.mjs` + `runner-{a,b,c}.mjs` (assertion-jsonl pattern).
- Reach gateways via the LAN IP `10.0.0.237`, NOT loopback — `isAllowedNetwork()`
  denies loopback for dashboard sessions.
- `--no-auth` does NOT bypass dashboard auth (it's MCP-side only). For a scratch
  gateway, mint a session row directly in the SCRATCH DB's `oauth_tokens` and set the
  cookie. Revoke test sessions when done.
- **Minting a session correctly (this has silently 303'd two sessions to
  `/dashboard/login`):** `oauth_tokens.token` stores **`sha256(token)`** while the
  cookie carries the **raw** token (`auth.js:15` `hashToken`, `:348` `verifySession`),
  and `expires_at` is a **TEXT datetime** compared against `datetime('now')` — NOT a
  unix epoch. Get either wrong and you get a silent redirect, not an error. Recipe:
  `TOK=$(openssl rand -hex 20); HASH=$(printf '%s' "$TOK" | sha256sum | cut -d' ' -f1)`
  → insert `$HASH` with `expires_at = datetime('now','+30 minutes')` → send `$TOK` in
  the cookie. Simpler alternative on a scratch box: seed `password_hash` in
  `dashboard_settings` (scrypt, `salt:key`) and just POST `/dashboard/login`.
- A fresh scratch DB has no password → every route redirects to `/setup`. Seed
  `password_hash` before expecting a dashboard.
- Browser gotchas that have burned sessions: cookies ignore ports (scratch + prod
  gateways on the same host share the cookie jar — use distinct cookie names or
  separate contexts); navigating to the SAME URL is a Turbo no-op (change a query
  param); onboarding action cards open NEW tabs — assert in the opened tab.
- Live-verify on prod exercises READ paths and existing UI flows; anything that would
  INSTALL/mutate prod state stays on the scratch gateway.

### Unattended-window safety (global rule)
Any long unattended operation that degrades prod (stops a service, locks a resource,
holds a port) MUST carry its own hard wall-clock cap that auto-restores prod, enforced
OUT OF PROCESS (detached deadman watchdog) — never rely on wake-ups or completion-only
waiters. Keep windows short; verify prod is back before calling a job "monitored."

### Fleet + deploy runbook
| Host | How to deploy | Notes |
|---|---|---|
| crow (this box, 10.0.0.237) | `cd ~/crow && git pull --ff-only` then `sudo systemctl restart crow-gateway crow-mpa-gateway` | Same tree serves both units — tree must be on main first. Gateway :3001, MPA :3006 (`CROW_HOME=~/.crow-mpa`). |
| grackle (100.121.254.89) | `grackle "cd ~/crow && git pull --ff-only"` then restart `crow-mcp-bridge` THEN `crow-gateway` | Bridge before gateway (DB-lock ordering). Gateway :3002. |
| black-swan (`ssh black-swan`, user `ubuntu`) | `cd /home/ubuntu/.crow/app && git pull --ff-only` then `sudo systemctl restart crow-gateway` | Passwordless sudo. Slow boot 60–90s — wait before health-checking. |

- sudo password crow+grackle: see `~/.claude/CLAUDE.md`.
- Health: `curl http://127.0.0.1:3001/health` (crow), `http://100.121.254.89:3002/health`,
  `http://100.90.185.114:3001/health`. All must be `"status":"ok"` post-deploy.
- Post-deploy soak: `PRAGMA integrity_check` on crow.db; sync_conflicts counts must
  not GROW; stash counts at baseline (crow 4 / grackle 17); zero err-level gateway log
  lines.
- Take a DB backup before any deploy that runs a migration or boot heal
  (`cp ~/.crow/data/crow.db ~/.crow/data/crow.db.pre-<slug>-$(date +%Y%m%d-%H%M%S)`).

### ⚠️ Auto-update means MERGING *IS* DEPLOYING — the migration rail

`servers/gateway/auto-update.js` is **ON by default** (`auto_update_enabled: "true"`,
`DEFAULT_INTERVAL_HOURS = 6`). On tick it does `git pull --ff-only origin main` → npm
install → **`init-db`** → restart. Verified live on crow 2026-07-11 (`auto_update_enabled
|true`, `interval|6`, a check at 22:13 that same day). **So the moment you merge to
main, every fleet box will pull and migrate itself within ~6 hours, unattended — before
you have taken a single backup, and ignoring grackle's bridge-then-gateway restart
order.**

`SCHEMA_GENERATION` / `user_version` is monotonic: **reverting the merge does NOT
un-migrate the databases.** Item 2b (contact_groups tombstones) requires a schema bump,
so this is not hypothetical — merged carelessly it migrates three production DBs
simultaneously with no backups and no human gate. This is the single worst thing this
plan can do to Kevin's fleet.

**Kevin's decision (2026-07-12), verbatim:** *"auto update can be turned off if necessary,
but I want to turn it back on when we are done."* So: disabling auto-update for a
migration window is **authorized**, and **re-enabling it is mandatory** — the item is not
"done" until auto-update is back ON and confirmed on all three boxes. If a session ends
with it off, that is an incident, not a pending task.

**⚠️ THE RAIL AS ORIGINALLY WRITTEN WAS INSUFFICIENT — corrected 2026-07-12 (Item 2a R3/MAJOR-4).**
A `SCHEMA_GENERATION` bump does NOT run "just the new migration": `needsSchemaInit`
(`servers/shared/schema-version.js:21-25`) → `gateway/index.js:134` runs **the ENTIRE
`scripts/init-db.js`**, which contains **8 `DROP TABLE` statements** — `shared_items`
(`:493`), `crow_context` (`:1275`), `dashboard_settings` (`:1834`), `research_projects`
(`:2696`), a generic `DROP TABLE ${tableName}` (`:926`) — plus `DELETE FROM schedules`
(`:2726`) and `DELETE FROM project_spaces` (`:1023`). These are *guarded rebuild-migrations*,
but **they have not run since gen 6 was stamped**, and a bump re-arms every one of them
against **FOUR** live DBs (crow, **MPA (`~/.crow-mpa` — easy to forget)**, grackle,
black-swan — all verified at `user_version = 6` on 2026-07-12).
**And the old rail could not detect the damage:** `PRAGMA integrity_check` reports *page-level*
integrity — it returns `ok` for a table that was rebuilt having silently lost rows — and
`user_version = 7` proves only that the script reached its last line.

**Rail — for any PR that bumps `SCHEMA_GENERATION` or adds a boot heal:**
1. Disable auto-update on all boxes FIRST (Settings → Updates, or set
   `auto_update_enabled=false`); confirm each box reports it disabled.
2. Back up **all four** DBs (`crow.db.pre-<slug>-<ts>`), verify each exists and is non-zero.
3. **DRY-RUN GATE (new, mandatory) — `scripts/schema-migration-dryrun.sh`.** It copies each DB,
   runs `init-db` against the copy, and diffs `sqlite_master` + per-table `COUNT(*)` pre/post.
   Zero unexplained deltas is the merge gate; ship the output as evidence. **Run it from the
   bump-bearing branch** (that is the point — it must exercise YOUR migration):
   ```
   grackle "cp ~/.crow/data/crow.db /tmp/g.db"; scp kh0pp@100.121.254.89:/tmp/g.db /tmp/grackle.db
   ssh black-swan "cp ~/.crow/data/crow.db /tmp/b.db"; scp black-swan:/tmp/b.db /tmp/bswan.db
   scripts/schema-migration-dryrun.sh crow ~/.crow/data/crow.db mpa ~/.crow-mpa/data/crow.db \
     grackle /tmp/grackle.db bswan /tmp/bswan.db
   ```
   For a well-behaved additive migration the ONLY deltas are your new column/table and
   `user_version`; every row count is unchanged. Any unexplained row-count delta or lost table
   is a STOP.
   **Baseline established 2026-07-12 (gen 6, unmodified main): the gate PASSES on all four prod
   DBs — zero schema deltas, zero row-count deltas, nothing lost.** So the 8 `DROP TABLE`
   rebuild-migrations are empirically **inert on this fleet's real data**, and a bump is
   de-risked — *provided you re-run the gate on your branch and it still passes.*
   (Stop the gateway before any REAL migration run — init-db does heavy DDL against a DB the
   gateway holds open, and `"database is locked"` is a documented recurring failure here.)
4. Merge.
5. Deploy manually, in the §3 runbook order, one box at a time; verify health +
   `PRAGMA integrity_check` + **the per-table row-count diff** + the migration's own acceptance
   check before moving on.
6. Re-enable auto-update on all boxes; confirm.

**Executor note on the lock:** crow runs TWO gateways off the same tree, and the
**crow-mpa-gateway** is typically the one that wins the atomic update lock — the primary
then logs `Skipped: another updater is running (pid …)`. That message is normal
co-hosted behavior, **not** evidence that auto-update is inert. Never assume it won't
fire. Determine the real state (`sqlite3 ~/.crow/data/crow.db "SELECT key,value FROM
dashboard_settings WHERE key LIKE 'auto_update%';"`) before merging anything schema-bearing.

### Network exposure invariant (never regress)
Dashboard + private routes must never be Funnel-reachable. Only `/blog`,
`/robots.txt`, `/sitemap.xml`, `/.well-known/`, `/favicon.ico`, `/manifest.json` are
public-safe. If you touch gateway routing/auth, run `tests/auth-network.test.js`.

### Sync-layer engineering gotchas (learned this arc)
- Emitting `op=update` for a table without a natural-key apply handler silently never
  delivers to fresh peers (generic `_applyUpdate` matches 0 rows) — backfills use
  `op=insert`.
- One-shot boot reconciliations: only `done:<n>` is terminal; `no-peers` must write NO
  flag (the flag-stuck class, PR #147).
- Schema changes bump `SCHEMA_GENERATION` — defined in **`servers/shared/schema-version.js:13`**
  (currently `6`), merely imported by `scripts/init-db.js`. That module is imported by
  gateway boot, so **keep it free of side-effecting imports**. Table/trigger DDL goes in
  `scripts/init-db.js`; the boot gate auto-migrates on restart. FTS-shadowed tables
  (`memories`, `sources`, `blog_posts`, `kb_articles`) need their virtual table +
  insert/update/delete triggers updated in the same place. See the migration rail above
  before merging any bump.
- `fix-the-product-not-the-instance`: every fix must work on a fresh single-click
  install, not just this fleet.

---

## 4. The queue

Execute top to bottom. Items 1–3 are well-scoped single PRs (or one small PR each).
Items 4–5 are THEMES: run a planning session first (brainstorm → spec → 2-round
adversarial review → break into PRs), then execute the PRs one at a time through §2.

---

### Item 1 — Extensions follow-up pool — ✅ SHIPPED 2026-07-12 (PR #174, main `bbedd0f5`)

**Done: merged, fleet-deployed (crow/mpa/grackle/black-swan), live-verified.** Spec:
`docs/superpowers/specs/2026-07-11-extensions-followups-design.md` (two adversarial
rounds). Evidence: `~/.crow/p4/ext-followups/` (23 assertions, 9 screenshots; 10/10 on
scratch + 5/5 on prod). Ledger has the full record.

The load-bearing lesson for later items: **the naive rule would have badged Kevin's
working bundles.** A missing `bundles/<id>/.env` usually means "not
gateway-managed-with-config", not "unconfigured" — MCP add-ons never read that file
(their env is in `mcp-addons.json` or ambient in the gateway's process env). Measured
before shipping; measured again after deploy: **zero badges on all 10 real bundles.**
When a rule keys off host state, *compute it against the real host before you build it.*

New follow-ups this item produced (fold into Item 3's batch, or their own PRs):
- **A docker bundle whose required key has no `default` never gets a `.env` written by
  the UI install path** (`routes/bundles.js:1252-1263` — the `.env.example` fallback is
  dead for UI installs, since the modal always sends an `env_vars` object), so it can
  never badge. `frigate` is the live instance. One-line fix, but it changes install
  behavior → own PR.
- The unregistered-bundle env fallback drops `secret` (`client.js:500,1360`), so such a
  key renders `type=text` instead of `type=password`.
- **3 tests read prod state to pass** and fail under a scratch `CROW_HOME` on unmodified
  main (so they'd fail on a fresh clone/CI): `bundles-validate-install.test.js` ("consent
  bundle with an invalid/bogus token", "a bundle already present in ~/.crow/installed.json")
  and `instance-sync.test.js` ("crow_context emitChange stamps local row's lamport_ts").

<details><summary>Original spec (kept for reference)</summary>

**Why:** three accepted follow-ups from the shipped extensions overhaul (PR #173).
Small, adjacent, zero design risk. Code lives in
`servers/gateway/dashboard/panels/extensions/client.js` (+ `.../extensions/html.js`),
`servers/gateway/routes/bundles.js` (the install/install-set/env routes — NOT under
`dashboard/`), `servers/gateway/dashboard/panels/onboarding.js`, and
`tests/install-set-e2e.test.js`.

**1a. Checklist re-derive-on-demand.** Today the post-install NEEDS_CONFIG checklist
is one-shot: `renderPendingChecklist` consumes the sessionStorage entry at load
(`panels/extensions/client.js:1341-1347` — `removeItem` fires before the parse), so
closing the modal without configuring loses the proactive checklist until reinstall.

**This requires a NEW SERVER SURFACE — do not try to do it client-side.**
`needsConfigKeys` is a *server* function (`servers/gateway/routes/bundles.js:1725`) and
its only caller is the install-set job runner (`:1961`), which writes `NEEDS_CONFIG <id>
<keys>` into a job log the client scrapes. Nothing exposes per-installed-bundle config
state: `GET /bundles/api/status` (`:1766`) returns only id/name/type/containers/running,
and the server-rendered Installed cards (`panels/extensions/html.js:303-338`) render
name/version/date. Note also that `NEEDS_CONFIG` is emitted **only** by `/install-set` —
a bundle installed via single `/install` (`:1849`) never gets a checklist at all, so
this affordance is its ONLY config surface. Cover that case.

**🔒 Hard constraint: expose KEY NAMES ONLY, never values.** The `.env` holds bundle
secrets (API keys, DB passwords). Shipping parsed `.env` contents to the browser to make
the state "derivable client-side" would leak them into dashboard HTML. Never do this.

*Decide in the spec (pick ONE, it determines the test shape):* (a) add a `needs_config:
["KEY", …]` field to `/bundles/api/status` → client-contract test; or (b) compute at
render time in `panels/extensions/html.js:303` → HTML-render test. (b) is simpler and
avoids a new client fetch; (a) is better if the client needs to refresh it without a
reload.

*Acceptance:* a bundle with unmet config keys shows the affordance after a full page
reload with **cleared sessionStorage**; it also shows for a bundle installed via single
`/install` (never had a checklist); clicking it opens the Configure (env-only) modal
scoped to exactly the missing keys; a successful save clears the affordance without
reinstall; a bundle with no missing keys never shows it; **no `.env` VALUE appears
anywhere in the response body or DOM** (assert this explicitly — grep the rendered HTML
for a known secret value and require zero hits). Test per the chosen surface + CDP proof
on a scratch gateway.

**1b. Onboarding action-card target decision — SCOPED TO THE DONE-STEP CARDS ONLY.**

⚠️ An earlier draft of this plan said "uniform `_blank` scheme, change all-or-none."
**That was wrong and would have broken the wizard.** The two `_blank` sites are
different things:
- **`deepLink()` (`panels/onboarding.js:33`) must KEEP `target="_blank"`.** Its callers
  (`:155, :157, :160`) are **mid-tour** steps pointing at internal dashboard paths
  (`/dashboard/settings?section=integrations`, `/dashboard/bot-builder`,
  `/dashboard/connect`), and its docstring (`:31-32`) states the rationale: it opens the
  surface in a new tab *so the tour stays open behind it*. Same-tab here navigates the
  user OUT of the wizard mid-tour. Do not touch it.
- **`renderActionCards()` (`:74`)** renders on the **done** step, after
  `onboarding_completed_at` is persisted (`:213-218`). There is no tour left to
  preserve, so new tabs for internal links are just odd UX. **This is the only site in
  scope.**

Change the done-step action cards so INTERNAL hrefs open in the same tab; external
hrefs keep `target="_blank" rel="noopener"`.
*Acceptance:* `deepLink` and its three mid-tour callers are byte-unchanged (assert);
each done-step card carries the correct `target` for its href class (test executes the
renderer, per-card assertion); CDP click-through proof on a done-step internal card —
note this **inverts** the old assertion 9b in `~/.crow/p4/ext-overhaul/` (which asserted
in the opened tab); update that recipe.

*Coupling with Item 4d:* 4d rewires this same wizard to offer starter collections and
may rewrite `renderActionCards` anyway. If you reach Item 4 with 1b unshipped, fold 1b
into Item 4's onboarding spec rather than shipping it twice.

**1c. T12 timer→barrier pacing.** `tests/install-set-e2e.test.js` paces the
install-set busy-gate window with `_setInstallSetStepDelayForTest(150)` (the seam is
`servers/gateway/routes/bundles.js:156`, consumed at ~:1939 and 0 in production) plus
setTimeout sleeps. Replace the timer coupling with a deterministic barrier promise
(the test seam resolves a promise the runner awaits), keeping the prod default a true
no-op.
*Acceptance:* the busy-gate section of the test contains zero wall-clock sleeps (grep
the test file for `setTimeout`/`sleep` in that block — zero hits); **the prod no-op is
proven by mechanism, not assertion-by-comment** — the seam is a module-private
`let _installSetStepDelayMs = 0` (`bundles.js:155-156`), so prove the production path
never awaits the barrier when the seam is untouched (e.g. assert the branch is
unreachable at default, or export a read-only getter and assert it is 0/undefined in a
fresh import). Mutation check: break the barrier ordering, a NAMED assertion goes red.

**Ship:** one branch `fix/extensions-follow-up-pool`, suite + gates green, CDP
evidence in `~/.crow/p4/ext-followups/`, PR, merge, fleet deploy, live verify
(1a affordance on a real bundle-with-missing-key on scratch; onboarding card behavior
on prod read-only).

</details>

---

### Item 2 — Sync-layer design leftovers — 2a ✅ / 2a-FU ✅ SHIPPED; **2b is NEXT**, then 2c/2d

These were explicitly deferred as "design-shaped, own session each." Each gets a spec
+ 2-round adversarial review (this layer has bitten us repeatedly — key-rebind,
lamport ties, offline-peer resurrection). All four live in `servers/sharing/`
(`contact-sync.js`, `group-sync.js`, `tailnet-sync.js`, `instance-sync.js`) +
`servers/gateway/dashboard/panels/messages/data-queries.js`.

**2a. pruneStaleAdvertisedContacts resurrection — ✅✅ SHIPPED 2026-07-12 (PR #177, main `2390f287`).**
Merged, fleet-deployed (crow/MPA/grackle/black-swan all at `user_version` 7), live-verified, auto-update
back ON. Spec v5 (`…-advertised-contact-prune-design.md`) carries the full record.

> **Read this before ANY future sync-layer work — it is the most expensive lesson of the arc.**
>
> **Six bugs. Five of them found AFTER the design was "complete", and three of them introduced by
> the fix for the previous one.** The v4 design had survived *three* adversarial Opus review rounds.
> Then an executable two-instance test demolished its convergence proof in one run (permanent silent
> divergence, zero `sync_conflicts`, nothing logged). Each subsequent fix broke something new:
> a lamport laundered across tombstone kinds; a "dropped as unreachable" finding (F6) whose premise
> the fix had silently deleted; a tombstone stripped by rule (a) during an awaited network teardown;
> a failed prune leaving a contact alive-but-unwired so the bot's next DM vanished.
>
> **Three lessons, in order of value:**
> 1. **Prose review is necessary and NOT sufficient for distributed state.** Three adversarial rounds
>    read v4's convergence proof and approved it. A test killed it immediately. **For any sync-layer
>    change the acceptance gate must be EXECUTABLE and MULTI-INSTANCE, and it must exercise the
>    MUTUAL case** — the single-actor case is exactly where these bugs hide.
> 2. **A finding dropped as "unreachable" is only as good as the premise that made it so.** When a
>    later change removes that premise, the dropped finding is live again and *nothing in the process
>    re-opens it*. That is precisely how F6 shipped as a CRITICAL.
> 3. **Three tests on this branch were VACUOUS** — they asserted a property they did not exercise, and
>    passed for unrelated reasons. The tell was identical every time: **the harness could not reach the
>    mechanism the assertion named** (no SyncManager; the emit sink was a module global left `null`;
>    the tombstone wasn't written yet when the simulated race fired). Mutation-check every guard, and
>    make sure the mutation you apply is the one the test *claims* to catch.

**Follow-ups this item produced (own PRs):**
- **[GATE BLIND SPOT] `scripts/schema-migration-dryrun.sh` cannot see `ALTER TABLE ADD COLUMN`** — it
  diffs `sqlite_master` *object names*. It proves nothing was LOST; it **cannot prove your migration
  happened**. Add a per-table `PRAGMA table_info` diff. (Both new columns had to be verified by hand.)
- **[REAL BUG, grackle] no bot can EVER be advertised from grackle** — `botIdentityFor` opens
  `/home/kh0pp/crow/data/identity.json` (the repo dir) instead of `~/.crow/data/identity.json`, so
  `buildAdvertisementPayload` skips every bot. Found by being the first ever to advertise one. **Root
  cause NOT established:** re-running the resolution under systemd's exact env (`HOME` set, no `CROW_*`)
  yields the CORRECT path, so the running gateway disagrees with a faithful repro — do not guess, and
  note grackle's `~/.crow/data/crow.db` is a **symlink** into the repo's `data/`. (F1 handled it
  perfectly: the skip ⇒ no `complete` key ⇒ `complete:false` ⇒ a peer can never prune from that list.)
- **[REAL BUG, MPA] MPA's federation credentials are broken** — `missing_peer_credentials` (→crow) and
  `hmac_mismatch` (→grackle). Its bot directory is therefore always empty and **it can never prune**
  (fail-safe, but wrong). Pre-existing pairing/credential drift; needs a re-pair or a credential repair.
- **[LEAK] a scratch gateway from a PREVIOUS session ran for 2 days** (pid 960187, port 3495,
  `CROW_DATA_DIR=…/jobs/…/ssc-dataA`, orphaned to PPID 1) and its **maker-lab bundle child held the
  PRODUCTION `crow.db` open**. Killed. grackle's unit has `ExecStartPre=kill-orphan-gateways.sh`;
  **crow's does not** — give crow the same guard, and make scratch gateways die with their session.

<details><summary>Original entry (design complete, build not started)</summary>

**2a. pruneStaleAdvertisedContacts resurrection — ✅ DESIGN COMPLETE (spec v4, 3 adversarial
rounds), ⏳ BUILD NOT STARTED (deliberate stop).**
Spec: `docs/superpowers/specs/2026-07-12-advertised-contact-prune-design.md`.
Branch `fix/advertised-contact-prune` (spec + this doc only; **no code**).

**Read the spec before touching code — three designs died in review, and the reasons are
not obvious.** v1 (prune broadcasts a delete-wins tombstone) → R1 REVISE; v2 (local-only
tombstone) → R2 REJECT; v3 → R3 REJECT; **v4's architecture was attacked directly by R3 and
held.** The surviving insight: **`origin` is a *judgment* ("I may GC this") — view-relative,
must NOT sync. "Instance X advertised this bot" is a *FACT* — it syncs safely, and lets every
instance re-derive prunability from its OWN view.** That converges with no broadcast, no host
authority, and protects the bot's host for free.

**⚠️ TWO SCOPE CHANGES vs this plan's original assumptions:**
- **2a now carries a SCHEMA BUMP (6→7)** — a new `contacts.advertised_by_instance_id` column.
  So 2a, not just 2b, needs the §3 migration rail. (Every schema-free design was proven unsound.)
- **The §3 rail itself was insufficient and has been corrected** (see the ⚠️ block there). This
  gates **2b** too. **Recommendation: fix the rail as its own small PR FIRST.**

Three real bugs found on the way, filed as follow-ups (details in spec §6/§7):
- **[REAL, shipped code]** `emitChange` returns a valid lamport when `outFeeds.size === 0`
  (`instance-sync.js:1027-1036`), so **#155's user-initiated contact delete**, in the boot
  window, tombstones locally, broadcasts to **nobody**, and then silently drops the peer's
  updates ⇒ permanent divergence, no error. `backfillContactsOnce:612` already guards that exact
  window (its comment records it *observed live on grackle*). **→ fold into 2c.**
- **[LATENT]** Every `origin='local-bot'` guard is weaker than it reads — a bot's host usually
  has **no contacts row for its own bot** (only 1 such row exists fleet-wide, on MPA), so
  `shouldSyncRow:204` / `deleteContactLocal:143` / `wireSyncedContact:111` are near-inert.
- **[TODAY]** `getBotDirectory` **prunes as a side effect of a read** (`data-queries.js:275`) —
  so the add path would durably delete contacts.

*Acceptance (unchanged, and v4 delivers it):* a pruned advertised contact stays gone on BOTH
sides across a full sync cycle AND a restart of each side; a still-live advertised contact
continues to sync normally (negative control); `sync_conflicts` does not grow. **Plus:** the
mutual-prune-then-re-add lamport-tie test (spec §5.6) — v3 shipped a permanent-divergence bug
that every other test passed.

**Live-state note that shapes the build:** *nothing on the fleet is advertised*
(`allow_paired_instances` is false on all 3 bot defs), so **the prune has never fired** and the
defect is doubly latent. There is **no urgency** — the bar is `fix-the-product` (correct on a
fresh install). The live proof must CREATE a throwaway advertised bot on grackle.

</details>

**Live-verified on production (2026-07-12), advertiser = crow, adder = grackle** — the full F4 trigger
matrix against real signed federation: a bot un-advertised by its advertiser was **PRUNED**, with the
tombstone at **the pruned row's own lamport (4400), `kind='prune'`** — while, in the same pass, a row
whose advertiser is *the host itself* was **KEPT** (rule 1), a **NULL-provenance hand-pasted** row was
**KEPT** (#155 §2.6), and a row **with a message** was **KEPT** (rule 5, history never destroyed). The
prune put **nothing on the wire** (peers hold no tombstone and no row), it survived a **full gateway
restart**, and `sync_conflicts` did not move on any of the four boxes (219/182/162/0).

---

**2a-FU. ✅ SHIPPED 2026-07-13 — PR #180 (main `e38c4d21`), fleet-deployed + live-verified.**
All four findings closed in one PR (no schema bump; rail not needed; auto-update stayed ON,
confirmed `true` ×4 after). Outcomes: (1) dry-run gate now diffs per-table `PRAGMA table_info`
— **2b is un-gated**; (2) grackle bot-advertise root cause was `CROW_DB_PATH` in its `.env`
(the gateway's `.env` loader was the premise the old repro missed) short-circuiting the seed
anchor — fixed product-wide via `instanceSeedDir()` = `resolveDataDir()`, **live-proven**: a
probe bot advertised on grackle reached crow `complete:true` with a cryptographically valid
invite, then was cleaned up; (3) MPA's creds were **never broken** — the 07-12 errors were the
probe reading crow's token file (no `CROW_PEER_TOKENS_PATH`); proven by signed fetches
returning 200 from both peers; product hardening: `peer-credentials.js` honors `CROW_HOME`,
resolved at call time (ESM hoisting); **no re-pair happened or is needed**; (4) in-repo
orphan sweeper (cgroup-ownership protection, subtree reaping, pid-reuse-safe) + installer
(ExecStartPre drop-ins + 1-min sweep timer, non-root) **installed on crow/grackle/black-swan**;
grackle's host-local script is now a shim to the repo sweeper (backup kept:
`~/bin/kill-orphan-gateways.sh.pre-2afu.bak`); parent-watch die-with-session **live-proven**
(killed a scratch gateway's parent; it self-terminated logging the orphan line; `fuser` clean).
Suite baseline note: shellcheck is installed on crow now, so the known-failures baseline is
**3 fail / 0 skip** (two pre-existing crow-install.sh lints were fixed in the PR).

<details><summary>Original 2a-FU work order (historical)</summary>

**2a-FU. The four production problems Item 2a uncovered — ONE PR, and it goes BEFORE 2b.**
**Kevin authorized this explicitly (2026-07-12): "let's be sure to follow up on those bugs with their
own PR."** Memory: `crow-fleet-findings-2026-07-12.md`.

**Why before 2b:** finding (1) below **gates 2b** — 2b is another schema bump, and the dry-run gate
cannot presently prove a migration actually *landed*. And findings (2)+(3) mean **the feature just
shipped in #177 cannot actually work anywhere on this fleet**: no box can advertise a bot, and MPA
can never prune. 2a is correct code that is currently inert in production.

1. **[GATE — do this first] `scripts/schema-migration-dryrun.sh` is blind to `ALTER TABLE ADD COLUMN.`**
   It diffs `sqlite_master` **object names**, so a new column is invisible. It proves nothing was
   LOST; it **cannot prove your migration HAPPENED** (both of 2a's columns had to be hand-verified).
   *Fix:* add a per-table `PRAGMA table_info` diff (name+type), and report added/removed columns
   alongside the existing row-count diff. *Acceptance:* run it against a copy of a prod DB from a
   branch that adds a column — the column MUST appear in the output; and a branch that adds nothing
   must still report clean.

2. **[REAL BUG] grackle can NEVER advertise a bot.** `botIdentityFor` opens
   `/home/kh0pp/crow/data/identity.json` (the **repo** dir) instead of `~/.crow/data/identity.json`,
   so `buildAdvertisementPayload` skips every bot and grackle's advertised list is always empty.
   **⚠️ ROOT CAUSE IS NOT ESTABLISHED — DO NOT GUESS AND DO NOT "FIX" IT BLIND.** Re-running the exact
   resolution under systemd's environment (`HOME=/home/kh0pp`, no `CROW_*`, cwd `/home/kh0pp/crow`)
   yields the **CORRECT** path, so the running gateway disagrees with a faithful repro and that gap is
   unexplained. **Load-bearing:** grackle's `~/.crow/data/crow.db` is a **SYMLINK** (29 bytes) into the
   repo's `data/crow.db` (the real 183 MB file); `~/.crow/data/` holds `identity.json` + `instance-id`,
   `~/crow/data/` does **not**. Any fix must respect that layout. *Start by instrumenting the RUNNING
   gateway* (log what `botsDbPath()`/`resolveDataDir()` actually return in-process) rather than
   reasoning from the source. *Acceptance:* a bot advertised on grackle appears in crow's directory
   with `complete:true`; `fix-the-product` — it must also be right on a fresh install.

3. **[REAL BUG] MPA's federation credentials are broken.** From MPA: `missing_peer_credentials` → crow,
   `hmac_mismatch` → grackle. Its bot directory is therefore always empty and **it can never prune**
   (fail-safe, but wrong). crow↔grackle federation is fine, so this is specific to MPA's registry.
   *Decide deliberately:* a credential repair vs. a re-pair ceremony (the latter is an operator matter —
   ask Kevin before any re-pair). *Acceptance:* MPA fetches crow's advertised-bots with `status:"ok"`.

4. **[LEAK] a scratch gateway from a previous session ran for 2 DAYS on the prod DB.** pid 960187,
   port 3495, `CROW_DATA_DIR=…/jobs/…/ssc-dataA`, orphaned to PPID 1 — its own DB was scratch, **but
   the maker-lab bundle server it spawned resolved to the PROD bundles dir and held
   `~/.crow/data/crow.db` open.** (Killed 2026-07-12.) This is the leaked-gateway class behind past
   `database is locked` crash-loops. *Fix:* crow's unit has **no** `ExecStartPre=kill-orphan-gateways.sh`
   (grackle's does) — add it, and make scratch gateways die with their session. *Acceptance:* start a
   scratch gateway, kill its parent, confirm it and its bundle children are reaped and that nothing but
   the systemd gateway holds `~/.crow/data/crow.db` (`fuser`).

*Ship:* one branch, full §2 pipeline. (1) and (4) are mechanical. (2) is an **investigation** — if the
root cause cannot be established honestly, the correct output is a written diagnosis + a recommendation,
NOT a guessed patch. (3) may need Kevin for the re-pair decision.

</details>

---

**2b. contact_groups offline-peer tombstones — ✅✅ SHIPPED 2026-07-13 (PR #181, main `e25d718b`), fleet-deployed + live-verified, auto-update back ON (`true` ×4).**
Spec: `docs/superpowers/specs/2026-07-13-group-tombstones-design.md` (v3; two adversarial
rounds — R2 found 3 blockers INSIDE R1's fixes, the 2a pattern caught in prose). Design:
**STRICT delete-wins keyed on group_uid, NO lamport gate** — sound because the
`contact_groups_group_uid_ai` trigger makes every genuine re-create a fresh random uid,
and a #155-style lamport-gated tombstone provably does NOT fix the mutual case (the
higher-lamport offline rename passes the gate). W1 atomic batch + room routing; W2
unconditional tombstone+delete with truthful winner/loser; G1 STATEMENT-level
`NOT EXISTS` guards (per-peer drains interleave at await boundaries); W3 legacy
deterministic-uid check; W4 FLAGLESS every-boot re-emit (per-peer flags survive
revoke/re-pair); G2 fail-open emit gate; G3 conflict-restore guard. Bonus: the dry-run
gate's object-diff was **pipefail-inverted** (always printed "(none)"); fixed on the
branch, removed index/trigger/view now a STOP.
**Rail executed in full:** auto-update off ×4 → fifth-DB sweep (found grackle's dormant
`~/casa-nueva/home-finance/data/crow.db` — the db.js:22 "finance" instance, no service,
not migrated) → backups ×4 → dry-run gate FROM the branch ×4 (`+ table group_tombstones`
sole delta, 7→8, zero row deltas) → merge → manual deploy in runbook order → verify
(gen 8 + integrity ok + counts ×4) → re-enable + confirm `true` ×4.
**Live proof (real gateways, minted session, real HTTP):** probe group created on crow →
synced to grackle; grackle STOPPED; delete on crow (W1: row+tombstone atomic, lamport
4386); offline rename on grackle at lamport 9999; grackle restart → **strict delete-wins
beat the newer rename** (row gone, tombstone 4387, exactly ONE truthful conflict row
delete|4387|9999); second restart → **`W4: re-emitted 1 group tombstone delete(s)`** in
the journal, crow no-oped, zero conflict growth. MPA converged as a free third instance.
Probe artifacts cleaned; conflicts back to baseline 219/182/162/0.
**Suite: 1769 tests / 3 known fails / 0 skips (new baseline: +31 tests).**
Observations for follow-up (NOT defects introduced here): black-swan received neither
the create nor the delete — its crow feed looks dormant (pre-existing; its HTTP signed
fetches work per 2a-FU); `backfillProvidersForNewPeers`' per-peer flag survives
revoke/re-pair (same class W4 avoids — pre-existing hole, own PR).

<details><summary>Original 2b work order (historical)</summary>

**2b. contact_groups offline-peer tombstones.** Group delete PROPAGATES live
(`emitGroupDelete` exists and is wired at `panels/contacts/api-handlers.js:323`), so
this is **a missing-tombstone gap, not a missing emit** — a peer OFFLINE at delete time
re-advertises the group later and resurrects it fleet-wide. `contact_tombstones`
(`scripts/init-db.js:1884` + `servers/sharing/contact-delete.js`) is the #155 precedent
that fixed exactly this class for contacts, delete-wins. Mirror it for groups: tombstone
keyed on `group_uid`, delete-wins on apply, retention pruning.
**Files: `servers/sharing/group-sync.js` + `scripts/init-db.js` (DDL) +
`servers/shared/schema-version.js` (the `SCHEMA_GENERATION` bump).**
**⚠️ This is the schema-bumping PR — the auto-update migration rail in §3 is MANDATORY
here.** (Disable auto-update fleet-wide → back up all three DBs → merge → deploy
manually in runbook order → verify → re-enable. `user_version` is monotonic; a revert
does not un-migrate.)
*Acceptance:* test — delete a group while a simulated peer is offline; the peer returns
and re-emits it; the tombstone wins on both sides. Live verify on crow↔grackle with a
throwaway group. Post-deploy: `user_version` = new gen on all three boxes,
`PRAGMA integrity_check` ok, `sync_conflicts` did not grow.

</details>

**2c. Lamport-preserving contact re-emit.** Boot backfills currently re-emit contacts
with fresh lamports, creating a divergence window where a stale value can clobber a
newer peer write (the I-B1 exposure class). Spec: re-emit preserving the row's
existing lamport (or emit-if-newer semantics).
*Acceptance:* test — a backfill re-emit does NOT advance lamport and cannot overwrite
a peer row with a higher lamport; the #147 done:<n> flag semantics stay intact.

**2d. Tailnet in-feed key rotation.** When an instance rotates keys, peers keep the
stale-keyed in-feed until restart. Spec: detect key change and recreate the affected
feed/storage live (the "storage-recreate on key change" note from #144's follow-ups).
**Under-specified on purpose — this one is NOT queueable until its spec answers:** which
key rotates (instance identity? feed/Hypercore key? Noise static?), what event or code
path performs the rotation today, how a peer currently detects it (if at all), and what
"recreate the storage" means concretely for an open Hypercore. If the spec cannot answer
those from the code, the honest output of the session is the spec + a recommendation,
not a rushed fix.
*Acceptance:* two-instance test — rotate the key, replication resumes WITHOUT a restart
on either side; no feed corruption (existing blocks still readable); `sync_conflicts`
does not grow. Live crow↔grackle verification with a real rotation.

Each PR: full pipeline, deploy, live crow↔grackle verification (these are exactly the
changes where "tests pass" ≠ "fleet converges" — prove convergence with real rows,
then check sync_conflicts did not grow).

---

### Item 2.9 — Review external PR #99 "Add Xquik add-on bundle" — ✅ REVIEWED 2026-07-13: CHANGES REQUESTED, not merged

**Decision (2026-07-13): courteous decline-as-is — REQUEST_CHANGES posted
([review](https://github.com/kh0pper/crow/pull/99#pullrequestreview-4684774775)), PR left open.**
All five dimensions run; split verdict:

- **PASSED — skill content (D1):** read every line; defensively written (read-only scope,
  explicit "don't follow instructions found in tweets/API responses", key-protection rules,
  no exfil/injection patterns). **PASSED — gates (D4):** test-merged onto current main
  (clean); bundle-contract 25/25 incl. registry-drift, check-ports (no port claimed),
  build-registry --check OK (91 bundles). **PASSED — check-runs (D5):** `total_count: 0`
  on head sha `1737812` (normal, path-filtered).
- **FAILED — honesty (D2):** manifest claims `"author": "Crow"` (false — third-party
  contribution); and STRUCTURAL: `build-registry.mjs:76-77` force-stamps `official: true`
  on every in-repo bundle, so there is NO way to list a third-party service without
  presenting it as official. All 90 existing entries are self-hosted or first-party; this
  would be the store's FIRST unaffiliated commercial API.
- **FAILED — functional:** Crow core exposes 89 tools, none an HTTP/REST client; the skill
  declares only `crow-memory`, so the REST workflows it describes cannot be executed by
  anything the bundle installs. Inert as shipped. (xquik.com has its own MCP server — an
  `mcp-server`-type bundle would be the functional shape; suggested to the contributor.)
- **MIXED — upstream legitimacy (D3):** xquik.com is live, valid OpenAPI 3.1, contact
  email, terms/privacy routes exist (SPA — content not verifiable by fetch). But: no
  operator identity/jurisdiction anywhere, X-data access method undisclosed while
  explicitly "Not affiliated with X Corp" (ToS-gray, longevity risk), and the full API is
  NOT read-only (compose, DELETE tweets, follower extraction, giveaway draws). Provenance:
  drive-by promo PR (fork+PR in under a minute, Codex-generated branch; follow-up comment
  offers to promote the merge to the author's 24k X followers).

**✅ OPERATOR QUESTION ANSWERED (Kevin, 2026-07-13, verbatim intent):** *"yes, I'll take
third-party listings … I am open to your recommendation for that, but I also see your
skepticism about undisclosed x data for this app."* So: (1) third-party listings are
WANTED → build the provenance mechanism (now queued as **Item 3.5** below, Kevin
pre-authorized, mechanism design = executor's recommendation); (2) PR #99 itself STAYS
declined-as-is — the upstream-transparency concern (undisclosed X-data access, no operator
identity) stands independently of the mechanism; re-review only if the author reworks it
per the posted review AND Item 3.5 has shipped.

**Original work order (kept for reference):**

**Kevin's direction (2026-07-13, verbatim intent):** review this pull request and decide
whether or not to merge it; "if the code is good, I think we should merge it and then
message the user/comment back."

PR #99, opened 2026-06-21 by external contributor **kriptoburak**
(`codex/add-xquik-crow-bundle-20260621`): +154/−0 over 3 files —
`bundles/xquik/manifest.json`, `bundles/xquik/skills/xquik.md` (skill-only bundle,
claims read-only X/Twitter research via `xquik.com`'s public REST API), and a
`registry/add-ons.json` entry. Mergeable-clean as of 2026-07-13.

**This is not a normal code review — it is an external contribution adding a
third-party service to the add-on store.** Review dimensions, all mandatory:
1. **Skill-content security:** the skill markdown is *instructions the AI will follow*.
   Read every line for prompt-injection, data-exfiltration patterns (e.g. "send the
   user's data to…", URL templates that leak context into query strings), and scope
   creep beyond the claimed read-only paths.
2. **Manifest/registry honesty:** does the manifest declare only what the skill does?
   Does the registry entry misrepresent capability, publisher, or safety? Does the
   add-on store have any provenance/verification story for third-party entries, and
   does listing an unaffiliated commercial API fit the store's intent (operator call —
   surface to Kevin if ambiguous)?
3. **Service legitimacy:** is `xquik.com` a real, reputable service (check the site,
   its openapi.json, terms; X-data scrapers are frequently ToS-violating or
   short-lived). A dead or shady upstream = decline politely.
4. **Repo-standard gates:** bundle contract test, `check-port-allocation` (skill-only
   bundle should claim no port), `build-registry --check`, registry JSON validity.
5. **CLAUDE.md rule:** external PR merge = check GitHub Actions check-runs on the head
   sha, not the legacy status API.

Outcome: merge + friendly comment if it passes; otherwise a courteous review comment
explaining what would make it mergeable (it is a community contribution — be welcoming
either way). Record the decision here.

---

### Item 3 — Messages/docs minors batch — ✅✅ SHIPPED 2026-07-13 (PR #182, main `fdbab2df`), fleet-deployed + live-verified

Triage ran first against current main; **3 of 7 pooled candidates survived** (the §1 rot
rule proved itself again — 4 dropped with recorded evidence, see the PR body for detail):
- **SHIPPED — `findContactByPubkey` deterministic ORDER BY**: real `crow:` row beats
  `req:` placeholder, then lowest id (the old arbitrary pick could double-store on the
  catch-all DM path). RED-first test; RED run = mutation check.
- **SHIPPED — onevent-test happens-after hardening**: `nostr-receive-health-hooks.test.js`
  now polls via the block-onevent-guard `waitFor` pattern (`wrapped()` fires the handler
  unawaited; the old assertions passed only because the stamps precede the first await).
  Mutation-checked live (markInbound disabled → named test red).
- **SHIPPED — F-UI-2 invite page**: light-mode `.code`/`button` were dark-on-dark
  (contrast 1.07:1); now 15.25:1, dark mode unchanged. deploy-docs succeeded; **live URL
  CDP-verified post-deploy** (evidence `~/.crow/p4/item3-minors/`). Rollback = revert
  `docs/public/invite/index.html`, deploy-docs re-runs.
- **DROPPED — null-syncManager no-heal**: DEAD — manager constructed unconditionally
  (`mcp-mounts.js:28`) before the `:30` getter; `feedsDisabled` no-op is deliberate
  (R2 MAJOR-A, `profile-heal.js` docblock).
- **DROPPED — `req:`-row delete propagation**: deliberate per-instance design
  (`messages/api-handlers.js:351`, `contact-delete.js` §D3); no resurrection bug
  (`req:` rows never sync). Cross-instance dismissal = sync-layer design work, not a minor.
- **STRUCK — F-SETTINGS-2**: the two live keys were fixed by #165; live sweep of all 27
  registered settings sections = zero raw keys. Remaining missing labelKeys are in
  UNREGISTERED legacy files (`panels/settings.js:52`) — dead code.
- **NOT A DEFECT — black-swan dormant crow feed** (follow-up-pool item): the crow↔bswan
  pairing was deliberately deleted at the messages-arc close (07-11); bswan runs its own
  identity (`crow:3n6dimacvr`) and is not expected to receive instance-sync events.
  Side observation for the operator re-pair (§0 out of scope): grackle still holds a
  stale trusted "Cloud (black-swan)" instance row and dials bswan's tailnet-sync
  endpoint ~1/min → `handshake sig invalid` spam in bswan's journal.

Post-deploy soak: health ok ×4, integrity ok, sync_conflicts 219/182/162/0 (baseline),
stash 4/17, auto-update `true` ×4, zero err-level log lines. Suite baseline unchanged:
1769 pass / 3 known fails / 0 skips.

<details><summary>Original work order (historical)</summary>

Pooled accepted minors; batch them like PR #170. **Run a triage pass FIRST** — confirm
each still reproduces, and drop the ones that don't (F-INSTALL-11 was already fixed;
expect others to be too). The batch PR contains only what survived triage.
- onevent-test happens-after hardening (sharing tests' event-ordering assumption).
- `findContactByPubkey` deterministic `ORDER BY` (multi-row pubkey matches).
- null-syncManager no-heal guard (boot heal path when sync is disabled).
- `req:`-row delete propagation (deleting a message-request row doesn't tombstone).
- F-SETTINGS-2: raw i18n keys visible in Settings. **This is a research task, not a
  fix — #165 shipped label fixes that may already cover it.** Reproduce in the live UI
  first; if it's gone, strike it and say so. Do not carry it into the PR unverified.
- **F-UI-2 (maestro.press invite page, dark-on-dark code box) — ✅ AUTHORIZED.** Kevin
  confirmed 2026-07-12: *"yes, blanket auth extends to public site."* Ship it. It is still
  a **public-web** change, so it carries a rollback story: it publishes via the
  `deploy-docs` workflow → GitHub Pages; verify the live page after the run completes, and
  know how to revert (re-push the prior CSS) if it renders wrong.

*Acceptance:* per-minor test where testable; CDP screenshot for any UI one; suite green
(scratch env); one PR, merge, deploy, live verify. State plainly in the PR body which
pooled items were dropped at triage and why.

</details>

---

### Item 3.5 — Registry provenance — ✅✅ SHIPPED 2026-07-13 (PR #183, main `997320e4`), fleet-deployed + live-verified

The recommended design shipped essentially as written, plus one review-driven addition:
- Manifest `origin` enum (`official` default | `community`) in `registry/manifest.schema.json`;
  bogus values fail the schema → bundle invalid, never published.
- `build-registry.mjs` DERIVES `official: origin !== "community"` (manifest `official`
  still stripped — a community manifest cannot smuggle the Official badge); `origin`
  passes through. **Committed registry regenerated byte-identical** (nothing declares
  `origin` yet).
- Store bridge: `data-queries.js` `_community: a.official === false` — the pre-existing
  community-store badge/caution/featured-exclusion machinery now covers in-repo
  third-party entries. `official`-absent remote entries conservatively stay first-party.
- **Review MAJOR → enforcement added:** `validateCollectionServerSide` rejects
  `origin: "community"` members (community bundles can never ride one-click
  install-set), plus a static curation gate in `tests/extensions-collections.test.js`.
  Reviewer-traced: provenance flags never touch install resolution (id-only, local
  bundles/ dir).
- Docs: `docs/developers/bundles.md` "Contributing a third-party bundle" (origin
  declaration + the listing bar: disclosed operator, accurate author, functional
  out of the box, scope honesty).

Pipeline: RED-first tests ×3 rounds (+8 tests total), mutation checks on the derivation
and the collection guard; 2 review rounds (FIX FIRST 2 MAJORs → both closed → READY TO
MERGE). CDP proof on scratch gateway 6/6 (fixture Community badge + tooltip + modal
caution; Official control clean) — evidence `~/.crow/p4/item35-provenance/`. Suite 1775
pass / 3 known / 0 skips. Deployed crow+MPA/grackle/bswan at `997320e4`, health ok ×4,
soak at baseline, deploy-docs success. Prod store live-checked: zero community-badged
cards (registry unchanged — correct).
**Operator note:** `bundles/rookery/manifest.json` declares `official: false` — a dead
field (ignored before and after). If rookery should carry the Community badge, set
`origin: "community"`; that changes its live store card, so it is Kevin's call.
**PR #99 stays declined-as-is** (upstream transparency) — if reworked per its review,
this mechanism is now ready for it.

<details><summary>Original work order (historical)</summary>

**Why (Kevin, verbatim intent):** "yes, I'll take third-party listings … I am open to
your recommendation for that." First external offer was PR #99 (Item 2.9) — declined
partly because the store STRUCTURALLY cannot list a third-party bundle honestly:
`scripts/build-registry.mjs:76-77` strips any manifest `official` field and force-stamps
`official: true` on every in-repo bundle.

**Recommended design (executor's call per the grant — validate against current code
first, §1 rule):** manifests gain an optional `origin` field (`"official"` default |
`"community"`); build-registry honors it instead of force-stamping (`official:
origin !== "community"` for back-compat, plus the `origin` field passed through);
the Extensions store UI renders a visible "Community" badge (and a one-line "not
maintained by Crow" note in the install modal) for community entries; bundle-contract
test covers the field; docs (`docs/developers/bundles.md` or creating-addons) gain a
"contributing a third-party bundle" section stating the bar: real upstream with
disclosed operator + terms, accurate `author`, functional out of the box.
*Acceptance:* a fixture community bundle round-trips through build-registry with
`origin: "community"` and no `official: true`; existing 91 bundles unchanged
byte-for-byte in the generated registry; CDP proof of the badge on a scratch gateway;
suite + gates green. Small single PR.
**Note:** PR #99 remains declined-as-is regardless (upstream transparency), per the
Item 2.9 record.

</details>

---

### Item 4 — THEME: Generalization + first-run experience (planning session first)

**PLANNING SESSION DONE 2026-07-13.** Reviewed spec (3 adversarial rounds, all
findings folded): `docs/superpowers/specs/2026-07-13-generalization-firstrun-design.md`.
**Build from the spec, not from the text below** — the spec's §1 rot report
supersedes this item's 2026-07-11 claims (notably: 4c largely shipped already;
the real 4a root is the repo-shipped `models.json` lab seed, which carries a
HARD pre-merge fleet gate in spec §2.1; F-ONBOARD-4's confirm field already
exists). PR seams: 4-PR1 seed+bot-builder honesty → 4-PR2 wizard steps →
4-PR3 identity backup → 4-PR4 hardcode sweep → 4-PR5 installer. No schema bumps.

**Why (Kevin, verbatim):** "his own personal preferences hardcoded into what is meant
to be a generalized, user-customizable app"; install "isn't actually easy for
non-technical users." Confirmed live on a fresh install (S3 walkthrough 2026-07-10):
the wizard walks a new user into creating an agent with ZERO providers configured and
a model dropdown listing the maintainer's lab models. Beachhead user = non-technical
public-education admin. This is `fix-the-product-not-the-instance` at product scale.

**Sub-scopes to spec in the planning session (suggested PR seams):**

- **4a. Per-install model/provider discovery.** Kill hardcoded model lists. Verified
  hardcode sites (2026-07-11): `panels/bot-builder/data-queries.js:193`,
  `panels/bot-builder/api-handlers.js:35`, `panels/bot-builder/html.js:55` (default +
  selected `crow-local/qwen3.6-35b-a3b`); audit further: companion model routing
  defaults, `scripts/pi-bots/model_resolver.mjs` LOCAL_FALLBACK, any orchestrator
  bundle defaults. Model pickers must derive from the live `providers` table /
  `/llm/v1` router (resolve-profile is already DB-providers-first — extend that
  pattern); empty state = honest "no models yet — add a provider" with a link, never
  a phantom list. (= F-ONBOARD-2's root.)
- **4b. Onboarding hardening.** F-ONBOARD-1 [MAJOR]: the wizard never surfaces an
  identity/seed backup and the seed lives plaintext in `~/.crow/data/identity.json`
  (verified 2026-07-11: keys `version, crowId, ed25519Pubkey, secp256k1Pubkey,
  createdAt, seed`) — a lost box = permanently lost identity, and the user is never
  told. Note a CLI path already exists (`npm run identity:export` / `identity:import`
  → `servers/sharing/identity.js`), so the gap is product surface, not primitives:
  add a backup step in the wizard (recovery phrase or downloadable export) + a restore
  path, reusing those functions. F-ONBOARD-2
  sequencing: an "add an AI provider" step BEFORE "create an agent". F-ONBOARD-3:
  connect-AI-client instructions (kill the dead-end cloud-web callout). F-ONBOARD-4:
  password screen confirm/show-password/paste guard.
- **4c. Installer prerequisites.** Extensions are unusable without Docker; Tailscale
  is assumed. `scripts/crow-install.sh` should detect+offer-to-install both (or degrade
  with clear per-OS guidance — macOS has no headless Docker; the spec must decide
  per-platform behavior honestly, not promise auto-install everywhere).
  (**F-INSTALL-11 is STRUCK — already fixed:** `crow-install.sh:209` defaults the
  hostname rename to N, and `ask_yn` returns No on the headless path too. Left here as
  a worked example of the §1 rot rule.)
- **4d. First-run starter templates.** The onboarding wizard offers the themed
  collections (home server / education / research / development) — the
  `registry/collections.json` + one-click `/install-set` machinery from #173 already
  exists; this is wiring it into first-run (this was "item 4" split out of the
  extensions directive).

**Verification vehicle:** a fresh-install audit on a clean VM (or a wiped
black-swan-style box) — the S1/S2 wipe-install playbook from the P4 campaign is the
precedent; unattended-window safety rules apply. CDP walkthrough of the NEW wizard
end-to-end as the acceptance gate.

---

### Item 5 — THEME: Bot Builder UX overhaul + non-technical tutorial (Theme 9)

**Why (Kevin, verbatim):** "can we make the bot builder interface easier to use?
maybe make it all more intuitive, and a cleaner interface. i think we also need a
solid tutorial for using the bot builder written for non technical users."

**June-2026 audit (re-verify against current panel code before speccing — the
extensions overhaul and messages arc have NOT touched this panel, but check):** list
page → 4-field create form → 9 equally-weighted tabs (AI, Tools, Gateways, Tracker,
Skills, Permissions, Triggers, Sessions, Review), no wizard/templates/progress; Review
tab dumps raw definition JSON; permissions cryptic; heavy jargon ("pi", "MCP",
"regen .mcp.json", "escalate"); gateway setup needs raw platform IDs; ~15 hardcoded
English hint paragraphs not i18n'd. Assets: 103 `botbuilder.*` i18n keys, `.btb-hint`
infra, `shared/components.js`, `docs/guide/bot-builder.md` EN+ES.

**Recommended shape (from the audit; planning session confirms):**
1. Guided creation flow — "what channel do you want?" → channel setup → review &
   deploy; templates/presets (Email responder, Discord Q&A, Project manager);
   readiness checklist replaces raw JSON as the default Review view (JSON behind a
   disclosure).
2. De-jargon + i18n pass (EN+ES; migrate the hardcoded hints).
3. `docs/guide/bot-builder-tutorial.md` (EN+ES) — "Your first bot" for non-technical
   users, linked from the list page.

**Sequencing note:** do this AFTER Item 4a lands — the model picker inside the new
guided flow must be the discovery-driven one, not the hardcoded list.
CDP proof of the full guided flow is the acceptance gate.

---

### Standing activity — drive-as-user CDP bug-hunt rounds

Kevin's standing directive (2026-07-10): periodic rounds where the executor drives
the dashboard as a real user over CDP, files findings, and squashes them (Cluster A
alone: 4 bugs invisible to the suite). Recipes at `~/.crow/p4/cluster-a-evidence/`
and `~/.crow/p4/bughunt-20260711/`. **Cadence: run one round after each queue item
ships** (post-deploy, on prod, read-only-plus-existing-flows). Findings become minors
batches or, if design-shaped, new queue items appended to this doc.

---

## 5. Bookkeeping

- After each item: update this doc's queue (mark shipped, append discovered items),
  append the ledger block, and update the arc memory file
  (`~/.claude/projects/-home-kh0pp-crow/memory/` — one fact per file, update
  MEMORY.md index).
- Branch cleanup: `fix/maker-lab-location-independent` and
  `fix/auto-update-hardening` are fully merged — delete local+remote copies when
  convenient.
- If anything here contradicts live state, live state wins — fix the doc in the same
  PR that ships the item.

---

## 6. Review record

**Reviewed 2026-07-11.** An adversarial plan review was dispatched (fresh Plan
subagent, staff-engineer prompt: self-containedness, factual accuracy vs the repo,
autonomous-executor risk, ordering, scope, acceptance-criteria quality). **The
reviewer was terminated early by an API spend limit and did not deliver a verdict** —
it had flagged one path error before dying. The verification pass was therefore
completed by the authoring session directly, checking every asserted path, line
reference, command, and host layout against the live repo and fleet.

Defects found and fixed (all were in this doc, not in the code):
1. **Wrong path** — `servers/gateway/dashboard/bundles.js` does not exist; the
   install / install-set / env routes live in `servers/gateway/routes/bundles.js`.
   Fixed in Item 1 and 1c (with the verified seam line `bundles.js:156`).
2. **Stale SDD scripts path** — hardcoded superpowers `6.1.1`; installed version is
   `6.0.3`. Replaced with a version glob.
3. **Suite command under-specified** — there is no `npm test` script in package.json;
   the full suite is `node --test tests/*.test.js`. Stated explicitly, along with the
   two local gate scripts.
4. **black-swan runbook vague** — corrected to the verified layout: user `ubuntu`,
   tree `/home/ubuntu/.crow/app`, unit `crow-gateway.service`, passwordless sudo.
5. **Jargon undefined for a cold-start reader** — SDD, ledger, and CDP now carry
   one-line definitions where first used.
6. **Item 4b framing corrected** — `npm run identity:export` / `identity:import`
   already exist (`servers/sharing/identity.js`), so the seed-backup gap is a missing
   product surface, not missing primitives.

Spot-checks that PASSED unchanged: `panels/onboarding.js:34,74` (uniform `_blank`
scheme confirmed), `panels/bot-builder/{data-queries.js:193, api-handlers.js:35,
html.js:55}` (hardcoded `crow-local/qwen3.6-35b-a3b` confirmed at all three),
`panels/messages/data-queries.js:284` (`pruneStaleAdvertisedContacts` confirmed,
deletes `origin='advertised'` rows with no messages), `panels/contacts/api-handlers.js:323`
(`emitGroupDelete` wired — confirming 2b is a tombstone gap, not a missing emit),
`registry/collections.json`, `tests/{install-set-e2e,extensions-client-contract,auth-network}.test.js`,
`scripts/{check-port-allocation.js,build-registry.mjs,init-db.js,crow-install.sh}`,
and all three `~/.crow/p4/` evidence dirs.

### Round 2 — independent adversarial review (Opus, 2026-07-11, verdict REVISE → folded)

The review was re-run on Opus and completed. Verdict **REVISE**, with six critical
issues — **two of which would have caused a wrong build, and one of which could have
damaged all three production databases.** Every claim was independently re-verified
against the code/live fleet by the authoring session before folding. All six are now
fixed in this doc:

- **C1 — Item 1a was not buildable as written, and invited a secret leak.**
  `needsConfigKeys` is server-side (`routes/bundles.js:1725`) with no client-reachable
  surface; the old wording ("derivable live") would have pushed an executor to either
  give up or ship the parsed `.env` to the browser. 1a now mandates a new server surface
  (key names only, never values, with an explicit no-secrets assertion) and covers the
  single-`/install` case, which never emits a checklist at all.
- **C2 — Item 1b's recommended option would have broken the onboarding wizard.**
  `deepLink()` (`onboarding.js:33`, callers `:155/:157/:160`) is `_blank` **on purpose**
  — its docstring says it keeps the tour open behind the new tab. "One scheme for every
  card" would have navigated users out of the wizard mid-tour. 1b is now scoped to the
  done-step `renderActionCards` only, with `deepLink` explicitly out of bounds.
- **C3 — the suite gate ran 261 test files against PRODUCTION state.** `CROW_HOME`
  defaults to the real `~/.crow` (homedir-derived — a throwaway clone does not help),
  there is no CI test workflow, and `node --test` runs files in parallel. This is the
  exact mechanism behind both contamination incidents §3 already records. §2 now
  mandates the scratch-env invocation.
- **C4 — merging IS deploying, and the migration rail was unenforceable.** Auto-update
  is ON by default (6h) and runs `pull → init-db → restart` unattended. Item 2b bumps
  the schema; `user_version` is monotonic, so a revert does not un-migrate. §3 now
  carries a mandatory disable-backup-merge-deploy-verify-reenable rail, plus the note
  that the primary's "Skipped: another updater is running" is normal co-hosted behavior
  (crow-mpa-gateway wins the lock) and is NOT evidence auto-update is inert.
- **C5 — wrong `SCHEMA_GENERATION` path** (it lives at `servers/shared/schema-version.js:13`,
  not `scripts/init-db.js`) — the same defect class round 1 claimed to have swept, and
  Item 2b depends on it.
- **C6 — F-INSTALL-11 was already fixed** (`crow-install.sh:209` defaults to N). Struck,
  and the §1 rot rule was made explicitly global rather than per-item.

Suggestions folded: the public docs-site deploy now has a post-merge check (every item
ships one, since §5 edits this doc); check-ports has a mechanical green predicate
(exactly one error line, `Port 8090 (capstone-tracker)`); the 1b↔4d coupling is noted;
the baseline is date-anchored rather than sha-anchored; and the weak acceptance criteria
the reviewer named (1c's no-op proof, 2a's unnamed call site, 2d's undefined "key
change", Item 3's research-task-in-a-fix-batch) are tightened.

**Both open questions ANSWERED by Kevin, 2026-07-12 — no longer open:**
1. *Auto-update:* may be turned OFF when a migration needs it, but **must be turned back
   ON when the work is done.** Folded into the §3 migration rail.
2. *Public site:* the blanket authorization **does** extend to maestro.press. Item 3's
   F-UI-2 is unblocked (ship it with a rollback story).

Reviewer-verified-accurate, no action needed: `renderPendingChecklist`'s sessionStorage
consumption (`client.js:1341-1347`), the bot-builder hardcodes, `pruneStaleAdvertisedContacts`,
`emitGroupDelete` being wired, `contact_tombstones` as the #155 precedent, the identity.json
keys, the 1c seam, the evidence dirs, and the stash/sync_conflicts baselines.
