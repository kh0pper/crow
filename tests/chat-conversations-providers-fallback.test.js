/**
 * chat.js conversation-creation env-fallback (Amended review, C-B Task 9
 * finding #1): on a providers-table-only install (BOTH wizard branches —
 * local download and cloud paste-key — write only a `providers` row, never
 * `.env` AI_PROVIDER or `ai_profiles`), the messages panel's "+ → New AI
 * chat" used to silently no-op: client msgNewAiChat finds zero profiles,
 * POSTs /api/chat/conversations with title only, routes/chat.js's Path C
 * env-fallback branch called getProviderConfig() → null → 400 "No AI
 * provider configured...", and the client saw no data.id and returned
 * silently.
 *
 * The fix extends Path C to consult the `providers` table (via
 * `findUsableProviderRow`, shared/providers-db.js — the same predicate the
 * Messages panel's `aiConfigured` gate uses, panels/messages.js
 * `hasUsableProvider`) before giving up.
 *
 * Harness: mounts the REAL chatRouter (not a re-implementation) on a bare
 * express app with an ephemeral HTTP server + plain fetch, mirroring
 * tests/board-stage-api.test.js's pattern. DB is a real sqlite instance
 * built by the real scripts/init-db.js (CROW_DATA_DIR-scoped), mirroring
 * tests/chat-template-kwargs.test.js and tests/messages-panel-ai-configured
 * .test.js. `process.env.HOME` is pointed at a throwaway dir per-scenario so
 * `getProviderConfig()` (reads `~/.crow/.env`, NOT CROW_DATA_DIR-scoped)
 * deterministically returns null or a real value regardless of what's on
 * the operator machine actually running this suite.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "chat-conv-fallback-data-"));
const noEnvHome = mkdtempSync(join(tmpdir(), "chat-conv-fallback-home-noenv-"));
const envHome = mkdtempSync(join(tmpdir(), "chat-conv-fallback-home-env-"));

// envHome DOES carry a ~/.crow/.env with AI_PROVIDER set, for the
// regression-pin test (#3) — written once, up front.
mkdirSync(join(envHome, ".crow"), { recursive: true });
writeFileSync(
  join(envHome, ".crow", ".env"),
  "AI_PROVIDER=openai\nAI_MODEL=gpt-4o-mini\nAI_API_KEY=sk-test-not-real\nAI_BASE_URL=https://api.openai.com/v1\n",
);

process.env.CROW_DATA_DIR = dataDir;
process.env.HOME = noEnvHome; // default: no ~/.crow/.env — getProviderConfig() null

let db = null;
let server = null;
let base = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dataDir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });

  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();

  const { default: express } = await import("express");
  const { default: chatRouter } = await import("../servers/gateway/routes/chat.js");
  const app = express();
  app.use(express.json());
  app.use(chatRouter((req, res, next) => next())); // dashboardAuth stub — auth not under test
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { db && db.close && db.close(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(noEnvHome, { recursive: true, force: true });
  rmSync(envHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute("DELETE FROM providers");
  await db.execute("DELETE FROM chat_conversations");
  await db.execute("DELETE FROM dashboard_settings WHERE key = 'ai_profiles'");
  process.env.HOME = noEnvHome;
  const { invalidateConfigCache } = await import("../servers/gateway/ai/provider.js");
  invalidateConfigCache();
});

async function insertProvider({ id, models, disabled = 0 }) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id)
          VALUES (?, ?, 'local', ?, ?, 1, 'test-instance')`,
    args: [id, "http://127.0.0.1:9999/v1", JSON.stringify(models), disabled],
  });
}

async function postConversation(body) {
  const res = await fetch(`${base}/api/chat/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// --- (1) providers-table-only install + a usable row -----------------------

test("providers-table-only install: usable row → conversation created with provider=row id, model=models[0].id", async () => {
  await insertProvider({ id: "local-llm", models: [{ id: "qwen3-4b", task: "chat" }] });

  const { status, json } = await postConversation({ title: "Hello" });
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.provider, "local-llm");
  assert.equal(json.model, "qwen3-4b");

  const { rows } = await db.execute({
    sql: "SELECT provider, model, title FROM chat_conversations WHERE id = ?",
    args: [json.id],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "local-llm");
  assert.equal(rows[0].model, "qwen3-4b");
  assert.equal(rows[0].title, "Hello");
});

test("providers-table-only install: multiple rows, scan finds the first usable one (id order) and skips a bad row ahead of it", async () => {
  // "bad-a" sorts before "good-b" alphabetically but has no usable model —
  // proves the scan doesn't just take the first row unconditionally.
  await insertProvider({ id: "bad-a", models: [] });
  await insertProvider({ id: "good-b", models: [{ id: "some-model" }] });

  const { status, json } = await postConversation({ title: "Hi" });
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.provider, "good-b");
  assert.equal(json.model, "some-model");
});

// --- (2) disabled-only / empty-models-only → 400 unchanged ------------------

test("only a disabled row with usable models → 400, same message as a fully-unconfigured install", async () => {
  await insertProvider({ id: "disabled-llm", models: [{ id: "qwen3-4b" }], disabled: 1 });

  const { status, json } = await postConversation({ title: "Hello" });
  assert.equal(status, 400);
  assert.equal(json.error, "No AI provider configured. Add an AI Profile or use Quick Chat.");
});

test("only an enabled row with an empty models array → 400, same message", async () => {
  await insertProvider({ id: "empty-models", models: [] });

  const { status, json } = await postConversation({ title: "Hello" });
  assert.equal(status, 400);
  assert.equal(json.error, "No AI provider configured. Add an AI Profile or use Quick Chat.");
});

test("no providers rows at all (fully unconfigured) → 400, same as pre-fix behavior", async () => {
  const { status, json } = await postConversation({ title: "Hello" });
  assert.equal(status, 400);
  assert.equal(json.error, "No AI provider configured. Add an AI Profile or use Quick Chat.");
});

// --- (3) env-configured install → unchanged (regression pin) ---------------

test("env-configured install: env still wins even when a usable providers-table row also exists", async () => {
  // A usable table row is ALSO present, to prove precedence didn't change —
  // env config must still be the one that wins in Path C.
  await insertProvider({ id: "local-llm", models: [{ id: "qwen3-4b" }] });

  process.env.HOME = envHome;
  const { invalidateConfigCache } = await import("../servers/gateway/ai/provider.js");
  invalidateConfigCache();
  try {
    const { status, json } = await postConversation({ title: "Hello" });
    assert.equal(status, 201, JSON.stringify(json));
    assert.equal(json.provider, "openai");
    assert.equal(json.model, "gpt-4o-mini");
  } finally {
    process.env.HOME = noEnvHome;
    invalidateConfigCache();
  }
});
