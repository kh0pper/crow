#!/usr/bin/env node
/**
 * crow-browser CDP relay: Chromium on a pipe, one token-gated WebSocket for the host.
 *
 * TWO PROCESSES, TWO UIDS, ONE PIPE. The entrypoint starts this file with `--supervise`,
 * as root. That process starts Chromium — which STAYS root, because the image's /root is
 * 0700 and the profile lives under it — and starts the relay itself as the GATEWAY's uid:
 *
 *   setpriv --reuid U --regid G --clear-groups --inh-caps=-all --bounding-set=-all \
 *           --no-new-privs -- /usr/bin/node /app/cdp-relay.mjs --attach
 *
 * handing it Chromium's pipe on fds 3 and 4 and a one-line report pipe on fd 5. The
 * supervisor listens on NO socket, and writes CROW_CDP_READY_FILE itself once the relay
 * has reported ready — into a root-owned 0755 directory the relay's uid cannot write to
 * (directly or through /proc/<relay>/root), so no process on that uid can announce a
 * browser that is not up.
 *
 * Why the uid split: a browser add-on runs behind a wall, and the wall's listener-owner
 * check (scripts/addon-sandbox/listener-owner.mjs) identifies a loopback port by who holds
 * the socket and, for a same-uid holder, by the container that holder runs in. A listener
 * owned by the GATEWAY's uid inside this add-on's own container is that add-on's own
 * service, provided the process can be identified: /proc/<pid>/fd, cwd, exe and cgroup must
 * be readable by the gateway, and argv must carry an absolute script path. A process exec'd
 * through setpriv keeps all of that; a process that calls setuid() itself becomes
 * non-dumpable and its /proc entries become unreadable, so this file NEVER drops privileges
 * in-process — it re-execs itself.
 *
 * The split does NOT contain Chromium. The token is full CDP control of a browser that
 * still runs as root: whoever holds it can read the profile's cookies and saved logins, and
 * can make the browser open file:// URLs for anything the container can read. What the
 * split buys is identification — the wall can tell that this listener belongs to the
 * browser add-on's own container and refuse it to every other add-on — not a boundary
 * around the browser.
 *
 * Why a relay at all: Chrome DevTools Protocol has no authentication, and under
 * `network_mode: host` a CDP port on 127.0.0.1 is reachable by every process on the
 * machine (and by a web page via DNS rebinding). So Chromium runs with
 * `--remote-debugging-pipe` and opens NO port; the relay owns the pipe (fd 3 = what it
 * writes to Chromium, fd 4 = what it reads back) and serves the host contract,
 * `127.0.0.1:${CDP_PORT}`, to anyone holding the per-instance
 * `CROW_BROWSER_CDP_TOKEN`. The token is read from a 0400 file (compose mounts it root
 * only; the entrypoint copies it into a directory the relay's uid owns), is compared in
 * constant time, and never reaches Chromium: not in its argv, and stripped from the env
 * Chromium inherits. It is never in the relay's argv or in an environment VALUE either —
 * CROW_CDP_TOKEN_FILE is only a path.
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
 * What the gate keeps out: other uids, other containers and web pages. It does NOT keep
 * out a process of this same uid that can read the token file — and such a process has the
 * whole root Chromium through that token (cookies, saved logins, file:// reads). The uid
 * split is an identification for the add-on wall, not a containment boundary; closing that
 * gap is the CROW_BOT_UID containment arc.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The longest request head the relay reads; Node answers 431 beyond it. */
export const MAX_HEADER_BYTES = 16 * 1024;
/** How long a connection may take to send its request head (no slowloris). */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Concurrent connections, HTTP and WebSocket together. */
export const MAX_CONNECTIONS = 32;
/** Largest frame in either direction: one CDP message, from a client or from Chromium. The
 *  pipe framer closes (and so the browser stops) past it, so it matches Playwright's own
 *  client limit: a page cannot make one message big enough to stop the browser below that. */
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;
/** Per-client output BACKLOG; past it that client alone is dropped (close 1009). A client whose
 *  buffer is empty may still take one message up to MAX_FRAME_BYTES, so a single large message
 *  never drops an idle client, while a slow one cannot pile up hundreds of MB in a container
 *  whose memory limit is shared with Chromium. */
