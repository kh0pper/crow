import { createHash, randomBytes, randomUUID } from "node:crypto";
import { validatePlan, planHash } from "./plan.js";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
function fail(code, msg) { const e = new Error(msg); e.code = code; return e; }

function hydrate(r) {
  if (!r) return null;
  return { ...r, created_by: P(r.created_by, {}), deliver_to: P(r.deliver_to), limits: P(r.limits_json, {}),
    shareable: P(r.shareable_json, {}), booking: P(r.booking_json), transcript: P(r.transcript_json, []), allow_cloud: !!r.allow_cloud };
}

export async function audit(db, callId, actor, event, detail = null) {
  await db.execute({ sql: "INSERT INTO phone_audit (call_id, actor, event, detail_json) VALUES (?,?,?,?)",
    args: [callId, typeof actor === "string" ? actor : J(actor), event, J(detail)] });
}

export async function createPlan(db, plan, actor, deliverTo) {
  // Per-bot buckets; every unattributed caller (S2: unsigned or forged actor
  // headers) shares ONE bucket, so a forger cannot dodge the limit by
  // inventing new bot ids.
  const bucket = actor?.kind === "bot" ? { where: "json_extract(created_by,'$.id')=?", args: [actor.id] }
    : actor?.kind === "unattributed" ? { where: "json_extract(created_by,'$.kind')='unattributed'", args: [] } : null;
  if (bucket) {
    const pend = (await db.execute({ sql: `SELECT COUNT(*) n FROM phone_calls WHERE status='awaiting_approval' AND ${bucket.where}`, args: bucket.args })).rows[0].n;
    const day = (await db.execute({ sql: `SELECT COUNT(*) n FROM phone_calls WHERE ${bucket.where} AND created_at > datetime('now','-1 day')`, args: bucket.args })).rows[0].n;
    if (pend >= 5 || day >= 10) throw fail("rate_limited", "too many call plans from this bot; ask the owner to review pending ones");
  }
  const id = "call_" + randomUUID();
  await db.execute({
    sql: `INSERT INTO phone_calls (id, created_by, deliver_to, business_name, number_e164, goal, limits_json, shareable_json, language, notes, run_after, plan_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, J(actor || { kind: "session" }), J(deliverTo), plan.business_name, plan.number_e164, plan.goal, J(plan.limits), J(plan.shareable), plan.language, plan.notes, plan.run_after, planHash(plan)],
  });
  await audit(db, id, actor || "session", "plan_created", { business: plan.business_name });
  return { call_id: id };
}

export async function getCall(db, id) {
  return hydrate((await db.execute({ sql: "SELECT * FROM phone_calls WHERE id = ?", args: [id] })).rows[0]);
}

export async function listCalls(db, { status, limit = 50 } = {}) {
  const r = status
    ? await db.execute({ sql: "SELECT * FROM phone_calls WHERE status = ? ORDER BY created_at DESC LIMIT ?", args: [status, limit] })
    : await db.execute({ sql: "SELECT * FROM phone_calls ORDER BY created_at DESC LIMIT ?", args: [limit] });
  return r.rows.map(hydrate);
}

/** I5 (spec 2026-10-01): the calls a Perch chat may show. BOTH the target
 *  session AND the creating bot must match. That stops a forged THREAD header
 *  (the call names its real bot, which is not this session's) and accidental
 *  mismatches. A child forging BOTH actor headers never gets here: since S2
 *  (phone 0.2.2) unsigned or mis-signed headers resolve to an unattributed
 *  actor with no deliver_to (mcp.js resolvePhoneActor). */
export async function listPerchCalls(db, sessionId, botId, limit = 20) {
  const n = Math.max(1, Math.min(20, Number(limit) || 20));
  const r = await db.execute({
    sql: `SELECT * FROM phone_calls
          WHERE json_extract(deliver_to,'$.kind')='perch' AND json_extract(deliver_to,'$.session_id')=?
            AND json_extract(created_by,'$.kind')='bot' AND json_extract(created_by,'$.id')=?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args: [String(sessionId), String(botId), n],
  });
  return r.rows.map(hydrate);
}

/** The bot that owns Perch session `sid`: the row perch-interactive.js adoptRow
 *  reads. A direct read on purpose (never adopts or wakes a session). Returns
 *  the bot id, or null when there is no row or no bot_sessions table (this
 *  instance has no Perch). Any other error (SQLITE_BUSY, IOERR, a closed
 *  client) is RETHROWN: callers must not mistake a transient failure for
 *  "no owner". Shared by deliver.js and panel/routes.js. */
