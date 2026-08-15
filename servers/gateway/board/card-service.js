/**
 * Card / tracker-item service — THE single writer for board mutations
 * (Track 1, Task 2). Pure service: no Express, no route wiring. Every
 * exported signature here is a CONTRACT — later Track 1 tasks (routes,
 * autonomy gating, plans/results) call these functions verbatim.
 *
 * Two kinds share one table (`tasks_items`), split by a single predicate
 * (D-T1.2): a CARD is `board_id IS NULL`, an ITEM is `board_id IS NOT NULL`.
 * Every lookup here filters on that predicate explicitly — nothing reads by
 * bare id, because a bare-id SELECT would silently cross the kinds and let a
 * tracker item answer a card lookup (or vice versa).
 *
 * Errors are thrown as `Object.assign(new Error(msg), { code, http })` so
 * route callers can map them directly to a response: archived/locked→409,
 * bad_status/bad_parent→400, not_found→404.
 *
 * Every mutation (create/update/move/archive/unarchive) records a
 * `board_mutations` row via recordMutation — a verb, the reporting actor
 * (kind/id/jobId), and a `{field: [old, new]}` diff of only the columns
 * that actually changed (D-T1.8 provenance). Tracker items use the SAME
 * verb vocabulary as cards (controller ruling on plan-review Q1) — this is
 * ONE mechanism for both kinds (D-T1.6), not two parallel ones.
 *
 * Callers own db handles: `tdb` is tasks.db (createDbClient(TASKS_DB)),
 * `cdb` is crow.db (createDbClient()) — passed in wherever the lock rails
 * (bot_jobs/bot_sessions, both crow.db) need to be checked. This service
 * never resolves a path itself.
 */

import { resolveBoardDef, resolveSlugBoardDef, isValidStatus, isTerminal } from "../routes/board-defs.js";
import { lockState } from "../routes/board-lock.js";

function fail(msg, code, http) {
  return Object.assign(new Error(msg), { code, http });
}

// Track 1 review fix wave (Finding 3): the ONLY two valid autonomy values.
// Both createCard and updateCard were previously trusting the caller (routes
// already validated at the HTTP boundary, but the service itself — the one
// place every caller, present and future, funnels through — did not; an
// invalid value from createCard silently coerced to 'gated' instead of
// erroring). Validated here so the contract holds regardless of caller.
const AUTONOMY_VALUES = new Set(["gated", "auto"]);

// A JS-side timestamp in the same shape as SQLite's `datetime('now')`
// (UTC "YYYY-MM-DD HH:MM:SS"). Used wherever a stamped column also needs to
// appear in a mutation's diff — going through a placeholder lets the diff
// record the EXACT value written, instead of a second read-back after the
// SQL-side `datetime('now')` literal.
function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** INSERT one board_mutations row. `detail` is stored as detail_json. */
export function recordMutation(tdb, { itemId, verb, actor, detail }) {
  const a = actor || {};
  return tdb.execute({
    sql: "INSERT INTO board_mutations (item_id, verb, actor_kind, actor_id, job_id, detail_json) VALUES (?,?,?,?,?,?)",
    args: [itemId, verb, a.kind || "human", a.id ?? null, a.jobId ?? null, JSON.stringify(detail || {})],
  });
}

// ---- reads ----

export async function getCard(tdb, id) {
  if (!Number.isInteger(id)) return null;
  const r = (await tdb.execute({
    sql: "SELECT * FROM tasks_items WHERE id=? AND board_id IS NULL",
    args: [id],
  })).rows[0];
  return r || null;
}

export async function getItem(tdb, id) {
  if (!Number.isInteger(id)) return null;
  const r = (await tdb.execute({
    sql: "SELECT * FROM tasks_items WHERE id=? AND board_id IS NOT NULL",
    args: [id],
  })).rows[0];
  return r || null;
}

/** item.board_id → board_defs row → slug → the resolved slug-board def, or null. */
async function resolveItemDef(tdb, boardId) {
  if (boardId == null) return null;
  const row = (await tdb.execute({
    sql: "SELECT slug FROM board_defs WHERE id=?",
    args: [boardId],
  })).rows[0];
  if (!row || !row.slug) return null;
  return resolveSlugBoardDef(tdb, row.slug);
}

