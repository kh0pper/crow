#!/usr/bin/env node
/**
 * crow-browser CDP relay: Chromium on a pipe, one token-gated WebSocket for the host.
 *
 * Why a relay at all: Chrome DevTools Protocol has no authentication, and under
 * `network_mode: host` a CDP port on 127.0.0.1 is reachable by every process on the
 * machine (and by a web page via DNS rebinding). So Chromium is started here with
 * `--remote-debugging-pipe` and opens NO port; this relay owns the pipe (fd 3 = its
 * input, fd 4 = its output) and serves the host contract, `127.0.0.1:${CDP_PORT}`,
 * to anyone holding the per-instance `CROW_BROWSER_CDP_TOKEN`. The token is read from
 * the 0400 file compose mounts, is compared in constant time, and never reaches
 * Chromium: not in its argv, and stripped from the env this process hands it.
 *
 * A pipe is ONE connection, so the relay multiplexes: each client gets its own flat
 * browser session (`Target.attachToBrowserTarget` → `S_c`), the relay remaps message
 * ids per client, stamps `sessionId: S_c` on a client's sessionless messages, routes
 * responses and session-bearing events back by that session, and refuses a
 * `sessionId` the client does not own (-32001).
 *
 * Node builtins only (the image installs Node 20 LTS, and no Node 22+ API is used here):
 * the image has no `ws`, and a minimal RFC 6455 server for text frames (handshake,
 * text/continuation, ping/pong, close, mask handling) is smaller than adding a
 * dependency to a security-sensitive hop.
 *
 * What the gate keeps out: other uids, other containers, web pages, and a bot whose
 * network is unshared. It does NOT keep out a same-uid process that can read the
 * bundle `.env` (which holds this token) — that is the CROW_BOT_UID containment arc.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

/** The longest request head the relay reads; Node answers 431 beyond it. */
export const MAX_HEADER_BYTES = 16 * 1024;
/** How long a connection may take to send its request head (no slowloris). */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Concurrent connections, HTTP and WebSocket together. */
export const MAX_CONNECTIONS = 32;
/** Largest frame in either direction: one CDP message, from a client or from Chromium. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Per-client output buffer; past it that client alone is dropped (close 1009). */
export const MAX_CLIENT_BUFFER_BYTES = 64 * 1024 * 1024;
/** How long a graceful stop waits for Chromium to close itself after `Browser.close`. */
export const CLOSE_TIMEOUT_MS = 10_000;
/** The token shape Crow mints (hex32 or base64url) — the same rule the entrypoint applies. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost):(\d{1,5})$/;
/** Env names the Chromium child never sees: whatever holds a secret in this process. */
const SECRET_ENV_RE = /TOKEN|SECRET|PASSWORD/i;

const die = (msg) => {
  console.error(`[cdp-relay] FATAL: ${msg}`);
  process.exit(1);
};

/**
 * Constant-time bearer check.
 *
 * Both sides are hashed first, so the comparison walks a fixed 32 bytes no matter how
 * long or how wrong the presented value is — the timing leaks neither the token's
 * length nor a shared prefix.
 */
