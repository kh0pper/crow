/** Comment loop store: the watch row (mode, lease, block), per-file scan state, the event log and pruning.
 * Times are epoch ms. The event log never holds full comment text (hash + snippet only). */
import { createHash } from "node:crypto";

export const MODES = ["off", "shadow", "on"];
export const EVENT_KINDS = ["live_report", "scan_new", "scan_edit", "rekey", "would_fire", "unverified", "fp_mismatch", "history", "unresolved_key", "scan_error"];
const DAY = 86400000;

// Bumped by every watch-row write in this process, so a cache of the row (the live router's) sees a Settings change
// at once; a write by another gateway process is seen when that cache expires.
let watchGen = 0;
export const watchGeneration = () => watchGen;

export async function getWatch(db) {
  await db.execute("INSERT OR IGNORE INTO workspace_comment_watch(id, mode) VALUES (1, 'off')");
  return (await db.execute("SELECT * FROM workspace_comment_watch WHERE id=1")).rows[0];
}

/** watch_since is set to nowMs only when the previous mode is off. */
export async function setMode(db, mode, nowMs) {
  if (!MODES.includes(mode)) throw new Error(`unknown comment-loop mode: ${mode}`);
  await getWatch(db);
  // One statement, so two gateways can't both decide the previous mode was off.
  await db.execute({
    sql: "UPDATE workspace_comment_watch SET watch_since = CASE WHEN mode='off' AND ?<>'off' THEN ? ELSE watch_since END, mode=? WHERE id=1",
    args: [mode, nowMs, mode],
  });
  watchGen++;
  return getWatch(db);
}

/** One owner at a time; an expired lease (or the owner's own) is taken. Atomic single UPDATE. */
export async function takeLease(db, owner, nowMs, ttlMs = 60000) {
  await getWatch(db);
  const r = await db.execute({
    sql: "UPDATE workspace_comment_watch SET lease_owner=?, lease_until=? WHERE id=1 AND (lease_owner IS NULL OR lease_owner=? OR lease_until IS NULL OR lease_until<=?)",
    args: [owner, nowMs + ttlMs, owner, nowMs],
  });
  return r.rowsAffected > 0;
}

/** The owner extends its own lease; false when another owner holds it (the caller stops). */
export async function renewLease(db, owner, nowMs, ttlMs = 60000) {
  const r = await db.execute({ sql: "UPDATE workspace_comment_watch SET lease_until=? WHERE id=1 AND lease_owner=?", args: [nowMs + ttlMs, owner] });
  return r.rowsAffected > 0;
}

export async function setBlocked(db, reason) {
  await getWatch(db);
  await db.execute({ sql: "UPDATE workspace_comment_watch SET blocked_reason=? WHERE id=1", args: [reason ?? null] });
  watchGen++;
}

/**
 * Clears the block only when it is `reason` (one statement); true when a block was cleared. When the mode is not off,
 * watch_since moves to nowMs, so comments written while the loop was blocked never count as new.
 */
export async function clearBlocked(db, reason, nowMs) {
  await getWatch(db);
  if (!Number.isFinite(Number(nowMs))) throw new Error("clearBlocked needs nowMs");
  const r = await db.execute({ sql: "UPDATE workspace_comment_watch SET blocked_reason=NULL, watch_since = CASE WHEN mode<>'off' THEN ? ELSE watch_since END WHERE id=1 AND blocked_reason=?", args: [Number(nowMs), reason] });
  watchGen++;
  return r.rowsAffected > 0;
}

export async function getState(db, fileId) {
  return (await db.execute({ sql: "SELECT * FROM workspace_comment_state WHERE file_id=?", args: [fileId] })).rows[0] ?? null;
}

/** Upsert; first_seen_at of an existing row is kept. */
export async function putState(db, row) {
  await db.execute({
    sql: `INSERT INTO workspace_comment_state(file_id, etag, mtime, threads_json, own_put_etag, first_seen_at, scanned_at, skip_reason)
VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(file_id) DO UPDATE SET etag=excluded.etag, mtime=excluded.mtime, threads_json=excluded.threads_json,
  own_put_etag=excluded.own_put_etag, scanned_at=excluded.scanned_at, skip_reason=excluded.skip_reason`,
    args: [row.file_id, row.etag ?? null, row.mtime ?? null, row.threads_json ?? "[]", row.own_put_etag ?? null, row.first_seen_at, row.scanned_at ?? null, row.skip_reason ?? null],
  });
}

export async function logEvent(db, { at, fileId, kind, detail }) {
  if (!EVENT_KINDS.includes(kind)) throw new Error(`unknown comment event kind: ${kind}`);
  const d = detail ?? {};
  assertNoFullText(d);
  await db.execute({ sql: "INSERT INTO workspace_comment_events(at, file_id, kind, detail_json) VALUES (?,?,?,?)", args: [at, fileId ?? null, kind, JSON.stringify(d)] });
}

const FORBIDDEN_KEYS = new Set(["text", "content", "body", "comment", "quote"]);
const MAX_DETAIL_STRING = 200;
/** Events keep a hash + snippet only: no full-text keys at any depth, and no long strings under any key. */
function assertNoFullText(v, depth = 0) {
  if (depth > 6 || v == null) return;
  if (typeof v === "string") {
    if (v.length > MAX_DETAIL_STRING) throw new Error("comment events never store full text (use hash + snippet)");
    return;
  }
  if (typeof v !== "object") return;
  for (const [k, val] of Object.entries(v)) {
    if (!Array.isArray(v) && FORBIDDEN_KEYS.has(k.toLowerCase())) throw new Error("comment events never store full text (use hash + snippet)");
    assertNoFullText(val, depth + 1);
  }
}

export const textHash = (s) => createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16);
export const snippetOf = (s) => [...String(s ?? "")].slice(0, 40).join("");

export async function prune(db, nowMs) {
  await db.execute({ sql: "DELETE FROM workspace_comment_events WHERE at < ?", args: [nowMs - 30 * DAY] });
  await db.execute({ sql: "DELETE FROM workspace_editor_sessions WHERE last_seen < ?", args: [nowMs - 7 * DAY] });
}
