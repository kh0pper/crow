# F-UPDATE-1 Auto-Update Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the June-stash incident class: branch-guard the updater (timer AND manual), delete stash/pop entirely (tolerant ff-only pull), serialize concurrent gateways with an atomic-reclaim lockfile, and default auto-update OFF under `--no-auth`.

**Architecture:** Spec `docs/superpowers/specs/2026-07-11-auto-update-hardening-design.md` (2-round adversarially reviewed; R1 empirically verified git semantics in real repos — every fold binding). All changes in `servers/gateway/auto-update.js` + one line in `boot/post-listen.js` + a neutral-skip branch in `settings/sections/updates.js`.

**Tech Stack:** Node ESM, node:test, real temp git repos as fixtures. No new deps. NO schema change.

## Global Constraints

- Branch: `fix/auto-update-hardening`, base = current origin/main (≥ 9216e590).
- Commits: explicit paths only (`git add <paths>` + `git commit <paths>`), never `-A`/`-a`/`--amend`; `git show --stat HEAD` after each.
- Tests: `node --test tests/<file>.test.js`. NEVER run anything against the real repo/prod env: every fixture is a temp `origin` bare repo + `work` clone, wired via `_setAppRootForTest`.
- Every skip return carries a human `message` field (R1 MAJOR-1 — the manual UI renders it; omitting it re-creates the fake-success class).
- #163's tests (tests/auto-update-tick-gate.test.js) must stay green untouched.

---

### Task 1: Lock + seams + branch guard + tolerant pull (the auto-update.js rework)

**Files:**
- Modify: `servers/gateway/auto-update.js`
- Test: `tests/auto-update-hardening.test.js` (new)

**Interfaces produced:** `_setAppRootForTest(dir)`; `tickCheck`/`checkForUpdates` signatures unchanged; internal `runLockedUpdate()` exported for tests; skip returns `{ updated:false, skipped:"not-on-main"|"locked", message, branch? }`.

- [ ] **Step 1: Seams.** Change line 16 `const APP_ROOT` → `let APP_ROOT`; add below `_setDbForTest`:

```js
/** Test-only: retarget git/npm/lock operations at a fixture repo. */
export function _setAppRootForTest(dir) {
  APP_ROOT = dir;
}
```

- [ ] **Step 2: Lock helpers** (module-level, after `run()`), verbatim:

```js
const LOCK_STALE_MS = 30 * 60 * 1000;

async function lockPath() {
  const r = await run("git", ["rev-parse", "--absolute-git-dir"]);
  if (r.code !== 0 || !r.stdout) return null; // not a git checkout → no lock possible
  return join(r.stdout, "crow-auto-update.lock");
}

function readLock(path) {
  try {
    const [pidLine, tsLine] = readFileSync(path, "utf8").split("\n");
    return { pid: parseInt(pidLine, 10), ts: Date.parse(tsLine || "") };
  } catch { return null; }
}

function lockIsStale(info) {
  if (!info || !Number.isFinite(info.pid)) return true;
  let alive = true;
  try { process.kill(info.pid, 0); } catch { alive = false; }
  const old = !Number.isFinite(info.ts) || Date.now() - info.ts > LOCK_STALE_MS;
  return !alive || old; // reclaim on (dead PID) OR (age>30min) — a wedged live updater must not block forever
}

/** Returns the lock file path on success, null when another updater holds it. */
function acquireLock(path) {
  // Sweep crash-orphaned quarantine files older than the staleness window.
  try {
    const dir = dirname(path);
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(basename(path) + ".stale.")) continue;
      const full = join(dir, f);
      try { if (Date.now() - statSync(full).mtimeMs > LOCK_STALE_MS) unlinkSync(full); } catch {}
    }
  } catch {}
  const body = `${process.pid}\n${new Date().toISOString()}\n`;
  try {
    writeFileSync(path, body, { flag: "wx" });
    return path;
  } catch (err) {
    if (err.code !== "EEXIST") return null;
  }
  const info = readLock(path);
  if (!lockIsStale(info)) return null; // live young holder → skip
  // Atomic reclaim: rename-quarantine — exactly one winner among reclaimers
  // racing the SAME stale inode (rename is NOT compare-and-swap; the lapping
  // residual is accepted in the spec with named backstops).
  const quarantine = `${path}.stale.${process.pid}`;
  try { renameSync(path, quarantine); } catch { return null; } // ENOENT = lost the race
  try { unlinkSync(quarantine); } catch {}
  try {
    writeFileSync(path, body, { flag: "wx" });
    return path;
  } catch { return null; } // a third party acquired meanwhile
}

/** Owner-checked release: never unlink a lock we no longer own. */
function releaseLock(path) {
  try {
    const info = readLock(path);
    if (info && info.pid === process.pid) unlinkSync(path);
  } catch {}
}
```

