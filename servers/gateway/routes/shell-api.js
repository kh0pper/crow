/**
 * shell-api.js — the shell's own routes: move an item between projects, and
 * move a Board card between lanes.
 *
 *   POST /dashboard/shell-api/items/:kind/:ref/project  { project_id: number | "unassigned" }
 *     -> { ok: true, project_id: number | null }
 *
 *   POST /dashboard/shell-api/cards/:id/lane  { to, from }   (lanes: panels/board/lanes.js)
 *     -> 200 { ok: true, lane }               the move's one real write is done
 *        409 { error: "stale", lane }         the card is no longer in `from`
 *        409 { error: "refused", reason }     no real write expresses this move
 *     A lane is derived state: the server recomputes it from stored card,
 *     result, decision and lock state (the panel's laneOf inputs), then runs
 *     movePlan's one write: moveCard, acceptResult (approve + done), or
 *     updateCard clearing action_needed.
 *
 * MOUNT: `/dashboard/shell-api`, `router.use(P, dashboardAuth)` as the first
 * statement, mounted in dashboard/index.js AFTER csrfMiddleware (the real CSRF
 * rail) and never public. All SQL on shell_items lives in shared/shell-items.js.
 *
 * The item must exist, so a typo never leaves a phantom row: a thread needs a
 * perch-live bot_sessions row, an artifact a live artifacts row. A Workspace file is only
 * checked for the bundle being installed and the id being a positive integer;
 * the core cannot reach the bundle's own store, so the real existence check
 * lands with the Workspace work in P4.
 */
import { Router } from "express";
import { join } from "node:path";
import { homedir } from "node:os";
import { jsonError } from "./_error.js";
import { createDbClient } from "../../db.js";
import { ITEM_KINDS, setItemProject } from "../../shared/shell-items.js";
import { installedBundleIds } from "../skills-catalog.js";
import { existsSync } from "node:fs";
import { TASKS_DB } from "../dashboard/panels/bot-board/data-queries.js";
import { lockMapFor } from "./board-lock.js";
import { resolveBoardDef } from "./board-defs.js";
import { getCard, moveCard, updateCard } from "../board/card-service.js";
import { acceptResult } from "../board/result-service.js";
import { LANES, laneOf, movePlan } from "../dashboard/panels/board/lanes.js";

const DASHBOARD_ACTOR = Object.freeze({ kind: "human", id: null, jobId: null });

/** The card's newest board_results row as { id, status }, or null (none yet, or a pre-0004 store). */
async function latestResultOf(tdb, id) {
  try {
    const r = (await tdb.execute({
      sql: "SELECT id, status FROM board_results WHERE item_id=? ORDER BY id DESC LIMIT 1",
      args: [id],
    })).rows[0];
    return r ? { id: Number(r.id), status: String(r.status) } : null;
  } catch (err) {
    if (noTable(err)) return null;
    throw err;
  }
}

/**
 * Everything a lane decision reads, from stored state: the same laneOf
 * inputs as the Board panel (status, latest result status, action_needed,
 * data_json, and the lock map keyed by Number id). Null for a card that is
 * missing, archived or a tracker item.
 */
export async function laneState(tdb, cdb, id) {
  const card = await getCard(tdb, id);
  if (!card || card.archived_at != null) return null;
  const def = await resolveBoardDef(tdb, { projectId: card.project_id == null ? null : Number(card.project_id) });
  const latestResult = await latestResultOf(tdb, id);
  const locked = (await lockMapFor(cdb, [id])).get(id) === true;
  const lane = laneOf({ ...card, latest_result_status: latestResult ? latestResult.status : null }, def, { locked });
  return { card, def, latestResult, locked, lane };
}

/**
 * Run a movePlan's one write, guarded on the state `st` it was planned from
 * (Ruling P10): a move carries the status read (moveCard expectStatus), a
 * clear_ask the action_needed read (updateCard expect), and an accept the
 * newest-result check inside its UPDATE (acceptResult). If the card changed
 * after the read, in this process or another, the write changes nothing and
 * throws 409 'stale'. A refuse or none plan writes nothing.
 */
export async function applyLanePlan(tdb, cdb, id, st, plan, actor = DASHBOARD_ACTOR) {
  if (plan.action === "move") {
    await moveCard(tdb, cdb, id, plan.status, actor, { expectStatus: String(st.card.status) });
  } else if (plan.action === "accept") {
    await acceptResult(tdb, cdb, id, plan.resultId, actor, "dashboard");
  } else if (plan.action === "clear_ask") {
    await updateCard(tdb, id, { action_needed: null }, actor, { expect: { action_needed: st.card.action_needed ?? null } });
  }
}

