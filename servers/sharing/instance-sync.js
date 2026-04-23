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
import { isSyncable } from "../gateway/dashboard/settings/sync-allowlist.js";
import bus from "../shared/event-bus.js";

// Tables that participate in core sync
const SYNCED_TABLES = [
  "memories",
  "crow_context",
  "contacts",
  "shared_items",
  "messages",
  "relay_config",
  "crow_instances",
  // Phase 5-full: LLM provider registry. Operator-editable on any instance;
  // changes propagate to peers so model swaps/additions are one-and-done.
  // Toggle off by removing this line if you want per-instance divergence.
  "providers",
  // LLM consolidation: per-agent provider/model overrides for presets.
  // Synthetic `id` PK (= "${preset_name}:${agent_name}") so the standard
  // _applyInsert / _applyUpdate / _applyDelete paths dispatch correctly.
  "orchestrator_role_overrides",
  // Scoped-settings replication (2026-04-14): only rows with instance_id IS NULL
  // AND whose key is in the SYNC_ALLOWLIST are actually emitted/applied.
  // See shouldSyncRow() below.
  "dashboard_settings",
  // Phase 6 (meta-glasses note-taking). research_notes + glasses_note_sessions
  // replicate so notes captured via glasses surface on paired instances.
  // research_projects stays local-only — see OUTBOUND_TRANSFORMS: research_notes
  // below, which NULLs project_id on the wire.
  "research_notes",
  "glasses_note_sessions",
];

// Columns to exclude from sync payloads (security-sensitive or instance-local)
const EXCLUDED_COLUMNS = {
  crow_instances: ["auth_token_hash"],
  // apiKey can be sensitive for some deployments; keep in sync by default for
  // local-lab scenarios but flag here as the place to exclude if paranoid.
  providers: [],
};

// Per-table outbound mutations applied right after the EXCLUDED_COLUMNS strip.
// Use for cases where the local representation differs from the synced
// representation — e.g. research_notes.project_id is a local FK (project rows
// aren't synced), so we NULL it on the wire. Synced notes show up on peers
// as project-less (null project_id).
const OUTBOUND_TRANSFORMS = {
  research_notes: (row) => ({ ...row, project_id: null }),
};

/**
 * Per-table filter: decide whether a mutated row should be broadcast (or an
 * inbound row applied). Returning false means "this row is local-only; skip it".
 *
 * For dashboard_settings we enforce:
 *   - instance_id IS NULL (i.e. the global scope row)
 *   - key matches the SYNC_ALLOWLIST
 *
 * All other synced tables default to true (no filter).
 */
// Debounced storage-client invalidation. The six storage.shared.* keys arrive
// as six separate sync entries within milliseconds; a 500ms trailing debounce
// collapses that burst into one resetStorageClient() call after the write
// settles, avoiding five intermediate rebuilds against partial config.
let _storageResetTimer = null;
function _scheduleStorageReset() {
  if (_storageResetTimer) clearTimeout(_storageResetTimer);
  _storageResetTimer = setTimeout(async () => {
    _storageResetTimer = null;
    try {
      const { resetStorageClient } = await import("../storage/s3-client.js");
      resetStorageClient();
    } catch (err) {
      console.warn("[instance-sync] resetStorageClient import failed:", err.message);
    }
  }, 500);
}

