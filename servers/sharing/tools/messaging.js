/**
 * Crow Sharing — Messaging Tools
 *
 * Registers: crow_send_message, crow_create_message_group,
 *            crow_list_message_groups, crow_send_group_message
 * (tool registration order #6-9)
 */

import { z } from "zod";
import { isKioskActive, kioskBlockedResponse } from "../../shared/kiosk-guard.js";

export function registerMessagingTools(server, ctx) {
  const { db, identity, nostrManager } = ctx;

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
}
