/**
 * Accept a Crow Messages bot invite — the ONE place a bot contact is created
 * (spec `2026-07-12-advertised-contact-prune-design.md` §3 F5, defect D1).
 *
 * D1 was a split-brain: `crow_accept_bot_invite` INSERTed an UNCLASSIFIED row and
 * emitted it, and the *caller* stamped the classification afterwards — the contacts
 * panel with a SECOND emit (`op="update"`), the messages panel with NO emit at all.
 * Peers therefore received `origin=NULL`, and whether they ever learned otherwise
 * depended on which panel the user happened to click. With F2's provenance column
 * that is no longer merely untidy: a row that reaches a peer without
 * `advertised_by_instance_id` is UN-prunable there, and one stamped wrongly is
 * OVER-prunable. So the classification rides the INSERT, in one place, and exactly
 * one `insert` is emitted from a re-SELECT of the row it produced.
 *
 * `insert` is load-bearing: it is the only op that passes a peer's tombstone gate
 * (`instance-sync.js` drops `op="update"` unconditionally when a tombstone stands),
 * so a re-add after a prune actually lands.
 *
 * PROVENANCE IS NEVER AN ARGUMENT A MODEL CONTROLS. `crow_accept_bot_invite`'s zod
 * schema is deliberately unchanged — it has no advertiser parameter. Only the panel
 * directory handlers supply `advertisedByInstanceId`, and they resolve it server-side
 * from a prune-free directory read. No advertiser ⇒ NULL provenance ⇒ never prunable,
 * which is the fail-safe direction.
 *
 * IMPORT DISCIPLINE: `managers` is passed IN, never imported — managers.js → nostr.js
 * → contact-promote.js → contact-sync.js is a live import chain, and a static
 * managers.js import here would close the cycle.
 */

import { parseBotInviteCode } from "./identity.js";
import { emitContactChange } from "./contact-sync.js";
import { clearTombstone } from "./contact-delete.js";

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

/**
 * Add a bot as a contact and tell it we accepted. Idempotent on the bot's crow_id.
 *
 * @param {object} db async db client ({ execute })
 * @param {object} managers { syncManager?, peerManager?, nostrManager?, identity? }
 * @param {object} opts
 * @param {string} opts.inviteCode the `crow:<id>.<payload>.<sig>` bot invite
 * @param {string} [opts.displayName] overrides the name baked into the invite
 * @param {string} [opts.advertisedByInstanceId] the instance whose directory this bot
 *   came from — supplied ONLY by the panel directory handlers, resolved server-side.
 *   Absent ⇒ `origin=NULL, advertised_by_instance_id=NULL` (structurally never prunable).
 * @param {boolean} [opts.isBot] assert bot-ness INDEPENDENTLY of provenance. Supplied by
 *   the panel directory handlers (a bot clicked in the bot directory IS a bot). Absent ⇒
 *   `is_bot` follows provenance, which keeps the MCP/pasted-invite path byte-identical to
 *   the pre-F5 tool (`is_bot=0` unless the caller marks it).
 * @returns {Promise<{ok:true, outcome:"created"|"existing", contactId:number, name:string,
 *                     botCrowId:string, notified:boolean, error?:string}>}
 * @throws on a malformed invite code or a failed INSERT — the callers render that.
 */
export async function acceptBotInvite(db, managers, { inviteCode, displayName, advertisedByInstanceId, isBot } = {}) {
  const { syncManager, nostrManager, identity } = managers || {};
  const bot = parseBotInviteCode(String(inviteCode || "").trim());
  // Prefer an explicit name, else the friendly name the owner put in the invite,
  // else the raw crow: id.
  const name = displayName || bot.name || bot.botCrowId;

  const existing = await db.execute({
    sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [bot.botCrowId],
  });

  let contactId;
  let outcome;
  if (existing.rows.length > 0) {
    // Already a contact: reuse the row, emit nothing. The callers keep their
    // markContactIsBot on this branch.
    contactId = Number(existing.rows[0].id);
    outcome = "existing";
  } else {
    outcome = "created";
    // THE one place the classification is decided. An advertiser means: this bot
    // came out of that instance's directory (a FACT, portable and true everywhere)
    // ⇒ it is advertised, and it is garbage-collectable when that instance stops
    // advertising it. No advertiser means none of those things.
    const advertisedBy = advertisedByInstanceId ? String(advertisedByInstanceId) : null;
    // BOT-NESS AND PRUNABILITY ARE DIFFERENT FACTS (R5/MAJOR-3). Deriving `is_bot` from
    // `advertisedBy` conflates them, and provenance resolution is genuinely fallible: the
    // advertised-bots cache expires after 60 s and any peer can exceed the 2 s directory
    // timeout, so a bot the user clicked in the BOT DIRECTORY can arrive here with a null
    // advertiser. Deriving bot-ness from that would land `is_bot=0`: unbadged in the UI,
    // AND swept into `backfillContactsOnce` (which filters `is_bot = 0`) to be re-emitted
    // as an `update` on every boot. So the directory handlers assert `isBot` explicitly and
    // an unresolvable advertiser costs only PRUNABILITY (advertised_by=NULL — the fail-safe
    // direction). The MCP/pasted-invite path passes neither ⇒ `is_bot=0`, exactly as before.
    const isBotFlag = isBot === true || advertisedBy ? 1 : 0;
    const result = await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey,
                                  origin, is_bot, advertised_by_instance_id)
            VALUES (?,?,?,?,?,?,?)`,
      args: [
        bot.botCrowId, name, bot.ed25519Pubkey, bot.secp256k1Pubkey,
        advertisedBy ? "advertised" : null,
        isBotFlag,
        advertisedBy,
      ],
    });
    contactId = Number(result.lastInsertRowid);

    try { await syncManager.initContact(contactId, null); } catch { /* bot has no hypercore feed; non-fatal */ }
    // Subscribe to the bot's replies over Nostr (new contact only — existing
    // contacts already have a live subscription from their first accept or from
    // restart, so re-subscribing would leak a handle per relay).
    try {
      await nostrManager.subscribeToContact({
        id: contactId, crowId: bot.botCrowId, secp256k1_pubkey: bot.secp256k1Pubkey,
      });
    } catch { /* non-fatal — re-subscribed on next restart */ }

    // Phase 3: an accepted remote bot is a real cross-instance contact — propagate
    // it to the user's other instances, ALREADY CLASSIFIED. Exactly one emit.
    try {
      const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] });
      if (rows[0]) {
        // D3.2: a local re-add supersedes any tombstone for this bot's crowId.
        await clearTombstone(db, bot.botCrowId);
        await emitContactChange("insert", rows[0]);
      }
    } catch { /* never blocks the accept */ }
  }

  // Tell the bot we accepted (carries the token it validates). Failing to reach it
  // is NOT a failure of the accept: the contact is added either way, and the bot
  // authorizes us when it next comes online.
  try {
    if (nostrManager.relays.size === 0) await nostrManager.connectRelays();
    await nostrManager.sendMessage(
      { secp256k1_pubkey: bot.secp256k1Pubkey },
      buildBotAcceptPayload(bot.token, identity, name),
    );
  } catch (err) {
    return { ok: true, outcome, contactId, name, botCrowId: bot.botCrowId, notified: false, error: err.message };
  }

  return { ok: true, outcome, contactId, name, botCrowId: bot.botCrowId, notified: true };
}
