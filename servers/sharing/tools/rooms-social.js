/**
 * Crow Sharing — Rooms and Social Tools
 *
 * Registers: crow_room_invite, crow_room_close, crow_voice_memo, crow_react
 * (tool registration order #21-24)
 *
 * crow_room_close iterates/has/gets/deletes _activeRooms directly — imports
 * the Map from rooms.js so all accesses stay on the singleton.
 * crow_room_invite/crow_voice_memo/crow_react delegate to the send* fns from rooms.js.
 */

import { z } from "zod";
import { _activeRooms, sendRoomInvite, sendVoiceMemo, sendReaction } from "../rooms.js";

export function registerRoomsSocialTools(server, ctx) {
  const { db, identity, nostrManager } = ctx;

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
}
