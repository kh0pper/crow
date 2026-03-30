/**
 * OpenAI-compatible Chat Adapter
 *
 * Covers OpenAI, OpenRouter, Ollama (OpenAI-compat mode), and any
 * provider that implements the OpenAI Chat Completions API.
 *
 * Uses native fetch() — no SDK dependency.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Convert MCP tool schemas to OpenAI function-calling format.
 */
function mcpToolsToOpenAI(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
}

/**
 * Convert chat messages to OpenAI message format.
 * @param {Array} messages
 * @param {Array} [tools] - Tool schemas, used to fix up empty arguments for
 *   providers (e.g. Meta Llama) that reject "{}" as "parameters missing".
 */
function toOpenAIMessages(messages, tools) {
  // Build a map of tool name → first schema property for empty-args fixup
  const toolFirstProp = new Map();
  if (tools) {
    for (const t of tools) {
      const props = t.inputSchema?.properties;
      if (props) {
        const firstKey = Object.keys(props)[0];
        if (firstKey) toolFirstProp.set(t.name, firstKey);
      }
    }
  }

  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: m.content || "",
      };
    }
    if (m.role === "assistant" && m.tool_calls) {
      const toolCalls = JSON.parse(m.tool_calls);
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: toolCalls.map((tc) => {
          let args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments);
          // Fix empty arguments for providers that reject "{}" (e.g. Meta Llama API)
          if (args === "{}" || args === "") {
            const firstProp = toolFirstProp.get(tc.name);
            if (firstProp) {
              args = JSON.stringify({ [firstProp]: "" });
            }
          }
          return {
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: args },
          };
        }),
      };
    }
    // User messages with resolved image URLs → multimodal content array
    // (imageUrls are pre-resolved presigned URLs, set by the chat route)
    if (m.role === "user" && m._imageUrls && m._imageUrls.length > 0) {
      const content = [{ type: "text", text: m.content || "" }];
      for (const url of m._imageUrls) {
        content.push({ type: "image_url", image_url: { url } });
      }
      return { role: "user", content };
    }
    return { role: m.role, content: m.content || "" };
  });
}

export default function createOpenAIAdapter(config) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = config.apiKey;

  return {
    name: "openai",

    async *chatStream(messages, tools, options = {}) {
      const model = options.model || config.model || "gpt-4o";
      const temperature = options.temperature ?? 0.7;
      const maxTokens = options.maxTokens || 4096;

      const openaiTools = mcpToolsToOpenAI(tools);

      const body = {
        model,
        messages: toOpenAIMessages(messages, tools),
        temperature,
        max_tokens: maxTokens,
        stream: true,
      };
      if (openaiTools) {
        body.tools = openaiTools;
      }

      const headers = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        if (response.status === 401) {
          throw Object.assign(new Error(`API key is invalid (401 from provider)`), { code: "auth_error" });
        }
        if (response.status === 429) {
          throw Object.assign(new Error(`Rate limited by provider — try again later`), { code: "rate_limit" });
        }
        if (response.status === 404) {
          throw Object.assign(new Error(`Model '${model}' not found (404)`), { code: "model_error" });
        }
        throw Object.assign(new Error(`Provider error (${response.status}): ${errBody.slice(0, 200)}`), { code: "provider_error" });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Track accumulated tool calls from streamed deltas
      const pendingToolCalls = new Map(); // index → { id, name, arguments }
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            let data;
            try {
              data = JSON.parse(trimmed.slice(6));
            } catch {
              continue;
            }

            // Usage info (may come in final chunk)
            if (data.usage) {
              inputTokens = data.usage.prompt_tokens || 0;
              outputTokens = data.usage.completion_tokens || 0;
            }

            const choice = data.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            // Content delta
            if (delta.content) {
              yield { type: "content_delta", text: delta.content };
            }

            // Tool call deltas
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!pendingToolCalls.has(idx)) {
                  pendingToolCalls.set(idx, { id: tc.id || "", name: "", arguments: "" });
                }
                const pending = pendingToolCalls.get(idx);
                if (tc.id) pending.id = tc.id;
                if (tc.function?.name) pending.name += tc.function.name;
                if (tc.function?.arguments) pending.arguments += tc.function.arguments;
              }
            }

            // When finish_reason is "tool_calls", emit accumulated tool calls
            if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
              if (pendingToolCalls.size > 0) {
                for (const [, tc] of pendingToolCalls) {
                  let args;
                  try {
                    args = JSON.parse(tc.arguments);
                  } catch {
                    args = {};
                  }
                  yield { type: "tool_call", id: tc.id, name: tc.name, arguments: args };
                }
                pendingToolCalls.clear();
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      yield { type: "done", usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
    },
  };
}
