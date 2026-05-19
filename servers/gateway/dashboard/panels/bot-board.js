/**
 * Bot Board Panel — Crow Bot Builder Phase 4 (real Kanban board + project linkage).
 *
 * A dedicated, full-width, project-centric Kanban board (design D2). SSR-first
 * (works without JS: project switcher = GET form, status moves = form-POST to
 * this route, drawer degrades to a dedicated `&card=M` card page), with a
 * native-EventSource live overlay layered on top (design D3/D4/§5):
 *   - cards = tasks.db `tasks_items` filtered by project_id (the cross-DB
 *     app-level soft link; opened ONLY via the gateway's journal-safe
 *     createDbClient(TASKS_DB) — no direct better-sqlite3 constructor in
 *     this file, never a WAL flip).
 *   - whole-card single-writer lock (design D5): the MAX(id) bot_sessions row
 *     for a card_id with status ∈ {active,waiting-user} ⇒ the card is
 *     read-only here AND every mutation endpoint 409s. Computed with ONE
 *     batched IN-list query (predicate-equivalent to the single-card form;
 *     never a per-card LIMIT-1 loop).
 *   - all mutations (move/create/edit/cancel/plan/project/bulk-assign/
 *     force-unlock) go to the auth-gated JSON router routes/bot-board-api.js;
 *     the no-JS status-move path posts to THIS route (POST …/bot-board) and
 *     303-redirects (the Phase-2.3 panel-family pattern).
 *
 * Zero new npm deps (hard constraint, design §8): markdown plan preview is a
 * dependency-free escaped <pre>/<textarea> toggle; drag = native HTML5 DnD;
 * live overlay = native EventSource; no-JS path = form POSTs. Client-side
 * dynamic content is built with safe DOM APIs (createElement/textContent),
 * never innerHTML; server-side HTML is escaped via shared escapeHtml().
 *
 * DEFENSIVE: pi_bot_defs / bot_sessions exist only on the MPA instance's
 * crow.db. On the primary gateway this panel falls through the same friendly
 * notAvail notice bot-builder.js uses and NEVER opens tasks.db there
 * (dashboard/index.js is shared by both gateways).
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
// row for a card_id with status ∈ {active,waiting-user} ⇒ locked.
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
// resolving the owning bot as the first pi_bot_defs row whose
// definition.project_id matches the card's project (single-bot-per-project
// is the live reality; deterministic lowest-bot_id pick otherwise). Returns
// { path, sessionDir } or null. Read-only here; the realpath-containment
// assertion is enforced (cardId is integer-cast, session_dir from trusted
// DB) so a crafted route param cannot escape the workspace.
async function derivePlanPath(db, card) {
  if (card.project_id == null) return null;
  let defs = [];
  try {
    defs = (await db.execute({
      sql: "SELECT definition FROM pi_bot_defs ORDER BY bot_id",
      args: [],
    })).rows || [];
  } catch {
    return null;
  }
  for (const row of defs) {
    let def;
    try { def = JSON.parse(row.definition || "{}"); } catch { continue; }
    if (def && def.session_dir && Number(def.project_id) === Number(card.project_id)) {
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

const PAGE_CSS = `<style>
  .bb-switch{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  .bb-switch select,.bb-switch input{padding:.45rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary)}
  .bb-switch button{padding:.45rem .9rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:#fff;cursor:pointer}
  .bb-board{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;align-items:start}
  .bb-col{background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);padding:.6rem;min-height:120px}
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
</style>`;

export default {
  id: "bot-board",
  name: "Bot Board",
  icon: "project",
  route: "/dashboard/bot-board",
  navOrder: 15,
  category: "tools",

  async handler(req, res, { db, layout }) {
    const notAvail = await tableMissing(db);

    // ---- no-JS status-move (design §6: POST …/bot-board → 303) ----
    if (req.method === "POST" && !notAvail) {
      const b = req.body || {};
      const projQ = b.project ? `?project=${encodeURIComponent(String(b.project))}` : "";
      if (b.action === "move") {
        const cardId = Number(b.card_id);
        const status = String(b.status || "");
        if (!Number.isInteger(cardId) || !CARD_STATUSES.includes(status)) {
          return res.redirectAfterPost(`/dashboard/bot-board${projQ}${projQ ? "&" : "?"}err=bad_move`);
        }
        // Per-mutation lock re-check (single-card form — this is the one
        // genuinely-single-card site; the SSR board uses the batched form).
        let locked = false;
        try {
          const lr = (await db.execute({
            sql: "SELECT status FROM bot_sessions WHERE card_id=? ORDER BY id DESC LIMIT 1",
            args: [cardId],
          })).rows[0];
          locked = lr && LOCK_STATUSES.has(String(lr.status));
        } catch { locked = false; }
        if (locked) return res.redirectAfterPost(`/dashboard/bot-board${projQ}${projQ ? "&" : "?"}err=locked`);
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
          return res.redirectAfterPost(`/dashboard/bot-board${projQ}${projQ ? "&" : "?"}err=move_failed`);
        } finally {
          if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
        }
        return res.redirectAfterPost(`/dashboard/bot-board${projQ}`);
      }
      return res.redirectAfterPost(`/dashboard/bot-board${projQ}`);
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
    // Project list (crow.db research_projects via the injected client).
    let projects = [];
    try {
      projects = (await db.execute({
        sql: "SELECT id, name, status FROM research_projects ORDER BY id",
        args: [],
      })).rows || [];
    } catch { projects = []; }

    const reqProj = q.project != null && q.project !== "" ? Number(q.project) : null;
    const selProj = (reqProj != null && projects.some((p) => Number(p.id) === reqProj))
      ? reqProj
      : (projects[0] ? Number(projects[0].id) : null);

    const noticeBits = [];
    if (q.err === "locked") noticeBits.push(`<p class="bb-msg err">⚠️ That card is being worked by a bot — read-only.</p>`);
    else if (q.err === "bad_move") noticeBits.push(`<p class="bb-msg err">⚠️ Invalid status move.</p>`);
    else if (q.err === "move_failed") noticeBits.push(`<p class="bb-msg err">⚠️ Move failed.</p>`);
    const notice = noticeBits.join("");

    // Project switcher (GET form — works without JS).
    const switcher =
      `<form method="GET" action="/dashboard/bot-board" class="bb-switch">` +
      `<label for="bb-proj" style="font-size:.8rem;color:var(--crow-text-muted)">Project</label>` +
      `<select id="bb-proj" name="project" onchange="this.form.submit()">` +
      (projects.length
        ? projects.map((p) =>
            `<option value="${escapeHtml(String(p.id))}"${Number(p.id) === selProj ? " selected" : ""}>` +
            `#${escapeHtml(String(p.id))} — ${escapeHtml(String(p.name || ""))}` +
            `${p.status && p.status !== "active" ? ` (${escapeHtml(String(p.status))})` : ""}</option>`).join("")
        : `<option value="">— no projects —</option>`) +
      `</select>` +
      `<noscript><button type="submit">Go</button></noscript>` +
      `<button type="button" class="bb-btn bb-sec" id="bb-new-proj-btn">+ New project</button>` +
      (selProj != null
        ? `<button type="button" class="bb-btn bb-sec" id="bb-new-card-btn">+ New card</button>` +
          `<button type="button" class="bb-btn bb-sec" id="bb-bulk-btn">+ Add unlinked cards</button>` : "") +
      `</form>`;

    if (selProj == null) {
      return layout({
        title: "Bot Board",
        content: PAGE_CSS + section("Bot Board",
          notice + switcher +
          `<p style="margin-top:1rem;color:var(--crow-text-muted)">No research projects yet. Create one to start a board.</p>`) +
          drawerMarkup() + clientJs(null),
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
        args: [selProj],
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
            `<p>#${escapeHtml(String(q.card))} is not in project #${escapeHtml(String(selProj))}.</p>` +
            `<p><a href="/dashboard/bot-board?project=${escapeHtml(String(selProj))}">← back to board</a></p>`),
        });
      }
      const locked = !!lockMap.get(cid);
      const planInfo = await derivePlanPath(db, card);
      const plan = readPlan(planInfo);
      const fieldRow = (lbl, val) =>
        `<tr><td style="padding:3px 14px 3px 0;opacity:.7">${escapeHtml(lbl)}</td><td>${escapeHtml(String(val == null ? "—" : val))}</td></tr>`;
      // No-JS view is read-only for the plan file: design §5 scopes the
      // no-JS surface to status buttons + a dedicated card page; plan
      // EDITING is the JS slide-over drawer (which keeps the mutation API
      // pure-JSON per §6 — no form-303 dual-mode).
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
        `<input type="hidden" name="project" value="${escapeHtml(String(selProj))}">` +
        `Move: ` + CARD_STATUSES.filter((s) => s !== card.status).map((s) =>
          `<button type="submit" name="status" value="${s}" class="bb-btn bb-sec" ${locked ? "disabled" : ""}>${escapeHtml(STATUS_LABEL[s])}</button>`).join(" ") +
        `</form>`;
      return layout({
        title: `Card #${cid}`,
        content: PAGE_CSS + section(
          `Card #${cid} — ${escapeHtml(String(card.title || ""))} ${badge(card.status, STATUS_BADGE[card.status] || "draft")}${locked ? " " + badge("bot working", "info") : ""}`,
          `<p><a href="/dashboard/bot-board?project=${escapeHtml(String(selProj))}">← back to board</a></p>` +
          `<table style="font-size:.9rem;border-collapse:collapse">` +
          fieldRow("Priority", card.priority) + fieldRow("Due", card.due_date) +
          fieldRow("Owner", card.owner) + fieldRow("Tags", card.tags) +
          fieldRow("Parent", card.parent_id) + fieldRow("Updated", card.updated_at) +
          `</table>` +
          (card.description ? `<p style="margin-top:.6rem">${escapeHtml(String(card.description))}</p>` : "") +
          moveForm + `<h4 style="margin-top:1rem">Plan file</h4>` + planBlock),
      });
    }

    // ---- full board ----
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

    const projName = (projects.find((p) => Number(p.id) === selProj) || {}).name || "";
    const content = PAGE_CSS + section(
      `Board — #${escapeHtml(String(selProj))} ${escapeHtml(String(projName))}`,
      notice + switcher + `<div class="bb-board">${columns}</div>`) +
      drawerMarkup() + clientJs(selProj);

    return layout({ title: `Bot Board — ${projName}`, content });
  },
};

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

// Vanilla client (zero deps): native EventSource live overlay (snapshot +
// deltas; never clobbers an in-flight drag or the open drawer), native HTML5
// drag-and-drop status moves, the slide-over drawer (card edit/cancel/
// plan-edit/project-reassign/force-unlock), inline project create, and the
// bulk-assign picker. All mutations hit the auth-gated JSON API
// /dashboard/bot-board-api/*; the API re-checks the lock server-side (409).
// Dynamic content is built with createElement/textContent — never innerHTML.
function clientJs(projectId) {
  const pj = projectId == null ? "null" : JSON.stringify(Number(projectId));
  return `<script>(function(){
  var PROJECT=${pj}; if(PROJECT==null) PROJECT=null;
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

  var drawer=$('bb-drawer'), cur=null, dragId=null, planMtime=null;
  function openDrawer(el){ if(el){el.classList.add('bb-open');el.setAttribute('aria-hidden','false');} }
  function closeDrawer(el){ if(el){el.classList.remove('bb-open');el.setAttribute('aria-hidden','true');} }
  function msg(el,txt,cls){ el.className='bb-msg '+(cls||''); el.textContent=txt||''; }

  function cardData(cardEl){
    return {id:Number(cardEl.getAttribute('data-card')),
            status:cardEl.getAttribute('data-status'),
            locked:cardEl.getAttribute('data-locked')==='1'};
  }
  function fillDrawer(cardEl){
    cur=cardData(cardEl);
    $('bb-d-title').textContent='Card #'+cur.id;
    var t0=cardEl.querySelector('.bb-title');
    $('bb-d-title-in').value=t0?t0.textContent:'';
    $('bb-d-status').value=cur.status;
    msg($('bb-d-msg'),'','');
    var lk=$('bb-d-lock'), unlock=$('bb-d-unlock');
    if(cur.locked){ lk.textContent='🔒 A bot is working this card — fields & plan are read-only.';
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
        var ps=$('bb-d-project'); clearEl(ps); ps.appendChild(optEl('','— none —',false));
        (r.j.projects||[]).forEach(function(p){
          ps.appendChild(optEl(String(p.id),'#'+p.id+' — '+(p.name||''),Number(c.project_id)===Number(p.id)));
        });
      }
    });
    loadPlan();
    openDrawer(drawer);
  }
  function loadPlan(){
    var pm=$('bb-d-plan-msg'); msg(pm,'loading…','');
    api('GET','/card/'+cur.id+'/plan').then(function(r){
      if(r.ok&&r.j){ $('bb-d-plan').value=r.j.markdown||''; planMtime=r.j.mtime||null;
        msg(pm, r.j.exists?'':'(no plan yet)', ''); renderPre();
      } else { msg(pm, (r.j&&r.j.reason)||'plan unavailable','warn'); }
    });
  }
  function renderPre(){ $('bb-d-plan-pre').textContent=$('bb-d-plan').value; }

  document.addEventListener('click',function(ev){
    var c=ev.target.closest && ev.target.closest('.bb-card');
    if(c && !ev.target.closest('.bb-nojs-move')){ ev.preventDefault(); fillDrawer(c); }
  });
  $('bb-d-close').onclick=function(){ closeDrawer(drawer); cur=null; };
  $('bb-d-save').onclick=function(){
    if(!cur||cur.locked) return;
    var body={title:$('bb-d-title-in').value,status:$('bb-d-status').value,
      priority:$('bb-d-prio').value===''?null:Number($('bb-d-prio').value),
      due_date:$('bb-d-due').value||null,owner:$('bb-d-owner').value||null,
      tags:$('bb-d-tags').value||null,description:$('bb-d-desc').value||null};
    api('POST','/card/'+cur.id,body).then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'Saved.','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'🔒 '+((r.j&&r.j.reason)||'locked by a bot'),'err'); }
      else { msg($('bb-d-msg'),(r.j&&(r.j.error||r.j.reason))||'save failed','err'); }
    });
  };
  var projSel=$('bb-d-project');
  if(projSel) projSel.onchange=function(){
    if(!cur||cur.locked) return;
    var v=projSel.value===''?null:Number(projSel.value);
    api('POST','/card/'+cur.id+'/project',{project_id:v}).then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'Project updated.','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'🔒 locked','err'); }
      else msg($('bb-d-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  $('bb-d-cancel').onclick=function(){
    if(!cur||cur.locked||!confirm('Cancel card #'+cur.id+'?')) return;
    api('POST','/card/'+cur.id+'/cancel').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'Cancelled.','ok'); setTimeout(reload,400); }
      else if(r.status===409){ msg($('bb-d-msg'),'🔒 locked','err'); }
      else msg($('bb-d-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  $('bb-d-unlock').onclick=function(){
    if(!cur||!confirm('Force-unlock card #'+cur.id+'? Only if the bot/pi is confirmed dead.')) return;
    api('POST','/card/'+cur.id+'/force-unlock').then(function(r){
      if(r.ok){ msg($('bb-d-msg'),'Force-unlocked.','ok'); setTimeout(reload,500); }
      else msg($('bb-d-msg'),(r.j&&(r.j.reason||r.j.error))||'refused (fail-closed: pi not confirmed dead)','err');
    });
  };
  var planToggled=false;
  $('bb-d-plan-toggle').onclick=function(){
    planToggled=!planToggled; renderPre();
    $('bb-d-plan').style.display=planToggled?'none':'';
    $('bb-d-plan-pre').style.display=planToggled?'':'none';
    this.textContent=planToggled?'Edit':'Preview';
  };
  $('bb-d-plan').addEventListener('input',renderPre);
  $('bb-d-plan-save').onclick=function(){
    if(!cur||cur.locked) return;
    api('POST','/card/'+cur.id+'/plan',{markdown:$('bb-d-plan').value,mtime:planMtime}).then(function(r){
      if(r.ok){ planMtime=(r.j&&r.j.mtime)||planMtime; msg($('bb-d-plan-msg'),'Plan saved.','ok'); }
      else if(r.status===409){ msg($('bb-d-plan-msg'),'⚠️ Plan changed on disk — reloading newer content.','warn'); loadPlan(); }
      else msg($('bb-d-plan-msg'),(r.j&&(r.j.error||r.j.reason))||'save failed','err');
    });
  };

  document.addEventListener('dragstart',function(e){
    var c=e.target.closest&&e.target.closest('.bb-card'); if(!c) return;
    if(c.getAttribute('data-locked')==='1'){ e.preventDefault(); return; }
    dragId=Number(c.getAttribute('data-card')); e.dataTransfer.effectAllowed='move';
  });
  document.addEventListener('dragend',function(){ dragId=null;
    document.querySelectorAll('.bb-col').forEach(function(x){x.classList.remove('bb-dragover');}); });
  document.querySelectorAll('.bb-col').forEach(function(col){
    col.addEventListener('dragover',function(e){ e.preventDefault(); col.classList.add('bb-dragover'); });
    col.addEventListener('dragleave',function(){ col.classList.remove('bb-dragover'); });
    col.addEventListener('drop',function(e){
      e.preventDefault(); col.classList.remove('bb-dragover');
      if(dragId==null) return;
      var st=col.getAttribute('data-col'), id=dragId; dragId=null;
      api('POST','/card/'+id+'/move',{status:st}).then(function(r){
        if(r.ok) reload();
        else if(r.status===409) alert('🔒 Card #'+id+' is being worked by a bot.');
        else alert((r.j&&(r.j.error||r.j.reason))||'move failed');
      });
    });
  });

  var np=$('bb-newproj');
  var npBtn=$('bb-new-proj-btn'); if(npBtn) npBtn.onclick=function(){ msg($('bb-np-msg'),'',''); openDrawer(np); };
  $('bb-np-close').onclick=function(){ closeDrawer(np); };
  $('bb-np-save').onclick=function(){
    var name=$('bb-np-name').value.trim();
    if(!name){ msg($('bb-np-msg'),'Name required.','err'); return; }
    api('POST','/project',{name:name,description:$('bb-np-desc').value||null}).then(function(r){
      if(r.ok){ var id=r.j&&r.j.id; location.href='/dashboard/bot-board'+(id?'?project='+id:''); }
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
    msg($('bb-bk-msg'),'loading…',''); openDrawer(bk);
    api('GET','/project/'+PROJECT+'/unlinked').then(function(r){
      var L=$('bb-bk-list'); clearEl(L);
      if(r.ok&&r.j&&r.j.cards&&r.j.cards.length){
        r.j.cards.forEach(function(c){
          var lab=document.createElement('label'); lab.style.display='block'; lab.style.padding='.2rem 0';
          var cb=document.createElement('input'); cb.type='checkbox'; cb.value=String(c.id);
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(' #'+c.id+' — '+(c.title||'')));
          L.appendChild(lab);
        });
        msg($('bb-bk-msg'),'','');
      } else if(r.ok){ var p=document.createElement('p'); p.style.color='var(--crow-text-muted)';
        p.textContent='No unlinked cards.'; L.appendChild(p); msg($('bb-bk-msg'),'','');
      } else msg($('bb-bk-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };
  $('bb-bk-close').onclick=function(){ closeDrawer(bk); };
  $('bb-bk-save').onclick=function(){
    var ids=[].slice.call($('bb-bk-list').querySelectorAll('input:checked')).map(function(x){return Number(x.value);});
    if(!ids.length){ msg($('bb-bk-msg'),'Select at least one card.','err'); return; }
    if(ids.length>200){ msg($('bb-bk-msg'),'Max 200 per assign.','err'); return; }
    api('POST','/project/'+PROJECT+'/bulk-assign',{card_ids:ids}).then(function(r){
      if(r.ok){ var a=((r.j&&r.j.applied)||[]).length, s=((r.j&&r.j.skipped)||[]).length;
        msg($('bb-bk-msg'),'Applied '+a+', skipped '+s+'.','ok'); setTimeout(reload,800); }
      else msg($('bb-bk-msg'),(r.j&&(r.j.error||r.j.reason))||'failed','err');
    });
  };

  if(PROJECT!=null && window.EventSource){
    var es=new EventSource('/dashboard/streams/bot-board?project='+PROJECT);
    es.onmessage=function(ev){
      var d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
      if(!d||!d.cards) return;
      var busyId = dragId!=null ? dragId : (drawer.classList.contains('bb-open')&&cur?cur.id:null);
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
})();</script>`;
}
