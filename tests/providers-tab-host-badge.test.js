import { test } from "node:test";
import assert from "node:assert/strict";
import { hostBadge } from "../servers/gateway/dashboard/settings/sections/llm/providers-tab.js";

const ctx = {
  ownAddrs: new Set(["127.0.0.1", "::1", "localhost", "100.118.41.122"]),
  ownInstanceId: "0867ac2809dedd885ba7769b21966f8e",
  instanceNames: new Map(),
};

test("hostBadge renders the honest label and escapes it", () => {
  assert.match(hostBadge({ host: "cloud", baseUrl: "http://10.0.0.126:8030/v1", provider_type: "openai-compat" }, ctx), />network</);
  assert.match(hostBadge({ host: "cloud", baseUrl: "https://api.together.xyz/v1", provider_type: "openai-compat" }, ctx), />cloud · openai-compat</);
  assert.match(hostBadge({ host: "local", baseUrl: "http://100.118.41.122:8003/v1" }, ctx), />this machine</);
  assert.match(hostBadge({ host: "<b>x", baseUrl: "http://10.0.0.1/v1" }, ctx), /&lt;b&gt;x/);
});
