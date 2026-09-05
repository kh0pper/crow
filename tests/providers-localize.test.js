import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProvidersFromDb } from "../servers/shared/providers-db.js";

function fakeDb(rows) { return { execute: async () => ({ rows }) }; }
const row = (id, base_url, gpu_policy) => ({ id, base_url, api_key: null, host: "local", bundle_id: null, description: null, models: "[]", disabled: 0, gpu_policy: JSON.stringify(gpu_policy) });

test("loadProvidersFromDb localizes rows this instance owns and leaves foreign-owned rows on their door", async () => {
  const db = fakeDb([
    row("crow-chat", "http://100.118.41.122:3001/llm/v1", { runtime: "native", owner: "me", port: 18100 }),
    row("grackle-x", "http://100.121.254.89:3002/llm/v1", { runtime: "native", owner: "grackle", port: 18100 }),
  ]);
  const cfg = await loadProvidersFromDb(db, { ownInstanceId: "me" });
  assert.equal(cfg.providers["crow-chat"].baseUrl, "http://127.0.0.1:18100/v1");
  assert.equal(cfg.providers["crow-chat"].doorUrl, "http://100.118.41.122:3001/llm/v1");
  assert.equal(cfg.providers["grackle-x"].baseUrl, "http://100.121.254.89:3002/llm/v1");
  assert.equal(cfg.providers["grackle-x"].doorUrl, undefined);
});
