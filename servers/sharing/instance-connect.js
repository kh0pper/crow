/**
 * Hyperswarm instance-connection handling, extracted from boot.js's
 * peerManager.onInstanceConnected so it can be driven by a test (review I2).
 *
 * All of one user's instances share one crow_id, so "crow_id X connected"
 * does not say which instance is on the other end. peer-manager passes the
 * instance_id the peer advertised on its challenge-response; when present,
 * ONLY that instance's feeds ride this connection and only its row is marked
 * seen. Before this, one sibling's connection replicated every live sibling
 * row (and refreshed every row's status), so a revoked or departed sibling
 * could be carried through someone else's connection.
 *
 * Older peers that advertise no instance_id keep the legacy behaviour:
 * every LIVE same-crow_id row (active/offline; revoked and paused excluded),
 * except a row whose sibling has pair-bound (PT-2a): a bound sibling always
 * names itself, so an anonymous connection never carries its feeds.
 */
import { markInstanceConnectionSeen } from "../shared/instance-status.js";
import { TRUSTED_PEER_SQL } from "../shared/peer-trust.js";
import {
  pairSubkey, pairSubkeyVia, hyperswarmMac, macEqual, defaultPairKey, pairBindingMode,
  isPairPinned, decideAndRecordPairBinding,
} from "../shared/sync-pair-binding.js";
import { ENROLL_ID_RE } from "../shared/enroll-guard.js";

/**
 * @param {object} p
 * @param {object} p.db
 * @param {object} p.instanceSyncManager
 * @param {string} p.crowId
 * @param {object} p.conn                 the authenticated Hyperswarm stream
 * @param {string|null} [p.remoteInstanceId]
 * @returns {Promise<string[]>} the instance ids replicated over `conn`
 */
export async function handleInstanceConnection({ db, instanceSyncManager, crowId, conn, remoteInstanceId = null }) {
  // Accept status='active' or 'offline' — a live Hyperswarm connection IS
  // the signal the peer is up (an offline-but-connected peer must still
  // initialize). Revoked/paused peers stay excluded.
  const localId = instanceSyncManager.localInstanceId;
  const { rows } = await db.execute({
    sql: `SELECT id FROM crow_instances WHERE crow_id = ? AND ${TRUSTED_PEER_SQL} AND id != ?`,
    args: [crowId, localId],
  });
  const liveIds = rows.map((r) => r.id);
  let targets;
  if (remoteInstanceId) {
    targets = liveIds.filter((id) => id === remoteInstanceId);
  } else {
    // No id: only rows whose sibling has never pair-bound (the pin read fails
    // closed, so an unreadable pin keeps the row off this connection).
    targets = [];
    for (const id of liveIds) if (!(await isPairPinned(db, localId, id))) targets.push(id);
  }

  for (const id of targets) {
    // Arm the out-feed (and the in-feed if a key is already known). No key
    // is passed: the authenticated feed-key receipt on the challenge-response
    // drives any swap (same rule as tailnet-sync's 2d F3 note).
    await instanceSyncManager.initInstance(id, null);
    await instanceSyncManager.replicate(id, conn);
  }

  // Only the rows this connection carries are marked seen.
  await markInstanceConnectionSeen(db, { matchedIds: targets, remoteInstanceId });
  return targets;
}

/**
 * The Hyperswarm pair-binding guard and MAC hook (PT-2a, private engineering
 * notes §3.5). `localId()` is read at call time.
 */
