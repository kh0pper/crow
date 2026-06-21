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

// Non-negative per-dimension delta of two SessionStats.tokens snapshots. pi's
// get_session_stats sums usage over ALL current session messages, so a mid-turn
// compaction can shrink the cumulative count: clamp to >=0 and flag the undercount.
export function tokenDelta(before, after, log = () => {}) {
  const b = before || {};
  const a = after || {};
  const raw = {
    input: (a.input || 0) - (b.input || 0),
    output: (a.output || 0) - (b.output || 0),
    cacheRead: (a.cacheRead || 0) - (b.cacheRead || 0),
  };
  if (raw.input < 0 || raw.output < 0 || raw.cacheRead < 0) {
    log("[metering] compaction detected (after < before) — bot usage undercount this turn");
  }
  return {
    input: Math.max(0, raw.input),
    output: Math.max(0, raw.output),
    cacheRead: Math.max(0, raw.cacheRead),
  };
}

// Record one bot turn's usage. Best-effort by contract: the CALLER wraps this in
// try/catch (a metering failure must never break a turn). statsBefore/statsAfter
// are the SessionStats objects (.data from PiRpc.getSessionStats()), or null.
export async function meterBotTurn({
  conn, statsBefore, statsAfter, resolved, surface = "bot", requestId = null, log = () => {},
}) {
  if (!statsAfter || !statsAfter.tokens) return { recorded: false, reason: "no-stats" };
  const delta = tokenDelta(statsBefore && statsBefore.tokens, statsAfter.tokens, log);
  if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0) {
    return { recorded: false, reason: "zero-delta" };
  }
  const r = await recordUsageEvent(libsqlAdapter(conn), {
    surface,
    tenantId: null,
    providerId: resolved && resolved.provider != null ? resolved.provider : null,
    providerType: null,
    modelId: resolved && resolved.model != null ? resolved.model : null,
    inputTokens: delta.input,
    outputTokens: delta.output,
    cachedTokens: delta.cacheRead,
    requestId,
  });
  return { recorded: true, priced: r.priced, cost: r.cost };
}
