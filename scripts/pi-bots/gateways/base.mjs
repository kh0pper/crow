#!/usr/bin/env node
/**
 * Crow Bot Builder — shared gateway helpers (Hermes-parity gateway layer, A1).
 *
 * The transport-agnostic turn core is handleInbound() in ../bridge.mjs. Every
 * gateway (Gmail poll, Discord WebSocket, Telegram long-poll, Slack socket-mode)
 * only has to: receive an inbound message, hand it to handleInbound() with a
 * `sendReply` callback + a `gateway_type`, and route the reply back over its
 * transport. The plumbing AROUND that — splitting long replies, a per-bot serial
 * queue, a typing heartbeat, downloading inbound images, allowlist filtering —
 * is identical across gateways and lives here so it has ONE definition and one
 * test surface.
 *
 * These were extracted verbatim from discord_gateway.mjs (which now imports
 * them) so the refactor is behavior-preserving: same chunking, same image
 * caps, same queue semantics. New adapters (telegram.mjs, slack.mjs) reuse the
 * same helpers and only differ in their wire protocol.
 *
 * Pure: node built-ins + global fetch only. No DB, no pi spawn, no transport SDK.
 */

/** Default reply-chunking limit; callers pass their platform's real limit
 *  (Discord 2000 -> 1990 margin, Telegram 4096, Slack ~3000). */
export const DEFAULT_CHUNK_LIMIT = 1990;
export const DEFAULT_CHUNK_DELAY_MS = 200;
export const DEFAULT_MAX_IMAGES = 4;
export const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Split a long reply on newline boundaries, falling back to hard slicing for
 * any single line that itself exceeds the chunk limit. (Verbatim from
 * discord_gateway.mjs splitMessage; `limit` is now a parameter.)
 */
export function splitMessage(text, limit = DEFAULT_CHUNK_LIMIT) {
  const out = [];
  let buf = "";
  for (const line of String(text).split("\n")) {
    if (line.length > limit) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    if (buf.length + line.length + 1 > limit) { out.push(buf); buf = line; }
    else { buf = buf ? buf + "\n" + line : line; }
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

/**
 * Send `text` as one or more chunks through an async `send(chunk)` sink,
 * splitting at `limit` and pausing `delayMs` between chunks. Empty chunks are
 * sent as "(no content)" (mirrors discord_gateway.mjs postReply). A failing
 * send is logged, never thrown.
 */
export async function chunkedSend(send, text, opts = {}) {
  const limit = opts.limit || DEFAULT_CHUNK_LIMIT;
  const delayMs = opts.delayMs == null ? DEFAULT_CHUNK_DELAY_MS : opts.delayMs;
  const log = opts.log || (() => {});
  const chunks = splitMessage(text, limit);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i].length ? chunks[i] : "(no content)";
    try {
      await send(c);
    } catch (e) {
      log("send failed: " + ((e && e.message) || e));
    }
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** Best-effort image mime guess from a filename/url. (Verbatim from Discord.) */
export function guessMime(name) {
  const m = (name || "").toLowerCase().match(/\.(png|jpe?g|webp|gif|bmp)$/);
  if (!m) return "image/png";
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" }[m[1]] || "image/png";
}

/**
 * Download a list of NORMALIZED image attachments into pi ImageContent blocks
 * ({type:"image", data:<base64>, mimeType}). Each adapter maps its platform's
 * attachment shape to { url, size?, name?, contentType? } before calling.
 * Best-effort: a failed/oversize image is skipped (logged), never throws.
 * (Logic verbatim from discord_gateway.mjs downloadImages; `opts.headers` was
 * added for Slack, whose url_private downloads need a Bearer token — Discord
 * and Telegram pass no headers, so their behavior is unchanged.)
 */
export async function downloadImages(atts, opts = {}) {
  const max = opts.max || DEFAULT_MAX_IMAGES;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_IMAGE_BYTES;
  const headers = opts.headers || undefined;
  const log = opts.log || (() => {});
  const out = [];
  for (const a of (atts || []).slice(0, max)) {
    try {
      if (a.size && a.size > maxBytes) { log("skip oversize image " + (a.name || "") + " (" + a.size + "b)"); continue; }
      const res = await fetch(a.url, headers ? { headers } : undefined);
      if (!res.ok) { log("image fetch failed " + res.status + " " + (a.name || "")); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) { log("skip oversize image post-fetch " + (a.name || "")); continue; }
      out.push({ type: "image", data: buf.toString("base64"), mimeType: a.contentType || guessMime(a.name || a.url) });
    } catch (e) { log("image download error " + (a.name || "") + ": " + ((e && e.message) || e)); }
  }
  return out;
}

/**
 * Allowlist gate: an empty/absent allowlist means "allow everyone"; otherwise
 * the sender id must be a member. (Mirrors the inline check in Discord's
 * messageCreate handler — the allowlist is each gateway's security boundary.)
 */
export function passesAllowlist(senderId, allow) {
  if (!Array.isArray(allow) || allow.length === 0) return true;
  return allow.includes(senderId);
}

/**
 * A per-bot FIFO serial queue: at most one turn runs at a time for a bot.
 * push() returns false (and invokes onFull) when the queue is at capacity, so
 * the caller can tell the user "still working". (Generalized from Discord's
 * queue/drain/draining triple.)
 */
export class SerialQueue {
  constructor(opts = {}) {
    this.maxDepth = opts.maxDepth || 5;
    this.handler = opts.handler;            // async (job) => {}
    this.onFull = opts.onFull || (() => {}); // (job) => {}
    this.log = opts.log || (() => {});
    this._q = [];
    this._draining = false;
  }
  /** @returns {boolean} true if accepted, false if dropped (queue full). */
  push(job) {
    if (this._q.length >= this.maxDepth) { this.onFull(job); return false; }
    this._q.push(job);
    this._drain();
    return true;
  }
  get depth() { return this._q.length; }
  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._q.length) {
        const job = this._q.shift();
        try { await this.handler(job); }
        catch (e) { this.log("queue handler error: " + ((e && e.message) || e)); }
      }
    } finally {
      this._draining = false;
    }
  }
}

/**
 * Start a typing/keepalive heartbeat: fire `tick` immediately, then every
 * `intervalMs` until stop() is called. (Discord re-triggers typing before its
 * 10s expiry; Telegram/Slack reuse the same wrapper with their own tick fn.)
 * @returns {{ stop: () => void }}
 */
export function typingHeartbeat(tick, intervalMs) {
  let timer = null;
  try { tick(); } catch {}
  timer = setInterval(() => { try { tick(); } catch {} }, intervalMs);
  return { stop() { if (timer) { clearInterval(timer); timer = null; } } };
}
