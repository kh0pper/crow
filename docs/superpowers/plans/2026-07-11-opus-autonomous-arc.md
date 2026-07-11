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

Baseline state when this plan was written (2026-07-11 night): fleet all on main
`845f3e41`, healthy; suite 1604 pass / 0 fail / 1 skip; sync_conflicts crow 219 /
grackle 162 / black-swan 0 (decreases are #124 retention-prune — only GROWTH is a red
flag); stash baselines crow 4 / grackle 17 (growth = auto-update stash regression);
PRs #163–#173 all merged (settings-scope, bug-hunt squash, bundle version-refresh,
maker-lab location-independence, auto-update hardening, providers owner-asserts,
follow-up minors, tailnet-dial minors, docs, extensions overhaul).

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

   Known local-only artifact: Kevin's untracked `bundles/capstone-tracker/` WIP makes
   check-ports error locally — it has 0 tracked files, so it is invisible to CI on the
   merged tree. Confirm that the ONLY check-ports error is that directory; do not
   "fix" or touch his WIP.
6. **Deploy fleet** (§3 runbook) → **live verify** — CDP browser proof for anything
   UI-facing (a curl 200 is not proof a page works), plus the item's own acceptance
   checks. Evidence under `~/.crow/p4/<item-slug>/` (screenshots + assertions.jsonl).
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
- Schema changes bump `SCHEMA_GENERATION` in `scripts/init-db.js`; the boot gate
  auto-migrates on restart. FTS-shadowed tables need trigger updates in the same file.
- `fix-the-product-not-the-instance`: every fix must work on a fresh single-click
  install, not just this fleet.

---

## 4. The queue

Execute top to bottom. Items 1–3 are well-scoped single PRs (or one small PR each).
Items 4–5 are THEMES: run a planning session first (brainstorm → spec → 2-round
adversarial review → break into PRs), then execute the PRs one at a time through §2.

---

### Item 1 — Extensions follow-up pool (one PR; Kevin's go-ahead already given)

