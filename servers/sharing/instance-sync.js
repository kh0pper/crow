/**
 * Instance Sync Manager — P2P data replication between Crow instances.
 *
 * Separate from the contact-to-contact SyncManager. Instance sync replicates
 * core data (memories, context, contacts, etc.) between instances owned by
 * the same user, using Hypercore feeds and Lamport timestamps.
 *
 * Entry format: { table, op, row, lamport_ts, instance_id, signature }
 *
 * Conflict resolution: if incoming.lamport_ts > local.lamport_ts → apply;
 * otherwise → log to sync_conflicts table preserving both versions.
 */

import Hypercore from "hypercore";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { sign, verify } from "./identity.js";
import { resolveDataDir } from "../db.js";

// Tables that participate in core sync
const SYNCED_TABLES = [
  "memories",
  "crow_context",
  "contacts",
  "shared_items",
  "messages",
  "relay_config",
  "crow_instances",
];

// Columns to exclude from sync payloads (security-sensitive or instance-local)
const EXCLUDED_COLUMNS = {
  crow_instances: ["auth_token_hash"],
};

export class InstanceSyncManager {
  /**
   * @param {object} identity - Crow identity (from loadOrCreateIdentity)
   * @param {import("@libsql/client").Client} db
   * @param {string} localInstanceId - This instance's UUID
   */
  constructor(identity, db, localInstanceId) {
    this.identity = identity;
    this.db = db;
    this.localInstanceId = localInstanceId;
    this.dataDir = resolve(resolveDataDir(), "instance-sync");

    // Per-remote-instance paired feeds
    this.outFeeds = new Map(); // remoteInstanceId → Hypercore (we write)
    this.inFeeds = new Map();  // remoteInstanceId → Hypercore (they write)

    // Local Lamport counter (monotonically increasing)
    this._localCounter = 0;
    this._counterLoaded = false;

    // Whether the manager has been started
    this.started = false;
  }

  /**
   * Load the local Lamport counter from the database.
   */
  async _ensureCounter() {
    if (this._counterLoaded) return;

    try {
      const { rows } = await this.db.execute({
        sql: "SELECT local_counter FROM sync_state WHERE instance_id = ?",
        args: [this.localInstanceId],
      });

      if (rows.length > 0) {
        this._localCounter = rows[0].local_counter;
      } else {
        // First time — insert initial state
        await this.db.execute({
          sql: "INSERT OR IGNORE INTO sync_state (instance_id, local_counter) VALUES (?, 0)",
          args: [this.localInstanceId],
        });
      }
    } catch (err) {
      console.warn("[instance-sync] Failed to load counter:", err.message);
    }

    this._counterLoaded = true;
  }

  /**
   * Increment and persist the local Lamport counter.
   * @returns {number} The new counter value
   */
  async _nextLamport() {
    await this._ensureCounter();
    this._localCounter++;

    await this.db.execute({
      sql: "UPDATE sync_state SET local_counter = ?, updated_at = datetime('now') WHERE instance_id = ?",
      args: [this._localCounter, this.localInstanceId],
    });

    return this._localCounter;
  }

  /**
   * Update the local counter to be at least as large as an incoming value.
   * @param {number} incomingTs - Lamport timestamp from a remote entry
   */
  async _advanceCounter(incomingTs) {
    await this._ensureCounter();
    if (incomingTs >= this._localCounter) {
      this._localCounter = incomingTs + 1;
      await this.db.execute({
        sql: "UPDATE sync_state SET local_counter = ?, updated_at = datetime('now') WHERE instance_id = ?",
        args: [this._localCounter, this.localInstanceId],
      });
    }
  }

  /**
   * Initialize feeds for a remote instance.
   * @param {string} remoteInstanceId
   * @param {Buffer|null} theirFeedKey - The remote instance's outgoing feed key (null if unknown yet)
   */
  async initInstance(remoteInstanceId, theirFeedKey) {
    const dir = resolve(this.dataDir, remoteInstanceId);
    mkdirSync(resolve(dir, "out"), { recursive: true });
    mkdirSync(resolve(dir, "in"), { recursive: true });

    // Our outgoing feed (writable by us)
    if (!this.outFeeds.has(remoteInstanceId)) {
      const outFeed = new Hypercore(resolve(dir, "out"), {
        valueEncoding: "json",
      });
      await outFeed.ready();
      this.outFeeds.set(remoteInstanceId, outFeed);
    }

    // Their incoming feed (writable by them)
    if (!this.inFeeds.has(remoteInstanceId) && theirFeedKey) {
      const inFeed = new Hypercore(resolve(dir, "in"), theirFeedKey, {
        valueEncoding: "json",
      });
      await inFeed.ready();

      // Listen for new entries
      inFeed.on("append", async () => {
        await this._processNewEntries(remoteInstanceId, inFeed);
      });

      this.inFeeds.set(remoteInstanceId, inFeed);
    }

    return this.outFeeds.get(remoteInstanceId);
  }

