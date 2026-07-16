/**
 * Peer Discovery & Connection Manager
 *
 * Uses Hyperswarm DHT for peer-to-peer discovery:
 * - Topic = hash(sorted pubkey pair) — unique per contact
 * - Challenge-response auth on connect
 * - Connection state tracking and reconnection
 */

import Hyperswarm from "hyperswarm";
import { shouldInitInstanceSync } from "./instance-sync.js";
import { createHash, randomBytes } from "node:crypto";
import { sign, verify } from "./identity.js";

// 2c follow-up (spec §F2 C2c): hard cap on awaiting the DHT announce
// confirmation (`discovery.flushed()`) in joinContact. An unresponsive DHT
// must not wedge the boot per-contact join loop (boot.js) or the inbound
// sync apply chain (wireFullContact → joinContact). Overridable per-call via
// opts.flushedCapMs (tests).
const FLUSHED_CAP_MS = 10_000;

/**
 * Create a deterministic topic for a contact pair.
 * topic = sha256(sorted(myPubkey, theirPubkey))
 */
function computeTopic(myEd25519Pub, theirEd25519Pub) {
  const keys = [myEd25519Pub, theirEd25519Pub].sort();
  return createHash("sha256")
    .update(keys[0])
    .update(keys[1])
    .digest();
}

export class PeerManager {
  constructor(identity) {
    this.identity = identity;
    this.swarm = null;
    this.connections = new Map(); // crowId -> { conn, authenticated }
    this.topics = new Map(); // crowId -> topic buffer
    this.instanceSyncTopic = null; // Buffer — the instance sync DHT topic
    this.onPeerConnected = null; // callback(crowId, conn)
    this.onPeerData = null; // callback(crowId, data)
    this.onPeerDisconnected = null; // callback(crowId)
    this.onInstanceConnected = null; // callback(crowId, conn) — instance-to-instance connections
    this.onInstanceKeyReceived = null; // callback(remoteInstanceId, feedKeyHex) — peer advertised their outgoing Hypercore feed key
    this.getFeedKeyForInstance = null; // async (remoteInstanceId) => hex — our outgoing feed key to this specific peer instance
    this.localInstanceId = null; // wired by server.js — the local Crow instance id we advertise to peers

    // A --no-auth companion gateway (e.g. grackle's loopback crow-mcp-bridge) is
    // never a peer — it must NOT run the Hyperswarm P2P layer, or it steals the
    // DHT-topic connection (and per-contact feed locks) from the PRIMARY gateway,
    // starving the primary's cross-instance replication. Same signal as the
    // instance-sync feed gate. See shouldInitInstanceSync().
    this.p2pDisabled = !shouldInitInstanceSync({ argv: process.argv, env: process.env });
  }

  /**
   * Initialize Hyperswarm and start listening.
   */
  async start() {
    if (this.p2pDisabled) return this; // --no-auth companion: no swarm
    this.swarm = new Hyperswarm();

    this.swarm.on("connection", (conn, info) => {
      this._handleConnection(conn, info);
    });

    return this;
  }

