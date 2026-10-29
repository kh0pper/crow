// Project lifecycle: archive, restore, the archived-allowing owner check, and the permanent delete.
//
// Two markers mean two things. `status='archived'` is the user's lifecycle state (this file).
// `archived_at` has only ever meant "deleted"; archive and restore NEVER write it, because the
// bot runtime treats archived_at as gone. See docs/guide/projects.md.

import { appendAudit } from "./project-acl.js";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createDbClient, auditLog, resolveDataDir } from "../db.js";
import { emitOrQueue } from "./sync-emit.js";
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

async function defaultSyncManager() {
  try { return (await import("../sharing/managers.js")).getInstanceSyncManager(); } catch { return null; }
}

/** Run one write inside the transaction; an absent table/column is skipped, anything else throws. */
async function txWrite(db, sql, args) {
  try { return await db.execute({ sql, args }); } catch (err) { if (isAbsent(err)) return { rowsAffected: 0, skipped: true }; throw err; }
}

/** The crow.db purge + tombstone, in ONE BEGIN IMMEDIATE ... COMMIT. Synchronous DB work only. */
async function purgeCrowDb(db, project, { actor, counts, beforeTombstone }) {
  const id = Number(project.id);
  const emits = { notes: [], context: [], memories: [] };
  await db.execute("BEGIN IMMEDIATE");
  try {
    await txWrite(db, "DELETE FROM service_connections WHERE project_id = ?", [id]);
    await txWrite(db, "DELETE FROM data_backends WHERE project_id = ?", [id]);

    emits.notes = await tolerant(async () => (await db.execute({
      sql: "SELECT id FROM research_notes WHERE project_id = ? ORDER BY id", args: [id],
    })).rows.map((r) => Number(r.id)), []);
    await txWrite(db, "DELETE FROM research_notes WHERE project_id = ?", [id]);
    await txWrite(db, "DELETE FROM research_sources WHERE project_id = ?", [id]);

    emits.context = await tolerant(async () => (await db.execute({
      sql: "SELECT section_key, device_id, project_id FROM crow_context WHERE project_id = ? ORDER BY id", args: [id],
    })).rows.map((r) => ({ section_key: r.section_key, device_id: r.device_id ?? null, project_id: r.project_id ?? null })), []);
    await txWrite(db, "DELETE FROM crow_context WHERE project_id = ?", [id]);

    // Memories are the user's: unfiled, never deleted.
    emits.memories = await tolerant(async () => (await db.execute({
      sql: "SELECT id, source FROM memories WHERE project_id = ? OR (project_uuid IS NOT NULL AND project_uuid = ?) ORDER BY id",
      args: [id, project.uuid],
    })).rows, null);
    if (emits.memories === null) { // pre-0020 memories table: no project_uuid
      emits.memories = await tolerant(async () => (await db.execute({
        sql: "SELECT id, source FROM memories WHERE project_id = ? ORDER BY id", args: [id],
      })).rows, []);
      await txWrite(db, "UPDATE memories SET project_id = NULL, updated_at = datetime('now') WHERE project_id = ?", [id]);
    } else {
      await txWrite(db,
        "UPDATE memories SET project_id = NULL, project_uuid = NULL, updated_at = datetime('now') WHERE project_id = ? OR (project_uuid IS NOT NULL AND project_uuid = ?)",
        [id, project.uuid]);
    }

    // Filings go to Unassigned; the card a filing named is being deleted, so its card_id goes too.
    await txWrite(db, "UPDATE shell_items SET project_id = NULL, card_id = NULL, updated_at = datetime('now') WHERE project_id = ?", [id]);
    // card_offers.status is pending|accepted|declined: a pending offer is cancelled as declined.
    await txWrite(db, "UPDATE card_offers SET status = 'declined', decided_at = datetime('now') WHERE project_id = ? AND status = 'pending'", [id]);
    await txWrite(db, "UPDATE bot_sessions SET project_id = NULL WHERE project_id = ?", [id]);

    await appendAudit(db, { project_id: id, actor_type: actor, action: "project.delete", payload: counts });

    if (beforeTombstone) await beforeTombstone();

    const tombSql = (withRepo) => `UPDATE project_spaces
         SET archived_at = datetime('now'), status = 'archived', slug = slug || '-deleted-' || id,
             description = NULL${withRepo ? ", repo_path = NULL" : ""}, updated_at = datetime('now')
       WHERE id = ? AND archived_at IS NULL`;
    let r;
    try { r = await db.execute({ sql: tombSql(true), args: [id] }); }
    catch (err) { if (!/no such column: repo_path/i.test(String(err && err.message))) throw err; r = await db.execute({ sql: tombSql(false), args: [id] }); }
    if (!r.rowsAffected) throw new Error("tombstone write matched no live row");
    await db.execute("COMMIT");
  } catch (err) {
    try { await db.execute("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
  return emits;
}

/** Sync deletes and the memory update, the way the existing emit sites shape them. Best effort. */
async function emitPurge(db, syncManager, emits) {
  for (const nid of emits.notes) await emitOrQueue(syncManager, db, "research_notes", "delete", { id: nid });
  for (const c of emits.context) await emitOrQueue(syncManager, db, "crow_context", "delete", c);
  // memory-write.js updateMemory's wire row for { project_id: null, project_uuid: null }.
  for (const m of emits.memories) {
    await emitOrQueue(syncManager, db, "memories", "update", { id: Number(m.id), project_id: null, source: m.source ?? null });
  }
  if (emits.context.length) {
    try { (await import("../memory/crow-context.js")).invalidateContextCache(); } catch { /* cache is per-process */ }
  }
}

/** Cards and their records in the resolved store; board_defs in the global store. Never unlinks a file. */
async function purgeCards(project, { tasksDbPath }, partial) {
  const id = Number(project.id);
  const store = resolveCardsStore(project, { tasksDbPath });
  const deleted = { cards: 0 };
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
 * nothing is followed. Only a workspace under <dataDir>/projects/ is moved. @returns {boolean} moved
 */
function moveWorkspace(project, dataDir, now, partial) {
  const ws = project.workspace_dir;
  if (!workspaceExists(ws)) return false;
  const root = join(dataDir, "projects");
  const rel = relative(root, resolve(ws));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    console.warn(`[project-lifecycle] delete ${project.id}: workspace ${ws} is outside ${root}; left in place`);
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
    return true;
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
 * @param {object|null} [opts.syncManager]  defaults to the gateway's InstanceSyncManager
 * @param {string} [opts.dataDir]  defaults to project-spaces.js's anchor
 * @param {string} [opts.tasksDbPath]  the instance-global tasks.db (instance-paths.mjs by default)
 * @param {string} [opts.crowHome]  accepted, unused (see deleteSummary)
 * @param {Function} [opts._beforeTombstone]  test seam: runs inside the transaction, before the tombstone
 * @returns {Promise<{ ok: true, counts: object, partial?: string[] } |
 *   { ok: false, code: 'bad_actor'|'not_owner'|'shared'|'bots'|'name_mismatch'|'failed', detail?: object }>}
 */
export async function deleteProject(db, projectId, {
  confirmName, crowHome, actor = "local", storageDelete, disconnectBackend = defaultDisconnectBackend,
  syncManager, dataDir, tasksDbPath, now = () => new Date(), _beforeTombstone,
} = {}) {
  if (!ACTORS.includes(actor)) return { ok: false, code: "bad_actor" };
  const summary = await deleteSummary(db, projectId, { tasksDbPath });
  if (summary.blocked) return { ok: false, code: summary.blocked.code, ...(summary.blocked.detail ? { detail: summary.blocked.detail } : {}) };
  const project = await loadProject(db, projectId);
  if (typeof confirmName !== "string" || confirmName.trim() !== String(project.name)) return { ok: false, code: "name_mismatch" };
  const id = Number(project.id);
  const counts = summary.counts;

  // Pre-transaction: keychain secrets masked (one service.disconnect audit each), running backends closed.
  try {
    await disconnectProjectConnections(db, id, { actor });
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

  let emits;
  try {
    emits = await purgeCrowDb(db, project, { actor, counts, beforeTombstone: _beforeTombstone });
  } catch (err) {
    console.warn(`[project-lifecycle] delete ${id}: crow.db purge rolled back:`, err?.message || err);
    return { ok: false, code: "failed" };
  }

  // After the commit: best effort. The tombstone already hides the project and its id is never
  // reused, so anything left behind is inert.
  const partial = [];
  try {
    const mgr = syncManager === undefined ? await defaultSyncManager() : syncManager;
    await emitPurge(db, mgr, emits);
  } catch (err) { console.warn(`[project-lifecycle] delete ${id}: sync emit failed:`, err?.message || err); partial.push("sync"); }
  await purgeCards(project, { tasksDbPath }, partial);
  await purgeFiles(db, id, storageDelete || defaultStorageDeleteFor(db), partial);
  const workspaceMoved = moveWorkspace(project, projectsDataDir(dataDir), now(), partial);
  const result = { ...counts, workspaceMoved };
  await auditLog(db, "project.delete", {
    actor,
    details: { project_id: id, uuid: project.uuid, slug: project.slug, name: project.name, counts: result, ...(partial.length ? { partial } : {}) },
  });
  return { ok: true, counts: result, ...(partial.length ? { partial } : {}) };
}
