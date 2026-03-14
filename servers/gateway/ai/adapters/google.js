/**
 * Google Gemini API Adapter
 *
 * Uses the Gemini REST API with streaming (streamGenerateContent).
 * Native fetch(), no SDK dependency.
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Convert MCP tool schemas to Gemini function declarations.
 */
function mcpToolsToGemini(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "OBJECT", properties: {} },
    })),
  }];
}

/**
 * Convert chat messages to Gemini content format.
 */
function toGeminiContents(messages) {
  const contents = [];
  let systemInstruction = null;

  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content || "" }] };
      continue;
    }

    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content || "" }] });
      continue;
    }

    if (m.role === "assistant") {
      const parts = [];
      if (m.content) {
        parts.push({ text: m.content });
      }
      if (m.tool_calls) {
        const toolCalls = JSON.parse(m.tool_calls);
        for (const tc of toolCalls) {
          let args;
          try {
            args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
          } catch {
            args = {};
          }
          parts.push({ functionCall: { name: tc.name, args } });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (m.role === "tool") {
      contents.push({
        role: "function",
        parts: [{
          functionResponse: {
            name: m.tool_name || "unknown",
            response: { result: m.content || "" },
          },
        }],
      });
      continue;
    }
  }

  return { contents, systemInstruction };
}

export default function createGoogleAdapter(config) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = config.apiKey;

  return {
    name: "google",

    async *chatStream(messages, tools, options = {}) {
      const model = options.model || config.model || "gemini-2.5-flash";
      const temperature = options.temperature ?? 0.7;
      const maxTokens = options.maxTokens || 4096;

      const { contents, systemInstruction } = toGeminiContents(messages);

      const body = {
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      };

      if (systemInstruction) body.systemInstruction = systemInstruction;
      const geminiTools = mcpToolsToGemini(tools);
      if (geminiTools) body.tools = geminiTools;

      const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          throw Object.assign(new Error("API key is invalid (401/403 from Google)"), { code: "auth_error" });
        }
        if (response.status === 429) {
          throw Object.assign(new Error("Rate limited by Google — try again later"), { code: "rate_limit" });
        }
        if (response.status === 404) {
          throw Object.assign(new Error(`Model '${model}' not found (404)`), { code: "model_error" });
        }
        throw Object.assign(new Error(`Google error (${response.status}): ${errBody.slice(0, 200)}`), { code: "provider_error" });
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
            if (!trimmed.startsWith("data: ")) continue;

            let data;
            try {
              data = JSON.parse(trimmed.slice(6));
            } catch {
              continue;
            }

            // Usage metadata
            if (data.usageMetadata) {
              inputTokens = data.usageMetadata.promptTokenCount || 0;
              outputTokens = data.usageMetadata.candidatesTokenCount || 0;
            }

            const candidate = data.candidates?.[0];
            if (!candidate?.content?.parts) continue;

            for (const part of candidate.content.parts) {
              if (part.text) {
                yield { type: "content_delta", text: part.text };
              }
              if (part.functionCall) {
                yield {
                  type: "tool_call",
                  id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  name: part.functionCall.name,
                  arguments: part.functionCall.args || {},
                };
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