export function tokenMatches(presented, expected) {
  if (typeof expected !== "string" || expected === "") return false;
  const a = createHash("sha256").update(typeof presented === "string" ? presented : "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Chromium's `--remote-debugging-pipe` framing: JSON messages, each terminated by a NUL
 * byte, in both directions. Copied from the gateway preview's cdp-pipe.js (an installed
 * bundle cannot import outside its own directory); a frame that does not start with "{"
 * or is over the cap closes the pipe, which takes the relay down with Chromium.
 */
function createPipeFramer({ input, output, maxFrameBytes }) {
  let parts = [];
  let size = 0;
  let done = false;
  const handlers = { message: () => {}, close: () => {} };

  function finish(reason) {
    if (done) return;
    done = true;
    output.off("data", onData);
    output.off("end", onEnd);
    output.off("close", onEnd);
    parts = [];
    size = 0;
    handlers.close(reason);
  }

  function take(bytes) {
    if (!bytes.length) return true;
    if (size === 0 && bytes[0] !== 0x7b) { finish("bad_frame"); return false; }
    size += bytes.length;
    if (size > maxFrameBytes) { finish("bad_frame"); return false; }
    parts.push(bytes);
    return true;
  }

  function onData(chunk) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    while (!done) {
      const nul = buf.indexOf(0, start);
      if (nul === -1) { take(buf.subarray(start)); return; }
      if (!take(buf.subarray(start, nul))) return;
      start = nul + 1;
      const frame = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = [];
      size = 0;
      let msg;
      try { msg = JSON.parse(frame.toString("utf8")); } catch { finish("bad_frame"); return; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) { finish("bad_frame"); return; }
      handlers.message(msg);
    }
  }

  function onEnd() { finish(size > 0 ? "bad_frame" : "eof"); }

  output.on("data", onData);
  output.once("end", onEnd);
  output.once("close", onEnd);
  output.on("error", () => finish("eof"));
  input.on("error", () => finish("eof"));

  return {
    write(msg) {
      if (done) return false;
      try { input.write(JSON.stringify(msg) + "\0"); return true; } catch { return false; }
    },
    on(event, fn) { handlers[event] = fn; },
    isClosed: () => done,
  };
}

/**
 * A minimal RFC 6455 server connection for text frames: the handshake is done by the
 * caller, this is the frame layer (masked client frames, continuation, ping/pong,
 * close). `onText` gets whole messages; `onClose` fires exactly once, after which
 * nothing more is read or written.
 */
function createWsConnection(socket, head, { maxFrameBytes, onText, onClose, onTooBig }) {
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [];
  let partsSize = 0;
  let closed = false;
  let closeSent = false;

  socket.setNoDelay(true);
  socket.setTimeout(0); // an idle CDP client is normal: no request timeout applies after the upgrade

  function finish(why) {
    if (closed) return;
    closed = true;
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("close", onEnd);
    socket.off("error", onEnd);
    parts = [];
    partsSize = 0;
    buf = Buffer.alloc(0);
    onClose(why);
  }

  function writeFrame(opcode, payload) {
    if (closed || socket.destroyed || !socket.writable) return false;
    const n = payload.length;
    let header;
    if (n < 126) header = Buffer.from([0x80 | opcode, n]);
    else if (n < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(n, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(n), 2); }
    try { return socket.write(Buffer.concat([header, payload])); } catch { return false; }
  }

  function sendClose(code) {
    if (closeSent || closed) return;
    closeSent = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code || 1000, 0);
    writeFrame(0x8, payload);
    try { socket.end(); } catch { /* gone */ }
    // Give the close frame time to flush before the fd goes away (the peer must see 1009).
    const t = setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } }, 1000);
    if (typeof t.unref === "function") t.unref();
  }

  function handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { sendClose(1000); finish("client_close"); return; }
    if (opcode === 0x9) { writeFrame(0xa, payload); return; }
    if (opcode === 0xa) return;
    if (opcode === 0x2) { sendClose(1003); finish("binary_frame"); return; }
    if (opcode !== 0x1 && opcode !== 0x0) { sendClose(1002); finish("bad_opcode"); return; }
    if (opcode === 0x1 && partsSize > 0) { sendClose(1002); finish("interleaved_message"); return; }
    parts.push(payload);
    partsSize += payload.length;
    if (partsSize > maxFrameBytes) { onTooBig(); return; }
    if (!fin) return;
    const text = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
    parts = [];
    partsSize = 0;
    onText(text);
  }

  function onData(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (!closed) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      // No extension is negotiated, so RSV1-3 must be zero; a client frame is always masked.
      if ((b0 & 0x70) !== 0) { sendClose(1002); finish("reserved_bits"); return; }
      if (!masked) { sendClose(1002); finish("unmasked"); return; }
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(maxFrameBytes)) { onTooBig(); return; }
        len = Number(big);
        offset = 10;
      }
      if (opcode >= 0x8 && (!fin || len > 125)) { sendClose(1002); finish("bad_control_frame"); return; }
      if (len > maxFrameBytes || partsSize + len > maxFrameBytes) { onTooBig(); return; }
      if (buf.length < offset + 4 + len) return;
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + 4 + i] ^ mask[i & 3];
      buf = buf.subarray(offset + 4 + len);
      handleFrame(fin, opcode, payload);
    }
  }

  function onEnd() { finish("socket_end"); }

  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  socket.on("error", onEnd);

  return {
    sendText(text) { return writeFrame(0x1, Buffer.from(text, "utf8")); },
    close(code) { sendClose(code || 1000); finish("relay_close"); },
    bufferedBytes() { return socket.writableLength || 0; },
  };
}