export const MAX_CLIENT_BUFFER_BYTES = 64 * 1024 * 1024;
/** How long a graceful stop waits for Chromium to close itself after `Browser.close`. */
export const CLOSE_TIMEOUT_MS = 10_000;
/** The token shape Crow mints (hex32 or base64url) — the same rule the entrypoint applies. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
/** How long the supervisor waits for the relay's one "ready <json>" line (the entrypoint waits 60 s). */
export const READY_TIMEOUT_MS = 60_000;
/** The largest ready line the supervisor accepts; anything bigger is a broken relay. */
const MAX_READY_LINE_BYTES = 4096;
/** The largest uid/gid accepted (the Linux id_t ceiling): anything else is a typo, not an id. */
const MAX_ID = 2147483647;
/** The one privileged helper used to start the relay on another uid (`util-linux`, in the base image). */
const SETPRIV = "/usr/bin/setpriv";
/** This script, absolutely, for the supervisor's re-exec (no relative path ever). */
const SELF = fileURLToPath(import.meta.url);
/**
 * The ONLY variables the supervisor gives the relay: a path to start with, the port, the
 * token's FILE (a path, never the token), the debug flag and the caps. Everything else of
 * the supervisor's environment stays with the supervisor — and none of these is a secret
 * except in name, which is why the token's location is a path and the value is in a file.
 */
const RELAY_ENV_KEYS = [
  "PATH", "CDP_PORT", "CROW_CDP_TOKEN_FILE", "CROW_CDP_DEBUG",
  "CROW_CDP_MAX_FRAME", "CROW_CDP_MAX_CLIENT_BUFFER", "CROW_CDP_MAX_CONNECTIONS", "CROW_CDP_MAX_HEADER",
  "CROW_CDP_HANDSHAKE_TIMEOUT_MS", "CROW_CDP_CLOSE_TIMEOUT_MS",
];

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
  // Permanent: finish() removes onEnd, but the socket can still error while a close frame
  // flushes (sendClose keeps it up to 1 s). An unhandled error would crash the relay.
  socket.on("error", () => {});

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
 * A uid or gid as this bundle accepts it: a decimal integer in 0..MAX_ID, and nothing
 * else. `undefined`, an empty string, "root", a negative number or a name all fail, so a
 * compose file that forgot to pass CROW_GATEWAY_UID stops the container instead of
 * silently listening as root.
 *
 * The value returned is CANONICAL decimal (a Number): "0010" and "10" are the same uid,
 * and the entrypoint's `listener_uid_is` compares the kernel's uid column against this
 * spelling as a string, so a leading zero must never reach setpriv or that comparison.
 * Exported for the unit test of exactly that.
 */
export function parseId(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ID ? n : null;
}

/** The size caps and timeouts from the environment (never a secret). */
function capsFromEnv() {
  const cap = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    maxFrameBytes: cap("CROW_CDP_MAX_FRAME", MAX_FRAME_BYTES),
    maxClientBuffer: cap("CROW_CDP_MAX_CLIENT_BUFFER", MAX_CLIENT_BUFFER_BYTES),
    maxConnections: cap("CROW_CDP_MAX_CONNECTIONS", MAX_CONNECTIONS),
    maxHeaderBytes: cap("CROW_CDP_MAX_HEADER", MAX_HEADER_BYTES),
    handshakeTimeoutMs: cap("CROW_CDP_HANDSHAKE_TIMEOUT_MS", HANDSHAKE_TIMEOUT_MS),
    closeTimeoutMs: cap("CROW_CDP_CLOSE_TIMEOUT_MS", CLOSE_TIMEOUT_MS),
  };
}

/** The token, read from its 0400 file (never from the environment). */
function readToken() {
  const tokenFile = process.env.CROW_CDP_TOKEN_FILE || "/run/secrets/crow-cdp-token";
  let token = "";
  try { token = readFileSync(tokenFile, "utf8").trim(); } catch { token = ""; }
  if (!TOKEN_RE.test(token)) {
    die(`the CDP token (${tokenFile}) is missing or malformed. Crow generates CROW_BROWSER_CDP_TOKEN at install, in this bundle's .env, and compose hands it in as that file; the relay never opens an ungated port instead.`);
  }
  return token;
}

/** CDP_PORT from the environment, or a fatal. */
function readPort() {
  const port = parsePort(process.env.CDP_PORT);
  if (port === null) die(`CDP_PORT '${process.env.CDP_PORT}' is not a port number`);
  return port;
}

/** The Chromium argv: the test seam first, else CHROME_PATH from the entrypoint. */
function chromiumCommand() {
  const chromePath = process.env.CHROME_PATH || "";
  const seam = process.env.CROW_CDP_CHROMIUM_ARGV;
  if (seam) {
    try {
      const parsed = JSON.parse(seam);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("not an argv");
      return [...parsed.map(String), ...chromiumArguments()];
    } catch { die("CROW_CDP_CHROMIUM_ARGV is not a JSON argv array"); }
  }
  if (!chromePath) die("CHROME_PATH is not set: the entrypoint finds Playwright's Chrome and passes it in");
  return [chromePath, ...chromiumArguments()];
}

/**
 * One line from the relay on fd 5: `ready <json>`. The supervisor's cue that Chromium's
 * pipe answered and the port is listening — the same evidence the ready FILE records.
 */
