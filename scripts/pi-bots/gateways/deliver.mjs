#!/usr/bin/env node
/**
 * Crow Bot Builder — background-job result delivery (Plan B Part 1 Stage 2).
 *
 * A completed bot_job's result text has to land SOMEWHERE. The transport-free
 * destinations (Crow memory, poll) are handled inline in job_runner.deliverResult.
 * This module owns the CHANNEL destinations — Gmail and the socket gateways
 * (Discord / Telegram / Slack).
 *
 * Q2 resolution (corrects the reviewed plan's premise): sending a message on
 * Discord/Telegram/Slack is a STATELESS authenticated REST call — the persistent
 * gateway WebSocket is only needed to RECEIVE inbound. So delivery does NOT
 * require the live in-memory receive-transport, and need not run inside the
 * specific host process that holds it (which matters because Discord lives in
 * its OWN process, pibot-discord.service, NOT the pibot-gateways host the plan
 * named). We reuse each SDK's REST primitive (telegraf `.telegram`, @slack/web-api
 * `WebClient`, discord.js `REST`) so any job-runner process can deliver to any
 * channel given the bot's token. Gmail uses the gmail_io.mjs CLI (works anywhere).
 *
 * makeChannelDeliverer() returns the `deliverChannel(job, spec, text)` callback
 * job_runner.tickJobs threads into deliverResult. Both the pibot-gateways host
 * and the Gmail bridge_tick drain inject the same one — whichever atomically
 * claims a job delivers it.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { chunkedSend } from "./base.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts/pi-bots/gateways
const GIO = join(HERE, "..", "gmail_io.mjs");

// Per-platform hard message limits (mirrors each adapter's CHUNK_LIMIT).
const CHUNK = { discord: 1990, telegram: 4096, slack: 3500 };
const CHUNK_DELAY_MS = 200;

/**
 * Parse a gateway_thread_id into its platform routing target. PURE — mirrors the
 * exact id shapes the adapters emit:
 *   discord  → "discord:" + channelId                 (discord_gateway.mjs:111)
 *   telegram → "telegram:" + chatId                   (telegram.mjs:91)
 *   slack    → "slack:" + channel + ":" + threadTs    (slack.mjs:82)
 * Tolerates a bare id (no type prefix) defensively.
 */
export function parseThread(type, threadId) {
  const s = String(threadId || "");
  const strip = (p) => (s.startsWith(p) ? s.slice(p.length) : s);
  if (type === "discord") return { channelId: strip("discord:") };
  if (type === "telegram") return { chatId: strip("telegram:") };
  if (type === "slack") {
    const rest = strip("slack:");
    const i = rest.indexOf(":");
    return i < 0 ? { channel: rest, threadTs: undefined }
                 : { channel: rest.slice(0, i), threadTs: rest.slice(i + 1) };
  }
  return {};
}

/** The bot's gateways[] entry for a type — the token carrier. */
export function findGatewayDef(botDef, type) {
  const gws = (botDef && botDef.gateways) || [];
  return gws.find((g) => g && g.type === type) || null;
}

/**
 * Send `text` to a socket-gateway channel via that platform's stateless REST API.
 * Throws on a missing token / unroutable thread / unsupported type BEFORE any
 * network call, so a misconfigured delivery fails loudly rather than silently.
 * @param {{type:string, gw:object, threadId:string, text:string, log?:Function}} a
 */
