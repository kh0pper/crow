/**
 * One-Shot AI Completion with Tool Calling
 *
 * Runs a single AI completion with tool access, consuming the streaming
 * response and executing tool calls in a loop. Used by bot relay for
 * task delegation between Crow instances.
 *
 * Reuses the same adapter + tool executor infrastructure as the AI chat gateway.
 */

import { createProviderAdapter } from "./provider.js";
import { createToolExecutor, getChatTools, MAX_TOOL_ROUNDS } from "./tool-executor.js";

/**
 * Run a one-shot AI completion with tool calling.
 *
 * @param {string} systemPrompt - System prompt for the AI
 * @param {string} userMessage - The user's task/question
 * @returns {string} The AI's final text response
 * @throws {Error} with code "not_configured" if no AI provider is set
 */
export async function runOneShot(systemPrompt, userMessage) {
  // createProviderAdapter returns { adapter, config } — destructure so
  // `adapter.chatStream(...)` below calls the real method rather than
  // throwing "chatStream is not a function" on the wrapper object.
  const { adapter } = await createProviderAdapter();
  const toolExecutor = createToolExecutor();
  const tools = getChatTools();

  try {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    let rounds = 0;
    let finalText = "";

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      let assistantContent = "";
      const toolCalls = [];

      for await (const event of adapter.chatStream(messages, tools)) {
        switch (event.type) {
          case "content_delta":
            assistantContent += event.text;
            break;
          case "tool_call":
            toolCalls.push({
              id: event.id,
              name: event.name,
              arguments: event.arguments,
            });
            break;
          case "done":
            break;
        }
      }

      // Add assistant message to context
      if (assistantContent || toolCalls.length > 0) {
        const assistantMsg = { role: "assistant", content: assistantContent || "" };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          }));
        }
        messages.push(assistantMsg);
      }

      finalText = assistantContent;

      // No tool calls = done
      if (toolCalls.length === 0) break;

      // Execute tool calls and add results to context
      const results = await toolExecutor.executeToolCalls(toolCalls);
      for (const result of results) {
        messages.push({
          role: "tool",
          content: result.result,
          tool_call_id: result.id,
          tool_name: result.name,
        });
      }

      // Loop for AI to process tool results
    }

    return finalText || "Task completed (no text response).";
  } finally {
    toolExecutor.close?.();
  }
}
