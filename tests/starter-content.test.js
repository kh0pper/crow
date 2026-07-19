/**
 * starter-content.js — onboarding starter memories + starter agent/conversation
 * (C1/C3 Tasks 2-3).
 *
 *   seedStarterMemories(db, lang) inserts a handful of `source='starter'`
 *   rows into `memories` (idempotent — no-ops if any starter row exists).
 *   clearStarterMemories(db) deletes only those rows (used by Task 4's
 *   Settings > Help and Setup action).
 *   shouldSyncRow('memories', row) excludes source='starter' rows from
 *   instance-sync (starter/demo content is per-install, same convention as
 *   providers' gpu_policy.local_only).
 *   resolveStarterProvider(db) picks the provider/model pair the starter
 *   agent + conversation should use (Task 3).
 *   createStarterArtifacts(db, {lang}) creates the `crow-starter` pi_bot_defs
 *   row and its matching chat_conversations row, idempotently (Task 3).
 *
 * Harness follows tests/instance-sync.test.js: real init-db.js schema in a
 * tmp dir so the memories_fts triggers exist (FTS works with zero embedding
 * providers — memory/server.js:176-214).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { shouldSyncRowForTest } from "../servers/sharing/instance-sync.js";
import {
  STARTER_SOURCE,
  STARTER_BOT_ID,
  seedStarterMemories,
  clearStarterMemories,
  resolveStarterProvider,
  createStarterArtifacts,
} from "../servers/gateway/dashboard/panels/onboarding/starter-content.js";

const REPO_ROOT = join(import.meta.dirname, "..");

// ── Shared setup ─────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "crow-startercontent-test-"));

execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
  cwd: REPO_ROOT,
});

const DB_PATH = join(tmpDir, "crow.db");
const db = createDbClient(DB_PATH);

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Task 3 shared helpers ───────────────────────────────────────────────────

/** The real catalog's first_run_default model id (currently "qwen3-4b"). */
const CATALOG = JSON.parse(readFileSync(join(REPO_ROOT, "registry", "model-catalog.json"), "utf8"));
const FIRST_RUN_DEFAULT_ID = CATALOG.models.find((m) => m.first_run_default === true).id;

/** Fresh scratch DB per test — provider/bot/conversation state must not leak
 * across resolveStarterProvider/createStarterArtifacts scenarios. */
function makeScratchDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-starterartifacts-test-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO_ROOT,
  });
  const scratchDb = createDbClient(join(dir, "crow.db"));
  return {
    db: scratchDb,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function insertProvider(scratchDb, { id, models, disabled = 0 }) {
  await scratchDb.execute({
    sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,?)",
    args: [id, "http://127.0.0.1:9/v1", JSON.stringify(models), disabled],
  });
}

// ── STARTER_SOURCE ────────────────────────────────────────────────────────────

test("STARTER_SOURCE is the 'starter' marker", () => {
  assert.equal(STARTER_SOURCE, "starter");
});

// ── seedStarterMemories ───────────────────────────────────────────────────────

test("seedStarterMemories inserts rows marked source='starter' and is idempotent", async () => {
  const first = await seedStarterMemories(db, "en");
  assert.ok(first.inserted >= 4 && first.inserted <= 8, "a handful of rows");
  const second = await seedStarterMemories(db, "en");
  assert.equal(second.inserted, 0);
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) n FROM memories WHERE source='starter'",
    args: [],
  });
  assert.equal(Number(rows[0].n), first.inserted);
});

test("starter rows are FTS-searchable with zero embedding providers", async () => {
  const { rows } = await db.execute({
    sql: "SELECT m.content FROM memories_fts f JOIN memories m ON m.id=f.rowid WHERE memories_fts MATCH ?",
    args: ["remember"],
  });
  assert.ok(rows.length > 0);
});

// ── clearStarterMemories ──────────────────────────────────────────────────────

