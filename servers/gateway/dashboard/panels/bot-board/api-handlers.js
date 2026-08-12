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
import { isCardLocked } from "../../../routes/board-lock.js";
import { resolveBoardDef, isValidStatus, isTerminal } from "../../../routes/board-defs.js";

export async function handleBotBoardPost(req, res, { db }) {
  const b = req.body || {};

  if (b.action === "move") {
    const botQ = b.bot ? `?bot=${encodeURIComponent(String(b.bot))}` : (b.project ? `?project=${encodeURIComponent(String(b.project))}` : "");
    const cardId = Number(b.card_id);
    const status = String(b.status || "");
    if (!Number.isInteger(cardId) || !status) {
      return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
    }
    // BOTH rails (routes/board-lock.js). A session-only check let an operator
    // drop a card into done/cancelled while its job was still running — and the
    // bot's own later tasks_* write would then race that move. This is the same
    // predicate the JSON API and the board render use; it is not re-derived.
    let locked = false;
    try { locked = await isCardLocked(db, cardId); } catch { locked = false; }
    if (locked) return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=locked`);
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const cur = (await tdb.execute({ sql: "SELECT status, project_id FROM tasks_items WHERE id=?", args: [cardId] })).rows[0];
      if (!cur) return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
      // Validated against the card's RESOLVED BOARD DEF — same rule as the
      // JSON API (routes/board-defs.js), not re-derived here.
      const def = await resolveBoardDef(tdb, { projectId: cur.project_id });
      if (!isValidStatus(def, status)) {
        return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
      }
      // Same TRANSITION rule as the JSON API: stamp on entering a terminal,
      // clear on leaving one, untouched otherwise (a terminal→terminal move
      // must not refresh the original completion time).
      const sets = ["status=?", "updated_at=datetime('now')"];
      if (isTerminal(def, status) && !isTerminal(def, String(cur.status))) sets.push("completed_at=datetime('now')");
      else if (!isTerminal(def, status) && isTerminal(def, String(cur.status))) sets.push("completed_at=NULL");
      await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id=?`, args: [status, cardId] });
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
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      // Check lock
      const cur = (await tdb.execute({
        sql: "SELECT processing_lease_status, board_id FROM tasks_items WHERE id=?",
        args: [itemId],
      })).rows[0];
      if (!cur) return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
      if (String(cur.processing_lease_status) === "in-progress") {
        return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=locked`);
      }
      // Validate status against board_defs.status_values
      const tdef = (await tdb.execute({
        sql: "SELECT status_values FROM board_defs WHERE id=?",
        args: [cur.board_id],
      })).rows[0];
      if (tdef) {
        const allowed = JSON.parse(tdef.status_values || "[]");
        if (!allowed.includes(status)) {
          return res.redirectAfterPost(`/dashboard/bot-board${botQ}${botQ ? "&" : "?"}err=bad_move`);
        }
      }
      await tdb.execute({
        sql: "UPDATE tasks_items SET status=?, updated_at=datetime('now') WHERE id=?",
        args: [status, itemId],
      });
    } catch {
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
