/**
 * Bot Builder Panel — thin orchestrator.
 *
 * Wires together panels/bot-builder/ submodules: css, data-queries, peer-edit,
 * api-handlers, editor, html. Same manifest shape as the monolithic original.
 */
import { botBuilderStyles } from "./bot-builder/css.js";
import { loadModelOptions, tableMissing } from "./bot-builder/data-queries.js";
import { escapeHtml, section, badge, dataTable, formField, actionBar } from "../shared/components.js";
import { botRuntimeActive } from "./bot-runtime-flag.js";
import { handlePeerEdit } from "./bot-builder/peer-edit.js";
import { handleBotBuilderPost } from "./bot-builder/api-handlers.js";
import { renderBotEditor } from "./bot-builder/editor.js";

const PAGE_CSS = botBuilderStyles();

export default {
  id: "bot-builder",
  name: "Bot Builder",
  icon: "extensions",
  route: "/dashboard/bot-builder",
  navOrder: 14,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    const notAvail = await tableMissing(db);

    // ---- F4a L3: remote edit of a TRUSTED PEER's bot (?peer=<instanceId>&bot=<botId>) ----
    // Runs BEFORE the notAvail gate (peer-edit works even when pi_bot_defs is missing here).
    if (await handlePeerEdit(req, res, { db, layout })) return;

    // ---- POST ----
    if (req.method === "POST" && !notAvail) {
      await handleBotBuilderPost(req, res, { db });
      if (res.headersSent) return;
    }

    if (notAvail) {
      return res.send(layout({
        title: "Bot Builder",
        content: section("Bot Builder",
          `<p>The Bot Builder tables are not initialized on this instance.</p>` +
          `<p>Run <code>npm run init-db</code> on the host whose crow.db this gateway uses, then reload.</p>`),
      }));
    }

    const runtimeActive = await botRuntimeActive(db);
    const runtimeBanner = runtimeActive ? "" :
      `<p class="btb-notice-warn">Bot definitions are stored on this instance. ` +
      `The bot runtime (Gmail/Telegram/Discord gateways) is enabled per-instance and is not active here yet.</p>`;

    const q = req.query || {};
    const baseNotice = q.saved ? `<p class="btb-notice-ok">Saved.</p>`
      : q.created ? `<p class="btb-notice-ok">Created <code>${escapeHtml(String(q.created))}</code>.</p>`
      : q.error ? `<p class="btb-notice-err">${escapeHtml(String(q.error))}</p>` : "";
    // Soft, non-blocking warning (e.g. AI-tab model pair not in models.json).
    // Independent of the base notice so it can ride alongside a Saved.
    const warnNotice = q.warn ? `<p class="btb-notice-warn">${escapeHtml(String(q.warn))}</p>` : "";
    const notice = runtimeBanner + baseNotice + warnNotice;

    // ---- editor for one bot (C5: delegated to editor.js) ----
    if (q.bot) {
      return renderBotEditor(req, res, { db, layout, lang, PAGE_CSS, botId: String(q.bot), notice, q });
    }

    // ---- list + create ----
    let bots = [], sessions = [], sessRows = [];
    try {
      bots = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, project_id, datetime(updated_at) AS updated_at FROM pi_bot_defs ORDER BY bot_id", args: [] })).rows;
      sessions = (await db.execute({ sql: "SELECT bot_id, status, count(*) AS n FROM bot_sessions GROUP BY bot_id, status", args: [] })).rows;
      sessRows = (await db.execute({ sql: "SELECT id, bot_id, status, model, escalated, control, card_id, gateway_thread_id, datetime(updated_at) AS updated_at FROM bot_sessions ORDER BY updated_at DESC LIMIT 50", args: [] })).rows;
    } catch { /* defensive */ }
    const sessSummary = (id) => sessions.filter((s) => s.bot_id === id).map((s) => `${escapeHtml(s.status)}:${s.n}`).join(" ") || "—";
    const rows = bots.map((bt) => {
      let model = "—", trackerType = "none";
      try { const d = JSON.parse(bt.definition || "{}"); model = (d.models && d.models.default) || "—"; trackerType = (d.tracker_config && d.tracker_config.type) || "kanban"; } catch {}
      // M3b: project_id from the column (not JSON).
      const proj = bt.project_id == null ? "—" : bt.project_id;
      const boardLink = bt.enabled && trackerType !== "none"
        ? `<a href="/dashboard/bot-board?bot=${encodeURIComponent(bt.bot_id)}">Board</a>` : "";
      return [
        `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(bt.bot_id)}&tab=ai">${escapeHtml(bt.bot_id)}</a>`,
        escapeHtml(bt.display_name || ""),
        bt.enabled ? badge("enabled", "connected") : badge("disabled", "draft"),
        escapeHtml(String(model)),
        escapeHtml(String(proj)),
        escapeHtml(sessSummary(bt.bot_id)),
        escapeHtml(bt.updated_at || ""),
        boardLink,
        `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(bt.bot_id)}&tab=ai">Edit</a>`,
      ];
    });
    const list = section("Bots (pi_bot_defs)",
      notice + (rows.length
        ? dataTable(["bot_id", "name", "state", "model", "project", "sessions", "updated", "board", ""], rows)
        : "<p>No agents yet. Create one below.</p>"));
    // Create form: project + model dropdowns (Phase 1, S3 plan review)
    let createProjects = [];
    try { createProjects = (await db.execute({ sql: "SELECT id, name, slug FROM project_spaces WHERE archived_at IS NULL ORDER BY id", args: [] })).rows; } catch {}
    const projCreateOpts = createProjects.map((p) => `<option value="${p.id}">#${p.id} &mdash; ${escapeHtml(p.name || "")} (${escapeHtml(p.slug || "")})</option>`).join("");
    const { opts: createModelOpts, error: createModelErr } = await loadModelOptions(db);
    const createByProv = {};
    for (const o of createModelOpts) (createByProv[o.provider] = createByProv[o.provider] || []).push(o);
    const createOptGroups = Object.keys(createByProv).map((p) =>
      `<optgroup label="${escapeHtml(p)}">` +
      createByProv[p].map((m) => `<option value="${escapeHtml(m.key)}"${m.key === "crow-local/qwen3.6-35b-a3b" ? " selected" : ""}>${escapeHtml(m.label)}</option>`).join("") +
      `</optgroup>`
    ).join("");
    const form = section("Create an agent",
      `<form method="POST" class="btb-form"><input type="hidden" name="action" value="create">` +
      formField("Bot id (slug)", "bot_id", { required: true, placeholder: "research-scout" }) +
      formField("Display name", "display_name", { required: true, placeholder: "Research Scout" }) +
      `<div class="btb-group"><label>Linked project</label>` +
      `<select name="project_id" class="btb-select"><option value="">&mdash; none &mdash;</option>${projCreateOpts}</select></div>` +
      (createModelErr ? `<p class="btb-warn">${escapeHtml(createModelErr)}</p>` : "") +
      `<div class="btb-group"><label>Model</label>` +
      `<select name="model" class="btb-select">${createOptGroups}</select></div>` +
      actionBar(`<button type="submit" class="btb-btn">Create</button>`) + `</form>` +
      `<p class="btb-hint">Creates a v0.1 bot with safe defaults; then use the tabbed editor (AI &middot; Tools &middot; Gateways &middot; Project &middot; Skills &middot; Permissions &middot; Triggers &middot; Review).</p>`);
    // Run monitor — live bot_sessions (the bridge's runtime authority).
    // Initial server render + a poll-based SSE source (the bridge is a
    // separate process; /dashboard/streams/bot-sessions replaces the tbody
    // every 5s). #pibot-sessions-tbody is the Turbo replace target.
    const statusClass = (s) => {
      if (s === "active" || s === "done") return "btb-ok";
      if (s === "waiting-user") return "btb-status-warn";
      if (s === "error") return "btb-err";
      return "btb-muted";
    };
    const monRows = sessRows.length
      ? sessRows.map((s) => {
          const cls = statusClass(s.status);
          return `<tr>` +
            `<td>${escapeHtml(String(s.id))}</td>` +
            `<td>${escapeHtml(String(s.bot_id || ""))}</td>` +
            `<td class="${cls}">${escapeHtml(String(s.status || ""))}</td>` +
            `<td class="btb-mono">${escapeHtml(String(s.model || "—"))}</td>` +
            `<td>${Number(s.escalated) ? "yes" : "—"}</td>` +
            `<td>${escapeHtml(String(s.control || ""))}</td>` +
            `<td>${s.card_id == null ? "—" : escapeHtml(String(s.card_id))}</td>` +
            `<td class="btb-mono">${escapeHtml(String(s.gateway_thread_id || "").slice(0, 18))}</td>` +
            `<td class="btb-muted">${escapeHtml(String(s.updated_at || ""))}</td>` +
            `</tr>`;
        }).join("")
      : `<tr><td colspan="9" class="btb-muted" style="padding:.5rem">No bot sessions yet.</td></tr>`;
    const monitor = section("Run monitor (bot_sessions — live, 5s)",
      `<turbo-stream-source src="/dashboard/streams/bot-sessions"></turbo-stream-source>` +
      `<table class="btb-monitor"><thead><tr>` +
      `<th>id</th><th>bot</th><th>status</th>` +
      `<th>model</th><th>esc</th>` +
      `<th>control</th><th>card</th><th>thread</th>` +
      `<th>updated</th></tr></thead>` +
      `<tbody id="pibot-sessions-tbody">${monRows}</tbody></table>`);
    return res.send(layout({ title: "Bot Builder", content: PAGE_CSS + list + monitor + form }));
  },
};
