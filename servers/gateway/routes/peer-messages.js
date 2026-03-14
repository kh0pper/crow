/**
 * Peer Messages API Routes
 *
 * REST endpoints for peer-to-peer messaging (Nostr).
 * Protected by dashboard session auth (cookie-based).
 *
 * Routes:
 *   GET  /api/messages/peer/:contactId       — Get messages for a contact
 *   POST /api/messages/peer/:contactId/send   — Send message to a contact
 *   POST /api/messages/peer/:id/read          — Mark message as read
 *   GET  /api/messages/status                 — Unread counts + latest timestamps
 */

import { Router } from "express";
import { createDbClient } from "../../db.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSharingServer } from "../../sharing/server.js";

export default function peerMessagesRouter(dashboardAuth) {
  const router = Router();

  // All peer message routes require dashboard auth
  router.use("/api/messages", dashboardAuth);

  // --- Get messages for a contact ---

  router.get("/api/messages/peer/:contactId", async (req, res) => {
    const db = createDbClient();
    try {
      const contactId = parseInt(req.params.contactId);
      if (!contactId) return res.status(400).json({ error: "Invalid contact ID" });

      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const offset = parseInt(req.query.offset) || 0;
      const afterId = parseInt(req.query.afterId) || 0;

      let sql, args;
      if (afterId) {
        sql = `SELECT m.id, m.content, m.direction, m.is_read, m.created_at,
                      m.thread_id, m.nostr_event_id, m.attachments,
                      c.display_name, c.crow_id, c.last_seen
               FROM messages m
               LEFT JOIN contacts c ON m.contact_id = c.id
               WHERE m.contact_id = ? AND m.id > ?
               ORDER BY m.id ASC
               LIMIT ?`;
        args = [contactId, afterId, limit];
      } else {
        sql = `SELECT m.id, m.content, m.direction, m.is_read, m.created_at,
                      m.thread_id, m.nostr_event_id, m.attachments,
                      c.display_name, c.crow_id, c.last_seen
               FROM messages m
               LEFT JOIN contacts c ON m.contact_id = c.id
               WHERE m.contact_id = ?
               ORDER BY m.id DESC
               LIMIT ? OFFSET ?`;
        args = [contactId, limit, offset];
      }

      const { rows } = await db.execute({ sql, args });

      // Get contact info
      const { rows: contactRows } = await db.execute({
        sql: `SELECT id, crow_id, display_name, ed25519_pubkey, is_blocked, last_seen, created_at
              FROM contacts WHERE id = ?`,
        args: [contactId],
      });

      // Parse attachments JSON
      const messages = (afterId ? rows : rows.reverse()).map((m) => ({
        ...m,
        attachments: m.attachments ? JSON.parse(m.attachments) : null,
      }));

      res.json({
        contact: contactRows[0] || null,
        messages,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Send message to a contact ---

  router.post("/api/messages/peer/:contactId/send", async (req, res) => {
    const db = createDbClient();
    try {
      const contactId = parseInt(req.params.contactId);
      if (!contactId) return res.status(400).json({ error: "Invalid contact ID" });

      const { message, attachments } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "Message content is required" });
      }

      // Get contact identifier for crow_send_message
      const { rows: contactRows } = await db.execute({
        sql: "SELECT crow_id, display_name FROM contacts WHERE id = ?",
        args: [contactId],
      });
      if (contactRows.length === 0) {
        return res.status(404).json({ error: "Contact not found" });
      }

      const contact = contactRows[0];
      const contactIdentifier = contact.display_name || contact.crow_id;

      // Send via MCP sharing server
      const server = createSharingServer();
      const client = new Client({ name: "peer-messages-api", version: "0.1.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await client.connect(ct);

      try {
        await client.callTool({
          name: "crow_send_message",
          arguments: { contact: contactIdentifier, message: message.trim() },
        });
      } finally {
        await client.close();
      }

      // Store attachment metadata if provided
      if (attachments && Array.isArray(attachments) && attachments.length > 0) {
        // Get the message we just sent (latest sent message to this contact)
        const { rows: latestMsg } = await db.execute({
          sql: `SELECT id FROM messages
                WHERE contact_id = ? AND direction = 'sent'
                ORDER BY id DESC LIMIT 1`,
          args: [contactId],
        });

        if (latestMsg.length > 0) {
          const msgId = latestMsg[0].id;
          await db.execute({
            sql: "UPDATE messages SET attachments = ? WHERE id = ?",
            args: [JSON.stringify(attachments), msgId],
          });

          // Update storage_files references
          for (const att of attachments) {
            if (att.s3_key) {
              await db.execute({
                sql: "UPDATE storage_files SET reference_type = 'message', reference_id = ? WHERE s3_key = ?",
                args: [msgId, att.s3_key],
              });
            }
          }
        }
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Mark message as read ---

  router.post("/api/messages/peer/:id/read", async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid message ID" });

      await db.execute({
        sql: "UPDATE messages SET is_read = 1 WHERE id = ?",
        args: [id],
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Status endpoint (lightweight polling) ---

  router.get("/api/messages/status", async (req, res) => {
    const db = createDbClient();
    try {
      // Peer unread counts per contact
      const { rows: peerRows } = await db.execute(`
        SELECT m.contact_id as contactId,
               SUM(CASE WHEN m.is_read = 0 AND m.direction = 'received' THEN 1 ELSE 0 END) as unread,
               MAX(m.created_at) as lastActivity
        FROM messages m
        GROUP BY m.contact_id
      `);

      // AI conversation last activity
      const { rows: aiRows } = await db.execute(`
        SELECT id as convId, updated_at as lastActivity
        FROM chat_conversations
        ORDER BY updated_at DESC
        LIMIT 50
      `);

      res.json({
        peers: peerRows.map((r) => ({
          contactId: r.contactId,
          unread: Number(r.unread) || 0,
          lastActivity: r.lastActivity,
        })),
        ai: aiRows.map((r) => ({
          convId: r.convId,
          lastActivity: r.lastActivity,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  return router;
}
