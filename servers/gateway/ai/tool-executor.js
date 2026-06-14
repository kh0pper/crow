/**
 * AI Chat Tool Executor
 *
 * Dispatches tool calls from AI providers to underlying Crow MCP servers.
 * Reuses the router.js pattern: in-process MCP Client + InMemoryTransport.
 *
 * Uses the router's 7 category tools (crow_memory, crow_projects, etc.)
 * to keep context manageable. The AI sees category-style tool names and
 * uses crow_discover for on-demand schema lookup.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryServer } from "../../memory/server.js";
import { createProjectServer } from "../../research/server.js";
import { createSharingServer } from "../../sharing/server.js";
import { createBlogServer } from "../../blog/server.js";
import { createConsultingServer } from "../../consulting/server.js";
import { TOOL_MANIFESTS } from "../tool-manifests.js";
import { connectedServers } from "../proxy.js";
import { voiceCategoryFor } from "../../../scripts/pi-bots/ext_registry.mjs";
import { createDbClient } from "../../db.js";
import { CronExpressionParser } from "cron-parser";
import { BOT_JOBS_DDL } from "../../../scripts/pi-bots/bot-jobs-schema.mjs";

// Lazy self-heal of bot_jobs on the gateway side (libsql), once per process —
// matches the pi-bots runner's ensure. Idempotent; never throws into a tool call.
let _botJobsEnsured = false;
async function ensureBotJobs(db) {
  if (_botJobsEnsured) return;
  try { await db.executeMultiple(BOT_JOBS_DDL); _botJobsEnsured = true; } catch { /* surfaced by the caller's own op */ }
}

// Bot-cron schedule namespace (Plan B Part 1 Stage 4). MUST stay in sync with
// scripts/pi-bots/bot_scheduler.mjs BOTCRON_PREFIX. Namespaced UNDER 'pipeline:'
// so the gateway notification scheduler's `NOT LIKE 'pipeline:%'` catch-all skips
// these rows (C1 — avoids the next_run data-loss race).
const BOTCRON_PREFIX = "pipeline:botcron:";
function botcronNextRun(cronExpression, fromDate = new Date()) {
  try { return CronExpressionParser.parse(cronExpression, { currentDate: fromDate }).next().toISOString(); }
  catch { return null; }
}

/**
 * Category proxies the chat tool-executor can actually dispatch. Mirrors the
 * regex in executeTool() (`^crow_(memory|projects|blog|sharing|storage|media)$`).
 * `orchestrator`/`consulting` are advertised in TOOL_MANIFESTS but the executor
 * regex omits them, so their category proxies are NOT executable — a bound bot
 * must not be handed them (Slice B B3 / plan D4). Deep work instead rides the
 * explicit crow_orchestrate / crow_orchestrate_status schemas added below.
 */
const EXECUTABLE_CATEGORIES = new Set(["memory", "projects", "blog", "sharing", "storage", "media"]);

/**
 * Slice B (B3): compute the voice-path tool scope for a bound bot from its
 * def.tools.crow_mcp ("<canonical-server>/<tool>" entries). Returns null when
 * unbound — callers then fall back to the full, unscoped tool set / no policy
 * enforcement (the pre-Slice-B behavior, byte-for-byte).
 *
 *   selectedToolNames  bare tool names the bot picked (match addon tools by name)
 *   selectedServers    canonical server ids the bot picked under
 *   coreCategories     voice categories (A4 map) the bot has ANY selection under;
 *                      core crow_<category> proxies are all-or-nothing (decision 4)
 */
export function botVoiceScope(botDef) {
  if (!botDef) return null;
  const crowMcp = (botDef.tools && botDef.tools.crow_mcp) || [];
  const selectedToolNames = new Set();
  const selectedServers = new Set();
  const coreCategories = new Set();
  for (const sel of crowMcp) {
    const s = String(sel);
    const slash = s.indexOf("/");
    if (slash < 0) continue;
    const server = s.slice(0, slash);
    const tool = s.slice(slash + 1);
    if (!tool) continue;
    selectedServers.add(server);
    selectedToolNames.add(tool);
    const cat = voiceCategoryFor(server);
    if (cat) coreCategories.add(cat);
  }
  return { selectedToolNames, selectedServers, coreCategories };
}

/** Set of tool names currently advertised by connected addon servers. */
function connectedAddonToolNames() {
  const names = new Set();
  if (!connectedServers) return names;
  for (const [, entry] of connectedServers) {
    if (entry.status !== "connected") continue;
    for (const t of entry.tools || []) names.add(t.name);
  }
  return names;
}

