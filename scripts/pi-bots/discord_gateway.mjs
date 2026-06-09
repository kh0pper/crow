#!/usr/bin/env node
/**
 * Crow Bot Builder — Discord gateway (long-lived WebSocket process).
 *
 * The Discord analogue of bridge_tick.mjs. Where Gmail polls every minute and
 * drives handleInbound() per un-processed thread, Discord holds a persistent
 * discord.js WebSocket per bot and drives handleInbound() on each inbound
 * messageCreate. Same transport-agnostic contract:
 *   handleInbound({ bot_id, gateway_thread_id, user_message, sendReply, log,
 *                   gateway_type: "discord" })
 *
 * Runs as Type=simple (pibot-discord.service), alongside the Gmail
 * pibot-bridge.timer — they watch different gateway types in pi_bot_defs and
 * never contend. crow.db opened with busy_timeout only, NO journal_mode pragma
 * (same established pattern as bridge.mjs / bridge_tick.mjs).
 *
 * Design (plan §1.2):
 *  - One discord.js Client per discord-gateway bot, token from gateways[0].token
 *  - Per-bot FIFO queue (max depth 5) — pi sessions run serially per bot; a
 *    full queue replies "still working" and drops the message
 *  - Typing indicator on a 9s interval while a turn runs (Discord expires at 10s)
 *  - sendReply splits on newline boundaries at ~1990 chars (Discord 2000 limit),
 *    200ms between chunks (rate-limit courtesy; discord.js handles REST limits)
 *  - allowlist (Discord user IDs) is the security boundary; optional channel_ids
 *  - MessageManager cache capped at 50 to bound memory
 *  - Graceful SIGTERM: destroy all clients
 */
import Database from "better-sqlite3";
import { Client, GatewayIntentBits, Partials, Options } from "discord.js";
import { handleInbound } from "./bridge.mjs";
// A1: shared gateway helpers (one definition, one test surface). These were
// extracted verbatim from this file, so importing them is behavior-preserving.
import { chunkedSend, downloadImages, passesAllowlist, SerialQueue, typingHeartbeat } from "./gateways/base.mjs";
import { botsDbPath } from "./instance-paths.mjs";

const HOME = "/home/kh0pp";
const CROW_DB = botsDbPath();
const MAX_QUEUE = 5;
const CHUNK_LIMIT = 1990;        // safe margin under Discord's 2000-char hard limit
const CHUNK_DELAY_MS = 200;      // courtesy delay between message chunks
const TYPING_INTERVAL_MS = 9000; // re-trigger typing before its 10s expiry
const MAX_IMAGES = 4;            // cap images per turn
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // skip attachments larger than this

function log(msg) {
  // journal captures stdout; prefix mirrors bridge_tick's "[tick]" convention.
  console.log("[discord] " + msg);
}
function db() { const d = new Database(CROW_DB); d.pragma("busy_timeout = 10000"); return d; }

// Read enabled bots that declare a discord gateway with a token.
function loadDiscordBots() {
  const d = db();
  let rows = [];
  try {
    rows = d.prepare("SELECT bot_id, definition FROM pi_bot_defs WHERE enabled=1").all();
  } catch {
    d.close();
    return [];
  }
  d.close();
  const bots = [];
  for (const row of rows) {
    let def;
    try { def = JSON.parse(row.definition || "{}"); } catch { continue; }
    const gw = (def.gateways || []).find((g) => g.type === "discord" && g.token);
    if (!gw) continue;
    bots.push({
      bot_id: row.bot_id,
      token: gw.token,
      guild_id: gw.guild_id || null,
      channel_ids: Array.isArray(gw.channel_ids) ? gw.channel_ids.filter(Boolean) : [],
      allowlist: Array.isArray(gw.allowlist) ? gw.allowlist.filter(Boolean) : [],
    });
  }
  return bots;
}

// splitMessage / postReply / guessMime / downloadImages were extracted to
// gateways/base.mjs (A1). postReply is now chunkedSend over channel.send;
// downloadImages takes Discord attachment objects directly (their {url,size,
// name,contentType} fields match the normalized shape base expects).
function postReply(channel, text) {
  return chunkedSend((c) => channel.send(c), text, { limit: CHUNK_LIMIT, delayMs: CHUNK_DELAY_MS, log });
}

const clients = [];

