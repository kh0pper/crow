// Inbound "source" share (servers/sharing/boot.js): a contact sent us a reference. It is stored
// as a project-less, unverified row with fetch_status left NULL, which reads as unknown and never
// citable; the user opens it with crow_add_source before citing it.
//
// This runs inside initSharingRuntime, which the stdio crow-sharing server starts without
// ensureProvenanceSchema, so the INSERT must not name any migration-0013 column: it has to work
// on a pre-0013 DB during the deploy window.
import { SOURCE_TYPES } from "../research/source-types.js";

const TITLE_MAX = 1000;

/**
 * @param {{execute: Function}} db
 * @param {{title?: string, url?: string, source_type?: string, citation?: string, notes?: string}} payload
 * @returns {Promise<number>} the new row id
 */
export async function insertSharedSource(db, payload = {}) {
  const p = payload || {};
  // S4: cap peer-controlled title at 1000 chars — title is FTS5-indexed
  // (research_sources_fts trigger in init-db.js) and is peer-supplied.
  const rawTitle = typeof p.title === "string" && p.title ? p.title : "Shared source";
  const title = rawTitle.length > TITLE_MAX ? rawTitle.slice(0, TITLE_MAX) : rawTitle;
  const sourceType = SOURCE_TYPES.includes(p.source_type) ? p.source_type : "other";
  const citation = typeof p.citation === "string" && p.citation ? p.citation : "(no citation)";
  const notes = typeof p.notes === "string" && p.notes ? p.notes : null;
  const url = typeof p.url === "string" && p.url ? p.url : null;

  const result = await db.execute({
    sql: `INSERT INTO research_sources (project_id, title, url, source_type, citation_apa, content_summary, verified)
          VALUES (NULL, ?, ?, ?, ?, ?, 0)`,
    args: [title, url, sourceType, citation, notes],
  });
  return Number(result.lastInsertRowid);
}
