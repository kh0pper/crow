# Free Cloud AI Options

Crow's setup wizard offers three ways to configure the AI that powers **BYOAI Chat** (the Messages → AI Chat tab in the Crow's Nest dashboard): download a local model, paste a cloud provider's API key, or skip AI setup for now. This page covers the second option — pasting a key from a cloud provider — and what it actually costs.

If you'd rather run everything locally with no API key and no data leaving your machine, see the wizard's local-download path instead, or the [Bring Your Own AI Provider guide](/guide/ai-providers) for the full local-model picture (including Ollama).

## What the Wizard's Cloud Option Does

When you choose "paste a key" in the setup wizard's AI step, you pick one of five curated providers, paste an API key you generate on that provider's own website, and the wizard writes it straight into Crow's `providers` table — no `.env` editing needed. These five match exactly what ships in the wizard (`servers/gateway/dashboard/panels/onboarding/cloud-presets.js`); Crow supports additional providers (Ollama, Meta AI, DashScope, Z.AI) too, but those aren't in the quick-setup wizard — see the [BYOAI guide](/guide/ai-providers) for the full list and manual `.env` setup.

::: warning Facts below checked 2026-07
Free-tier terms, credit amounts, and rate limits change frequently and are entirely at each provider's discretion — Crow has no control over them and doesn't track changes automatically. Everything below was verified as of **July 2026**; treat it as a starting point, not a guarantee, and check the provider's own pricing page before relying on a "free" tier for anything real. If something here is stale, the provider's pricing page is always the source of truth.
:::

## OpenAI

- **Sign up**: [platform.openai.com](https://platform.openai.com/signup)
- **Get your key**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys) (Dashboard → API keys)
- **Free tier (checked 2026-07)**: Not reliable. OpenAI's automatic new-account trial credit has been inconsistent since mid-2025 — some new accounts still receive a small one-time credit, many don't. Treat OpenAI as a paid-only option: add a payment method on [platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing) before expecting the API to work. Default model in the wizard: `gpt-4o-mini` (edit it in the form if you want a different one).

## Anthropic

- **Sign up**: [console.anthropic.com](https://console.anthropic.com)
- **Get your key**: [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
- **Free tier (checked 2026-07)**: New Console accounts get a small one-time free-credit trial after SMS phone verification. It's small and time-limited (the claim window and expiry are both short — claim it and start using it the same day you create the account, don't wait), useful for testing but not for ongoing use. Anthropic also runs a startup credits program for qualifying companies, separate from this per-account trial. Default model in the wizard: `claude-sonnet-5`.

## Google AI Studio

- **Sign up**: [aistudio.google.com](https://aistudio.google.com) (sign in with any Google account — no separate signup)
- **Get your key**: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) ("Get API key" button)
- **Free tier (checked 2026-07)**: Yes — Google AI Studio itself is free to use, and API keys generated there include a genuine free tier of the Gemini API (currently Flash and Flash-Lite model variants; Pro-tier models were pulled from the free tier earlier in 2026). It's rate-limited (requests per minute and per day, both fairly low) rather than credit-limited, and free-tier traffic may be used by Google to improve their models — if that matters to you, that's a paid-tier-only guarantee. Default model in the wizard: `gemini-2.5-flash`.

## Groq

- **Sign up**: [console.groq.com](https://console.groq.com)
- **Get your key**: [console.groq.com/keys](https://console.groq.com/keys)
- **Free tier (checked 2026-07)**: Yes, and it's the most generous of the five — a genuinely free, no-credit-card developer tier gated only by rate limits (requests/minute, tokens/minute, requests/day), not a spending credit that runs out. Individual models vary in their exact limits. Adding a payment method raises the limits and unlocks a discount, but isn't required to use the free tier indefinitely. Default model in the wizard: `llama-3.3-70b-versatile`.

## OpenRouter

- **Sign up**: [openrouter.ai](https://openrouter.ai)
- **Get your key**: [openrouter.ai/keys](https://openrouter.ai/keys)
- **Free tier (checked 2026-07)**: Yes — OpenRouter offers a rotating set of models with a `:free` suffix at zero cost per token, no credit card required. Daily request limits are low until you've purchased at least $10 in credits at some point (after which the free-model daily limit rises substantially), and the specific free models available change over time — check [openrouter.ai/models](https://openrouter.ai/models) (filter by price) for what's currently free before picking a default. Default model in the wizard is `openrouter/auto` (an auto-router that picks a suitable model per request, not pinned to the free tier — swap it for a specific `:free`-suffixed model in the wizard's model field if you want to guarantee zero cost).

## Which One Should I Pick?

- **Just want something free and working today, no credit card**: Groq or OpenRouter.
- **Want the best free-tier reasoning/coding quality**: Google AI Studio (Gemini Flash) is a strong, genuinely free option.
- **Already have credits or a subscription elsewhere** (e.g. you pay for Claude or ChatGPT already): Anthropic or OpenAI make sense once you've added billing, even though the API is billed separately from a consumer subscription.
- **Not sure / just exploring**: pick Groq or Google — both work with zero setup cost, so you can switch to a different provider later with no sunk cost. Switching later is just re-running the wizard's AI step or editing the provider in Settings → AI Provider.

## Where Keys Are Stored

Whichever provider you paste a key for, Crow stores it in the local `providers` table in your Crow's Nest database (`~/.crow/data/crow.db` by default) — it never leaves your machine except in requests to that provider's own API. See the [BYOAI guide's Security section](/guide/ai-providers#security) for the full picture, and Settings → AI Provider in the dashboard to change or remove a key later.