export async function postToChannel({ type, gw, threadId, text, log = () => {} }) {
  const body = String(text == null ? "" : text);
  if (type === "discord") {
    const token = gw && gw.token;
    if (!token) throw new Error("discord gateway missing token");
    const { channelId } = parseThread("discord", threadId);
    if (!channelId) throw new Error("discord deliver: no channelId in '" + threadId + "'");
    const { REST, Routes } = await import("discord.js");
    const rest = new REST({ version: "10" }).setToken(token);
    await chunkedSend((c) => rest.post(Routes.channelMessages(channelId), { body: { content: c } }),
      body, { limit: CHUNK.discord, delayMs: CHUNK_DELAY_MS, log });
    return { delivered: "discord", channelId };
  }
  if (type === "telegram") {
    const token = gw && gw.token;
    if (!token) throw new Error("telegram gateway missing token");
    const { chatId } = parseThread("telegram", threadId);
    if (!chatId) throw new Error("telegram deliver: no chatId in '" + threadId + "'");
    const { Telegraf } = await import("telegraf");
    const tg = new Telegraf(token); // .telegram is a REST client; we never .launch()
    await chunkedSend((c) => tg.telegram.sendMessage(chatId, c),
      body, { limit: CHUNK.telegram, delayMs: CHUNK_DELAY_MS, log });
    return { delivered: "telegram", chatId };
  }
  if (type === "slack") {
    const token = gw && gw.bot_token;
    if (!token) throw new Error("slack gateway missing bot_token");
    const { channel, threadTs } = parseThread("slack", threadId);
    if (!channel) throw new Error("slack deliver: no channel in '" + threadId + "'");
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(token);
    await chunkedSend((c) => client.chat.postMessage({ channel, thread_ts: threadTs, text: c }),
      body, { limit: CHUNK.slack, delayMs: CHUNK_DELAY_MS, log });
    return { delivered: "slack", channel };
  }
  throw new Error("unsupported gateway delivery type: " + type);
}

/**
 * Reply to a Gmail thread via the gmail_io.mjs CLI (works from any process).
 * Best-effort: a failed send is logged, never thrown (the result also lives in
 * bot_jobs.result for poll retrieval). Uses the running node + the sibling CLI.
 */
export function gioReply({ to, replyTo, subject, thread, text, log = () => {} }) {
  return new Promise((resolve) => {
    if (!to || !thread) { log("gmail deliver skipped: missing to/thread"); resolve({ delivered: "gmail-skip" }); return; }
    const args = ["reply", "--to", to, "--thread", thread, "--body", String(text == null ? "" : text)];
    if (replyTo) args.push("--reply-to", replyTo);
    if (subject) args.push("--subject", subject);
    execFile(process.execPath, [GIO, ...args], { timeout: 90000, maxBuffer: 8e6 }, (e, _so, se) => {
      if (e) { log("gmail deliver failed: " + ((e && e.message) || e) + (se ? " :: " + se : "")); resolve({ delivered: "gmail-error" }); }
      else resolve({ delivered: "gmail" });
    });
  });
}

/**
 * Build the deliverChannel(job, spec, text) callback job_runner.tickJobs injects.
 * Routes the two channel kinds:
 *   { kind:"gmail",   to, reply_to?, subject?, thread }
 *   { kind:"gateway", gateway_type, gateway_thread_id }   (discord|telegram|slack)
 * For a gateway, it loads the bot def (lazy import of bridge.mjs — no static
 * cycle) to recover the gateway's token, then posts via REST.
 */
export function makeChannelDeliverer({ log = () => {} } = {}) {
  return async function deliverChannel(job, spec, text) {
    const kind = spec && spec.kind;
    if (kind === "gmail") {
      return gioReply({ to: spec.to, replyTo: spec.reply_to, subject: spec.subject, thread: spec.thread, text, log });
    }
    if (kind === "gateway") {
      const type = spec.gateway_type;
      const bridge = await import("../bridge.mjs");
      const bot = bridge.loadBot(job.bot_id); // throws on unknown/disabled
      const gw = findGatewayDef(bot.def, type);
      if (!gw) throw new Error("bot " + job.bot_id + " has no '" + type + "' gateway configured");
      return postToChannel({ type, gw, threadId: spec.gateway_thread_id, text, log });
    }
    throw new Error("deliverChannel: unsupported kind '" + (kind || "?") + "'");
  };
}

export default { parseThread, findGatewayDef, postToChannel, gioReply, makeChannelDeliverer };
