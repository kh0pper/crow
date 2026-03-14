/**
 * Messages Panel — POST Action Handlers
 *
 * Dispatches form POST actions for peer messaging, invites, blocking.
 * Uses InMemoryTransport + MCP Client to call sharing server tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSharingServer } from "../../../../sharing/server.js";

/**
 * Create a connected sharing MCP client.
 */
async function getSharingClient() {
  const server = createSharingServer();
  const client = new Client({ name: "dashboard-msg-action", version: "0.1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}

/**
 * Handle POST actions from the messages panel.
 * Returns true if the action was handled (response sent), false otherwise.
 */
export async function handlePostAction(req, res, { db }) {
  const { action } = req.body;

  if (action === "send_peer" && req.body.contact_id && req.body.message) {
    const { rows } = await db.execute({
      sql: "SELECT display_name, crow_id FROM contacts WHERE id = ?",
      args: [parseInt(req.body.contact_id)],
    });
    if (rows.length === 0) return res.redirect("/dashboard/messages");

    const contactIdentifier = rows[0].display_name || rows[0].crow_id;
    try {
      const client = await getSharingClient();
      await client.callTool({
        name: "crow_send_message",
        arguments: { contact: contactIdentifier, message: req.body.message },
      });
      await client.close();
    } catch (err) {
      console.error("[messages] Failed to send peer message:", err.message);
    }
    return res.redirect("/dashboard/messages");
  }

  if (action === "mark_read" && req.body.id) {
    await db.execute({
      sql: "UPDATE messages SET is_read = 1 WHERE id = ?",
      args: [parseInt(req.body.id)],
    });
    return res.redirect("/dashboard/messages");
  }

  if (action === "block" && req.body.crow_id) {
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 1 WHERE crow_id = ?",
      args: [req.body.crow_id],
    });
    return res.redirect("/dashboard/messages");
  }

  if (action === "unblock" && req.body.crow_id) {
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 0 WHERE crow_id = ?",
      args: [req.body.crow_id],
    });
    return res.redirect("/dashboard/messages");
  }

  if (action === "generate_invite") {
    try {
      const client = await getSharingClient();
      const result = await client.callTool({
        name: "crow_generate_invite",
        arguments: {},
      });
      await client.close();
      // Extract invite code from result
      const text = result.content?.[0]?.text || "";
      // Store temporarily for display
      req._inviteResult = text;
    } catch (err) {
      console.error("[messages] Failed to generate invite:", err.message);
      req._inviteError = err.message;
    }
    // Don't redirect — let the panel render with the invite result
    return false;
  }

  if (action === "accept_invite" && req.body.invite_code) {
    try {
      const client = await getSharingClient();
      await client.callTool({
        name: "crow_accept_invite",
        arguments: { invite_code: req.body.invite_code.trim() },
      });
      await client.close();
    } catch (err) {
      console.error("[messages] Failed to accept invite:", err.message);
    }
    return res.redirect("/dashboard/messages");
  }

  return false; // Action not handled
}
