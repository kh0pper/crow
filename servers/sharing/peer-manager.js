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
    this.onPeerConnected = null; // callback(crowId, conn)
    this.onPeerData = null; // callback(crowId, data)
    this.onPeerDisconnected = null; // callback(crowId)
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
   * Handle incoming connection with challenge-response auth.
   */
  _handleConnection(conn, info) {
    let authenticated = false;
    let remoteCrowId = null;

    // Send challenge
    const challenge = randomBytes(32);
    conn.write(JSON.stringify({
      type: "challenge",
      challenge: challenge.toString("hex"),
      pubkey: this.identity.ed25519Pubkey,
      crowId: this.identity.crowId,
    }) + "\n");

    let buffer = "";
    conn.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this._handleMessage(conn, msg, challenge, { authenticated, remoteCrowId }, (state) => {
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
        // Respond with signed challenge + our own challenge response
        const response = sign(msg.challenge, this.identity.ed25519Priv);
        conn.write(JSON.stringify({
          type: "challenge-response",
          signature: response,
          pubkey: this.identity.ed25519Pubkey,
          crowId: this.identity.crowId,
        }) + "\n");
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

          if (this.onPeerConnected) {
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
          console.log(`[peer] Received data from ${state.remoteCrowId}:`, msg.payload?.type || "unknown");
          this.onPeerData(state.remoteCrowId, msg.payload);
        } else {
          console.warn(`[peer] Dropped data message: auth=${state.authenticated}, remote=${state.remoteCrowId}, handler=${!!this.onPeerData}`);
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
