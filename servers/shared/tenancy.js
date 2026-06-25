/**
 * Tenancy primitives (Phase 1.0 — identity only).
 *
 * The usage ledger keys on a real tenant_id from day one so every metered event
 * is attributable when Phase 3 isolation lands. v1 resolution is context-free:
 * one tenant per instance, `process.env.CROW_TENANT_ID` or the 'default'
 * constant. NO DB read, cannot throw — safe on the best-effort meter hot path.
 *
 * `resolveTenantId(ctx)` IGNORES `ctx` today; it exists as the Phase-3 seam
 * (Phase 3 replaces the body to resolve a real tenant from request/auth/device
 * WITHOUT changing any call site). Do NOT add query-scoping or a second live
 * tenant before Phase 3 — pre-isolation the contactId=null ACL bypass makes
 * tenant_id decorative for access control.
 */

export const DEFAULT_TENANT_ID = "default";

/** Resolve the tenant id for a metered event. Pure: env-or-constant, never throws. */
export function resolveTenantId(ctx = {}) {
  return process.env.CROW_TENANT_ID || DEFAULT_TENANT_ID;
}

/** Idempotent registry upsert. db is a libsql-style client ({ execute }). */
export async function ensureTenant(db, { id, name = null }) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)`,
    args: [id, name],
  });
}
