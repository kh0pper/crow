// servers/shared/shell-items.js — the pure rules for which project a shell item (a Perch thread,
// an artifact, a Workspace file) belongs to. The derive* functions are pure (callers hand in the
// facts); the rest of the file is the shell_items service over a createDbClient() client.
// project_id here is filing only: never an ACL input; never read by project-acl.js.

import { AclError, appendAudit } from "./project-acl.js";

// A project an item may be filed under: not archived, not a learner profile. Used as a SQL
// fragment against project_spaces (the 0010 backfill, and the readers that follow it). The columns
// are unqualified, so in a join use activeProjectWhere("alias") to keep them unambiguous.
export function activeProjectWhere(alias = "") {
  if (alias && !/^[A-Za-z_]\w*$/.test(alias)) throw new Error(`bad SQL alias: ${alias}`);
  const c = alias ? `${alias}.` : "";
  return `${c}archived_at IS NULL AND ${c}status != 'archived' AND (${c}type IS NULL OR ${c}type != 'learner_profile')`;
}
export const ACTIVE_PROJECT_WHERE = activeProjectWhere();

/**
 * The project an item may be filed under, by the same rule the readers use (activeProjectWhere).
 * Throws AclError not_found for a missing or learner_profile project, and AclError archived
 * (http 409) for either archive marker (archived_at set, or status 'archived').
 */
export async function assertLiveProject(db, id) {
  const { rows } = await db.execute({
    sql: `SELECT id, slug, name, type, (${ACTIVE_PROJECT_WHERE}) AS live FROM project_spaces WHERE id = ? LIMIT 1`,
    args: [Number(id)],
  });
  const p = rows[0];
  if (!p || p.type === "learner_profile") throw new AclError(`Project #${id} not found`, "not_found");
  if (!Number(p.live)) {
    const err = new AclError(`Project #${id} is archived`, "archived");
    err.http = 409;
    throw err;
  }
  return { id: Number(p.id), slug: p.slug, name: p.name };
}

function firstLive(candidates, liveProjectIds) {
  for (const c of candidates) {
    if (c !== null && c !== undefined && liveProjectIds.has(Number(c))) return Number(c);
  }
  return null;
}

/** The thread's card's project, else the session's, else the bot's — the first that is still live. */
export function deriveThreadProject({ cardProjectId, sessionProjectId, botProjectId, liveProjectIds }) {
  return firstLive([cardProjectId, sessionProjectId, botProjectId], liveProjectIds);
}

/** The origin card's project, else the origin thread's, else the creating bot's — the first still live. */
export function deriveArtifactProject({ cardProjectId, threadProjectId, botProjectId, liveProjectIds }) {
  return firstLive([cardProjectId, threadProjectId, botProjectId], liveProjectIds);
}

// ---- the shell_items service ----

export const ITEM_KINDS = ["perch_thread", "artifact", "workspace_file"];
const DOCUMENT_KINDS = ["artifact", "workspace_file"];

function codedError(message, code, http) {
  const err = new Error(message);
  err.code = code;
  if (http) err.http = http;
  return err;
}

function assertKind(kind, allowed = ITEM_KINDS) {
  if (!allowed.includes(kind)) throw codedError(`bad item kind: ${kind}`, "bad_kind", 400);
}

const noTable = (err) => /no such table/i.test(String(err?.message || err));

// A store that hasn't run 0010 reads as empty and refuses writes with a 503.
async function reader(fn, empty) {
  try { return await fn(); } catch (err) { if (noTable(err)) return empty; throw err; }
}
async function writer(fn) {
  try { return await fn(); } catch (err) {
    if (noTable(err)) throw codedError("shell_items is not migrated yet", "not_migrated", 503);
    throw err;
  }
}

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

/** One item's row, or null. `live` is true only when projectId names a live project. */
export async function getItem(db, kind, ref) {
  const item = await reader(async () => {
    const { rows } = await db.execute({
      sql: `SELECT item_kind, item_ref, project_id, card_id, set_by, seen_version, seen_at
              FROM shell_items WHERE item_kind = ? AND item_ref = ?`,
      args: [kind, String(ref)],
    });
    const r = rows[0];
    if (!r) return null;
    return {
      kind: r.item_kind, ref: r.item_ref, projectId: numOrNull(r.project_id), cardId: numOrNull(r.card_id),
      setBy: r.set_by, seenVersion: numOrNull(r.seen_version), seenAt: r.seen_at ?? null,
    };
  }, null);
  if (!item) return null;
  item.live = item.projectId === null ? false : await reader(async () => {
    const { rows } = await db.execute({
      sql: `SELECT 1 FROM project_spaces WHERE id = ? AND ${ACTIVE_PROJECT_WHERE} LIMIT 1`,
      args: [item.projectId],
    });
    return rows.length > 0;
  }, false);
  return item;
}

/**
 * The live project of each ref, in one query: Map<ref, number|null>, keyed by the refs as given.
 * A ref with no row, no project, or a project that is missing, archived or a learner profile maps
 * to null. Without the table every ref maps to null. This is how a consumer that lists its OWN
 * items (artifacts, Workspace files) answers Unassigned: listItemRefs only knows existing rows.
 */
export async function projectOfItems(db, kind, refs) {
  const list = [...(refs || [])];
  const out = new Map(list.map((r) => [r, null]));
  if (!list.length) return out;
  const found = await reader(async () => {
    const { rows } = await db.execute({
      sql: `SELECT s.item_ref, CASE WHEN ps.id IS NOT NULL AND ${activeProjectWhere("ps")} THEN s.project_id END AS live_project
              FROM shell_items s LEFT JOIN project_spaces ps ON ps.id = s.project_id
             WHERE s.item_kind = ? AND s.item_ref IN (SELECT value FROM json_each(?))`,
      args: [kind, JSON.stringify(list.map(String))],
    });
    return new Map(rows.map((r) => [r.item_ref, numOrNull(r.live_project)]));
  }, new Map());
  for (const r of list) out.set(r, found.get(String(r)) ?? null);
  return out;
}