  /**
   * Get the local outgoing feed key for a remote instance.
   * Used during instance handshake so the remote knows our feed key.
   */
  getOutFeedKey(remoteInstanceId) {
    const feed = this.outFeeds.get(remoteInstanceId);
    return feed ? feed.key : null;
  }

  /**
   * Replicate feeds over a connection stream.
   * @param {string} remoteInstanceId
   * @param {object} stream - Hyperswarm connection
   */
  async replicate(remoteInstanceId, stream) {
    const outFeed = this.outFeeds.get(remoteInstanceId);
    const inFeed = this.inFeeds.get(remoteInstanceId);

    if (outFeed) outFeed.replicate(stream, { live: true });
    if (inFeed) inFeed.replicate(stream, { live: true });
  }

  /**
   * Emit a sync entry for a local data change.
   * Called by memory/context/sharing servers after mutations.
   *
   * @param {string} table - Table name (e.g., "memories")
   * @param {"insert"|"update"|"delete"} op - Operation type
   * @param {object} row - The row data (for insert/update) or { id } (for delete)
   */
  async emitChange(table, op, row) {
    if (!SYNCED_TABLES.includes(table)) return;

    const lamportTs = await this._nextLamport();

    // Strip excluded columns
    const excluded = EXCLUDED_COLUMNS[table] || [];
    const cleanRow = { ...row };
    for (const col of excluded) {
      delete cleanRow[col];
    }

    const entry = {
      table,
      op,
      row: cleanRow,
      lamport_ts: lamportTs,
      instance_id: this.localInstanceId,
    };

    // Sign the entry (signature over JSON without the signature field)
    const payload = JSON.stringify(entry);
    entry.signature = sign(payload, this.identity.ed25519Priv);

    // Update the row's lamport_ts in the local database
    if (op !== "delete" && row.id !== undefined) {
      try {
        await this.db.execute({
          sql: `UPDATE ${table} SET lamport_ts = ? WHERE id = ?`,
          args: [lamportTs, row.id],
        });
      } catch {
        // Non-fatal — row may not have lamport_ts column yet
      }
    }

    // Append to all outgoing feeds (broadcast to all connected instances)
    for (const [instanceId, feed] of this.outFeeds) {
      try {
        await feed.append(entry);
      } catch (err) {
        console.warn(`[instance-sync] Failed to append to feed for ${instanceId}:`, err.message);
      }
    }

    return lamportTs;
  }

  /**
   * Process new entries from a remote instance's incoming feed.
   */
  async _processNewEntries(remoteInstanceId, feed) {
    // Get checkpoint: last applied sequence for this peer
    const lastSeq = await this._getLastAppliedSeq(remoteInstanceId);

    for (let seq = lastSeq; seq < feed.length; seq++) {
      try {
        const entry = await feed.get(seq);
        await this._applyEntry(remoteInstanceId, entry);
      } catch (err) {
        console.warn(`[instance-sync] Failed to process entry ${seq} from ${remoteInstanceId}:`, err.message);
      }
    }

    // Update checkpoint
    await this._setLastAppliedSeq(remoteInstanceId, feed.length);
  }

  /**
   * Apply a single sync entry from a remote instance.
   */
  async _applyEntry(remoteInstanceId, entry) {
    const { table, op, row, lamport_ts, instance_id, signature } = entry;

    // Validate table
    if (!SYNCED_TABLES.includes(table)) return;

    // Verify signature
    const entryWithoutSig = { table, op, row, lamport_ts, instance_id };
    const payload = JSON.stringify(entryWithoutSig);

    // Look up the instance's public key
    const verified = verify(payload, signature, this.identity.ed25519Pubkey);
    // Note: For now, all instances share the same identity (same user).
    // In future, verify against the instance's registered public key.

    if (!verified) {
      console.warn(`[instance-sync] Signature verification failed for entry from ${remoteInstanceId}`);
      return;
    }

    // Advance local counter
    await this._advanceCounter(lamport_ts);

    // Check for conflicts
    if (op === "update" && row.id !== undefined) {
      const conflict = await this._checkConflict(table, row.id, lamport_ts, instance_id, row);
      if (conflict === "skip") return; // Local version wins
    }

    // Apply the change
    try {
      switch (op) {
        case "insert":
          await this._applyInsert(table, row, lamport_ts, instance_id);
          break;
        case "update":
          await this._applyUpdate(table, row, lamport_ts, instance_id);
          break;
        case "delete":
          await this._applyDelete(table, row);
          break;
      }
    } catch (err) {
      console.warn(`[instance-sync] Failed to apply ${op} on ${table}:`, err.message);
    }
  }

