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
import { markContactIsBot } from "../../shared/mark-contact-bot.js";
import { createRoom, listRoomMembers } from "./rooms-store.js";
import { buildRoomJoinEnvelope, fanOut } from "../../../../sharing/room-fanout.js";
import { extractInviteCode } from "../../../../sharing/invite-url.js";

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
export async function handlePostAction(req, res, { db, sharingClientFactory = getSharingClient, _managers = null }) {
  const managers = _managers || getManagersOrNull();
  const { action } = req.body;

  if (action === "send_peer" && req.body.contact_id && req.body.message) {
    const { rows } = await db.execute({
      sql: "SELECT display_name, crow_id FROM contacts WHERE id = ?",
      args: [parseInt(req.body.contact_id)],
    });
    if (rows.length === 0) return res.redirectAfterPost("/dashboard/messages");

    const contactIdentifier = rows[0].display_name || rows[0].crow_id;
    try {
      const client = await sharingClientFactory();
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
      const client = await sharingClientFactory();
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
      const code = extractInviteCode(req.body.invite_code);
      const client = await sharingClientFactory();
      let result;
      try {
        result = await client.callTool({
          name: "crow_accept_invite",
          arguments: { invite_code: code },
        });
      } finally { try { await client.close?.(); } catch {} }
      if (result?.isError) {
        req._inviteError = result.content?.[0]?.text || "Invite could not be accepted.";
        return false; // re-render with the error banner
      }
    } catch (err) {
      console.error("[messages] Failed to accept invite"); // never echo the code
      req._inviteError = err.message;
      return false;
    }
    return res.redirectAfterPost("/dashboard/messages");
  }

  // Short-code pairing (P2/C2): generate a 12-char code to read aloud/type.
  if (action === "generate_short_invite") {
    try {
      const client = await sharingClientFactory();
      let result;
      try {
        result = await client.callTool({ name: "crow_generate_short_invite", arguments: {} });
      } finally { try { await client.close?.(); } catch {} }
      const text = result.content?.[0]?.text || "";
      if (result?.isError) {
        req._inviteError = text || "Could not generate a short code.";
      } else {
        req._shortCodeResult = text;
      }
    } catch (err) {
      console.error("[messages] Failed to generate short invite:", err.message);
      req._inviteError = err.message;
    }
    // Don't redirect — let the panel render with the short-code result
    return false;
  }

  if (action === "accept_short_invite" && req.body.short_code) {
    try {
      const client = await sharingClientFactory();
      let result;
      try {
        result = await client.callTool({
          name: "crow_accept_short_invite",
          arguments: { short_code: req.body.short_code },
        });
      } finally { try { await client.close?.(); } catch {} }
      if (result?.isError) {
        req._inviteError = result.content?.[0]?.text || "Code could not be accepted.";
        return false; // re-render with the error banner
      }
    } catch (err) {
      console.error("[messages] Failed to accept short code"); // never echo the code
      req._inviteError = err.message;
      return false;
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
      try {
        const { parseBotInviteCode } = await import("../../../../sharing/identity.js");
        await markContactIsBot(db, parseBotInviteCode(req.body.invite_code.trim()).botCrowId);
      } catch {}
    } catch (err) {
      console.error("[messages] Failed to accept bot invite:", err.message);
    }
    return res.redirectAfterPost("/dashboard/messages");
  }

  if ((action === "dir_add_bot" || action === "dir_message_bot") && req.body.invite_code) {
    const code = req.body.invite_code.trim();
    let botCrowId = null;
    try {
      const { parseBotInviteCode } = await import("../../../../sharing/identity.js");
      botCrowId = parseBotInviteCode(code).botCrowId;
    } catch { /* malformed — accept will report; bail to plain redirect */ }

    // Was this bot already a contact? Only tag origin on contacts WE create
    // (mirrors the removed message_advertised_bot discipline), preserving the
    // pruneStaleAdvertisedContacts lifecycle + the is_bot backfill grain.
    let wasNew = false;
    if (botCrowId) {
      try { const { rows } = await db.execute({ sql: "SELECT 1 FROM contacts WHERE crow_id = ?", args: [botCrowId] }); wasNew = rows.length === 0; } catch {}
    }

    let redirectTo = "/dashboard/messages";
    try {
      const client = await sharingClientFactory();
      try {
        const accepted = await client.callTool({ name: "crow_accept_bot_invite", arguments: { invite_code: code } });
        if (accepted?.isError) return res.redirectAfterPost("/dashboard/messages");
        if (botCrowId) {
          if (wasNew) await db.execute({ sql: "UPDATE contacts SET origin = 'advertised' WHERE crow_id = ?", args: [botCrowId] });
          await markContactIsBot(db, botCrowId);
          if (action === "dir_message_bot") {
            const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [botCrowId] });
            if (rows[0]?.id != null) redirectTo = `/dashboard/messages?open=${rows[0].id}`;
          }
        }
      } finally {
        await client.close();
      }
    } catch (err) {
      console.error("[messages] dir bot materialize failed:", err.message);
    }
    return res.redirectAfterPost(redirectTo);
  }

  if (action === "create_room" && req.body.room_name) {
    // member_ids arrives as repeated checkbox fields (array) OR a comma string.
    const rawMembers = req.body.member_ids;
    const memberIds = (Array.isArray(rawMembers) ? rawMembers : String(rawMembers || "").split(","))
      .map((s) => parseInt(String(s).trim(), 10)).filter((n) => Number.isInteger(n));
    const mode = req.body.mode === "always" ? "always" : "addressed";
    const hostCrowId = managers?.identity?.crowId || null;
    const { groupId, roomUid } = await createRoom(db, { name: req.body.room_name.trim(), memberContactIds: memberIds, mode, hostCrowId });
    // Notify members so their client materializes the room.
    if (managers?.nostrManager) {
      const members = await listRoomMembers(db, groupId);
      const roster = members.map((m) => ({ crow_id: m.crow_id, display_name: m.display_name }));
      const join = buildRoomJoinEnvelope({ roomUid, roomName: req.body.room_name.trim(), hostCrowId, members: roster });
      await fanOut({ nostrManager: managers.nostrManager, members, envelope: join, log: (m) => console.error("[rooms]", m) });
    }
    return res.redirectAfterPost("/dashboard/messages?openRoom=" + groupId);
  }

  // L6: accept a pending message request. Flips 'pending'→'accepted' (a distinct
  // GATED state — NOT NULL, so the partial secp-only row can't masquerade as a
  // full contact in peer-join/sync/room-trust until R4 supplies its identity),
  // marks its messages read, and (best-effort) opens a per-contact Nostr sub so
  // replies flow. Unknown / already-handled id = safe no-op redirect.
  if (action === "accept_request" && req.body.request_id) {
    const id = parseInt(req.body.request_id, 10);
    if (Number.isInteger(id)) {
      const { rows } = await db.execute({
        sql: "SELECT id, crow_id, secp256k1_pubkey FROM contacts WHERE id = ? AND request_status = 'pending'",
        args: [id],
      });
      if (rows.length > 0) {
        const c = rows[0];
        await db.execute({ sql: "UPDATE contacts SET request_status = 'accepted' WHERE id = ?", args: [id] });
        await db.execute({ sql: "UPDATE messages SET is_read = 1 WHERE contact_id = ?", args: [id] });
        if (managers?.nostrManager) {
          try {
            await managers.nostrManager.subscribeToContact({
              id: c.id,
              crow_id: c.crow_id,
              secp256k1_pubkey: c.secp256k1_pubkey,
            });
          } catch (err) {
            console.error("[messages] accept_request subscribe failed:", err.message);
          }
        }
      }
    }
    return res.redirectAfterPost("/dashboard/messages");
  }

  // L6: decline a pending message request → delete the request contact. CASCADE
  // drops its messages (and any group memberships). Safe: request rows don't
  // push-sync, so there's no re-sync race. Unknown id = safe no-op redirect.
  if (action === "decline_request" && req.body.request_id) {
    const id = parseInt(req.body.request_id, 10);
    if (Number.isInteger(id)) {
      await db.execute({
        sql: "DELETE FROM contacts WHERE id = ? AND request_status = 'pending'",
        args: [id],
      });
    }
    return res.redirectAfterPost("/dashboard/messages");
  }

  return false; // Action not handled
}
