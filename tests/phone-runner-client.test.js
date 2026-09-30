import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunnerClient } from "../bundles/phone/server/runner-client.js";

test("no secret → requests reject with a clear error, nothing is sent", async () => {
  let sent = 0;
  const c = createRunnerClient({ baseUrl: "http://x", fetchImpl: async () => { sent++; return { ok: true, json: async () => ({}) }; } });
  await assert.rejects(() => c.events("call_1", 0), /secret/i);
  assert.equal(sent, 0);
});
