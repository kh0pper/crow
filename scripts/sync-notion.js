#!/usr/bin/env node
/**
 * Sync Notion pages into Crow's memory store for local semantic search.
 *
 * Notion's own MCP only does keyword search, and Crow's semantic search runs
 * over the `memories` table — not over Notion live. This script bridges the two:
 * it fetches every page shared with your Notion integration, converts it to
 * Markdown, and stores it as a memory (category=learning, tags=notion,sync).
 * The existing embedding pipeline (grackle-embed by default) then makes the
 * content semantically searchable via crow_search_memories / crow_deep_recall.
 *
 * Idempotent: dedups on `source = "notion:<pageId>"` and only re-embeds a page
 * when its Notion `last_edited_time` changed. Inert when NOTION_TOKEN is unset,
 * so instances that pull this script but don't use Notion are unaffected.
 *
 * Usage:
 *   node scripts/sync-notion.js --once               # one full sync pass
 *   node scripts/sync-notion.js --once --dry-run     # show insert/update/skip, no writes
 *   node scripts/sync-notion.js --once --limit 5     # cap pages (for testing)
 *   node scripts/sync-notion.js --once --force       # re-embed every page regardless of last_edited_time
 *
 * Requires NOTION_TOKEN in the environment (e.g. node --env-file=.env ...).
 */

import { createDbClient } from "../servers/db.js";
import {
  embedText,
  embedProviderInfo,
  upsertMemoryEmbedding,
} from "../servers/memory/embeddings.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const THROTTLE_MS = 350; // Notion allows ~3 req/s
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONTENT_CHARS = 50_000; // memories.content storage cap
const MAX_EMBED_CHARS = 8_000; // matches backfill-embeddings.js

const MEMORY_CATEGORY = "learning";
const MEMORY_TAGS = "notion,sync";
const MEMORY_IMPORTANCE = 4; // just below default 5 so bulk imports don't outrank hand-curated memories

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------------
// Pure helpers (exported for tests)
// ----------------------------------------------------------------------

/** Concatenate a Notion rich_text array into plain text. */
export function richTextToPlain(rich) {
  if (!Array.isArray(rich)) return "";
  return rich.map((r) => r?.plain_text ?? r?.text?.content ?? "").join("");
}

/** Render a single Notion block (and its children, indented) to Markdown. */
export function blockToMarkdown(block, depth = 0) {
  const indent = "  ".repeat(depth);
  const type = block?.type;
  const data = (type && block[type]) || {};
  const text = richTextToPlain(data.rich_text);

  let line = "";
  switch (type) {
    case "paragraph": line = text; break;
    case "heading_1": line = `# ${text}`; break;
    case "heading_2": line = `## ${text}`; break;
    case "heading_3": line = `### ${text}`; break;
    case "bulleted_list_item": line = `- ${text}`; break;
    case "numbered_list_item": line = `1. ${text}`; break;
    case "to_do": line = `- [${data.checked ? "x" : " "}] ${text}`; break;
    case "quote": line = `> ${text}`; break;
    case "callout": line = `> ${text}`; break;
    case "toggle": line = `- ${text}`; break;
    case "code": line = "```" + (data.language || "") + "\n" + text + "\n```"; break;
    case "divider": line = "---"; break;
    default: line = text; break; // unknown types: best-effort plain text
  }

  const lines = [];
  if (line !== "") lines.push(indent + line);
  if (Array.isArray(block.children)) {
    for (const child of block.children) {
      const sub = blockToMarkdown(child, depth + 1);
      if (sub !== "") lines.push(sub);
    }
  }
  return lines.join("\n");
}

/** Render a list of top-level blocks to Markdown. */
export function blocksToMarkdown(blocks, depth = 0) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => blockToMarkdown(b, depth))
    .filter((s) => s !== "")
    .join("\n\n");
}

/** Extract a page's title from its properties (the `title`-type property). */
export function extractTitle(page) {
  const props = page?.properties || {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p && p.type === "title") {
      return richTextToPlain(p.title) || "Untitled";
    }
  }
  return "Untitled";
}

/**
 * Decide what to do with a page given the existing memory row (if any).
 * Returns "insert" | "update" | "skip". Pure + testable.
 */
