/**
 * Bot Builder Panel — Crow Bot Builder Phase 2.3 (full tabbed editor).
 *
 * Server-rendered, Turbo/303-safe. List + create (v0.1 defaults) as before,
 * PLUS a one-bot-at-a-time tabbed editor (?bot=<id>&tab=<tab>): AI/Models ·
 * Tools&Extensions · Gateways · Project/Kanban · Skills&Prompt ·
 * Permissions/Safety · Triggers · Review/Deploy. Each tab POSTs only its own
 * fields; the handler merges them into the bot's definition JSON and writes
 * pi_bot_defs back, so a Save never clobbers other tabs.
 *
 * Picker data (plan §5): models = ~/.pi/agent/models.json; crow_mcp tools =
 * a LIVE per-server tools/list via scripts/pi-bots/mcp_writer.probeServerTools
 * (NOT getProxyStatus); a tool whose schema carries a `pattern`/regex gets a
 * non-blocking SOFT-WARN (S4 proved the crow-chat --jinja scar does NOT
 * reproduce under pi — warn, never fail-closed); projects = research_projects;
 * skills = ~/.crow/skills. "Review" regenerates the per-bot <session_dir>/
 * .mcp.json (Phase 2.1 writer). pi_extensions offered = curated allowlist
 * ONLY (Phase 2.4 enforces install-approval for anything else).
 *
 * DEFENSIVE: pi_bot_defs only exists on the MPA instance's crow.db. On any
 * instance lacking it this panel renders a friendly notice and NEVER throws —
 * dashboard/index.js is shared by both gateways.
 */
import { readFileSync, readdirSync } from "node:fs";
import { escapeHtml, section, badge, dataTable, formField, actionBar } from "../shared/components.js";
import { createDbClient } from "../../../db.js";
import {
  readCanonicalMcp,
  probeServerTools,
  serversForBot,
  writeBotMcp,
} from "../../../../scripts/pi-bots/mcp_writer.mjs";
import {
  PI_EXT_ALLOWLIST,
  MULTI_AGENT_CAPABLE,
  isMultiAgentCapable,
} from "../../../../scripts/pi-bots/pi_extensions_allowlist.mjs";
import {
  loadModels as loadModelsJson,
  validateModelKey,
  resolveModel,
} from "../../../../scripts/pi-bots/model_resolver.mjs";

const HOME = "/home/kh0pp";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const MODELS_JSON = HOME + "/.pi/agent/models.json";
const SKILLS_DIR = HOME + "/.crow/skills";
const PI_BUILTIN = ["read", "edit", "write", "bash", "list", "glob", "grep"];
// PI_EXT_ALLOWLIST is imported from the single-source module (Phase 2.4):
// scripts/pi-bots/pi_extensions_allowlist.mjs — the panel only OFFERS these;
// the bridge REFUSES anything else (no Bot Builder code ever runs `pi install`).
const TABS = [
  ["ai", "AI / Models"],
  ["tools", "Tools & Extensions"],
  ["gateways", "Gateways"],
  ["project", "Project / Kanban"],
  ["skills", "Skills & Prompt"],
  ["permissions", "Permissions / Safety"],
  ["triggers", "Triggers"],
  ["review", "Review / Deploy"],
];

// in-process probe cache (per gateway process), 5-min TTL — probing spawns
// every MCP server, so we don't redo it on every tools-tab render.
let _probeCache = null;
let _probeAt = 0;
async function probeAll() {
  if (_probeCache && Date.now() - _probeAt < 300000) return _probeCache;
  const out = {};
  let canonical;
  try {
    canonical = readCanonicalMcp();
  } catch (e) {
    return { _error: String(e.message || e) };
  }
  const names = Object.keys(canonical.mcpServers);
  await Promise.all(
    names.map(async (n) => {
      try {
        out[n] = await probeServerTools(canonical.mcpServers[n], { timeoutMs: 12000 });
      } catch (e) {
        out[n] = { ok: false, error: String(e.message || e) };
      }
    })
  );
  _probeCache = out;
  _probeAt = Date.now();
  return out;
}

// R14 (Phase 3.2): models.json read goes through the 3.0 resolver's
// loadModels() — the SINGLE source for "is models.json readable" (it returns
// null on ANY missing/parse failure). Returns { opts, error }: a malformed or
// missing models.json yields a soft inline `error` string + a crow-local
// fallback option so the AI tab still renders and a Save never 500s.
const MODEL_FALLBACK_OPT = {
  provider: "crow-local",
  key: "crow-local/qwen3.6-35b-a3b",
  label: "qwen3.6-35b-a3b",
};
function loadModelOptions() {
  const j = loadModelsJson();
  if (!j) {
    return {
      error: "~/.pi/agent/models.json is missing or malformed — showing the crow-local fallback only.",
      opts: [MODEL_FALLBACK_OPT],
    };
  }
  const provs = j.providers || {};
  const opts = [];
  for (const p of Object.keys(provs)) {
    for (const m of provs[p].models || []) {
      opts.push({ provider: p, key: `${p}/${m.id}`, label: `${m.name || m.id}` });
    }
  }
  if (!opts.length) {
    return {
      error: "~/.pi/agent/models.json has no providers/models — showing the crow-local fallback only.",
      opts: [MODEL_FALLBACK_OPT],
    };
  }
  return { error: null, opts };
}

