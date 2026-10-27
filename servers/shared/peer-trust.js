/**
 * The one definition of "trusted peer" (PT-1).
 *
 * A peer credential (bearer, HMAC signature, SSO ticket, sync handshake) is
 * accepted only if the peer's crow_instances row passes TRUSTED_PEER_SQL at
 * the moment of use. There is no cache: every check reads the row, so a
 * revoke written by any process (gateway or stdio MCP server) takes effect on
 * the next request.
 *
 * On a DB error the lookup is retried once on a fresh client (a re-opened
 * file re-maps a desynced WAL/shm; see validateInstanceToken). If both fail
 * the peer is refused, loudly: one console line per peer per minute plus a
 * Nest health item. Refusing a possibly revoked peer is the safe direction.
 */

import { recordTrustLookupFailure } from "./peer-trust-health.js";

export const TRUSTED_PEER_SQL = "trusted = 1 AND status IN ('active','offline')";

const LOG_EVERY_MS = 60_000;
let _lastLog = new Map();

/** Test seam. */
export function _resetPeerTrustLogForTest() { _lastLog = new Map(); }

async function defaultFreshClient() {
  const { createDbClient } = await import("../db.js");
  return createDbClient();
}

function classify(row) {
  if (!row) return "unknown";
  if (row.status === "revoked") return "revoked";
  if (row.status === "paused") return "paused";
  if (Number(row.trusted) !== 1) return "untrusted";
  if (row.status !== "active" && row.status !== "offline") return "untrusted";
  return null;
}

/** The predicate applied to a row already in hand (same rule as TRUSTED_PEER_SQL). */
export function rowIsTrusted(row) {
  return classify(row) === null;
}

/**
 * @param {object} db  libsql-shaped client ({ execute })
 * @param {string} id  crow_instances.id
 * @param {object} [opts]
 * @param {() => object|Promise<object>} [opts.freshClient]  opens a fresh client for the retry
 * @param {() => number} [opts.now]
 * @returns {Promise<{ok: boolean, row: object|null, reason: null|'unknown'|'revoked'|'paused'|'untrusted'|'trust_lookup_failed'}>}
 */
export async function peerTrust(db, id, { freshClient, now = () => Date.now() } = {}) {
  if (!id) return { ok: false, row: null, reason: "unknown" };
  const stmt = { sql: "SELECT * FROM crow_instances WHERE id = ?", args: [String(id)] };
  let row;
  try {
    const { rows } = await db.execute(stmt);
    row = rows[0] || null;
  } catch (err) {
    let fresh;
    try {
      fresh = await (freshClient || defaultFreshClient)();
      const { rows } = await fresh.execute(stmt);
      row = rows[0] || null;
    } catch (err2) {
      const t = now();
      const last = _lastLog.get(id);
      if (last == null || t - last >= LOG_EVERY_MS) {
        _lastLog.set(id, t);
        console.error(
          `[peer-trust] trust_lookup_failed for ${String(id).slice(0, 16)}: peer refused (fail closed). ` +
          `captured client: ${err.message}; fresh client: ${err2.message}`,
        );
      }
      recordTrustLookupFailure(id, err2.message, t);
      return { ok: false, row: null, reason: "trust_lookup_failed" };
    } finally {
      try { fresh?.close?.(); } catch { /* ignore */ }
    }
  }
  const reason = classify(row);
  return { ok: reason === null, row, reason };
}