const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (typeof t.unref === "function") t.unref(); });

/** CDP_PORT: a port number, 0 for "pick one" (tests), 9222 when unset. */
function parsePort(value) {
  if (value === undefined || value === null || value === "") return 9222;
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
}

/**
 * Start the relay: spawn Chromium on a pipe, wait until the pipe answers
 * `Browser.getVersion`, then listen on 127.0.0.1:`port` for gated clients.
 *
 * Message flow: a client's sessionless command is stamped with its own browser session
 * (`S_c`) and given a relay-wide id; the response to that id goes back to that client
 * with its original id, and without `sessionId` when it is `S_c`; an event carrying a
 * session goes to that session's owner (also stripped when it is `S_c`); a message
 * naming a session the client does not own is answered -32001 and never forwarded; and
 * a disconnecting client's child sessions and then its `S_c` are detached while its
 * pending ids are discarded, so a late response has nowhere to go but the bin.
 */
export async function createRelay(config) {
  const {
    token,
    port = 9222,
    chromiumArgv,
    childEnv = process.env,
    log = () => {},
    debug = () => {},
    compareToken = tokenMatches,
    maxFrameBytes = MAX_FRAME_BYTES,
    maxClientBuffer = MAX_CLIENT_BUFFER_BYTES,
    maxConnections = MAX_CONNECTIONS,
    maxHeaderBytes = MAX_HEADER_BYTES,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    closeTimeoutMs = CLOSE_TIMEOUT_MS,
  } = config || {};

  if (!TOKEN_RE.test(String(token || ""))) throw new Error("the CDP token is missing or malformed");
  if (!Array.isArray(chromiumArgv) || chromiumArgv.length === 0) throw new Error("no Chromium command");

  // Chromium is its own process group (detached): one kill then reaches its renderers and
  // zygotes, which is what makes "the relay dies, Chromium dies" true on the paths this
  // process cannot run code on. Belt and braces: Chromium exits on pipe EOF too, and the
  // entrypoint treats a dead relay as a dead container.
  const safeEnv = {};
  for (const [k, v] of Object.entries(childEnv)) if (!SECRET_ENV_RE.test(k)) safeEnv[k] = v;
  const child = spawn(chromiumArgv[0], chromiumArgv.slice(1), {
    stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"],
    detached: true,
    env: safeEnv,
  });

  let childExited = false;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => { childExited = true; resolve({ code, signal }); });
    child.once("error", (err) => {
      childExited = true;
      console.error(`[cdp-relay] FATAL: cannot start Chromium (${err && err.code ? err.code : "error"})`);
      resolve({ code: 127, signal: null });
    });
  });

  let stopping = false;
  function killChromium(signal = "SIGKILL") {
    if (!child.pid || childExited) return;
    try { process.kill(-child.pid, signal); return; } catch { /* the group is gone */ }
    try { child.kill(signal); } catch { /* the process is gone */ }
  }

  const input = child.stdio[3];
  const output = child.stdio[4];
  if (!input || !output) { killChromium(); throw new Error("Chromium did not get its pipe (fds 3 and 4)"); }
  const framer = createPipeFramer({ input, output, maxFrameBytes });

  const relayId = randomBytes(16).toString("hex");
  const clients = new Set();
  /** relay id → { client, originalId, method } — a client's in-flight command. */
  const pending = new Map();
  /** relay id → handler — the relay's own commands (bootstrap, getVersion, detach). */
  const internal = new Map();
  /** CDP sessionId → the client that owns it (its `S_c` and every child session). */
  const sessionOwner = new Map();
  const stats = { clientsCreated: 0, activeClients: 0, sessionlessEvents: 0, orphanEvents: 0, refused: 0, slowDropped: 0, closed: 0, framesIn: 0, framesOut: 0 };
  let nextId = 1;
  let clientSeq = 0;
  let actualPort = port;

  function pipeSend(msg) { return framer.write(msg); }

  function internalRequest(method, params = {}, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => { internal.delete(id); resolve(null); }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      internal.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      if (!pipeSend({ id, method, params })) { clearTimeout(timer); internal.delete(id); resolve(null); }
    });
  }

  function registerSession(sessionId, client) {
    sessionOwner.set(sessionId, client);
    client.sessions.add(sessionId);
  }

  function detachSession(sessionId) {
    const id = nextId++;
    internal.set(id, () => {});
    pipeSend({ id, method: "Target.detachFromTarget", params: { sessionId } });
  }

  function send(client, msg) {
    if (!client || client.closed) return false;
    const text = typeof msg === "string" ? msg : JSON.stringify(msg);
    const size = Buffer.byteLength(text, "utf8");
    // Outbound frame cap, and then the per-client buffer cap: past either one, that client
    // alone goes (close 1009). The pipe and its siblings never wait on it.
    if (size + 10 > maxFrameBytes) { dropClient(client, 1009, "outbound frame over the cap"); return false; }
    if (client.ws.bufferedBytes() + size + 10 > maxClientBuffer) {
      stats.slowDropped++;
      dropClient(client, 1009, "output buffer over the cap");
      return false;
    }
    const ok = client.ws.sendText(text);
    stats.framesOut++;
    return ok;
  }

  function dropClient(client, code, why) {
    if (!client || client.closed) return;
    client.closed = true;
    stats.closed++;
    for (const sid of [...client.sessions]) {
      sessionOwner.delete(sid);
      if (sid !== client.sc) detachSession(sid);
    }
    if (client.sc) detachSession(client.sc);
    client.sessions.clear();
    // Its in-flight ids die with it: a late response then finds no owner and is discarded.
    for (const [id, entry] of [...pending]) if (entry.client === client) pending.delete(id);
    client.queue = [];
    client.queueBytes = 0;
    clients.delete(client);
    stats.activeClients = clients.size;
    client.ws.close(code || 1000);
    debug(`client ${client.id} dropped (${code}): ${why}`);
  }

  function flush(client) {
    if (!client.sc || client.closed) return;
    const queued = client.queue;
    client.queue = [];
    client.queueBytes = 0;
    for (const text of queued) forwardText(client, text);
  }

  function attachBrowserSession(client) {
    const id = nextId++;
    internal.set(id, (msg) => {
      const sessionId = msg && msg.result && msg.result.sessionId;
      if (typeof sessionId !== "string") {
        log(`client ${client.id}: no browser session (${msg && msg.error ? "error " + msg.error.code : "no sessionId"}) — refusing it`);
        dropClient(client, 1011, "browser session unavailable");
        return;
      }
      client.sc = sessionId;
      registerSession(sessionId, client);
      debug(`client ${client.id} attached with its own browser session`);
      flush(client);
    });
    pipeSend({ id, method: "Target.attachToBrowserTarget", params: {} });
  }

  function forwardText(client, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { debug(`client ${client.id}: a frame that is not JSON, dropped`); return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const asked = typeof msg.sessionId === "string" ? msg.sessionId : null;
    if (asked && sessionOwner.get(asked) !== client) {
      // Another client's session (or one that never was): refuse, never forward. Forwarding
      // would let one client drive another's page.
      if (msg.id !== undefined) send(client, { id: msg.id, error: { code: -32001, message: "Session not owned" } });
      return;
    }
    const sessionId = asked || client.sc;
    if (msg.id === undefined) { pipeSend({ ...msg, sessionId }); stats.framesIn++; return; }
    const relayMsgId = nextId++;
    pending.set(relayMsgId, { client, originalId: msg.id, method: typeof msg.method === "string" ? msg.method : null });
    pipeSend({ ...msg, id: relayMsgId, sessionId });
    stats.framesIn++;
  }

  function fromClient(client, text) {
    if (client.closed) return;
    if (Buffer.byteLength(text, "utf8") > maxFrameBytes) { dropClient(client, 1009, "inbound frame over the cap"); return; }
    if (!client.sc) {
      // Playwright's first commands race the browser-session bootstrap: hold, then flush.
      client.queue.push(text);
      client.queueBytes += text.length;
      if (client.queueBytes > maxFrameBytes) dropClient(client, 1009, "queued frames over the cap");
      return;
    }
    forwardText(client, text);
  }

  function fromPipe(msg) {
    if (msg.id !== undefined) {
      const handler = internal.get(msg.id);
      if (handler) { internal.delete(msg.id); handler(msg); return; }
      const entry = pending.get(msg.id);
      if (!entry) return; // a late response for a client that is gone: discard
      pending.delete(msg.id);
      const client = entry.client;
      const announced = msg.result && typeof msg.result.sessionId === "string" ? msg.result.sessionId : null;
      // A session can be announced by a response (Target.attachToTarget) or by an event.
      if (announced && entry.method && entry.method.startsWith("Target.attach")) registerSession(announced, client);
      const out = { ...msg, id: entry.originalId };
      if (out.sessionId === client.sc) delete out.sessionId;
      send(client, out);
      return;
    }
    if (typeof msg.method !== "string") return;
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
    if (!sessionId) {
      // Every flat browser session is addressed, so a sessionless event has no owner.
      stats.sessionlessEvents++;
      debug(`an event without a session was dropped (${msg.method})`);
      return;
    }
    const owner = sessionOwner.get(sessionId);
    if (!owner) { stats.orphanEvents++; debug(`an event for an unowned session was dropped (${msg.method})`); return; }
    const child = msg.params && typeof msg.params.sessionId === "string" ? msg.params.sessionId : null;
    if (msg.method === "Target.attachedToTarget" && child) registerSession(child, owner);
    else if (msg.method === "Target.detachedFromTarget" && child) sessionOwner.delete(child);
    const out = { ...msg };
    if (sessionId === owner.sc) delete out.sessionId;
    send(owner, out);
  }

  function addClient(socket, head) {
    const client = { id: ++clientSeq, sc: null, sessions: new Set(), queue: [], queueBytes: 0, closed: false, ws: null };
    client.ws = createWsConnection(socket, head, {
      maxFrameBytes,
      onText: (text) => fromClient(client, text),
      onClose: (why) => dropClient(client, 1000, why),
      onTooBig: () => dropClient(client, 1009, "frame over the cap"),
    });
    clients.add(client);
    stats.clientsCreated = clientSeq;
    stats.activeClients = clients.size;
    attachBrowserSession(client);
    return client;
  }

  /** Only /json/version[/] and the one WebSocket path exist; everything else is unknown. */
  function classify(rawUrl) {
    const path = String(rawUrl || "").split("?")[0].split("#")[0];
    if (path === "/json/version" || path === "/json/version/") return "version";
    const m = /^\/devtools\/browser\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m) return m[1] === relayId ? "ws" : "unknown";
    return "unknown";
  }

  /**
   * One log line per request: method, a fixed label, status. Never a header value, and
   * never the raw path — a client could put the token in a query string, and this line
   * would copy it into the container's log.
   */
  function logLine(method, route, status) {
    const label = route === "version" ? "/json/version" : route === "ws" ? "/devtools/browser" : "(unrecognized path)";
    log(`${method} ${label} ${status}`);
  }

  function authenticate(headers) {
    const raw = headers && headers.authorization;
    const presented = typeof raw === "string" && /^bearer /i.test(raw.trim()) ? raw.trim().slice(7) : "";
    // Always through the comparator, even for an empty or malformed header: one code path,
    // constant time, nothing for an observer to time.
    return compareToken(presented, token);
  }

  function loopbackHost(hostHeader) {
    const host = String(hostHeader || "").trim().toLowerCase();
    const m = LOOPBACK_HOST_RE.exec(host);
    if (!m || Number(m[2]) !== actualPort) return null;
    return host;
  }

  async function readVersion() {
    const msg = await internalRequest("Browser.getVersion");
    return msg && msg.result ? msg.result : null;
  }

  function respond(res, status, body) {
    const text = JSON.stringify(body);
    try {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end(text);
    } catch { /* the client went away */ }
  }

  function reject(socket, status, text) {
    try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
  }

  async function onRequest(req, res) {
    headSeen.add(req.socket);
    const route = classify(req.url);
    // Auth first: an unauthenticated caller learns nothing about which paths exist.
    if (!authenticate(req.headers)) {
      stats.refused++;
      respond(res, 401, { error: "unauthorized" });
      logLine(req.method, route, 401);
      return;
    }
    if (route === "unknown") {
      respond(res, 404, { error: "not found" });
      logLine(req.method, route, 404);
      return;
    }
    if (route === "ws") {
      respond(res, 426, { error: "this path is for a WebSocket upgrade" });
      logLine(req.method, route, 426);
      return;
    }
    if (req.method !== "GET") {
      respond(res, 405, { error: "method not allowed" });
      logLine(req.method, route, 405);
      return;
    }
    // webSocketDebuggerUrl is only ever built from a loopback Host on this very port, so a
    // page that reaches the relay by name (rebinding, a forward proxy) is told nothing.
    const host = loopbackHost(req.headers.host);
    if (!host) {
      respond(res, 400, { error: "unexpected Host header" });
      logLine(req.method, route, 400);
      return;
    }
    const version = await readVersion();
    if (!version) {
      respond(res, 503, { error: "the browser did not answer" });
      logLine(req.method, route, 503);
      return;
    }
    respond(res, 200, {
      Browser: String(version.product || ""),
      "Protocol-Version": String(version.protocolVersion || ""),
      "User-Agent": String(version.userAgent || ""),
      "V8-Version": String(version.jsVersion || ""),
      "WebKit-Version": version.revision ? `537.36 (@${version.revision})` : "537.36",
      webSocketDebuggerUrl: `ws://${host}/devtools/browser/${relayId}`,
    });
    logLine(req.method, route, 200);
  }

  function onUpgrade(req, socket, head) {
    headSeen.add(socket);
    const route = classify(req.url);
    if (!authenticate(req.headers)) { stats.refused++; reject(socket, 401, "Unauthorized"); logLine("UPGRADE", route, 401); return; }
    if (route !== "ws") { reject(socket, 404, "Not Found"); logLine("UPGRADE", route, 404); return; }
    if (!loopbackHost(req.headers.host)) { reject(socket, 400, "Bad Request"); logLine("UPGRADE", route, 400); return; }
    const key = typeof req.headers["sec-websocket-key"] === "string" ? req.headers["sec-websocket-key"].trim() : "";
    const wsVersion = String(req.headers["sec-websocket-version"] || "").trim();
    if (!/^[A-Za-z0-9+/]{16,64}={0,2}$/.test(key) || wsVersion !== "13") {
      reject(socket, 400, "Bad Request");
      logLine("UPGRADE", route, 400);
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    addClient(socket, head);
    logLine("UPGRADE", route, 101);
  }

  framer.on("message", fromPipe);
  framer.on("close", (reason) => {
    if (stopping) return;
    // Chromium's output ended: it is gone, or it broke the protocol. Either way this relay
    // has nothing left to serve, and Chromium must not outlive it.
    log(`the pipe to Chromium closed (${reason}) — exiting`);
    killChromium();
  });

  const server = http.createServer({ maxHeaderSize: maxHeaderBytes }, (req, res) => { void onRequest(req, res); });
  server.on("upgrade", onUpgrade);
  server.headersTimeout = handshakeTimeoutMs;
  server.requestTimeout = handshakeTimeoutMs;
  // Node only RE-CHECKS those timers on this interval (default 30 s), which would turn a
  // 10 s handshake timeout into "up to 40 s". Check often enough for the stated timeout.
  server.connectionsCheckingInterval = Math.max(50, Math.min(handshakeTimeoutMs, 1000));
  server.on("clientError", (err, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch { /* gone */ }
  });
  const sockets = new Set();
  // Sockets that have delivered a complete request head. Node's own headersTimeout only
  // expires connections on a coarse interval (and not at all before any byte arrives), so
  // the handshake deadline is enforced here too: no head within handshakeTimeoutMs, gone.
  const headSeen = new WeakSet();
  server.on("connection", (socket) => {
    if (sockets.size >= maxConnections) { stats.refused++; try { socket.destroy(); } catch { /* gone */ } return; }
    sockets.add(socket);
    const timer = setTimeout(() => { if (!headSeen.has(socket)) { try { socket.destroy(); } catch { /* gone */ } } }, handshakeTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); });
  });

  actualPort = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });

  // Readiness is "Chromium answered over the pipe": nothing is served before that.
  const version = await readVersion();
  if (!version) {
    stopping = true;
    try { server.close(); } catch { /* ignore */ }
    killChromium();
    throw new Error("Chromium did not answer Browser.getVersion on its pipe");
  }

  async function shutdown(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    // The graceful path: ask Chromium to close, which is what commits its cookie store.
    pipeSend({ id: nextId++, method: "Browser.close", params: {} });
    const how = await Promise.race([exited.then(() => "exited"), delay(closeTimeoutMs).then(() => "timeout")]);
    if (how === "timeout") {
      log(`Chromium did not close within ${Math.round(closeTimeoutMs / 1000)}s — killing it`);
      killChromium();
      await Promise.race([exited, delay(2000)]);
    }
    for (const client of [...clients]) dropClient(client, 1001, "the relay is stopping");
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 500);
      if (typeof t.unref === "function") t.unref();
      server.close(() => { clearTimeout(t); resolve(); });
    });
    try { input.destroy(); } catch { /* gone */ }
    try { output.destroy(); } catch { /* gone */ }
    process.exitCode = exitCode;
  }

  return {
    port: actualPort,
    relayId,
    version,
    stats,
    child,
    exited,
    shutdown,
    killChromium,
    isChildExited: () => childExited,
    url: `ws://127.0.0.1:${actualPort}/devtools/browser/${relayId}`,
  };
}

