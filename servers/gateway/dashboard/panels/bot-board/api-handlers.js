/**
 * Bot Board Panel — POST API Handlers
 *
 * Handles move, tracker_move, peer_toggle, and fallback POST actions.
 * peer_toggle is federation boundary code — moved byte-for-byte, no i18n.
 */

import { createDbClient } from "../../../../db.js";
import { setPeerBotEnabled } from "../../../../bot-federation-client.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { TASKS_DB, CARD_STATUSES, LOCK_STATUSES } from "./data-queries.js";

export async function handleBotBoardPost(req, res, { db }) {
  const b = req.body || {};

  if (b.action === "move") {
    const botQ = b.bot ? `?bot=${encodeURIComponent(String(b.bot))}` : (b.project ? `?project=${encodeURIComponent(String(b.project))}` : "");
    const cardId = Number(b.card_id);
    const status = String(b.status || "");
    if (!Number.isInteger(cardId) || !CARD_STATUSES.includes(status)) {
      return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
    }
    let locked = false;
    try {
      const lr = (await db.execute({
        sql: "SELECT status FROM bot_sessions WHERE card_id=? ORDER BY id DESC LIMIT 1",
        args: [cardId],
      })).rows[0];
      locked = lr && LOCK_STATUSES.has(String(lr.status));
    } catch { locked = false; }
    if (locked) return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=locked`);
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const done = status === "done" || status === "cancelled";
      await tdb.execute({
        sql:
          "UPDATE tasks_items SET status=?, updated_at=datetime('now'), " +
          "completed_at=" + (done ? "datetime('now')" : "NULL") + " WHERE id=?",
        args: [status, cardId],
      });
    } catch {
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
    let cdb;
    try {
      cdb = createDbClient();
      // Check lock
      const cur = (await cdb.execute({
        sql: "SELECT processing_lease_status, tracker_id FROM tracker_items WHERE id=?",
        args: [itemId],
      })).rows[0];
      if (!cur) return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
      if (String(cur.processing_lease_status) === "in-progress") {
        return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=locked`);
      }
      // Validate status against tracker_defs.status_values
      const tdef = (await cdb.execute({
        sql: "SELECT status_values FROM tracker_defs WHERE id=?",
        args: [cur.tracker_id],
      })).rows[0];
      if (tdef) {
        const allowed = JSON.parse(tdef.status_values || "[]");
        if (!allowed.includes(status)) {
          return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
        }
      }
      await cdb.execute({
        sql: "UPDATE tracker_items SET status=?, updated_at=datetime('now') WHERE id=?",
        args: [status, itemId],
      });
    } catch {
      return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=move_failed`);
    } finally {
      if (cdb) { try { cdb.close(); } catch { /* already closed */ } }
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
