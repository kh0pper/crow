/**
 * Pending-change rows (spec §5.6). Every state transition is a compare-and-set in the single crow.db
 * (`UPDATE … WHERE id=? AND state=?`), so the live plugin and the close-time applier can both claim and only one wins.
 */
import { randomBytes } from "node:crypto";
import { WsError } from "../result.js";

export const STATES = Object.freeze(["pending", "claimed_live", "applying_close", "applied_live", "applied_close", "failed", "cancelled", "expired", "unknown_after_claim"]);
/** The ONE terminal-state list (spec §5.6); everything else that orders or offers changes imports it. */
export const TERMINAL = Object.freeze(new Set(["applied_live", "applied_close", "failed", "cancelled", "expired"]));
export const EXPIRY_MS = 7 * 86400e3;
const now = () => Date.now();
/** A change_id: pc_<base36 time><12 hex>. */
export const CHANGE_ID_RE = /^pc_[0-9a-z]{6,40}$/;
const newId = () => `pc_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
const PATCHABLE = new Set(["lease_until", "lease_owner", "claim_count", "result_json", "version_id", "inverse_json", "verified", "doc_key"]);

export async function get(db, id) { return (await db.execute({ sql: "SELECT * FROM workspace_pending_changes WHERE id=?", args: [String(id)] })).rows[0] || null; }

export async function enqueue(db, r) {
  const id = newId(); const t = now();
  // seq = max+1 per file inside the INSERT; UNIQUE(file_id, seq) turns a race into a retry
  for (let i = 0; ; i++) {
    try {
      await db.execute({ sql: `INSERT INTO workspace_pending_changes (id,file_id,path,seq,doc_key,tool,args_json,precondition_json,state,open_by_json,requested_by,created_at,updated_at)
        VALUES (?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM workspace_pending_changes WHERE file_id=?),?,?,?,?,'pending',?,?,?,?)`,
        args: [id, r.fileId, r.path, r.fileId, r.key ?? null, r.tool, JSON.stringify(r.args ?? {}), JSON.stringify(r.precondition ?? null), JSON.stringify(r.openBy ?? []), r.requestedBy ?? null, t, t] });
      return get(db, id);
    } catch (e) { if (i >= 2 || !/UNIQUE/.test(String(e.message))) throw e; }
  }
}

/** Compare-and-set: moves `id` from `from` to `to` (plus patch columns) only if it is still in `from`. */
export async function cas(db, id, from, to, patch = {}) {
  if (!STATES.includes(to)) throw new Error(`unknown state ${to}`);
  const cols = Object.keys(patch);
  for (const c of cols) if (!PATCHABLE.has(c)) throw new Error(`not a patchable column: ${c}`);
  const sets = ["state=?", "updated_at=?", ...cols.map((c) => `${c}=?`)];
  const res = await db.execute({ sql: `UPDATE workspace_pending_changes SET ${sets.join(",")} WHERE id=? AND state=?`, args: [to, now(), ...cols.map((c) => patch[c] ?? null), String(id), from] });
  return res.rowsAffected === 1;
}

/** Spec §5.6 order: the lowest-seq change whose earlier changes are ALL terminal, if it is in one of `states`. */
export async function nextApplicable(db, fileId, states = ["pending", "unknown_after_claim"]) {
  const rows = (await db.execute({ sql: "SELECT * FROM workspace_pending_changes WHERE file_id=? ORDER BY seq", args: [fileId] })).rows;
  for (const r of rows) { if (TERMINAL.has(r.state)) continue; return states.includes(r.state) ? r : null; } // an earlier non-terminal change blocks
  return null;
}

/** Files the close-time worker must look at (incl. live-applied changes not yet checked against the saved file). */
export async function filesWithWork(db) {
  return (await db.execute({ sql: "SELECT file_id, MIN(path) AS path FROM workspace_pending_changes WHERE state IN ('pending','unknown_after_claim','claimed_live') OR (state='applied_live' AND verified=0) GROUP BY file_id", args: [] })).rows;
}
export async function byKey(db, key) { return (await db.execute({ sql: "SELECT * FROM workspace_pending_changes WHERE doc_key=? ORDER BY file_id, seq", args: [String(key)] })).rows; }

/** pending for more than 7 days → expired; returns the ids that this call expired. */
export async function expireOld(db, at = now()) {
  const rows = (await db.execute({ sql: "SELECT id FROM workspace_pending_changes WHERE state='pending' AND created_at < ?", args: [at - EXPIRY_MS] })).rows;
  const out = [];
  for (const r of rows) if (await cas(db, r.id, "pending", "expired")) out.push(r.id);
  return out;
}
/** A live lease that ran out without an ack → unknown_after_claim (NOT pending: the edit may already be in the document). */
export async function releaseExpiredLeases(db, at = now()) {
  const rows = (await db.execute({ sql: "SELECT id FROM workspace_pending_changes WHERE state='claimed_live' AND lease_until < ?", args: [at] })).rows;
  for (const r of rows) await cas(db, r.id, "claimed_live", "unknown_after_claim");
}
/** K5-I5: a crash between the PUT and the final CAS strands applying_close; on start those become unknown_after_claim. */
export async function recoverStranded(db) {
  const rows = (await db.execute({ sql: "SELECT id FROM workspace_pending_changes WHERE state='applying_close'", args: [] })).rows;
  for (const r of rows) await cas(db, r.id, "applying_close", "unknown_after_claim");
  return rows.map((r) => r.id);
}
/** Paths are kept in step when a file is found again by id after a rename. */
export async function setPath(db, fileId, path) { await db.execute({ sql: "UPDATE workspace_pending_changes SET path=? WHERE file_id=?", args: [path, fileId] }); }
export async function markVerified(db, id) { await db.execute({ sql: "UPDATE workspace_pending_changes SET verified=1, updated_at=? WHERE id=? AND state='applied_live'", args: [now(), String(id)] }); }
/**
 * Claim the undo of a live-applied change, once: sets result_json.undone_by while the row is still applied_live
 * and not yet undone. Returns true for the one caller that wins.
 */
export async function claimUndo(db, id, marker) {
  const res = await db.execute({ sql: `UPDATE workspace_pending_changes SET result_json=json_set(COALESCE(result_json,'{}'),'$.undone_by',?), updated_at=?
    WHERE id=? AND state='applied_live' AND json_extract(COALESCE(result_json,'{}'),'$.undone_by') IS NULL`, args: [marker, now(), String(id)] });
  return res.rowsAffected === 1;
}

/** Give back an undo claim (only the caller's own marker): queueing the inverse failed, so undo may be retried. */
export async function releaseUndo(db, id, marker) {
  await db.execute({ sql: `UPDATE workspace_pending_changes SET result_json=json_remove(result_json,'$.undone_by'), updated_at=?
    WHERE id=? AND json_extract(COALESCE(result_json,'{}'),'$.undone_by')=?`, args: [now(), String(id), marker] });
}

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const resultOf = (r) => parse(r?.result_json, {});
export const argsOf = (r) => parse(r?.args_json, {});
export const preOf = (r) => parse(r?.precondition_json, null);
export const publicRow = (r) => ({
  ...resultOf(r),
  change_id: r.id, path: r.path, file_id: Number(r.file_id), tool: r.tool, state: r.state, open_by: parse(r.open_by_json, []),
  version_id: r.version_id || null, ...(r.state === "applied_live" ? { verified: Number(r.verified) === 1 } : {}),
  requested_by: r.requested_by || null, created: new Date(Number(r.created_at)).toISOString(), updated: new Date(Number(r.updated_at)).toISOString(),
});
export const notPending = () => new WsError("not_pending", "That change is no longer pending (it was applied, failed, expired or cancelled).");
export const noSuchChange = () => new WsError("not_found", "No queued change with that change_id on this Crow.");
