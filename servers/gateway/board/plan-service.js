/**
 * Plan service — plans become records (Track 1, Task 3 / D-T1.4).
 *
 * `board_plans` rows are never edited in place: `savePlan` always appends a
 * new version as `draft`; `approvePlan` marks one version `approved` and
 * supersedes whatever version was previously `approved` for the same item,
 * in one transaction (`tdb.batch`). "Current plan" is derived, not a pointer
 * column: the latest `approved` version if one exists, else the latest
 * `draft`, else null (D-T1.4: an approved plan stays "current" even after a
 * newer draft is saved on top of it, until THAT draft is approved).
 *
 * Errors use the same `{code, http}` idiom as card-service.js.
 *
 * `tdb` is tasks.db (createDbClient(TASKS_DB)) — board_plans is
 * instance-global-only (D-T1.4 store-topology rule); this file never
 * resolves a path itself.
 */

import { recordMutation } from "./card-service.js";

function fail(msg, code, http) {
  return Object.assign(new Error(msg), { code, http });
}

function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Latest approved version, else latest draft, else null. */
export async function getCurrentPlan(tdb, itemId) {
  const approved = (await tdb.execute({
    sql: "SELECT * FROM board_plans WHERE item_id=? AND status='approved' ORDER BY version DESC LIMIT 1",
    args: [itemId],
  })).rows[0];
  if (approved) return approved;
  const draft = (await tdb.execute({
    sql: "SELECT * FROM board_plans WHERE item_id=? AND status='draft' ORDER BY version DESC LIMIT 1",
    args: [itemId],
  })).rows[0];
  return draft || null;
}

/** All versions for an item, newest first. */
export async function listPlans(tdb, itemId) {
  return (await tdb.execute({
    sql: "SELECT * FROM board_plans WHERE item_id=? ORDER BY version DESC",
    args: [itemId],
  })).rows;
}

/**
 * Appends version n+1 as 'draft'; records 'plan_save'.
 *
 * Track 1 review fix wave (Finding 6): the version number used to be
 * computed by a separate read (SELECT MAX) before the INSERT, with no
 * transaction tying them together — two concurrent savePlan calls for the
 * same item could both read the same MAX and both attempt to insert the
 * same version. board_plans' UNIQUE(item_id, version) turns that into a
 * loud failure rather than a silent collision, but the loser still 500s for
 * a caller who did nothing wrong. Fixed by folding the MAX computation into
 * the INSERT's own subselect, so the read and the write are the SAME
 * statement — there is no window between them for a second call to land in.
 */
export async function savePlan(tdb, itemId, bodyMd, actor) {
  const a = actor || {};
  const r = await tdb.execute({
    sql: `INSERT INTO board_plans (item_id, version, body_md, status, created_actor_kind, created_actor_id)
          SELECT ?, COALESCE(MAX(version), 0) + 1, ?, 'draft', ?, ?
          FROM board_plans WHERE item_id=?`,
    args: [itemId, String(bodyMd ?? ""), a.kind || "human", a.id ?? null, itemId],
  });
  // The subselect's COALESCE(MAX(version),0)+1 always yields exactly one row
  // (COALESCE guarantees a result even with zero existing plans), so this
  // read-back is just recovering the value the INSERT itself computed —
  // never a second racy computation.
  const saved = (await tdb.execute({
    sql: "SELECT version FROM board_plans WHERE id=?",
    args: [r.lastInsertRowid],
  })).rows[0];
  const version = Number(saved.version);
  await recordMutation(tdb, { itemId, verb: "plan_save", actor, detail: { version: [null, version] } });
  return { id: Number(r.lastInsertRowid), version };
}

/**
 * Marks `version` approved and supersedes the item's prior approved version
 * (if any) — one transaction (tdb.batch). `via` is a decided_via value
 * ('chat'|'dashboard'|'auto'). Records 'plan_approve'.
 */
export async function approvePlan(tdb, itemId, version, actor, via) {
  const row = (await tdb.execute({
    sql: "SELECT * FROM board_plans WHERE item_id=? AND version=?",
    args: [itemId, version],
  })).rows[0];
  if (!row) throw fail(`plan version not found: ${version}`, "not_found", 404);
  if (row.status !== "draft") throw fail(`plan version is not a draft: ${row.status}`, "bad_version", 400);

  const stamp = nowStamp();
  await tdb.batch([
    {
      sql: "UPDATE board_plans SET status='superseded' WHERE item_id=? AND status='approved'",
      args: [itemId],
    },
    {
      sql: "UPDATE board_plans SET status='approved', decided_at=?, decided_via=? WHERE item_id=? AND version=?",
      args: [stamp, via ?? null, itemId, version],
    },
  ]);

  await recordMutation(tdb, {
    itemId,
    verb: "plan_approve",
    actor,
    detail: { version: [null, version], decided_via: [null, via ?? null] },
  });

  return { id: Number(row.id), version, status: "approved" };
}
