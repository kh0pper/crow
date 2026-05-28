/**
 * Bot Board Panel — Crow Bot Builder (unified bot-centric board).
 *
 * A dedicated, full-width, bot-centric board (refactored from the project-
 * centric Phase 4 design). SSR-first (works without JS: bot switcher = GET
 * form, status moves = form-POST to this route, drawer degrades to a
 * dedicated `&card=M` card page), with a native-EventSource live overlay
 * layered on top:
 *
 *   - Each enabled bot in pi_bot_defs resolves to a tracker type via
 *     definition.tracker_config.type (default: "kanban").
 *   - kanban/task-list bots: cards = tasks.db `tasks_items` filtered by
 *     project_id (cross-DB soft link; opened via createDbClient(TASKS_DB)).
 *   - custom tracker bots: items = crow.db `tracker_items` filtered by
 *     bot_id, rendered with dynamic columns from tracker_defs.
 *   - none: informational message, no board.
 *
 * Whole-card single-writer lock (design D5) for kanban; processing_lease
 * lock for tracker items. All mutations go to bot-board-api.js; the no-JS
 * move paths post to THIS route and 303-redirect.
 *
 * DEFENSIVE: pi_bot_defs exists only on the MPA instance's crow.db. On the
 * primary gateway this panel falls through the same notAvail notice.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { escapeHtml, section, badge } from "../shared/components.js";
import { createDbClient } from "../../../db.js";

const HOME = "/home/kh0pp";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const CARD_STATUSES = ["pending", "in_progress", "done", "cancelled"];
const STATUS_LABEL = { pending: "Pending", in_progress: "In Progress", done: "Done", cancelled: "Cancelled" };
const STATUS_BADGE = { pending: "draft", in_progress: "info", done: "connected", cancelled: "draft" };
const LOCK_STATUSES = new Set(["active", "waiting-user"]);

// pi_bot_defs is MPA-only; absent on the primary gateway. Mirrors
// bot-builder.js::tableMissing — never throws, never opens tasks.db there.
async function tableMissing(db) {
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
async function lockMapFor(db, cardIds) {
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
async function derivePlanPath(db, card) {
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

function readPlan(planInfo) {
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

function cardFaceHtml(card, locked) {
  const prio = card.priority == null ? "" :
    `<span class="bb-prio bb-prio-${escapeHtml(String(card.priority))}" title="priority ${escapeHtml(String(card.priority))}">P${escapeHtml(String(card.priority))}</span>`;
  const due = card.due_date ? `<span class="bb-meta">⏱ ${escapeHtml(String(card.due_date))}</span>` : "";
  const owner = card.owner ? `<span class="bb-meta">👤 ${escapeHtml(String(card.owner))}</span>` : "";
  const tags = card.tags
    ? `<div class="bb-tags">${String(card.tags).split(",").map((s) => s.trim()).filter(Boolean)
        .map((tg) => `<span class="bb-tag">${escapeHtml(tg)}</span>`).join("")}</div>`
    : "";
  const sub = card.parent_id != null
    ? `<div class="bb-sub">↳ subtask of #${escapeHtml(String(card.parent_id))}</div>` : "";
  const lockBadge = locked
    ? `<span class="bb-lock" title="a bot is working this card — read-only">🔒 bot working</span>` : "";
  return `<div class="bb-card${locked ? " bb-locked" : ""}" draggable="${locked ? "false" : "true"}" ` +
    `data-card="${escapeHtml(String(card.id))}" data-status="${escapeHtml(String(card.status))}" ` +
    `data-locked="${locked ? "1" : "0"}" tabindex="0" role="button" ` +
    `aria-label="card ${escapeHtml(String(card.id))}: ${escapeHtml(String(card.title || ""))}">` +
    `<div class="bb-card-top">${prio}<span class="bb-id">#${escapeHtml(String(card.id))}</span>${lockBadge}</div>` +
    `<div class="bb-title">${escapeHtml(String(card.title || "(untitled)"))}</div>` +
    `<div class="bb-card-meta">${due}${owner}</div>${tags}${sub}` +
    `<form method="POST" action="/dashboard/bot-board" class="bb-nojs-move">` +
    `<input type="hidden" name="action" value="move">` +
    `<input type="hidden" name="card_id" value="${escapeHtml(String(card.id))}">` +
    `<input type="hidden" name="project" value="${escapeHtml(String(card.project_id == null ? "" : card.project_id))}">` +
    CARD_STATUSES.filter((s) => s !== card.status).map((s) =>
      `<button type="submit" name="status" value="${s}" ${locked ? "disabled" : ""} ` +
      `title="move to ${STATUS_LABEL[s]}">${escapeHtml(STATUS_LABEL[s])}</button>`).join("") +
    `</form></div>`;
}

function trackerCardFaceHtml(item, contextFields, statusValues, locked) {
  const prio = item.priority == null ? "" :
    `<span class="bb-prio bb-prio-${escapeHtml(String(item.priority))}" title="priority ${escapeHtml(String(item.priority))}">P${escapeHtml(String(item.priority))}</span>`;
  const lockBadge = locked
    ? `<span class="bb-lock" title="a bot is processing this item — read-only">🔒 processing</span>` : "";

  // Extract metadata from data_json for context fields (skip "label" and "status")
  let data = {};
  try { data = JSON.parse(item.data_json || "{}"); } catch { data = {}; }
  const searchParts = [item.label || "", item.status || ""];
  for (const v of Object.values(data)) {
    if (v != null && v !== "") searchParts.push(typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  if (item.action_needed) searchParts.push(String(item.action_needed));
  const searchText = searchParts.join(" ").toLowerCase();
  const metaParts = [];
  for (const cf of contextFields) {
    const key = typeof cf === "string" ? cf : (cf.key || cf.name || "");
    if (!key || key === "label" || key === "status") continue;
    const val = data[key];
    if (val != null && val !== "") {
      const displayKey = typeof cf === "object" && cf.label ? cf.label : key;
      metaParts.push(`<span class="bb-meta">${escapeHtml(String(displayKey))}: ${escapeHtml(String(val))}</span>`);
    }
  }
  const metaHtml = metaParts.length
    ? `<div class="bb-card-meta">${metaParts.join("")}</div>` : "";

  const actionHtml = item.action_needed
    ? `<div class="bb-sub" style="color:#b8860b">⚠ ${escapeHtml(String(item.action_needed))}</div>` : "";

  // No-JS move buttons using dynamic statusValues
  const moveButtons = statusValues.filter((s) => s !== item.status).map((s) =>
    `<button type="submit" name="status" value="${escapeHtml(s)}" ${locked ? "disabled" : ""} ` +
    `title="move to ${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("");

  return `<div class="bb-card${locked ? " bb-locked" : ""}" draggable="${locked ? "false" : "true"}" ` +
    `data-card="${escapeHtml(String(item.id))}" data-status="${escapeHtml(String(item.status))}" ` +
    `data-locked="${locked ? "1" : "0"}" data-item-type="tracker" ` +
    `data-search-text="${escapeHtml(searchText)}" data-action-needed="${item.action_needed ? "1" : "0"}" ` +
    `data-priority="${item.priority != null ? escapeHtml(String(item.priority)) : ""}" ` +
    `data-json="${escapeHtml(item.data_json || "{}")}" ` +
    `tabindex="0" role="button" ` +
    `aria-label="item ${escapeHtml(String(item.id))}: ${escapeHtml(String(item.label || ""))}">` +
    `<div class="bb-card-top">${prio}<span class="bb-id">#${escapeHtml(String(item.id))}</span>${lockBadge}</div>` +
    `<div class="bb-title">${escapeHtml(String(item.label || "(untitled)"))}</div>` +
    metaHtml + actionHtml +
    `<form method="POST" action="/dashboard/bot-board" class="bb-nojs-move">` +
    `<input type="hidden" name="action" value="tracker_move">` +
    `<input type="hidden" name="item_id" value="${escapeHtml(String(item.id))}">` +
    `<input type="hidden" name="bot" value="${escapeHtml(String(item.bot_id || ""))}">` +
    moveButtons +
    `</form></div>`;
}

const PAGE_CSS = `<style>
  .bb-switch{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  .bb-switch select,.bb-switch input{padding:.45rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary)}
  .bb-switch button{padding:.45rem .9rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:#fff;cursor:pointer}
  .bb-board{display:grid;grid-template-columns:repeat(var(--bb-cols,4),1fr);gap:.75rem;align-items:start;overflow-x:auto}
  .bb-col{background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);padding:.6rem;min-height:120px;min-width:140px}
  .bb-col.bb-dragover{border-color:var(--crow-accent);background:var(--crow-bg-elevated)}
  .bb-col h4{margin:.1rem 0 .6rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:var(--crow-text-muted);display:flex;justify-content:space-between}
  .bb-card{background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);padding:.55rem;margin-bottom:.5rem;cursor:pointer;transition:border-color .12s}
  .bb-card:hover{border-color:var(--crow-accent)}
  .bb-card.bb-locked{opacity:.85;cursor:not-allowed;border-style:dashed}
  .bb-card-top{display:flex;align-items:center;gap:.4rem;font-size:.72rem;color:var(--crow-text-muted)}
  .bb-id{font-family:'JetBrains Mono',monospace}
  .bb-title{font-weight:600;font-size:.9rem;margin:.25rem 0}
  .bb-card-meta{display:flex;gap:.6rem;flex-wrap:wrap}
  .bb-meta{font-size:.72rem;color:var(--crow-text-secondary)}
  .bb-tags{margin-top:.3rem;display:flex;gap:.25rem;flex-wrap:wrap}
  .bb-tag{font-size:.68rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);padding:0 .4rem;color:var(--crow-text-muted)}
  .bb-sub{font-size:.7rem;color:var(--crow-text-muted);margin-top:.25rem}
  .bb-lock{margin-left:auto;color:#b8860b;font-weight:600}
  .bb-prio{font-weight:700}.bb-prio-1,.bb-prio-2{color:#c0392b}.bb-prio-3{color:#b8860b}.bb-prio-4,.bb-prio-5{color:#888}
  .bb-nojs-move{display:flex;gap:.25rem;flex-wrap:wrap;margin-top:.4rem}
  .bb-nojs-move button{font-size:.66rem;padding:.15rem .4rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-secondary);cursor:pointer}
  body.bb-js .bb-nojs-move{display:none}
  .bb-drawer{position:fixed;top:0;right:0;height:100vh;width:min(480px,92vw);background:var(--crow-bg-surface);border-left:1px solid var(--crow-border);box-shadow:-8px 0 24px rgba(0,0,0,.3);transform:translateX(100%);transition:transform .18s ease;z-index:50;overflow-y:auto;padding:1rem}
  .bb-drawer.bb-open{transform:translateX(0)}
  .bb-drawer label{display:block;font-size:.75rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:.05em;margin:.7rem 0 .25rem}
  .bb-drawer input,.bb-drawer select,.bb-drawer textarea{width:100%;padding:.45rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary);font:inherit}
  .bb-drawer textarea{font-family:'JetBrains Mono',monospace;font-size:.82rem;min-height:220px}
  .bb-drawer .bb-row{display:flex;gap:.5rem}.bb-drawer .bb-row>*{flex:1}
  .bb-btn{padding:.45rem .9rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:#fff;cursor:pointer;margin:.5rem .4rem 0 0}
  .bb-btn.bb-sec{background:var(--crow-bg-elevated);color:var(--crow-text-secondary);border:1px solid var(--crow-border)}
  .bb-btn:disabled{opacity:.5;cursor:not-allowed}
  .bb-msg{font-size:.82rem;margin:.5rem 0;min-height:1.1em}
  .bb-msg.ok{color:#1a7f37}.bb-msg.err{color:#c0392b}.bb-msg.warn{color:#b8860b}
  .bb-pre{background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:6px;padding:.6rem;white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono',monospace;font-size:.82rem;max-height:340px;overflow:auto}
  .bb-filter-bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.6rem 0}
  .bb-search{flex:1;min-width:200px;padding:.45rem .7rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary);font:inherit;font-size:.85rem}
  .bb-search::placeholder{color:var(--crow-text-muted)}
  .bb-chips{display:flex;gap:.3rem;flex-wrap:wrap}
  .bb-chip{padding:.25rem .65rem;font-size:.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-secondary);cursor:pointer;transition:all .12s}
  .bb-chip:hover{border-color:var(--crow-accent)}
  .bb-chip-active{background:var(--crow-accent);border-color:var(--crow-accent);color:#fff}
  .bb-chip-action{border-color:#b8860b;color:#b8860b}
  .bb-chip-action.bb-chip-active{background:#b8860b;border-color:#b8860b;color:#fff}
  .bb-view-toggle{display:flex;gap:0;margin-left:auto}
  .bb-view-btn{padding:.25rem .65rem;font-size:.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);color:var(--crow-text-secondary);cursor:pointer;transition:all .12s}
  .bb-view-btn:first-child{border-radius:var(--crow-radius-pill) 0 0 var(--crow-radius-pill)}
  .bb-view-btn:last-child{border-radius:0 var(--crow-radius-pill) var(--crow-radius-pill) 0;border-left:none}
  .bb-view-btn-active{background:var(--crow-accent);border-color:var(--crow-accent);color:#fff}
  .bb-list-table{width:100%;border-collapse:collapse;font-size:.85rem}
  .bb-list-table th{text-align:left;padding:.4rem .6rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--crow-text-muted);border-bottom:2px solid var(--crow-border);cursor:pointer;user-select:none;white-space:nowrap}
  .bb-list-table th:hover{color:var(--crow-text-primary)}
  .bb-list-table th.bb-sort-asc::after{content:' \\25B2';font-size:.6rem}
  .bb-list-table th.bb-sort-desc::after{content:' \\25BC';font-size:.6rem}
  .bb-list-table td{padding:.4rem .6rem;border-bottom:1px solid var(--crow-border);vertical-align:top}
  .bb-list-table tr:hover td{background:var(--crow-bg-elevated)}
  .bb-list-table tbody tr{cursor:pointer}
  .bb-list-status{display:inline-block;padding:.1rem .45rem;font-size:.72rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill)}
  .bb-col-toggle{background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:.85rem;padding:0 .3rem;margin-left:.4rem;line-height:1}
  .bb-col-toggle:hover{color:var(--crow-text-primary)}
  .bb-col-collapsed .bb-col-body{display:none}
  .bb-col-collapsed{min-width:60px!important}
  .bb-td-field-row{margin:.4rem 0}
  .bb-td-field-label{display:block;font-size:.72rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.2rem}
  .bb-td-section{font-size:.8rem;color:var(--crow-text-primary);margin:1rem 0 .4rem;padding-bottom:.25rem;border-bottom:1px solid var(--crow-border)}
  .bb-td-link{display:block;font-size:.82rem;color:var(--crow-accent);text-decoration:none;margin:.3rem 0}
  .bb-td-link:hover{text-decoration:underline}
  .bb-td-readonly{font-size:.85rem;color:var(--crow-text-secondary)}
</style>`;

// ---- Resolve bot info from pi_bot_defs ----
function parseBotDef(row) {
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

export default {
  id: "bot-board",
  name: "Bot Board",
  icon: "project",
  route: "/dashboard/bot-board",
  navOrder: 15,
  category: "tools",

  async handler(req, res, { db, layout }) {
    const notAvail = await tableMissing(db);

    // ---- no-JS status-move: kanban (action=move) ----
    if (req.method === "POST" && !notAvail) {
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

      // Fallback redirect for unknown POST actions
      const fallbackQ = b.bot ? `?bot=${encodeURIComponent(String(b.bot))}` : "";
      return res.redirectAfterPost(`/dashboard/bot-board${fallbackQ}`);
    }

    if (notAvail) {
      return layout({
        title: "Bot Board",
        content: section("Bot Board",
          `<p>The <code>pi_bot_defs</code> / <code>bot_sessions</code> tables are not present on this instance.</p>` +
          `<p>The Bot Builder Kanban board runs on the MPA instance. Initialize with ` +
          `<code>node ~/crow/scripts/init-pi-bots.mjs</code> on the host whose crow.db this gateway uses.</p>`),
      });
    }

    const q = req.query || {};

    // ---- Bot list from pi_bot_defs ----
    let botRows = [];
    try {
      botRows = (await db.execute({
        sql: "SELECT bot_id, display_name, definition, enabled, project_id FROM pi_bot_defs WHERE enabled=1 ORDER BY bot_id",
        args: [],
      })).rows || [];
    } catch { botRows = []; }

    const bots = botRows.map(parseBotDef);

    // ---- Backwards compat: ?project=N -> find bot, redirect ----
    if (q.project != null && q.project !== "" && (q.bot == null || q.bot === "")) {
      const projId = Number(q.project);
      // Prefer kanban-type bots for this project
      const match = bots.find((b) => Number(b.projectId) === projId && (b.trackerType === "kanban" || b.trackerType === "task-list"))
        || bots.find((b) => Number(b.projectId) === projId);
      if (match) {
        return res.redirect(302, `/dashboard/bot-board?bot=${encodeURIComponent(match.botId)}`);
      }
      // No matching bot — fall through to show error below
    }

    // ---- Resolve selected bot ----
    const reqBot = q.bot != null && q.bot !== "" ? String(q.bot) : null;
    let selBot = null;
    if (reqBot != null) {
      selBot = bots.find((b) => b.botId === reqBot) || null;
    }
    if (!selBot && bots.length > 0 && reqBot == null) {
      selBot = bots[0]; // default to first enabled bot
    }

    // Error/notice messages
    const noticeBits = [];
    if (q.err === "locked") noticeBits.push(`<p class="bb-msg err">⚠️ That item is being worked by a bot — read-only.</p>`);
    else if (q.err === "bad_move") noticeBits.push(`<p class="bb-msg err">⚠️ Invalid status move.</p>`);
    else if (q.err === "move_failed") noticeBits.push(`<p class="bb-msg err">⚠️ Move failed.</p>`);
    if (reqBot != null && !selBot) {
      noticeBits.push(`<p class="bb-msg err">⚠️ Bot <code>${escapeHtml(reqBot)}</code> not found or disabled.</p>`);
    }
    const notice = noticeBits.join("");

    // ---- Bot switcher (GET form) ----
    const switcherOptions = bots.length
      ? bots.map((b) => {
          const typeLabel = b.trackerType === "custom" && b.trackerSlug
            ? `custom: ${escapeHtml(b.trackerSlug)}`
            : escapeHtml(b.trackerType);
          const selected = selBot && b.botId === selBot.botId ? " selected" : "";
          return `<option value="${escapeHtml(b.botId)}"${selected}>${escapeHtml(b.displayName)} (${typeLabel})</option>`;
        }).join("")
      : `<option value="">-- no bots --</option>`;

    const isKanban = selBot && (selBot.trackerType === "kanban" || selBot.trackerType === "task-list");
    const isCustom = selBot && selBot.trackerType === "custom";
    const switcherButtons = isKanban
      ? `<button type="button" class="bb-btn bb-sec" id="bb-new-proj-btn">+ New project</button>` +
        `<button type="button" class="bb-btn bb-sec" id="bb-new-card-btn">+ New card</button>` +
        `<button type="button" class="bb-btn bb-sec" id="bb-bulk-btn">+ Add unlinked cards</button>`
      : isCustom
        ? `<button type="button" class="bb-btn bb-sec" id="bb-new-tracker-item-btn">+ New item</button>`
        : "";

    const editBotLink = selBot
      ? `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(selBot.botId)}&tab=tracker" ` +
        `style="font-size:.78rem;color:var(--crow-text-muted);text-decoration:none;margin-left:.3rem" ` +
        `title="Edit bot definition">Edit bot</a>`
      : "";

    const switcher =
      `<form method="GET" action="/dashboard/bot-board" class="bb-switch">` +
      `<label for="bb-bot" style="font-size:.8rem;color:var(--crow-text-muted)">Bot</label>` +
      `<select id="bb-bot" name="bot" onchange="this.form.submit()">` +
      switcherOptions +
      `</select>` + editBotLink +
      `<noscript><button type="submit">Go</button></noscript>` +
      switcherButtons +
      `</form>`;

    // ---- No bot selected ----
    if (!selBot) {
      return layout({
        title: "Bot Board",
        content: PAGE_CSS + section("Bot Board",
          notice + switcher +
          `<p style="margin-top:1rem;color:var(--crow-text-muted)">No enabled bots found. Create a bot in Bot Builder to start a board.</p>`) +
          drawerMarkup() + clientJs(null, "none", null),
      });
    }

    // ---- Dispatch by tracker type ----
    const trackerType = selBot.trackerType;

    if (trackerType === "none") {
      return layout({
        title: `Bot Board — ${selBot.displayName}`,
        content: PAGE_CSS + section(
          `Board — ${escapeHtml(selBot.displayName)}`,
          notice + switcher +
          `<p style="margin-top:1rem;color:var(--crow-text-muted)">This bot has no tracker.</p>`),
      });
    }

    if (trackerType === "custom") {
      // ---- Custom tracker rendering ----
      return await renderCustomTracker(req, res, { db, layout, selBot, bots, notice, switcher, q });
    }

    // ---- Kanban / task-list rendering (default) ----
    return await renderKanbanBoard(req, res, { db, layout, selBot, bots, notice, switcher, q });
  },
};

// ---- Kanban board rendering ----
async function renderKanbanBoard(req, res, { db, layout, selBot, bots, notice, switcher, q }) {
  const projectId = selBot.projectId != null ? Number(selBot.projectId) : null;

  if (projectId == null) {
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: PAGE_CSS + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">This bot has no project linked. Assign a project_id in Bot Builder.</p>`) +
        drawerMarkup() + clientJs(selBot.botId, "kanban", null),
    });
  }

  // Cards for the selected project — tasks.db via the journal-safe client.
  let cards = [];
  let tdb;
  try {
    tdb = createDbClient(TASKS_DB);
    cards = (await tdb.execute({
      sql:
        "SELECT id,title,description,status,priority,due_date,owner,tags,parent_id,project_id," +
        "datetime(updated_at) AS updated_at, completed_at " +
        "FROM tasks_items WHERE project_id=? ORDER BY priority ASC, id ASC",
      args: [projectId],
    })).rows || [];
  } catch {
    cards = [];
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }

  const lockMap = await lockMapFor(db, cards.map((c) => Number(c.id)));

  // ---- no-JS dedicated card view (&card=M) ----
  if (q.card != null && q.card !== "") {
    const cid = Number(q.card);
    const card = cards.find((c) => Number(c.id) === cid);
    if (!card) {
      return layout({
        title: "Bot Board",
        content: PAGE_CSS + section("Card not found",
          `<p>#${escapeHtml(String(q.card))} is not in this bot's project.</p>` +
          `<p><a href="/dashboard/bot-board?bot=${escapeHtml(selBot.botId)}">← back to board</a></p>`),
      });
    }
    const locked = !!lockMap.get(cid);
    const planInfo = await derivePlanPath(db, card);
    const plan = readPlan(planInfo);
    const fieldRow = (lbl, val) =>
      `<tr><td style="padding:3px 14px 3px 0;opacity:.7">${escapeHtml(lbl)}</td><td>${escapeHtml(String(val == null ? "—" : val))}</td></tr>`;
    const planBlock = !planInfo
      ? `<p class="bb-msg warn">No bot is linked to this project, so there is no plan file path.</p>`
      : `<p style="font-size:.8rem;color:var(--crow-text-muted)">${escapeHtml(planInfo.path)}</p>` +
        `<div class="bb-pre">${escapeHtml(plan.text || "(no plan yet)")}</div>` +
        (locked
          ? `<p class="bb-msg warn">🔒 A bot is working this card — the plan file is read-only.</p>`
          : `<p class="bb-msg">Open this board with JavaScript enabled to edit the plan file in the card drawer.</p>`);
    const moveForm =
      `<form method="POST" action="/dashboard/bot-board" style="margin:.6rem 0">` +
      `<input type="hidden" name="action" value="move">` +
      `<input type="hidden" name="card_id" value="${cid}">` +
      `<input type="hidden" name="bot" value="${escapeHtml(selBot.botId)}">` +
      `Move: ` + CARD_STATUSES.filter((s) => s !== card.status).map((s) =>
        `<button type="submit" name="status" value="${s}" class="bb-btn bb-sec" ${locked ? "disabled" : ""}>${escapeHtml(STATUS_LABEL[s])}</button>`).join(" ") +
      `</form>`;
    return layout({
      title: `Card #${cid}`,
      content: PAGE_CSS + section(
        `Card #${cid} — ${escapeHtml(String(card.title || ""))} ${badge(card.status, STATUS_BADGE[card.status] || "draft")}${locked ? " " + badge("bot working", "info") : ""}`,
        `<p><a href="/dashboard/bot-board?bot=${escapeHtml(selBot.botId)}">← back to board</a></p>` +
        `<table style="font-size:.9rem;border-collapse:collapse">` +
        fieldRow("Priority", card.priority) + fieldRow("Due", card.due_date) +
        fieldRow("Owner", card.owner) + fieldRow("Tags", card.tags) +
        fieldRow("Parent", card.parent_id) + fieldRow("Updated", card.updated_at) +
        `</table>` +
        (card.description ? `<p style="margin-top:.6rem">${escapeHtml(String(card.description))}</p>` : "") +
        moveForm + `<h4 style="margin-top:1rem">Plan file</h4>` + planBlock),
    });
  }

  // ---- full kanban board ----
  const byStatus = { pending: [], in_progress: [], done: [], cancelled: [] };
  for (const c of cards) (byStatus[c.status] || (byStatus[c.status] = [])).push(c);
  const columns = CARD_STATUSES.map((st) => {
    const list = byStatus[st] || [];
    const cardsHtml = list.length
      ? list.map((c) => cardFaceHtml(c, !!lockMap.get(Number(c.id)))).join("")
      : `<div style="color:var(--crow-text-muted);font-size:.78rem;padding:.4rem">—</div>`;
    return `<div class="bb-col" data-col="${st}">` +
      `<h4><span>${escapeHtml(STATUS_LABEL[st])}</span><span>${list.length}</span></h4>` +
      `<div class="bb-col-body" data-col-body="${st}">${cardsHtml}</div></div>`;
  }).join("");

  const boardHtml = `<div class="bb-board" style="--bb-cols:4">${columns}</div>`;

  const content = PAGE_CSS + section(
    `Board — ${escapeHtml(selBot.displayName)}`,
    notice + switcher + boardHtml) +
    drawerMarkup() + clientJs(selBot.botId, "kanban", projectId);

  return layout({ title: `Bot Board — ${selBot.displayName}`, content });
}

// ---- Custom tracker rendering ----
async function renderCustomTracker(req, res, { db, layout, selBot, bots, notice, switcher, q }) {
  const trackerSlug = selBot.trackerSlug;
  if (!trackerSlug) {
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: PAGE_CSS + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">Custom tracker type but no tracker_slug configured.</p>`),
    });
  }

  // Look up tracker_defs
  let trackerDef = null;
  try {
    trackerDef = (await db.execute({
      sql: "SELECT id, slug, display_name, columns_json, status_values FROM tracker_defs WHERE slug=?",
      args: [trackerSlug],
    })).rows[0] || null;
  } catch { trackerDef = null; }

  if (!trackerDef) {
    return layout({
      title: `Bot Board — ${selBot.displayName}`,
      content: PAGE_CSS + section(
        `Board — ${escapeHtml(selBot.displayName)}`,
        notice + switcher +
        `<p style="margin-top:1rem;color:var(--crow-text-muted)">Tracker definition <code>${escapeHtml(trackerSlug)}</code> not found.</p>`),
    });
  }

  let statusValues = [];
  try { statusValues = JSON.parse(trackerDef.status_values || "[]"); } catch { statusValues = []; }

  // Use bot's tracker_config.context_fields for card face display (not all columns)
  const botContextFields = (selBot.definition && selBot.definition.tracker_config && selBot.definition.tracker_config.context_fields) || [];
  // Fall back to columns_json if bot has no context_fields configured
  let contextFields = botContextFields.length > 0 ? botContextFields : [];
  if (!contextFields.length) {
    try { contextFields = JSON.parse(trackerDef.columns_json || "[]"); } catch { contextFields = []; }
  }

  // Query tracker_items for this bot
  let items = [];
  try {
    items = (await db.execute({
      sql:
        "SELECT id, tracker_id, bot_id, status, priority, label, data_json, action_needed, " +
        "next_followup_date, processing_lease, processing_lease_status, " +
        "datetime(created_at) AS created_at, datetime(updated_at) AS updated_at " +
        "FROM tracker_items WHERE bot_id=? AND tracker_id=? ORDER BY priority ASC, id ASC",
      args: [selBot.botId, trackerDef.id],
    })).rows || [];
  } catch { items = []; }

  // Build columns from statusValues
  const byStatus = {};
  for (const sv of statusValues) byStatus[sv] = [];
  for (const item of items) {
    const st = item.status || "";
    if (!byStatus[st]) byStatus[st] = [];
    byStatus[st].push(item);
  }

  const colCount = statusValues.length || 1;

  const columnsHtml = statusValues.map((st) => {
    const list = byStatus[st] || [];
    const cardsHtml = list.length
      ? list.map((item) => {
          const locked = String(item.processing_lease_status) === "in-progress";
          return trackerCardFaceHtml(item, contextFields, statusValues, locked);
        }).join("")
      : `<div style="color:var(--crow-text-muted);font-size:.78rem;padding:.4rem">—</div>`;
    return `<div class="bb-col" data-col="${escapeHtml(st)}">` +
      `<h4><span>${escapeHtml(st)}</span><span>${list.length}</span>` +
      `<button type="button" class="bb-col-toggle" title="collapse column">−</button></h4>` +
      `<div class="bb-col-body" data-col-body="${escapeHtml(st)}">${cardsHtml}</div></div>`;
  }).join("");

  const boardHtml = `<div class="bb-board" id="bb-board" style="--bb-cols:${colCount}">${columnsHtml}</div>` +
    `<div id="bb-list-wrap" style="display:none"></div>`;

  const filterBarHtml =
    `<div class="bb-filter-bar">` +
    `<input type="text" id="bb-search" class="bb-search" placeholder="Search items…">` +
    `<div class="bb-chips">` +
    statusValues.map((sv) => `<button type="button" class="bb-chip" data-status-filter="${escapeHtml(sv)}">${escapeHtml(sv)}</button>`).join("") +
    `<button type="button" class="bb-chip bb-chip-action" data-filter="action-needed">action needed</button>` +
    `</div>` +
    `<div class="bb-view-toggle">` +
    `<button type="button" class="bb-view-btn bb-view-btn-active" data-view="columns">Columns</button>` +
    `<button type="button" class="bb-view-btn" data-view="list">List</button>` +
    `</div></div>`;

  const content = PAGE_CSS + section(
    `Board — ${escapeHtml(selBot.displayName)} (${escapeHtml(trackerDef.display_name || trackerSlug)})`,
    notice + switcher + filterBarHtml + boardHtml) +
    trackerDrawerMarkup() + drawerMarkup() + clientJs(selBot.botId, "custom", null, trackerSlug, contextFields);

  return layout({ title: `Bot Board — ${selBot.displayName}`, content });
}

// Right slide-over drawer (design D6) — populated client-side on card click;
// the board stays visible + live behind it. Pure static markup (no dynamic
// data interpolated here); no-JS users never see it (they get &card=M).
function drawerMarkup() {
  return `<div class="bb-drawer" id="bb-drawer" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="bb-d-title" style="font-family:'Fraunces',serif;margin:0">Card</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-d-close">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-d-msg"></div>
    <div id="bb-d-lock" class="bb-msg warn"></div>
    <label>Title</label><input id="bb-d-title-in" type="text">
    <div class="bb-row">
      <div><label>Status</label><select id="bb-d-status">${CARD_STATUSES.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}</select></div>
      <div><label>Priority</label><select id="bb-d-prio"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <div class="bb-row">
      <div><label>Due date</label><input id="bb-d-due" type="text" placeholder="YYYY-MM-DD"></div>
      <div><label>Owner</label><input id="bb-d-owner" type="text"></div>
    </div>
    <label>Tags (comma-separated)</label><input id="bb-d-tags" type="text">
    <label>Description</label><textarea id="bb-d-desc" rows="3" style="font-family:inherit"></textarea>
    <label>Project</label><select id="bb-d-project"></select>
    <div>
      <button type="button" class="bb-btn" id="bb-d-save">Save card</button>
      <button type="button" class="bb-btn bb-sec" id="bb-d-cancel">Cancel card</button>
      <button type="button" class="bb-btn bb-sec" id="bb-d-unlock" style="display:none">Force-unlock</button>
    </div>
    <h4 style="margin-top:1rem;display:flex;justify-content:space-between;align-items:center">
      <span>Plan file</span>
      <button type="button" class="bb-btn bb-sec" id="bb-d-plan-toggle" style="margin:0">Preview</button>
    </h4>
    <div id="bb-d-plan-msg" class="bb-msg"></div>
    <textarea id="bb-d-plan" rows="14" placeholder="(no plan yet)"></textarea>
    <div class="bb-pre" id="bb-d-plan-pre" style="display:none"></div>
    <button type="button" class="bb-btn" id="bb-d-plan-save">Save plan</button>
  </div>
  <div class="bb-drawer" id="bb-newproj" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">New project</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-np-close">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-np-msg"></div>
    <label>Name</label><input id="bb-np-name" type="text">
    <label>Description</label><textarea id="bb-np-desc" rows="3" style="font-family:inherit"></textarea>
    <button type="button" class="bb-btn" id="bb-np-save">Create project</button>
  </div>
  <div class="bb-drawer" id="bb-newcard" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">New card</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-nc-close">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-nc-msg"></div>
    <p style="font-size:.8rem;color:var(--crow-text-muted)">Created in the current project, status <b>pending</b>.</p>
    <label>Title</label><input id="bb-nc-title" type="text">
    <label>Description</label><textarea id="bb-nc-desc" rows="3" style="font-family:inherit"></textarea>
    <div class="bb-row">
      <div><label>Due date</label><input id="bb-nc-due" type="text" placeholder="YYYY-MM-DD"></div>
      <div><label>Owner</label><input id="bb-nc-owner" type="text"></div>
    </div>
    <label>Tags (comma-separated)</label><input id="bb-nc-tags" type="text">
    <button type="button" class="bb-btn" id="bb-nc-save">Create card</button>
  </div>
  <div class="bb-drawer" id="bb-bulk" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">Add unlinked cards</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-bk-close">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-bk-msg"></div>
    <p style="font-size:.82rem;color:var(--crow-text-muted)">Cards with no project (max 200 per assign).</p>
    <div id="bb-bk-list" style="max-height:60vh;overflow:auto"></div>
    <button type="button" class="bb-btn" id="bb-bk-save">Assign selected</button>
  </div>`;
}

// Tracker item drawer — for custom tracker bots
function trackerDrawerMarkup() {
  return `<div class="bb-drawer" id="bb-tracker-drawer" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="bb-td-title" style="font-family:'Fraunces',serif;margin:0">Item</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-td-close">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-td-msg"></div>
    <div id="bb-td-lock" class="bb-msg warn"></div>
    <label>Label</label><input id="bb-td-label" type="text">
    <div class="bb-row">
      <div><label>Status</label><select id="bb-td-status"></select></div>
      <div><label>Priority</label><select id="bb-td-prio"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <label>Action needed</label><input id="bb-td-action" type="text">
    <div id="bb-td-fields"></div>
    <div id="bb-td-lease" style="margin-top:.5rem;font-size:.78rem;color:var(--crow-text-muted)"></div>
    <div>
      <button type="button" class="bb-btn" id="bb-td-save">Save item</button>
      <button type="button" class="bb-btn bb-sec" id="bb-td-clear-lease" style="display:none">Force-clear lease</button>
    </div>
  </div>
  <div class="bb-drawer" id="bb-new-tracker-item" aria-hidden="true">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="font-family:'Fraunces',serif;margin:0">New tracker item</h3>
      <button type="button" class="bb-btn bb-sec" id="bb-nti-close">✕ Close</button>
    </div>
    <div class="bb-msg" id="bb-nti-msg"></div>
    <label>Label (title)</label><input id="bb-nti-label" type="text">
    <div class="bb-row">
      <div><label>Status</label><select id="bb-nti-status"></select></div>
      <div><label>Priority</label><select id="bb-nti-prio"><option value="3" selected>3</option>${[1, 2, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
    </div>
    <label>Action needed</label><input id="bb-nti-action" type="text">
    <div id="bb-nti-fields"></div>
    <button type="button" class="bb-btn" id="bb-nti-save">Create item</button>
  </div>`;
}

// Vanilla client (zero deps): native EventSource live overlay, native HTML5
// drag-and-drop, slide-over drawers, all mutations via auth-gated JSON API.
// Dynamic content is built with createElement/textContent — never innerHTML.
function clientJs(botId, trackerType, projectId, trackerSlug, contextFields) {
  const bi = botId == null ? "null" : JSON.stringify(String(botId));
  const tt = JSON.stringify(String(trackerType || "none"));
  const pj = projectId == null ? "null" : JSON.stringify(Number(projectId));
  const ts = trackerSlug ? JSON.stringify(String(trackerSlug)) : "null";
  const cf = contextFields ? JSON.stringify(contextFields) : "[]";
  return `<script>(function(){
  var BOT_ID=${bi};
  var TRACKER_TYPE=${tt};
  var PROJECT=${pj};
  window._trackerSlug=${ts};
  window._bbContextFields=${cf};
  document.body.classList.add('bb-js');
  var API='/dashboard/bot-board-api';
  function $(id){return document.getElementById(id);}
  function clearEl(e){ while(e&&e.firstChild) e.removeChild(e.firstChild); }
  function optEl(v,t,sel){ var o=document.createElement('option'); o.value=v; o.textContent=t; if(sel) o.selected=true; return o; }
  function api(method,path,body){
    return fetch(API+path,{method:method,headers:{'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,credentials:'same-origin'})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,status:r.status,j:j};});});
  }
  function reload(){ location.reload(); }

  var drawer=$('bb-drawer'), trackerDrawer=$('bb-tracker-drawer'), cur=null, dragId=null, dragType=null, planMtime=null;
  function openDrawer(el){ if(el){el.classList.add('bb-open');el.setAttribute('aria-hidden','false');} }
  function closeDrawer(el){ if(el){el.classList.remove('bb-open');el.setAttribute('aria-hidden','true');} }
  function msg(el,txt,cls){ if(!el) return; el.className='bb-msg '+(cls||''); el.textContent=txt||''; }

  // ---- Kanban card drawer ----
  function cardData(cardEl){
    return {id:Number(cardEl.getAttribute('data-card')),
            status:cardEl.getAttribute('data-status'),
            locked:cardEl.getAttribute('data-locked')==='1',
            itemType:cardEl.getAttribute('data-item-type')||'kanban'};
  }
  function fillDrawer(cardEl){
    cur=cardData(cardEl);
    $('bb-d-title').textContent='Card #'+cur.id;
    var t0=cardEl.querySelector('.bb-title');
    $('bb-d-title-in').value=t0?t0.textContent:'';
    $('bb-d-status').value=cur.status;
    msg($('bb-d-msg'),'','');
    var lk=$('bb-d-lock'), unlock=$('bb-d-unlock');
    if(cur.locked){ lk.textContent='\\uD83D\\uDD12 A bot is working this card \\u2014 fields & plan are read-only.';
      unlock.style.display=''; } else { lk.textContent=''; unlock.style.display='none'; }
    ['bb-d-title-in','bb-d-status','bb-d-prio','bb-d-due','bb-d-owner','bb-d-tags','bb-d-desc','bb-d-project','bb-d-save','bb-d-cancel','bb-d-plan','bb-d-plan-save']
      .forEach(function(i){ var e=$(i); if(e) e.disabled=cur.locked; });
    api('GET','/card/'+cur.id).then(function(r){
      if(r.ok&&r.j&&r.j.card){var c=r.j.card;
        $('bb-d-title-in').value=c.title||'';
        $('bb-d-status').value=c.status||'pending';
        $('bb-d-prio').value=c.priority==null?'':String(c.priority);
        $('bb-d-due').value=c.due_date||'';
        $('bb-d-owner').value=c.owner||'';
        $('bb-d-tags').value=c.tags||'';
        $('bb-d-desc').value=c.description||'';
        var ps=$('bb-d-project'); clearEl(ps); ps.appendChild(optEl('','\\u2014 none \\u2014',false));
        (r.j.projects||[]).forEach(function(p){
          ps.appendChild(optEl(String(p.id),'#'+p.id+' \\u2014 '+(p.name||''),Number(c.project_id)===Number(p.id)));
        });
      }
    });
    loadPlan();
    openDrawer(drawer);
  }
  function loadPlan(){
    var pm=$('bb-d-plan-msg'); msg(pm,'loading\\u2026','');
    api('GET','/card/'+cur.id+'/plan').then(function(r){
      if(r.ok&&r.j){ $('bb-d-plan').value=r.j.markdown||''; planMtime=r.j.mtime||null;
        msg(pm, r.j.exists?'':'(no plan yet)', ''); renderPre();
      } else { msg(pm, (r.j&&r.j.reason)||'plan unavailable','warn'); }
    });
  }
  function renderPre(){ var el=$('bb-d-plan-pre'); if(el) el.textContent=$('bb-d-plan').value; }

  // ---- Tracker item drawer ----
  function fillTrackerDrawer(cardEl){
    var cd=cardData(cardEl);
    cur=cd;
    var td=trackerDrawer; if(!td) return;
    $('bb-td-title').textContent='Item #'+cd.id;
    msg($('bb-td-msg'),'','');
    var lk=$('bb-td-lock'), clBtn=$('bb-td-clear-lease');
    if(cd.locked){ lk.textContent='\\uD83D\\uDD12 A bot is processing this item \\u2014 read-only.';
      if(clBtn) clBtn.style.display=''; } else { lk.textContent=''; if(clBtn) clBtn.style.display='none'; }
    ['bb-td-label','bb-td-status','bb-td-prio','bb-td-action','bb-td-save']
      .forEach(function(i){ var e=$(i); if(e) e.disabled=cd.locked; });
    api('GET','/tracker-item/'+cd.id).then(function(r){
      if(!r.ok||!r.j||!r.j.item) { msg($('bb-td-msg'),'Failed to load item.','err'); return; }
      var item=r.j.item, tracker=r.j.tracker;
      $('bb-td-label').value=item.label||'';
      $('bb-td-prio').value=item.priority==null?'':String(item.priority);
      $('bb-td-action').value=item.action_needed||'';
      // Populate status dropdown from tracker def
      var ss=$('bb-td-status'); clearEl(ss);
      if(tracker&&tracker.status_values){
        var svs=[]; try{svs=JSON.parse(tracker.status_values||'[]');}catch(e){svs=[];}
        svs.forEach(function(s){ ss.appendChild(optEl(s,s,s===item.status)); });
      }
      // Populate data fields (Feature 4 — enhanced detail view)
      var fieldsDiv=$('bb-td-fields'); clearEl(fieldsDiv);
      if(tracker&&tracker.columns_json){
        var cols=[]; try{cols=JSON.parse(tracker.columns_json||'[]');}catch(e){cols=[];}
        var data=item.data||{};
        var secH=document.createElement('h4');secH.className='bb-td-section';secH.textContent='Data Fields';
        fieldsDiv.appendChild(secH);
        cols.forEach(function(cf){
          var key=typeof cf==='string'?cf:(cf.key||cf.name||'');
          if(!key||key==='label'||key==='status') return;
          var displayLabel=typeof cf==='object'&&cf.label?cf.label:key;
          var ftype=typeof cf==='object'?(cf.type||'text'):'text';
          var ro=typeof cf==='object'?!!cf.readonly:false;
          var row=document.createElement('div');row.className='bb-td-field-row';
          var lb=document.createElement('label');lb.className='bb-td-field-label';lb.textContent=displayLabel;
          row.appendChild(lb);
          if(ftype==='json'){
            var pre=document.createElement('pre');pre.className='bb-pre';pre.style.maxHeight='200px';
            var jv=data[key];
            try{pre.textContent=typeof jv==='string'?JSON.stringify(JSON.parse(jv),null,2):(jv!=null?JSON.stringify(jv,null,2):'');}
            catch(e){pre.textContent=jv!=null?String(jv):'';}
            row.appendChild(pre);
          } else if(ftype==='boolean'){
            var cb=document.createElement('input');cb.type='checkbox';
            cb.setAttribute('data-field-key',key);cb.className='bb-td-data-field';
            cb.checked=!!data[key];cb.disabled=cd.locked||ro;
            row.appendChild(cb);
          } else if(ftype==='date'){
            var di=document.createElement('input');di.type='date';
            di.setAttribute('data-field-key',key);di.className='bb-td-data-field';
            di.value=data[key]||'';di.disabled=cd.locked||ro;
            row.appendChild(di);
          } else if(ro){
            var sp=document.createElement('span');sp.className='bb-td-readonly';
            sp.textContent=data[key]!=null?String(data[key]):'\\u2014';
            row.appendChild(sp);
          } else if(key==='status_notes'||key==='description'||ftype==='textarea'){
            var ta=document.createElement('textarea');ta.rows=3;
            ta.setAttribute('data-field-key',key);ta.className='bb-td-data-field';
            ta.style.fontFamily='inherit';ta.value=data[key]||'';ta.disabled=cd.locked;
            row.appendChild(ta);
          } else {
            var inp=document.createElement('input');inp.type='text';
            inp.setAttribute('data-field-key',key);inp.className='bb-td-data-field';
            inp.value=data[key]!=null?String(data[key]):'';inp.disabled=cd.locked||ro;
            row.appendChild(inp);
          }
          fieldsDiv.appendChild(row);
        });
        // History section
        var histH=document.createElement('h4');histH.className='bb-td-section';histH.textContent='History';
        fieldsDiv.appendChild(histH);
        var histDiv=document.createElement('div');histDiv.style.fontSize='.82rem';histDiv.style.color='var(--crow-text-secondary)';
        if(item.updated_at){var up=document.createElement('div');up.textContent='Updated: '+item.updated_at;histDiv.appendChild(up);}
        if(item.created_at){var cr=document.createElement('div');cr.textContent='Created: '+item.created_at;histDiv.appendChild(cr);}
        if(data.status_notes){var sn=document.createElement('div');sn.style.marginTop='.3rem';sn.style.whiteSpace='pre-wrap';sn.textContent=data.status_notes;histDiv.appendChild(sn);}
        fieldsDiv.appendChild(histDiv);
        // Related links section
        var hasLinks=data.note_id||data.review_thread_id||data.pir_number;
        if(hasLinks){
          var linkH=document.createElement('h4');linkH.className='bb-td-section';linkH.textContent='Related';
          fieldsDiv.appendChild(linkH);
          var linkDiv=document.createElement('div');
          if(data.pir_number){var pn=document.createElement('div');pn.style.fontWeight='600';pn.style.fontSize='.95rem';pn.textContent='PIR #'+data.pir_number;linkDiv.appendChild(pn);}
          if(data.note_id){var nl=document.createElement('a');nl.className='bb-td-link';nl.href='http://10.0.0.39:8080/notes/'+data.note_id;nl.target='_blank';nl.textContent='View note \\u2192 #'+data.note_id;linkDiv.appendChild(nl);}
          if(data.review_thread_id){var rt=document.createElement('div');rt.className='bb-td-link';rt.textContent='Thread: '+data.review_thread_id;rt.style.cursor='pointer';rt.title='Click to copy';rt.onclick=function(ev){ev.stopPropagation();navigator.clipboard.writeText(data.review_thread_id);msg($('bb-td-msg'),'Copied thread ID.','ok');};linkDiv.appendChild(rt);}
          fieldsDiv.appendChild(linkDiv);
        }
      }
      // Lease info
      var leaseDiv=$('bb-td-lease');
      if(leaseDiv){
        clearEl(leaseDiv);
        if(item.processing_lease||item.processing_lease_status){
          var t=document.createElement('span');
          t.textContent='Lease: '+(item.processing_lease_status||'none')+
            (item.processing_lease?' ('+item.processing_lease+')':'');
          leaseDiv.appendChild(t);
        }
      }
    });
    openDrawer(td);
  }

  // ---- Click handler: dispatch by item type ----
  document.addEventListener('click',function(ev){
    var c=ev.target.closest && ev.target.closest('.bb-card');
    if(c && !ev.target.closest('.bb-nojs-move')){
      ev.preventDefault();
      var itemType=c.getAttribute('data-item-type')||'kanban';
      if(itemType==='tracker'){ fillTrackerDrawer(c); }
      else { fillDrawer(c); }
    }
  });

  // ---- Kanban drawer events ----
  if($('bb-d-close')) $('bb-d-close').onclick=function(){ closeDrawer(drawer); cur=null; };
  if($('bb-d-save')) $('bb-d-save').onclick=function(){
    if(!cur||cur.locked) return;
    var body={title:$('bb-d-title-in').value,status:$('bb-d-status').value,
      priority:$('bb-d-prio').value===''?null:Number($('bb-d-prio').value),
      due_date:$('bb-d-due').value||null,owner:$('bb-d-owner').value||null,
      tags:$('bb-d-tags').value||null,description:$('bb-d-desc').value||null};
    api('POST','/card/'+cur.id,body).then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'Saved.','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'\\uD83D\\uDD12 '+((r.j&&r.j.reason)||'locked by a bot'),'err'); }
      else { msg($('bb-d-msg'),(r.j&&(r.j.error||r.j.reason))||'save failed','err'); }
    });
  };
  var projSel=$('bb-d-project');
  if(projSel) projSel.onchange=function(){
    if(!cur||cur.locked) return;
    var v=projSel.value===''?null:Number(projSel.value);
    api('POST','/card/'+cur.id+'/project',{project_id:v}).then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'Project updated.','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'\\uD83D\\uDD12 locked','err'); }
      else msg($('bb-d-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  if($('bb-d-cancel')) $('bb-d-cancel').onclick=function(){
    if(!cur||cur.locked||!confirm('Cancel card #'+cur.id+'?')) return;
    api('POST','/card/'+cur.id+'/cancel').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'Cancelled.','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'\\uD83D\\uDD12 locked','err'); }
      else msg($('bb-d-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  if($('bb-d-unlock')) $('bb-d-unlock').onclick=function(){
    if(!cur||!confirm('Force-unlock card #'+cur.id+'? Only if the bot/pi is confirmed dead.')) return;
    api('POST','/card/'+cur.id+'/force-unlock').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'Force-unlocked.','ok'); setTimeout(reload,500); }
      else msg($('bb-d-msg'),(r.j&&(r.j.reason||r.j.error))||'refused (fail-closed: pi not confirmed dead)','err');
    });
  };
  var planToggled=false;
  if($('bb-d-plan-toggle')) $('bb-d-plan-toggle').onclick=function(){
    planToggled=!planToggled; renderPre();
    $('bb-d-plan').style.display=planToggled?'none':'';
    $('bb-d-plan-pre').style.display=planToggled?'':'none';
    this.textContent=planToggled?'Edit':'Preview';
  };
  if($('bb-d-plan')) $('bb-d-plan').addEventListener('input',renderPre);
  if($('bb-d-plan-save')) $('bb-d-plan-save').onclick=function(){
    if(!cur||cur.locked) return;
    api('POST','/card/'+cur.id+'/plan',{markdown:$('bb-d-plan').value,mtime:planMtime}).then(function(r){
      if(r.ok){ planMtime=(r.j&&r.j.mtime)||planMtime; msg($('bb-d-plan-msg'),'Plan saved.','ok'); }
      else if(r.status===409){ msg($('bb-d-plan-msg'),'\\u26A0\\uFE0F Plan changed on disk \\u2014 reloading newer content.','warn'); loadPlan(); }
      else msg($('bb-d-plan-msg'),(r.j&&(r.j.error||r.j.reason))||'save failed','err');
    });
  };

  // ---- Tracker drawer events ----
  if($('bb-td-close')) $('bb-td-close').onclick=function(){ closeDrawer(trackerDrawer); cur=null; };
  if($('bb-td-save')) $('bb-td-save').onclick=function(){
    if(!cur||cur.locked) return;
    var body={label:$('bb-td-label').value,status:$('bb-td-status').value,
      priority:$('bb-td-prio').value===''?null:Number($('bb-td-prio').value),
      action_needed:$('bb-td-action').value||null};
    // Collect data fields
    var dataFields=document.querySelectorAll('.bb-td-data-field');
    if(dataFields.length){
      var data={};
      dataFields.forEach(function(inp){
        var fk=inp.getAttribute('data-field-key');
        if(!fk) return;
        if(inp.type==='checkbox') data[fk]=inp.checked;
        else data[fk]=inp.value;
      });
      body.data=data;
    }
    api('POST','/tracker-item/'+cur.id,body).then(function(r){
      if(r.ok){ msg($('bb-td-msg'),'Saved.','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-td-msg'),'\\uD83D\\uDD12 '+((r.j&&r.j.reason)||'locked by a bot'),'err'); }
      else { msg($('bb-td-msg'),(r.j&&(r.j.error||r.j.reason))||'save failed','err'); }
    });
  };
  if($('bb-td-clear-lease')) $('bb-td-clear-lease').onclick=function(){
    if(!cur||!confirm('Force-clear lease on item #'+cur.id+'?')) return;
    api('POST','/tracker-item/'+cur.id+'/force-clear-lease').then(function(r){
      if(r.ok){ msg($('bb-td-msg'),'Lease cleared.','ok'); setTimeout(reload,500); }
      else msg($('bb-td-msg'),(r.j&&(r.j.reason||r.j.error))||'failed','err');
    });
  };

  // ---- Drag and drop ----
  document.addEventListener('dragstart',function(e){
    var c=e.target.closest&&e.target.closest('.bb-card'); if(!c) return;
    if(c.getAttribute('data-locked')==='1'){ e.preventDefault(); return; }
    dragId=Number(c.getAttribute('data-card'));
    dragType=c.getAttribute('data-item-type')||'kanban';
    e.dataTransfer.effectAllowed='move';
  });
  document.addEventListener('dragend',function(){ dragId=null; dragType=null;
    document.querySelectorAll('.bb-col').forEach(function(x){x.classList.remove('bb-dragover');}); });
  document.querySelectorAll('.bb-col').forEach(function(col){
    col.addEventListener('dragover',function(e){ e.preventDefault(); col.classList.add('bb-dragover'); });
    col.addEventListener('dragleave',function(){ col.classList.remove('bb-dragover'); });
    col.addEventListener('drop',function(e){
      e.preventDefault(); col.classList.remove('bb-dragover');
      if(dragId==null) return;
      var st=col.getAttribute('data-col'), id=dragId, dt=dragType; dragId=null; dragType=null;
      if(dt==='tracker'){
        api('POST','/tracker-item/'+id+'/move',{status:st}).then(function(r){
          if(r.ok) reload();
          else if(r.status===409) alert('\\uD83D\\uDD12 Item #'+id+' is being processed by a bot.');
          else alert((r.j&&(r.j.error||r.j.reason))||'move failed');
        });
      } else {
        api('POST','/card/'+id+'/move',{status:st}).then(function(r){
          if(r.ok) reload();
          else if(r.status===409) alert('\\uD83D\\uDD12 Card #'+id+' is being worked by a bot.');
          else alert((r.j&&(r.j.error||r.j.reason))||'move failed');
        });
      }
    });
  });

  // ---- New project / card / bulk (kanban only) ----
  var np=$('bb-newproj');
  var npBtn=$('bb-new-proj-btn'); if(npBtn) npBtn.onclick=function(){ msg($('bb-np-msg'),'',''); openDrawer(np); };
  if($('bb-np-close')) $('bb-np-close').onclick=function(){ closeDrawer(np); };
  if($('bb-np-save')) $('bb-np-save').onclick=function(){
    var name=$('bb-np-name').value.trim();
    if(!name){ msg($('bb-np-msg'),'Name required.','err'); return; }
    api('POST','/project',{name:name,description:$('bb-np-desc').value||null}).then(function(r){
      if(r.ok){ var id=r.j&&r.j.id; location.href='/dashboard/bot-board'+(BOT_ID?'?bot='+encodeURIComponent(BOT_ID):''); }
      else msg($('bb-np-msg'),(r.j&&(r.j.error||r.j.reason))||'create failed','err');
    });
  };

  var nc=$('bb-newcard');
  var ncBtn=$('bb-new-card-btn');
  if(ncBtn) ncBtn.onclick=function(){ msg($('bb-nc-msg'),'',''); openDrawer(nc); };
  var ncClose=$('bb-nc-close'); if(ncClose) ncClose.onclick=function(){ closeDrawer(nc); };
  var ncSave=$('bb-nc-save');
  if(ncSave) ncSave.onclick=function(){
    var title=$('bb-nc-title').value.trim();
    if(!title){ msg($('bb-nc-msg'),'Title required.','err'); return; }
    api('POST','/card',{title:title,description:$('bb-nc-desc').value||null,
      due_date:$('bb-nc-due').value||null,owner:$('bb-nc-owner').value||null,
      tags:$('bb-nc-tags').value||null,project_id:PROJECT}).then(function(r){
      if(r.ok){ msg($('bb-nc-msg'),'Created #'+(r.j&&r.j.id)+'.','ok'); setTimeout(reload,500); }
      else msg($('bb-nc-msg'),(r.j&&(r.j.error||r.j.reason))||'create failed','err');
    });
  };

  var bk=$('bb-bulk');
  var bkBtn=$('bb-bulk-btn');
  if(bkBtn) bkBtn.onclick=function(){
    msg($('bb-bk-msg'),'loading\\u2026',''); openDrawer(bk);
    api('GET','/project/'+PROJECT+'/unlinked').then(function(r){
      var L=$('bb-bk-list'); clearEl(L);
      if(r.ok&&r.j&&r.j.cards&&r.j.cards.length){
        r.j.cards.forEach(function(c){
          var lab=document.createElement('label'); lab.style.display='block'; lab.style.padding='.2rem 0';
          var cb=document.createElement('input'); cb.type='checkbox'; cb.value=String(c.id);
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(' #'+c.id+' \\u2014 '+(c.title||'')));
          L.appendChild(lab);
        });
        msg($('bb-bk-msg'),'','');
      } else if(r.ok){ var p=document.createElement('p'); p.style.color='var(--crow-text-muted)';
        p.textContent='No unlinked cards.'; L.appendChild(p); msg($('bb-bk-msg'),'','');
      } else msg($('bb-bk-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  if($('bb-bk-close')) $('bb-bk-close').onclick=function(){ closeDrawer(bk); };
  if($('bb-bk-save')) $('bb-bk-save').onclick=function(){
    var ids=[].slice.call($('bb-bk-list').querySelectorAll('input:checked')).map(function(x){return Number(x.value);});
    if(!ids.length){ msg($('bb-bk-msg'),'Select at least one card.','err'); return; }
    if(ids.length>200){ msg($('bb-bk-msg'),'Max 200 per assign.','err'); return; }
    api('POST','/project/'+PROJECT+'/bulk-assign',{card_ids:ids}).then(function(r){
      if(r.ok){ var a=((r.j&&r.j.applied)||[]).length, s=((r.j&&r.j.skipped)||[]).length;
        msg($('bb-bk-msg'),'Applied '+a+', skipped '+s+'.','ok'); setTimeout(reload,800); }
      else msg($('bb-bk-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };

  // ---- New tracker item ----
  var ntiDrawer=$('bb-new-tracker-item');
  var ntiBtn=$('bb-new-tracker-item-btn');
  if(ntiBtn && ntiDrawer) ntiBtn.onclick=function(){
    msg($('bb-nti-msg'),'','');
    $('bb-nti-label').value='';
    $('bb-nti-action').value='';
    // Populate status dropdown from tracker data (fetch tracker def)
    if(BOT_ID && TRACKER_TYPE==='custom'){
      var slug=document.querySelector('[data-col]');
      if(slug){
        var statusSel=$('bb-nti-status');
        clearEl(statusSel);
        document.querySelectorAll('[data-col]').forEach(function(col){
          var sv=col.getAttribute('data-col');
          statusSel.appendChild(optEl(sv,sv,statusSel.options.length===0));
        });
      }
      // Populate data fields from columns_json
      api('GET','/trackers').then(function(r){
        if(!r.ok||!r.j||!r.j.trackers) return;
        var fieldsDiv=$('bb-nti-fields');
        clearEl(fieldsDiv);
        // Find the tracker for this bot by checking which tracker slug is on the board
        var firstCol=document.querySelector('[data-col]');
        if(!firstCol) return;
        r.j.trackers.forEach(function(t){
          var cols; try{cols=JSON.parse(t.columns_json||'[]');}catch(e){return;}
          cols.forEach(function(col){
            if(col.key==='label'||col.key==='status'||col.key==='action_needed'||col.key==='priority') return;
            var label=document.createElement('label');
            label.textContent=col.label||col.key;
            var input=document.createElement('input');
            input.type='text';
            input.setAttribute('data-field-key',col.key);
            fieldsDiv.appendChild(label);
            fieldsDiv.appendChild(input);
          });
        });
      });
    }
    openDrawer(ntiDrawer);
  };
  if($('bb-nti-close')) $('bb-nti-close').onclick=function(){ closeDrawer(ntiDrawer); };
  if($('bb-nti-save')) $('bb-nti-save').onclick=function(){
    var label=($('bb-nti-label').value||'').trim();
    if(!label){ msg($('bb-nti-msg'),'Label required.','err'); return; }
    var status=$('bb-nti-status').value;
    var priority=$('bb-nti-prio').value;
    var action=$('bb-nti-action').value||null;
    // Collect data fields
    var data={};
    var fields=$('bb-nti-fields');
    if(fields){
      fields.querySelectorAll('input[data-field-key]').forEach(function(inp){
        var v=inp.value.trim();
        if(v) data[inp.getAttribute('data-field-key')]=v;
      });
    }
    // Determine tracker_slug from the URL or bot definition
    var slugMatch=location.search.match(/bot=([^&]+)/);
    var botIdForCreate=slugMatch?decodeURIComponent(slugMatch[1]):BOT_ID;
    api('GET','/tracker/'+encodeURIComponent(status)+'/items').catch(function(){});
    // We need the tracker_slug. Get it from the page title or fetch it.
    api('POST','/tracker-item',{
      tracker_slug:window._trackerSlug||'',
      bot_id:botIdForCreate,
      label:label,
      status:status,
      priority:priority?Number(priority):3,
      action_needed:action,
      data:data
    }).then(function(r){
      if(r.ok){ msg($('bb-nti-msg'),'Created #'+(r.j&&r.j.id)+'.','ok'); setTimeout(reload,500); }
      else msg($('bb-nti-msg'),(r.j&&(r.j.error||r.j.reason))||'create failed','err');
    });
  };

  // ---- Search and filter (Feature 1) ----
  if(TRACKER_TYPE==='custom'){
    var searchInput=$('bb-search');
    var chips=document.querySelectorAll('.bb-chip');
    var activeStatuses={};
    var actionNeededFilter=false;
    function statusFilterOn(){ for(var k in activeStatuses) return true; return false; }

    function applyFilters(){
      var q=(searchInput?searchInput.value:'').toLowerCase().trim();
      var colCounts={};
      document.querySelectorAll('.bb-col').forEach(function(col){
        colCounts[col.getAttribute('data-col')]={total:0,visible:0};
      });
      document.querySelectorAll('.bb-card[data-item-type="tracker"]').forEach(function(card){
        var matchSearch=!q||(card.getAttribute('data-search-text')||'').indexOf(q)>=0;
        var st=card.getAttribute('data-status');
        var matchStatus=!statusFilterOn()||!!activeStatuses[st];
        var matchAction=!actionNeededFilter||card.getAttribute('data-action-needed')==='1';
        var vis=matchSearch&&matchStatus&&matchAction;
        card.style.display=vis?'':'none';
        if(colCounts[st]){colCounts[st].total++;if(vis)colCounts[st].visible++;}
      });
      document.querySelectorAll('.bb-col').forEach(function(col){
        var st=col.getAttribute('data-col'),h4=col.querySelector('h4');
        if(!h4) return;
        var spans=h4.querySelectorAll('span');
        if(spans.length<2) return;
        var c=colCounts[st]||{total:0,visible:0};
        var filt=q||statusFilterOn()||actionNeededFilter;
        spans[spans.length-1].textContent=filt?c.visible+'/'+c.total:String(c.total);
      });
      document.querySelectorAll('#bb-list-wrap tr[data-card]').forEach(function(row){
        var mS=!q||(row.getAttribute('data-search-text')||'').indexOf(q)>=0;
        var rSt=row.getAttribute('data-status');
        var mSt=!statusFilterOn()||!!activeStatuses[rSt];
        var mA=!actionNeededFilter||row.getAttribute('data-action-needed')==='1';
        row.style.display=(mS&&mSt&&mA)?'':'none';
      });
      updateFilterHash();
    }
    window._bbApplyFilters=applyFilters;

    function updateFilterHash(){
      var parts=[];
      if(searchInput&&searchInput.value) parts.push('search='+encodeURIComponent(searchInput.value));
      var sk=Object.keys(activeStatuses);
      if(sk.length) parts.push('status='+sk.join(','));
      if(actionNeededFilter) parts.push('action=1');
      var h=parts.length?'#'+parts.join('&'):'';
      if(location.hash!==h) history.replaceState(null,'',location.pathname+location.search+h);
    }

    function parseFilterHash(){
      var h=location.hash.replace(/^#/,'');
      if(!h) return;
      h.split('&').forEach(function(part){
        var eq=part.indexOf('=');
        if(eq<0) return;
        var k=part.substring(0,eq),v=decodeURIComponent(part.substring(eq+1));
        if(k==='search'&&searchInput) searchInput.value=v;
        if(k==='status') v.split(',').forEach(function(s){ if(s) activeStatuses[s]=1; });
        if(k==='action'&&v==='1') actionNeededFilter=true;
      });
      chips.forEach(function(chip){
        var sf=chip.getAttribute('data-status-filter');
        if(sf) chip.classList.toggle('bb-chip-active',!!activeStatuses[sf]);
        if(chip.getAttribute('data-filter')==='action-needed') chip.classList.toggle('bb-chip-active',actionNeededFilter);
      });
    }

    if(searchInput) searchInput.addEventListener('input',applyFilters);
    chips.forEach(function(chip){
      chip.addEventListener('click',function(){
        var sf=chip.getAttribute('data-status-filter');
        if(sf){
          if(activeStatuses[sf]){delete activeStatuses[sf];chip.classList.remove('bb-chip-active');}
          else{activeStatuses[sf]=1;chip.classList.add('bb-chip-active');}
        }
        if(chip.getAttribute('data-filter')==='action-needed'){
          actionNeededFilter=!actionNeededFilter;
          chip.classList.toggle('bb-chip-active',actionNeededFilter);
        }
        applyFilters();
      });
    });

    parseFilterHash();
    applyFilters();

    // ---- View toggle + list + collapsible columns (Feature 3) ----
    var bbBoard=$('bb-board');
    var bbListWrap=$('bb-list-wrap');
    var viewBtns=document.querySelectorAll('.bb-view-btn');
    var currentView='columns';
    var sortKey=null,sortAsc=true;

    function switchView(view){
      currentView=view;
      if(view==='list'){
        if(bbBoard) bbBoard.style.display='none';
        if(bbListWrap){bbListWrap.style.display='';buildListTable();applyFilters();}
      } else {
        if(bbBoard) bbBoard.style.display='';
        if(bbListWrap) bbListWrap.style.display='none';
      }
      viewBtns.forEach(function(btn){btn.classList.toggle('bb-view-btn-active',btn.getAttribute('data-view')===view);});
      try{localStorage.setItem('bb-view-'+BOT_ID,view);}catch(e){}
    }
    viewBtns.forEach(function(btn){
      btn.addEventListener('click',function(){switchView(btn.getAttribute('data-view'));});
    });

    function buildListTable(){
      if(!bbListWrap) return;
      clearEl(bbListWrap);
      var table=document.createElement('table');
      table.className='bb-list-table';
      var thead=document.createElement('thead');
      var hr=document.createElement('tr');
      var cols=[{key:'id',label:'#'},{key:'label',label:'Label'},{key:'status',label:'Status'},
                {key:'priority',label:'Pri'},{key:'action',label:'Action Needed'}];
      var cf=window._bbContextFields||[];
      cf.forEach(function(c){
        var key=typeof c==='string'?c:(c.key||c.name||'');
        if(!key||key==='label'||key==='status'||key==='priority'||key==='action_needed') return;
        cols.push({key:key,label:typeof c==='object'&&c.label?c.label:key});
      });
      cols.forEach(function(col){
        var th=document.createElement('th');
        th.textContent=col.label;
        th.setAttribute('data-sort-key',col.key);
        if(sortKey===col.key) th.classList.add(sortAsc?'bb-sort-asc':'bb-sort-desc');
        th.onclick=function(){sortListByKey(col.key);};
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody=document.createElement('tbody');
      var cards=[].slice.call(document.querySelectorAll('.bb-card[data-item-type="tracker"]'));
      if(sortKey) cards.sort(function(a,b){
        var va=cardSortVal(a,sortKey),vb=cardSortVal(b,sortKey);
        if(va===vb) return 0;
        return (va<vb?-1:1)*(sortAsc?1:-1);
      });
      cards.forEach(function(card){
        var tr=document.createElement('tr');
        tr.setAttribute('data-card',card.getAttribute('data-card'));
        tr.setAttribute('data-status',card.getAttribute('data-status'));
        tr.setAttribute('data-item-type','tracker');
        tr.setAttribute('data-search-text',card.getAttribute('data-search-text')||'');
        tr.setAttribute('data-action-needed',card.getAttribute('data-action-needed')||'0');
        tr.setAttribute('data-priority',card.getAttribute('data-priority')||'');
        var data={}; try{data=JSON.parse(card.getAttribute('data-json')||'{}');}catch(e){data={};}
        cols.forEach(function(col){
          var td=document.createElement('td');
          if(col.key==='id') td.textContent='#'+card.getAttribute('data-card');
          else if(col.key==='label'){var t=card.querySelector('.bb-title');td.textContent=t?t.textContent:'';}
          else if(col.key==='status'){var sp=document.createElement('span');sp.className='bb-list-status';sp.textContent=card.getAttribute('data-status');td.appendChild(sp);}
          else if(col.key==='priority') td.textContent=card.getAttribute('data-priority')||'\\u2014';
          else if(col.key==='action'){
            if(card.getAttribute('data-action-needed')==='1'){
              var sub=card.querySelector('.bb-sub');td.textContent=sub?sub.textContent.replace(/^\\u26A0\\s*/,''):'Yes';
              td.style.color='#b8860b';
            } else td.textContent='\\u2014';
          } else {var v=data[col.key];td.textContent=v!=null?String(v):'';}
          tr.appendChild(td);
        });
        tr.onclick=function(){
          var cid=this.getAttribute('data-card');
          var orig=document.querySelector('.bb-card[data-card="'+cid+'"]');
          if(orig) fillTrackerDrawer(orig);
        };
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      bbListWrap.appendChild(table);
    }

    function cardSortVal(card,key){
      if(key==='id') return Number(card.getAttribute('data-card'))||0;
      if(key==='priority') return Number(card.getAttribute('data-priority'))||99;
      if(key==='status') return card.getAttribute('data-status')||'';
      if(key==='label'){var t=card.querySelector('.bb-title');return t?t.textContent.toLowerCase():'';}
      if(key==='action') return card.getAttribute('data-action-needed')==='1'?0:1;
      var data={};try{data=JSON.parse(card.getAttribute('data-json')||'{}');}catch(e){}
      var v=data[key];return v!=null?String(v).toLowerCase():'';
    }

    function sortListByKey(key){
      if(sortKey===key) sortAsc=!sortAsc;
      else{sortKey=key;sortAsc=true;}
      buildListTable();
      applyFilters();
    }

    // Collapsible columns
    var collapsedKey='bb-collapsed-'+BOT_ID;
    function getCollapsed(){try{return JSON.parse(localStorage.getItem(collapsedKey)||'[]');}catch(e){return [];}}
    function saveCollapsed(arr){try{localStorage.setItem(collapsedKey,JSON.stringify(arr));}catch(e){}}

    function toggleColumn(colEl){
      var st=colEl.getAttribute('data-col');
      var collapsed=getCollapsed();
      var idx=collapsed.indexOf(st);
      if(idx>=0){collapsed.splice(idx,1);colEl.classList.remove('bb-col-collapsed');}
      else{collapsed.push(st);colEl.classList.add('bb-col-collapsed');}
      saveCollapsed(collapsed);
      var btn=colEl.querySelector('.bb-col-toggle');
      if(btn) btn.textContent=idx>=0?'\\u2212':'+';
    }

    document.querySelectorAll('.bb-col-toggle').forEach(function(btn){
      btn.addEventListener('click',function(ev){
        ev.stopPropagation();
        var col=btn.closest('.bb-col');
        if(col) toggleColumn(col);
      });
    });

    function restoreCollapsedColumns(){
      var collapsed=getCollapsed();
      collapsed.forEach(function(st){
        var col=document.querySelector('.bb-col[data-col="'+st+'"]');
        if(col){col.classList.add('bb-col-collapsed');var btn=col.querySelector('.bb-col-toggle');if(btn) btn.textContent='+';}
      });
    }

    restoreCollapsedColumns();
    var savedView;try{savedView=localStorage.getItem('bb-view-'+BOT_ID);}catch(e){}
    if(savedView==='list') switchView('list');
  }

  // ---- EventSource live overlay ----
  if(window.EventSource){
    var esUrl=null;
    if(BOT_ID!=null){
      esUrl='/dashboard/streams/bot-board?bot='+encodeURIComponent(BOT_ID);
    } else if(PROJECT!=null){
      esUrl='/dashboard/streams/bot-board?project='+PROJECT;
    }
    if(esUrl){
      var es=new EventSource(esUrl);
      es.onmessage=function(ev){
        var d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
        if(!d||!d.cards) return;
        var openDrawerId = drawer&&drawer.classList.contains('bb-open')&&cur?cur.id:null;
        var busyId = dragId!=null ? dragId : openDrawerId;
        var changed=false;
        d.cards.forEach(function(c){
          var el=document.querySelector('.bb-card[data-card="'+c.id+'"]');
          var curStatus=el?el.getAttribute('data-status'):null;
          var curLocked=el?(el.getAttribute('data-locked')==='1'):false;
          var newLocked=!!(d.locks&&d.locks[c.id]);
          if(!el || curStatus!==c.status || curLocked!==newLocked){ if(c.id!==busyId) changed=true; }
        });
        if(changed && !document.hidden) reload();
      };
      es.onerror=function(){ /* EventSource auto-reconnects; server resends a full snapshot */ };
    }
  }
})();</script>`;
}
