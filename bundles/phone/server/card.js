// NO bare imports (installed copy; see mcp.js).

/** The SSE pointer for one call (spec 2026-10-01 I2). Built here from the DB
 *  row; the Perch client refetches the row by call_id. Nothing a pi child
 *  emitted is ever forwarded. */
export function cardFrame(call) {
  return { type: "phone_call", call_id: String(call.id), status: String(call.status), event_seq: Number(call.event_seq) || 0 };
}

/** Push a call's card into the Perch chat that asked for it (spec §4.2).
 *  I3: the engine emits only when its resident session belongs to the bot that
 *  created the call. That stops a forged THREAD header and accidental
 *  mismatches — not a child that forges both actor headers (spec "Known
 *  limits"). A mismatch shows no card; the call still appears in the Phone
 *  panel, and ONE audit row records it. Never throws. */
let warnedHookError = false;

export async function pushCallCard(db, call, notifyCard) {
  if (!notifyCard) return { delivered: false, reason: "no_hook" };
  if (!call) return { delivered: false, reason: "no_call" };
  const d = call.deliver_to;
  if (!d || d.kind !== "perch" || !d.session_id) return { delivered: false, reason: "not_perch" };
  const botId = call.created_by && call.created_by.kind === "bot" && call.created_by.id ? String(call.created_by.id) : null;
  if (!botId) return { delivered: false, reason: "no_bot" };
  let r;
  try { r = await notifyCard(String(d.session_id), cardFrame(call), { botId }); }
  catch (e) {
    if (!warnedHookError) { warnedHookError = true; console.warn(`[phone] card push hook threw for ${call.id}: ${e.message} (logged once per process)`); }
    return { delivered: false, reason: "error", error: e.message };
  }
  r = r || { delivered: false, reason: "no_result" };
  if (r.reason === "bot_mismatch") {
    // Once per call, in ONE statement (backlog P10): a check-then-insert let two
    // concurrent pushes (a route action racing the dispatcher's flush) both write.
    try {
      await db.execute({
        sql: `INSERT INTO phone_audit (call_id, actor, event, detail_json)
              SELECT ?, 'service', 'card_target_mismatch', ?
              WHERE NOT EXISTS (SELECT 1 FROM phone_audit WHERE call_id=? AND event='card_target_mismatch')`,
        args: [call.id, JSON.stringify({ session_id: String(d.session_id), expected_bot: botId, session_bot: r.botId ?? null }), call.id],
      });
    } catch (e) { console.warn(`[phone] mismatch audit failed for ${call.id}: ${e.message}`); }
  }
  return r;
}
