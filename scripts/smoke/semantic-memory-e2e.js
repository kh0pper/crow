#!/usr/bin/env node
/**
 * Phase 4 end-to-end smoke: store memories, verify embeddings written,
 * query with semantic search, verify semantic-only query matches.
 *
 * Uses the memory server factory directly (no MCP transport).
 */

import { createMemoryServer } from "../../servers/memory/server.js";
import { createDbClient } from "../../servers/db.js";

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

const db = await createDbClient();
// Clean up test memories from any prior run
await db.execute({ sql: "DELETE FROM memories WHERE source = 'phase4-smoke'", args: [] });

// Build the server (we won't actually invoke via MCP; we'll read/write DB directly
// and exercise the embedder via the same hook that crow_store_memory uses).
const server = createMemoryServer();
void server;

// -- Step 1: Insert 3 memories with contrasting content, let the write hook embed them --
// We replicate what crow_store_memory does: INSERT then call storeEmbedding.
// Since storeEmbedding is internal to the factory closure, we just call the embedder
// path directly via our public modules (same thing, easier to test).

import { embedText, embedProviderInfo, upsertMemoryEmbedding, loadMemoryEmbeddings, rankByCosine } from "../../servers/memory/embeddings.js";
import { rerank } from "../../servers/memory/rerank.js";

const info = await embedProviderInfo();
if (!info.ok) fail(`provider down: ${info.error}`);

const sampleMemories = [
  { content: "Crow's orchestrator routes agents to different LLM providers based on role.", category: "project" },
  { content: "My favorite color is blue and I like to go hiking on Saturdays.", category: "preference" },
  { content: "vLLM serves OpenAI-compatible endpoints for embeddings, reranking, and chat.", category: "learning" },
];

const ids = [];
for (const m of sampleMemories) {
  const r = await db.execute({
    sql: "INSERT INTO memories (content, category, importance, source) VALUES (?, ?, 5, 'phase4-smoke')",
    args: [m.content, m.category],
  });
  const id = Number(r.lastInsertRowid);
  ids.push(id);
  const vec = await embedText(m.content);
  await upsertMemoryEmbedding(db, id, vec, { model: info.model, dim: vec.length });
}
console.log(`  inserted ${ids.length} memories with embeddings: ids=${ids.join(",")}`);

// -- Step 2: Load embeddings back, verify all 3 present --
const loaded = await loadMemoryEmbeddings(db);
const loadedIds = new Set(loaded.map((e) => e.memory_id));
for (const id of ids) if (!loadedIds.has(id)) fail(`embedding not persisted for memory ${id}`);
console.log(`  verified ${loaded.length} embeddings in memory_embeddings_blob`);

// -- Step 3: Semantic query that has NO keyword overlap with the project doc --
// Query: "agent dispatch"  — no word appears literally in any content, but semantically it maps to
// "Crow's orchestrator routes agents to different LLM providers based on role."
const query = "agent dispatch";
const qvec = await embedText(query);
const ranked = rankByCosine(qvec, loaded, 10);
console.log("  cosine ranking for 'agent dispatch':");
for (const r of ranked) {
  // Fetch content for display
  const { rows } = await db.execute({ sql: "SELECT content FROM memories WHERE id = ?", args: [r.memory_id] });
  console.log(`    ${r.score.toFixed(3)}  [${r.memory_id}]  ${rows[0]?.content?.slice(0, 60)}...`);
}

// Project memory (index 0 in sampleMemories, ids[0]) should rank first
if (ranked[0].memory_id !== ids[0]) fail(`expected project memory (id=${ids[0]}) to rank first, got ${ranked[0].memory_id}`);
console.log(`  ✓ semantic search matched the project memory without keyword overlap`);

// -- Step 4: Rerank pass --
const rerankInputs = ranked.map((r, i) => {
  return { id: r.memory_id, text: sampleMemories.find((_, idx) => ids[idx] === r.memory_id)?.content || "" };
});
const rr = await rerank(query, rerankInputs, { topK: 3 });
console.log(`  reranker top-3:`);
for (const r of rr) {
  console.log(`    ${(r.relevance ?? -1).toFixed(3)}  [${r.id}]  ${r.text.slice(0, 60)}...`);
}
if (rr[0].id !== ids[0]) fail(`reranker disagreed with cosine: expected id=${ids[0]} first`);
console.log(`  ✓ reranker concurred`);

// Cleanup
await db.execute({ sql: "DELETE FROM memories WHERE source = 'phase4-smoke'", args: [] });

console.log("\nPASS: Phase 4 end-to-end verified");
process.exit(0);
