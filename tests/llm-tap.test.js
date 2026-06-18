import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";

import { extractUsageFromOpenAIResponse } from "../servers/shared/metering.js";

// Reproduces the /llm proxy tap: a 'data' listener accumulates a bounded tail
// while pipe() forwards bytes to the client. This guards the real risk of the
// change — that tapping the stream could corrupt or drop proxied bytes.
function teeThroughProxy(sourceChunks, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const src = Readable.from(sourceChunks);
    let forwarded = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        forwarded += chunk.toString("utf8");
        cb();
      },
    });
    let captured = "";
    src.on("data", (chunk) => {
      captured += chunk.toString("utf8");
      if (captured.length > cap) captured = captured.slice(-cap);
    });
    src.on("error", reject);
    src.pipe(sink);
    sink.on("finish", () => resolve({ forwarded, captured }));
  });
}

test("the proxy tap forwards every byte unchanged while capturing usage", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"The capital"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" is Paris."}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":120}}\n\n',
    "data: [DONE]\n\n",
  ];
  const { forwarded, captured } = await teeThroughProxy(chunks);

  // Client must receive the exact, complete stream.
  assert.equal(forwarded, chunks.join(""));
  // And the tap must recover usage from the captured tail.
  assert.deepEqual(extractUsageFromOpenAIResponse(captured), {
    inputTokens: 900,
    outputTokens: 120,
    cachedTokens: 0,
  });
});

test("the bounded tail still retains the trailing usage frame on long streams", async () => {
  // Many filler frames then the usage frame last; cap forces tail-only retention.
  const filler = Array.from({ length: 200 }, (_, i) =>
    `data: {"choices":[{"delta":{"content":"tok${i} "}}]}\n\n`,
  );
  const chunks = [
    ...filler,
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n',
    "data: [DONE]\n\n",
  ];
  const { forwarded, captured } = await teeThroughProxy(chunks, 1024);

  assert.equal(forwarded, chunks.join(""), "client still gets the full stream");
  assert.deepEqual(extractUsageFromOpenAIResponse(captured), {
    inputTokens: 5,
    outputTokens: 7,
    cachedTokens: 0,
  });
});
