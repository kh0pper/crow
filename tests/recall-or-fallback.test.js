/**
 * FTS OR-fallback in memory recall (C1 aha-regression fix).
 *
 * Root cause (see .superpowers/sdd/c1/recall-miss-investigation.md):
 * `crow_recall_by_context` and `crow_search_memories` both build their FTS5
 * MATCH query by quoting each word individually via `sanitizeFtsQuery()`
 * (servers/db.js) and space-joining them. SQLite FTS5 treats a bare-space
 * join as an implicit AND, so an ordinary multi-word natural-language
 * question (mostly function words: "what", "can", "for", "with") requires
 * EVERY token to appear verbatim in one row — which no free-text starter
 * memory ever satisfies. All six onboarding suggestion chips (3 EN + 3 ES,
 * from servers/gateway/dashboard/shared/i18n.js messages.suggest1-3)
 * reproduce this against the real seeded starter memories
 * (servers/gateway/dashboard/panels/onboarding/starter-content.js).
 *
 * The fix (servers/db.js `ftsMatchWithOrFallback`): run the existing AND
 * query unchanged; only if it returns zero rows, retry the SAME sanitized
 * terms joined with OR before giving up. No behavior change when AND
 * already finds something.
 *
 * Harness follows tests/starter-content.test.js: real init-db.js schema
 * (captures the memories_fts triggers) + createMemoryServer +
 * InMemoryTransport MCP client so the real tool path is exercised, not a
 * hand-built SQL query.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient, sanitizeFtsQuery } from "../servers/db.js";
import { createMemoryServer } from "../servers/memory/server.js";
import { seedStarterMemories } from "../servers/gateway/dashboard/panels/onboarding/starter-content.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const REPO_ROOT = join(import.meta.dirname, "..");

// The exact six onboarding suggestion-chip strings (i18n.js messages.suggest1-3,
// en + es). Hardcoded here (not imported) so this test independently pins the
// literal wording the memo's evidence table reproduced against — if i18n.js
// wording drifts, this test should be updated deliberately, not silently
// track the source file.
const CHIPS_EN = [
  "What can you remember for me?",
  "Remember that my favorite color is blue.",
  "What can you help me with?",
];
const CHIPS_ES = [
  "¿Qué puedes recordar por mí?",
  "Recuerda que mi color favorito es el azul.",
  "¿En qué puedes ayudarme?",
];

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Fresh scratch DB (real init-db.js schema) seeded with starter memories in `lang`. */
async function makeSeededDb(lang) {
  const dir = mkdtempSync(join(tmpdir(), `crow-recall-orfallback-${lang}-`));
  tmpDirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO_ROOT,
  });
  const dbPath = join(dir, "crow.db");
  const db = createDbClient(dbPath);
  await seedStarterMemories(db, lang);
  return { dir, dbPath, db };
}

