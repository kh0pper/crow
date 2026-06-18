import { test } from "node:test";
import assert from "node:assert/strict";

import { extractUsageFromOpenAIResponse } from "../servers/shared/metering.js";

test("extracts usage from a streaming SSE response (include_usage final chunk)", () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":800}}}',
    "data: [DONE]",
    "",
  ].join("\n\n");

  const usage = extractUsageFromOpenAIResponse(sse);
  assert.deepEqual(usage, { inputTokens: 1200, outputTokens: 300, cachedTokens: 800 });
});

test("extracts usage from a non-streaming JSON response", () => {
  const json = JSON.stringify({
    choices: [{ message: { content: "hi" } }],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  });
  const usage = extractUsageFromOpenAIResponse(json);
  assert.deepEqual(usage, { inputTokens: 50, outputTokens: 10, cachedTokens: 0 });
});

test("returns null when no usage block is present (stream without include_usage)", () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    "data: [DONE]",
    "",
  ].join("\n\n");
  assert.equal(extractUsageFromOpenAIResponse(sse), null);
});
