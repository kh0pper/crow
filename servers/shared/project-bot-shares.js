// Bot ↔ project share store (Phase 1).
//
// A share is one row in `project_bot_shares`: this instance's owner granted a bot access to a
// project at `read` or `read_write`. Rows are never deleted — a revoke sets `revoked_at` — and the
// partial unique index keeps at most one LIVE row per (project, bot), so a revoked row and a fresh
// grant coexist.
//
// Two things make a stored row weaker than it looks, and both are evaluated on EVERY call (there is
// no caching: a share's reach must follow the tables, never the moment it was granted):
//   - OUTSIDE MEMBER. While either project — the shared one or the bot's own home project — has an
//     active `project_members` row whose contact is not the local owner, the share is SUSPENDED.
//     Grant is refused then, and use is refused with reason "outside_member". The local owner is the
//     `contact_id IS NULL` row (the partial unique index `idx_project_members_local_owner`), so the
//     test is `contact_id IS NOT NULL AND revoked_at IS NULL`; live Crow-to-Crow members are contact
//     rows and count the same way.
//   - GONE. A project that is archived (`status='archived'`, the user's lifecycle state) or
//     tombstoned (`archived_at` set, which only a permanent delete writes — see
//     servers/shared/project-lifecycle.js) resolves to no access, and so does a bot whose
//     `pi_bot_defs` row is gone. The share row is left as it was, so archiving and restoring, or a
//     later re-created bot def, cannot resurrect reach it should not have.
//
// Grant and revoke are owner-only at the caller (the dashboard session check) and are written to
// BOTH projects' `project_audit_log` via appendAudit, naming the other project by id only.
//
// See the private engineering notes for the Phase 1 share design.

import { AclError, appendAudit, assertProjectExists } from "./project-acl.js";

export const SHARE_LEVELS = Object.freeze(["read", "read_write"]);

export class ShareError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ShareError";
    this.code = code || "bad_level";
  }
}

const auditTarget = (botId) => `bot:${botId}`;

const noAccess = () => ({ kind: "none", level: null, suspended: false, reason: null });

async function loadProjectRow(db, projectId) {
  const { rows } = await db.execute({
    sql: "SELECT id, name, status, archived_at FROM project_spaces WHERE id = ? LIMIT 1",
    args: [Number(projectId)],
  });
  return rows[0] || null;
}

async function loadBotRow(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT bot_id, display_name, project_id, definition FROM pi_bot_defs WHERE bot_id = ? LIMIT 1",
    args: [String(botId)],
  });
  return rows[0] || null;
}

/** The bot's home project id, or null when the def names none. */
function homeOf(bot) {
  return bot && bot.project_id != null ? Number(bot.project_id) : null;
}

/** A project that can be shared into: exists and is neither archived nor tombstoned. */
function assertLiveProject(project) {
  if (!project || project.archived_at || String(project.status) === "archived") {
    throw new ShareError(`Project #${project && project.id} is not available`, "project_not_found");
  }
}

/**
 * Active `project_members` rows whose contact is not the local owner: the "outside member" the
 * Phase 1 rule watches on both sides of a share.
 */
