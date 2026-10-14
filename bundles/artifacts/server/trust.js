// Crow Artifacts — per-session trust (plan review R-M2 + the follow-up
// security review). A bot session's trust comes ONLY from the server's own
// records, read at the moment it matters:
//   clean  ⇔  a bot_sessions row exists for (bot, thread), its narrowed_tools
//             is NULL or a valid JSON array without "crow:locked", AND no
//             artifact_session_taint row marks the thread;
//   anything else — no row, a corrupt value, an unreadable table, no thread
//   at all (a channel or job turn) — is UNTRUSTED (fail closed).
// A trusted round goes only to a chat that is not LOCKED (D23, below); a
// version is saved trusted only if its author's session is clean WHEN IT IS
// SAVED (re-read, never cached from dispatch).
import { appImport } from "./app-root.js";
let memory = null;   // servers/gateway/session-taint-memory.js (R3-M1), same process

/**
 * D23 (spec v1.6 §7.3; plan PR-3 Task 3.1): trust splits in two.
 *   isLocked  — may this chat receive a TRUSTED round at all? Locked chats
 *               hold an untrusted round's context; trusted rounds never go there.
 *   isTainted — does what this chat writes save untrusted? (D22: it read
 *               outside text.) A tainted chat DOES receive trusted rounds;
 *               its results save tainted and D20 gates them.
 * Both fail closed: no bot, no thread, an unreadable record or a failing
 * query reads as locked AND tainted.
 *
 * isLocked must be AT LEAST AS STRICT as mcp.js scopeOf (round-2 B9) — never
 * an exact mirror: scopeOf looks only at the LATEST round bound to the thread
 * and treats a missing row as unlocked; isLocked locks on ANY untrusted round
 * ever bound to the thread and on a missing/corrupt row. Pinned one-way by
 * tests/artifacts-trust-split.test.js (scopeOf scoped ⇒ isLocked).
 */
export async function isLocked(db, botId, threadId) {
  if (!botId || !threadId) return true;
  try {
    const r = (await db.execute({ sql: "SELECT narrowed_tools FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1", args: [botId, threadId] })).rows[0];
    if (!r) return true;
    // Review L1: the marker ANYWHERE in the stored value locks — as strict as
    // scopeOf's and the engine's own substring test — before the shape check.
    if (typeof r.narrowed_tools === "string" && r.narrowed_tools.includes("crow:locked")) return true;
    if (r.narrowed_tools != null) {
      let v; try { v = JSON.parse(r.narrowed_tools); } catch { return true; }
      if (!Array.isArray(v) || v.includes("crow:locked")) return true;
    }
    // ANY untrusted round ever bound to this thread (not only the latest);
    // untrusted_input is clean only when exactly 0 (store.flagUntrusted).
    const u = (await db.execute({ sql: "SELECT 1 FROM artifact_rounds WHERE session_id=? AND (untrusted_input IS NULL OR untrusted_input<>0) LIMIT 1", args: [threadId] })).rows[0];
    return !!u;
  } catch { return true; }
}

export async function isTainted(db, botId, threadId) {
  if (!botId || !threadId) return true;
  try {
    if (!memory) memory = await appImport("servers/gateway/session-taint-memory.js");
    if (memory.isTaintUnrecorded(botId, threadId)) return true;
    const t = (await db.execute({ sql: "SELECT 1 FROM artifact_session_taint WHERE bot_id=? AND thread_id=?", args: [botId, threadId] })).rows[0];
    return !!t;
  } catch { return true; }
}

/** The save path (store/mcp callers): a version or reply is trusted only
 *  when its author's chat is neither locked nor tainted, re-read NOW. */
export async function sessionIsClean(db, botId, threadId) {
  return !(await isLocked(db, botId, threadId)) && !(await isTainted(db, botId, threadId));
}

/** Record that a session saw untrusted text (an untrusted round was sent to
 *  it, or it acted inside one). Never cleared. */
export async function markSessionTainted(db, botId, threadId, reason) {
  if (!botId || !threadId) return;
  await db.execute({ sql: "INSERT OR IGNORE INTO artifact_session_taint (bot_id, thread_id, reason) VALUES (?,?,?)", args: [botId, threadId, String(reason || "").slice(0, 64)] });
}