/** The Chromium argv: the entrypoint's flags, minus the debugging port, plus the pipe. */
export function chromiumArguments(env = process.env) {
  const profileDir = env.CROW_CHROMIUM_PROFILE || "/root/.config/chromium-crow";
  const args = [
    "--no-sandbox", "--disable-setuid-sandbox",
    // No --remote-debugging-port and no --remote-allow-origins: with a pipe there is no
    // port to open and no Origin check to disable; the relay's bearer is the control.
    "--remote-debugging-pipe",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1920,1080", "--start-maximized",
    "--no-first-run", "--no-default-browser-check",
    "--disable-infobars", "--disable-extensions",
    `--user-data-dir=${profileDir}`,
  ];
  if (env.CHROME_PROXY) args.push(`--proxy-server=${env.CHROME_PROXY}`);
  args.push("about:blank");
  return args;
}

/**
 * The CLI: read the token, spawn Chromium, serve, and share fate with it.
 *
 * Env (none of it secret): CDP_PORT, CHROME_PATH, CHROME_PROXY, CROW_CHROMIUM_PROFILE,
 * CROW_CDP_TOKEN_FILE, CROW_CDP_READY_FILE, CROW_CDP_DEBUG, plus the test seams
 * CROW_CDP_CHROMIUM_ARGV (a JSON argv prefix that speaks the pipe) and the size caps
 * CROW_CDP_MAX_FRAME / CROW_CDP_MAX_CLIENT_BUFFER / CROW_CDP_MAX_CONNECTIONS /
 * CROW_CDP_MAX_HEADER / CROW_CDP_HANDSHAKE_TIMEOUT_MS / CROW_CDP_CLOSE_TIMEOUT_MS.
 */
