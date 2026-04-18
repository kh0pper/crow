/**
 * Crow Orchestrator — MCP Server
 *
 * Exposes multi-agent orchestration as Crow tools via the MCP protocol.
 * Uses open-multi-agent as the engine, with Crow's MCP tools bridged
 * into a shared ToolRegistry.
 *
 * Tools:
 *   crow_orchestrate        — Start a multi-agent team on a goal (async, returns job ID)
 *   crow_orchestrate_status — Check/retrieve result of a running job
 *   crow_list_presets       — List available team presets
 *   crow_run_pipeline       — Execute a named pipeline immediately
 *   crow_schedule_pipeline  — Schedule a pipeline on a cron schedule
 *   crow_list_pipelines     — List available pipelines
 *   crow_list_remote_tools  — List tools available on remote Crow instances
 *
 * Jobs are stored in-memory and pruned after 1 hour.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { OpenMultiAgent, ToolRegistry, registerBuiltInTools } from "open-multi-agent";
import { registerCrowTools, registerRemoteTools } from "./mcp-bridge.js";
import { presets } from "./presets.js";
import { resolvePreset } from "./preset-resolver.js";
import { pipelines } from "./pipelines.js";
import { startPipelineRunner } from "./pipeline-runner.js";
import { createDbClient } from "../db.js";
import { ensureModelWarm, releaseModel, getLifecycleSnapshot, resetAllRefcounts } from "./lifecycle.js";
import { attachEventLogger, logEvent } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Models config loader
// ---------------------------------------------------------------------------

function loadModelsConfig() {
  const searchPaths = [
    resolve(__dirname, "../../models.json"),
    resolve(__dirname, "../../bundles/crowclaw/config/agents/main/models.json"),
    resolve(__dirname, "../../config/models.json"),
  ];

  for (const p of searchPaths) {
    try {
      const raw = readFileSync(p, "utf-8");
      return JSON.parse(raw);
    } catch {
      // Try next path
    }
  }

  console.warn("[orchestrator] models.json not found, using defaults");
  return { providers: {} };
}

/**
 * Resolve provider config from models.json.
 * Returns { baseURL, apiKey } for the given provider name.
 */
function resolveProvider(modelsConfig, providerName) {
  const provider = modelsConfig.providers?.[providerName];
  if (!provider) {
    throw new Error(
      `Provider "${providerName}" not found in models.json. ` +
      `Available: ${Object.keys(modelsConfig.providers || {}).join(", ")}`
    );
  }
  return {
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey || undefined,
  };
}

/**
 * Resolve the default orchestrator provider and model.
 * Priority: env vars > first provider in models.json.
 */
function resolveDefaultOrchestratorConfig(modelsConfig) {
  const providers = modelsConfig.providers || {};
  const providerKeys = Object.keys(providers);

  // Resolve provider
  const envProvider = process.env.CROW_ORCHESTRATOR_PROVIDER;
  const providerName = (envProvider && providers[envProvider]) ? envProvider : providerKeys[0];
  if (!providerName) {
    throw new Error("No LLM providers configured in models.json");
  }

  const provider = providers[providerName];

  // Resolve model
  const envModel = process.env.CROW_ORCHESTRATOR_MODEL;
  const modelId = envModel || provider.models?.[0]?.id;

  return {
    provider: providerName,
    model: modelId,
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey || undefined,
  };
}

// ---------------------------------------------------------------------------
// Job storage
// ---------------------------------------------------------------------------

/** @type {Map<string, { status: string, result?: string, error?: string, startedAt: number }>} */
const jobs = new Map();

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.startedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