function loadSkills() {
  try {
    return readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

async function tableMissing(db) {
  try {
    await db.execute({ sql: "SELECT 1 FROM pi_bot_defs LIMIT 1", args: [] });
    return false;
  } catch {
    return true;
  }
}

function defaultDefinition(botId, projectId, model) {
  const sessionDir = `${HOME}/.crow-mpa/pi-bots/${botId}`;
  return {
    engine: "pi",
    models: { default: model || "crow-local/qwen3.6-35b-a3b" },
    tools: {
      pi_builtin: ["read", "edit", "write"],
      crow_mcp: [
        "crow-tasks/tasks_list",
        "crow-tasks/tasks_get",
        "crow-tasks/tasks_update",
        "crow-tasks/tasks_complete",
        "crow-tasks/tasks_search",
      ],
      pi_extensions: [],
      skills: [],
    },
    gateways: [
      {
        type: "gmail",
        address: `kevin.hopper+${botId}@maestro.press`,
        allowlist: ["kevin.hopper1@gmail.com", "kevin.hopper@maestro.press"],
      },
    ],
    project_id: projectId,
    permission_policy: { bash: "deny", bash_allow: [], write_paths: [sessionDir], external_send: "draft_only", confirm: [] },
    triggers: { gateway: true, cron: "" },
    system_prompt:
      `You are ${botId}, a single-purpose Crow bot. Operate ONLY within ` +
      `project ${projectId}'s Kanban (tasks_* filtered by that project_id) and ` +
      `your workspace ${sessionDir}. For the card you are told to do: read its ` +
      `plan file, do the work, write results into the plan file, advance the card ` +
      `pending->in_progress->done via tasks_update, then reply in the same gateway ` +
      `thread. Never send external email; never run bash. One card per request.`,
    skills: [],
    session_dir: sessionDir,
    spawn_env: { CROW_JOURNAL_MODE: "DELETE", PI_PROVIDER: "crow-local" },
  };
}

const lines = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

export default {
  id: "bot-builder",
  name: "Bot Builder",
  icon: "extensions",
  route: "/dashboard/bot-builder",
  navOrder: 14,
  category: "tools",

  async handler(req, res, { db, layout }) {
    const notAvail = await tableMissing(db);

    // ---- POST ----
    if (req.method === "POST" && !notAvail) {
      const b = req.body || {};
      const action = b.action;

      if (action === "create") {
        const display = (b.display_name || "").trim();
        const botId = (b.bot_id || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const projectId = b.project_id ? Number(b.project_id) : null;
        const model = (b.model || "crow-local/qwen3.6-35b-a3b").trim();
        if (!botId || !display) return res.redirectAfterPost("/dashboard/bot-builder?error=name_required");
        try {
          await db.execute({
            sql:
              "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1) " +
              "ON CONFLICT(bot_id) DO UPDATE SET display_name=excluded.display_name, " +
              "definition=excluded.definition, updated_at=datetime('now')",
            args: [botId, display, JSON.stringify(defaultDefinition(botId, projectId, model))],
          });
        } catch (e) {
          return res.redirectAfterPost("/dashboard/bot-builder?error=" + encodeURIComponent(String(e.message || e)));
        }
        return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=ai&saved=1`);
      }

      if (action === "toggle") {
        try {
          await db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 1 - enabled, updated_at=datetime('now') WHERE bot_id=?", args: [b.bot_id] });
        } catch { /* ignore */ }
        return res.redirectAfterPost("/dashboard/bot-builder");
      }

      // tab saves — merge only that tab's fields into the existing definition
      if (action && action.startsWith("save_")) {
        const botId = b.bot_id;
        let row;
        try {
          row = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
        } catch { row = null; }
        if (!row) return res.redirectAfterPost("/dashboard/bot-builder?error=unknown_bot");
        let def;
        try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
        def.tools = def.tools || {};
        def.permission_policy = def.permission_policy || {};
        def.triggers = def.triggers || {};
        const tab = action.slice(5);
        // Extra query suffix carried into the post-save redirect (e.g. a soft
        // validation warning for the AI tab). Never blocks the save.
        let extraQ = "";

        if (tab === "ai") {
          def.models = def.models || {};
          def.models.default = (b.model_default || def.models.default || "").trim();
          const esc = (b.model_escalation || "").trim();
          if (esc) def.models.escalation = esc; else delete def.models.escalation;
          // R13/R14: validate the saved pair via the 3.0 resolver's validator
          // (single source). Non-blocking and never throws: a bad value can't
          // break the bot (resolveModel() fails closed to crow-local at
          // runtime), so we persist the operator's choice and only surface a
          // soft warning — a Save never 500s nor clobbers other tabs.
          try {
            const mj = loadModelsJson();
            if (!mj) {
              extraQ = "&warn=" + encodeURIComponent(
                "models.json unreadable — could not validate the model pair; saved anyway (runtime fails closed to crow-local).");
            } else {
              const bad = [];
              if (def.models.default && !validateModelKey(mj, def.models.default).ok) bad.push("default (" + def.models.default + ")");
              if (def.models.escalation && !validateModelKey(mj, def.models.escalation).ok) bad.push("escalation (" + def.models.escalation + ")");
              if (bad.length) {
                extraQ = "&warn=" + encodeURIComponent(
                  "not in models.json: " + bad.join(", ") + " — saved anyway (runtime fails closed to crow-local).");
              }
            }
          } catch {
            /* validation must never 500 the save (R14) */
          }
        } else if (tab === "tools") {
          const builtin = PI_BUILTIN.filter((t) => b["builtin_" + t]);
          const mcp = [].concat(b.crow_mcp || []).filter(Boolean);
          const exts = PI_EXT_ALLOWLIST.filter((e) => b["ext_" + e]);
          def.tools.pi_builtin = builtin.length ? builtin : ["read"];
          def.tools.crow_mcp = Array.isArray(mcp) ? mcp : [mcp];
          def.tools.pi_extensions = exts;
        } else if (tab === "gateways") {
          def.gateways = [
            {
              type: "gmail",
              address: (b.gw_address || "").trim(),
              allowlist: lines(b.gw_allowlist),
            },
          ];
        } else if (tab === "project") {
          def.project_id = b.project_id ? Number(b.project_id) : null;
        } else if (tab === "skills") {
          def.skills = [].concat(b.skills || []).filter(Boolean);
          def.tools.skills = def.skills;
          def.system_prompt = (b.system_prompt || "").trim();
        } else if (tab === "permissions") {
          def.permission_policy.bash = b.pp_bash || "deny";
          def.permission_policy.bash_allow = lines(b.pp_bash_allow);
          def.permission_policy.write_paths = lines(b.pp_write_paths);
          def.permission_policy.external_send = b.pp_external_send || "draft_only";
          def.permission_policy.confirm = lines(b.pp_confirm);
          // R13 (Phase 3.2): multi-agent opt-in. The pi-lab gate (Phase 3.1)
          // only ALLOWS the `subagent` tool when policy.multi_agent===true AND
          // the resolved model is MULTI_AGENT_CAPABLE; default false.
          def.permission_policy.multi_agent = !!b.pp_multi_agent;
        } else if (tab === "triggers") {
          def.triggers.gateway = !!b.tr_gateway;
          def.triggers.cron = (b.tr_cron || "").trim();
        }

        try {
          await db.execute({
            sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?",
            args: [JSON.stringify(def), botId],
          });
        } catch (e) {
          return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${tab}&error=` + encodeURIComponent(String(e.message || e)));
        }
        return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${tab}&saved=1${extraQ}`);
      }

      if (action === "regen_mcp") {
        const botId = b.bot_id;
        let msg;
        try {
          const row = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
          const def = JSON.parse(row.definition || "{}");
          const r = writeBotMcp(def);
          msg = `wrote ${r.path} (servers: ${r.servers.join(", ") || "none"}` +
            (r.warnings.length ? `; ⚠ ${r.warnings.join("; ")}` : "") +
            (r.journalGuarded.length ? `; journal-guarded: ${r.journalGuarded.join(",")}` : "") + ")";
        } catch (e) {
          msg = "ERROR: " + String(e.message || e);
        }
        return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=review&mcp=` + encodeURIComponent(msg));
      }
    }

    if (notAvail) {
      return res.send(layout({
        title: "Bot Builder",
        content: section("Bot Builder",
          `<p>The <code>pi_bot_defs</code> table is not present on this instance.</p>` +
          `<p>Bot Builder runs on the MPA instance. Initialize with ` +
          `<code>node ~/crow/scripts/init-pi-bots.mjs</code> on the host whose ` +
          `crow.db this gateway uses.</p>`),
      }));
    }

    const q = req.query || {};
    const baseNotice = q.saved ? `<p style="color:#1a7f37">✅ Saved.</p>`
      : q.created ? `<p style="color:#1a7f37">✅ Created <code>${escapeHtml(String(q.created))}</code>.</p>`
      : q.error ? `<p style="color:#c0392b">⚠️ ${escapeHtml(String(q.error))}</p>` : "";
    // Soft, non-blocking warning (e.g. AI-tab model pair not in models.json).
    // Independent of the base notice so it can ride alongside a ✅ Saved.
    const warnNotice = q.warn ? `<p style="color:#b8860b">⚠️ ${escapeHtml(String(q.warn))}</p>` : "";
    const notice = baseNotice + warnNotice;

    // ---- editor for one bot ----
    if (q.bot) {
      const botId = String(q.bot);
      let bot;
      try {
        bot = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
      } catch { bot = null; }
      if (!bot) return res.send(layout({ title: "Bot Builder", content: section("Bot Builder", `<p>Unknown bot.</p><p><a href="/dashboard/bot-builder">← back</a></p>`) }));
      let def; try { def = JSON.parse(bot.definition || "{}"); } catch { def = {}; }
      const tabId = TABS.find((t) => t[0] === (q.tab || "ai")) ? String(q.tab || "ai") : "ai";

      const nav = TABS.map(([id, lbl]) =>
        `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${id}" ` +
        `style="display:inline-block;padding:6px 12px;margin:0 4px 6px 0;border-radius:6px;text-decoration:none;` +
        `${id === tabId ? "background:#2d6cdf;color:#fff" : "background:#eee;color:#333"}">${escapeHtml(lbl)}</a>`
      ).join("");

      const hidden = (t) => `<input type="hidden" name="action" value="save_${t}"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">`;
      let body = "";

      if (tabId === "ai") {
        // Provider→model picker, grouped by provider via <optgroup> (the
        // server-rendered "cascading" shape — no client JS, Phase-2.3 style).
        const { opts: mOpts, error: mErr } = loadModelOptions();
        const byProv = {};
        for (const o of mOpts) (byProv[o.provider] = byProv[o.provider] || []).push(o);
        const optGroups = (sel) =>
          Object.keys(byProv)
            .map(
              (p) =>
                `<optgroup label="${escapeHtml(p)}">` +
                byProv[p]
                  .map((m) => `<option value="${escapeHtml(m.key)}"${m.key === sel ? " selected" : ""}>${escapeHtml(m.label)}</option>`)
                  .join("") +
                `</optgroup>`
            )
            .join("");
        const mErrHtml = mErr ? `<p style="color:#b8860b">⚠️ ${escapeHtml(mErr)}</p>` : "";
        body =
          `<form method="POST">${hidden("ai")}` +
          mErrHtml +
          `<label>Default model<br><select name="model_default">${optGroups((def.models || {}).default)}</select></label><br><br>` +
          `<label>Escalation model (optional, cloud)<br><select name="model_escalation"><option value="">— none —</option>${optGroups((def.models || {}).escalation)}</select></label>` +
          `<p style="opacity:.7;font-size:.9em">Escalation only applies when an inbound message contains the <code>!escalate</code> token (operator-driven, per-turn). Otherwise the bot always runs on its Default model. The token is stripped before the model sees the message.</p>` +
          actionBar(`<button type="submit">Save AI</button>`) + `</form>`;
      } else if (tabId === "tools") {
        const probe = await probeAll();
        const selBuiltin = new Set((def.tools && def.tools.pi_builtin) || []);
        const selMcp = new Set((def.tools && def.tools.crow_mcp) || []);
        const selExt = new Set((def.tools && def.tools.pi_extensions) || []);
        const builtinBoxes = PI_BUILTIN.map((t) =>
          `<label style="margin-right:14px"><input type="checkbox" name="builtin_${t}"${selBuiltin.has(t) ? " checked" : ""}> ${t}</label>`
        ).join("");
        let mcpHtml = "";
        if (probe._error) {
          mcpHtml = `<p style="color:#c0392b">MCP probe unavailable: ${escapeHtml(probe._error)}</p>`;
        } else {
          for (const srv of Object.keys(probe)) {
            const p = probe[srv];
            if (!p.ok) { mcpHtml += `<p><b>${escapeHtml(srv)}</b> <span style="color:#c0392b">(probe failed: ${escapeHtml(String(p.error || "").slice(0, 80))})</span></p>`; continue; }
            mcpHtml += `<p style="margin:10px 0 4px"><b>${escapeHtml(srv)}</b> <span style="opacity:.6">(${p.tools.length} tools)</span></p>`;
            mcpHtml += p.tools.map((t) => {
              const v = `${srv}/${t.name}`;
              const warn = t.hasPattern ? ` <span title="schema has a pattern/regex — pi tolerates it (S4), operator awareness only" style="color:#b8860b">⚠ regex</span>` : "";
              return `<label style="display:inline-block;width:46%;margin:2px 0"><input type="checkbox" name="crow_mcp" value="${escapeHtml(v)}"${selMcp.has(v) ? " checked" : ""}> ${escapeHtml(t.name)}${warn}</label>`;
            }).join("");
          }
        }
        const extBoxes = PI_EXT_ALLOWLIST.map((e) =>
          `<label style="margin-right:14px"><input type="checkbox" name="ext_${e}"${selExt.has(e) ? " checked" : ""}> ${e}</label>`
        ).join("");
        // R13 (Phase 3.2): non-blocking SOFT-WARN for `subagent` (Phase-2.3 /
        // S4 pattern — never fail-closed in the UI; the pi-lab gate is the
        // hard runtime backstop). Selecting it here does nothing unless the
        // bot's resolved model is MULTI_AGENT_CAPABLE AND Permissions →
        // Multi-agent is on.
        const subWarn = PI_EXT_ALLOWLIST.includes("subagent")
          ? `<p style="color:#b8860b;font-size:.9em;margin-top:6px">⚠ <code>subagent</code> is runtime-blocked unless this bot's resolved model is in MULTI_AGENT_CAPABLE <em>and</em> Permissions → Multi-agent is on. Capable models: <code>${escapeHtml(MULTI_AGENT_CAPABLE.join(", "))}</code>.</p>`
          : "";
        body =
          `<form method="POST">${hidden("tools")}` +
          `<p><b>pi builtin</b></p>${builtinBoxes}` +
          `<p style="margin-top:14px"><b>Crow MCP tools</b> (live tools/list; ⚠ regex = non-blocking soft-warn, S4)</p>${mcpHtml}` +
          `<p style="margin-top:14px"><b>pi extensions</b> (curated allowlist only; others need install-approval)</p>${extBoxes}${subWarn}` +
          actionBar(`<button type="submit">Save Tools</button>`) + `</form>`;
      } else if (tabId === "gateways") {
        const gw = (def.gateways && def.gateways[0]) || {};
        body =
          `<form method="POST">${hidden("gateways")}` +
          formField("Gmail address (+alias)", "gw_address", { value: gw.address || "" }) +
          `<label>Allowlist (one address per line)<br><textarea name="gw_allowlist" rows="4" style="width:420px">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></label>` +
          actionBar(`<button type="submit">Save Gateways</button>`) + `</form>`;
      } else if (tabId === "project") {
        let projects = [];
        try { projects = (await db.execute({ sql: "SELECT id, name FROM research_projects ORDER BY id", args: [] })).rows; } catch {}
        const opts = projects.map((p) => `<option value="${p.id}"${Number(def.project_id) === Number(p.id) ? " selected" : ""}>#${p.id} — ${escapeHtml(p.name || "")}</option>`).join("");
        // Phase 4: compact READ-ONLY Kanban snapshot for the linked project
        // + a link to the dedicated full board. Read-only, never throws,
        // POSTs nothing — the Phase-2.3 invariant (this tab saves ONLY
        // def.project_id via save_project) is unchanged.
        let snap = "";
        const pid = def.project_id;
        if (pid != null && pid !== "") {
          let tdb;
          try {
            tdb = createDbClient(TASKS_DB);
            const rows = (await tdb.execute({
              sql: "SELECT status, COUNT(*) AS n FROM tasks_items WHERE project_id=? GROUP BY status",
              args: [Number(pid)],
            })).rows || [];
            const c = { pending: 0, in_progress: 0, done: 0, cancelled: 0 };
            for (const r of rows) c[r.status] = Number(r.n);
            const total = c.pending + c.in_progress + c.done + c.cancelled;
            const href = "/dashboard/bot-board?project=" + encodeURIComponent(String(pid));
            snap =
              `<div style="margin:10px 0;padding:10px;background:#f6f8fa;border-radius:6px;font-size:.9em">` +
              `<b>Kanban snapshot</b> (project #${escapeHtml(String(pid))}, ${total} cards): ` +
              `pending <b>${c.pending}</b> · in_progress <b>${c.in_progress}</b> · ` +
              `done <b>${c.done}</b> · cancelled <b>${c.cancelled}</b>` +
              `<br><a href="${href}" style="color:#2d6cdf;font-weight:600">Open board ↗</a>` +
              `</div>`;
          } catch {
            snap = `<p style="opacity:.7;font-size:.85em">(Kanban snapshot unavailable — tasks.db not reachable on this instance.)</p>`;
          } finally {
            if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
          }
        }
        body =
          `<form method="POST">${hidden("project")}` +
          `<label>Linked project (crow.db research_projects)<br><select name="project_id"><option value="">— none —</option>${opts}</select></label>` +
          `<p style="opacity:.7;font-size:.9em">Kanban = tasks.db tasks_items filtered by this project_id (cross-DB app-level soft link).</p>` +
          snap +
          actionBar(`<button type="submit">Save Project</button>`) + `</form>`;
      } else if (tabId === "skills") {
        const skills = loadSkills();
        const sel = new Set((def.skills || []));
        const boxes = skills.length
          ? skills.map((s) => `<label style="margin-right:14px"><input type="checkbox" name="skills" value="${escapeHtml(s)}"${sel.has(s) ? " checked" : ""}> ${escapeHtml(s)}</label>`).join("")
          : `<p style="opacity:.7">No skills in ~/.crow/skills.</p>`;
        body =
          `<form method="POST">${hidden("skills")}` +
          `<p><b>Skills</b> (~/.crow/skills)</p>${boxes}` +
          `<p style="margin-top:14px"><b>System prompt</b></p>` +
          `<textarea name="system_prompt" rows="10" style="width:100%">${escapeHtml(def.system_prompt || "")}</textarea>` +
          actionBar(`<button type="submit">Save Skills & Prompt</button>`) + `</form>`;
      } else if (tabId === "permissions") {
        const pp = def.permission_policy || {};
        const bashSel = (v) => (pp.bash || "deny") === v ? " selected" : "";
        const esSel = (v) => (pp.external_send || "draft_only") === v ? " selected" : "";
        body =
          `<form method="POST">${hidden("permissions")}` +
          `<label>bash<br><select name="pp_bash"><option${bashSel("deny")}>deny</option><option${bashSel("allowlist")}>allowlist</option><option${bashSel("sandbox")}>sandbox</option></select></label><br><br>` +
          `<label>bash_allow prefixes (one per line; allowlist mode)<br><textarea name="pp_bash_allow" rows="3" style="width:420px">${escapeHtml((pp.bash_allow || []).join("\n"))}</textarea></label><br><br>` +
          `<label>write_paths (one per line)<br><textarea name="pp_write_paths" rows="3" style="width:420px">${escapeHtml((pp.write_paths || []).join("\n"))}</textarea></label><br><br>` +
          `<label>external_send<br><select name="pp_external_send"><option${esSel("draft_only")}>draft_only</option><option${esSel("allow")}>allow</option></select></label><br><br>` +
          `<label>confirm tools (one per line; blocked unattended)<br><textarea name="pp_confirm" rows="3" style="width:420px">${escapeHtml((pp.confirm || []).join("\n"))}</textarea></label><br><br>` +
          `<label><input type="checkbox" name="pp_multi_agent"${pp.multi_agent ? " checked" : ""}> Multi-agent (allow the <code>subagent</code> tool)</label>` +
          `<p style="opacity:.7;font-size:.9em">Multi-agent is gated by pi-lab/permission-gating.ts (Phase 3.1): <code>subagent</code> is allowed only when this is on AND the bot's resolved model is MULTI_AGENT_CAPABLE; recursion is depth-capped. Off by default.</p>` +
          `<p style="opacity:.7;font-size:.9em">Enforced by pi-lab/permission-gating.ts via PI_BOT_PERMISSION_POLICY (Phase 2.2). Default-deny for safety.</p>` +
          actionBar(`<button type="submit">Save Permissions</button>`) + `</form>`;
      } else if (tabId === "triggers") {
        const tr = def.triggers || {};
        body =
          `<form method="POST">${hidden("triggers")}` +
          `<label><input type="checkbox" name="tr_gateway"${tr.gateway ? " checked" : ""}> Gateway-triggered (Gmail inbound via the bridge tick)</label><br><br>` +
          formField("Cron (bridge's own timer; optional)", "tr_cron", { value: tr.cron || "", placeholder: "*/15 * * * *" }) +
          `<p style="opacity:.7;font-size:.9em">The bridge runs its OWN timer over triggers.cron — NOT the schedules table / pipeline-runner (plan §2).</p>` +
          actionBar(`<button type="submit">Save Triggers</button>`) + `</form>`;
      } else if (tabId === "review") {
        const mcpMsg = q.mcp ? `<p style="color:#1a7f37">${escapeHtml(String(q.mcp))}</p>` : "";
        // R13/R14 (Phase 3.2): show the EFFECTIVE runtime decision the bridge
        // will make — resolved default/escalation provider/model (via the 3.0
        // resolver, fail-closed, never throws), the multi_agent flag, and the
        // computed isMultiAgentCapable verdict for the default-resolved pair.
        let effHtml;
        try {
          const rDef = resolveModel(def, { escalate: false });
          const rEsc = resolveModel(def, { escalate: true });
          const maOn = !!(def.permission_policy && def.permission_policy.multi_agent);
          const capable = isMultiAgentCapable(rDef.provider, rDef.model);
          const escConfigured = !!(def.models && def.models.escalation);
          const fb = (r) => (r.source === "fallback" ? ` <span style="color:#b8860b">(fail-closed fallback)</span>` : "");
          const subAllowed = maOn && capable;
          effHtml =
            `<p><b>Effective runtime decision</b> (computed via model_resolver.mjs + pi_extensions_allowlist.mjs)</p>` +
            `<table style="border-collapse:collapse;font-size:.92em">` +
            `<tr><td style="padding:3px 12px 3px 0;opacity:.7">Default model</td><td><code>${escapeHtml(rDef.key)}</code> <span style="opacity:.6">source=${escapeHtml(rDef.source)}</span>${fb(rDef)}</td></tr>` +
            `<tr><td style="padding:3px 12px 3px 0;opacity:.7">Escalation model</td><td>` +
              (escConfigured
                ? `<code>${escapeHtml(rEsc.key)}</code> <span style="opacity:.6">source=${escapeHtml(rEsc.source)}</span>` +
                  (rEsc.escalationRequestedButUnavailable ? ` <span style="color:#b8860b">(configured value not in models.json — would fall back + notice)</span>` : "")
                : `<span style="opacity:.6">— none (escalation disabled; <code>!escalate</code> is a no-op)</span>`) +
            `</td></tr>` +
            `<tr><td style="padding:3px 12px 3px 0;opacity:.7">multi_agent flag</td><td>${maOn ? `<b style="color:#1a7f37">on</b>` : `<span style="opacity:.6">off</span>`}</td></tr>` +
            `<tr><td style="padding:3px 12px 3px 0;opacity:.7">isMultiAgentCapable(default)</td><td>${capable ? `<b style="color:#1a7f37">true</b>` : `<span style="color:#c0392b">false</span>`}</td></tr>` +
            `<tr><td style="padding:3px 12px 3px 0;opacity:.7">→ <code>subagent</code> at runtime</td><td>${subAllowed ? `<b style="color:#1a7f37">ALLOWED</b>` : `<b style="color:#c0392b">BLOCKED</b> <span style="opacity:.6">(${escapeHtml(!maOn ? "multi_agent off" : "model not MULTI_AGENT_CAPABLE")})</span>`}</td></tr>` +
            `</table>` +
            `<p style="opacity:.7;font-size:.85em">This mirrors the pi-lab gate (Phase 3.1): the bridge only offers <code>subagent</code> when both are true; the gate is the hard backstop. Escalation is per-turn via <code>!escalate</code> only.</p>`;
        } catch (e) {
          effHtml = `<p style="color:#b8860b">⚠️ Could not compute the effective runtime decision: ${escapeHtml(String(e.message || e))}</p>`;
        }
        body =
          mcpMsg +
          effHtml +
          `<p><b>Computed definition</b> (pi_bot_defs.definition)</p>` +
          `<pre style="background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;max-height:420px">${escapeHtml(JSON.stringify(def, null, 2))}</pre>` +
          `<p>Per-bot MCP servers from selection: <code>${escapeHtml(serversForBot(def).join(", ") || "(none)")}</code></p>` +
          `<form method="POST" style="display:inline"><input type="hidden" name="action" value="regen_mcp"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
          `<button type="submit">Regenerate &lt;session_dir&gt;/.mcp.json</button></form> ` +
          `<form method="POST" style="display:inline"><input type="hidden" name="action" value="toggle"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
          `<button type="submit">${bot.enabled ? "Disable bot" : "Enable bot"}</button></form>` +
          `<p style="opacity:.7;font-size:.9em">Saving a bot writes pi_bot_defs only. The bridge spawn-per-turn picks up changes on the next inbound; no gateway restart needed.</p>`;
      }

      return res.send(layout({
        title: "Bot Builder — " + escapeHtml(botId),
        content: section(
          `Edit bot: ${escapeHtml(bot.display_name || botId)} ${bot.enabled ? badge("enabled", "connected") : badge("disabled", "draft")}`,
          `<p><a href="/dashboard/bot-builder">← all bots</a></p>` + notice +
          `<div style="margin:10px 0 16px">${nav}</div>` + body
        ),
      }));
    }

    // ---- list + create ----
    let bots = [], sessions = [], sessRows = [];
    try {
      bots = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, datetime(updated_at) AS updated_at FROM pi_bot_defs ORDER BY bot_id", args: [] })).rows;
      sessions = (await db.execute({ sql: "SELECT bot_id, status, count(*) AS n FROM bot_sessions GROUP BY bot_id, status", args: [] })).rows;
      sessRows = (await db.execute({ sql: "SELECT id, bot_id, status, model, escalated, control, card_id, gateway_thread_id, datetime(updated_at) AS updated_at FROM bot_sessions ORDER BY updated_at DESC LIMIT 50", args: [] })).rows;
    } catch { /* defensive */ }
    const sessSummary = (id) => sessions.filter((s) => s.bot_id === id).map((s) => `${escapeHtml(s.status)}:${s.n}`).join(" ") || "—";
    const rows = bots.map((bt) => {
      let proj = "—", model = "—";
      try { const d = JSON.parse(bt.definition || "{}"); proj = d.project_id ?? "—"; model = (d.models && d.models.default) || "—"; } catch {}
      return [
        `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(bt.bot_id)}&tab=ai">${escapeHtml(bt.bot_id)}</a>`,
        escapeHtml(bt.display_name || ""),
        bt.enabled ? badge("enabled", "connected") : badge("disabled", "draft"),
        escapeHtml(String(model)),
        escapeHtml(String(proj)),
        escapeHtml(sessSummary(bt.bot_id)),
        escapeHtml(bt.updated_at || ""),
        `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(bt.bot_id)}&tab=ai">Edit</a>`,
      ];
    });
    const list = section("Bots (pi_bot_defs)",
      notice + (rows.length
        ? dataTable(["bot_id", "name", "state", "model", "project", "sessions", "updated", ""], rows)
        : "<p>No bots yet. Create one below.</p>"));
    const form = section("Create a bot",
      `<form method="POST"><input type="hidden" name="action" value="create">` +
      formField("Bot id (slug)", "bot_id", { required: true, placeholder: "research-scout" }) +
      formField("Display name", "display_name", { required: true, placeholder: "Research Scout" }) +
      formField("Project id", "project_id", { placeholder: "1" }) +
      formField("Model", "model", { value: "crow-local/qwen3.6-35b-a3b" }) +
      actionBar(`<button type="submit">Create</button>`) + `</form>` +
      `<p style="opacity:.7;font-size:.9em">Creates a v0.1 bot with safe defaults; then use the tabbed editor (AI · Tools · Gateways · Project · Skills · Permissions · Triggers · Review).</p>`);
    // Run monitor — live bot_sessions (the bridge's runtime authority).
    // Initial server render + a poll-based SSE source (the bridge is a
    // separate process; /dashboard/streams/bot-sessions replaces the tbody
    // every 5s). #pibot-sessions-tbody is the Turbo replace target.
    const COLOR = { active: "#1a7f37", "waiting-user": "#b8860b", stopped: "#888", done: "#2d6cdf", error: "#c0392b" };
    const monRows = sessRows.length
      ? sessRows.map((s) => {
          const c = COLOR[s.status] || "#333";
          return `<tr>` +
            `<td style="padding:4px 8px">${escapeHtml(String(s.id))}</td>` +
            `<td style="padding:4px 8px">${escapeHtml(String(s.bot_id || ""))}</td>` +
            `<td style="padding:4px 8px;color:${c};font-weight:600">${escapeHtml(String(s.status || ""))}</td>` +
            `<td style="padding:4px 8px;font-family:monospace;font-size:.8rem">${escapeHtml(String(s.model || "—"))}</td>` +
            `<td style="padding:4px 8px">${Number(s.escalated) ? "yes" : "—"}</td>` +
            `<td style="padding:4px 8px">${escapeHtml(String(s.control || ""))}</td>` +
            `<td style="padding:4px 8px">${s.card_id == null ? "—" : escapeHtml(String(s.card_id))}</td>` +
            `<td style="padding:4px 8px;font-family:monospace;font-size:.8rem">${escapeHtml(String(s.gateway_thread_id || "").slice(0, 18))}</td>` +
            `<td style="padding:4px 8px;color:#888">${escapeHtml(String(s.updated_at || ""))}</td>` +
            `</tr>`;
        }).join("")
      : `<tr><td colspan="9" style="padding:8px;color:#888">No bot sessions yet.</td></tr>`;
    const monitor = section("Run monitor (bot_sessions — live, 5s)",
      `<turbo-stream-source src="/dashboard/streams/bot-sessions"></turbo-stream-source>` +
      `<table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left;border-bottom:1px solid #ddd">` +
      `<th style="padding:4px 8px">id</th><th style="padding:4px 8px">bot</th><th style="padding:4px 8px">status</th>` +
      `<th style="padding:4px 8px">model</th><th style="padding:4px 8px">esc</th>` +
      `<th style="padding:4px 8px">control</th><th style="padding:4px 8px">card</th><th style="padding:4px 8px">thread</th>` +
      `<th style="padding:4px 8px">updated</th></tr></thead>` +
      `<tbody id="pibot-sessions-tbody">${monRows}</tbody></table>`);
    return res.send(layout({ title: "Bot Builder", content: list + monitor + form }));
  },
};
