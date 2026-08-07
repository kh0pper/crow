# Board Card Dispatch on the Job Rail — v2 (corrected)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Supersedes:** `2026-08-07-board-card-dispatch-on-job-rail.md`. That plan's Tasks 1–2 were correct and are already committed on `feat/board-dispatch-job-rail`. Its Tasks 3–4 were built on a wrong premise and must be substantially replaced. Read "What v1 got wrong" before touching anything.

**Goal:** Give board card dispatch the job rail's durability — scan-gated pickup, retry, stale-claim recovery, telemetry — **without changing what actually runs**. The bridge keeps composing the prompt, enforcing the planning safety floor, and reconciling card state. The job rail becomes the queue in front of it, not a replacement for it.

---

## What v1 got wrong (the correction this plan exists for)

v1 replaced `bridge.mjs --inject` / `--plan-card` with a bare `bot_jobs` enqueue whose `goal` was the string `"Execute board card #N"`. A whole-branch review, plus direct reading of the code v1 never opened, established that this is **not behaviour-preserving**:

1. **It removes a safety floor.** `bridge.planCard` (`scripts/pi-bots/bridge.mjs:855-950`) *refuses to run on anything but a local model* — its own comment reads "no config knob reaches a paid model" — and merges a confinement policy **deliberately stricter than the bot's own**: `bash: "deny"`, `write_paths: [<repo>/.pi/plans, <repo>/docs]`, `multi_agent: false`. A generic job runs under the bot's own policy. This is the single most important reason v1 must not ship.
2. **It throws away the work context.** The old execute prompt (`bridge.mjs:657-666`) carried the project context block, the card number, the card's current board status, and **the full plan-file text**, then told the bot to *"use the `tasks_*` tools … to set this card in_progress, then done"* and to record output under the plan file's `## Result` section. v1 sent a bare goal string into an empty temp dir. The bot never saw the plan.
3. **It inverted who owns card state.** In the real design the **bot** writes the card's status via `tasks_*` tools and `statusToStage` reconciles it. v1's `applyCardOutcome` had the *dispatcher* set the card from the pi process's exit code — so "completed" meant only "the process didn't throw", and a reply of "I can't do that" marked the card Done.
4. **It dropped stranding recovery.** `planCard` calls `resetStrandedCardBestEffort` on every failure path. v1 had no equivalent, and `recoverStaleClaims` — a third terminal path — never touched the card at all.
5. **It updated one of three lock predicates.** `lockState` learned the job rail; `lockMapFor` (board render + SSE) and `handleBotBoardPost action=move` did not, and `force-unlock` cannot clear a job lock at all.

**The corrected architecture:** a card job is a *durable claim ticket* whose execution calls the bridge's existing card entry points. `runJob` already does `await import("./bridge.mjs")` (`job_runner.mjs:260`), so this is a routing change, not new machinery.

## Branch disposition

`feat/board-dispatch-job-rail` currently holds 9 commits. Keep Tasks 1–2 (`3135e835`, `8e680b0b`) — the `card_id` column and its migration at every entry point are correct and were verified against a real legacy table. Task 1 of this plan reverts the rest.

## Global Constraints

