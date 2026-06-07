#!/usr/bin/env node
/**
 * Crow Bot Builder — Slack gateway adapter (Hermes-parity, A2).
 *
 * Uses @slack/bolt in SOCKET MODE: the node opens an outbound WebSocket to
 * Slack (no inbound HTTP endpoint, no Events-API request URL to expose), so —
 * like Telegram long-poll — it never touches Crow's Tailscale-Funnel network
 * invariant. Same transport-agnostic contract:
 *   handleInbound({ bot_id, gateway_thread_id, user_message, sendReply, log,
 *                   gateway_type: "slack", images })
 *
 * @slack/bolt is imported LAZILY so the dep is only paid for when a Slack
 * gateway is configured, and a missing/broken bolt disables only this gateway.
 *
 * gw entry shape: { type:"slack", bot_token (xoxb-…), app_token (xapp-…,
 * connections:write), allowlist?[] (Slack user ids), channel_ids?[] }.
 * Socket Mode requires BOTH a bot token and an app-level token.
 *
 * Threading: replies go into the message's thread (thread_ts = the message's
 * own thread root) so a conversation stays in one Slack thread and maps to one
 * Crow session. Slack has no public bot "typing" API, so there is no typing
 * heartbeat here (unlike Discord/Telegram).
 */
import { handleInbound } from "../bridge.mjs";
import { chunkedSend, downloadImages, passesAllowlist, SerialQueue } from "./base.mjs";

const CHUNK_LIMIT = 3500;        // safe margin for a Slack message
const CHUNK_DELAY_MS = 200;
const MAX_QUEUE = 5;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export const type = "slack";
export const mode = "socket";

export const configFields = [
  { key: "bot_token", label: "Bot token (xoxb-…)", secret: true, required: true },
  { key: "app_token", label: "App-level token (xapp-…, connections:write)", secret: true, required: true },
  { key: "allowlist", label: "Allowed Slack user IDs", type: "list", help: "Empty = allow anyone in the workspace who can DM/@ the bot" },
  { key: "channel_ids", label: "Restrict to channel IDs (optional)", type: "list" },
];

export function gatewayHint(threadId) {
  return "\nGATEWAY: slack — your reply text is posted to the Slack thread automatically. "
    + "Do NOT use gmail tools. (thread ref: " + threadId + ")";
}

export async function checkRequirements() {
  try { await import("@slack/bolt"); return true; }
  catch { return false; }
}

// Slack file attachments (image/*) -> normalized shape for downloadImages.
// url_private_download needs an Authorization: Bearer <bot_token> header.
function collectImages(files) {
  const atts = [];
  for (const f of files || []) {
    if (!/^image\//.test(f.mimetype || "")) continue;
    atts.push({ url: f.url_private_download || f.url_private, size: f.size, name: f.name || "image", contentType: f.mimetype });
  }
  return atts;
}

/**
 * Start one Slack bot. Returns { stop }.
 * @param {{ bot_id:string, gw:object, log:(m:string)=>void }} args
 */
export async function start({ bot_id, gw, log }) {
  const { App } = await import("@slack/bolt");
  const botToken = gw && gw.bot_token;
  const appToken = gw && gw.app_token;
  if (!botToken || !appToken) { log("slack bot=" + bot_id + " missing bot_token/app_token — skipped"); return { stop() {} }; }
  const allow = (Array.isArray(gw.allowlist) ? gw.allowlist : []).map(String).filter(Boolean);
  const channelIds = (Array.isArray(gw.channel_ids) ? gw.channel_ids : []).map(String).filter(Boolean);

  const app = new App({ token: botToken, appToken, socketMode: true });

  async function runTurn(job) {
    const { message, client } = job;
    const channel = message.channel;
    const threadTs = message.thread_ts || message.ts;
    const gateway_thread_id = "slack:" + channel + ":" + threadTs;
    try {
      let images;
      const atts = collectImages(message.files);
      if (atts.length) {
        images = await downloadImages(atts, {
          max: MAX_IMAGES, maxBytes: MAX_IMAGE_BYTES, log,
          headers: { Authorization: "Bearer " + botToken },
        });
        if (images.length) log("attached " + images.length + " image(s) to turn bot=" + bot_id);
      }
      const r = await handleInbound({
        bot_id,
        gateway_thread_id,
        user_message: job.content,
        gateway_type: "slack",
        images: images && images.length ? images : undefined,
        sendReply: async (text) => {
          await chunkedSend(
            (c) => client.chat.postMessage({ channel, thread_ts: threadTs, text: c }),
            text, { limit: CHUNK_LIMIT, delayMs: CHUNK_DELAY_MS, log });
        },
        log: (m) => log("  [bridge:" + bot_id + "] " + m),
      });
      log("turn done bot=" + bot_id + " thread=" + gateway_thread_id + " action=" + (r && r.action));
    } catch (e) {
      log("handleInbound failed bot=" + bot_id + " thread=" + gateway_thread_id + ": " + ((e && e.message) || e));
      try { await client.chat.postMessage({ channel, thread_ts: threadTs, text: "Something went wrong on my end. Try again in a moment." }); } catch {}
    }
  }

  const queue = new SerialQueue({
    maxDepth: MAX_QUEUE,
    handler: runTurn,
    log: (m) => log("bot=" + bot_id + " " + m),
    onFull: (job) => {
      log("queue full bot=" + bot_id + " — dropping inbound");
      job.client.chat.postMessage({ channel: job.message.channel, thread_ts: job.message.thread_ts || job.message.ts, text: "I'm still working on something — try again in a minute." }).catch(() => {});
    },
  });

  app.message(async ({ message, client }) => {
    try {
      // Only plain user messages: skip edits, joins, and any bot/self message.
      if (message.subtype || message.bot_id) return;
      const senderId = message.user ? String(message.user) : "";
      if (!passesAllowlist(senderId, allow)) {
        log("drop bot=" + bot_id + " sender=" + senderId + " not in allowlist");
        return;
      }
      if (channelIds.length && !channelIds.includes(String(message.channel))) return;
      let content = (message.text || "").trim();
      const atts = collectImages(message.files);
      if (!content) {
        if (atts.length) {
          content = "(The user sent an image with no caption. If it is a receipt, read it and act per your "
            + "skills; otherwise describe what you see and ask what they'd like done.)";
        } else {
          log("empty/unsupported message dropped bot=" + bot_id + " from=" + senderId);
          return;
        }
      }
      queue.push({ message, client, content });
    } catch (e) {
      log("message handler error bot=" + bot_id + ": " + ((e && e.message) || e));
    }
  });

  app.error(async (err) => { log("bolt error bot=" + bot_id + ": " + ((err && err.message) || err)); });

  await app.start();
  log("started slack bot=" + bot_id + (allow.length ? " (allowlist " + allow.length + ")" : " (open)"));

  return { async stop() { try { await app.stop(); } catch {} } };
}

export default { type, mode, configFields, gatewayHint, checkRequirements, start };