export async function perchSessionBot(db, sid) {
  try {
    const r = await db.execute({ sql: "SELECT bot_id FROM bot_sessions WHERE gateway_thread_id=? AND kind='perch-live' ORDER BY id DESC LIMIT 1", args: [String(sid)] });
    return r.rows[0] ? String(r.rows[0].bot_id) : null;
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return null;
    throw e;
  }
}

function planFromRow(row, edits = {}) {
  return validatePlan({
    business_name: edits.business_name ?? row.business_name, number: edits.number ?? row.number_e164,
    goal: edits.goal ?? row.goal, limits: edits.limits ?? row.limits, shareable: edits.shareable ?? row.shareable,
    language: edits.language ?? row.language, notes: edits.notes ?? row.notes, run_after: edits.run_after ?? row.run_after,
  });
}

async function applyEdits(db, id, plan) {
  await db.execute({
    sql: `UPDATE phone_calls SET business_name=?, number_e164=?, goal=?, limits_json=?, shareable_json=?, language=?, notes=?, plan_hash=?, updated_at=datetime('now') WHERE id=?`,
    args: [plan.business_name, plan.number_e164, plan.goal, J(plan.limits), J(plan.shareable), plan.language, plan.notes, planHash(plan), id],
  });
}

export async function approveCall(db, id, { session, allowCloud, edits, runAfter, expectedHash } = {}) {
  // I4 (spec 2026-10-01): approve exactly what was shown. The caller names the
  // plan_hash it rendered; the pre-check gives a clean error and the CAS below
  // re-checks it in the same UPDATE, so an edit landing in between still loses.
  if (typeof expectedHash !== "string" || !expectedHash) throw fail("plan_hash_required", "approval must name the plan_hash that was shown");
  const row = await getCall(db, id);
  if (!row) throw fail("not_found", "no such call");
  if (row.status !== "awaiting_approval") throw fail("not_pending", "call is not awaiting approval");
  if (row.plan_hash !== expectedHash) throw fail("plan_changed", "the plan changed since it was shown; review it again");
  // Validate the edited plan (if any) before the CAS. The CAS compares the SHOWN
  // hash; the row then carries the edited plan's hash.
  let plan = row;
  if (edits) {
    plan = planFromRow(row, edits);
  }
  // "Approve now" means now: runAfter undefined keeps the stored time (a bot's
  // proposal, which the card and the Phone panel show and prefill), null clears it,
  // a string sets it.
  const runAt = runAfter === undefined ? (row.run_after ?? null) : (runAfter || null);
  const token = randomBytes(24).toString("hex");
  const newHash = planHash(plan);
  const r = await db.execute({
    sql: `UPDATE phone_calls SET status='approved', business_name=?, number_e164=?, goal=?, limits_json=?, shareable_json=?, language=?, notes=?, plan_hash=?, token_hash=?, approved_by_session=?, approved_at=datetime('now'), allow_cloud=?, run_after=?, updated_at=datetime('now')
          WHERE id=? AND status='awaiting_approval' AND plan_hash=?`,
    args: [plan.business_name, plan.number_e164, plan.goal, J(plan.limits), J(plan.shareable), plan.language, plan.notes, newHash, sha(token + ":" + id + ":" + newHash), sha(session || ""), allowCloud ? 1 : 0, runAt, id, expectedHash],
  });
  if (!r.rowsAffected) {
    const now = await getCall(db, id);
    if (now && now.status === "awaiting_approval") throw fail("plan_changed", "the plan changed since it was shown; review it again");
    throw fail("not_pending", "call is not awaiting approval");
  }
  await audit(db, id, "owner", "approved", { allowCloud: !!allowCloud, runAfter: runAt });
  return { token };
}

