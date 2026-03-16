/**
 * MCP Session Logger — Tracks MCP client sessions and tool usage.
 *
 * Records when clients connect via HTTP/SSE transports, which tools
 * they call, and when sessions end. Data displayed on the Nest panel.
 *
 * Tool calls are accumulated in-memory and flushed to DB on session end
 * (or every 30s for long sessions) to minimize write overhead.
 */

import { createDbClient } from "../db.js";

// In-memory accumulator: sessionId → { serverName, toolCounts: Map<string, number>, dbRowId: number }
const _activeSessions = new Map();
let _flushTimer = null;

/**
 * Record a new MCP session start.
 */
export async function recordSessionStart({ sessionId, serverName, transport, clientInfo }) {
  const db = createDbClient();
  try {
    const result = await db.execute({
      sql: `INSERT INTO mcp_sessions (session_id, transport, server_name, client_info, started_at, last_activity_at)
            VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [sessionId, transport, serverName, clientInfo ? JSON.stringify(clientInfo) : null],
    });
    const dbRowId = Number(result.lastInsertRowid);
    _activeSessions.set(sessionId, { serverName, toolCounts: new Map(), dbRowId });

    // Start periodic flush if not already running
    if (!_flushTimer) {
      _flushTimer = setInterval(flushAllSessions, 30000);
    }
  } catch (err) {
    console.warn("[session-logger] Failed to record session start:", err.message);
  } finally {
    db.close();
  }
}

/**
 * Record a tool call for an active session.
 * Accumulates in memory — flushed to DB on session end or periodically.
 */
export function recordToolCall(sessionId, toolName) {
  const session = _activeSessions.get(sessionId);
  if (!session) return;
  const count = session.toolCounts.get(toolName) || 0;
  session.toolCounts.set(toolName, count + 1);
}

/**
 * Record session end — flush accumulated tool calls and set ended_at.
 */
export async function recordSessionEnd(sessionId) {
  const session = _activeSessions.get(sessionId);
  if (!session) return;
  _activeSessions.delete(sessionId);

  const db = createDbClient();
  try {
    const summary = Object.fromEntries(session.toolCounts);
    const totalCalls = [...session.toolCounts.values()].reduce((a, b) => a + b, 0);
    await db.execute({
      sql: `UPDATE mcp_sessions SET ended_at = datetime('now'), last_activity_at = datetime('now'),
            tool_calls_summary = ?, tool_call_count = ? WHERE id = ?`,
      args: [JSON.stringify(summary), totalCalls, session.dbRowId],
    });
  } catch (err) {
    console.warn("[session-logger] Failed to record session end:", err.message);
  } finally {
    db.close();
  }

  // Stop flush timer if no active sessions
  if (_activeSessions.size === 0 && _flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

/**
 * Flush all active session tool counts to DB (called periodically).
 */
async function flushAllSessions() {
  if (_activeSessions.size === 0) return;
  const db = createDbClient();
  try {
    for (const [, session] of _activeSessions) {
      const summary = Object.fromEntries(session.toolCounts);
      const totalCalls = [...session.toolCounts.values()].reduce((a, b) => a + b, 0);
      await db.execute({
        sql: `UPDATE mcp_sessions SET last_activity_at = datetime('now'),
              tool_calls_summary = ?, tool_call_count = ? WHERE id = ?`,
        args: [JSON.stringify(summary), totalCalls, session.dbRowId],
      });
    }
  } catch (err) {
    console.warn("[session-logger] Flush failed:", err.message);
  } finally {
    db.close();
  }
}

/**
 * Get recent MCP sessions for the Nest panel.
 */
export async function getRecentSessions(db, limit = 10) {
  const { rows } = await db.execute({
    sql: `SELECT id, session_id, transport, server_name, client_info, tool_calls_summary,
                 tool_call_count, started_at, ended_at, last_activity_at
          FROM mcp_sessions ORDER BY started_at DESC LIMIT ?`,
    args: [limit],
  });
  return rows.map(r => ({
    ...r,
    client_info: r.client_info ? JSON.parse(r.client_info) : null,
    tool_calls_summary: r.tool_calls_summary ? JSON.parse(r.tool_calls_summary) : {},
  }));
}

/**
 * Clean up old sessions (called at gateway startup).
 */
export async function cleanupOldSessions(db, daysToKeep = 30) {
  try {
    await db.execute({
      sql: "DELETE FROM mcp_sessions WHERE started_at < datetime('now', ?)",
      args: [`-${daysToKeep} days`],
    });
  } catch {}
}