test("clearStarterMemories deletes only starter rows", async () => {
  const tmpDir2 = mkdtempSync(join(tmpdir(), "crow-startercontent-clear-test-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: tmpDir2 },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db2 = createDbClient(join(tmpDir2, "crow.db"));
  try {
    await db2.execute({
      sql: "INSERT INTO memories (content, source) VALUES ('user row','manual')",
      args: [],
    });
    await seedStarterMemories(db2, "en");
    const { deleted } = await clearStarterMemories(db2);
    assert.ok(deleted > 0);
    const { rows } = await db2.execute({ sql: "SELECT source FROM memories", args: [] });
    assert.deepEqual(rows.map((r) => r.source), ["manual"]);
  } finally {
    rmSync(tmpDir2, { recursive: true, force: true });
  }
});

// ── lang="es" ──────────────────────────────────────────────────────────────

test("seedStarterMemories(db, 'es') inserts real Spanish translations", async () => {
  const tmpDir3 = mkdtempSync(join(tmpdir(), "crow-startercontent-es-test-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: tmpDir3 },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db3 = createDbClient(join(tmpDir3, "crow.db"));
  try {
    const result = await seedStarterMemories(db3, "es");
    assert.ok(result.inserted > 0);
    const { rows } = await db3.execute({
      sql: "SELECT content FROM memories WHERE source='starter'",
      args: [],
    });
    // Real translation, not the EN string reused: must not equal the EN
    // "general/about" row and should contain Spanish-specific wording.
    assert.ok(
      rows.some((r) => /recuerda|almacenad|guardad/i.test(r.content)),
      "expected at least one Spanish row using recordar-family vocabulary"
    );
    assert.ok(
      rows.every((r) => !/^Crow is your private AI/.test(r.content)),
      "es rows must not be the untranslated EN string"
    );
  } finally {
    rmSync(tmpDir3, { recursive: true, force: true });
  }
});

// ── shouldSyncRow exclusion ────────────────────────────────────────────────

test("shouldSyncRow excludes memories rows with source='starter' (both directions use the same gate)", () => {
  assert.equal(
    shouldSyncRowForTest("memories", { id: 1, content: "x", source: "starter" }),
    false
  );
  assert.equal(
    shouldSyncRowForTest("memories", { id: 2, content: "y", source: "manual" }),
    true
  );
  assert.equal(
    shouldSyncRowForTest("memories", { id: 3, content: "z", source: null }),
    true
  );
});

// ── STARTER_BOT_ID ───────────────────────────────────────────────────────────

test("STARTER_BOT_ID is the 'crow-starter' marker", () => {
  assert.equal(STARTER_BOT_ID, "crow-starter");
});

// ── resolveStarterProvider ───────────────────────────────────────────────────

test("resolveStarterProvider: picks the native first_run_default provider row when present", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    await insertProvider(sdb, { id: FIRST_RUN_DEFAULT_ID, models: [{ id: FIRST_RUN_DEFAULT_ID }] });
    const result = await resolveStarterProvider(sdb);
    assert.deepEqual(result, { providerId: FIRST_RUN_DEFAULT_ID, modelId: FIRST_RUN_DEFAULT_ID });
  } finally {
    cleanup();
  }
});

test("resolveStarterProvider: falls back to the newest enabled provider with a model when no native default row exists", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    await insertProvider(sdb, { id: "cloud-x", models: [{ id: "gpt-x" }] });
    const result = await resolveStarterProvider(sdb);
    assert.deepEqual(result, { providerId: "cloud-x", modelId: "gpt-x" });
  } finally {
    cleanup();
  }
});