// ---- lock exemption (moveCard's {lockExempt} option) ----

// board-lock.js's sessionRowFor SELECT carries bot_id (Task 3), so the
// session-rail branch below is reachable: it matches when the reporting
// actor's id is the same bot that owns the live session (D-T1.5's
// result↔lock contract, exercised by result-service.js's reportResult).
function lockExemptMatches(lock, lockExempt) {
  if (!lockExempt || !lock || !lock.row) return false;
  if (lock.rail === "job") return String(lock.row.job_id) === String(lockExempt.jobId);
  if (lock.rail === "session") {
    return lock.row.bot_id != null && String(lock.row.bot_id) === String(lockExempt.id);
  }
  return false;
}

// ---- card side ----

export async function createCard(tdb, fields, actor) {
  const f = fields || {};
  let projectId = f.project_id == null ? null : Number(f.project_id);
  let parentId = f.parent_id == null ? null : Number(f.parent_id);

  if (parentId != null) {
    const parent = await getCard(tdb, parentId);
    if (!parent) throw fail(`parent card not found: ${parentId}`, "bad_parent", 400);
    projectId = parent.project_id == null ? null : Number(parent.project_id);
  }

  const def = await resolveBoardDef(tdb, { projectId });
  const status = f.status != null ? String(f.status) : def.status_values[0];
  if (!isValidStatus(def, status)) throw fail(`invalid status: ${status}`, "bad_status", 400);

  let autonomy = "gated";
  if (f.autonomy != null) {
    autonomy = String(f.autonomy);
    if (!AUTONOMY_VALUES.has(autonomy)) throw fail(`invalid autonomy: ${autonomy}`, "bad_autonomy", 400);
  }
  const r = await tdb.execute({
    sql: `INSERT INTO tasks_items
            (title, description, status, priority, due_date, phase, owner, tags, project_id, parent_id, autonomy)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      String(f.title ?? ""),
      f.description == null ? null : String(f.description),
      status,
      f.priority != null ? Number(f.priority) : 3,
      f.due_date == null || f.due_date === "" ? null : String(f.due_date),
      f.phase == null ? null : String(f.phase),
      f.owner == null ? null : String(f.owner),
      f.tags == null ? null : String(f.tags),
      projectId,
      parentId,
      autonomy,
    ],
  });
  const id = Number(r.lastInsertRowid);
  await recordMutation(tdb, { itemId: id, verb: "create", actor, detail: {} });
  return { id };
}

// Track 1 Task 9: "assigned_bot" joined this list so the dashboard's card-edit
// route (bot-board-api.js POST /card/:id) can converge onto updateCard for
// EVERY field it writes, including bot assignment — the route still does its
// own pi_bot_defs existence/enabled lookup first (that's a crow.db read this
// tasks.db-only service has no business making), but the actual column write
// and its provenance now go through here like everything else.
//
// "project_id" joined this list in the final Track 1 review fix wave (Finding
// 1): the dashboard's POST /card/:id/project and /project/:id/bulk-assign
// routes used to UPDATE tasks_items directly, bypassing recordMutation
// entirely (no provenance for the operation that assigns a card to a
// project). Unlike parent_id's re-inheritance branch below, this is a PLAIN
// set — project-assignment is its own explicit operation, not something that
// follows from another field, so it belongs in the generic key/value loop
// with no special-case logic.
const CARD_UPDATE_FIELDS = ["title", "description", "due_date", "phase", "owner", "tags", "priority", "autonomy", "assigned_bot", "project_id"];

// `allowArchived` (Finding 1 fix wave): bulk-assign's `?include_archived=1`
// escape hatch (Task 5, D-T1.6) is a deliberate operator override that lets
// project-assignment reach an archived card — the ONE write bulk-assign has
// always permitted through archived_at. Converging bulk-assign onto this
// function must not silently drop that override, so it's threaded through as
// an explicit opt-in rather than folded into the default (archived-refusing)
// path every other caller relies on.
export async function updateCard(tdb, id, fields, actor, { allowArchived } = {}) {
  const cur = await getCard(tdb, id);
  if (!cur) throw fail("card not found", "not_found", 404);
  if (cur.archived_at != null && !allowArchived) throw fail("card is archived", "archived", 409);

  const f = fields || {};
  const sets = [], args = [], detail = {};
  for (const key of CARD_UPDATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(f, key)) continue;
    const raw = f[key];
    const norm = key === "priority" || key === "project_id"
      ? (raw == null ? null : Number(raw))
      : (raw == null ? null : String(raw));
    if (key === "autonomy" && norm != null && !AUTONOMY_VALUES.has(norm)) {
      throw fail(`invalid autonomy: ${norm}`, "bad_autonomy", 400);
    }
    const old = key === "project_id" ? (cur[key] == null ? null : Number(cur[key])) : (cur[key] ?? null);
    if (old === norm) continue;
    sets.push(`${key}=?`); args.push(norm);
    detail[key] = [old, norm];
  }

  // parent_id — handled separately from the plain-field loop above: setting a
  // new parent RE-INHERITS that parent's project_id (createCard's own
  // semantics — a consistency ruling, not a bug: a card's project always
  // follows its parent), which the generic key/value loop can't express
  // (it's a two-column write driven by one input field). Explicitly null
  // clears parent_id only, no other side effects. Self-parenting and a
  // nonexistent parent both 400 (bad_parent), same as createCard.
  if (Object.prototype.hasOwnProperty.call(f, "parent_id")) {
    const newParentId = f.parent_id == null ? null : Number(f.parent_id);
    const oldParentId = cur.parent_id ?? null;
    if (newParentId !== oldParentId) {
      let newProjectId = cur.project_id ?? null;
      if (newParentId != null) {
        if (newParentId === id) throw fail("a card cannot be its own parent", "bad_parent", 400);
        const parent = await getCard(tdb, newParentId);
        if (!parent) throw fail(`parent card not found: ${newParentId}`, "bad_parent", 400);
        newProjectId = parent.project_id == null ? null : Number(parent.project_id);
      }
      sets.push("parent_id=?"); args.push(newParentId);
      detail.parent_id = [oldParentId, newParentId];
      const oldProjectId = cur.project_id ?? null;
      if (newProjectId !== oldProjectId) {
        sets.push("project_id=?"); args.push(newProjectId);
        detail.project_id = [oldProjectId, newProjectId];
      }
    }
  }

  if (!sets.length) return { id, changed: false };

  sets.push("updated_at=datetime('now')");
  args.push(id);
  await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=? AND board_id IS NULL`, args });
  await recordMutation(tdb, { itemId: id, verb: "update", actor, detail });
  return { id, changed: true };
}

