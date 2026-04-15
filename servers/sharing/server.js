/**
 * Crow Sharing Server — Server Factory
 *
 * Creates a configured McpServer with P2P sharing tools.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 *
 * 17 MCP tools:
 *   crow_generate_invite    — Create invite code with 24h expiry
 *   crow_accept_invite      — Accept invite, handshake, show safety number
 *   crow_list_contacts      — List peers with online/offline status
 *   crow_share              — Share memory/project/source/note to a contact
 *   crow_inbox              — List received shares and messages
 *   crow_send_message       — Send encrypted Nostr message
 *   crow_revoke_access      — Revoke shared project access
 *   crow_sharing_status     — Show Crow ID, peer count, relay status
 *   crow_find_contacts      — Find Crow users by email hash (privacy-preserving)
 *   crow_set_discoverable   — Opt in/out of contact discovery
 *   crow_discover_relays    — List configured relays
 *   crow_add_relay          — Add a Nostr or peer relay
 *   crow_list_instances     — List registered Crow instances
 *   crow_register_instance  — Register a Crow instance
 *   crow_update_instance    — Update instance details
 *   crow_revoke_instance    — Revoke an instance (device compromise, decommission)
 *   crow_list_sync_conflicts — List and review sync conflicts between instances
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { createDbClient } from "../db.js";
import { generateToken, validateToken, shouldSkipGates } from "../shared/confirm.js";
import { isKioskActive, kioskBlockedResponse } from "../shared/kiosk-guard.js";
import {
  loadOrCreateIdentity,
  generateInviteCode,
  parseInviteCode,
  computeSafetyNumber,
} from "./identity.js";
import {
  canonicalPayload as canonicalAttestationPayload,
  signAttestation,
  verifyAttestation,
  verifyCrowIdBinding,
  signRevocation,
  verifyRevocation,
  SUPPORTED_APPS as ATTESTATION_APPS,
} from "../shared/identity-attestation.js";
import { transform as crosspostTransform, SUPPORTED_PAIRS as CROSSPOST_PAIRS } from "../gateway/crossposting/transforms.js";
import { PeerManager } from "./peer-manager.js";
import { SyncManager } from "./sync.js";
import { InstanceSyncManager } from "./instance-sync.js";
import { NostrManager } from "./nostr.js";
import { createNotification } from "../shared/notifications.js";
import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";

// Singleton sharing managers — Hyperswarm and Nostr connections are shared across
// all McpServer instances (stdio, gateway per-session, router dispatch).
let _sharedManagers = null;

// In-memory room state — active companion room tokens.
// Map<roomCode, { token, hostCrowId, hostName, companionUrl, createdAt, participants: Set<contactId> }>
const _activeRooms = new Map();

function getSharedManagers(dbPath) {
  if (_sharedManagers) return _sharedManagers;

  const db = createDbClient(dbPath);
  const identity = loadOrCreateIdentity();
  const peerManager = new PeerManager(identity);
  const syncManager = new SyncManager(identity);
  const nostrManager = new NostrManager(identity, db);

  // Instance sync manager for cross-instance replication
  const localInstanceId = getOrCreateLocalInstanceId();
  const instanceSyncManager = new InstanceSyncManager(identity, db, localInstanceId);

  _sharedManagers = { db, identity, peerManager, syncManager, instanceSyncManager, nostrManager, initialized: false };
  return _sharedManagers;
}

/**
 * Get the shared InstanceSyncManager instance (for use by other servers via gateway).
 * Returns null if managers haven't been initialized yet.
 */
export function getInstanceSyncManager() {
  return _sharedManagers?.instanceSyncManager || null;
}

/**
 * Validate a room token for companion access.
 * Returns the room info if valid, null if invalid/expired.
 */
export function validateRoomToken(roomCode, token) {
  const room = _activeRooms.get(roomCode);
  if (!room) return null;
  if (room.token !== token) return null;
  // Rooms expire after 24 hours
  if (Date.now() - room.createdAt > 24 * 60 * 60 * 1000) {
    _activeRooms.delete(roomCode);
    return null;
  }
  return { roomCode, hostCrowId: room.hostCrowId, hostName: room.hostName };
}

/**
 * Send a room invite to a contact by name. Used by the WM server
 * to proxy "invite <name>" commands from the companion.
 * Returns { ok, message, roomCode?, joinUrl? }
 */
export async function sendRoomInvite(contactName, hostName, opts = {}) {
  if (!_sharedManagers) return { ok: false, message: "Sharing server not initialized" };
  const { db, identity, nostrManager } = _sharedManagers;

  const result = await db.execute({
    sql: "SELECT * FROM contacts WHERE (crow_id = ? OR display_name = ?) AND is_blocked = 0",
    args: [contactName, contactName],
  });
  if (result.rows.length === 0) {
    return { ok: false, message: `Contact not found: ${contactName}` };
  }
  const contactRow = result.rows[0];

  // Use caller-provided room credentials if available (calls bundle flow),
  // otherwise generate new ones (companion/MCP tool flow)
  const roomCode = opts.roomCode || randomBytes(6).toString("hex");
  const token = opts.token || randomBytes(16).toString("hex");

  let joinUrl;
  if (opts.joinUrl) {
    joinUrl = opts.joinUrl;
  } else {
    const gatewayUrl = process.env.CROW_GATEWAY_URL || "";
    // Use /calls URL when calls bundle is enabled, /companion/ otherwise
    if (process.env.CROW_CALLS_ENABLED === "1" && gatewayUrl) {
      joinUrl = `${gatewayUrl}/calls?room=${roomCode}&token=${token}`;
    } else {
      const companionPort = process.env.COMPANION_PORT || "12393";
      joinUrl = gatewayUrl
        ? `${gatewayUrl}/companion/?room=${roomCode}&token=${token}`
        : `http://localhost:${companionPort}/?room=${roomCode}&token=${token}`;
    }
  }

  _activeRooms.set(roomCode, {
    token,
    hostCrowId: identity.crowId,
    hostName: hostName || identity.crowId,
    companionUrl: joinUrl,
    createdAt: Date.now(),
    participants: new Set([contactRow.id]),
  });

  const envelope = JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: "room_invite",
    payload: {
      room_code: roomCode,
      join_url: joinUrl,
      host_name: hostName || identity.crowId,
      host_crow_id: identity.crowId,
    },
  });

  try {
    const delivery = await nostrManager.sendMessage(contactRow, envelope);
    try {
      await createNotification(db, {
        title: `Room invite sent to ${contactRow.display_name || contactRow.crow_id}`,
        type: "system",
        source: "sharing:room_invite",
        action_url: joinUrl,
      });
    } catch {}
    return {
      ok: true,
      message: `Invite sent to ${contactRow.display_name || contactRow.crow_id} via ${delivery.relays.length} relay(s).`,
      roomCode,
      joinUrl,
    };
  } catch (err) {
    _activeRooms.delete(roomCode);
    return { ok: false, message: `Failed to send invite: ${err.message}` };
  }
}

/**
 * Get all active rooms (for status display).
 */
export function getActiveRooms() {
  const rooms = [];
  for (const [code, room] of _activeRooms) {
    // Clean up expired rooms
    if (Date.now() - room.createdAt > 24 * 60 * 60 * 1000) {
      _activeRooms.delete(code);
      continue;
    }
    rooms.push({ code, hostName: room.hostName, participants: room.participants.size, createdAt: room.createdAt });
  }
  return rooms;
}

/**
 * Send a text voice memo to a contact. The recipient's companion speaks it aloud via TTS.
 * Returns { ok, message }
 */
export async function sendVoiceMemo(contactName, text, senderName) {
  if (!_sharedManagers) return { ok: false, message: "Sharing server not initialized" };
  const { db, identity, nostrManager } = _sharedManagers;

  const result = await db.execute({
    sql: "SELECT * FROM contacts WHERE (crow_id = ? OR display_name = ?) AND is_blocked = 0",
    args: [contactName, contactName],
  });
  if (result.rows.length === 0) return { ok: false, message: `Contact not found: ${contactName}` };
  const contact = result.rows[0];

  const envelope = JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: "voice_memo",
    payload: {
      text,
      sender_name: senderName || identity.crowId,
      sender_crow_id: identity.crowId,
      timestamp: new Date().toISOString(),
    },
  });

  try {
    const delivery = await nostrManager.sendMessage(contact, envelope);
    return {
      ok: true,
      message: `Voice memo sent to ${contact.display_name || contact.crow_id} via ${delivery.relays.length} relay(s).`,
    };
  } catch (err) {
    return { ok: false, message: `Failed to send voice memo: ${err.message}` };
  }
}

/**
 * Send an emoji reaction to a contact.
 * Returns { ok, message }
 */
export async function sendReaction(contactName, emoji, senderName) {
  if (!_sharedManagers) return { ok: false, message: "Sharing server not initialized" };
  const { db, identity, nostrManager } = _sharedManagers;

  const result = await db.execute({
    sql: "SELECT * FROM contacts WHERE (crow_id = ? OR display_name = ?) AND is_blocked = 0",
    args: [contactName, contactName],
  });
  if (result.rows.length === 0) return { ok: false, message: `Contact not found: ${contactName}` };
  const contact = result.rows[0];

  const envelope = JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: "reaction",
    payload: {
      emoji,
      sender_name: senderName || identity.crowId,
      sender_crow_id: identity.crowId,
      timestamp: new Date().toISOString(),
    },
  });

  try {
    const delivery = await nostrManager.sendMessage(contact, envelope);
    return {
      ok: true,
      message: `Reaction ${emoji} sent to ${contact.display_name || contact.crow_id}.`,
    };
  } catch (err) {
    return { ok: false, message: `Failed to send reaction: ${err.message}` };
  }
}

// ─── Bot Relay: AI-to-AI Task Delegation ───

// Pending relays waiting for results (relay_id → { timeout, instanceName })
const _pendingRelays = new Map();

// Cached local instance name (resolved at first relay)
let _localInstanceName = null;

async function resolveLocalInstanceName(db) {
  if (_localInstanceName) return _localInstanceName;
  const localId = getOrCreateLocalInstanceId();
  const result = await db.execute({
    sql: "SELECT name FROM crow_instances WHERE id = ?",
    args: [localId],
  });
  _localInstanceName = result.rows.length > 0 ? result.rows[0].name : null;
  return _localInstanceName;
}

/**
 * Send a task to a remote Crow instance for execution.
 * Uses Nostr self-messaging with target_instance for routing.
 * Returns { ok, message, relayId? }
 */
