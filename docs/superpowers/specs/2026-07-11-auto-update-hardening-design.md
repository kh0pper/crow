# F-UPDATE-1 — auto-update hardening design

Date: 2026-07-11 · Arc: post-Messages-arc follow-up pool, item (2)
Operator decisions (2026-07-11, AskUserQuestion): tolerant pull (no stash, no
pre-check — git's own overlap refusal is the gate); ALL FOUR guards approved
(branch guard incl. the manual button, O_EXCL lock w/ PID+staleness, --no-auth
default OFF, tolerant pull).
BUILD CONSTRAINT: branches AFTER PR #163 merges — both touch
servers/gateway/auto-update.js (#163 added tickCheck/_setDbForTest).

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
  return { updated: false, skipped: "not-on-main", branch: branch.stdout };
}
```

Inside `checkForUpdates` — NOT in #163's tickCheck — so it protects BOTH
callers (operator decision d): the timer, and the manual `check_updates_now`
action, whose UI already renders `data.message`-style results; the returned
message must be honest ("Skipped: not on main…"), never a fake success.
Rationale for guarding the manual path too: a click on a dev checkout must
not fetch/pull under a feature branch; `--ff-only` can't cross branches, but
the fetch+status writes would still churn and confuse.

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

- Lock path: `<APP_ROOT>/.git/crow-auto-update.lock` (inside .git so it can
  never be swept into a commit and lives with the repo the lock protects).
- Acquire: `fs.open(path, "wx")` → write `${pid}\n${new Date().toISOString()}`.
  On EEXIST: read the file; if the recorded PID is alive (`process.kill(pid,0)`
  succeeds) AND the timestamp is younger than 30 minutes → **skip this tick**
  (`{ updated:false, skipped:"locked" }`, honest status "Another updater is
  running (pid N)"). Otherwise the lock is stale (crashed process or PID
  reuse older than 30min) → unlink and retry the O_EXCL open ONCE; a second
  EEXIST (lost the race to another reclaimer) → skip.
- Release: unlink in a `finally` around the fetch→pull→npm→init-db sequence.
  The lock wraps everything AFTER the branch guard (a skipped-branch tick
  never takes the lock). The restart path (:179-187) fires after release —
  a restarting process must not leave a lock that its successor then treats
  as live-PID (the PID may be REUSED by the new gateway itself).
- Scope: same-host only, which matches the threat (crow + MPA + scratch
  gateways share one host and one tree). Staleness = PID-liveness AND age,
  both required to reclaim, because PIDs recycle.

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
scope: `if (shouldStartAutoUpdate({ env: process.env, noAuth })) startAutoUpdate(...)`.
The existing in-function env check (:206-209) stays as a second layer (other
callers/tests hit startAutoUpdate directly). Kill-switch semantics unchanged;
`CROW_AUTO_UPDATE=1` on a --no-auth unit is the explicit opt-in.

### D5 — init-db equivalence (documentation only)

Post-pull `node scripts/init-db.js` (:152) + the #127 schema boot gate remain
the two-layer schema story. No change.

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
   timestamp) → skip `{skipped:"locked"}` — **mutation**: removing the
   EEXIST-skip reddens; (ii) stale lock (dead PID or old timestamp) →
   reclaimed, update proceeds, lock removed afterward — **mutation**:
   removing the staleness reclaim reddens (ii); (iii) lock released in
   finally even when the pull fails (assert no lockfile after an
   overlap-refused run); (iv) both-required rule: live PID + old timestamp →
   still reclaimed after 30min? NO — decide: live-PID + old-age means a WEDGED
   updater; reclaim requires (dead PID) OR (age>30min). Test pins the chosen
   rule: dead-PID young lock → reclaimed; live-PID old lock → reclaimed;
   live-PID young lock → skip.
4. D4 predicate: table-driven — (noAuth, env) × {unset,"0","false","1","true"}
   → expected; **mutation**: dropping the noAuth branch reddens. Call-site
   test: post-listen wiring passes noAuth (unit test the predicate + assert
   the call site via the boot log line absence under --no-auth, reusing the
   #163 scratch-boot pattern).
5. Existing #163 tests stay green (tickCheck, manual ungated-by-enabled —
   note the manual path IS now branch-guarded but NOT enabled-gated; the D6
   test asserting "manual runs while disabled" must run its fixture ON main
   or inject the check spy above the branch guard — reconcile in the plan).
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
- #163 interaction: D6's "manual runs while auto-update disabled" test uses a
  db stub only — its fixture has no git repo at all; adding the branch guard
  FIRST in checkForUpdates would make that test hit rev-parse against the
  REAL repo cwd (on main in CI, on a branch mid-build!). The plan must
  restructure: branch guard uses `run()` which obeys `_setAppRootForTest`;
  the #163 tick tests inject their check spy and never reach the real
  checkForUpdates — verify each existing test's actual path before coding.
