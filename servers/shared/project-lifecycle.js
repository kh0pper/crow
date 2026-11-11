// Project lifecycle: archive, restore, the archived-allowing owner check, and the permanent delete.
//
// Two markers mean two things. `status='archived'` is the user's lifecycle state (this file).
// `archived_at` has only ever meant "deleted"; archive and restore NEVER write it, because the
// bot runtime treats archived_at as gone. See docs/guide/projects.md.

import { AclError, appendAudit } from "./project-acl.js";
import { clearApprovalNonce } from "./data-backend-approval-key.js";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createDbClient, auditLog, resolveDataDir } from "../db.js";
import { disconnectProjectConnections } from "./service-connections.js";
import { CROW_VOICE_BOT_ID } from "./voice-bot.js";
import { resolveSqlitePath, tasksDbPath as defaultTasksDbPath } from "../../scripts/pi-bots/instance-paths.mjs";

const ACTORS = ["local", "contact", "bot", "system"];

/**
 * Erase what a permanent project delete removed from history, at once. The closure
 * and the latest-is-a-delete rule live in servers/shared/history/erase.js; this is
 * only the actor (the delete's own consequence, not an independent history edit).
 */
async function eraseProjectHistory(db, project) {
  const { eraseByProject } = await import("./history/erase.js");
  return eraseByProject(
    db,
    { projectUuid: project.uuid, projectId: project.id },
    { authorKind: "system", authorId: "project-delete" },
  );
}

/**
 * canManageProject's rule (live row, local owner member, not revoked, role owner), except that
 * status='archived' is allowed. archived_at set and learner_profile rows are always false.
 */
export async function canOwnProject(db, projectId) {
  return ownsProject(db, projectId, { allowDeleted: false });
}

/**
 * The SAME owner rule with the tombstone allowed (archived_at NOT NULL). Only finishing a delete
 * that stopped partway uses it: the row it addresses is by definition already deleted, so the
 * ordinary rule could never pass. Everything else keeps using canOwnProject.
 */
export async function canOwnDeletedProject(db, projectId) {
  return ownsProject(db, projectId, { allowDeleted: true });
}

async function ownsProject(db, projectId, { allowDeleted }) {
  if (projectId == null || !Number.isFinite(Number(projectId))) return false;
  try {
    const { rows } = await db.execute({
      sql: `SELECT m.role FROM project_spaces ps
              JOIN project_members m ON m.project_id = ps.id AND m.contact_id IS NULL AND m.revoked_at IS NULL
             WHERE ps.id = ?${allowDeleted ? "" : " AND ps.archived_at IS NULL"} AND (ps.type IS NULL OR ps.type != 'learner_profile')
             LIMIT 1`,
      args: [Number(projectId)],
    });
    return !!rows[0] && rows[0].role === "owner";
  } catch (err) {
    console.warn("[project-lifecycle] owner lookup failed:", err.message);
    return false;
  }
}

/**
 * A status change is allowed only to the project's owner. Archiving is a soft delete (it hides
 * the project), so it takes delete's rule: `canOwnProject`, which already allows an archived
 * row but never a tombstone, a visited/clone-shared project, or a missing one. Throws
 * AclError('not_owner') so every caller answers it the way it answers a refused delete, and
 * callers run it BEFORE the write.
 */
