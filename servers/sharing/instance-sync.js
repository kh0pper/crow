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
 * otherwise run the equivalence check — equal data → skip silently; differing
 * data → log to sync_conflicts and notify the operator.
 */

import Hypercore from "hypercore";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { sign, verify } from "./identity.js";
import { emitGroupUpsert } from "./group-sync.js";
import { resolveDataDir } from "../db.js";
import { isSyncable, PROFILE_SYNC_KEYS } from "../gateway/dashboard/settings/sync-allowlist.js";
import { normalizePubkey } from "./pubkey-util.js";
import { readTombstone, writeTombstone, clearTombstone } from "./contact-delete.js";
import { sanitizeDisplayName } from "./display-name.js";
import bus from "../shared/event-bus.js";

/**
 * Build the canonical wire row for a crow_context DB row.
 *
 * Allowlist: {section_key, section_title, content, sort_order, enabled,
 *   device_id, project_id}.  Never includes id (instance-local AUTOINCREMENT),
 * lamport_ts, or updated_at.  enabled comes from the DB row as an INTEGER (0/1)
 * — better-sqlite3 throws on boolean binds, so the caller must not coerce it.
 *
 * Used by every crow_context emit site so the allowlist is single-sourced.
 *
 * @param {object} dbRow — a row returned by a SELECT * FROM crow_context query
 * @returns {object} wire object safe to pass to emitChange
 */
export function buildCrowContextWireRow(dbRow) {
  return {
    section_key:   dbRow.section_key,
    section_title: dbRow.section_title,
    content:       dbRow.content,
    sort_order:    dbRow.sort_order,
    enabled:       dbRow.enabled,  // INTEGER 0/1 from DB
    device_id:     dbRow.device_id   ?? null,
    project_id:    dbRow.project_id  ?? null,
  };
}

// Tables that participate in core sync
export const SYNCED_TABLES = [
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
  // Phase 3 (groups follow the user): PLAIN contact groups (room_uid IS NULL)
  // sync so a user's organizational groups + membership follow them across
  // instances. Multi-party ROOMS (room_uid NOT NULL) are gated OUT by
  // shouldSyncRow — they have their own Nostr fan-out.
  "contact_groups",
];

// Columns to exclude from sync payloads (security-sensitive or instance-local)
export const EXCLUDED_COLUMNS = {
  crow_instances: ["auth_token_hash"],
  // apiKey can be sensitive for some deployments; keep in sync by default for
  // local-lab scenarios but flag here as the place to exclude if paranoid.
  // created_at/updated_at are per-instance bookkeeping that ride the wire
  // TODAY via disableProvider's SELECT * spread and manufacture the same
  // spurious conflicts as contacts.created_at below. lamport_ts is sync
  // metadata carried in the entry envelope, not the row (prior art:
  // messages/contact_groups).
  providers: ["created_at", "updated_at", "lamport_ts"],
  // Phase 3 (contacts follow the user): `verified` is a per-device attestation
  // ("I compared the safety number on THIS device") — never assert it on a
  // device that didn't check. `last_seen` is bumped on every inbound DM
  // (boot.js) — syncing it would firehose the feed. `id` is the per-instance
  // AUTOINCREMENT key (never portable). `created_at` differs when two instances
  // independently form the same req: row, manufacturing spurious conflicts.
  // All stripped from the wire; the row still syncs (keyed on crow_id).
  contacts: ["verified", "last_seen", "id", "created_at"],
  // Phase 3 PR-B: messages sync keyed on nostr_event_id; the per-instance
  // id/contact_id are never portable (crow_id rides the wire instead). is_read
  // is per-device (each instance computes its own unread badge). lamport_ts is
  // sync metadata carried in the entry envelope, not the row.
  messages: ["id", "contact_id", "is_read", "lamport_ts"],
  // Phase 3 groups: group_uid is the stable wire key; id is per-instance
  // AUTOINCREMENT (never portable); created_at differs when two instances form
  // the same group independently (spurious conflicts). room_uid/host_crow_id/mode
  // are LEFT on the wire (NULL for a plain group) so the apply-side shouldSyncRow
  // can still reject a malicious room-bearing entry; lamport_ts rides the row and
  // is dropped on apply. Membership rides the attached `members` wire-map.
  contact_groups: ["id", "created_at"],
};

// Per-table outbound mutations applied right after the EXCLUDED_COLUMNS strip.
// Use for cases where the local representation differs from the synced
// representation — e.g. research_notes.project_id is a local FK (project rows
// aren't synced), so we NULL it on the wire. Synced notes show up on peers
// as project-less (null project_id).
const OUTBOUND_TRANSFORMS = {
  research_notes: (row) => ({ ...row, project_id: null }),
  // providers: a null gpu_policy must not ride the wire — _applyUpdate writes
  // wire nulls verbatim and would null a peer's locally-set policy, while the
  // local write path already treats null as "keep" (COALESCE,
  // providers-db.js:198). Drop the key when null; pass through otherwise.
  // NOTE: transforms are applied in emitChange AND to the local row in
  // _checkConflict — must be pure (never mutate the input).
  providers: (row) => {
    if (row.gpu_policy == null) {
      const { gpu_policy, ...rest } = row;
      return rest;
    }
    return { ...row };
  },
};

/**
 * Equivalence check: incoming row's values match the local row on every key
 * present in the incoming row.
 *
 * Per-key rules: both null/undefined → equal; exactly one nullish → NOT equal
 * (never alias null with ""); otherwise String(a) === String(b).
 * lamport_ts and instance_id are ignored — sync metadata, not content.
 *
 * "a" is the LOCAL row (already passed through OUTBOUND_TRANSFORMS at the call
 * site). "b" is the INCOMING (wire) row. Only keys in "b" are checked: wire
 * entries are partial rows (only changed or relevant fields), so keys absent
 * from the incoming row are not part of the equivalence judgement.
 *
 * @param {object} a - Local row (pre-transformed for wire comparison)
 * @param {object} b - Incoming (wire) row
 * @returns {boolean}
 */
export function rowsEquivalent(a, b) {
  if (!a || !b) return false;
  const IGNORE = new Set(["lamport_ts", "instance_id"]);
  for (const k of Object.keys(b)) {
    if (IGNORE.has(k)) continue;
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    const aNullish = av === null || av === undefined;
    const bNullish = bv === null || bv === undefined;
    if (aNullish && bNullish) continue;            // both absent/null → equal
    if (aNullish !== bNullish) return false;        // exactly one nullish → not equal
    if (String(av) !== String(bv)) return false;
  }
  return true;
}

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
  if (table === "contacts") {
    if (!row) return false;
    // local-bot contacts are hosted on THIS instance (instance-local secp key);
    // a phantom on a peer would point at a bot that isn't there.
    if (row.origin === "local-bot") return false;
    // Only established contacts sync. `pending` message-requests are a
    // per-instance inbox each instance forms from the shared inbound stream.
    const rs = row.request_status;
    if (rs !== null && rs !== undefined && rs !== "accepted") return false;
    return true;
  }
  if (table === "messages") {
    // A syncable message MUST carry the stable key (nostr_event_id) and the
    // contact's crow_id (attached on emit). Rows lacking either — synthetic
    // group ids (grp_<ts>, own room sync) or an unresolved contact — never sync.
    if (!row) return false;
    return Boolean(row.nostr_event_id) && Boolean(row.crow_id);
  }
  if (table === "contact_groups") {
    if (!row) return false;
    // Rooms (room_uid NOT NULL) sync via their own Nostr fan-out — never here.
    // `!= null` catches both null and undefined (a delete row omits room_uid).
    if (row.room_uid != null) return false;
    return Boolean(row.group_uid);
  }
  if (table === "providers") {
    // Loopback endpoints are per-instance by construction: a peer dialing
    // 127.0.0.1 reaches ITSELF, never the origin's service. They're also
    // co-owned by every instance's locality predicate (loopback matches
    // everywhere), so the reconciler ownership gate cannot partition them —
    // keeping them off the wire entirely (this function gates BOTH emit and
    // apply) is the only clean single-writer story. Missing/malformed
    // base_url → defensive false: a providers row without a parseable
    // endpoint shouldn't sync either.
    if (!row || !row.base_url) return false;
    let hostname;
    try {
      hostname = new URL(row.base_url).hostname;
    } catch {
      return false;
    }
    const host = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    if (host === "localhost" || host === "::1" || /^127\./.test(host)) return false;
    return true;
  }
  if (table !== "dashboard_settings") return true;
  if (!row || !row.key) return false;
  // dashboard_settings holds only the global scope; per-instance overrides live
  // in dashboard_settings_overrides (never synced). Allowlist gates the key.
  return isSyncable(row.key);
}

// Test-only alias (keeps the function module-private for production callers).
export function shouldSyncRowForTest(table, row) { return shouldSyncRow(table, row); }

/**
 * Whether this process should participate in cross-instance sync feeds.
 * A `--no-auth` gateway is a loopback companion (e.g. grackle's crow-mcp-bridge),
 * NEVER the primary instance — it must NOT open the instance-sync Hypercore feeds,
 * or it grabs the on-disk feed lock and starves the PRIMARY gateway ("File
 * descriptor could not be locked"), silently breaking the primary's replication.
 * Same class as shouldRunHealthMonitor (QW1). Pure + injectable for tests.
 * @param {{argv?: string[], env?: object}} opts
 */
