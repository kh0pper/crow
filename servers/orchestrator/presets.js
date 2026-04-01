/**
 * Multi-Agent Team Presets
 *
 * Each preset defines a team configuration for OpenMultiAgent.runTeam():
 *   - provider / model: which LLM backend to use (resolved from models.json)
 *   - agents: array of { name, systemPrompt, tools, maxTurns }
 *
 * Tool filtering: each agent's `tools` array is a whitelist of tool names
 * from the shared ToolRegistry.  Keep to ~10 tools per agent max to fit
 * within 16K context windows (local models).
 */

export const presets = {
  research: {
    description: "Research team: one agent searches memories/projects, another synthesizes findings",
    categories: ["memory", "projects"],
    provider: "local",
    model: "opus-reasoning-35b",
    agents: [
      {
        name: "researcher",
        systemPrompt:
          "You are a research assistant with access to a persistent memory system and project database. " +
          "Search thoroughly, cross-reference findings, and report what you discover with specific details. " +
          "Always cite memory IDs or source IDs when referencing stored information.",
        tools: [
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_list_memories",
          "crow_memory_stats",
          "crow_search_sources",
          "crow_list_sources",
          "crow_search_notes",
          "crow_list_projects",
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

  research_cloud: {
    description: "Research team using cloud LLM (z.ai GLM-5)",
    categories: ["memory", "projects"],
    provider: "zai",
    model: "glm-5",
    agents: [
      {
        name: "researcher",
        systemPrompt:
          "You are a research assistant with access to a persistent memory system and project database. " +
          "Search thoroughly, cross-reference findings, and report what you discover with specific details.",
        tools: [
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_list_memories",
          "crow_memory_stats",
          "crow_search_sources",
          "crow_list_sources",
          "crow_search_notes",
          "crow_list_projects",
        ],
        maxTurns: 6,
      },
      {
        name: "writer",
        systemPrompt:
          "You are a technical writer. Synthesize research findings into clear, well-organized text.",
        tools: [],
        maxTurns: 3,
      },
    ],
  },

  memory_ops: {
    description: "Memory operations: search, consolidate, and organize memories",
    categories: ["memory"],
    provider: "local",
    model: "opus-reasoning-35b",
    agents: [
      {
        name: "analyst",
        systemPrompt:
          "You are a memory analyst. Search and review stored memories to find patterns, " +
          "duplicates, and connections. You can also store new consolidated memories and " +
          "update existing ones. Report your findings clearly.",
        tools: [
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_list_memories",
          "crow_memory_stats",
          "crow_store_memory",
          "crow_update_memory",
        ],
        maxTurns: 8,
      },
    ],
  },

  full: {
    description: "Full team: planner, researcher, and writer with broad tool access",
    categories: ["memory", "projects", "blog"],
    provider: "local",
    model: "opus-reasoning-35b",
    agents: [
      {
        name: "researcher",
        systemPrompt:
          "You are a research agent. Search memories, projects, sources, and notes to gather information. " +
          "Be thorough and report findings with references.",
        tools: [
          "crow_search_memories",
          "crow_recall_by_context",
          "crow_list_memories",
          "crow_search_sources",
          "crow_list_sources",
          "crow_search_notes",
          "crow_list_projects",
          "crow_get_source",
          "crow_project_stats",
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
        ],
        maxTurns: 4,
      },
      {
        name: "writer",
        systemPrompt:
          "You are a technical writer. Synthesize all research and findings into a clear, " +
          "comprehensive response. Do not call tools — focus on writing.",
        tools: [],
        maxTurns: 3,
      },
    ],
  },
};
