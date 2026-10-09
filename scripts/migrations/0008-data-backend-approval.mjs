// scripts/migrations/0008-data-backend-approval.mjs
//
// data_backends.approved_ref_sha256 — the dashboard owner's approval of an
// mcp_server backend, bound to the exact connection_ref it approved
// (servers/shared/data-backend-approval.js). The gateway starts an
// mcp_server row only while this matches, so a backend registered by an AI
// client or bot stays pending until the owner approves it.
//
// ADDITIVE column, no SCHEMA_GENERATION bump: init-db.js carries the same
// column (CREATE body + addColumnIfMissing) — one shape, two rails, so a
// co-hosted instance converging on its own restart gets it too (the
// 0005 story). Idempotent, absent-table tolerant, never destructive. A
// missing column reads as "not approved", so the gateway fails closed until
// this has run.
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0005-bot-sessions-label-cwd.mjs";

export const id = "0008-data-backend-approval";

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  let r;
  try {
    r = addColumnIfMissing(db, "data_backends", "approved_ref_sha256", "TEXT");
    log(`  data_backends.approved_ref_sha256: ${r}`);
  } finally {
    db.close();
  }
  return { applied: true, results: [r] };
}
