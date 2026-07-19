/**
 * starter-content.js — onboarding starter memories (C1/C3 Task 2).
 *
 *   seedStarterMemories(db, lang) inserts a handful of `source='starter'`
 *   rows into `memories` (idempotent — no-ops if any starter row exists).
 *   clearStarterMemories(db) deletes only those rows (used by Task 4's
 *   Settings > Help and Setup action).
 *   shouldSyncRow('memories', row) excludes source='starter' rows from
 *   instance-sync (starter/demo content is per-install, same convention as
 *   providers' gpu_policy.local_only).
 *
 * Harness follows tests/instance-sync.test.js: real init-db.js schema in a
 * tmp dir so the memories_fts triggers exist (FTS works with zero embedding
 * providers — memory/server.js:176-214).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { shouldSyncRowForTest } from "../servers/sharing/instance-sync.js";
import {
  STARTER_SOURCE,
  seedStarterMemories,
  clearStarterMemories,
} from "../servers/gateway/dashboard/panels/onboarding/starter-content.js";

// ── Shared setup ─────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "crow-startercontent-test-"));

execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
  cwd: join(import.meta.dirname, ".."),
});

const DB_PATH = join(tmpDir, "crow.db");
const db = createDbClient(DB_PATH);

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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
