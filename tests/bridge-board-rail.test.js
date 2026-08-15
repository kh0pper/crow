// tests/bridge-board-rail.test.js
//
// Track 1 Task 7 — the bridge/bot rail: plan records in the dispatch prompt,
// the board_report_result terminal-state signal, and the store-topology rule
// (planForCard resolves the INSTANCE-GLOBAL tasks.db resolved freshly, never
// a per-project override — D-T1.4). Two harnesses:
//
//   A. planForCard() (exported additively, same idiom as recordPlanRef used
//      to be) — direct unit coverage against real migrated tasks.db files
//      (0004 run via the runner, same fixture pattern as
//      tests/board-plan-result-service.test.js). No pi spawn.
//
//   B. handleInbound() end-to-end with a protocol-speaking stub pi (the
//      tests/bot-world.test.js precedent) — proves the execute prompt's
//      content and the end-of-turn board_report_result detection that flips
//      a session 'done' vs 'waiting-user'. CROW_DATA_DIR/CROW_HOME are
//      scratch for the whole file, so the operator's ~/.crow is untouchable.
//
// Harness B is wrapped in its own `describe()` so its before()/after() are
// SCOPED to just its tests, not shared (global, top-level) hooks racing
// against Harness A's dozen sibling tests — under `node --test
// --test-name-pattern`, an unscoped top-level before()/after() pair
// observably fired `after()` (deleting the scratch root) WHILE the matching
// test's own before() was still mid-flight, because the runner settles
// "done" for the whole file's hook scope once every OTHER (non-matching,
// instantly-skipped) sibling test has resolved — independent of whether the
// one actually-running test's shared hook has finished. Scoping the hooks
// inside a describe() removes the shared scope entirely. (Verified via a
// fs.rmSync/child_process monkeypatch trace during triage — not a bug in the
// bridge/migration code this file exercises.)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";
// NO static import of bot-world.mjs/bridge.mjs here — deliberately. Both
// transitively static-import mcp_writer.mjs, whose `CANONICAL_MCP_PATH`
// (`HOME + "/.pi/agent/mcp.json"`) is captured at MODULE LOAD time, and ES
// module static imports resolve the ENTIRE graph before this file's own
// top-level body runs — so a `process.env.HOME =` assignment anywhere below
// a static import of either module would always be too late. On a dev host
// with a real `~/.pi/agent/mcp.json` (pi-lab) this was invisible; on CI
// (no such file) `readCanonicalMcp` throws, `buildBotWorld`'s catch swallows
// it as "non-fatal", and no `.mcp.json` is ever written — a host-state
// dependency this file must not have. So: point HOME at a scratch dir with a
// seeded minimal canonical FIRST (below), and import both modules only
// dynamically, after that.
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "scripts", "migrations");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// Hermetic env, same discipline as tests/bot-world.test.js.
for (const k of Object.keys(process.env)) {
  if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
}

