/**
 * Live browser tile: a turn's final browser screenshot, kept like a file the
 * bot sent (spec §4.5).
 *
 *   - the bytes go into the session's gateway-owned staging dir through
 *     servers/shared/perch-delivered.js (anchored root fd, O_EXCL|O_NOFOLLOW),
 *     so the existing workspace route serves them;
 *   - the history row is a perch_session_files row with kind='browser_shot'
 *     and turn_anchor: only this module writes that kind, so a bot that sends
 *     a file with a look-alike name still gets a plain file card;
 *   - after each insert the thread keeps its newest SHOT_KEEP shots; older
 *     rows go with their files (unlinkDelivered, fd-anchored).
 *
 * The hostname only ever appears in the file name (which the chat shows); it
 * is never logged.
 */
import { closeSync, constants as fsConstants, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { openDeliveredDir, resolveSentName, unlinkDelivered } from "../../shared/perch-delivered.js";

/** Shots kept per thread (spec §4.5). */
export const SHOT_KEEP = 20;

const pad = (n) => String(n).padStart(2, "0");

/** `browser-<host ≤ 60 chars>-<yyyymmdd-hhmmss>.jpg` (UTC). */
export function shotName(hostname, now = new Date()) {
  const host = String(hostname == null ? "" : hostname).toLowerCase()
    .replace(/[^a-z0-9.-]/g, "").replace(/^[.-]+/, "").slice(0, 60) || "page";
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const stamp = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
    + "-" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  return "browser-" + host + "-" + stamp + ".jpg";
}

/**
 * Write one shot and record it. `db` is a createDbClient() handle; `s` is the
 * Perch session ({ sessionId, botId, threadId, outputsDir? }). Returns
 * { id, name }. Throws when the file cannot be written (the caller treats that
 * as "no shot"); the prune afterwards is best-effort.
 */
export async function storeShot(db, s, { buf, hostname, anchor = null, now = new Date() } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error("no shot bytes");
  const base = shotName(hostname, now);
  let name;
  const dfd = openDeliveredDir(s.sessionId, { create: true });
  try {
    const viaFd = "/proc/self/fd/" + dfd;
    // The outputs dir is served under the same flat names; stay clear of it.
    const dirs = [viaFd, s.outputsDir].filter(Boolean);
    for (let tries = 0; ; tries++) {
      name = resolveSentName(dirs, base);
      let wfd;
      try {
        wfd = openSync(join(viaFd, name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      } catch (e) {
        if (e.code === "EEXIST" && tries < 5) continue;   // raced another writer: next free slot
        throw e;
      }
      try { writeFileSync(wfd, buf); } finally { closeSync(wfd); }
      break;
    }
  } finally { closeSync(dfd); }

  let id;
  try {
    const r = await db.execute({
      sql: "INSERT INTO perch_session_files (bot_id, thread_id, name, stored, mime, size, caption, servable, kind, turn_anchor) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [String(s.botId || ""), String(s.threadId || s.sessionId), name, name, "image/jpeg", buf.length, "", 1, "browser_shot",
        anchor == null ? null : String(anchor).slice(0, 256)],
    });
    id = Number(r.lastInsertRowid);
  } catch (e) {
    unlinkDelivered(s.sessionId, name);   // no row → no orphan file
    throw e;
  }
  try { await pruneShots(db, s); } catch { /* retention retries on the next shot */ }
  return { id, name };
}

/**
 * Keep the thread's newest `keep` shots; delete older rows and their files.
 * The file goes first: a row whose file is gone is simply skipped by the
 * history reader, while a file whose row is gone would never be cleaned up.
 */
export async function pruneShots(db, s, { keep = SHOT_KEEP } = {}) {
  const botId = String(s.botId || "");
  const threadId = String(s.threadId || s.sessionId);
  const r = await db.execute({
    sql: "SELECT id, stored FROM perch_session_files WHERE bot_id=? AND thread_id=? AND kind='browser_shot' ORDER BY id DESC LIMIT -1 OFFSET ?",
    args: [botId, threadId, Math.max(0, Number(keep) || 0)],
  });
  for (const row of r.rows) {
    if (row.stored) unlinkDelivered(s.sessionId, String(row.stored));
    await db.execute({
      sql: "DELETE FROM perch_session_files WHERE id=? AND bot_id=? AND thread_id=? AND kind='browser_shot'",
      args: [Number(row.id), botId, threadId],
    });
  }
  return r.rows.length;
}