/**
 * True iff `name` is a tool exposed by a currently CONNECTED addon server (as
 * opposed to a core-category action, crow_discover, or a device-native tool).
 * The policy wrapper uses this to enforce a bound bot's addon allowlist: an
 * addon tool the bot did not select must not run even if force-called via the
 * crow_tools proxy (advertised-set scoping alone wouldn't stop that).
 */
export function isConnectedAddonTool(name) {
  return connectedAddonToolNames().has(name);
}

/**
 * Slice B (B3/B4 + Q3): bot tool selections that have NO voice equivalent —
 * neither a core voice category (A4 map) NOR a tool exposed by a currently
 * connected addon server. These work under the pi runtime but cannot be driven
 * by the fast voice turn, so B4 WARNS about them (we omit them from the
 * advertised voice tools rather than advertise an unrunnable tool). Returns the
 * verbatim "<server>/<tool>" selection strings.
 */
export function voiceUnavailableSelections(botDef) {
  if (!botDef) return [];
  const crowMcp = (botDef.tools && botDef.tools.crow_mcp) || [];
  const addonTools = connectedAddonToolNames();
  const out = [];
  for (const sel of crowMcp) {
    const s = String(sel);
    const slash = s.indexOf("/");
    if (slash < 0) continue;
    const server = s.slice(0, slash);
    const tool = s.slice(slash + 1);
    if (!tool) continue;
    const reachable = voiceCategoryFor(server) || addonTools.has(tool);
    if (!reachable) out.push(s);
  }
  return out;
}

// See router.js for rationale — orchestrator is optional when the
// open-multi-agent sibling repo isn't installed.
let createOrchestratorServer = null;
try {
  ({ createOrchestratorServer } = await import("../../orchestrator/server.js"));
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
}

/** Max characters for a single tool result before truncation */
const MAX_RESULT_LENGTH = 2000;

/** Max tool call rounds per message turn */
export const MAX_TOOL_ROUNDS = 10;

/**
 * Server factory map — mirrors router.js.
 * Media is available as a bundle add-on (accessed via crow_tools proxy).
 */
const SERVER_FACTORIES = {
  memory: createMemoryServer,
  projects: createProjectServer,
  sharing: createSharingServer,
  blog: createBlogServer,
  consulting: createConsultingServer,
  ...(createOrchestratorServer
    ? { orchestrator: () => createOrchestratorServer(undefined, { connectedServers }) }
    : {}),
};

/**
 * Create an in-process MCP Client connected to a server.
 */
