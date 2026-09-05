/**
 * Final review C2: the two providers-table resolvers that do NOT go through
 * `loadProvidersFromDb` must localize an OWNED native row the same way it
 * does — `ai/resolve-profile.js`'s `resolveFromDb` (behind
 * `resolveProviderConfig`, which llm-router / routes/chat.js / ai/provider.js
 * all call) and `memory/embeddings.js`'s cold-cache `loadProviderFromDb`.
 *
 * A native row's `base_url` is the DOOR (`http://<tailnet-ip>:<gateway>/llm/v1`).
 * The OWNING instance calling that door recurses into its own router; a
 * FOREIGN-owned row must keep the door, because the door is the only way to
 * reach a peer's llama-server.
 *
 * Harness: freshLibsql() — the same pattern as tests/models-registration.test.js
 * (`scripts/init-db.js` against a per-test tmp dir, CROW_DATA_DIR pointed at
 * it so getOrCreateLocalInstanceId() reads/writes an instance-id file there,
 * never the real ~/.crow).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProviderConfig } from "../servers/gateway/ai/resolve-profile.js";
import { loadProviderFromDb } from "../servers/memory/embeddings.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

const DOOR = "http://100.118.41.122:3001/llm/v1";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "providers-localize-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    dir, db,
    cleanup() {
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function insertRow(db, { id, gpuPolicy, baseUrl = DOOR }) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, api_key, host, bundle_id, description, models, disabled, gpu_policy)
          VALUES (?, ?, ?, 'local', NULL, ?, ?, 0, ?)`,
    args: [id, baseUrl, "none", `${id} (native)`, JSON.stringify([{ id, task: "chat" }]), JSON.stringify(gpuPolicy)],
  });
}

test("C2: resolveProviderConfig localizes an OWNED native row to loopback and leaves a FOREIGN-owned row on the door", async () => {
  const h = freshLibsql();
  try {
    const own = getOrCreateLocalInstanceId();
    await insertRow(h.db, {
      id: "mine",
      gpuPolicy: { runtime: "native", owner: own, port: 18150, catalogId: "x", quant: "Q4" },
    });
    await insertRow(h.db, {
      id: "theirs",
      gpuPolicy: { runtime: "native", owner: "some-other-instance", port: 18151, catalogId: "y", quant: "Q4" },
    });

    const mine = await resolveProviderConfig(h.db, "mine");
    assert.equal(mine.baseUrl, "http://127.0.0.1:18150/v1", "owned native row resolves to its llama-server loopback");

    const theirs = await resolveProviderConfig(h.db, "theirs");
    assert.equal(theirs.baseUrl, DOOR, "a peer's native row keeps the door — that is the only way to reach it");
  } finally {
    h.cleanup();
  }
});

test("C2: resolveProviderConfig leaves non-native and owner-less rows untouched", async () => {
  const h = freshLibsql();
  try {
    await insertRow(h.db, { id: "cloud", baseUrl: "https://api.openai.com/v1", gpuPolicy: null });
    await insertRow(h.db, {
      id: "pre-arc",
      baseUrl: "http://127.0.0.1:18160/v1",
      gpuPolicy: { runtime: "native", mutexGroup: "local-llm" }, // no owner: the pre-branch shape
    });

    assert.equal((await resolveProviderConfig(h.db, "cloud")).baseUrl, "https://api.openai.com/v1");
    assert.equal((await resolveProviderConfig(h.db, "pre-arc")).baseUrl, "http://127.0.0.1:18160/v1");
  } finally {
    h.cleanup();
  }
});

test("C2: the embeddings cold-cache DB loader localizes an owned native row, keeps a peer's door", async () => {
  const h = freshLibsql();
  try {
    const own = getOrCreateLocalInstanceId();
    await insertRow(h.db, {
      id: "embed-mine",
      gpuPolicy: { runtime: "native", owner: own, port: 18155, catalogId: "embed", quant: "Q8" },
    });
    await insertRow(h.db, {
      id: "embed-theirs",
      gpuPolicy: { runtime: "native", owner: "some-other-instance", port: 18156, catalogId: "embed", quant: "Q8" },
    });

    const mine = await loadProviderFromDb("embed-mine");
    assert.equal(mine.baseUrl, "http://127.0.0.1:18155/v1");
    const theirs = await loadProviderFromDb("embed-theirs");
    assert.equal(theirs.baseUrl, DOOR);
  } finally {
    h.cleanup();
  }
});

test("C2: an owned native row with no port is left alone (nothing to localize to)", async () => {
  const h = freshLibsql();
  try {
    const own = getOrCreateLocalInstanceId();
    await insertRow(h.db, { id: "no-port", gpuPolicy: { runtime: "native", owner: own } });
    assert.equal((await resolveProviderConfig(h.db, "no-port")).baseUrl, DOOR);
    assert.equal((await loadProviderFromDb("no-port")).baseUrl, DOOR);
  } finally {
    h.cleanup();
  }
});
