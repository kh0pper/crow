/**
 * Data-backend approval — an `mcp_server` backend is a command the gateway
 * will execute, so registering one must not be enough to run it.
 *
 * - An AI client or bot (the crow_register_backend MCP tool) can only create
 *   a row in `pending_approval`.
 * - The dashboard owner approves it on the Projects page (session-authed,
 *   CSRF-checked POST). Approval stores the SHA-256 of the exact
 *   `connection_ref` text in `approved_ref_sha256`.
 * - The gateway starts a row only while that hash still matches: any later
 *   edit of the command, args or env-var names voids the approval.
 * - Rows never arrive from peers: data_backends is not an instance-sync
 *   table, and project clone bundles carry backend manifests without
 *   inserting them.
 */
import { createHash } from "node:crypto";

export const PENDING_STATUS = "pending_approval";

export function refHash(connectionRef) {
  return createHash("sha256").update(String(connectionRef ?? ""), "utf8").digest("hex");
}

/** True when `row` (an mcp_server data_backends row) is owner-approved as it stands. */
export function isApproved(row) {
  return !!row && typeof row.approved_ref_sha256 === "string"
    && row.approved_ref_sha256 === refHash(row.connection_ref);
}

/**
 * Launch-command verification hook. Every approved backend passes through
 * here right before it is spawned. Today it checks shape only; when the
 * add-on launcher verification (servers/shared/resolve-command.js) lands,
 * call its resolver here so backends get the same root-owned / pinned
 * launcher rules as add-ons.
 * @returns {{ ok: true, command: string, args: string[] } | { ok: false, reason: string }}
 */
export function verifyBackendLaunch(connRef) {
  if (!connRef || typeof connRef.command !== "string" || !connRef.command) {
    return { ok: false, reason: "connection_ref has no command" };
  }
  const args = Array.isArray(connRef.args) ? connRef.args : [];
  if (!args.every((a) => typeof a === "string")) return { ok: false, reason: "args must be strings" };
  return { ok: true, command: connRef.command, args };
}

/**
 * Owner action: approve the row's current connection_ref. When `expectedHash`
 * is given (the hash of the command the owner was shown), the approval only
 * lands if the row still carries exactly that command.
 */
export async function approveBackend(db, id, expectedHash) {
  const { rows } = await db.execute({
    sql: "SELECT id, connection_ref FROM data_backends WHERE id = ? AND backend_type = 'mcp_server'",
    args: [id],
  });
  if (!rows.length) return false;
  if (expectedHash !== undefined && expectedHash !== refHash(rows[0].connection_ref)) return false;
  await db.execute({
    sql: "UPDATE data_backends SET approved_ref_sha256 = ?, status = 'disconnected', last_error = NULL, updated_at = datetime('now') WHERE id = ?",
    args: [refHash(rows[0].connection_ref), id],
  });
  return true;
}

/** Owner action: withdraw an approval (the row stays, it is no longer started). */
export async function revokeBackendApproval(db, id) {
  const r = await db.execute({
    sql: "UPDATE data_backends SET approved_ref_sha256 = NULL, status = ?, updated_at = datetime('now') WHERE id = ? AND backend_type = 'mcp_server'",
    args: [PENDING_STATUS, id],
  });
  return (r.rowsAffected ?? 0) > 0;
}
