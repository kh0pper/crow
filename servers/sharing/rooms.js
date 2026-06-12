/**
 * Crow Sharing — Active Rooms State + Room/Voice/Reaction Senders
 *
 * Owns the _activeRooms singleton Map and the send* functions that
 * interact with rooms or send social messages.
 */

import { randomBytes } from "node:crypto";
import { createNotification } from "../shared/notifications.js";
import { getManagersOrNull } from "./managers.js";

// In-memory room state — active companion room tokens.
// Map<roomCode, { token, hostCrowId, hostName, companionUrl, createdAt, participants: Set<contactId> }>
export const _activeRooms = new Map();

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
  const managers = getManagersOrNull();
  if (!managers) return { ok: false, message: "Sharing server not initialized" };
  const { db, identity, nostrManager } = managers;

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
  const managers = getManagersOrNull();
  if (!managers) return { ok: false, message: "Sharing server not initialized" };
  const { db, identity, nostrManager } = managers;

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
  const managers = getManagersOrNull();
  if (!managers) return { ok: false, message: "Sharing server not initialized" };
  const { db, identity, nostrManager } = managers;

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