export async function outsideMembers(db, projectId) {
  const { rows } = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM project_members
           WHERE project_id = ? AND contact_id IS NOT NULL AND revoked_at IS NULL`,
    args: [Number(projectId)],
  });
  return { count: Number(rows[0] && rows[0].n) || 0 };
}

/** Audits a share event to the shared project's log and to the bot's home project's log. */
async function auditBoth(db, { action, project, home, botId, payload }) {
  await appendAudit(db, {
    project_id: Number(project.id), actor_type: "local", action, target: auditTarget(botId), payload,
  });
  if (home == null || Number(home.id) === Number(project.id) || home.archived_at) return;
  await appendAudit(db, {
    project_id: Number(home.id), actor_type: "local", action, target: auditTarget(botId),
    payload: { ...payload, project_id: Number(project.id) },
  });
}

/**
 * Whether the bot can invoke a peer's tools at all: this instance's `remote_invocation` flag is on
 * AND the bot selects at least one remote capability. A live share blocks that proxy, so the caller
 * uses this to warn that the warning toggle is about to be inert for this bot.
 *
 * Both halves are resolved LAZILY, here and nowhere else: the settings registry and the pi-bots
 * remote-block helper are dashboard/bridge code, and a server that only imports this store (to
 * resolve a bot's access) must not pull them in.
 */
async function remoteInvocationOn(db, bot) {
  let mods;
  try {
    mods = await Promise.all([
      import("../gateway/dashboard/settings/registry.js"),
      import("../../scripts/pi-bots/remote-blocks.mjs"),
    ]);
  } catch {
    // A helper that cannot be loaded only means the warning is unavailable: report it off rather
    // than fail a grant that has nothing to do with remote invocation.
    return false;
  }
  const { readSetting } = mods[0];
  const { parseRemoteInvocationFlag, remoteServersForBot } = mods[1];
  let raw = null;
  try { raw = await readSetting(db, "feature_flags"); } catch { return false; }
  if (!parseRemoteInvocationFlag(raw)) return false;
  let def = {};
  try { def = bot.definition ? JSON.parse(bot.definition) : {}; } catch { return false; }
  return remoteServersForBot(def).length > 0;
}

/**
 * Grant (or re-grant) the bot access to a project. Upserts the single live row, reporting whether
 * it was created, its level changed, or nothing was touched; a fresh grant or a level change is
 * audited to both projects.
 *
 * @param {object} db
 * @param {{ projectId: number|string, botId: string, level: string }} opts
 * @returns {Promise<{ id: number, changed: "created"|"level_changed"|"unchanged", remoteInvocationOn: boolean }>}
 * @throws {ShareError} bad_level | bot_not_found | project_not_found | same_project | outside_members
 */
export async function grantShare(db, { projectId, botId, level } = {}) {
  if (!SHARE_LEVELS.includes(level)) {
    throw new ShareError(`Share level must be one of ${SHARE_LEVELS.join(", ")}`, "bad_level");
  }
  const bot = await loadBotRow(db, botId);
  if (!bot) throw new ShareError(`Bot ${botId} not found`, "bot_not_found");

  const project = await loadProjectRow(db, projectId);
  if (!project) throw new ShareError(`Project #${projectId} not found`, "project_not_found");
  try {
    await assertProjectExists(db, Number(project.id));
  } catch (err) {
    // assertProjectExists refuses the tombstone (archived_at); map it to this store's vocabulary.
    if (err instanceof AclError) throw new ShareError(`Project #${projectId} is not available`, "project_not_found");
    throw err;
  }
  assertLiveProject(project);

  const id = Number(project.id);
  const homeId = homeOf(bot);
  if (homeId === id) {
    throw new ShareError(`Project #${id} is the bot's own project`, "same_project");
  }
  const home = homeId == null ? null : await loadProjectRow(db, homeId);
  if ((await outsideMembers(db, id)).count > 0) {
    throw new ShareError(`Project #${id} has an outside member`, "outside_members");
  }
  if (home && (await outsideMembers(db, home.id)).count > 0) {
    throw new ShareError(`The bot's own project #${home.id} has an outside member`, "outside_members");
  }

  const { rows } = await db.execute({
    sql: `SELECT id, level FROM project_bot_shares
           WHERE project_id = ? AND bot_id = ? AND revoked_at IS NULL LIMIT 1`,
    args: [id, String(botId)],
  });
  const live = rows[0] || null;
  let shareId;
  let changed;
  if (!live) {
    const r = await db.execute({
      sql: "INSERT INTO project_bot_shares (project_id, bot_id, level, granted_by) VALUES (?, ?, ?, 'owner')",
      args: [id, String(botId), level],
    });
    shareId = Number(r.lastInsertRowid);
    changed = "created";
  } else if (String(live.level) !== level) {
    await db.execute({ sql: "UPDATE project_bot_shares SET level = ? WHERE id = ?", args: [level, Number(live.id)] });
    shareId = Number(live.id);
    changed = "level_changed";
  } else {
    shareId = Number(live.id);
    changed = "unchanged";
  }

  if (changed !== "unchanged") {
    await auditBoth(db, {
      action: changed === "created" ? "share.grant" : "share.level_changed",
      project, home, botId, payload: { level },
    });
  }
  return { id: shareId, changed, remoteInvocationOn: await remoteInvocationOn(db, bot) };
}

/**
 * Revoke the bot's live share of a project: `revoked_at`, never a delete. Audited to both logs.
 * @throws {ShareError} no_such_share
 */
export async function revokeShare(db, { projectId, botId } = {}) {
  const id = Number(projectId);
  const { rows } = await db.execute({
    sql: `SELECT id, level FROM project_bot_shares
           WHERE project_id = ? AND bot_id = ? AND revoked_at IS NULL LIMIT 1`,
    args: [id, String(botId)],
  });
  const live = rows[0];
  if (!live) throw new ShareError(`No live share of project #${id} with bot ${botId}`, "no_such_share");

  await db.execute({
    sql: "UPDATE project_bot_shares SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
    args: [Number(live.id)],
  });

  const bot = await loadBotRow(db, botId);
  const homeId = homeOf(bot);
  const project = await loadProjectRow(db, id);
  const home = homeId == null || homeId === id ? null : await loadProjectRow(db, homeId);
  await auditBoth(db, {
    action: "share.revoke",
    project: project || { id },
    home, botId, payload: { level: String(live.level) },
  });
}

/**
 * What the bot may do with `projectId` right now.
 *   - `home`: the project is the bot's own (`pi_bot_defs.project_id`), so no share is involved;
 *   - `share`: a live share grants `level`, `suspended` while either side has an outside member;
 *   - `none`: no live share, or the project is archived/tombstoned, or the bot def is gone.
 * @returns {Promise<{ kind: "home"|"share"|"none", level: null|"read"|"read_write",
 *   suspended: boolean, reason: null|"outside_member" }>}
 */
