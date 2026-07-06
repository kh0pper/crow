/**
 * Crow Sharing — Contacts Tools
 *
 * Registers: crow_generate_invite, crow_accept_invite, crow_generate_short_invite,
 * crow_accept_short_invite, crow_add_contact, crow_accept_bot_invite, crow_list_contacts
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import { isKioskActive, kioskBlockedResponse } from "../../shared/kiosk-guard.js";
import { generateInviteCode, parseInviteCode, parseBotInviteCode, computeSafetyNumber } from "../identity.js";
import { upsertFullContact } from "../contact-promote.js";
import { emitContactChange } from "../contact-sync.js";
import { buildInviteUrl, extractInviteCode } from "../invite-url.js";
import {
  generateShortCode, formatShortCode, normalizeShortCode, deriveShortCodeKeys,
  buildRendezvousEvent, parseRendezvousEvent, SHORTCODE_EXPIRY_MS,
} from "../short-code.js";
import { recordShortInvite } from "../shortcode-ledger.js";

/**
 * Core of "accept an invite and pair with the peer it names." VERBATIM
 * extraction of the former crow_accept_invite handler body (from `const peer =
 * parseInviteCode…` through the success return) — see the P2/C2 plan's Task 3
 * Interfaces. The ONLY two deltas from that inherited body: (a) the
 * acceptancePayload gains `...(peer.inviteId ? { inviteId: peer.inviteId } :
 * {})` so the short-code single-use ledger can consume the token; (b) nothing
 * else — same `{ content: [...] }` shapes, same control flow, same error
 * surface. Module-level (not a closure over registerContactsTools) so both
 * crow_accept_invite and crow_accept_short_invite can share it; the
 * previously-in-closure collaborators are passed explicitly instead.
 */
