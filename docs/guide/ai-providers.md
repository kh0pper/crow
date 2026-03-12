# Bring Your Own AI Provider (BYOAI)

Crow's MCP servers are **tool providers** — they don't call AI APIs themselves. However, future features (smart search, auto-summarization, Crow Chat bridge) may benefit from AI-assisted processing. This page documents the planned provider adapter interface.

## Current State

Today, Crow works with any MCP-compatible AI client. The AI provider is determined by which platform you connect from:

- Claude (via claude.ai, Claude Code, or Claude Desktop)
- ChatGPT (via ChatGPT Plus)
- Gemini (via Gemini CLI or Google AI Studio)
- Grok (via xAI)
- Cursor, Windsurf, Cline (via their built-in AI)
- Qwen Coder CLI (via Qwen models)

No configuration needed — Crow doesn't care which AI is calling its tools.

## When BYOAI Would Apply

BYOAI configuration would be needed when Crow itself needs to call an AI API, such as:

- **Smart search**: AI-powered semantic search over memories and projects
- **Auto-summarization**: Summarizing long sources or conversations
- **Crow Chat bridge**: Using Crow's gateway as a unified chat interface powered by your preferred LLM
- **Content classification**: Auto-categorizing memories or sources

These features are not yet implemented. When they are, the provider adapter interface below will be used.

## Planned Interface

### Environment Variables

```env
# AI Provider Configuration
AI_PROVIDER=anthropic          # anthropic, openai, google, ollama, custom
AI_API_KEY=sk-...              # API key for the chosen provider
AI_MODEL=claude-sonnet-4-5-20250514   # Model to use (provider-specific)
AI_BASE_URL=                   # Custom API endpoint (optional, for self-hosted)
```

### Provider Adapters

Each provider adapter implements a common interface:

```javascript
// servers/gateway/ai-provider.js (planned)
export function createProvider(config) {
  // Returns { complete(prompt, options), embed(text), summarize(text) }
}
```

| Provider | `AI_PROVIDER` value | Notes |
|---|---|---|
| Anthropic | `anthropic` | Claude models via Messages API |
| OpenAI | `openai` | GPT models via Chat Completions API |
| Google | `google` | Gemini models via Generative Language API |
| Ollama | `ollama` | Local models, uses `OLLAMA_HOST` from add-on |
| Custom | `custom` | Any OpenAI-compatible API via `AI_BASE_URL` |

### Ollama Integration

If the Ollama add-on is installed, it can serve as the BYOAI provider for on-device AI processing:

```env
AI_PROVIDER=ollama
AI_MODEL=llama3.2
# AI_BASE_URL defaults to OLLAMA_HOST
```

This keeps all data local — useful for privacy-sensitive deployments.

## Design Principles

1. **Optional**: BYOAI is never required. Crow works fully without it.
2. **Local-first**: Prefer Ollama when available for privacy.
3. **Provider-agnostic**: The adapter interface is the same regardless of provider.
4. **Lazy loading**: Provider adapters are only loaded when a feature needs them.
5. **No vendor lock-in**: Switching providers should require only changing env vars.