export async function moveCard(tdb, cdb, id, status, actor, { lockExempt } = {}) {
  const cur = await getCard(tdb, id);
  if (!cur) throw fail("card not found", "not_found", 404);

  if (cur.archived_at != null) throw fail("card is archived", "archived", 409);

  const def = await resolveBoardDef(tdb, { projectId: cur.project_id });
  const ns = String(status);
  if (!isValidStatus(def, ns)) throw fail(`invalid status: ${ns}`, "bad_status", 400);

  const lock = await lockState(cdb, id);
  if (lock.locked && !lockExemptMatches(lock, lockExempt)) {
    throw fail("card is locked", "locked", 409);
  }

  const wasTerminal = isTerminal(def, String(cur.status));
  const nowTerminal = isTerminal(def, ns);
  const sets = ["status=?", "updated_at=datetime('now')"];
  const args = [ns];
  const detail = {};
  if (String(cur.status) !== ns) detail.status = [String(cur.status), ns];
  if (nowTerminal && !wasTerminal) {
    const stamp = nowStamp();
    sets.push("completed_at=?"); args.push(stamp);
    detail.completed_at = [cur.completed_at ?? null, stamp];
  } else if (!nowTerminal && wasTerminal) {
    sets.push("completed_at=NULL");
    detail.completed_at = [cur.completed_at ?? null, null];
  }
  args.push(id);
  await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=? AND board_id IS NULL`, args });
  await recordMutation(tdb, { itemId: id, verb: "move", actor, detail });
}

export async function archiveCard(tdb, cdb, id, actor) {
  const cur = await getCard(tdb, id);
  if (!cur) throw fail("card not found", "not_found", 404);

  const lock = await lockState(cdb, id);
  if (lock.locked) throw fail("card is locked", "locked", 409);
  if (cur.archived_at != null) throw fail("card is already archived", "archived", 409);

  const stamp = nowStamp();
  await tdb.execute({
    sql: "UPDATE tasks_items SET archived_at=?, updated_at=datetime('now') WHERE id=? AND board_id IS NULL",
    args: [stamp, id],
  });
  await recordMutation(tdb, { itemId: id, verb: "archive", actor, detail: { archived_at: [null, stamp] } });
}

export async function unarchiveCard(tdb, id, actor) {
  const cur = await getCard(tdb, id);
  if (!cur) throw fail("card not found", "not_found", 404);

  const old = cur.archived_at ?? null;
  await tdb.execute({
    sql: "UPDATE tasks_items SET archived_at=NULL WHERE id=? AND board_id IS NULL",
    args: [id],
  });
  await recordMutation(tdb, { itemId: id, verb: "unarchive", actor, detail: { archived_at: [old, null] } });
}

// ---- tracker-item side (D-T1.6: one mechanism, same verb vocabulary) ----

export async function moveItem(tdb, id, status, actor) {
  const cur = await getItem(tdb, id);
  if (!cur) throw fail("item not found", "not_found", 404);

  if (cur.archived_at != null) throw fail("item is archived", "archived", 409);

  const def = await resolveItemDef(tdb, cur.board_id);
  const ns = String(status);
  if (!def || !isValidStatus(def, ns)) throw fail(`invalid status: ${ns}`, "bad_status", 400);

  const wasTerminal = isTerminal(def, String(cur.status));
  const nowTerminal = isTerminal(def, ns);
  const sets = ["status=?", "updated_at=datetime('now')"];
  const args = [ns];
  const detail = {};
  if (String(cur.status) !== ns) detail.status = [String(cur.status), ns];
  if (nowTerminal && !wasTerminal) {
    const stamp = nowStamp();
    sets.push("completed_at=?"); args.push(stamp);
    detail.completed_at = [cur.completed_at ?? null, stamp];
  } else if (!nowTerminal && wasTerminal) {
    sets.push("completed_at=NULL");
    detail.completed_at = [cur.completed_at ?? null, null];
  }
  args.push(id);
  await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=? AND board_id IS NOT NULL`, args });
  await recordMutation(tdb, { itemId: id, verb: "move", actor, detail });
}