test("resolveStarterProvider: a provider with empty models[] is unusable -> null", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    await insertProvider(sdb, { id: "no-auto-provider", models: [] });
    const result = await resolveStarterProvider(sdb);
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

test("resolveStarterProvider: no provider rows -> null", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    const result = await resolveStarterProvider(sdb);
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

// ── createStarterArtifacts ───────────────────────────────────────────────────

test("createStarterArtifacts: no provider -> {error:'no_provider'} and creates nothing", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    const result = await createStarterArtifacts(sdb, { lang: "en" });
    assert.deepEqual(result, { error: "no_provider" });
    const bots = await sdb.execute({ sql: "SELECT COUNT(*) n FROM pi_bot_defs", args: [] });
    assert.equal(Number(bots.rows[0].n), 0);
    const convs = await sdb.execute({ sql: "SELECT COUNT(*) n FROM chat_conversations", args: [] });
    assert.equal(Number(convs.rows[0].n), 0);
  } finally {
    cleanup();
  }
});

test("createStarterArtifacts: creates a bot def + conversation, and is idempotent on a second call", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    await insertProvider(sdb, { id: FIRST_RUN_DEFAULT_ID, models: [{ id: FIRST_RUN_DEFAULT_ID }] });

    const first = await createStarterArtifacts(sdb, { lang: "en" });
    assert.equal(first.botId, STARTER_BOT_ID);
    assert.equal(first.providerId, FIRST_RUN_DEFAULT_ID);
    assert.equal(first.modelId, FIRST_RUN_DEFAULT_ID);
    assert.ok(Number.isInteger(first.conversationId));

    const botsAfterFirst = await sdb.execute({ sql: "SELECT COUNT(*) n FROM pi_bot_defs", args: [] });
    assert.equal(Number(botsAfterFirst.rows[0].n), 1);
    const convsAfterFirst = await sdb.execute({ sql: "SELECT COUNT(*) n FROM chat_conversations", args: [] });
    assert.equal(Number(convsAfterFirst.rows[0].n), 1);

    const second = await createStarterArtifacts(sdb, { lang: "en" });
    assert.deepEqual(second, first);

    const botsAfterSecond = await sdb.execute({ sql: "SELECT COUNT(*) n FROM pi_bot_defs", args: [] });
    assert.equal(Number(botsAfterSecond.rows[0].n), 1);
    const convsAfterSecond = await sdb.execute({ sql: "SELECT COUNT(*) n FROM chat_conversations", args: [] });
    assert.equal(Number(convsAfterSecond.rows[0].n), 1);
  } finally {
    cleanup();
  }
});

test("createStarterArtifacts: bot definition is a well-formed pi memory-tooled def; conversation shares its system_prompt", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    await insertProvider(sdb, { id: FIRST_RUN_DEFAULT_ID, models: [{ id: FIRST_RUN_DEFAULT_ID }] });
    const result = await createStarterArtifacts(sdb, { lang: "en" });

    const botRow = await sdb.execute({
      sql: "SELECT definition, display_name FROM pi_bot_defs WHERE bot_id = ?",
      args: [STARTER_BOT_ID],
    });
    assert.equal(botRow.rows.length, 1);
    const def = JSON.parse(botRow.rows[0].definition);
    assert.equal(def.engine, "pi");
    assert.ok(def.tools.crow_mcp.includes("crow-memory/crow_recall_by_context"));
    assert.equal(def.models.default, `${FIRST_RUN_DEFAULT_ID}/${FIRST_RUN_DEFAULT_ID}`);
    assert.equal(botRow.rows[0].display_name, "My Crow");
    assert.ok(def.system_prompt && def.system_prompt.length > 0);

    const convRow = await sdb.execute({
      sql: "SELECT title, provider, model, system_prompt FROM chat_conversations WHERE id = ?",
      args: [result.conversationId],
    });
    assert.equal(convRow.rows.length, 1);
    assert.equal(convRow.rows[0].title, "Chat with your Crow");
    assert.equal(convRow.rows[0].provider, FIRST_RUN_DEFAULT_ID);
    assert.equal(convRow.rows[0].model, FIRST_RUN_DEFAULT_ID);
    assert.ok(convRow.rows[0].system_prompt && convRow.rows[0].system_prompt.length > 0);
    assert.equal(convRow.rows[0].system_prompt, def.system_prompt);
  } finally {
    cleanup();
  }
});

