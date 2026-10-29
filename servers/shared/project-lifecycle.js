// Project lifecycle: archive, restore, the archived-allowing owner check, and the permanent delete.
//
// Two markers mean two things. `status='archived'` is the user's lifecycle state (this file).
// `archived_at` has only ever meant "deleted"; archive and restore NEVER write it, because the
// bot runtime treats archived_at as gone. See docs/guide/projects.md.

import { appendAudit } from "./project-acl.js";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createDbClient, auditLog, resolveDataDir } from "../db.js";
import { disconnectProjectConnections } from "./service-connections.js";
import { CROW_VOICE_BOT_ID } from "./voice-bot.js";
import { resolveSqlitePath, tasksDbPath as defaultTasksDbPath } from "../../scripts/pi-bots/instance-paths.mjs";

const ACTORS = ["local", "contact", "bot", "system"];

/**
 * canManageProject's rule (live row, local owner member, not revoked, role owner), except that
 * status='archived' is allowed. archived_at set and learner_profile rows are always false.
 */
export async function canOwnProject(db, projectId) {
  if (projectId == null || !Number.isFinite(Number(projectId))) return false;
  try {
    const { rows } = await db.execute({
      sql: `SELECT m.role FROM project_spaces ps
              JOIN project_members m ON m.project_id = ps.id AND m.contact_id IS NULL AND m.revoked_at IS NULL
             WHERE ps.id = ? AND ps.archived_at IS NULL AND (ps.type IS NULL OR ps.type != 'learner_profile')
             LIMIT 1`,
      args: [Number(projectId)],
    });
    return !!rows[0] && rows[0].role === "owner";
  } catch (err) {
    console.warn("[project-lifecycle] canOwnProject lookup failed:", err.message);
    return false;
  }
}

async function statusOf(db, projectId) {
  const { rows } = await db.execute({ sql: "SELECT status FROM project_spaces WHERE id = ?", args: [Number(projectId)] });
  return rows[0] ? rows[0].status : null;
}

/** Archive: status only. Returns { ok } or { ok:false, code: 'not_owner' | 'already_archived' }. */
export async function archiveProject(db, projectId, { actor = "local" } = {}) {
  if (!ACTORS.includes(actor)) return { ok: false, code: "bad_actor" };
  if (!(await canOwnProject(db, projectId))) return { ok: false, code: "not_owner" };
  if ((await statusOf(db, projectId)) === "archived") return { ok: false, code: "already_archived" };
  const r = await db.execute({
    sql: "UPDATE project_spaces SET status = 'archived', updated_at = datetime('now') WHERE id = ? AND status != 'archived'",
    args: [Number(projectId)],
  });
  if (!r.rowsAffected) return { ok: false, code: "already_archived" };
  await appendAudit(db, { project_id: Number(projectId), actor_type: actor, action: "project.archive" });
  return { ok: true };
}

