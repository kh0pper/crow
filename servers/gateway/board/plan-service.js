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

/** Appends version n+1 as 'draft'; records 'plan_save'. */
export async function savePlan(tdb, itemId, bodyMd, actor) {
  const maxRow = (await tdb.execute({
    sql: "SELECT COALESCE(MAX(version), 0) AS mx FROM board_plans WHERE item_id=?",
    args: [itemId],
  })).rows[0];
  const version = Number(maxRow.mx) + 1;
  const a = actor || {};
  const r = await tdb.execute({
    sql: `INSERT INTO board_plans (item_id, version, body_md, status, created_actor_kind, created_actor_id)
          VALUES (?,?,?,'draft',?,?)`,
    args: [itemId, version, String(bodyMd ?? ""), a.kind || "human", a.id ?? null],
  });
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
