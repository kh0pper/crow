/**
 * The dedicated proxy socket — the security audit's finding (N1a-3/N1a-4).
 *
 * The installer's Caddy used to dial the gateway on loopback, so every visitor
 * arrived as a loopback socket carrying X-Forwarded-For. classifyPeer
 * (servers/shared/peer-class.js) must call that shape `unverified`, because any
 * process on this box can write the same header and there is no uid to check —
 * and the dashboard's network gate then turned the owner away right after the
 * first password was set.
 *
 * CROW_TRUSTED_PROXIES=loopback is NOT the answer (see loopbackProxyWarning):
 * it makes every same-box caller the proxy, breaks the loopback-only doors for
 * bots, and lets any local process forge a LAN client.
 *
 * So systemd owns a unix socket and the gateway receives its listening fd:
 *
 *   crow-gateway-proxy.socket   ListenStream=/run/crow-proxy/gateway.sock
 *                               SocketUser=root SocketGroup=caddy Mode=0660
 *
 *   crow-gateway.service        Sockets=crow-gateway-proxy.socket
 *                               Requires=/After=crow-gateway-proxy.socket
 *
 * The gateway then listens on the inherited fd (LISTEN_FDS, systemd socket
 * activation) and never creates, chmods or unlinks a path. That is the whole
 * point of moving the socket out of the gateway's own runtime directory:
 *
 *   - only root and the `caddy` group can open it, so a bot running as the
 *     gateway's own user cannot dial it with a forged X-Forwarded-For and be
 *     classified `proxy` (which would escape the self-origin rules that
 *     classify it `local`/`unverified`);
 *   - the mode is fixed by the unit file, not by whoever runs the gateway, and
 *     no user has to be added to the operator's group to reach it.
 *
 * Every connection accepted here is marked (PROXY_SOCKET in peer-class.js) and
 * classified `proxy` with the client Caddy named (the rightmost
 * X-Forwarded-For hop, and only that hop).
 *
 * Node built-ins only.
 */

import { createServer } from "node:http";
import { PROXY_SOCKET } from "../shared/peer-class.js";

/** The socket unit that activation fds are named after (LISTEN_FDNAMES). */
export const PROXY_SOCKET_UNIT = "crow-gateway-proxy.socket";

/** Where the unit listens (docs/tests only: the gateway never touches a path). */
export const PROXY_SOCKET_PATH = "/run/crow-proxy/gateway.sock";

/** The first fd systemd passes (after stdin/stdout/stderr). */
const FIRST_LISTEN_FD = 3;

/**
 * The inherited listening fd for our socket, or null when systemd did not
 * activate us.
 *
 * systemd sets LISTEN_PID to the pid it passed the fds to, LISTEN_FDS to how
 * many there are (numbered from fd 3), and LISTEN_FDNAMES to their unit names,
 * colon-separated in the same order. A foreign or stale LISTEN_PID is ignored
 * (that is the documented guard: an env inherited by a child must never make it
 * listen on someone else's socket).
 *
 * @param {Record<string, string|undefined>} env
 * @param {number} pid
 * @returns {number|null}
 */
export function pickProxyFd(env = process.env, pid = process.pid) {
  const listenPid = String(env.LISTEN_PID ?? "").trim();
  if (!listenPid || listenPid !== String(pid)) return null;
  const count = Number.parseInt(String(env.LISTEN_FDS ?? "").trim(), 10);
  if (!Number.isInteger(count) || count < 1) return null;
  const names = String(env.LISTEN_FDNAMES ?? "").trim();
  // No names: refuse. systemd 227+ always names passed fds, so a nameless fd
  // was not handed over by the installer's unit (review: exact match only).
  if (!names) return null;
  const list = names.split(":");
  const idx = list.findIndex((n) => n.trim() === PROXY_SOCKET_UNIT);
  if (idx >= 0) return idx < count ? FIRST_LISTEN_FD + idx : null;
  // Names that do not mention our unit: refuse. Another activated socket (say a
  // TCP one) must never be taken for the proxy socket, where every connection
  // is trusted to name its client (review: the operator could add one).
  return null;
}

/** An http server serving `app`, marking every accepted connection. */
export function createProxySocketServer(app) {
  const server = createServer(app);
  server.on("connection", (socket) => {
    try { socket[PROXY_SOCKET] = true; } catch { /* a frozen socket: it stays unverified */ }
  });
  return server;
}

/**
 * Give the proxy server the WebSocket handlers the TCP server has. Looked up
 * per upgrade, so a handler wired later (post-listen setup is partly async)
 * is still seen. Each handler ignores paths it does not own, exactly as it
 * does on the TCP server.
 */
