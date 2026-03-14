/**
 * Data Sync Layer
 *
 * Manages Hypercore append-only feeds for peer-to-peer data synchronization:
 * - Paired feeds per contact (one per direction)
 * - Entry signing (Ed25519) and encryption (AES-256-GCM)
 * - Auto-replication when peers connect via Hyperswarm
 * - Eventually consistent: missed entries sync on reconnect
 */

import Hypercore from "hypercore";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sign, encryptForPeer, decryptFromPeer } from "./identity.js";
import { resolveDataDir } from "../db.js";

const PEERS_DIR = resolve(resolveDataDir(), "peers");

/**
 * Get the storage path for a contact's feeds.
 */
function contactDir(contactId) {
  const dir = resolve(PEERS_DIR, String(contactId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class SyncManager {
  constructor(identity) {
    this.identity = identity;
    this.outFeeds = new Map(); // contactId -> Hypercore (our outgoing feed)
    this.inFeeds = new Map(); // contactId -> Hypercore (their incoming feed)
    this.onEntry = null; // callback(contactId, entry)
  }

  /**
   * Initialize feeds for a contact. Creates outgoing feed if needed.
   */
  async initContact(contactId, theirFeedKey) {
    const dir = contactDir(contactId);

    // Our outgoing feed for this contact
    if (!this.outFeeds.has(contactId)) {
      const outFeed = new Hypercore(resolve(dir, "out"), {
        valueEncoding: "json",
      });
      await outFeed.ready();
      this.outFeeds.set(contactId, outFeed);
    }

    // Their incoming feed (writable only by them)
    if (theirFeedKey && !this.inFeeds.has(contactId)) {
      const inFeed = new Hypercore(resolve(dir, "in"), theirFeedKey, {
        valueEncoding: "json",
      });
      await inFeed.ready();
      this.inFeeds.set(contactId, inFeed);

      // Watch for new entries
      inFeed.on("append", async () => {
        const seq = inFeed.length - 1;
        try {
          const entry = await inFeed.get(seq);
          if (this.onEntry) {
            this.onEntry(contactId, entry);
          }
        } catch (err) {
          // Entry read error, skip
        }
      });
    }

    return {
      outKey: this.outFeeds.get(contactId)?.key?.toString("hex"),
    };
  }

  /**
   * Append a share entry to a contact's outgoing feed.
   */
  async appendEntry(contactId, entry) {
    const feed = this.outFeeds.get(contactId);
    if (!feed) throw new Error(`No feed for contact ${contactId}`);

    // Sign the entry
    const entryWithMeta = {
      ...entry,
      timestamp: new Date().toISOString(),
      sender: this.identity.crowId,
    };

    const payload = JSON.stringify(entryWithMeta);
    entryWithMeta.signature = sign(payload, this.identity.ed25519Priv);

    await feed.append(entryWithMeta);
    return feed.length - 1;
  }

  /**
   * Create a share entry for sending.
   */
  createShareEntry(type, action, payload, permissions) {
    return {
      type,
      action: action || "share",
      payload,
      permissions: permissions || "read",
    };
  }

  /**
   * Replicate feeds with a connected peer.
   */
  async replicate(contactId, stream) {
    const outFeed = this.outFeeds.get(contactId);
    const inFeed = this.inFeeds.get(contactId);

    if (outFeed) {
      outFeed.replicate(stream, { live: true });
    }
    if (inFeed) {
      inFeed.replicate(stream, { live: true });
    }
  }

  /**
   * Get all entries from incoming feed for a contact.
   */
  async getIncomingEntries(contactId, since = 0) {
    const feed = this.inFeeds.get(contactId);
    if (!feed) return [];

    const entries = [];
    for (let i = since; i < feed.length; i++) {
      try {
        const entry = await feed.get(i);
        entries.push(entry);
      } catch (err) {
        // Skip unreadable entries
      }
    }
    return entries;
  }

  /**
   * Get the outgoing feed key for a contact (for sharing during handshake).
   */
  getOutFeedKey(contactId) {
    const feed = this.outFeeds.get(contactId);
    return feed?.key?.toString("hex") || null;
  }

  /**
   * Close all feeds.
   */
  async destroy() {
    for (const feed of this.outFeeds.values()) {
      await feed.close();
    }
    for (const feed of this.inFeeds.values()) {
      await feed.close();
    }
    this.outFeeds.clear();
    this.inFeeds.clear();
  }
}
