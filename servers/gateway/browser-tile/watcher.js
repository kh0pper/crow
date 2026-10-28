/**
 * Live browser tile: the gateway's read-only browser watcher (spec §4.3, §4.5).
 *
 * One watcher per gateway process. It
 *   - watches the shared lease (fs.watch on the lease dir, debounced 250 ms,
 *     plus a 1 s poll that is the truth) and reports every bot holding to the
 *     Perch engine with the leased page's domain, read from CDP — so the tile
 *     lights while the bot's first browser call is still running;
 *   - streams the leased page to the holding session's tile: a JPEG
 *     screencast paced at the source by delaying each screencastFrameAck
 *     (≤ 2 frames/s, ≤ 1 frame/s at 480 px when every viewer is a phone),
 *     stopped after 10 s without a poll and detached after 30 s;
 *   - takes the turn's final screenshot (≤ 1280 px wide) for the final-shot
 *     hook, only while the lease is still that session's at the turn's gen.
 *
 * Which browser (spec §4.3, §7 item 6): only this CROW_HOME's own. The watcher
 * runs only when this instance's installed.json lists `browser`; the CDP port
 * comes from this instance's bundle .env; the bare 9222 is used only when this
 * instance's own CROW_BROWSER_CONTAINER_NAME container is running AND its
 * /downloads mount is this instance's browser-downloads dir. A containerized
 * gateway never watches. CDP is loopback only.
 *
 * Read-only: every CDP message goes through cdp-allowlist.js's cdpSend gate,
 * and attachToTarget is only ever sent for the lease's own targetId.
 *
 * URLs and hostnames are never logged; log lines carry error codes only.
 */
import { existsSync, readFileSync, realpathSync, watch as fsWatch } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";
import WebSocket from "ws";
import { readLease, readLeaseLocked, isFree } from "../../shared/browser-lease.js";
import { browserInstalled, heldBySession, FORCE_BREAK_AFTER_MS } from "./session-hooks.js";
import { parseEnvText } from "../bundle-env-codec.js";
import { createCdpClient } from "./cdp-allowlist.js";

export const POLL_MS = 1000;
export const DEBOUNCE_MS = 250;
export const FRAME_MIN_MS = 500;          // ≤ 2 frames/s
export const PHONE_FRAME_MIN_MS = 1000;   // ≤ 1 frame/s on phones
export const STOP_AFTER_MS = 10_000;      // no poll → Page.stopScreencast
export const DETACH_AFTER_MS = 30_000;    // no viewer → detach
export const LONG_POLL_MS = 2000;
export const SHOT_MAX_W = 1280;
export const DEFAULT_CDP_PORT = 9222;
const DESK = { maxWidth: 640, maxHeight: 400 };
const PHONE = { maxWidth: 480, maxHeight: 300 };
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30_000;
const MAX_FRAME_B64 = 4 * 1024 * 1024;
const MAX_SHOT_B64 = 16 * 1024 * 1024;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** A log-safe word for an error (never its message: it can quote a URL). */
function codeOf(e) {
  return e && typeof e.code === "string" && /^[A-Z_]{1,32}$/.test(e.code) ? e.code : "error";
}

// ---------------------------------------------------------------------------
// which browser
// ---------------------------------------------------------------------------

/** Is this gateway itself running in a container? Then it never watches. */
export function isContainerized(exists = existsSync) {
  return exists("/.dockerenv") || exists("/run/.containerenv");
}

/** 127.0.0.0/8, ::1 and localhost only. */
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

function readBundleEnv(crowHome) {
  try { return parseEnvText(readFileSync(join(crowHome, "bundles", "browser", ".env"), "utf8")) || {}; } catch { return {}; }
}

function parsePort(raw) {
  const s = String(raw).trim();
  if (!/^[0-9]{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

function samePath(a, b) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolvePath(p); } };
  return typeof a === "string" && a.length > 0 && real(a) === real(b);
}

/**
 * `docker inspect` one container, bounded: → { running, downloads } | null.
 * `downloads` is the host path mounted at /downloads (the compose file mounts
 * <CROW_HOME>/browser-downloads there), which ties a container to its instance.
 */
