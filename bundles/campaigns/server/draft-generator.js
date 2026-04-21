/**
 * Crow Campaigns — AI Draft Generator
 *
 * Generates subreddit-tailored post drafts using the configured BYOAI provider.
 * Reads AI_PROVIDER, AI_API_KEY, AI_MODEL, AI_BASE_URL from env.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRITING_RULES = readFileSync(join(__dirname, "..", "templates", "writing-rules.md"), "utf8");

/**
 * Build the system prompt for draft generation.
 */
function buildSystemPrompt(campaign, subredditData) {
  const rulesSection = subredditData.rules_json
    ? `\nSubreddit rules:\n${JSON.parse(subredditData.rules_json).map(r => `- ${r.title}: ${r.description || ""}`).join("\n")}`
    : "";

  const flairSection = subredditData.flair_json
    ? `\nAvailable flairs:\n${JSON.parse(subredditData.flair_json).map(f => `- "${f.text}" (ID: ${f.id})`).join("\n")}`
    : "";

  return `You are a Reddit post ghostwriter. Generate a post draft for r/${subredditData.name}.

## Campaign Brief
${campaign.brief || "(No brief provided)"}

## Target Subreddit: r/${subredditData.name}
Subscribers: ${subredditData.subscribers || "unknown"}
${subredditData.culture_notes ? `Culture notes: ${subredditData.culture_notes}` : ""}
${subredditData.timing_rules ? `Timing: ${subredditData.timing_rules}` : ""}
${rulesSection}
${flairSection}

## Writing Rules
${WRITING_RULES}

## Output Format
Respond with ONLY a JSON object (no markdown fences, no explanation):
{
  "title": "Post title here",
  "body": "Post body in markdown",
  "flair_text": "Suggested flair text or null",
  "flair_id": "Flair template ID if known, or null",
  "reasoning": "Brief explanation of why you structured the post this way (not included in the actual post)"
}`;
}

/**
 * Call the configured AI provider to generate a completion.
 * Supports OpenAI-compatible APIs and Anthropic.
 */
async function callAI(systemPrompt, userMessage) {
  const provider = (process.env.AI_PROVIDER || "").toLowerCase().trim();
  const apiKey = process.env.AI_API_KEY || "";
  const model = process.env.AI_MODEL || "";
  const baseUrl = process.env.AI_BASE_URL || "";

  if (!provider) {
    throw new Error("No AI provider configured. Set AI_PROVIDER in .env (openai, anthropic, google, ollama).");
  }

  if (provider === "anthropic") {
    return callAnthropic(apiKey, model || "claude-sonnet-4-20250514", systemPrompt, userMessage);
  }

  // OpenAI-compatible (openai, openrouter, ollama, meta, etc.)
  return callOpenAICompat(apiKey, model, systemPrompt, userMessage, baseUrl, provider);
}

async function callAnthropic(apiKey, model, systemPrompt, userMessage) {
  if (!apiKey) throw new Error("Anthropic requires AI_API_KEY");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.content[0]?.text || "";
}

async function callOpenAICompat(apiKey, model, systemPrompt, userMessage, baseUrl, provider) {
  let url = "https://api.openai.com/v1/chat/completions";
  if (provider === "openrouter") url = "https://openrouter.ai/api/v1/chat/completions";
  else if (provider === "ollama") url = `${baseUrl || "http://localhost:11434"}/v1/chat/completions`;
  else if (provider === "meta") url = "https://api.llama.com/compat/v1/chat/completions";
  else if (baseUrl) url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const effectiveModel = model || "gpt-4o";

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: effectiveModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`AI API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

/**
 * Parse AI response as JSON. Handles markdown fences and other wrapping.
 */
function parseAIResponse(text) {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse AI response as JSON. Raw response:\n${text.substring(0, 500)}`);
  }
}

/**
 * Generate a draft post for a single subreddit.
 *
 * @param {object} campaign - Campaign row
 * @param {object} subredditData - Row from campaigns_subreddits
 * @returns {{ title: string, body: string, flair_text?: string, flair_id?: string, reasoning: string }}
 */
export async function generateDraft(campaign, subredditData) {
  const systemPrompt = buildSystemPrompt(campaign, subredditData);

  const userMessage = `Generate a Reddit post for r/${subredditData.name} based on the campaign brief. The post should feel native to this community and follow all writing rules. Return JSON only.`;

  const response = await callAI(systemPrompt, userMessage);
  return parseAIResponse(response);
}
