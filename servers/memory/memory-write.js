/**
 * The memory server's own insert and update writes, shared by the
 * crow_store_memory / crow_update_memory tools and by gateway code that files
 * a memory itself (the session summary job, servers/gateway/perch/
 * session-summary.js). One path, so every writer gets the same sync emit.
 *
 * project_uuid: put in the row (and on the wire) ONLY when it is non-null.
 * A peer that has not run migration 0020 has no such column, and the generic
 * apply path fails on a key the local table lacks. The outbound transform also
 * drops a null project_uuid; this keeps the local INSERT working on an
 * un-migrated store as well.
 */
import { emitOrQueue } from "../shared/sync-emit.js";

const orNull = (v) => (v === undefined ? null : v);
const hasUuid = (v) => typeof v === "string" && v.length > 0;

/**
 * INSERT one memory and emit its sync entry (non-blocking).
 * @param {object} db  a createDbClient() client
 * @param {{content:string, category:string, context?:string|null, tags?:string|null, source?:string|null,
 *   importance:number, instance_id?:string|null, project_id?:number|null, project_uuid?:string|null}} f
 * @param {{syncManager?:object|null, onStored?:(id:number, content:string)=>void}} [opts]
 * @returns {Promise<number>} the new memory id
 */
export async function insertMemory(db, f, { syncManager = null, onStored = null } = {}) {
  const row = {
    content: f.content,
    category: f.category,
    context: orNull(f.context),
    tags: orNull(f.tags),
    source: orNull(f.source),
    importance: f.importance,
    instance_id: orNull(f.instance_id),
    project_id: orNull(f.project_id),
  };
  if (hasUuid(f.project_uuid)) row.project_uuid = f.project_uuid;
  const cols = Object.keys(row);
  const result = await db.execute({
    sql: `INSERT INTO memories (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    args: cols.map((c) => row[c]),
  });
  const id = Number(result.lastInsertRowid);
  if (onStored) { try { onStored(id, f.content); } catch { /* embedding is best effort */ } }
  emitOrQueue(syncManager, db, "memories", "insert", { id, ...row }).catch(() => {});
  return id;
}

/**
 * UPDATE the given fields of one memory and emit its sync entry. Fields left
 * undefined are not touched and not sent. `source` is the row's existing
 * source (the wire row carries it). Returns false when nothing was given.
 * @param {object} db
 * @param {number} id
 * @param {{content?:string, category?:string, tags?:string, importance?:number, context?:string,
 *   project_id?:number|null, project_uuid?:string|null}} f
 * @param {{syncManager?:object|null, source?:string|null, onContent?:(id:number, content:string)=>void}} [opts]
 */
export async function updateMemory(db, id, f, { syncManager = null, source = null, onContent = null } = {}) {
  const fields = {};
  for (const k of ["content", "category", "tags", "importance", "context", "project_id"]) {
    if (f[k] !== undefined) fields[k] = f[k];
  }
  // A null project_uuid is written locally (the memory left its project) but
  // never sent: the wire row only ever carries a non-null uuid.
  const local = { ...fields };
  if (hasUuid(f.project_uuid)) { fields.project_uuid = f.project_uuid; local.project_uuid = f.project_uuid; }
  else if (f.project_uuid === null) local.project_uuid = null;
  const keys = Object.keys(local);
  if (keys.length === 0) return false;
  await db.execute({
    sql: `UPDATE memories SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    args: [...keys.map((k) => local[k]), id],
  });
  if (fields.content !== undefined && onContent) {
    try { onContent(id, fields.content); } catch { /* embedding is best effort */ }
  }
  emitOrQueue(syncManager, db, "memories", "update", { id, ...fields, source: source ?? null }).catch(() => {});
  return true;
}
