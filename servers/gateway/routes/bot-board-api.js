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
import { existsSync, readFileSync, writeFileSync, realpathSync, statSync, readdirSync } from "node:fs";
import { createDbClient } from "../../db.js";

const HOME = "/home/kh0pp";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const CARD_STATUSES = new Set(["pending", "in_progress", "done", "cancelled"]);
const PROJECT_STATUSES = new Set(["active", "paused", "completed", "archived"]);
const LOCK_STATUSES = new Set(["active", "waiting-user"]);
const TERMINAL = new Set(["done", "cancelled"]);
const STALE_SECONDS = 1800; // 30 min — force-unlock staleness threshold (D5)
const BULK_CAP = 200;

function jerr(res, code, obj) { return res.status(code).json(obj); }

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
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    let tdb, cdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({
        sql:
          "SELECT id,title,description,status,priority,due_date,owner,tags,parent_id,project_id," +
          "datetime(updated_at) AS updated_at, completed_at FROM tasks_items WHERE id=?",
        args: [id],
      })).rows[0];
      if (!card) return jerr(res, 404, { error: "card not found" });
      cdb = createDbClient();
      let projects = [];
      try {
        projects = (await cdb.execute({ sql: "SELECT id, name FROM research_projects ORDER BY id", args: [] })).rows || [];
      } catch { projects = []; }
      const { locked } = await lockState(cdb, id);
      return res.json({ card, projects, locked });
    } catch (e) {
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- create card ----
  router.post(P + "/card", async (req, res) => {
    const b = req.body || {};
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) return jerr(res, 400, { error: "title is required" }); // BEFORE INSERT
    const projectId = b.project_id == null || b.project_id === "" ? null : Number(b.project_id);
    if (projectId != null && !Number.isInteger(projectId)) return jerr(res, 400, { error: "bad project_id" });
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
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- edit card fields ----
  router.post(P + "/card/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    const b = req.body || {};
    if (b.status != null && !CARD_STATUSES.has(String(b.status))) {
      return jerr(res, 400, { error: "invalid status" }); // BEFORE SQL
    }
    let prio = null, prioSet = false;
    if (b.priority != null && b.priority !== "") {
      prio = Number(b.priority);
      if (!Number.isInteger(prio) || prio < 1 || prio > 5) return jerr(res, 400, { error: "priority must be 1-5" });
      prioSet = true;
    }
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return jerr(res, 409, { reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT status FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jerr(res, 404, { error: "card not found" });
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
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- move card (status) ----
  router.post(P + "/card/:id/move", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    const status = String((req.body || {}).status || "");
    if (!CARD_STATUSES.has(status)) return jerr(res, 400, { error: "invalid status" }); // BEFORE SQL
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return jerr(res, 409, { reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT status FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jerr(res, 404, { error: "card not found" });
      const sets = ["status=?", "updated_at=datetime('now')"];
      if (TERMINAL.has(status) && !TERMINAL.has(String(cur.status))) sets.push("completed_at=datetime('now')");
      else if (!TERMINAL.has(status) && TERMINAL.has(String(cur.status))) sets.push("completed_at=NULL");
      await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=?`, args: [status, id] });
      return res.json({ ok: true });
    } catch (e) {
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- cancel card ----
  router.post(P + "/card/:id/cancel", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return jerr(res, 409, { reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jerr(res, 404, { error: "card not found" });
      await tdb.execute({
        sql: "UPDATE tasks_items SET status='cancelled', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?",
        args: [id],
      });
      return res.json({ ok: true });
    } catch (e) {
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- read plan file ----
  router.get(P + "/card/:id/plan", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    let tdb, cdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT id, project_id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!card) return jerr(res, 404, { error: "card not found" });
      cdb = createDbClient();
      const info = await derivePlanPath(cdb, card);
      if (!info) return res.json({ exists: false, markdown: "", mtime: null, reason: "no bot is linked to this project" });
      const real = containedRealPath(info.path, info.sessionDir);
      if (!real) return jerr(res, 400, { error: "plan path escapes the bot workspace" });
      if (!existsSync(info.path)) return res.json({ exists: false, markdown: "", mtime: null });
      const mtime = String(statSync(info.path).mtimeMs);
      return res.json({ exists: true, markdown: readFileSync(info.path, "utf8"), mtime });
    } catch (e) {
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- save plan file (mtime optimistic-concurrency; lock-checked) ----
  router.post(P + "/card/:id/plan", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    const b = req.body || {};
    if (typeof b.markdown !== "string") return jerr(res, 400, { error: "markdown (string) required" });
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return jerr(res, 409, { reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT id, project_id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!card) return jerr(res, 404, { error: "card not found" });
      const info = await derivePlanPath(cdb, card);
      if (!info) return jerr(res, 400, { error: "no bot is linked to this project — no plan path" });
      const real = containedRealPath(info.path, info.sessionDir);
      if (!real) return jerr(res, 400, { error: "plan path escapes the bot workspace" });
      const exists = existsSync(info.path);
      if (exists) {
        // Optimistic concurrency: the client's mtime (from its GET) must
        // still match. Hard 409 on mismatch — the drawer reloads the newer
        // content (no auto-merge in v1; Phase 5).
        const curMtime = String(statSync(info.path).mtimeMs);
        if (b.mtime != null && String(b.mtime) !== curMtime) {
          return jerr(res, 409, { reason: "plan changed on disk since you opened it", mtime: curMtime });
        }
      }
      writeFileSync(info.path, b.markdown, "utf8");
      const mtime = String(statSync(info.path).mtimeMs);
      return res.json({ ok: true, mtime });
    } catch (e) {
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- assign / clear / reassign a card's project ----
  router.post(P + "/card/:id/project", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    const raw = (req.body || {}).project_id;
    const projectId = raw == null || raw === "" ? null : Number(raw);
    if (projectId != null && !Number.isInteger(projectId)) return jerr(res, 400, { error: "bad project_id" });
    let tdb, cdb;
    try {
      cdb = createDbClient();
      const { locked } = await lockState(cdb, id);
      if (locked) return jerr(res, 409, { reason: "bot is working this card" });
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jerr(res, 404, { error: "card not found" });
      await tdb.execute({
        sql: "UPDATE tasks_items SET project_id=?, updated_at=datetime('now') WHERE id=?",
        args: [projectId, id],
      });
      return res.json({ ok: true });
    } catch (e) {
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- force-unlock (D5 stale-lock recovery; FAIL-CLOSED) ----
  router.post(P + "/card/:id/force-unlock", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    let cdb;
    try {
      cdb = createDbClient();
      const { row } = await lockState(cdb, id);
      if (!row) return jerr(res, 409, { reason: "no bot_sessions row for this card — nothing to unlock" });
      if (!LOCK_STATUSES.has(String(row.status))) {
        return jerr(res, 409, { reason: "card is not locked (latest session is " + String(row.status) + ")" });
      }
      const ageS = Number(row.age_s);
      if (!Number.isFinite(ageS) || ageS < STALE_SECONDS) {
        return jerr(res, 409, { reason: "session is not stale yet (age " + (Number.isFinite(ageS) ? ageS + "s" : "unknown") + "; need ≥ " + STALE_SECONDS + "s)" });
      }
      // FAIL-CLOSED liveness gate (Step-1 pinned pattern).
      const live = piLiveness(row.pi_session_dir);
      if (live !== "dead") {
        return jerr(res, 409, {
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
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- create project ----
  router.post(P + "/project", async (req, res) => {
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return jerr(res, 400, { error: "name is required" }); // BEFORE INSERT
    let cdb;
    try {
      cdb = createDbClient();
      const r = await cdb.execute({
        sql: "INSERT INTO research_projects (name, description) VALUES (?, ?)",
        args: [name, b.description ? String(b.description) : null],
      });
      return res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  // ---- edit project metadata ----
  router.post(P + "/project/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return jerr(res, 400, { error: "bad id" });
    const b = req.body || {};
    if (b.status != null && !PROJECT_STATUSES.has(String(b.status))) {
      return jerr(res, 400, { error: "invalid project status" }); // BEFORE SQL
    }
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (b.name != null && !name) return jerr(res, 400, { error: "name cannot be empty" });
    let cdb;
    try {
      cdb = createDbClient();
      const cur = (await cdb.execute({ sql: "SELECT id FROM research_projects WHERE id=?", args: [id] })).rows[0];
      if (!cur) return jerr(res, 404, { error: "project not found" });
      const sets = [], args = [];
      if (b.name != null) { sets.push("name=?"); args.push(name); }
      if (b.description != null) { sets.push("description=?"); args.push(String(b.description) || null); }
      if (b.status != null) { sets.push("status=?"); args.push(String(b.status)); }
      if (!sets.length) return jerr(res, 400, { error: "nothing to update" });
      sets.push("updated_at=datetime('now')");
      args.push(id);
      await cdb.execute({ sql: `UPDATE research_projects SET ${sets.join(", ")} WHERE id=?`, args });
      return res.json({ ok: true });
    } catch (e) {
      return jerr(res, 500, { error: String(e.message || e) });
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
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
    }
  });

  // ---- bulk-assign cards to a project (atomic; per-card report) ----
  router.post(P + "/project/:id/bulk-assign", async (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) return jerr(res, 400, { error: "bad project id" });
    const ids = Array.isArray((req.body || {}).card_ids)
      ? req.body.card_ids.map(Number).filter((n) => Number.isInteger(n))
      : [];
    if (!ids.length) return jerr(res, 400, { error: "card_ids[] required" });
    if (ids.length > BULK_CAP) return jerr(res, 400, { error: `too many cards (max ${BULK_CAP})` });
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
      return jerr(res, 500, { error: String(e.message || e) });
    } finally {
      if (tdb) { try { tdb.close(); } catch {} }
      if (cdb) { try { cdb.close(); } catch {} }
    }
  });

  return router;
}