export function decideAction(existingRow, page, { force = false } = {}) {
  if (!existingRow) return "insert";
  if (force) return "update";
  let stored = null;
  try {
    stored = JSON.parse(existingRow.context || "{}").last_edited_time;
  } catch {
    stored = null;
  }
  return stored === page?.last_edited_time ? "skip" : "update";
}

/** Build the memory content blob for a page. */
export function buildContent(title, markdown) {
  return `# ${title}\n\n${markdown}`.slice(0, MAX_CONTENT_CHARS);
}

/** Build the provenance/context JSON stored alongside the memory. */
export function buildContext(page, title) {
  return JSON.stringify({
    notion_page_id: page.id,
    notion_url: page.url,
    last_edited_time: page.last_edited_time,
    title,
    chunk: 0,
  });
}

// ----------------------------------------------------------------------
// Notion REST client (network)
// ----------------------------------------------------------------------

async function notionFetch(token, path, { method = "GET", body } = {}) {
  const url = path.startsWith("http") ? path : `${NOTION_API}${path}`;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after")) || attempt + 1;
        lastErr = new Error(`Notion HTTP ${res.status}`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Notion HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      await sleep((attempt + 1) * 500);
    }
  }
  throw lastErr || new Error("Notion request failed");
}

/**
 * A page whose parent is a database is a database row (e.g. a calendar cell or
 * tracker entry) — usually low-signal noise for semantic search. Exported for tests.
 */
export function isDatabaseRow(page) {
  return page?.parent?.type === "database_id";
}

