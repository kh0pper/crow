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
      this._handleConnection(conn, info);
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
    if (isInstanceConn && this.localInstanceId) {
      challengePayload.instance_id = this.localInstanceId;
    }
    console.log(`[peer-manager] sending challenge isInstanceConn=${isInstanceConn} localInstanceId=${this.localInstanceId?.slice(0,12) || "null"}`);
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
        // Respond with signed challenge + our own challenge response. On
        // instance-sync connections we also ride our outgoing Hypercore feed
        // key on this message so the peer can open its inbound feed without
        // any additional round-trips. Peer is identified by their
        // instance_id (crow_id alone is ambiguous — all paired instances of
        // the same user share one Crow identity).
        (async () => {
          const response = sign(msg.challenge, this.identity.ed25519Priv);
          let feedKeyHex = null;
          if (state.isInstanceConn && msg.instance_id && this.getFeedKeyForInstance) {
            try { feedKeyHex = await this.getFeedKeyForInstance(msg.instance_id); } catch {}
          }
          const payload = {
            type: "challenge-response",
            signature: response,
            pubkey: this.identity.ed25519Pubkey,
            crowId: this.identity.crowId,
          };
          if (state.isInstanceConn && this.localInstanceId) {
            payload.instance_id = this.localInstanceId;
          }
          if (feedKeyHex) payload.feed_key_hex = feedKeyHex;
          console.log(`[peer-manager] challenge from ${msg.crowId} instance_id=${msg.instance_id || "none"} isInstanceConn=${state.isInstanceConn} → respond feed_key=${feedKeyHex ? feedKeyHex.slice(0,16) : "null"}`);
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

          console.log(`[peer-manager] challenge-response from ${msg.crowId} instance_id=${msg.instance_id || "none"} feed_key=${msg.feed_key_hex ? msg.feed_key_hex.slice(0,16) : "none"} isInstanceConn=${state.isInstanceConn}`);
          // Peer piggybacked their outgoing Hypercore feed key on the
          // challenge-response — persist it before dispatching so the
          // onInstanceConnected handler can open the inbound feed with
          // the received key on its first attempt. Must include the
          // peer's instance_id so we know which crow_instances row to
          // write to (crow_id is shared across all paired instances).
          if (state.isInstanceConn && msg.instance_id && msg.feed_key_hex && this.onInstanceKeyReceived) {
            Promise.resolve(this.onInstanceKeyReceived(msg.instance_id, msg.feed_key_hex)).catch(() => {});
          }

          // Dispatch to the appropriate handler based on connection origin
          if (state.isInstanceConn && this.onInstanceConnected) {
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
