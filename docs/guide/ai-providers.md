# Bring Your Own AI Provider (BYOAI)

Crow's built-in AI Chat lets you chat with any AI provider directly from the Crow's Nest dashboard. The AI has full access to your Crow tools — memory, projects, blog, storage, and sharing — so you can manage your data through natural conversation.

## How BYOAI Fits In

BYOAI is one of [three ways AI connects to Crow](/guide/integration-overview). External platforms (Claude.ai, ChatGPT, Cursor) connect via MCP and bring their own AI. BYOAI flips that: Crow's gateway acts as the AI client, calling the provider API on your behalf and dispatching tool calls internally.

This means BYOAI and external MCP connections share the same database. A memory stored from BYOAI Chat is instantly available in Claude.ai, and vice versa. If you also use [OpenClaw](/platforms/openclaw), the same applies — all three patterns read and write the same data.

## How It Works

Crow's MCP servers are **tool providers**. When you configure an AI provider, the Crow gateway acts as a bridge: it sends your messages to the AI, and when the AI wants to use Crow tools (search memories, create blog posts, etc.), the gateway executes those tool calls locally and feeds the results back.

This means:
- Your data stays on your machine
- The AI provider only sees the conversation and tool results
- You can switch providers anytime by changing a few env vars
- Works with free/cheap options like Ollama (fully local) or OpenRouter

## Quick Setup

### From the Crow's Nest (recommended)

1. Open the Crow's Nest → **Settings**
2. Find the **AI Provider** section
3. Select your provider from the dropdown
4. Enter your API key (not needed for Ollama)
5. Click **Save**, then **Test Connection**
6. Go to **Messages** → the **AI Chat** tab is now active

### From `.env`

Add these to your `.env` file (or `~/.crow/.env`):

```env
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-4o
```

No gateway restart needed — the config is hot-reloaded.

## Supported Providers