export async function main() {
  const debugOn = process.env.CROW_CDP_DEBUG === "1";
  const log = (msg) => console.log(`[cdp-relay] ${msg}`);
  const debug = (msg) => { if (debugOn) log(msg); };

  const tokenFile = process.env.CROW_CDP_TOKEN_FILE || "/run/secrets/crow-cdp-token";
  let token = "";
  try { token = readFileSync(tokenFile, "utf8").trim(); } catch { token = ""; }
  if (!TOKEN_RE.test(token)) {
    die(`the CDP token (${tokenFile}) is missing or malformed. Crow generates CROW_BROWSER_CDP_TOKEN at install, in this bundle's .env, and compose hands it in as that file; the relay never opens an ungated port instead.`);
  }

  const port = parsePort(process.env.CDP_PORT);
  if (port === null) die(`CDP_PORT '${process.env.CDP_PORT}' is not a port number`);

  const chromePath = process.env.CHROME_PATH || "";
  const seam = process.env.CROW_CDP_CHROMIUM_ARGV;
  let chromiumArgv;
  if (seam) {
    try {
      const parsed = JSON.parse(seam);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("not an argv");
      chromiumArgv = [...parsed.map(String), ...chromiumArguments()];
    } catch { die("CROW_CDP_CHROMIUM_ARGV is not a JSON argv array"); }
  } else {
    if (!chromePath) die("CHROME_PATH is not set: the entrypoint finds Playwright's Chrome and passes it in");
    chromiumArgv = [chromePath, ...chromiumArguments()];
  }
  debug(`Chromium: ${chromiumArgv[0]}`);

  const cap = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };

  let relay;
  try {
    relay = await createRelay({
      token,
      port,
      chromiumArgv,
      log,
      debug,
      maxFrameBytes: cap("CROW_CDP_MAX_FRAME", MAX_FRAME_BYTES),
      maxClientBuffer: cap("CROW_CDP_MAX_CLIENT_BUFFER", MAX_CLIENT_BUFFER_BYTES),
      maxConnections: cap("CROW_CDP_MAX_CONNECTIONS", MAX_CONNECTIONS),
      maxHeaderBytes: cap("CROW_CDP_MAX_HEADER", MAX_HEADER_BYTES),
      handshakeTimeoutMs: cap("CROW_CDP_HANDSHAKE_TIMEOUT_MS", HANDSHAKE_TIMEOUT_MS),
      closeTimeoutMs: cap("CROW_CDP_CLOSE_TIMEOUT_MS", CLOSE_TIMEOUT_MS),
    });
  } catch (err) {
    die(String((err && err.message) || err));
  }

  const readyFile = process.env.CROW_CDP_READY_FILE || "/tmp/cdp-relay.ready";
  const removeReadyFile = () => { try { rmSync(readyFile, { force: true }); } catch { /* gone */ } };
  try {
    mkdirSync(dirname(readyFile), { recursive: true });
    writeFileSync(readyFile, JSON.stringify({ pid: process.pid, port: relay.port, browser: String(relay.version.product || "") }) + "\n", { mode: 0o644 });
  } catch {
    relay.killChromium();
    die(`cannot write the ready file (${readyFile})`);
  }
  log(`ready on 127.0.0.1:${relay.port} — Chromium ${relay.version.product || "(unknown)"} over a pipe, bearer required`);

  let stopping = false;
  void relay.exited.then(({ code }) => {
    // Chromium's fate is ours: the entrypoint sees the relay exit and takes the container
    // down, so a crashed browser restarts instead of leaving a dead port behind.
    if (stopping) return;
    log(`Chromium exited (${code === null ? "signal" : `code ${code}`}); exiting with it`);
    removeReadyFile();
    relay.killChromium();
    process.exit(code === null ? 1 : code);
  });

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: closing Chromium through the pipe...`);
    await relay.shutdown(0);
    removeReadyFile();
    log("stopped.");
    process.exit(0);
  };
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
  process.on("SIGINT", () => { void stop("SIGINT"); });
  const crash = (err) => {
    console.error(`[cdp-relay] FATAL: ${(err && err.message) || err}`);
    relay.killChromium();
    removeReadyFile();
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  // Last resort for any other exit path: never leave Chromium running ungated.
  process.on("exit", () => relay.killChromium());
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => die(String((err && err.message) || err)));
}