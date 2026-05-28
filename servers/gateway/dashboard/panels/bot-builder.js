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
  resolveModel,
} from "../../../../scripts/pi-bots/model_resolver.mjs";
import { listProvidersAll } from "../../../orchestrator/providers-db.js";

const HOME = "/home/kh0pp";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const SKILLS_DIR = HOME + "/.crow/skills";
const REPO_SKILLS_DIR = HOME + "/crow/skills";
const PI_BUILTIN = ["read", "edit", "write", "bash", "list", "glob", "grep"];
// PI_EXT_ALLOWLIST is imported from the single-source module (Phase 2.4):
// scripts/pi-bots/pi_extensions_allowlist.mjs — the panel only OFFERS these;
// the bridge REFUSES anything else (no Bot Builder code ever runs `pi install`).
const TABS = [
  ["ai", "AI / Models"],
  ["tools", "Tools & Extensions"],
  ["gateways", "Gateways"],
  ["tracker", "Project / Tracker"],
  ["skills", "Skills & Prompt"],
  ["permissions", "Permissions / Safety"],
  ["triggers", "Triggers"],
  ["sessions", "Sessions"],
  ["review", "Review / Deploy"],
];

/* ── PAGE_CSS ── scoped styles for the bot-builder panel ── */
const PAGE_CSS = `<style>
  /* Tab navigation */
  .btb-tabs{display:flex;gap:.35rem;flex-wrap:wrap;margin:10px 0 16px}
  .btb-tab{display:inline-block;padding:.4rem .75rem;border-radius:var(--crow-radius-pill);text-decoration:none;font-size:.85rem;font-weight:500;background:var(--crow-bg-elevated);color:var(--crow-text-secondary);border:1px solid var(--crow-border);transition:background .12s,color .12s,border-color .12s}
  .btb-tab:hover{background:var(--crow-bg-surface);color:var(--crow-text-primary);border-color:var(--crow-accent)}
  .btb-tab-active{background:var(--crow-accent);color:#fff;border-color:var(--crow-accent)}
  .btb-tab-active:hover{background:var(--crow-accent);color:#fff}

  /* Form layout */
  .btb-form{padding:0}
  .btb-group{margin-bottom:1rem}
  .btb-group>label{display:block;font-size:.8rem;color:var(--crow-text-muted);margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.05em}

  /* Form fields */
  .btb-select,.btb-input,.btb-textarea{width:100%;max-width:480px;padding:.45rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary);font:inherit}
  .btb-textarea{font-family:'JetBrains Mono',monospace;font-size:.82rem;min-height:80px}
  .btb-textarea-wide{max-width:100%}

  /* Hints & warnings */
  .btb-hint{font-size:.9em;color:var(--crow-text-muted);margin:.35rem 0 .75rem}
  .btb-warn{font-size:.9em;color:var(--crow-text-secondary);margin:.35rem 0 .75rem;font-style:italic}

  /* Notices */
  .btb-notice-ok{color:var(--crow-success)}
  .btb-notice-err{color:var(--crow-error)}
  .btb-notice-warn{color:var(--crow-text-secondary);font-style:italic}

  /* Divider */
  .btb-divider{margin:1rem 0;border:none;border-top:1px solid var(--crow-border)}

  /* Checkboxes */
  .btb-checkbox-group{display:flex;flex-wrap:wrap;gap:.25rem .75rem;margin:.5rem 0}
  .btb-checkbox{display:inline-flex;align-items:center;gap:.3rem;font-size:.88rem;cursor:pointer;padding:.2rem 0}
  .btb-checkbox input[type="checkbox"]{margin:0}

  /* MCP tool grid */
  .btb-mcp-section{margin:.75rem 0 .5rem}
  .btb-mcp-section b{font-size:.9rem}
  .btb-mcp-count{font-size:.8rem;color:var(--crow-text-muted)}
  .btb-mcp-grid{display:flex;flex-wrap:wrap;gap:0}
  .btb-mcp-tool{display:inline-flex;align-items:center;gap:.3rem;width:48%;font-size:.85rem;padding:.15rem 0}
  .btb-mcp-regex{color:var(--crow-text-secondary);font-size:.8rem}

  /* Tables */
  .btb-table{width:100%;border-collapse:collapse;font-size:.85rem}
  .btb-table thead tr{border-bottom:1px solid var(--crow-border)}
  .btb-table th{padding:.35rem .5rem;text-align:left;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--crow-text-muted);font-weight:600}
  .btb-table td{padding:.35rem .5rem}
  .btb-table tbody tr{border-bottom:1px solid var(--crow-border)}
  .btb-table tbody tr:last-child{border-bottom:none}
  .btb-table input,.btb-table select{padding:.25rem .35rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-primary);font:inherit;font-size:.85rem}

  /* Monitor table */
  .btb-monitor{width:100%;border-collapse:collapse;font-size:.85rem}
  .btb-monitor thead tr{text-align:left;border-bottom:1px solid var(--crow-border)}
  .btb-monitor th{padding:.35rem .5rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--crow-text-muted);font-weight:600}
  .btb-monitor td{padding:.35rem .5rem}
  .btb-monitor tbody tr{border-bottom:1px solid var(--crow-border)}
  .btb-monitor tbody tr:last-child{border-bottom:none}
  .btb-monitor .btb-mono{font-family:'JetBrains Mono',monospace;font-size:.8rem}

  /* Status colors */
  .btb-ok{color:var(--crow-success);font-weight:600}
  .btb-err{color:var(--crow-error);font-weight:600}
  .btb-status-warn{color:var(--crow-text-secondary);font-weight:600}
  .btb-muted{color:var(--crow-text-muted)}

  /* Snapshot card */
  .btb-snapshot{margin:.75rem 0;padding:.75rem;background:var(--crow-bg-elevated);color:var(--crow-text-primary);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);font-size:.9em}
  .btb-snapshot a{color:var(--crow-accent);font-weight:600}

  /* Send panel (sessions tab) */
  .btb-send-panel{display:none;margin:1rem 0;padding:.75rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card)}
  .btb-send-panel label{font-size:.8rem}
  .btb-send-panel textarea{width:100%;margin:.4rem 0}
  .btb-send-panel .btb-send-status{margin-left:.5rem;font-size:.8rem}

  /* Review tab */
  .btb-review-table{border-collapse:collapse;font-size:.92em}
  .btb-review-table td{padding:.2rem .75rem .2rem 0}
  .btb-review-table td:first-child{color:var(--crow-text-muted)}
  .btb-review-table code{font-family:'JetBrains Mono',monospace;font-size:.88em}
  .btb-review-source{font-size:.85em;color:var(--crow-text-muted)}
  .btb-review-fallback{color:var(--crow-text-secondary)}

  .btb-pre{background:var(--crow-bg-elevated);color:var(--crow-text-primary);border:1px solid var(--crow-border);padding:.75rem;border-radius:var(--crow-radius-card);overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono',monospace;font-size:.82rem}

  /* Tracker def editor */
  .btb-tdef-msg{font-size:.82rem;min-height:1.1em;margin:.25rem 0}

  /* Buttons (reuse bb-btn/bb-sec from bot-board where available) */
  .btb-btn{padding:.45rem .9rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:#fff;cursor:pointer;font:inherit}
  .btb-btn-sec{background:var(--crow-bg-elevated);color:var(--crow-text-secondary);border:1px solid var(--crow-border)}
  .btb-btn-sm{font-size:.78rem;padding:.2rem .5rem}
  .btb-btn-inline{display:inline}

  /* Session action buttons */
  .btb-sess-btn{font-size:.75rem;padding:.15rem .4rem;cursor:pointer;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-primary)}
  .btb-sess-link{font-size:.75rem;color:var(--crow-accent)}
</style>`;

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
async function loadModelOptions(db) {
  try {
    const all = await listProvidersAll(db);
    const enabled = all.filter((p) => !p.disabled);
    const opts = [];
    for (const row of enabled) {
      for (const m of row.models || []) {
        const mid = typeof m === "string" ? m : m.id;
        if (!mid) continue;
        opts.push({ provider: row.id, key: `${row.id}/${mid}`, label: (m.name || mid) });
      }
    }
    if (!opts.length) return { error: "No providers configured.", opts: [] };
    return { error: null, opts };
  } catch (err) {
    return { error: "Provider registry unavailable: " + err.message, opts: [] };
  }
}

