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
import { shouldInitInstanceSync } from "./instance-sync.js";
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
    this._initLocks = new Map(); // contactId -> tail Promise (see initContact)
    // --no-auth companion: no per-contact sync feeds (would grab the feed lock).
    this.p2pDisabled = !shouldInitInstanceSync({ argv: process.argv, env: process.env });
  }

  /**
   * Initialize feeds for a contact. Creates outgoing feed if needed.
   *
   * Serialized per contact: the boot contacts loop (server.js:439), the
   * Nostr-invite auto-add path (server.js:481), and tool handlers (~:993)
   * can all call this for the same contactId. The outFeeds.has() /
   * inFeeds.has() guards are not atomic across the await in
   * Hypercore.ready(), so concurrent callers would otherwise race to
   * construct two Hypercores on the same on-disk feed and the loser
   * would throw "File descriptor could not be locked" from fd-lock.
   * See InstanceSyncManager.initInstance() for the same pattern.
   */
  async initContact(contactId, theirFeedKey) {
    if (this.p2pDisabled) return null; // --no-auth companion: no per-contact feeds
    const prior = this._initLocks.get(contactId) || Promise.resolve();
    const next = prior
      .catch(() => {}) // a failed prior turn shouldn't block our attempt
      .then(() => this._initContactInner(contactId, theirFeedKey));
    this._initLocks.set(contactId, next);
    try {
      return await next;
    } finally {
      if (this._initLocks.get(contactId) === next) {
        this._initLocks.delete(contactId);
      }
    }
  }

  async _initContactInner(contactId, theirFeedKey) {
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
   * Close feeds for a single contact and remove them from the Maps.
   *
   * Serialized through the _initLocks tail so close cannot interleave with a
   * concurrent initContact call for the same contactId. Hypercore close is safe
   * and the on-disk storage persists; the next initContact call will reopen.
   *
   * NOTE: unblock re-inits lazily via wireSyncedContact → wireFullContact →
   * initContact (F-BLOCK-1 D2) — both panel unblock handlers and the synced
   * onContactSynced hook route through it. Keep re-init OUT of this method.
   */
  async closeContactFeeds(contactId) {
    const prior = this._initLocks.get(contactId) || Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(() => this._closeContactFeedsInner(contactId));
    this._initLocks.set(contactId, next);
    try {
      return await next;
    } finally {
      if (this._initLocks.get(contactId) === next) {
        this._initLocks.delete(contactId);
      }
    }
  }

  async _closeContactFeedsInner(contactId) {
    const outFeed = this.outFeeds.get(contactId);
    if (outFeed) {
      try { await outFeed.close(); } catch {}
      this.outFeeds.delete(contactId);
    }
    const inFeed = this.inFeeds.get(contactId);
    if (inFeed) {
      try { await inFeed.close(); } catch {}
      this.inFeeds.delete(contactId);
    }
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
