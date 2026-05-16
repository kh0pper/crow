/**
 * Bot Builder Panel (v0.1, minimal one-form) — Crow Bot Builder Phase 1.
 *
 * Lists pi_bot_defs and creates a v0.1 pi bot (the GUI equivalent of
 * scripts/pi-bots-phase1-setup.mjs's seed). DEFENSIVE: pi_bot_defs only
 * exists on the MPA instance's crow.db (created by scripts/init-pi-bots.mjs);
 * on any instance lacking it this panel must render a friendly notice and
 * NEVER throw — dashboard/index.js is shared by both gateways and a throw
 * here would break the primary Nest. Full GUI (tabs/tools/permissions) = Ph2.
 */
import { escapeHtml, section, badge, dataTable, formField, actionBar } from "../shared/components.js";

async function tableMissing(db) {
  try {
    await db.execute({ sql: "SELECT 1 FROM pi_bot_defs LIMIT 1", args: [] });
    return false;
  } catch {
    return true;
  }
}

export default {
  id: "bot-builder",
  name: "Bot Builder",
  icon: "extensions",
  route: "/dashboard/bot-builder",
  navOrder: 14,
  category: "tools",

  async handler(req, res, { db, layout }) {
    const notAvail = await tableMissing(db);

    if (req.method === "POST" && !notAvail) {
      const action = req.body && req.body.action;
      if (action === "create") {
        const display = (req.body.display_name || "").trim();
        const botId = (req.body.bot_id || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const projectId = req.body.project_id ? Number(req.body.project_id) : null;
        const model = (req.body.model || "crow-local/qwen3.6-35b-a3b").trim();
        if (!botId || !display) {
          return res.redirectAfterPost("/dashboard/bot-builder?error=name_required");
        }
        const sessionDir = `/home/kh0pp/.crow-mpa/pi-bots/${botId}`;
        const definition = {
          engine: "pi",
          models: { default: model },
          tools: { pi_builtin: ["read", "edit", "write"],
                   crow_mcp: ["crow-tasks/tasks_list", "crow-tasks/tasks_get", "crow-tasks/tasks_update",
                              "crow-tasks/tasks_complete", "crow-tasks/tasks_search"],
                   pi_extensions: [], skills: [] },
          gateways: [{ type: "gmail", address: `kevin.hopper+${botId}@maestro.press`,
                       allowlist: ["kevin.hopper1@gmail.com", "kevin.hopper@maestro.press"] }],
          project_id: projectId,
          permission_policy: { bash: "deny", write_paths: [sessionDir], external_send: "draft_only", confirm: [] },
          triggers: { gateway: true },
          system_prompt:
            `You are ${botId}, a single-purpose Crow bot. Operate ONLY within ` +
            `project ${projectId}'s Kanban (tasks_* filtered by that project_id) and ` +
            `your workspace ${sessionDir}. For the card you are told to do: read its ` +
            `plan file, do the work, write results into the plan file, advance the card ` +
            `pending->in_progress->done via tasks_update, then reply in the same gateway ` +
            `thread. Never send external email; never run bash. One card per request.`,
          skills: [], session_dir: sessionDir,
          spawn_env: { CROW_JOURNAL_MODE: "DELETE", PI_PROVIDER: "crow-local" },
        };
        try {
          await db.execute({
            sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1) " +
                 "ON CONFLICT(bot_id) DO UPDATE SET display_name=excluded.display_name, " +
                 "definition=excluded.definition, updated_at=datetime('now')",
            args: [botId, display, JSON.stringify(definition)],
          });
        } catch (e) {
          return res.redirectAfterPost("/dashboard/bot-builder?error=" + encodeURIComponent(String(e.message || e)));
        }
        return res.redirectAfterPost("/dashboard/bot-builder?created=" + encodeURIComponent(botId));
      }
      if (action === "toggle") {
        const botId = req.body.bot_id;
        try {
          await db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 1 - enabled, updated_at=datetime('now') WHERE bot_id=?", args: [botId] });
        } catch { /* ignore */ }
        return res.redirectAfterPost("/dashboard/bot-builder");
      }
    }

    if (notAvail) {
      return res.send(layout({
        title: "Bot Builder",
        content: section("Bot Builder (v0.1)",
          `<p>The <code>pi_bot_defs</code> table is not present on this instance.</p>` +
          `<p>Bot Builder runs on the MPA instance. Initialize with ` +
          `<code>node ~/crow/scripts/init-pi-bots.mjs</code> on the host whose ` +
          `crow.db this gateway uses.</p>`),
      }));
    }

    // List bots + live session counts (cross-table, same crow.db)
    let bots = [], sessions = [];
    try {
      bots = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, datetime(updated_at) AS updated_at FROM pi_bot_defs ORDER BY bot_id", args: [] })).rows;
      sessions = (await db.execute({ sql: "SELECT bot_id, status, count(*) AS n FROM bot_sessions GROUP BY bot_id, status", args: [] })).rows;
    } catch { /* defensive */ }

    const sessSummary = (botId) => sessions.filter((s) => s.bot_id === botId)
      .map((s) => `${escapeHtml(s.status)}:${s.n}`).join(" ") || "—";

    const rows = bots.map((b) => {
      let proj = "—", model = "—";
      try { const d = JSON.parse(b.definition || "{}"); proj = d.project_id ?? "—"; model = (d.models && d.models.default) || "—"; } catch {}
      return [
        escapeHtml(b.bot_id),
        escapeHtml(b.display_name || ""),
        b.enabled ? badge("enabled", "connected") : badge("disabled", "draft"),
        escapeHtml(String(model)),
        escapeHtml(String(proj)),
        escapeHtml(sessSummary(b.bot_id)),
        escapeHtml(b.updated_at || ""),
        `<form method="POST" style="display:inline">` +
          `<input type="hidden" name="action" value="toggle">` +
          `<input type="hidden" name="bot_id" value="${escapeHtml(b.bot_id)}">` +
          `<button type="submit">${b.enabled ? "Disable" : "Enable"}</button></form>`,
      ];
    });

    const q = req.query || {};
    const notice = q.created ? `<p>✅ Saved bot <code>${escapeHtml(String(q.created))}</code>.</p>`
      : q.error ? `<p style="color:#c0392b">⚠️ ${escapeHtml(String(q.error))}</p>` : "";

    const list = section("Bots (pi_bot_defs)",
      notice + (rows.length
        ? dataTable(["bot_id", "name", "state", "model", "project", "sessions", "updated", ""], rows)
        : "<p>No bots yet. Create one below.</p>"));

    const form = section("Create / update a v0.1 bot",
      `<form method="POST">` +
      `<input type="hidden" name="action" value="create">` +
      formField("Bot id (slug)", "bot_id", { required: true, placeholder: "research-scout" }) +
      formField("Display name", "display_name", { required: true, placeholder: "Research Scout (v0.1)" }) +
      formField("Project id (crow.db research_projects.id)", "project_id", { placeholder: "1" }) +
      formField("Model", "model", { value: "crow-local/qwen3.6-35b-a3b" }) +
      actionBar(`<button type="submit">Save bot</button>`) +
      `</form>` +
      `<p style="opacity:.7;font-size:.9em">v0.1 defaults: tools = read/edit/write + crow-tasks allowlist; ` +
      `bash denied; external email draft-only; Gmail gateway <code>kevin.hopper+&lt;bot_id&gt;@maestro.press</code>; ` +
      `workspace <code>~/.crow-mpa/pi-bots/&lt;bot_id&gt;</code>. Full tool/permission editor = Phase 2.</p>`);

    return res.send(layout({ title: "Bot Builder", content: list + form }));
  },
};