export function dockerInspect(name, { bin = "docker", timeoutMs = 2000 } = {}) {
  if (typeof name !== "string" || !CONTAINER_RE.test(name)) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(bin, ["inspect", "--type", "container", name], { timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const info = JSON.parse(String(stdout))[0];
          if (!info || typeof info !== "object") return resolve(null);
          const mount = Array.isArray(info.Mounts) ? info.Mounts.find((m) => m && m.Destination === "/downloads") : null;
          resolve({ running: !!(info.State && info.State.Running === true), downloads: mount && typeof mount.Source === "string" ? mount.Source : null });
        } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

/** Cache container checks (they fork docker) for `ttlMs`. */
export function createInspectCache({ inspect = dockerInspect, now = Date.now, ttlMs = 30_000 } = {}) {
  const cache = new Map();
  return async (name) => {
    const hit = cache.get(name);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    let value = null;
    try { value = await inspect(name); } catch { value = null; }
    cache.set(name, { at: now(), value });
    return value;
  };
}

/**
 * This instance's CDP endpoint (`http://127.0.0.1:<port>`), or null.
 * Never another instance's: see the module header.
 */
export async function resolveCdpUrl({ crowHome, inspect = dockerInspect, containerized = isContainerized } = {}) {
  if (!crowHome || containerized()) return null;
  if (!browserInstalled(crowHome)) return null;
  const env = readBundleEnv(crowHome);
  const raw = env.CROW_BROWSER_CDP_PORT;
  if (raw != null && String(raw).trim() !== "") {
    const port = parsePort(raw);
    return port ? "http://127.0.0.1:" + port : null;
  }
  const name = env.CROW_BROWSER_CONTAINER_NAME ? String(env.CROW_BROWSER_CONTAINER_NAME).trim() : "crow-browser";
  if (!CONTAINER_RE.test(name)) return null;
  let info = null;
  try { info = await inspect(name); } catch { info = null; }
  if (!info || !info.running) return null;
  if (!samePath(info.downloads, join(crowHome, "browser-downloads"))) return null;
  return "http://127.0.0.1:" + DEFAULT_CDP_PORT;
}

/**
 * Connect to a loopback DevTools endpoint: /json/version → its browser
 * WebSocket, which must be loopback on the same port. → a cdp-allowlist client.
 */
export async function connectCdp(base, { timeoutMs = 2000, maxPayload = 24 * 1024 * 1024 } = {}) {
  let u;
  try { u = new URL(base); } catch { throw codeError("ECDPHOST", "bad CDP endpoint"); }
  if (u.protocol !== "http:" || !isLoopbackHost(u.hostname) || !u.port) throw codeError("ECDPHOST", "CDP endpoint is not loopback");
  let j;
  try {
    const r = await fetch(new URL("/json/version", u), { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    const text = r.ok ? await r.text() : "";
    if (!text || text.length > 65536) throw new Error("bad version");
    j = JSON.parse(text);
  } catch {
    throw codeError("ECDPVERSION", "no CDP version");
  }
  let ws;
  try { ws = new URL(j && j.webSocketDebuggerUrl); } catch { throw codeError("ECDPHOST", "bad CDP socket"); }
  if (ws.protocol !== "ws:" || !isLoopbackHost(ws.hostname) || ws.port !== u.port) throw codeError("ECDPHOST", "CDP socket is not this loopback endpoint");
  const socket = new WebSocket(ws.href, { maxPayload, handshakeTimeout: timeoutMs, followRedirects: false, perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    const fail = () => { try { socket.terminate(); } catch { /* gone */ } reject(codeError("ECDPCONNECT", "CDP connect failed")); };
    socket.once("open", resolve);
    socket.once("error", fail);
    socket.once("unexpected-response", fail);
  });
  socket.on("error", () => { /* 'close' follows */ });
  return createCdpClient(socket);
}

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

/** The tile's domain for a main-frame URL: http(s) hostname, else null ("Browser"). */
export function hostnameOf(url) {
  if (typeof url !== "string" || !url || url.length > 8192) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  return h && h.length <= 253 ? h : null;
}

/** A JPEG's pixel size from its SOF header → { w, h } | null. */
export function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (i + 9 > buf.length) return null;
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

function defaultWatchFs(dir, cb) {
  try {
    const w = fsWatch(dir, { persistent: false }, cb);
    w.on("error", () => { /* the poll carries on */ });
    return w;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// the watcher
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   enabled(): boolean,
 *   isHolder(sid: string): Promise<boolean>,
 *   frameAfter(sid: string, seq: number, opts?: { timeoutMs?: number, signal?: AbortSignal, phone?: boolean }): Promise<{seq:number, jpegB64:string, w:number, h:number}|null>,
 *   hostname(): string|null,
 *   captureFinal(sid: string, opts: { gen: number, signal?: AbortSignal }): Promise<Buffer|null>,
 *   close(): void,
 * }}
 */
export function createWatcher({
  crowHome,
  resolveCdpUrl: resolveUrl = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
  onLease = null,
  connect = connectCdp,
  containerized = isContainerized,
  inspect = null,
  installed = null,
  watchFs = defaultWatchFs,
  leaseDir = null,
  pollMs = POLL_MS,
} = {}) {
  const dir = leaseDir || join(crowHome, "browser-lease");
  const inspectCached = createInspectCache({ inspect: inspect || dockerInspect });
  const resolveEndpoint = resolveUrl || (() => resolveCdpUrl({ crowHome, inspect: inspectCached, containerized }));
  let connectFn = connect;

  let closed = false;
  let enabledCache = null;
  let lease = null;                 // the last lease read (≤ 1 s old)
  let domainOf = null;              // { targetId, value } from CDP
  let conn = null;
  let connecting = null;
  let connectedAt = 0;
  let nextConnectAt = -Infinity;
  let backoff = BACKOFF_MIN;
  let att = null;                   // { targetId, sessionId, cast: null|"desk"|"phone" }
  let latest = null;                // { seq, jpegB64, w, h, gen, sid, targetId }
  let seq = 0;
  let ackTimer = null;
  let lastAckAt = -Infinity;
  let lastPollAt = -Infinity;
  let lastDeskAt = -Infinity;
  const waiters = new Set();
  let ops = Promise.resolve();
  let pollTimer = null;
  let debounceTimer = null;
  let fsWatcher = null;
  let ticking = false;
  let tickAgain = false;
  const logged = new Map();

  function logOnce(line) {
    const t = Date.now();
    const at = logged.get(line);
    if (at && t - at < 60_000) return;
    logged.set(line, t);
    try { log(line); } catch { /* a logger's own problem */ }
  }

  function enabled() {
    if (closed) return false;
    const t = Date.now();   // a file-system cache, real clock
    if (!enabledCache || t - enabledCache.at > 60_000) {
      let ok = false;
      try { ok = !containerized() && (installed ? !!installed() : browserInstalled(crowHome)); } catch { ok = false; }
      enabledCache = { at: t, ok };
    }
    return enabledCache.ok;
  }

  /** CDP control is one queue: attach/detach/start/stop never interleave. */
  function serial(fn) {
    const p = ops.then(fn);
    ops = p.catch(() => {});
    return p;
  }

  const heldBot = (l) => !!l && !isFree(l, now()) && !!l.holder && l.holder.kind === "bot";
  const heldBy = (l, sid) => heldBySession(l, sid, now());

  async function freshLease() {
    try { return await readLease(dir); } catch { return null; }
  }

  // ---- connection ----------------------------------------------------------

  function failConnect(e) {
    nextConnectAt = now() + backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
    if (e) logOnce("browser watcher: browser unavailable (" + codeOf(e) + ")");
  }

  function dropConn(c) {
    if (conn !== c) return;
    if (now() - connectedAt >= 10_000) backoff = BACKOFF_MIN;   // it was healthy: start over
    conn = null;
    att = null;
    clearAck();
    nextConnectAt = now() + backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }

  async function ensureConnected() {
    if (closed) return null;
    if (conn && !conn.closed) return conn;
    if (connecting) return connecting;
    if (now() < nextConnectAt) return null;
    connecting = (async () => {
      let base = null;
      try { base = await resolveEndpoint(); } catch { base = null; }
      if (closed) return null;
      if (!base) { failConnect(null); return null; }
      try {
        const u = new URL(base);
        if (!isLoopbackHost(u.hostname)) throw codeError("ECDPHOST", "not loopback");
        const c = await connectFn(base);
        if (closed) { c.close(); return null; }
        conn = c;
        connectedAt = now();
        c.onEvent(onCdpEvent);
        c.onClose(() => dropConn(c));
        return c;
      } catch (e) {
        failConnect(e);
        return null;
      }
    })().finally(() => { connecting = null; });
    return connecting;
  }

  // ---- CDP events ------------------------------------------------------------

  function clearAck() {
    if (ackTimer != null) { clearTimer(ackTimer); ackTimer = null; }
  }

  function onCdpEvent(method, params, sessionId) {
    if (method === "Page.screencastFrame") return onFrame(params, sessionId);
    if (method === "Target.detachedFromTarget" && att && params.sessionId === att.sessionId) {
      att = null;
      clearAck();
    }
  }

  function onFrame(params, sessionId) {
    const a = att;
    if (!a || !a.cast || sessionId !== a.sessionId) return;   // a straggler from an old page
    const ackId = params.sessionId;
    if (!Number.isInteger(ackId)) return;
    const data = params.data;
    const l = lease;
    if (typeof data === "string" && data.length <= MAX_FRAME_B64 && heldBot(l) && l.targetId === a.targetId) {
      const size = jpegSize(Buffer.from(data.slice(0, 8192), "base64"));
      if (size) {
        latest = { seq: ++seq, jpegB64: data, w: size.w, h: size.h, gen: l.gen, sid: l.holder.sessionId, targetId: a.targetId };
        for (const w of [...waiters]) w.check();
      }
    }
    scheduleAck(ackId, a);
  }

  /** Pacing at the source: Chromium sends the next frame only after the ack. */
  function scheduleAck(ackId, a) {
    const interval = a.cast === "phone" ? PHONE_FRAME_MIN_MS : FRAME_MIN_MS;
    const wait = Math.max(0, lastAckAt + interval - now());
    clearAck();
    ackTimer = setTimer(() => {
      ackTimer = null;
      const c = conn;
      if (!c || att !== a || !a.cast) return;
      lastAckAt = now();
      c.cdpSend("Page.screencastFrameAck", { sessionId: ackId }, a.sessionId).catch(() => {});
    }, wait);
  }

  // ---- attach / cast (always inside serial) ---------------------------------

  async function detach(c) {
    const a = att;
    if (!a) return;
    att = null;
    clearAck();
    if (a.cast) await c.cdpSend("Page.stopScreencast", {}, a.sessionId).catch(() => {});
    await c.cdpSend("Target.detachFromTarget", { sessionId: a.sessionId }).catch(() => {});
  }

  async function stopCast(c) {
    const a = att;
    if (!a || !a.cast) return;
    a.cast = null;
    clearAck();
    await c.cdpSend("Page.stopScreencast", {}, a.sessionId).catch(() => {});
  }

  /** Attach to exactly the lease's targetId (any other id is never sent). */
  async function attachTo(c, targetId) {
    if (att && att.targetId === targetId) return att;
    if (att) await detach(c);
    if (!lease || lease.targetId !== targetId || typeof targetId !== "string") return null;
    const r = await c.cdpSend("Target.attachToTarget", { targetId, flatten: true });
    if (!r || typeof r.sessionId !== "string" || conn !== c) return null;
    att = { targetId, sessionId: r.sessionId, cast: null };
    await c.cdpSend("Page.enable", {}, r.sessionId);
    return att;
  }

  const wantMode = () => (now() - lastDeskAt <= STOP_AFTER_MS ? "desk" : "phone");

  function ensureCasting() {
    return serial(async () => {
      const l = lease;
      if (closed || !heldBot(l) || !l.targetId) return;
      if (now() - lastPollAt >= STOP_AFTER_MS) return;
      const c = await ensureConnected();
      if (!c) return;
      const a = await attachTo(c, l.targetId);
      if (!a || att !== a) return;
      const mode = wantMode();
      if (a.cast === mode) return;
      if (a.cast) await stopCast(c);
      const p = mode === "phone" ? PHONE : DESK;
      a.cast = mode;   // before the call: its first frame can beat the reply's continuation
      try {
        await c.cdpSend("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: p.maxWidth, maxHeight: p.maxHeight, everyNthFrame: 1 }, a.sessionId);
      } catch (e) {
        if (att === a) a.cast = null;
        throw e;
      }
    });
  }

  async function lookupDomain(c, targetId) {
    try {
      const r = await c.cdpSend("Target.getTargets", {});
      const t = Array.isArray(r.targetInfos) ? r.targetInfos.find((x) => x && x.targetId === targetId) : null;
      return t ? hostnameOf(t.url) : undefined;
    } catch { return undefined; }
  }

  // ---- the lease watch -------------------------------------------------------

  async function tick() {
    if (closed) return;
    if (ticking) { tickAgain = true; return; }
    ticking = true;
    try {
      do {
        tickAgain = false;
        await tickOnce();
      } while (tickAgain && !closed);
    } catch (e) {
      logOnce("browser watcher: " + codeOf(e));
    } finally { ticking = false; }
  }

  async function tickOnce() {
    if (!enabled()) {
      if (conn) { const c = conn; await serial(() => detach(c)); c.close(); }
      return;
    }
    if (!fsWatcher) fsWatcher = watchFs(dir, onFsEvent) || null;
    const l = await freshLease();
    lease = l;
    if (!heldBot(l)) {
      domainOf = null;
      const c = conn;
      if (c) {
        await serial(() => detach(c));
        if (now() - lastPollAt >= DETACH_AFTER_MS && conn === c) { conn = null; c.close(); }
      }
      return;
    }
    let domain;
    if (l.targetId) {
      const c = await ensureConnected();
      if (c) domain = await lookupDomain(c, l.targetId);
      if (domain !== undefined) domainOf = { targetId: l.targetId, value: domain };
    }
    if (onLease) {
      try { onLease(l, domain === undefined ? {} : { domain }); } catch (e) { logOnce("browser watcher: lease hook " + codeOf(e)); }
    }
    const c = conn;
    if (c) {
      await serial(async () => {
        if (att && att.targetId !== l.targetId) await detach(c);
        const idle = now() - lastPollAt;
        if (att && att.cast && idle >= STOP_AFTER_MS) await stopCast(c);
        if (att && idle >= DETACH_AFTER_MS) await detach(c);
      });
    }
    if (l.targetId && now() - lastPollAt < STOP_AFTER_MS) await ensureCasting().catch(() => {});
  }

  function onFsEvent() {
    if (closed || debounceTimer != null) return;
    debounceTimer = setTimer(() => { debounceTimer = null; tick(); }, DEBOUNCE_MS);
  }

  function armPoll() {
    if (closed) return;
    pollTimer = setTimer(async function leasePoll() {
      pollTimer = null;
      await tick();
      armPoll();
    }, pollMs);
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
  }
  armPoll();

  // ---- the public surface --------------------------------------------------

  async function isHolder(sid) {
    if (!enabled()) return false;
    return heldBy(await freshLease(), sid);
  }

  async function frameAfter(sid, after, { timeoutMs = LONG_POLL_MS, signal = null, phone = false } = {}) {
    if (!enabled() || (signal && signal.aborted)) return null;
    const t = now();
    lastPollAt = t;
    if (!phone) lastDeskAt = t;
    const l = await freshLease();
    if (!heldBy(l, sid) || !l.targetId) return null;
    lease = l;
    const since = Number.isSafeInteger(after) && after > 0 ? after : 0;
    const fits = (f) => !!f && f.seq > since && f.sid === sid && f.gen === l.gen && f.targetId === l.targetId;
    const pick = (f) => ({ seq: f.seq, jpegB64: f.jpegB64, w: f.w, h: f.h });
    ensureCasting().catch((e) => logOnce("browser watcher: screencast " + codeOf(e)));
    if (fits(latest)) return pick(latest);
    if (signal && signal.aborted) return null;
    return new Promise((resolve) => {
      const w = {};
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        waiters.delete(w);
        if (w.timer != null) clearTimer(w.timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => finish(null);
      w.check = () => { if (fits(latest)) finish(pick(latest)); };
      w.cancel = () => finish(null);
      w.timer = setTimer(() => finish(null), Math.min(Math.max(0, Number(timeoutMs) || 0), 30_000));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      waiters.add(w);
    });
  }

  function hostname() {
    const l = lease;
    if (!domainOf || !heldBot(l) || l.targetId !== domainOf.targetId) return null;
    return domainOf.value || null;
  }

  async function shoot(c, a, params) {
    const r = await c.cdpSend("Page.captureScreenshot", params, a.sessionId);
    if (!r || typeof r.data !== "string" || r.data.length > MAX_SHOT_B64) return null;
    return Buffer.from(r.data, "base64");
  }

  /** The turn's final screenshot (JPEG q70, ≤ 1280 px wide), or null. */
  async function captureFinal(sid, { gen, signal = null } = {}) {
    if (!enabled() || (signal && signal.aborted)) return null;
    const stillOurs = async () => {
      const l = await freshLease();
      return heldBy(l, sid) && l.gen === gen && l.targetId ? l : null;
    };
    const l = await stillOurs();
    if (!l) return null;
    lease = l;
    return serial(async () => {
      const c = await ensureConnected();
      if (!c || (signal && signal.aborted)) return null;
      const a = await attachTo(c, l.targetId);
      if (!a || att !== a) return null;
      let buf = await shoot(c, a, { format: "jpeg", quality: 70 });
      let size = buf && jpegSize(buf);
      if (!size) return null;
      if (size.w > SHOT_MAX_W) {
        // Clip in CSS pixels; a HiDPI page's device ratio is learnt from the result.
        const base = { w: size.w, h: size.h };
        const scale = SHOT_MAX_W / base.w;
        let css = { w: base.w, h: base.h };
        for (let i = 0; i < 2 && size.w > SHOT_MAX_W; i++) {
          if (signal && signal.aborted) return null;
          buf = await shoot(c, a, { format: "jpeg", quality: 70, clip: { x: 0, y: 0, width: css.w, height: css.h, scale } });
          size = buf && jpegSize(buf);
          if (!size) return null;
          if (size.w > SHOT_MAX_W) {
            const dpr = size.w / (css.w * scale);
            css = { w: base.w / dpr, h: base.h / dpr };
          }
        }
        if (size.w > SHOT_MAX_W) return null;
      }
      if (signal && signal.aborted) return null;
      if (!(await stillOurs())) return null;
      return buf;
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    if (pollTimer != null) { clearTimer(pollTimer); pollTimer = null; }
    if (debounceTimer != null) { clearTimer(debounceTimer); debounceTimer = null; }
    clearAck();
    for (const w of [...waiters]) w.cancel();
    if (fsWatcher) { try { fsWatcher.close(); } catch { /* closed */ } fsWatcher = null; }
    const c = conn;
    conn = null;
    att = null;
    if (c) c.close();
  }

  return {
    enabled,
    isHolder,
    frameAfter,
    hostname,
    captureFinal,
    close,
    _waitersForTest: () => waiters.size,
    _attachedForTest: () => (att ? att.targetId : null),
    _setConnectForTest: (fn) => { connectFn = fn; },
  };
}

// ---------------------------------------------------------------------------
// the final-shot hook
// ---------------------------------------------------------------------------

/**
 * The engine's browserHooks.finalShot (spec §4.5, §7 item 2, Ruling B4).
 * No shot (null) when the operator took the browser during the turn or holds
 * it now (the gateway's own memory, never the file alone), when the lease was
 * not this session's at turn end, when its gen moved since the session's own
 * last step, when the holder checked UNDER THE LOCK is not this session at
 * that gen, or when the engine's deadline fired (ctx.signal) before the store.
 */
export function createFinalShotHook({
  watcher,
  leaseDir,
  storeShot,
  createDb,
  operatorHeld = () => false,
  now = Date.now,
  log = () => {},
  urlPrefix = "/dashboard/perch-api",
} = {}) {
  return async function finalShot(ctx) {
    const signal = ctx && ctx.signal;
    const aborted = () => !!(signal && signal.aborted);
    try {
      if (!ctx || ctx.operatorTook || !ctx.heldAtEnd || !Number.isSafeInteger(ctx.genAtEnd)) return null;
      if (ctx.gen != null && ctx.gen !== ctx.genAtEnd) return null;
      if (operatorHeld() || aborted()) return null;
      const sid = ctx.sessionId;
      const locked = await readLeaseLocked(leaseDir, { lockTimeoutMs: 1000, forceBreakAfterMs: FORCE_BREAK_AFTER_MS });
      if (!heldBySession(locked, sid, now()) || locked.gen !== ctx.genAtEnd) return null;
      if (operatorHeld() || aborted()) return null;
      const buf = await watcher.captureFinal(sid, { gen: ctx.genAtEnd, signal });
      if (!buf || operatorHeld() || aborted()) return null;
      const db = createDb();
      let stored;
      try {
        stored = await storeShot(db, { sessionId: sid, botId: ctx.botId, threadId: ctx.threadId || sid, outputsDir: ctx.outputsDir || null },
          { buf, hostname: watcher.hostname(), anchor: ctx.anchor || null });
      } finally { try { db.close(); } catch { /* closed */ } }
      if (!stored || typeof stored.name !== "string") return null;
      return { id: stored.id, url: urlPrefix + "/interactive/" + encodeURIComponent(sid) + "/workspace/" + encodeURIComponent(stored.name) };
    } catch (e) {
      try { log("browser final shot: " + codeOf(e)); } catch { /* ignore */ }
      return null;
    }
  };
}