function readReadyLine(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    if (!stream) { reject(new Error("the relay has no report pipe (fd 5)")); return; }
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`the relay did not report ready within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    function onData(chunk) {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        if (buf.length > MAX_READY_LINE_BYTES) finish(reject, new Error("the relay's ready line is too long"));
        return;
      }
      const m = /^ready (\{.*\})$/.exec(buf.slice(0, nl).trim());
      if (!m) { finish(reject, new Error("the relay's first line on fd 5 was not a ready line")); return; }
      let info = null;
      try { info = JSON.parse(m[1]); } catch { info = null; }
      if (!info || typeof info !== "object" || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) {
        finish(reject, new Error("the relay's ready line carried no port"));
        return;
      }
      finish(resolve, info);
    }
    function onEnd() { finish(reject, new Error("the relay closed fd 5 without reporting ready")); }
    function onError() { finish(reject, new Error("the relay's ready pipe failed")); }
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
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
    pipe = null,
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
  // Two ways to own the pipe: spawn Chromium here (the pre-1.7.0 shape, and what the unit
  // tests drive), or attach to the pipe the supervisor handed over on fds 3 and 4.
  const pipeMode = !!(pipe && typeof pipe === "object" && pipe.input && pipe.output);
  if (!pipeMode && (!Array.isArray(chromiumArgv) || chromiumArgv.length === 0)) throw new Error("no Chromium command");

  let child = null;
  let input;
  let output;
  if (pipeMode) {
    input = pipe.input;
    output = pipe.output;
  } else {
    // Chromium is its own process group (detached): one kill then reaches its renderers and
    // zygotes, which is what makes "the relay dies, Chromium dies" true on the paths this
    // process cannot run code on. Belt and braces: Chromium exits on pipe EOF too, and the
    // supervisor treats a dead relay as a dead container.
    const safeEnv = {};
    for (const [k, v] of Object.entries(childEnv)) if (!SECRET_ENV_RE.test(k)) safeEnv[k] = v;
    child = spawn(chromiumArgv[0], chromiumArgv.slice(1), {
      stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"],
      detached: true,
      env: safeEnv,
    });
    input = child.stdio[3];
    output = child.stdio[4];
  }

  let childExited = pipeMode;
  // In pipe mode the framer's close IS "Chromium is gone": its end of the pipe went away.
  let resolvePipeClosed = () => {};
  const pipeClosed = new Promise((resolve) => { resolvePipeClosed = resolve; });
  const exited = pipeMode ? pipeClosed : new Promise((resolve) => {
    child.once("exit", (code, signal) => { childExited = true; resolve({ code, signal }); });
    child.once("error", (err) => {
      childExited = true;
      console.error(`[cdp-relay] FATAL: cannot start Chromium (${err && err.code ? err.code : "error"})`);
      resolve({ code: 127, signal: null });
    });
  });

  let stopping = false;
  function killChromium(signal = "SIGKILL") {
    if (pipeMode) {
      // There is no child of ours to signal: the pipe is the whole relationship, and
      // closing it is exactly what Chromium sees as "the relay is gone".
      try { input.destroy(); } catch { /* gone */ }
      try { output.destroy(); } catch { /* gone */ }
      return;
    }
    if (!child.pid || childExited) return;
    try { process.kill(-child.pid, signal); return; } catch { /* the group is gone */ }
    try { child.kill(signal); } catch { /* the process is gone */ }
  }

  if (!input || !output) {
    killChromium();
    throw new Error(pipeMode ? "the pipe arrived without both fds (3 and 4)" : "Chromium did not get its pipe (fds 3 and 4)");
  }
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
    const buffered = client.ws.bufferedBytes();
    if (buffered > 0 && buffered + size + 10 > maxClientBuffer) {
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

  /**
   * Would this message make Chromium open a target AT a URL?
   *
   * `Target.createTarget {url}` hands the URL to the browser with the request: Chromium
   * starts fetching it before any Playwright-side guard (the page-side private-address
   * guard, a route interceptor) can be attached to that target, so a client could reach a
   * private address through a target the guard never sees. Playwright's `newPage()` is not
   * affected: it creates the target as `about:blank` and navigates it afterwards, with the
   * guard already in place — which is exactly the shape this allows through. Only an
   * absent/undefined url, an exact `""` and an exact `"about:blank"` pass; anything else,
   * a non-string included, is refused. The operator's own new tab is opened through
   * Chrome's UI over VNC (a click in the browser window), not through CDP, so it is
   * unaffected by this rule.
   */
  function refusesInitialUrl(msg) {
    if (!msg || msg.method !== "Target.createTarget") return false;
    const params = msg.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return false;
    if (!Object.prototype.hasOwnProperty.call(params, "url")) return false;
    const url = params.url;
    return !(url === undefined || url === "" || url === "about:blank");
  }

  function forwardText(client, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { debug(`client ${client.id}: a frame that is not JSON, dropped`); return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (refusesInitialUrl(msg)) {
      // Refused before anything is forwarded: an initial-URL target would fetch its URL
      // before the guard could attach (see refusesInitialUrl). The client's own id comes
      // back, so it sees a normal CDP error and the connection stays open; nothing is
      // queued and no pending entry is created.
      debug(`client ${client.id}: a Target.createTarget with an initial URL was refused`);
      if (msg.id !== undefined) {
        send(client, { id: msg.id, error: { code: -32602, message: "Target.createTarget with a URL is refused: create the page as about:blank and navigate it" } });
      }
      return;
    }
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
    // Node drops its own socket error handler before handing over an upgrade socket. A peer
    // that resets while we answer (401 included) must never become an uncaught exception,
    // which would take the relay, and Chromium with it, down.
    socket.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });
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
    // In pipe mode this is how Chromium's fate reaches the relay: the peer end is gone.
    resolvePipeClosed({ code: reason === "eof" ? 0 : 1, signal: null, reason });
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

  // reusePort is deliberately NEVER set, here or in the caps: SO_REUSEPORT lets another
  // process of this same uid bind 127.0.0.1:port too, and the kernel would then hand it a
  // share of the connections — its clients' CDP commands and their bearer tokens. One
  // owner of the port, always: this process, or nothing.
  actualPort = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
  // After listen, a server error (an accept failure such as EMFILE) is logged, never thrown:
  // an uncaught one would stop the relay and the browser with it.
  server.on("error", (err) => { try { console.error(`[cdp-relay] server error: ${err && err.code ? err.code : "error"}`); } catch { /* ignore */ } });

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
    mode: pipeMode ? "pipe" : "spawn",
    exited,
    shutdown,
    killChromium,
    isChildExited: () => childExited,
    url: `ws://127.0.0.1:${actualPort}/devtools/browser/${relayId}`,
  };
}

