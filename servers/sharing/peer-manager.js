/**
 * Peer Discovery & Connection Manager
 *
 * Uses Hyperswarm DHT for peer-to-peer discovery:
 * - Topic = hash(sorted pubkey pair) — unique per contact
 * - Challenge-response auth on connect
 * - Connection state tracking and reconnection
 */

import Hyperswarm from "hyperswarm";
import { createHash, randomBytes } from "node:crypto";
import { sign, verify } from "./identity.js";

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
  }

  /**
   * Initialize Hyperswarm and start listening.
   */
  async start() {
    this.swarm = new Hyperswarm();

    this.swarm.on("connection", (conn, info) => {
      const pid = info?.publicKey?.toString("hex")?.slice(0,16) || "?";
      const topics = info?.topics?.map(t => t.toString("hex").slice(0,12)).join(",") || "?";
      console.log(`[peer-manager] swarm.connection peer=${pid} topics=${topics} instanceSyncTopic=${this.instanceSyncTopic?.toString("hex").slice(0,12) || "null"}`);
      this._handleConnection(conn, info);
    });
    this.swarm.on("update", () => {
      if (this.instanceSyncTopic) {
        console.log(`[peer-manager] swarm.update peers=${this.swarm.peers.size} conns=${this.swarm.connections.size}`);
      }
    });

    return this;
  }

  /**
   * Join the DHT topic for a specific contact.
   */
  async joinContact(contact) {
    if (!this.swarm) throw new Error("PeerManager not started");

    const topic = computeTopic(
      this.identity.ed25519Pubkey,
      contact.ed25519Pubkey
    );

    this.topics.set(contact.crow_id || contact.crowId, topic);

    const discovery = this.swarm.join(topic, { server: true, client: true });
    await discovery.flushed();

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
   */
  async joinInstanceSync() {
    if (!this.swarm) throw new Error("PeerManager not started");

    this.instanceSyncTopic = createHash("sha256")
      .update(this.identity.crowId + "instance-sync")
      .digest();

    const discovery = this.swarm.join(this.instanceSyncTopic, { server: true, client: true });
    await discovery.flushed();

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

      case "feed-key-announce": {
        // Peer advertises the Hypercore feed key they use to write to us.
        // We persist it so future gateway starts can open the inbound feed
        // without waiting for a fresh Hyperswarm handshake.
        if (state.authenticated && state.remoteCrowId && this.onInstanceKeyReceived && msg.feed_key_hex) {
          this.onInstanceKeyReceived(state.remoteCrowId, msg.feed_key_hex);
        }
        break;
      }
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