/** Enumerate pages shared with the integration. Skips database-row pages unless includeDbRows. */
async function searchPages(token, { limit, includeDbRows = false } = {}) {
  const pages = [];
  let dbRowsSkipped = 0;
  let cursor;
  do {
    const body = { filter: { value: "page", property: "object" }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(token, "/search", { method: "POST", body });
    for (const r of data.results || []) {
      if (r.object !== "page") continue;
      if (!includeDbRows && isDatabaseRow(r)) { dbRowsSkipped++; continue; }
      pages.push(r);
      if (limit && pages.length >= limit) return { pages: pages.slice(0, limit), dbRowsSkipped };
    }
    cursor = data.has_more ? data.next_cursor : null;
    if (cursor) await sleep(THROTTLE_MS);
  } while (cursor);
  return { pages, dbRowsSkipped };
}

/** Fetch a block's children recursively, attaching `children` arrays. */
async function fetchBlockChildren(token, blockId) {
  const blocks = [];
  let cursor;
  do {
    const qs = cursor
      ? `?start_cursor=${cursor}&page_size=100`
      : "?page_size=100";
    const data = await notionFetch(token, `/blocks/${blockId}/children${qs}`);
    for (const block of data.results || []) {
      if (block.has_children) {
        await sleep(THROTTLE_MS);
        block.children = await fetchBlockChildren(token, block.id);
      }
      blocks.push(block);
    }
    cursor = data.has_more ? data.next_cursor : null;
    if (cursor) await sleep(THROTTLE_MS);
  } while (cursor);
  return blocks;
}

async function fetchPageMarkdown(token, pageId) {
  const blocks = await fetchBlockChildren(token, pageId);
  return blocksToMarkdown(blocks);
}

// ----------------------------------------------------------------------
// Sync driver
// ----------------------------------------------------------------------

/**
 * Run one full sync pass.
 *
 * @param {object} [opts]
 * @param {string} [opts.token]   — Notion token (defaults to process.env.NOTION_TOKEN)
 * @param {object} [opts.db]      — caller-provided db client; created/closed locally if omitted
 * @param {number|null} [opts.limit]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.force]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ok, skipped, inserted, updated, unchanged, embedded, ftsOnly, failed}>}
 */
export async function runSync(opts = {}) {
  const token = opts.token ?? process.env.NOTION_TOKEN;
  const { limit = null, dryRun = false, force = false, includeDbRows = false } = opts;
  const logger = opts.log ?? console.log;
  const log = (msg) => logger(msg);
  log.error = (msg) => (opts.logError ?? console.error)(msg);

  const stats = {
    ok: true, skipped: false,
    inserted: 0, updated: 0, unchanged: 0, embedded: 0, ftsOnly: 0, failed: 0,
  };

  if (!token) {
    log("NOTION_TOKEN not set — nothing to sync, skipping.");
    stats.skipped = true;
    return stats;
  }

  const info = await embedProviderInfo();
  if (info.ok) {
    log(`embed provider=${info.provider} model=${info.model}`);
  } else {
    log(`embed provider offline (${info.error}) — storing FTS-only; run 'node scripts/backfill-embeddings.js --only memories' once it's back`);
  }

  const ownsDb = !opts.db;
  const db = opts.db ?? createDbClient();
  try {
    const { pages, dbRowsSkipped } = await searchPages(token, { limit, includeDbRows });
    log(`found ${pages.length} content page(s)` + (dbRowsSkipped ? `, skipped ${dbRowsSkipped} database-row page(s)` : ""));

    for (const page of pages) {
      const title = extractTitle(page);
      try {
        const key = `notion:${page.id}`;
        const { rows } = await db.execute({
          sql: "SELECT id, context FROM memories WHERE source = ? LIMIT 1",
          args: [key],
        });
        const existing = rows[0];
        const action = decideAction(existing, page, { force });

        if (action === "skip") {
          stats.unchanged++;
          continue;
        }
        if (dryRun) {
          log(`  [dry-run] ${action}: ${title}`);
          if (action === "insert") stats.inserted++;
          else stats.updated++;
          continue;
        }

        const markdown = await fetchPageMarkdown(token, page.id);
        const content = buildContent(title, markdown);
        const context = buildContext(page, title);

        let id;
        if (action === "insert") {
          const r = await db.execute({
            sql: "INSERT INTO memories (content, category, context, tags, source, importance) VALUES (?, ?, ?, ?, ?, ?)",
            args: [content, MEMORY_CATEGORY, context, MEMORY_TAGS, key, MEMORY_IMPORTANCE],
          });
          id = Number(r.lastInsertRowid);
          stats.inserted++;
        } else {
          await db.execute({
            sql: "UPDATE memories SET content = ?, context = ?, updated_at = datetime('now') WHERE id = ?",
            args: [content, context, existing.id],
          });
          id = existing.id;
          stats.updated++;
        }

        if (info.ok) {
          try {
            const vec = await embedText(content.slice(0, MAX_EMBED_CHARS));
            if (vec?.length) {
              await upsertMemoryEmbedding(db, id, vec, { model: info.model, dim: vec.length });
              stats.embedded++;
            } else {
              stats.ftsOnly++;
            }
          } catch (err) {
            log.error(`  embed failed "${title}": ${err.message}`);
            stats.ftsOnly++;
          }
        } else {
          stats.ftsOnly++;
        }

        log(`  ${action}: ${title}`);
        await sleep(THROTTLE_MS);
      } catch (err) {
        stats.failed++;
        stats.ok = false; // surface partial failures in the CLI exit code (cron/monitoring)
        log.error(`  FAILED "${title}" (${page?.id}): ${err.message}`);
      }
    }
  } finally {
    if (ownsDb) {
      try { db.close?.(); } catch {}
    }
  }

  log(
    `done — inserted=${stats.inserted} updated=${stats.updated} ` +
    `unchanged=${stats.unchanged} embedded=${stats.embedded} ` +
    `fts-only=${stats.ftsOnly} failed=${stats.failed}`
  );
  return stats;
}

// ----------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------

function parseArgs(argv) {
  const out = { limit: null, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--once") out.once = true; // single pass is the only mode; accepted for clarity
    else if (a === "--include-db-rows") out.includeDbRows = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("sync-notion — mirror Notion pages into Crow memory for semantic search");
    console.log("  --once          run a single sync pass (default behavior)");
    console.log("  --dry-run       show insert/update/skip decisions without writing");
    console.log("  --limit N       cap the number of pages (for testing)");
    console.log("  --force         re-embed every page regardless of last_edited_time");
    console.log("  --include-db-rows  also sync database-row pages (default: skip them)");
    console.log("\nRequires NOTION_TOKEN in the environment.");
    process.exit(0);
  }
  const result = await runSync({
    limit: args.limit,
    dryRun: args.dryRun,
    force: args.force,
    includeDbRows: args.includeDbRows,
  });
  if (!result.ok) process.exit(1);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  });
}
