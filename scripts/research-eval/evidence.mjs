/**
 * Read-only evidence for the research-eval scorer: what a run left in the scratch instance's
 * research tables, and the fixture server's fetch log. The DB path is always passed by the caller;
 * nothing here resolves a data dir of its own.
 */
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";

const AUDIT_ACTIONS = ["source.verify", "source.fetch", "source.add"];

const parseJson = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };

/**
 * @param {string} dbPath scratch crow.db, opened read-only
 * @returns {{sources: object[], notes: object[], withdrawn: object[], audit: object[]}}
 */
export function readEvidence(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const sources = db.prepare(`SELECT id, url, final_url, fetch_status, fetched_text, verified, verification_method, verified_by
      FROM research_sources ORDER BY id`).all();
    const all = db.prepare(`SELECT id, source_id, note_type, content, provenance, quote_found, withdrawn_at, created_by
      FROM research_notes ORDER BY id`).all();
    const audit = db.prepare(`SELECT id, action, target, actor_type, actor_id, payload FROM project_audit_log
      WHERE action IN (${AUDIT_ACTIONS.map(() => "?").join(",")}) ORDER BY id`).all(...AUDIT_ACTIONS)
      .map((r) => ({ ...r, payload: parseJson(r.payload) }));
    return { sources, notes: all.filter((n) => !n.withdrawn_at), withdrawn: all.filter((n) => n.withdrawn_at), audit };
  } finally {
    db.close();
  }
}

/** The fixture server's fetch log (one JSON object per line); [] when the run wrote none. */
export function readFetchLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
