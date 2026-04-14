#!/usr/bin/env node
/**
 * Backfill embeddings for existing memories (and optionally sources, notes,
 * blog posts) that don't have a Phase 4 BLOB entry yet.
 *
 * Idempotent: skips rows already embedded with the current provider's model.
 * Batches embedding requests (16 per call by default) to amortize HTTP round-trips.
 *
 * Usage:
 *   node scripts/backfill-embeddings.js               # backfill all content types
 *   node scripts/backfill-embeddings.js --only memories
 *   node scripts/backfill-embeddings.js --batch-size 32
 */

import { createDbClient } from "../servers/db.js";
import {
  embedText,
  embedProviderInfo,
  upsertMemoryEmbedding,
  sourceEmbeddings,
  noteEmbeddings,
  blogEmbeddings,
  vecToBlob,
} from "../servers/memory/embeddings.js";

function parseArgs(argv) {
  const out = { only: null, batchSize: 16, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = argv[++i];
    else if (a === "--batch-size") out.batchSize = parseInt(argv[++i], 10);
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function backfillMemories(db, { batchSize, limit, model }) {
  const limitClause = limit ? ` LIMIT ${limit}` : "";
  const { rows } = await db.execute(`
    SELECT m.id, m.content
    FROM memories m
    LEFT JOIN memory_embeddings_blob e ON e.memory_id = m.id AND e.model = '${model.replace(/'/g, "''")}'
    WHERE e.memory_id IS NULL AND m.content IS NOT NULL AND length(m.content) > 0
    ORDER BY m.id DESC${limitClause}
  `);
  if (rows.length === 0) { console.log("  memories: already backfilled"); return 0; }
  console.log(`  memories: ${rows.length} to embed`);
  return embedBatch(rows, batchSize, async (row, vec) => {
    await upsertMemoryEmbedding(db, row.id, vec, { model, dim: vec.length });
  });
}

function makeGenericBackfill(kindLabel, helpers, table, fk, contentSql) {
  return async function backfill(db, { batchSize, limit, model }) {
    const limitClause = limit ? ` LIMIT ${limit}` : "";
    const { rows } = await db.execute(`
      SELECT s.id, ${contentSql} AS content
      FROM ${table} s
      LEFT JOIN ${helpers._tableName} e ON e.${fk} = s.id AND e.model = '${model.replace(/'/g, "''")}'
      WHERE e.${fk} IS NULL AND ${contentSql} IS NOT NULL AND length(${contentSql}) > 0
      ORDER BY s.id DESC${limitClause}
    `);
    if (rows.length === 0) { console.log(`  ${kindLabel}: already backfilled`); return 0; }
    console.log(`  ${kindLabel}: ${rows.length} to embed`);
    return embedBatch(rows, batchSize, async (row, vec) => {
      await helpers.upsert(db, row.id, vec, { model, dim: vec.length });
    });
  };
}

// Attach table names to the helper objects (local convenience)
sourceEmbeddings._tableName = "source_embeddings";
noteEmbeddings._tableName = "note_embeddings";
blogEmbeddings._tableName = "blog_post_embeddings";

async function embedBatch(rows, batchSize, writeFn) {
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const texts = batch.map((r) => String(r.content || "").slice(0, 8000));
    const vecs = await embedText(texts).catch((err) => {
      console.error(`  embed batch failed @${i}: ${err.message}`);
      return null;
    });
    if (!vecs) continue;
    for (let j = 0; j < batch.length; j++) {
      try {
        await writeFn(batch[j], vecs[j]);
        done++;
      } catch (err) {
        console.error(`  write failed id=${batch[j].id}: ${err.message}`);
      }
    }
    process.stdout.write(`.${done % 10 === 0 ? `(${done})` : ""}`);
  }
  process.stdout.write("\n");
  return done;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("backfill-embeddings — populate Phase 4 embedding tables");
    console.log("  --only memories|sources|notes|blog    restrict to one content type");
    console.log("  --batch-size N                        embeddings per HTTP call (default 16)");
    console.log("  --limit N                             cap rows per content type (for testing)");
    process.exit(0);
  }

  const info = await embedProviderInfo();
  if (!info.ok) {
    console.error(`FAIL: embedding provider unhealthy: ${info.error}`);
    process.exit(1);
  }
  console.log(`provider=${info.provider} model=${info.model} baseUrl=${info.baseUrl}`);

  const db = await createDbClient();
  try {
    const tasks = [
      ["memories", () => backfillMemories(db, { ...args, model: info.model })],
      ["sources", makeGenericBackfill("sources", sourceEmbeddings, "research_sources", "source_id",
        "COALESCE(s.title, '') || ' ' || COALESCE(s.abstract, '') || ' ' || COALESCE(s.content_summary, '')")],
      ["notes", makeGenericBackfill("notes", noteEmbeddings, "research_notes", "note_id",
        "COALESCE(s.content, '')")],
      ["blog", makeGenericBackfill("blog", blogEmbeddings, "blog_posts", "post_id",
        "COALESCE(s.title, '') || ' ' || COALESCE(s.excerpt, '') || ' ' || COALESCE(s.content, '')")],
    ];

    let total = 0;
    for (const [kind, fn] of tasks) {
      if (args.only && args.only !== kind) continue;
      try {
        const n = typeof fn === "function" && fn.length <= 1
          ? await fn(db, { ...args, model: info.model })
          : await fn();
        total += n || 0;
      } catch (err) {
        console.error(`  ${kind}: error ${err.message}`);
      }
    }
    console.log(`\ntotal embedded: ${total}`);
  } finally {
    try { db.close?.(); } catch {}
  }
}

main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