Add to the fs import line: `readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync` via `node:fs`, and `join, dirname, basename` via `node:path` (extend the existing imports; `dirname` already imported).

- [ ] **Step 3: Rework `checkForUpdates` per spec D1/D2/D3/D3b.** Shape (keep all existing saveSetting/status/npm/init-db/restart logic inside `runLockedUpdate`):

```js
export async function checkForUpdates() {
  const log = (msg) => console.log(`[auto-update] ${msg}`);
  try {
    const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.code !== 0 || branch.stdout !== "main") {
      const msg = branch.code !== 0
        ? `Skipped: cannot determine branch (${branch.stderr || "not a git checkout"})`
        : `Skipped: not on main (on '${branch.stdout}')`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "not-on-main", branch: branch.stdout, message: msg };
    }
    const lock = await lockPath();
    const held = lock ? acquireLock(lock) : null;
    if (lock && !held) {
      const info = readLock(lock);
      const msg = `Skipped: another updater is running (pid ${info?.pid ?? "unknown"})`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "locked", message: msg };
    }
    try {
      return await runLockedUpdate(log);
    } finally {
      if (held) releaseLock(held);
    }
  } catch (err) { /* existing catch body unchanged */ }
}

/** The mutating sequence; exported ONLY as the test seam for the under-lock
 *  branch re-check (spec D3b — the outer guard would abort a branch fixture
 *  before the lock). */
export async function runLockedUpdate(log = (m) => console.log(`[auto-update] ${m}`)) {
  // ... existing body: rev-parse current, fetch, rev-list behind-count,
  //     version bookkeeping, up-to-date early return ...
  // D3b: re-check the branch UNDER the lock, immediately before the pull —
  // a parallel session's raw `git checkout` races the outer guard across the
  // fetch window, and `pull --ff-only origin main` on an ancestor feature
  // branch FAST-FORWARDS that ref (R1 empirically proved it).
  const recheck = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (recheck.stdout !== "main") {
    const msg = `Skipped: branch changed mid-update (now '${recheck.stdout}')`;
    log(msg);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, skipped: "not-on-main", branch: recheck.stdout, message: msg };
  }
  // D2: pull directly — NO stash. Delete the stash block (:124-125 old), the
  // pop-on-pull-fail (:132-134 old), and the entire pop/restore block
  // (:154-164 old). On pull failure keep the existing honest-error path and
  // extend the message: `Pull failed (local changes may conflict with the
  // update — resolve manually): ${stderr}`.
  // ... rest of the existing body unchanged (npm-if-package-changed,
  //     init-db, version stamps, isSupervised restart) ...
}
```

The implementer moves the existing body VERBATIM except the three stash hunks and the inserted re-check; diff review must show no other logic drift.

- [ ] **Step 4: Failing tests** in `tests/auto-update-hardening.test.js`. Fixture helper:

```js
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, runLockedUpdate, tickCheck, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";

