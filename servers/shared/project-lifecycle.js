// Project lifecycle: archive, restore, and the archived-allowing owner check.
//
// Two markers mean two things. `status='archived'` is the user's lifecycle state (this file).
// `archived_at` has only ever meant "deleted"; archive and restore NEVER write it, because the
// bot runtime treats archived_at as gone. See docs/guide/projects.md.

import { appendAudit } from "./project-acl.js";

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