export async function editCall(db, id, edits) {
  const row = await getCall(db, id);
  if (!row) throw fail("not_found", "no such call");
  if (!["awaiting_approval", "approved"].includes(row.status)) throw fail("not_editable", "call can no longer be edited");
  const plan = planFromRow(row, edits);
  const newHash = planHash(plan);
  const r = await db.execute({
    sql: `UPDATE phone_calls SET business_name=?, number_e164=?, goal=?, limits_json=?, shareable_json=?, language=?, notes=?, plan_hash=?, status='awaiting_approval', token_hash=NULL, approved_at=NULL, approved_by_session=NULL, updated_at=datetime('now')
          WHERE id=? AND status IN ('awaiting_approval','approved')`,
    args: [plan.business_name, plan.number_e164, plan.goal, J(plan.limits), J(plan.shareable), plan.language, plan.notes, newHash, id],
  });
  if (!r.rowsAffected) throw fail("not_editable", "call can no longer be edited");
  await audit(db, id, "owner", "edited", Object.keys(edits));
}

export async function rejectCall(db, id) {
  await db.execute({ sql: "UPDATE phone_calls SET status='rejected', token_hash=NULL, updated_at=datetime('now') WHERE id=? AND status IN ('awaiting_approval','approved')", args: [id] });
  await audit(db, id, "owner", "rejected");
}

export async function cancelCall(db, id, actor) {
  const row = await getCall(db, id);
  if (!row) throw fail("not_found", "no such call");
  if (actor && typeof actor === "object" && actor.kind !== "session" && (actor.kind !== "bot" || !actor.id || row.created_by?.id !== actor.id)) throw fail("forbidden", "not your call plan");
  const r = await db.execute({ sql: "UPDATE phone_calls SET status='cancelled', token_hash=NULL, updated_at=datetime('now') WHERE id=? AND status IN ('awaiting_approval','approved')", args: [id] });
  if (!r.rowsAffected) throw fail("not_cancellable", "call is already running or finished");
  await audit(db, id, actor || "owner", "cancelled");
}

export async function consumeToken(db, id, token) {
  if (!token) return false;
  const row = await getCall(db, id);
  if (!row) return false;
  const r = await db.execute({ sql: "UPDATE phone_calls SET token_hash=NULL WHERE id=? AND token_hash=? AND plan_hash=? AND status IN ('approved','starting','live')", args: [id, sha(token + ":" + id + ":" + row.plan_hash), row.plan_hash] });
  return r.rowsAffected === 1;
}

/** Expire unapproved plans older than 24 h and return the ids this call
 *  expired (spec 2026-10-01 S6: each gets a card frame). Per-id CAS, so two
 *  dispatchers never both claim one expiry. */
export async function expirePlanIds(db) {
  const ids = (await db.execute({ sql: "SELECT id FROM phone_calls WHERE status='awaiting_approval' AND created_at < datetime('now','-24 hours')", args: [] })).rows.map((r) => r.id);
  const out = [];
  for (const id of ids) {
    const r = await db.execute({ sql: "UPDATE phone_calls SET status='expired', updated_at=datetime('now') WHERE id=? AND status='awaiting_approval'", args: [id] });
    if (r.rowsAffected) out.push(id);
  }
  return out;
}

export async function expirePlans(db) {
  return (await expirePlanIds(db)).length;
}

export async function claimNextDue(db) {
  const r = await db.execute({
    sql: `UPDATE phone_calls SET status='starting', updated_at=datetime('now')
          WHERE id = (SELECT id FROM phone_calls WHERE status='approved' AND (run_after IS NULL OR run_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY approved_at ASC, rowid ASC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM phone_calls WHERE status IN ('starting','live'))`,
    args: [] });
  if (!r.rowsAffected) return null;
  const next = (await db.execute({ sql: "SELECT id FROM phone_calls WHERE status='starting' ORDER BY updated_at DESC LIMIT 1", args: [] })).rows[0];
  return next ? getCall(db, next.id) : null;
}

export async function markLive(db, id, modelUsed) {
  const r = await db.execute({ sql: "UPDATE phone_calls SET status='live', started_at=datetime('now'), model_used=? WHERE id=? AND status='starting'", args: [modelUsed || null, id] });
  return r.rowsAffected === 1;
}

export async function issueStartToken(db, id) {
  const row = await getCall(db, id);
  if (!row || row.status !== "starting") return null;
  const token = randomBytes(24).toString("hex");
  const r = await db.execute({
    sql: "UPDATE phone_calls SET token_hash=? WHERE id=? AND status='starting'",
    args: [sha(token + ":" + id + ":" + row.plan_hash), id],
  });
  return r.rowsAffected ? token : null;
}

