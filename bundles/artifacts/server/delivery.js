// Crow Artifacts — delivering a round to a bot (spec §7.2 step 2, §7.3, D4).
//
// Rules:
//  - UNTRUSTED round (any non-owner text): always a NEW Perch session started
//    LOCKED to the Artifacts tools (engine.spawn({narrowedTools}) +
//    scripts/pi-bots/narrowing-lock.mjs). Never an existing session, never a
//    board card in v1 (card jobs have no locked-narrowing path yet). This
//    holds for a TARGETED round too (review M5(b)): trust is re-classified
//    first, and a downgraded round never reaches its target chat.
//  - trusted round, choice "chat" (spec v1.6 D25, plan PR-3 Task 3.3): ONLY
//    the round's persisted target_thread — re-verified now (active link, bot
//    access, the chat is this bot's, tools), not LOCKED (D23: a tainted chat
//    is fine, its results save tainted), woken through the engine if it
//    sleeps. Anything else FAILS by name with the threads released. There is
//    no "any live session" and no origin fallback (round-2 B7/B8). No target
//    at all → the owner chooses: "new-session" or "board-card".
//  - at capacity (interactive_capacity / pi_capacity): the round is QUEUED and
//    the owner is offered a board card (trusted rounds only); the sweep
//    retries the SAME choice (the target, or a new session).
// The engine is injected (servers/gateway/perch-interactive.js
// getInteractiveEngine), so this module has no gateway imports.
import { roundMessage, setDelivery, UNTRUSTED_ALLOW, reclassifyAtDelivery, failRound } from "./rounds.js";
import { audit } from "./store.js";
import { isLocked, markSessionTainted } from "./trust.js";
import { verifyTarget } from "./links.js";

const CAPACITY = new Set(["interactive_capacity", "pi_capacity"]);
const codeOf = (e) => e?.code || [...CAPACITY].find((c) => String(e?.message || "").includes(c)) || null;

/** The ONE grant normaliser on the bundle side (plan review R-M6): a def's
 *  crow_mcp entry grants the Artifacts server whole (`artifacts`) or per tool
 *  (`artifacts/<tool>`). Mirrors allowEntryMatches in narrowing-lock.mjs,
 *  which accepts `mcp__artifacts` and `mcp__artifacts__<tool>` alike. */
export function grantsServer(entry, server) {
  // `server`, `server/<tool>`, and `server__<tool>` (toolAllowlist maps "/" to
  // "__", so the bridge accepts that shape too: R2-L2 parity).
  return typeof entry === "string" && (entry === server || entry.startsWith(server + "/") || entry.startsWith(server + "__"));
}
export function botHasArtifactsTools(def) {
  const list = (def && def.tools && def.tools.crow_mcp) || [];
  return list.some((s) => grantsServer(s, "artifacts"));
}

/** R-M3: stop a locked round session when its round ends. Returns true when
 *  nothing of it is left running. A transient engine fault (list/stop
 *  throwing) reads as "not stopped" so one bad leg can never abort a whole
 *  sweep tick before the queued retries (review C2-L1); the next tick retries
 *  (the row keeps session_stopped_at NULL). */
export async function stopRoundSession(engine, threadId) {
  if (!threadId) return true;
  try {
    const s = (await engine.list()).find((x) => x.threadId === threadId);
    if (!s || s.state === "stopped") return true;
    await engine.stop(s.sessionId);
    return true;
  } catch { return false; }
}

/**
 * @returns {Promise<{ status: string, delivery?: string, threadId?: string, needsChoice?: boolean, offerBoard?: boolean, error?: string }>}
 */
/**
 * R3-M2: one delivery at a time per round, claimed atomically. The route, the
 * sweep's retry, a double click or two overlapping ticks race on this UPDATE;
 * exactly one wins. Anything short of a delivery (needs a choice, at capacity,
 * an error) returns the round to its previous state and unbinds it.
 */
export async function deliverRound(db, round, opts) {
  const claim = await db.execute({ sql: "UPDATE artifact_rounds SET status='delivering', updated_at=datetime('now') WHERE id=? AND status IN ('pending','queued') AND session_id IS NULL AND card_id IS NULL", args: [round.id] });
  if (Number(claim.rowsAffected) !== 1) return { status: "busy", error: "already_delivering_or_delivered" };
  const back = round.status === "queued" ? "queued" : "pending";
  const revert = (unbind) => db.execute({ sql: `UPDATE artifact_rounds SET status=?${unbind ? ", session_id=NULL" : ""}, updated_at=datetime('now') WHERE id=? AND status='delivering'`, args: [back, round.id] });
  try {
    const out = await deliverClaimed(db, { ...round, status: back }, opts);
    await revert(false);   // a no-op unless the round is still 'delivering'
    return out;
  } catch (e) {
    await revert(true);
    throw e;
  }
}