export async function sendBotRelay(instanceName, task) {
  if (!_sharedManagers) return { ok: false, message: "Sharing server not initialized" };
  const { db, identity, nostrManager } = _sharedManagers;

  // Verify the target instance exists and is active
  const result = await db.execute({
    sql: "SELECT * FROM crow_instances WHERE name = ? AND status = 'active'",
    args: [instanceName],
  });
  if (result.rows.length === 0) return { ok: false, message: `Instance not found or inactive: ${instanceName}` };

  const localName = await resolveLocalInstanceName(db);
  const relayId = randomBytes(16).toString("hex");

  const envelope = JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: "bot_relay",
    payload: {
      relay_id: relayId,
      task,
      target_instance: instanceName,
      sender_name: localName || "unknown",
      sender_instance: localName || "unknown",
      sender_crow_id: identity.crowId,
      timestamp: new Date().toISOString(),
    },
  });

  try {
    const delivery = await nostrManager.sendSelfMessage(envelope);

    // Track pending relay with 5-min timeout
    const timeout = setTimeout(async () => {
      _pendingRelays.delete(relayId);
      try {
        await createNotification(db, {
          title: `No response from ${instanceName}`,
          body: `Relay task timed out: ${task.slice(0, 100)}`,
          type: "system",
          source: "sharing:bot_relay_timeout",
        });
      } catch {}
    }, 5 * 60 * 1000);
    _pendingRelays.set(relayId, { timeout, instanceName });

    return {
      ok: true,
      message: `Task relayed to ${instanceName} via ${delivery.relays.length} relay(s).`,
      relayId,
    };
  } catch (err) {
    return { ok: false, message: `Failed to relay task: ${err.message}` };
  }
}

/**
 * Handle an incoming bot_relay request: execute the task using local AI + tools.
 */
async function handleIncomingBotRelay(payload, db, identity, nostrManager) {
  const { relay_id, task, sender_instance, sender_name } = payload;
  console.log(`[sharing] Bot relay from ${sender_instance}: ${task}`);

  let resultText = "";
  let status = "success";

  try {
    const { runOneShot } = await import("../gateway/ai/one-shot.js");
    resultText = await runOneShot(
      "You are a helpful assistant. Execute the requested task using available tools. Reply with a brief result (1-2 sentences).",
      task
    );
  } catch (err) {
    if (err.code === "not_configured") {
      // No AI provider — create notification for manual handling
      try {
        await createNotification(db, {
          title: `Relay task from ${sender_name || sender_instance}`,
          body: task,
          type: "system",
          source: "sharing:bot_relay_manual",
          priority: "high",
        });
      } catch {}
      resultText = "No AI provider configured. Task forwarded as notification.";
      status = "error";
    } else {
      resultText = `Error: ${err.message}`;
      status = "error";
    }
  }

  // Truncate result
  if (resultText.length > 500) resultText = resultText.slice(0, 497) + "...";

  // Send result back
  const localName = await resolveLocalInstanceName(db);
  const envelope = JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: "bot_relay_result",
    payload: {
      relay_id,
      status,
      result: resultText,
      target_instance: sender_instance,
      responder_instance: localName || "unknown",
      timestamp: new Date().toISOString(),
    },
  });

  try {
    await nostrManager.sendSelfMessage(envelope);
    console.log(`[sharing] Bot relay result sent to ${sender_instance}`);
  } catch (err) {
    console.warn(`[sharing] Failed to send relay result: ${err.message}`);
  }
}

