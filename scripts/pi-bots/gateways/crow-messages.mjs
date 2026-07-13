/**
 * Crow Messages gateway adapter (pi-bots host-managed, like telegram/slack).
 * A bot is reachable under its own derived Nostr identity; authorized senders'
 * DMs drive the real pi bridge (handleInbound) and the bot replies from its key.
 */
import { loadInstanceSeed, deriveBotIdentity } from "../../../servers/sharing/identity.js";
import { chunkedSend, SerialQueue } from "./base.mjs";
import * as cmStore from "./crow-messages-store.mjs";
import { xOnly, buildDM, openDM, connectRelays, subscribeResilient, publish, makeDedupeGate } from "./nostr-client.mjs";

export const type = "crow-messages";
export const mode = "nostr";
export const configFields = []; // custom Share/manage UI ships in Plan 2

export function gatewayHint(threadId) {
  return "\nGATEWAY: crow-messages — your reply text is delivered over Crow Messages automatically. "
    + "Do NOT use gmail tools. (thread ref: " + threadId + ")";
}

/**
 * The adapter's seed + bot-identity derivation, exported so the parity test can
 * hold THIS module to the admin panel's botIdentityFor — they must derive from
 * the same seed anchor or invites minted by one are unverifiable against the
 * other. start() routes through adapterSeed() too, so the test constrains the
 * live path, not a copy. Seed comes from the INSTANCE data dir
 * (instanceSeedDir() = resolveDataDir()), never from dirname(CROW_DB_PATH):
 * the DB may legitimately live outside the instance dir (grackle's
 * symlinked-DB layout).
 */
export async function adapterSeed() {
  const { instanceSeedDir } = await import("../instance-paths.mjs");
  return loadInstanceSeed(instanceSeedDir());
}

export async function adapterBotIdentity(botId) {
  return deriveBotIdentity(await adapterSeed(), botId);
}

export async function checkRequirements() {
  try { await import("nostr-tools/pure"); return true; } catch { return false; }
}

/**
 * Core router for one decrypted inbound DM. Dependency-injected for testing.
 * @returns {Promise<void>}
 */
