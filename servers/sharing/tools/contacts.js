/**
 * Crow Sharing — Contacts Tools
 *
 * Registers: crow_generate_invite, crow_accept_invite, crow_list_contacts
 * (tool registration order #1-3)
 */

import { z } from "zod";
import { isKioskActive, kioskBlockedResponse } from "../../shared/kiosk-guard.js";
import { generateInviteCode, parseInviteCode, parseBotInviteCode, computeSafetyNumber } from "../identity.js";

/**
 * Build the DM payload a recipient sends to a bot to accept its invite.
 * The adapter authorizes future chats on the SIGNED event pubkey, so the keys
 * here are labels the bot stores; the token is the bearer capability it checks.
 */
export function buildBotAcceptPayload(token, identity, displayName) {
  return JSON.stringify({
    type: "crow_social",
    subtype: "bot_invite_accept",
    token,
    sender: {
      crow_id: identity.crowId,
      ed25519_pubkey: identity.ed25519Pubkey,
      secp256k1_pubkey: identity.secp256k1Pubkey,
      display_name: displayName || identity.crowId,
    },
  });
}

export function registerContactsTools(server, ctx) {
  const { db, identity, peerManager, syncManager, nostrManager } = ctx;

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

  // --- Tool: crow_accept_bot_invite ---

  server.tool(
    "crow_accept_bot_invite",
    "Accept a Crow Messages bot invite. Adds the bot to your Messages so you can chat with it, and tells the bot you accepted so it authorizes you. Paste the bot invite code the owner shared.",
    {
      invite_code: z.string().max(2000).describe("The bot invite code (crow:<id>.<payload>.<sig>)"),
      display_name: z.string().max(100).optional().describe("Name to show for this bot"),
    },
    async ({ invite_code, display_name }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_accept_bot_invite");
      try {
        const bot = parseBotInviteCode(invite_code.trim());
        const name = display_name || bot.botCrowId;

        // Add the bot as a contact so it appears in Messages and we subscribe
        // for its replies. Idempotent on crow_id.
        const existing = await db.execute({
          sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [bot.botCrowId],
        });
        let contactId;
        if (existing.rows.length > 0) {
          contactId = Number(existing.rows[0].id);
        } else {
          const result = await db.execute({
            sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)",
            args: [bot.botCrowId, name, bot.ed25519Pubkey, bot.secp256k1Pubkey],
          });
          contactId = Number(result.lastInsertRowid);
          try { await syncManager.initContact(contactId, null); } catch { /* bot has no hypercore feed; non-fatal */ }
          // Subscribe to the bot's replies over Nostr (new contact only — existing
          // contacts already have a live subscription from their first accept or
          // from restart, so re-subscribing would leak a handle per relay).
          try {
            await nostrManager.subscribeToContact({
              id: contactId, crowId: bot.botCrowId, secp256k1_pubkey: bot.secp256k1Pubkey,
            });
          } catch { /* non-fatal — re-subscribed on next restart */ }
        }

        // Tell the bot we accepted (carries the token it validates).
        try {
          if (nostrManager.relays.size === 0) await nostrManager.connectRelays();
          await nostrManager.sendMessage(
            { secp256k1_pubkey: bot.secp256k1Pubkey },
            buildBotAcceptPayload(bot.token, identity, name)
          );
        } catch (err) {
          return {
            content: [{ type: "text", text: `Added ${name}, but could not reach the bot to confirm (it will authorize you when next online): ${err.message}` }],
          };
        }

        return {
          content: [{ type: "text", text: `Added ${name}! You can now message this bot from your Messages list.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to accept bot invite: ${err.message}` }],
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
}
