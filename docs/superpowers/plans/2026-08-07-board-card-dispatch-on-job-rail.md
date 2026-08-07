# Board Card Dispatch on the Job Rail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bot board dispatch card work onto the `bot_jobs` worker rail — the one with scan-gated pickup, retry, and telemetry — instead of spawning a detached `bridge.mjs --inject` into the conversational rail.

**Architecture:** `bot_jobs` gains `card_id` and a `source='card'` value, so a unit of work can name the card it came from. `job_runner`'s existing `deliver_to` dispatcher gains a `kind:"card"` target that writes the outcome back onto `tasks_items` — without it, repointed cards would sit in `executing` forever. The board's `execute` and `plan-dispatch` handlers then enqueue a row instead of spawning a process, and `lockState` learns to see job-rail work so a card cannot be double-dispatched.

**Tech Stack:** Node 22, SQLite (libsql client on the gateway side, better-sqlite3 on the pi-bots side), node:test, express.

## Global Constraints

- **Node 22 on every invocation:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`. Bare `node` is v20 and some addons are built for 22.
- **Suite baseline: 3004 pass / 0 fail** (main after #275 and #276). Every task ends green.
- **No `SCHEMA_GENERATION` bump.** See "Migration strategy" below — this is deliberate and load-bearing.
- **Never open a running gateway's `crow.db`/`tasks.db` with an external sqlite3 client.** Tests use throwaway temp DBs only.
- **`init-db.js` without `CROW_DATA_DIR` writes the LIVE primary DB.** Never invoke it bare.
- **Doctrine:** every change ships via PR + green CI (`suite`, `static-checks`, `audit`; query `/commits/<sha>/check-runs`, never commit-status). `enforce_admins` is TRUE. Branch work in a worktree with `ln -s ~/crow/node_modules`. Commit with positional path args (`git commit <path> -m …`), never bare `git add .`.
- **Never attribute Claude / never add Claude as a co-author.**
- **Mutation-test every new test.** Assume a test is vacuous until a deliberate mutation proves it fails.

## Migration strategy (read before Task 1)

`bot_jobs` is **not** migrated by the `SCHEMA_GENERATION` rail. Its DDL lives in `scripts/pi-bots/bot-jobs-schema.mjs` as a pure constant that three entry points `CREATE TABLE IF NOT EXISTS` on first use — a deliberate convention documented in that file's header, because the gateway only re-runs `init-db` when a 3-table completeness check fails, so installs predating the table never get it from a restart.

Consequences you must respect:

1. Adding a column to `BOT_JOBS_DDL` gives it to **fresh** installs only. `CREATE TABLE IF NOT EXISTS` is a no-op against r4's existing table (which has 3 rows today).
2. Therefore every new column needs **both** a DDL change *and* an idempotent `ALTER TABLE ADD COLUMN` applied at each entry point.
3. We deliberately **do not** bump `SCHEMA_GENERATION`. That rail re-runs all of `init-db.js` — including 8 `DROP TABLE` statements — against four live databases, and requires the manual `scripts/schema-migration-dryrun.sh` gate. The lazy-ensure convention already covers every reader and writer of this table, so the bump buys nothing and carries real risk.

State this rationale in the PR body; a reviewer will reasonably ask why there is no bump.

## Deferred from the original spec

`bot_jobs.bot_session_id` (the job→conversation join) is **deferred**. Nothing in this plan creates a `bot_sessions` row for a board-dispatched job, so the column would ship with no writer. Add it when Perch-initiated jobs exist and there is something to join to.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/pi-bots/bot-jobs-schema.mjs` | Single source of truth for `bot_jobs` DDL | Modify — add `card_id`, index, and a pure `missingBotJobsColumns()` helper |
| `scripts/pi-bots/job_runner.mjs` | Claim/run/finalize/deliver jobs | Modify — apply column migration on connect; add `deliver_to.kind === "card"` |
| `servers/gateway/ai/tool-executor.js` | `crow_delegate` enqueue (lazy self-heal site) | Modify — apply column migration |
| `scripts/init-db.js` | Fresh-install schema build | Modify — apply column migration after the DDL |
| `servers/gateway/routes/bot-board-api.js` | Board REST API | Modify — `execute` + `plan-dispatch` enqueue; `lockState` sees jobs |
| `tests/bot-jobs-card-columns.test.js` | Migration helper + idempotence | Create |
| `tests/bot-jobs-card-delivery.test.js` | `kind:"card"` write-back | Create |
| `tests/board-dispatch-job-rail.test.js` | Board enqueues instead of spawning | Create |
| `tests/bot-jobs-store.test.js` | Existing job-store tests | Modify — import the real DDL instead of a hand-mirrored copy |

---

### Task 1: `bot_jobs` gains `card_id` and a reusable migration helper

