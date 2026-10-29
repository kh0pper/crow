/**
 * Bot Builder — move a bot to another project ("Move a bot here", the project
 * home's Bots section). "Turn on a board" (api-handlers.js handleBoardOn)
 * generalised from no project to any project:
 *
 *   1. read the row; 2. refuse what must not move; 3. work out the old world
 *   root (the current project's <workspace>/bots/<id> when it is there, even
 *   for an archived project; else the legacy root) and the new one (<workspace>/bots/<id>); 4. plan the carry-over
 *   from the bot's REAL world (planMoveCarryOver), before anything is
 *   written; 5. make the links; 6. the tracker write (applyTrackerChoice,
 *   kanban or task-list kept); 7. the compare-and-swap on the definition and
 *   the project_id column, undoing the links on any failure; 8. the
 *   defs-changed emit; 9. a "bot.move" audit entry on both projects.
 *
 * Refusals change nothing. Nothing is ever overwritten, moved or deleted on
 * disk: the old world stays where it really lives and the new root links to
 * it. Past sessions stay filed in the projects they're in.
 *
 * Who may move is the caller's check (the project home shows the action only
 * when canManageProject is true); this helper only requires that the target
 * is a live project_spaces row.
 */
import { worldRootFor, planMoveCarryOver, applyCarryOver, undoCarryOver } from "../../../../../scripts/pi-bots/world-root.mjs";
import { isVoiceBotId } from "../../../../shared/voice-bot.js";
import { activeProjectWhere } from "../../../../shared/shell-items.js";
import { appendAudit } from "../../../../shared/project-acl.js";
import { boardState } from "../../shared/bot-display.js";
import { applyTrackerChoice } from "./tracker-choice.js";
import { emitBotDefsChanged } from "./defs-changed.js";
import { lstatSync } from "node:fs";

function pathPresent(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

/**
 * @param {object} db
 * @param {string} botId
 * @param {number} projectId - the destination project_spaces.id
 * @param {{crowHome: string, actor?: string}} opts - actor is the audit actor_type
 * @returns {Promise<{ok: true, carry: {mode: string, reason: string|null, carried: string[]}}
 *   | {ok: false, code: "unknown_bot"|"voice_bot"|"same_project"|"custom_tracker"|"no_project"|"conflict"|"stale", path?: string}>}
 */
export async function moveBotToProject(db, botId, projectId, { crowHome, actor = "local" } = {}) {
  botId = String(botId || "");
  if (isVoiceBotId(botId)) return { ok: false, code: "voice_bot" };
  let row = null;
  try {
    row = (await db.execute({ sql: "SELECT bot_id, display_name, definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0] || null;
  } catch { row = null; }
  if (!row) return { ok: false, code: "unknown_bot" };

  const toId = Number(projectId);
  const fromId = row.project_id == null ? null : Number(row.project_id);
  if (fromId != null && fromId === toId) return { ok: false, code: "same_project" };
  let def;
  try { def = JSON.parse(row.definition || "{}") || {}; } catch { def = {}; }
  const board = boardState(row);
  // A custom tracker, set up or not: the same rule as "Turn on a board".
  if (board.state === "custom" || board.reason === "no_slug") return { ok: false, code: "custom_tracker" };

  let target = null;
  if (Number.isInteger(toId) && toId > 0) {
    try {
      target = (await db.execute({
        sql: `SELECT id, workspace_dir FROM project_spaces WHERE id=? AND ${activeProjectWhere()}`, args: [toId],
      })).rows[0] || null;
    } catch { target = null; }
  }
  if (!target) return { ok: false, code: "no_project" };

  // The old root: the current project's <workspace>/bots/<id>, archived or
  // not (an archived project still holds the world the bot built there; the
  // runtime falls back to the legacy root for an archived project, so moving
  // out of one must carry what is under the workspace). Only when the row,
  // its workspace_dir or that folder is gone is the legacy root the world.
  const legacyRoot = worldRootFor({ workspaceDir: null, def, crowHome, botId });
  let oldRoot = legacyRoot;
  if (fromId != null) {
    let ws = null;
    try {
      ws = (await db.execute({ sql: "SELECT workspace_dir FROM project_spaces WHERE id=?", args: [fromId] })).rows[0]?.workspace_dir || null;
    } catch { ws = null; }
    const inProject = ws ? worldRootFor({ workspaceDir: ws, def, crowHome, botId }) : null;
    if (inProject && pathPresent(inProject)) oldRoot = inProject;
  }
  const newRoot = worldRootFor({ workspaceDir: target.workspace_dir || null, def, crowHome, botId });

  const plan = planMoveCarryOver(oldRoot, newRoot, { legacyRoot });
  if (plan.conflicts.length) return { ok: false, code: "conflict", path: plan.conflicts.map((c) => c.path).join(", ") };
  let made = [], carried = [];
  try {
    const applied = applyCarryOver(plan, newRoot);
    made = applied.created;
    carried = applied.carried;
  } catch (e) {
    return { ok: false, code: "conflict", path: String((e && (e.path || e.message)) || e) };
  }
  const carry = { mode: plan.mode, reason: plan.reason, carried };

  const type = (def.tracker_config || {}).type === "task-list" ? "task-list" : "kanban";
  const hadProjectKey = Object.prototype.hasOwnProperty.call(def, "project_id");
  applyTrackerChoice(def, { projectId: toId, type });
  // The column is authoritative (M3b): add no JSON copy; an existing copy is
  // kept in step with the column (as handleBoardOn does).
  if (!hadProjectKey) delete def.project_id;
  let r;
  try {
    r = await db.execute({
      sql: "UPDATE pi_bot_defs SET definition=?, project_id=?, updated_at=datetime('now') WHERE bot_id=? AND definition IS ? AND project_id IS ?",
      args: [JSON.stringify(def), toId, botId, row.definition ?? null, row.project_id ?? null],
    });
  } catch { r = null; }
  if (!r || Number(r.rowsAffected) === 0) { undoCarryOver(made); return { ok: false, code: "stale" }; }

  emitBotDefsChanged(botId);
  const payload = { from: fromId, to: toId, carry };
  for (const pid of fromId != null ? [fromId, toId] : [toId]) {
    await appendAudit(db, { project_id: pid, actor_type: actor, action: "bot.move", target: `bot:${botId}`, payload });
  }
  return { ok: true, carry };
}