function generateJobId() {
  return `orch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Prune completed jobs every 10 minutes
setInterval(pruneJobs, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Check if a local/self-hosted LLM server is reachable.
 * Only checks URLs that look like local endpoints (localhost, private IPs).
 * Cloud APIs are assumed reachable (they authenticate, not health-check).
 */
async function checkLlmHealth(baseURL) {
  if (!baseURL) return true;

  // Only health-check local/private endpoints
  try {
    const url = new URL(baseURL);
    const host = url.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1"
      || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("100.");
    if (!isLocal) return true; // Cloud API — skip health check
  } catch {
    return true; // Can't parse URL, assume reachable
  }

  try {
    const healthUrl = baseURL.replace(/\/v1\/?$/, "/health");
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const PIPELINE_PREFIX = "pipeline:";

// ---------------------------------------------------------------------------
// Per-preset ToolRegistry (keyed by sorted category list)
// ---------------------------------------------------------------------------

/** @type {Map<string, ToolRegistry>} */
const registryCache = new Map();

/**
 * Get or create a ToolRegistry for the given MCP categories.
 * Caches by category set (except when "remote" is included — remote tools are dynamic).
 */
async function getRegistryForCategories(categories, connectedServers) {
  const hasRemote = categories.includes("remote");
  const localCategories = categories.filter((c) => c !== "remote");
  const key = [...localCategories].sort().join(",");

  let registry;
  if (!hasRemote && registryCache.has(key)) {
    registry = registryCache.get(key);
  } else {
    registry = new ToolRegistry();
    registerBuiltInTools(registry);

    if (localCategories.length > 0) {
      const { toolCount } = await registerCrowTools(registry, { categories: localCategories });
      console.log(`[orchestrator] Registry [${key}]: ${toolCount} Crow tools + built-ins`);
    }

    if (!hasRemote) {
      registryCache.set(key, registry);
    }
  }

  // Register remote instance tools (not cached — connections are dynamic)
  if (hasRemote && connectedServers) {
    const { toolCount: remoteCount } = await registerRemoteTools(registry, connectedServers);
    if (remoteCount > 0) {
      console.log(`[orchestrator] Registry [${key}+remote]: +${remoteCount} remote tools`);
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createOrchestratorServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-orchestrator", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  const modelsConfig = loadModelsConfig();
  const connectedServers = options.connectedServers || null;

  // Phase 5-full: attach the event logger so lifecycle + dispatch events
  // persist to orchestrator_events. No-op if no DB is available.
  try {
    const db = createDbClient(dbPath);
    attachEventLogger(db);
  } catch {}

  // Resolve default provider/model once at startup
  let defaults;
  try {
    defaults = resolveDefaultOrchestratorConfig(modelsConfig);
    console.log(`[orchestrator] Default provider: ${defaults.provider}, model: ${defaults.model}`);
  } catch (err) {
    console.warn(`[orchestrator] No default provider: ${err.message}`);
    defaults = { provider: null, model: null, baseURL: null, apiKey: null };
  }

  // -----------------------------------------------------------------------
  // Helper: resolve provider config for a preset (with per-agent overrides)
  // -----------------------------------------------------------------------

  function resolveAgentConfig(agent, preset) {
    const agentProvider = agent.provider || preset.provider || defaults.provider;
    const agentModel = agent.model || preset.model || defaults.model;
    if (!agentProvider) {
      throw new Error("No LLM provider configured. Set CROW_ORCHESTRATOR_PROVIDER or add a provider to models.json.");
    }
    const pc = resolveProvider(modelsConfig, agentProvider);
    return {
      name: agent.name,
      model: agentModel,
      provider: "openai", // All providers use OpenAI-compatible API
      apiKey: pc.apiKey,
      baseURL: pc.baseURL,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools,
      maxTurns: agent.maxTurns || 6,
      maxTokens: agent.maxTokens || preset.maxTokens || 8192,
    };
  }

  // -----------------------------------------------------------------------
  // Helper: health check for a preset's default provider
  // -----------------------------------------------------------------------

  async function checkPresetHealth(preset) {
    const providerName = preset.provider || defaults.provider;
    if (!providerName) return { healthy: false, error: "No LLM provider configured" };

    let pc;
    try {
      pc = resolveProvider(modelsConfig, providerName);
    } catch (err) {
      return { healthy: false, error: err.message };
    }

    // Only health-check providers with a baseURL (local/self-hosted)
    if (pc.baseURL) {
      const healthy = await checkLlmHealth(pc.baseURL);
      if (!healthy) {
        return { healthy: false, error: `LLM server not reachable at ${pc.baseURL}` };
      }
    }

    return { healthy: true, providerConfig: pc };
  }

  // -----------------------------------------------------------------------
  // Background orchestration runner (inside closure for connectedServers access)
  // -----------------------------------------------------------------------

  async function runOrchestration(jobId, goal, preset, providerConfig) {
    const job = jobs.get(jobId);
    if (!job) return;

    // Phase 5-full: ensure all providers the preset agents need are warm.
    // Collect unique provider IDs from preset + per-agent overrides.
    const requiredProviders = new Set();
    if (preset.provider) requiredProviders.add(preset.provider);
    for (const a of preset.agents || []) {
      if (a.provider) requiredProviders.add(a.provider);
    }
    const warmed = [];
    for (const providerId of requiredProviders) {
      const r = await ensureModelWarm(providerId);
      await logEvent({
        run_id: jobId,
        event_type: r.ok ? "dispatch.provider_ready" : "dispatch.provider_failed",
        provider_id: providerId,
        preset: preset.name || null,
        data: r.ok ? null : { reason: r.reason },
      });
      if (r.ok) warmed.push(providerId);
      else {
        // A required provider failed to warm — abort this run cleanly
        for (const w of warmed) await releaseModel(w);
        const err = `required provider "${providerId}" unavailable: ${r.reason}`;
        job.status = "failed"; job.error = err;
        await logEvent({ run_id: jobId, event_type: "dispatch.aborted", preset: preset.name || null, data: { error: err } });
        return;
      }
    }

    await logEvent({ run_id: jobId, event_type: "dispatch.run_start", preset: preset.name || null, data: { goal: String(goal).slice(0, 200) } });

    try {
      const categories = preset.categories || ["memory", "projects"];
      const registry = await getRegistryForCategories(categories, connectedServers);

      // Expand wildcard tool references (e.g., "colibri:*")
      const expandedAgents = preset.agents.map((a) => {
        if (!a.tools || a.tools.length === 0) return a;
        const allTools = registry.list ? [...registry.list()] : [];
        const expanded = a.tools.flatMap((t) => {
          if (typeof t === "string" && t.endsWith(":*")) {
            const prefix = t.slice(0, -1); // "colibri:"
            const matches = allTools.filter((name) => name.startsWith(prefix));
            if (matches.length === 0) {
              console.warn(`[orchestrator] Wildcard "${t}" matched 0 tools (instance may be offline)`);
            }
            return matches;
          }
          return [t];
        });
        return { ...a, tools: expanded };
      });

      // Build agent configs with per-agent provider resolution
      const agentConfigs = expandedAgents.map((a) => resolveAgentConfig(a, preset));

      const presetProvider = preset.provider || defaults.provider;
      const presetModel = preset.model || defaults.model;
      const presetPC = resolveProvider(modelsConfig, presetProvider);

      const orchestrator = new OpenMultiAgent({
        maxConcurrency: preset.maxConcurrency || 1,
        defaultModel: presetModel,
        defaultProvider: "openai",
        defaultApiKey: presetPC.apiKey,
        defaultBaseURL: presetPC.baseURL,
        toolRegistry: registry,
        onProgress: (event) => {
          let extra = "";
          if (event.type === "task_complete" && event.data?.output) {
            extra = ` output=${event.data.output.length}chars`;
          }
          if (event.type === "agent_complete" && event.data?.toolCalls?.length > 0) {
            extra = ` toolCalls=${event.data.toolCalls.length}`;
          }
          if (event.type === "error") {
            const d = event.data;
            const msg = d?.message || d?.output || String(d);
            extra = ` error="${msg.slice(0, 300)}"`;
          }
          console.log(`[orchestrator] [${jobId}] ${event.type}${event.agent ? ` agent=${event.agent}` : ""}${event.task ? ` task=${event.task}` : ""}${extra}`);
        },
      });

      const team = orchestrator.createTeam("team", {
        name: "team",
        agents: agentConfigs,
        sharedMemory: true,
        maxConcurrency: preset.maxConcurrency || 1,
      });

      // Run with 5 minute timeout
      const result = await Promise.race([
        orchestrator.runTeam(team, goal),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Orchestration timed out after 5 minutes")), 300000)
        ),
      ]);

      // Extract coordinator's final synthesis
      const coordinatorResult = result.agentResults.get("coordinator");
      const output = coordinatorResult?.output || "(no coordinator output)";

      const fullResult = [
        output,
        "",
        "---",
        `Orchestration completed: ${result.success ? "success" : "partial failure"}`,
        `Total tokens: ${result.totalTokenUsage.input_tokens} in / ${result.totalTokenUsage.output_tokens} out`,
      ].join("\n");

      job.status = "completed";
      job.result = fullResult;

      await orchestrator.shutdown();
      await logEvent({
        run_id: jobId,
        event_type: "dispatch.run_complete",
        preset: preset.name || null,
        data: { tokens_in: result.totalTokenUsage.input_tokens, tokens_out: result.totalTokenUsage.output_tokens },
      });
    } catch (err) {
      job.status = "failed";
      job.error = err.message || String(err);
      console.error(`[orchestrator] Job ${jobId} failed:`, err.message);
      await logEvent({
        run_id: jobId,
        event_type: "dispatch.run_error",
        preset: preset.name || null,
        data: { error: String(err.message || err).slice(0, 500) },
      });
    } finally {
      // Release every provider we warmed up for this run.
      for (const providerId of requiredProviders) {
        await releaseModel(providerId).catch(() => {});
      }
    }
  }

  // -----------------------------------------------------------------------
  // MCP Tools
  // -----------------------------------------------------------------------

  // --- crow_list_presets ---

  server.tool(
    "crow_list_presets",
    "List available multi-agent team presets with their descriptions, provider, model, and agent names.",
    {},
    async () => {
      const lines = [];
      for (const [name, preset] of Object.entries(presets)) {
        const agentNames = preset.agents.map((a) => a.name).join(", ");
        const provider = preset.provider || defaults.provider || "(none)";
        const model = preset.model || defaults.model || "(none)";
        lines.push(
          `**${name}** — ${preset.description}\n` +
          `  Provider: ${provider}, Model: ${model}\n` +
          `  Agents: ${agentNames}`
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
      };
    }
  );

  // --- crow_orchestrate ---

  server.tool(
    "crow_orchestrate",
    "Start a multi-agent team on a goal. Returns a job ID immediately — the orchestration runs in the background. Use crow_orchestrate_status to check progress and retrieve results.",
    {
      goal: z.string().min(1).describe("The high-level goal for the agent team to accomplish"),
      preset: z.string().optional().describe('Team preset name (default: "research"). Use crow_list_presets to see options.'),
    },
    async ({ goal, preset: presetName }) => {
      const name = presetName || "research";
      const presetDb = createDbClient();
      let preset;
      try { preset = await resolvePreset(presetDb, name); }
      finally { presetDb.close(); }
      if (!preset) {
        return {
          content: [{
            type: "text",
            text: `Unknown preset: "${name}". Available: ${Object.keys(presets).join(", ")}`,
          }],
          isError: true,
        };
      }

      const { healthy, error } = await checkPresetHealth(preset);
      if (!healthy) {
        return { content: [{ type: "text", text: error }], isError: true };
      }

      const jobId = generateJobId();
      jobs.set(jobId, { status: "running", startedAt: Date.now() });

      runOrchestration(jobId, goal, preset, null).catch((err) => {
        console.error(`[orchestrator] Job ${jobId} unexpected error:`, err);
        const job = jobs.get(jobId);
        if (job && job.status === "running") {
          job.status = "failed";
          job.error = err.message;
        }
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ jobId, status: "running", preset: presetName || "research", goal }),
        }],
      };
    }
  );

  // --- crow_orchestrate_status ---

  server.tool(
    "crow_orchestrate_status",
    "Check the status of a multi-agent orchestration job. Returns the result when completed.",
    {
      jobId: z.string().describe("Job ID returned by crow_orchestrate"),
    },
    async ({ jobId }) => {
      const job = jobs.get(jobId);
      if (!job) {
        return {
          content: [{ type: "text", text: `Job not found: ${jobId}. It may have expired (jobs are kept for 1 hour).` }],
          isError: true,
        };
      }

      const response = { status: job.status };
      if (job.result) response.result = job.result;
      if (job.error) response.error = job.error;

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- crow_run_pipeline ---

  server.tool(
    "crow_run_pipeline",
    "Execute a named pipeline immediately. Pipelines are predefined multi-agent workflows (e.g. memory-consolidation, daily-summary). Returns a job ID — poll with crow_orchestrate_status.",
    {
      pipeline: z.string().describe("Pipeline name (use crow_list_pipelines to see options)"),
    },
    async ({ pipeline: pipelineName }) => {
      const pipeline = pipelines[pipelineName];
      if (!pipeline) {
        return {
          content: [{
            type: "text",
            text: `Unknown pipeline: "${pipelineName}". Available: ${Object.keys(pipelines).join(", ")}`,
          }],
          isError: true,
        };
      }

      const presetDb = createDbClient();
      let preset;
      try { preset = await resolvePreset(presetDb, pipeline.preset); }
      finally { presetDb.close(); }
      if (!preset) {
        return {
          content: [{ type: "text", text: `Pipeline "${pipelineName}" references unknown preset: "${pipeline.preset}"` }],
          isError: true,
        };
      }

      const { healthy, error } = await checkPresetHealth(preset);
      if (!healthy) {
        return { content: [{ type: "text", text: error }], isError: true };
      }

      const jobId = generateJobId();
      jobs.set(jobId, { status: "running", startedAt: Date.now(), pipeline: pipelineName });

      runOrchestration(jobId, pipeline.goal, preset, null).catch((err) => {
        console.error(`[orchestrator] Pipeline job ${jobId} error:`, err);
        const job = jobs.get(jobId);
        if (job && job.status === "running") {
          job.status = "failed";
          job.error = err.message;
        }
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ jobId, status: "running", pipeline: pipelineName, goal: pipeline.goal }),
        }],
      };
    }
  );

  // --- crow_schedule_pipeline ---

  server.tool(
    "crow_schedule_pipeline",
    "Schedule a pipeline to run on a cron schedule. Creates an entry in Crow's schedules table with a pipeline: prefix.",
    {
      pipeline: z.string().describe("Pipeline name (e.g. memory-consolidation, daily-summary, research-digest)"),
      cron_expression: z.string().max(50).optional().describe("Cron expression (e.g. '0 3 * * *'). If omitted, uses the pipeline's default schedule."),
      description: z.string().max(500).optional().describe("Optional description override"),
    },
    async ({ pipeline: pipelineName, cron_expression, description }) => {
      const pipeline = pipelines[pipelineName];
      if (!pipeline) {
        return {
          content: [{
            type: "text",
            text: `Unknown pipeline: "${pipelineName}". Available: ${Object.keys(pipelines).join(", ")}`,
          }],
          isError: true,
        };
      }

      const cron = cron_expression || pipeline.defaultCron;

      let nextRun = null;
      try {
        const { CronExpressionParser } = await import("cron-parser");
        const interval = CronExpressionParser.parse(cron);
        nextRun = interval.next().toISOString();
      } catch {
        return {
          content: [{ type: "text", text: `Invalid cron expression: "${cron}". Use standard 5-field format.` }],
          isError: true,
        };
      }

      const db = createDbClient();
      const task = `${PIPELINE_PREFIX}${pipelineName}`;
      const desc = description || pipeline.description;

      const { rows: existing } = await db.execute({
        sql: "SELECT id FROM schedules WHERE task = ?",
        args: [task],
      });

      if (existing.length > 0) {
        await db.execute({
          sql: "UPDATE schedules SET cron_expression = ?, description = ?, next_run = ?, enabled = 1, updated_at = datetime('now') WHERE task = ?",
          args: [cron, desc, nextRun, task],
        });
        return {
          content: [{
            type: "text",
            text: `Pipeline schedule updated (id: #${existing[0].id}, pipeline: ${pipelineName}, cron: ${cron}, next run: ${nextRun})`,
          }],
        };
      }

      const result = await db.execute({
        sql: "INSERT INTO schedules (task, cron_expression, description, next_run) VALUES (?, ?, ?, ?)",
        args: [task, cron, desc, nextRun],
      });

      return {
        content: [{
          type: "text",
          text: `Pipeline scheduled (id: #${Number(result.lastInsertRowid)}, pipeline: ${pipelineName}, cron: ${cron}, next run: ${nextRun})`,
        }],
      };
    }
  );

  // --- crow_list_pipelines ---

  server.tool(
    "crow_list_pipelines",
    "List available pipelines with their descriptions and default schedules.",
    {},
    async () => {
      const lines = [];
      for (const [name, pipeline] of Object.entries(pipelines)) {
        lines.push(
          `**${name}** — ${pipeline.description}\n` +
          `  Preset: ${pipeline.preset}, Default cron: ${pipeline.defaultCron}\n` +
          `  Stores result: ${pipeline.storeResult ? `yes (category: ${pipeline.resultCategory})` : "no"}`
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
      };
    }
  );

  // --- crow_list_remote_tools ---

  server.tool(
    "crow_list_remote_tools",
    "List tools available on remote Crow instances. Shows connected instances and their exposed tools.",
    {},
    async () => {
      if (!connectedServers) {
        return {
          content: [{ type: "text", text: "No remote instances available (orchestrator running in stdio mode)." }],
        };
      }

      const lines = [];
      for (const [key, entry] of connectedServers) {
        if (!entry.isRemote) continue;
        const status = entry.status === "connected" ? "connected" : `offline (${entry.error || "unknown"})`;
        const toolNames = (entry.tools || []).map((t) => t.name);
        lines.push(
          `**${entry.instanceName || key}** — ${status}\n` +
          `  Gateway: ${entry.gatewayUrl || "unknown"}\n` +
          `  Tools (${toolNames.length}): ${toolNames.join(", ") || "(none)"}`
        );
      }

      if (lines.length === 0) {
        return { content: [{ type: "text", text: "No remote instances registered." }] };
      }

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
      };
    }
  );

  // --- crow_lifecycle_snapshot (Phase 5-full) ---
  server.tool(
    "crow_lifecycle_snapshot",
    "Return the current orchestrator lifecycle snapshot (refcounts per provider, last released timestamps).",
    {},
    async () => {
      const snap = getLifecycleSnapshot();
      if (Object.keys(snap).length === 0) {
        return { content: [{ type: "text", text: "No providers currently tracked." }] };
      }
      const lines = Object.entries(snap).map(([k, v]) => {
        const age = v.lastReleasedAt ? ` (released ${Math.round((Date.now() - v.lastReleasedAt) / 1000)}s ago)` : "";
        return `  ${k}: refs=${v.refs}${age}`;
      });
      return { content: [{ type: "text", text: "Lifecycle snapshot:\n" + lines.join("\n") }] };
    }
  );

  // --- crow_reset_refcounts (operator kill switch) ---
  server.tool(
    "crow_reset_refcounts",
    "Operator kill switch: clear all lifecycle refcounts and reconcile against live provider health. Use when refcount state drifts from reality.",
    {},
    async () => {
      const r = await resetAllRefcounts();
      return { content: [{ type: "text", text: `Refcounts reset. Reconciled ${r.reconciled} providers.` }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Pipeline runner integration
// ---------------------------------------------------------------------------

/**
 * Start the background pipeline runner. Call from gateway startup.
 *
 * @param {object} db - libsql database client
 * @param {object} [options]
 * @param {Map} [options.connectedServers] - Remote instance connections (from proxy.js)
 */
export function startOrchestratorPipelines(db, options = {}) {
  const modelsConfig = loadModelsConfig();
  const connectedServers = options.connectedServers || null;

  let pipelineDefaults;
  try {
    pipelineDefaults = resolveDefaultOrchestratorConfig(modelsConfig);
  } catch {
    pipelineDefaults = { provider: null, model: null, baseURL: null, apiKey: null };
  }

  async function runOrchestrationSync(goal, presetName) {
    const presetDb = createDbClient();
    let preset;
    try { preset = await resolvePreset(presetDb, presetName); }
    finally { presetDb.close(); }
    if (!preset) {
      return { status: "failed", error: `Unknown preset: "${presetName}"` };
    }

    const providerName = preset.provider || pipelineDefaults.provider;
    if (!providerName) {
      return { status: "failed", error: "No LLM provider configured" };
    }

    let pc;
    try {
      pc = resolveProvider(modelsConfig, providerName);
    } catch (err) {
      return { status: "failed", error: err.message };
    }

    if (pc.baseURL) {
      const healthy = await checkLlmHealth(pc.baseURL);
      if (!healthy) {
        return { status: "failed", error: `LLM not reachable at ${pc.baseURL}` };
      }
    }

    // Build a temporary orchestrator server to reuse runOrchestration
    const tempServer = createOrchestratorServer(undefined, { connectedServers });

    const jobId = generateJobId();
    jobs.set(jobId, { status: "running", startedAt: Date.now() });

    // Run orchestration using the registry from getRegistryForCategories
    const categories = preset.categories || ["memory", "projects"];
    const registry = await getRegistryForCategories(categories, connectedServers);

    const presetModel = preset.model || pipelineDefaults.model;
    const agentConfigs = preset.agents.map((a) => {
      const agentProvider = a.provider || preset.provider || pipelineDefaults.provider;
      const agentModel = a.model || preset.model || pipelineDefaults.model;
      const agentPC = resolveProvider(modelsConfig, agentProvider);
      return {
        name: a.name,
        model: agentModel,
        provider: "openai",
        apiKey: agentPC.apiKey,
        baseURL: agentPC.baseURL,
        systemPrompt: a.systemPrompt,
        tools: a.tools,
        maxTurns: a.maxTurns || 6,
        maxTokens: a.maxTokens || preset.maxTokens || 8192,
      };
    });

    const presetPC = resolveProvider(modelsConfig, providerName);

    try {
      const orchestrator = new OpenMultiAgent({
        maxConcurrency: preset.maxConcurrency || 1,
        defaultModel: presetModel,
        defaultProvider: "openai",
        defaultApiKey: presetPC.apiKey,
        defaultBaseURL: presetPC.baseURL,
        toolRegistry: registry,
        onProgress: (event) => {
          if (event.type === "error") {
            const d = event.data;
            const msg = d?.message || d?.output || String(d);
            console.log(`[pipeline-runner] ${event.type} ${event.agent || ""} error="${msg.slice(0, 200)}"`);
          }
        },
      });

      const team = orchestrator.createTeam("team", {
        name: "team",
        agents: agentConfigs,
        sharedMemory: true,
        maxConcurrency: preset.maxConcurrency || 1,
      });

      const result = await Promise.race([
        orchestrator.runTeam(team, goal),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Pipeline timed out after 5 minutes")), 300000)
        ),
      ]);

      const coordinatorResult = result.agentResults.get("coordinator");
      const output = coordinatorResult?.output || "(no coordinator output)";

      await orchestrator.shutdown();

      return {
        status: "completed",
        result: [
          output,
          "",
          "---",
          `Pipeline completed: ${result.success ? "success" : "partial failure"}`,
          `Total tokens: ${result.totalTokenUsage.input_tokens} in / ${result.totalTokenUsage.output_tokens} out`,
        ].join("\n"),
      };
    } catch (err) {
      return { status: "failed", error: err.message || String(err) };
    }
  }

  async function storeResultAsMemory(title, content, category) {
    await db.execute({
      sql: `INSERT INTO memories (content, category, importance, tags)
            VALUES (?, ?, 6, 'pipeline,automated')`,
      args: [`${title}\n\n${content}`, category],
    });
  }

  startPipelineRunner(db, {
    runOrchestration: runOrchestrationSync,
    storeResult: storeResultAsMemory,
  });
}
