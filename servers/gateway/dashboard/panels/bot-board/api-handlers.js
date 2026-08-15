/**
 * Bot Board Panel — POST API Handlers
 *
 * Handles move, tracker_move, peer_toggle, and fallback POST actions.
 * peer_toggle is federation boundary code — moved byte-for-byte, no i18n.
 */

import { createDbClient } from "../../../../db.js";
import { setPeerBotEnabled } from "../../../bot-federation-client.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { TASKS_DB } from "./data-queries.js";
import { getItem, moveCard, moveItem } from "../../../board/card-service.js";

// Track 1: every dashboard-originated write is attributed to this actor
// (D-T1.3 provenance; brief-pinned shape).
const DASHBOARD_ACTOR = { kind: "human", id: null, jobId: null };

export async function handleBotBoardPost(req, res, { db }) {
  const b = req.body || {};

  if (b.action === "move") {
    const botQ = b.bot ? `?bot=${encodeURIComponent(String(b.bot))}` : (b.project ? `?project=${encodeURIComponent(String(b.project))}` : "");
    const cardId = Number(b.card_id);
    const status = String(b.status || "");
    if (!Number.isInteger(cardId) || !status) {
      return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
    }
    // THE single card/item writer (Track 1): moveCard applies the card
    // predicate (board_id IS NULL — a tracker-item id here 404s rather than
    // silently moving the wrong row, D-T1.8), validates against the card's
    // resolved board def, checks BOTH lock rails (routes/board-lock.js via
    // card-service), and records provenance. Not re-derived here.
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      await moveCard(tdb, db, cardId, status, DASHBOARD_ACTOR);
    } catch (e) {
      const code = e && e.code;
      if (code === "locked" || code === "archived") {
        return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=locked`);
      }
      if (code === "not_found" || code === "bad_status") {
        return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
      }
      return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=move_failed`);
    } finally {
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
    return res.redirectAfterPost(`/dashboard/bot-board${botQ}`);
  }

  // ---- no-JS status-move: tracker (action=tracker_move) ----
  if (b.action === "tracker_move") {
    const botQ = b.bot ? `?bot=${encodeURIComponent(String(b.bot))}` : "";
    const itemId = Number(b.item_id);
    const status = String(b.status || "");
    if (!Number.isInteger(itemId) || !status) {
      return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
    }
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      // moveItem (card-service, Task 2) has no lease/lock opinion — that rail
      // is item-side only (no bot_sessions/bot_jobs row exists for a tracker
      // item), so the lease check stays here, BEFORE the service call, same
      // as force-clear-lease's precedent.
      const cur = await getItem(tdb, itemId);
      if (!cur) return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
      if (String(cur.processing_lease_status) === "in-progress") {
        return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=locked`);
      }
      await moveItem(tdb, itemId, status, DASHBOARD_ACTOR);
    } catch (e) {
      const code = e && e.code;
      if (code === "archived") return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=locked`);
      if (code === "not_found" || code === "bad_status") {
        return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
      }
      return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=move_failed`);
    } finally {
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
    return res.redirectAfterPost(`/dashboard/bot-board${botQ}`);
  }

  // ---- F4a L3: remote enable/disable a manageable peer bot ----
  // FEDERATION BOUNDARY CODE: byte-for-byte move, no i18n inside (spec rule 5).
  // The "ok" token is compared on the GET side (q.peer === "ok") — must stay frozen.
  if (b.action === "peer_toggle") {
    const instanceId = b.instance_id, botId = b.bot_id;
    const r = await setPeerBotEnabled({
      db, sourceInstanceId: getOrCreateLocalInstanceId(), instanceId, botId,
      enabled: b.enabled === "1" ? 1 : 0, actor: "dashboard",
    });
    const msg = r.ok ? "ok" : (r.error || (r.body && r.body.error) || "failed");
    return res.redirectAfterPost(`/dashboard/bot-board?peer=${encodeURIComponent(msg)}`);
  }

  // Fallback redirect for unknown POST actions
  const fallbackQ = b.bot ? `?bot=${encodeURIComponent(String(b.bot))}` : "";
  return res.redirectAfterPost(`/dashboard/bot-board${fallbackQ}`);
}