const SCRATCH_HOME = mkdtempSync(join(tmpdir(), "bridge-board-rail-home-"));
mkdirSync(join(SCRATCH_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(SCRATCH_HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = SCRATCH_HOME;
// Synchronous, no test-runner hook involved — sidesteps the before()/after()
// hook-scope hazard documented below (an env restore has no reason to race
// anything, but this file already learned once not to trust a node:test
// hook for cleanup timing it can't fully control).
process.on("exit", () => {
  try { rmSync(SCRATCH_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
});

// ---------------------------------------------------------------------------
// shared fixture helpers (board-plan-result-service.test.js's pattern)
// ---------------------------------------------------------------------------

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

/** Build a standalone, 0004-migrated tasks.db (its own throwaway crow.db just
 *  to hold schema_migrations — runMigrations always wants one). Returns the
 *  tasks.db path. */
async function migratedTasksDb(dir, name) {
  const dbPath = join(dir, name + "-crow.db");
  const tasksDbPath = join(dir, name + "-tasks.db");
  const c = new Database(dbPath);
  markPriorDone(c);
  c.exec("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT)");
  c.close();
  const t = new Database(tasksDbPath);
  seedPost0003TasksDb(t);
  t.close();
  await runMigrations({ migrationsDir: MIGRATIONS_DIR, dbPath, tasksDbPath, sha: "test", log: () => {} });
  return tasksDbPath;
}

function seedPlan(tasksDbPath, itemId, version, status, bodyMd) {
  const t = new Database(tasksDbPath);
  t.prepare(
    "INSERT INTO board_plans (item_id, version, body_md, status, created_actor_kind, created_actor_id) VALUES (?,?,?,?,?,?)"
  ).run(itemId, version, bodyMd, status, "human", null);
  t.close();
}

function seedCard(tasksDbPath, id, title, status = "pending") {
  const t = new Database(tasksDbPath);
  t.prepare("INSERT INTO tasks_items (id, title, status) VALUES (?,?,?)").run(id, title, status);
  t.close();
}

// ---------------------------------------------------------------------------
// Harness A: planForCard — real migrated stores, no pi spawn
// ---------------------------------------------------------------------------

describe("planForCard (D-T1.4 store-topology rule)", () => {
  const dirA = mkdtempSync(join(tmpdir(), "planforcard-"));
  const dbAPromise = migratedTasksDb(dirA, "instance");
  const dbBPromise = migratedTasksDb(dirA, "decoy-project");

  // planForCard's module-load-time TASKS_DB const is irrelevant to it (it
  // calls resolveTasksDbPath() itself); this import just needs to succeed.
  const bridgePromise = import("../scripts/pi-bots/bridge.mjs");

  function withTasksDbEnv(path, fn) {
    const prev = process.env.CROW_TASKS_DB_PATH;
    process.env.CROW_TASKS_DB_PATH = path;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.CROW_TASKS_DB_PATH; else process.env.CROW_TASKS_DB_PATH = prev;
    }
  }

  let dbA, dbB, planForCard;
  before(async () => {
    dbA = await dbAPromise;
    dbB = await dbBPromise;
    ({ planForCard } = await bridgePromise);
  });
  after(() => { rmSync(dirA, { recursive: true, force: true }); });

  test("resolves the instance-global store FRESH at call time (store-topology rule)", () => {
    seedPlan(dbA, 1, 1, "approved", "PLAN A (instance-global)");
    seedPlan(dbB, 1, 1, "approved", "PLAN B (decoy per-project store, SAME item id)");

    withTasksDbEnv(dbA, () => assert.equal(planForCard(1), "PLAN A (instance-global)"));
    // Same cardId, DIFFERENT env value -> different answer: proves the read
    // is never cached from module-load time, and never silently prefers
    // whichever store was resolved first.
    withTasksDbEnv(dbB, () => assert.equal(planForCard(1), "PLAN B (decoy per-project store, SAME item id)"));
  });

  test("takes no per-project override — its signature is cardId only", () => {
    // Structural pin: the store-topology rule is enforced by NOT accepting a
    // tasksDbPath argument at all (unlike cardStatus/boardVocab/kanbanText,
    // which do). A regression that re-adds one would still pass the test
    // above by accident if the caller happened to pass the right value —
    // this closes that gap by pinning the arity.
    assert.equal(planForCard.length, 1, "planForCard(cardId) — no second argument to ignore-or-honor");
  });

  test("current plan = latest approved, even when a newer draft exists on top", () => {
    seedPlan(dbA, 2, 1, "approved", "v1 approved (current)");
    seedPlan(dbA, 2, 2, "draft", "v2 draft, not yet approved");
    withTasksDbEnv(dbA, () => assert.equal(planForCard(2), "v1 approved (current)"));
  });

  test("no approved version -> latest draft", () => {
    seedPlan(dbA, 3, 1, "draft", "draft v1");
    seedPlan(dbA, 3, 2, "draft", "draft v2 (latest)");
    withTasksDbEnv(dbA, () => assert.equal(planForCard(3), "draft v2 (latest)"));
  });

  test("no plan rows for the card -> null (never throws)", () => {
    withTasksDbEnv(dbA, () => assert.equal(planForCard(999), null));
  });

  test("a pre-0004 store with no board_plans table -> null, never throws", () => {
    const legacyDb = join(dirA, "legacy-tasks.db");
    const l = new Database(legacyDb);
    l.exec("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)");
    l.close();
    withTasksDbEnv(legacyDb, () => {
      assert.doesNotThrow(() => planForCard(1));
      assert.equal(planForCard(1), null);
    });
  });
});

// ---------------------------------------------------------------------------
// Harness B: handleInbound end-to-end (protocol-speaking stub pi)
// ---------------------------------------------------------------------------

describe("handleInbound board rail (execute prompt + board_report_result detection)", () => {
  const ROOT = mkdtempSync(join(tmpdir(), "bridge-board-rail-"));
  process.env.CROW_DATA_DIR = ROOT;
  process.env.CROW_HOME = join(ROOT, "home");
  delete process.env.CROW_DB_PATH;
  delete process.env.CROW_TASKS_DB_PATH;

  const CROW_DB = join(ROOT, "crow.db");
  const TASKS_DB = join(ROOT, "tasks.db");

  process.env.PIBOT_MAX_PI = "99";
  process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
  process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
  process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
  process.env.PIBOT_TURN_TIMEOUT_MS = "5000";
  process.env.PI_MODELS_JSON = join(ROOT, "models.json");
  mkdirSync(process.env.CROW_HOME, { recursive: true });
  mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));

  const STUB_PI = join(ROOT, "stub-pi.mjs");
  writeFileSync(STUB_PI, [
    'import { writeFileSync } from "node:fs";',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    // PIBOT_TEST_TOOLCALLS: JSON array of {tool, isError} to emit as
    // tool_execution_end events before agent_end — this is how each test
    // below controls what pi.toolCalls() sees.
    'let toolCalls = [];',
    'try { toolCalls = JSON.parse(process.env.PIBOT_TEST_TOOLCALLS || "[]"); } catch {}',
    'let buf = "";',
    'process.stdin.on("data", (chunk) => {',
    '  buf += chunk.toString("utf8");',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    let m; try { m = JSON.parse(line); } catch { continue; }',
    '    if (m.type === "get_state") {',
    '      out({ type: "response", command: "get_state", data: { sessionId: "stub-session" } });',
    '    } else if (m.type === "get_session_stats") {',
    '      out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
    '    } else if (m.type === "prompt") {',
    '      writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify({ prompt: m.message }));',
    '      out({ type: "response", command: "prompt" });',
    '      for (const c of toolCalls) out({ type: "tool_execution_end", toolName: c.tool, isError: !!c.isError });',
    '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });',
    '    } else if (m.type === "abort") {',
    '      out({ type: "response", command: "abort" });',
    '    }',
    '  }',
    '});',
    'process.stdin.resume();',
    '',
  ].join("\n"));
  process.env.PIBOT_PI_CLI = STUB_PI;

  const bridgePromise = import("../scripts/pi-bots/bridge.mjs");
  let handleInbound;

  before(async () => {
    ({ handleInbound } = await bridgePromise);
    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: ROOT }, stdio: "pipe", cwd: REPO,
    });
    const c = new Database(CROW_DB);
    c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)").run(
      "railbot", "Rail Bot",
      JSON.stringify({
        system_prompt: "You are the rail-test bot.",
        models: { default: "stub/m1" },
        tools: { pi_builtin: ["read", "write"], crow_mcp: ["board"] },
        permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
        session_dir: join(ROOT, "bots", "railbot"),
      }), 1,
    );
    // init-db.js creates crow.db but never touches schema_migrations (that's
    // the migrations/ runner's own ledger) — mark 0001-0003 applied so
    // runMigrations below only runs 0004 against the tasks_items shape it
    // expects.
    markPriorDone(c);
    c.close();

    // Raw board token, the exact <crowHome>/board-token shape
    // generateBoardToken (servers/gateway/local-token.js) writes at boot —
    // needed for the job_id-threading test below, which reads the real
    // .mcp.json a real buildBotWorld() call produces.
    writeFileSync(join(process.env.CROW_HOME, "board-token"), "rail-board-token");

    const t = new Database(TASKS_DB);
    seedPost0003TasksDb(t);
    t.close();
    await runMigrations({ migrationsDir: MIGRATIONS_DIR, dbPath: CROW_DB, tasksDbPath: TASKS_DB, sha: "test", log: () => {} });
  });

  after(() => { rmSync(ROOT, { recursive: true, force: true }); });

  let captureN = 0;
  async function turn(cardId, opts = {}) {
    const captureFile = join(ROOT, "capture-" + (++captureN) + ".json");
    process.env.PIBOT_TEST_CAPTURE = captureFile;
    process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify(opts.toolCalls || []);
    const threadId = "rail-thread-" + captureN;
    const replies = [];
    const result = await handleInbound({
      bot_id: "railbot", gateway_type: "board", gateway_thread_id: threadId,
      user_message: "do card #" + cardId,
      log: () => {}, sendReply: async (t2) => { replies.push(t2); },
    });
    const prompt = existsSync(captureFile) ? JSON.parse(readFileSync(captureFile, "utf8")).prompt : null;
    const session = (() => {
      const c = new Database(CROW_DB);
      const r = c.prepare("SELECT * FROM bot_sessions WHERE bot_id='railbot' AND gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
      c.close();
      return r;
    })();
    return { result, replies, prompt, session };
  }

  test("execute prompt: instructs board_report_result, and drops the old move-to-done instruction", async () => {
    seedCard(TASKS_DB, 10, "rail card 10");
    seedPlan(TASKS_DB, 10, 1, "approved", "Do the thing carefully.");

    const { prompt } = await turn(10);
    assert.match(prompt, /board_report_result/, "the bot must be told to call board_report_result");
    assert.match(prompt, /Do the thing carefully\./, "the current approved plan body must be in the prompt");
    assert.doesNotMatch(prompt, /set this card in_progress,\s*then/i, "the retired move-to-done instruction must be gone");
    assert.doesNotMatch(prompt, /## Result/, "the retired plan-file '## Result' instruction must be gone");
    assert.doesNotMatch(prompt, /plan file missing/i, "D-T1.4: never the old file-rail wording");
  });

  test("execute prompt says '(no plan)' for a card with no plan record — never 'plan file missing'", async () => {
    seedCard(TASKS_DB, 11, "rail card 11, no plan");
    const { prompt } = await turn(11);
    assert.match(prompt, /\(no plan\)/);
    assert.doesNotMatch(prompt, /plan file missing/i);
  });

  test("a non-error board_report_result tool call ends the session 'done'", async () => {
    seedCard(TASKS_DB, 12, "rail card 12");
    const { session } = await turn(12, { toolCalls: [{ tool: "mcp__board__board_report_result", isError: false }] });
    assert.equal(session.status, "done");
  });

  test("an isError board_report_result call must NOT count — session stays 'waiting-user'", async () => {
    // The 409-terminal/409-archived refusal surfaces as MCP isError (Task 6)
    // — a refused report must never look like a completed run, or a card
    // that couldn't be reported on would silently unlock and vanish from
    // review.
    seedCard(TASKS_DB, 13, "rail card 13");
    const { session } = await turn(13, { toolCalls: [{ tool: "mcp__board__board_report_result", isError: true }] });
    assert.equal(session.status, "waiting-user");
  });

  test("no board_report_result call at all -> session stays 'waiting-user'", async () => {
    seedCard(TASKS_DB, 14, "rail card 14");
    const { session } = await turn(14, { toolCalls: [{ tool: "mcp__board__board_move_item", isError: false }] });
    assert.equal(session.status, "waiting-user");
  });

  test("detection matches on tool-name SUFFIX — not tied to the 'board' catalog key specifically", async () => {
    // Named mechanism (D-T1.5): a non-error `*__board_report_result` call in
    // THIS turn's transcript is the signal, regardless of which MCP server
    // name the tool arrived under.
    seedCard(TASKS_DB, 15, "rail card 15");
    const { session } = await turn(15, { toolCalls: [{ tool: "mcp__some-other-server__board_report_result", isError: false }] });
    assert.equal(session.status, "done");
  });

  test("buildBotWorld's jobId reaches the generated .mcp.json board headers (the missing link)", async () => {
    // D-T1.5: job_runner.runCardExecute passes job.job_id into handleInbound
    // -> buildBotWorld -> writeBotMcp's board-entry headers. This is the
    // structural proof, end to end, through the REAL buildBotWorld (not a
    // stub) and the REAL board-token file written above.
    //
    // Dynamic import, deliberately: buildBotWorld's module (bot-world.mjs)
    // transitively static-imports mcp_writer.mjs, whose CANONICAL_MCP_PATH
    // is HOME-captured at load time — importing it here, well after the
    // module-top SCRATCH_HOME swap above, is what makes that capture see
    // the scratch HOME instead of whatever the real host's HOME is.
    const { buildBotWorld } = await import("../scripts/pi-bots/bot-world.mjs");
    const world = await buildBotWorld({
      botId: "railbot", threadId: "job-id-thread", gatewayType: "board",
      jobId: "job-thread-check", log: () => {},
    });
    const mcp = JSON.parse(readFileSync(join(world.sessionDir, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.board.headers["X-Crow-Job-Id"], "job-thread-check");
    assert.equal(mcp.mcpServers.board.headers["X-Crow-Actor-Id"], "railbot");

    // And the negative: an interactive (non-job) turn passes no jobId, and
    // the header must be genuinely ABSENT, not merely falsy — a stray
    // "X-Crow-Job-Id": undefined would still serialize as a header some HTTP
    // clients coerce to the string "undefined".
    const worldNoJob = await buildBotWorld({
      botId: "railbot", threadId: "no-job-thread", gatewayType: "board", log: () => {},
    });
    const mcpNoJob = JSON.parse(readFileSync(join(worldNoJob.sessionDir, ".mcp.json"), "utf8"));
    assert.ok(!("X-Crow-Job-Id" in mcpNoJob.mcpServers.board.headers));
  });
});
