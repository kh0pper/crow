/**
 * A read-only memory search, for pages that must never write on a GET (the
 * project home's "Where you left off", which Turbo prefetches on hover).
 *
 * The same FTS5 search crow_recall_by_context runs (sanitizeFtsQuery, an AND
 * match first and the OR fallback after), with one difference that matters:
 * it never touches accessed_at or access_count. crow_search_memories and
 * crow_deep_recall bump both on every hit; a page view is not a recall.
 */
import { sanitizeFtsQuery, ftsMatchWithOrFallback } from "../db.js";

const ABSENT_RE = /no such (table|column)/i;

/**
 * @param {object} db  a createDbClient() client
 * @param {string} query  free words (FTS operators are stripped)
 * @param {{projectId?:number|null, limit?:number, excludeSourcePrefix?:string|null}} [opts]
 * @returns {Promise<Array<{id:number, content:string, source:string|null}>>} best match first
 */
export async function recallMemoriesReadOnly(db, query, { projectId = null, limit = 3, excludeSourcePrefix = null } = {}) {
  const safe = sanitizeFtsQuery(String(query || ""));
  if (!safe) return [];
  let sql = `SELECT m.id, m.content, m.source FROM memories_fts fts
               JOIN memories m ON m.id = fts.rowid
              WHERE memories_fts MATCH ?
                AND (m.source IS NULL OR m.source != 'maker-lab')`;
  const args = [safe];
  if (projectId != null) { sql += " AND m.project_id = ?"; args.push(Number(projectId)); }
  if (excludeSourcePrefix) { sql += " AND (m.source IS NULL OR substr(m.source, 1, ?) != ?)"; args.push(excludeSourcePrefix.length, excludeSourcePrefix); }
  sql += " ORDER BY rank LIMIT ?";
  args.push(Math.max(1, Math.min(50, Number(limit) || 3)));
  try {
    const rows = await ftsMatchWithOrFallback(db, sql, args);
    return rows.map((r) => ({ id: Number(r.id), content: String(r.content ?? ""), source: r.source == null ? null : String(r.source) }));
  } catch (err) {
    if (ABSENT_RE.test(String(err && err.message))) return [];
    throw err;
  }
}
