/**
 * pi-bots usage capture (Phase 1.4 of the metered-inference roadmap).
 *
 * Records one usage_events row per bot inference turn (surface="bot"), reusing
 * the SHARED servers/shared/metering.js recordUsageEvent path so the bot leg
 * shares the gateway's price book + single recording semantics (reconciliation,
 * Phase 1.5, must trust one path).
 *
 * The bridge / job runner speak better-sqlite3; recordUsageEvent + loadPricingRules
 * speak the libsql {execute({sql,args})} surface. `libsqlAdapter` is a thin
 * {execute} shim over an EXISTING better-sqlite3 connection. It deliberately does
 * NOT use servers/db.js createDbClient: that flips journal_mode to WAL on high-RAM
 * hosts (crow) and registers a keeper — the crowdb-wal-flip-new-consumers hazard
 * the bridge avoids by opening busy_timeout-only. This shim flips nothing.
 */
import { recordUsageEvent } from "../../servers/shared/metering.js";

// Wrap a better-sqlite3 connection in the async {execute} surface that
// recordUsageEvent / loadPricingRules expect. SELECT -> {rows}; write -> {rowsAffected}.
export function libsqlAdapter(conn) {
  return {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const args = (typeof arg === "string" ? [] : arg.args) || [];
      const stmt = conn.prepare(sql);
      if (/^\s*select/i.test(sql)) return { rows: stmt.all(...args) };
      const info = stmt.run(...args);
      return { rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
  };
}