function shouldSyncRow(table, row) {
  if (table !== "dashboard_settings") return true;
  if (!row || !row.key) return false;
  // dashboard_settings holds only the global scope; per-instance overrides live
  // in dashboard_settings_overrides (never synced). Allowlist gates the key.
  return isSyncable(row.key);
}

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

    // Per-peer serialization for initInstance() — see initInstance() for why.
    this._initLocks = new Map(); // remoteInstanceId → tail Promise

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
    // Serialize per-peer to prevent concurrent fd-lock contention on
    // <feed-dir>/db/LOCK. Multiple startup paths converge here for the
    // same peer (boot loop at server.js, eagerInitPairedPeers, the
    // onInstanceConnected callback when Hyperswarm connects, tailnet-sync,
    // onInstanceKeyReceived after the handshake). The outFeeds.has()/
    // inFeeds.has() guards alone are not atomic across the await in
    // Hypercore.ready(), so two concurrent callers would each construct
    // a second Hypercore on the same on-disk feed, and the loser would
    // throw "File descriptor could not be locked".
    //
    // We can't cache the first call's promise and short-circuit subsequent
    // calls, because a later caller may arrive with a real theirFeedKey
    // that a prior null-key call skipped — we need to open the inFeed on
    // the later turn. So we strictly chain instead: each call awaits the
    // prior call, then re-evaluates state.
    const prior = this._initLocks.get(remoteInstanceId) || Promise.resolve();
    const next = prior
      .catch(() => {}) // a failed prior turn shouldn't block our attempt
      .then(() => this._initInstanceInner(remoteInstanceId, theirFeedKey));
    this._initLocks.set(remoteInstanceId, next);
    try {
      return await next;
    } finally {
      // If we're still the tail, drop the entry so the Map doesn't retain
      // a settled promise per peer over the process lifetime.
      if (this._initLocks.get(remoteInstanceId) === next) {
        this._initLocks.delete(remoteInstanceId);
      }
    }
  }

  async _initInstanceInner(remoteInstanceId, theirFeedKey) {
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
   * Eagerly open outbound feeds for every paired peer in `crow_instances`.
   * MUST be called at gateway boot BEFORE any `emitChange` can fire — otherwise
   * early emissions (memory stores, settings writes at startup, bundle
   * registrations) vanish silently: `emitChange` iterates `outFeeds`, which is
   * empty until a peer WebSocket lands, so its `feed.append` loop has zero
   * iterations while `_localCounter` advances anyway.
   *
   * Safe to re-call; `initInstance` no-ops if the out-feed already exists.
   * In-feeds are also pre-opened if the peer's `sync_url` (their outbound
   * feed key) is already cached — this lets startup `_processNewEntries`
   * catch up entries that mirrored during a previous session.
   */
  async eagerInitPairedPeers() {
    let rows = [];
    try {
      const r = await this.db.execute({
        sql: "SELECT id, sync_url FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
        args: [this.localInstanceId],
      });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] eagerInitPairedPeers: db query failed: ${err.message}`);
      return 0;
    }
    let opened = 0;
    for (const peer of rows) {
      try {
        const theirKey = peer.sync_url ? Buffer.from(peer.sync_url, "hex") : null;
        await this.initInstance(peer.id, theirKey);
        // Catch up any in-feed entries that arrived during a past session
        // but were never processed because `append` only fires on NEW
        // replicated blocks, not on re-opening an existing feed.
        const inFeed = this.inFeeds.get(peer.id);
        if (inFeed && inFeed.length > 0) {
          this._processNewEntries(peer.id, inFeed).catch((err) =>
            console.warn(`[instance-sync] eager catch-up failed for ${peer.id.slice(0,12)}…: ${err.message}`),
          );
        }
        opened++;
      } catch (err) {
        console.warn(`[instance-sync] eager init failed for ${peer.id.slice(0,12)}…: ${err.message}`);
      }
    }
    if (opened > 0) {
      console.log(`[instance-sync] eagerly opened ${opened} peer feed(s) — emit pipeline armed`);
    }
    return opened;
  }

  /**
   * One-shot reconciliation: re-emit every sync-allowlisted dashboard_settings
   * row so that peers whose pre-fix outFeed dropped entries can catch up.
   * Guarded by a flag row so it runs once per instance lifetime (post-fix).
   *
   * Called at boot AFTER eagerInitPairedPeers. Idempotent: re-running is a
   * no-op. On the peer side, `_applyDashboardSetting` skips rows whose
   * lamport_ts is stale or whose value is unchanged, so the re-emit is
   * safe even when the peer already has current data.
   */
  async reemitSyncableSettingsOnce() {
    const FLAG_KEY = "__sync_reemit_allowlist_v1";
    let alreadyRan = false;
    try {
      const { rows } = await this.db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = ?",
        args: [FLAG_KEY],
      });
      alreadyRan = rows?.length > 0;
    } catch {}
    if (alreadyRan) return 0;

    if (this.outFeeds.size === 0) {
      // No paired peers — nothing to reconcile with. Still mark done so we
      // don't keep checking on every boot.
      try {
        await this.db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, 'no-peers', datetime('now')) ON CONFLICT(key) DO NOTHING",
          args: [FLAG_KEY],
        });
      } catch {}
      return 0;
    }

    // dashboard_settings is the global scope only — per-instance scopes live
    // in dashboard_settings_overrides (never synced). No instance_id column.
    let rows;
    try {
      const r = await this.db.execute({
        sql: "SELECT key, value, lamport_ts FROM dashboard_settings",
      });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] reemit read failed: ${err.message}`);
      return 0;
    }

    let emitted = 0;
    for (const row of rows) {
      if (!isSyncable(row.key)) continue;
      try {
        await this.emitChange("dashboard_settings", "update", {
          key: row.key,
          value: row.value,
          instance_id: null,
        });
        emitted++;
      } catch (err) {
        console.warn(`[instance-sync] reemit ${row.key} failed: ${err.message}`);
      }
    }

    try {
      await this.db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO NOTHING",
        args: [FLAG_KEY, `done:${emitted}`],
      });
    } catch {}

    if (emitted > 0) {
      console.log(`[instance-sync] one-shot re-emit: ${emitted} sync-allowlisted setting(s) → peers will reconcile`);
    }
    return emitted;
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
   * Replicate feeds over a NoiseSecretStream-wrapped transport. Hyperswarm
   * connections are already NoiseSecretStream instances; for plain WebSocket
   * or other Duplex transports, wrap with `new NoiseSecretStream(isInitiator,
   * underlyingDuplex)` first (see tailnet-sync.js).
   *
   * @param {string} remoteInstanceId
   * @param {object} stream - NoiseSecretStream (Hypercore reads .noiseStream from it)
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
    if (!shouldSyncRow(table, row)) return; // local-only row; don't broadcast

    const lamportTs = await this._nextLamport();

    // Strip excluded columns
    const excluded = EXCLUDED_COLUMNS[table] || [];
    let cleanRow = { ...row };
    for (const col of excluded) {
      delete cleanRow[col];
    }
    // Apply per-table outbound transform (e.g. NULL project_id on notes).
    const transform = OUTBOUND_TRANSFORMS[table];
    if (transform) cleanRow = transform(cleanRow);

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
    if (op !== "delete") {
      try {
        if (table === "dashboard_settings" && row.key !== undefined) {
          await this.db.execute({
            sql: `UPDATE dashboard_settings SET lamport_ts = ? WHERE key = ?`,
            args: [lamportTs, row.key],
          });
        } else if (row.id !== undefined) {
          await this.db.execute({
            sql: `UPDATE ${table} SET lamport_ts = ? WHERE id = ?`,
            args: [lamportTs, row.id],
          });
        }
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

    // Defense in depth: drop inbound rows that fail the local syncability check.
    // A peer claiming a non-allowlisted dashboard_settings key (or a row with
    // instance_id != NULL) is either misconfigured or malicious — either way we don't apply.
    if (!shouldSyncRow(table, row)) return;

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

    // Tables keyed by 'key' instead of 'id' need special-case apply logic.
    if (table === "dashboard_settings") {
      try {
        await this._applyDashboardSetting(op, row, lamport_ts);
        if (row?.key && String(row.key).startsWith("storage.shared.")) {
          _scheduleStorageReset();
        }
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on dashboard_settings:`, err.message);
      }
      return;
    }

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

    // Broadcast a messages:changed event when a synced-in message row
    // lands locally. Without this, a paired Crow receiving a peer
    // message via Nostr forwards the row via InstanceSync but our
    // local onMessage / createNotification paths never fire, so
    // badges wouldn't live-update. The 5-min fallback poll would
    // eventually catch up, but this closes the gap for cross-instance
    // traffic. Errors are swallowed — the row is already applied.
    if (op === "insert" && table === "messages" && row?.contact_id != null) {
      try {
        const { rows } = await this.db.execute({
          sql: `SELECT COUNT(*) AS unread FROM messages
                WHERE contact_id = ? AND is_read = 0 AND direction = 'received'`,
          args: [row.contact_id],
        });
        const unread = Number(rows?.[0]?.unread ?? 0);
        bus.emit("messages:changed", { contactId: row.contact_id, unread });
      } catch {}
    }
  }

  /**
   * Apply a dashboard_settings mutation. Only the global row is synced;
   * per-instance overrides live in dashboard_settings_overrides.
   * Last-write-wins by lamport_ts.
   */
  async _applyDashboardSetting(op, row, lamportTs) {
    if (!row || !row.key) return;

    const { rows: existing } = await this.db.execute({
      sql: `SELECT value, lamport_ts FROM dashboard_settings WHERE key = ?`,
      args: [row.key],
    });
    const localTs = existing[0]?.lamport_ts || 0;
    if (lamportTs < localTs) return;
    if (lamportTs === localTs && existing[0]?.value === row.value) return;

    if (op === "delete") {
      await this.db.execute({
        sql: `DELETE FROM dashboard_settings WHERE key = ?`,
        args: [row.key],
      });
      return;
    }

    await this.db.execute({
      sql: `INSERT INTO dashboard_settings (key, value, updated_at, lamport_ts)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value, updated_at = datetime('now'), lamport_ts = excluded.lamport_ts`,
      args: [row.key, row.value ?? "", lamportTs],
    });
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