const ITEM_PLAIN_FIELDS = ["title", "priority", "action_needed", "next_followup_date"];
// The lease is the item-side lock (no bot_sessions/bot_jobs rail exists for
// tracker items) — these two writes are allowed through even on an archived
// item, mirroring force-clear-lease's precedent in bot-board-api.js.
const ITEM_LEASE_FIELDS = ["processing_lease", "processing_lease_status"];

export async function updateItem(tdb, id, fields, actor) {
  const cur = await getItem(tdb, id);
  if (!cur) throw fail("item not found", "not_found", 404);

  const f = fields || {};
  const isArchived = cur.archived_at != null;
  const sets = [], args = [], detail = {};

  for (const key of ITEM_LEASE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(f, key)) continue;
    const norm = f[key] == null ? null : String(f[key]);
    const old = cur[key] ?? null;
    if (old === norm) continue;
    sets.push(`${key}=?`); args.push(norm);
    detail[key] = [old, norm];
  }

  const nonLeaseKeys = ITEM_PLAIN_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(f, k));
  const wantsData = f.data != null && typeof f.data === "object";
  if (isArchived && (nonLeaseKeys.length || wantsData)) {
    throw fail("item is archived", "archived", 409);
  }

  for (const key of nonLeaseKeys) {
    const raw = f[key];
    const norm = key === "priority" ? (raw == null ? null : Number(raw)) : (raw == null ? null : String(raw));
    const old = cur[key] ?? null;
    if (old === norm) continue;
    sets.push(`${key}=?`); args.push(norm);
    detail[key] = [old, norm];
  }

  if (wantsData) {
    const curJson = cur.data_json || "{}";
    let base;
    try { base = JSON.parse(curJson); } catch { base = {}; }
    const merged = { ...base, ...f.data };
    const newJson = JSON.stringify(merged);
    if (newJson !== curJson) {
      sets.push("data_json=?"); args.push(newJson);
      detail.data_json = [curJson, newJson];
    }
  }

  if (!sets.length) return { id, changed: false };

  sets.push("updated_at=datetime('now')");
  args.push(id);
  await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=? AND board_id IS NOT NULL`, args });
  await recordMutation(tdb, { itemId: id, verb: "update", actor, detail });
  return { id, changed: true };
}

export async function archiveItem(tdb, id, actor) {
  const cur = await getItem(tdb, id);
  if (!cur) throw fail("item not found", "not_found", 404);

  // "an active lease" == the same predicate the rest of the codebase uses
  // for a tracker item currently claimed by a bot (trackerItemLocked in
  // servers/gateway/routes/bot-board-api.js and the dashboard bot-board
  // panel's api-handlers.js): processing_lease_status === 'in-progress'.
  if (String(cur.processing_lease_status) === "in-progress") {
    throw fail("item has an active processing lease", "locked", 409);
  }
  if (cur.archived_at != null) throw fail("item is already archived", "archived", 409);

  const stamp = nowStamp();
  await tdb.execute({
    sql: "UPDATE tasks_items SET archived_at=?, updated_at=datetime('now') WHERE id=? AND board_id IS NOT NULL",
    args: [stamp, id],
  });
  await recordMutation(tdb, { itemId: id, verb: "archive", actor, detail: { archived_at: [null, stamp] } });
}

export async function unarchiveItem(tdb, id, actor) {
  const cur = await getItem(tdb, id);
  if (!cur) throw fail("item not found", "not_found", 404);

  const old = cur.archived_at ?? null;
  await tdb.execute({
    sql: "UPDATE tasks_items SET archived_at=NULL WHERE id=? AND board_id IS NOT NULL",
    args: [id],
  });
  await recordMutation(tdb, { itemId: id, verb: "unarchive", actor, detail: { archived_at: [old, null] } });
}

/**
 * Create a tracker item on a given board_id (Track 1 Task 9 — the single
 * writer for tracker-item creation, converged out of board-mcp.js's
 * createItemImpl and bot-board-api.js's inline POST /tracker-item INSERT,
 * which used to duplicate this exact logic and only ONE of the two recorded
 * a mutation. `resolveItemDef` (above) is reused rather than re-deriving the
 * board→def lookup a third time.
 */
export async function createItem(tdb, boardId, fields, actor) {
  const def = await resolveItemDef(tdb, boardId);
  if (!def) throw fail(`tracker not found for board_id ${boardId}`, "not_found", 404);
  const f = fields || {};
  const status = f.status != null ? String(f.status) : def.status_values[0];
  if (!isValidStatus(def, status)) throw fail(`invalid status: ${status}`, "bad_status", 400);
  const dataJson = f.data && typeof f.data === "object" ? JSON.stringify(f.data) : "{}";
  const r = await tdb.execute({
    sql: `INSERT INTO tasks_items (board_id, bot_id, status, priority, title, data_json, action_needed)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      boardId,
      f.bot_id ?? null,
      status,
      f.priority != null ? Number(f.priority) : 3,
      String(f.title ?? ""),
      dataJson,
      f.action_needed ?? null,
    ],
  });
  const id = Number(r.lastInsertRowid);
  await recordMutation(tdb, { itemId: id, verb: "create", actor, detail: {} });
  return { id };
}