async function createInProcessClient(name, serverFactory) {
  const server = serverFactory();
  const client = new Client({ name: `chat-${name}`, version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/**
 * Resolve which server category owns a tool name.
 * Returns { category, toolName } or null.
 */
function resolveToolCategory(action) {
  for (const [category, manifest] of Object.entries(TOOL_MANIFESTS)) {
    if (manifest.tools[action]) return { category, toolName: action };
    // Try without crow_ prefix
    const prefixed = `crow_${action}`;
    if (manifest.tools[prefixed]) return { category, toolName: prefixed };
  }
  return null;
}

/**
 * Create a tool executor instance.
 *
 * Manages a pool of lazy in-process MCP clients and dispatches
 * tool calls to the appropriate server.
 */
/**
 * @param {object} [opts]
 * @param {object} [opts.botDef]          bound bot definition — sets the default
 *                                        delegate target (crow_delegate's `bot`).
 * @param {object} [opts.defaultDeliverTo] deliver_to spec to use when crow_delegate
 *                                        is called without one (e.g. the current
 *                                        gateway turn's thread). Falls back to poll.
 */
export function createToolExecutor(opts = {}) {
  const clients = new Map(); // category → Client
  const boundBotId = opts.botDef && opts.botDef.bot_id ? opts.botDef.bot_id : null;
  const defaultDeliverTo = opts.defaultDeliverTo || null;

  async function getClient(category) {
    if (clients.has(category)) return clients.get(category);

    let factories = { ...SERVER_FACTORIES };
    if (category === "storage") {
      try {
        const { createStorageServer } = await import("../../storage/server.js");
        factories.storage = createStorageServer;
      } catch {
        throw new Error("Storage server not available. Set MINIO_ENDPOINT in .env.");
      }
    }

    const factory = factories[category];
    if (!factory) {
      throw new Error(`Unknown category: ${category}`);
    }

    const { client } = await createInProcessClient(category, factory);
    clients.set(category, client);
    return client;
  }

  /**
   * Execute a single tool call.
   * Returns { result: string, isError: boolean }.
   */
  async function executeTool(name, args) {
    try {
      // Check if it's a category-level tool (crow_memory, crow_projects, etc.)
      const categoryMatch = name.match(/^crow_(memory|projects|blog|sharing|storage|media)$/);
      if (categoryMatch) {
        const category = categoryMatch[1];
        const action = args.action;
        const params = args.params || {};

        if (!action) {
          return { result: `Error: ${name} requires an 'action' parameter`, isError: true };
        }

        const client = await getClient(category);

        // Resolve action to full tool name
        const manifest = TOOL_MANIFESTS[category];
        let toolName = action;
        if (manifest && !manifest.tools[action]) {
          const prefixed = `crow_${action}`;
          if (manifest.tools[prefixed]) toolName = prefixed;
        }

        const result = await client.callTool({ name: toolName, arguments: params });
        return formatResult(result);
      }

      // crow_discover — schema discovery
      if (name === "crow_discover") {
        return await handleDiscover(args);
      }

      // crow_delegate / crow_job_status — pi-backed background jobs (Plan B Part 1
      // Stage 3, the crow_orchestrate replacement). Pure DB ops: enqueue a queued
      // bot_jobs row / read one back. The pi-bots host (gateway_runner / bridge_tick)
      // claims + runs + delivers it out of band.
      if (name === "crow_delegate") {
        return await handleDelegate(args);
      }
      if (name === "crow_job_status") {
        return await handleJobStatus(args);
      }
      if (name === "crow_schedule_bot") {
        return await handleScheduleBot(args);
      }
      if (name === "crow_list_bot_schedules") {
        return await handleListBotSchedules(args);
      }
      if (name === "crow_delete_bot_schedule") {
        return await handleDeleteBotSchedule(args);
      }

      // crow_tools — external integrations (legacy wrapper, still supported)
      if (name === "crow_tools") {
        return await handleExternalTool(args);
      }

      // Direct addon tool call (e.g., "crow_tax_prepare_from_documents")
      if (connectedServers) {
        for (const [integrationId, entry] of connectedServers) {
          if (entry.status !== "connected" || !entry.client) continue;
          const hasTool = entry.tools?.some((t) => t.name === name);
          if (hasTool) {
            try {
              const result = await entry.client.callTool({ name, arguments: args });
              return formatResult(result);
            } catch (err) {
              return { result: `Error calling ${name} (${integrationId}): ${err.message}`, isError: true };
            }
          }
        }
      }

      // Direct tool name (resolve to category)
      const resolved = resolveToolCategory(name);
      if (resolved) {
        const client = await getClient(resolved.category);
        const result = await client.callTool({ name: resolved.toolName, arguments: args });
        return formatResult(result);
      }

      return { result: `Unknown tool: ${name}`, isError: true };
    } catch (err) {
      return { result: `Tool error (${name}): ${err.message}`, isError: true };
    }
  }

  /**
   * Execute multiple tool calls concurrently.
   */
  async function executeToolCalls(toolCalls) {
    return Promise.all(
      toolCalls.map(async (tc) => {
        const { result, isError } = await executeTool(tc.name, tc.arguments || {});
        return {
          id: tc.id,
          name: tc.name,
          result,
          isError,
        };
      })
    );
  }

  /**
   * crow_delegate — enqueue a background job for a Crow bot. The bot runs the goal
   * detached in the pi-bots host and the result is delivered per deliver_to. This
   * is the crow_orchestrate replacement: a single strong agent (pi) doing the work
   * in one coherent context, async. Pure DB op here — no process is spawned.
   * Defaults: bot = the bound bot; deliver_to = the turn's thread (if the caller
   * provided one) else poll-mode (read back later with crow_job_status).
   */
  async function handleDelegate(args) {
    const goal = (args && typeof args.goal === "string") ? args.goal.trim() : "";
    if (!goal) return { result: "Error: crow_delegate requires a non-empty 'goal'", isError: true };
    const botId = (args && args.bot) || boundBotId;
    if (!botId) {
      return { result: "Error: crow_delegate needs a 'bot' (no bot is bound to this conversation)", isError: true };
    }
    // deliver_to: explicit arg wins; else the caller's default (turn thread); else poll.
    let deliverTo = args && args.deliver_to != null ? args.deliver_to : defaultDeliverTo;
    if (deliverTo && typeof deliverTo === "string") {
      try { deliverTo = JSON.parse(deliverTo); } catch { /* leave as-is; stored verbatim */ }
    }
    const db = createDbClient();
    try {
      await ensureBotJobs(db);
      const { rows } = await db.execute({
        sql: "SELECT bot_id, enabled FROM pi_bot_defs WHERE bot_id = ?",
        args: [botId],
      });
      if (!rows.length) return { result: `Error: unknown bot '${botId}'`, isError: true };
      if (!rows[0].enabled) return { result: `Error: bot '${botId}' is disabled`, isError: true };

      const jobId = "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const deliverJson = deliverTo == null ? null
        : (typeof deliverTo === "string" ? deliverTo : JSON.stringify(deliverTo));
      const escalate = args && (args.escalate === true || args.escalate === 1) ? 1 : 0;
      await db.execute({
        sql: "INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source, escalate) "
           + "VALUES (?, ?, ?, 'queued', ?, ?, ?)",
        args: [jobId, botId, goal, deliverJson, "chat", escalate],
      });
      const kind = (deliverTo && deliverTo.kind) || "poll";
      return {
        result: JSON.stringify({ jobId, status: "queued", bot: botId, deliver: kind }),
        isError: false,
      };
    } finally { try { db.close(); } catch {} }
  }

  /** crow_job_status — read a delegated job's current state (poll-mode retrieval). */
  async function handleJobStatus(args) {
    const jobId = args && args.jobId;
    if (!jobId) return { result: "Error: crow_job_status requires 'jobId'", isError: true };
    const db = createDbClient();
    try {
      await ensureBotJobs(db);
      const { rows } = await db.execute({
        sql: "SELECT job_id, bot_id, status, result, error, tool_calls, attempts, "
           + "created_at, started_at, ended_at FROM bot_jobs WHERE job_id = ?",
        args: [jobId],
      });
      if (!rows.length) return { result: `Error: no job '${jobId}'`, isError: true };
      return { result: JSON.stringify(rows[0]), isError: false };
    } finally { try { db.close(); } catch {} }
  }

  /**
   * crow_schedule_bot — create a recurring bot-cron schedule. Stores the job spec
   * ({goal, deliver_to?, escalate?, label?}) as JSON in schedules.description under
   * the task "pipeline:botcron:<bot_id>"; the pi-bots bot_scheduler enqueues a
   * bot_jobs row each time it fires. Mirrors crow_schedule_pipeline.
   */
  async function handleScheduleBot(args) {
    const goal = (args && typeof args.goal === "string") ? args.goal.trim() : "";
    const cron = (args && typeof args.cron === "string") ? args.cron.trim() : "";
    if (!goal) return { result: "Error: crow_schedule_bot requires a 'goal'", isError: true };
    if (!cron) return { result: "Error: crow_schedule_bot requires a 'cron' expression", isError: true };
    const botId = (args && args.bot) || boundBotId;
    if (!botId) return { result: "Error: crow_schedule_bot needs a 'bot'", isError: true };
    const nextRun = botcronNextRun(cron);
    if (!nextRun) return { result: `Error: invalid cron expression '${cron}'`, isError: true };

    const db = createDbClient();
    try {
      const { rows } = await db.execute({ sql: "SELECT enabled FROM pi_bot_defs WHERE bot_id=?", args: [botId] });
      if (!rows.length) return { result: `Error: unknown bot '${botId}'`, isError: true };
      if (!rows[0].enabled) return { result: `Error: bot '${botId}' is disabled`, isError: true };

      const spec = { goal };
      if (args.deliver_to != null) {
        spec.deliver_to = typeof args.deliver_to === "string"
          ? (() => { try { return JSON.parse(args.deliver_to); } catch { return args.deliver_to; } })()
          : args.deliver_to;
      }
      if (args.escalate === true || args.escalate === 1) spec.escalate = true;
      if (args.label) spec.label = String(args.label);

      const { rows: ins } = await db.execute({
        sql: "INSERT INTO schedules (task, cron_expression, description, enabled, next_run) "
           + "VALUES (?, ?, ?, 1, ?) RETURNING id",
        args: [BOTCRON_PREFIX + botId, cron, JSON.stringify(spec), nextRun],
      });
      return {
        result: JSON.stringify({ scheduleId: ins[0].id, bot: botId, cron, next_run: nextRun }),
        isError: false,
      };
    } finally { try { db.close(); } catch {} }
  }

  /** crow_list_bot_schedules — list bot-cron schedules (optionally for one bot). */
  async function handleListBotSchedules(args) {
    const botId = (args && args.bot) || null;
    const db = createDbClient();
    try {
      const sql = "SELECT id, task, cron_expression, description, enabled, last_run, next_run FROM schedules "
        + "WHERE task LIKE ?" + (botId ? " AND task = ?" : "") + " ORDER BY id";
      const sqlArgs = botId ? [BOTCRON_PREFIX + "%", BOTCRON_PREFIX + botId] : [BOTCRON_PREFIX + "%"];
      const { rows } = await db.execute({ sql, args: sqlArgs });
      const list = rows.map((r) => {
        let spec = {};
        try { spec = JSON.parse(r.description || "{}"); } catch { spec = {}; }
        return {
          scheduleId: r.id, bot: r.task.slice(BOTCRON_PREFIX.length), cron: r.cron_expression,
          enabled: !!r.enabled, goal: spec.goal, deliver_to: spec.deliver_to || null,
          label: spec.label || null, last_run: r.last_run, next_run: r.next_run,
        };
      });
      return { result: JSON.stringify(list), isError: false };
    } finally { try { db.close(); } catch {} }
  }

  /** crow_delete_bot_schedule — delete a bot-cron schedule by id (bot-cron rows only). */
  async function handleDeleteBotSchedule(args) {
    const id = args && args.scheduleId;
    if (id == null) return { result: "Error: crow_delete_bot_schedule requires 'scheduleId'", isError: true };
    const db = createDbClient();
    try {
      // Guard: only ever delete a pipeline:botcron: row, never an arbitrary schedule.
      const { rows } = await db.execute({
        sql: "SELECT id FROM schedules WHERE id=? AND task LIKE ?",
        args: [id, BOTCRON_PREFIX + "%"],
      });
      if (!rows.length) return { result: `Error: no bot schedule #${id}`, isError: true };
      await db.execute({ sql: "DELETE FROM schedules WHERE id=? AND task LIKE ?", args: [id, BOTCRON_PREFIX + "%"] });
      return { result: JSON.stringify({ deleted: id }), isError: false };
    } finally { try { db.close(); } catch {} }
  }

  /**
   * Handle crow_discover tool call.
   */
  async function handleDiscover(args) {
    const { category, action } = args;

    if (!category) {
      const lines = ["Available categories:"];
      for (const [cat, manifest] of Object.entries(TOOL_MANIFESTS)) {
        const toolCount = Object.keys(manifest.tools).length;
        lines.push(`  ${cat} (${toolCount} actions): ${manifest.description}`);
      }
      // Include addon servers as discoverable categories
      if (connectedServers) {
        for (const [id, entry] of connectedServers) {
          if (entry.status === "connected" && entry.tools?.length) {
            lines.push(`  tools/${id} (${entry.tools.length} tools): Installed extension`);
          }
        }
      }
      return { result: lines.join("\n"), isError: false };
    }

    // Handle "tools" category — discover addon tools
    if (category === "tools" || category.startsWith("tools/")) {
      const addonId = category.includes("/") ? category.split("/")[1] : null;

      if (action) {
        // Get schema for a specific addon tool
        for (const [id, entry] of connectedServers) {
          if (entry.status !== "connected" || !entry.client) continue;
          const tool = entry.tools?.find((t) => t.name === action);
          if (tool) {
            return {
              result: JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 2),
              isError: false,
            };
          }
        }
        return { result: `Tool "${action}" not found in any addon`, isError: true };
      }

      // List all addon tools (or just one addon)
      const lines = [];
      for (const [id, entry] of connectedServers) {
        if (entry.status !== "connected") continue;
        if (addonId && id !== addonId) continue;
        lines.push(`[${id}] (${entry.tools?.length || 0} tools):`);
        for (const t of entry.tools || []) {
          lines.push(`  - ${t.name}: ${(t.description || "").substring(0, 100)}`);
        }
      }
      return { result: lines.join("\n") || "No addon tools connected", isError: false };
    }

    const manifest = TOOL_MANIFESTS[category];
    if (!manifest) {
      return { result: `Unknown category: ${category}. Use crow_discover (no args) to see available categories.`, isError: true };
    }

    if (action) {
      try {
        const client = await getClient(category);
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === action || t.name === `crow_${action}`);
        if (!tool) {
          return { result: `Action "${action}" not found in ${category}`, isError: true };
        }
        return {
          result: JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 2),
          isError: false,
        };
      } catch (err) {
        return { result: `Error discovering ${category}/${action}: ${err.message}`, isError: true };
      }
    }

    const lines = [`${manifest.displayName} actions:`];
    for (const [toolName, info] of Object.entries(manifest.tools)) {
      const shortName = toolName.replace(/^crow_/, "");
      lines.push(`  - ${shortName}(${info.params}): ${info.desc}`);
    }
    return { result: lines.join("\n"), isError: false };
  }

  /**
   * Handle crow_tools (external integration) tool call.
   *
   * Forgiving parameter handling — accepts multiple formats that weaker models produce:
   *   { action: "tool", params: { key: val } }           — correct format
   *   { action: "tool", params: { arguments: { ... } } } — nested arguments (common mistake)
   *   { action: "tool", arguments: { key: val } }         — arguments instead of params
   *   { action: "tool", key: val, ... }                   — flat params mixed with action
   */
  async function handleExternalTool(args) {
    let { action, params } = args;
    if (!action) {
      return { result: "crow_tools requires an 'action' parameter. Example: { action: 'crow_tax_get_documents', params: {} }", isError: true };
    }

    // Normalize params from various formats weaker models produce
    if (!params || typeof params !== "object") {
      params = {};
    }
    // Unwrap nested { arguments: { ... } } inside params
    if (params.arguments && typeof params.arguments === "object" && Object.keys(params).length <= 2) {
      params = params.arguments;
    }
    // If model put tool params directly on args (flat), extract them
    if (Object.keys(params).length === 0) {
      const flat = { ...args };
      delete flat.action;
      delete flat.params;
      if (Object.keys(flat).length > 0) {
        params = flat;
      }
    }

    for (const [integrationId, entry] of connectedServers) {
      if (entry.status !== "connected" || !entry.client) continue;
      const hasTool = entry.tools.some((t) => t.name === action);
      if (hasTool) {
        try {
          const result = await entry.client.callTool({ name: action, arguments: params });
          return formatResult(result);
        } catch (err) {
          return { result: `Error calling ${action} (${integrationId}): ${err.message}`, isError: true };
        }
      }
    }

    return { result: `Tool "${action}" not found in any connected extension. Available: ${[...connectedServers.entries()].filter(([,e]) => e.status === "connected").map(([id, e]) => `${id}(${e.tools?.length || 0})`).join(", ")}`, isError: true };
  }

  /**
   * Clean up all in-process clients.
   */
  async function close() {
    for (const [, client] of clients) {
      try {
        await client.close();
      } catch {}
    }
    clients.clear();
  }

  return { executeTool, executeToolCalls, close };
}