export function createSharingServer(dbPath, options = {}) {
  const managers = getSharedManagers(dbPath);
  const { db, identity, peerManager, syncManager, instanceSyncManager, nostrManager } = managers;

  // One-time initialization: start Hyperswarm, join contacts, wire callbacks
  if (!managers.initialized) {
    managers.initialized = true;

    // Start peer manager and join DHT topics for existing contacts
    peerManager.start().then(async () => {
      try {
        const contacts = await db.execute({
          sql: "SELECT id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey FROM contacts WHERE is_blocked = 0",
          args: [],
        });
        for (const c of contacts.rows) {
          try {
            await syncManager.initContact(c.id, null);
            await peerManager.joinContact({
              crowId: c.crow_id,
              ed25519Pubkey: c.ed25519_pubkey,
            });
            // Subscribe to Nostr messages from this contact
            await nostrManager.subscribeToContact({
              id: c.id,
              crow_id: c.crow_id,
              secp256k1_pubkey: c.secp256k1_pubkey,
              display_name: c.display_name,
            });
          } catch (err) {
            console.warn(`[sharing] Failed to join topic for ${c.crow_id}:`, err.message);
          }
        }
        if (contacts.rows.length > 0) {
          console.log(`[sharing] Joined DHT topics for ${contacts.rows.length} contact(s)`);
        }
      } catch (err) {
        console.warn("[sharing] Failed to load contacts on startup:", err.message);
      }

      // Subscribe to all incoming DMs (invites, social messages)
      // Done here so relay connections from subscribeToContact are reused
      try {
        await nostrManager.subscribeToIncoming(async (payload) => {
          if (!payload.crowId || !payload.ed25519Pub || !payload.secp256k1Pub) return;

          const existing = await db.execute({
            sql: "SELECT id FROM contacts WHERE crow_id = ?",
            args: [payload.crowId],
          });
          if (existing.rows.length > 0) return;

          const result = await db.execute({
            sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey)
                  VALUES (?, ?, ?, ?)`,
            args: [payload.crowId, payload.displayName || payload.crowId, payload.ed25519Pub, payload.secp256k1Pub],
          });

          const contactId = Number(result.lastInsertRowid);
          await syncManager.initContact(contactId, null);
          await peerManager.joinContact({ crowId: payload.crowId, ed25519Pubkey: payload.ed25519Pub });
          await nostrManager.subscribeToContact({
            id: contactId, crowId: payload.crowId, secp256k1_pubkey: payload.secp256k1Pub,
          });
          console.log(`[sharing] Auto-added contact from invite acceptance: ${payload.displayName || payload.crowId}`);
        }, async (subtype, payload, senderPubkey) => {
          console.log(`[sharing] Received crow_social message: ${subtype}`);
          if (subtype === "room_invite") {
            const { room_code, join_url, host_name, host_crow_id } = payload;
            if (!room_code || !join_url) return;
            try {
              await createNotification(db, {
                title: `${host_name || "Someone"} is calling`,
                body: `Tap to join the call`,
                type: "peer",
                source: "sharing:room_invite",
                priority: "high",
                action_url: join_url,
              });
            } catch (err) {
              console.warn("[sharing] Failed to create room invite notification:", err.message);
            }
          } else if (subtype === "room_closed") {
            const { host_name } = payload;
            try {
              await createNotification(db, {
                title: `${host_name || "Host"} closed the room`,
                type: "peer",
                source: "sharing:room_closed",
              });
            } catch {}
          } else if (subtype === "voice_memo") {
            const { text, sender_name } = payload;
            if (!text) return;
            try {
              await createNotification(db, {
                title: `Voice memo from ${sender_name || "Someone"}`,
                body: text.length > 200 ? text.slice(0, 200) + "..." : text,
                type: "peer",
                source: "sharing:voice_memo",
                priority: "high",
              });
            } catch (err) {
              console.warn("[sharing] Failed to create voice memo notification:", err.message);
            }
          } else if (subtype === "reaction") {
            const { emoji, sender_name } = payload;
            if (!emoji) return;
            try {
              await createNotification(db, {
                title: `${sender_name || "Someone"} reacted ${emoji}`,
                type: "peer",
                source: "sharing:reaction",
              });
            } catch {}
          } else if (subtype === "group_message") {
            const { group_name, sender_name, message: msgText } = payload;
            if (!msgText) return;
            try {
              await createNotification(db, {
                title: `[${group_name || "Group"}] ${sender_name || "Someone"}`,
                body: msgText.length > 200 ? msgText.slice(0, 200) + "..." : msgText,
                type: "peer",
                source: "sharing:group_message",
                priority: "high",
              });
            } catch (err) {
              console.warn("[sharing] Failed to create group message notification:", err.message);
            }
            // Also store as a regular message with group context
            try {
              // Find the sender contact
              const senderContact = await db.execute({
                sql: "SELECT id FROM contacts WHERE crow_id = ?",
                args: [payload.sender_crow_id || ""],
              });
              if (senderContact.rows.length > 0) {
                await db.execute({
                  sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
                        VALUES (?, ?, ?, 'received', 0, datetime('now'))`,
                  args: [senderContact.rows[0].id, `grp_${Date.now()}`, `[${group_name}] ${msgText}`],
                });
              }
            } catch {}
          } else if (subtype === "bot_relay") {
            const localName = await resolveLocalInstanceName(db);
            if (payload.target_instance !== localName) return; // Not for us
            // Validate sender is a known instance
            const senderCheck = await db.execute({
              sql: "SELECT id FROM crow_instances WHERE name = ? AND status = 'active'",
              args: [payload.sender_instance],
            });
            if (senderCheck.rows.length === 0) {
              console.warn(`[sharing] Bot relay from unknown instance: ${payload.sender_instance}`);
              return;
            }
            handleIncomingBotRelay(payload, db, identity, nostrManager);
          } else if (subtype === "bot_relay_result") {
            const localName = await resolveLocalInstanceName(db);
            if (payload.target_instance !== localName) return; // Not for us
            const pending = _pendingRelays.get(payload.relay_id);
            if (pending) {
              clearTimeout(pending.timeout);
              _pendingRelays.delete(payload.relay_id);
            }
            try {
              await createNotification(db, {
                title: `${payload.responder_instance}: ${payload.status === "success" ? "Done" : "Error"}`,
                body: payload.result || "No details",
                type: "system",
                source: "sharing:bot_relay_result",
                priority: "high",
              });
            } catch (err) {
              console.warn("[sharing] Failed to create relay result notification:", err.message);
            }
          }
        });
        console.log("[sharing] Subscribed to incoming Nostr messages");
      } catch (err) {
        console.warn("[sharing] Failed to subscribe to incoming messages:", err.message);
      }

      // Join instance sync topic for cross-instance discovery
      try {
        await peerManager.joinInstanceSync();

        // Initialize feeds for known instances. Include 'offline' peers so a
        // late-arriving Hyperswarm connection can replicate into a feed that's
        // already open, rather than racing a first-open against the connection.
        // Revoked/paused peers are deliberately excluded.
        const { rows: instances } = await db.execute({
          sql: "SELECT id, sync_url FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
          args: [instanceSyncManager.localInstanceId],
        });
        for (const inst of instances) {
          try {
            // Feed key from sync_url (hex-encoded) or null for first contact
            const feedKey = inst.sync_url ? Buffer.from(inst.sync_url, "hex") : null;
            await instanceSyncManager.initInstance(inst.id, feedKey);
          } catch (err) {
            console.warn(`[sharing] Failed to init sync feed for instance ${inst.id}:`, err.message);
          }
        }
        if (instances.length > 0) {
          console.log(`[sharing] Initialized sync feeds for ${instances.length} instance(s)`);
        }
      } catch (err) {
        console.warn("[sharing] Instance sync setup:", err.message);
      }
    }).catch((err) => {
      console.warn("[sharing] PeerManager start failed:", err.message);
    });

  // Wire instance-to-instance connections for Hypercore replication
  peerManager.onInstanceConnected = async (crowId, conn) => {
    console.log(`[sharing] Instance peer connected: ${crowId}`);

    // Find which instance this connection belongs to. Accept status='active'
    // or 'offline' — a live Hyperswarm connection IS the signal the peer is
    // up, so treating an offline-but-connected peer as unreachable would
    // create a chicken-and-egg where sync never initializes and status never
    // flips to active. Revoked/paused peers stay excluded.
    try {
      const { rows } = await db.execute({
        sql: "SELECT id FROM crow_instances WHERE crow_id = ? AND status IN ('active','offline') AND id != ?",
        args: [crowId, instanceSyncManager.localInstanceId],
      });

      for (const inst of rows) {
        // Initialize feed (idempotent — opens outgoing feed, and incoming feed
        // too if we already know the peer's feed key from the challenge-response
        // handshake or from a prior exchange persisted to crow_instances.sync_url).
        const existingKey = inst.sync_url ? Buffer.from(inst.sync_url, "hex") : null;
        await instanceSyncManager.initInstance(inst.id, existingKey);

        // Replicate over this connection. Our outgoing feed key was already
        // piggybacked on the challenge-response JSON message (see peer-manager.js
        // case "challenge" + getFeedKeyForCrow wiring below).
        await instanceSyncManager.replicate(inst.id, conn);
      }

      // Update last_seen on all matching instances
      await db.execute({
        sql: "UPDATE crow_instances SET last_seen_at = datetime('now'), status = 'active' WHERE crow_id = ? AND id != ?",
        args: [crowId, instanceSyncManager.localInstanceId],
      });
    } catch (err) {
      console.warn(`[sharing] Instance connection handling failed for ${crowId}:`, err.message);
    }
  };

  // peer-manager asks us for OUR outgoing feed key to a given peer crow_id
  // so it can piggyback the key on the challenge-response JSON message.
  // Called once per incoming challenge. We return null if we don't have a
  // crow_instances row for this crow_id yet — in that case the peer will
  // learn our key on the next handshake after we pair.
  peerManager.getFeedKeyForCrow = async (remoteCrowId) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT id FROM crow_instances WHERE crow_id = ? AND status IN ('active','offline') AND id != ? LIMIT 1",
        args: [remoteCrowId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return null;
      // Ensure the outbound feed exists so getOutFeedKey can return something.
      await instanceSyncManager.initInstance(rows[0].id, null);
      const key = instanceSyncManager.getOutFeedKey(rows[0].id);
      return key ? key.toString("hex") : null;
    } catch (err) {
      console.warn(`[sharing] getFeedKeyForCrow for ${remoteCrowId}:`, err.message);
      return null;
    }
  };

  // Persist a peer-advertised feed key so we can open their incoming feed.
  // Called when the peer piggybacks feed_key_hex on the challenge-response
  // JSON message (see peer-manager.js).
  peerManager.onInstanceKeyReceived = async (remoteCrowId, feedKeyHex) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT id, sync_url FROM crow_instances WHERE crow_id = ? AND status IN ('active','offline') AND id != ?",
        args: [remoteCrowId, instanceSyncManager.localInstanceId],
      });
      for (const inst of rows) {
        if (inst.sync_url === feedKeyHex) continue; // unchanged — skip
        await db.execute({
          sql: "UPDATE crow_instances SET sync_url = ?, updated_at = datetime('now') WHERE id = ?",
          args: [feedKeyHex, inst.id],
        });
        console.log(`[sharing] Stored feed key from ${remoteCrowId} for instance ${inst.id.slice(0, 12)}…`);
        // Open the incoming feed now that we have the key. initInstance is
        // idempotent — re-calling with a non-null feedKey adds the inFeed
        // without disturbing the already-open outFeed.
        try {
          await instanceSyncManager.initInstance(inst.id, Buffer.from(feedKeyHex, "hex"));
        } catch (err) {
          console.warn(`[sharing] Failed to open inbound feed after key exchange: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[sharing] onInstanceKeyReceived for ${remoteCrowId}:`, err.message);
    }
  };

  // Wire peer connections — update last_seen and deliver pending shares
  peerManager.onPeerConnected = async (crowId, conn) => {
    const contact = await db.execute({
      sql: "SELECT * FROM contacts WHERE crow_id = ? AND is_blocked = 0",
      args: [crowId],
    });
    if (contact.rows.length === 0) return;

    const c = contact.rows[0];
    console.log(`[sharing] Peer connected: ${crowId}`);

    // Update last_seen
    await db.execute({
      sql: "UPDATE contacts SET last_seen = datetime('now') WHERE id = ?",
      args: [c.id],
    });

    // Deliver any pending shares
    const pending = await db.execute({
      sql: `SELECT si.*, '${c.crow_id}' as crow_id FROM shared_items si
            WHERE si.contact_id = ? AND si.direction = 'sent' AND si.delivery_status = 'pending'`,
      args: [c.id],
    });

    for (const share of pending.rows) {
      try {
        const tableMap = {
          memory: "memories",
          project: "research_projects",
          source: "research_sources",
          note: "research_notes",
          kb_article: "kb_articles",
        };
        const table = tableMap[share.share_type];
        if (!table) continue;

        const itemData = await db.execute({
          sql: `SELECT * FROM ${table} WHERE id = ?`,
          args: [share.item_id],
        });
        if (itemData.rows.length === 0) continue;

        peerManager.send(crowId, {
          type: "share",
          share_type: share.share_type,
          payload: itemData.rows[0],
          permissions: share.permissions,
          sender: identity.crowId,
          timestamp: new Date().toISOString(),
        });

        await db.execute({
          sql: "UPDATE shared_items SET delivery_status = 'delivered' WHERE id = ?",
          args: [share.id],
        });
      } catch (err) {
        // Delivery failed — will retry next connection
      }
    }

    if (pending.rows.length > 0) {
      console.log(`[sharing] Delivered ${pending.rows.length} pending share(s) to ${crowId}`);
    }
  };

  // Handle data from connected peers (shares, revokes, etc.)
  peerManager.onPeerData = async (crowId, payload) => {
    if (!payload?.type) return;

    const contact = await db.execute({
      sql: "SELECT * FROM contacts WHERE crow_id = ? AND is_blocked = 0",
      args: [crowId],
    });
    if (contact.rows.length === 0) return;
    const c = contact.rows[0];

    if (payload.type === "share" && payload.share_type && payload.payload) {
      // Incoming share — import the data and record it
      try {
        let importedItemId = 0;

        if (payload.share_type === "memory") {
          const result = await db.execute({
            sql: `INSERT INTO memories (content, category, importance, context, source, tags)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [
              payload.payload.content || "",
              payload.payload.category || "general",
              payload.payload.importance || 5,
              payload.payload.context || "",
              payload.payload.source || "",
              payload.payload.tags || "",
            ],
          });
          importedItemId = Number(result.lastInsertRowid);
        } else if (payload.share_type === "source") {
          const result = await db.execute({
            sql: `INSERT INTO research_sources (project_id, title, url, source_type, citation, notes)
                  VALUES (NULL, ?, ?, ?, ?, ?)`,
            args: [
              payload.payload.title || "Shared source",
              payload.payload.url || "",
              payload.payload.source_type || "other",
              payload.payload.citation || "",
              payload.payload.notes || "",
            ],
          });
          importedItemId = Number(result.lastInsertRowid);
        } else if (payload.share_type === "note") {
          const result = await db.execute({
            sql: `INSERT INTO research_notes (project_id, content)
                  VALUES (NULL, ?)`,
            args: [payload.payload.content || ""],
          });
          importedItemId = Number(result.lastInsertRowid);
        } else if (payload.share_type === "kb_article") {
          try {
            const p = payload.payload;
            const { randomUUID } = await import("node:crypto");
            // Find or create a collection for received articles
            let colId = null;
            const existing = await db.execute({ sql: "SELECT id FROM kb_collections LIMIT 1", args: [] });
            if (existing.rows.length > 0) {
              colId = existing.rows[0].id;
            } else {
              // Create a default collection for shared articles
              const newCol = await db.execute({
                sql: `INSERT INTO kb_collections (slug, name, description, visibility) VALUES ('shared', 'Shared Articles', 'Articles received from contacts', 'private')`,
                args: [],
              });
              colId = Number(newCol.lastInsertRowid);
            }
            const result = await db.execute({
              sql: `INSERT INTO kb_articles (collection_id, pair_id, language, slug, title, content, excerpt, author, tags, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
              args: [
                colId,
                p.pair_id || randomUUID(),
                p.language || "en",
                p.slug || p.title?.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 200) || "shared-article",
                p.title || "Shared article",
                p.content || "",
                p.excerpt || null,
                p.author || null,
                p.tags || null,
              ],
            });
            importedItemId = Number(result.lastInsertRowid);
          } catch (kbErr) {
            // kb_articles table may not exist if knowledge-base bundle is not installed
            console.warn(`[sharing] Cannot import kb_article — knowledge-base bundle may not be installed: ${kbErr.message}`);
          }
        }

        await db.execute({
          sql: `INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status)
                VALUES (?, ?, ?, ?, 'received', 'delivered')`,
          args: [c.id, payload.share_type, importedItemId, payload.permissions || "read"],
        });

        console.log(`[sharing] Received ${payload.share_type} from ${crowId} → imported as #${importedItemId}`);

        try {
          await createNotification(db, {
            title: `Received ${payload.share_type} from ${c.display_name || crowId}`,
            type: "peer",
            source: "sharing:share",
            action_url: "/dashboard/messages",
          });
        } catch {}
      } catch (err) {
        console.warn(`[sharing] Failed to import share from ${crowId}:`, err.message);
      }
    } else if (payload.type === "revoke" && payload.share_type) {
      // Handle revocation
      console.log(`[sharing] Received revoke for ${payload.share_type} from ${crowId}`);
    }
  };

  // Hypercore feed entries (legacy — shares now go via onPeerData)
  syncManager.onEntry = async (contactId, entry) => {
    console.log(`[sharing] Received Hypercore entry for contact ${contactId}:`, entry.type);
  };

  // subscribeToIncoming is now set up inside peerManager.start().then()
  // so relay connections from subscribeToContact are reused

  } // end one-time initialization

  const server = new McpServer(
    { name: "crow-sharing", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // --- Tool: crow_generate_invite ---

  server.tool(
    "crow_generate_invite",
    "Generate a single-use invite code to share with someone. The code expires in 24 hours and can only be used once. Share it via any channel (email, message, in person).",
    {
      display_name: z.string().max(100).optional().describe("Optional display name for this contact"),
    },
    async ({ display_name }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_generate_invite");
      const code = generateInviteCode(identity);
      return {
        content: [
          {
            type: "text",
            text: [
              `Invite code generated (expires in 24 hours):`,
              ``,
              `\`${code}\``,
              ``,
              `Share this code with the person you want to connect with.`,
              `They should use \`crow_accept_invite\` with this code.`,
              `Your Crow ID: ${identity.crowId}`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  // --- Tool: crow_accept_invite ---

  server.tool(
    "crow_accept_invite",
    "Accept an invite code from another Crow user. This establishes a peer connection and enables sharing. Shows a safety number for out-of-band verification.",
    {
      invite_code: z.string().max(1000).describe("The invite code received from another user"),
      display_name: z.string().max(100).optional().describe("Name for this contact"),
    },
    async ({ invite_code, display_name }) => {
      try {
        const peer = parseInviteCode(invite_code);

        // Check if already a contact
        const existing = await db.execute({
          sql: "SELECT id FROM contacts WHERE crow_id = ?",
          args: [peer.crowId],
        });

        if (existing.rows.length > 0) {
          return {
            content: [{ type: "text", text: `Already connected to ${peer.crowId}` }],
          };
        }

        // Add to contacts
        const result = await db.execute({
          sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey)
                VALUES (?, ?, ?, ?)`,
          args: [
            peer.crowId,
            display_name || peer.crowId,
            peer.ed25519Pubkey,
            peer.secp256k1Pubkey,
          ],
        });

        const contactId = Number(result.lastInsertRowid);

        // Initialize sync feeds
        await syncManager.initContact(contactId, null);

        // Join Hyperswarm topic for this contact
        await peerManager.joinContact({
          crowId: peer.crowId,
          ed25519Pubkey: peer.ed25519Pubkey,
        });

        // Subscribe to Nostr messages
        await nostrManager.subscribeToContact({
          id: contactId,
          crowId: peer.crowId,
          secp256k1_pubkey: peer.secp256k1Pubkey,
        });

        // Compute safety number
        const safetyNumber = computeSafetyNumber(
          identity.ed25519Pubkey,
          peer.ed25519Pubkey
        );

        // Send acceptance back to inviter so they auto-add us
        try {
          if (nostrManager.relays.size === 0) {
            await nostrManager.connectRelays();
          }
          const acceptancePayload = JSON.stringify({
            type: "invite_accepted",
            crowId: identity.crowId,
            ed25519Pub: identity.ed25519Pubkey,
            secp256k1Pub: identity.secp256k1Pubkey,
          });
          await nostrManager.sendMessage(
            { secp256k1_pubkey: peer.secp256k1Pubkey },
            acceptancePayload
          );
        } catch {
          // Non-fatal — inviter can still add us manually
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `Connected to ${display_name || peer.crowId}!`,
                ``,
                `Crow ID: ${peer.crowId}`,
                `Safety Number: ${safetyNumber}`,
                ``,
                `Verify this safety number with your contact through a separate channel`,
                `(in person, phone call, etc.) to confirm the connection is secure.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to accept invite: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: crow_list_contacts ---

  server.tool(
    "crow_list_contacts",
    "List all connected peers with their online/offline status, last seen time, and sharing activity.",
    {
      include_blocked: z.boolean().default(false).describe("Include blocked contacts"),
    },
    async ({ include_blocked }) => {
      let sql = "SELECT * FROM contacts";
      const args = [];

      if (!include_blocked) {
        sql += " WHERE is_blocked = 0";
      }
      sql += " ORDER BY last_seen DESC NULLS LAST";

      const result = await db.execute({ sql, args });

      if (result.rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No contacts yet. Use `crow_generate_invite` to create an invite code.",
            },
          ],
        };
      }

      const contacts = result.rows.map((c) => {
        const online = peerManager.isConnected(c.crow_id);
        const status = c.is_blocked ? "blocked" : online ? "online" : "offline";
        return [
          `${c.display_name || c.crow_id} (${c.crow_id})`,
          `  Status: ${status}`,
          `  Last seen: ${c.last_seen || "never"}`,
          `  Added: ${c.created_at}`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: `Contacts (${result.rows.length}):\n\n${contacts.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // --- Tool: crow_share ---

  server.tool(
    "crow_share",
    "Share a memory, research project, source, or note with a connected contact. The data is encrypted end-to-end. Returns a preview and confirmation token on first call; pass the token back to execute.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      share_type: z.enum(["memory", "project", "source", "note", "kb_article"]).describe("Type of item to share"),
      item_id: z.number().describe("ID of the item to share"),
      permissions: z.enum(["read", "read-write", "one-time"]).default("read").describe("Permission level"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ contact, share_type, item_id, permissions, confirm_token }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_share");
      // Find contact
      const result = await db.execute({
        sql: "SELECT * FROM contacts WHERE (crow_id = ? OR display_name = ?) AND is_blocked = 0",
        args: [contact, contact],
      });

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Contact not found: ${contact}` }],
          isError: true,
        };
      }

      const contactRow = result.rows[0];

      // Verify the item exists
      const tableMap = {
        memory: "memories",
        project: "research_projects",
        source: "research_sources",
        note: "research_notes",
      };
      const table = tableMap[share_type];
      const item = await db.execute({
        sql: `SELECT * FROM ${table} WHERE id = ?`,
        args: [item_id],
      });

      if (item.rows.length === 0) {
        return {
          content: [{ type: "text", text: `${share_type} #${item_id} not found` }],
          isError: true,
        };
      }

      // Confirmation gate
      const tokenKey = `share_${share_type}_${item_id}_${contactRow.id}`;
      if (!shouldSkipGates()) {
        if (confirm_token) {
          if (!validateToken(confirm_token, "share", tokenKey)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token. Pass confirm_token: \"\" to get a new preview." }], isError: true };
          }
        } else {
          const itemRow = item.rows[0];
          const itemDesc = itemRow.title || itemRow.name || itemRow.content?.substring(0, 100) || `#${item_id}`;
          const token = generateToken("share", tokenKey);
          return {
            content: [{
              type: "text",
              text: `⚠️ This will share:\n  ${share_type} #${item_id}: "${itemDesc}"\n  With: ${contactRow.display_name || contactRow.crow_id}\n  Permissions: ${permissions}\n\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      // Record the share
      await db.execute({
        sql: `INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status)
              VALUES (?, ?, ?, ?, 'sent', ?)`,
        args: [
          contactRow.id,
          share_type,
          item_id,
          permissions,
          peerManager.isConnected(contactRow.crow_id) ? "delivered" : "pending",
        ],
      });

      // If peer is online, send directly via Hyperswarm data channel
      if (peerManager.isConnected(contactRow.crow_id)) {
        try {
          peerManager.send(contactRow.crow_id, {
            type: "share",
            share_type,
            payload: item.rows[0],
            permissions,
            sender: identity.crowId,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          // Send failed — still recorded in shared_items as pending
          await db.execute({
            sql: "UPDATE shared_items SET delivery_status = 'pending' WHERE contact_id = ? AND item_id = ? AND share_type = ? AND direction = 'sent' ORDER BY created_at DESC LIMIT 1",
            args: [contactRow.id, item_id, share_type],
          });
        }
      }

      const status = peerManager.isConnected(contactRow.crow_id)
        ? "delivered"
        : "queued (will deliver when peer comes online)";

      return {
        content: [
          {
            type: "text",
            text: `Shared ${share_type} #${item_id} with ${contactRow.display_name || contactRow.crow_id} (${permissions}). Status: ${status}`,
          },
        ],
      };
    }
  );

  // --- Tool: crow_inbox ---

  server.tool(
    "crow_inbox",
    "Check your inbox for received shares and messages from contacts.",
    {
      unread_only: z.boolean().default(false).describe("Show only unread items"),
      limit: z.number().max(100).default(20).describe("Maximum items to return"),
    },
    async ({ unread_only, limit }) => {
      // Get received shares
      const sharesSql = `
        SELECT si.*, c.crow_id, c.display_name
        FROM shared_items si
        JOIN contacts c ON c.id = si.contact_id
        WHERE si.direction = 'received'
        ORDER BY si.created_at DESC
        LIMIT ?
      `;
      const shares = await db.execute({ sql: sharesSql, args: [limit] });

      // Get unread messages
      let msgSql = `
        SELECT m.*, c.crow_id, c.display_name
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.direction = 'received'
      `;
      const msgArgs = [];

      if (unread_only) {
        msgSql += " AND m.is_read = 0";
      }
      msgSql += " ORDER BY m.created_at DESC LIMIT ?";
      msgArgs.push(limit);

      const messages = await db.execute({ sql: msgSql, args: msgArgs });

      const parts = [];

      if (shares.rows.length > 0) {
        parts.push("Received shares:");
        for (const s of shares.rows) {
          parts.push(`  [${s.share_type}] from ${s.display_name || s.crow_id} — ${s.permissions} (${s.created_at})`);
        }
      }

      if (messages.rows.length > 0) {
        parts.push("");
        parts.push("Messages:");
        for (const m of messages.rows) {
          const readIcon = m.is_read ? "" : "[NEW] ";
          parts.push(`  ${readIcon}${m.display_name || m.crow_id}: --- stored content ---\n${m.content}\n--- end stored content --- (${m.created_at})`);
        }
      }

      if (parts.length === 0) {
        parts.push("Inbox is empty. No shares or messages received.");
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
      };
    }
  );

  // --- Tool: crow_send_message ---

  server.tool(
    "crow_send_message",
    "Send an encrypted message via the Nostr network. Messages cannot be retracted once sent.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      message: z.string().max(10000).describe("Message text to send"),
    },
    async ({ contact, message }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_send_message");
      // Find contact
      const result = await db.execute({
        sql: "SELECT * FROM contacts WHERE (crow_id = ? OR display_name = ?) AND is_blocked = 0",
        args: [contact, contact],
      });

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Contact not found: ${contact}` }],
          isError: true,
        };
      }

      const contactRow = result.rows[0];

      try {
        const delivery = await nostrManager.sendMessage(contactRow, message);
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${contactRow.display_name || contactRow.crow_id} via ${delivery.relays.length} relay(s).`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to send message: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: crow_create_message_group ---

  server.tool(
    "crow_create_message_group",
    "Create a message group for group conversations. Add contacts by name or Crow ID.",
    {
      name: z.string().max(200).describe("Group name"),
      members: z.array(z.string().max(500)).describe("Array of contact names or Crow IDs to add"),
      color: z.string().max(20).optional().describe("Group color (hex, e.g. #6366f1)"),
    },
    async ({ name, members, color }) => {
      // Create the group
      const groupResult = await db.execute({
        sql: "INSERT INTO contact_groups (name, color) VALUES (?, ?)",
        args: [name, color || "#6366f1"],
      });
      const groupId = Number(groupResult.lastInsertRowid);

      // Resolve and add members
      const added = [];
      const notFound = [];
      for (const member of members) {
        const contact = await db.execute({
          sql: "SELECT id, display_name, crow_id FROM contacts WHERE (crow_id = ? OR display_name = ?) AND is_blocked = 0",
          args: [member, member],
        });
        if (contact.rows.length > 0) {
          const row = contact.rows[0];
          try {
            await db.execute({
              sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, ?)",
              args: [groupId, row.id],
            });
            added.push(row.display_name || row.crow_id);
          } catch { /* duplicate, ignore */ }
        } else {
          notFound.push(member);
        }
      }

      let text = `Created group "${name}" (ID: ${groupId}) with ${added.length} member(s): ${added.join(", ")}`;
      if (notFound.length > 0) text += `\nNot found: ${notFound.join(", ")}`;
      return { content: [{ type: "text", text }] };
    }
  );

  // --- Tool: crow_list_message_groups ---

  server.tool(
    "crow_list_message_groups",
    "List all message groups with their members.",
    {},
    async () => {
      const groups = await db.execute("SELECT * FROM contact_groups ORDER BY sort_order, name");
      if (groups.rows.length === 0) {
        return { content: [{ type: "text", text: "No message groups. Create one with crow_create_message_group." }] };
      }

      const lines = [];
      for (const grp of groups.rows) {
        const members = await db.execute({
          sql: `SELECT c.display_name, c.crow_id FROM contacts c
                JOIN contact_group_members gm ON gm.contact_id = c.id
                WHERE gm.group_id = ?`,
          args: [grp.id],
        });
        const memberNames = members.rows.map(m => m.display_name || m.crow_id).join(", ");
        lines.push(`[${grp.id}] ${grp.name} (${members.rows.length} members): ${memberNames || "empty"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // --- Tool: crow_send_group_message ---

  server.tool(
    "crow_send_group_message",
    "Send a message to all members of a contact group. Messages are sent as individual encrypted DMs with group context.",
    {
      group: z.string().max(200).describe("Group name or ID"),
      message: z.string().max(10000).describe("Message text to send"),
    },
    async ({ group, message }) => {
      // Find the group
      const groupResult = await db.execute({
        sql: "SELECT * FROM contact_groups WHERE name = ? OR id = ?",
        args: [group, isNaN(Number(group)) ? -1 : Number(group)],
      });
      if (groupResult.rows.length === 0) {
        return { content: [{ type: "text", text: `Group not found: ${group}` }], isError: true };
      }
      const grp = groupResult.rows[0];

      // Get group members with contact info
      const membersResult = await db.execute({
        sql: `SELECT c.* FROM contacts c
              JOIN contact_group_members gm ON gm.contact_id = c.id
              WHERE gm.group_id = ? AND c.is_blocked = 0`,
        args: [grp.id],
      });

      if (membersResult.rows.length === 0) {
        return { content: [{ type: "text", text: `Group "${grp.name}" has no members` }], isError: true };
      }

      // Build group message envelope
      const envelope = JSON.stringify({
        type: "crow_social",
        version: 1,
        subtype: "group_message",
        payload: {
          group_name: grp.name,
          group_id: grp.id,
          sender_name: identity.displayName || identity.crowId,
          sender_crow_id: identity.crowId,
          message,
          timestamp: new Date().toISOString(),
        },
      });

      // Fan-out: send to each member individually
      const sent = [];
      const failed = [];
      for (const contact of membersResult.rows) {
        try {
          await nostrManager.sendMessage(contact, envelope);
          sent.push(contact.display_name || contact.crow_id);
        } catch (err) {
          failed.push(contact.display_name || contact.crow_id);
        }
      }

      let text = `Sent to ${sent.length}/${membersResult.rows.length} members of "${grp.name}"`;
      if (failed.length > 0) text += `\nFailed: ${failed.join(", ")}`;
      return { content: [{ type: "text", text }] };
    }
  );

  // --- Tool: crow_revoke_access ---

  server.tool(
    "crow_revoke_access",
    "Revoke a previously shared item or project from a contact. Stops ongoing sync for shared projects. Returns a preview and confirmation token on first call; pass the token back to execute.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      share_type: z.enum(["memory", "project", "source", "note", "kb_article"]).describe("Type of shared item"),
      item_id: z.number().describe("ID of the shared item to revoke"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ contact, share_type, item_id, confirm_token }) => {
      const result = await db.execute({
        sql: "SELECT * FROM contacts WHERE crow_id = ? OR display_name = ?",
        args: [contact, contact],
      });

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Contact not found: ${contact}` }],
          isError: true,
        };
      }

      const contactRow = result.rows[0];

      // Check if a matching share exists
      const shareCheck = await db.execute({
        sql: `SELECT id FROM shared_items
              WHERE contact_id = ? AND share_type = ? AND item_id = ? AND direction = 'sent'`,
        args: [contactRow.id, share_type, item_id],
      });

      if (shareCheck.rows.length === 0) {
        return {
          content: [{ type: "text", text: `No matching share found to revoke.` }],
        };
      }

      // Confirmation gate
      const tokenKey = `revoke_${share_type}_${item_id}_${contactRow.id}`;
      if (!shouldSkipGates()) {
        if (confirm_token) {
          if (!validateToken(confirm_token, "revoke_access", tokenKey)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token. Pass confirm_token: \"\" to get a new preview." }], isError: true };
          }
        } else {
          const token = generateToken("revoke_access", tokenKey);
          return {
            content: [{
              type: "text",
              text: `⚠️ This will revoke access:\n  ${share_type} #${item_id}\n  From: ${contactRow.display_name || contactRow.crow_id}\n\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      await db.execute({
        sql: `DELETE FROM shared_items
              WHERE contact_id = ? AND share_type = ? AND item_id = ? AND direction = 'sent'`,
        args: [contactRow.id, share_type, item_id],
      });

      // Send revocation notice via data channel
      if (peerManager.isConnected(contactRow.crow_id)) {
        try {
          peerManager.send(contactRow.crow_id, {
            type: "revoke",
            share_type,
            item_id,
            sender: identity.crowId,
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Best effort
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Revoked ${share_type} #${item_id} from ${contactRow.display_name || contactRow.crow_id}.`,
          },
        ],
      };
    }
  );

  // --- Tool: crow_sharing_status ---

  server.tool(
    "crow_sharing_status",
    "Show your Crow identity, connected peers, relay status, and sharing statistics.",
    {},
    async () => {
      const contactCount = await db.execute({
        sql: "SELECT COUNT(*) as count FROM contacts WHERE is_blocked = 0",
        args: [],
      });

      const shareCount = await db.execute({
        sql: "SELECT direction, COUNT(*) as count FROM shared_items GROUP BY direction",
        args: [],
      });

      const unreadMsgs = await db.execute({
        sql: "SELECT COUNT(*) as count FROM messages WHERE is_read = 0 AND direction = 'received'",
        args: [],
      });

      const relays = await db.execute({
        sql: "SELECT * FROM relay_config WHERE enabled = 1",
        args: [],
      });

      const connectedPeers = peerManager.getConnectedPeers();

      const sent = shareCount.rows.find((r) => r.direction === "sent")?.count || 0;
      const received = shareCount.rows.find((r) => r.direction === "received")?.count || 0;

      const parts = [
        `Crow Sharing Status`,
        ``,
        `Identity:`,
        `  Crow ID: ${identity.crowId}`,
        `  Ed25519: ${identity.ed25519Pubkey.slice(0, 16)}...`,
        `  secp256k1: ${identity.secp256k1Pubkey.slice(0, 16)}...`,
        ``,
        `Network:`,
        `  Contacts: ${contactCount.rows[0]?.count || 0}`,
        `  Online peers: ${connectedPeers.length}`,
        `  Connected relays: ${nostrManager.relays.size}`,
        ``,
        `Sharing:`,
        `  Sent: ${sent}`,
        `  Received: ${received}`,
        `  Unread messages: ${unreadMsgs.rows[0]?.count || 0}`,
      ];

      if (relays.rows.length > 0) {
        parts.push("");
        parts.push("Configured relays:");
        for (const r of relays.rows) {
          parts.push(`  ${r.relay_url} (${r.relay_type})`);
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
      };
    }
  );

  // --- Tool: crow_find_contacts ---

  server.tool(
    "crow_find_contacts",
    "Search for Crow users by email hash. Privacy-preserving: only SHA-256 hashes are compared, never plain text emails. Users must opt in to discovery by setting their email hash.",
    {
      email: z.string().max(500).describe("Email address to search for (will be hashed locally, never sent in plain text)"),
    },
    async ({ email }) => {
      // Hash the email locally
      const normalized = email.trim().toLowerCase();
      const emailHash = createHash("sha256").update(normalized).digest("hex");

      // Check local contacts first
      const localMatch = await db.execute({
        sql: "SELECT crow_id, display_name, email_hash FROM contacts WHERE email_hash = ? AND is_blocked = 0",
        args: [emailHash],
      });

      if (localMatch.rows.length > 0) {
        const c = localMatch.rows[0];
        return {
          content: [{
            type: "text",
            text: `Found existing contact: ${c.display_name || c.crow_id} (${c.crow_id})`,
          }],
        };
      }

      // Check configured peer relays for discovery
      const relays = await db.execute({
        sql: "SELECT relay_url FROM relay_config WHERE relay_type = 'peer' AND enabled = 1",
        args: [],
      });

      const found = [];
      for (const relay of relays.rows) {
        try {
          const url = new URL("/discover/find", relay.relay_url);
          url.searchParams.set("hash", emailHash);
          const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            const data = await resp.json();
            if (data.found && data.crow_id) {
              found.push({
                crowId: data.crow_id,
                displayName: data.display_name,
                relay: relay.relay_url,
              });
            }
          }
        } catch {
          // Relay unreachable, skip
        }
      }

      if (found.length > 0) {
        const lines = found.map((f) =>
          `  ${f.displayName || f.crowId} (${f.crowId}) — via ${f.relay}`
        );
        return {
          content: [{
            type: "text",
            text: `Found ${found.length} Crow user(s):\n${lines.join("\n")}\n\nUse crow_accept_invite with their invite code to connect.`,
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: `No Crow users found for that email. They may not have opted into discovery. You can still connect by exchanging invite codes directly.`,
        }],
      };
    }
  );

  // --- Tool: crow_set_discoverable ---

  server.tool(
    "crow_set_discoverable",
    "Opt in or out of contact discovery by setting your email hash. Other Crow users can then find you by email without revealing your actual address.",
    {
      email: z.string().max(500).describe("Your email address (hashed locally, only the hash is stored)"),
      enabled: z.boolean().default(true).describe("Enable or disable discoverability"),
    },
    async ({ email, enabled }) => {
      const normalized = email.trim().toLowerCase();
      const emailHash = createHash("sha256").update(normalized).digest("hex");

      // Store the hash in dashboard_settings for the discovery endpoint
      if (enabled) {
        await db.execute({
          sql: `INSERT OR REPLACE INTO dashboard_settings (key, value, updated_at)
                VALUES ('discovery_email_hash', ?, datetime('now'))`,
          args: [emailHash],
        });
      } else {
        await db.execute({
          sql: "DELETE FROM dashboard_settings WHERE key = 'discovery_email_hash'",
          args: [],
        });
      }

      return {
        content: [{
          type: "text",
          text: enabled
            ? `Discovery enabled. Other Crow users can now find you by email (only your hash is stored: ${emailHash.slice(0, 12)}...).`
            : `Discovery disabled. You are no longer findable by email.`,
        }],
      };
    }
  );

  // --- Tool: crow_discover_relays ---

  server.tool(
    "crow_discover_relays",
    "List configured relays and discover new ones. Relays enable offline message delivery and contact discovery.",
    {},
    async () => {
      const relays = await db.execute({
        sql: "SELECT * FROM relay_config ORDER BY relay_type, relay_url",
        args: [],
      });

      if (relays.rows.length === 0) {
        return {
          content: [{
            type: "text",
            text: [
              "No relays configured.",
              "",
              "Add a relay with crow_add_relay:",
              '  Nostr relay: crow_add_relay({ url: "wss://relay.damus.io", type: "nostr" })',
              '  Peer relay:  crow_add_relay({ url: "https://friend.example.com", type: "peer" })',
              "",
              "Nostr relays enable encrypted messaging between Crow users.",
              "Peer relays enable offline share delivery (store-and-forward).",
            ].join("\n"),
          }],
        };
      }

      const lines = relays.rows.map((r) => {
        const status = r.enabled ? "enabled" : "disabled";
        return `  ${r.relay_url} (${r.relay_type}, ${status})`;
      });

      return {
        content: [{
          type: "text",
          text: `Configured relays (${relays.rows.length}):\n${lines.join("\n")}`,
        }],
      };
    }
  );

  // --- Tool: crow_add_relay ---

  server.tool(
    "crow_add_relay",
    "Add a Nostr or peer relay to your configuration. Nostr relays handle encrypted messaging. Peer relays handle offline share delivery.",
    {
      url: z.string().max(500).describe("Relay URL (wss:// for Nostr, https:// for peer relay)"),
      type: z.enum(["nostr", "peer"]).describe("Relay type"),
    },
    async ({ url, type }) => {
      // Basic URL validation
      try {
        new URL(url);
      } catch {
        return {
          content: [{ type: "text", text: `Invalid URL: ${url}` }],
          isError: true,
        };
      }

      try {
        await db.execute({
          sql: `INSERT INTO relay_config (relay_url, relay_type, enabled)
                VALUES (?, ?, 1)`,
          args: [url, type],
        });
      } catch (err) {
        if (err.message?.includes("UNIQUE")) {
          return {
            content: [{ type: "text", text: `Relay already configured: ${url}` }],
          };
        }
        throw err;
      }

      // If it's a Nostr relay, connect immediately
      if (type === "nostr") {
        try {
          await nostrManager.connectRelays();
        } catch {
          // Non-fatal — will connect on next message send
        }
      }

      return {
        content: [{
          type: "text",
          text: `Added ${type} relay: ${url}`,
        }],
      };
    }
  );

  // --- Instance Management Tools ---

  server.tool(
    "crow_list_instances",
    "List all registered Crow instances (local and remote). Shows instance name, hostname, directory, status, and whether it's the home instance.",
    {
      status: z.enum(["active", "offline", "paused", "revoked"]).optional()
        .describe("Filter by status (default: all)"),
    },
    async ({ status }) => {
      const { listInstances } = await import("../gateway/instance-registry.js");
      const instances = await listInstances(db, { status });

      if (instances.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No instances registered yet. Use crow_register_instance to register this Crow installation.",
          }],
        };
      }

      const lines = instances.map((inst) => {
        const home = inst.is_home ? " [HOME]" : "";
        const topics = inst.topics ? ` | topics: ${inst.topics}` : "";
        const lastSeen = inst.last_seen_at ? ` | last seen: ${inst.last_seen_at}` : "";
        return `• ${inst.name}${home} (${inst.status})\n  id: ${inst.id}\n  host: ${inst.hostname || "unknown"} | dir: ${inst.directory || "unknown"}${topics}${lastSeen}`;
      });

      return {
        content: [{
          type: "text",
          text: `Registered instances (${instances.length}):\n\n${lines.join("\n\n")}`,
        }],
      };
    }
  );

  server.tool(
    "crow_register_instance",
    "Register a Crow instance in the instance registry. Each Crow installation directory is a separate instance. The first registered instance is typically designated as 'home' (the sync hub).",
    {
      name: z.string().max(100).describe("Display name for this instance (e.g., 'Main', 'Finance', 'Cloud Blog')"),
      directory: z.string().max(500).optional().describe("Installation directory path (e.g., ~/crow)"),
      hostname: z.string().max(100).optional().describe("Machine hostname (e.g., grackle, black-swan)"),
      tailscale_ip: z.string().max(50).optional().describe("Tailscale IP for cross-machine access"),
      gateway_url: z.string().max(500).optional().describe("Gateway URL if running (e.g., https://grackle:3001)"),
      sync_profile: z.enum(["full", "memory-only", "blog-only", "custom"]).optional()
        .describe("What to sync: full (everything), memory-only, blog-only, or custom"),
      topics: z.string().max(500).optional()
        .describe("Comma-separated routing keywords (e.g., 'finance, budget, tax')"),
      is_home: z.boolean().optional().describe("Designate as home instance (sync hub). Only one instance can be home."),
    },
    async ({ name, directory, hostname, tailscale_ip, gateway_url, sync_profile, topics, is_home }) => {
      const {
        registerInstance,
        getOrCreateLocalInstanceId,
        generateAuthToken,
        computeInstanceSyncTopic,
      } = await import("../gateway/instance-registry.js");

      const instanceId = getOrCreateLocalInstanceId();
      const crowId = identity.crowId;

      // Generate auth token for this instance
      const { token, hash } = generateAuthToken();

      // Compute Hyperswarm sync topic
      const syncTopic = computeInstanceSyncTopic(crowId);

      await registerInstance(db, {
        id: instanceId,
        name,
        crowId,
        directory: directory || process.cwd(),
        hostname: hostname || (await import("os")).hostname(),
        tailscaleIp: tailscale_ip || null,
        gatewayUrl: gateway_url || null,
        syncUrl: syncTopic.toString("hex"),
        syncProfile: sync_profile || "full",
        topics: topics || null,
        isHome: is_home || false,
        authTokenHash: hash,
      });

      try {
        await createNotification(db, {
          title: `Instance registered: ${name}`,
          type: "system",
          source: "instance-registry",
          action_url: "/dashboard/nest",
        });
      } catch {}

      const homeNote = is_home ? "\nDesignated as HOME instance (sync hub)." : "";
      return {
        content: [{
          type: "text",
          text: `Instance registered successfully.\n\nName: ${name}\nInstance ID: ${instanceId}\nCrow ID: ${crowId}\nAuth token: ${token}\n(Save this token — it's needed for remote instances to authenticate with this one)${homeNote}`,
        }],
      };
    }
  );

  server.tool(
    "crow_update_instance",
    "Update a registered instance's details (name, URL, topics, sync profile, or designate as home).",
    {
      instance_id: z.string().max(100).describe("Instance ID to update"),
      name: z.string().max(100).optional().describe("New display name"),
      gateway_url: z.string().max(500).optional().describe("Updated gateway URL"),
      tailscale_ip: z.string().max(50).optional().describe("Updated Tailscale IP"),
      sync_profile: z.enum(["full", "memory-only", "blog-only", "custom"]).optional()
        .describe("Updated sync profile"),
      topics: z.string().max(500).optional().describe("Updated routing keywords"),
      is_home: z.boolean().optional().describe("Set as home instance"),
      status: z.enum(["active", "offline", "paused"]).optional().describe("Updated status"),
    },
    async ({ instance_id, ...fields }) => {
      const { getInstance, updateInstance } = await import("../gateway/instance-registry.js");

      const existing = await getInstance(db, instance_id);
      if (!existing) {
        return {
          content: [{ type: "text", text: `Instance not found: ${instance_id}` }],
          isError: true,
        };
      }

      const updates = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) updates[key] = value;
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: "text", text: "No fields to update." }],
        };
      }

      await updateInstance(db, instance_id, updates);

      return {
        content: [{
          type: "text",
          text: `Instance "${existing.name}" updated: ${Object.keys(updates).join(", ")}`,
        }],
      };
    }
  );

  server.tool(
    "crow_revoke_instance",
    "Revoke a registered instance — sets status to 'revoked', clears its auth token, and stops accepting its sync data. Use this if a device is compromised or an instance is no longer needed.",
    {
      instance_id: z.string().max(100).describe("Instance ID to revoke"),
      confirm: z.boolean().describe("Must be true to confirm revocation (this action cannot be undone)"),
    },
    async ({ instance_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: "text", text: "Revocation not confirmed. Set confirm: true to proceed." }],
        };
      }

      const { getInstance, revokeInstance } = await import("../gateway/instance-registry.js");

      const existing = await getInstance(db, instance_id);
      if (!existing) {
        return {
          content: [{ type: "text", text: `Instance not found: ${instance_id}` }],
          isError: true,
        };
      }

      if (existing.is_home) {
        return {
          content: [{ type: "text", text: "Cannot revoke the home instance. Designate another instance as home first." }],
          isError: true,
        };
      }

      await revokeInstance(db, instance_id);

      try {
        await createNotification(db, {
          title: `Instance revoked: ${existing.name}`,
          type: "system",
          source: "instance-registry",
        });
      } catch {}

      return {
        content: [{
          type: "text",
          text: `Instance "${existing.name}" has been revoked. Its auth token has been cleared and it will no longer be able to sync.`,
        }],
      };
    }
  );

  server.tool(
    "crow_list_sync_conflicts",
    "List sync conflicts between instances. When the same data is modified on multiple instances, conflicts are logged with both versions preserved. Review and resolve conflicts to keep data consistent.",
    {
      table_name: z.string().max(100).optional().describe("Filter by table name (e.g., 'memories', 'crow_context')"),
      unresolved_only: z.boolean().default(true).describe("Only show unresolved conflicts"),
      limit: z.number().max(100).default(20).describe("Maximum results"),
    },
    async ({ table_name, unresolved_only, limit }) => {
      let sql = "SELECT * FROM sync_conflicts WHERE 1=1";
      const params = [];

      if (table_name) {
        sql += " AND table_name = ?";
        params.push(table_name);
      }
      if (unresolved_only) {
        sql += " AND resolved = 0";
      }

      sql += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);

      const { rows } = await db.execute({ sql, args: params });

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: unresolved_only ? "No unresolved sync conflicts." : "No sync conflicts found." }],
        };
      }

      const formatted = rows.map((r) => {
        const winning = JSON.parse(r.winning_data);
        const losing = JSON.parse(r.losing_data);
        const winPreview = typeof winning.content === "string" ? winning.content.substring(0, 80) : JSON.stringify(winning).substring(0, 80);
        const losePreview = typeof losing.content === "string" ? losing.content.substring(0, 80) : JSON.stringify(losing).substring(0, 80);
        return `Conflict #${r.id} (${r.table_name}, row: ${r.row_id}, ${r.resolved ? "resolved" : "unresolved"})
  Winner: instance ${r.winning_instance_id} (ts: ${r.winning_lamport_ts})
    ${winPreview}...
  Loser:  instance ${r.losing_instance_id} (ts: ${r.losing_lamport_ts})
    ${losePreview}...
  Created: ${r.created_at}`;
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `Sync conflicts (${rows.length}):\n\n${formatted}` }],
      };
    }
  );

  // --- Tool: crow_room_invite ---

  server.tool(
    "crow_room_invite",
    "Invite a Crow contact to join your companion room. Generates a room token and sends an encrypted invite via Nostr. The contact receives a notification with a join link.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact to invite"),
      host_name: z.string().max(100).optional().describe("Your display name shown in the invite (defaults to Crow ID)"),
    },
    async ({ contact, host_name }) => {
      const result = await sendRoomInvite(contact, host_name);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: [
              result.message,
              `Room code: ${result.roomCode}`,
              `Join URL: ${result.joinUrl}`,
              `They will receive a notification to join your room.`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  // --- Tool: crow_room_close ---

  server.tool(
    "crow_room_close",
    "Close an active companion room. Invalidates the room token and optionally notifies participants.",
    {
      room_code: z.string().max(50).optional().describe("Room code to close (closes the most recent room if omitted)"),
    },
    async ({ room_code }) => {
      let code = room_code;

      // If no code specified, close the most recent room
      if (!code) {
        let latestTime = 0;
        for (const [rc, room] of _activeRooms) {
          if (room.hostCrowId === identity.crowId && room.createdAt > latestTime) {
            latestTime = room.createdAt;
            code = rc;
          }
        }
      }

      if (!code || !_activeRooms.has(code)) {
        return {
          content: [{ type: "text", text: "No active room found to close." }],
          isError: true,
        };
      }

      const room = _activeRooms.get(code);

      // Notify participants that the room is closing
      for (const contactId of room.participants) {
        try {
          const { rows } = await db.execute({
            sql: "SELECT * FROM contacts WHERE id = ? AND is_blocked = 0",
            args: [contactId],
          });
          if (rows.length > 0) {
            const envelope = JSON.stringify({
              type: "crow_social",
              version: 1,
              subtype: "room_closed",
              payload: {
                room_code: code,
                host_name: room.hostName,
                host_crow_id: room.hostCrowId,
              },
            });
            await nostrManager.sendMessage(rows[0], envelope);
          }
        } catch {
          // Best-effort notification
        }
      }

      _activeRooms.delete(code);

      return {
        content: [{ type: "text", text: `Room ${code} closed. Participants have been notified.` }],
      };
    }
  );

  // --- Tool: crow_voice_memo ---

  server.tool(
    "crow_voice_memo",
    "Send a text voice memo to a Crow contact. The recipient's companion will speak it aloud using TTS.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      message: z.string().max(2000).describe("The message text to send as a voice memo"),
      sender_name: z.string().max(100).optional().describe("Your display name (defaults to Crow ID)"),
    },
    async ({ contact, message, sender_name }) => {
      const result = await sendVoiceMemo(contact, message, sender_name);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], isError: true };
      }
      return { content: [{ type: "text", text: result.message }] };
    }
  );

  // --- Tool: crow_react ---

  server.tool(
    "crow_react",
    "Send an emoji reaction to a Crow contact.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      emoji: z.string().max(20).describe("The emoji to send (e.g. thumbs up, heart, fire)"),
    },
    async ({ contact, emoji }) => {
      const result = await sendReaction(contact, emoji);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], isError: true };
      }
      return { content: [{ type: "text", text: result.message }] };
    }
  );

  // --- Prompts ---

  server.prompt(
    "sharing-guide",
    "P2P sharing and messaging workflow — invites, contacts, sharing data, and Nostr messaging",
    async () => {
      const text = `Crow P2P Sharing Guide

1. Getting Started
   - Each Crow instance has a unique Crow ID (Ed25519 + secp256k1 key pair)
   - Check your identity with crow_sharing_status
   - Sharing uses end-to-end encryption — no data passes through central servers

2. Connecting with Peers
   - Generate an invite code with crow_generate_invite (expires in 24 hours)
   - Share the invite code with the other person (via any channel)
   - They accept with crow_accept_invite — both sides see a safety number to verify
   - Verify safety numbers match out-of-band for maximum security

3. Sharing Data
   - Share memories, research projects, sources, or notes with crow_share
   - Specify the contact, item type, and item ID
   - Set permissions: "read" (view only) or "read-write" (can modify)
   - Check incoming shares with crow_inbox

4. Messaging
   - Send encrypted messages with crow_send_message
   - Messages use Nostr protocol with NIP-44 encryption
   - View received messages in crow_inbox

5. Managing Access
   - List all contacts with crow_list_contacts (shows online/offline status)
   - Revoke shared access with crow_revoke_access
   - Sharing is peer-to-peer via Hyperswarm (NAT holepunching for direct connections)`;

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  );

  // --- F.11: Identity attestation tools ---

  server.tool(
    "crow_identity_attest",
    "Create a signed attestation linking a per-app handle (e.g., @alice@m.example on Mastodon) to this Crow root identity. The signature can be verified by remote parties via /.well-known/crow-identity.json. OFF BY DEFAULT — opt-in per-handle; publication is permanent and can only be retracted via signed revocation (which itself is public).",
    {
      app: z.enum(ATTESTATION_APPS).describe("Federated app the handle belongs to."),
      external_handle: z.string().min(3).max(320).describe("Full handle, e.g. @alice@m.example or !community@lemmy.example or @user:server.org (Matrix)."),
      app_pubkey: z.string().max(1024).optional().describe("Optional: app-side public key (Matrix MXID signing key, Funkwhale actor key, etc.). Omit if the app doesn't expose a stable signing key."),
      confirm: z.literal("yes").describe("Public linkage is effectively permanent; confirm intent."),
    },
    async ({ app, external_handle, app_pubkey }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          // Check for an existing active attestation; bump version if present
          const existing = await db.execute({
            sql: `SELECT MAX(version) AS v FROM identity_attestations WHERE crow_id = ? AND app = ? AND external_handle = ?`,
            args: [identity.crowId, app, external_handle],
          });
          const prevVersion = existing.rows[0]?.v ? Number(existing.rows[0].v) : 0;
          const version = prevVersion + 1;
          const created_at = Math.floor(Date.now() / 1000);
          const payload = { crow_id: identity.crowId, app, external_handle, app_pubkey, version, created_at };
          const sig = signAttestation(identity, payload);

          const result = await db.execute({
            sql: `INSERT INTO identity_attestations
                    (crow_id, app, external_handle, app_pubkey, sig, version, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [identity.crowId, app, external_handle, app_pubkey || null, sig, version, created_at],
          });
          const id = Number(result.rows[0].id);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                attestation_id: id,
                crow_id: identity.crowId,
                app,
                external_handle,
                version,
                sig,
                publish_url: "/.well-known/crow-identity.json",
                note: "Attestation is now public via the .well-known endpoint. Use crow_identity_revoke to invalidate it (publication of the revocation itself is also public).",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_verify",
    "Verify an attestation for a given (crow_id, app, handle) triple. Fetches the latest non-revoked attestation from the local database and cryptographically verifies the signature. For cross-instance verification, the caller's gateway is expected to fetch /.well-known/crow-identity.json on the target host instead (rate-limited to 60 req/min/IP at that endpoint).",
    {
      crow_id: z.string().min(6).max(64),
      app: z.enum(ATTESTATION_APPS),
      external_handle: z.string().min(3).max(320),
      max_age_seconds: z.number().int().min(0).max(86400 * 30).optional().describe("If set, accept cached records up to this age; otherwise always fetch fresh (local DB read is already fresh — this is semantic only for HTTP callers)."),
    },
    async ({ crow_id, app, external_handle }) => {
      try {
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: `SELECT id, app_pubkey, sig, version, created_at, revoked_at
                  FROM identity_attestations
                  WHERE crow_id = ? AND app = ? AND external_handle = ? AND revoked_at IS NULL
                  ORDER BY version DESC LIMIT 1`,
            args: [crow_id, app, external_handle],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ valid: false, reason: "no_active_attestation", crow_id, app, external_handle }, null, 2) }] };
          }
          const r = row.rows[0];
          // Re-derive pubkey from local identity iff crow_id matches local
          const localIdentity = loadOrCreateIdentity();
          let rootPubkey = null;
          if (localIdentity.crowId === crow_id) rootPubkey = localIdentity.ed25519Pubkey;
          if (!rootPubkey) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  valid: null,
                  reason: "remote_crow_id_pubkey_unavailable",
                  note: "This tool only verifies attestations that belong to THIS Crow instance. For cross-instance verification, fetch /.well-known/crow-identity.json on the remote host.",
                  crow_id, app, external_handle,
                }, null, 2),
              }],
            };
          }
          const payload = { crow_id, app, external_handle, app_pubkey: r.app_pubkey || undefined, version: Number(r.version), created_at: Number(r.created_at) };
          const ok = verifyAttestation(payload, r.sig, rootPubkey) && verifyCrowIdBinding(crow_id, rootPubkey);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                valid: ok,
                version: Number(r.version),
                created_at: Number(r.created_at),
                fetched_at: Math.floor(Date.now() / 1000),
                attestation_id: Number(r.id),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_revoke",
    "Sign a revocation for a previously-published attestation. The revocation is added to /.well-known/crow-identity-revocations.json and the original attestation is marked revoked (but retained in the DB for audit). Rotating an app key should automatically chain revoke → attest; expose that via the bundle's own key-rotation flow.",
    {
      attestation_id: z.number().int(),
      reason: z.string().max(500).optional(),
      confirm: z.literal("yes").describe("Revocations themselves are public; confirm intent."),
    },
    async ({ attestation_id, reason }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: "SELECT crow_id, revoked_at FROM identity_attestations WHERE id = ?",
            args: [attestation_id],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: "Error: attestation not found." }] };
          }
          if (row.rows[0].crow_id !== identity.crowId) {
            return { content: [{ type: "text", text: "Error: this attestation belongs to a different crow_id — only the owner can revoke." }] };
          }
          if (row.rows[0].revoked_at) {
            return { content: [{ type: "text", text: JSON.stringify({ already_revoked: true, revoked_at: Number(row.rows[0].revoked_at) }, null, 2) }] };
          }

          const revoked_at = Math.floor(Date.now() / 1000);
          const payload = { attestation_id, revoked_at, reason };
          const sig = signRevocation(identity, payload);

          await db.execute({
            sql: "UPDATE identity_attestations SET revoked_at = ? WHERE id = ?",
            args: [revoked_at, attestation_id],
          });
          await db.execute({
            sql: `INSERT INTO identity_attestation_revocations (attestation_id, revoked_at, reason, sig) VALUES (?, ?, ?, ?)`,
            args: [attestation_id, revoked_at, reason || null, sig],
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                attestation_id,
                revoked_at,
                sig,
                publish_url: "/.well-known/crow-identity-revocations.json",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_list",
    "List attestations for this Crow instance. Includes both active and revoked entries; filter with include_revoked=false to see only active ones.",
    {
      include_revoked: z.boolean().optional(),
      app: z.enum(ATTESTATION_APPS).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ include_revoked, app, limit }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          const clauses = ["crow_id = ?"];
          const args = [identity.crowId];
          if (app) { clauses.push("app = ?"); args.push(app); }
          if (include_revoked === false) clauses.push("revoked_at IS NULL");
          args.push(limit ?? 100);
          const rows = await db.execute({
            sql: `SELECT id, app, external_handle, version, created_at, revoked_at
                  FROM identity_attestations
                  WHERE ${clauses.join(" AND ")}
                  ORDER BY created_at DESC
                  LIMIT ?`,
            args,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                crow_id: identity.crowId,
                count: rows.rows.length,
                attestations: rows.rows.map(r => ({
                  id: Number(r.id),
                  app: r.app,
                  external_handle: r.external_handle,
                  version: Number(r.version),
                  created_at: Number(r.created_at),
                  revoked_at: r.revoked_at ? Number(r.revoked_at) : null,
                })),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- F.12.2: Crow-native cross-posting ---

  server.tool(
    "crow_list_crosspost_transforms",
    "List the available (source, target) transform pairs for crow_crosspost. Each pair is a pure function in servers/gateway/crossposting/transforms.js.",
    {},
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({ pairs: CROSSPOST_PAIRS }, null, 2),
      }],
    }),
  );

  server.tool(
    "crow_crosspost",
    "Cross-post a status from one federated bundle to another via the shared transform library. Requires idempotency_key — duplicate keys within 7 days return the cached result. on_publish trigger queues with a 60-second delay + cancel notification (no fake undo-after-publish).",
    {
      source_app: z.string().min(1).max(50),
      source_post_id: z.string().min(1).max(200).describe("The source app's native post id. Used for idempotency + audit."),
      source_post: z.object({}).passthrough().describe("Source post shape — transforms pull fields from this object (title, content, url, media, etc.)."),
      target_app: z.string().min(1).max(50),
      idempotency_key: z.string().min(8).max(200).describe("Required. Typically sha256(source_app+source_post_id+target_app). Per-Crow-instance scope."),
      trigger: z.enum(["manual", "on_publish", "on_tag"]).optional().describe("manual fires immediately; on_publish/on_tag enqueue with 60s delay."),
      delay_seconds: z.number().int().min(0).max(86400).optional().describe("Override the default 60s delay. 0 = fire immediately (manual default)."),
      confirm: z.literal("yes").describe("Cross-posts cannot be reliably retracted; confirm intent."),
    },
    async ({ source_app, source_post_id, source_post, target_app, idempotency_key, trigger, delay_seconds }) => {
      try {
        // Validate the transform exists before creating a queue entry
        let transformed;
        try {
          transformed = crosspostTransform(source_app, target_app, source_post);
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }

        const db = createDbClient();
        try {
          // Idempotency check (last 7 days)
          const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
          const existing = await db.execute({
            sql: `SELECT id, status, target_post_id, scheduled_at, published_at, cancelled_at
                  FROM crosspost_log
                  WHERE idempotency_key = ? AND source_app = ? AND target_app = ?
                    AND created_at >= ?
                  LIMIT 1`,
            args: [idempotency_key, source_app, target_app, sevenDaysAgo],
          });
          if (existing.rows.length > 0) {
            const r = existing.rows[0];
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "idempotent_hit",
                  log_id: Number(r.id),
                  prior_status: r.status,
                  target_post_id: r.target_post_id || null,
                  scheduled_at: Number(r.scheduled_at),
                  published_at: r.published_at ? Number(r.published_at) : null,
                  cancelled_at: r.cancelled_at ? Number(r.cancelled_at) : null,
                  note: "Duplicate idempotency_key within 7 days — returning cached entry without re-queuing.",
                }, null, 2),
              }],
            };
          }

          const effectiveTrigger = trigger || "manual";
          const isImmediate = effectiveTrigger === "manual";
          const delay = delay_seconds != null ? delay_seconds : (isImmediate ? 0 : 60);
          const now = Math.floor(Date.now() / 1000);
          const scheduledAt = now + delay;
          const status = delay > 0 ? "queued" : "ready";

          const inserted = await db.execute({
            sql: `INSERT INTO crosspost_log
                    (idempotency_key, source_app, source_post_id, target_app,
                     transform, status, scheduled_at, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  RETURNING id`,
            args: [
              idempotency_key, source_app, source_post_id, target_app,
              `${source_app}→${target_app}`, status, scheduledAt, now,
            ],
          });
          const logId = Number(inserted.rows[0].id);

          if (delay > 0) {
            try {
              await createNotification(db, {
                title: `About to cross-post to ${target_app}`,
                body: `Source: ${source_app}#${source_post_id}. Firing in ${delay}s unless cancelled. Cancel via crow_crosspost_cancel({ log_id: ${logId} }).`,
                type: "peer",
                source: "crosspost",
                priority: "medium",
                action_url: `/dashboard/crosspost?log_id=${logId}`,
              });
            } catch {}
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                log_id: logId,
                status,
                scheduled_at: scheduledAt,
                delay_seconds: delay,
                transform: `${source_app}→${target_app}`,
                transformed_preview: transformed,
                note: delay > 0
                  ? `Queued with ${delay}s cancel window. Target bundle's publish tool must be invoked when scheduled_at arrives — this tool only produces the transformed payload + audit log entry, it does NOT publish directly.`
                  : "Ready to publish. Target bundle's publish tool must be invoked now — this tool only produces the transformed payload.",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_crosspost_cancel",
    "Cancel a queued cross-post before its scheduled_at fires. Idempotent — cancelling an already-published entry returns the published target_post_id. Cancelling an already-cancelled entry is a no-op.",
    {
      log_id: z.number().int(),
    },
    async ({ log_id }) => {
      try {
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: "SELECT status, target_post_id, cancelled_at, published_at, scheduled_at FROM crosspost_log WHERE id = ?",
            args: [log_id],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: "Error: crosspost not found." }] };
          }
          const r = row.rows[0];
          if (r.status === "published") {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "already_published",
                  target_post_id: r.target_post_id,
                  published_at: Number(r.published_at),
                  note: "Published cross-posts cannot be retracted via this tool — use the target bundle's delete verb + accept that delete-propagation is unreliable.",
                }, null, 2),
              }],
            };
          }
          if (r.cancelled_at) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ status: "already_cancelled", cancelled_at: Number(r.cancelled_at) }, null, 2),
              }],
            };
          }
          const now = Math.floor(Date.now() / 1000);
          await db.execute({
            sql: "UPDATE crosspost_log SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
            args: [now, log_id],
          });
          return { content: [{ type: "text", text: JSON.stringify({ status: "cancelled", cancelled_at: now }, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_crosspost_mark_published",
    "Mark a queued cross-post as published (called by the target bundle's publish flow after the actual remote post is created). This tool ONLY updates the audit log — it does NOT perform the publication itself.",
    {
      log_id: z.number().int(),
      target_post_id: z.string().min(1).max(200),
    },
    async ({ log_id, target_post_id }) => {
      try {
        const db = createDbClient();
        try {
          const now = Math.floor(Date.now() / 1000);
          const res = await db.execute({
            sql: `UPDATE crosspost_log SET status = 'published', target_post_id = ?, published_at = ?
                  WHERE id = ? AND status != 'cancelled'`,
            args: [target_post_id, now, log_id],
          });
          if (res.rowsAffected === 0) {
            return { content: [{ type: "text", text: "Error: log row not found or already cancelled." }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ status: "published", target_post_id, published_at: now }, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_list_crossposts",
    "List recent cross-posts from the log with their status (queued/ready/published/cancelled/error).",
    {
      status: z.enum(["queued", "ready", "published", "cancelled", "error"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ status, limit }) => {
      try {
        const db = createDbClient();
        try {
          const clauses = [];
          const args = [];
          if (status) { clauses.push("status = ?"); args.push(status); }
          args.push(limit ?? 50);
          const rows = await db.execute({
            sql: `SELECT id, source_app, source_post_id, target_app, transform, status,
                         target_post_id, scheduled_at, published_at, cancelled_at, error, created_at
                  FROM crosspost_log
                  ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
                  ORDER BY created_at DESC LIMIT ?`,
            args,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                count: rows.rows.length,
                crossposts: rows.rows.map(r => ({
                  id: Number(r.id),
                  source_app: r.source_app,
                  source_post_id: r.source_post_id,
                  target_app: r.target_app,
                  transform: r.transform,
                  status: r.status,
                  target_post_id: r.target_post_id || null,
                  scheduled_at: Number(r.scheduled_at),
                  published_at: r.published_at ? Number(r.published_at) : null,
                  cancelled_at: r.cancelled_at ? Number(r.cancelled_at) : null,
                  error: r.error || null,
                })),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}
