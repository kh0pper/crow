/**
 * Bot Board Panel — Data Queries
 *
 * Constants, DB helpers, and bot-definition utilities for the bot-board panel.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createDbClient } from "../../../../db.js";
import { tasksDbPath } from "../../../../../scripts/pi-bots/instance-paths.mjs";
import { getPeerCapabilities } from "../../../capabilities-cache.js";
import { getTrustedInstances } from "../nest/data-queries.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";

export const TASKS_DB = tasksDbPath();

export const CARD_STATUSES = ["pending", "in_progress", "done", "cancelled"];

// STATUS_LABEL: keys are logic/routing values (frozen); values are i18n keys
// resolved via t() at use sites (spec rule 3 blessed shape — W4-3 i18n sweep).
export const STATUS_LABEL = { pending: "Pending", in_progress: "In Progress", done: "Done", cancelled: "Cancelled" };
export const STATUS_BADGE = { pending: "draft", in_progress: "info", done: "connected", cancelled: "draft" };

export const LOCK_STATUSES = new Set(["active", "waiting-user"]);

// F4a: best-effort federated peer bots. Budgeted; a slow/offline peer is skipped.
export async function gatherPeerBots(db) {
  let peers = [];
  try { peers = await getTrustedInstances(db); } catch { return []; }
  if (!peers.length) return [];
  const localId = getOrCreateLocalInstanceId();
  const settled = await Promise.allSettled(
    peers.filter((p) => p.id !== localId).map((p) => getPeerCapabilities(db, p.id, { source: "bot-board" }))
  );
  const out = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value || s.value.status !== "ok") continue;
    const inst = s.value.instance || {};
    for (const b of (s.value.capabilities?.bots || [])) {
      out.push({ ...b, instanceId: s.value.instanceId, instanceName: inst.name || s.value.instanceId || "(unknown)" });
    }
  }
  return out;
}

// pi_bot_defs is MPA-only; absent on the primary gateway. Mirrors
// bot-builder.js::tableMissing — never throws, never opens tasks.db there.
export async function tableMissing(db) {
  try {
    await db.execute({ sql: "SELECT 1 FROM pi_bot_defs LIMIT 1", args: [] });
    return false;
  } catch {
    return true;
  }
}

// Lock map for a set of card ids — ONE batched query (the SSE tick uses the
// same shape; design D5 / plan Step 2: never a per-card LIMIT-1 loop). The
// predicate is identical to the single-card form: the MAX(id) bot_sessions
// row for a card_id with status in {active,waiting-user} => locked.
export async function lockMapFor(db, cardIds) {
  const ids = cardIds.filter((n) => Number.isInteger(n));
  if (!ids.length) return new Map();
  const ph = ids.map(() => "?").join(",");
  let rows = [];
  try {
    rows = (await db.execute({
      sql:
        `SELECT card_id, status FROM bot_sessions ` +
        `WHERE id IN (SELECT MAX(id) FROM bot_sessions WHERE card_id IN (${ph}) GROUP BY card_id)`,
      args: ids,
    })).rows || [];
  } catch {
    // bot_sessions absent / transient — treat as no locks (caller still
    // gates writes server-side in the API; this only affects UI affordance).
    return new Map();
  }
  const m = new Map();
  for (const r of rows) m.set(Number(r.card_id), LOCK_STATUSES.has(String(r.status)));
  return m;
}

// Derive the plan-file path for a card the same way the bridge does
// (bridge.mjs:151-152 — `def.session_dir + "/plans/" + cardId + ".md"`),
// resolving the owning bot as the first pi_bot_defs row whose project_id
// (column, M3b — was: definition.project_id JSON) matches the card's
// project. Single-bot-per-project is the live reality; deterministic
// lowest-bot_id pick otherwise. Returns { path, sessionDir } or null.
// Read-only here; the realpath-containment assertion is enforced (cardId
// is integer-cast, session_dir from trusted DB) so a crafted route param
// cannot escape the workspace.
export async function derivePlanPath(db, card) {
  if (card.project_id == null) return null;
  let defs = [];
  try {
    defs = (await db.execute({
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
      const path = sessionDir + "/plans/" + Number(card.id) + ".md";
      return { path, sessionDir };
    }
  }
  return null;
}

export function readPlan(planInfo) {
  if (!planInfo || !existsSync(planInfo.path)) return { exists: false, text: "", mtime: "" };
  try {
    // Containment: resolved realpath must live under the bot's session_dir.
    const real = realpathSync(planInfo.path);
    const rootReal = realpathSync(planInfo.sessionDir);
    if (real !== rootReal && !real.startsWith(rootReal + "/")) return { exists: false, text: "", mtime: "" };
    const mtime = String(statSync(planInfo.path).mtimeMs);
    return { exists: true, text: readFileSync(planInfo.path, "utf8"), mtime };
  } catch {
    return { exists: false, text: "", mtime: "" };
  }
}

// ---- Resolve bot info from pi_bot_defs ----
export function parseBotDef(row) {
  let def = {};
  try { def = JSON.parse(row.definition || "{}"); } catch { /* */ }
  const tc = def.tracker_config || {};
  const trackerType = tc.type || "kanban";
  const trackerSlug = tc.tracker_slug || null;
  return {
    botId: row.bot_id,
    displayName: row.display_name || row.bot_id,
    projectId: row.project_id,
    trackerType,
    trackerSlug,
    definition: def,
  };
}