/** The profile Chromium is given: the argv below and the pre-launch rewrite both use it. */
function chromiumProfileDir(env = process.env) {
  return env.CROW_CHROMIUM_PROFILE || "/root/.config/chromium-crow";
}

/**
 * Delete a profile's saved-session files, best effort.
 *
 * `Default/Sessions/` holds the session's own files and `Default/` keeps four beside it
 * (`Current Session`, `Current Tabs`, `Last Session`, `Last Tabs`). They are the crashed
 * session's pages, so they go with the rewrite. A missing directory or file is normal (a
 * profile that never crashed has none) and a failed delete is not this caller's problem:
 * neither case throws, and nothing here ever creates a file or a directory.
 */
function removeSavedSessions(defaultDir) {
  const sessionsDir = join(defaultDir, "Sessions");
  let entries = [];
  try { entries = readdirSync(sessionsDir); } catch { entries = []; } // no Sessions dir: nothing inside it
  for (const name of entries) {
    try { rmSync(join(sessionsDir, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    try { rmSync(join(defaultDir, name), { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Record the last exit as clean in the profile Chromium is about to open — but ONLY when
 * that profile says the last exit CRASHED. After the exit cleanup kills the browser
 * (`Browser.crash`, on purpose), the profile says "Crashed", and the next launch offers to
 * restore that session's pages in the VNC viewer — which can reopen a page the bot loaded.
 * The switch (--hide-crash-restore-bubble) hides the bubble; this makes the record itself
 * clean, so there is nothing to restore. Called BEFORE the spawn: Chromium reads it at
 * startup. A missing file, an unparseable one, or no Default directory does nothing at all
 * (never creates a file, never throws); the rewrite is atomic (temp file in the same
 * directory + rename, same mode), so Chromium never reads half a Preferences.
 *
 * A CLEAN record is left alone, byte for byte (exit_type "Normal", "None", or no
 * `profile.exit_type` at all): the bubble and the crashed-session restore are only a
 * problem AFTER A CRASH, and a crash is exactly what the exit cleanup's `Browser.crash`
 * causes on purpose. Rewriting a clean profile would be destructive in its own right — it
 * re-serialises the operator's own file, overrides a "continue where you left off" they
 * chose deliberately, and deletes session files that belong to a clean exit — so the whole
 * rewrite below is gated on `profile.exit_type === "Crashed"`.
 *
 * The bubble is not the only way a crashed session comes back: a profile whose startup
 * setting is "Continue where you left off" (session.restore_on_startup 1, or 4 on some
 * builds) reopens the crashed tabs by itself, bubble or no bubble. So the same rewrite
 * points that setting at the new tab page (5) — the other keys of `session` are kept, and
 * any other value (the default, "open the new tab page", "open a specific page") is left
 * exactly as the operator set it — and then deletes the saved session it would have
 * restored. Nothing is deleted before the profile is known to be parsable and crashed: a
 * Preferences this function will not touch leaves its session files alone too.
 */
export function markProfileExitClean(profileDir) {
  if (typeof profileDir !== "string" || !profileDir) return;
  const prefs = join(profileDir, "Default", "Preferences");
  let raw;
  let mode;
  try {
    mode = statSync(prefs).mode & 0o777;
    raw = readFileSync(prefs, "utf8");
  } catch { return; } // no file (or no Default dir): nothing to rewrite, nothing to create
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; } // unparseable: leave the bytes alone
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const profile = parsed.profile && typeof parsed.profile === "object" && !Array.isArray(parsed.profile) ? parsed.profile : {};
  // ACT ON A CRASHED RECORD ONLY. A clean profile has nothing to restore, so its file,
  // its restore_on_startup setting and its saved session are none of this function's
  // business — and "None" or a missing key says nothing about a crash either.
  if (profile.exit_type !== "Crashed") return;
  profile.exit_type = "Normal";
  profile.exited_cleanly = true;
  parsed.profile = profile;
  // "Continue where you left off" restores the crashed session on its own, bubble or not:
  // only that setting is changed, and only to the new tab page. 3 ("open a specific page")
  // names the operator's own start pages and is none of this rewrite's business.
  const session = parsed.session && typeof parsed.session === "object" && !Array.isArray(parsed.session) ? parsed.session : null;
  if (session && (session.restore_on_startup === 1 || session.restore_on_startup === 4)) {
    session.restore_on_startup = 5;
    parsed.session = session;
  }

  const dir = dirname(prefs);
  const temp = join(dir, `.Preferences.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeSync(fd, JSON.stringify(parsed));
    closeSync(fd);
    fd = undefined;
    renameSync(temp, prefs);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* gone */ } }
    try { rmSync(temp, { force: true }); } catch { /* gone */ }
    throw err;
  }
  // The profile is clean and points at the new tab page; the pages themselves are the one
  // thing left that a launch could reopen, so they go now (after the rewrite: a profile this
  // function refused to touch keeps its session files).
  removeSavedSessions(dir);
}

/** The Chromium argv: the entrypoint's flags, minus the debugging port, plus the pipe. */
export function chromiumArguments(env = process.env) {
  const profileDir = chromiumProfileDir(env);
  const args = [
    "--no-sandbox", "--disable-setuid-sandbox",
    // No --remote-debugging-port and no --remote-allow-origins: with a pipe there is no
    // port to open and no Origin check to disable; the relay's bearer is the control.
    "--remote-debugging-pipe",
    "--disable-blink-features=AutomationControlled",
    // Defence in depth next to the page-level WebRTC disable in server/private-address.js;
    // a live test found some Chromium builds ignore the switch, so it is not relied on alone.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    // A Back press in the VNC viewer must not restore a page the bot opened from the back-forward cache: the exit cleanup leaves a fresh about:blank page, and a later feature must be comma-merged into this one flag (Chromium honours only the last --disable-features).
    "--disable-features=BackForwardCache",
    "--window-size=1920,1080", "--start-maximized",
    "--no-first-run", "--no-default-browser-check",
    "--disable-infobars", "--disable-extensions",
    // The exit cleanup kills the browser, so a restart would offer to restore the crashed
    // session's pages in the VNC viewer — a way back into a page the bot loaded.
    "--hide-crash-restore-bubble",
    `--user-data-dir=${profileDir}`,
  ];
  if (env.CHROME_PROXY) args.push(`--proxy-server=${env.CHROME_PROXY}`);
  args.push("about:blank");
  return args;
}

/**
 * The CLI. Three modes, and the first two are the container's shape since 1.7.0:
 *
 *   --supervise  root: start Chromium (root) and the relay (the gateway's uid), own both,
 *                and write the ready file once the relay reports in.
 *   --attach     the gateway's uid: serve 127.0.0.1:${CDP_PORT} from the pipe on fds 3/4
 *                and report ready on fd 5. Never writes the ready file, never spawns.
 *   (no flag)    the pre-1.7.0 shape, kept for the unit tests: spawn Chromium here, serve,
 *                write the ready file, and share fate with Chromium.
 *
 * Env (none of it secret): CDP_PORT, CHROME_PATH, CHROME_PROXY, CROW_CHROMIUM_PROFILE,
 * CROW_CDP_TOKEN_FILE, CROW_CDP_READY_FILE, CROW_CDP_DEBUG, CROW_CDP_RELAY_UID /
 * CROW_CDP_RELAY_GID (the supervisor's), plus the test seams CROW_CDP_CHROMIUM_ARGV (a
 * JSON argv prefix that speaks the pipe) and the size caps CROW_CDP_MAX_FRAME /
 * CROW_CDP_MAX_CLIENT_BUFFER / CROW_CDP_MAX_CONNECTIONS / CROW_CDP_MAX_HEADER /
 * CROW_CDP_HANDSHAKE_TIMEOUT_MS / CROW_CDP_CLOSE_TIMEOUT_MS.
 */
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--supervise")) return supervise();
  if (argv.includes("--attach")) return attach();
  return serveInProcess();
}

/** The debug-aware loggers every mode uses. */
function loggers() {
  const debugOn = process.env.CROW_CDP_DEBUG === "1";
  const log = (msg) => console.log(`[cdp-relay] ${msg}`);
  const debug = (msg) => { if (debugOn) log(msg); };
  return { log, debug };
}

/** The default ready file: inside the root-owned 0755 directory the entrypoint creates. */
const DEFAULT_READY_FILE = "/run/crow-cdp-ready/cdp-relay.ready";

/**
 * Write the ready file the way root must: unlink whatever is there, create a FRESH file
 * under a random temp name with O_CREAT|O_EXCL|O_NOFOLLOW (so a symlink or a name planted
 * at that path is refused, never followed or truncated), write the body, then rename it
 * into place inside the same directory. The rename is what makes the entrypoint's
 * `[ -s "$CDP_READY_FILE" ]` see either nothing or the whole line, and the directory is
 * root-owned, so no process of the relay's uid can plant or replace it.
 */
function writeReadyFile(readyFile, body) {
  const dir = dirname(readyFile);
  mkdirSync(dir, { recursive: true });
  try { rmSync(readyFile, { force: true, recursive: true }); } catch { /* the create below refuses what is left */ }
  const temp = join(dir, `.${basename(readyFile)}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o644);
    writeSync(fd, body);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, readyFile);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* gone */ } }
    try { rmSync(temp, { force: true }); } catch { /* gone */ }
    throw err;
  }
}

/**
 * The pre-1.7.0 shape (no flag): Chromium is this process's own child, the ready file is
 * written here, and the exit code is Chromium's. The unit tests drive this directly.
 */
async function serveInProcess() {
  const { log, debug } = loggers();
  const token = readToken();
  const port = readPort();
  const chromiumArgv = chromiumCommand();
  debug(`Chromium: ${chromiumArgv[0]}`);
  // Before the browser reads the profile: an unclean last exit is what the bubble is for.
  try { markProfileExitClean(chromiumProfileDir()); } catch (err) { debug(`could not mark the profile clean: ${(err && err.message) || err}`); }

  let relay;
  try {
    relay = await createRelay({ token, port, chromiumArgv, log, debug, ...capsFromEnv() });
  } catch (err) {
    die(String((err && err.message) || err));
  }

  const readyFile = process.env.CROW_CDP_READY_FILE || DEFAULT_READY_FILE;
  const removeReadyFile = () => { try { rmSync(readyFile, { force: true }); } catch { /* gone */ } };
  try {
    writeReadyFile(readyFile, JSON.stringify({ pid: process.pid, port: relay.port, browser: String(relay.version.product || "") }) + "\n");
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

/**
 * --attach: the gateway's uid. The pipe is already open (the supervisor passed Chromium's
 * fds 3 and 4), so this mode wraps them and serves the host contract on the loopback port.
 * It never spawns, never writes the ready file (it could not: it is not root), and exits
 * when the pipe closes — Chromium's death is its death.
 */
async function attach() {
  const { log, debug } = loggers();
  const token = readToken();
  const port = readPort();
  // The inherited fds are socketpairs (Node's `pipe` stdio), so a net.Socket can wrap
  // them: input is the end Chromium reads (we write), output the end it writes (we read).
  const input = new net.Socket({ fd: 3, readable: true, writable: true });
  const output = new net.Socket({ fd: 4, readable: true, writable: true });

  let relay;
  try {
    relay = await createRelay({ token, port, pipe: { input, output }, log, debug, ...capsFromEnv() });
  } catch (err) {
    die(String((err && err.message) || err));
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : "?";
  log(`ready on 127.0.0.1:${relay.port} — Chromium ${relay.version.product || "(unknown)"} over a pipe, bearer required, as uid ${uid}`);
  // One line on fd 5 is the supervisor's cue to write the ready file. It carries the port
  // and the browser, never the token.
  try {
    writeSync(5, `ready ${JSON.stringify({ port: relay.port, browser: String(relay.version.product || "") })}\n`);
    closeSync(5);
  } catch {
    relay.killChromium();
    die("cannot report ready to the supervisor (fd 5): start this mode through --supervise");
  }

  let stopping = false;
  void relay.exited.then(({ code }) => {
    if (stopping) return;
    log("the pipe to Chromium closed; exiting with it");
    process.exit(typeof code === "number" ? code : 1);
  });

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: closing Chromium through the pipe...`);
    await relay.shutdown(0);
    log("stopped.");
    process.exit(0);
  };
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
  process.on("SIGINT", () => { void stop("SIGINT"); });
  const crash = (err) => {
    console.error(`[cdp-relay] FATAL: ${(err && err.message) || err}`);
    relay.killChromium();
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  // Last resort for any other exit path: close the pipe, which is all this side has to do.
  process.on("exit", () => relay.killChromium());
}

/**
 * --supervise: the root process the entrypoint starts. It owns Chromium (left root: the
 * image's /root is 0700 and the profile lives there) and the relay (re-exec'd as the
 * GATEWAY's uid through setpriv), gives the relay Chromium's pipe and a report pipe, and
 * writes the ready file itself. It listens on no socket of any kind.
 */
async function supervise() {
  const { log, debug } = loggers();
  const uid = parseId(process.env.CROW_CDP_RELAY_UID);
  if (uid === null) {
    die(`CROW_CDP_RELAY_UID ('${String(process.env.CROW_CDP_RELAY_UID ?? "")}') is not a decimal uid between 0 and ${MAX_ID}. Crow's gateway passes it when it runs compose (from CROW_GATEWAY_UID): the relay must listen as the gateway's own uid, and there is no default.`);
  }
  const gid = parseId(process.env.CROW_CDP_RELAY_GID);
  if (gid === null) {
    die(`CROW_CDP_RELAY_GID ('${String(process.env.CROW_CDP_RELAY_GID ?? "")}') is not a decimal gid between 0 and ${MAX_ID}. Crow's gateway passes it when it runs compose (from CROW_GATEWAY_GID), alongside CROW_CDP_RELAY_UID; there is no default.`);
  }
  const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
  // Root can start the relay on any uid; anything else can only start it on its own, and a
  // relay on a uid the gateway does not have would be refused by the add-on wall anyway.
  const drop = euid === 0 && uid !== 0;
  if (euid === 0) {
    if (!drop) log("CROW_CDP_RELAY_UID is 0: this gateway runs as root, so the relay runs as root too (no uid split).");
    else if (!existsSync(SETPRIV)) die(`${SETPRIV} is missing from this image, so the relay cannot be started as uid ${uid}: rebuild the browser image (the Dockerfile asserts it).`);
  } else if (uid !== euid) {
    die(`CROW_CDP_RELAY_UID (${uid}) is not this process's uid (${euid}): without root the relay can only run as its own uid, and one on another uid would be refused by the add-on wall.`);
  }

  const caps = capsFromEnv();
  const readyFile = process.env.CROW_CDP_READY_FILE || DEFAULT_READY_FILE;
  const chromiumArgv = chromiumCommand();
  debug(`Chromium: ${chromiumArgv[0]}`);
  // The profile belongs to root, and this is the root process: clean it before the spawn.
  try { markProfileExitClean(chromiumProfileDir()); } catch (err) { debug(`could not mark the profile clean: ${(err && err.message) || err}`); }

  // Chromium keeps this process's environment minus every secret-shaped name (the token's
  // location included), exactly as before the split.
  const chromeEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV_RE.test(k)) chromeEnv[k] = v;
  const chrome = spawn(chromiumArgv[0], chromiumArgv.slice(1), {
    stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"],
    detached: true,
    env: chromeEnv,
  });
  if (!chrome.stdio || !chrome.stdio[3] || !chrome.stdio[4]) {
    try { chrome.kill("SIGKILL"); } catch { /* gone */ }
    die("Chromium did not get its pipe (fds 3 and 4), so there is nothing for the relay to attach to");
  }

  const relayEnv = {};
  for (const key of RELAY_ENV_KEYS) if (process.env[key] !== undefined) relayEnv[key] = process.env[key];

  const relay = drop
    ? spawn(SETPRIV, [
      "--reuid", String(uid), "--regid", String(gid), "--clear-groups",
      "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs",
      "--", process.execPath, SELF, "--attach",
    ], { stdio: ["ignore", "inherit", "inherit", chrome.stdio[3], chrome.stdio[4], "pipe"], env: relayEnv })
    : spawn(process.execPath, [SELF, "--attach"], {
      stdio: ["ignore", "inherit", "inherit", chrome.stdio[3], chrome.stdio[4], "pipe"],
      env: relayEnv,
    });

  // In this same synchronous tick: the relay is the pipe's only reader from now on. A
  // net.Socket starts reading the moment it exists, so a listener left on these copies
  // could swallow a frame that the relay then never sees. Destroy them, attach nothing.
  for (const stream of [chrome.stdio[3], chrome.stdio[4]]) { try { stream.destroy(); } catch { /* gone */ } }

  let chromeExited = false;
  let chromeCode = 1;
  let relayExited = false;
  let stopping = false;
  let finished = false;
  let resolveChromeExit = () => {};
  const chromeExit = new Promise((resolve) => { resolveChromeExit = resolve; });
  let resolveRelayExit = () => {};
  const relayExit = new Promise((resolve) => { resolveRelayExit = resolve; });

  const removeReadyFile = () => { try { rmSync(readyFile, { force: true }); } catch { /* gone */ } };
  function killChromiumGroup(signal = "SIGKILL") {
    if (!chrome.pid || chromeExited) return;
    try { process.kill(-chrome.pid, signal); return; } catch { /* the group is gone */ }
    try { chrome.kill(signal); } catch { /* the process is gone */ }
  }
  function killRelay(signal = "SIGKILL") {
    if (relayExited) return;
    try { relay.kill(signal); } catch { /* gone */ }
  }
  function finish(code) {
    if (finished) return;
    finished = true;
    removeReadyFile();
    process.exit(code);
  }
  /** Is the process gone (zombie or reaped)? Read from /proc, never from an event. */
  function chromiumIsGone(pid) {
    if (!pid) return true;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const state = close >= 0 ? stat.slice(close + 2, close + 3) : "";
      return state === "Z" || state === "X";
    } catch { return true; }
  }
  const failSpawn = (code) => {
    killChromiumGroup("SIGKILL");
    killRelay("SIGKILL");
    finish(code);
  };

  chrome.once("exit", (code, signal) => {
    chromeExited = true;
    chromeCode = code === null ? 1 : code;
    resolveChromeExit();
    if (stopping || finished) return;
    if (relayExited) { finish(chromeCode); return; } // the relay's fate is already settled
    log(`Chromium exited (${code === null ? "signal" : `code ${code}`}); stopping the relay`);
    killRelay("SIGTERM");
    void Promise.race([relayExit, delay(2000)]).then(() => finish(chromeCode));
  });
  chrome.once("error", (err) => {
    if (finished) return;
    console.error(`[cdp-relay] FATAL: cannot start Chromium (${err && err.code ? err.code : "error"})`);
    failSpawn(127);
  });
  relay.once("exit", (code, signal) => {
    relayExited = true;
    resolveRelayExit();
    if (stopping || finished) return;
    if (chromeExited) { finish(chromeCode); return; }
    // Chromium closing its fds is exactly what the relay sees as EOF, so when Chromium died
    // first its exit event may still be in flight: if the process is already gone, give the
    // kernel a moment to report its code, and let that code win. If Chromium is still alive,
    // the relay really did go first — kill the group and answer with the relay's code.
    const graceMs = chromiumIsGone(chrome.pid) ? 500 : 0;
    void Promise.race([chromeExit, delay(graceMs)]).then(() => {
      if (stopping || finished) return;
      if (chromeExited) { finish(chromeCode); return; }
      log(`the CDP relay exited (${signal ? `signal ${signal}` : `code ${code}`}); stopping Chromium`);
      killChromiumGroup("SIGKILL");
      finish(signal ? 1 : code === null ? 1 : code);
    });
  });
  relay.once("error", (err) => {
    if (finished) return;
    console.error(`[cdp-relay] FATAL: cannot start the relay (${err && err.code ? err.code : "error"})`);
    failSpawn(1);
  });

  // The graceful path: the relay asks Chromium to close over the pipe (which is what
  // commits its cookie store), and Chromium's own exit is the signal that it is done. Past
  // the relay's own close timeout plus 2 s, the group goes.
  const stop = async (signal) => {
    if (stopping || finished) return;
    stopping = true;
    log(`${signal}: closing Chromium through the relay...`);
    killRelay("SIGTERM");
    const budgetMs = caps.closeTimeoutMs + 2000;
    const how = await Promise.race([chromeExit, delay(budgetMs).then(() => "timeout")]);
    if (how === "timeout") {
      log(`Chromium did not close within ${Math.round(budgetMs / 1000)}s — killing it`);
      killChromiumGroup("SIGKILL");
    }
    await Promise.race([relayExit, delay(2000)]);
    log("stopped.");
    finish(0);
  };
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
  process.on("SIGINT", () => { void stop("SIGINT"); });
  const crash = (err) => {
    console.error(`[cdp-relay] FATAL: ${(err && err.message) || err}`);
    failSpawn(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  // Last resort for every other exit path: leave neither the browser nor the relay behind.
  process.on("exit", () => {
    killChromiumGroup("SIGKILL");
    killRelay("SIGKILL");
  });

  let info;
  try {
    info = await readReadyLine(relay.stdio[5], READY_TIMEOUT_MS);
  } catch (err) {
    const why = String((err && err.message) || err);
    console.error(`[cdp-relay] FATAL: ${why}`);
    failSpawn(1);
    return;
  }
  // Written here, as root, through the same safe writer: the relay's uid cannot write in
  // that directory, and the JSON is the same one the pre-split relay wrote (pid, port,
  // browser — never the token).
  try {
    writeReadyFile(readyFile, JSON.stringify({ pid: relay.pid, port: info.port, browser: String(info.browser || "") }) + "\n");
  } catch {
    console.error(`[cdp-relay] FATAL: cannot write the ready file (${readyFile})`);
    failSpawn(1);
    return;
  }
  log(`ready on 127.0.0.1:${info.port} — Chromium ${info.browser || "(unknown)"} over a pipe, bearer required, relay as uid ${uid}${drop ? "" : " (no uid drop)"}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => die(String((err && err.message) || err)));
}