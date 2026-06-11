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
 *    constructor anywhere in this file; no executeMultiple/DDL.
 *  - Status literals validated against a hardcoded in-app allowlist BEFORE
 *    any SQL → 400 (the DB CHECK is defense-in-depth, never caught).
 *  - card-create: title must be a non-empty trimmed string → 400 before the
 *    INSERT; status/priority are OMITTED from the INSERT column list (rely on
 *    DEFAULT 'pending' / DEFAULT 3 — never NULL-bind over a DEFAULT).
 *  - Every UPDATE explicitly sets updated_at=datetime('now'); →done/→cancelled
 *    also sets completed_at=datetime('now'); transition OUT of done/cancelled
 *    sets completed_at=NULL (SQLite DEFAULT is INSERT-only).
 *  - Whole-card single-writer lock (D5): every card write re-checks the
 *    MAX(id) bot_sessions row for that card_id (single-card form); status ∈
 *    {active,waiting-user} ⇒ 409 {reason}.
 *  - Plan file = DERIVED <def.session_dir>/plans/<cardId>.md; resolved
 *    realpath asserted under that session_dir (else 400); POST does an
 *    mtime optimistic-concurrency check (409 if changed since the GET).
 *  - bulk-assign: cap ≤200 (400 if exceeded); D5 lock-filter runs FIRST
 *    (partition survivors vs skipped[]); survivors go into ONE atomic
 *    db.batch(); applied[] is derived ONLY from the resolved batch result's
 *    per-statement rowsAffected (1 ⇒ applied, 0 ⇒ skipped:"stale"); a
 *    rejected batch ⇒ {error, applied:[]} (all rolled back).
 *  - force-unlock: permitted ONLY when the MAX(id) row is active/waiting-user
 *    AND stale (no updated_at movement ≥ 30 min) AND a POSITIVE "pi is dead"
 *    determination. The liveness check FAILS CLOSED: anything ambiguous /
 *    errored / unverifiable ⇒ refuse (card stays locked; manual SQL remains
 *    the escape hatch). Idempotent SQL guarded by status IN (...).
 *
 * Zero new npm deps. No bridge/pi edits. Never touches the 3 prod MPA bots.
 */
import { Router } from "express";
import { existsSync, readFileSync, writeFileSync, realpathSync, statSync, readdirSync, unlinkSync, mkdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "../../db.js";
import { jsonError } from "./_error.js";
import { listProvidersAll } from "../../orchestrator/providers-db.js";
import { proposalsDir, normalizeSkillName, listProposals } from "../../../scripts/pi-bots/skill_proposals.mjs";
// B4: shared write+attach helper (one code path with the auto review pass).
import { promoteSkill } from "../../../scripts/pi-bots/skill_promote.mjs";
import { listBotSkillEvents } from "../../../scripts/pi-bots/skill_provenance.mjs";
import { createProjectSpace, updateProjectSpaceMeta } from "../../shared/project-spaces.js";

// Slice C: operator-approved promotion target (the PRIMARY skills dir both the
// pi bridge and the glasses voice path search via skill_resolver).
const CROW_USER_SKILLS = "/home/kh0pp/.crow/skills";

const HOME = "/home/kh0pp";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const CARD_STATUSES = new Set(["pending", "in_progress", "done", "cancelled"]);
const PROJECT_STATUSES = new Set(["active", "paused", "completed", "archived"]);
const LOCK_STATUSES = new Set(["active", "waiting-user"]);
const TERMINAL = new Set(["done", "cancelled"]);
const STALE_SECONDS = 1800; // 30 min — force-unlock staleness threshold (D5)
const BULK_CAP = 200;

// D5 single-card lock re-check (the genuinely-single-card site). Returns
// { locked, row } where row is the MAX(id) bot_sessions row for the card.
async function lockState(cdb, cardId) {
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
    // bot_sessions absent (primary gateway) / transient — not locked here,
    // but the panel never opens this router there (notAvail). Be permissive
    // for read, conservative for write callers (they 409 only on positive).
    return { locked: false, row: null };
  }
}

