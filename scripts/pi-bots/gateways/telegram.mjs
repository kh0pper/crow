#!/usr/bin/env node
/**
 * Crow Bot Builder — Telegram gateway adapter (Hermes-parity, A2).
 *
 * Telegram analogue of discord_gateway.mjs. Uses telegraf in LONG-POLL mode
 * (the node dials OUT to api.telegram.org/getUpdates) so there is NO inbound
 * HTTP endpoint to expose — this sidesteps Crow's Tailscale-Funnel network
 * invariant entirely. Same transport-agnostic contract as every other gateway:
 *   handleInbound({ bot_id, gateway_thread_id, user_message, sendReply, log,
 *                   gateway_type: "telegram", images })
 *
 * telegraf is imported LAZILY inside start()/checkRequirements() so a bot
 * builder that never configures a Telegram gateway doesn't pay for the dep,
 * and a missing/broken telegraf disables only this gateway (checkRequirements
 * returns false), never the whole host.
 *
 * The adapter is driven by gateway_runner.mjs: the runner scans pi_bot_defs,
 * and for each gateways[] entry of type "telegram" calls start({bot_id, gw,
 * log}). gw is that gateway entry: { type:"telegram", token, allowlist?[],
 * chat_ids?[] }. allowlist (Telegram numeric user ids) is the security
 * boundary; chat_ids optionally restricts to specific chats.
 */
import { handleInbound } from "../bridge.mjs";
import { chunkedSend, downloadImages, passesAllowlist, SerialQueue, typingHeartbeat } from "./base.mjs";

const CHUNK_LIMIT = 4096;        // Telegram hard message limit
const CHUNK_DELAY_MS = 200;
const TYPING_INTERVAL_MS = 4000; // Telegram "typing" action lasts ~5s
const MAX_QUEUE = 5;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export const type = "telegram";
export const mode = "longpoll";

/** Field schema for the Bot Builder UI (A4 / registry capabilitiesForUI). */
export const configFields = [
  { key: "token", label: "Bot token (@BotFather)", secret: true, required: true },
  { key: "allowlist", label: "Allowed Telegram user IDs", type: "list", help: "Empty = allow anyone who can reach the bot" },
  { key: "chat_ids", label: "Restrict to chat IDs (optional)", type: "list" },
];

/** Per-turn prompt hint (registry, A1.3). Reply auto-delivered like Discord. */
export function gatewayHint(threadId) {
  return "\nGATEWAY: telegram — your reply text is sent to the Telegram chat automatically. "
    + "Do NOT use gmail tools. (thread ref: " + threadId + ")";
}

/** Lazy probe: is telegraf importable? Used by the host to skip cleanly. */
export async function checkRequirements() {
  try { await import("telegraf"); return true; }
  catch { return false; }
}

// Map a Telegram message's image attachments to the normalized shape
// downloadImages() expects ({ url, name?, contentType? }). Largest photo size
// + any image/* document. Needs the telegram client to resolve file links.
async function collectImages(telegram, msg, log) {
  const atts = [];
  try {
    if (Array.isArray(msg.photo) && msg.photo.length) {
      const largest = msg.photo[msg.photo.length - 1]; // sizes are ascending
      const link = await telegram.getFileLink(largest.file_id);
      atts.push({ url: String(link.href || link), name: "photo.jpg", contentType: "image/jpeg" });
    }
    const doc = msg.document;
    if (doc && /^image\//.test(doc.mime_type || "")) {
      const link = await telegram.getFileLink(doc.file_id);
      atts.push({ url: String(link.href || link), name: doc.file_name || "image", contentType: doc.mime_type });
    }
  } catch (e) { log("image link resolve failed: " + ((e && e.message) || e)); }
  return atts;
}

/**
 * Start one Telegram bot. Returns { stop } to tear it down.
 * @param {{ bot_id:string, gw:object, log:(m:string)=>void }} args
 */
