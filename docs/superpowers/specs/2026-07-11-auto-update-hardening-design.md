# F-UPDATE-1 — auto-update hardening design

Date: 2026-07-11 · Arc: post-Messages-arc follow-up pool, item (2)
Operator decisions (2026-07-11, AskUserQuestion): tolerant pull (no stash, no
pre-check — git's own overlap refusal is the gate); ALL FOUR guards approved
(branch guard incl. the manual button, O_EXCL lock w/ PID+staleness, --no-auth
default OFF, tolerant pull).
BUILD CONSTRAINT: branches AFTER PR #163 merges — both touch
servers/gateway/auto-update.js (#163 added tickCheck/_setDbForTest).
Review: R1 (adversarial, opus, git semantics empirically verified in real
temp repos) REVISE — 3 MAJOR (fake-success on the manual skip; double-acquire
reclaim race; branch-guard TOCTOU that fast-forwards an ancestor feature ref)
+ 5 minors — ALL FOLDED. R1 confirmed the D2 safety matrix empirically:
disjoint dirty survives byte-identical; overlap/delete/untracked-collision all
refused with tree untouched. R2 (adversarial, opus) REVISE-documentation-grade
— all 8 R1 folds CONFIRMED-FAITHFUL; NEW-1 honesty fix folded (rename is not
CAS: "exactly one winner" holds only among same-inode reclaimers; lapping
residual accepted with named backstops — owner-checked release, git
index.lock, separate crow/MPA DBs; sole real exposure = concurrent npm
install, rare∩rare) + NEW-2 message-in-sketch, NEW-3 runLockedUpdate seam,
NEW-4 §4.5 clarification, NEW-5 quarantine sweep. R2 also verified: crow/MPA
share the TREE but NOT crow.db (lock-skip status writes are per-instance);
restart releases the lock ~1.5s before exit.

## 1. Problem — the F-UPDATE-1 incident class (Cluster A, 2026-07-10)

During Cluster-A verification, auto-update's stash/pop popped a **June** stash
entry onto the working branch, staging 5 foreign files + UU conflict markers in
nostr.js. Recovery was lossless only because pop-on-conflict keeps the entry.
Four distinct defects in `checkForUpdates()` (auto-update.js:88-197):

1. **didStash false-positive** (:124-125): `didStash = !stdout.includes("No
   local changes")`. When `git stash` FAILS outright (index.lock held by a
   concurrent gateway/session, exit≠0, empty stdout), didStash is TRUE — and
   the later `git stash pop` (:133 or :156) pops **whatever is on top of the
   stash stack**, i.e. potentially another era's entry. This is the June-stash
   mechanism.
2. **No branch guard**: nothing checks what's checked out. Prod crow-gateway
   AND crow-mpa-gateway both have `WorkingDirectory=/home/kh0pp/crow`; a
   parallel Claude session regularly checks out feature branches there. A
   timer tick or a manual "Check now" click while a branch is checked out
   stashes/pulls the session's work-in-progress.
3. **No cross-process serialization**: crow + MPA gateways (same tree) plus
   any scratch gateway tick independently; interleaved
   stash/pull/npm/init-db/pop sequences race each other and git's index.lock.
4. **--no-auth companions self-update by default**: companion bridges and
   scratch gateways run the full updater unless each operator remembers
   `CROW_AUTO_UPDATE=0` (a standing Cluster-A gotcha; grackle's bridge unit is
   exactly this shape).

Non-defect confirmed: post-pull `node scripts/init-db.js` already runs (:152)
and the schema boot gate (#127, SCHEMA_GENERATION) covers any instance that
gets code via other paths — the operator's "init-db equivalence" item is
ALREADY SATISFIED; this spec only documents it.

## 2. Design

### D1 — Branch guard: no-op unless HEAD == main (timer AND manual)

At the top of `checkForUpdates()` (before the fetch):

```js
const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch.stdout !== "main") {
  const msg = `Skipped: not on main (on '${branch.stdout}')`;
  ... saveSetting last_check/last_result ... log(msg);
  return { updated: false, skipped: "not-on-main", branch: branch.stdout, message: msg };
}
// (R2 NEW-2: `message` is REQUIRED on every skip return — the manual UI
// renders it; omitting it re-creates the fake-success class via an
// empty/undefined render.)
```

Inside `checkForUpdates` — NOT in #163's tickCheck — so it protects BOTH
callers (operator decision d): the timer, and the manual `check_updates_now`
action. **Manual-UI honesty (R1 MAJOR-1):** the check-now click handler
(updates.js:114-135) branches only on `data.updated` → `data.error` → else
"Already up to date" — as-is, a skip return would render a FAKE SUCCESS (the
exact Cluster-A fake-success class, invisible to the node suite). Two wired
ends, both required: (a) every skip return carries a human `message` field
("Skipped: not on main (on 'x')" / "Skipped: another updater is running
(pid N)"); (b) the check-now JS gains a NEUTRAL branch — `else if
(data.skipped)` renders `data.message` in the muted style, not green, not
red — before the else. §5's UI verification asserts this exact rendering.
Rationale for guarding the manual path too: a click on a dev checkout must
not fetch/pull under a feature branch — R1 proved this is not hypothetical:
`git pull --ff-only origin main` while an ANCESTOR feature branch is checked
out FAST-FORWARDS that feature ref onto main (empirically confirmed), then
behindCount>0 logic proceeds and can RESTART the gateway under a dev's feet.

Detached HEAD (`rev-parse --abbrev-ref` prints `HEAD`) also skips — correct:
an updater must never mutate a detached checkout. A rev-parse failure (not a
git repo, git missing) skips with the error in the message (fail-closed for a
mutating operation).

### D2 — Delete stash/pop entirely; tolerant ff-only pull

Remove :123-125 (stash), :132-134 (pop-on-pull-fail), :154-164 (pop/restore
block) — the whole didStash concept. The pull runs directly against the
possibly-dirty tree:

- `git pull --ff-only` refuses to proceed ONLY when the incoming diff
  overlaps a locally-modified tracked file ("Your local changes to the
  following files would be overwritten by merge") or an untracked file that
  the merge would create. Disjoint local WIP (crow's live state: a modified
  bench compose file + untracked dirs) does not block a pull that doesn't
  touch those paths — crow keeps auto-updating.
- On refusal, the existing pull-failed path (:129-138 minus the pop) reports
  the honest failure; extend the message to say local changes conflict with
  the update and need manual attention (the raw git stderr is kept — it names
  the files).

This deletes defect 1 by construction: no stash command exists to misfire,
and no pop can ever touch a foreign stash entry.

### D3 — Cross-process lock around the mutating sequence

New module-level helpers in auto-update.js (no new deps):

- Lock path: `<gitDir>/crow-auto-update.lock`, where gitDir is resolved PER
  ACQUIRE via `git rev-parse --absolute-git-dir` (R1 MINOR-4: `.git` is a
  FILE in a worktree — a hardcoded `<APP_ROOT>/.git/…` open would throw
  ENOTDIR every tick there; rev-parse gives the real per-worktree git dir,
  which is also exactly the right serialization scope: one lock per working
  tree). Resolved from the live APP_ROOT each call (R1 MINOR-3: APP_ROOT
  becomes `let` for the `_setAppRootForTest` seam; nothing may capture it at
  module load).
- Acquire: `fs.open(path, "wx")` → write `${pid}\n${new Date().toISOString()}`.
  On EEXIST: read the file; if the recorded PID is alive (`process.kill(pid,0)`
  succeeds) AND the timestamp is younger than 30 minutes → **skip this tick**
  (`{ updated:false, skipped:"locked", message:"Another updater is running
  (pid N)" }`).
- **Stale reclaim via rename-quarantine (R1 MAJOR-2**, honesty-corrected by
  R2 NEW-1): the reclaimer does
  `fs.rename(lock, lock + ".stale." + process.pid)`; ENOENT on rename = lost
  the reclaim race → skip. The winner unlinks its quarantine file and retries
  the O_EXCL open ONCE; EEXIST there (a third party acquired meanwhile) →
  skip. On every acquire, best-effort sweep any `*.stale.*` leftovers older
  than the staleness window (R2 NEW-5 — a crash between rename and unlink
  would otherwise litter $GIT_DIR forever).
  **What this guarantees, precisely (R2 NEW-1):** exactly one winner among
  reclaimers racing the SAME stale inode. POSIX rename is not
  compare-and-swap: a reclaimer that read the stale lock, then lost a full
  reclaim+fresh-acquire cycle to a peer, can rename the peer's FRESH lock
  into quarantine and proceed — a residual double-run window that only opens
  behind an already-rare stale lock. ACCEPTED, with named backstops: (1)
  owner-checked release contains all lockfile damage (no non-owner unlink);
  (2) git's own index.lock/ref locks make concurrent pulls fail honestly —
  refs cannot be doubly mutated; (3) crow and MPA have SEPARATE crow.db files
  (CROW_DATA_DIR differs; R2 verified) so init-db never contends. The one
  genuinely unsafe concurrent op is `npm install` on the shared node_modules,
  which runs only when the incoming diff touches package files — rare∩rare,
  and still strictly better than main's zero serialization. (The
  close-it-fully alternative — quarantine-file-as-held-mutex — was assessed
  and rejected as past the YAGNI bar given these backstops.)
- **Owner-checked release**: the `finally` re-reads the lockfile and unlinks
  ONLY if it still contains our PID+timestamp — never blindly (the second
  half of MAJOR-2: a process must not release a lock it no longer owns).
- The lock wraps everything AFTER the branch guard (a skipped-branch tick
  never takes the lock). Restart ordering verified by R1: the `finally`
  unlink runs synchronously on return, ~1.5s before `crow:shutdown` and
  ~2.5s before `process.exit` — the lock is always released before exit.
- Scope: same-host only, which matches the threat (crow + MPA + scratch
  gateways share one host and one tree). Staleness reclaim requires
  (dead PID) OR (age > 30min) — a live-but-wedged updater must not block
  forever; 30min exceeds the worst-case internal timeout sum (~11min: git
  120s×N + npm 300s + init-db 120s — R1 verified init-db inherits run()'s
  120s default, it is NOT unbounded).

### D3b — Branch re-check under the lock (R1 MAJOR-3, TOCTOU)

The D1 branch read races any parallel session's raw `git checkout` (which
takes no lock) across the multi-second fetch window. R1 empirically proved
the damage mode: on a feature branch that is an ancestor of origin/main,
`pull --ff-only origin main` fast-forwards THAT ref. Mitigation: re-run
`git rev-parse --abbrev-ref HEAD` INSIDE the lock, immediately before the
pull; if it no longer says `main`, abort with the honest skip (no pull, no
npm, no init-db). This shrinks the window from seconds to milliseconds.
RESIDUAL (documented, accepted): a checkout landing inside those final
milliseconds can still be fast-forwarded — recoverable via reflog; git
offers no transactional checkout+pull without a wrapper lock that external
sessions won't take. R2 sharpened the bound: DURING the pull itself git's
own index.lock/ref locks refuse a concurrent checkout, so the true exposure
is only the process-spawn gap between the re-check and git taking its locks.
STRUCTURE (R2 NEW-3): everything after the D1 guard lives in a named,
separately-exported-for-test helper — `runLockedUpdate()` — which is the
seam test 3b uses to reach the under-lock re-check with a branch already
checked out (the outer D1 guard would otherwise abort the fixture first).

### D4 — --no-auth gateways: auto-update OFF by default

Exported pure predicate (QW1 `shouldRunHealthMonitor` pattern,
boot/post-listen.js:27):

```js
export function shouldStartAutoUpdate({ env = {}, noAuth = false } = {}) {
  if (env.CROW_AUTO_UPDATE === "0" || env.CROW_AUTO_UPDATE === "false") return false; // kill-switch, any mode
  if (noAuth) return env.CROW_AUTO_UPDATE === "1" || env.CROW_AUTO_UPDATE === "true"; // opt-in only
  return true;
}
```

Wired at the post-listen.js call site (:186), which already has `noAuth` in
scope (R1 verified the threading: index.js:577 → post-listen deps :62), AND
enforced inside `startAutoUpdate` itself: it gains a `{ noAuth }` option and
applies the same predicate (R1 MINOR-1 — the existing in-function check
:206-209 is kill-switch-only; without the in-function predicate, any future
caller added without the call-site guard silently reintroduces defect 4).
Kill-switch semantics unchanged; `CROW_AUTO_UPDATE=1` on a --no-auth unit is
the explicit opt-in.

### D5 — init-db equivalence (documentation only)

Post-pull `node scripts/init-db.js` (:152) + the #127 schema boot gate remain
the two-layer schema story. No change.

Accepted D2 residuals (R1 MINOR-5, explicit): (a) `npm install` and
`init-db.js` now run against a tree that may carry local WIP — this bites
only when package.json/package-lock.json/scripts/init-db.js are themselves
locally modified AND disjoint from the incoming diff (overlap → the pull
already refused); the old stash's "pristine build inputs" property is
consciously traded for never touching the stash stack. (b) A persistently
branch-checked-out gateway shows a stale `auto_update_current_version` in
the Updates section (the skip path deliberately writes only
last_check/last_result — status churn is bounded and honest).

## 3. Non-goals

- No change to the restart mechanism (isSupervised/crow:shutdown), npm-install
  warning-only posture, or the #163 tickCheck/enabled semantics.
- No multi-host coordination (instances on other hosts have their own trees).
- No recovery tooling for historic stash entries (the June entry was already
  recovered; `git stash list` remains the operator path).
- No schema change; NO SCHEMA_GENERATION bump.

## 4. Tests (TDD; mutation-test every guard; fixture = real temp git repos)

Test seam: `_setAppRootForTest(dir)` (alongside #163's `_setDbForTest`) so
`run()` executes in a temp clone. Fixtures: `origin` bare repo + `work` clone
with package.json/init-db stubbed via a scripts/init-db.js that exits 0 (or
the changed-files check simply not matching). Each test builds its own repos.

1. D1: clone checked out on `feature/x` → `checkForUpdates()` returns
   `{skipped:"not-on-main"}`, NO fetch performed (origin fetch head file
   unchanged / result recorded via a pre-set marker), status message honest —
   **mutation**: removing the guard reddens. Detached HEAD → skips.
2. D2 tolerant pull: origin gains a commit touching `a.txt`; clone has a
   dirty `b.txt` (tracked) + untracked `c/` → update SUCCEEDS, `b.txt`
   modification survives byte-identical, no stash entry created
   (`git stash list` empty) — **mutation**: reintroducing a
   `git stash`/`git stash pop` pair around the pull reddens the
   stash-list-empty assertion. Overlap case: clone dirties `a.txt` itself →
   pull refused, result honest error naming local changes, tree untouched,
   NO stash entry, no pop.
3. D3 lock: (i) lock held by a live PID (this test process's own pid, fresh
   timestamp) → skip `{skipped:"locked"}` with a `message` — **mutation**:
   removing the EEXIST-skip reddens; (ii) stale lock (dead PID or old
   timestamp) → reclaimed VIA RENAME-QUARANTINE, update proceeds, lock
   removed afterward — **mutation**: removing the staleness reclaim reddens;
   (iii) lock released in finally even when the pull fails (no lockfile after
   an overlap-refused run); (iv) staleness rule pinned: dead-PID young lock →
   reclaimed; live-PID old (>30min) lock → reclaimed; live-PID young → skip;
   (v) **reclaim race (R1 MAJOR-2)**: with a stale lock present, two
   concurrent acquire attempts → EXACTLY ONE proceeds (the rename loser gets
   ENOENT → skip) — deterministic per R2: OS rename atomicity decides the
   winner regardless of libuv scheduling; NOTE (R2) this covers ONLY the
   same-inode race — the NEW-1 lapping residual is accepted, not tested —
   **mutation**: reverting rename-quarantine to unlink-then-open reddens
   (both would proceed); (vi) **owner-checked release**: if the lockfile now
   holds a DIFFERENT pid, release must NOT unlink it — **mutation**:
   blind-unlink release reddens; (vii) quarantine sweep: a stale
   `*.stale.*` file older than the window is removed on acquire.
3b. D3b branch re-check under lock (R1 MAJOR-3): fixture switches the clone
   to a feature branch AFTER the first guard passes (via a test seam hook or
   by invoking the internal locked-pull helper directly on a branch-checked
   repo) → aborts with the honest skip, NO pull ran (feature ref position
   unchanged) — **mutation**: removing the re-check reddens (R1's empirical
   ancestor-ff repro becomes the negative case).
3c. Manual-UI honesty (R1 MAJOR-1): node side — every skip return carries
   `message`; the check-now action's JSON therefore includes it. Client side
   is CDP-verified (§5): the neutral branch renders the message, NOT
   "Already up to date" — the fake-success repro is the red case.
4. D4 predicate: table-driven — (noAuth, env) × {unset,"0","false","1","true"}
   → expected; **mutation**: dropping the noAuth branch reddens. Call-site
   test: post-listen wiring passes noAuth (unit test the predicate + assert
   the call site via the boot log line absence under --no-auth, reusing the
   #163 scratch-boot pattern).
5. Existing #163 tests stay green — R1/R2 both verified all four tick-gate
   tests are spy-injected and never reach the real checkForUpdates, so
   nothing existing reddens. (R2 NEW-4 clarification: no existing test
   asserts "manual runs while disabled" by calling the real function — that
   property is structural, gate-in-tickCheck. This item is guidance for any
   NEW manual-path test the plan adds: such a fixture must run ON main or
   use the runLockedUpdate seam, since the manual path is now
   branch-guarded but still not enabled-gated.)
6. Full suite ≥ baseline; boot clean.

## 5. Verification beyond the suite

- Scratch gateway on a throwaway clone checked out on a branch: manual
  "Check for updates now" click (CDP) → UI shows the honest "not on main"
  message, `git log`/status untouched.
- Two concurrent `checkForUpdates()` on one tree (script) → exactly one
  pulls, the other reports `skipped:"locked"`.
- Post-deploy prod: crow (dirty-disjoint bench WIP) still auto-updates on the
  next real commit; `git stash list` on crow/MPA gains NO new entries across
  an update cycle; grackle companion bridge unit (--no-auth) logs no
  auto-update start line.

## 6. Risks / review focus

- Staleness rule (3.iv): reclaim on (dead PID) OR (age>30min) even if alive —
  a wedged live updater (hung npm install has its own 300s timeout, git 120s)
  should not block updates forever; 30min exceeds every internal timeout sum.
  Review the interaction with the restart path: the lock is released BEFORE
  the process exits for restart, so the successor never sees its own reused
  PID in a live lock.
- Tolerant pull inherits git's refusal semantics — if git ever changes
  overlap detection the behavior degrades to "pull fails honestly", never to
  silent data loss.
- The D1 skip writes last_check/last_result on every tick on a
  branch-checkout gateway (status churn only; same as today's failure paths).
- #163 interaction — RESOLVED by R1 (MINOR-2): all four
  tests/auto-update-tick-gate.test.js tests inject a spy via
  `tickCheck(check)` and NEVER reach the real `checkForUpdates`; no existing
  test anywhere calls it. Adding the branch guard reddens nothing. No D6
  fixture restructuring is needed — the plan must not invent it.
- `_setAppRootForTest` seam: APP_ROOT `const` → `let`; `run()` re-reads it
  per call (R1 verified nothing else captures it); the D3 lock/gitDir
  resolution must also read it per acquire, never at module load.