// Resolve the plan-file path for a card exactly as the bridge does
// (bridge.mjs:151-152): the first pi_bot_defs row whose project_id column
// (M3b — was: definition.project_id JSON) matches the card's project →
// `<def.session_dir>/plans/<cardId>.md`. Returns { path, sessionDir } or null.
async function derivePlanPath(cdb, card) {
  if (card.project_id == null) return null;
  let defs = [];
  try {
    defs = (await cdb.execute({
      sql: "SELECT definition, project_id FROM pi_bot_defs WHERE project_id = ? ORDER BY bot_id",
      args: [Number(card.project_id)],
    })).rows || [];
  } catch {
    return null;
  }
  for (const row of defs) {
    let def;
    try { def = JSON.parse(row.definition || "{}"); } catch { continue; }
    if (def && def.session_dir) {
      const sessionDir = String(def.session_dir);
      return { path: sessionDir + "/plans/" + Number(card.id) + ".md", sessionDir };
    }
  }
  return null;
}

// Realpath containment — the resolved file must live under sessionDir. For a
// not-yet-existing plan file, resolve+contain the parent dir instead.
function containedRealPath(path, sessionDir) {
  try {
    const rootReal = realpathSync(sessionDir);
    let real;
    if (existsSync(path)) {
      real = realpathSync(path);
    } else {
      const slash = path.lastIndexOf("/");
      const dir = path.slice(0, slash);
      if (!existsSync(dir)) return null;
      real = realpathSync(dir) + path.slice(slash);
    }
    if (real === rootReal || real.startsWith(rootReal + "/")) return real;
    return null;
  } catch {
    return null;
  }
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
          "datetime(updated_at) AS updated_at, completed_at FROM tasks_items WHERE id=?",
        args: [id],
      })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      cdb = createDbClient();
      let projects = [];
      try {
        projects = (await cdb.execute({ sql: "SELECT id, name, slug FROM project_spaces WHERE archived_at IS NULL ORDER BY id", args: [] })).rows || [];
      } catch { projects = []; }
      const { locked } = await lockState(cdb, id);
      return res.json({ card, projects, locked });
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
      // OMIT status/priority from the column list → rely on DEFAULT 'pending'
      // / DEFAULT 3 (never NULL-bind over a DEFAULT). created_at/updated_at
      // via their INSERT DEFAULTs.
      const r = await tdb.execute({
        sql: "INSERT INTO tasks_items (title, description, due_date, owner, tags, project_id) VALUES (?,?,?,?,?,?)",
        args: [
          title,
          b.description ? String(b.description) : null,
          b.due_date ? String(b.due_date) : null,
          b.owner ? String(b.owner) : null,
          b.tags ? String(b.tags) : null,
          projectId,
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
    if (b.status != null && !CARD_STATUSES.has(String(b.status))) {
      return jsonError(res, 400, "invalid status"); // BEFORE SQL
    }
    let prio = null, prioSet = false;
    if (b.priority != null && b.priority !== "") {
      prio = Number(b.priority);
      if (!Number.isInteger(prio) || prio < 1 || prio > 5) return jsonError(res, 400, "priority must be 1-5");
      prioSet = true;
    }
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT status FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jsonError(res, 404, "card not found");
      const sets = ["title=?", "description=?", "due_date=?", "owner=?", "tags=?"];
      const args = [
        typeof b.title === "string" ? b.title.trim() : (b.title == null ? null : String(b.title)),
        b.description == null ? null : String(b.description),
        b.due_date == null || b.due_date === "" ? null : String(b.due_date),
        b.owner == null || b.owner === "" ? null : String(b.owner),
        b.tags == null || b.tags === "" ? null : String(b.tags),
      ];
      if (prioSet) { sets.push("priority=?"); args.push(prio); }
      if (b.status != null) {
        const ns = String(b.status);
        sets.push("status=?"); args.push(ns);
        if (TERMINAL.has(ns) && !TERMINAL.has(String(cur.status))) sets.push("completed_at=datetime('now')");
        else if (!TERMINAL.has(ns) && TERMINAL.has(String(cur.status))) sets.push("completed_at=NULL");
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
    const status = String((req.body || {}).status || "");
    if (!CARD_STATUSES.has(status)) return jsonError(res, 400, "invalid status"); // BEFORE SQL
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT status FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jsonError(res, 404, "card not found");
      const sets = ["status=?", "updated_at=datetime('now')"];
      if (TERMINAL.has(status) && !TERMINAL.has(String(cur.status))) sets.push("completed_at=datetime('now')");
      else if (!TERMINAL.has(status) && TERMINAL.has(String(cur.status))) sets.push("completed_at=NULL");
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
      const cur = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jsonError(res, 404, "card not found");
      await tdb.execute({
        sql: "UPDATE tasks_items SET status='cancelled', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?",
        args: [id],
      });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- read plan file ----
  router.get(P + "/card/:id/plan", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    let tdb, cdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT id, project_id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      cdb = createDbClient();
      const info = await derivePlanPath(cdb, card);
      if (!info) return res.json({ exists: false, markdown: "", mtime: null, reason: "no bot is linked to this project" });
      const real = containedRealPath(info.path, info.sessionDir);
      if (!real) return jsonError(res, 400, "plan path escapes the bot workspace");
      if (!existsSync(info.path)) return res.json({ exists: false, markdown: "", mtime: null });
      const mtime = String(statSync(info.path).mtimeMs);
      return res.json({ exists: true, markdown: readFileSync(info.path, "utf8"), mtime });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- save plan file (mtime optimistic-concurrency; lock-checked) ----
  router.post(P + "/card/:id/plan", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jsonError(res, 400, "bad id");
    const b = req.body || {};
    if (typeof b.markdown !== "string") return jsonError(res, 400, "markdown (string) required");
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return res.status(409).json({ reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT id, project_id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!card) return jsonError(res, 404, "card not found");
      const info = await derivePlanPath(cdb, card);
      if (!info) return jsonError(res, 400, "no bot is linked to this project — no plan path");
      const real = containedRealPath(info.path, info.sessionDir);
      if (!real) return jsonError(res, 400, "plan path escapes the bot workspace");
      const exists = existsSync(info.path);
      if (exists) {
        // Optimistic concurrency: the client's mtime (from its GET) must
        // still match. Hard 409 on mismatch — the drawer reloads the newer
        // content (no auto-merge in v1; Phase 5).
        const curMtime = String(statSync(info.path).mtimeMs);
        if (b.mtime != null && String(b.mtime) !== curMtime) {
          return res.status(409).json({ reason: "plan changed on disk since you opened it", mtime: curMtime });
        }
      }
      writeFileSync(info.path, b.markdown, "utf8");
      const mtime = String(statSync(info.path).mtimeMs);
      return res.json({ ok: true, mtime });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
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
      const cur = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
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
    let cdb;
    try {
      cdb = createDbClient();
      const { row } = await lockState(cdb, id);
      if (!row) return res.status(409).json({ reason: "no bot_sessions row for this card — nothing to unlock" });
      if (!LOCK_STATUSES.has(String(row.status))) {
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
  router.get(P + "/project/:id/unlinked", async (req, res) => {
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const cards = (await tdb.execute({
        sql: "SELECT id, title FROM tasks_items WHERE project_id IS NULL ORDER BY id LIMIT 500",
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
        const stmts = survivors.map((cid) => ({
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
            skipped: skipped.concat(survivors.map((id) => ({ id, reason: "rolled-back" }))),
          });
        }
        // applied[] derived ONLY from the resolved per-statement rowsAffected
        // (1 ⇒ applied; 0 ⇒ the row vanished between filter and batch ⇒
        // skipped:"stale"). Never from the pre-built survivor list.
        results.forEach((r, i) => {
          const cid = survivors[i];
          if (Number(r && r.rowsAffected) === 1) applied.push(cid);
          else skipped.push({ id: cid, reason: "stale" });
        });
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

  // ---- create tracker def ----
  router.post(P + "/tracker", async (req, res) => {
    const b = req.body || {};
    const slug = typeof b.slug === "string" ? b.slug.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") : "";
    const displayName = typeof b.display_name === "string" ? b.display_name.trim() : "";
    if (!slug || !displayName) return jsonError(res, 400, "slug and display_name are required");
    let cdb;
    try {
      cdb = createDbClient();
      const existing = (await cdb.execute({ sql: "SELECT id FROM tracker_defs WHERE slug=?", args: [slug] })).rows[0];
      if (existing) return jsonError(res, 409, "tracker slug already exists: " + slug);
      const statusValues = Array.isArray(b.status_values) ? b.status_values : ["pending"];
      const columnsJson = Array.isArray(b.columns_json) ? b.columns_json : [];
      const r = await cdb.execute({
        sql: "INSERT INTO tracker_defs (slug, display_name, columns_json, status_values) VALUES (?, ?, ?, ?)",
        args: [slug, displayName, JSON.stringify(columnsJson), JSON.stringify(statusValues)],
      });
      return res.json({ ok: true, id: Number(r.lastInsertRowid), slug });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- update tracker def ----
  router.post(P + "/tracker/:slug", async (req, res) => {
    const b = req.body || {};
    let cdb;
    try {
      cdb = createDbClient();
      const cur = (await cdb.execute({ sql: "SELECT id FROM tracker_defs WHERE slug=?", args: [req.params.slug] })).rows[0];
      if (!cur) return jsonError(res, 404, "tracker not found");
      const sets = [], args = [];
      if (b.display_name != null) { sets.push("display_name=?"); args.push(String(b.display_name).trim()); }
      if (b.status_values != null) { sets.push("status_values=?"); args.push(JSON.stringify(Array.isArray(b.status_values) ? b.status_values : [])); }
      if (b.columns_json != null) { sets.push("columns_json=?"); args.push(JSON.stringify(Array.isArray(b.columns_json) ? b.columns_json : [])); }
      if (!sets.length) return jsonError(res, 400, "nothing to update");
      sets.push("updated_at=datetime('now')");
      args.push(cur.id);
      await cdb.execute({ sql: `UPDATE tracker_defs SET ${sets.join(", ")} WHERE id=?`, args });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- tracker defs list (S3: for custom tracker selector) ----
  router.get(P + "/trackers", async (req, res) => {
    let cdb;
    try {
      cdb = createDbClient();
      const rows = (await cdb.execute({
        sql: "SELECT id, slug, display_name, columns_json, status_values FROM tracker_defs ORDER BY slug",
        args: [],
      })).rows || [];
      return res.json({ trackers: rows });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
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
    let cdb;
    try {
      cdb = createDbClient();
      const def = (await cdb.execute({
        sql: "SELECT id, display_name, columns_json, status_values FROM tracker_defs WHERE slug=?",
        args: [req.params.slug],
      })).rows[0];
      if (!def) return jsonError(res, 404, "tracker not found");
      const clauses = ["tracker_id = ?"];
      const params = [def.id];
      if (req.query.status) { clauses.push("status = ?"); params.push(String(req.query.status)); }
      if (req.query.bot_id) { clauses.push("bot_id = ?"); params.push(String(req.query.bot_id)); }
      const rows = (await cdb.execute({
        sql: `SELECT id, tracker_id, bot_id, status, priority, label, data_json, action_needed,
                next_followup_date, processing_lease, processing_lease_status, created_at, updated_at
              FROM tracker_items WHERE ${clauses.join(" AND ")}
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
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  router.get(P + "/tracker-item/:id", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    let cdb;
    try {
      cdb = createDbClient();
      const r = (await cdb.execute({
        sql: "SELECT * FROM tracker_items WHERE id=?", args: [itemId],
      })).rows[0];
      if (!r) return jsonError(res, 404, "item not found");
      const def = (await cdb.execute({
        sql: "SELECT slug, display_name, columns_json, status_values FROM tracker_defs WHERE id=?",
        args: [r.tracker_id],
      })).rows[0];
      return res.json({
        item: { ...r, data: parseDataJson(r.data_json) },
        tracker: def || null,
        locked: trackerItemLocked(r),
      });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  router.post(P + "/tracker-item/:id", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    const b = req.body || {};
    let cdb;
    try {
      cdb = createDbClient();
      const cur = (await cdb.execute({ sql: "SELECT * FROM tracker_items WHERE id=?", args: [itemId] })).rows[0];
      if (!cur) return jsonError(res, 404, "item not found");
      if (trackerItemLocked(cur)) return res.status(409).json({ reason: "item is being processed by a bot" });
      if (b.status != null) {
        const def = (await cdb.execute({ sql: "SELECT status_values FROM tracker_defs WHERE id=?", args: [cur.tracker_id] })).rows[0];
        if (def) {
          const allowed = JSON.parse(def.status_values || "[]");
          if (!allowed.includes(String(b.status))) return jsonError(res, 400, "invalid status: " + b.status);
        }
      }
      const sets = [], args = [];
      if (b.status != null) { sets.push("status=?"); args.push(String(b.status)); }
      if (b.priority != null) { sets.push("priority=?"); args.push(Number(b.priority)); }
      if (b.label != null) { sets.push("label=?"); args.push(String(b.label)); }
      if (b.action_needed !== undefined) { sets.push("action_needed=?"); args.push(b.action_needed); }
      if (b.data && typeof b.data === "object") {
        const merged = { ...parseDataJson(cur.data_json), ...b.data };
        sets.push("data_json=?"); args.push(JSON.stringify(merged));
      }
      if (!sets.length) return jsonError(res, 400, "nothing to update");
      sets.push("updated_at=datetime('now')");
      args.push(itemId);
      await cdb.execute({ sql: `UPDATE tracker_items SET ${sets.join(", ")} WHERE id=?`, args });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  router.post(P + "/tracker-item/:id/move", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    const status = String((req.body || {}).status || "");
    if (!status) return jsonError(res, 400, "status required");
    let cdb;
    try {
      cdb = createDbClient();
      const cur = (await cdb.execute({ sql: "SELECT * FROM tracker_items WHERE id=?", args: [itemId] })).rows[0];
      if (!cur) return jsonError(res, 404, "item not found");
      if (trackerItemLocked(cur)) return res.status(409).json({ reason: "item is being processed by a bot" });
      const def = (await cdb.execute({ sql: "SELECT status_values FROM tracker_defs WHERE id=?", args: [cur.tracker_id] })).rows[0];
      if (def) {
        const allowed = JSON.parse(def.status_values || "[]");
        if (!allowed.includes(status)) return jsonError(res, 400, "invalid status: " + status);
      }
      await cdb.execute({ sql: "UPDATE tracker_items SET status=?, updated_at=datetime('now') WHERE id=?", args: [status, itemId] });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- create tracker item ----
  router.post(P + "/tracker-item", async (req, res) => {
    const b = req.body || {};
    const slug = String(b.tracker_slug || "");
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (!slug || !label) return jsonError(res, 400, "tracker_slug and label are required");
    let cdb;
    try {
      cdb = createDbClient();
      const def = (await cdb.execute({ sql: "SELECT id, status_values FROM tracker_defs WHERE slug=?", args: [slug] })).rows[0];
      if (!def) return jsonError(res, 404, "tracker not found: " + slug);
      const status = b.status ? String(b.status) : JSON.parse(def.status_values || "[]")[0] || "pending";
      const allowed = JSON.parse(def.status_values || "[]");
      if (!allowed.includes(status)) return jsonError(res, 400, "invalid status: " + status);
      const priority = b.priority != null ? Number(b.priority) : 3;
      const dataJson = b.data && typeof b.data === "object" ? JSON.stringify(b.data) : "{}";
      const r = await cdb.execute({
        sql: `INSERT INTO tracker_items (tracker_id, bot_id, status, priority, label, data_json, action_needed)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [def.id, b.bot_id || null, status, priority, label, dataJson, b.action_needed || null],
      });
      return res.json({ ok: true, id: Number(r.lastInsertRowid) });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  router.post(P + "/tracker-item/:id/force-clear-lease", async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return jsonError(res, 400, "bad id");
    let cdb;
    try {
      cdb = createDbClient();
      const cur = (await cdb.execute({ sql: "SELECT processing_lease_status FROM tracker_items WHERE id=?", args: [itemId] })).rows[0];
      if (!cur) return jsonError(res, 404, "item not found");
      if (!trackerItemLocked(cur)) return res.json({ ok: true, message: "already unlocked" });
      await cdb.execute({
        sql: "UPDATE tracker_items SET processing_lease=NULL, processing_lease_status=NULL, updated_at=datetime('now') WHERE id=?",
        args: [itemId],
      });
      return res.json({ ok: true });
    } catch (e) {
      return jsonError(res, 500, String(e.message || e));
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
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
