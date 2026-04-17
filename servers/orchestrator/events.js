/**
 * Orchestrator event logger.
 *
 * Subscribes to lifecycle events (from lifecycle.js) and dispatch events
 * (emitted by server.js during orchestration) and persists them to the
 * `orchestrator_events` table. The minimal CLI tail script
 * (scripts/orchestrator-events-tail.js) reads this table; the full Crow's
 * Nest timeline panel also draws from it.
 *
 * Never throws — logging failures must not break the orchestration path.
 */

import { onLifecycleEvent } from "./lifecycle.js";
import bus from "../shared/event-bus.js";

let _db = null;

/**
 * Attach the logger to a DB client. Must be called once at orchestrator
 * server startup. Idempotent.
 */
export function attachEventLogger(db) {
  if (!db || _db === db) return; // already attached to this db
  _db = db;

  onLifecycleEvent((evt) => {
    logEvent({
      event_type: `lifecycle.${evt.type}`,
      provider_id: evt.providerId || null,
      bundle_id: evt.bundleId || null,
      refs: typeof evt.refs === "number" ? evt.refs : null,
      data: pickData(evt),
    });
  });
}

function pickData(evt) {
  const clone = { ...evt };
  delete clone.type;
  delete clone.providerId;
  delete clone.bundleId;
  delete clone.refs;
  if (Object.keys(clone).length === 0) return null;
  try { return JSON.stringify(clone); } catch { return null; }
}

/**
 * Manually log a dispatch-side event (run_start, run_end, agent_start, etc).
 * Non-throwing: logs to console on failure and continues.
 */
export async function logEvent({
  run_id = null,
  event_type,
  provider_id = null,
  bundle_id = null,
  preset = null,
  agent_name = null,
  refs = null,
  data = null,
}) {
  if (!_db || !event_type) return;
  try {
    await _db.execute({
      sql: `INSERT INTO orchestrator_events
            (run_id, event_type, provider_id, bundle_id, preset, agent_name, refs, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        run_id, event_type, provider_id, bundle_id, preset, agent_name, refs,
        typeof data === "string" ? data : (data ? JSON.stringify(data) : null),
      ],
    });
  } catch (err) {
    console.warn(`[orch-events] log failed: ${err.message}`);
  }
  // Broadcast to any Nest panel clients listening via Turbo Stream. The
  // emit is after the insert so a subscriber failure (or bus-side
  // error) cannot block the write or any caller. Real event_type
  // strings seen in the codebase as of 2026-04-16:
  //   dispatch.{provider_ready,provider_failed,aborted,run_start,
  //             run_complete,run_error}
  //   lifecycle.{ref_inc,warm_existing,bundle_start,
  //              bundle_start_failed,warm_timeout,warmed,
  //              release_ignored_pinned,ref_dec,bundle_stop,released,
  //              refcounts_reset}
  try {
    bus.emit("orchestrator:event", {
      event_type,
      run_id,
      provider_id,
      bundle_id,
      preset,
      agent_name,
      refs,
      data,
      at: new Date().toISOString(),
    });
  } catch {}
}

/**
 * Fetch recent events (for CLI tail + Nest panel).
 */
export async function listRecentEvents({ limit = 100, sinceSeconds = null, runId = null } = {}) {
  if (!_db) return [];
  const args = [];
  let where = "";
  if (runId) { where = "WHERE run_id = ?"; args.push(runId); }
  else if (sinceSeconds) { where = `WHERE at >= datetime('now', ?)`; args.push(`-${sinceSeconds} seconds`); }
  args.push(limit);
  const { rows } = await _db.execute({
    sql: `SELECT * FROM orchestrator_events ${where} ORDER BY id DESC LIMIT ?`,
    args,
  });
  return rows;
}