function makeInstanceBinding({ db, localId, pairKeyLookup, mode }) {
  /**
   * Our MAC for a sibling that offered `pb: 1` and has proven the seed on
   * this connection (PeerManager._admit sends it in a `pair-binding` frame),
   * or null. Synchronous: the production store read is; an async lookup
   * yields no MAC.
   */
  function macFor({ peerInstanceId, challengeHex, handshakeHashHex }) {
    const me = localId();
    if (!me || typeof peerInstanceId !== "string" || !ENROLL_ID_RE.test(peerInstanceId) || peerInstanceId === me) return null;
    try {
      const hex = pairKeyLookup(peerInstanceId);
      if (typeof hex !== "string" || !hex) return null;
      return hyperswarmMac(pairSubkey(hex), { responder: me, challenger: peerInstanceId, challenge: challengeHex, handshakeHash: handshakeHashHex });
    } catch {
      return null;
    }
  }

  /** Is `peerId` a trusted sibling row here? A lookup error is "no" (record nothing). */
  async function hasTrustedRow(peerId, me) {
    if (!peerId) return false;
    try {
      const { rows } = await db.execute({
        sql: `SELECT id FROM crow_instances WHERE id = ? AND ${TRUSTED_PEER_SQL} AND id != ? LIMIT 1`,
        args: [peerId, me ?? ""],
      });
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Verifier (admitGuards.instance): runs in PeerManager._admit after the
   * sibling proved our key, the one instance id is resolved and its
   * `pair-binding` frame (if it offered pb) arrived, before any admission
   * side effect. Bound = its pb_mac verifies under OUR challenge and OUR
   * handshake hash. The Nest records only siblings we have a trusted row
   * for, so an id a seed holder makes up leaves nothing behind.
   */
  async function guard({ conn, state, remoteInstanceId, pbMac }) {
    const me = localId();
    const k = await pairSubkeyVia(pairKeyLookup, remoteInstanceId);
    let bound = false;
    let macInvalid = false;
    if (pbMac !== undefined && pbMac !== null && k) {
      const hh = state?.handshakeHashHex || (conn?.handshakeHash?.length ? Buffer.from(conn.handshakeHash).toString("hex") : null);
      try {
        bound = Boolean(me && hh && state?.ourChallengeHex) && macEqual(pbMac, hyperswarmMac(k, {
          responder: remoteInstanceId, challenger: me, challenge: state.ourChallengeHex, handshakeHash: hh,
        }));
      } catch {
        bound = false;
      }
      macInvalid = !bound;
    }
    const d = await decideAndRecordPairBinding({
      db, localId: me, peerId: remoteInstanceId, k, bound, macInvalid, mode,
      prefix: "[sharing]", where: "Hyperswarm", recordNest: await hasTrustedRow(remoteInstanceId, me),
    });
    return d.ok ? { ok: true } : { ok: false, reason: d.reason };
  }

  return { macFor, guard };
}

/**
 * Wire a PeerManager's Hyperswarm instance sync (PT-2a I1): the three
 * instance closures (moved unchanged from boot.js), the pair-binding guard
 * (admitGuards.instance) and the responder hook (instanceBinding). boot.js
 * calls it synchronously next to wireContactBinding, before the swarm joins
 * any topic; tests drive the same function.
 *
 * @param {object} peerManager
 * @param {object} o
 * @param {object} o.db
 * @param {object} o.instanceSyncManager
 * @param {(peerId:string)=>string|null} [o.pairKeyLookup] the pair's signing_key hex
 * @param {"auto"|"require"} [o.mode]
 * @param {number} [o.pairBindingWaitMs] how long to wait for a sibling's pair-binding frame (PeerManager default 10 s)
 */
export function wireInstanceSync(peerManager, { db, instanceSyncManager, pairKeyLookup = defaultPairKey, mode = pairBindingMode(), pairBindingWaitMs } = {}) {
  // Wire instance-to-instance connections for Hypercore replication
  peerManager.onInstanceConnected = async (crowId, conn, remoteInstanceId = null) => {
    console.log(`[sharing] Instance peer connected: ${crowId}`);

    // One connection = one instance when the peer advertised its id
    // (servers/sharing/instance-connect.js, review I2).
    try {
      await handleInstanceConnection({ db, instanceSyncManager, crowId, conn, remoteInstanceId });
    } catch (err) {
      console.warn(`[sharing] Instance connection handling failed for ${crowId}:`, err.message);
    }
  };

  // peer-manager asks us for OUR outgoing feed key to a specific peer
  // instance (remoteInstanceId is the peer's local id, which matches the
  // `id` column in our crow_instances table for that peer's row).
  peerManager.getFeedKeyForInstance = async (remoteInstanceId) => {
    try {
      // Only return a key if we actually have a paired row for this instance.
      const { rows } = await db.execute({
        sql: `SELECT id FROM crow_instances WHERE id = ? AND ${TRUSTED_PEER_SQL} AND id != ? LIMIT 1`,
        args: [remoteInstanceId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return null;
      // Ensure our outbound feed to this peer exists before asking for the key.
      await instanceSyncManager.initInstance(remoteInstanceId, null);
      const key = instanceSyncManager.getOutFeedKey(remoteInstanceId);
      return key ? key.toString("hex") : null;
    } catch (err) {
      console.warn(`[sharing] getFeedKeyForInstance for ${remoteInstanceId}:`, err.message);
      return null;
    }
  };

  // Persist a peer-advertised feed key so we can open their incoming feed.
  // Called only after the sibling proved our key: from a new sibling's
  // `instance-key` frame, or an old sibling's challenge-response piggyback
  // (instance_id, feed_key_hex). See peer-manager.js.
  peerManager.onInstanceKeyReceived = async (remoteInstanceId, feedKeyHex) => {
    try {
      const { rows } = await db.execute({
        sql: `SELECT sync_url FROM crow_instances WHERE id = ? AND ${TRUSTED_PEER_SQL} AND id != ?`,
        args: [remoteInstanceId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return; // Not paired with this instance_id — drop
      const keyBuf = instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, feedKeyHex);
      if (!keyBuf) return; // malformed or self-echoed — skip persist AND init
      if (rows[0].sync_url === feedKeyHex) return; // unchanged — skip
      await db.execute({
        sql: "UPDATE crow_instances SET sync_url = ?, updated_at = datetime('now') WHERE id = ? AND status != 'revoked'",
        args: [feedKeyHex, remoteInstanceId],
      });
      console.log(`[sharing] Stored feed key for instance ${remoteInstanceId.slice(0, 12)}…`);
      // Open the incoming feed now that we have the key. initInstance is
      // idempotent — re-calling with a non-null feedKey adds the inFeed
      // without disturbing the already-open outFeed.
      try {
        await instanceSyncManager.initInstance(remoteInstanceId, keyBuf);
      } catch (err) {
        console.warn(`[sharing] Failed to open inbound feed after key exchange: ${err.message}`);
      }
    } catch (err) {
      console.warn(`[sharing] onInstanceKeyReceived for ${remoteInstanceId}:`, err.message);
    }
  };

  // PT-2a: the pair-binding guard and responder hook. The local id is read
  // at call time, never captured.
  const localId = () => peerManager.localInstanceId || instanceSyncManager?.localInstanceId || null;
  const binding = makeInstanceBinding({ db, localId, pairKeyLookup, mode });
  if (!peerManager.admitGuards) peerManager.admitGuards = { instance: null, contact: null };
  peerManager.admitGuards.instance = binding.guard;
  peerManager.instanceBinding = { macFor: binding.macFor };
  if (Number.isFinite(pairBindingWaitMs) && pairBindingWaitMs > 0) peerManager.pairBindingWaitMs = pairBindingWaitMs;
  return peerManager;
}