test("createStarterArtifacts: idempotency survives via dashboard_settings even if resolveStarterProvider's inputs later change", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    await insertProvider(sdb, { id: "cloud-x", models: [{ id: "gpt-x" }] });
    const first = await createStarterArtifacts(sdb, { lang: "en" });
    assert.equal(first.providerId, "cloud-x");

    // A newer provider row now exists; without the dashboard_settings gate
    // this would resolve to a different provider on a naive re-run.
    await insertProvider(sdb, { id: FIRST_RUN_DEFAULT_ID, models: [{ id: FIRST_RUN_DEFAULT_ID }] });
    const second = await createStarterArtifacts(sdb, { lang: "en" });
    assert.deepEqual(second, first);

    const convs = await sdb.execute({ sql: "SELECT COUNT(*) n FROM chat_conversations", args: [] });
    assert.equal(Number(convs.rows[0].n), 1);
  } finally {
    cleanup();
  }
});

test("resolveStarterProvider falls through when the first_run_default row is disabled", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    // Disabled first-run default provider — should be skipped.
    await insertProvider(sdb, { id: FIRST_RUN_DEFAULT_ID, models: [{ id: FIRST_RUN_DEFAULT_ID }], disabled: 1 });
    // Enabled fallback provider.
    await insertProvider(sdb, { id: "cloud-x", models: [{ id: "gpt-x" }] });

    const result = await resolveStarterProvider(sdb);
    // Must pick the enabled provider, not the disabled first-run default.
    assert.deepEqual(result, { providerId: "cloud-x", modelId: "gpt-x" });
  } finally {
    cleanup();
  }
});

test("createStarterArtifacts recreates the conversation when starter_conversation_id points at a deleted row", async () => {
  const { db: sdb, cleanup } = makeScratchDb();
  try {
    await insertProvider(sdb, { id: FIRST_RUN_DEFAULT_ID, models: [{ id: FIRST_RUN_DEFAULT_ID }] });

    // First run: creates bot + conversation.
    const first = await createStarterArtifacts(sdb, { lang: "en" });
    const firstConvId = first.conversationId;
    assert.ok(Number.isInteger(firstConvId));

    // Verify initial state: 1 bot, 1 conversation.
    const botsAfterFirst = await sdb.execute({ sql: "SELECT COUNT(*) n FROM pi_bot_defs", args: [] });
    assert.equal(Number(botsAfterFirst.rows[0].n), 1);
    const convsAfterDelete = await sdb.execute({ sql: "SELECT COUNT(*) n FROM chat_conversations", args: [] });
    assert.equal(Number(convsAfterDelete.rows[0].n), 1);

    // Delete the conversation row (simulating operator cleanup or DB inconsistency).
    await sdb.execute({
      sql: "DELETE FROM chat_conversations WHERE id = ?",
      args: [firstConvId],
    });

    // Verify the row is gone.
    const convsAfterDeleteVerify = await sdb.execute({
      sql: "SELECT COUNT(*) n FROM chat_conversations",
      args: [],
    });
    assert.equal(Number(convsAfterDeleteVerify.rows[0].n), 0);

    // Second run: should recreate conversation with a NEW id (not re-use the deleted id).
    const second = await createStarterArtifacts(sdb, { lang: "en" });
    const secondConvId = second.conversationId;

    // Must have created a new conversation (different id).
    assert.notEqual(secondConvId, firstConvId);
    assert.ok(Number.isInteger(secondConvId));

    // Verify new conversation row exists.
    const convsAfterSecond = await sdb.execute({
      sql: "SELECT COUNT(*) n FROM chat_conversations WHERE id = ?",
      args: [secondConvId],
    });
    assert.equal(Number(convsAfterSecond.rows[0].n), 1);

    // Verify no duplicate bot was created (still 1 bot row).
    const botsAfterSecond = await sdb.execute({ sql: "SELECT COUNT(*) n FROM pi_bot_defs", args: [] });
    assert.equal(Number(botsAfterSecond.rows[0].n), 1);
  } finally {
    cleanup();
  }
});
