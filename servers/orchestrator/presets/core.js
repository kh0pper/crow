// Core orchestration presets — research, memory_ops, full, briefing, briefing-bidirectional.
export const corePresets = {
  research: {
    description: "Research team: one agent searches memories/projects, another synthesizes findings",
    categories: ["memory", "projects"],
    // Default provider for all agents; agents can override individually.
    provider: "crow-chat",
    agents: [
      {
        name: "researcher",
        // Researcher does many tool calls → prefer fast dispatch model
        provider: "crow-dispatch",
        systemPrompt:
          "You are a research assistant with access to a persistent memory system and project database. " +
          "Search thoroughly, cross-reference findings, and report what you discover with specific details. " +
          "Always cite memory IDs or source IDs when referencing stored information.",
        tools: [
          // Memory read
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_deep_recall",
          "crow_list_memories",
          "crow_memory_stats",
          // Projects read
          "crow_list_projects",
          "crow_search_sources",
          "crow_get_source",
          "crow_list_sources",
          "crow_verify_source",
          "crow_search_notes",
          "crow_generate_bibliography",
          "crow_project_stats",
          "crow_list_backends",
          "crow_backend_schema",
          // Memory write (for storing findings)
          "crow_store_memory",
          "crow_update_memory",
          "crow_add_note",
        ],
        maxTurns: 6,
      },
      {
        name: "writer",
        systemPrompt:
          "You are a technical writer. Synthesize research findings into clear, well-organized text. " +
          "Do not search for information yourself — rely on what the researcher has provided. " +
          "Focus on clarity, accuracy, and logical structure.",
        tools: [],
        maxTurns: 3,
      },
    ],
  },

  memory_ops: {
    description: "Memory operations: search, consolidate, and organize memories",
    categories: ["memory"],
    provider: "crow-chat",
    agents: [
      {
        name: "analyst",
        systemPrompt:
          "You are a memory analyst. Search and review stored memories to find patterns, " +
          "duplicates, and connections. You can also store new consolidated memories and " +
          "update existing ones. Report your findings clearly.",
        tools: [
          // Read
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_deep_recall",
          "crow_list_memories",
          "crow_memory_stats",
          "crow_dream",
          // Write
          "crow_store_memory",
          "crow_update_memory",
          "crow_delete_memory",
          // Context (read-only)
          "crow_get_context",
          "crow_list_context_sections",
        ],
        maxTurns: 8,
      },
    ],
  },

  full: {
    description: "Full team: researcher, memory writer, and synthesizer with broad tool access",
    categories: ["memory", "projects"],
    provider: "crow-chat",
    agents: [
      {
        name: "researcher",
        // Tool-heavy researcher → fast dispatch model
        provider: "crow-dispatch",
        systemPrompt:
          "You are a research agent. Search memories, projects, sources, and notes to gather information. " +
          "Be thorough and report findings with references. Do not store or modify data.",
        tools: [
          // Memory read
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_deep_recall",
          "crow_list_memories",
          "crow_memory_stats",
          // Projects read
          "crow_list_projects",
          "crow_search_sources",
          "crow_get_source",
          "crow_list_sources",
          "crow_verify_source",
          "crow_search_notes",
          "crow_generate_bibliography",
          "crow_project_stats",
          "crow_list_backends",
          "crow_backend_schema",
        ],
        maxTurns: 6,
      },
      {
        name: "memory_writer",
        systemPrompt:
          "You are responsible for storing findings and results into the memory system. " +
          "When asked to persist information, store it with appropriate categories and tags.",
        tools: [
          "crow_store_memory",
          "crow_update_memory",
          "crow_add_note",
          "crow_create_notification",
        ],
        maxTurns: 4,
      },
      {
        name: "writer",
        // Writer does synthesis — mid-tier reasoning
        provider: "crow-chat",
        systemPrompt:
          "You are a technical writer. Synthesize all research and findings into a clear, " +
          "comprehensive response. Do not call tools — focus on writing.",
        tools: [],
        maxTurns: 3,
      },
    ],
  },

  briefing: {
    description:
      "Single-agent briefing worker. Runs on crow-chat end-to-end so it never blocks on mutex-group GPU swaps the gpu-orchestrator cannot currently perform cross-machine. Deliberately one agent instead of a coordinator+workers team — empirically the coordinator dispatches the first step and then synthesizes the rest itself, so multi-step tool calls get described in prose but never fired. Categories include `addons` so the tasks_* + google-workspace tools from the tasks bundle / google-workspace addon are bridged into the registry.",
    categories: ["memory", "addons"],
    provider: "crow-chat",
    agents: [
      {
        name: "briefer",
        systemPrompt:
          "You are the daily-briefing worker. Execute the goal exactly, calling the listed tools in " +
          "order. You MUST invoke every tool call the goal specifies — do not merely describe what " +
          "you would do. After calling tasks_store_briefing, you MUST call crow_create_notification " +
          "with the returned briefing id. Your final text output should confirm the tools you " +
          "called and include the briefing id returned by tasks_store_briefing.",
        tools: [
          "tasks_briefing_snapshot",
          "tasks_store_briefing",
          "tasks_list",
          "gcal_list_events",
          "gmail_search_threads",
          "crow_search_memories",
          "crow_store_memory",
          "crow_create_notification",
        ],
        maxTurns: 12,
      },
    ],
  },

  // Phase 4 (2026-05-16) — dedicated clone of `briefing` that ALSO opens a
  // replyable +bot digest thread (gmail_send_to_self). Used ONLY by
  // mpa-daily-briefing + mpa-deadline-watcher; shared `briefing` (and
  // mpa-weekly-retro, which uses it) stays untouched (rev 8).
  "briefing-bidirectional": {
    description:
      "Like `briefing` but also SENDS the digest to Kevin's inbox via gmail_send_to_self with Reply-To kevin.hopper+bot@maestro.press, so a plain-English reply round-trips through the router into mpa-tasks. Single-agent crow-chat. Used only by mpa-daily-briefing + mpa-deadline-watcher.",
    categories: ["memory", "addons"],
    provider: "crow-chat",
    agents: [
      {
        name: "briefer",
        systemPrompt:
          "You are the daily-briefing worker. Execute the goal exactly, calling the listed tools in " +
          "order. You MUST invoke every tool call the goal specifies — do not merely describe what " +
          "you would do. After calling tasks_store_briefing, you MUST call crow_create_notification " +
          "with the returned briefing id, and then the gmail_send_to_self digest call the goal " +
          "specifies. Your final text output should confirm the tools you called and include the " +
          "briefing id returned by tasks_store_briefing.",
        tools: [
          "tasks_briefing_snapshot",
          "tasks_store_briefing",
          "tasks_list",
          "gcal_list_events",
          "gmail_search_threads",
          "gmail_send_to_self",
          "crow_search_memories",
          "crow_store_memory",
          "crow_create_notification",
        ],
        maxTurns: 18,
      },
    ],
  },
};
