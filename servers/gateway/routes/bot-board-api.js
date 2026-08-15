/**
 * Bot Board mutation API — Crow Bot Builder Phase 4 (auth-gated JSON router).
 *
 * Default-exports botBoardApiRouter(dashboardAuth); mounted in
 * servers/gateway/index.js EXACTLY as streamsRouter is
 * (`app.use(botBoardApiRouter(dashboardAuth))` adjacent to the streams mount,
 * after the global rejectFunneledMiddleware() at index.js:252) so every
 * endpoint inherits Funnel-reject + the dashboard session gate. The FIRST
 * statement in the factory is `router.use("/dashboard/bot-board-api",
 * dashboardAuth)` — the literal prefix (distinct from /dashboard/streams and
 * from the SSR panel route /dashboard/bot-board); every route is registered
 * AFTER that line, under that prefix.
 *
 * Invariants (design §6 / plan Step 3):
 *  - All DB access via the gateway's journal-safe createDbClient() — tasks.db
 *    via createDbClient(TASKS_DB) (DELETE-pinned by CROW_JOURNAL_MODE on this
 *    gateway), crow.db via createDbClient(). No direct better-sqlite3
 *    constructor anywhere in this file. The ONE executeMultiple/DDL exception
 *    is ensureBotJobs(), the lazy bot_jobs self-heal shared in spirit with
 *    tool-executor.js's ensureBotJobs() and job_runner.mjs's
 *    ensureBotJobsSchema() — scripts/pi-bots/bot-jobs-schema.mjs is the single
 *    DDL source for all three, and it runs at most once per process.
 *  - Status literals validated against a hardcoded in-app allowlist BEFORE
 *    any SQL → 400 (the DB CHECK is defense-in-depth, never caught).
 *  - card-create: title must be a non-empty trimmed string → 400 before the
 *    INSERT; status/priority are OMITTED from the INSERT column list (rely on
 *    DEFAULT 'pending' / DEFAULT 3 — never NULL-bind over a DEFAULT).
 *  - Every UPDATE explicitly sets updated_at=datetime('now'); →done/→cancelled
 *    also sets completed_at=datetime('now'); transition OUT of done/cancelled
 *    sets completed_at=NULL (SQLite DEFAULT is INSERT-only).
 *  - Whole-card single-writer lock (D5): every card write re-checks BOTH rails
 *    via the shared predicate in ./board-lock.js — an unfinished bot_jobs row
 *    (queued/running) for that card_id, else the MAX(id) bot_sessions row with
 *    status ∈ {active,waiting-user} ⇒ 409 {reason}. The SSR board render and
 *    the no-JS move handler import that SAME module; a local copy here is what
 *    let the three predicates drift apart once already.
 *  - Plan file = DERIVED <def.session_dir>/plans/<cardId>.md; resolved
 *    realpath asserted under that session_dir (else 400); POST does an
 *    mtime optimistic-concurrency check (409 if changed since the GET).
 *  - bulk-assign: cap ≤200 (400 if exceeded); D5 lock-filter runs FIRST
 *    (partition survivors vs skipped[]); survivors go into ONE atomic
 *    db.batch(); applied[] is derived ONLY from the resolved batch result's
 *    per-statement rowsAffected (1 ⇒ applied, 0 ⇒ skipped:"stale"); a
 *    rejected batch ⇒ {error, applied:[]} (all rolled back).
 *  - force-unlock, SESSION rail: permitted ONLY when the MAX(id) row is
 *    active/waiting-user AND stale (no updated_at movement ≥ 30 min) AND a
 *    POSITIVE "pi is dead" determination. The liveness check FAILS CLOSED:
 *    anything ambiguous / errored / unverifiable ⇒ refuse (card stays locked;
 *    manual SQL remains the escape hatch). Idempotent SQL guarded by status IN.
 *  - force-unlock, JOB rail: terminates the job (status='failed' + an operator
 *    error string) so it can never be claimed and re-take the card, then
 *    best-effort un-strands the card via the bridge's own reset. A 'queued' job
 *    needs no staleness window — nothing has claimed it, so nothing is lost. A
 *    'running' job takes the same fail-closed gate, against its worker pid.
 *    One rail per call, deliberately.
 *
 * Zero new npm deps. No bridge/pi edits. Never touches the 3 prod MPA bots.
 */
import { Router } from "express";
import { existsSync, readFileSync, readdirSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { createDbClient } from "../../db.js";
import { jsonError } from "./_error.js";
import { listProvidersAll } from "../../shared/providers-db.js";
import { proposalsDir, normalizeSkillName, listProposals } from "../../../scripts/pi-bots/skill_proposals.mjs";
// B4: shared write+attach helper (one code path with the auto review pass).
import { promoteSkill } from "../../../scripts/pi-bots/skill_promote.mjs";
import { listBotSkillEvents } from "../../../scripts/pi-bots/skill_provenance.mjs";
import { createProjectSpace, updateProjectSpaceMeta } from "../../shared/project-spaces.js";
import { resolveBoardDef, resolveSlugBoardDef, isValidStatus, isTerminal, validateDefPayload } from "./board-defs.js";
// Track 1 Task 4: the plan drawer re-points from the file rail to plan
// records (D-T1.4) — plan-ref.js stops being imported HERE (the file itself
// is deleted in Task 7, after bridge.mjs:43's static import is removed).
import { getCurrentPlan, listPlans, savePlan, approvePlan } from "../board/plan-service.js";
// Track 1 Task 5 (D-T1.6): archive/unarchive is THE single writer for
// archived_at on both id spaces — thin route callers below.
import { archiveCard, unarchiveCard, archiveItem, unarchiveItem } from "../board/card-service.js";
// THE shared dual-rail lock predicate (job rail + session rail). The SSR board
// render and the no-JS move handler import the same module — see board-lock.js
// for why a local copy is not allowed to exist here.
import { lockState, sessionRowFor, SESSION_LOCK_STATUSES } from "./board-lock.js";
// THE single bot_jobs DDL (shared with init-db, job_runner and tool-executor).
import { BOT_JOBS_DDL, missingBotJobsColumns } from "../../../scripts/pi-bots/bot-jobs-schema.mjs";

// Slice C: operator-approved promotion target (the PRIMARY skills dir both the
// pi bridge and the glasses voice path search via skill_resolver).
const CROW_USER_SKILLS = join(process.env.CROW_HOME || join(homedir(), ".crow"), "skills");

const HOME = process.env.HOME || homedir();
const TASKS_DB = tasksDbPath();
const PROJECT_STATUSES = new Set(["active", "paused", "completed", "archived"]);
const STALE_SECONDS = 1800; // 30 min — force-unlock staleness threshold (D5)
const BULK_CAP = 200;

/**
 * Lazy self-heal of bot_jobs from the gateway side, ONCE per process.
 *
 * The latch is not an optimisation: without it the multi-statement DDL below
 * would be re-executed against crow.db on every single dispatch request. Same
 * `_botJobsEnsured` idiom as servers/gateway/ai/tool-executor.js.
 *
 * ORDER IS LOAD-BEARING — PRAGMA, then ALTER, then DDL:
 *   BOT_JOBS_DDL ends with a partial index on card_id. Executing it against a
 *   LEGACY table that predates that column throws "no such column: card_id",
 *   so a DDL-first ordering never reaches the ALTER that would have fixed it.
 *   PRAGMA on a table that does not exist yet returns zero rows, so a fresh
 *   install skips the ALTER loop and gets everything from the DDL.
 *
 * Deliberately NOT try/caught: a failed ensure must propagate so the dispatch
 * handler 500s with the card still untouched. Swallowing it here would let the
 * INSERT fail afterwards for a second, less legible reason.
 */
let _botJobsEnsured = false;
async function ensureBotJobs(cdb) {
  if (_botJobsEnsured) return;
  const info = await cdb.execute("PRAGMA table_info(bot_jobs)");
  const names = (info.rows || []).map((r) => r.name);
  if (names.length) {
    for (const stmt of missingBotJobsColumns(names)) await cdb.execute(stmt);
  }
  // BOT_JOBS_DDL is several statements in one string; execute() prepares a
  // SINGLE statement (better-sqlite3 .prepare() throws on more than one).
  await cdb.executeMultiple(BOT_JOBS_DDL);
  _botJobsEnsured = true;
}

/**
 * Enqueue ONE board-card job and return its job_id. The board's whole part in a
 * dispatch is this row: job_runner claims it, routes it on source/card_id to
 * runCardJob, and the BRIDGE does the work — handleInbound (D-T1.7: card jobs
 * are execution-only now; plans are board_plans records, edited via
 * board_save_plan/board_approve_plan, never dispatched as a job). Nothing here
 * composes a prompt or decides an outcome.
 *
 * deliver_to is NULL on purpose. A card job reports through the bot's own
 * board_report_result call (D-T1.5); the dispatcher owns no delivery channel
 * and must never write the card's terminal state from a job outcome. (An
 * earlier attempt set {kind:"card"} here, which inverted exactly that
 * ownership and was reverted.)
 */
async function enqueueCardJob(cdb, { botId, cardId, action, goal }) {
  await ensureBotJobs(cdb);
  const jobId = "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  await cdb.execute({
    sql: "INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source, card_id, card_action) "
       + "VALUES (?, ?, ?, 'queued', NULL, 'card', ?, ?)",
    args: [jobId, botId, goal, cardId, action],
  });
  return jobId;
}

