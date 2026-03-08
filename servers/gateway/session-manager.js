/**
 * SessionManager — Consolidated session storage for all MCP servers.
 *
 * Replaces the 8+ individual Maps that were previously scattered across
 * the gateway. Each server gets two session stores (streamable + SSE),
 * all managed through a single interface.
 */

export class SessionManager {
  constructor() {
    /** @type {Map<string, Map<string, { transport: any, server: any }>>} */
    this.stores = new Map();
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