/** The newest perch-live session's card for a thread. The only reader of a thread's card. */
export async function threadCard(db, threadId) {
  return reader(async () => {
    const { rows } = await db.execute({
      sql: `SELECT card_id FROM bot_sessions
             WHERE gateway_thread_id = ? AND kind = 'perch-live'
             ORDER BY id DESC LIMIT 1`,
      args: [String(threadId)],
    });
    return numOrNull(rows[0]?.card_id);
  }, null);
}

export async function setItemProject(db, kind, ref, projectId, { setBy = "operator" } = {}) {
  assertKind(kind);
  const pid = projectId === null || projectId === undefined ? null : Number(projectId);
  if (pid !== null) await assertLiveProject(db, pid);
  await writer(() => db.execute({
    sql: `INSERT INTO shell_items (item_kind, item_ref, project_id, set_by) VALUES (?, ?, ?, ?)
          ON CONFLICT (item_kind, item_ref)
          DO UPDATE SET project_id = excluded.project_id, set_by = excluded.set_by, updated_at = datetime('now')`,
    args: [kind, String(ref), pid, setBy],
  }));
  if (pid !== null) {
    await appendAudit(db, { project_id: pid, actor_type: "local", action: "item_filed", target: `${kind}:${ref}` });
  }
  return { projectId: pid };
}

/** INSERT OR IGNORE: records where an item started, never overriding an existing row. */
export async function ensureItem(db, kind, ref, { projectId, cardId = null, setBy = "origin" } = {}) {
  assertKind(kind);
  await writer(() => db.execute({
    sql: `INSERT OR IGNORE INTO shell_items (item_kind, item_ref, project_id, card_id, set_by) VALUES (?, ?, ?, ?, ?)`,
    args: [kind, String(ref), numOrNull(projectId), kind === "perch_thread" ? null : numOrNull(cardId), setBy],
  }));
}

/** Link a document to a card (or clear it), keeping its project. Threads take their card from bot_sessions. */
export async function setItemCard(db, kind, ref, cardId) {
  assertKind(kind, DOCUMENT_KINDS);
  await writer(() => db.execute({
    sql: `INSERT INTO shell_items (item_kind, item_ref, card_id, set_by) VALUES (?, ?, ?, 'origin')
          ON CONFLICT (item_kind, item_ref)
          DO UPDATE SET card_id = excluded.card_id, updated_at = datetime('now')`,
    args: [kind, String(ref), numOrNull(cardId)],
  }));
}

export async function markSeen(db, kind, ref, version) {
  assertKind(kind);
  await writer(() => db.execute({
    sql: `INSERT INTO shell_items (item_kind, item_ref, set_by, seen_version, seen_at) VALUES (?, ?, 'origin', ?, datetime('now'))
          ON CONFLICT (item_kind, item_ref)
          DO UPDATE SET seen_version = excluded.seen_version, seen_at = excluded.seen_at, updated_at = datetime('now')`,
    args: [kind, String(ref), numOrNull(version)],
  }));
}

/**
 * Refs of one kind in a scope: { projectId }, { unassigned: true } or { all: true }. An item whose
 * project is missing, archived or a learner profile counts as unassigned.
 *
 * Only EXISTING shell_items rows are listed: { unassigned: true } never returns an item that has
 * no row at all. A consumer listing its own items must ask projectOfItems() for each of them
 * instead, and treat null as Unassigned.
 */
export async function listItemRefs(db, kind, scope = { all: true }) {
  return reader(async () => {
    const live = activeProjectWhere("ps");
    let where = "";
    const args = [kind];
    if (scope?.projectId != null) { where = `AND ps.id IS NOT NULL AND ${live} AND s.project_id = ?`; args.push(Number(scope.projectId)); }
    else if (scope?.unassigned) where = `AND (s.project_id IS NULL OR ps.id IS NULL OR NOT (${live}))`;
    const { rows } = await db.execute({
      sql: `SELECT s.item_ref FROM shell_items s
              LEFT JOIN project_spaces ps ON ps.id = s.project_id
             WHERE s.item_kind = ? ${where}
             ORDER BY s.created_at, s.item_ref`,
      args,
    });
    return rows.map((r) => r.item_ref);
  }, []);
}

export async function activeProjects(db) {
  return reader(async () => {
    const { rows } = await db.execute(
      `SELECT id, slug, name FROM project_spaces WHERE ${ACTIVE_PROJECT_WHERE} ORDER BY name COLLATE NOCASE`,
    );
    return rows.map((r) => ({ id: Number(r.id), slug: r.slug, name: r.name }));
  }, []);
}

/** The documents (artifacts, files) linked to a card. */
export async function itemsForCard(db, cardId) {
  return reader(async () => {
    const { rows } = await db.execute({
      sql: `SELECT item_kind, item_ref FROM shell_items
             WHERE card_id = ? AND item_kind IN ('artifact','workspace_file')
             ORDER BY created_at, item_ref`,
      args: [Number(cardId)],
    });
    return rows.map((r) => ({ kind: r.item_kind, ref: r.item_ref }));
  }, []);
}

/** "all" | "unassigned" | a positive integer string; anything else is { all: true }. */
export function parseScope(value) {
  if (value === "unassigned") return { unassigned: true };
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return { projectId: Number(value) };
  return { all: true };
}