/**
 * Liveness of a bot_jobs worker pid, for the job half of force-unlock. Same
 * FAIL-CLOSED shape as piLiveness(): only a positive ESRCH counts as dead.
 * EPERM means the pid exists under another uid — alive. Anything else is
 * unverifiable, and unverifiable must never unlock.
 */
function workerLiveness(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return "unknown";
  try { process.kill(p, 0); return "alive"; } catch (e) {
    if (e && e.code === "ESRCH") return "dead";
    if (e && e.code === "EPERM") return "alive";
    return "unknown";
  }
}

// Track 1: every dashboard-originated write is attributed to this actor
// (D-T1.3 provenance; brief-pinned shape) — the plan drawer, and any other
// card-service/plan-service call this file makes.
const DASHBOARD_ACTOR = { kind: "human", id: null, jobId: null };

// Maps a service-layer {message, code, http} error to the response. 409s use
// the router's existing {reason} shape (matched by client.js's `r.j.reason`
// fallback everywhere else in this file); everything else is jsonError's
// {error} shape.
function serviceError(res, e) {
  // `code` rides alongside `reason` (added Track 1 Task 5) so client.js can
  // map a KNOWN error to an i18n'd string (board.errArchived/board.errLocked)
  // instead of displaying the raw EN service message — server-side JSON
  // errors are never translated (no precedent for it anywhere in this file).
  if (e && e.http === 409) return res.status(409).json({ reason: e.message, code: e.code });
  if (e && e.http) return jsonError(res, e.http, e.message);
  return jsonError(res, 500, String((e && e.message) || e));
}

// True iff the query/body carries the `include_archived` escape (D-T1.6's
// convention: default views exclude archived_at IS NOT NULL rows; this is
// the ONLY way to see them). Accepts "1"/"true" from either query or body —
// GET list endpoints only ever see query; bulk-assign is a POST that still
// takes it as a query param (the body is card_ids[] only).
function wantsArchived(req) {
  const v = (req.query && req.query.include_archived) ?? (req.body && req.body.include_archived);
  return v === "1" || v === "true" || v === true;
}

// Fail-closed pi-liveness (Step-1 pinned pattern, recorded in the plan's
// Verified Claims): a process is "the live pi holding bot_sessions row R"
// iff basename(/proc/<pid>/comm) === "node" AND /proc/<pid>/cmdline contains
// the substring `--session-dir <R.pi_session_dir>`. Returns:
//   "alive"   — a matching live pi process was positively found
//   "dead"    — scanned cleanly, no matching process exists
//   "unknown" — anything ambiguous/errored/unverifiable (⇒ caller refuses)
function piLiveness(piSessionDir) {
  if (!piSessionDir || typeof piSessionDir !== "string") return "unknown";
  const needle = "--session-dir " + piSessionDir;
  let pids;
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return "unknown"; // cannot enumerate /proc → cannot confirm dead
  }
  let scannedAny = false;
  for (const pid of pids) {
    let comm, cmdline;
    try {
      comm = readFileSync("/proc/" + pid + "/comm", "utf8").trim();
    } catch {
      continue; // process exited mid-scan — fine, keep scanning
    }
    try {
      cmdline = readFileSync("/proc/" + pid + "/cmdline").toString("utf8");
    } catch {
      continue;
    }
    scannedAny = true;
    // /proc/<pid>/comm is the argv0 basename (truncated to 15 chars by the
    // kernel; "node" is 4 so exact compare is safe). cmdline is NUL-joined;
    // normalise NUL→space for the substring test.
    if (comm === "node" && cmdline.replace(/\0/g, " ").includes(needle)) {
      return "alive";
    }
  }
  return scannedAny ? "dead" : "unknown";
}