/** Restore: status back to 'active'. Returns { ok } or { ok:false, code: 'not_owner' | 'not_archived' }. */
export async function restoreProject(db, projectId, { actor = "local" } = {}) {
  if (!ACTORS.includes(actor)) return { ok: false, code: "bad_actor" };
  if (!(await canOwnProject(db, projectId))) return { ok: false, code: "not_owner" };
  if ((await statusOf(db, projectId)) !== "archived") return { ok: false, code: "not_archived" };
  const r = await db.execute({
    sql: "UPDATE project_spaces SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'archived'",
    args: [Number(projectId)],
  });
  if (!r.rowsAffected) return { ok: false, code: "not_archived" };
  await appendAudit(db, { project_id: Number(projectId), actor_type: actor, action: "project.restore" });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Permanent delete (spec §15.2): purge the contents, keep a hidden tombstone row.
//
// The project_spaces row is NEVER deleted (its id is not AUTOINCREMENT and a dozen references
// have no FK, so a reused id would inherit them; project_audit_log cascades with the row). The
// delete empties the project and then turns the row into a tombstone (archived_at = now, the
// "deleted" marker). Nothing here unlinks a tasks store, deletes a directory, or follows a link:
// the workspace is renamed in place, which moves any symlinks inside it as links.
// ---------------------------------------------------------------------------------------------

// The absent-table pattern (project-home/data.js): a bundle-owned table may not exist here.
const ABSENT_RE = /no such (table|column)/i;
const isAbsent = (err) => ABSENT_RE.test(String(err && err.message));

/** Run a read that may name an absent table/column; absent reads as `fallback`. */
async function tolerant(fn, fallback) {
  try { return await fn(); } catch (err) { if (isAbsent(err)) return fallback; throw err; }
}

const num = (v) => Number(v || 0);

/** The data dir the project's workspace was built under (project-spaces.js's own anchor). */
function projectsDataDir(dataDir) {
  if (dataDir) return resolve(dataDir);
  return process.env.CROW_DB_PATH ? resolve(process.env.CROW_DB_PATH, "..") : resolveDataDir();
}

const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The store holding a project's cards: `tasks_db_uri` when set, else the instance-global
 * tasks.db. `global` is true when that store IS the global file (compared through realpath),
 * in which case cards are filtered by project_id like any shared-store project.
 */
export function resolveCardsStore(project, { tasksDbPath } = {}) {
  const globalPath = resolve(tasksDbPath || defaultTasksDbPath());
  const uri = project && project.tasks_db_uri;
  if (!uri) return { path: globalPath, global: true, globalPath };
  const p = resolveSqlitePath(String(uri));
  if (typeof p !== "string" || !p || p === ":memory:") return { path: null, global: false, globalPath };
  const path = resolve(p);
  return { path, global: realOr(path) === realOr(globalPath), globalPath };
}

/** Open an EXISTING sqlite file (never creates one), or null when it is absent. */
function openExisting(path) {
  if (!path || !existsSync(path)) return null;
  return createDbClient(path);
}

async function tableExists(tdb, name) {
  const { rows } = await tdb.execute({ sql: "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", args: [name] });
  return rows.length > 0;
}

async function loadProject(db, projectId) {
  const { rows } = await db.execute({
    sql: "SELECT id, uuid, slug, name, workspace_dir, tasks_db_uri FROM project_spaces WHERE id = ?",
    args: [Number(projectId)],
  });
  return rows[0] || null;
}

async function countCards(project, opts) {
  const store = resolveCardsStore(project, opts);
  const tdb = openExisting(store.path);
  if (!tdb) return 0;
  try {
    return await tolerant(async () => num((await tdb.execute({
      sql: "SELECT COUNT(*) AS n FROM tasks_items WHERE project_id = ?", args: [Number(project.id)],
    })).rows[0].n), 0);
  } finally { tdb.close(); }
}

async function countOf(db, sql, args) {
  return tolerant(async () => num((await db.execute({ sql, args })).rows[0].n), 0);
}

function workspaceExists(dir) {
  if (!dir) return false;
  try { lstatSync(dir); return true; } catch { return false; }
}

/** Who still shares it: non-revoked contact member rows and sent project shares. */
async function sharedBlock(db, id) {
  const members = await tolerant(async () => (await db.execute({
    sql: `SELECT COALESCE(c.display_name, c.crow_id, 'contact ' || m.contact_id) AS name
            FROM project_members m LEFT JOIN contacts c ON c.id = m.contact_id
           WHERE m.project_id = ? AND m.contact_id IS NOT NULL AND m.revoked_at IS NULL ORDER BY m.id`,
    args: [id],
  })).rows.map((r) => String(r.name)), []);
  const shares = await countOf(db,
    "SELECT COUNT(*) AS n FROM shared_items WHERE share_type = 'project' AND direction = 'sent' AND item_id = ?", [id]);
  return members.length || shares ? { code: "shared", detail: { members, shares } } : null;
}

/** Bots on it (the voice bot never has a project, and is excluded anyway). */
async function botsBlock(db, id) {
  const bots = await tolerant(async () => (await db.execute({
    sql: "SELECT display_name, bot_id FROM pi_bot_defs WHERE project_id = ? AND bot_id != ? ORDER BY display_name",
    args: [id, CROW_VOICE_BOT_ID],
  })).rows.map((r) => String(r.display_name || r.bot_id)), []);
  return bots.length ? { code: "bots", detail: { bots } } : null;
}

async function everCloneShared(db, id) {
  const members = await countOf(db,
    "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND contact_id IS NOT NULL AND mode = 'clone'", [id]);
  const sends = await countOf(db,
    "SELECT COUNT(*) AS n FROM project_audit_log WHERE project_id = ? AND action = 'share.send'", [id]);
  return members + sends > 0;
}

async function summaryCounts(db, project, opts) {
  const id = Number(project.id);
  const one = (sql) => countOf(db, sql, [id]);
  const botSessions = await one("SELECT COUNT(*) AS n FROM bot_sessions WHERE project_id = ?");
  const shellItems = await one("SELECT COUNT(*) AS n FROM shell_items WHERE project_id = ?");
  return {
    cards: await countCards(project, opts),
    files: await one("SELECT COUNT(*) AS n FROM storage_files WHERE project_id = ?"),
    notes: await one("SELECT COUNT(*) AS n FROM research_notes WHERE project_id = ?"),
    sources: await one("SELECT COUNT(*) AS n FROM research_sources WHERE project_id = ?"),
    sessions: botSessions + shellItems,
    connections: await one("SELECT COUNT(*) AS n FROM service_connections WHERE project_id = ?"),
    backends: await one("SELECT COUNT(*) AS n FROM data_backends WHERE project_id = ?"),
    workspace: workspaceExists(project.workspace_dir),
    everCloneShared: await everCloneShared(db, id),
  };
}

/**
 * What a delete would remove, and whether it is refused. Read-only: it never opens a missing
 * tasks store (no file is created) and writes nothing.
 * @returns {Promise<{ blocked: null | { code: 'not_owner'|'shared'|'bots', detail: object|null },
 *   counts: null | { cards, files, notes, sources, sessions, connections, backends, workspace, everCloneShared } }>}
 *   counts is null for not_owner (a visited or missing project is never described).
 *   `crowHome` is accepted for the callers' signature; every path comes from the instance anchor
 *   (instance-paths.mjs tasksDbPath, project-spaces.js's data dir), or `tasksDbPath` in tests.
 */
export async function deleteSummary(db, projectId, { crowHome, tasksDbPath } = {}) {
  if (!(await canOwnProject(db, projectId))) return { blocked: { code: "not_owner", detail: null }, counts: null };
  const project = await loadProject(db, projectId);
  if (!project) return { blocked: { code: "not_owner", detail: null }, counts: null };
  const id = Number(project.id);
  const blocked = (await sharedBlock(db, id)) || (await botsBlock(db, id));
  return { blocked, counts: await summaryCounts(db, project, { tasksDbPath }) };
}

async function defaultDisconnectBackend(backendId) {
  const m = await import("../gateway/proxy.js");
  return m.disconnectDynamicBackend(backendId);
}

/** The storage server's per-file delete (crow_delete_file): the object, then its row. */
function defaultStorageDeleteFor(db) {
  return async (row) => {
    const { deleteObject } = await import("../storage/s3-client.js");
    await deleteObject(row.s3_key, row.bucket || "crow-files");
    await db.execute({ sql: "DELETE FROM storage_files WHERE id = ?", args: [row.id] });
  };
}

/** Run one write inside the transaction; an absent table/column is skipped, anything else throws. */
async function txWrite(db, sql, args) {
  try { return await db.execute({ sql, args }); } catch (err) { if (isAbsent(err)) return { rowsAffected: 0, skipped: true }; throw err; }
}

/** The refusals (owner, shared, bots) as they stand now, or null. Synchronous DB reads only. */
async function currentBlock(db, id) {
  if (!(await canOwnProject(db, id))) return { code: "not_owner", detail: null };
  return (await sharedBlock(db, id)) || (await botsBlock(db, id));
}

/** A refusal found inside the transaction: rolls it back, and deleteProject returns its code. */
class DeleteRefused extends Error {
  constructor(code, detail = null) { super(`delete refused: ${code}`); this.code = code; this.detail = detail; }
}

/** The first free tombstone slug: <slug>-deleted-<id>, then -2, -3, ... */
async function tombstoneSlug(db, slug, id) {
  const base = `${slug}-deleted-${id}`;
  for (let n = 1; ; n++) {
    const cand = n === 1 ? base : `${base}-${n}`;
    const { rows } = await db.execute({ sql: "SELECT 1 AS x FROM project_spaces WHERE slug = ? AND id != ?", args: [cand, id] });
    if (!rows.length) return cand;
  }
}

/**
 * The crow.db purge + tombstone, in ONE BEGIN IMMEDIATE ... COMMIT. Synchronous DB work only.
 * Notes, context and memories are deleted or unfiled LOCALLY ONLY and nothing is emitted (spec §15
 * amendment): a note delete keys on a per-instance id and a context delete on the raw local
 * project id, so on a peer either would hit UNRELATED rows; a memory update with a NULL project
 * carries nothing once the transform strips it. The refusals are re-checked first, inside the
 * transaction, so a member or bot added since the summary refuses with nothing changed.
 * @returns {Promise<{ contextChanged: boolean }>}
 */
async function purgeCrowDb(db, project, { actor, counts, beforeTombstone }) {
  const id = Number(project.id);
  await db.execute("BEGIN IMMEDIATE");
  let contextChanged = false;
  try {
    const block = await currentBlock(db, id);
    if (block) throw new DeleteRefused(block.code, block.detail);

    await txWrite(db, "DELETE FROM service_connections WHERE project_id = ?", [id]);
    await txWrite(db, "DELETE FROM data_backends WHERE project_id = ?", [id]);
    await txWrite(db, "DELETE FROM research_notes WHERE project_id = ?", [id]);
    await txWrite(db, "DELETE FROM research_sources WHERE project_id = ?", [id]);
    const ctx = await txWrite(db, "DELETE FROM crow_context WHERE project_id = ?", [id]);
    contextChanged = Number(ctx.rowsAffected || 0) > 0;

    // Memories are the user's: unfiled, never deleted.
    const mem = await txWrite(db,
      "UPDATE memories SET project_id = NULL, project_uuid = NULL, updated_at = datetime('now') WHERE project_id = ? OR (project_uuid IS NOT NULL AND project_uuid = ?)",
      [id, project.uuid]);
    if (mem.skipped) { // pre-0020 memories table: no project_uuid
      await txWrite(db, "UPDATE memories SET project_id = NULL, updated_at = datetime('now') WHERE project_id = ?", [id]);
    }

    // Filings go to Unassigned; the card a filing named is being deleted, so its card_id goes too.
    await txWrite(db, "UPDATE shell_items SET project_id = NULL, card_id = NULL, updated_at = datetime('now') WHERE project_id = ?", [id]);
    // card_offers.status is pending|accepted|declined: a pending offer is cancelled as declined.
    await txWrite(db, "UPDATE card_offers SET status = 'declined', decided_at = datetime('now') WHERE project_id = ? AND status = 'pending'", [id]);
    await txWrite(db, "UPDATE bot_sessions SET project_id = NULL WHERE project_id = ?", [id]);

    await appendAudit(db, { project_id: id, actor_type: actor, action: "project.delete", payload: counts });

    if (beforeTombstone) await beforeTombstone();

    const slug = await tombstoneSlug(db, project.slug, id);
    const tombSql = (withRepo) => `UPDATE project_spaces
         SET archived_at = datetime('now'), status = 'archived', slug = ?,
             description = NULL${withRepo ? ", repo_path = NULL" : ""}, updated_at = datetime('now')
       WHERE id = ? AND archived_at IS NULL`;
    let r;
    try { r = await db.execute({ sql: tombSql(true), args: [slug, id] }); }
    catch (err) { if (!/no such column: repo_path/i.test(String(err && err.message))) throw err; r = await db.execute({ sql: tombSql(false), args: [slug, id] }); }
    if (!r.rowsAffected) throw new Error("tombstone write matched no live row");
    await db.execute("COMMIT");
  } catch (err) {
    try { await db.execute("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
  return { contextChanged };
}

/** Cards and their records in the resolved store; board_defs in the global store. Never unlinks a file. */
async function purgeCards(project, { tasksDbPath }, partial) {
  const id = Number(project.id);
  const store = resolveCardsStore(project, { tasksDbPath });
  const deleted = { cards: 0, ids: [], global: store.global };
  if (store.path) {
    let tdb;
    try {
      tdb = openExisting(store.path);
      if (tdb && (await tableExists(tdb, "tasks_items"))) {
        const ids = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE project_id = ?", args: [id] })).rows.map((r) => Number(r.id));
        // Card records live in the SAME file as the cards they key (card ids are per store), so a
        // per-project store's ids never touch the global store's plans/results/mutations.
        const stmts = [];
        const idsJson = JSON.stringify(ids);
        for (const t of ["board_plans", "board_results", "board_mutations"]) {
          if (ids.length && (await tableExists(tdb, t))) {
            stmts.push({ sql: `DELETE FROM ${t} WHERE item_id IN (SELECT value FROM json_each(?))`, args: [idsJson] });
          }
        }
        stmts.push({ sql: "DELETE FROM tasks_items WHERE project_id = ?", args: [id] });
        if (store.global && (await tableExists(tdb, "board_defs"))) {
          stmts.push({ sql: "DELETE FROM board_defs WHERE project_id = ?", args: [id] });
        }
        await tdb.batch(stmts);
        deleted.cards = ids.length;
        deleted.ids = ids;
      }
    } catch (err) {
      console.warn(`[project-lifecycle] delete ${id}: cards purge failed:`, err?.message || err);
      partial.push("cards");
    } finally { if (tdb) tdb.close(); }
  }
  if (!store.global) {
    let gdb;
    try {
      gdb = openExisting(store.globalPath);
      if (gdb && (await tableExists(gdb, "board_defs"))) {
        await gdb.execute({ sql: "DELETE FROM board_defs WHERE project_id = ?", args: [id] });
      }
    } catch (err) {
      console.warn(`[project-lifecycle] delete ${id}: board_defs purge failed:`, err?.message || err);
      partial.push("board_defs");
    } finally { if (gdb) gdb.close(); }
  }
  return deleted;
}

/**
 * Queued bot_jobs for the deleted cards never run. bot_jobs lives in crow.db and its card_id names
 * an instance-global card (dispatch only addresses global cards), so this runs only when the cards
 * came from the global store: a per-project store's ids are another id space. bot_jobs.status is
 * queued|running|completed|failed with no cancelled state, so a cancel is the force-unlock's
 * terminal write (bot-board-api.js): status='failed' with a reason, guarded on 'queued' so a job a
 * runner just claimed is left alone. Never a DELETE.
 */
async function cancelCardJobs(db, id, cards, partial) {
  if (!cards.global || !cards.ids.length) return;
  try {
    await txWrite(db, `UPDATE bot_jobs SET status = 'failed', error = 'cancelled: its project was deleted', ended_at = datetime('now')
                        WHERE status = 'queued' AND card_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(cards.ids)]);
  } catch (err) {
    console.warn(`[project-lifecycle] delete ${id}: cancelling card jobs failed:`, err?.message || err);
    partial.push("jobs");
  }
}

async function purgeFiles(db, id, storageDelete, partial) {
  let rows = [];
  try { rows = (await db.execute({ sql: "SELECT * FROM storage_files WHERE project_id = ? ORDER BY id", args: [id] })).rows; }
  catch (err) { if (!isAbsent(err)) { console.warn(`[project-lifecycle] delete ${id}: storage list failed:`, err.message); partial.push("files"); } return; }
  let failed = 0;
  for (const row of rows) {
    try { await storageDelete(row); }
    catch (err) { failed++; console.warn(`[project-lifecycle] delete ${id}: storage delete of ${row.s3_key} failed:`, err?.message || err); }
  }
  if (failed) partial.push("files");
}

const yyyymmdd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

/**
 * Rename the workspace to <dataDir>/deleted-projects/<uuid>-<YYYYMMDD>/. renameSync moves the
 * directory entry itself: links inside (and the dir, if it is itself a link) move as links and
 * nothing is followed. Only <dataDir>/projects/<slug>/workspace is moved. @returns {string|false} the new path, or false
 */
function moveWorkspace(project, dataDir, now, partial) {
  const ws = project.workspace_dir;
  if (!workspaceExists(ws)) return false;
  const root = join(dataDir, "projects");
  // Only the project's own folder, <dataDir>/projects/<slug>/workspace (the slug from before the tombstone).
  if (relative(root, resolve(ws)) !== join(String(project.slug), "workspace")) {
    console.warn(`[project-lifecycle] delete ${project.id}: workspace ${ws} is not ${root}/${project.slug}/workspace; left in place`);
    partial.push("workspace");
    return false;
  }
  try {
    const parent = join(dataDir, "deleted-projects");
    mkdirSync(parent, { recursive: true });
    const base = join(parent, `${project.uuid}-${yyyymmdd(now)}`);
    let dest = base;
    for (let n = 2; workspaceExists(dest); n++) dest = `${base}-${n}`;
    renameSync(ws, dest);
    return dest;
  } catch (err) {
    console.warn(`[project-lifecycle] delete ${project.id}: workspace rename failed:`, err?.message || err);
    partial.push("workspace");
    return false;
  }
}

/**
 * Permanently delete a project (spec §15.2). Refusals change nothing.
 * @param {object} opts
 * @param {string} opts.confirmName  must equal the project's name after trim()
 * @param {string} [opts.actor='local']  local|contact|bot|system
 * @param {(fileRow:object)=>Promise<void>} [opts.storageDelete]  per-file delete (object + row)
 * @param {(backendId:number)=>any} [opts.disconnectBackend]  closes a running data backend
 * @param {string} [opts.dataDir]  defaults to project-spaces.js's anchor
 * @param {string} [opts.tasksDbPath]  the instance-global tasks.db (instance-paths.mjs by default)
 * @param {string} [opts.crowHome]  accepted, unused (see deleteSummary)
 * @param {Function} [opts._afterSummary]  test seam: runs after the summary, before the pre-disconnect re-check
 * @param {Function} [opts._beforeTransaction]  test seam: runs after the pre-transaction steps, before BEGIN
 * @param {Function} [opts._beforeTombstone]  test seam: runs inside the transaction, before the tombstone
 * @returns {Promise<{ ok: true, counts: object, movedTo?: string, partial?: string[] } |
 *   { ok: false, code: 'bad_actor'|'not_owner'|'shared'|'bots'|'name_mismatch'|'failed', detail?: object }>}
 *   A refusal found inside the transaction carries detail.disconnected: the connections already disconnected.
 */
export async function deleteProject(db, projectId, {
  confirmName, crowHome, actor = "local", storageDelete, disconnectBackend = defaultDisconnectBackend,
  dataDir, tasksDbPath, now = () => new Date(), _afterSummary, _beforeTransaction, _beforeTombstone,
} = {}) {
  if (!ACTORS.includes(actor)) return { ok: false, code: "bad_actor" };
  const summary = await deleteSummary(db, projectId, { tasksDbPath });
  if (summary.blocked) return { ok: false, code: summary.blocked.code, ...(summary.blocked.detail ? { detail: summary.blocked.detail } : {}) };
  const project = await loadProject(db, projectId);
  if (typeof confirmName !== "string" || confirmName.trim() !== String(project.name)) return { ok: false, code: "name_mismatch" };
  const id = Number(project.id);
  const counts = summary.counts;

  if (_afterSummary) await _afterSummary();
  // The refusals again, right before the first write (the disconnects), so a member or bot added
  // since the summary refuses with nothing changed. They run once more inside the transaction.
  const late = await currentBlock(db, id);
  if (late) return { ok: false, code: late.code, ...(late.detail ? { detail: late.detail } : {}) };

  // Pre-transaction: keychain secrets masked (one service.disconnect audit each), running backends closed.
  let disconnected = 0;
  try {
    ({ disconnected } = await disconnectProjectConnections(db, id, { actor }));
  } catch (err) {
    console.warn(`[project-lifecycle] delete ${id}: disconnecting connections failed:`, err?.message || err);
    return { ok: false, code: "failed" };
  }
  const backendIds = await tolerant(async () => (await db.execute({
    sql: "SELECT id FROM data_backends WHERE project_id = ?", args: [id],
  })).rows.map((r) => Number(r.id)), []);
  for (const b of backendIds) {
    try { await disconnectBackend(b); } catch (err) { console.warn(`[project-lifecycle] delete ${id}: backend ${b} disconnect failed:`, err?.message || err); }
  }

  if (_beforeTransaction) await _beforeTransaction();

  let purged;
  try {
    purged = await purgeCrowDb(db, project, { actor, counts, beforeTombstone: _beforeTombstone });
  } catch (err) {
    // A refusal this late comes after the disconnects: say how many connections were disconnected.
    if (err instanceof DeleteRefused) return { ok: false, code: err.code, detail: { ...(err.detail || {}), disconnected } };
    console.warn(`[project-lifecycle] delete ${id}: crow.db purge rolled back:`, err?.message || err);
    return { ok: false, code: "failed" };
  }

  // After the commit: best effort. The tombstone already hides the project and its id is never
  // reused, so anything left behind is inert.
  const partial = [];
  if (purged.contextChanged) {
    try { (await import("../memory/crow-context.js")).invalidateContextCache(); } catch { /* cache is per-process */ }
  }
  const cards = await purgeCards(project, { tasksDbPath }, partial);
  await cancelCardJobs(db, id, cards, partial);
  await purgeFiles(db, id, storageDelete || defaultStorageDeleteFor(db), partial);
  const movedTo = moveWorkspace(project, projectsDataDir(dataDir), now(), partial);
  const workspaceMoved = !!movedTo;
  const result = { ...counts, workspaceMoved };
  await auditLog(db, "project.delete", {
    actor,
    details: { project_id: id, uuid: project.uuid, slug: project.slug, name: project.name, counts: result, ...(partial.length ? { partial } : {}) },
  });
  return { ok: true, counts: result, ...(movedTo ? { movedTo } : {}), ...(partial.length ? { partial } : {}) };
}

/** Where deleted workspaces are moved to: <dataDir>/deleted-projects (for showing the new path). */
export function deletedProjectsDir(dataDir) {
  return join(projectsDataDir(dataDir), "deleted-projects");
}
