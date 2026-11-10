/**
 * LAN Discovery — mDNS/DNS-SD advertisement for Knowledge Base collections.
 *
 * When a collection has lan_enabled = 1, advertises a _crow-kb._tcp
 * service on the local network so devices can discover the KB.
 *
 * Uses the `multicast-dns` package (pure JS, no native deps). The module is
 * loaded on first start(), not at import time: an add-on running walled has no
 * multicast socket at all, and a missing or failing package must leave the KB
 * working with discovery off, not take the module down with it.
 */

import { createRequire } from "node:module";
import { hostname } from "os";

const SERVICE_TYPE = "_crow-kb._tcp.local";

/** Resolved where the bundle is installed (the package is a bundle dependency). */
const requireHere = createRequire(import.meta.url);

function defaultMdnsFactory() {
  return requireHere("multicast-dns");
}

/** What the last attempt to start a responder came to: `{ ok, reason }`. */
let status = { ok: true, reason: null };

/**
 * The mDNS start status: `ok` false (with a reason) when a responder could not
 * be created, e.g. inside an add-on's wall. Reading it never throws.
 */
export function lanDiscoveryStatus() {
  return { ...status };
}

export class LanDiscovery {
  /**
   * @param {number} [port]         the port the KB's public pages are served on
   * @param {object} [opts]
   * @param {Function} [opts.mdnsFactory] test seam: returns a responder or throws
   */
  constructor(port, opts = {}) {
    this.port = port || parseInt(process.env.CROW_GATEWAY_PORT || "3001", 10);
    this.advertised = new Map(); // slug → collection info
    this.mdnsInstance = null;
    this.host = hostname() + ".local";
    this.mdnsFactory = typeof opts?.mdnsFactory === "function" ? opts.mdnsFactory : defaultMdnsFactory;
    this.status = { ...status };
  }

  /**
   * Start the mDNS responder. A failure is recorded, never thrown: discovery is
   * optional (a walled add-on cannot use multicast at all).
   */
  start() {
    if (this.mdnsInstance) return;
    let responder = null;
    try {
      responder = this.mdnsFactory();
      if (!responder || typeof responder.on !== "function") throw new Error("the mDNS package gave no responder");
      responder.on("query", (query) => {
        // Respond to queries for our service type
        for (const q of query?.questions || []) {
          if (q.type === "PTR" && q.name === SERVICE_TYPE) {
            this._respondAll();
          }
          // Also respond to specific instance queries
          if (q.type === "SRV" || q.type === "TXT") {
            for (const [slug] of this.advertised) {
              const instanceName = `crow-kb-${slug}.${SERVICE_TYPE}`;
              if (q.name === instanceName) {
                this._respondOne(slug);
              }
            }
          }
        }
      });
      responder.on("error", (err) => {
        // Non-fatal — mDNS may not work on all networks
        console.warn("[lan-discovery] mDNS error:", err?.message);
      });
    } catch (err) {
      this.mdnsInstance = null;
      this._setStatus(false, err?.message || "mDNS could not start");
      console.warn("[lan-discovery] mDNS is off:", this.status.reason);
      return;
    }
    this.mdnsInstance = responder;
    this._setStatus(true, null);
  }

  /** Record the start status for this instance and for lanDiscoveryStatus(). */
  _setStatus(ok, reason) {
    this.status = { ok, reason };
    status = { ok, reason };
  }

  /**
   * Advertise a collection on the network.
   */
  advertise(collection) {
    this.advertised.set(collection.slug, {
      name: collection.name,
      slug: collection.slug,
      path: `/kb/${collection.slug}`,
    });

    if (!this.mdnsInstance) this.start();

    // Send an unsolicited announcement
    this._respondOne(collection.slug);
  }

  /**
   * Stop advertising a collection.
   */
  unadvertise(slug) {
    this.advertised.delete(slug);
  }

  /**
   * Stop the mDNS responder entirely.
   */
  stop() {
    if (this.mdnsInstance) {
      try { this.mdnsInstance.destroy(); } catch { /* it is going away either way */ }
      this.mdnsInstance = null;
    }
    this.advertised.clear();
  }

  /**
   * Respond with all advertised collections.
   */
  _respondAll() {
    if (!this.mdnsInstance) return;

    const answers = [];
    const additionals = [];

    for (const [slug, info] of this.advertised) {
      const instanceName = `crow-kb-${slug}.${SERVICE_TYPE}`;
      answers.push({ name: SERVICE_TYPE, type: "PTR", data: instanceName });
      additionals.push(
        { name: instanceName, type: "SRV", data: { port: this.port, target: this.host, weight: 0, priority: 0 } },
        { name: instanceName, type: "TXT", data: [`path=${info.path}`, `name=${info.name}`, `version=1`] }
      );
    }

    if (answers.length > 0) {
      try { this.mdnsInstance.respond({ answers, additionals }); } catch { /* the network is gone */ }
    }
  }

  /**
   * Respond with a single collection's records.
   */
  _respondOne(slug) {
    if (!this.mdnsInstance) return;
    const info = this.advertised.get(slug);
    if (!info) return;

    const instanceName = `crow-kb-${slug}.${SERVICE_TYPE}`;
    try {
      this.mdnsInstance.respond({
        answers: [
          { name: SERVICE_TYPE, type: "PTR", data: instanceName },
          { name: instanceName, type: "SRV", data: { port: this.port, target: this.host, weight: 0, priority: 0 } },
          { name: instanceName, type: "TXT", data: [`path=${info.path}`, `name=${info.name}`, `version=1`] },
        ],
      });
    } catch { /* the network is gone */ }
  }
}

// Singleton instance (shared across gateway lifetime)
let instance = null;

/**
 * Start LAN discovery for all enabled KB collections.
 * Called by the gateway after mounting KB routes.
 *
 * @param {object} db - Database client
 * @param {number} port - Gateway port
 * @param {object} [opts] - { mdnsFactory } test seam
 */
export async function startLanDiscovery(db, port, opts = {}) {
  try {
    const result = await db.execute({
      sql: "SELECT slug, name FROM kb_collections WHERE lan_enabled = 1",
      args: [],
    });

    if (result.rows.length === 0) return null;

    instance = new LanDiscovery(port, opts);
    instance.start();

    for (const row of result.rows) {
      instance.advertise(row);
      console.log(`[lan-discovery] Advertising KB: ${row.name} at /kb/${row.slug}`);
    }

    return instance;
  } catch (err) {
    console.warn("[lan-discovery] Failed to start:", err.message);
    return null;
  }
}

/**
 * Get the singleton LanDiscovery instance (if started).
 */
export function getLanDiscovery() {
  return instance;
}