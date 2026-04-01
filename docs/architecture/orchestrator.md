# Orchestrator Server

The orchestrator server (`servers/orchestrator/`) provides multi-agent orchestration, allowing teams of AI agents to collaborate on complex goals using Crow's MCP tools.

Powered by the [open-multi-agent](https://github.com/kh0pper/open-multi-agent) engine, the orchestrator bridges Crow's existing tools (memory, projects, blog, sharing) into a shared tool registry that multiple agents can access simultaneously.

## How It Works

```
User Goal → Coordinator Agent → Task Decomposition
                                      ↓
                              Worker Agent Pool
                          (each with role-appropriate tools)
                                      ↓
                      Shared Memory + Tool Results
                                      ↓
                      Coordinator Synthesizes Output
```

1. You provide a **goal** (plain text) and select a **preset** (team configuration)
2. A **coordinator agent** decomposes the goal into tasks and assigns them to worker agents
3. Each **worker agent** has access to a curated set of Crow's MCP tools relevant to its role
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

### crow_list_remote_tools

List tools available on remote Crow instances. Shows connected instances and their exposed tools. No parameters.

## Presets

Presets define team configurations. Presets are provider-agnostic by default; the LLM provider is resolved from `CROW_ORCHESTRATOR_PROVIDER` env var or the first provider in `models.json`.

| Preset | Description | Agents |
|---|---|---|
| `research` | Research team with memory/project search and writing | researcher (18 tools), writer (no tools) |
| `memory_ops` | Memory analysis, consolidation, and organization | analyst (11 tools) |
| `full` | Broad team with research, memory writing, and synthesis | researcher (15 tools), memory_writer (4 tools), writer (no tools) |

Each agent's `tools` array lists the specific tools relevant to its role. The coordinator agent (auto-created by the engine) always gets `tools: []` so it only decomposes goals without calling tools.

### Adding a Preset

Add an entry to `servers/orchestrator/presets.js`:

```javascript
export const presets = {
  my_preset: {
    description: "What this team does",
    categories: ["memory", "projects"],  // which MCP servers to bridge
    agents: [
      {
        name: "worker",
        systemPrompt: "You are a specialized agent...",
        tools: ["crow_search_memories", "crow_list_memories", "crow_store_memory"],
        maxTurns: 6,
      },
    ],
  },
}
```

List the tools each agent actually needs for its role. Agents that should not call tools (writers, synthesizers) use `tools: []`.

### Per-Agent Provider Overrides

Individual agents can use different LLM providers within the same orchestration:

```javascript
{
  name: "researcher",
  provider: "zai",     // override default provider
  model: "glm-5",      // override default model
  tools: [...],
}
```

This enables hybrid orchestrations where some agents run on local models and others on cloud APIs.

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

## Remote Instance Tools

Presets can include `"remote"` in their `categories` array to access tools on connected remote Crow instances. Remote tools are registered with namespaced names like `colibri:ha_light_toggle`.

```javascript
{
  description: "Home automation with remote tools",
  categories: ["memory", "remote"],
  agents: [{
    name: "controller",
    tools: ["colibri:ha_light_toggle", "colibri:ha_status"],
    // or use wildcard: tools: ["colibri:*"]
  }],
}
```

The `"instance:*"` wildcard expands to all tools from that instance at orchestration time.

Remote tool connections come from the gateway's `connectedServers` map (populated by `proxy.js` from the `crow_instances` table). The orchestrator receives this via dependency injection, so it works in gateway mode but gracefully degrades in stdio mode (no remote tools available).

## LLM Configuration

The orchestrator reads `models.json` (same config file as Crow's main AI chat) to resolve provider endpoints. Configure via environment variables:

- `CROW_ORCHESTRATOR_PROVIDER` — default provider name (falls back to first provider in models.json)
- `CROW_ORCHESTRATOR_MODEL` — default model ID (falls back to first model from the resolved provider)

Key settings:
- `maxConcurrency` defaults to 1, configurable per preset
- `maxTokens` defaults to 8192, configurable per agent or preset
- 5-minute timeout on all orchestrations
- Health check on providers with a `baseURL` before starting (checks `/health` endpoint)
