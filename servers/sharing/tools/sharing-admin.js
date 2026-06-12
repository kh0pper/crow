/**
 * Crow Sharing — Sharing Admin Tools
 *
 * Registers: crow_revoke_access, crow_sharing_status
 * (tool registration order #10-11)
 */

import { z } from "zod";
import { generateToken, validateToken, shouldSkipGates } from "../../shared/confirm.js";
import { appendAudit } from "../../shared/project-acl.js";

export function registerSharingAdminTools(server, ctx) {
  const { db, identity, peerManager, nostrManager } = ctx;

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

      // M4: project shares also soft-revoke any matching project_members row
      // (mode='clone' or 'subscription'). The recipient's local copy persists
      // — clone semantics. Append an audit entry on the origin so the project
      // timeline reflects the revocation.
      if (share_type === "project") {
        try {
          await db.execute({
            sql: `UPDATE project_members
                     SET revoked_at = datetime('now')
                   WHERE project_id = ? AND contact_id = ?
                     AND mode IN ('clone','subscription') AND revoked_at IS NULL`,
            args: [item_id, contactRow.id],
          });
          await appendAudit(db, {
            project_id: item_id, actor_type: "local",
            action: "share.revoke",
            target: `contact:${contactRow.id}`,
            payload: { recipient_crow_id: contactRow.crow_id },
          });
        } catch (revokeErr) {
          console.warn(`[sharing] project_members revoke / audit failed: ${revokeErr.message}`);
        }
      }

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
}
