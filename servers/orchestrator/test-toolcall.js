#!/usr/bin/env node
/**
 * Diagnostic: test whether llama.cpp on port 8081 actually makes tool calls
 * when given tools in the OpenAI format.
 */

const BASE_URL = "http://localhost:8081/v1";

const response = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "opus-reasoning-35b",
    max_tokens: 1024,
    messages: [
      {
        role: "system",
        content: "You are a research assistant with access to a memory search tool. Always use tools when asked to search or look up information.",
      },
      {
        role: "user",
        content: "Search my memories for anything about the home lab network architecture.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "crow_search_memories",
          description: "Search memories using full-text search (FTS5)",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              category: { type: "string", description: "Filter by category" },
              limit: { type: "number", description: "Max results" },
            },
            required: ["query"],
          },
        },
      },
    ],
  }),
});

const data = await response.json();
console.log("Status:", response.status);
console.log("Finish reason:", data.choices?.[0]?.finish_reason);
console.log("Message:", JSON.stringify(data.choices?.[0]?.message, null, 2));
console.log("Tool calls:", data.choices?.[0]?.message?.tool_calls?.length ?? 0);