/**
 * Format an MCP tool result into a truncated string.
 */
function formatResult(mcpResult) {
  const isError = mcpResult.isError || false;
  let text = "";

  if (mcpResult.content) {
    for (const block of mcpResult.content) {
      if (block.type === "text") {
        text += block.text;
      }
    }
  }

  // Truncate long results — but skip for _audio_stream envelopes since the
  // meta-glasses interceptor replaces them with brief prose before the LLM
  // sees them. Truncating here would corrupt the JSON and break playback.
  const hasAudioEnvelope = text.includes('"_audio_stream"') || text.includes('"_audio_stream_control"');
  if (text.length > MAX_RESULT_LENGTH && !hasAudioEnvelope) {
    text = text.slice(0, MAX_RESULT_LENGTH) + "\n...[truncated]";
  }

  return { result: text, isError };
}

const CATEGORY_PROXY_RE = /^crow_(memory|projects|blog|sharing|storage|media|orchestrator|consulting)$/;

/**
 * Slice B (B3, decision 5): resolve a tool call to the EFFECTIVE tool it will
 * actually run, unwrapping the two proxy forms a model can hide an action
 * behind. The permission wrapper must enforce policy on THIS name, not on
 * tc.name (which is bypassable via crow_tools / a category proxy):
 *   crow_tools         { action: "fw_play" }            -> "fw_play"
 *   crow_blog          { action: "publish_post" }       -> "crow_publish_post"
 *   crow_blog          { action: "crow_publish_post" }  -> "crow_publish_post"
 *   crow_publish_post  (direct)                          -> "crow_publish_post"
 */