- **Node 22 on every invocation:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`.
- **Do not weaken the planning safety floor.** Local-model-only, `bash: "deny"`, confined `write_paths`, `multi_agent: false`. If a task appears to require relaxing any of these, STOP and escalate.
- **The bot owns card state.** No dispatcher-side write that sets a card to `done`. The only dispatcher-side card write permitted in this plan is *stranding recovery* — returning a card that no longer has a live worker out of `executing`.
- **No `SCHEMA_GENERATION` bump.** `bot_jobs` migrates through the lazy-ensure convention (`BOT_JOBS_DDL` + `missingBotJobsColumns` at every entry point). Ordering is **PRAGMA → ALTER-if-table-exists → DDL**; DDL-first throws `no such column: card_id` on a legacy table and `init-db`'s `initTable()` exits 1 on DDL failure.
- **`blocked` is not a board stage.** `STAGES = [backlog, planning, ready, executing, done, cancelled]`.
- **Cards may live in a per-project database.** `planCard` resolves `(projectSpace && projectSpace.tasks_db_uri) || TASKS_DB`, and that value is a `file:` URI, not a plain path — `bridge.mjs`'s `db()` helper handles the scheme. Never open a card DB with a bare global path.
- **Suite green, 0 fail.** Branch is at 3015 with v1's Tasks 3–4 present; expect a different number after the revert.
- Commit with positional path args. Never attribute Claude or add a Co-Authored-By trailer.
- Mutation-test every new test.
- Doctrine: PR + green CI (`suite`, `static-checks`, `audit` via `/commits/<sha>/check-runs`), `enforce_admins` is TRUE.

---

### Task 1: Revert v1's Tasks 3–4, keep the schema work

**Files:** `scripts/pi-bots/job_runner.mjs`, `servers/gateway/routes/bot-board-api.js`, `tests/board-stage-api.test.js`; delete `tests/bot-jobs-card-delivery.test.js`, `tests/board-dispatch-job-rail.test.js`.

**Why a revert rather than an edit:** v1's `applyCardOutcome`/`applyCardFailure` encode the inverted ownership model this plan rejects. Editing them forward preserves the wrong shape. The `card_id` column and its migration (commits `3135e835`, `8e680b0b`) are kept.

- [ ] **Step 1: Revert the three v1 commits, newest first**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
git revert --no-commit 54039815   # board enqueue + lockState + test repair
git revert --no-commit 2ae064e9   # 'ready' instead of 'blocked'
git revert --no-commit 3c50fa4e   # deliver_to kind 'card'
git status --short
```

- [ ] **Step 2: Confirm what survived**

```bash
grep -n "card_id" scripts/pi-bots/bot-jobs-schema.mjs          # must still be there
grep -rn "applyCardOutcome\|applyCardFailure" scripts/ servers/ # must be GONE
grep -n "CROW_BOARD_DISPATCH_DRYRUN" servers/gateway/routes/bot-board-api.js  # must be BACK
```

Expected: `card_id` present in the DDL; no `applyCardOutcome`; the dispatch seam restored in the board API.

- [ ] **Step 3: Full suite**

`npm test > /tmp/revert.log 2>&1; grep -E '^# (tests|pass|fail)' /tmp/revert.log | tail -3`

Expected: 0 fail. Record the number — it is the new baseline.

- [ ] **Step 4: Commit**

```bash
git commit scripts/pi-bots/job_runner.mjs servers/gateway/routes/bot-board-api.js tests/ \
  -m "revert: v1 card write-back and board enqueue

v1 made the DISPATCHER own card state from the pi exit code, and replaced
bridge.planCard — which forces a local model and a confinement policy stricter
than the bot's own — with a generic job. Both are wrong. The card_id column and
its migration are kept; the dispatch path is rebuilt on top of the bridge."
```

---

### Task 2: `bot_jobs` learns which card action a job represents

**Files:** `scripts/pi-bots/bot-jobs-schema.mjs`, `tests/bot-jobs-card-columns.test.js`.

**Interfaces produced:** `BOT_JOBS_ADDED_COLUMNS` gains `{ name: "card_action", ddl: "ALTER TABLE bot_jobs ADD COLUMN card_action TEXT" }`. Values: `'execute'` or `'plan'`, NULL for every non-card job.

**Why a column and not a `source` value:** `source` already means *where the request came from* (`voice | chat | schedule | manual`), and `card_id`/`source='card'` answer that. Which of the two card verbs to run is a different axis; overloading `source` would make `source='card-plan'` mean two things at once.

- [ ] **Step 1: Extend the DDL and the added-columns list**

In `scripts/pi-bots/bot-jobs-schema.mjs`, add to the `CREATE TABLE` body right after `card_id`:

```js
    card_action   TEXT,                             -- 'execute' | 'plan' (card jobs only)
```

and append to `BOT_JOBS_ADDED_COLUMNS`:

```js
  { name: "card_action", ddl: "ALTER TABLE bot_jobs ADD COLUMN card_action TEXT" },
```

- [ ] **Step 2: Extend the existing migration tests**

`tests/bot-jobs-card-columns.test.js` already proves the fresh/legacy/idempotent contract for `card_id`. Its `LEGACY_DDL` predates both columns, so the "legacy table" test's `assert.equal(stmts.length, BOT_JOBS_ADDED_COLUMNS.length)` keeps working unchanged. Add one case:

