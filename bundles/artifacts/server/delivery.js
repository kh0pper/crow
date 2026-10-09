// Crow Artifacts — delivering a round to a bot (spec §7.2 step 2, §7.3, D4).
//
// Rules:
//  - UNTRUSTED round (any non-owner text): always a NEW Perch session started
//    LOCKED to the Artifacts tools (engine.spawn({narrowedTools}) +
//    scripts/pi-bots/narrowing-lock.mjs). Never an existing session, never a
//    board card in v1 (card jobs have no locked-narrowing path yet).
//  - trusted round, choice "auto": the session that made the base version if
//    it is live, else the bot's most recent live Perch session; none → the
//    owner chooses (D4): "new-session" or "board-card".
//  - at capacity (interactive_capacity / pi_capacity): the round is QUEUED and
//    the owner is offered a board card (trusted rounds only).
// The engine is injected (servers/gateway/perch-interactive.js
// getInteractiveEngine), so this module has no gateway imports.
import { roundMessage, setDelivery, UNTRUSTED_ALLOW, reclassifyAtDelivery } from "./rounds.js";
import { audit } from "./store.js";
import { sessionIsClean, markSessionTainted } from "./trust.js";

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

/** Live sessions a TRUSTED round may reuse: never a locked one (plan review
 *  R-M2) — its context holds untrusted text, so trust is per session. A
 *  session whose lock state cannot be read is excluded too (fail closed). */
async function liveSessionsOf(db, engine, botId) {
  const all = (await engine.list()).filter((s) => s.botId === botId && !["stopped"].includes(s.state) && !s.archived);
  const out = [];
  for (const s of all) if (await sessionIsClean(db, botId, s.threadId)) out.push(s);   // trust.js: unknown = untrusted
  return out;
}

/** R-M3: stop a locked round session when its round ends. Returns true when
 *  nothing of it is left running. */
export async function stopRoundSession(engine, threadId) {
  if (!threadId) return true;
  const s = (await engine.list()).find((x) => x.threadId === threadId);
  if (!s || s.state === "stopped") return true;
  try { await engine.stop(s.sessionId); return true; } catch { return false; }
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

async function deliverClaimed(db, round, { engine, botDef, choice = "auto", originThread = null, createBoardCard = null, actor = { kind: "session" } }) {
  if (!botHasArtifactsTools(botDef)) {
    await setDelivery(db, round.id, { status: "failed" });
    return { status: "failed", error: "bot_lacks_artifacts" };
  }
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
    // auto
    const live = await liveSessionsOf(db, engine, round.bot_id);
    // Fallback: the first live session in engine.list() order (not verified to
    // be most-recent; the build task adds an explicit last-activity sort).
    const pick = live.find((s) => s.threadId === originThread) || live[0];
    if (!pick) return { status: round.status, needsChoice: true, offerBoard: typeof createBoardCard === "function" };
    // A trusted round to an existing clean session: send first, bind after (a
    // busy session leaves the round unbound and retryable).
    await engine.message(pick.sessionId, text);
    await setDelivery(db, round.id, { status: "working", delivery: "perch-session", sessionId: pick.threadId });
    return { status: "working", delivery: "perch-session", threadId: pick.threadId };
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