export async function appendEvents(db, id, events) {
  const row = await getCall(db, id);
  let seq = row.event_seq; const t = row.transcript;
  for (const ev of events) {
    if (ev.seq <= seq) continue;
    if (["farend", "agent", "dtmf", "state"].includes(ev.type)) t.push({ seq: ev.seq, type: ev.type, ...ev.data, at: ev.at || null });
    seq = ev.seq;
  }
  await db.execute({ sql: "UPDATE phone_calls SET event_seq=?, transcript_json=?, updated_at=datetime('now') WHERE id=?", args: [seq, J(t), id] });
  return { lastSeq: seq };
}

export async function finalizeCall(db, id, { outcome, booking, summary, error }) {
  const r = await db.execute({
    sql: "UPDATE phone_calls SET status='done', outcome=?, booking_json=?, summary=?, error=?, ended_at=datetime('now'), token_hash=NULL WHERE id=? AND status IN ('starting','live')",
    args: [outcome, J(booking), summary || null, error || null, id] });
  if (r.rowsAffected) await audit(db, id, "service", "finalized", { outcome });
  return r.rowsAffected === 1;
}

export async function markDelivered(db, id) {
  const r = await db.execute({ sql: "UPDATE phone_calls SET delivered=1 WHERE id=? AND delivered=0", args: [id] });
  return r.rowsAffected === 1;
}

export async function addSuppression(db, e164, reason) {
  await db.execute({ sql: "INSERT OR IGNORE INTO phone_suppression (number_e164, reason) VALUES (?,?)", args: [e164, reason || null] });
}

export async function suppressedSet(db) {
  return new Set((await db.execute({ sql: "SELECT number_e164 FROM phone_suppression", args: [] })).rows.map((r) => r.number_e164));
}

export async function callsTodayCount(db) {
  return (await db.execute({ sql: "SELECT COUNT(*) n FROM phone_calls WHERE started_at > datetime('now','start of day')", args: [] })).rows[0].n;
}

export async function recentCallToNumber(db, e164, minutes = 10) {
  return (await db.execute({ sql: "SELECT COUNT(*) n FROM phone_calls WHERE number_e164=? AND started_at > datetime('now', ?)", args: [e164, `-${minutes} minutes`] })).rows[0].n > 0;
}

export async function listUndelivered(db, limit = 5) {
  const rows = (await db.execute({ sql: "SELECT id FROM phone_calls WHERE status='done' AND delivered=0 AND delivery_attempts < 5 AND (delivery_retry_at IS NULL OR delivery_retry_at <= datetime('now')) ORDER BY ended_at LIMIT ?", args: [limit] })).rows;
  const out = [];
  for (const r of rows) out.push(await getCall(db, r.id));
  return out;
}

export async function bumpDeliveryAttempt(db, id) {
  await db.execute({ sql: "UPDATE phone_calls SET delivery_attempts = delivery_attempts + 1 WHERE id=?", args: [id] });
}

/** Spec 2026-10-01 §4.6: the bot cannot take a turn RIGHT NOW (mid-turn, box
 *  full, or no engine yet after a restart). Not a failure — keep the delivery
 *  pending and back off 5,10,20,40,60,60… s, for up to `windowMinutes` after
 *  the call ended. Then give up (the result is still in Phone and on the chat
 *  card) and audit it. */
export async function deferDelivery(db, id, windowMinutes = 10) {
  const row = (await db.execute({ sql: "SELECT delivery_busy, (julianday('now') - julianday(ended_at)) * 1440 AS age_min FROM phone_calls WHERE id=?", args: [id] })).rows[0];
  if (!row) return { gaveUp: true };
  if (row.age_min != null && row.age_min >= windowMinutes) {
    await db.execute({ sql: "UPDATE phone_calls SET delivery_attempts=5, delivery_retry_at=NULL WHERE id=?", args: [id] });
    await audit(db, id, "service", "delivery_gave_up", { reason: "the bot could not take a turn", minutes: windowMinutes });
    return { gaveUp: true };
  }
  const n = Number(row.delivery_busy || 0);
  const delaySeconds = Math.min(60, 5 * 2 ** Math.min(n, 4));
  await db.execute({ sql: "UPDATE phone_calls SET delivery_busy=delivery_busy+1, delivery_retry_at=datetime('now', ?) WHERE id=?", args: [`+${delaySeconds} seconds`, id] });
  return { gaveUp: false, delaySeconds };
}
