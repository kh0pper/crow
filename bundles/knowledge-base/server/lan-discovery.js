/**
 * LAN Discovery — mDNS/DNS-SD advertisement for Knowledge Base collections.
 *
 * When a collection has lan_enabled = 1, advertises a _crow-kb._tcp
 * service on the local network so devices can discover the KB.
 *
 * Uses the `multicast-dns` package (pure JS, no native deps).
 */

import mdns from "multicast-dns";
import { hostname } from "os";

const SERVICE_TYPE = "_crow-kb._tcp.local";

export class LanDiscovery {
  constructor(port) {
    this.port = port || parseInt(process.env.CROW_GATEWAY_PORT || "3001", 10);
    this.advertised = new Map(); // slug → collection info
    this.mdnsInstance = null;
    this.host = hostname() + ".local";
  }

  /**
   * Start the mDNS responder.
   */
  start() {
    if (this.mdnsInstance) return;

    this.mdnsInstance = mdns();

    this.mdnsInstance.on("query", (query) => {
      // Respond to queries for our service type
      for (const q of query.questions) {
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

    this.mdnsInstance.on("error", (err) => {
      // Non-fatal — mDNS may not work on all networks
      console.warn("[lan-discovery] mDNS error:", err.message);
    });
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
      this.mdnsInstance.destroy();
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
      this.mdnsInstance.respond({ answers, additionals });
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
    this.mdnsInstance.respond({
      answers: [
        { name: SERVICE_TYPE, type: "PTR", data: instanceName },
        { name: instanceName, type: "SRV", data: { port: this.port, target: this.host, weight: 0, priority: 0 } },
        { name: instanceName, type: "TXT", data: [`path=${info.path}`, `name=${info.name}`, `version=1`] },
      ],
    });
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
 */
export async function startLanDiscovery(db, port) {
  try {
    const result = await db.execute({
      sql: "SELECT slug, name FROM kb_collections WHERE lan_enabled = 1",
      args: [],
    });

    if (result.rows.length === 0) return null;

    instance = new LanDiscovery(port);
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
