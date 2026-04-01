# Orchestrator Server

The orchestrator server (`servers/orchestrator/`) provides multi-agent orchestration, allowing teams of AI agents to collaborate on complex goals using Crow's MCP tools.

Powered by the [open-multi-agent](https://github.com/kh0pper/open-multi-agent) engine, the orchestrator bridges Crow's existing tools (memory, projects, blog, sharing) into a shared tool registry that multiple agents can access simultaneously.

## How It Works

```
User Goal → Coordinator Agent → Task Decomposition
                                      ↓
                              Worker Agent Pool
                          (each with filtered tools)
                                      ↓
                      Shared Memory + Tool Results
                                      ↓
                      Coordinator Synthesizes Output
```

1. You provide a **goal** (plain text) and select a **preset** (team configuration)
2. A **coordinator agent** decomposes the goal into tasks and assigns them to worker agents
3. Each **worker agent** has access to a filtered subset of Crow's MCP tools (max ~10 per agent)
4. Workers execute tasks, calling tools and sharing results via shared memory
5. The coordinator synthesizes all findings into a final output

## Tools

### crow_orchestrate

Start a multi-agent team on a goal. Runs asynchronously and returns a job ID immediately.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `goal` | string | Yes | The high-level goal for the agent team |
| `preset` | string | No | Team preset name (default: "research") |

### crow_orchestrate_status

Check the status of a running orchestration job.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `jobId` | string | Yes | Job ID returned by crow_orchestrate |

Returns `{ status: "running" | "completed" | "failed", result?, error? }`.

### crow_list_presets

List all available team presets with their descriptions, provider, model, and agent names. No parameters.

### crow_run_pipeline

Execute a named pipeline immediately. Like crow_orchestrate but uses a predefined goal.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pipeline` | string | Yes | Pipeline name (e.g. "memory-consolidation") |

### crow_schedule_pipeline

Schedule a pipeline to run on a cron schedule. Creates an entry in Crow's schedules table.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pipeline` | string | Yes | Pipeline name |
| `cron_expression` | string | No | Cron expression (defaults to pipeline's built-in schedule) |
| `description` | string | No | Optional description override |

### crow_list_pipelines

List all available pipelines with descriptions and default schedules. No parameters.

## Presets

Presets define team configurations: which LLM provider and model to use, and which agents participate with what tools.

| Preset | Description | Provider | Agents |
|---|---|---|---|
| `research` | Research team with memory/project search and writing | local | researcher, writer |
| `research_cloud` | Same as research but using cloud LLM | z.ai | researcher, writer |
| `memory_ops` | Memory analysis, consolidation, and organization | local | analyst |
| `full` | Broad team with research, memory writing, and synthesis | local | researcher, memory_writer, writer |

Each agent's `tools` array is a whitelist. The coordinator agent (auto-created by the engine) always gets `tools: []` so it only decomposes goals without calling tools.

### Adding a Preset

Add an entry to `servers/orchestrator/presets.js`:

```javascript
export const presets = {
  my_preset: {
    description: "What this team does",
    categories: ["memory", "projects"],  // which MCP servers to bridge
    provider: "local",                   // from models.json
    model: "opus-reasoning-35b",
    agents: [
      {
        name: "worker",
        systemPrompt: "You are a specialized agent...",
        tools: ["crow_search_memories", "crow_list_memories"],
        maxTurns: 6,
      },
    ],
  },
}
```

Keep tool count per agent to ~10 max to fit within 16K context windows on local models.

## Pipelines

Pipelines are predefined goal + preset combinations that can run on a schedule.

| Pipeline | Default Schedule | Preset | Description |
|---|---|---|---|
| `memory-consolidation` | Daily at 3am | memory_ops | Find duplicate and conflicting memories |
| `daily-summary` | Daily at 10pm | research | Summarize the day's activity |
| `research-digest` | Weekly Monday 9am | research | Review all active projects |

Pipeline results are automatically stored as Crow memories (category from pipeline config, tagged `pipeline,automated`).

### Scheduling a Pipeline

```
"Schedule the daily-summary pipeline"
→ crow_schedule_pipeline({ pipeline: "daily-summary" })
→ Uses default cron: "0 22 * * *"

"Run memory consolidation every Sunday at 2am"
→ crow_schedule_pipeline({ pipeline: "memory-consolidation", cron_expression: "0 2 * * 0" })
```

The pipeline runner polls the schedules table every 60 seconds for `pipeline:` prefix entries and executes them when due.

## MCP Bridge

The MCP bridge (`servers/orchestrator/mcp-bridge.js`) connects Crow's MCP servers to the orchestration engine:

1. Creates in-process MCP clients via `InMemoryTransport` (same pattern as the gateway's tool executor)
2. Lists all tools from each connected server
3. Registers each tool in the shared `ToolRegistry` with:
   - `z.any()` as the Zod schema (passthrough, no client-side validation)
   - `rawInputSchema` set to the tool's real JSON Schema (sent to the LLM for parameter generation)
4. Tool execution calls back through the MCP client to the server

Per-preset category filtering ensures only the needed servers are connected (e.g., the `research` preset only bridges memory and projects, not sharing or blog).

## LLM Configuration

The orchestrator reads `models.json` (same config file as Crow's main AI chat) to resolve provider endpoints. Local presets use llama.cpp on port 8081; cloud presets use z.ai or other configured providers.

Key settings:
- `maxConcurrency: 1` serializes LLM calls (single GPU constraint)
- `maxTokens: 4096` per agent response (leaves room for prompts within 16K context)
- 5-minute timeout on all orchestrations
- Health check on local LLM before starting (checks `/health` endpoint)