export async function handleCrowMessageEvent({
  botId, senderPubkey, decrypted, db, handleInbound, sendDM, log, allowPaired = false,
  hostXOnly = null, botDisplayName = null, botCrowId = null, sendRoomReply = null,
}) {
  const pk = xOnly(senderPubkey); // the cryptographically-verified signer of the event
  // Control message?
  if (typeof decrypted === "string" && decrypted.startsWith("{")) {
    let payload = null;
    try { payload = JSON.parse(decrypted); } catch { payload = null; }
    if (payload && payload.type === "crow_social" && payload.subtype === "room_message") {
      // Trust: accept room traffic ONLY from our own host instance (the signer of
      // this DM). Payload fields (author/host_crow_id) are LABELS, never trusted.
      if (!hostXOnly || pk !== xOnly(hostXOnly)) { log("room drop: signer!=host bot=" + botId); return; }
      const p = payload.payload || {};
      const author = p.author || {};
      // Loop-safety: react ONLY to human-authored messages.
      if (author.kind !== "human") return;
      // Addressing: the host already encoded the mode decision into addressed_to
      // (all bots in 'always' mode, matched bots otherwise). We only check membership.
      const me = String(botDisplayName || "").toLowerCase();
      const addressed = Array.isArray(p.addressed_to) ? p.addressed_to.map((s) => String(s).toLowerCase()) : [];
      if (!me || !addressed.includes(me)) return;
      await handleInbound({
        bot_id: botId,
        gateway_thread_id: "crow-room:" + p.room_uid,
        user_message: p.text || "",
        gateway_type: "crow-messages",
        sendReply: async (text) => { if (sendRoomReply) await sendRoomReply(p.room_uid, p.room_name, text); },
        log: (m) => log("  [bridge:" + botId + "] " + m),
      });
      return;
    }
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
  // Plain chat → authorize (ACL-only in Plan 1, allowPaired in Plan 2) then run a turn.
  if (!cmStore.authorizeSender(db, botId, pk, allowPaired)) { log("drop unauthorized bot=" + botId + " sender=" + pk); return; }
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
  const Database = (await import("better-sqlite3")).default;
  const { botsDbPath } = await import("../instance-paths.mjs"); // CROW_DB resolver used by gateway_runner
  const { handleInbound: realHandleInbound } = await import("../bridge.mjs");
  const dbPath = botsDbPath();
  const db = new Database(dbPath); db.pragma("busy_timeout = 10000");

  // Seed anchor rationale: see adapterSeed() above. Hosts that run bots
  // against a different instance's DB keep the anchors aligned because
  // install-runtime.sh always writes CROW_DATA_DIR into the pibot env files.
  let seed;
  try { seed = await adapterSeed(); }
  catch (e) { log("crow-messages bot=" + bot_id + " no instance seed: " + e.message); try { db.close(); } catch {} return { stop() {} }; }
  const botIdentity = deriveBotIdentity(seed, bot_id);

  const { deriveInstanceIdentity } = await import("../../../servers/sharing/identity.js");
  const hostIdentity = deriveInstanceIdentity(seed);
  const hostXOnly = xOnly(hostIdentity.secp256k1Pubkey);
  const botDisplayName = (() => {
    try { return db.prepare("SELECT display_name FROM pi_bot_defs WHERE bot_id=?").get(bot_id)?.display_name || bot_id; }
    catch { return bot_id; }
  })();
  const { randomBytes } = await import("node:crypto");

  const allowPaired = !!(gw && gw.allow_paired_instances);
  try { cmStore.pruneSeen(db); } catch { /* best-effort */ }
  const relays = await connectRelays(cmStore.resolveRelays(db));
  const botXOnly = xOnly(botIdentity.secp256k1Pubkey);
  const queue = new SerialQueue({ maxDepth: 5, log, handler: (job) => job() });
  const isNew = makeDedupeGate(); // collapse the same event arriving from N relays (in-process)
  const since = Math.floor(Date.now() / 1000) - 86400; // don't replay >24h of relay history

  const subResilient = subscribeResilient(relays, { kinds: [4], "#p": [botXOnly] }, (event) => {
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
      allowPaired,
      hostXOnly,
      botDisplayName,
      botCrowId: botIdentity.crowId,
      sendRoomReply: async (roomUid, roomName, text) => {
        // Reply to the HOST as a bot-authored room_message; one envelope per chunk,
        // each with its own msg_uid so the host dedups + relays each bubble.
        await chunkedSend(async (chunk) => {
          const env = JSON.stringify({
            type: "crow_social", version: 1, subtype: "room_message",
            payload: {
              room_uid: roomUid, room_name: roomName, host_crow_id: hostIdentity.crowId,
              msg_uid: randomBytes(16).toString("hex"),
              author: { kind: "bot", crow_id: botIdentity.crowId, display_name: botDisplayName },
              text: chunk, addressed_to: [], ts: new Date().toISOString(),
            },
          });
          const ev = buildDM(botIdentity.secp256k1Priv, hostXOnly, env);
          await publish(relays, ev);
        }, text, { log });
      },
    }).catch((e) => log("event handler error: " + (e && e.message))));
  }, { initialSince: since });

  log("crow-messages bot=" + bot_id + " listening as " + botIdentity.crowId + " on " + relays.size + " relay(s)");
  const healthMs = Number(process.env.PIBOT_NOSTR_HEALTH_MS) || 45000;
  const healthTimer = setInterval(() => { subResilient.ensureAllHealthy().catch(() => {}); }, healthMs);
  if (healthTimer.unref) healthTimer.unref();
  return {
    stop() {
      try { clearInterval(healthTimer); } catch {}
      try { subResilient.stop(); } catch {}
      for (const [, relay] of relays) { try { relay.close(); } catch {} }
      try { db.close(); } catch {}
    },
  };
}

export default { type, mode, configFields, gatewayHint, checkRequirements, start, handleCrowMessageEvent };
