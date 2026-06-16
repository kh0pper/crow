/**
 * Crow Messages gateway adapter (pi-bots host-managed, like telegram/slack).
 * A bot is reachable under its own derived Nostr identity; authorized senders'
 * DMs drive the real pi bridge (handleInbound) and the bot replies from its key.
 */
import { loadInstanceSeed, deriveBotIdentity } from "../../../servers/sharing/identity.js";
import { handleInbound as realHandleInbound } from "../bridge.mjs";
import { chunkedSend, SerialQueue } from "./base.mjs";
import * as cmStore from "./crow-messages-store.mjs";
import { xOnly, buildDM, openDM, connectRelays, subscribe, publish, makeDedupeGate } from "./nostr-client.mjs";

export const type = "crow-messages";
export const mode = "nostr";
export const configFields = []; // custom Share/manage UI ships in Plan 2

export function gatewayHint(threadId) {
  return "\nGATEWAY: crow-messages — your reply text is delivered over Crow Messages automatically. "
    + "Do NOT use gmail tools. (thread ref: " + threadId + ")";
}

export async function checkRequirements() {
  try { await import("nostr-tools/pure"); return true; } catch { return false; }
}

/**
 * Core router for one decrypted inbound DM. Dependency-injected for testing.
 * @returns {Promise<void>}
 */
export async function handleCrowMessageEvent({ botId, senderPubkey, decrypted, db, handleInbound, sendDM, log }) {
  const pk = xOnly(senderPubkey); // the cryptographically-verified signer of the event
  // Control message?
  if (typeof decrypted === "string" && decrypted.startsWith("{")) {
    let payload = null;
    try { payload = JSON.parse(decrypted); } catch { payload = null; }
    if (payload && payload.type === "crow_social" && payload.subtype === "bot_invite_accept") {
      // Idempotent re-accept: an already-authorized sender (e.g. a second device,
      // or a duplicate that slipped the gate) just gets re-acked, no token burn.
      if (!cmStore.authorizeSender(db, botId, pk)) {
        if (!cmStore.consumeInvite(db, botId, payload.token)) { log("invite reject bot=" + botId + " sender=" + pk); return; }
        const s = payload.sender || {};
        // Key the ACL on `pk` (the SIGNED event pubkey) — never the sender-claimed
        // key — so future chats (authorized by event.pubkey) match and a malicious
        // accept can't authorize a third party. Claimed fields are labels only.
        cmStore.upsertAclFromAccept(db, botId, pk, s.crow_id || null, s.display_name || null);
        log("invite accept bot=" + botId + " sender=" + pk);
      }
      try { await sendDM(pk, "You can chat with this bot now."); } catch { /* ack best-effort */ }
      return;
    }
    // Unknown control payloads are ignored (no turn).
    if (payload && payload.type) return;
  }
  // Plain chat → authorize (ACL-only in Plan 1) then run a turn.
  if (!cmStore.authorizeSender(db, botId, pk)) { log("drop unauthorized bot=" + botId + " sender=" + pk); return; }
  await handleInbound({
    bot_id: botId,
    gateway_thread_id: "crow-messages:" + pk,
    user_message: decrypted,
    gateway_type: "crow-messages",
    sendReply: async (text) => { await sendDM(pk, text); },
    log: (m) => log("  [bridge:" + botId + "] " + m),
  });
}

export async function start({ bot_id, gw, log }) {
  const { dirname } = await import("node:path");
  const Database = (await import("better-sqlite3")).default;
  const { botsDbPath } = await import("../instance-paths.mjs"); // CROW_DB resolver used by gateway_runner
  const dbPath = botsDbPath();
  const db = new Database(dbPath); db.pragma("busy_timeout = 10000");

  // Derive the bot key from the SAME instance dir the DB lives in (avoids the
  // CROW_DATA_DIR/CROW_DB_PATH split-brain — see loadInstanceSeed).
  let seed;
  try { seed = loadInstanceSeed(dirname(dbPath)); }
  catch (e) { log("crow-messages bot=" + bot_id + " no instance seed: " + e.message); try { db.close(); } catch {} return { stop() {} }; }
  const botIdentity = deriveBotIdentity(seed, bot_id);

  try { cmStore.pruneSeen(db); } catch { /* best-effort */ }
  const relays = await connectRelays(cmStore.resolveRelays(db));
  const botXOnly = xOnly(botIdentity.secp256k1Pubkey);
  const queue = new SerialQueue({ maxDepth: 5, log, handler: (job) => job() });
  const isNew = makeDedupeGate(); // collapse the same event arriving from N relays (in-process)
  const since = Math.floor(Date.now() / 1000) - 86400; // don't replay >24h of relay history

  const subs = subscribe(relays, { kinds: [4], "#p": [botXOnly], since }, (event) => {
    if (!isNew(event.id)) return; // already handled from another relay (same process)
    // Cross-restart dedup: a relay replays up to 24h on resubscribe; persisting
    // processed ids stops re-answering chats the bot already handled pre-restart.
    if (!cmStore.markEventSeen(db, bot_id, event.id)) return;
    let decrypted;
    try { decrypted = openDM(botIdentity.secp256k1Priv, event.pubkey, event.content); }
    catch { return; } // not for us / undecryptable
    queue.push(() => handleCrowMessageEvent({
      botId: bot_id, senderPubkey: event.pubkey, decrypted, db,
      handleInbound: realHandleInbound,
      sendDM: async (recipXOnly, text) => {
        await chunkedSend(async (chunk) => {
          const ev = buildDM(botIdentity.secp256k1Priv, recipXOnly, chunk);
          await publish(relays, ev);
        }, text, { log });
      },
      log,
    }).catch((e) => log("event handler error: " + (e && e.message))));
  });

  log("crow-messages bot=" + bot_id + " listening as " + botIdentity.crowId + " on " + relays.size + " relay(s)");
  return {
    stop() {
      for (const s of subs) { try { s.close(); } catch {} }
      for (const [, relay] of relays) { try { relay.close(); } catch {} }
      try { db.close(); } catch {}
    },
  };
}

export default { type, mode, configFields, gatewayHint, checkRequirements, start, handleCrowMessageEvent };
