/**
 * Ollama Native API Adapter
 *
 * Uses Ollama's native /api/chat endpoint with streaming.
 * Falls back to the OpenAI-compat adapter if tool calling is needed
 * and the model doesn't support it natively.
 */

const DEFAULT_BASE_URL = "http://localhost:11434";

/**
 * Convert MCP tool schemas to Ollama tool format (same as OpenAI format).
 */
function mcpToolsToOllama(tools) {
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
 * Convert chat messages to Ollama message format.
 */
function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content || "",
      };
    }
    if (m.role === "assistant" && m.tool_calls) {
      const toolCalls = JSON.parse(m.tool_calls);
      return {
        role: "assistant",
        content: m.content || "",
        tool_calls: toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
          },
        })),
      };
    }
    return { role: m.role, content: m.content || "" };
  });
}

export default function createOllamaAdapter(config) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    name: "ollama",

    async *chatStream(messages, tools, options = {}) {
      const model = options.model || config.model || "llama3.1";
      const temperature = options.temperature ?? 0.7;

      const body = {
        model,
        messages: toOllamaMessages(messages),
        stream: true,
        options: {
          temperature,
        },
      };

      const ollamaTools = mcpToolsToOllama(tools);
      if (ollamaTools) body.tools = ollamaTools;

      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        if (response.status === 404) {
          throw Object.assign(new Error(`Model '${model}' not found. Run: ollama pull ${model}`), { code: "model_error" });
        }
        throw Object.assign(new Error(`Ollama error (${response.status}): ${errBody.slice(0, 200)}`), { code: "provider_error" });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
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
            if (!trimmed) continue;

            let data;
            try {
              data = JSON.parse(trimmed);
            } catch {
              continue;
            }

            // Ollama streams JSON objects, one per line (NDJSON)
            if (data.message?.content) {
              yield { type: "content_delta", text: data.message.content };
            }

            // Tool calls (Ollama sends them in the final message)
            if (data.message?.tool_calls) {
              for (const tc of data.message.tool_calls) {
                yield {
                  type: "tool_call",
                  id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  name: tc.function?.name || "unknown",
                  arguments: tc.function?.arguments || {},
                };
              }
            }

            // Usage info (in the final chunk where done=true)
            if (data.done) {
              inputTokens = data.prompt_eval_count || 0;
              outputTokens = data.eval_count || 0;
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