**Why:** three accepted follow-ups from the shipped extensions overhaul (PR #173).
Small, adjacent, zero design risk. Code lives in
`servers/gateway/dashboard/panels/extensions/client.js` (+ `.../extensions/html.js`),
`servers/gateway/routes/bundles.js` (the install/install-set/env routes — NOT under
`dashboard/`), `servers/gateway/dashboard/panels/onboarding.js`, and
`tests/install-set-e2e.test.js`.

**1a. Checklist re-derive-on-demand.** Today the post-install NEEDS_CONFIG checklist
is one-shot: `renderPendingChecklist` consumes the sessionStorage entry at load, and
closing the modal without configuring loses the proactive checklist until reinstall.
The data is derivable live: `needsConfigKeys` already derives from the bundle manifest
vs the live `.env`. Spec: add an affordance (e.g. a "Needs configuration" pill/button
on an Installed card whose bundle has unmet `needsConfigKeys`) that re-opens the same
Configure (env-only) modal on demand — no sessionStorage dependency.
*Acceptance:* a bundle with unmet config keys shows the affordance after a full page
reload with clean sessionStorage; clicking it opens Configure scoped to the missing
keys; a successful save clears the affordance without reinstall; a bundle with no
missing keys never shows it. Client-contract test (linkedom+vm, extend
`tests/extensions-client-contract.test.js`) + CDP proof on a scratch gateway.

**1b. Onboarding action-card target decision (all-or-none).** All onboarding cards
open `target="_blank"` (uniform scheme, `panels/onboarding.js:34,74`). For INTERNAL
dashboard links (e.g. the collections card → `/dashboard/extensions#collections`)
a new tab is odd UX. Decide and implement ONE of: (a) same-tab for internal hrefs
(path-relative), new-tab only for external — recommended; or (b) keep uniform _blank
and document why. Whichever way, change ALL cards consistently, keep
`rel="noopener"` on every remaining _blank, and update the CDP assertion recipe
(9b asserted in the opened tab — that assertion inverts under (a)).
*Acceptance:* one scheme, applied to every card; test executes the renderer and
asserts the `target` attribute per card class; CDP click-through proof.

**1c. T12 timer→barrier pacing.** `tests/install-set-e2e.test.js` paces the
install-set busy-gate window with `_setInstallSetStepDelayForTest(150)` (the seam is
`servers/gateway/routes/bundles.js:156`, consumed at ~:1939 and 0 in production) plus
setTimeout sleeps. Replace the timer coupling with a deterministic barrier promise
(the test seam resolves a promise the runner awaits), keeping the prod default a true
no-op.
*Acceptance:* test passes with zero wall-clock sleeps in the busy-gate section; the
seam's prod-path no-op is proven (default value short-circuits); mutation check: break
the barrier order, a named assertion goes red.

**Ship:** one branch `fix/extensions-follow-up-pool`, suite + gates green, CDP
evidence in `~/.crow/p4/ext-followups/`, PR, merge, fleet deploy, live verify
(1a affordance on a real bundle-with-missing-key on scratch; onboarding card behavior
on prod read-only).

---

### Item 2 — Sync-layer design leftovers (four separate PRs, in this order)

These were explicitly deferred as "design-shaped, own session each." Each gets a spec
+ 2-round adversarial review (this layer has bitten us repeatedly — key-rebind,
lamport ties, offline-peer resurrection). All four live in `servers/sharing/`
(`contact-sync.js`, `group-sync.js`, `tailnet-sync.js`, `instance-sync.js`) +
`servers/gateway/dashboard/panels/messages/data-queries.js`.

**2a. pruneStaleAdvertisedContacts resurrection.** The prune
(`messages/data-queries.js:284`) deletes bot-advertised contact rows that are no
longer live, but deleted rows can resurrect via sync because the delete doesn't
propagate correctly — the documented-inert fix must move to where `origin` is set
(the `shouldSyncRow` approach was proven inert per #155 R2 MAJOR-2; do not retry it).
*Acceptance:* two-instance test — a pruned advertised contact stays gone on both
sides across a sync cycle + restart; a live advertised contact still syncs.

**2b. contact_groups offline-peer tombstones.** Group delete PROPAGATES live
(`emitGroupDelete` exists and is wired in `panels/contacts/api-handlers.js:323`), but
there is no tombstone table — a peer OFFLINE at delete time re-advertises the group
later and resurrects it fleet-wide (the exact class `contact_tombstones` fixed for
contacts in #155, delete-wins). Spec: mirror #155's design for groups (tombstone on
group_uid, delete-wins on apply, retention pruning), including the SCHEMA_GENERATION
bump + boot-gate migration.
*Acceptance:* test — delete a group while a simulated peer is offline; peer comes
back and re-emits the group; the tombstone wins on both sides. Live verify on
crow↔grackle with a throwaway group.

**2c. Lamport-preserving contact re-emit.** Boot backfills currently re-emit contacts
with fresh lamports, creating a divergence window where a stale value can clobber a
newer peer write (the I-B1 exposure class). Spec: re-emit preserving the row's
existing lamport (or emit-if-newer semantics).
*Acceptance:* test — a backfill re-emit does NOT advance lamport and cannot overwrite
a peer row with a higher lamport; the #147 done:<n> flag semantics stay intact.

**2d. Tailnet in-feed key rotation.** When an instance rotates keys, peers keep the
stale-keyed in-feed until restart. Spec: detect key change and recreate the affected
feed/storage live (the "storage-recreate on key change" note from #144's follow-ups).
*Acceptance:* two-instance test — rotate, verify replication resumes without restart.

Each PR: full pipeline, deploy, live crow↔grackle verification (these are exactly the
changes where "tests pass" ≠ "fleet converges" — prove convergence with real rows,
then check sync_conflicts did not grow).

---

### Item 3 — Messages/docs minors batch (one PR)

Pooled accepted minors; batch them like PR #170. Verify each still exists first:
- onevent-test happens-after hardening (sharing tests' event-ordering assumption).
- `findContactByPubkey` deterministic `ORDER BY` (multi-row pubkey matches).
- null-syncManager no-heal guard (boot heal path when sync is disabled).
- `req:`-row delete propagation (deleting a message-request row doesn't tombstone).
- F-UI-2: maestro.press invite page code box dark-on-dark (docs-site CSS, lives in
  the maestro-press static page — coordinate with the Deploy Docs workflow).
- F-SETTINGS-2: raw i18n keys visible in Settings (may already be fixed by #165's
  label fixes — verify in the live UI first).

*Acceptance:* per-minor test where testable; CDP screenshot for the two UI ones;
suite green; one PR, merge, deploy, live verify.

---

### Item 4 — THEME: Generalization + first-run experience (planning session first)

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
  is assumed. `scripts/crow-install.sh` should detect+offer-to-install both (or degrade with
  clear per-OS guidance — macOS has no headless Docker; the spec must decide
  per-platform behavior honestly, not promise auto-install everywhere). Include
  F-INSTALL-11: stop renaming the OS hostname to 'crow' by default.
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

**A future session should treat this doc as reviewed-but-not-independently-approved.**
Before Item 1, re-run the §1 anti-archaeology checks; if you have review budget, a
fresh adversarial read of §4 is still worth having.