```js
test("card_action is added alongside card_id and round-trips", () => {
  withDb(BOT_JOBS_DDL, (db) => {
    assert.ok(cols(db).includes("card_action"), "current DDL must create card_action");
    db.prepare("INSERT INTO bot_jobs (job_id,bot_id,goal,source,card_id,card_action) VALUES (?,?,?,?,?,?)")
      .run("job-p", "bot-1", "plan card 120", "card", 120, "plan");
    const r = db.prepare("SELECT card_id, card_action FROM bot_jobs WHERE job_id='job-p'").get();
    assert.deepEqual([r.card_id, r.card_action], [120, "plan"]);
  });
});
```

- [ ] **Step 3: Run + mutation-test**

Run `node --test tests/bot-jobs-card-columns.test.js`. Then delete the `card_action` entry from `BOT_JOBS_ADDED_COLUMNS` and confirm the legacy-table test fails on the count. Revert.

- [ ] **Step 4: Commit** (`scripts/pi-bots/bot-jobs-schema.mjs tests/bot-jobs-card-columns.test.js`).

---

### Task 3: `runJob` routes card jobs to the bridge

**Files:** `scripts/pi-bots/job_runner.mjs`, `tests/bot-jobs-card-routing.test.js` (create).

**This is the task that preserves the safety floor.** A card job must not go through the generic `runJob` body.

**Interfaces produced:** `runJob(job, {log})` returns its existing `{result, toolCalls, sessionId}` shape for every job. For `job.source === "card"` it delegates and maps the bridge's return onto that shape.

- [ ] **Step 1: Read the two entry points you are delegating to**

Read `scripts/pi-bots/bridge.mjs`: `planCard(opts)` (~line 858) and the `--inject` path that reaches `handleInbound` with a `cardId`. Note for `planCard`: it takes `{cardId, botId, log}`, and returns `{action:"planned", planRef}` / `{action:"error", error}` / `{action:"deferred", reason}`. Do not modify either function in this task.

- [ ] **Step 2: Write the failing test**

Create `tests/bot-jobs-card-routing.test.js`. It must prove routing **without** running pi — inject a fake bridge module rather than spawning an engine:

```js
/**
 * A card job must execute through the BRIDGE, not through runJob's generic
 * goal path. This is a safety property, not a style preference: bridge.planCard
 * forces a local model and a confinement policy stricter than the bot's own
 * (bash deny, confined write_paths, multi_agent false). A generic job runs
 * under the bot's own policy, so a routing regression silently removes that
 * floor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("a plan card job calls bridge.planCard with the card id", async () => {
  const calls = [];
  const fakeBridge = {
    planCard: async (o) => { calls.push(["planCard", o.cardId, o.botId]); return { action: "planned", planRef: { kind: "repo", path: "x.md" } }; },
    loadBot: () => { throw new Error("generic path must not be reached for a card job"); },
  };
  const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");
  const r = await runJob(
    { job_id: "j1", bot_id: "b1", source: "card", card_action: "plan", card_id: 120, goal: "plan #120" },
    { log: () => {}, bridge: fakeBridge },
  );
  assert.deepEqual(calls, [["planCard", 120, "b1"]]);
  assert.match(String(r.result), /plan/i);
});

test("a non-card job still takes the generic path", async () => {
  const fakeBridge = {
    planCard: async () => { throw new Error("planCard must not be called for a scheduled job"); },
    loadBot: () => { throw new Error("REACHED_GENERIC"); },
  };
  const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");
  await assert.rejects(
    () => runJob({ job_id: "j2", bot_id: "b1", source: "schedule", goal: "heartbeat" }, { log: () => {}, bridge: fakeBridge }),
    /REACHED_GENERIC/,
    "a scheduled job must still run the generic body",
  );
});
```

- [ ] **Step 3: Run it, expect failure**

`node --test tests/bot-jobs-card-routing.test.js` → FAIL (`runJob` ignores the injected bridge and has no card branch).

- [ ] **Step 4: Add bridge injection and the card branch**

In `runJob`, make the bridge injectable so the test never spawns pi, then branch before any generic setup:

```js
export async function runJob(job, { log = () => {}, bridge: injectedBridge = null } = {}) {
  const bridge = injectedBridge || await import("./bridge.mjs");

  // Card jobs delegate to the bridge, which owns the prompt (project context +
  // card status + FULL plan text), the planning safety floor (local-model-only,
  // bash deny, confined write_paths), stranding recovery, and the audit entry.
  // Running one through the generic body below would silently drop all of it.
  if (job.source === "card") {
    return await runCardJob(job, { log, bridge });
  }
  ...existing generic body, unchanged...
}
```

and add:

```js
/**
 * Execute a card job by delegating to the bridge entry point that owns the
 * behaviour. Maps the bridge's action union onto runJob's {result, toolCalls,
 * sessionId} contract.
 *
 * A 'deferred' outcome (pi capacity) is NOT a failure: the bridge has already
 * reset the card, and throwing here would burn a retry attempt. Report it as a
 * result so the job completes and can be re-dispatched by the operator.
 */
async function runCardJob(job, { log, bridge }) {
  const cardId = Number(job.card_id);
  if (!Number.isInteger(cardId) || cardId <= 0) throw new Error("card job has no usable card_id");

  if (job.card_action === "plan") {
    const r = await bridge.planCard({ cardId, botId: job.bot_id, log });
    if (r.action === "error") throw new Error("plan dispatch failed: " + r.error);
    if (r.action === "deferred") return { result: "deferred: " + r.reason, toolCalls: 0, sessionId: null };
    return { result: "planned: " + JSON.stringify(r.planRef), toolCalls: 0, sessionId: null };
  }
  // 'execute' (default for a card job)
  return await runCardExecute(job, { log, bridge });
}
```

- [ ] **Step 5: Implement `runCardExecute` against the real inject path**

Read how `--inject` builds its payload in `bridge.mjs` (`{bot_id, gateway_type, gateway_thread_id, user_message}` with `gateway_type: "board"` and `gateway_thread_id: "board-card-<id>"`), and call the same in-process entry point `handleInbound` uses, so the card prompt and `statusToStage` reconciliation are preserved verbatim. Do **not** re-implement prompt composition. If `handleInbound` is not directly importable with those arguments, STOP and report rather than inlining a second copy of the prompt.

- [ ] **Step 6: Run the tests, then mutation-test**

Run the new file. Then change the branch condition to `if (false)` and confirm test 1 fails with the "generic path must not be reached" error. Revert.

- [ ] **Step 7: Commit** (`scripts/pi-bots/job_runner.mjs tests/bot-jobs-card-routing.test.js`).

---

### Task 4: Stranding recovery on every terminal path

**Files:** `scripts/pi-bots/job_runner.mjs`, `tests/bot-jobs-stranding.test.js` (create).

**Scope discipline:** this is the ONLY dispatcher-side card write in the plan. It never sets a card to `done` — the bot does that through `tasks_*`. It only rescues a card whose worker is gone.

- [ ] **Step 1: Read the existing behaviour you are matching**

Read `resetStrandedCardBestEffort` in `bridge.mjs`. Reuse it; do not write a second implementation. Note it resolves the card's database the same way `planCard` does — `(projectSpace && projectSpace.tasks_db_uri) || TASKS_DB` through the `db()` helper that understands the `file:` scheme. A bare global path is wrong.

- [ ] **Step 2: Write the failing test**

`tests/bot-jobs-stranding.test.js` must cover the path the whole-branch review found uncovered:

```js
test("recoverStaleClaims un-strands the card when a card job is abandoned for good", async () => {
  // Seed: a card job in status='running' whose worker_pid is dead, at the
  // attempts cap, with its card in stage='executing'.
  // Expect: job -> 'failed' AND the card no longer in 'executing'.
  // Without this, the card is stuck forever — the exact bug the job rail was
  // adopted to prevent.
});
```

Fill in the seeding using the same throwaway-temp-DB idiom as `tests/bot-jobs-store.test.js` (import `BOT_JOBS_DDL`, never a hand-mirrored copy), plus a `tasks_items` table with the columns listed in Task 5's fixture.

- [ ] **Step 3: Wire the reset into all three terminal paths**

`recoverStaleClaims` (`job_runner.mjs` ~line 152) currently sets `status='failed'` without selecting `card_id`. Add `card_id`/`card_action` to its SELECT and call the bridge's reset when a card job reaches the attempts cap. Do the same in `tickJobs`'s failure branch and the `--run-once` CLI branch — via **one shared helper**, not three copies.