  /**
   * Join the DHT topic for a specific contact.
   * @param {{crowId?:string, crow_id?:string, ed25519Pubkey:string}} contact
   * @param {{flushedCapMs?:number}} [opts] override the flushed() cap (tests)
   */
  async joinContact(contact, opts = {}) {
    if (this.p2pDisabled) return null; // --no-auth companion: no DHT topics
    if (!this.swarm) throw new Error("PeerManager not started");
    const cap = Number(opts.flushedCapMs) > 0 ? Number(opts.flushedCapMs) : FLUSHED_CAP_MS;

    const topic = computeTopic(
      this.identity.ed25519Pubkey,
      contact.ed25519Pubkey
    );

    this.topics.set(contact.crow_id || contact.crowId, topic);

    const discovery = this.swarm.join(topic, { server: true, client: true });
    // Cap ONLY the announce-confirmation await (C2c). The topic registration
    // (topics.set above) and the announce (swarm.join above) have already
    // fired — flushed() merely confirms the announce reached the DHT. On cap
    // we proceed: only the confirmation is abandoned, never the announce.
    // Timer is cleared when flushed() wins (no dangling timer).
    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve("__flushed_cap__"), cap);
    });
    try {
      const r = await Promise.race([discovery.flushed(), guard]);
      if (r === "__flushed_cap__") {
        console.warn(`[peer-manager] joinContact: discovery.flushed() exceeded ${cap}ms — proceeding without DHT announce confirmation`);
      }
    } finally {
      clearTimeout(timer);
    }

    return topic;
  }

  /**
   * Leave a contact's topic (disconnect).
   */
  async leaveContact(crowId) {
    const topic = this.topics.get(crowId);
    if (topic) {
      await this.swarm.leave(topic);
      this.topics.delete(crowId);
    }
    const conn = this.connections.get(crowId);
    if (conn) {
      conn.conn.destroy();
      this.connections.delete(crowId);
    }
  }

  /**
   * Join the instance sync DHT topic.
   * All instances owned by the same Crow ID join this topic for P2P discovery.
   * topic = sha256(crowId + "instance-sync")
   * @param {{flushedCapMs?:number}} [opts] override the flushed() cap (tests)
   */
  async joinInstanceSync(opts = {}) {
    if (this.p2pDisabled) return null; // --no-auth companion: no instance-sync topic
    if (!this.swarm) throw new Error("PeerManager not started");
    const cap = Number(opts.flushedCapMs) > 0 ? Number(opts.flushedCapMs) : FLUSHED_CAP_MS;

    this.instanceSyncTopic = createHash("sha256")
      .update(this.identity.crowId + "instance-sync")
      .digest();

    const discovery = this.swarm.join(this.instanceSyncTopic, { server: true, client: true });
    // Cap ONLY the announce-confirmation await (C2c, same shape as
    // joinContact). The topic registration (instanceSyncTopic above) and the
    // announce (swarm.join above) have already fired — flushed() merely
    // confirms the announce reached the DHT. On cap we proceed: only the
    // confirmation is abandoned, never the announce. Timer is cleared when
    // flushed() wins (no dangling timer).
    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve("__flushed_cap__"), cap);
    });
    try {
      const r = await Promise.race([discovery.flushed(), guard]);
      if (r === "__flushed_cap__") {
        console.warn(`[peer-manager] joinInstanceSync: discovery.flushed() exceeded ${cap}ms — proceeding without DHT announce confirmation`);
      }
    } finally {
      clearTimeout(timer);
    }

    console.log(`[peer-manager] Joined instance sync topic for ${this.identity.crowId}`);
    return this.instanceSyncTopic;
  }

  /**
   * Check if a connection came from the instance sync topic.
   */
  _isInstanceConnection(info) {
    if (!this.instanceSyncTopic || !info?.topics) return false;
    return info.topics.some(t => t.equals(this.instanceSyncTopic));
  }

  /**
   * Handle incoming connection with challenge-response auth.
   */
  _handleConnection(conn, info) {
    let authenticated = false;
    let remoteCrowId = null;
    const isInstanceConn = this._isInstanceConnection(info);

    // Send challenge. On instance-sync connections we also advertise our
    // local instance_id so the peer can look up OUR row in their
    // crow_instances table (crow_id alone is ambiguous — all instances of
    // the same user share one Crow identity).
    const challenge = randomBytes(32);
    const challengePayload = {
      type: "challenge",
      challenge: challenge.toString("hex"),
      pubkey: this.identity.ed25519Pubkey,
      crowId: this.identity.crowId,
    };
    // Always include our instance_id when available. The remote uses crow_id
    // match to decide whether to treat this as an instance-sync connection;
    // we can't make that call on the sender side because we don't yet know
    // the peer's crow_id at challenge-send time. Safe to include on contact
    // connections too — the receiver ignores it for non-same-user peers.
    if (this.localInstanceId) {
      challengePayload.instance_id = this.localInstanceId;
    }
    conn.write(JSON.stringify(challengePayload) + "\n");

    let buffer = "";
    conn.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this._handleMessage(conn, msg, challenge, { authenticated, remoteCrowId, isInstanceConn }, (state) => {
            authenticated = state.authenticated;
            remoteCrowId = state.remoteCrowId;
          });
        } catch (err) {
          // Ignore parse errors
        }
      }
    });

    conn.on("close", () => {
      if (remoteCrowId) {
        this.connections.delete(remoteCrowId);
        if (this.onPeerDisconnected) this.onPeerDisconnected(remoteCrowId);
      }
    });

    conn.on("error", () => {
      if (remoteCrowId) {
        this.connections.delete(remoteCrowId);
      }
    });
  }

  /**
   * Handle protocol messages.
   */
  _handleMessage(conn, msg, ourChallenge, state, setState) {
    switch (msg.type) {
      case "challenge": {
        // Respond with signed challenge + our own challenge response. When
        // the peer's crow_id matches our own, this is an instance-sync
        // connection regardless of Hyperswarm's topic hint (hyperswarm
        // doesn't consistently populate info.topics on both sides, so the
        // crow_id-match is the reliable signal that both endpoints belong
        // to the same user). Piggyback our local instance_id + outgoing
        // feed key so the peer can open its inbound feed without more
        // round trips.
        (async () => {
          const response = sign(msg.challenge, this.identity.ed25519Priv);
          const isInstance = state.isInstanceConn || msg.crowId === this.identity.crowId;
          let feedKeyHex = null;
          if (isInstance && msg.instance_id && this.getFeedKeyForInstance) {
            try { feedKeyHex = await this.getFeedKeyForInstance(msg.instance_id); } catch {}
          }
          const payload = {
            type: "challenge-response",
            signature: response,
            pubkey: this.identity.ed25519Pubkey,
            crowId: this.identity.crowId,
          };
          if (isInstance && this.localInstanceId) {
            payload.instance_id = this.localInstanceId;
          }
          if (feedKeyHex) payload.feed_key_hex = feedKeyHex;
          conn.write(JSON.stringify(payload) + "\n");
        })();
        break;
      }

      case "challenge-response": {
        // Verify their response to our challenge
        const valid = verify(
          ourChallenge.toString("hex"),
          msg.signature,
          msg.pubkey
        );

        if (valid) {
          state.authenticated = true;
          state.remoteCrowId = msg.crowId;
          setState(state);

          this.connections.set(msg.crowId, {
            conn,
            authenticated: true,
            pubkey: msg.pubkey,
          });

          conn.write(JSON.stringify({ type: "authenticated" }) + "\n");

          // Self-loopback filter: Hyperswarm's DHT discovery on the
          // instance-sync topic (sha256(crowId+"instance-sync")) can return
          // ourselves as a candidate peer. Drop the connection before we
          // invoke any callbacks — there's nothing to sync with ourselves.
          if (msg.crowId === this.identity.crowId && msg.instance_id && msg.instance_id === this.localInstanceId) {
            conn.destroy();
            this.connections.delete(msg.crowId);
            break;
          }

          // Same-crow_id peer is definitely an instance-sync connection
          // (peer is one of our own paired instances), regardless of
          // whether Hyperswarm tagged the connection with our topic.
          const isInstance = state.isInstanceConn || msg.crowId === this.identity.crowId;

          // Peer piggybacked their outgoing Hypercore feed key on the
          // challenge-response — persist it before dispatching so the
          // onInstanceConnected handler can open the inbound feed with
          // the received key on its first attempt. Must include the
          // peer's instance_id so we know which crow_instances row to
          // write to (crow_id is shared across all paired instances).
          if (isInstance && msg.instance_id && msg.feed_key_hex && this.onInstanceKeyReceived) {
            Promise.resolve(this.onInstanceKeyReceived(msg.instance_id, msg.feed_key_hex)).catch(() => {});
          }

          // Dispatch to the appropriate handler based on connection origin
          if (isInstance && this.onInstanceConnected) {
            this.onInstanceConnected(msg.crowId, conn);
          } else if (this.onPeerConnected) {
            this.onPeerConnected(msg.crowId, conn);
          }
        } else {
          conn.destroy();
        }
        break;
      }

      case "authenticated": {
        // The other side confirmed our auth
        break;
      }

      case "data": {
        if (state.authenticated && state.remoteCrowId && this.onPeerData) {
          this.onPeerData(state.remoteCrowId, msg.payload);
        }
        break;
      }

      // NOTE: a "feed-key-announce" case lived here until 2026-07. Nothing in
      // the codebase ever SENT that message type (feed keys ride the
      // challenge/challenge-response piggyback above; rotation rides
      // tailnet-sync's in-band exchange, 2d), and the handler passed
      // state.remoteCrowId where onInstanceKeyReceived requires an INSTANCE
      // id — crow_id is shared fleet-wide and can never key a crow_instances
      // row. If an announce message is ever actually needed, it must carry
      // the sender's instance_id (see the challenge-response case).
    }
  }

  /**
   * Send data to a connected peer.
   */
  send(crowId, payload) {
    const peer = this.connections.get(crowId);
    if (!peer || !peer.authenticated) {
      throw new Error(`Not connected to ${crowId}`);
    }
    peer.conn.write(JSON.stringify({
      type: "data",
      payload,
    }) + "\n");
  }

  /**
   * Check if a peer is connected.
   */
  isConnected(crowId) {
    const peer = this.connections.get(crowId);
    return peer?.authenticated || false;
  }

  /**
   * Get list of connected peer IDs.
   */
  getConnectedPeers() {
    return [...this.connections.entries()]
      .filter(([, p]) => p.authenticated)
      .map(([id]) => id);
  }

  /**
   * Shut down the swarm.
   */
  async destroy() {
    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }
    this.connections.clear();
    this.topics.clear();
  }
}
