/**
 * Messages Panel — POST Action Handlers
 *
 * Dispatches form POST actions for peer messaging, invites, blocking.
 * Uses InMemoryTransport + MCP Client to call sharing server tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSharingServer } from "../../../../sharing/server.js";
import { getManagersOrNull } from "../../../../sharing/managers.js";

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
export async function handlePostAction(req, res, { db, sharingClientFactory = getSharingClient }) {
  const { action } = req.body;

  if (action === "send_peer" && req.body.contact_id && req.body.message) {
    const { rows } = await db.execute({
      sql: "SELECT display_name, crow_id FROM contacts WHERE id = ?",
      args: [parseInt(req.body.contact_id)],
    });
    if (rows.length === 0) return res.redirectAfterPost("/dashboard/messages");

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
    return res.redirectAfterPost("/dashboard/messages");
  }

  if (action === "mark_read" && req.body.id) {
    await db.execute({
      sql: "UPDATE messages SET is_read = 1 WHERE id = ?",
      args: [parseInt(req.body.id)],
    });
    return res.redirectAfterPost("/dashboard/messages");
  }

  if (action === "block" && req.body.crow_id) {
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 1 WHERE crow_id = ?",
      args: [req.body.crow_id],
    });
    // Close Hypercore feeds for the blocked contact to free FDs.
    // NOTE: unblocking does NOT re-init feeds — no lazy re-init path exists for
    // contacts. A restart or re-invite is needed to reopen feeds after an unblock.
    const managers = getManagersOrNull();
    if (managers) {
      try {
        if (managers.syncManager) {
          // SyncManager keys by integer contactId; look it up from crow_id.
          const { rows } = await db.execute({
            sql: "SELECT id FROM contacts WHERE crow_id = ?",
            args: [req.body.crow_id],
          });
          if (rows[0]?.id != null) {
            await managers.syncManager.closeContactFeeds(rows[0].id);
          }
        }
        if (managers.peerManager) {
          await managers.peerManager.leaveContact(req.body.crow_id);
        }
      } catch {}
    }
    return res.redirectAfterPost("/dashboard/messages");
  }

  if (action === "unblock" && req.body.crow_id) {
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 0 WHERE crow_id = ?",
      args: [req.body.crow_id],
    });
    return res.redirectAfterPost("/dashboard/messages");
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
    return res.redirectAfterPost("/dashboard/messages");
  }

  if (action === "accept_bot_invite" && req.body.invite_code) {
    try {
      const client = await sharingClientFactory();
      await client.callTool({
        name: "crow_accept_bot_invite",
        arguments: { invite_code: req.body.invite_code.trim() },
      });
      await client.close();
    } catch (err) {
      console.error("[messages] Failed to accept bot invite:", err.message);
    }
    return res.redirectAfterPost("/dashboard/messages");
  }

  if (action === "message_advertised_bot" && req.body.invite_code && req.body.message) {
    const code = req.body.invite_code.trim();
    let botCrowId = null;
    try {
      const { parseBotInviteCode } = await import("../../../../sharing/identity.js"); // four levels up (cf. api-handlers.js static imports)
      botCrowId = parseBotInviteCode(code).botCrowId;
    } catch { /* malformed — accept will report the error; bail to redirect */ }

    try {
      // Was this bot already a contact? (Only tag origin on contacts WE create,
      // so we never relabel a manually-added contact.)
      let wasNew = false;
      if (botCrowId) {
        const { rows } = await db.execute({ sql: "SELECT 1 FROM contacts WHERE crow_id = ?", args: [botCrowId] });
        wasNew = rows.length === 0;
      }

      const client = await sharingClientFactory();
      // try/finally so the in-memory MCP client is always closed — even if the
      // UPDATE or crow_send_message throws (otherwise its pipe leaks for the
      // process lifetime in this long-lived gateway).
      try {
        // crow_accept_bot_invite sets isError:true ONLY on a malformed code / DB
        // failure (it does NOT create a contact then). An owner momentarily
        // unreachable is a NON-error success (accept + message go to relays
        // store-and-forward), so we proceed in that case.
        const accepted = await client.callTool({ name: "crow_accept_bot_invite", arguments: { invite_code: code } });
        if (accepted?.isError) {
          return res.redirectAfterPost("/dashboard/messages"); // accept failed → nothing materialized
        }

        if (botCrowId) {
          if (wasNew) {
            await db.execute({ sql: "UPDATE contacts SET origin = 'advertised' WHERE crow_id = ?", args: [botCrowId] });
          }
          await client.callTool({ name: "crow_send_message", arguments: { contact: botCrowId, message: req.body.message } });
        }
      } finally {
        await client.close();
      }
    } catch (err) {
      console.error("[messages] Failed to message advertised bot:", err.message);
    }
    return res.redirectAfterPost("/dashboard/messages");
  }

  return false; // Action not handled
}
