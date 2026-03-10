/**
 * Crow Sharing Server — Server Factory
 *
 * Creates a configured McpServer with P2P sharing tools.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 *
 * 8 MCP tools:
 *   crow_generate_invite  — Create invite code with 24h expiry
 *   crow_accept_invite    — Accept invite, handshake, show safety number
 *   crow_list_contacts    — List peers with online/offline status
 *   crow_share            — Share memory/project/source/note to a contact
 *   crow_inbox            — List received shares and messages
 *   crow_send_message     — Send encrypted Nostr message
 *   crow_revoke_access    — Revoke shared project access
 *   crow_sharing_status   — Show Crow ID, peer count, relay status
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "../db.js";
import {
  loadOrCreateIdentity,
  generateInviteCode,
  parseInviteCode,
  computeSafetyNumber,
} from "./identity.js";
import { PeerManager } from "./peer-manager.js";
import { SyncManager } from "./sync.js";
import { NostrManager } from "./nostr.js";

export function createSharingServer(dbPath, options = {}) {
  const db = createDbClient(dbPath);
  const identity = loadOrCreateIdentity();
  const peerManager = new PeerManager(identity);
  const syncManager = new SyncManager(identity);
  const nostrManager = new NostrManager(identity, db);

  // Start peer manager (non-blocking)
  peerManager.start().catch((err) => {
    console.warn("[sharing] PeerManager start failed:", err.message);
  });

  // Wire peer connections to sync
  peerManager.onPeerConnected = async (crowId, conn) => {
    // Find contact and start replication
    const contact = await db.execute({
      sql: "SELECT * FROM contacts WHERE crow_id = ? AND is_blocked = 0",
      args: [crowId],
    });
    if (contact.rows.length > 0) {
      const c = contact.rows[0];
      await syncManager.replicate(c.id, conn);
      // Update last_seen
      await db.execute({
        sql: "UPDATE contacts SET last_seen = datetime('now') WHERE id = ?",
        args: [c.id],
      });
    }
  };

  // Wire incoming sync entries to DB
  syncManager.onEntry = async (contactId, entry) => {
    try {
      if (entry.type === "memory" || entry.type === "source" || entry.type === "note" || entry.type === "project") {
        await db.execute({
          sql: `INSERT OR IGNORE INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status)
                VALUES (?, ?, ?, ?, 'received', 'delivered')`,
          args: [contactId, entry.type, 0, entry.permissions || "read"],
        });
      }
    } catch (err) {
      // Skip insertion errors
    }
  };

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
    "Share a memory, research project, source, or note with a connected contact. The data is encrypted end-to-end.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      share_type: z.enum(["memory", "project", "source", "note"]).describe("Type of item to share"),
      item_id: z.number().describe("ID of the item to share"),
      permissions: z.enum(["read", "read-write", "one-time"]).default("read").describe("Permission level"),
    },
    async ({ contact, share_type, item_id, permissions }) => {
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
        sql: `SELECT id FROM ${table} WHERE id = ?`,
        args: [item_id],
      });

      if (item.rows.length === 0) {
        return {
          content: [{ type: "text", text: `${share_type} #${item_id} not found` }],
          isError: true,
        };
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

      // If peer is online, send via Hypercore
      if (peerManager.isConnected(contactRow.crow_id)) {
        try {
          // Get the actual item data
          const itemData = await db.execute({
            sql: `SELECT * FROM ${table} WHERE id = ?`,
            args: [item_id],
          });

          const entry = syncManager.createShareEntry(
            share_type,
            "share",
            itemData.rows[0],
            permissions
          );
          await syncManager.appendEntry(contactRow.id, entry);
        } catch (err) {
          // Sync append failed — still recorded in shared_items
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
    "Send an encrypted message to a contact via the Nostr network. Messages are end-to-end encrypted and delivered through public Nostr relays.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      message: z.string().max(10000).describe("Message text to send"),
    },
    async ({ contact, message }) => {
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

  // --- Tool: crow_revoke_access ---

  server.tool(
    "crow_revoke_access",
    "Revoke a previously shared item or project from a contact. Stops ongoing sync for shared projects.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      share_type: z.enum(["memory", "project", "source", "note"]).describe("Type of shared item"),
      item_id: z.number().describe("ID of the shared item to revoke"),
    },
    async ({ contact, share_type, item_id }) => {
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

      const deleted = await db.execute({
        sql: `DELETE FROM shared_items
              WHERE contact_id = ? AND share_type = ? AND item_id = ? AND direction = 'sent'`,
        args: [contactRow.id, share_type, item_id],
      });

      if (deleted.rowsAffected === 0) {
        return {
          content: [{ type: "text", text: `No matching share found to revoke.` }],
        };
      }

      // Send revocation notice via sync
      if (peerManager.isConnected(contactRow.crow_id)) {
        try {
          const entry = syncManager.createShareEntry(share_type, "revoke", { item_id }, "read");
          await syncManager.appendEntry(contactRow.id, entry);
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

  return server;
}
