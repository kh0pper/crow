// Schema generation version — a pure, side-effect-free constant module.
//
// BUMP this by 1 whenever you add a schema migration to scripts/init-db.js
// (a new table, addColumnIfMissing, index, or data migration). On the next
// gateway boot, any install whose DB PRAGMA user_version is lower re-runs
// init-db (idempotent) to apply it. This closes the gap where out-of-band
// code updates + a plain restart didn't apply new columns.
//
// IMPORTANT: keep this module free of side-effecting imports. It is imported
// by servers/gateway/index.js during boot; importing scripts/init-db.js here
// (or anything that runs DB work at module top-level) would execute init-db
// as an unwanted side effect.
export const SCHEMA_GENERATION = 3;

// Pure decision helper for the gateway boot gate. Returns true when the DB
// needs init-db to run: either core tables are missing (fresh/incomplete
// install) OR the persisted schema stamp is behind the current generation
// (out-of-band code update that added migrations).
export function needsSchemaInit({ coreTableCount, userVersion, schemaGeneration }) {
  if (coreTableCount < 3) return true;
  if (userVersion < schemaGeneration) return true;
  return false;
}
