// tests/board-plan-result-service.test.js
//
// Track 1 Task 3: plan-service.js (plans as records, D-T1.4) +
// result-service.js (per-card autonomy / results / the result↔lock
// contract, D-T1.5). Same fixture pattern as tests/board-card-service.test.js
// (Task 2): real 0004 migration run via the runner, board_defs seeded with
// TWO project boards — one whose terminal_values includes 'done' (the
// autonomy auto-move target exists), one whose terminal_values does NOT
// (the auto-move must be a no-op there) — for the autonomy × outcome ×
// def-has-done matrix. cdb's bot_sessions gains `bot_id` (absent from Task
// 2's fixture, needed here for the session-rail lock-exemption tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { createDbClient } from "../servers/db.js";
import { createCard, getCard } from "../servers/gateway/board/card-service.js";
import { getCurrentPlan, listPlans, savePlan, approvePlan } from "../servers/gateway/board/plan-service.js";
import { reportResult, decideResult, listResults } from "../servers/gateway/board/result-service.js";

const DIR = join(import.meta.dirname, "..", "scripts", "migrations");

const HUMAN = { kind: "human", id: "kevin", jobId: null };
const BOT = { kind: "bot", id: "bot-1", jobId: "job-abc" };

function markPriorDone(c) {
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
}