export function mirrorUpgradeHandlers(server, mainServer) {
  server.on("upgrade", (req, socket, head) => {
    for (const handler of mainServer.listeners("upgrade")) handler.call(mainServer, req, socket, head);
  });
}

/**
 * The production path, and the only one: listen on the fd systemd handed us.
 *
 * Returns null when there is no activation fd (a dev run, `node
 * servers/gateway/index.js` by hand, any non-systemd supervisor). Never throws:
 * a listener that cannot start only costs the proxy path, not the gateway.
 *
 * @returns {import("node:http").Server|null}
 */
export function startActivatedProxySocket(app, mainServer, { env = process.env, pid = process.pid, log = console.log } = {}) {
  const fd = pickProxyFd(env, pid);
  if (fd == null) {
    if (String(env.LISTEN_PID ?? "").trim()) {
      log(`[proxy-socket] WARN no ${PROXY_SOCKET_UNIT} fd for this process (LISTEN_PID=${env.LISTEN_PID}, LISTEN_FDS=${env.LISTEN_FDS ?? ""}, pid=${pid}): Caddy's visitors will be refused`);
    } else if (String(env.INVOCATION_ID ?? "").trim()) {
      // Supervised by systemd but no socket unit in front of us (an install from
      // before the socket moved to systemd): say which unit is missing.
      log(`[proxy-socket] WARN running under systemd without ${PROXY_SOCKET_UNIT}: Caddy's visitors will be refused (scripts/fix-caddy-proxy-socket.sh installs it)`);
    }
    return null;
  }
  let server;
  try {
    server = createProxySocketServer(app);
    mirrorUpgradeHandlers(server, mainServer);
  } catch (err) {
    log(`[proxy-socket] WARN could not prepare the activation listener: ${err.message}`);
    return null;
  }
  server.on("error", (err) => log(`[proxy-socket] WARN fd ${fd}: ${err.message}`));
  server.listen({ fd }, () => {
    // Only a unix socket may be the proxy socket: on a TCP fd every LAN client
    // would be trusted to name its own address (review).
    const addr = server.address();
    if (addr && typeof addr === "object" && "port" in addr) {
      log(`[proxy-socket] REFUSED: fd ${fd} is a TCP socket, not the unix proxy socket; closing it`);
      server.close();
      return;
    }
    log(`[proxy-socket] listening on ${PROXY_SOCKET_UNIT} (${PROXY_SOCKET_PATH})`);
  });
  return server;
}

/**
 * TEST ONLY — never read from the environment, never called by the gateway.
 *
 * `target` is a unix socket PATH to listen on, or the fd number of an
 * already-listening socket (an existing `net.Server`'s `_handle.fd`), which is
 * how the activation path is exercised without systemd. Production listens only
 * on the fd systemd passes (startActivatedProxySocket above): this exists so the
 * marker and the classifier can be tested over a real HTTP round trip.
 *
 * @returns {import("node:http").Server|null}
 */
export function listenProxySocketForTests(app, mainServer, target, { log = console.log } = {}) {
  if (target == null || target === "") return null;
  let server;
  try {
    server = createProxySocketServer(app);
    mirrorUpgradeHandlers(server, mainServer);
  } catch (err) {
    log(`[proxy-socket] WARN could not prepare the test listener: ${err.message}`);
    return null;
  }
  server.on("error", (err) => log(`[proxy-socket] WARN test listener: ${err.message}`));
  const where = typeof target === "number" ? `fd ${target}` : target;
  server.listen(typeof target === "number" ? { fd: target } : target, () => log(`[proxy-socket] TEST listening on ${where}`));
  return server;
}

const CLOSED = Symbol.for("crow.proxy-socket.closed");

/**
 * Close the proxy listener alongside the TCP one and return a promise for its
 * `close` event, so the gateway's drain can wait on BOTH servers (a second
 * `close(cb)` on an already-closing server would wait for an event that has
 * already fired). Idempotent; never throws. `force` additionally severs live
 * connections (the TCP server's step-4 closeAllConnections: SSE/Turbo-Stream
 * sockets through Caddy).
 *
 * @returns {Promise<void>}
 */
export function closeProxySocket(server, { force = false } = {}) {
  if (!server) return Promise.resolve();
  let closed = server[CLOSED];
  if (!closed) {
    closed = new Promise((resolve) => {
      try {
        server.once("close", () => resolve());
        server.close();
      } catch { resolve(); }
    });
    try { server[CLOSED] = closed; } catch { /* frozen server: the promise still settles */ }
  }
  try { server.closeIdleConnections?.(); } catch {}
  if (force) { try { server.closeAllConnections?.(); } catch {} }
  return closed;
}