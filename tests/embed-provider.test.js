import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultProvider } from "../servers/memory/embeddings.js";

test("CROW_EMBED_PROVIDER env var takes precedence", async () => {
  const prev = process.env.CROW_EMBED_PROVIDER;
  process.env.CROW_EMBED_PROVIDER = "test-embed-provider";
  try {
    assert.equal(await resolveDefaultProvider(), "test-embed-provider");
  } finally {
    if (prev === undefined) delete process.env.CROW_EMBED_PROVIDER;
    else process.env.CROW_EMBED_PROVIDER = prev;
  }
});

test("no env override and DB unreachable -> null (never a named host)", async () => {
  const { _resetProviderTaskCacheForTest } = await import("../servers/shared/provider-task.js");
  _resetProviderTaskCacheForTest();
  const prevProvider = process.env.CROW_EMBED_PROVIDER;
  const prevDb = process.env.CROW_DB_PATH;
  delete process.env.CROW_EMBED_PROVIDER;
  process.env.CROW_DB_PATH = "/nonexistent-dir-xyz-123/none.db";
  try {
    assert.equal(await resolveDefaultProvider(), null);
  } finally {
    if (prevProvider !== undefined) process.env.CROW_EMBED_PROVIDER = prevProvider;
    if (prevDb === undefined) delete process.env.CROW_DB_PATH;
    else process.env.CROW_DB_PATH = prevDb;
    _resetProviderTaskCacheForTest();
  }
});