export async function assertCanChangeStatus(db, projectId) {
  if (!(await canOwnProject(db, projectId))) {
    throw new AclError(`Only the owner can change project #${projectId}'s status`, "not_owner");
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
 * @returns {Promise<{ contextChanged: boolean, backendIds: number[] }>}
 */
async function purgeCrowDb(db, project, { actor, counts, beforeTombstone }) {
  const id = Number(project.id);
  await db.execute("BEGIN IMMEDIATE");
  let contextChanged = false;
  let backendIds = [];
  try {
    const block = await currentBlock(db, id);
    if (block) throw new DeleteRefused(block.code, block.detail);

    await txWrite(db, "DELETE FROM service_connections WHERE project_id = ?", [id]);
    // The ids of the rows this transaction deletes, so their approval nonces can be
    // dropped once it commits (a rolled-back delete keeps the rows, and the approvals).
    backendIds = await tolerant(async () => (await db.execute({
      sql: "SELECT id FROM data_backends WHERE project_id = ?", args: [id],
    })).rows.map((r) => Number(r.id)), []);
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
  return { contextChanged, backendIds };
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
 * @param {(db:object, project:object)=>Promise<object>} [opts._eraseHistory]  test seam over the at-once history erase
 * @returns {Promise<{ ok: true, counts: object, movedTo?: string, partial?: string[] } |
 *   { ok: false, code: 'bad_actor'|'not_owner'|'shared'|'bots'|'name_mismatch'|'failed', detail?: object }>}
 *   A refusal found inside the transaction carries detail.disconnected: the connections already disconnected.
 */
export async function deleteProject(db, projectId, {
  confirmName, crowHome, actor = "local", storageDelete, disconnectBackend = defaultDisconnectBackend,
  dataDir, tasksDbPath, now = () => new Date(), _afterSummary, _beforeTransaction, _beforeTombstone,
  _eraseHistory = eraseProjectHistory,
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

  // A permanent project delete erases history AT ONCE, never after a Trash period (the
  // operator's ruling, 2026-11-10: nothing ships until erase works). Scoped to what the purge
  // actually removed: eraseByProject closes over the ITEM but only takes items whose latest
  // version is a delete, so the context sections this purge deleted lose every version while
  // the memories it merely UNFILED keep theirs — they still exist, the user still has them.
  // A failure is a partial step: it is recorded (and re-run by resumeProjectDelete), never
  // silently swallowed, and the tombstone stands either way.
  const partial = [];
  try {
    const erased = await _eraseHistory(db, project);
    if (erased.versions > 0) {
      console.log(`[project-lifecycle] delete ${id}: erased ${erased.versions} version(s) of ${erased.erased.length} item(s)`);
    }
  } catch (err) {
    console.warn(`[project-lifecycle] delete ${id}: history erase failed:`, err?.message || err);
    partial.push("history-erase");
  }

  // A permanent project delete also removes the project's own file history AT ONCE (the
  // operator's ruling): nothing about a deleted project should linger under history/workspaces.
  // EXACTLY the directory the project id derives, never a path read from a column, so a stale
  // repo_path can never make a delete remove another project's history. The data dir is
  // resolved the way creation resolved it (workspace-history's own rule). Archiving keeps it.
  try {
    const { removeWorkspaceHistory } = await import("./history/workspace-history.js");
    if (!removeWorkspaceHistory(id, { dataDir })) {
      console.warn(`[project-lifecycle] delete ${id}: the project's file history could not be removed`);
      partial.push("history-workspace");
    }
  } catch (err) {
    console.warn(`[project-lifecycle] delete ${id}: file history removal failed:`, err?.message || err);
    partial.push("history-workspace");
  }

  // The backends are gone for good, so their approval nonces go too: with one on record, a
  // writer that put a row back with the same id, connection_ref and old value would have that
  // value verify again. The delete stands either way — a record that cannot be written leaves
  // the old nonce behind, and the gateway prunes a stale entry at load.
  for (const backendId of purged.backendIds) {
    try { await clearApprovalNonce(backendId); }
    catch { console.warn(`[project-lifecycle] delete ${id}: backend ${backendId} approval record entry could not be dropped`); }
  }
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

// ---------------------------------------------------------------------------------------------
// Finishing a delete that stopped partway.
//
// Everything after the tombstone commit is best effort, and the tombstone makes the project
// undeletable again (canOwnProject needs a live row), so a step that failed there could never be
// finished. The `project.delete` audit entry in audit_log keeps the ORIGINAL slug and uuid (the
// row's slug is the tombstone's now) and the list of steps that failed. This re-runs exactly
// those steps — each one keys on project_id and is idempotent, and the workspace move is skipped
// when its source is gone — then records what is still left. The tombstone itself is never
// touched, and nothing runs this automatically: the operator asks for it.
// ---------------------------------------------------------------------------------------------

/** The steps a partial delete can list (the ones deleteProject runs after its commit). */
const RESUME_STEPS = Object.freeze(["history-erase", "history-workspace", "cards", "board_defs", "jobs", "files", "workspace"]);

/** What a uuid has to look like to name a folder under deleted-projects (hex digits and dashes). */
const AUDIT_UUID_RE = /^[0-9a-f-]{36}$/i;

/** The newest audit_log row for `id` among `events`, or null. Read-only. */
async function latestAuditOf(db, id, events) {
  const { rows } = await db.execute({
    sql: `SELECT id, event_type, details FROM audit_log
           WHERE event_type IN (${events.map(() => "?").join(",")})
             AND json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END, '$.project_id') = ?
           ORDER BY id DESC LIMIT 1`,
    args: [...events, id],
  });
  const row = rows[0];
  if (!row) return null;
  let details = null;
  try { details = JSON.parse(String(row.details)); } catch { details = null; }
  if (!details || typeof details !== "object") return null;
  return { id: Number(row.id), event: String(row.event_type), details };
}

/** The row as it stands, tombstone included. */
async function loadAnyProject(db, projectId) {
  const { rows } = await db.execute({
    sql: "SELECT id, uuid, slug, name, workspace_dir, tasks_db_uri, archived_at FROM project_spaces WHERE id = ?",
    args: [Number(projectId)],
  });
  return rows[0] || null;
}

/** The project's card ids still in its store (read-only), in the shape cancelCardJobs takes. */
async function cardsLeft(project, { tasksDbPath } = {}) {
  const store = resolveCardsStore(project, { tasksDbPath });
  const tdb = openExisting(store.path);
  if (!tdb) return { ids: [], global: store.global };
  try {
    if (!(await tableExists(tdb, "tasks_items"))) return { ids: [], global: store.global };
    const ids = (await tdb.execute({ sql: "SELECT id FROM tasks_items WHERE project_id = ?", args: [Number(project.id)] }))
      .rows.map((r) => Number(r.id));
    return { ids, global: store.global };
  } catch (err) {
    console.warn(`[project-lifecycle] resume ${project.id}: reading card ids failed:`, err?.message || err);
    return { ids: [], global: store.global };
  } finally { tdb.close(); }
}

/**
 * Finish a delete that stopped partway: re-run the steps its `project.delete` audit lists as
 * failed, and record what is still left.
 *
 * A candidate is a tombstoned project (`archived_at` set, slug `<slug>-deleted-<id>`, or one of
 * its `-2`, `-3` clash variants) whose newest delete/resume audit entry still names steps. Any
 * other row is refused with `not_partial`. The original slug and uuid come from the
 * `project.delete` audit entry, because the row's own slug is the tombstone's.
 * @param {object} opts
 * @param {string} [opts.actor='local']  local|contact|bot|system
 * @param {(fileRow:object)=>Promise<void>} [opts.storageDelete]  per-file delete (object + row)
 * @param {string} [opts.dataDir]  defaults to project-spaces.js's anchor
 * @param {string} [opts.tasksDbPath]  the instance-global tasks.db (instance-paths.mjs by default)
 * @param {() => Date} [opts.now]  the date used in the deleted-projects folder name
 * @param {(db:object, project:object)=>Promise<object>} [opts._eraseHistory]  test seam over the at-once history erase
 * @returns {Promise<{ ok: true, partial: string[], untraceable?: string[] } |
 *   { ok: false, code: 'bad_actor'|'not_owner'|'not_partial' }>}
 *   `partial` lists what failed again this time (empty when the delete is now complete).
 *   `untraceable` lists owed steps that could not be repeated at all (a queued job whose card
 *   rows are gone): they are reported, never silently counted as done, and never owed again.
 */
export async function resumeProjectDelete(db, projectId, {
  actor = "local", storageDelete, dataDir, tasksDbPath, now = () => new Date(), _eraseHistory = eraseProjectHistory,
} = {}) {
  if (!ACTORS.includes(actor)) return { ok: false, code: "bad_actor" };
  const id = Number(projectId);
  if (!Number.isInteger(id)) return { ok: false, code: "not_partial" };
  if (!(await canOwnDeletedProject(db, id))) return { ok: false, code: "not_owner" };

  const tomb = await loadAnyProject(db, id);
  if (!tomb || !tomb.archived_at) return { ok: false, code: "not_partial" };
  // tombstoneSlug: <slug>-deleted-<id>, or -2/-3/... when that slug was taken.
  if (!new RegExp(`-deleted-${id}(-[0-9]+)?$`).test(String(tomb.slug || ""))) return { ok: false, code: "not_partial" };

  const del = await latestAuditOf(db, id, ["project.delete"]);
  if (!del || !del.details.slug) return { ok: false, code: "not_partial" };
  // The newest entry decides what is left: the original delete, or a resume that failed again
  // (which carries the steps it could not finish). None left means the delete is already complete.
  const latest = await latestAuditOf(db, id, ["project.delete", "project.delete.resume"]);
  const listed = latest && latest.event === "project.delete.resume" ? latest.details.remaining_partial : del.details.partial;
  const wanted = new Set((Array.isArray(listed) ? listed : []).filter((s) => RESUME_STEPS.includes(s)));
  if (!wanted.size) return { ok: false, code: "not_partial" };

  // The destination folder is named from the ROW's uuid: the audit entry is text a caller could
  // have written, so it never names a path. Only a row with no uuid falls back to the audit's, and
  // only when that is uuid-shaped; anything else refuses rather than steer the move out of
  // deleted-projects.
  let uuid = tomb.uuid;
  if (!uuid) {
    if (!AUDIT_UUID_RE.test(String(del.details.uuid || ""))) return { ok: false, code: "not_partial" };
    uuid = String(del.details.uuid);
  }
  const project = { ...tomb, id, slug: String(del.details.slug), uuid };
  const partial = [];
  const untraceable = [];
  if (wanted.has("history-erase")) {
    try { await _eraseHistory(db, project); }
    catch (err) {
      console.warn(`[project-lifecycle] resume ${id}: history erase failed:`, err?.message || err);
      partial.push("history-erase");
    }
  }
  if (wanted.has("history-workspace")) {
    try {
      const { removeWorkspaceHistory } = await import("./history/workspace-history.js");
      if (!removeWorkspaceHistory(id, { dataDir })) throw new Error("could not be removed");
    } catch (err) {
      console.warn(`[project-lifecycle] resume ${id}: file history removal failed:`, err?.message || err);
      partial.push("history-workspace");
    }
  }
  // The ids first: purgeCards removes the rows they name. A card id is per store, so a store with
  // no rows for the project has no queued job that can be tied to it any more (nothing to cancel).
  const cards = wanted.has("jobs") ? await cardsLeft(project, { tasksDbPath }) : null;
  if (wanted.has("cards") || wanted.has("board_defs")) await purgeCards(project, { tasksDbPath }, partial);
  if (cards) {
    // No card rows left: no queued job can be tied to the project, so the step cannot run. Report
    // it instead of counting it as done — and leave it out of remaining_partial, which is what a
    // later resume reads, so it is never owed again.
    if (!cards.ids.length) untraceable.push("jobs");
    else await cancelCardJobs(db, id, cards, partial);
  }
  if (wanted.has("files")) await purgeFiles(db, id, storageDelete || defaultStorageDeleteFor(db), partial);
  if (wanted.has("workspace")) moveWorkspace(project, projectsDataDir(dataDir), now(), partial);

  const extra = untraceable.length ? { untraceable } : {};
  await appendAudit(db, {
    project_id: id, actor_type: actor, action: "project.delete.resume", payload: { remaining_partial: partial, ...extra },
  });
  await auditLog(db, "project.delete.resume", {
    actor,
    details: { project_id: id, uuid: project.uuid, slug: project.slug, name: tomb.name ?? null, remaining_partial: partial, ...extra },
  });
  return { ok: true, partial, ...extra };
}
