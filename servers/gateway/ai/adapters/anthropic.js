/**
 * Anthropic Messages API Adapter
 *
 * Uses native fetch() against the Anthropic Messages API with streaming.
 * Handles content_block_delta events for both text and tool_use.
 */

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

/**
 * Convert MCP tool schemas to Anthropic tool format.
 */
function mcpToolsToAnthropic(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));
}

/**
 * Convert chat messages to Anthropic message format.
 * Anthropic requires alternating user/assistant roles, and tool results
 * go inside user messages as tool_result content blocks.
 */
function toAnthropicMessages(messages) {
  const result = [];
  let i = 0;

  while (i < messages.length) {
    const m = messages[i];

    if (m.role === "system") {
      // System messages handled separately — skip
      i++;
      continue;
    }

    if (m.role === "user") {
      result.push({ role: "user", content: m.content || "" });
      i++;
      continue;
    }

    if (m.role === "assistant") {
      const content = [];
      if (m.content) {
        content.push({ type: "text", text: m.content });
      }
      if (m.tool_calls) {
        const toolCalls = JSON.parse(m.tool_calls);
        for (const tc of toolCalls) {
          let input;
          try {
            input = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input,
          });
        }
      }
      result.push({ role: "assistant", content: content.length > 0 ? content : (m.content || "") });
      i++;
      continue;
    }

    if (m.role === "tool") {
      // Collect consecutive tool results into a single user message
      const toolResults = [];
      while (i < messages.length && messages[i].role === "tool") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: messages[i].tool_call_id,
          content: messages[i].content || "",
        });
        i++;
      }
      result.push({ role: "user", content: toolResults });
      continue;
    }

    // Unknown role — skip
    i++;
  }

  return result;
}

export default function createAnthropicAdapter(config) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = config.apiKey;

  return {
    name: "anthropic",

    async *chatStream(messages, tools, options = {}) {
      const model = options.model || config.model || "claude-sonnet-4-20250514";
      const temperature = options.temperature ?? 0.7;
      const maxTokens = options.maxTokens || 4096;

      // Extract system message
      const systemMessages = messages.filter((m) => m.role === "system");
      const nonSystemMessages = messages.filter((m) => m.role !== "system");
      const system = systemMessages.map((m) => m.content).join("\n\n") || undefined;

      const body = {
        model,
        messages: toAnthropicMessages(nonSystemMessages),
        max_tokens: maxTokens,
        temperature,
        stream: true,
      };

      if (system) body.system = system;

      const anthropicTools = mcpToolsToAnthropic(tools);
      if (anthropicTools) body.tools = anthropicTools;

      const headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      };

      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        if (response.status === 401) {
          throw Object.assign(new Error("API key is invalid (401 from Anthropic)"), { code: "auth_error" });
        }
        if (response.status === 429) {
          throw Object.assign(new Error("Rate limited by Anthropic — try again later"), { code: "rate_limit" });
        }
        if (response.status === 404) {
          throw Object.assign(new Error(`Model '${model}' not found (404)`), { code: "model_error" });
        }
        throw Object.assign(new Error(`Anthropic error (${response.status}): ${errBody.slice(0, 200)}`), { code: "provider_error" });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      let inputTokens = 0;
      let outputTokens = 0;

      // Track current content block for tool_use streaming
      let currentToolUse = null; // { id, name, arguments_json }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;

            let data;
            try {
              data = JSON.parse(trimmed.slice(6));
            } catch {
              continue;
            }

            switch (data.type) {
              case "message_start":
                if (data.message?.usage) {
                  inputTokens = data.message.usage.input_tokens || 0;
                }
                break;

              case "content_block_start":
                if (data.content_block?.type === "tool_use") {
                  currentToolUse = {
                    id: data.content_block.id,
                    name: data.content_block.name,
                    arguments_json: "",
                  };
                }
                break;

              case "content_block_delta":
                if (data.delta?.type === "text_delta") {
                  yield { type: "content_delta", text: data.delta.text };
                } else if (data.delta?.type === "input_json_delta" && currentToolUse) {
                  currentToolUse.arguments_json += data.delta.partial_json;
                }
                break;

              case "content_block_stop":
                if (currentToolUse) {
                  let args;
                  try {
                    args = JSON.parse(currentToolUse.arguments_json);
                  } catch {
                    args = {};
                  }
                  yield {
                    type: "tool_call",
                    id: currentToolUse.id,
                    name: currentToolUse.name,
                    arguments: args,
                  };
                  currentToolUse = null;
                }
                break;

              case "message_delta":
                if (data.usage) {
                  outputTokens = data.usage.output_tokens || 0;
                }
                break;

              case "message_stop":
                break;
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