async function acceptInviteCore({ invite_code, display_name }, { db, identity, syncManager, peerManager, nostrManager }) {
  const peer = parseInviteCode(invite_code);

  // Idempotent, repairable insert/promote/merge — re-accepting a known or
  // partial contact repairs it instead of erroring (the repair action IS the
  // normal action). Handles wiring (sync feeds, DHT topic, Nostr sub) itself.
  const { contactId } = await upsertFullContact(
    db,
    { syncManager, peerManager, nostrManager },
    {
      crowId: peer.crowId,
      ed25519Pub: peer.ed25519Pubkey,
      secp256k1Pub: peer.secp256k1Pubkey,
      displayName: display_name || undefined,
    },
  );

  // Compute safety number (unchanged).
  const safetyNumber = computeSafetyNumber(
    identity.ed25519Pubkey,
    peer.ed25519Pubkey
  );

  // Send acceptance back to the inviter so they auto-add us. sendInviteAccepted
  // (PR3) also enqueues it for retry until the inviter's handshake_complete ack
  // clears the row — so an offline inviter can no longer strand the handshake.
  try {
    if (nostrManager.relays.size === 0) {
      await nostrManager.connectRelays();
    }
    const acceptancePayload = JSON.stringify({
      type: "invite_accepted",
      crowId: identity.crowId,
      ed25519Pub: identity.ed25519Pubkey,
      secp256k1Pub: identity.secp256k1Pubkey,
      ...(peer.inviteId ? { inviteId: peer.inviteId } : {}),
    });
    await nostrManager.sendInviteAccepted(
      { id: contactId, secp256k1_pubkey: peer.secp256k1Pubkey },
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
}

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
      const url = buildInviteUrl(code);
      return {
        content: [
          {
            type: "text",
            text: [
              `Invite code generated (expires in 24 hours):`,
              ``,
              `\`${code}\``,
              ``,
              `Share link (opens a page with the code and instructions):`,
              url,
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
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_accept_invite");
      invite_code = extractInviteCode(invite_code);
      try {
        return await acceptInviteCore(
          { invite_code, display_name },
          { db, identity, syncManager, peerManager, nostrManager }
        );
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to accept invite: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: crow_generate_short_invite (P2/C2) ---

  server.tool(
    "crow_generate_short_invite",
    "Generate a short 12-character pairing code to read aloud or type to someone right now (in person, on a call). Expires in 10 minutes. For longer-lived sharing (email, chat, no time pressure) use crow_generate_invite instead.",
    {},
    async () => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_generate_short_invite");
      try {
        const code = generateShortCode();
        const keys = await deriveShortCodeKeys(code); // full-strength — production, no N override
        const inviteId = randomUUID();
        const expires = Date.now() + SHORTCODE_EXPIRY_MS;
        // C1 fix (a): the inner code MUST carry expiresInMs so it dies in 10
        // min via ANY accept path — without it, it silently reverts to the
        // 24h default and reopens the acceptor-side leak window.
        const innerCode = generateInviteCode(identity, { inviteId, expiresInMs: SHORTCODE_EXPIRY_MS });
        await recordShortInvite(db, inviteId, expires);
        const event = buildRendezvousEvent(keys, { inviteCode: innerCode, expires: Date.now() + SHORTCODE_EXPIRY_MS });
        const published = await nostrManager.publishRendezvousEvent(event);

        if (published.length === 0) {
          return {
            content: [{ type: "text", text: "Could not reach any relay — try again or use an invite link (crow_generate_invite)." }],
            isError: true,
          };
        }

        const formatted = formatShortCode(code);
        const minutes = Math.round(SHORTCODE_EXPIRY_MS / 60000);
        return {
          content: [
            {
              type: "text",
              text: [
                `Short pairing code (expires in ${minutes} minutes):`,
                ``,
                formatted,
                ``,
                `Speak it aloud or type it to the other person — don't post it anywhere public.`,
                `They should use \`crow_accept_short_invite\` with this code.`,
                `Once connected, verify the safety number through a separate channel to confirm the connection is secure.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to generate short invite: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: crow_accept_short_invite (P2/C2) ---

  server.tool(
    "crow_accept_short_invite",
    "Accept a short pairing code someone read aloud or typed to you. Looks up the pairing rendezvous on the relay network and completes the connection. Shows a safety number for out-of-band verification.",
    {
      short_code: z.string().max(24).describe("The short pairing code (e.g. K7Q4-M2X9-3FHT)"),
      display_name: z.string().max(100).optional().describe("Name for this contact"),
    },
    async ({ short_code, display_name }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_accept_short_invite");
      const normalized = normalizeShortCode(short_code);
      if (!normalized) {
        return {
          content: [{ type: "text", text: "That doesn't look like a Crow short code." }],
          isError: true,
        };
      }
      try {
        const keys = await deriveShortCodeKeys(normalized); // full-strength — production, no N override
        const { events } = await nostrManager.fetchRendezvousByAuthor(keys.pub);

        const parsed = [];
        for (const event of events) {
          try {
            parsed.push(parseRendezvousEvent(event, keys));
          } catch {
            // Expired/tampered/wrong-key event — dropped, not thrown.
          }
        }

        if (parsed.length === 0) {
          return {
            content: [{ type: "text", text: "Code not found or expired — ask for a fresh one." }],
            isError: true,
          };
        }

        // I1 FAIL-CLOSED: two DISTINCT rendezvous payloads under one code key
        // means someone else published under the same derived key — a MITM
        // attempt. Refuse rather than newest-wins. This is a TRIPWIRE, not a
        // guarantee: a code-cracker who floods >limit relays with their OWN
        // single payload can bury the honest event so only one distinct code is
        // seen. That regime already presupposes a cracked code, where the
        // safety number (PR3) is the real backstop; this catches the naive
        // competing-publish, which is the common accidental/low-effort case.
        const distinctCodes = new Set(parsed.map((p) => p.inviteCode));
        if (distinctCodes.size > 1) {
          console.warn("[sharing] short-code: multiple distinct rendezvous events — refusing");
          return {
            content: [{ type: "text", text: "This code may be compromised — ask for a fresh one and verify the safety number after connecting." }],
            isError: true,
          };
        }

        const result = await acceptInviteCore(
          { invite_code: parsed[0].inviteCode, display_name },
          { db, identity, syncManager, peerManager, nostrManager }
        );
        if (result.isError) return result;

        // Append the safety-number backstop caveat to the (verbatim, shared)
        // success text without altering acceptInviteCore itself.
        const caveat = "\n\n(A safety-number comparison UI is coming in a future update — for now, read the numbers aloud to your contact through a separate channel.)";
        return {
          content: result.content.map((c, i) =>
            i === 0 && c.type === "text" ? { ...c, text: c.text + caveat } : c
          ),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to accept short invite: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: crow_add_contact (R4 handshake repair) ---

  server.tool(
    "crow_add_contact",
    "Repair or add a Crow contact directly from their Crow ID and public keys — the recovery path when an invite handshake half-completed and messages are stuck as requests. Idempotent: completes an existing partial/request contact in place instead of duplicating it.",
    {
      crow_id: z.string().max(200).describe("The contact's Crow ID (e.g. crow:abcd1234)"),
      secp256k1_pubkey: z.string().max(200).describe("Their secp256k1 public key (64- or 66-hex)"),
      ed25519_pubkey: z.string().max(200).optional().describe("Their ed25519 public key (enables peer sync + room trust)"),
      display_name: z.string().max(100).optional().describe("Name for this contact"),
    },
    async ({ crow_id, secp256k1_pubkey, ed25519_pubkey, display_name }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_add_contact");
      try {
        // Pass the raw `db` — upsertFullContact only needs `.execute`, and
        // crow_accept_invite calls `db.execute` on the raw ctx db (contacts.js:78,90).
        const r = await upsertFullContact(
          db,
          { syncManager, peerManager, nostrManager },
          { crowId: crow_id.trim(), ed25519Pub: (ed25519_pubkey || "").trim(), secp256k1Pub: secp256k1_pubkey.trim(), displayName: display_name?.trim() }
        );
        const verb = r.outcome === "created" ? "Added" : r.outcome === "noop" ? "Already connected to" : "Repaired contact";
        return { content: [{ type: "text", text: `${verb} ${display_name || crow_id} (${r.outcome}).` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to add contact: ${err.message}` }], isError: true };
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
        // Prefer an explicit name, else the friendly name the owner put in the
        // invite, else the raw crow: id.
        const name = display_name || bot.name || bot.botCrowId;

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
          // Phase 3: an accepted remote bot is a real cross-instance contact —
          // propagate it to the user's other instances (advertised/remote bots
          // sync per S-BOTS; a local-bot would be gated by shouldSyncRow).
          try {
            const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] });
            if (rows[0]) await emitContactChange("insert", rows[0]);
          } catch { /* never blocks the accept */ }
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
      // request_status IS NOT NULL rows are partial message-request contacts
      // (secp-only) — exclude them from the normal contact listing.
      let sql = "SELECT * FROM contacts WHERE request_status IS NULL";
      const args = [];

      if (!include_blocked) {
        sql += " AND is_blocked = 0";
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
