/**
 * Comment loop (§3.3, I-6): who was in an editor session, and when. workspace_editor_sessions keeps one row per
 * ONLYOFFICE document key: the file, every uid ever seen in it (a union, so a coworker sampled once and gone still
 * taints the key) and the first/last time it was seen live. Times are epoch ms; a file mtime is epoch s.
 * Rows are written only after the key was confirmed against the document server (docSession(fileId).key === key).
 */
import { listRecent } from "../nc/dav.js";
import { docSession } from "../nc/onlyoffice.js";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const uniq = (uids) => [...new Set((uids || []).map(String).filter(Boolean))].sort();

/** Upsert: the uids are unioned, first_seen keeps the earliest and last_seen the latest. One statement. */
export async function recordSession(db, { key, fileId, uids, at }) {
  const json = JSON.stringify(uniq(uids));
  await db.execute({
    sql: `INSERT INTO workspace_editor_sessions(doc_key, file_id, uids_json, first_seen, last_seen) VALUES (?,?,?,?,?)
      ON CONFLICT(doc_key) DO UPDATE SET file_id=excluded.file_id, first_seen=MIN(first_seen, excluded.first_seen), last_seen=MAX(last_seen, excluded.last_seen),
      uids_json=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(workspace_editor_sessions.uids_json) UNION SELECT value FROM json_each(?) ORDER BY value))`,
    args: [String(key), Number(fileId), json, at, at, json],
  });
}

export async function sessionByKey(db, key) {
  return (await db.execute({ sql: "SELECT * FROM workspace_editor_sessions WHERE doc_key=?", args: [String(key)] })).rows[0] || null;
}

const uidsOf = (row) => { try { const v = JSON.parse(row?.uids_json || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

/** Was anyone but the owners ever seen in this session? No row → false. */
export function everNonOwner(row, ownerUids) {
  const owners = new Set((ownerUids || []).map(String));
  return uidsOf(row).some((u) => !owners.has(u));
}

/**
 * Was the file being edited by its owners alone at mtimeS? True only when at least one session row of the file
 * covers mtimeS (±slackS) and EVERY covering row lists owners only (an overlapping coworker session → false).
 */
export async function soleOwnerWindowAt(db, fileId, mtimeS, ownerUids, slackS = 30) {
  const t = Number(mtimeS) * 1000, slack = Number(slackS) * 1000;
  const rows = (await db.execute({ sql: "SELECT * FROM workspace_editor_sessions WHERE file_id=? AND first_seen-?<=? AND last_seen+?>=?", args: [Number(fileId), slack, t, slack, t] })).rows;
  if (!rows.length) return false;
  const owners = new Set((ownerUids || []).map(String));
  return rows.every((r) => { const u = uidsOf(r); return u.length > 0 && u.every((x) => owners.has(x)); });
}

/**
 * One sampling pass: the newest `limit` .docx files; each one the editor holds (lock type 1) is asked for its
 * session, and a live one is recorded. → {sampled: files asked, anyLive}.
 * Spike E10: nc:lock is not searchable on NC 34 (SEARCH answers 400), so a locked file outside the newest `limit`
 * cannot be listed; liveSession reaches it through a sampled key or the plugin's file hint instead.
 */
export async function sweepSessions({ db, getConfig, clock, limit = 60 }) {
  const cfg = getConfig();
  const entries = await listRecent(cfg, { limit, mimes: [DOCX_MIME] });
  let sampled = 0, anyLive = false;
  for (const e of entries) {
    if (!(e.lock && e.lockType === 1) || !(Number(e.fileId) > 0)) continue;
    sampled++;
    const s = await docSession(cfg, e.fileId).catch(() => null);
    if (!s?.live) continue;
    anyLive = true;
    await recordSession(db, { key: s.key, fileId: e.fileId, uids: s.uids, at: clock.now() });
  }
  return { sampled, anyLive };
}
