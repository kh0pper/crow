/**
 * SessionManager — Consolidated session storage for all MCP servers.
 *
 * Replaces the 8+ individual Maps that were previously scattered across
 * the gateway. Each server gets two session stores (streamable + SSE),
 * all managed through a single interface.
 */

// Every live manager in this process, so a peer revoke (revoke-peer.js, the
// trust sweeper) can close that peer's sessions without a reference to the
// gateway's instance. A stdio process has none, which is a no-op.
const _live = new Set();

export class SessionManager {
  constructor() {
    /** @type {Map<string, Map<string, { transport: any, server: any, owner?: string|null }>>} */
    this.stores = new Map();
    _live.add(this);
  }

  /** Stop being reachable from the process-wide helpers (tests). */
  dispose() { _live.delete(this); }

  /**
   * Sessions record who opened them (`owner` = req.auth.clientId, e.g.
   * "instance:<id>" for a paired peer). Count one owner's open sessions.
   */
  countSessionsOwnedBy(owner) {
    if (!owner) return 0;
    let n = 0;
    for (const store of this.stores.values()) {
      for (const s of store.values()) if (s.owner === owner) n++;
    }
    return n;
  }

  /**
   * Close every transport one owner opened (PT-1: a revoked peer's open
   * streamable GET / SSE streams outlive the per-request bearer check).
   * @returns {Promise<number>} sessions closed
   */
  async closeSessionsOwnedBy(owner) {
    if (!owner) return 0;
    let n = 0;
    for (const store of this.stores.values()) {
      for (const [sid, s] of [...store.entries()]) {
        if (s.owner !== owner) continue;
        store.delete(sid);
        n++;
        try { await s.transport.close(); } catch { /* already closed */ }
      }
    }
    return n;
  }

  /**
   * Get or create a session store for a given server + transport type.
   * @param {string} serverName - e.g. "memory", "research"
   * @param {"streamable"|"sse"} transportType
   * @returns {Map<string, { transport: any, server: any }>}
   */
  getStore(serverName, transportType = "streamable") {
    const key = `${serverName}:${transportType}`;
    if (!this.stores.has(key)) {
      this.stores.set(key, new Map());
    }
    return this.stores.get(key);
  }

  /**
   * Get all sessions across all stores (for graceful shutdown).
   * @returns {Array<[string, { transport: any, server: any }]>}
   */
  allSessions() {
    const all = [];
    for (const store of this.stores.values()) {
      for (const entry of store.entries()) {
        all.push(entry);
      }
    }
    return all;
  }

  /**
   * Close all transports and clear all stores.
   */
  async closeAll() {
    for (const [, session] of this.allSessions()) {
      try {
        await session.transport.close();
      } catch {}
    }
    for (const store of this.stores.values()) {
      store.clear();
    }
  }
}

/** closeSessionsOwnedBy on every live manager in this process. */
export async function closeSessionsOwnedByEverywhere(owner) {
  let n = 0;
  for (const m of _live) n += await m.closeSessionsOwnedBy(owner);
  return n;
}

/** countSessionsOwnedBy over every live manager in this process. */
export function countSessionsOwnedByEverywhere(owner) {
  let n = 0;
  for (const m of _live) n += m.countSessionsOwnedBy(owner);
  return n;
}

/** The owner tag for a peer instance's sessions. */
export function peerSessionOwner(instanceId) { return `instance:${instanceId}`; }
