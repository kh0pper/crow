/**
 * Live browser tile: the gateway's read-only CDP client (spec §4.3).
 *
 * The gateway watches the bot's page; it never drives it. Every message this
 * client puts on the DevTools socket goes through cdpSend(), which refuses
 * any method outside ALLOWED_CDP with a synchronous throw — so no input, no
 * navigation, no script evaluation, no new targets and no auto-attach can
 * ever be sent from here, whatever a caller asks for.
 *
 * Errors carry a code only: a CDP error message can quote a page URL, and
 * URLs never reach a log (spec §4.2).
 */

const ALLOWED = [
  "Target.getTargets",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Page.enable",
  "Page.startScreencast",
  "Page.screencastFrameAck",
  "Page.stopScreencast",
  "Page.captureScreenshot",
];

/** The private set the gate checks: changing the exported copy widens nothing. */
const GATE = new Set(ALLOWED);

/** The read-only CDP methods the gateway may send (a copy, for tests and docs). */
export const ALLOWED_CDP = new Set(ALLOWED);

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Throws ECDPREFUSED unless `method` is on the read-only list. */
export function assertAllowedCdp(method) {
  if (typeof method !== "string" || !GATE.has(method)) throw codeError("ECDPREFUSED", "CDP method refused");
}

/**
 * Wrap a DevTools WebSocket (the `ws` package's socket, or a test fake with
 * the same send/on/close surface) in a request/response client.
 *
 * @returns {{
 *   cdpSend(method: string, params?: object, sessionId?: string|null): Promise<object>,
 *   onEvent(fn: (method: string, params: object, sessionId: string|null) => void): () => void,
 *   onClose(fn: () => void): void,
 *   close(): void,
 *   readonly closed: boolean,
 * }}
 */
export function createCdpClient(socket, { callTimeoutMs = 5000, maxPending = 64 } = {}) {
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();
  const closers = new Set();

  function settleAll() {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(codeError("ECDPCLOSED", "CDP connection closed")); }
    pending.clear();
  }

  function onClosed() {
    if (closed) return;
    closed = true;
    settleAll();
    for (const fn of closers) { try { fn(); } catch { /* a listener's own problem */ } }
    closers.clear();
    listeners.clear();
  }

  socket.on("message", (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (typeof m.id === "number") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(codeError("ECDPERROR", "CDP error " + (Number.isInteger(m.error.code) ? m.error.code : "")));
      else p.resolve(m.result && typeof m.result === "object" ? m.result : {});
      return;
    }
    if (typeof m.method !== "string") return;
    const params = m.params && typeof m.params === "object" ? m.params : {};
    const sid = typeof m.sessionId === "string" ? m.sessionId : null;
    for (const fn of listeners) { try { fn(m.method, params, sid); } catch { /* a listener's own problem */ } }
  });
  socket.on("close", onClosed);
  socket.on("error", () => { /* 'close' follows */ });

  /** The ONLY way a message reaches the browser. */
  function cdpSend(method, params = {}, sessionId = null) {
    assertAllowedCdp(method);
    if (closed) return Promise.reject(codeError("ECDPCLOSED", "CDP connection closed"));
    if (pending.size >= maxPending) return Promise.reject(codeError("ECDPBUSY", "too many CDP calls in flight"));
    const id = ++nextId;
    const msg = { id, method, params: params && typeof params === "object" ? params : {} };
    if (typeof sessionId === "string" && sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(codeError("ECDPTIMEOUT", "CDP call timed out"));
      }, callTimeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(codeError("ECDPCLOSED", "CDP connection closed"));
      }
    });
  }

  return {
    cdpSend,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onClose(fn) { if (closed) { try { fn(); } catch { /* ignore */ } } else closers.add(fn); },
    close() {
      try { socket.close(); } catch { /* already closing */ }
      onClosed();
    },
    get closed() { return closed; },
  };
}