export default function botBoardApiRouter(dashboardAuth) {
  const router = Router();

  // FIRST statement: auth-gate the whole prefix (distinct from
  // /dashboard/streams and from the SSR panel route /dashboard/bot-board).
  router.use("/dashboard/bot-board-api", dashboardAuth);

  const P = "/dashboard/bot-board-api";

  // ---- GET card (drawer hydration: card fields + project list + lock) ----
  router.get(P + "/card/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    let tdb, cdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({
        sql:
          "SELECT id,title,description,status,priority,due_date,owner,tags,parent_id,project_id," +
          "assigned_bot,archived_at," +
          "datetime(updated_at) AS updated_at, completed_at FROM tasks_items WHERE id=? AND board_id IS NULL",
        args: [id],
      })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      const def = await resolveBoardDef(tdb, { projectId: card.project_id });
      cdb = createDbClient();
      let projects = [];
      try {
        projects = (await cdb.execute({ sql: "SELECT id, name, slug, repo_path FROM project_spaces WHERE archived_at IS NULL ORDER BY id", args: [] })).rows || [];
      } catch { projects = []; }
      const { locked } = await lockState(cdb, id);
      return res.json({
        card, projects, locked,
        board: {
          status_values: def.status_values,
          terminal_values: def.terminal_values,
          fields: def.fields,
          builtin: def.builtin,
        },
      });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- create card ----
  router.post(P + "/card", async (req, res) => {
    const b = req.body || {};
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) return jsonError(res, 400, "title is required"); // BEFORE INSERT
    const projectId = b.project_id == null || b.project_id === "" ? null : Number(b.project_id);
    if (projectId != null && !Number.isInteger(projectId)) return jsonError(res, 400, "bad project_id");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      // A new card must land ON its board: the DEFAULT 'pending' is only right
      // when the resolved def has 'pending'. A custom board's cards start on
      // its FIRST status — otherwise the card is born off-def.
      const def = await resolveBoardDef(tdb, { projectId });
      const explicitStatus = isValidStatus(def, "pending") ? null : def.status_values[0];
      // OMIT status (when defaultable) / priority from the column list → rely
      // on DEFAULT 'pending' / DEFAULT 3 (never NULL-bind over a DEFAULT).
      // created_at/updated_at via their INSERT DEFAULTs.
      const r = explicitStatus == null
        ? await tdb.execute({
            sql: "INSERT INTO tasks_items (title, description, due_date, owner, tags, project_id) VALUES (?,?,?,?,?,?)",
            args: [
              title,
              b.description ? String(b.description) : null,
              b.due_date ? String(b.due_date) : null,
              b.owner ? String(b.owner) : null,
              b.tags ? String(b.tags) : null,
              projectId,
            ],
          })
        : await tdb.execute({
            sql: "INSERT INTO tasks_items (title, description, due_date, owner, tags, project_id, status) VALUES (?,?,?,?,?,?,?)",
            args: [
              title,
              b.description ? String(b.description) : null,
              b.due_date ? String(b.due_date) : null,
              b.owner ? String(b.owner) : null,
              b.tags ? String(b.tags) : null,
              projectId,
              explicitStatus,
            ],
          });
      return res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- edit card fields ----
  router.post(P + "/card/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    const b = req.body || {};
    let prio = null, prioSet = false;
    if (b.priority != null && b.priority !== "") {
      prio = Number(b.priority);
      if (!Number.isInteger(prio) || prio < 1 || prio > 5) return jsonError(res, 400, "priority must be 1-5");
      prioSet = true;
    }
    let botSet = false, botVal = null;
    if (b.assigned_bot !== undefined) {
      botSet = true;
      botVal = b.assigned_bot == null || b.assigned_bot === "" ? null : String(b.assigned_bot);
    }
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      if (botSet && botVal != null) {
        const botRow = (await cdb.execute({
          sql: "SELECT bot_id FROM pi_bot_defs WHERE bot_id=? AND enabled=1", args: [botVal],
        })).rows[0];
        if (!botRow) return jsonError(res, 400, "assigned_bot not found or disabled");
      }
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT status, project_id, archived_at FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!cur) return jsonError(res, 404, "card not found");
      // D-T1.6: this route is NOT converged onto card-service (updateCard) —
      // it writes tasks_items directly — so the archived-refuses-write guard
      // has to be inline here too, or the JS drawer's Save button (POST
      // /card/:id) could silently mutate an archived card.
      if (cur.archived_at != null) return res.status(409).json({ reason: "card is archived", code: "archived" });
      // Status validated against the card's RESOLVED BOARD DEF, before any
      // write (Track 0: per-board status values; the old hardcoded allowlist
      // is now just the builtin fallback def).
      const def = await resolveBoardDef(tdb, { projectId: cur.project_id });
      if (b.status != null && !isValidStatus(def, String(b.status))) {
        return jsonError(res, 400, "invalid status");
      }
      const sets = ["title=?", "description=?", "due_date=?", "owner=?", "tags=?"];
      const args = [
        typeof b.title === "string" ? b.title.trim() : (b.title == null ? null : String(b.title)),
        b.description == null ? null : String(b.description),
        b.due_date == null || b.due_date === "" ? null : String(b.due_date),
        b.owner == null || b.owner === "" ? null : String(b.owner),
        b.tags == null || b.tags === "" ? null : String(b.tags),
      ];
      if (prioSet) { sets.push("priority=?"); args.push(prio); }
      if (botSet) { sets.push("assigned_bot=?"); args.push(botVal); }
      if (b.status != null) {
        const ns = String(b.status);
        sets.push("status=?"); args.push(ns);
        if (isTerminal(def, ns) && !isTerminal(def, String(cur.status))) sets.push("completed_at=datetime('now')");
        else if (!isTerminal(def, ns) && isTerminal(def, String(cur.status))) sets.push("completed_at=NULL");
      }
      sets.push("updated_at=datetime('now')");
      args.push(id);
      await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=?`, args });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- move card (status) ----
  router.post(P + "/card/:id/move", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    const b = req.body || {};
    // The stage rail is gone (Track 0): a {stage:…} body is an invalid move.
    if (b.stage != null) return jsonError(res, 400, "invalid status");
    const status = String(b.status || "");
    if (!status) return jsonError(res, 400, "invalid status");
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT status, project_id, archived_at FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!cur) return jsonError(res, 404, "card not found");
      // D-T1.6: this JSON route is what drag-and-drop calls (client.js
      // '/card/'+id+'/move') — not converged onto card-service.moveCard —
      // so the archived guard is inline, same as the edit route above.
      if (cur.archived_at != null) return res.status(409).json({ reason: "card is archived", code: "archived" });
      const def = await resolveBoardDef(tdb, { projectId: cur.project_id });
      if (!isValidStatus(def, status)) return jsonError(res, 400, "invalid status");
      const sets = ["status=?", "updated_at=datetime('now')"];
      if (isTerminal(def, status) && !isTerminal(def, String(cur.status))) sets.push("completed_at=datetime('now')");
      else if (!isTerminal(def, status) && isTerminal(def, String(cur.status))) sets.push("completed_at=NULL");
      await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=?`, args: [status, id] });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- cancel card ----
  router.post(P + "/card/:id/cancel", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT id, status, project_id, archived_at FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!cur) return jsonError(res, 404, "card not found");
      if (cur.archived_at != null) return res.status(409).json({ reason: "card is archived", code: "archived" });
      const def = await resolveBoardDef(tdb, { projectId: cur.project_id });
      if (!isValidStatus(def, "cancelled")) {
        return jsonError(res, 400, "this board has no cancelled status");
      }
      // completed_at follows the def's terminal-ness, same transition rule as
      // move/edit — a board may legally list 'cancelled' as non-terminal.
      const sets = ["status='cancelled'", "updated_at=datetime('now')"];
      if (isTerminal(def, "cancelled") && !isTerminal(def, String(cur.status))) sets.push("completed_at=datetime('now')");
      else if (!isTerminal(def, "cancelled") && isTerminal(def, String(cur.status))) sets.push("completed_at=NULL");
      await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=?`, args: [id] });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- archive / unarchive card (D-T1.6) ----
  router.post(P + "/card/:id/archive", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    let tdb, cdb;
    try {
      cdb = createDbClient();
      tdb = createDbClient(TASKS_DB);
      await archiveCard(tdb, cdb, id, DASHBOARD_ACTOR);
      return res.json({ ok: true });
    } catch (e) {
      return serviceError(res, e);
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  router.post(P + "/card/:id/unarchive", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      await unarchiveCard(tdb, id, DASHBOARD_ACTOR);
      return res.json({ ok: true });
    } catch (e) {
      return serviceError(res, e);
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- read plan (D-T1.4: plans are RECORDS now, not a file) ----
  // Guard: nothing reads by bare id (D-T1.8) — `id` must resolve as a CARD
  // (board_id IS NULL) before plan-service is ever consulted for it.
  router.get(P + "/card/:id/plan", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      const [versions, current] = await Promise.all([listPlans(tdb, id), getCurrentPlan(tdb, id)]);
      return res.json({
        versions: versions.map((v) => ({ version: v.version, status: v.status, created_at: v.created_at })),
        current: current ? { version: current.version, body_md: current.body_md, status: current.status } : null,
      });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- save plan: always appends a new draft version (plan-service.savePlan) ----
  router.post(P + "/card/:id/plan", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    const b = req.body || {};
    if (typeof b.body_md !== "string") return jsonError(res, 400, "body_md (string) required");
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      const { version } = await savePlan(tdb, id, b.body_md, DASHBOARD_ACTOR);
      return res.json({ ok: true, version });
    } catch (e) {
      return serviceError(res, e);
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- approve a plan version (plan-service.approvePlan; decided_via='dashboard') ----
  router.post(P + "/card/:id/plan/approve", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    const version = Number((req.body || {}).version);
    if (!Number.isInteger(version)) return jsonError(res, 400, "version (integer) required");
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      await approvePlan(tdb, id, version, DASHBOARD_ACTOR, "dashboard");
      return res.json({ ok: true });
    } catch (e) {
      return serviceError(res, e);
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- assign / clear / reassign a card's project ----
  router.post(P + "/card/:id/project", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    const raw = (req.body || {}).project_id;
    const projectId = raw == null || raw === "" ? null : Number(raw);
    if (projectId != null && !Number.isInteger(projectId)) return jsonError(res, 400, "bad project_id");
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!cur) return jsonError(res, 404, "card not found");
      await tdb.execute({
        sql: "UPDATE tasks_items SET project_id=?, updated_at=datetime('now') WHERE id=?",
        args: [projectId, id],
      });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- force-unlock (D5 stale-lock recovery; FAIL-CLOSED) ----
  router.post(P + "/card/:id/force-unlock", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    let tdb, cdb;
    try {
      // D-T1.8: nothing reads by bare id — bot_jobs/bot_sessions key on
      // card_id without a kind marker, so this is the one guard boundary
      // that has to ask tasks.db directly before the lock rails are ever
      // consulted for a tracker-item id.
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      cdb = createDbClient();
      const { rail, row } = await lockState(cdb, id);
      if (!row) return res.status(409).json({ reason: "no bot_sessions row for this card — nothing to unlock" });

      // ---- JOB rail: the lock is an unfinished bot_jobs row, not a session.
      // Releasing it means TERMINATING the job — a job left 'queued' would be
      // claimed later and re-take the card. 'failed' is the terminal status
      // job_runner already understands (claimNextJob only reads 'queued';
      // recoverStaleClaims only scans 'running'), so a failed row can never be
      // resurrected. No new status value is invented for this.
      if (rail === "job") {
        const jobStatus = String(row.status);

        // BOTH RAILS ARE NORMALLY HELD AT ONCE for a RUNNING card job: the job
        // executes bridge.handleInbound IN-PROCESS (job_runner runCardExecute),
        // and handleInbound upserts a bot_sessions row carrying this card_id
        // with status='active' BEFORE it spawns pi. lockState reports the job
        // rail first, so without this lookup the session rail's gates —
        // piLiveness() and the 30-minute staleness window — would simply never
        // be consulted for a card job. They exist for exactly this case.
        const sess = await sessionRowFor(cdb, id);
        const sessionHolds = !!(sess && SESSION_LOCK_STATUSES.has(String(sess.status)));

        // A 'queued' job has provably not been claimed — there is no worker to
        // outlive and no work to lose, so no staleness window applies. This is
        // the exact case the operator is stuck in when the pi-bots runtime is
        // down: the job will never start, and until it is failed the card is
        // unwritable. A 'running' job goes through the same fail-closed gate a
        // session does, against the worker pid that claimed it AND — because pi
        // is spawned detached:true and outlives its parent — against the pi
        // process itself. A dead worker with an orphaned live pi reads 'dead' on
        // the pid check alone; that is not enough to declare the card free.
        if (jobStatus === "running") {
          const live = workerLiveness(row.worker_pid);
          if (live !== "dead") {
            return res.status(409).json({
              reason: live === "alive"
                ? "refused: the worker process running this job is still alive"
                : "refused (fail-closed): could not positively confirm the job worker is dead",
            });
          }
          if (sessionHolds) {
            const piLive = piLiveness(sess.pi_session_dir);
            if (piLive !== "dead") {
              return res.status(409).json({
                reason: piLive === "alive"
                  ? "refused: this card's job has a live pi process (its session row is still " + String(sess.status) + ") — the worker died but pi is detached and outlived it"
                  : "refused (fail-closed): the card is also held by a bot_sessions row and the pi could not be positively confirmed dead",
              });
            }
          }
        }
        // Guarded on the status we OBSERVED: if the runner claimed the queued
        // job between the read and this write, 0 rows change and we report that
        // rather than failing a job that just started running.
        const upd = await cdb.execute({
          sql: "UPDATE bot_jobs SET status='failed', error=?, ended_at=datetime('now') WHERE job_id=? AND status=?",
          args: ["force-unlocked from the board by an operator (was '" + jobStatus + "')", row.job_id, jobStatus],
        });
        const cleared = Number(upd.rowsAffected) || 0;
        // Terminating the job IS the whole release: the card row was never
        // written by dispatch (Track 0), so there is nothing to reset — the
        // lock predicate stops reporting the card held the moment this row is
        // terminal. The session rail keeps its own gates; force-unlock it
        // separately.
        return res.json({
          ok: true, cleared, rail: "job", job_id: row.job_id,
          session_lock: sessionHolds ? { status: String(sess.status), age_s: Number(sess.age_s) } : null,
          note: sessionHolds
            ? "the job is terminated, but a bot_sessions row still holds this card — force-unlock again once that session is stale (>= " + STALE_SECONDS + "s) and its pi is confirmed dead"
            : undefined,
        });
      }

      if (!SESSION_LOCK_STATUSES.has(String(row.status))) {
        return res.status(409).json({ reason: "card is not locked (latest session is " + String(row.status) + ")" });
      }
      const ageS = Number(row.age_s);
      if (!Number.isFinite(ageS) || ageS < STALE_SECONDS) {
        return res.status(409).json({ reason: "session is not stale yet (age " + (Number.isFinite(ageS) ? ageS + "s" : "unknown") + "; need ≥ " + STALE_SECONDS + "s)" });
      }
      // FAIL-CLOSED liveness gate (Step-1 pinned pattern).
      const live = piLiveness(row.pi_session_dir);
      if (live !== "dead") {
        return res.status(409).json({
          reason: live === "alive"
            ? "refused: a live pi process for this bot is still running"
            : "refused (fail-closed): could not positively confirm the pi is dead",
        });
      }
      // Idempotent: WHERE-guard prevents clobbering an already-moved row;
      // it does NOT replace the liveness gate above. 'error' ∈ the CHECK.
      const r = await cdb.execute({
        sql: "UPDATE bot_sessions SET status='error', updated_at=datetime('now') WHERE id=? AND status IN ('active','waiting-user')",
        args: [row.id],
      });
      return res.json({ ok: true, cleared: Number(r.rowsAffected) || 0 });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- execute from board (spec: dispatch is explicit; drags never dispatch) ----
  // ENQUEUES a bot_jobs row and writes NOTHING to the card. "A bot is working
  // this card" is the lock predicate (board-lock.js), derived from the live
  // rails — when the job goes terminal the lock releases by itself, so there
  // is no stranded state and no un-strand rail. Recovery from a dead worker is
  // re-dispatch. Gate: unlocked, non-terminal on ITS board, has a bot.
  router.post(P + "/card/:id/execute", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({
        sql: "SELECT id, status, assigned_bot, project_id, archived_at FROM tasks_items WHERE id=? AND board_id IS NULL",
        args: [id],
      })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      // D-T1.6: this route reads the card row directly (never converged onto
      // card-service) — the archived guard lands HERE, not in a service.
      if (card.archived_at != null) return res.status(409).json({ reason: "card is archived", code: "archived" });
      const bot = card.assigned_bot ? String(card.assigned_bot) : "";
      if (!bot) return jsonError(res, 400, "card has no assigned_bot");
      const botRow = (await cdb.execute({
        sql: "SELECT bot_id FROM pi_bot_defs WHERE bot_id=? AND enabled=1", args: [bot],
      })).rows[0];
      if (!botRow) return jsonError(res, 400, "assigned_bot not found or disabled");
      const def = await resolveBoardDef(tdb, { projectId: card.project_id });
      if (isTerminal(def, card.status)) {
        return res.status(409).json({ reason: "card is in a terminal status (" + String(card.status) + ")" });
      }
      const jobId = await enqueueCardJob(cdb, {
        botId: bot, cardId: id, action: "execute",
        goal: "Execute board card #" + id,
      });
      return res.json({ ok: true, dispatched: bot, jobId });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- create project ----
  router.post(P + "/project", async (req, res) => {
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return jsonError(res, 400, "name is required"); // BEFORE INSERT
    let cdb;
    try {
      cdb = createDbClient();
      const { id: newId } = await createProjectSpace(cdb, {
        name,
        description: b.description ? String(b.description) : null,
      });
      return res.json({ ok: true, id: newId });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- edit project metadata ----
  router.post(P + "/project/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    const b = req.body || {};
    if (b.status != null && !PROJECT_STATUSES.has(String(b.status))) {
      return jsonError(res, 400, "invalid project status"); // BEFORE SQL
    }
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (b.name != null && !name) return jsonError(res, 400, "name cannot be empty");
    // Collect the patch fields the caller provided.
    const patch = {};
    if (b.name != null) patch.name = name;
    if (b.description != null) patch.description = String(b.description) || null;
    if (b.status != null) patch.status = String(b.status);
    if (!Object.keys(patch).length) return jsonError(res, 400, "nothing to update");
    let cdb;
    try {
      cdb = createDbClient();
      const cur = (await cdb.execute({ sql: "SELECT id FROM project_spaces WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jsonError(res, 404, "project not found");
      await updateProjectSpaceMeta(cdb, id, patch);
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- unlinked-cards picker (project_id IS NULL) for bulk-assign ----
  // D-T1.6: default-hides archived (an archived orphan is not a candidate to
  // re-home); ?include_archived=1 is the escape.
  router.get(P + "/project/:id/unlinked", async (req, res) => {
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const cards = (await tdb.execute({
        sql: "SELECT id, title FROM tasks_items WHERE project_id IS NULL"
          + (wantsArchived(req) ? "" : " AND archived_at IS NULL")
          + " ORDER BY id LIMIT 500",
        args: [],
      })).rows || [];
      return res.json({ cards });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- bulk-assign cards to a project (atomic; per-card report) ----
  router.post(P + "/project/:id/bulk-assign", async (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) return jsonError(res, 400, "bad project id");
    const ids = Array.isArray((req.body || {}).card_ids)
      ? req.body.card_ids.map(Number).filter((n) => Number.isInteger(n))
      : [];
    if (!ids.length) return jsonError(res, 400, "card_ids[] required");
    if (ids.length > BULK_CAP) return jsonError(res, 400, `too many cards (max ${BULK_CAP})`);
    let tdb, cdb;
    try {
      cdb = createDbClient();
      // Lock-filter FIRST — you cannot conditionally skip inside an atomic
      // batch. Partition into survivors vs skipped[] (locked).
      const survivors = [];
      const skipped = [];
      for (const cid of ids) {
        const { locked } = await lockState(cdb, cid);
        if (locked) skipped.push({ id: cid, reason: "locked" });
        else survivors.push(cid);
      }
      let applied = [];
      if (survivors.length) {
        tdb = createDbClient(TASKS_DB);
        // D-T1.6: archived cards are NOT bulk-assign candidates (the same
        // rule as move/update — an archived card refuses a write) unless the
        // caller opts in with ?include_archived=1. Filtered here, AFTER the
        // lock check, BEFORE the batch is built — one query, no per-card loop.
        let writable = survivors;
        if (!wantsArchived(req)) {
          const placeholders = survivors.map(() => "?").join(",");
          const archivedRows = (await tdb.execute({
            sql: `SELECT id FROM tasks_items WHERE id IN (${placeholders}) AND archived_at IS NOT NULL`,
            args: survivors,
          })).rows || [];
          const archivedIds = new Set(archivedRows.map((r) => Number(r.id)));
          if (archivedIds.size) {
            writable = survivors.filter((cid) => !archivedIds.has(cid));
            for (const cid of survivors) {
              if (archivedIds.has(cid)) skipped.push({ id: cid, reason: "archived" });
            }
          }
        }
        if (writable.length) {
          const stmts = writable.map((cid) => ({
            sql: "UPDATE tasks_items SET project_id=?, updated_at=datetime('now') WHERE id=?",
            args: [projectId, cid],
          }));
          let results;
          try {
            // ONE atomic transaction (createDbClient().batch wraps all in a
            // single db.transaction — all-or-nothing).
            results = await tdb.batch(stmts);
          } catch (e) {
            // Rejected ⇒ the WHOLE txn rolled back; NOTHING applied.
            return res.json({
              ok: false,
              error: "bulk assignment failed and was rolled back: " + String(e.message || e),
              applied: [],
              skipped: skipped.concat(writable.map((id) => ({ id, reason: "rolled-back" }))),
            });
          }
          // applied[] derived ONLY from the resolved per-statement rowsAffected
          // (1 ⇒ applied; 0 ⇒ the row vanished between filter and batch ⇒
          // skipped:"stale"). Never from the pre-built survivor list.
          results.forEach((r, i) => {
            const cid = writable[i];
            if (Number(r && r.rowsAffected) === 1) applied.push(cid);
            else skipped.push({ id: cid, reason: "stale" });
          });
        }
      }
      return res.json({ ok: true, applied, skipped });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- session stop (S3: session resume UX) ----
  router.post(P + "/session/stop", async (req, res) => {
    const b = req.body || {};
    const botId = b.bot_id, threadId = b.gateway_thread_id;
    if (!botId || !threadId) return jsonError(res, 400, "bot_id and gateway_thread_id required");
    let cdb;
    try {
      cdb = createDbClient();
      const sess = (await cdb.execute({
        sql: "SELECT id, status FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1",
        args: [botId, threadId],
      })).rows[0];
      if (!sess) return res.json({ ok: false, reason: "no session" });
      await cdb.execute({
        sql: "UPDATE bot_sessions SET control='stop', status='stopped', updated_at=datetime('now') WHERE id=?",
        args: [sess.id],
      });
      return res.json({ ok: true, sessionId: sess.id });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- session send message (S3: dispatches via bridge --inject) ----
  router.post(P + "/session/send", async (req, res) => {
    const b = req.body || {};
    const botId = b.bot_id, threadId = b.gateway_thread_id, message = b.message;
    if (!botId || !threadId || !message) return jsonError(res, 400, "bot_id, gateway_thread_id, and message required");
    const { spawn } = await import("node:child_process");
    const NODE = HOME + "/.nvm/versions/node/v20.20.2/bin/node";
    const BRIDGE = HOME + "/crow/scripts/pi-bots/bridge.mjs";
    const payload = JSON.stringify({ bot_id: botId, gateway_thread_id: threadId, user_message: message });
    const child = spawn(NODE, [BRIDGE, "--inject", payload], {
      cwd: HOME, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    child.unref();
    return res.json({ ok: true, message: "Dispatch started (background)" });
  });

  // ---- session transcript (S3: raw JSONL viewer) ----
  router.get(P + "/session/:id/transcript", async (req, res) => {
    const sessId = Number(req.params.id);
    if (!Number.isInteger(sessId)) return jsonError(res, 400, "bad session id");
    let cdb;
    try {
      cdb = createDbClient();
      const sess = (await cdb.execute({
        sql: "SELECT pi_session_id, pi_session_dir FROM bot_sessions WHERE id=?",
        args: [sessId],
      })).rows[0];
      if (!sess || !sess.pi_session_id || !sess.pi_session_dir) {
        return res.status(404).send("<pre>No transcript available (session has no pi_session_id or dir).</pre>");
      }
      const tPath = sess.pi_session_dir + "/" + sess.pi_session_id + "/transcript.jsonl";
      if (!existsSync(tPath)) {
        return res.status(404).send("<pre>Transcript file not found: " + tPath + "</pre>");
      }
      const content = readFileSync(tPath, "utf8");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.send(content);
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- board settings (Track 0): read + upsert a project board's def ----
  router.get(P + "/board-def", async (req, res) => {
    const projectId = req.query.project_id == null || req.query.project_id === "" ? null : Number(req.query.project_id);
    if (projectId == null || !Number.isInteger(projectId)) return jsonError(res, 400, "bad project_id");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const def = await resolveBoardDef(tdb, { projectId });
      return res.json({
        project_id: projectId, display_name: def.display_name,
        status_values: def.status_values, terminal_values: def.terminal_values,
        fields: def.fields, builtin: def.builtin,
      });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  router.post(P + "/board-def", async (req, res) => {
    const b = req.body || {};
    const projectId = b.project_id == null || b.project_id === "" ? null : Number(b.project_id);
    if (projectId == null || !Number.isInteger(projectId)) return jsonError(res, 400, "bad project_id");
    const v = validateDefPayload(b);
    if (!v.ok) return jsonError(res, 400, v.error);
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      // Config must never orphan data: refuse to drop a status that still has
      // cards on it. Renames are remove+add and get the same guard — move the
      // cards on the board first, then remove the value.
      const keep = new Set(JSON.parse(v.def.status_values));
      const counts = (await tdb.execute({
        sql: "SELECT status, COUNT(*) AS n FROM tasks_items WHERE project_id=? GROUP BY status",
        args: [projectId],
      })).rows || [];
      for (const r of counts) {
        if (!keep.has(String(r.status))) {
          return jsonError(res, 400, `status '${r.status}' still has ${r.n} card${Number(r.n) === 1 ? "" : "s"} — move them first`);
        }
      }
      await tdb.execute({
        sql:
          "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(project_id) DO UPDATE SET display_name=excluded.display_name, " +
          "status_values=excluded.status_values, terminal_values=excluded.terminal_values, " +
          "fields_json=excluded.fields_json, updated_at=datetime('now')",
        args: [projectId, v.def.display_name, v.def.status_values, v.def.terminal_values, v.def.fields_json],
      });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  router.get(P + "/models", async (req, res) => {
    const db = createDbClient();
    try {
      const all = await listProvidersAll(db);
      const models = [];
      for (const row of all) {
        if (row.disabled) continue;
        for (const m of row.models || []) {
          const mid = typeof m === "string" ? m : m.id;
          if (!mid) continue;
          models.push({ provider: row.id, id: mid, name: m.name || mid, key: `${row.id}/${mid}` });
        }
      }
      return res.json({ models });
    } catch (err) {
      return res.json({ models: [], error: err.message });
    } finally {
      db.close();
    }
  });

  // Spread-preserve: client.js reads entry keys beyond key/label (`type`
  // drives the json-field renderer at client.js:134, `readonly` at :135) — a
  // keep-list here would silently strip them. Only key/label/storage are
  // normalized; every other input key rides through unchanged. Same rule as
  // migration 0003's mapFields (scripts/migrations/0003-tracker-convergence.mjs).
  function mapTrackerFields(columnsJson) {
    const cols = Array.isArray(columnsJson) ? columnsJson : [];
    return cols.filter((c) => c && typeof c === "object" && c.key).map((c) => ({
      ...c,
      key: String(c.key),
      label: String(c.label || c.key),
      storage: "data",
    }));
  }

  // ---- create tracker def ----
  router.post(P + "/tracker", async (req, res) => {
    const b = req.body || {};
    const slug = typeof b.slug === "string" ? b.slug.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") : "";
    const displayName = typeof b.display_name === "string" ? b.display_name.trim() : "";
    if (!slug || !displayName) return jsonError(res, 400, "slug and display_name are required");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const existing = (await tdb.execute({ sql: "SELECT id FROM board_defs WHERE slug=?", args: [slug] })).rows[0];
      if (existing) return jsonError(res, 409, "tracker slug already exists: " + slug);
      const statusValues = Array.isArray(b.status_values) ? b.status_values : ["pending"];
      const columnsJson = Array.isArray(b.columns_json) ? b.columns_json : [];
      // Same rule migration 0003 applied: terminal-seed 'done' iff present.
      const terminals = statusValues.includes("done") ? ["done"] : [];
      const fields = mapTrackerFields(columnsJson);
      const r = await tdb.execute({
        sql: "INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES (?, ?, ?, ?, ?)",
        args: [slug, displayName, JSON.stringify(statusValues), JSON.stringify(terminals), JSON.stringify(fields)],
      });
      return res.json({ ok: true, id: Number(r.lastInsertRowid), slug });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- update tracker def ----
  router.post(P + "/tracker/:slug", async (req, res) => {
    const b = req.body || {};
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT id FROM board_defs WHERE slug=?", args: [req.params.slug] })).rows[0];
      if (!cur) return jsonError(res, 404, "tracker not found");
      const sets = [], args = [];
      if (b.display_name != null) { sets.push("display_name=?"); args.push(String(b.display_name).trim()); }
      if (b.status_values != null) { sets.push("status_values=?"); args.push(JSON.stringify(Array.isArray(b.status_values) ? b.status_values : [])); }
      if (b.columns_json != null) { sets.push("fields_json=?"); args.push(JSON.stringify(mapTrackerFields(Array.isArray(b.columns_json) ? b.columns_json : []))); }
      if (!sets.length) return jsonError(res, 400, "nothing to update");
      sets.push("updated_at=datetime('now')");
      args.push(cur.id);
      await tdb.execute({ sql: `UPDATE board_defs SET ${sets.join(", ")} WHERE id=?`, args });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- tracker defs list (S3: for custom tracker selector) ----
  router.get(P + "/trackers", async (req, res) => {
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const rows = (await tdb.execute({
        sql: "SELECT id, slug, display_name, fields_json AS columns_json, status_values FROM board_defs WHERE slug IS NOT NULL ORDER BY slug",
        args: [],
      })).rows || [];
      return res.json({ trackers: rows });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ── Phase 2: tracker item CRUD (unified bot board) ──────────────────

  function parseDataJson(raw) {
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }

  function trackerItemLocked(item) {
    return String(item.processing_lease_status) === "in-progress";
  }

  router.get(P + "/tracker/:slug/items", async (req, res) => {
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const def = (await tdb.execute({
        sql: "SELECT id, display_name, fields_json AS columns_json, status_values FROM board_defs WHERE slug=?",
        args: [req.params.slug],
      })).rows[0];
      if (!def) return jsonError(res, 404, "tracker not found");
      const clauses = ["board_id = ?"];
      const params = [def.id];
      if (req.query.status) { clauses.push("status = ?"); params.push(String(req.query.status)); }
      if (req.query.bot_id) { clauses.push("bot_id = ?"); params.push(String(req.query.bot_id)); }
      // D-T1.6: default view excludes archived; ?include_archived=1 escapes.
      if (!wantsArchived(req)) clauses.push("archived_at IS NULL");
      const rows = (await tdb.execute({
        sql: `SELECT id, board_id, bot_id, status, priority, title AS label, data_json, action_needed,
                next_followup_date, processing_lease, processing_lease_status, archived_at, created_at, updated_at
              FROM tasks_items WHERE ${clauses.join(" AND ")}
              ORDER BY priority ASC, id ASC LIMIT 500`,
        args: params,
      })).rows || [];
      const locks = {};
      const items = rows.map((r) => {
        if (trackerItemLocked(r)) locks[r.id] = true;
        return { ...r, data: parseDataJson(r.data_json) };
      });
      return res.json({
        tracker: { slug: req.params.slug, display_name: def.display_name, columns_json: def.columns_json, status_values: def.status_values },
        items, locks,
      });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  router.get(P + "/tracker-item/:id", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const r = (await tdb.execute({
        sql: `SELECT id, board_id, bot_id, status, priority, title AS label, data_json, action_needed,
                next_followup_date, processing_lease, processing_lease_status, archived_at, created_at, updated_at
              FROM tasks_items WHERE id=? AND board_id IS NOT NULL`,
        args: [itemId],
      })).rows[0];
      if (!r) return jsonError(res, 404, "item not found");
      const def = (await tdb.execute({
        sql: "SELECT slug, display_name, fields_json AS columns_json, status_values FROM board_defs WHERE id=?",
        args: [r.board_id],
      })).rows[0];
      return res.json({
        item: { ...r, data: parseDataJson(r.data_json) },
        tracker: def || null,
        locked: trackerItemLocked(r),
      });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  router.post(P + "/tracker-item/:id", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    const b = req.body || {};
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({
        sql: `SELECT id, board_id, bot_id, status, priority, title AS label, data_json, action_needed,
                next_followup_date, processing_lease, processing_lease_status, archived_at, created_at, updated_at
              FROM tasks_items WHERE id=? AND board_id IS NOT NULL`,
        args: [itemId],
      })).rows[0];
      if (!cur) return jsonError(res, 404, "item not found");
      if (trackerItemLocked(cur)) return res.status(409).json({ reason: "item is being processed by a bot" });
      // D-T1.6: this route is not converged onto card-service.updateItem —
      // inline guard, same rule (an archived item refuses a write).
      if (cur.archived_at != null) return res.status(409).json({ reason: "item is archived", code: "archived" });
      if (b.status != null) {
        const def = (await tdb.execute({ sql: "SELECT status_values FROM board_defs WHERE id=?", args: [cur.board_id] })).rows[0];
        if (def) {
          const allowed = JSON.parse(def.status_values || "[]");
          if (!allowed.includes(String(b.status))) return jsonError(res, 400, "invalid status: " + b.status);
        }
      }
      const sets = [], args = [];
      if (b.status != null) { sets.push("status=?"); args.push(String(b.status)); }
      if (b.priority != null) { sets.push("priority=?"); args.push(Number(b.priority)); }
      if (b.label != null) { sets.push("title=?"); args.push(String(b.label)); }
      if (b.action_needed !== undefined) { sets.push("action_needed=?"); args.push(b.action_needed); }
      if (b.data && typeof b.data === "object") {
        const merged = { ...parseDataJson(cur.data_json), ...b.data };
        sets.push("data_json=?"); args.push(JSON.stringify(merged));
      }
      if (!sets.length) return jsonError(res, 400, "nothing to update");
      sets.push("updated_at=datetime('now')");
      args.push(itemId);
      await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=?`, args });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  router.post(P + "/tracker-item/:id/move", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    const status = String((req.body || {}).status || "");
    if (!status) return jsonError(res, 400, "status required");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT * FROM tasks_items WHERE id=? AND board_id IS NOT NULL", args: [itemId] })).rows[0];
      if (!cur) return jsonError(res, 404, "item not found");
      if (trackerItemLocked(cur)) return res.status(409).json({ reason: "item is being processed by a bot" });
      if (cur.archived_at != null) return res.status(409).json({ reason: "item is archived", code: "archived" });
      const def = (await tdb.execute({ sql: "SELECT status_values FROM board_defs WHERE id=?", args: [cur.board_id] })).rows[0];
      if (def) {
        const allowed = JSON.parse(def.status_values || "[]");
        if (!allowed.includes(status)) return jsonError(res, 400, "invalid status: " + status);
      }
      await tdb.execute({ sql: "UPDATE tasks_items SET status=?, updated_at=datetime('now') WHERE id=?", args: [status, itemId] });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- create tracker item ----
  router.post(P + "/tracker-item", async (req, res) => {
    const b = req.body || {};
    const slug = String(b.tracker_slug || "");
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (!slug || !label) return jsonError(res, 400, "tracker_slug and label are required");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const def = await resolveSlugBoardDef(tdb, slug);
      if (!def) return jsonError(res, 404, "tracker not found: " + slug);
      const status = b.status ? String(b.status) : (def.status_values[0] || "pending");
      if (!def.status_values.includes(status)) return jsonError(res, 400, "invalid status: " + status);
      const priority = b.priority != null ? Number(b.priority) : 3;
      const dataJson = b.data && typeof b.data === "object" ? JSON.stringify(b.data) : "{}";
      const r = await tdb.execute({
        sql: `INSERT INTO tasks_items (board_id, bot_id, status, priority, title, data_json, action_needed)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [def.id, b.bot_id || null, status, priority, label, dataJson, b.action_needed || null],
      });
      return res.json({ ok: true, id: Number(r.lastInsertRowid) });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- archive / unarchive tracker item (D-T1.6: same mechanism as cards) ----
  router.post(P + "/tracker-item/:id/archive", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      await archiveItem(tdb, itemId, DASHBOARD_ACTOR);
      return res.json({ ok: true });
    } catch (e) {
      return serviceError(res, e);
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  router.post(P + "/tracker-item/:id/unarchive", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      await unarchiveItem(tdb, itemId, DASHBOARD_ACTOR);
      return res.json({ ok: true });
    } catch (e) {
      return serviceError(res, e);
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  router.post(P + "/tracker-item/:id/force-clear-lease", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT processing_lease_status FROM tasks_items WHERE id=? AND board_id IS NOT NULL", args: [itemId] })).rows[0];
      if (!cur) return jsonError(res, 404, "item not found");
      if (!trackerItemLocked(cur)) return res.json({ ok: true, message: "already unlocked" });
      await tdb.execute({
        sql: "UPDATE tasks_items SET processing_lease=NULL, processing_lease_status=NULL, updated_at=datetime('now') WHERE id=?",
        args: [itemId],
      });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ── Slice C: opt-in self-authoring skill proposals ──────────────────
  // A self_authoring bot drafts proposals into <def.session_dir>/proposed-skills
  // (the bridge confines it there). These endpoints let the operator review and
  // either APPROVE (copy the reviewed text into ~/.crow/skills + attach to
  // def.skills) or REJECT (discard). normalizeSkillName is the ONLY name source
  // for any path — it strips .md and rejects traversal/slashes, so join() cannot
  // escape. We additionally refuse symlinks and never overwrite an existing skill.

  async function loadBotDef(cdb, botId) {
    const row = (await cdb.execute({
      sql: "SELECT definition, updated_at FROM pi_bot_defs WHERE bot_id=?",
      args: [botId],
    })).rows[0];
    if (!row) return null;
    let def; try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
    return { def, updatedAt: row.updated_at == null ? null : String(row.updated_at) };
  }

  // ---- list a bot's staged proposals (name, text, guardrail flags) ----
  router.get(P + "/bot/:botId/proposed-skills", async (req, res) => {
    const botId = String(req.params.botId || "");
    let cdb;
    try {
      cdb = createDbClient();
      const b = await loadBotDef(cdb, botId);
      if (!b) return jsonError(res, 404, "unknown bot");
      const proposals = listProposals(b.def.session_dir)
        .map((p) => ({ name: p.name, text: p.text, flags: p.flags, mtime: p.mtime }));
      return res.json({ proposals });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- approve: promote a proposal to ~/.crow/skills + attach to def.skills ----
  router.post(P + "/bot/:botId/proposed-skill/approve", async (req, res) => {
    const botId = String(req.params.botId || "");
    const body = req.body || {};
    const name = normalizeSkillName(body.name);
    if (!name) return jsonError(res, 400, "invalid skill name"); // BEFORE any path use
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return jsonError(res, 400, "content (non-empty reviewed text) required");
    let cdb;
    try {
      cdb = createDbClient();
      const b = await loadBotDef(cdb, botId);
      if (!b) return jsonError(res, 404, "unknown bot");
      const sessionDir = b.def.session_dir;
      if (!sessionDir) return jsonError(res, 400, "bot has no session_dir");

      // staged source must exist + be a regular file (no symlink-follow)
      const stagedPath = join(proposalsDir(sessionDir), name + ".md");
      if (!existsSync(stagedPath)) return jsonError(res, 404, "no staged proposal named " + name);
      if (lstatSync(stagedPath).isSymbolicLink()) return jsonError(res, 400, "staged proposal is a symlink — refusing");

      // B4: write the OPERATOR-REVIEWED content (Q4 edits apply) + attach to the
      // def via the shared promoteSkill helper — the SAME code path the auto
      // review pass uses, so containment/no-overwrite/transaction live in one
      // place. mode:"operator" keeps the never-overwrite-an-existing-skill rule.
      const r = promoteSkill({ bot_id: botId, name, text: content, mode: "operator" });
      if (!r.ok) {
        const status = r.code === "exists" ? 409 : r.code === "unknown-bot" ? 404
          : (r.code === "invalid-name" || r.code === "empty" || r.code === "escape") ? 400 : 500;
        return jsonError(res, status, r.message);
      }
      // success — remove the staged file
      try { unlinkSync(stagedPath); } catch {}
      return res.json({ ok: true, promoted: name });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- reject: discard a staged proposal (operator confirms first) ----
  router.post(P + "/bot/:botId/proposed-skill/reject", async (req, res) => {
    const botId = String(req.params.botId || "");
    const name = normalizeSkillName((req.body || {}).name);
    if (!name) return jsonError(res, 400, "invalid skill name");
    let cdb;
    try {
      cdb = createDbClient();
      const b = await loadBotDef(cdb, botId);
      if (!b) return jsonError(res, 404, "unknown bot");
      if (!b.def.session_dir) return jsonError(res, 400, "bot has no session_dir");
      const stagedPath = join(proposalsDir(b.def.session_dir), name + ".md");
      if (existsSync(stagedPath)) {
        if (lstatSync(stagedPath).isSymbolicLink()) return jsonError(res, 400, "staged proposal is a symlink — refusing");
        unlinkSync(stagedPath);
      }
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  return router;
}
