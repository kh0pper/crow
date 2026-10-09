// Crow Artifacts — per-session trust (plan review R-M2 + the follow-up
// security review). A bot session's trust comes ONLY from the server's own
// records, read at the moment it matters:
//   clean  ⇔  a bot_sessions row exists for (bot, thread), its narrowed_tools
//             is NULL or a valid JSON array without "crow:locked", AND no
//             artifact_session_taint row marks the thread;
//   anything else — no row, a corrupt value, an unreadable table, no thread
//   at all (a channel or job turn) — is UNTRUSTED (fail closed).
// A trusted round goes only to a clean session; a version is saved trusted
// only if its author's session is clean WHEN IT IS SAVED (re-read, never
// cached from dispatch).
import { appImport } from "./app-root.js";
let memory = null;   // servers/gateway/session-taint-memory.js (R3-M1), same process

export async function sessionIsClean(db, botId, threadId) {
  if (!botId || !threadId) return false;
  try {
    if (!memory) memory = await appImport("servers/gateway/session-taint-memory.js");
    if (memory.isTaintUnrecorded(botId, threadId)) return false;
    const r = (await db.execute({ sql: "SELECT narrowed_tools FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1", args: [botId, threadId] })).rows[0];
    if (!r) return false;
    if (r.narrowed_tools != null) {
      let v; try { v = JSON.parse(r.narrowed_tools); } catch { return false; }
      if (!Array.isArray(v) || v.includes("crow:locked")) return false;
    }
    const t = (await db.execute({ sql: "SELECT 1 FROM artifact_session_taint WHERE bot_id=? AND thread_id=?", args: [botId, threadId] })).rows[0];
    return !t;
  } catch { return false; }
}

/** Record that a session saw untrusted text (an untrusted round was sent to
 *  it, or it acted inside one). Never cleared. */
export async function markSessionTainted(db, botId, threadId, reason) {
  if (!botId || !threadId) return;
  await db.execute({ sql: "INSERT OR IGNORE INTO artifact_session_taint (bot_id, thread_id, reason) VALUES (?,?,?)", args: [botId, threadId, String(reason || "").slice(0, 64)] });
}