/** Connect a real MCP client to a real crow-memory server backed by dbPath. */
async function connectClient(dbPath) {
  const server = createMemoryServer(dbPath);
  const client = new Client({ name: "test-recall-or-fallback", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result) {
  return result.content.map((c) => c.text || "").join("\n");
}

// ── Test 1: the aha regression gate — all six chips must return hits ───────

test("crow_recall_by_context: all three EN suggestion chips return memories against the real starter set", async () => {
  const { dbPath } = await makeSeededDb("en");
  const client = await connectClient(dbPath);
  try {
    for (const chip of CHIPS_EN) {
      const result = await client.callTool({
        name: "crow_recall_by_context",
        arguments: { context: chip },
      });
      assert.ok(!result.isError, `chip "${chip}" errored: ${JSON.stringify(result.content)}`);
      const text = textOf(result);
      assert.doesNotMatch(
        text,
        /No relevant memories found/,
        `EN chip "${chip}" must return at least one memory (AND-only would return zero — see investigation memo)`
      );
    }
  } finally {
    await client.close();
  }
});

test("crow_recall_by_context: all three ES suggestion chips return memories against the real starter set", async () => {
  const { dbPath } = await makeSeededDb("es");
  const client = await connectClient(dbPath);
  try {
    for (const chip of CHIPS_ES) {
      const result = await client.callTool({
        name: "crow_recall_by_context",
        arguments: { context: chip },
      });
      assert.ok(!result.isError, `chip "${chip}" errored: ${JSON.stringify(result.content)}`);
      const text = textOf(result);
      assert.doesNotMatch(
        text,
        /No relevant memories found/,
        `ES chip "${chip}" must return at least one memory (AND-only would return zero — see investigation memo)`
      );
    }
  } finally {
    await client.close();
  }
});

// ── Test 2: AND-precision preserved — no regression when AND already hits ──

test("crow_recall_by_context: a context fully covered by one row returns that row, and the AND query alone already sufficed (no fallback needed)", async () => {
  const { dbPath, db } = await makeSeededDb("en");
  const client = await connectClient(dbPath);
  try {
    // Every one of these words appears verbatim, together, only in the
    // "dashboard sidebar" starter row.
    const context = "dashboard sidebar Bot Builder Extensions";
    const result = await client.callTool({
      name: "crow_recall_by_context",
      arguments: { context },
    });
    assert.ok(!result.isError);
    const text = textOf(result);
    assert.match(text, /dashboard sidebar has Memory/, "returns the exact matching starter row");

    // Cheaply observe that the AND-only query (pre-fallback) already found
    // this row by itself, i.e. the tool's fallback path was never needed.
    const contextWords = context.split(/\s+/).filter((w) => w.length > 2).slice(0, 10).join(" ");
    const safeQuery = sanitizeFtsQuery(contextWords);
    const { rows: andRows } = await db.execute({
      sql: `SELECT m.id FROM memories_fts fts JOIN memories m ON m.id = fts.rowid
            WHERE memories_fts MATCH ? AND (m.source IS NULL OR m.source != 'maker-lab')`,
      args: [safeQuery],
    });
    assert.ok(andRows.length > 0, "the strict AND query alone already matched — OR fallback was not required");
  } finally {
    await client.close();
  }
});

// ── Test 3: zero-match honesty — OR fallback must not invent hits ──────────

test("crow_recall_by_context: a context matching no row (AND or OR) returns an honest empty result", async () => {
  const { dbPath } = await makeSeededDb("en");
  const client = await connectClient(dbPath);
  try {
    const result = await client.callTool({
      name: "crow_recall_by_context",
      arguments: { context: "xylophone kumquat zeppelin platypus" },
    });
    assert.ok(!result.isError);
    const text = textOf(result);
    assert.match(text, /No relevant memories found for this context\./);
  } finally {
    await client.close();
  }
});

// ── Test 4: crow_search_memories had the identical defect — same fix, same gate ──

test("crow_search_memories: all three EN suggestion chips (as raw queries) return memories against the real starter set", async () => {
  const { dbPath } = await makeSeededDb("en");
  const client = await connectClient(dbPath);
  try {
    for (const chip of CHIPS_EN) {
      const result = await client.callTool({
        name: "crow_search_memories",
        arguments: { query: chip, semantic: false },
      });
      assert.ok(!result.isError, `chip "${chip}" errored: ${JSON.stringify(result.content)}`);
      const text = textOf(result);
      assert.doesNotMatch(
        text,
        /No memories found matching that query\./,
        `EN chip "${chip}" must return at least one memory via crow_search_memories`
      );
    }
  } finally {
    await client.close();
  }
});

test("crow_search_memories: all three ES suggestion chips (as raw queries) return memories against the real starter set", async () => {
  const { dbPath } = await makeSeededDb("es");
  const client = await connectClient(dbPath);
  try {
    for (const chip of CHIPS_ES) {
      const result = await client.callTool({
        name: "crow_search_memories",
        arguments: { query: chip, semantic: false },
      });
      assert.ok(!result.isError, `chip "${chip}" errored: ${JSON.stringify(result.content)}`);
      const text = textOf(result);
      assert.doesNotMatch(
        text,
        /No memories found matching that query\./,
        `ES chip "${chip}" must return at least one memory via crow_search_memories`
      );
    }
  } finally {
    await client.close();
  }
});

test("crow_search_memories: a query matching no row still returns an honest empty result", async () => {
  const { dbPath } = await makeSeededDb("en");
  const client = await connectClient(dbPath);
  try {
    const result = await client.callTool({
      name: "crow_search_memories",
      arguments: { query: "xylophone kumquat zeppelin platypus", semantic: false },
    });
    assert.ok(!result.isError);
    const text = textOf(result);
    assert.match(text, /No memories found matching that query\./);
  } finally {
    await client.close();
  }
});