const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "au-hard-"));
  const origin = join(root, "origin.git"); const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t"); g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "a.txt"); g(work, "commit", "-m", "c1"); g(work, "push", "origin", "main");
  return { root, origin, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function originCommit(fx, file, content) {
  const c2 = join(fx.root, "pusher");
  execFileSync("git", ["clone", fx.origin, c2], { stdio: "pipe" });
  g(c2, "config", "user.email", "t@t"); g(c2, "config", "user.name", "t");
  writeFileSync(join(c2, file), content);
  g(c2, "add", file); g(c2, "commit", "-m", "up"); g(c2, "push", "origin", "main");
}
const stubDb = () => ({ execute: async () => ({ rows: [] }) });
```

Tests (each: arrange fixture → `_setAppRootForTest(fx.work)` + `_setDbForTest(stubDb())` → act → assert → `_setAppRootForTest` back to the real root via a saved original? NO — the module has no getter; instead every test sets it and the file's `after()` hook restores by re-importing is impossible — so the LAST action of every test is `_setAppRootForTest(<the real repo root>)` computed once as `join(import.meta.dirname, "..")`):
1. Branch guard: `g(work,"checkout","-b","feature/x")` → `checkForUpdates()` → `{skipped:"not-on-main", branch:"feature/x"}`, `message` non-empty, origin FETCH_HEAD absent (no fetch ran: assert `!existsSync(join(work,".git","FETCH_HEAD"))`).
2. Tolerant pull, disjoint: `originCommit(fx,"a.txt","two\n")`; dirty `b.txt` (untracked) + dirty tracked via a second committed file... (arrange: commit `c.txt` first, push, then locally modify `c.txt` AFTER? No — modify a file the incoming diff does NOT touch: add+commit+push `c.txt` from work, then `originCommit` touching only `a.txt`, then locally edit `c.txt`) → `checkForUpdates()` → `{updated:true}`, `c.txt` local edit byte-identical, `git stash list` EMPTY.
3. Tolerant pull, overlap: local edit to `a.txt` itself + originCommit touching `a.txt` → result has `error` mentioning failure, tree untouched (local `a.txt` content preserved), stash list EMPTY.
4. Lock held (live young): write lockfile with `process.pid` + fresh ISO into `.git/` → `checkForUpdates()` → `{skipped:"locked"}` with message; lockfile still present.
5. Stale reclaim: lockfile with pid 999999999 + old ts → update proceeds (with an origin commit staged) → lockfile GONE afterward.
6. Reclaim race (deterministic, same-inode): stale lockfile present; run `Promise.all([checkForUpdates(), checkForUpdates()])` — wait: both in ONE process share the pid... make the second a simulated reclaimer: call `acquireLock` indirectly via two concurrent `checkForUpdates` with DIFFERENT... in-process both have same pid so owner-check confuses. INSTEAD test the primitive through the public surface: pre-create quarantine `lock.stale.<otherpid>` older than window → acquire sweeps it; and the rename-loser path via a lockfile that VANISHES between read and rename (delete it after writing a stale one, monkey... ) — SIMPLIFY: assert (a) stale sweep removes old quarantine files; (b) after a successful reclaim the lock contains OUR pid; (c) `releaseLock` with a lockfile holding a DIFFERENT pid does NOT unlink (write foreign-pid lock, call the exported-for-test? releaseLock is not exported — test via checkForUpdates: run a full update while a bystander swaps the lockfile mid-run is nondeterministic → EXPORT `_lockPrimitivesForTest = { acquireLock, releaseLock, lockIsStale }` and unit-test the primitives directly incl. the two-reclaimer interleaving by calling renameSync manually between steps).
7. D3b re-check: on main, take origin ahead; call `runLockedUpdate()` AFTER `g(work,"checkout","-b","feat/y")` → `{skipped:"not-on-main"}`, feature ref position unchanged (`g(work,"rev-parse","feat/y")` equals pre-call), NO pull.
8. #163 regression: `node --test tests/auto-update-tick-gate.test.js` still green.

Mutations to record red-then-restored: (M1) remove outer branch guard → test 1 red; (M2) reintroduce stash+pop around the pull → test 2 stash-list red; (M3) remove EEXIST-skip → test 4 red; (M4) remove staleness reclaim → test 5 red; (M5) blind-unlink release → primitive test (c) red; (M6) remove D3b re-check → test 7 red (R1's ancestor-ff repro is the negative).

- [ ] **Step 5:** Implement (Steps 1-3), tests green, mutations recorded, commit:
```bash
git add tests/auto-update-hardening.test.js
git commit servers/gateway/auto-update.js tests/auto-update-hardening.test.js -m "feat(auto-update): branch guard + no-stash tolerant pull + atomic-reclaim lock (F-UPDATE-1 D1-D3b)"
```

---

### Task 2: D4 predicate + call-site + manual-UI neutral skip branch

**Files:**
- Modify: `servers/gateway/auto-update.js` (predicate + startAutoUpdate `{noAuth}` option)
- Modify: `servers/gateway/boot/post-listen.js` (:186 call site — `noAuth` already in deps :62)
- Modify: `servers/gateway/dashboard/settings/sections/updates.js` (check-now click handler neutral branch)
- Test: extend `tests/auto-update-hardening.test.js`

- [ ] Predicate (exported from auto-update.js, spec D4 verbatim):
```js
export function shouldStartAutoUpdate({ env = {}, noAuth = false } = {}) {
  if (env.CROW_AUTO_UPDATE === "0" || env.CROW_AUTO_UPDATE === "false") return false;
  if (noAuth) return env.CROW_AUTO_UPDATE === "1" || env.CROW_AUTO_UPDATE === "true";
  return true;
}
```
`startAutoUpdate(database, { noAuth = false } = {})` applies it first (replacing the kill-switch-only block — semantics preserved by the predicate). post-listen.js:186 → `startAutoUpdate(createDbClient(), { noAuth })`.
- [ ] updates.js check-now handler: insert BEFORE the final else:
```js
          } else if (data.skipped) {
            msg.style.display = 'block';
            msg.style.color = 'var(--crow-text-muted)';
            msg.textContent = data.message || data.skipped;
```
- [ ] Tests: predicate table (noAuth × {unset,"0","false","1","true"}); startAutoUpdate with noAuth:true + stub db → returns without arming (no log "Enabled"); mutation: drop the noAuth branch → red. The JS branch is CDP-verified (Task 3); node-side asserts every skip return carries `message` (already covered by Task 1 tests).
- [ ] Commit: `git commit servers/gateway/auto-update.js servers/gateway/boot/post-listen.js servers/gateway/dashboard/settings/sections/updates.js tests/auto-update-hardening.test.js -m "feat(auto-update): --no-auth default OFF + honest neutral skip in the manual Check-now UI (F-UPDATE-1 D4 + R1 MAJOR-1)"`

---

### Task 3 (controller): suite + CDP + PR

- [ ] Full suite ≥ 1434/0/1 baseline; boot clean (scratch CROW_DATA_DIR + CROW_HOME).
- [ ] CDP on a scratch THROWAWAY clone checked out on a branch: real "Check for updates now" click → neutral muted "Skipped: not on main (on 'x')" rendered (NOT "Already up to date" — the R1 fake-success repro is the red case); repo `git log` untouched. Second scratch check: two concurrent checkForUpdates via a node script on one fixture → exactly one pulls, other `skipped:"locked"`.
- [ ] PR; Kevin gates. Post-deploy: `git stash list` on crow/MPA gains no entries across an update cycle; grackle companion bridge logs no auto-update start.

## Self-Review
Spec coverage: D1→T1 guard, D2→T1 pull, D3/D3b→T1 lock+recheck, D4→T2, R1-MAJOR-1 UI→T2+T3, tests §4.1-4.5→T1/T2, §5→T3. Placeholders: none (test 6's primitive-export decision is made: `_lockPrimitivesForTest`). Types consistent: `runLockedUpdate`, `_setAppRootForTest`, `shouldStartAutoUpdate`, skip-shape `{updated,skipped,message,branch?}`.