export function effectiveToolName(tc) {
  const name = tc?.name || "";
  const args = tc?.arguments || {};
  if (name === "crow_tools") {
    return typeof args.action === "string" && args.action ? args.action : name;
  }
  if (CATEGORY_PROXY_RE.test(name) && typeof args.action === "string" && args.action) {
    return args.action.startsWith("crow_") ? args.action : "crow_" + args.action;
  }
  return name;
}

/**
 * Voice-reachable tools that transmit content to an external party. Under a
 * bound bot's permission_policy.external_send === "draft_only", these are
 * blocked on the fast voice turn (spoken explanation) instead of executed
 * (Slice B B3 / Q2). Drafts (crow_create_post, crow_create_song,
 * gmail_create_draft*) are NOT sends and stay allowed.
 */
const EXTERNAL_SEND_TOOLS = new Set([
  "crow_publish_post",       // blog: publishes a draft live
  "crow_share_post",         // blog: shares a post to a peer
  "crow_send_message",       // sharing: encrypted DM (cannot be retracted)
  "crow_send_group_message", // sharing: fan-out encrypted DMs
  "crow_voice_memo",         // sharing: spoken memo to a contact
  "crow_share",              // sharing: share an item with a contact
]);
export function isExternalSendTool(name) {
  if (!name) return false;
  if (EXTERNAL_SEND_TOOLS.has(name)) return true;
  // Addon email sends (gmail_send, gmail_send_to_self, ...); gmail_create_draft* are drafts.
  if (/^gmail_send/.test(name) || /_send_to_self$/.test(name)) return true;
  return false;
}

