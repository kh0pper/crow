// Inbound "source" share (servers/sharing/boot.js): a contact sent us a reference. It is stored
// as a project-less, unverified row with fetch_status left NULL, which reads as unknown and never
// citable; the user opens it with crow_add_source before citing it.
//
// This runs inside initSharingRuntime, which the stdio crow-sharing server starts without
// ensureProvenanceSchema, so the INSERT must not name any migration-0013 column: it has to work
// on a pre-0013 DB during the deploy window.
import { SOURCE_TYPES } from "../research/source-types.js";

const TITLE_MAX = 1000;
// abstract / content_summary cap for peer-supplied rows (content_summary is FTS-indexed); the
// project clone import uses the same value.
export const SHARED_SUMMARY_MAX = 50000;
// citation_apa cap for peer-supplied rows (also indexed in sources_fts).
export const SHARED_CITATION_MAX = 2000;

/** The first non-empty string among the values, else null. */
function firstString(...values) {
  for (const v of values) if (typeof v === "string" && v) return v;
  return null;
}

/** Cap a peer-supplied string at max chars, marking the cut. */
function capShared(value, max) {
  return value && value.length > max
    ? `${value.slice(0, max)}\n[truncated at share import: original ${value.length} chars]`
    : value;
}

/**
 * @param {{execute: Function}} db
 * @param {{title?, url?, source_type?, citation_apa?, content_summary?, citation?, notes?}} payload
 * @returns {Promise<number>} the new row id
 */
export async function insertSharedSource(db, payload = {}) {
  const p = payload || {};
  // S4: cap peer-controlled title at 1000 chars — title is FTS5-indexed
  // (research_sources_fts trigger in init-db.js) and is peer-supplied.
  const rawTitle = typeof p.title === "string" && p.title ? p.title : "Shared source";
  const title = rawTitle.length > TITLE_MAX ? rawTitle.slice(0, TITLE_MAX) : rawTitle;
  const sourceType = SOURCE_TYPES.includes(p.source_type) ? p.source_type : "other";
  const citation = capShared(firstString(p.citation_apa, p.citation), SHARED_CITATION_MAX) ?? "(no citation)";
  const notes = capShared(firstString(p.content_summary, p.notes), SHARED_SUMMARY_MAX);
  const url = typeof p.url === "string" && p.url ? p.url : null;

  const result = await db.execute({
    sql: `INSERT INTO research_sources (project_id, title, url, source_type, citation_apa, content_summary, verified)
          VALUES (NULL, ?, ?, ?, ?, ?, 0)`,
    args: [title, url, sourceType, citation, notes],
  });
  return Number(result.lastInsertRowid);
}