- [ ] **Step 4: Guard the write**

The reset must open its database with `busy_timeout` set (`bridge.mjs`'s `db()` helper already does; that is another reason to reuse it) and must **log** on failure. A silently swallowed `SQLITE_BUSY` here leaves the card stuck with no trace — the failure mode this task exists to remove.

- [ ] **Step 5: Run, mutation-test** (remove the `recoverStaleClaims` call; test must fail), **commit**.

---

### Task 5: All three lock predicates understand the job rail

**Files:** `servers/gateway/routes/bot-board-api.js`, `servers/gateway/dashboard/panels/bot-board/data-queries.js`, `servers/gateway/dashboard/panels/bot-board/api-handlers.js`, `tests/board-job-lock.test.js` (create).

**The Critical finding this closes:** a card locked by a `queued`/`running` job cannot be force-unlocked, because `force-unlock` tests `LOCK_STATUSES` (`{active, waiting-user}`) against the job row's status. With the runtime off, one Execute click bricks the card with no UI path back.

- [ ] **Step 1: Write the failing tests**

`tests/board-job-lock.test.js`, three cases against the real router (same harness idiom as `tests/board-stage-api.test.js`):

1. `force-unlock` clears a card locked by a `queued` job — after it, an `execute` on that card succeeds. Assert the queued job is cancelled or the lock is otherwise released; assert the endpoint does **not** return 409.
2. `lockMapFor` reports a card with a `queued` job as locked, so the board renders the lock badge and blocks drag. (Call the exported query directly; no HTTP needed.)
3. `action=move` on a card with a `running` job is refused — a manual move must not race the bot's own `tasks_*` write.

- [ ] **Step 2: Fix `force-unlock`**

Make it release job-rail locks. A queued job for that card should be marked `status='failed'` (or `cancelled`, matching whatever `bot_jobs.status` values `job_runner` already understands — check before inventing one) with an error noting the operator force-unlocked it. Do not simply widen `LOCK_STATUSES`: that set is about `bot_sessions` statuses, and adding `queued` to it would mis-describe a session.

- [ ] **Step 3: Fix `lockMapFor` and `action=move`**

Both must use the same dual-rail predicate as `lockState`. Extract one shared predicate rather than writing a third and fourth copy — `data-queries.js`'s own comment claims "The predicate is identical to the single-card form", and that claim must become true again.

- [ ] **Step 4: Run, mutation-test each of the three, commit.**

---

### Task 6: Board enqueues, safely

**Files:** `servers/gateway/routes/bot-board-api.js`, `tests/board-dispatch-job-rail.test.js` (recreate).

- [ ] **Step 1: Write the failing tests**

Recreate the v1 test file, keeping its two cases (one job per dispatch with `source='card'`/`card_id`; a second dispatch is refused) **with the v1 fix that made the second case meaningful**: reset the card's stage to `ready` before the second call, so the 409 can only come from `lockState` and not from the unrelated "card is not Ready" guard. Add two cases v1 lacked:

3. an `execute` enqueue sets `card_action='execute'`; a `plan-dispatch` enqueue sets `card_action='plan'`.
4. if the enqueue fails, the card is **not** left in `executing` (see Step 3).

- [ ] **Step 2: Enqueue in both handlers**

Mirror `tool-executor.js`'s pattern (`jobId` = `"job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8)`, `status='queued'`). Set `source='card'`, `card_id`, and `card_action`. Use `cdb.executeMultiple(BOT_JOBS_DDL)` — `execute()` takes a single statement and the DDL is multi-statement.

`deliver_to` must be **NULL** for both. The bot reports through its own `tasks_*` writes and the plan file's `## Result` section; there is no dispatcher-side delivery. (v1's `{kind:"card"}` is what inverted card ownership.)

- [ ] **Step 3: Enqueue BEFORE flipping the card's stage**

v1 set `stage='executing'` and then ran the ensure + INSERT, so a `SQLITE_BUSY` returned 500 with the card stranded in `executing` and no job. Invert: enqueue first, then flip the stage; on an enqueue error return 500 with the card untouched. Add a once-per-process latch around `ensureBotJobsColumns` (the `_botJobsEnsured` idiom in `tool-executor.js`) so the DDL does not run on every dispatch request.