export async function resolveBotAccess(db, botId, projectId) {
  if (botId == null || projectId == null) return noAccess();
  const { rows } = await db.execute({
    sql: `SELECT p.status, p.archived_at, d.bot_id, d.project_id AS home_project_id,
                 s.id AS share_id, s.level AS share_level,
                 (SELECT COUNT(*) FROM project_members m
                   WHERE m.project_id = p.id AND m.contact_id IS NOT NULL AND m.revoked_at IS NULL) AS project_outside,
                 (SELECT COUNT(*) FROM project_members m
                   WHERE m.project_id = d.project_id AND m.contact_id IS NOT NULL AND m.revoked_at IS NULL) AS home_outside
            FROM project_spaces p
            LEFT JOIN pi_bot_defs d ON d.bot_id = ?
            LEFT JOIN project_bot_shares s ON s.bot_id = d.bot_id AND s.project_id = p.id AND s.revoked_at IS NULL
           WHERE p.id = ?
           LIMIT 1`,
    args: [String(botId), Number(projectId)],
  });
  const row = rows[0];
  if (!row || !row.bot_id) return noAccess();
  if (row.archived_at || String(row.status) === "archived") return noAccess();
  if (row.home_project_id != null && Number(row.home_project_id) === Number(projectId)) {
    return { kind: "home", level: null, suspended: false, reason: null };
  }
  if (row.share_id == null) return noAccess();
  const suspended = Number(row.project_outside) > 0 || Number(row.home_outside) > 0;
  return {
    kind: "share", level: String(row.share_level), suspended,
    reason: suspended ? "outside_member" : null,
  };
}

/**
 * Revoke every live share the bot holds, auditing `share.revoke` (payload `{ reason }`) to each
 * shared project's log. A no-op when it holds none. Used when the bot itself is deleted, so a bot
 * later created with the same id inherits nothing.
 */
export async function revokeAllSharesForBot(db, botId, { reason = "bot_deleted" } = {}) {
  const { rows } = await db.execute({
    sql: "SELECT DISTINCT project_id FROM project_bot_shares WHERE bot_id = ? AND revoked_at IS NULL ORDER BY project_id",
    args: [String(botId)],
  });
  if (!rows.length) return;
  await db.execute({
    sql: "UPDATE project_bot_shares SET revoked_at = datetime('now') WHERE bot_id = ? AND revoked_at IS NULL",
    args: [String(botId)],
  });
  for (const row of rows) {
    await appendAudit(db, {
      project_id: Number(row.project_id), actor_type: "local", action: "share.revoke",
      target: auditTarget(botId), payload: { reason },
    });
  }
}

/**
 * Does the bot hold any live share, suspended ones included? A suspended share does not grant
 * access, but it still blocks the bot's remote-proxy blocks, so a suspension must not be usable to
 * regain them.
 */
export async function botHoldsLiveShare(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT 1 AS x FROM project_bot_shares WHERE bot_id = ? AND revoked_at IS NULL LIMIT 1",
    args: [String(botId)],
  });
  return rows.length > 0;
}

// Live rows joined to their project and bot, with the outside-member counts of both sides, so one
// query answers "what is shared, and is it currently suspended".
const LIST_SQL = `
  SELECT s.id, s.project_id, p.name AS project_name, s.bot_id,
         COALESCE(d.display_name, s.bot_id) AS bot_name, s.level, s.granted_at,
         (SELECT COUNT(*) FROM project_members m
           WHERE m.project_id = s.project_id AND m.contact_id IS NOT NULL AND m.revoked_at IS NULL) AS project_outside,
         (SELECT COUNT(*) FROM project_members m
           WHERE m.project_id = d.project_id AND m.contact_id IS NOT NULL AND m.revoked_at IS NULL) AS home_outside
    FROM project_bot_shares s
    JOIN project_spaces p ON p.id = s.project_id
    LEFT JOIN pi_bot_defs d ON d.bot_id = s.bot_id
   WHERE s.revoked_at IS NULL AND `;

function listRow(row) {
  const suspended = Number(row.project_outside) > 0 || Number(row.home_outside) > 0;
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    project_name: row.project_name == null ? null : String(row.project_name),
    bot_id: String(row.bot_id),
    bot_name: row.bot_name == null ? null : String(row.bot_name),
    level: String(row.level),
    granted_at: row.granted_at == null ? null : String(row.granted_at),
    suspended,
    reason: suspended ? "outside_member" : null,
  };
}

/** Live shares of one project, oldest grant first. */
export async function listSharesForProject(db, projectId) {
  const { rows } = await db.execute({
    sql: LIST_SQL + "s.project_id = ? ORDER BY s.granted_at, s.id",
    args: [Number(projectId)],
  });
  return rows.map(listRow);
}

/** Live shares held by one bot, oldest grant first. */
export async function listSharesForBot(db, botId) {
  const { rows } = await db.execute({
    sql: LIST_SQL + "s.bot_id = ? ORDER BY s.granted_at, s.id",
    args: [String(botId)],
  });
  return rows.map(listRow);
}