/** Engine codes that mean "that chat cannot be woken" (B8). */
const ASLEEP = new Set(["session_stopped", "no_such_session"]);

async function deliverClaimed(db, round, { engine, botDef, choice = "chat", createBoardCard = null, actor = { kind: "session" } }) {
  const fail = async (error) => { await failRound(db, round, error); return { status: "failed", error }; };
  if (!botHasArtifactsTools(botDef)) return fail("bot_lacks_artifacts");
  // R2-H1: trust is re-checked from the snapshot NOW, before any text leaves.
  const wasTrusted = !round.untrusted;
  await reclassifyAtDelivery(db, round);
  const downgraded = wasTrusted && round.untrusted;
  const text = await roundMessage(db, round);
  const spawnAndSend = async (narrowed) => {
    const s = await engine.spawn(narrowed ? { botId: round.bot_id, narrowedTools: UNTRUSTED_ALLOW } : { botId: round.bot_id });
    try {
      // The taint record is written BEFORE the round text is sent.
      if (narrowed) await markSessionTainted(db, round.bot_id, s.threadId, "untrusted-round");
      // session_id holds the THREAD id: the bot's actor headers carry the
      // thread, and mcp.js scopes untrusted rounds by it.
      await setDelivery(db, round.id, { status: "working", delivery: "perch-session", sessionId: s.threadId });
      await engine.message(s.sessionId, text);
    } catch (e) {
      // R2-L5: never leave a spawned session running unrecorded, and unbind it.
      try { await engine.stop(s.sessionId); } catch {}
      await db.execute({ sql: "UPDATE artifact_rounds SET session_id=NULL WHERE id=? AND session_id=?", args: [round.id, s.threadId] });
      throw e;
    }
    return s;
  };
  try {
    if (round.untrusted) {
      if (choice === "board-card") return { status: round.status, error: "untrusted_rounds_need_a_new_session" };
      const s = await spawnAndSend(true);
      await audit(db, { artifactId: round.artifact_id, actor, action: "round-delivered", target: String(round.id), detail: { narrowed: true, thread: s.threadId } });
      // R3-L2: the owner is told (the route shows it; the sweep notifies).
      return { status: "working", delivery: "perch-session", threadId: s.threadId, downgraded };
    }
    if (choice === "board-card") {
      if (typeof createBoardCard !== "function") return { status: round.status, error: "no_board" };
      const cardId = await createBoardCard({ round, text });
      await setDelivery(db, round.id, { status: "pending", delivery: "board-card", cardId });
      return { status: "pending", delivery: "board-card", cardId };
    }
    if (choice === "new-session") {
      const s = await spawnAndSend(false);
      return { status: "working", delivery: "perch-session", threadId: s.threadId };
    }
    // "chat": the persisted target, and only it.
    const target = round.target_thread ? String(round.target_thread) : null;
    if (!target) return { status: round.status, needsChoice: true, offerBoard: typeof createBoardCard === "function" };
    const why = await verifyTarget(db, { artifactId: round.artifact_id, botId: round.bot_id, threadId: target, botDef });
    if (why) return fail(why);
    if (await isLocked(db, round.bot_id, target)) return fail("target_locked");   // D23
    const seen = (await engine.list()).find((x) => x.threadId === target);
    if (seen && (seen.botId !== round.bot_id)) return fail("target_not_bots_chat");
    if (seen && (seen.state === "stopped" || seen.archived)) return fail("target_asleep");
    // Send first, bind after (a busy chat leaves the round unbound and
    // retryable). message() wakes a hibernating chat itself (B8).
    try { await engine.message(seen ? seen.sessionId : target, text); }
    catch (e) { if (ASLEEP.has(codeOf(e))) return fail("target_asleep"); throw e; }
    await setDelivery(db, round.id, { status: "working", delivery: "perch-session", sessionId: target });
    return { status: "working", delivery: "perch-session", threadId: target };
  } catch (e) {
    const code = codeOf(e);
    if (CAPACITY.has(code)) {
      await setDelivery(db, round.id, { status: "queued" });
      return { status: "queued", offerBoard: !round.untrusted && typeof createBoardCard === "function" };
    }
    if (code === "turn_in_progress" || code === "cycle_busy") {
      await setDelivery(db, round.id, { status: "queued" });
      return { status: "queued", offerBoard: false };
    }
    throw e;
  }
}