/**
 * Build the MCP tool schemas for the AI provider.
 *
 * Unbound (no opts.botDef): returns the full category proxies + discover + all
 * connected addon tools — the pre-Slice-B behavior, unchanged.
 *
 * Bound (opts.botDef set — Slice B B3): SCOPES the advertised set to the bot's
 * selection. Core crow_<category> proxies are included only for EXECUTABLE
 * categories the bot selected under (all-or-nothing, decision 4); addon tools
 * only for the bot's selected tool names; orchestrator/consulting category
 * proxies are dropped in favor of explicit crow_orchestrate / _status schemas
 * (D4); device-native tools (capture, discover) are always unioned. Tool
 * selections with no voice equivalent are simply omitted here — B4 surfaces a
 * warning for them (see voiceUnavailableSelections / Q3).
 *
 * @param {object} [opts]
 * @param {object} [opts.botDef] - bound bot definition (pi_bot_defs.definition)
 */
export function getChatTools(opts = {}) {
  const scope = botVoiceScope(opts.botDef);   // null ⇒ unbound, no scoping
  const tools = [];

  for (const [category, manifest] of Object.entries(TOOL_MANIFESTS)) {
    if (scope) {
      // Bound: only executable categories the bot actually selected under.
      if (!EXECUTABLE_CATEGORIES.has(category)) continue;
      if (!scope.coreCategories.has(category)) continue;
    }
    const actionLines = Object.entries(manifest.tools)
      .map(([name, info]) => `- ${name.replace(/^crow_/, "")}(${info.params}): ${info.desc}`)
      .join("\n");

    tools.push({
      name: `crow_${category}`,
      description: `${manifest.description}. Actions:\n${actionLines}`,
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Action name (e.g. 'store_memory', 'search_memories'). Use crow_discover to see full schemas.",
          },
          params: {
            type: "object",
            description: "Parameters for the action",
          },
        },
        required: ["action"],
      },
    });
  }

  // crow_discover
  tools.push({
    name: "crow_discover",
    description: "Discover available actions and their parameter schemas. No args = list categories. category = list actions. category + action = full schema.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Server category: memory, projects, blog, sharing, storage" },
        action: { type: "string", description: "Action name for full schema" },
      },
    },
  });

  // crow_delegate / crow_job_status — pi-backed background jobs (Plan B Part 1
  // Stage 3). The crow_orchestrate replacement: hand a long/background task to a
  // Crow bot, which runs it async; the result is delivered or polled. UNLIKE the
  // force-injected crow_orchestrate (which mis-fired on trivial voice commands and
  // hit a dead provider), this only enqueues a DB row — but the description is kept
  // tight so a weak fast-voice model doesn't reach for it on ordinary requests.
  // Advertised in both bound and unbound turns (a core capability, not scoped).
  tools.push({
    name: "crow_delegate",
    description: "Hand off a LONG or BACKGROUND task to be done asynchronously by a Crow bot, returning "
      + "immediately with a job id. Use ONLY when the user explicitly wants substantial work done in the "
      + "background or later (e.g. 'research X and report back', 'draft a long write-up'). Do NOT use it for "
      + "normal, quick requests you can answer or tool-call directly now (playing music, recalling a memory, "
      + "taking a photo, answering a question). The result is delivered per deliver_to, or read back later "
      + "with crow_job_status.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The task to perform, self-contained." },
        bot: { type: "string", description: "Bot id to run it (default: the bot bound to this conversation)." },
        deliver_to: {
          type: "object",
          description: "Where the result goes. Omit for poll-mode. { kind:'memory', memory_category? } stores "
            + "it as a Crow memory; { kind:'poll' } leaves it for crow_job_status.",
        },
        escalate: { type: "boolean", description: "Use the bot's stronger/escalated model for this job." },
      },
      required: ["goal"],
    },
  });
  tools.push({
    name: "crow_job_status",
    description: "Check a delegated background job by its job id (returned by crow_delegate). Returns its "
      + "status (queued/running/completed/failed) and, when finished, the result.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", description: "The job id from crow_delegate." } },
      required: ["jobId"],
    },
  });

  // Bot-cron management (Stage 4). Administrative — advertised only in the UNBOUND
  // surface (dashboard chat), NOT scoped voice bots, to keep the per-voice-turn
  // tool surface lean (the crow_orchestrate misfire lesson). The recurring job is
  // composed with crow_delegate's runner via the bot_jobs table.
  if (!scope) {
    tools.push({
      name: "crow_schedule_bot",
      description: "Schedule a Crow bot to run a goal on a recurring cron schedule. The result is delivered "
        + "per deliver_to (default poll). Use for recurring background work (e.g. a daily digest).",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The task to run each time." },
          cron: { type: "string", description: "Cron expression, e.g. '0 8 * * *' for 8am daily." },
          bot: { type: "string", description: "Bot id to run it." },
          deliver_to: { type: "object", description: "Result destination, e.g. { kind:'memory' }. Omit for poll." },
          escalate: { type: "boolean", description: "Use the bot's stronger model for each run." },
          label: { type: "string", description: "Human label for the schedule." },
        },
        required: ["goal", "cron", "bot"],
      },
    });
    tools.push({
      name: "crow_list_bot_schedules",
      description: "List recurring bot-cron schedules (optionally filtered to one bot).",
      inputSchema: {
        type: "object",
        properties: { bot: { type: "string", description: "Filter to this bot id (optional)." } },
      },
    });
    tools.push({
      name: "crow_delete_bot_schedule",
      description: "Delete a recurring bot-cron schedule by its scheduleId (from crow_list_bot_schedules).",
      inputSchema: {
        type: "object",
        properties: { scheduleId: { type: "number", description: "The schedule id to delete." } },
        required: ["scheduleId"],
      },
    });
  }

  // Bound bots: device-native tools advertised as explicit schemas.
  // crow_glasses_capture_photo — intercepted in the meta-glasses panel and never
  // reaches an MCP server, but must be advertised so the model can take photos.
  if (scope) {
    tools.push({
      name: "crow_glasses_capture_photo",
      description: "Capture a photo from the paired glasses camera (and, when a vision profile is set, describe it). Use when the user asks what you see or to take a picture.",
      inputSchema: {
        type: "object",
        properties: { device_id: { type: "string", description: "Glasses device id (use the active device)" } },
      },
    });
  }

  // Addon tools (from installed extensions)
  if (connectedServers && connectedServers.size > 0) {
    // Promote high-level "entry point" tools as direct tools (no crow_tools wrapper needed).
    // These are the tools an AI should call first — they do the most with fewest calls.
    // Bundles with consistent naming prefixes (fw_, ha_, etc.) get all their tools
    // promoted so the AI can use them in voice flows like fw_play through the glasses.
    const PROMOTED_PATTERNS = [
      /prepare/, /get_documents/, /calculate/, /generate_pdfs/,
      /^fw_/,           // funkwhale: fw_search, fw_play, fw_libraries, ...
      /^ha_/,           // home-assistant
      /^iptv_/,         // iptv channel manager
      /^kodi_/,         // kodi remote
      /^plex_/,         // plex media server
      /^jellyfin_/,     // jellyfin media server
      /^pf_/,           // pixelfed
      /^ptube_/,        // peertube
      /^masto_/,        // mastodon
      /^gts_/,          // gotosocial
      /^lemmy_/,        // lemmy
      /^matrix_/,       // matrix-dendrite
    ];

    const promotedTools = [];
    const allAddonLines = [];

    for (const [id, entry] of connectedServers) {
      if (entry.status !== "connected" || !entry.tools?.length) continue;
      const toolNames = [];

      for (const tool of entry.tools) {
        // Bound: advertise only addon tools the bot selected (scoped, by name).
        if (scope && !scope.selectedToolNames.has(tool.name)) continue;
        const isPromoted = PROMOTED_PATTERNS.some((p) => p.test(tool.name));
        if (isPromoted) {
          // Expose as direct tool with real schema — no wrapper needed
          tools.push({
            name: tool.name,
            description: tool.description || "",
            inputSchema: tool.inputSchema || { type: "object", properties: {} },
          });
          promotedTools.push(tool.name);
        }
        toolNames.push(tool.name);
      }
      if (toolNames.length) allAddonLines.push(`[${id}]: ${toolNames.join(", ")}`);
    }

    // Also keep crow_tools for accessing granular tools that aren't promoted.
    // When bound with no selected addon tools, there is nothing to call — omit it.
    if (allAddonLines.length) {
      tools.push({
        name: "crow_tools",
        description: `Call any installed extension tool. Use: { action: "tool_name", params: { ... } }.\n\nAll tools by extension:\n${allAddonLines.join("\n")}${promotedTools.length ? `\n\nNote: These tools can also be called directly (no crow_tools wrapper): ${promotedTools.join(", ")}` : ""}`,
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "Tool name" },
            params: { type: "object", description: "Parameters for the tool" },
          },
          required: ["action"],
        },
      });
    }
  }

  return tools;
}