  /**
   * Check if applying an update would conflict with a local version.
   * @returns {"apply"|"skip"} Whether to apply the incoming change
   */
  async _checkConflict(table, rowId, incomingTs, incomingInstanceId, incomingRow) {
    try {
      const { rows } = await this.db.execute({
        sql: `SELECT * FROM ${table} WHERE id = ?`,
        args: [rowId],
      });

      if (rows.length === 0) return "apply"; // No local version — safe to apply

      const localRow = rows[0];
      const localTs = localRow.lamport_ts || 0;

      if (incomingTs > localTs) {
        return "apply"; // Incoming is newer
      }

      if (incomingTs <= localTs) {
        // Conflict — log both versions
        await this.db.execute({
          sql: `INSERT INTO sync_conflicts (table_name, row_id, winning_instance_id, losing_instance_id, winning_lamport_ts, losing_lamport_ts, winning_data, losing_data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            table,
            String(rowId),
            localRow.instance_id || this.localInstanceId,
            incomingInstanceId,
            localTs,
            incomingTs,
            JSON.stringify(localRow),
            JSON.stringify(incomingRow),
          ],
        });
        return "skip"; // Local version wins
      }
    } catch (err) {
      console.warn(`[instance-sync] Conflict check failed for ${table}:${rowId}:`, err.message);
    }

    return "apply"; // Default to applying on error
  }

  /**
   * Apply an insert operation from a remote instance.
   */
  async _applyInsert(table, row, lamportTs, instanceId) {
    const cols = Object.keys(row);
    // Add sync metadata
    if (!cols.includes("lamport_ts")) cols.push("lamport_ts");
    if (!cols.includes("instance_id") && table === "memories") cols.push("instance_id");

    const values = cols.map(c => {
      if (c === "lamport_ts") return lamportTs;
      if (c === "instance_id" && row[c] === undefined) return instanceId;
      return row[c] ?? null;
    });

    const placeholders = cols.map(() => "?").join(", ");
    const colNames = cols.join(", ");

    await this.db.execute({
      sql: `INSERT OR IGNORE INTO ${table} (${colNames}) VALUES (${placeholders})`,
      args: values,
    });
  }

  /**
   * Apply an update operation from a remote instance.
   */
  async _applyUpdate(table, row, lamportTs) {
    if (row.id === undefined) return;

    const updates = [];
    const params = [];

    for (const [key, value] of Object.entries(row)) {
      if (key === "id") continue;
      updates.push(`${key} = ?`);
      params.push(value ?? null);
    }

    // Always update lamport_ts
    updates.push("lamport_ts = ?");
    params.push(lamportTs);

    params.push(row.id);

    await this.db.execute({
      sql: `UPDATE ${table} SET ${updates.join(", ")} WHERE id = ?`,
      args: params,
    });
  }

  /**
   * Apply a delete operation from a remote instance.
   */
  async _applyDelete(table, row) {
    if (row.id === undefined) return;

    await this.db.execute({
      sql: `DELETE FROM ${table} WHERE id = ?`,
      args: [row.id],
    });
  }

  /**
   * Get the last applied sequence number for a remote instance's feed.
   */
  async _getLastAppliedSeq(remoteInstanceId) {
    try {
      const { rows } = await this.db.execute({
        sql: "SELECT last_applied_seq_per_peer FROM sync_state WHERE instance_id = ?",
        args: [this.localInstanceId],
      });

      if (rows.length > 0 && rows[0].last_applied_seq_per_peer) {
        const seqs = JSON.parse(rows[0].last_applied_seq_per_peer);
        return seqs[remoteInstanceId] || 0;
      }
    } catch {}

    return 0;
  }

  /**
   * Update the last applied sequence number for a remote instance's feed.
   */
  async _setLastAppliedSeq(remoteInstanceId, seq) {
    try {
      const { rows } = await this.db.execute({
        sql: "SELECT last_applied_seq_per_peer FROM sync_state WHERE instance_id = ?",
        args: [this.localInstanceId],
      });

      let seqs = {};
      if (rows.length > 0 && rows[0].last_applied_seq_per_peer) {
        seqs = JSON.parse(rows[0].last_applied_seq_per_peer);
      }

      seqs[remoteInstanceId] = seq;

      await this.db.execute({
        sql: "UPDATE sync_state SET last_applied_seq_per_peer = ?, updated_at = datetime('now') WHERE instance_id = ?",
        args: [JSON.stringify(seqs), this.localInstanceId],
      });
    } catch (err) {
      console.warn(`[instance-sync] Failed to update checkpoint for ${remoteInstanceId}:`, err.message);
    }
  }

  /**
   * Get sync status summary for all connected instances.
   */
  async getSyncStatus() {
    const status = [];

    for (const [instanceId, feed] of this.outFeeds) {
      const inFeed = this.inFeeds.get(instanceId);
      const lastSeq = await this._getLastAppliedSeq(instanceId);

      status.push({
        instanceId,
        outFeedLength: feed.length,
        inFeedLength: inFeed ? inFeed.length : 0,
        lastAppliedSeq: lastSeq,
        pendingEntries: inFeed ? Math.max(0, inFeed.length - lastSeq) : 0,
      });
    }

    return status;
  }

  /**
   * Close all feeds.
   */
  async close() {
    for (const feed of this.outFeeds.values()) {
      try { await feed.close(); } catch {}
    }
    for (const feed of this.inFeeds.values()) {
      try { await feed.close(); } catch {}
    }
    this.outFeeds.clear();
    this.inFeeds.clear();
    this.started = false;
  }
}