function loadSkills() {
  const names = new Set();
  for (const dir of [SKILLS_DIR, REPO_SKILLS_DIR]) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".md")) names.add(f.replace(/\.md$/, ""));
      }
    } catch { /* dir missing */ }
  }
  return [...names].sort();
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
  // M3b: project_id is no longer a field in this returned object — the
  // pi_bot_defs.project_id column is authoritative. We still take projectId
  // as a parameter so the system_prompt template can baked-reference the
  // project number at creation time (it's just a string in the prompt; the
  // runtime project context block in bridge.mjs supersedes it).
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
          // M3b: project_id goes in the column, not the JSON. defaultDefinition
          // no longer includes it.
          await db.execute({
            sql:
              "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1) " +
              "ON CONFLICT(bot_id) DO UPDATE SET display_name=excluded.display_name, " +
              "definition=excluded.definition, project_id=excluded.project_id, updated_at=datetime('now')",
            args: [botId, display, JSON.stringify(defaultDefinition(botId, projectId, model)), projectId],
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
          // M3b: also fetch project_id column (authoritative). After parsing
          // the JSON we set def.project_id from the column so the rest of
          // this handler can keep reading `def.project_id` transparently.
          row = (await db.execute({ sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
        } catch { row = null; }
        if (!row) return res.redirectAfterPost("/dashboard/bot-builder?error=unknown_bot");
        let def;
        try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
        def.tools = def.tools || {};
        def.permission_policy = def.permission_policy || {};
        def.triggers = def.triggers || {};
        // M3b: column wins over JSON. Stale JSON copies of project_id will
        // never be re-baked because we don't read them anywhere downstream.
        def.project_id = row.project_id == null ? null : Number(row.project_id);
        let columnProjectIdUpdate = null;  // set when the project tab is saved
        const tab = action.slice(5);
        // Extra query suffix carried into the post-save redirect (e.g. a soft
        // validation warning for the AI tab). Never blocks the save.
        let extraQ = "";

        if (tab === "ai") {
          def.models = def.models || {};
          def.models.default = (b.model_default || def.models.default || "").trim();
          const esc = (b.model_escalation || "").trim();
          if (esc) def.models.escalation = esc; else delete def.models.escalation;
          try {
            const { opts } = await loadModelOptions(db);
            const validKeys = new Set(opts.map((o) => o.key));
            const bad = [];
            if (def.models.default && !validKeys.has(def.models.default)) bad.push("default (" + def.models.default + ")");
            if (def.models.escalation && !validKeys.has(def.models.escalation)) bad.push("escalation (" + def.models.escalation + ")");
            if (bad.length) {
              extraQ = "&warn=" + encodeURIComponent(
                "not in provider registry: " + bad.join(", ") + " — saved anyway (runtime fails closed to crow-local).");
            }
          } catch {
            /* validation must never 500 the save */
          }
        } else if (tab === "tools") {
          const builtin = PI_BUILTIN.filter((t) => b["builtin_" + t]);
          const mcp = [].concat(b.crow_mcp || []).filter(Boolean);
          const exts = PI_EXT_ALLOWLIST.filter((e) => b["ext_" + e]);
          def.tools.pi_builtin = builtin.length ? builtin : ["read"];
          def.tools.crow_mcp = Array.isArray(mcp) ? mcp : [mcp];
          def.tools.pi_extensions = exts;
        } else if (tab === "gateways") {
          const gwType = (b.gw_type || "gmail").trim();
          if (gwType === "none") {
            def.gateways = [];
          } else {
            def.gateways = [
              {
                type: gwType,
                address: (b.gw_address || "").trim(),
                allowlist: lines(b.gw_allowlist),
              },
            ];
          }
        } else if (tab === "tracker") {
          // M3b: project_id is owned by the column now.
          const next = b.project_id ? Number(b.project_id) : null;
          def.project_id = next;
          columnProjectIdUpdate = next;
          // S3: tracker_config
          const ttype = b.tracker_type || "kanban";
          def.tracker_config = def.tracker_config || {};
          def.tracker_config.type = ttype;
          if (ttype === "custom") {
            def.tracker_config.tracker_slug = (b.tracker_slug || "").trim();
            def.tracker_config.context_fields = (b.context_fields || "").split(",").map((s) => s.trim()).filter(Boolean);
            const qf = (b.queue_filter_key || "").trim();
            const qv = (b.queue_filter_value || "").trim();
            if (qf && qv) { def.tracker_config.queue_filter = { [qf]: qv }; }
            else { delete def.tracker_config.queue_filter; }
          } else if (ttype === "kanban" || ttype === "task-list") {
            delete def.tracker_config.tracker_slug;
            delete def.tracker_config.context_fields;
            delete def.tracker_config.queue_filter;
          } else if (ttype === "none") {
            delete def.tracker_config.tracker_slug;
            delete def.tracker_config.context_fields;
            delete def.tracker_config.queue_filter;
          }
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
          // M3b: when the project tab is saved, the project_id column gets
          // updated alongside definition JSON — column is authoritative for
          // every downstream reader (bridge.mjs, bot-board, bot-board-api).
          if (columnProjectIdUpdate !== null) {
            await db.execute({
              sql: "UPDATE pi_bot_defs SET definition=?, project_id=?, updated_at=datetime('now') WHERE bot_id=?",
              args: [JSON.stringify(def), columnProjectIdUpdate, botId],
            });
          } else {
            await db.execute({
              sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?",
              args: [JSON.stringify(def), botId],
            });
          }
        } catch (e) {
          return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${tab}&error=` + encodeURIComponent(String(e.message || e)));
        }
        return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${tab}&saved=1${extraQ}`);
      }

      if (action === "regen_mcp") {
        const botId = b.bot_id;
        let msg;
        try {
          // M3b: also fetch project_id so we can resolve the actual sessionDir
          // (workspace path) the bridge will use; the .mcp.json must live next
          // to where pi runs, not at the legacy def.session_dir.
          const row = (await db.execute({
            sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?",
            args: [botId],
          })).rows[0];
          const def = JSON.parse(row.definition || "{}");
          let sessionDir = def.session_dir;
          if (row.project_id != null) {
            const ws = (await db.execute({
              sql: "SELECT workspace_dir FROM project_spaces WHERE id=?",
              args: [row.project_id],
            })).rows[0];
            if (ws && ws.workspace_dir) {
              sessionDir = ws.workspace_dir + "/bots/" + botId;
            }
          }
          const r = writeBotMcp(def, { sessionDir });
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
    const baseNotice = q.saved ? `<p class="btb-notice-ok">Saved.</p>`
      : q.created ? `<p class="btb-notice-ok">Created <code>${escapeHtml(String(q.created))}</code>.</p>`
      : q.error ? `<p class="btb-notice-err">${escapeHtml(String(q.error))}</p>` : "";
    // Soft, non-blocking warning (e.g. AI-tab model pair not in models.json).
    // Independent of the base notice so it can ride alongside a Saved.
    const warnNotice = q.warn ? `<p class="btb-notice-warn">${escapeHtml(String(q.warn))}</p>` : "";
    const notice = baseNotice + warnNotice;

    // ---- editor for one bot ----
    if (q.bot) {
      const botId = String(q.bot);
      let bot;
      try {
        bot = (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
      } catch { bot = null; }
      if (!bot) return res.send(layout({ title: "Bot Builder", content: PAGE_CSS + section("Bot Builder", `<p>Unknown bot.</p><p><a href="/dashboard/bot-builder">&larr; back</a></p>`) }));
      let def; try { def = JSON.parse(bot.definition || "{}"); } catch { def = {}; }
      // M3b: column is authoritative — overwrite any stale JSON copy of project_id.
      def.project_id = bot.project_id == null ? null : Number(bot.project_id);
      const tabId = TABS.find((t) => t[0] === (q.tab || "ai")) ? String(q.tab || "ai") : "ai";

      const nav = `<div class="btb-tabs">` +
        TABS.map(([id, lbl]) =>
          `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${id}" ` +
          `class="btb-tab${id === tabId ? " btb-tab-active" : ""}">${escapeHtml(lbl)}</a>`
        ).join("") +
        `</div>`;

      const hidden = (t) => `<input type="hidden" name="action" value="save_${t}"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">`;
      let body = "";

      if (tabId === "ai") {
        // Provider->model picker, grouped by provider via <optgroup> (the
        // server-rendered "cascading" shape — no client JS, Phase-2.3 style).
        const { opts: mOpts, error: mErr } = await loadModelOptions(db);
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
        const mErrHtml = mErr ? `<p class="btb-warn">${escapeHtml(mErr)}</p>` : "";
        body =
          `<form method="POST" class="btb-form">${hidden("ai")}` +
          mErrHtml +
          `<div class="btb-group"><label>Default model</label>` +
          `<select name="model_default" class="btb-select">${optGroups((def.models || {}).default)}</select></div>` +
          `<div class="btb-group"><label>Escalation model (optional, cloud)</label>` +
          `<select name="model_escalation" class="btb-select"><option value="">&mdash; none &mdash;</option>${optGroups((def.models || {}).escalation)}</select></div>` +
          `<p class="btb-hint">Escalation only applies when an inbound message contains the <code>!escalate</code> token (operator-driven, per-turn). Otherwise the bot always runs on its Default model. The token is stripped before the model sees the message.</p>` +
          actionBar(`<button type="submit" class="btb-btn">Save AI</button>`) + `</form>`;
      } else if (tabId === "tools") {
        const probe = await probeAll();
        const selBuiltin = new Set((def.tools && def.tools.pi_builtin) || []);
        const selMcp = new Set((def.tools && def.tools.crow_mcp) || []);
        const selExt = new Set((def.tools && def.tools.pi_extensions) || []);
        const builtinBoxes = `<div class="btb-checkbox-group">` +
          PI_BUILTIN.map((t) =>
            `<label class="btb-checkbox"><input type="checkbox" name="builtin_${t}"${selBuiltin.has(t) ? " checked" : ""}> ${t}</label>`
          ).join("") + `</div>`;
        let mcpHtml = "";
        if (probe._error) {
          mcpHtml = `<p class="btb-err">MCP probe unavailable: ${escapeHtml(probe._error)}</p>`;
        } else {
          for (const srv of Object.keys(probe)) {
            const p = probe[srv];
            if (!p.ok) {
              mcpHtml += `<p class="btb-mcp-section"><b>${escapeHtml(srv)}</b> <span class="btb-err">(probe failed: ${escapeHtml(String(p.error || "").slice(0, 80))})</span></p>`;
              continue;
            }
            mcpHtml += `<p class="btb-mcp-section"><b>${escapeHtml(srv)}</b> <span class="btb-mcp-count">(${p.tools.length} tools)</span></p>`;
            mcpHtml += `<div class="btb-mcp-grid">` + p.tools.map((t) => {
              const v = `${srv}/${t.name}`;
              const warn = t.hasPattern ? ` <span title="schema has a pattern/regex — pi tolerates it (S4), operator awareness only" class="btb-mcp-regex">&#9888; regex</span>` : "";
              return `<label class="btb-mcp-tool"><input type="checkbox" name="crow_mcp" value="${escapeHtml(v)}"${selMcp.has(v) ? " checked" : ""}> ${escapeHtml(t.name)}${warn}</label>`;
            }).join("") + `</div>`;
          }
        }
        const extBoxes = `<div class="btb-checkbox-group">` +
          PI_EXT_ALLOWLIST.map((e) =>
            `<label class="btb-checkbox"><input type="checkbox" name="ext_${e}"${selExt.has(e) ? " checked" : ""}> ${e}</label>`
          ).join("") + `</div>`;
        // R13 (Phase 3.2): non-blocking SOFT-WARN for `subagent` (Phase-2.3 /
        // S4 pattern — never fail-closed in the UI; the pi-lab gate is the
        // hard runtime backstop). Selecting it here does nothing unless the
        // bot's resolved model is MULTI_AGENT_CAPABLE AND Permissions →
        // Multi-agent is on.
        const subWarn = PI_EXT_ALLOWLIST.includes("subagent")
          ? `<p class="btb-warn">&#9888; <code>subagent</code> is runtime-blocked unless this bot's resolved model is in MULTI_AGENT_CAPABLE <em>and</em> Permissions &rarr; Multi-agent is on. Capable models: <code>${escapeHtml(MULTI_AGENT_CAPABLE.join(", "))}</code>.</p>`
          : "";
        body =
          `<form method="POST" class="btb-form">${hidden("tools")}` +
          `<div class="btb-group"><label>pi builtin</label>${builtinBoxes}</div>` +
          `<hr class="btb-divider">` +
          `<div class="btb-group"><label>Crow MCP tools</label>` +
          `<p class="btb-hint">Live tools/list; &#9888; regex = non-blocking soft-warn, S4</p>${mcpHtml}</div>` +
          `<hr class="btb-divider">` +
          `<div class="btb-group"><label>pi extensions</label>` +
          `<p class="btb-hint">Curated allowlist only; others need install-approval</p>${extBoxes}${subWarn}</div>` +
          actionBar(`<button type="submit" class="btb-btn">Save Tools</button>`) + `</form>`;
      } else if (tabId === "gateways") {
        const gw = (def.gateways && def.gateways[0]) || {};
        const gwType = gw.type || "gmail";
        const gwTypes = [
          { value: "gmail", label: "Gmail", available: true },
          { value: "crow-messages", label: "Crow Messages", available: false },
          { value: "discord", label: "Discord", available: false },
          { value: "signal", label: "Signal", available: false },
          { value: "none", label: "None (no gateway)", available: true },
        ];
        const typeOpts = gwTypes.map((t) =>
          `<option value="${t.value}"${gwType === t.value ? " selected" : ""}>${escapeHtml(t.label)}${t.available ? "" : " — coming soon"}</option>`
        ).join("");
        body =
          `<form method="POST" class="btb-form">${hidden("gateways")}` +
          `<div class="btb-group"><label>Gateway type</label>` +
          `<select name="gw_type" class="btb-select">${typeOpts}</select></div>` +
          formField("Gmail address (+alias)", "gw_address", { value: gw.address || "" }) +
          `<div class="btb-group"><label>Allowlist (one address per line)</label>` +
          `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>` +
          `<p class="btb-hint">The gateways array supports multiple types. Only Gmail is currently implemented (bridge_tick.mjs polls <code>to:&lt;+alias&gt;@maestro.press</code>). Crow Messages, Discord, and Signal gateways are planned.</p>` +
          actionBar(`<button type="submit" class="btb-btn">Save Gateways</button>`) + `</form>`;
      } else if (tabId === "tracker") {
        let projects = [];
        try { projects = (await db.execute({ sql: "SELECT id, name, slug FROM project_spaces WHERE archived_at IS NULL ORDER BY id", args: [] })).rows; } catch {}
        const projOpts = projects.map((p) => `<option value="${p.id}"${Number(def.project_id) === Number(p.id) ? " selected" : ""}>#${p.id} &mdash; ${escapeHtml(p.name || "")} (${escapeHtml(p.slug || "")})</option>`).join("");
        // Tracker defs for custom tracker dropdown
        let trackerDefs = [];
        try { trackerDefs = (await db.execute({ sql: "SELECT id, slug, display_name FROM tracker_defs ORDER BY slug", args: [] })).rows; } catch {}
        const tc = def.tracker_config || {};
        const ttype = tc.type || "kanban";
        const ttSel = (v) => ttype === v ? " selected" : "";
        const trackerOpts = trackerDefs.map((t) =>
          `<option value="${escapeHtml(t.slug)}"${tc.tracker_slug === t.slug ? " selected" : ""}>${escapeHtml(t.display_name)} (${escapeHtml(t.slug)})</option>`
        ).join("");
        const cfFields = Array.isArray(tc.context_fields) ? tc.context_fields.join(", ") : "";
        const qfKey = tc.queue_filter ? Object.keys(tc.queue_filter)[0] || "" : "";
        const qfVal = tc.queue_filter && qfKey ? tc.queue_filter[qfKey] || "" : "";
        let snap = "";
        const pid = def.project_id;
        const boardHref = "/dashboard/bot-board?bot=" + encodeURIComponent(botId);
        if (pid != null && pid !== "" && (ttype === "kanban" || ttype === "task-list")) {
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
            snap =
              `<div class="btb-snapshot">` +
              `<b>Kanban snapshot</b> (project #${escapeHtml(String(pid))}, ${total} cards): ` +
              `pending <b>${c.pending}</b> &middot; in_progress <b>${c.in_progress}</b> &middot; ` +
              `done <b>${c.done}</b> &middot; cancelled <b>${c.cancelled}</b>` +
              `<br><a href="${boardHref}">Open board &nearr;</a>` +
              `</div>`;
          } catch {
            snap = `<p class="btb-hint">(Kanban snapshot unavailable.)</p>`;
          } finally {
            if (tdb) { try { tdb.close(); } catch {} }
          }
        } else if (ttype === "custom" && tc.tracker_slug) {
          try {
            const tdef = (await db.execute({ sql: "SELECT id, display_name, status_values FROM tracker_defs WHERE slug=?", args: [tc.tracker_slug] })).rows[0];
            if (tdef) {
              const statusRows = (await db.execute({ sql: "SELECT status, COUNT(*) AS n FROM tracker_items WHERE tracker_id=? GROUP BY status", args: [tdef.id] })).rows || [];
              const statusMap = {}; let total = 0;
              for (const r of statusRows) { statusMap[r.status] = Number(r.n); total += Number(r.n); }
              const statusList = JSON.parse(tdef.status_values || "[]");
              const countParts = statusList.map((s) => `${escapeHtml(s)} <b>${statusMap[s] || 0}</b>`).join(" &middot; ");
              snap =
                `<div class="btb-snapshot">` +
                `<b>${escapeHtml(tdef.display_name)} snapshot</b> (${total} items): ${countParts}` +
                `<br><a href="${boardHref}">Open board &nearr;</a>` +
                `</div>`;
            }
          } catch {
            snap = `<p class="btb-hint">(Tracker snapshot unavailable.)</p>`;
          }
        }
        body =
          `<form method="POST" class="btb-form">${hidden("tracker")}` +
          `<div class="btb-group"><label>Linked project</label>` +
          `<select name="project_id" class="btb-select"><option value="">&mdash; none &mdash;</option>${projOpts}</select></div>` +
          `<p class="btb-hint">Project determines workspace, tasks DB, and member ACL.</p>` +
          `<hr class="btb-divider">` +
          `<div class="btb-group"><label>Tracker type</label>` +
          `<select name="tracker_type" class="btb-select">` +
          `<option value="kanban"${ttSel("kanban")}>Kanban (tasks_items board)</option>` +
          `<option value="task-list"${ttSel("task-list")}>Task list (flat checklist)</option>` +
          `<option value="custom"${ttSel("custom")}>Custom tracker (tracker_defs)</option>` +
          `<option value="none"${ttSel("none")}>None (no tracker)</option>` +
          `</select></div>` +
          `<div id="custom-tracker-fields" style="${ttype !== "custom" ? "display:none" : ""}">` +
          `<div class="btb-group"><label>Tracker slug</label>` +
          `<select name="tracker_slug" class="btb-select"><option value="">&mdash; select &mdash;</option>${trackerOpts}</select></div>` +
          `<div class="btb-group"><label>Context fields (comma-separated keys for prompt)</label>` +
          `<input name="context_fields" value="${escapeHtml(cfFields)}" class="btb-input" placeholder="label, status, action_needed, pir_number"></div>` +
          `<div class="btb-group"><label>Queue filter (key=value for dispatch queue)</label>` +
          `<input name="queue_filter_key" value="${escapeHtml(qfKey)}" class="btb-input" style="max-width:220px;display:inline-block" placeholder="processing_lease_status"> = ` +
          `<input name="queue_filter_value" value="${escapeHtml(qfVal)}" class="btb-input" style="max-width:220px;display:inline-block" placeholder="queued"></div>` +
          `</div>` +
          snap +
          `<script>document.querySelector('[name=tracker_type]').onchange=function(){` +
          `document.getElementById('custom-tracker-fields').style.display=this.value==='custom'?'':'none';}</script>` +
          actionBar(`<button type="submit" class="btb-btn">Save Tracker Config</button>`) + `</form>` +
          // Tracker definition editor (below the config form)
          (function() {
            if (ttype !== "custom" || !tc.tracker_slug) return "";
            const selTracker = trackerDefs.find((t) => t.slug === tc.tracker_slug);
            if (!selTracker) return "";
            let sv = []; try { sv = JSON.parse(selTracker.status_values || "[]"); } catch {}
            let cols = []; try { cols = JSON.parse(selTracker.columns_json || "[]"); } catch {}
            const svText = sv.join(", ");
            const colRows = cols.map((c, i) =>
              `<tr>` +
              `<td><input name="col_key_${i}" value="${escapeHtml(c.key || "")}" style="width:120px"></td>` +
              `<td><input name="col_label_${i}" value="${escapeHtml(c.label || "")}" style="width:140px"></td>` +
              `<td><select name="col_type_${i}">` +
              ["text","number","date","datetime","boolean","json"].map((t) => `<option${t === (c.type || "text") ? " selected" : ""}>${t}</option>`).join("") +
              `</select></td>` +
              `<td><input type="checkbox" name="col_req_${i}"${c.required ? " checked" : ""}></td>` +
              `</tr>`
            ).join("");
            return `<hr class="btb-divider">` +
              `<h4 style="margin:0 0 .5rem">Tracker definition: ${escapeHtml(selTracker.display_name)}</h4>` +
              `<p class="btb-hint" style="margin:0 0 .75rem">Edit the tracker's column headers (statuses) and data fields. Changes apply to all items in this tracker.</p>` +
              `<div id="bb-tracker-def-msg" class="btb-tdef-msg"></div>` +
              `<div class="btb-group"><label>Display name</label>` +
              `<input id="bb-tdef-name" value="${escapeHtml(selTracker.display_name)}" class="btb-input" style="max-width:300px"></div>` +
              `<div class="btb-group"><label>Status columns (comma-separated, in display order)</label>` +
              `<input id="bb-tdef-statuses" value="${escapeHtml(svText)}" class="btb-input" placeholder="pending, processing, received, done"></div>` +
              `<p class="btb-hint" style="margin-top:-.5rem">These become the board columns. Changing them does not migrate existing items &mdash; items with removed statuses will appear in an "other" column.</p>` +
              `<div class="btb-group"><label>Data fields (columns_json)</label>` +
              `<table class="btb-table">` +
              `<thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Req</th></tr></thead>` +
              `<tbody id="bb-tdef-cols">${colRows}</tbody></table></div>` +
              `<button type="button" class="btb-btn btb-btn-sec btb-btn-sm" id="bb-tdef-add-col">+ Add field</button>` +
              `<div style="margin-top:.75rem">` +
              `<button type="button" class="btb-btn" id="bb-tdef-save">Save tracker definition</button>` +
              `</div>` +
              `<script>(function(){
                var API='/dashboard/bot-board-api';
                var slug=${JSON.stringify(tc.tracker_slug)};
                var msgEl=document.getElementById('bb-tracker-def-msg');
                function tdefMsg(t,c){msgEl.style.color=c==='ok'?'var(--crow-success)':c==='err'?'var(--crow-error)':'';msgEl.textContent=t||'';}
                var colIdx=${cols.length};
                document.getElementById('bb-tdef-add-col').onclick=function(){
                  var tbody=document.getElementById('bb-tdef-cols');
                  var tr=document.createElement('tr');
                  function td(child){var t=document.createElement('td');t.appendChild(child);return t;}
                  var ki=document.createElement('input');ki.name='col_key_'+colIdx;ki.style.width='120px';ki.placeholder='field_key';
                  var li=document.createElement('input');li.name='col_label_'+colIdx;li.style.width='140px';li.placeholder='Display Label';
                  var sel=document.createElement('select');sel.name='col_type_'+colIdx;
                  ['text','number','date','datetime','boolean','json'].forEach(function(t){var o=document.createElement('option');o.value=t;o.textContent=t;if(t==='text')o.selected=true;sel.appendChild(o);});
                  var cb=document.createElement('input');cb.type='checkbox';cb.name='col_req_'+colIdx;
                  tr.appendChild(td(ki));tr.appendChild(td(li));tr.appendChild(td(sel));tr.appendChild(td(cb));
                  tbody.appendChild(tr);
                  colIdx++;
                };
                document.getElementById('bb-tdef-save').onclick=function(){
                  var name=document.getElementById('bb-tdef-name').value.trim();
                  if(!name){tdefMsg('Display name required.','err');return;}
                  var svRaw=document.getElementById('bb-tdef-statuses').value;
                  var statuses=svRaw.split(',').map(function(s){return s.trim();}).filter(Boolean);
                  if(!statuses.length){tdefMsg('At least one status required.','err');return;}
                  var cols=[];
                  var tbody=document.getElementById('bb-tdef-cols');
                  var rows=tbody.querySelectorAll('tr');
                  rows.forEach(function(row){
                    var inputs=row.querySelectorAll('input,select');
                    var key=(inputs[0]&&inputs[0].value||'').trim();
                    if(!key)return;
                    cols.push({key:key,label:(inputs[1]&&inputs[1].value||'').trim()||key,type:(inputs[2]&&inputs[2].value||'text'),required:!!(inputs[3]&&inputs[3].checked)});
                  });
                  tdefMsg('Saving...','');
                  fetch(API+'/tracker/'+encodeURIComponent(slug),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({display_name:name,status_values:statuses,columns_json:cols}),credentials:'same-origin'})
                  .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})
                  .then(function(r){
                    if(r.ok){tdefMsg('Saved. Reload the Bot Board to see changes.','ok');}
                    else{tdefMsg((r.j&&(r.j.error||r.j.reason))||'save failed','err');}
                  });
                };
              })();</script>`;
          })();
      } else if (tabId === "skills") {
        const skills = loadSkills();
        const sel = new Set((def.skills || []));
        const boxes = skills.length
          ? `<div class="btb-checkbox-group">` +
            skills.map((s) => `<label class="btb-checkbox"><input type="checkbox" name="skills" value="${escapeHtml(s)}"${sel.has(s) ? " checked" : ""}> ${escapeHtml(s)}</label>`).join("") +
            `</div>`
          : `<p class="btb-muted">No skills in ~/.crow/skills.</p>`;
        body =
          `<form method="POST" class="btb-form">${hidden("skills")}` +
          `<div class="btb-group"><label>Skills</label>` +
          `<p class="btb-hint">~/.crow/skills</p>${boxes}</div>` +
          `<hr class="btb-divider">` +
          `<div class="btb-group"><label>System prompt</label>` +
          `<textarea name="system_prompt" rows="10" class="btb-textarea btb-textarea-wide">${escapeHtml(def.system_prompt || "")}</textarea></div>` +
          actionBar(`<button type="submit" class="btb-btn">Save Skills &amp; Prompt</button>`) + `</form>`;
      } else if (tabId === "permissions") {
        const pp = def.permission_policy || {};
        const bashSel = (v) => (pp.bash || "deny") === v ? " selected" : "";
        const esSel = (v) => (pp.external_send || "draft_only") === v ? " selected" : "";
        body =
          `<form method="POST" class="btb-form">${hidden("permissions")}` +
          `<div class="btb-group"><label>bash</label>` +
          `<select name="pp_bash" class="btb-select"><option${bashSel("deny")}>deny</option><option${bashSel("allowlist")}>allowlist</option><option${bashSel("sandbox")}>sandbox</option></select></div>` +
          `<div class="btb-group"><label>bash_allow prefixes (one per line; allowlist mode)</label>` +
          `<textarea name="pp_bash_allow" rows="3" class="btb-textarea">${escapeHtml((pp.bash_allow || []).join("\n"))}</textarea></div>` +
          `<div class="btb-group"><label>write_paths (one per line)</label>` +
          `<textarea name="pp_write_paths" rows="3" class="btb-textarea">${escapeHtml((pp.write_paths || []).join("\n"))}</textarea></div>` +
          `<div class="btb-group"><label>external_send</label>` +
          `<select name="pp_external_send" class="btb-select"><option${esSel("draft_only")}>draft_only</option><option${esSel("allow")}>allow</option></select></div>` +
          `<div class="btb-group"><label>confirm tools (one per line; blocked unattended)</label>` +
          `<textarea name="pp_confirm" rows="3" class="btb-textarea">${escapeHtml((pp.confirm || []).join("\n"))}</textarea></div>` +
          `<div class="btb-group"><label class="btb-checkbox"><input type="checkbox" name="pp_multi_agent"${pp.multi_agent ? " checked" : ""}> Multi-agent (allow the <code>subagent</code> tool)</label></div>` +
          `<p class="btb-hint">Multi-agent is gated by pi-lab/permission-gating.ts (Phase 3.1): <code>subagent</code> is allowed only when this is on AND the bot's resolved model is MULTI_AGENT_CAPABLE; recursion is depth-capped. Off by default.</p>` +
          `<p class="btb-hint">Enforced by pi-lab/permission-gating.ts via PI_BOT_PERMISSION_POLICY (Phase 2.2). Default-deny for safety.</p>` +
          actionBar(`<button type="submit" class="btb-btn">Save Permissions</button>`) + `</form>`;
      } else if (tabId === "triggers") {
        const tr = def.triggers || {};
        body =
          `<form method="POST" class="btb-form">${hidden("triggers")}` +
          `<div class="btb-group"><label class="btb-checkbox"><input type="checkbox" name="tr_gateway"${tr.gateway ? " checked" : ""}> Gateway-triggered (Gmail inbound via the bridge tick)</label></div>` +
          formField("Cron (bridge's own timer; optional)", "tr_cron", { value: tr.cron || "", placeholder: "*/15 * * * *" }) +
          `<p class="btb-hint">The bridge runs its OWN timer over triggers.cron &mdash; NOT the schedules table / pipeline-runner (plan &sect;2).</p>` +
          actionBar(`<button type="submit" class="btb-btn">Save Triggers</button>`) + `</form>`;
      } else if (tabId === "sessions") {
        // S3: session resume UX — list, send-message, transcript viewer, stop
        let sessions = [];
        try {
          sessions = (await db.execute({
            sql: `SELECT id, pi_session_id, pi_session_dir, gateway_thread_id, status, control,
                    model, escalated, card_id, datetime(updated_at) AS updated_at
                  FROM bot_sessions WHERE bot_id=? ORDER BY id DESC LIMIT 30`,
            args: [botId],
          })).rows || [];
        } catch {}
        const statusClass = (s) => {
          if (s === "active" || s === "done") return "btb-ok";
          if (s === "waiting-user") return "btb-status-warn";
          if (s === "error") return "btb-err";
          return "btb-muted";
        };
        const sessHtml = sessions.length
          ? `<table class="btb-table">
              <thead><tr>
              <th>ID</th>
              <th>Status</th>
              <th>Model</th>
              <th>Thread</th>
              <th>Updated</th>
              <th>Actions</th>
              </tr></thead><tbody>` +
            sessions.map((s) => {
              const cls = statusClass(s.status);
              const canSend = s.status === "active" || s.status === "waiting-user";
              const canStop = s.status === "active" || s.status === "waiting-user";
              const threadShort = (s.gateway_thread_id || "").slice(0, 20);
              const actions = [];
              if (canSend) actions.push(`<button class="bb-sess-send btb-sess-btn" data-thread="${escapeHtml(s.gateway_thread_id || "")}">Send</button>`);
              if (canStop) actions.push(`<button class="bb-sess-stop btb-sess-btn" data-thread="${escapeHtml(s.gateway_thread_id || "")}">Stop</button>`);
              if (s.pi_session_id && s.pi_session_dir) actions.push(`<a href="/dashboard/bot-board-api/session/${s.id}/transcript" target="_blank" class="btb-sess-link">Transcript</a>`);
              return `<tr>
                <td>${s.id}</td>
                <td class="${cls}">${escapeHtml(s.status || "")}</td>
                <td class="btb-mono" style="font-family:monospace;font-size:.78rem">${escapeHtml(s.model || "—")}</td>
                <td class="btb-mono" style="font-family:monospace;font-size:.78rem" title="${escapeHtml(s.gateway_thread_id || "")}">${escapeHtml(threadShort)}</td>
                <td class="btb-muted">${escapeHtml(s.updated_at || "")}</td>
                <td>${actions.join(" ")}</td>
              </tr>`;
            }).join("") + `</tbody></table>`
          : `<p class="btb-muted">No sessions for this bot.</p>`;
        // Send-message form (shown via JS when Send button clicked)
        const sendForm =
          `<div id="bb-sess-send-panel" class="btb-send-panel">` +
          `<label>Send message to session (thread: <code id="bb-sess-thread"></code>)</label><br>` +
          `<textarea id="bb-sess-msg" rows="3" class="btb-textarea btb-textarea-wide"></textarea>` +
          `<button id="bb-sess-send-btn" class="btb-btn">Send via bridge --inject</button>` +
          `<span id="bb-sess-send-status" class="btb-send-status"></span>` +
          `</div>`;
        const sessScript = `<script>(function(){
          var panel=document.getElementById('bb-sess-send-panel');
          var threadEl=document.getElementById('bb-sess-thread');
          var msgEl=document.getElementById('bb-sess-msg');
          var statusEl=document.getElementById('bb-sess-send-status');
          var curThread=null;
          document.querySelectorAll('.bb-sess-send').forEach(function(btn){
            btn.onclick=function(){ curThread=this.getAttribute('data-thread');
              threadEl.textContent=curThread; panel.style.display=''; msgEl.focus(); };
          });
          document.querySelectorAll('.bb-sess-stop').forEach(function(btn){
            btn.onclick=function(){
              if(!confirm('Stop this session?')) return;
              var t=this.getAttribute('data-thread');
              fetch('/dashboard/bot-board-api/session/stop',{method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({bot_id:'${escapeHtml(botId)}',gateway_thread_id:t}),
                credentials:'same-origin'})
              .then(function(r){return r.json();})
              .then(function(j){ if(j.ok) location.reload(); else alert(j.reason||'failed'); });
            };
          });
          var sendBtn=document.getElementById('bb-sess-send-btn');
          if(sendBtn) sendBtn.onclick=function(){
            var msg=msgEl.value.trim();
            if(!msg||!curThread){ statusEl.textContent='Message required'; return; }
            statusEl.textContent='Sending...';
            fetch('/dashboard/bot-board-api/session/send',{method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({bot_id:'${escapeHtml(botId)}',gateway_thread_id:curThread,message:msg}),
              credentials:'same-origin'})
            .then(function(r){return r.json();})
            .then(function(j){ if(j.ok){ statusEl.textContent='Dispatched.'; msgEl.value=''; }
              else statusEl.textContent=j.error||'failed'; })
            .catch(function(e){ statusEl.textContent='Error: '+e.message; });
          };
        })();</script>`;
        body = sessHtml + sendForm + sessScript;
      } else if (tabId === "review") {
        const mcpMsg = q.mcp ? `<p class="btb-notice-ok">${escapeHtml(String(q.mcp))}</p>` : "";
        // R13/R14 (Phase 3.2): show the EFFECTIVE runtime decision the bridge
        // will make — resolved default/escalation provider/model (via the 3.0
        // resolver, fail-closed, never throws), the multi_agent flag, and the
        // computed isMultiAgentCapable verdict for the default-resolved pair.
        let effHtml;
        try {
          const rDef = await resolveModel(def, { escalate: false });
          const rEsc = await resolveModel(def, { escalate: true });
          const maOn = !!(def.permission_policy && def.permission_policy.multi_agent);
          const capable = isMultiAgentCapable(rDef.provider, rDef.model);
          const escConfigured = !!(def.models && def.models.escalation);
          const fb = (r) => (r.source === "fallback" ? ` <span class="btb-review-fallback">(fail-closed fallback)</span>` : "");
          const subAllowed = maOn && capable;
          effHtml =
            `<div class="btb-group"><b>Effective runtime decision</b> <span class="btb-hint" style="display:inline">(computed via model_resolver.mjs + pi_extensions_allowlist.mjs)</span></div>` +
            `<table class="btb-review-table">` +
            `<tr><td>Default model</td><td><code>${escapeHtml(rDef.key)}</code> <span class="btb-review-source">source=${escapeHtml(rDef.source)}</span>${fb(rDef)}</td></tr>` +
            `<tr><td>Escalation model</td><td>` +
              (escConfigured
                ? `<code>${escapeHtml(rEsc.key)}</code> <span class="btb-review-source">source=${escapeHtml(rEsc.source)}</span>` +
                  (rEsc.escalationRequestedButUnavailable ? ` <span class="btb-review-fallback">(configured value not in models.json &mdash; would fall back + notice)</span>` : "")
                : `<span class="btb-muted">&mdash; none (escalation disabled; <code>!escalate</code> is a no-op)</span>`) +
            `</td></tr>` +
            `<tr><td>multi_agent flag</td><td>${maOn ? `<b class="btb-ok">on</b>` : `<span class="btb-muted">off</span>`}</td></tr>` +
            `<tr><td>isMultiAgentCapable(default)</td><td>${capable ? `<b class="btb-ok">true</b>` : `<span class="btb-err">false</span>`}</td></tr>` +
            `<tr><td>&rarr; <code>subagent</code> at runtime</td><td>${subAllowed ? `<b class="btb-ok">ALLOWED</b>` : `<b class="btb-err">BLOCKED</b> <span class="btb-muted">(${escapeHtml(!maOn ? "multi_agent off" : "model not MULTI_AGENT_CAPABLE")})</span>`}</td></tr>` +
            `</table>` +
            `<p class="btb-hint">This mirrors the pi-lab gate (Phase 3.1): the bridge only offers <code>subagent</code> when both are true; the gate is the hard backstop. Escalation is per-turn via <code>!escalate</code> only.</p>`;
        } catch (e) {
          effHtml = `<p class="btb-notice-warn">${escapeHtml(String(e.message || e))}</p>`;
        }
        body =
          mcpMsg +
          effHtml +
          `<hr class="btb-divider">` +
          `<div class="btb-group"><b>Computed definition</b> (pi_bot_defs.definition)</div>` +
          `<pre class="btb-pre">${escapeHtml(JSON.stringify(def, null, 2))}</pre>` +
          `<p style="margin:.75rem 0">Per-bot MCP servers from selection: <code>${escapeHtml(serversForBot(def).join(", ") || "(none)")}</code></p>` +
          `<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.75rem 0">` +
          `<form method="POST"><input type="hidden" name="action" value="regen_mcp"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
          `<button type="submit" class="btb-btn">Regenerate &lt;session_dir&gt;/.mcp.json</button></form>` +
          `<form method="POST"><input type="hidden" name="action" value="toggle"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
          `<button type="submit" class="btb-btn btb-btn-sec">${bot.enabled ? "Disable bot" : "Enable bot"}</button></form>` +
          `</div>` +
          `<p class="btb-hint">Saving a bot writes pi_bot_defs only. The bridge spawn-per-turn picks up changes on the next inbound; no gateway restart needed.</p>`;
      }

      return res.send(layout({
        title: "Bot Builder — " + escapeHtml(botId),
        content: PAGE_CSS + section(
          `Edit bot: ${escapeHtml(bot.display_name || botId)} ${bot.enabled ? badge("enabled", "connected") : badge("disabled", "draft")}`,
          `<p><a href="/dashboard/bot-builder">&larr; all bots</a></p>` + notice +
          nav + body
        ),
      }));
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
        : "<p>No bots yet. Create one below.</p>"));
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
    const form = section("Create a bot",
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
