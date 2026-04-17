/**
 * Multi-Agent Team Presets
 *
 * Each preset defines a team configuration for OpenMultiAgent.runTeam():
 *   - categories: which MCP servers to bridge into the shared ToolRegistry
 *   - agents: array of { name, systemPrompt, tools, maxTurns }
 *   - provider / model: optional overrides (defaults resolved from env or models.json)
 *
 * Tool filtering: each agent's `tools` array is a whitelist of tool names
 * from the shared ToolRegistry. List the tools relevant to each agent's role.
 * Use `tools: []` for agents that should not call tools (e.g., writers).
 */

export const presets = {
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

  // -- Phase 5-full new presets --

  code_team: {
    description: "Coding team: researcher gathers context via memory/projects, coder writes code",
    categories: ["memory", "projects"],
    provider: "crow-chat",
    agents: [
      {
        name: "researcher",
        provider: "crow-dispatch",
        systemPrompt:
          "You gather context for a coding task. Search memory, projects, and notes for " +
          "relevant code, decisions, and constraints. Report concisely; let the coder write the code.",
        tools: [
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_deep_recall",
          "crow_list_projects",
          "crow_search_sources",
          "crow_search_notes",
        ],
        maxTurns: 4,
      },
      {
        name: "coder",
        // On-demand agentic-coding specialist (Qwen3.6-35B-A3B, Apr 2026)
        provider: "crow-swap-agentic",
        systemPrompt:
          "You are a code specialist. Write clean, well-tested code following the project's " +
          "conventions. Reference memories/sources provided by the researcher. Output code " +
          "blocks with clear explanations of non-obvious choices.",
        tools: [],
        maxTurns: 6,
      },
    ],
  },

  vision_team: {
    description: "Vision team: VLM describes image content, synthesizer writes human-readable output",
    categories: ["memory"],
    provider: "crow-chat",
    agents: [
      {
        name: "viewer",
        // On-demand vision specialist (grackle-vision)
        provider: "grackle-vision",
        systemPrompt:
          "You describe images in detail. Extract text (OCR), identify objects, read charts, " +
          "and produce structured output when requested. Be precise — the synthesizer depends on you.",
        tools: [],
        maxTurns: 3,
      },
      {
        name: "synthesizer",
        provider: "crow-chat",
        systemPrompt:
          "Given the viewer's image description, write a clear, user-facing response. " +
          "Store notable findings via memory tools if asked.",
        tools: ["crow_store_memory", "crow_recall_by_context"],
        maxTurns: 3,
      },
    ],
  },

  deep_synthesis: {
    description: "Deep-reasoning synthesis: swap-deep model + RAG pass via memory embeddings",
    categories: ["memory", "projects"],
    // Retrieval agent uses fast dispatch for lookups; the synthesizer uses the
    // on-demand deep-reasoning slot (GLM-4.5-Air Q5_K_M MoE when available).
    provider: "crow-dispatch",
    agents: [
      {
        name: "retriever",
        provider: "crow-dispatch",
        systemPrompt:
          "You retrieve the most relevant memories and sources for the current goal using " +
          "semantic search. Use crow_search_memories (semantic=true) and crow_search_sources. " +
          "Return IDs and brief quotes; do not synthesize.",
        tools: [
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_deep_recall",
          "crow_search_sources",
          "crow_search_notes",
          "crow_get_source",
        ],
        maxTurns: 3,
      },
      {
        name: "deep_synthesizer",
        // On-demand deep-reasoning swap slot
        provider: "crow-swap-deep",
        systemPrompt:
          "You are a deep-reasoning synthesizer. Use the retriever's findings to produce a " +
          "thorough, well-reasoned response. Cite memory/source IDs. Think step-by-step.",
        tools: [],
        maxTurns: 8,
      },
    ],
  },
};
