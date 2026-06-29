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

test("falls back to grackle-embed when no env override and DB unreachable", async () => {
  const prevProvider = process.env.CROW_EMBED_PROVIDER;
  const prevDb = process.env.CROW_DB_PATH;
  delete process.env.CROW_EMBED_PROVIDER;
  // Point at a path whose parent dir does not exist so the lookup fails and we
  // exercise the fallback branch deterministically.
  process.env.CROW_DB_PATH = "/nonexistent-dir-xyz-123/none.db";
  try {
    assert.equal(await resolveDefaultProvider(), "grackle-embed");
  } finally {
    if (prevProvider !== undefined) process.env.CROW_EMBED_PROVIDER = prevProvider;
    if (prevDb === undefined) delete process.env.CROW_DB_PATH;
    else process.env.CROW_DB_PATH = prevDb;
  }
});