- [ ] **Step 4: Repair `tests/board-stage-api.test.js` again**

Same repair as v1 Step 6: remove the four `CROW_BOARD_DISPATCH_DRYRUN` lines, and clear `bot_jobs` between the `execute` and `plan-dispatch` tests (both act on card 1, so the first's queued job would 409 the second).

- [ ] **Step 5: Run the board trio, mutation-test, full suite, commit.**

---

### Task 7: Loose ends the whole-branch review named

**Files:** `scripts/pi-bots/bot_scheduler.mjs`, `bundles/pm-workspace/server/dispatch.js`, `docs/developers/perch-hub.md`, `servers/gateway/routes/bot-board-api.js`.

- [ ] **Step 1: Fix the fifth entry point.** `bot_scheduler.mjs:41` still does `d.exec(BOT_JOBS_DDL)` DDL-first, which throws `no such column: card_id` on a legacy table into a `catch {}`. Convert it to the same PRAGMA → ALTER → DDL ensure. Verify with the legacy-table fixture.
- [ ] **Step 2: Fix the sixth.** `bundles/pm-workspace/server/dispatch.js:25` carries a hand-mirrored `bot_jobs` DDL. Replace it with an import of `BOT_JOBS_DDL` so "single source of truth" is true.
- [ ] **Step 3: Correct the docs.** `docs/developers/perch-hub.md:29` and `:72` describe board dispatch as creating a `bot_sessions` row via a detached `--inject` child. Under this plan the bridge still creates that session row, so **verify against the code before editing** — if it is still accurate after Task 3, leave it.
- [ ] **Step 4: Correct the stale comment** at `bot-board-api.js:31-33` describing the lock as "the MAX(id) `bot_sessions` row".
- [ ] **Step 5: Commit.**

---

## Settled: escalation never applies to a planning card job

**Operator ruling, 2026-08-07 — binding, not a suggestion.**

`planCard` refuses any non-local model ("no config knob reaches a paid model"). `runJob` honours `job.escalate`, whose entire purpose is to reach a *bigger* — i.e. cloud — model. For `card_action='plan'` the safety floor wins: **escalation is ignored.**

It must be ignored **explicitly and visibly**, never silently:

- `runCardJob` must not pass `job.escalate` through to `planCard`, and must not resolve an escalated model for a planning job.
- When a planning job arrives with `escalate = 1`, log it at dispatch time in a form an operator can grep, e.g.:

```js
  if (job.card_action === "plan" && job.escalate) {
    log(`job ${job.job_id}: escalate ignored — plan dispatch is local-model-only (safety floor)`);
  }
```

- Task 3's tests must include a case asserting that a planning job with `escalate = 1` still routes to `planCard` and does not request an escalated model. A test that only covers `escalate = 0` leaves the floor unproven.

If implementing this appears to require relaxing the local-model check in `planCard`, STOP and escalate — that is the one thing this plan exists to protect.

## Verification before the PR

- [ ] `npm test` — 0 fail.
- [ ] `node servers/gateway/index.js --no-auth` boots clean.
- [ ] `grep -rn "crow-local" scripts/pi-bots/bridge.mjs` — the planning floor is intact.
- [ ] No dispatcher-side write sets a card to `done`: `grep -rn "stage='done'" scripts/pi-bots/` returns only bridge reconciliation.
- [ ] CI check-runs all `completed`/`success` before merge.

## Real-boot acceptance (after merge + deploy)

r4 has 45 cards in PENDING that have never been dispatched, and a `bot_jobs` table with 3 completed heartbeat jobs.

1. Deploy with `r4-deploy.sh` (dry-run first).
2. Press **Execute** on a Ready card with an `assigned_bot`. Confirm a `bot_jobs` row with `source='card'`, `card_action='execute'`, and the right `card_id` — query a **copy** of `~/.crow-r4/data/crow.db`.
3. Confirm the worker claims it and that the bot receives the plan text (check the pi session transcript, not just the card).
4. Confirm the card's terminal state was written by the **bot** via `tasks_*`, not by the dispatcher.
5. With the pi-bots runtime stopped, press Execute, then **force-unlock** — confirm the card recovers. This is the Critical finding's regression test in the real system.