function startBot(bot) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged — must be enabled in the Dev Portal
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message], // required to receive DMs
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 50, // bound memory (plan §1.5)
    }),
  });
  client._botId = bot.bot_id;

  // Per-bot serial queue: at most one pi turn at a time for this bot (A1:
  // SerialQueue from gateways/base.mjs; runTurn is its handler).
  async function runTurn(job) {
    const { message } = job;
    const channel = message.channel;
    const gateway_thread_id = "discord:" + message.channelId; // thread channels carry their own id
    const beat = typingHeartbeat(() => { channel.sendTyping().catch(() => {}); }, TYPING_INTERVAL_MS);
    try {
      // Download any image attachments and pass them as pi ImageContent so the
      // vision model can read them (e.g. receipts). Non-fatal on failure.
      let images;
      if (job.imgAtts && job.imgAtts.length) {
        images = await downloadImages(job.imgAtts, { max: MAX_IMAGES, maxBytes: MAX_IMAGE_BYTES, log });
        if (images.length) log("attached " + images.length + " image(s) to turn bot=" + bot.bot_id);
      }
      const r = await handleInbound({
        bot_id: bot.bot_id,
        gateway_thread_id,
        user_message: job.content,
        gateway_type: "discord",
        images: images && images.length ? images : undefined,
        sendReply: async (text) => { beat.stop(); await postReply(channel, text); },
        log: (m) => log("  [bridge:" + bot.bot_id + "] " + m),
      });
      log("turn done bot=" + bot.bot_id + " thread=" + gateway_thread_id + " action=" + (r && r.action));
    } catch (e) {
      log("handleInbound failed bot=" + bot.bot_id + " thread=" + gateway_thread_id + ": " + (e && e.message || e));
      try { await postReply(channel, "Something went wrong on my end. Try again in a moment."); } catch {}
    } finally {
      beat.stop();
    }
  }

  const queue = new SerialQueue({
    maxDepth: MAX_QUEUE,
    handler: runTurn,
    log: (m) => log("bot=" + bot.bot_id + " " + m),
    onFull: (job) => {
      log("queue full bot=" + bot.bot_id + " — dropping inbound");
      job.message.channel.send("I'm still working on something — try again in a minute.").catch(() => {});
    },
  });

  client.on("messageCreate", (message) => {
    try {
      if (message.author.bot) return;                         // ignore bots (incl. self)
      const senderId = message.author.id;
      if (!passesAllowlist(senderId, bot.allowlist)) {
        log("drop bot=" + bot.bot_id + " sender=" + senderId + " not in allowlist");
        return;
      }
      if (bot.channel_ids.length && !bot.channel_ids.includes(message.channelId)) {
        return;                                               // restricted to specific channels
      }
      let content = (message.content || "").trim();
      const atts = message.attachments ? [...message.attachments.values()] : [];
      const imgAtts = atts.filter((a) =>
        /^image\//.test(a.contentType || "") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.name || a.url || ""));
      if (!content) {
        // No text body. A receipt photo (image attachment, no caption) lands
        // here — the model is vision-capable, so pass the image through (below)
        // and give it a sensible default instruction.
        if (imgAtts.length) {
          content = "(The user sent " + imgAtts.length + " image(s) with no caption. If it is a receipt, "
            + "read it and log the expense + stock the pantry per the household-kitchen skill; otherwise "
            + "describe what you see and ask what they'd like done.)";
        } else if (atts.length) {
          const names = atts.map((a) => a.name || a.url).join(", ");
          log("non-image attachment-only message bot=" + bot.bot_id + " from=" + senderId + " atts=[" + names + "]");
          content = "[The user sent attachment(s) you cannot read (not images): " + names
            + ". Ask them to type the details.]";
        } else {
          log("empty message dropped bot=" + bot.bot_id + " from=" + senderId + " (no text, no attachments)");
          return;
        }
      }
      if (imgAtts.length) log("image message bot=" + bot.bot_id + " from=" + senderId + " images=" + imgAtts.length);

      // SerialQueue enforces MAX_QUEUE + the "still working" onFull reply.
      queue.push({ message, content, imgAtts });
    } catch (e) {
      log("messageCreate handler error bot=" + bot.bot_id + ": " + (e && e.message || e));
    }
  });

  client.once("clientReady", (c) => log("connected to Discord as " + c.user.tag + " (bot=" + bot.bot_id + ")"));
  client.on("error", (e) => log("client error bot=" + bot.bot_id + ": " + (e && e.message || e)));
  client.on("warn", (m) => log("client warn bot=" + bot.bot_id + ": " + m));
  client.on("shardDisconnect", (ev) => log("shard disconnect bot=" + bot.bot_id + " code=" + (ev && ev.code)));
  client.on("shardReconnecting", () => log("shard reconnecting bot=" + bot.bot_id));

  client.login(bot.token).catch((e) => log("login failed bot=" + bot.bot_id + ": " + (e && e.message || e)));
  clients.push(client);
}

function shutdown() {
  log("SIGTERM — destroying " + clients.length + " client(s)");
  for (const c of clients) { try { c.destroy(); } catch {} }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

(function main() {
  const bots = loadDiscordBots();
  if (!bots.length) {
    log("no enabled bots with a discord gateway — idle (service stays up; restart after adding one)");
    // Stay alive so systemd doesn't flap on Restart=on-failure; a config change
    // + service restart picks up new bots (Phase 1 hot-reload = restart).
    setInterval(() => {}, 1 << 30);
    return;
  }
  log("starting " + bots.length + " discord bot(s): " + bots.map((b) => b.bot_id).join(", "));
  for (const b of bots) startBot(b);
})();
