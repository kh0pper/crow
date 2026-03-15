# DashScope Coding Plan (Alibaba Cloud)

The [Alibaba Cloud DashScope Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan-quickstart) is a monthly subscription that gives you access to multiple AI models from different providers through a single API key. It includes models from Qwen, Zhipu (GLM), Kimi, and MiniMax — all accessible through an OpenAI-compatible API.

## Why DashScope?

- **Multi-model access** — One subscription covers Qwen, GLM, Kimi, and MiniMax models
- **OpenAI-compatible** — Works with any tool that supports the OpenAI Chat Completions API
- **International endpoint** — Singapore-based endpoint for global access
- **Affordable** — Subscription pricing instead of per-token billing

## Available Models

| Model | Provider | Capabilities |
|-------|----------|-------------|
| `qwen3.5-plus` | Qwen | Text generation, deep thinking, visual understanding |
| `qwen3-max-2026-01-23` | Qwen | Text generation, deep thinking |
| `qwen3-coder-next` | Qwen | Text generation (code-focused) |
| `qwen3-coder-plus` | Qwen | Text generation (code-focused) |
| `glm-5` | Zhipu | Text generation, deep thinking |
| `glm-4.7` | Zhipu | Text generation, deep thinking |
| `kimi-k2.5` | Kimi | Text generation, deep thinking, visual understanding |
| `MiniMax-M2.5` | MiniMax | Text generation, deep thinking |

::: tip Model Selection
For general use, start with `qwen3.5-plus` — it's the most capable all-around model. For coding tasks, try `qwen3-coder-next`. For deep reasoning, `glm-5` and `kimi-k2.5` are strong options.
:::

## Quick Setup

### Step 1: Get Your API Key

1. Go to the [DashScope API Key page](https://dashscope.console.aliyun.com/apiKey)
2. Click **Create API Key**
3. Select your account and the default workspace
4. Copy the key (it starts with `sk-sp-`)

::: warning Coding Plan Keys
Coding Plan keys start with `sk-sp-` and use a different endpoint than standard DashScope keys (`sk-`). Don't mix them up — they are not interchangeable.
:::

### Step 2: Configure in Crow's Nest

1. Open your Crow's Nest → **Settings**
2. Find the **AI Provider** section
3. Set:
   - **Provider:** OpenAI (DashScope uses an OpenAI-compatible API)
   - **API Key:** Your `sk-sp-...` key
   - **Model:** `qwen3.5-plus` (or any model from the table above)
   - **Base URL:** `https://coding-intl.dashscope.aliyuncs.com/v1`
4. Click **Save**, then **Test Connection**
5. Go to **Messages** → the **AI Chat** tab is now active

### Alternative: `.env` Configuration

```env
AI_PROVIDER=openai
AI_API_KEY=sk-sp-your-key-here
AI_MODEL=qwen3.5-plus
AI_BASE_URL=https://coding-intl.dashscope.aliyuncs.com/v1
```

No gateway restart needed — the config is hot-reloaded.

## Switching Models

To switch models, update `AI_MODEL` in Settings or `.env` to any model from the table above. All models use the same API key and base URL — only the model name changes.

## Endpoint Reference

| Purpose | URL |
|---------|-----|
| OpenAI-compatible (Coding Plan) | `https://coding-intl.dashscope.aliyuncs.com/v1` |
| Anthropic-compatible (Coding Plan) | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` |
| Standard DashScope (pay-as-you-go) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |

::: warning
The **Coding Plan** endpoint (`coding-intl.dashscope.aliyuncs.com`) is different from the standard **pay-as-you-go** endpoint (`dashscope-intl.aliyuncs.com`). Use the correct one for your subscription type.
:::

## Troubleshooting

### "API key is invalid (401)"
Make sure you're using a Coding Plan key (`sk-sp-...`) with the Coding Plan endpoint. Standard DashScope keys don't work with the Coding Plan endpoint and vice versa.

### "Model not found (404)"
Check the model name matches exactly (case-sensitive). The available models depend on your subscription tier.

### "Rate limited (429)"
The Coding Plan has usage quotas. Check your [DashScope console](https://dashscope.console.aliyun.com) for current usage and limits.

### Tool calls not working
Most DashScope models support function/tool calling. If tools aren't working, try `qwen3.5-plus` or `qwen3-coder-next` which have the strongest tool calling support.

## Resources

- [Coding Plan Quickstart](https://www.alibabacloud.com/help/en/model-studio/coding-plan-quickstart)
- [DashScope API Key Management](https://dashscope.console.aliyun.com/apiKey)
- [OpenAI Compatibility Reference](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)
- [Model Studio Documentation](https://www.alibabacloud.com/help/en/model-studio/)
