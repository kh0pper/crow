# Orchestrator (Agent Teams)

Run teams of AI agents that collaborate on a goal using your Crow data — searching memories, reading projects, writing summaries — and schedule recurring jobs that keep your knowledge base tidy while you sleep.

## What is this?

The orchestrator turns a single request into a coordinated team effort. You give it a goal in plain language; a coordinator agent breaks it into tasks and hands them to worker agents, each equipped with just the Crow tools its role needs. The team shares findings and the coordinator synthesizes a final answer.

## Why would I want this?

- **Multi-step research** — one agent digs through your memories and project sources while another writes up what it finds
- **Recurring maintenance** — a nightly pipeline finds duplicate or conflicting memories so your recall stays sharp
- **Scheduled digests** — a daily summary of activity, or a weekly review of all active projects, delivered as a memory without you asking

## Running a Team

Ask your AI client to orchestrate — it uses the `crow_orchestrate` tool behind the scenes:

```
"Orchestrate a research team on: what do my notes say about FERPA compliance?"
```

The run starts in the background and returns a job ID. Ask for status anytime:

```
"Check on that orchestration"
→ crow_orchestrate_status({ jobId: "..." })
```

### Choosing a Team Preset

Presets are ready-made team configurations. Ask "list the orchestrator presets" (`crow_list_presets`) to see everything available on your instance. The general-purpose ones:

| Preset | What it does |
|---|---|
| `research` | One agent searches memories and projects, another synthesizes the findings |
| `memory_ops` | A single analyst searches, consolidates, and organizes memories |
| `full` | Researcher + memory writer + synthesizer with broad tool access |
| `code_team`, `vision_team`, `deep_synthesis` | Specialized teams for code, image, and deep-synthesis work |

Additional presets power Bot Builder bots and instance-specific workflows — they appear in the list too, but you'll rarely call them directly.

## Pipelines: Scheduled Team Runs

Pipelines are predefined goal + preset combinations that can run on a schedule. The built-ins:

| Pipeline | Default Schedule | What it does |
|---|---|---|
| `memory-consolidation` | Daily at 3am | Finds duplicate and conflicting memories |
| `daily-summary` | Daily at 10pm | Summarizes the day's activity |
| `research-digest` | Weekly, Monday 9am | Reviews all active projects |

Run one immediately, or put it on the calendar — both in plain language:

```
"Run the memory consolidation pipeline now"
→ crow_run_pipeline({ pipeline: "memory-consolidation" })

"Schedule the daily summary"
→ crow_schedule_pipeline({ pipeline: "daily-summary" })

"Run memory consolidation every Sunday at 2am"
→ crow_schedule_pipeline({ pipeline: "memory-consolidation", cron_expression: "0 2 * * 0" })
```

Pipeline results are stored as Crow memories (tagged `pipeline,automated`), so the output lands in the same searchable knowledge base as everything else.

## Watching It Work

Open **Orchestrator** in the Crow's Nest dashboard for a live timeline of every run: which agents dispatched, which model each used, token counts, durations, and any errors. It's the layer-down view — you don't need it for orchestration to work, but it's there when you're curious what actually happened.

## Which Model Does It Use?

By default, the same provider configuration as Crow's AI chat (`models.json`). Two environment variables override the default for orchestration: `CROW_ORCHESTRATOR_PROVIDER` and `CROW_ORCHESTRATOR_MODEL`. Individual agents inside a preset can pin their own provider/model, so a team can mix local and cloud models in one run.

## Next Steps

- [Orchestrator architecture](/architecture/orchestrator) — presets, the MCP bridge, remote-instance tools, and internals
- [Scheduling guide](/guide/scheduling) — how Crow's schedules work in general
- [Context & Performance](/guide/context-performance) — how the orchestrator's tools fit your AI's context budget