export function shouldInitInstanceSync({ argv = [], env = {} } = {}) {
  if (env.CROW_DISABLE_INSTANCE_SYNC === "1") return false;
  if (Array.isArray(argv) && argv.includes("--no-auth")) return false;
  return true;
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

    // Per-peer serialization for _processNewEntries — see D4 fix below.
    this._processLocks = new Map(); // remoteInstanceId → tail Promise

    // Flag that _ensureCounter has seeded the sync_state row at least once.
    // The DB row is the authority; this is only a cheap short-circuit.
    this._counterSeeded = false;

    // Whether the manager has been started
    this.started = false;

    // A --no-auth companion gateway must not open instance-sync feeds (it would
    // steal the primary's feed lock). Detected from the process flags at
    // construction so ALL feed-open paths (eagerInitPairedPeers, tailnet-sync,
    // boot.js) are gated uniformly. See shouldInitInstanceSync().
    this.feedsDisabled = !shouldInitInstanceSync({ argv: process.argv, env: process.env });
  }

  /**
   * Idempotent seeder: ensure a sync_state row exists for this instance.
   * INSERT OR IGNORE is atomic against concurrent first-callers; safe to race.
   * All three sync_state writers call this before their UPDATE so that a fresh
   * receive-only instance (which never calls _nextLamport) still has a row to
   * UPDATE — without it the counter advances and checkpoints silently no-op.
   */
  async _ensureCounter() {
    if (this._counterSeeded) return;
    try {
      await this.db.execute({
        sql: "INSERT OR IGNORE INTO sync_state (instance_id, local_counter) VALUES (?, 0)",
        args: [this.localInstanceId],
      });
      // Only latch on success — a transient DB error must not permanently
      // disable seeding (the writers would then no-op forever after recovery).
      this._counterSeeded = true;
    } catch (err) {
      console.warn("[instance-sync] Failed to seed sync_state row:", err.message);
    }
  }

  /**
   * Atomically increment and persist the local Lamport counter.
   * Uses a single UPDATE ... RETURNING so no two concurrent callers can race
   * on the same value — better-sqlite3 is synchronous, each statement is atomic
   * with respect to all JS interleavings.
   * @returns {Promise<number>} The new counter value
   */
  async _nextLamport() {
    await this._ensureCounter();
    const { rows } = await this.db.execute({
      sql: `UPDATE sync_state SET local_counter = local_counter + 1, updated_at = datetime('now')
            WHERE instance_id = ? RETURNING local_counter`,
      args: [this.localInstanceId],
    });
    if (rows.length === 0) {
      // Seed race: the INSERT OR IGNORE above ran but the UPDATE found no row
      // (another caller's INSERT lost the race). Seed explicitly and retry once.
      this._counterSeeded = false;
      await this._ensureCounter();
      const retry = await this.db.execute({
        sql: `UPDATE sync_state SET local_counter = local_counter + 1, updated_at = datetime('now')
              WHERE instance_id = ? RETURNING local_counter`,
        args: [this.localInstanceId],
      });
      if (!retry.rows[0]) {
        // Seed + retry both failed — the DB is genuinely unavailable. Throw
        // with a real message instead of a bare TypeError out of emitChange.
        throw new Error("[instance-sync] sync_state row missing after seed+retry — DB unavailable?");
      }
      return Number(retry.rows[0].local_counter);
    }
    return Number(rows[0].local_counter);
  }

  /**
   * Advance the local counter so it is greater than an incoming Lamport value.
   * Single atomic MAX(...) UPDATE — no read-check-write race across an await.
   * @param {number} incomingTs - Lamport timestamp from a remote entry
   */
  async _advanceCounter(incomingTs) {
    await this._ensureCounter();
    await this.db.execute({
      sql: `UPDATE sync_state SET local_counter = MAX(local_counter, CAST(? AS INTEGER) + 1), updated_at = datetime('now')
            WHERE instance_id = ?`,
      args: [Number(incomingTs) || 0, this.localInstanceId],
    });
  }

  /**
   * Initialize feeds for a remote instance.
   * @param {string} remoteInstanceId
   * @param {Buffer|null} theirFeedKey - The remote instance's outgoing feed key (null if unknown yet)
   */
  async initInstance(remoteInstanceId, theirFeedKey) {
    // --no-auth companion: never open feeds (would steal the primary's lock).
    if (this.feedsDisabled) return null;
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
   * iterations while the Lamport counter advances anyway.
   *
   * Safe to re-call; `initInstance` no-ops if the out-feed already exists.
   * In-feeds are also pre-opened if the peer's `sync_url` (their outbound
   * feed key) is already cached — this lets startup `_processNewEntries`
   * catch up entries that mirrored during a previous session.
   */
  async eagerInitPairedPeers() {
    if (this.feedsDisabled) return 0; // --no-auth companion: skip feed init entirely
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
    // v1 → v2 (Cluster B, 2026-07-10): the profile keys were added to the
    // allowlist and every fleet instance's v1 flag is already done: — without a
    // re-run, pre-existing global profile rows (written before the settings-
    // scope refactor) would never replicate until the next manual save. The v1
    // flag row remains as a harmless orphan.
    const FLAG_KEY = "__sync_reemit_allowlist_v2";
    // Same race class as backfillContactsOnce: the boot call runs concurrently
    // with the async sharing boot that arms outFeeds, so 'no-peers' must be
    // retryable, and only a real completed run ('done:<n>') is terminal.
    let alreadyRan = false;
    try {
      const { rows } = await this.db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = ?",
        args: [FLAG_KEY],
      });
      alreadyRan = typeof rows?.[0]?.value === "string" && rows[0].value.startsWith("done:");
    } catch {}
    if (alreadyRan) return 0;

    if (this.outFeeds.size === 0) {
      // No paired peers armed (yet) — retry next boot; do NOT mark the flag.
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
      // R1 MAJOR-2 (Cluster B): never re-emit an EMPTY profile value — a
      // historical empty row (indistinguishable from "never set") would get a
      // fresh lamport and could win LWW, blanking a peer's real value. A LIVE
      // save of "" still emits via writeSetting (a deliberate clear propagates);
      // this guard is scoped to the re-emit reconciliation only.
      if (PROFILE_SYNC_KEYS.includes(row.key) && (typeof row.value !== "string" || row.value.trim() === "")) continue;
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
      // UPSERT: a stale 'no-peers' row from the pre-fix code must be
      // overwritten or this done-mark silently no-ops (per-boot re-emit).
      await this.db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [FLAG_KEY, `done:${emitted}`],
      });
    } catch {}

    if (emitted > 0) {
      console.log(`[instance-sync] one-shot re-emit: ${emitted} sync-allowlisted setting(s) → peers will reconcile`);
    }
    return emitted;
  }

  /**
   * One-shot idempotent backfill (Phase 3 PR-B / I-4): re-emit every existing
   * SYNCABLE full contact so a peer can resolve crow_id → local contact_id for
   * contacts that predate PR-A (they never emitted a contact-sync entry, so
   * _applyMessage would otherwise SKIP every synced message for them forever).
   *
   * Guarded by a dashboard_settings flag so it runs at most once per instance
   * lifetime — no repeated lamport thrash. On the peer, _applyContact converges
   * an unchanged re-emit as an effective no-op (fresh lamport → UPDATE with
   * identical values; onContactSynced re-subscribe is idempotent). Mirrors
   * reemitSyncableSettingsOnce(). Never throws out of the loop.
   */
  async backfillContactsOnce() {
    const FLAG_KEY = "__contacts_backfill_v1";
    // Only a real completed run ("done:<n>") is terminal. The boot call races
    // the async sharing boot that opens the sync feeds — on a slow host the
    // peers exist but outFeeds is still empty when we run (observed live on
    // grackle 2026-07-06: flag stuck at 'no-peers' with 4 paired peers).
    // Treating no-peers as retryable makes the next boot backfill correctly;
    // a genuinely peer-less instance just re-runs two cheap queries per boot.
    let alreadyRan = false;
    try {
      const { rows } = await this.db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = ?",
        args: [FLAG_KEY],
      });
      alreadyRan = typeof rows?.[0]?.value === "string" && rows[0].value.startsWith("done:");
    } catch {}
    if (alreadyRan) return 0;

    if (this.outFeeds.size === 0) {
      // No paired peers armed (yet) — nothing to backfill NOW. Deliberately
      // do NOT mark the flag: feeds may simply not have opened yet this boot.
      return 0;
    }

    // I-B1 ordering guard: drain the locally-replicated inbound backlog FIRST,
    // so a peer's already-delivered newer edit (e.g. a block) is applied before
    // we re-emit with a fresh lamport and fabricate recency over it.
    // _processNewEntries' per-peer promise-chain serializes this safely with
    // any concurrent append-listener run; checkpointing makes it idempotent.
    try {
      for (const [peerId, inFeed] of this.inFeeds) {
        await this._processNewEntries(peerId, inFeed);
      }
    } catch (err) {
      console.warn(`[instance-sync] contacts backfill drain failed: ${err.message}`);
    }

    let rows = [];
    try {
      const r = await this.db.execute({
        sql: `SELECT * FROM contacts
               WHERE (request_status IS NULL OR request_status = 'accepted')
                 AND (is_bot IS NULL OR is_bot = 0)
                 AND (origin IS NULL OR origin != 'local-bot')
                 AND (is_blocked IS NULL OR is_blocked = 0)`,
      });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] contacts backfill read failed: ${err.message}`);
      return 0;
    }

    let emitted = 0;
    for (const row of rows) {
      try {
        // shouldSyncRow("contacts", …) is the final gate inside emitChange;
        // EXCLUDED_COLUMNS.contacts strips verified/last_seen/id/created_at.
        await this.emitChange("contacts", "update", row);
        emitted++;
      } catch (err) {
        console.warn(`[instance-sync] contacts backfill emit failed for ${row.crow_id}: ${err.message}`);
      }
    }

    try {
      // UPSERT, not DO NOTHING: a stale 'no-peers' row (written by the pre-fix
      // code when boot raced feed-init) must be overwritten, or the done-mark
      // silently no-ops and the backfill re-emits every boot (lamport thrash).
      await this.db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [FLAG_KEY, `done:${emitted}`],
      });
    } catch {}

    if (emitted > 0) {
      console.log(`[instance-sync] one-shot contacts backfill: ${emitted} contact(s) re-emitted → peers resolve legacy contacts`);
    }
    return emitted;
  }

  /**
   * D7 — one-shot providers backfill PER PEER GENERATION (the new-pairing
   * counterpart to D2's no-op suppression). Outgoing sync feeds are per-peer
   * Hypercores created EMPTY at first pairing (_initInstanceInner — no history
   * replay); before D2, the boot reconciler's unconditional per-boot re-emit
   * was accidentally how a newly-paired peer ever received this instance's
   * provider rows. D2 kills that boot churn, so this backfill is the
   * deliberate delivery channel.
   *
   * Unlike the GLOBAL contacts flag, the flag here is PER PEER
   * (`__providers_backfill_v1:<peerId>` in dashboard_settings) so every FUTURE
   * pairing also gets a backfill — not just the deploy transition. Only a
   * "done:*" value is terminal; a stale non-done value is overwritten by the
   * UPSERT done-mark. Zero armed peers → return WITHOUT writing any flag
   * (feeds may not have opened yet this boot — retry next boot; contacts
   * lesson, observed live on grackle 2026-07-06). Inbound backlog is drained
   * first (I-B1) so a peer's already-delivered newer provider edit is applied
   * before we re-emit with a fresh lamport.
   *
   * emitChange broadcasts to ALL peers: already-current peers converge the
   * re-emit as re-delivery noise (rowsEquivalent → silent skip in
   * _checkConflict, or a plain newer-lamport UPDATE with identical values) —
   * accepted cost, same as the contacts backfill. shouldSyncRow('providers')
   * inside emitChange drops loopback rows automatically, and
   * EXCLUDED_COLUMNS/OUTBOUND_TRANSFORMS strip bookkeeping + null gpu_policy —
   * no pre-filtering here. Disabled rows ARE included: disabled=1 is a synced
   * fact the peer must learn (see disableProvider's emit).
   *
   * Documented limitation (parity with the contacts backfill): a pairing
   * formed mid-run without a subsequent reboot waits for the next boot —
   * acceptable, pairing flows involve restarts in practice.
   * Never throws out of the loop. Returns the count of rows actually emitted.
   */
  async backfillProvidersForNewPeers() {
    const FLAG_PREFIX = "__providers_backfill_v1:";
    if (this.outFeeds.size === 0) {
      // No peer feeds armed (yet) — deliberately write NO flags: feeds may
      // simply not have opened yet this boot. A later boot retries; a
      // genuinely peer-less instance just re-runs a cheap check per boot.
      return 0;
    }

    // Which armed peers still need a backfill? Only "done:*" is terminal.
    const newPeers = [];
    for (const peerId of this.outFeeds.keys()) {
      let done = false;
      try {
        const { rows } = await this.db.execute({
          sql: "SELECT value FROM dashboard_settings WHERE key = ?",
          args: [FLAG_PREFIX + peerId],
        });
        done = typeof rows?.[0]?.value === "string" && rows[0].value.startsWith("done:");
      } catch {}
      if (!done) newPeers.push(peerId);
    }
    if (newPeers.length === 0) return 0; // every armed peer already covered

    // I-B1 ordering guard: drain the locally-replicated inbound backlog FIRST,
    // so a peer's already-delivered newer provider edit is applied before we
    // re-emit with a fresh lamport and fabricate recency over it.
    try {
      for (const [peerId, inFeed] of this.inFeeds) {
        await this._processNewEntries(peerId, inFeed);
      }
    } catch (err) {
      console.warn(`[instance-sync] providers backfill drain failed: ${err.message}`);
    }

    let rows = [];
    try {
      // ALL rows, including disabled ones — disabled=1 is a synced fact.
      // No pre-filtering: shouldSyncRow inside emitChange drops loopback rows,
      // EXCLUDED_COLUMNS/OUTBOUND_TRANSFORMS handle wire hygiene.
      const r = await this.db.execute({ sql: "SELECT * FROM providers" });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] providers backfill read failed: ${err.message}`);
      return 0;
    }

    let emitted = 0;
    for (const row of rows) {
      try {
        // emitChange returns null when the row was gated off the wire
        // (loopback / feedsDisabled) — only count rows that actually rode.
        const ts = await this.emitChange("providers", "update", row);
        if (ts != null) emitted++;
      } catch (err) {
        console.warn(`[instance-sync] providers backfill emit failed for ${row.id}: ${err.message}`);
      }
    }

    for (const peerId of newPeers) {
      try {
        // UPSERT: a stale non-done value must be overwritten or the done-mark
        // silently no-ops (per-boot re-emit thrash). Already-done peers are
        // never rewritten — only the previously-unflagged ones.
        await this.db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          args: [FLAG_PREFIX + peerId, `done:${emitted}`],
        });
      } catch {}
    }

    if (emitted > 0) {
      console.log(`[instance-sync] providers backfill: ${emitted} provider row(s) re-emitted for ${newPeers.length} new peer(s)`);
    }
    return emitted;
  }

  /**
   * C1: assign a DETERMINISTIC, FROZEN group_uid to every pre-existing PLAIN group
   * the migration left NULL, so the SAME logical group on two instances (same shared
   * identity) converges on ONE uid instead of duplicating. uid = first-32-hex of
   * sha256(<shared ed25519 pubkey> ":" lower(trim(name))). Local same-name collisions
   * are resolved COLLISION-DRIVEN (R2 F1): a UNIQUE rejection retries with a
   * "\x1f"-suffixed key (base\x1f1, base\x1f2, …, bound 16 then warn+skip). The \x1f
   * unit separator cannot survive lower(trim(name)) of any real group name, so a
   * suffixed key can never collide with a literal name's base key; and probing the DB
   * instead of pre-counting makes the assignment crash-idempotent (a partial run
   * strands nothing — the retry walks past whatever already landed).
   * Idempotent: only touches NULL-uid rows; a frozen uid is never re-derived on rename.
   * Never throws. Returns the count assigned.
   */
  deterministicGroupUid(name, n = 0) {
    const base = String(name ?? "").trim().toLowerCase();
    // n=0 → base hash; n>0 → collision-retry slot. "\x1f" is a control char no real
    // group name contains — unlike "#2", a slot key can never equal a literal name.
    const keyed = n > 0 ? `${base}\x1f${n}` : base;
    return createHash("sha256")
      .update(`${this.identity.ed25519Pubkey}:${keyed}`)
      .digest("hex")
      .slice(0, 32);
  }

  async _assignDeterministicGroupUids() {
    const MAX_COLLISION_RETRIES = 16;
    let assigned = 0;
    let rows = [];
    try {
      const r = await this.db.execute({ sql: "SELECT id, name FROM contact_groups WHERE room_uid IS NULL AND group_uid IS NULL ORDER BY id ASC" });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] deterministic group_uid read failed: ${err.message}`);
      return 0;
    }
    for (const row of rows) {
      // COLLISION-DRIVEN (R2 F1): try the base hash; every UNIQUE rejection bumps n
      // and retries the \x1f-suffixed slot. No in-memory counter → crash-idempotent:
      // the retry walks past hashes that already landed (this run, a previous
      // interrupted run, or a peer's identical deterministic uid).
      let settled = false;
      for (let n = 0; n <= MAX_COLLISION_RETRIES && !settled; n++) {
        const uid = this.deterministicGroupUid(row.name, n);
        try {
          // group_uid IS NULL guard makes the UPDATE a no-op if a concurrent path already set it.
          await this.db.execute({ sql: "UPDATE contact_groups SET group_uid = ? WHERE id = ? AND group_uid IS NULL", args: [uid, row.id] });
          assigned++;
          settled = true;
        } catch (err) {
          if (!/unique|constraint/i.test(err.message || "")) {
            // Non-UNIQUE failure — skip this row, never throw (re-attempted next boot,
            // since assignment runs before the flag gate — R2 F2).
            console.warn(`[instance-sync] deterministic group_uid assign failed for group ${row.id}: ${err.message}`);
            settled = true;
          }
          // UNIQUE collision → loop retries with n+1.
        }
      }
      if (!settled) {
        console.warn(`[instance-sync] deterministic group_uid: ${MAX_COLLISION_RETRIES} collisions for group ${row.id} — left NULL (re-attempted next boot)`);
      }
    }
    if (assigned > 0) console.log(`[instance-sync] assigned ${assigned} deterministic group_uid(s) to pre-existing groups`);
    return assigned;
  }

  /**
   * One-shot idempotent backfill (Phase 3 groups-follow-user): re-emit every
   * existing PLAIN contact group (room_uid IS NULL) so a peer can resolve it for
   * groups that predate this feature. Rooms are excluded (own Nostr sync). The
   * RE-EMIT is guarded by a flag so it runs once per instance lifetime; C1
   * deterministic uid assignment runs BEFORE that gate — every boot (R2 F2) — so
   * pre-existing groups converge (not duplicate) and a NULL-uid row introduced
   * later (restore/import/interrupted run) self-heals on the next boot. Then it
   * drains the inbound backlog (I-B1) so a peer's already-delivered newer group
   * edit wins before we re-emit with a fresh lamport. Mirrors
   * backfillContactsOnce(). Never throws.
   */
  async backfillGroupsOnce() {
    // C1: assign deterministic frozen uids to legacy NULL-uid plain groups BEFORE the
    // flag gate (R2 F2 — every boot; usually 0 rows) and BEFORE the peer gate — so even
    // a peerless instance gets stable, convergent uids and stranded NULLs self-heal.
    await this._assignDeterministicGroupUids();

    const FLAG_KEY = "__groups_backfill_v1";
    let alreadyRan = false;
    try {
      const { rows } = await this.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [FLAG_KEY] });
      alreadyRan = typeof rows?.[0]?.value === "string" && rows[0].value.startsWith("done:");
    } catch {}
    if (alreadyRan) return 0;

    if (this.outFeeds.size === 0) return 0; // no peers armed yet — retry next boot; do NOT mark

    // I-B1 ordering guard: apply the peer's already-replicated backlog first.
    try {
      for (const [peerId, inFeed] of this.inFeeds) {
        await this._processNewEntries(peerId, inFeed);
      }
    } catch (err) {
      console.warn(`[instance-sync] groups backfill drain failed: ${err.message}`);
    }

    let rows = [];
    try {
      const r = await this.db.execute({ sql: "SELECT id FROM contact_groups WHERE room_uid IS NULL" });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] groups backfill read failed: ${err.message}`);
      return 0;
    }

    let emitted = 0;
    for (const row of rows) {
      try {
        await emitGroupUpsert(this.db, row.id); // shouldSyncRow + room skip are the final gate
        emitted++;
      } catch (err) {
        console.warn(`[instance-sync] groups backfill emit failed for group ${row.id}: ${err.message}`);
      }
    }

    try {
      await this.db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [FLAG_KEY, `done:${emitted}`],
      });
    } catch {}

    if (emitted > 0) console.log(`[instance-sync] one-shot groups backfill: ${emitted} group(s) re-emitted → peers resolve legacy groups`);
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
    // --no-auth companion doesn't drive fleet sync (and has no outFeeds).
    if (this.feedsDisabled) return null;
    if (!SYNCED_TABLES.includes(table)) return null;
    if (!shouldSyncRow(table, row)) return null; // local-only row; don't broadcast

    // Envelope counter floor: after a sync_state reset (e.g. DB recovery) the
    // local counter can sit BELOW lamports already stamped on rows; an emit
    // would then look stale to peers (they order on the envelope) and the
    // divergence is silent and permanent. Floor the counter at the outgoing
    // row's own lamport first — _advanceCounter is an atomic
    // MAX(counter, ts+1), so the _nextLamport below strictly exceeds it.
    const rowTs = Number(row?.lamport_ts);
    if (Number.isFinite(rowTs) && rowTs > 0) {
      await this._advanceCounter(rowTs);
    }
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
        } else if (table === "crow_context" && row.section_key !== undefined) {
          // Composite-key stamp; MAX(COALESCE(...)) guards against out-of-order
          // concurrent emitChange calls — plain MAX(NULL,x) is NULL in SQLite so
          // the COALESCE is load-bearing.
          await this.db.execute({
            sql: `UPDATE crow_context SET lamport_ts = MAX(COALESCE(lamport_ts, 0), ?)
                  WHERE section_key = ? AND device_id IS ? AND project_id IS ?`,
            args: [lamportTs, row.section_key, row.device_id ?? null, row.project_id ?? null],
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
   * Public wrapper: serialize per-peer to prevent overlapping runs (D4).
   * Same promise-chain pattern as _initLocks — a failed run's .catch(() => {})
   * ensures the next queued run is not blocked by a prior error.
   * lastSeq is re-read INSIDE the inner run after acquiring the chain, so a
   * queued run naturally no-ops the range the prior run already covered.
   */
  async _processNewEntries(remoteInstanceId, feed) {
    const prior = this._processLocks.get(remoteInstanceId) || Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(() => this._processNewEntriesInner(remoteInstanceId, feed));
    this._processLocks.set(remoteInstanceId, next);
    try {
      return await next;
    } finally {
      if (this._processLocks.get(remoteInstanceId) === next) {
        this._processLocks.delete(remoteInstanceId);
      }
    }
  }

  /**
   * Inner body: process new entries from a remote instance's incoming feed.
   * lastSeq is read here (after acquiring the per-peer chain) so each
   * queued run starts from where the prior run actually left off.
   *
   * Checkpoints AFTER every ATTEMPTED entry (seq + 1, outside the try-catch).
   * This intentionally advances the checkpoint past failed entries — halting
   * on a poison entry would freeze the entire peer feed, a worse outcome than
   * skipping one bad entry. The trailing whole-batch checkpoint is removed.
   */
  async _processNewEntriesInner(remoteInstanceId, feed) {
    // Re-read lastSeq inside the lock — the prior chained run may have advanced it.
    const lastSeq = await this._getLastAppliedSeq(remoteInstanceId);

    for (let seq = lastSeq; seq < feed.length; seq++) {
      try {
        const entry = await feed.get(seq);
        await this._applyEntry(remoteInstanceId, entry);
      } catch (err) {
        // Skip-and-continue: a poison entry must not freeze this peer's feed.
        console.warn(`[instance-sync] Failed to process entry ${seq} from ${remoteInstanceId}:`, err.message);
      }
      // Checkpoint after every attempted entry — outside the try so it advances
      // even when _applyEntry threw (intentional skip-log-advance semantics).
      await this._setLastAppliedSeq(remoteInstanceId, seq + 1);
    }
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

    // crow_context is keyed by composite (section_key, device_id, project_id) — route
    // ALL ops (insert/update/delete) through the composite-key handler so that:
    //   • insert collisions get LWW upsert instead of the null-id warn dead-end
    //   • updates and deletes are applied/conflicted by composite key rather than id
    // The invalidateContextCache() call that previously lived below the switch now
    // fires inside _applyCrowContext on every apply, which is the ONLY path reached
    // (the return below prevents fall-through).  The old position was only reachable
    // because id-less entries fell through _applyUpdate's early-return; that path
    // becomes unreachable here for crow_context.
    if (table === "crow_context") {
      try {
        await this._applyCrowContext(op, row, lamport_ts, instance_id);
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on crow_context:`, err.message);
      }
      return;
    }

    // contacts is keyed by the stable crow_id (per-instance AUTOINCREMENT id is
    // NOT portable). Route ALL ops through the natural-key handler, mirroring
    // _applyCrowContext. shouldSyncRow already gated inbound at :639 (before the
    // signature verify + dispatch), so a peer-injected pending/local-bot row
    // never reaches here.
    if (table === "contacts") {
      try {
        await this._applyContact(op, row, lamport_ts, instance_id);
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on contacts:`, err.message);
      }
      return;
    }

    // messages are keyed by the stable nostr_event_id (UNIQUE); the per-instance
    // AUTOINCREMENT id + local contact_id are NOT portable. Route ALL ops through
    // the natural-key handler, mirroring _applyCrowContext / _applyContact.
    // shouldSyncRow already gated at :678 (nostr_event_id + crow_id required).
    if (table === "messages") {
      try {
        await this._applyMessage(op, row, lamport_ts, instance_id);
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on messages:`, err.message);
      }
      return;
    }

    // contact_groups (plain groups only — rooms gated by shouldSyncRow) are keyed
    // on the stable group_uid; the per-instance AUTOINCREMENT id + join-table FKs
    // are NOT portable. Route ALL ops through the natural-key handler, mirroring
    // _applyContact. shouldSyncRow already dropped room_uid/keyless rows at :787.
    if (table === "contact_groups") {
      try {
        await this._applyGroup(op, row, lamport_ts, instance_id);
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on contact_groups:`, err.message);
      }
      return;
    }

    // Conflict detection gates both updates and deletes — a stale remote delete
    // with a lower lamport_ts must not silently destroy a newer local edit (D6).
    if ((op === "update" || op === "delete") && row.id !== undefined) {
      const conflict = await this._checkConflict(table, row.id, lamport_ts, instance_id, row, op);
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
    // Tie + different value falls through: incoming wins silently (no conflict
    // row — operator-only settings rarely diverge; asymmetric with _checkConflict
    // by design, pre-existing behavior).

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
   * Apply a crow_context mutation (insert / update / delete).
   *
   * crow_context is keyed by composite (section_key, device_id, project_id) with
   * four NULL-aware partial unique indexes.  Standard _applyUpdate/_applyDelete early-
   * return when row.id is undefined, so we route all ops here instead.
   *
   * Conflict rules follow _checkConflict (W4-1 standard):
   *   incomingTs > localTs  → apply
   *   incomingTs <= localTs, data equal → silent skip
   *   incomingTs <= localTs, data differ (including tie) → conflict, local kept
   *
   * Upsert-on-missing applies to 'update' too (resurrection-over-loss, spec §3 C4):
   * a re-delivered pre-delete update recreates the section rather than silently
   * losing the edit.
   *
   * @param {"insert"|"update"|"delete"} op
   * @param {object} row — wire row (no id, no lamport_ts)
   * @param {number} lamportTs — incoming Lamport timestamp
   * @param {string} instanceId — origin instance id
   */
  async _applyCrowContext(op, row, lamportTs, instanceId) {
    if (!row || row.section_key == null) {
      console.warn("[instance-sync] _applyCrowContext: missing section_key — skipping");
      return;
    }

    const sk = row.section_key;
    const devId = row.device_id ?? null;
    const projId = row.project_id ?? null;

    // Key-filter the incoming row: intersect with live PRAGMA columns; drop
    // id, lamport_ts, instance_id, and updated_at so an unexpected wire key
    // doesn't throw.  Cached per-process on the first crow_context apply.
    if (!this._crowContextCols) {
      try {
        const { rows: pragma } = await this.db.execute({
          sql: "PRAGMA table_info(crow_context)",
          args: [],
        });
        this._crowContextCols = new Set(pragma.map((r) => r.name));
      } catch {
        this._crowContextCols = null;
      }
    }
    const ALWAYS_DROP = new Set(["id", "lamport_ts", "instance_id", "updated_at"]);
    let filteredRow = {};
    for (const [k, v] of Object.entries(row)) {
      if (ALWAYS_DROP.has(k)) continue;
      if (this._crowContextCols && !this._crowContextCols.has(k)) continue;
      filteredRow[k] = v;
    }

    // Read local row
    const { rows: localRows } = await this.db.execute({
      sql: "SELECT * FROM crow_context WHERE section_key = ? AND device_id IS ? AND project_id IS ?",
      args: [sk, devId, projId],
    });
    const localRow = localRows[0] ?? null;
    const localTs = localRow?.lamport_ts || 0;

    // ── delete ────────────────────────────────────────────────────────────────
    if (op === "delete") {
      if (!localRow) return; // Nothing to delete
      if (lamportTs > localTs) {
        await this.db.execute({
          sql: "DELETE FROM crow_context WHERE section_key = ? AND device_id IS ? AND project_id IS ?",
          args: [sk, devId, projId],
        });
        try {
          const { invalidateContextCache } = await import("../memory/crow-context.js");
          invalidateContextCache();
        } catch {}
        return;
      }
      // stale delete → conflict, local kept
      const rowIdJson = JSON.stringify({ section_key: sk, device_id: devId, project_id: projId });
      try {
        await this._insertConflictRow(
          "crow_context", rowIdJson,
          localRow.instance_id || this.localInstanceId, instanceId,
          localTs, lamportTs,
          JSON.stringify(localRow), JSON.stringify(filteredRow),
          "delete",
        );
        await this._notifyConflict();
      } catch (err) {
        console.warn(`[instance-sync] crow_context conflict LOGGING failed (local data preserved):`, err.message);
      }
      return;
    }

    // ── insert / update ───────────────────────────────────────────────────────
    if (!localRow) {
      // No local row: upsert (covers both insert and update ops — resurrection
      // of a deleted section is preferable to silently losing a catch-up edit).
      const required = ["section_title", "content"];
      const missing = required.filter((k) => filteredRow[k] == null);
      if (missing.length > 0) {
        console.warn(`[instance-sync] _applyCrowContext: upsert skipped — NOT NULL column(s) absent (${missing.join(", ")}); old-sender partial entry`);
        return;
      }
      // Include composite key columns that may not be in filteredRow already
      const insertFields = { ...filteredRow, section_key: sk, device_id: devId, project_id: projId, lamport_ts: lamportTs, updated_at: "datetime('now')" };
      // Build the INSERT without updated_at as a bind param (it's an SQL expression)
      const colsForInsert = Object.keys(insertFields).filter((k) => k !== "updated_at");
      const placeholders = colsForInsert.map(() => "?").join(", ");
      const values = colsForInsert.map((k) => insertFields[k]);
      await this.db.execute({
        sql: `INSERT INTO crow_context (${colsForInsert.join(", ")}, updated_at)
              VALUES (${placeholders}, datetime('now'))`,
        args: values,
      });
      try {
        const { invalidateContextCache } = await import("../memory/crow-context.js");
        invalidateContextCache();
      } catch {}
      return;
    }

    // Local row exists
    if (lamportTs > localTs) {
      // Newer incoming: UPDATE present filtered keys + lamport_ts + updated_at
      const updateKeys = Object.keys(filteredRow).filter((k) => !["section_key", "device_id", "project_id"].includes(k));
      if (updateKeys.length > 0) {
        const setClauses = [...updateKeys.map((k) => `${k} = ?`), "lamport_ts = ?", "updated_at = datetime('now')"].join(", ");
        const vals = [...updateKeys.map((k) => filteredRow[k] ?? null), lamportTs];
        await this.db.execute({
          sql: `UPDATE crow_context SET ${setClauses} WHERE section_key = ? AND device_id IS ? AND project_id IS ?`,
          args: [...vals, sk, devId, projId],
        });
      } else {
        // Nothing to update besides timestamps
        await this.db.execute({
          sql: `UPDATE crow_context SET lamport_ts = ?, updated_at = datetime('now') WHERE section_key = ? AND device_id IS ? AND project_id IS ?`,
          args: [lamportTs, sk, devId, projId],
        });
      }
      try {
        const { invalidateContextCache } = await import("../memory/crow-context.js");
        invalidateContextCache();
      } catch {}
      return;
    }

    // incomingTs <= localTs: check equivalence
    if (rowsEquivalent(localRow, filteredRow)) {
      return; // Re-delivery noise — silent skip
    }

    // Real conflict (includes tie + different data): local kept
    const rowIdJson = JSON.stringify({ section_key: sk, device_id: devId, project_id: projId });
    try {
      await this._insertConflictRow(
        "crow_context", rowIdJson,
        localRow.instance_id || this.localInstanceId, instanceId,
        localTs, lamportTs,
        JSON.stringify(localRow), JSON.stringify(filteredRow),
        op || "update",
      );
      await this._notifyConflict();
    } catch (err) {
      console.warn(`[instance-sync] crow_context conflict LOGGING failed (local data preserved):`, err.message);
    }
  }

  /**
   * Apply a contacts mutation keyed on the stable crow_id (Phase 3 / D1).
   * Per-instance AUTOINCREMENT id is never used. LWW by lamport_ts, matching
   * _applyCrowContext / _checkConflict (W4-1) semantics. After any insert/update
   * that leaves a live row, fires this.onContactSynced(localRow) so the receiver
   * subscribes to the contact (boot-injected; undefined in tests/pre-boot).
   *
   * @param {"insert"|"update"|"delete"} op
   * @param {object} row - wire row (no local id; keyed by crow_id)
   * @param {number} lamportTs
   * @param {string} instanceId - origin instance id
   */
  async _applyContact(op, row, lamportTs, instanceId) {
    const crowId = row && row.crow_id;
    if (!crowId) {
      console.warn("[instance-sync] _applyContact: missing crow_id — skipping");
      return;
    }

    // PRAGMA-filter incoming keys to live columns; always drop id/lamport_ts/
    // instance_id and the never-synced verified/last_seen/created_at (defense on
    // apply — these are stripped on emit too).
    if (!this._contactCols) {
      try {
        const { rows: pragma } = await this.db.execute({ sql: "PRAGMA table_info(contacts)", args: [] });
        this._contactCols = new Set(pragma.map((r) => r.name));
      } catch { this._contactCols = null; }
    }
    // Defense-in-depth: dynamic column names below are built from `filtered`'s
    // keys, so they MUST be whitelisted against the live schema. If the PRAGMA
    // failed we cannot whitelist — skip rather than build SQL from raw wire keys.
    if (!this._contactCols) {
      console.warn("[instance-sync] _applyContact: contacts columns unavailable — skipping");
      return;
    }
    const ALWAYS_DROP = new Set(["id", "lamport_ts", "instance_id", "verified", "last_seen", "created_at"]);
    const filtered = {};
    for (const [k, v] of Object.entries(row)) {
      if (ALWAYS_DROP.has(k)) continue;
      if (!this._contactCols.has(k)) continue;
      filtered[k] = v;
    }

    // F-CONTACT-2 (design §D5): display_name is remote-controlled and renders in
    // the dashboard. The sync signature proves same-KEY, not honest content — an
    // older/buggy peer on the shared identity can carry an uncapped, control-laden
    // name straight in. Sanitize HERE, the moment `filtered` is built, so the
    // same-secp rebind, the rowsEquivalent() check, and both write branches all
    // read the cleaned value. Sanitizing later would make every redelivery of a
    // name-needing-sanitization mismatch the stored (sanitized) row and spam the
    // conflict log. Only rewrite when the key is present (an entry may omit it);
    // a null result is legal (a NULL display_name is a placeholder).
    if (Object.prototype.hasOwnProperty.call(filtered, "display_name")) {
      filtered.display_name = sanitizeDisplayName(filtered.display_name);
    }

    const { rows: localRows } = await this.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] });
    const localRow = localRows[0] ?? null;
    const localTs = localRow?.lamport_ts || 0;
    const rowIdJson = JSON.stringify({ crow_id: crowId });

    // ── tombstone gate (F-CONTACT-1, design §D3.1) ───────────────────────────
    // Runs BEFORE the existing branches. Makes deletion durable: a delete that
    // resurrects is worse than no delete. The rule is a pure function of
    // (op, tomb.lamport_ts, localRow?), so every instance evaluates it identically.
    let tomb = await readTombstone(this.db, crowId);

    // (a) A local row proves some local path re-created the contact, so the
    //     tombstone is stale — the local re-create wins. Clear it and fall
    //     through to normal LWW. (Robust against the many local write paths that
    //     create contacts without each remembering to clearTombstone.)
    if (tomb && localRow) {
      await clearTombstone(this.db, crowId);
      tomb = null;
    }

    // ── delete ──────────────────────────────────────────────────────────────
    if (op === "delete") {
      // A tombstone is written only when the delete is AUTHORITATIVE. The ROW
      // delete keeps today's LWW guard (lamportTs > localTs) — a stale delete
      // must NOT wipe a live contact, whose FK ON DELETE CASCADE would also
      // destroy its entire DM history (design §2.1). The loss branch writes no
      // tombstone: the row won, so no tombstone is warranted.
      if (!localRow) {
        // delete-before-insert race: record the tombstone, apply nothing.
        await writeTombstone(this.db, crowId, Math.max(tomb?.lamport_ts ?? 0, lamportTs));
        return;
      }
      if (lamportTs > localTs) {
        // Winning delete: unwire locally (boot-injected hook, guarded — mirrors
        // onContactSynced), remove the row, then record the tombstone. The hook
        // runs with the doomed row BEFORE the DELETE.
        if (typeof this.onContactDeleted === "function") {
          try { await this.onContactDeleted(localRow); } catch { /* never throw into apply */ }
        }
        await this.db.execute({ sql: "DELETE FROM contacts WHERE crow_id = ?", args: [crowId] });
        await writeTombstone(this.db, crowId, Math.max(tomb?.lamport_ts ?? 0, lamportTs));
        return;
      }
      try {
        await this._insertConflictRow("contacts", rowIdJson,
          localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
          JSON.stringify(localRow), JSON.stringify(filtered), "delete");
        await this._notifyConflict();
      } catch (err) {
        console.warn("[instance-sync] contacts delete conflict LOGGING failed (local kept):", err.message);
      }
      return;
    }

    // (c) A tombstone is still standing and there is NO local row (rule (a)
    //     already cleared any tombstone that coexisted with a row). Delete wins
    //     over a concurrent update; a stale insert replay is dropped; only a
    //     fresher insert re-adds — and it must APPLY before it clears (ordering
    //     is load-bearing: _processNewEntries locks per remote instance, so a
    //     concurrent stale update from another feed must see either the tombstone
    //     or the row, never neither — design §D3.1(c)).
    let clearTombAfterApply = false;
    if (tomb) {
      if (op === "update") return;                    // drop — delete wins over a concurrent update
      if (lamportTs <= tomb.lamport_ts) return;        // stale insert replay
      clearTombAfterApply = true;                      // insert above the tombstone: apply, THEN clear
    }

    // ── insert / update ────────────────────────────────────────────────────
    if (!localRow) {
      // NOT NULL parity (ed25519_pubkey, secp256k1_pubkey are NOT NULL). A
      // partial old-sender row would throw; skip with a warning instead
      // (mirrors _applyCrowContext's required-column guard). Empty string '' is
      // fine — manual/keyless contacts carry ''; only a truly-absent column skips.
      if (filtered.secp256k1_pubkey == null || filtered.ed25519_pubkey == null) {
        console.warn("[instance-sync] _applyContact: insert skipped — NOT NULL pubkey column absent");
        return;
      }

      // Same-secp REBIND (spec §A2 "upsertFullContact-style merge"). The
      // handshake rebinds a placeholder `req:<secp>` contact to a real
      // `crow:<id>` (contact-promote.js). An instance offline across the
      // handshake catches up as update(req:x) then update(crow:y) — same secp,
      // different crow_id. Keying only on crow_id would insert BOTH → a split
      // contact. So on a crow_id miss, if a local row already holds this secp
      // under a DIFFERENT crow_id, REBIND it instead of inserting a duplicate.
      // Safe: the entry is ed25519-signed by the shared identity, a secp match =
      // same key-holder = same peer, and the incoming crow_id is unowned here.
      const secpNorm = filtered.secp256k1_pubkey ? normalizePubkey(String(filtered.secp256k1_pubkey)) : "";
      const secpRow = secpNorm ? (await this.db.execute({
        sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ? ORDER BY id ASC LIMIT 1",
        args: [secpNorm],
      })).rows[0] || null : null;
      if (secpRow) {
        // Never relabel a real `crow:` id DOWN to a `req:` placeholder (a 3+-
        // instance cross-feed reorder could otherwise un-promote). One-directional.
        if (String(crowId).startsWith("req:") && !String(secpRow.crow_id).startsWith("req:")) return;
        // LWW: only rebind if the incoming entry is at least as new as the local
        // same-secp row (a stale re-delivery must not relabel a fresher row).
        if (lamportTs >= (secpRow.lamport_ts || 0)) {
          const rebindKeys = Object.keys(filtered).filter((k) => k !== "crow_id");
          const setClauses = ["crow_id = ?", ...rebindKeys.map((k) => `${k} = ?`), "verified = 0", "lamport_ts = ?"];
          const vals = [crowId, ...rebindKeys.map((k) => filtered[k] ?? null), lamportTs];
          await this.db.execute({ sql: `UPDATE contacts SET ${setClauses.join(", ")} WHERE id = ?`, args: [...vals, secpRow.id] });
          await this._afterContactApplied(crowId);
          if (clearTombAfterApply) await clearTombstone(this.db, crowId); // §D3.1(c): clear AFTER the row exists
        }
        return;
      }

      const cols = Object.keys(filtered).filter((k) => filtered[k] !== undefined);
      if (!cols.includes("crow_id")) cols.push("crow_id");
      const insertCols = [...new Set(cols)];
      const placeholders = insertCols.map(() => "?").join(", ");
      const values = insertCols.map((k) => (k === "crow_id" ? crowId : filtered[k] ?? null));
      await this.db.execute({
        sql: `INSERT INTO contacts (${insertCols.join(", ")}, lamport_ts) VALUES (${placeholders}, ?)`,
        args: [...values, lamportTs],
      });
      await this._afterContactApplied(crowId);
      if (clearTombAfterApply) await clearTombstone(this.db, crowId); // §D3.1(c): clear AFTER the row exists
      return;
    }

    if (lamportTs > localTs) {
      const updateKeys = Object.keys(filtered).filter((k) => k !== "crow_id");
      // PR3 parity: a synced key rebind invalidates a local safety-number check.
      // `verified` is excluded from the wire (only ever set by a local device
      // comparison), so a secp/ed change MUST reset it to 0 — matching the local
      // promote/merge path (contact-promote.js).
      const secpChanged = filtered.secp256k1_pubkey != null &&
        normalizePubkey(String(filtered.secp256k1_pubkey)) !== normalizePubkey(String(localRow.secp256k1_pubkey || ""));
      const edChanged = filtered.ed25519_pubkey != null &&
        String(filtered.ed25519_pubkey) !== String(localRow.ed25519_pubkey || "");
      const setClauses = updateKeys.map((k) => `${k} = ?`);
      const vals = updateKeys.map((k) => filtered[k] ?? null);
      if (secpChanged || edChanged) setClauses.push("verified = 0");
      setClauses.push("lamport_ts = ?"); vals.push(lamportTs);
      await this.db.execute({ sql: `UPDATE contacts SET ${setClauses.join(", ")} WHERE crow_id = ?`, args: [...vals, crowId] });
      await this._afterContactApplied(crowId);
      return;
    }

    // incomingTs <= localTs
    if (rowsEquivalent(localRow, filtered)) return; // re-delivery noise
    try {
      await this._insertConflictRow("contacts", rowIdJson,
        localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
        JSON.stringify(localRow), JSON.stringify(filtered), op || "update");
      await this._notifyConflict();
    } catch (err) {
      console.warn("[instance-sync] contacts conflict LOGGING failed (local kept):", err.message);
    }
  }

  /** Re-select the applied contact row and hand it to the subscribe hook (guarded). */
  async _afterContactApplied(crowId) {
    try {
      const { rows } = await this.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] });
      if (rows[0] && typeof this.onContactSynced === "function") {
        Promise.resolve(this.onContactSynced(rows[0])).catch(() => {});
      }
    } catch {}
  }

  /**
   * Apply a messages mutation keyed on the stable nostr_event_id (Phase 3 PR-B /
   * S3). Messages are immutable inserts; the UNIQUE(nostr_event_id) constraint
   * gives free store-dedupe (the same event arriving via BOTH direct Nostr AND
   * sync yields exactly one row). The per-instance id/contact_id are never used —
   * contact_id is resolved LOCALLY from the wire-carried crow_id. If the contact
   * is not local yet, SKIP (no phantom contact): the row will also arrive via
   * direct Nostr once subscribed, or on a later re-sync once the contact syncs.
   *
   * On a genuinely-new row (INSERT OR IGNORE rowsAffected > 0) fires
   * messages:changed with the LOCAL contact_id (folded from the old :761-771 hook so
   * live badges update). The received-row notification is added in Task 3.
   *
   * @param {"insert"} op            - only inserts are emitted; other ops are no-ops
   * @param {object} row             - wire row (crow_id + nostr_event_id keyed)
   * @param {number} lamportTs       - entry envelope lamport (unused; messages don't LWW)
   * @param {string} instanceId      - origin instance id (unused)
   */
  async _applyMessage(op, row, lamportTs, instanceId) {
    if (op !== "insert") return; // messages are insert-only on the wire
    const eventId = row && row.nostr_event_id;
    const crowId = row && row.crow_id;
    if (!eventId || !crowId) {
      console.warn("[instance-sync] _applyMessage: missing nostr_event_id/crow_id — skipping");
      return;
    }

    // Resolve the LOCAL contact by crow_id. If absent, skip — never conjure a
    // contact through the message channel (trust boundary). The row backfills
    // once the contact syncs (PR-A) or via direct Nostr.
    const { rows: crows } = await this.db.execute({
      sql: "SELECT id, is_blocked FROM contacts WHERE crow_id = ? LIMIT 1",
      args: [crowId],
    });
    const localContactId = crows[0]?.id;
    if (localContactId == null) return;
    // I-2: resolve the local block flag. A locally-blocked contact still STORES
    // the synced row (converged-block semantics — the row is consistent with a
    // block that hasn't finished propagating, and dropping it would lose data),
    // but its NOTIFICATION is SUPPRESSED below. The notification is the security-
    // relevant surface the sync channel must not let a blocked contact bypass
    // during block-propagation divergence.
    const isBlocked = Number(crows[0]?.is_blocked ?? 0) === 1;

    // Store-dedupe on the UNIQUE nostr_event_id. Carry the original created_at
    // (coherent thread ordering) + direction verbatim (a 'sent' row on A shows as
    // 'sent' on B). is_read defaults 0 on this device (per-device unread badge).
    const result = await this.db.execute({
      sql: `INSERT OR IGNORE INTO messages
              (contact_id, nostr_event_id, content, direction, thread_id, created_at, delivery_status, attachments)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        localContactId,
        eventId,
        row.content ?? "",
        row.direction === "sent" ? "sent" : "received", // CHECK-constraint safe
        row.thread_id ?? null,
        row.created_at ?? new Date().toISOString(),
        row.delivery_status ?? null,
        row.attachments ?? null,
      ],
    });

    if (Number(result.rowsAffected ?? 0) > 0 && !isBlocked) {
      // I-2 + M-B1: a locally-blocked contact gets NEITHER the notification
      // NOR the unread-badge tick (the row itself is stored above regardless —
      // convergence preserved, no user-visible surface for a blocked contact).
      // Live badge update (folded from the old :761-771 hook), with the LOCAL id.
      try {
        const { rows } = await this.db.execute({
          sql: `SELECT COUNT(*) AS unread FROM messages
                WHERE contact_id = ? AND is_read = 0 AND direction = 'received'`,
          args: [localContactId],
        });
        bus.emit("messages:changed", { contactId: localContactId, unread: Number(rows?.[0]?.unread ?? 0) });
      } catch {}
      // Task 3 inserts the received-row notification here (gate shared with
      // the badge — see the enclosing !isBlocked).
      await this._notifyMessageApplied?.(localContactId, crowId, row);
    }
  }

  /**
   * Phase 3 PR-B (S-NOTIFY): fire exactly one notification for a newly-stored
   * RECEIVED message (never for a 'sent' mirror). Called only on rowsAffected>0
   * from _applyMessage, so a duplicate (already stored via direct Nostr or an
   * earlier sync) never re-notifies (layer a — per-instance dedupe). Carries the
   * nostr_event_id in metadata as a client collapse key so two simultaneously-
   * online instances' pushes can be merged (layer b). Never throws.
   *
   * this.createNotification is a test seam (default: the shared helper, lazily
   * imported to keep the push side-effect graph out of this module's static load).
   */
  async _notifyMessageApplied(localContactId, crowId, wireRow) {
    try {
      if (!wireRow || wireRow.direction === "sent") return; // only inbound notifies
      let name = crowId;
      try {
        const { rows } = await this.db.execute({
          sql: "SELECT display_name FROM contacts WHERE id = ? LIMIT 1",
          args: [localContactId],
        });
        name = rows[0]?.display_name || crowId;
      } catch {}
      const notify = this.createNotification ||
        (async (db, opts) => {
          const { createNotification } = await import("../shared/notifications.js");
          return createNotification(db, opts);
        });
      await notify(this.db, {
        title: `Message from ${name}`,
        type: "peer",
        source: "sharing:message",
        action_url: "/dashboard/messages",
        // Client-side collapse key: two online instances that both notify for the
        // same DM can dedupe on this. Rides the existing metadata JSON column —
        // NO schema change (SCHEMA_GENERATION stays 4).
        metadata: { nostr_event_id: wireRow.nostr_event_id },
      });
    } catch (err) {
      try { console.warn("[instance-sync] message-applied notify failed:", err.message); } catch {}
    }
  }

  /**
   * Apply a PLAIN contact-group mutation keyed on the stable group_uid (Phase 3
   * groups-follow-user). Rooms (room_uid NOT NULL) are dropped upstream by
   * shouldSyncRow. Group metadata (name/color; sort_order forward-looking, M1) is
   * LWW by lamport_ts, exactly like _applyContact; membership is WHOLE-SET replaced
   * (I1) from the wire-map of member crow_ids on a winning apply — a concurrent
   * removal on the losing side is reverted, not merged — but ONLY when the wire row
   * carries a `members` key (absent != empty, R2 F3: a metadata-only emit skips the
   * reconcile; an explicit [] replaces). Members are resolved to LOCAL
   * contact ids, bounded to the syncable domain (unresolvable OR local-bot/pending
   * members skipped — never conjure a contact, never add a local-bot the peer named).
   * A synced group can never become a room: room_uid/host_crow_id/mode are dropped
   * from every applied write.
   */
  async _applyGroup(op, row, lamportTs, instanceId) {
    const groupUid = row && row.group_uid;
    if (!groupUid) {
      console.warn("[instance-sync] _applyGroup: missing group_uid — skipping");
      return;
    }

    if (!this._groupCols) {
      try {
        const { rows: pragma } = await this.db.execute({ sql: "PRAGMA table_info(contact_groups)", args: [] });
        this._groupCols = new Set(pragma.map((r) => r.name));
      } catch { this._groupCols = null; }
    }
    if (!this._groupCols) {
      console.warn("[instance-sync] _applyGroup: contact_groups columns unavailable — skipping");
      return;
    }
    // Never write id/lamport/created_at, never turn a synced group into a room,
    // never treat the `members` pseudo-column as a real column.
    const ALWAYS_DROP = new Set(["id", "lamport_ts", "instance_id", "created_at", "room_uid", "host_crow_id", "mode", "members"]);
    const filtered = {};
    for (const [k, v] of Object.entries(row)) {
      if (ALWAYS_DROP.has(k)) continue;
      if (!this._groupCols.has(k)) continue;
      filtered[k] = v;
    }

    const { rows: localRows } = await this.db.execute({ sql: "SELECT * FROM contact_groups WHERE group_uid = ? AND room_uid IS NULL", args: [groupUid] });
    const localRow = localRows[0] ?? null;
    const localTs = localRow?.lamport_ts || 0;
    const rowIdJson = JSON.stringify({ group_uid: groupUid });

    // ── delete ──────────────────────────────────────────────────────────────
    if (op === "delete") {
      if (!localRow) return;
      if (lamportTs > localTs) {
        // ON DELETE CASCADE reaps contact_group_members.
        await this.db.execute({ sql: "DELETE FROM contact_groups WHERE group_uid = ? AND room_uid IS NULL", args: [groupUid] });
        return;
      }
      try {
        await this._insertConflictRow("contact_groups", rowIdJson,
          localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
          JSON.stringify(localRow), JSON.stringify(filtered), "delete");
        await this._notifyConflict();
      } catch (err) {
        console.warn("[instance-sync] contact_groups delete conflict LOGGING failed (local kept):", err.message);
      }
      return;
    }

    // ── insert / update (LWW) ───────────────────────────────────────────────
    if (!localRow) {
      const cols = Object.keys(filtered).filter((k) => filtered[k] !== undefined);
      if (!cols.includes("group_uid")) cols.push("group_uid");
      const insertCols = [...new Set(cols)];
      const placeholders = insertCols.map(() => "?").join(", ");
      const values = insertCols.map((k) => (k === "group_uid" ? groupUid : filtered[k] ?? null));
      await this.db.execute({
        sql: `INSERT INTO contact_groups (${insertCols.join(", ")}, lamport_ts) VALUES (${placeholders}, ?)`,
        args: [...values, lamportTs],
      });
      const gid = await this._groupIdByUid(groupUid);
      await this._reconcileGroupMembers(gid, row.members);
      return;
    }

    if (lamportTs > localTs) {
      const updateKeys = Object.keys(filtered).filter((k) => k !== "group_uid");
      const setClauses = updateKeys.map((k) => `${k} = ?`);
      const vals = updateKeys.map((k) => filtered[k] ?? null);
      setClauses.push("lamport_ts = ?"); vals.push(lamportTs);
      await this.db.execute({ sql: `UPDATE contact_groups SET ${setClauses.join(", ")} WHERE group_uid = ?`, args: [...vals, groupUid] });
      await this._reconcileGroupMembers(localRow.id, row.members);
      return;
    }

    // incomingTs <= localTs — local wins wholesale (metadata AND membership).
    // M3: on a metadata-equal tie we return WITHOUT reconciling membership, so a
    // concurrent membership divergence at equal metadata persists silently (documented
    // in Known limitations — acceptable for a single user's low-contention groups).
    if (rowsEquivalent(localRow, filtered)) return; // re-delivery noise
    try {
      await this._insertConflictRow("contact_groups", rowIdJson,
        localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
        JSON.stringify(localRow), JSON.stringify(filtered), op || "update");
      await this._notifyConflict();
    } catch (err) {
      console.warn("[instance-sync] contact_groups conflict LOGGING failed (local kept):", err.message);
    }
  }

  async _groupIdByUid(groupUid) {
    const { rows } = await this.db.execute({ sql: "SELECT id FROM contact_groups WHERE group_uid = ? AND room_uid IS NULL LIMIT 1", args: [groupUid] });
    return rows[0]?.id ?? null;
  }

  /**
   * Whole-set replace (I1) of group membership from a wire-map of member crow_ids,
   * bounded to the SHARED, SYNCABLE contact domain. Absent != empty (R2 F3): a wire
   * row WITHOUT a members key (metadata-only emit) skips the reconcile entirely —
   * only an EXPLICIT array (including []) replaces. A winning apply overwrites the
   * entire local membership: adds resolvable-and-SYNCABLE-and-missing members (never
   * creates a contact, never adds a local-bot/pending contact the peer named — I2);
   * removes only SYNCABLE members (origin != local-bot, established) whose crow_id is
   * absent from the wire-map. Local-only / local-bot / pending memberships are NEVER
   * touched — the emitting peer can't know about them, so a whole-set replace must not
   * wipe them (and a concurrent removal on the LOSING side IS reverted — I1).
   */
  async _reconcileGroupMembers(groupId, wireCrowIds) {
    if (groupId == null) return;
    // R2 F3: members ABSENT (undefined) is a metadata-only emit, NOT an empty group —
    // treating it as [] would wipe every syncable member. Skip; explicit [] still honored.
    if (wireCrowIds === undefined) return;
    const wireSet = new Set((Array.isArray(wireCrowIds) ? wireCrowIds : []).filter(Boolean));

    // Add: resolvable + SYNCABLE + missing (I2 — symmetric with the remove branch).
    for (const crowId of wireSet) {
      try {
        const { rows } = await this.db.execute({ sql: "SELECT id, origin, request_status FROM contacts WHERE crow_id = ? LIMIT 1", args: [crowId] });
        const c = rows[0];
        if (c == null || c.id == null) continue; // unresolved — never create a contact
        const syncable = c.origin !== "local-bot" &&
          (c.request_status == null || c.request_status === "accepted");
        if (!syncable) continue; // peer cannot pull a local-bot/pending contact into a synced group
        await this.db.execute({ sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)", args: [groupId, c.id] });
      } catch (err) {
        console.warn(`[instance-sync] _reconcileGroupMembers add ${crowId} failed: ${err.message}`);
      }
    }

    // Remove: syncable members no longer in the wire-map.
    try {
      const { rows: locals } = await this.db.execute({
        sql: `SELECT gm.contact_id, c.crow_id, c.origin, c.request_status
                FROM contact_group_members gm JOIN contacts c ON c.id = gm.contact_id
               WHERE gm.group_id = ?`, args: [groupId],
      });
      for (const lm of locals) {
        const syncable = lm.origin !== "local-bot" &&
          (lm.request_status == null || lm.request_status === "accepted");
        if (!syncable) continue;                 // local-only membership — peer can't know it
        if (wireSet.has(lm.crow_id)) continue;   // still a member
        await this.db.execute({ sql: "DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?", args: [groupId, lm.contact_id] });
      }
    } catch (err) {
      console.warn(`[instance-sync] _reconcileGroupMembers remove failed: ${err.message}`);
    }
  }

  /**
   * Check if applying an update or delete would conflict with a local version.
   *
   * Equivalence check (for updates): apply the table's OUTBOUND_TRANSFORMS to
   * the local row before comparing, so a locally-assigned transformed column
   * (e.g. research_notes.project_id) never manufactures a false conflict.
   *
   * Delete path: equivalence check is skipped — a delete vs a live row is never
   * equivalent. Low incomingTs + local row → conflict op='delete'.
   *
   * NO same-author heuristic: row.instance_id is the ORIGIN instance, not the
   * last editor. Treating same-origin as "safe stale re-order" would silently
   * drop real concurrent edits of rows both instances received from one origin.
   *
   * @param {string} op - 'update' or 'delete' (caller gates before calling)
   * @returns {Promise<"apply"|"skip">}
   */
  async _checkConflict(table, rowId, incomingTs, incomingInstanceId, incomingRow, op) {
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

      // incomingTs <= localTs: potential conflict.
      // For updates: run equivalence check to filter re-delivery noise.
      // For deletes: skip equivalence — a delete vs live row is never equivalent.
      if (op !== "delete") {
        // Apply OUTBOUND_TRANSFORMS to the local row before comparing so that a
        // locally-assigned transformed column (e.g. project_id on research_notes)
        // doesn't manufacture a false conflict for an otherwise-identical row.
        const transform = OUTBOUND_TRANSFORMS[table];
        const localForCompare = transform ? transform({ ...localRow }) : localRow;
        if (rowsEquivalent(localForCompare, incomingRow)) {
          return "skip"; // Re-delivery noise — no conflict row needed
        }
      }

      // Real conflict: log both versions and notify the operator.
      // The verdict is already determined here (local is newer and the data
      // differs) — a failure to LOG must not flip it to "apply" and overwrite
      // newer local data, so logging gets its own guard and we skip regardless.
      try {
        await this._insertConflictRow(
          table, String(rowId),
          localRow.instance_id || this.localInstanceId, incomingInstanceId,
          localTs, incomingTs,
          JSON.stringify(localRow), JSON.stringify(incomingRow),
          op || "update",
        );
        await this._notifyConflict();
      } catch (err) {
        console.warn(`[instance-sync] Conflict LOGGING failed for ${table}:${rowId} (local data still preserved):`, err.message);
      }

      return "skip"; // Local version wins
    } catch (err) {
      console.warn(`[instance-sync] Conflict check failed for ${table}:${rowId}:`, err.message);
    }

    return "apply"; // Default to applying on error
  }

  /**
   * Insert a sync_conflicts row, degrading gracefully when the `op` column
   * doesn't exist yet (code pulled + gateway restarted before init-db ran —
   * the gateway-boot migration also closes this, but a non-gateway host or a
   * mid-boot race must not lose the conflict trace, and in _checkConflict a
   * thrown INSERT must never cascade into applying a stale row).
   */
  async _insertConflictRow(tableName, rowId, winInst, loseInst, winTs, loseTs, winData, loseData, conflictOp) {
    const legacyCols = `table_name, row_id, winning_instance_id, losing_instance_id,
                 winning_lamport_ts, losing_lamport_ts, winning_data, losing_data`;
    const legacyArgs = [tableName, rowId, winInst, loseInst, winTs, loseTs, winData, loseData];
    try {
      await this.db.execute({
        sql: `INSERT INTO sync_conflicts (${legacyCols}, op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [...legacyArgs, conflictOp],
      });
    } catch (err) {
      if (!/no column named op/i.test(err.message || "")) throw err;
      await this.db.execute({
        sql: `INSERT INTO sync_conflicts (${legacyCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: legacyArgs,
      });
    }
  }

  /**
   * Fire an operator notification when a real conflict is logged.
   * Deduped: if an unread+undismissed instance-sync notification already
   * exists, skip creating another one. The SELECT-then-INSERT is TOCTOU-racy
   * across peers (per-peer locks don't serialize across different peers), so a
   * duplicate may slip through — that's acceptable (harmless extra bell item).
   * Never throws into the apply loop.
   */
  async _notifyConflict() {
    try {
      const { rows: existing } = await this.db.execute({
        sql: `SELECT id FROM notifications
              WHERE source = 'instance-sync' AND is_read = 0 AND is_dismissed = 0
              LIMIT 1`,
        args: [],
      });
      if (existing.length > 0) return; // Standing notification already present

      // Lazy dynamic import to avoid loading gateway push modules in
      // non-gateway contexts (same pattern as crow-context.js import above).
      const { createNotification } = await import("../shared/notifications.js");
      await createNotification(this.db, {
        type: "system",
        source: "instance-sync",
        priority: "high",
        title: "Sync conflict recorded",
        body: "A sync conflict was recorded — one version of an item was kept, the other saved for review.",
        action_url: "/dashboard/settings?section=sync-conflicts",
      });
    } catch (err) {
      console.warn("[instance-sync] Failed to send conflict notification:", err.message);
    }
  }

  /**
   * Apply an insert operation from a remote instance.
   * On INSERT OR IGNORE conflict (rowsAffected === 0): fetch the local row.
   * - row.id == null → warn only (binding undefined to better-sqlite3 throws)
   * - No local row at that id → secondary UNIQUE/NOT NULL/CHECK collision, not
   *   an id collision; warn-log only, no conflict row (the dual-path messages
   *   Nostr+sync delivery is the live example)
   * - Local row equivalent → benign re-delivery, done
   * - Local row differs → log conflict op='insert' + notify (D7 surfacing)
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

    const result = await this.db.execute({
      sql: `INSERT OR IGNORE INTO ${table} (${colNames}) VALUES (${placeholders})`,
      args: values,
    });

    if (result.rowsAffected === 0) {
      // INSERT OR IGNORE skipped — figure out why.
      if (row.id == null) {
        // Better-sqlite3 throws on undefined binds; null id is also not useful.
        console.warn(`[instance-sync] _applyInsert: null/undefined id on ${table} — skipping`);
        return;
      }

      const { rows: localRows } = await this.db.execute({
        sql: `SELECT * FROM ${table} WHERE id = ?`,
        args: [row.id],
      });

      if (localRows.length === 0) {
        // No row at this id — secondary UNIQUE/NOT NULL/CHECK collision.
        // Not an id collision; log and move on without a conflict row.
        console.warn(`[instance-sync] _applyInsert: INSERT OR IGNORE on ${table} id=${row.id} skipped (secondary constraint); no conflict logged`);
        return;
      }

      const localRow = localRows[0];
      // Apply transform to the local row before equivalence comparison (same
      // logic as _checkConflict) so a transformed column doesn't trigger
      // a false insert-conflict for an otherwise-identical row.
      const transform = OUTBOUND_TRANSFORMS[table];
      const localForCompare = transform ? transform({ ...localRow }) : localRow;
      if (rowsEquivalent(localForCompare, row)) {
        return; // Benign re-delivery
      }

      // Id collision with different data — surface it (D7 minimal fix).
      // The incoming insert is still not applied; the trace is preserved.
      await this._insertConflictRow(
        table, String(row.id),
        localRow.instance_id || this.localInstanceId, instanceId,
        localRow.lamport_ts || 0, lamportTs,
        JSON.stringify(localRow), JSON.stringify(row),
        "insert",
      );

      await this._notifyConflict();
    }
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
   * Atomically update the last applied sequence number for a remote peer.
   *
   * Uses json_set on the existing blob — a single atomic UPDATE that avoids
   * the SELECT-then-UPDATE race (D3) where two peers checkpointing concurrently
   * could lose one of the two writes. json_set accepts the path as a bound
   * parameter; instance ids are UUIDs so they contain no `"` — but we
   * defensively reject ids that would corrupt the JSON path.
   *
   * Semantics unchanged: `seq` is the NEXT unprocessed sequence number
   * (i.e. the last successfully attempted seq + 1). getSyncStatus and
   * _getLastAppliedSeq consume the same blob.
   */
  async _setLastAppliedSeq(remoteInstanceId, seq) {
    // Guard: a `"` in the id would break the json_set path literal.
    if (remoteInstanceId.includes('"')) {
      console.warn(`[instance-sync] _setLastAppliedSeq: skipping id with quote char: ${remoteInstanceId}`);
      return;
    }
    try {
      await this._ensureCounter();
      await this.db.execute({
        sql: `UPDATE sync_state
              SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer, '{}'), ?, CAST(? AS INTEGER)),
                  updated_at = datetime('now')
              WHERE instance_id = ?`,
        args: [`$."${remoteInstanceId}"`, seq, this.localInstanceId],
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
   * Close feeds for a single remote instance and remove them from the Maps.
   *
   * Serialized through the _initLocks tail so close cannot interleave with a
   * concurrent initInstance call for the same remoteInstanceId. Hypercore close
   * is safe and on-disk storage persists; the instance lazily re-inits on
   * un-revoke (boot.js eagerInitPairedPeers / tailnet-sync paths gate on status
   * and will reopen when the instance is un-revoked).
   */
  async closeInstanceFeeds(remoteInstanceId) {
    const prior = this._initLocks.get(remoteInstanceId) || Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(() => this._closeInstanceFeedsInner(remoteInstanceId));
    this._initLocks.set(remoteInstanceId, next);
    try {
      return await next;
    } finally {
      if (this._initLocks.get(remoteInstanceId) === next) {
        this._initLocks.delete(remoteInstanceId);
      }
    }
  }

  async _closeInstanceFeedsInner(remoteInstanceId) {
    const outFeed = this.outFeeds.get(remoteInstanceId);
    if (outFeed) {
      try { await outFeed.close(); } catch {}
      this.outFeeds.delete(remoteInstanceId);
    }
    const inFeed = this.inFeeds.get(remoteInstanceId);
    if (inFeed) {
      try { await inFeed.close(); } catch {}
      this.inFeeds.delete(remoteInstanceId);
    }
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