**Files:**
- Modify: `scripts/pi-bots/bot-jobs-schema.mjs`
- Create: `tests/bot-jobs-card-columns.test.js`
- Modify: `tests/bot-jobs-store.test.js` (replace the hand-mirrored schema)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BOT_JOBS_DDL: string` (existing export, now includes `card_id INTEGER` and `idx_bot_jobs_card`)
  - `BOT_JOBS_ADDED_COLUMNS: Array<{name: string, ddl: string}>`
  - `missingBotJobsColumns(existingColumnNames: string[]): string[]` — pure; returns the `ALTER TABLE` statements still needed. Returns `[]` for a table created from the current `BOT_JOBS_DDL`.

- [ ] **Step 1: Write the failing test**

Create `tests/bot-jobs-card-columns.test.js`:

```js
/**
 * bot_jobs card_id migration. The DDL is CREATE TABLE IF NOT EXISTS shared by
 * three entry points, so a new column reaches EXISTING installs only via an
 * idempotent ALTER applied on first use. These pin both halves: fresh tables
 * need no ALTER, pre-existing ones get exactly the missing columns, and
 * running the migration twice is a no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BOT_JOBS_DDL, BOT_JOBS_ADDED_COLUMNS, missingBotJobsColumns,
} from "../scripts/pi-bots/bot-jobs-schema.mjs";

/** The pre-card_id table, exactly as it exists on installs today. */
const LEGACY_DDL = `
  CREATE TABLE bot_jobs (
    job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', deliver_to TEXT, source TEXT,
    schedule_id INTEGER, escalate INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    pi_session_id TEXT, tool_calls INTEGER, worker_pid INTEGER,
    claimed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT, ended_at TEXT
  );`;