export async function start({ bot_id, gw, log }) {
  const { Telegraf } = await import("telegraf");
  const token = gw && gw.token;
  if (!token) { log("telegram bot=" + bot_id + " has no token — skipped"); return { stop() {} }; }
  const allow = (Array.isArray(gw.allowlist) ? gw.allowlist : []).map(String).filter(Boolean);
  const chatIds = (Array.isArray(gw.chat_ids) ? gw.chat_ids : []).map(String).filter(Boolean);

  const tg = new Telegraf(token);

  async function runTurn(job) {
    const { ctx, content, msg } = job;
    const chatId = ctx.chat.id;
    const gateway_thread_id = "telegram:" + chatId;
    const beat = typingHeartbeat(() => { ctx.telegram.sendChatAction(chatId, "typing").catch(() => {}); }, TYPING_INTERVAL_MS);
    try {
      let images;
      const atts = await collectImages(ctx.telegram, msg, log);
      if (atts.length) {
        images = await downloadImages(atts, { max: MAX_IMAGES, maxBytes: MAX_IMAGE_BYTES, log });
        if (images.length) log("attached " + images.length + " image(s) to turn bot=" + bot_id);
      }
      const r = await handleInbound({
        bot_id,
        gateway_thread_id,
        user_message: content,
        gateway_type: "telegram",
        images: images && images.length ? images : undefined,
        sendReply: async (text) => {
          beat.stop();
          await chunkedSend((c) => ctx.telegram.sendMessage(chatId, c), text, { limit: CHUNK_LIMIT, delayMs: CHUNK_DELAY_MS, log });
        },
        log: (m) => log("  [bridge:" + bot_id + "] " + m),
      });
      log("turn done bot=" + bot_id + " thread=" + gateway_thread_id + " action=" + (r && r.action));
    } catch (e) {
      log("handleInbound failed bot=" + bot_id + " thread=" + gateway_thread_id + ": " + ((e && e.message) || e));
      try { await ctx.telegram.sendMessage(ctx.chat.id, "Something went wrong on my end. Try again in a moment."); } catch {}
    } finally {
      beat.stop();
    }
  }

  const queue = new SerialQueue({
    maxDepth: MAX_QUEUE,
    handler: runTurn,
    log: (m) => log("bot=" + bot_id + " " + m),
    onFull: (job) => {
      log("queue full bot=" + bot_id + " — dropping inbound");
      job.ctx.telegram.sendMessage(job.ctx.chat.id, "I'm still working on something — try again in a minute.").catch(() => {});
    },
  });

  tg.on("message", (ctx) => {
    try {
      const msg = ctx.message || {};
      const senderId = ctx.from ? String(ctx.from.id) : "";
      if (!passesAllowlist(senderId, allow)) {
        log("drop bot=" + bot_id + " sender=" + senderId + " not in allowlist");
        return;
      }
      if (chatIds.length && !chatIds.includes(String(ctx.chat.id))) return; // restricted chats
      let content = (msg.text || msg.caption || "").trim();
      const hasPhoto = Array.isArray(msg.photo) && msg.photo.length;
      const isImgDoc = msg.document && /^image\//.test(msg.document.mime_type || "");
      if (!content) {
        if (hasPhoto || isImgDoc) {
          content = "(The user sent an image with no caption. If it is a receipt, read it and act per your "
            + "skills; otherwise describe what you see and ask what they'd like done.)";
        } else if (msg.document) {
          content = "[The user sent a file you cannot read (not an image): " + (msg.document.file_name || "file")
            + ". Ask them to type the details.]";
          log("non-image document-only message bot=" + bot_id + " from=" + senderId);
        } else {
          log("empty/unsupported message dropped bot=" + bot_id + " from=" + senderId);
          return;
        }
      }
      queue.push({ ctx, content, msg });
    } catch (e) {
      log("message handler error bot=" + bot_id + ": " + ((e && e.message) || e));
    }
  });

  tg.catch((err) => log("telegraf error bot=" + bot_id + ": " + ((err && err.message) || err)));

  // launch() resolves only after the long-poll loop ends, so don't await it.
  tg.launch().then(() => log("telegram long-poll ended bot=" + bot_id))
    .catch((e) => log("telegram launch failed bot=" + bot_id + ": " + ((e && e.message) || e)));
  log("started telegram bot=" + bot_id + (allow.length ? " (allowlist " + allow.length + ")" : " (open)"));

  return { stop() { try { tg.stop("SIGTERM"); } catch {} } };
}

export default { type, mode, configFields, gatewayHint, checkRequirements, start };
