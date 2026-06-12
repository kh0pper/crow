// -- Phase 5-full new presets --

export const teamPresets = {
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
        // Purpose-built coder specialist (Qwen3-coder-30B-A3B MoE). Apr 2026:
        // was crow-swap-agentic; retired when crow-chat itself became the
        // Qwen3.6-35B-A3B MoE and crow-swap-agentic collapsed into crow-chat.
        provider: "crow-swap-coder",
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
        // Explicit annotation consumed by compat.js / role-shape.js. Intentionally
        // set on this agent only — the synthesizer's prompt mentions "image
        // description" but it processes text output, not raw images.
        needs_vision: true,
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
