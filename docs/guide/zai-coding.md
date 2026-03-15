# Z.AI Coding Plan (Zhipu AI)

The [Z.AI Coding Plan](https://docs.z.ai/guides/overview/quick-start) is a monthly subscription from Zhipu AI that gives you access to GLM models through an OpenAI-compatible API. GLM models are strong at text generation, deep thinking, and code — and the coding plan provides flat-rate access for use with AI coding tools.

## Why Z.AI?

- **GLM model family** — Access to GLM-5, GLM-4.7, and other variants
- **OpenAI-compatible** — Works with any tool that supports the OpenAI Chat Completions API
- **International endpoint** — Global access via `api.z.ai`
- **Coding-optimized** — Subscription designed for coding tool integration

## Available Models

| Model | Capabilities |
|-------|-------------|
| `glm-5` | Text generation, deep thinking |
| `glm-4.7` | Text generation, deep thinking |
| `glm-4.7-flash` | Fast text generation |
| `glm-4.7-flashx` | Fast text generation |
| `glm-4.6` | Text generation |
| `glm-4.6v` | Text generation, visual understanding |
| `glm-4.5` | Text generation |
| `glm-4.5-air` | Lightweight text generation |
| `glm-4.5-flash` | Fast text generation |
| `glm-4.5v` | Text generation, visual understanding |

::: tip Model Selection
For general use, start with `glm-5` — it's the most capable model. For faster responses, try `glm-4.7-flash`. Models ending in `v` support visual understanding (image input).
:::

## Quick Setup

### Step 1: Get Your API Key

1. Go to [Z.AI](https://z.ai) and sign in
2. Navigate to your API key management page
3. Create a new API key
4. Copy the key (format: `hexstring.Base64string`)

### Step 2: Configure in Crow's Nest

1. Open your Crow's Nest → **Settings**
2. Find the **AI Provider** section
3. Set:
   - **Provider:** OpenAI (Z.AI uses an OpenAI-compatible API)
   - **API Key:** Your Z.AI key
   - **Model:** `glm-5` (or any model from the table above)
   - **Base URL:** `https://api.z.ai/api/coding/paas/v4`
4. Click **Save**, then **Test Connection**
5. Go to **Messages** → the **AI Chat** tab is now active

### Alternative: `.env` Configuration

```env
AI_PROVIDER=openai
AI_API_KEY=your-zai-key-here
AI_MODEL=glm-5
AI_BASE_URL=https://api.z.ai/api/coding/paas/v4
```

No gateway restart needed — the config is hot-reloaded.

## Switching Models

To switch models, update `AI_MODEL` in Settings or `.env` to any model from the table above. All models use the same API key and base URL — only the model name changes.

## Endpoint Reference

| Purpose | URL |
|---------|-----|
| Coding Plan (international) | `https://api.z.ai/api/coding/paas/v4` |
| Standard API (international) | `https://api.z.ai/api/paas/v4` |
| Standard API (China mainland) | `https://open.bigmodel.cn/api/paas/v4` |

::: warning
The **Coding Plan** endpoint (`/api/coding/paas/v4`) is different from the standard API endpoint (`/api/paas/v4`). Use the correct one for your subscription type.
:::

## Troubleshooting

### "API key is invalid (401)"
Make sure you're using a Coding Plan key with the Coding Plan endpoint. Standard API keys don't work with the Coding Plan endpoint and vice versa.

### "Model not found (404)"
Check the model name matches exactly (case-sensitive). The available models depend on your subscription tier.

### Tool calls not working
GLM models generally support function/tool calling. If tools aren't working, try `glm-5` which has the strongest tool calling support.

## Resources

- [Z.AI Quick Start](https://docs.z.ai/guides/overview/quick-start)
- [Z.AI API Key Configuration](https://zcode.z.ai/docs/configuration)
- [Z.AI Model Documentation](https://z.ai/model-api)