// One lane move per card at a time in this process, so a second drop of the
// same card reads the first one's result and gets a clean `stale` before any
// write. Correctness does not rest on it: the writes themselves are guarded
// on the state read (applyLanePlan), which also covers other processes.
const cardQueues = new Map();
function serialized(id, fn) {
  const prev = cardQueues.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  cardQueues.set(id, tail);
  tail.then(() => { if (cardQueues.get(id) === tail) cardQueues.delete(id); });
  return run;
}

const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const noTable = (err) => /no such table/i.test(String(err?.message || err));

async function exists(db, sql, args) {
  try {
    const { rows } = await db.execute({ sql, args });
    return rows.length > 0;
  } catch (err) {
    if (noTable(err)) return false;
    throw err;
  }
}

async function itemExists(db, kind, ref) {
  if (kind === "perch_thread") {
    return exists(db, "SELECT 1 FROM bot_sessions WHERE gateway_thread_id = ? AND kind = 'perch-live' LIMIT 1", [ref]);
  }
  if (kind === "artifact") {
    return exists(db, "SELECT 1 FROM artifacts WHERE id = ? AND deleted_at IS NULL LIMIT 1", [ref]);
  }
  // workspace_file: installed bundle only (existence check moves to P4).
  const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
  return installedBundleIds(crowHome).includes("workspace");
}

export function shellApiRouter(dashboardAuth) {
  const router = Router();
  const P = "/dashboard/shell-api";
  router.use(P, dashboardAuth);

  router.post(P + "/items/:kind/:ref/project", async (req, res) => {
    const kind = String(req.params.kind);
    const ref = String(req.params.ref);
    if (!ITEM_KINDS.includes(kind) || !REF_RE.test(ref)) return jsonError(res, 400, "bad_request");
    if (kind === "workspace_file" && !/^[1-9]\d*$/.test(ref)) return jsonError(res, 400, "bad_request");

    const raw = req.body && typeof req.body === "object" ? req.body.project_id : undefined;
    let projectId;
    if (raw === "unassigned") projectId = null;
    else if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) projectId = raw;
    else if (typeof raw === "string" && /^[1-9]\d*$/.test(raw)) projectId = Number(raw);
    else return jsonError(res, 400, "bad_request");

    const db = createDbClient();
    try {
      if (!(await itemExists(db, kind, ref))) return jsonError(res, 404, "not_found");
      await setItemProject(db, kind, ref, projectId, { setBy: "operator" });
      res.json({ ok: true, project_id: projectId });
    } catch (err) {
      if (err && err.name === "AclError") {
        if (err.code === "not_found") return jsonError(res, 404, "not_found");
        if (err.code === "archived") return jsonError(res, 409, "archived");
      }
      if (err && err.code === "not_migrated") return jsonError(res, 503, "not_migrated");
      if (err && err.code === "bad_kind") return jsonError(res, 400, "bad_request");
      console.warn("[shell-api] move failed:", err.message);
      jsonError(res, 500, "move failed");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  router.post(P + "/cards/:id/lane", async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (!/^[1-9]\d*$/.test(String(req.params.id)) || !LANES.includes(b.to) || !LANES.includes(b.from)) {
      return jsonError(res, 400, "bad_request");
    }
    if (!existsSync(TASKS_DB)) return jsonError(res, 404, "not_found");

    await serialized(id, async () => {
      let tdb, cdb;
      try {
        tdb = createDbClient(TASKS_DB);
        cdb = createDbClient();
        const st = await laneState(tdb, cdb, id);
        if (!st) return jsonError(res, 404, "not_found");
        if (st.lane !== b.from) return jsonError(res, 409, "stale", { lane: st.lane });

        const plan = movePlan(st.card, st.def, { locked: st.locked, latestResult: st.latestResult }, b.to);
        if (plan.action === "refuse") return jsonError(res, 409, "refused", { reason: plan.reason });
        await applyLanePlan(tdb, cdb, id, st, plan);

        const after = await laneState(tdb, cdb, id);
        res.json({ ok: true, lane: after ? after.lane : b.to });
      } catch (err) {
        // A write the state check could not foresee: someone else got there
        // first (a decision, a lock, an archive). Tell the client where the
        // card is now; it re-renders from that.
        if (err && err.http === 409) {
          if (err.code === "locked") return jsonError(res, 409, "refused", { reason: "locked" });
          let lane = null;
          try { lane = (await laneState(tdb, cdb, id))?.lane ?? null; } catch { /* report without a lane */ }
          return jsonError(res, 409, "stale", { lane });
        }
        if (err && err.http === 404) return jsonError(res, 404, "not_found");
        if (err && err.http === 400) return jsonError(res, 400, "bad_request");
        if (noTable(err)) return jsonError(res, 503, "not_migrated");
        console.warn("[shell-api] lane move failed:", err && err.message);
        jsonError(res, 500, "move failed");
      } finally {
        if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
        if (cdb) { try { cdb.close(); } catch { /* already closed */ } }
      }
    });
  });

  return router;
}