| Provider | `AI_PROVIDER` | Default Model | API Key Required | Notes |
|---|---|---|---|---|
| OpenAI | `openai` | `gpt-4o` | Yes | [Get key](https://platform.openai.com/api-keys) |
| Anthropic | `anthropic` | `claude-sonnet-4-20250514` | Yes | [Get key](https://console.anthropic.com/settings/keys) |
| Google Gemini | `google` | `gemini-2.5-flash` | Yes | [Get key](https://aistudio.google.com/app/apikey) |
| Ollama | `ollama` | `llama3.1` | No | Fully local, no API key needed |
| OpenRouter | `openrouter` | `openai/gpt-4o` | Yes | [Get key](https://openrouter.ai/keys) — access 100+ models |
| DashScope Coding | `openai` | `qwen3.5-plus` | Yes | [Get key](https://dashscope.console.aliyun.com/apiKey) — Qwen, GLM, Kimi, MiniMax ([guide](/guide/dashscope-coding)) |
| Z.AI Coding | `openai` | `glm-5` | Yes | [Get key](https://z.ai) — GLM models ([guide](/guide/zai-coding)) |

### OpenAI

```env
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-4o
```

Works with GPT-4o, GPT-4o-mini, o1, and any model available on the OpenAI API.

### Anthropic

```env
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-...
AI_MODEL=claude-sonnet-4-20250514
```

Works with Claude Opus, Sonnet, and Haiku models.

### Google Gemini

```env
AI_PROVIDER=google
AI_API_KEY=AIza...
AI_MODEL=gemini-2.5-flash
```

Uses the Gemini REST API. Works with Gemini 2.5 Flash, Gemini 2.5 Pro, and other available models. The free tier is generous for personal use.

### Ollama (Local)

```env
AI_PROVIDER=ollama
AI_MODEL=llama3.1
AI_BASE_URL=http://localhost:11434
```

Runs entirely on your machine — no API key, no data leaves your network. Install Ollama from [ollama.com](https://ollama.com) or use the Crow Ollama add-on (`crow bundle install ollama`).

::: warning Tool Calling with Ollama
Most local models have limited or no function/tool calling support. For best results with Crow tools, use models that support function calling: `llama3.1`, `mistral-nemo`, `qwen2.5`. Without tool support, the chat works but cannot access your Crow data.
:::

### OpenRouter

```env
AI_PROVIDER=openrouter
AI_API_KEY=sk-or-...
AI_MODEL=openai/gpt-4o
```

OpenRouter gives you access to 100+ models from multiple providers through a single API key. Great for trying different models without signing up for each provider separately. Many models have free tiers.

### DashScope Coding Plan (Alibaba Cloud)

```env
AI_PROVIDER=openai
AI_API_KEY=sk-sp-...
AI_MODEL=qwen3.5-plus
AI_BASE_URL=https://coding-intl.dashscope.aliyuncs.com/v1
```

The DashScope Coding Plan gives you access to models from Qwen, GLM, Kimi, and MiniMax through a single subscription. All models use the same API key and base URL — just change the model name. See the [DashScope Coding Plan guide](/guide/dashscope-coding) for full setup instructions and available models.

### Z.AI Coding Plan (Zhipu AI)

```env
AI_PROVIDER=openai
AI_API_KEY=your-zai-key
AI_MODEL=glm-5
AI_BASE_URL=https://api.z.ai/api/coding/paas/v4
```

The Z.AI Coding Plan provides access to the GLM model family (GLM-5, GLM-4.7, and more) through a monthly subscription. See the [Z.AI Coding Plan guide](/guide/zai-coding) for full setup instructions and available models.

### Custom OpenAI-Compatible Endpoint

Any API that implements the OpenAI Chat Completions format works with the `openai` provider and a custom base URL:

```env
AI_PROVIDER=openai
AI_API_KEY=your-key
AI_MODEL=your-model
AI_BASE_URL=https://your-endpoint.com/v1
```

This works with vLLM, LM Studio, text-generation-webui, and other OpenAI-compatible servers.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | Yes | Provider name: `openai`, `anthropic`, `google`, `ollama`, `openrouter` |
| `AI_API_KEY` | Depends | API key (not needed for Ollama) |
| `AI_MODEL` | No | Model name (uses provider default if blank) |
| `AI_BASE_URL` | No | Custom API endpoint (for Ollama, OpenRouter, or self-hosted) |

## Using AI Chat

Once configured, open **Messages** in the Crow's Nest. The **AI Chat** tab appears with:

- **Conversation sidebar** — Create, switch between, and delete conversations
- **Chat area** — Send messages, see streaming responses
- **Tool calls** — Expandable cards showing when the AI uses your Crow tools
- **Cancel** — Stop a generation in progress

The AI sees your Crow tools as 7 category tools (`crow_memory`, `crow_projects`, `crow_blog`, `crow_sharing`, `crow_storage`, `crow_tools`, `crow_discover`). It can:

- Recall your memories and store new ones
- Search and manage research projects
- Create and publish blog posts
- Upload and manage files
- Send messages to contacts
- Discover available tools and their schemas

### Conversation Context

Each conversation sends the system prompt (generated from your crow.md context) plus the last 20 messages to the AI. Tool results are truncated to 2000 characters to prevent context overflow. The AI can make up to 10 tool call rounds per message.

### Token Tracking

Total tokens are tracked per conversation and displayed in the sidebar. This helps you monitor API usage costs.

## AI Chat vs External Platforms

You don't have to choose — they work together:

| Feature | AI Chat (BYOAI) | External Platforms (Claude.ai, ChatGPT, etc.) |
|---|---|---|
| **Setup** | Configure API key in Settings | Install Crow MCP servers on the platform |
| **Interface** | Crow's Nest dashboard | Platform's native UI |
| **AI provider** | Your choice (any supported provider) | Platform's built-in AI |
| **Tool access** | Full (all Crow tools via gateway) | Full (all Crow tools via MCP) |
| **Data sharing** | Same database — both see the same memories | Same database |
| **Best for** | Quick interactions from the dashboard, free/cheap AI | Deep work, platform-specific features |

## Security

- API keys are stored in plaintext in your `.env` file on your device
- The Crow's Nest is private by default (local network / Tailscale only)
- Chat conversations are stored in your local SQLite database
- Messages are sent to your chosen AI provider's API — they leave your machine
- For fully local operation, use Ollama — nothing leaves your network

## Semantic Search (Opt-in)

When an AI provider with embedding support is configured, Crow can enhance memory search with **semantic search** — finding memories based on meaning, not just keywords.

### Requirements

- An AI provider that supports embeddings (OpenAI, Ollama with nomic-embed-text, or Google)
- The `sqlite-vec` SQLite extension installed on your system
- Both are optional — Crow falls back to full-text search (FTS5) when either is missing

### How it works

1. When you store a memory, Crow generates an embedding vector from the content
2. The vector is stored in a `memory_embeddings` virtual table (powered by `sqlite-vec`)
3. When you search with `semantic: true`, Crow compares your query's embedding against stored vectors
4. Results from semantic and keyword search are merged for the best of both approaches

### Installing sqlite-vec

On Debian/Ubuntu:
```bash
sudo apt install sqlite3-vec
```

Or install from source: [sqlite-vec on GitHub](https://github.com/asg017/sqlite-vec)

After installing, run `npm run init-db` to create the vector table.

## LocalAI Bundle

For fully local AI (including embeddings), install the **LocalAI** bundle:

```
crow bundle install localai
crow bundle start localai
```

Then configure Crow to use it:
```env
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:8080/v1
AI_MODEL=gpt-3.5-turbo
```

LocalAI provides an OpenAI-compatible API running entirely on your hardware — no data leaves your network.

## Troubleshooting

### "No AI provider configured"
Set `AI_PROVIDER` in Settings or `.env`. At minimum you need the provider name.

### "API key is invalid (401)"
Double-check your `AI_API_KEY`. For Anthropic, keys start with `sk-ant-`. For OpenAI, `sk-`. For Google, `AIza`.

### "Model not found (404)"
The model name is provider-specific. Check the provider's docs for available models. For Ollama, run `ollama pull <model>` first.

### "Rate limited"
The provider is throttling requests. Wait a moment and try again, or upgrade your API plan.

### Tool calls not working
Some models (especially small local models via Ollama) don't support function/tool calling. Try a model that explicitly supports it: `llama3.1`, `gpt-4o`, `claude-sonnet-4-20250514`, `gemini-2.5-flash`.

### Chat input not responding
Check the browser console for errors. The chat uses Server-Sent Events (SSE) for streaming — ensure your network/proxy doesn't buffer or terminate SSE connections.
