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
 *
 * Jobs are stored in-memory and pruned after 1 hour.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { OpenMultiAgent, ToolRegistry, registerBuiltInTools } from "open-multi-agent";
import { registerCrowTools } from "./mcp-bridge.js";
import { presets } from "./presets.js";
import { pipelines } from "./pipelines.js";
import { startPipelineRunner } from "./pipeline-runner.js";
import { createDbClient } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Models config loader
// ---------------------------------------------------------------------------

/**
 * Load models.json and extract provider config (baseUrl, apiKey).
 * Searches multiple known locations.
 */
function loadModelsConfig() {
  const searchPaths = [
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
// Per-preset ToolRegistry (keyed by sorted category list)
// ---------------------------------------------------------------------------

/** @type {Map<string, ToolRegistry>} */
const registryCache = new Map();

/**
 * Get or create a ToolRegistry for the given MCP categories.
 * Each unique set of categories gets its own registry (cached).
 * Only the needed servers are connected — avoids loading sharing/blog
 * servers whose Hyperswarm/Nostr connections can interfere with tool calls.
 */
async function getRegistryForCategories(categories) {
  const key = [...categories].sort().join(",");
  if (registryCache.has(key)) return registryCache.get(key);

  const registry = new ToolRegistry();
  registerBuiltInTools(registry);
  const { toolCount } = await registerCrowTools(registry, { categories });
  console.log(`[orchestrator] Registry [${key}]: ${toolCount} Crow tools + built-ins`);
  registryCache.set(key, registry);
  return registry;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkLlmHealth(baseURL) {
  if (!baseURL) return true; // No URL = cloud provider, assume reachable

  try {
    // Try /health (llama.cpp) or just /v1/models (OpenAI-compatible)
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
// Server factory
// ---------------------------------------------------------------------------

export function createOrchestratorServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-orchestrator", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  const modelsConfig = loadModelsConfig();

  // --- crow_list_presets ---

  server.tool(
    "crow_list_presets",
    "List available multi-agent team presets with their descriptions, provider, model, and agent names.",
    {},
    async () => {
      const lines = [];
      for (const [name, preset] of Object.entries(presets)) {
        const agentNames = preset.agents.map((a) => a.name).join(", ");
        lines.push(
          `**${name}** — ${preset.description}\n` +
          `  Provider: ${preset.provider}, Model: ${preset.model}\n` +
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
      const preset = presets[presetName || "research"];
      if (!preset) {
        return {
          content: [{
            type: "text",
            text: `Unknown preset: "${presetName}". Available: ${Object.keys(presets).join(", ")}`,
          }],
          isError: true,
        };
      }

      // Resolve LLM provider
      let providerConfig;
      try {
        providerConfig = resolveProvider(modelsConfig, preset.provider);
      } catch (err) {
        return {
          content: [{ type: "text", text: err.message }],
          isError: true,
        };
      }

      // Health check for local providers
      if (preset.provider === "local") {
        const healthy = await checkLlmHealth(providerConfig.baseURL);
        if (!healthy) {
          return {
            content: [{
              type: "text",
              text: `LLM server not reachable at ${providerConfig.baseURL}. Is llama-server running?`,
            }],
            isError: true,
          };
        }
      }

      // Create job
      const jobId = generateJobId();
      jobs.set(jobId, { status: "running", startedAt: Date.now() });

      // Run orchestration in background (do NOT await)
      runOrchestration(jobId, goal, preset, providerConfig).catch((err) => {
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
      pipeline: z.string().describe("Pipeline name (use crow_list_presets to see pipelines section)"),
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

      // Delegate to crow_orchestrate internally
      const preset = presets[pipeline.preset];
      if (!preset) {
        return {
          content: [{ type: "text", text: `Pipeline "${pipelineName}" references unknown preset: "${pipeline.preset}"` }],
          isError: true,
        };
      }

      let providerConfig;
      try {
        providerConfig = resolveProvider(modelsConfig, preset.provider);
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }

      if (preset.provider === "local") {
        const healthy = await checkLlmHealth(providerConfig.baseURL);
        if (!healthy) {
          return {
            content: [{
              type: "text",
              text: `LLM server not reachable at ${providerConfig.baseURL}. Is llama-server running?`,
            }],
            isError: true,
          };
        }
      }

      const jobId = generateJobId();
      jobs.set(jobId, { status: "running", startedAt: Date.now(), pipeline: pipelineName });

      runOrchestration(jobId, pipeline.goal, preset, providerConfig).catch((err) => {
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

      // Validate cron
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

      // Check for existing schedule with the same task
      const { rows: existing } = await db.execute({
        sql: "SELECT id FROM schedules WHERE task = ?",
        args: [task],
      });

      if (existing.length > 0) {
        // Update existing schedule
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

  return server;
}

// ---------------------------------------------------------------------------
// Pipeline runner integration
// ---------------------------------------------------------------------------

/**
 * Start the background pipeline runner. Call from gateway startup.
 * Polls the schedules table for pipeline: entries and runs orchestrations.
 *
 * @param {object} db - libsql database client
 */
export function startOrchestratorPipelines(db) {
  const modelsConfig = loadModelsConfig();

  async function runOrchestrationSync(goal, presetName) {
    const preset = presets[presetName];
    if (!preset) {
      return { status: "failed", error: `Unknown preset: "${presetName}"` };
    }

    let providerConfig;
    try {
      providerConfig = resolveProvider(modelsConfig, preset.provider);
    } catch (err) {
      return { status: "failed", error: err.message };
    }

    if (preset.provider === "local") {
      const healthy = await checkLlmHealth(providerConfig.baseURL);
      if (!healthy) {
        return { status: "failed", error: `LLM not reachable at ${providerConfig.baseURL}` };
      }
    }

    const jobId = generateJobId();
    jobs.set(jobId, { status: "running", startedAt: Date.now() });

    await runOrchestration(jobId, goal, preset, providerConfig);

    const job = jobs.get(jobId);
    return {
      status: job?.status || "failed",
      result: job?.result,
      error: job?.error,
    };
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

// ---------------------------------------------------------------------------
// Background orchestration runner
// ---------------------------------------------------------------------------

async function runOrchestration(jobId, goal, preset, providerConfig) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    const categories = preset.categories || ["memory", "projects"];
    const registry = await getRegistryForCategories(categories);

    // Build agent configs from preset
    const agentConfigs = preset.agents.map((a) => ({
      name: a.name,
      model: preset.model,
      provider: "openai",  // All providers use OpenAI-compatible API
      apiKey: providerConfig.apiKey,
      baseURL: providerConfig.baseURL,
      systemPrompt: a.systemPrompt,
      tools: a.tools,
      maxTurns: a.maxTurns || 6,
      maxTokens: 4096,
    }));

    const orchestrator = new OpenMultiAgent({
      maxConcurrency: 1,
      defaultModel: preset.model,
      defaultProvider: "openai",
      defaultApiKey: providerConfig.apiKey,
      defaultBaseURL: providerConfig.baseURL,
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
      maxConcurrency: 1,
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

    // Also gather individual agent outputs for context
    const agentOutputs = [];
    for (const [name, agentResult] of result.agentResults) {
      if (name !== "coordinator") {
        agentOutputs.push(`## ${name}\n${agentResult.output}`);
      }
    }

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
  } catch (err) {
    job.status = "failed";
    job.error = err.message || String(err);
    console.error(`[orchestrator] Job ${jobId} failed:`, err.message);
  }
}