function seedPost0003TasksDb(t) {
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT, stage TEXT,
    board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

/**
 * A fresh migrated store: real 0004 run, board_defs seeded with:
 *   - project_id=1 "HasDone" — statuses incl a terminal 'done' (the
 *     autonomy auto-move target exists)
 *   - project_id=2 "NoDone" — statuses/terminals that never include 'done'
 *     (the auto-move must be a structural no-op: 'done' is not even a
 *     valid status on this board)
 * cdb carries bot_jobs/bot_sessions (bot_sessions WITH bot_id, unlike Task
 * 2's fixture — needed for the session-rail lock-exemption tests here).
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "planresultsvc-"));
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");

  const c = new Database(dbPath);
  markPriorDone(c);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT);
    CREATE TABLE bot_jobs (job_id TEXT PRIMARY KEY, bot_id TEXT, card_id INTEGER, card_action TEXT,
      status TEXT, worker_pid INTEGER, started_at TEXT);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, card_id INTEGER, status TEXT,
      pi_session_dir TEXT, updated_at TEXT DEFAULT (datetime('now')));`);
  c.close();

  const t = new Database(tasksDbPath);
  seedPost0003TasksDb(t);
  t.close();

  return { root, dbPath, tasksDbPath };
}

async function withStore(fn) {
  const f = fixture();
  try {
    await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, sha: "test", log: () => {} });
    const tdb = createDbClient(f.tasksDbPath);
    const cdb = createDbClient(f.dbPath);
    await tdb.execute({
      sql: "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (1,'HasDone',?,?,'[]')",
      args: ['["pending","in_progress","done"]', '["done"]'],
    });
    await tdb.execute({
      sql: "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (2,'NoDone',?,?,'[]')",
      args: ['["backlog","working","complete"]', '["complete"]'],
    });
    try {
      await fn({ tdb, cdb, tasksDbPath: f.tasksDbPath, dbPath: f.dbPath });
    } finally {
      tdb.close();
      cdb.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

async function allMutations(tdb, itemId) {
  return (await tdb.execute({ sql: "SELECT * FROM board_mutations WHERE item_id=? ORDER BY id ASC", args: [itemId] })).rows;
}

// The starting (non-terminal) status per project board.
const START_STATUS = { 1: "pending", 2: "backlog" };

async function makeCard(tdb, projectId, autonomy, actor = HUMAN) {
  const { id } = await createCard(
    tdb,
    { title: "t", status: START_STATUS[projectId], project_id: projectId, autonomy },
    actor,
  );
  return id;
}

// ---------------------------------------------------------------------------
// plan-service.js
// ---------------------------------------------------------------------------

test("savePlan appends version n+1 as draft and records plan_save", async () => {
  await withStore(async ({ tdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    const v1 = await savePlan(tdb, id, "# plan v1", HUMAN);
    assert.equal(v1.version, 1);
    const v2 = await savePlan(tdb, id, "# plan v2", HUMAN);
    assert.equal(v2.version, 2);

    const versions = await listPlans(tdb, id);
    assert.deepEqual(versions.map((v) => v.version), [2, 1], "listPlans returns all versions desc");
    assert.equal(versions[0].status, "draft");
    assert.equal(versions[1].status, "draft");
    assert.equal(versions[0].body_md, "# plan v2");

    const muts = await allMutations(tdb, id);
    assert.equal(muts.filter((m) => m.verb === "plan_save").length, 2);
  });
});

test("getCurrentPlan: null with no plans, latest draft with only drafts, latest approved even under a newer draft", async () => {
  await withStore(async ({ tdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    assert.equal(await getCurrentPlan(tdb, id), null);

    await savePlan(tdb, id, "v1", HUMAN);
    let cur = await getCurrentPlan(tdb, id);
    assert.equal(cur.version, 1);
    assert.equal(cur.status, "draft");

    await approvePlan(tdb, id, 1, HUMAN, "chat");
    cur = await getCurrentPlan(tdb, id);
    assert.equal(cur.version, 1);
    assert.equal(cur.status, "approved");

    // A newer draft does NOT displace the approved version as "current".
    await savePlan(tdb, id, "v2", HUMAN);
    cur = await getCurrentPlan(tdb, id);
    assert.equal(cur.version, 1, "the approved version stays current until the newer draft is itself approved");
    assert.equal(cur.status, "approved");
  });
});

test("approvePlan supersedes the prior approved version in one transaction", async () => {
  await withStore(async ({ tdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    await savePlan(tdb, id, "v1", HUMAN);
    await approvePlan(tdb, id, 1, HUMAN, "chat");
    await savePlan(tdb, id, "v2", HUMAN);

    const before = await listPlans(tdb, id);
    assert.equal(before.find((v) => v.version === 1).status, "approved");

    const result = await approvePlan(tdb, id, 2, HUMAN, "dashboard");
    assert.equal(result.status, "approved");

    const after = await listPlans(tdb, id);
    assert.equal(after.find((v) => v.version === 1).status, "superseded", "prior approved version is superseded");
    assert.equal(after.find((v) => v.version === 2).status, "approved");
    assert.ok(after.find((v) => v.version === 2).decided_at, "decided_at stamped");
    assert.equal(after.find((v) => v.version === 2).decided_via, "dashboard");

    // Exactly one approved row at a time — the invariant the "one txn"
    // requirement exists to protect.
    const approvedCount = after.filter((v) => v.status === "approved").length;
    assert.equal(approvedCount, 1);

    const muts = await allMutations(tdb, id);
    assert.ok(muts.some((m) => m.verb === "plan_approve"));
  });
});

test("approvePlan rejects a version that is not a draft (already approved/superseded) with bad_version, and an unknown version with not_found", async () => {
  await withStore(async ({ tdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    await savePlan(tdb, id, "v1", HUMAN);
    await approvePlan(tdb, id, 1, HUMAN, "chat");

    await assert.rejects(
      () => approvePlan(tdb, id, 1, HUMAN, "chat"),
      (e) => { assert.equal(e.code, "bad_version"); assert.equal(e.http, 400); return true; },
    );
    await assert.rejects(
      () => approvePlan(tdb, id, 999, HUMAN, "chat"),
      (e) => { assert.equal(e.code, "not_found"); assert.equal(e.http, 404); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// result-service.js — the full matrix: autonomy(gated|auto) x
// outcome(success|failure|partial) x def-has-done(y|n)
// ---------------------------------------------------------------------------

const AUTONOMIES = ["gated", "auto"];
const OUTCOMES = ["success", "failure", "partial"];
const DEFS = [
  { projectId: 1, label: "has-done", hasDone: true },
  { projectId: 2, label: "no-done", hasDone: false },
];

for (const autonomy of AUTONOMIES) {
  for (const outcome of OUTCOMES) {
    for (const def of DEFS) {
      const shouldAutoMove = outcome === "success" && autonomy === "auto" && def.hasDone;
      test(`reportResult matrix: autonomy=${autonomy} outcome=${outcome} def=${def.label} -> ${shouldAutoMove ? "auto-moves to done" : "stays recorded"}`, async () => {
        await withStore(async ({ tdb, cdb }) => {
          const id = await makeCard(tdb, def.projectId, autonomy);
          const res = await reportResult(tdb, cdb, id, { outcome, summaryMd: "x" }, BOT);
          const card = await getCard(tdb, id);
          if (shouldAutoMove) {
            assert.equal(card.status, "done");
            assert.equal(res.status, "approved");
            const row = (await tdb.execute({ sql: "SELECT decided_via, decided_at FROM board_results WHERE id=?", args: [res.id] })).rows[0];
            assert.equal(row.decided_via, "auto");
            assert.ok(row.decided_at);
          } else {
            assert.equal(card.status, START_STATUS[def.projectId], "card must not move");
            assert.equal(res.status, "recorded");
          }
          const muts = await allMutations(tdb, id);
          assert.ok(muts.some((m) => m.verb === "result_report"));
        });
      });
    }
  }
}

test("gated success records, does not move, result stays 'recorded'", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    const res = await reportResult(tdb, cdb, id, { outcome: "success", summaryMd: "done working" }, BOT);
    assert.equal(res.status, "recorded");
    const card = await getCard(tdb, id);
    assert.equal(card.status, "pending");
  });
});

test("reportResult 409s 'terminal' on a def-terminal-status card", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    await tdb.execute({ sql: "UPDATE tasks_items SET status='done' WHERE id=?", args: [id] });
    await assert.rejects(
      () => reportResult(tdb, cdb, id, { outcome: "success" }, BOT),
      (e) => { assert.equal(e.code, "terminal"); assert.equal(e.http, 409); return true; },
    );
  });
});

test("reportResult 409s 'archived' on an archived card", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    await tdb.execute({ sql: "UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?", args: [id] });
    await assert.rejects(
      () => reportResult(tdb, cdb, id, { outcome: "success" }, BOT),
      (e) => { assert.equal(e.code, "archived"); assert.equal(e.http, 409); return true; },
    );
  });
});

test("duplicate success after auto-move 409s (replay-proof: card is now terminal)", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const id = await makeCard(tdb, 1, "auto");
    const first = await reportResult(tdb, cdb, id, { outcome: "success" }, BOT);
    assert.equal(first.status, "approved");
    const card = await getCard(tdb, id);
    assert.equal(card.status, "done");

    await assert.rejects(
      () => reportResult(tdb, cdb, id, { outcome: "success" }, BOT),
      (e) => { assert.equal(e.code, "terminal"); assert.equal(e.http, 409); return true; },
    );
  });
});

test("auto-move succeeds THROUGH the reporter's own job lock, 409s on someone else's", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const ownId = await makeCard(tdb, 1, "auto");
    await cdb.execute({
      sql: "INSERT INTO bot_jobs (job_id, bot_id, card_id, card_action, status) VALUES (?,?,?,?,?)",
      args: ["job-abc", "bot-1", ownId, "work", "running"],
    });
    const res = await reportResult(tdb, cdb, ownId, { outcome: "success" }, BOT);
    assert.equal(res.status, "approved");
    assert.equal((await getCard(tdb, ownId)).status, "done", "the reporter's own job lock does not block its own auto-move");

    const otherId = await makeCard(tdb, 1, "auto");
    await cdb.execute({
      sql: "INSERT INTO bot_jobs (job_id, bot_id, card_id, card_action, status) VALUES (?,?,?,?,?)",
      args: ["job-other", "bot-2", otherId, "work", "running"],
    });
    await assert.rejects(
      () => reportResult(tdb, cdb, otherId, { outcome: "success" }, BOT), // BOT carries jobId 'job-abc', not 'job-other'
      (e) => { assert.equal(e.code, "locked"); assert.equal(e.http, 409); return true; },
    );
    assert.notEqual((await getCard(tdb, otherId)).status, "done", "someone else's lock must actually block the move");
    // The result row itself is still recorded even though the auto-move was refused.
    const results = await listResults(tdb, otherId);
    assert.equal(results[0].status, "recorded");
  });
});

test("auto-move succeeds through the reporter's own session lock (bot_id match)", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const id = await makeCard(tdb, 1, "auto");
    await cdb.execute({
      sql: "INSERT INTO bot_sessions (bot_id, card_id, status) VALUES (?,?,?)",
      args: ["bot-1", id, "active"],
    });
    // No bot_jobs row — this is a chat-driven turn holding only the session
    // lock (spec D-T1.5's motivating case: a job-id exemption alone could
    // never match this).
    const res = await reportResult(tdb, cdb, id, { outcome: "success" }, BOT);
    assert.equal(res.status, "approved");
    assert.equal((await getCard(tdb, id)).status, "done");

    // A DIFFERENT bot's session lock still blocks.
    const otherId = await makeCard(tdb, 1, "auto");
    await cdb.execute({
      sql: "INSERT INTO bot_sessions (bot_id, card_id, status) VALUES (?,?,?)",
      args: ["bot-2", otherId, "active"],
    });
    await assert.rejects(
      () => reportResult(tdb, cdb, otherId, { outcome: "success" }, BOT),
      (e) => { assert.equal(e.code, "locked"); assert.equal(e.http, 409); return true; },
    );
  });
});

test("decideResult approves/rejects a recorded result and refuses an already-decided one", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    const res = await reportResult(tdb, cdb, id, { outcome: "success" }, BOT);
    assert.equal(res.status, "recorded");

    const decided = await decideResult(tdb, id, res.id, "approved", HUMAN, "dashboard");
    assert.equal(decided.status, "approved");

    const row = (await tdb.execute({ sql: "SELECT status, decided_via, decided_at FROM board_results WHERE id=?", args: [res.id] })).rows[0];
    assert.equal(row.status, "approved");
    assert.equal(row.decided_via, "dashboard");
    assert.ok(row.decided_at);

    // decideResult NEVER moves the card, even for an approval.
    assert.equal((await getCard(tdb, id)).status, "pending");

    await assert.rejects(
      () => decideResult(tdb, id, res.id, "rejected", HUMAN, "dashboard"),
      (e) => { assert.equal(e.code, "already_decided"); assert.equal(e.http, 409); return true; },
    );

    const muts = await allMutations(tdb, id);
    assert.ok(muts.some((m) => m.verb === "result_decide"));
  });
});

test("decideResult 404s not_found on an unknown result id", async () => {
  await withStore(async ({ tdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    await assert.rejects(
      () => decideResult(tdb, id, 999999, "approved", HUMAN, "dashboard"),
      (e) => { assert.equal(e.code, "not_found"); assert.equal(e.http, 404); return true; },
    );
  });
});

test("result rows surface plan version + superseded flag (listResults join)", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const id = await makeCard(tdb, 1, "gated");
    const v1 = await savePlan(tdb, id, "v1", HUMAN);
    await approvePlan(tdb, id, 1, HUMAN, "chat");

    const res1 = await reportResult(tdb, cdb, id, { outcome: "partial", summaryMd: "half done", planId: v1.id }, BOT);

    // A re-run against a newer plan: v1 gets superseded mid-run.
    await savePlan(tdb, id, "v2", HUMAN);
    await approvePlan(tdb, id, 2, HUMAN, "chat");

    const results = await listResults(tdb, id);
    const r1 = results.find((r) => r.id === res1.id);
    assert.equal(r1.plan_version, 1);
    assert.equal(r1.plan_superseded, true, "the plan version this result worked against was superseded since");

    // A result with no plan_id at all: null version, not superseded.
    const res2 = await reportResult(tdb, cdb, id, { outcome: "partial", summaryMd: "no plan ref" }, BOT);
    const r2 = (await listResults(tdb, id)).find((r) => r.id === res2.id);
    assert.equal(r2.plan_version, null);
    assert.equal(r2.plan_superseded, false);
  });
});