function withDb(ddl, fn) {
  const dir = mkdtempSync(join(tmpdir(), "botjobs-cols-"));
  const db = new Database(join(dir, "crow.db"));
  try { db.exec(ddl); return fn(db); }
  finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

const cols = (db) => db.prepare("PRAGMA table_info(bot_jobs)").all().map((r) => r.name);

test("a table built from the current DDL already has card_id and needs no ALTER", () => {
  withDb(BOT_JOBS_DDL, (db) => {
    assert.ok(cols(db).includes("card_id"), "current DDL must create card_id");
    assert.deepEqual(missingBotJobsColumns(cols(db)), [],
      "a fresh table must require no migration — otherwise every boot re-ALTERs");
  });
});

test("a legacy table is missing card_id and the helper names exactly that ALTER", () => {
  withDb(LEGACY_DDL, (db) => {
    assert.equal(cols(db).includes("card_id"), false);
    const stmts = missingBotJobsColumns(cols(db));
    assert.equal(stmts.length, BOT_JOBS_ADDED_COLUMNS.length);
    assert.match(stmts[0], /ALTER TABLE bot_jobs ADD COLUMN card_id INTEGER/);
  });
});

test("applying the migration to a legacy table is idempotent", () => {
  withDb(LEGACY_DDL, (db) => {
    for (const s of missingBotJobsColumns(cols(db))) db.exec(s);
    assert.ok(cols(db).includes("card_id"), "card_id must exist after migrating");

    // Second pass: nothing left to do. A non-empty list here would mean every
    // entry point re-runs ALTER on every connect and throws "duplicate column".
    assert.deepEqual(missingBotJobsColumns(cols(db)), []);
  });
});

test("card_id survives a round-trip and defaults to NULL for non-card jobs", () => {
  withDb(BOT_JOBS_DDL, (db) => {
    db.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, source) VALUES (?,?,?,?)")
      .run("job-a", "bot-1", "do a thing", "schedule");
    db.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, source, card_id) VALUES (?,?,?,?,?)")
      .run("job-b", "bot-1", "work card 120", "card", 120);

    assert.equal(db.prepare("SELECT card_id FROM bot_jobs WHERE job_id='job-a'").get().card_id, null);
    assert.equal(db.prepare("SELECT card_id FROM bot_jobs WHERE job_id='job-b'").get().card_id, 120);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node --test tests/bot-jobs-card-columns.test.js
```

Expected: FAIL — `BOT_JOBS_ADDED_COLUMNS` and `missingBotJobsColumns` are not exported (`SyntaxError: The requested module ... does not provide an export named ...`).

- [ ] **Step 3: Implement**

In `scripts/pi-bots/bot-jobs-schema.mjs`, add `card_id` to the `CREATE TABLE` body immediately after `schedule_id`:

```js
    schedule_id   INTEGER,                         -- set when launched by the bot cron runner
    card_id       INTEGER,                         -- board card this job executes (source='card')
```

Add an index inside the same template literal, after `idx_bot_jobs_bot`:

```js
  CREATE INDEX IF NOT EXISTS idx_bot_jobs_card
    ON bot_jobs(card_id) WHERE card_id IS NOT NULL;
```

Then append to the file:

```js
/**
 * Columns added AFTER the table shipped. CREATE TABLE IF NOT EXISTS cannot add
 * them to an existing install, so every entry point applies these on first use
 * — the same lazy-ensure contract as the table itself.
 *
 * Adding one here means: add it to BOT_JOBS_DDL above TOO, or fresh installs
 * take the ALTER path forever.
 */
export const BOT_JOBS_ADDED_COLUMNS = [
  { name: "card_id", ddl: "ALTER TABLE bot_jobs ADD COLUMN card_id INTEGER" },
];

/**
 * Pure: given the column names a live bot_jobs table has, return the ALTER
 * statements still needed. Callers apply them with their own client (the
 * gateway is async libsql, pi-bots is sync better-sqlite3), which is why this
 * returns SQL rather than executing it.
 *
 * @param {string[]} existingColumnNames  from PRAGMA table_info(bot_jobs)
 * @returns {string[]}
 */
export function missingBotJobsColumns(existingColumnNames) {
  const have = new Set(existingColumnNames || []);
  return BOT_JOBS_ADDED_COLUMNS.filter((c) => !have.has(c.name)).map((c) => c.ddl);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/bot-jobs-card-columns.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-test the new tests**

Temporarily change `missingBotJobsColumns` to `return [];` unconditionally. Re-run.

Expected: the "legacy table" and "idempotent" tests FAIL. If they pass, they are vacuous — fix them before continuing. Revert the mutation.

- [ ] **Step 6: Remove the hand-mirrored schema from the existing store test**

In `tests/bot-jobs-store.test.js`, delete the local `const SCHEMA = \`...\`` block and import the real DDL, so the two can never drift:

```js
import { BOT_JOBS_DDL } from "../scripts/pi-bots/bot-jobs-schema.mjs";
```

and in `before()` replace `init.exec(SCHEMA)` with:

```js
  init.exec(BOT_JOBS_DDL);
```

- [ ] **Step 7: Verify the store tests still pass**

```bash
node --test tests/bot-jobs-store.test.js
```

Expected: PASS, unchanged count.

- [ ] **Step 8: Commit**

```bash
git commit scripts/pi-bots/bot-jobs-schema.mjs tests/bot-jobs-card-columns.test.js tests/bot-jobs-store.test.js \
  -m "feat(bot-jobs): card_id column plus a pure migration helper

CREATE TABLE IF NOT EXISTS cannot add a column to an existing install, so
card_id ships as both a DDL change (fresh installs) and an idempotent ALTER
that every entry point applies on first use — the lazy-ensure contract this
table already uses. No SCHEMA_GENERATION bump: that rail re-runs all of
init-db (8 DROP TABLEs) against four live DBs and buys nothing here.

bot-jobs-store.test.js now imports the real DDL instead of a hand-mirrored
copy that was kept in sync by intent."
```

---

### Task 2: Every entry point applies the migration on first use

**Files:**
- Modify: `scripts/pi-bots/job_runner.mjs`
- Modify: `servers/gateway/ai/tool-executor.js`
- Modify: `scripts/init-db.js`
- Modify: `tests/bot-jobs-card-columns.test.js` (add the entry-point test)

**Interfaces:**
- Consumes: `BOT_JOBS_DDL`, `missingBotJobsColumns` from Task 1.
- Produces: `ensureBotJobsSchema(conn)` exported from `scripts/pi-bots/job_runner.mjs` — sync, better-sqlite3, safe to call on every connect.

- [ ] **Step 1: Write the failing test**

Append to `tests/bot-jobs-card-columns.test.js`:

```js
test("job_runner self-heals a legacy table on connect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botjobs-heal-"));
  const dbPath = join(dir, "crow.db");
  const seed = new Database(dbPath);
  seed.exec(LEGACY_DDL);
  seed.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal) VALUES ('j1','b1','g')").run();
  seed.close();

  process.env.CROW_DB_PATH = dbPath;
  const mod = await import("../scripts/pi-bots/job_runner.mjs");

  const c = new Database(dbPath);
  try {
    mod.ensureBotJobsSchema(c);
    const names = c.prepare("PRAGMA table_info(bot_jobs)").all().map((r) => r.name);
    assert.ok(names.includes("card_id"), "an existing install must gain card_id without init-db");

    // The pre-existing row must survive — ALTER ADD COLUMN, never a rebuild.
    assert.equal(c.prepare("SELECT COUNT(*) n FROM bot_jobs").get().n, 1);

    mod.ensureBotJobsSchema(c); // second call must not throw "duplicate column"
  } finally {
    c.close(); rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test tests/bot-jobs-card-columns.test.js
```

Expected: FAIL — `mod.ensureBotJobsSchema is not a function`.

- [ ] **Step 3: Implement in `job_runner.mjs`**

Extend the existing schema import at line 43:

```js
import { BOT_JOBS_DDL, missingBotJobsColumns } from "./bot-jobs-schema.mjs";
```

Add the exported helper next to the other store functions:

```js
/**
 * Create the table if absent, then add any columns introduced after it
 * shipped. Both halves are idempotent, and an existing install has no other
 * path to a new column (the gateway re-runs init-db only when its 3-table
 * completeness check fails).
 * @param {import('better-sqlite3').Database} conn
 */
export function ensureBotJobsSchema(conn) {
  conn.exec(BOT_JOBS_DDL);
  const names = conn.prepare("PRAGMA table_info(bot_jobs)").all().map((r) => r.name);
  for (const stmt of missingBotJobsColumns(names)) conn.exec(stmt);
}
```

`dbConn()` (line 58) already ensures the DDL once per process behind a
module-level `_botJobsEnsured` latch. Keep that latch — it is what stops a
`PRAGMA table_info` on every single connect — and widen what it guards:

```js
function dbConn() {
  const d = new Database(botsDbPath());
  d.pragma("busy_timeout = 10000");
  if (!_botJobsEnsured) { try { ensureBotJobsSchema(d); _botJobsEnsured = true; } catch {} }
  return d;
}
```

Note this connects to `botsDbPath()`, not a generic `dbPath()`. Do not change
that. The latch means the migration runs on the first connect of each process,
which is exactly the lazy-ensure contract.

- [ ] **Step 4: Implement in `tool-executor.js`**

This side is async libsql. Extend the existing import at line 23 — the path is already correct, only the named-import list changes:

```js
import { BOT_JOBS_DDL, missingBotJobsColumns } from "../../../scripts/pi-bots/bot-jobs-schema.mjs";
```

Immediately after the DDL exec, before the insert:

```js
      // Columns added after the table shipped reach existing installs only here.
      const info = await db.execute("PRAGMA table_info(bot_jobs)");
      const names = info.rows.map((r) => r.name);
      for (const stmt of missingBotJobsColumns(names)) await db.execute(stmt);
```

- [ ] **Step 5: Implement in `init-db.js`**

After the statement that executes `BOT_JOBS_DDL`, add:

```js
// bot_jobs columns added after the table shipped. Fresh installs get them from
// the DDL above; this covers a DB that predates them.
{
  const info = await db.execute("PRAGMA table_info(bot_jobs)");
  const names = info.rows.map((r) => r.name);
  for (const stmt of missingBotJobsColumns(names)) await db.execute(stmt);
}
```

and extend the existing import at line 7 to include `missingBotJobsColumns`:

```js
import { BOT_JOBS_DDL, missingBotJobsColumns } from "./pi-bots/bot-jobs-schema.mjs";
```

- [ ] **Step 6: Run the tests**

```bash
node --test tests/bot-jobs-card-columns.test.js tests/bot-jobs-store.test.js
```

Expected: PASS.

- [ ] **Step 7: Mutation-test**

Change `ensureBotJobsSchema` to skip the ALTER loop (`for (const stmt of []) …`). Re-run.

Expected: the self-heal test FAILS. Revert.

- [ ] **Step 8: Commit**

```bash
git commit scripts/pi-bots/job_runner.mjs servers/gateway/ai/tool-executor.js scripts/init-db.js tests/bot-jobs-card-columns.test.js \
  -m "feat(bot-jobs): apply the card_id migration at every entry point

The table's contract is lazy-ensure at each entry point, not the
SCHEMA_GENERATION rail, so a new column needs the same treatment or existing
installs never see it. ensureBotJobsSchema() is idempotent and runs on every
connect."
```

---

### Task 3: A job can deliver its result back to a board card

**Files:**
- Modify: `scripts/pi-bots/job_runner.mjs` (the `deliverResult` dispatcher)
- Create: `tests/bot-jobs-card-delivery.test.js`

**Interfaces:**
- Consumes: `card_id` from Task 1.
- Produces: `deliver_to = {"kind":"card","card_id":<int>}` handled in `deliverResult`. On success the card moves to `stage='done', status='done'`; on failure to `stage='blocked', status='pending'`. Exported helper `applyCardOutcome({ tasksDbPath: string, cardId: number, ok: boolean })` for direct testing.

**Why this task exists:** `deliverResult` today handles `memory`, `poll`, `gmail`, and `gateway`. None of them touch `tasks_items`. Repointing the board without this leaves every dispatched card stuck in `executing` forever.

- [ ] **Step 1: Write the failing test**

Create `tests/bot-jobs-card-delivery.test.js`:

```js
/**
 * deliver_to {kind:"card"} — a finished job writes its outcome back onto the
 * board card that produced it. Without this the board's repointed dispatch
 * would strand every card in 'executing'.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TASKS_DDL = `
  CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY, title TEXT, status TEXT, stage TEXT,
    assigned_bot TEXT, plan_ref TEXT, project_id INTEGER,
    updated_at TEXT
  );`;

function seedCard(dir, stage = "executing") {
  const p = join(dir, "tasks.db");
  const db = new Database(p);
  db.exec(TASKS_DDL);
  db.prepare("INSERT INTO tasks_items (id,title,status,stage,assigned_bot) VALUES (?,?,?,?,?)")
    .run(120, "Safe rolling updates", "in_progress", stage, "r4-assistant");
  db.close();
  return p;
}
const readCard = (p) => new Database(p).prepare("SELECT stage,status FROM tasks_items WHERE id=120").get();

test("a completed card job moves the card to done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carddeliver-"));
  try {
    const tasksDbPath = seedCard(dir);
    const mod = await import("../scripts/pi-bots/job_runner.mjs");
    mod.applyCardOutcome({ tasksDbPath, cardId: 120, ok: true });
    assert.deepEqual(readCard(tasksDbPath), { stage: "done", status: "done" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed card job blocks the card rather than leaving it executing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carddeliver-fail-"));
  try {
    const tasksDbPath = seedCard(dir);
    const mod = await import("../scripts/pi-bots/job_runner.mjs");
    mod.applyCardOutcome({ tasksDbPath, cardId: 120, ok: false });
    const row = readCard(tasksDbPath);
    assert.equal(row.stage, "blocked", "a failed job must not leave the card in executing");
    assert.equal(row.status, "pending");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing card is a no-op, not a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carddeliver-missing-"));
  try {
    const tasksDbPath = seedCard(dir);
    const mod = await import("../scripts/pi-bots/job_runner.mjs");
    // Delivery runs after the job already succeeded; a deleted card must not
    // turn a completed job into a crashed worker.
    mod.applyCardOutcome({ tasksDbPath, cardId: 999, ok: true });
    assert.deepEqual(readCard(tasksDbPath), { stage: "executing", status: "in_progress" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test tests/bot-jobs-card-delivery.test.js
```

Expected: FAIL — `mod.applyCardOutcome is not a function`.

- [ ] **Step 3: Implement `applyCardOutcome`**

In `scripts/pi-bots/job_runner.mjs`, add near the other exported store helpers:

```js
/**
 * Write a finished job's outcome onto its board card. Opens tasks.db directly
 * (the board's cards live there, not in crow.db) with the same better-sqlite3
 * client the rest of this module uses.
 *
 * Failure blocks the card instead of leaving it in 'executing' — a stuck card
 * is invisible, a blocked one is actionable.
 *
 * Deliberately does NOT carry the result or error text: finalizeJob already
 * persists both on the bot_jobs row, and tasks_items has no column for them.
 * The job row is the record; the card is the state.
 *
 * @param {{tasksDbPath: string, cardId: number, ok: boolean}} o
 */
export function applyCardOutcome({ tasksDbPath, cardId, ok }) {
  const c = new Database(tasksDbPath);
  try {
    const stage = ok ? "done" : "blocked";
    const status = ok ? "done" : "pending";
    c.prepare(
      "UPDATE tasks_items SET stage=?, status=?, updated_at=datetime('now') WHERE id=?"
    ).run(stage, status, cardId);
  } catch {
    // Delivery runs after the work already succeeded. A tasks.db problem must
    // not escalate into a failed job or a dead worker.
  } finally {
    try { c.close(); } catch {}
  }
}
```

- [ ] **Step 4: Wire it into `deliverResult`**

In `deliverResult`, alongside the existing `memory` / `poll` branches, add:

```js
  if (kind === "card") {
    const cardId = Number(deliver.card_id ?? job.card_id);
    if (Number.isInteger(cardId)) {
      applyCardOutcome({ tasksDbPath: resolveTasksDbPath(), cardId, ok: true });
      log(`card ${cardId} marked done by job ${job.job_id}`);
    }
    return;
  }
```

Import the tasks-db path resolver at the top of the file if it is not already imported:

```js
import { tasksDbPath as resolveTasksDbPath } from "./instance-paths.mjs";
```

- [ ] **Step 5: Handle the failure path — once, in a shared helper**

`deliverResult` runs only for completed jobs, so a *failed* card job would never
reach the write-back and its card would stay in `executing`. Two call sites need
this: `tickJobs` and the `--run-once` CLI branch, which has its own copy of the
finalize logic.

Do **not** paste the same block into both — extract a helper next to
`applyCardOutcome`:

```js
/**
 * Post-finalize hook for a card-sourced job's FAILURE path. Success flows
 * through deliverResult's kind:"card" branch instead.
 *
 * Exists so tickJobs and the --run-once CLI branch share one implementation:
 * they already keep separate copies of the finalize logic, and a second
 * divergent copy of the card write-back is how one path silently stops
 * updating the board.
 *
 * @param {{card_id: number|null}} job
 * @param {{status: string}} outcome
 */
export function applyCardFailure(job, outcome) {
  if (outcome.status !== "failed") return;
  if (job.card_id == null) return;
  applyCardOutcome({ tasksDbPath: resolveTasksDbPath(), cardId: Number(job.card_id), ok: false });
}
```

Then call it immediately after `finalizeJob(...)` in **both** places:

```js
    applyCardFailure(job, outcome);
```

- [ ] **Step 6: Run the tests**

```bash
node --test tests/bot-jobs-card-delivery.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Mutation-test**

Change `applyCardOutcome`'s failure branch to use `stage = "done"` for both outcomes. Re-run.

Expected: the "failed card job blocks the card" test FAILS. Revert.

- [ ] **Step 8: Commit**

```bash
git commit scripts/pi-bots/job_runner.mjs tests/bot-jobs-card-delivery.test.js \
  -m "feat(bot-jobs): deliver_to kind 'card' writes the outcome back to the board

deliverResult handled memory/poll/gmail/gateway, none of which touch
tasks_items — so a card-sourced job would finish and leave its card in
'executing' forever. Success moves the card to done; failure blocks it, because
a stuck card is invisible and a blocked one is actionable. A missing card is a
no-op: delivery runs after the work succeeded and must not crash the worker."
```

---

### Task 4: The board enqueues jobs instead of spawning a bridge

**Files:**
- Modify: `servers/gateway/routes/bot-board-api.js` (`lockState` ~line 77, `execute` ~line 546, `plan-dispatch` ~line 602)
- Create: `tests/board-dispatch-job-rail.test.js`
- Modify: `tests/board-stage-api.test.js` (this task removes a seam it depends on — see Step 6)

**Interfaces:**
- Consumes: `card_id` (Task 1), `ensureBotJobsSchema` semantics (Task 2), `deliver_to.kind = "card"` (Task 3).
- Produces: `POST /dashboard/bot-board-api/card/:id/execute` inserts one `bot_jobs` row with `source='card'`, `card_id=<id>`, `deliver_to='{"kind":"card","card_id":<id>}'`, `status='queued'`, and returns `{ ok: true, dispatched: <botId>, jobId: <string> }`. `lockState` reports `locked` when a queued or running `bot_jobs` row exists for the card.

- [ ] **Step 1: Write the failing test**

Create `tests/board-dispatch-job-rail.test.js`:

```js
/**
 * The board dispatches onto the job rail.
 *
 * Before this, execute/plan-dispatch spawned a detached `bridge.mjs --inject`
 * into the CONVERSATIONAL rail (bot_sessions) — so the board's work never
 * appeared in bot_jobs, never got scan-gated pickup, retry, or telemetry, and
 * could not be recovered if the worker died.
 *
 * These run the real router against throwaway DBs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BOT_JOBS_DDL } from "../scripts/pi-bots/bot-jobs-schema.mjs";

const dir = mkdtempSync(join(tmpdir(), "board-jobrail-"));
const crowDb = join(dir, "crow.db");
const tasksDb = join(dir, "tasks.db");

process.env.CROW_DB_PATH = crowDb;
process.env.CROW_TASKS_DB_PATH = tasksDb;

function seed() {
  const c = new Database(crowDb);
  c.exec(BOT_JOBS_DDL);
  c.exec(`CREATE TABLE IF NOT EXISTS pi_bot_defs (
    bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER,
    created_at TEXT, updated_at TEXT);`);
  c.exec(`CREATE TABLE IF NOT EXISTS bot_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, pi_session_id TEXT,
    pi_session_dir TEXT, gateway_type TEXT, gateway_thread_id TEXT, project_id INTEGER,
    card_id INTEGER, plan_path TEXT, status TEXT NOT NULL DEFAULT 'active',
    control TEXT NOT NULL DEFAULT 'run', model TEXT, escalated INTEGER DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'chat', narrowed_tools TEXT,
    created_at TEXT, updated_at TEXT);`);
  c.prepare("INSERT INTO pi_bot_defs (bot_id,display_name,enabled) VALUES ('r4-assistant','R4',1)").run();
  c.close();

  const t = new Database(tasksDb);
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY, title TEXT, status TEXT, stage TEXT,
    assigned_bot TEXT, plan_ref TEXT, project_id INTEGER, updated_at TEXT);`);
  t.prepare("INSERT INTO tasks_items (id,title,status,stage,assigned_bot) VALUES (?,?,?,?,?)")
    .run(120, "card", "pending", "ready", "r4-assistant");
  t.close();
}

let server, port;
before(async () => {
  seed();
  const { default: boardRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(boardRouter((req, res, next) => next()));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;
});
after(() => {
  try { server.closeAllConnections?.(); server.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const post = (path) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
const jobs = () => new Database(crowDb).prepare("SELECT * FROM bot_jobs").all();

test("execute enqueues one card-sourced job", async () => {
  const res = await post("/dashboard/bot-board-api/card/120/execute");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.jobId, "the caller must learn the job id it created");

  const rows = jobs();
  assert.equal(rows.length, 1, "exactly one job per dispatch");
  assert.equal(rows[0].card_id, 120, "the job must name its card");
  assert.equal(rows[0].source, "card");
  assert.equal(rows[0].status, "queued", "the worker claims it — the API must not run it inline");
  assert.equal(rows[0].bot_id, "r4-assistant");
  assert.deepEqual(JSON.parse(rows[0].deliver_to), { kind: "card", card_id: 120 });
});

test("a second execute while the job is queued is refused, not duplicated", async () => {
  const res = await post("/dashboard/bot-board-api/card/120/execute");
  assert.equal(res.status, 409, "a queued job must lock the card");
  assert.equal(jobs().length, 1, "the card must not accumulate duplicate work");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test tests/board-dispatch-job-rail.test.js
```

Expected: FAIL — `rows.length` is 0, because `execute` spawns a bridge and writes no job row.

- [ ] **Step 3: Teach `lockState` about the job rail**

Replace the body of `lockState` (`servers/gateway/routes/bot-board-api.js:77`):

```js
async function lockState(cdb, cardId) {
  // A card is locked by EITHER rail: a live conversational session (the legacy
  // bridge path) or an unfinished job (the current dispatch path). Checking
  // only bot_sessions let a queued job be dispatched a second time.
  try {
    const job = (await cdb.execute({
      sql: "SELECT job_id, status FROM bot_jobs WHERE card_id=? AND status IN ('queued','running') "
         + "ORDER BY rowid DESC LIMIT 1",
      args: [cardId],
    })).rows[0];
    if (job) return { locked: true, row: job };
  } catch {
    // bot_jobs absent on this instance — fall through to the session check.
  }
  try {
    const r = (await cdb.execute({
      sql:
        "SELECT id, status, pi_session_dir, " +
        "(strftime('%s','now') - strftime('%s', updated_at)) AS age_s " +
        "FROM bot_sessions WHERE card_id=? ORDER BY id DESC LIMIT 1",
      args: [cardId],
    })).rows[0];
    if (!r) return { locked: false, row: null };
    return { locked: LOCK_STATUSES.has(String(r.status)), row: r };
  } catch {
    return { locked: false, row: null };
  }
}
```

- [ ] **Step 4: Replace the spawn in `execute` with an enqueue**

In the `execute` handler, replace the whole `if (!process.env.CROW_BOARD_DISPATCH_DRYRUN) { … }` block with:

```js
      const jobId = "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      await ensureBotJobsColumns(cdb);
      await cdb.execute({
        sql: "INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source, card_id) "
           + "VALUES (?, ?, ?, 'queued', ?, 'card', ?)",
        args: [
          jobId, bot, "Execute board card #" + id,
          JSON.stringify({ kind: "card", card_id: id }), id,
        ],
      });
      return res.json({ ok: true, dispatched: bot, jobId });
```

Delete the now-unreachable `return res.json({ ok: true, dispatched: bot });` below it.

Add the ensure helper near `lockState`:

```js
/** Lazy-ensure bot_jobs + its post-ship columns from the gateway side. */
async function ensureBotJobsColumns(cdb) {
  await cdb.execute(BOT_JOBS_DDL);
  const info = await cdb.execute("PRAGMA table_info(bot_jobs)");
  for (const stmt of missingBotJobsColumns(info.rows.map((r) => r.name))) {
    await cdb.execute(stmt);
  }
}
```

and import at the top of the file:

```js
import { BOT_JOBS_DDL, missingBotJobsColumns } from "../../../scripts/pi-bots/bot-jobs-schema.mjs";
```

> Confirm the relative depth against a sibling import in this file before committing.

- [ ] **Step 5: Do the same for `plan-dispatch`**

Replace its spawn block with an enqueue whose goal names the planning intent. The card stays in `planning`; the plan file is the deliverable, so delivery stays `poll`:

```js
      const jobId = "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      await ensureBotJobsColumns(cdb);
      await cdb.execute({
        sql: "INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source, card_id) "
           + "VALUES (?, ?, ?, 'queued', ?, 'card', ?)",
        args: [
          jobId, bot, "Write an implementation plan for board card #" + id,
          JSON.stringify({ kind: "poll" }), id,
        ],
      });
      return res.json({ ok: true, dispatched: bot, jobId });
```

- [ ] **Step 6: Repair `tests/board-stage-api.test.js` — this task breaks it**

Two existing tests there use `CROW_BOARD_DISPATCH_DRYRUN = "1"` as a seam to
skip the real spawn (lines ~178 and ~198). This task deletes that seam, and
that creates a **real cross-test failure**, not just a dead env var:

- the `execute` test dispatches **card 1** — which now leaves a `queued`
  `bot_jobs` row for card 1;
- the `plan-dispatch` test then acts on **card 1** as well — and the new
  `lockState` correctly sees that queued job and returns **409**, so its
  `assert.equal(ok.ok, true)` fails.

Fix both, in this order:

1. Delete the four `CROW_BOARD_DISPATCH_DRYRUN` lines (the two assignments and
   the two `delete` calls). The env var no longer exists in the source.
2. Clear the job queue between the two tests so the lock cannot leak. Add this
   immediately before the `plan-dispatch` test's first `fetch`:

```js
  // execute (above) enqueued a queued job for this same card; lockState now
  // treats that as a lock, which would 409 this dispatch. Clear it — these two
  // tests deliberately reuse card 1.
  const jq = new Database(process.env.CROW_DB_PATH);
  jq.exec("DELETE FROM bot_jobs");
  jq.close();
```

3. In the `execute` test, tighten the assertion to prove the new rail is used
   rather than only that the call returned 200:

```js
  assert.equal(ok.dispatched, "scout");
  const jdb = new Database(process.env.CROW_DB_PATH);
  const job = jdb.prepare("SELECT source, card_id, status FROM bot_jobs WHERE card_id=1").get();
  jdb.close();
  assert.deepEqual([job.source, job.card_id, job.status], ["card", 1, "queued"]);
```

- [ ] **Step 7: Run the tests**

```bash
node --test tests/board-dispatch-job-rail.test.js tests/board-stage-api.test.js tests/board-plan-dispatch.test.js
```

Expected: PASS — the 2 new tests plus every existing board test.

- [ ] **Step 8: Mutation-test**

Change `lockState`'s job query to `status IN ('running')` only. Re-run.

Expected: the "second execute is refused" test FAILS (a queued job no longer locks). Revert.

- [ ] **Step 9: Run the full suite**

```bash
npm test > /tmp/suite.log 2>&1; echo "EXIT=$?"
grep -E '^# (tests|pass|fail)' /tmp/suite.log | tail -3
```

Expected: 0 fail. Baseline 3004 plus the tests added here.

- [ ] **Step 10: Commit**

```bash
git commit servers/gateway/routes/bot-board-api.js tests/board-dispatch-job-rail.test.js tests/board-stage-api.test.js \
  -m "feat(board): dispatch cards onto the job rail instead of spawning a bridge

execute and plan-dispatch spawned a detached bridge.mjs --inject into the
CONVERSATIONAL rail, so board work never reached bot_jobs and never got
scan-gated pickup, retry, stale-claim recovery, or telemetry. Both now enqueue
a queued bot_jobs row with source='card' and card_id, and the existing worker
claims it like any other job.

lockState now treats a queued-or-running job as a lock. Checking only
bot_sessions would have let the same card be dispatched twice, since the job
rail writes no session row.

Also drops three hardcoded ~/.nvm/versions/node/v20.20.2 paths from the
dispatch path — pi_resolver.mjs's own header calls that pattern out as a
single-machine portability trap."
```

---

## Verification before the PR

- [ ] `npm test` — 0 fail.
- [ ] Boot check: `node servers/gateway/index.js --no-auth` starts cleanly, then ctrl-C.
- [ ] Confirm no `v20.20.2` literal remains in the dispatch path:
      `grep -n 'v20.20.2' servers/gateway/routes/bot-board-api.js` → only `session/send` (out of scope) or nothing.
- [ ] Open the PR; query `https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` and confirm `suite`, `static-checks`, and `audit` are all `completed`/`success` before merging. An empty result means something is wrong, not that CI passed.
- [ ] PR body must state why there is **no** `SCHEMA_GENERATION` bump (see "Migration strategy").

## Real-boot acceptance (after merge + deploy)

1. Deploy to r4: `SUDO_ASKPASS=… /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh` (dry-run first).
2. On r4's board, pick a card in **Ready** with an `assigned_bot`, press **Execute**.
3. Confirm a `bot_jobs` row appears with `source='card'` and the right `card_id` — query a **copy** of `~/.crow-r4/data/crow.db`, never the live file.
4. Confirm the worker claims it (`status='running'`, `worker_pid` set), then completes.
5. Confirm the card lands in **Done** on the board, not stuck in **Executing**.
6. Press **Execute** twice quickly on another card and confirm the second returns 409 with no duplicate row.

## Known risk to watch

`tickJobs` gates pickup on `countLivePi()` against `LIFECYCLE_DEFAULTS.maxPi`. There is a standing fleet-wide defect where `process.title` handling makes `countLivePi` unreliable, which can make that reserve gate ineffective. This plan does not fix it and does not depend on it, but board dispatch will increase job volume — if pickup misbehaves under load, that gate is the first place to look, not this change.
