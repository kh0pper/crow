/**
 * Bot Board Panel — Data Queries
 *
 * Constants, DB helpers, and bot-definition utilities for the bot-board panel.
 */

import { createDbClient } from "../../../../db.js";
import { tasksDbPath } from "../../../../../scripts/pi-bots/instance-paths.mjs";
import { getPeerCapabilities } from "../../capabilities-cache.js";
import { getTrustedInstances } from "../nest/data-queries.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { t } from "../../shared/i18n.js";
import { SESSION_LOCK_STATUSES, lockMapFor as sharedLockMapFor } from "../../../routes/board-lock.js";

export const TASKS_DB = tasksDbPath();

// STATUS_LABEL: keys are frozen logic/routing values; values are the EN display
// strings used as i18n key lookup suffixes via statusLabel(status, lang).
// The status vocabulary itself lives in routes/board-defs.js (DEFAULT_BOARD_DEF
// for the builtin board; board_defs rows otherwise) — do not re-declare it.
export const STATUS_LABEL = { pending: "Pending", in_progress: "In Progress", done: "Done", cancelled: "Cancelled" };
export const STATUS_BADGE = { pending: "draft", in_progress: "info", done: "connected", cancelled: "draft" };

// Map a CARD_STATUSES value to its display label in the given language.
// Falls back to the frozen EN string so callers are always safe.
const STATUS_KEY = { pending: "botboard.statusPending", in_progress: "botboard.statusInProgress", done: "botboard.statusDone", cancelled: "botboard.statusCancelled" };
export function statusLabel(status, lang) {
  const key = STATUS_KEY[status];
  return key ? t(key, lang) : (STATUS_LABEL[status] || status);
}

// Re-export of the session-rail statuses from THE shared predicate — this file
// used to declare its own copy. Prefer isCardLocked/lockMapFor over comparing
// statuses by hand: a card is also locked by an unfinished bot_jobs row, which
// no bot_sessions status can express.
export const LOCK_STATUSES = SESSION_LOCK_STATUSES;

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

// Lock map for a set of card ids — batched (the SSE tick uses the same shape;
// design D5 / plan Step 2: never a per-card LIMIT-1 loop). The predicate is
// LITERALLY the single-card form now: this delegates to routes/board-lock.js,
// which is the only place either rail is defined. It stopped being identical
// once when the job rail was taught to the API and not to this file, and the
// board drew job-locked cards as unlocked and draggable while every API write
// on them 409'd. Delegation is what makes the claim enforceable.
export async function lockMapFor(db, cardIds) {
  return sharedLockMapFor(db, cardIds);
}

// derivePlanPath/readPlan (the plan-FILE rail) retired Track 1 (D-T1.7): the
// no-JS card view now reads plan RECORDS via plan-service.getCurrentPlan —
// see html.js's renderKanbanBoard &card=M branch. Nothing else imported them.

// ---- Track 3 Task 11: engine-sourced bird state (spec §3.2, §5.6) ----
//
// A session carrying `pendingUi` is the loudest state a bird can be in
// (a human is waited on); an awake session with no pending card is
// "working"; a parked-but-resumable child is "hibernating". A session this
// process has never seen as awake AND with nothing in the DB but 'stopped'
// carries no bird at all — callers treat null as "this session draws
// nothing", never as "idle" (idle is a BOT-level default for zero live
// sessions, decided by the caller, not this function).
export function sessionBirdState(session) {
  if (!session) return null;
  if (session.pendingUi) return "waiting";
  if (session.state === "awake") return "working";
  if (session.state === "hibernating") return "hibernating";
  return null;
}

// waiting-on-you > working > hibernating (spec §3.2) — the SAME ordering
// routes/perch.js's /roost endpoint uses to fold a bot's several sessions
// down to one strip glyph.
const BIRD_STATE_PRIORITY = { waiting: 3, working: 2, hibernating: 1 };

// Collapse several sessions' fold states to the single most attention-worthy
// one. Skips nulls; an all-null (or empty) input folds to null.
export function foldBirdStates(states) {
  let best = null;
  for (const s of states) {
    if (s && (!best || (BIRD_STATE_PRIORITY[s] || 0) > (BIRD_STATE_PRIORITY[best] || 0))) best = s;
  }
  return best;
}

// Card-bound live sessions, one entry per occupied card: Map<cardId,
// {botId, state, sessionId}>. The board SSR join (html.js) and the board SSE
// tick (routes/streams.js) both call this so the two never fold the engine's
// state differently — engine-sourced, not DB-derivable (spec §5.6: an
// awake-at-rest, hibernated, or interrupted row can all read the same DB
// status). `engine.list()`'s in-memory sessions carry `cardId` (from its own
// snapshot()); its DB-fallback entries — another process's hibernating rows —
// do not set the key at all, so those are backfilled here from bot_sessions,
// one IN-list query total, never a per-session lookup.
export async function liveBirdsByCard(engine, db) {
  const map = new Map();
  if (!engine) return map;
  let sessions = [];
  try {
    sessions = await engine.list();
  } catch {
    return map;
  }
  const missingIds = sessions.filter((s) => s.cardId === undefined).map((s) => s.sessionId);
  const rowCardById = new Map();
  if (missingIds.length && db) {
    try {
      const ph = missingIds.map(() => "?").join(",");
      const { rows } = await db.execute({
        sql: `SELECT gateway_thread_id, card_id FROM bot_sessions WHERE kind='perch-live' AND gateway_thread_id IN (${ph})`,
        args: missingIds,
      });
      for (const r of rows) rowCardById.set(String(r.gateway_thread_id), r.card_id);
    } catch {
      // bot_sessions absent / transient — those sessions just get no card_id.
    }
  }
  for (const s of sessions) {
    const state = sessionBirdState(s);
    if (!state) continue;
    const rawCardId = s.cardId !== undefined ? s.cardId : rowCardById.get(s.sessionId);
    if (rawCardId == null) continue;
    const cid = Number(rawCardId);
    if (!Number.isInteger(cid)) continue;
    const existing = map.get(cid);
    if (!existing || (BIRD_STATE_PRIORITY[state] || 0) > (BIRD_STATE_PRIORITY[existing.state] || 0)) {
      map.set(cid, { botId: s.botId, state, sessionId: s.sessionId });
    }
  }
  return map;
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
