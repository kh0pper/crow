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
 * So Caddy dials a unix socket instead. A unix socket has no peer address at
 * all, which lets us mark exactly the connections accepted here
 * (PROXY_SOCKET in peer-class.js) and classify them as `proxy` with the client
 * Caddy named. Who may connect is a filesystem question: the socket is 0660
 * inside RuntimeDirectory=crow (0750), so only the gateway's group — the
 * installer adds caddy to it — can open it, not every local process.
 *
 * Node built-ins only.
 */

import { createServer } from "node:http";
import { chmodSync, rmSync } from "node:fs";
import { PROXY_SOCKET } from "../shared/peer-class.js";

/** The configured socket path, or null when the feature is off. */
export function proxySocketPath(env = process.env) {
  const p = String(env.CROW_PROXY_SOCKET || "").trim();
  return p || null;
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
 * Start listening on `socketPath` (a no-op without one). A stale socket file
 * from a previous run is removed first. Never throws: a listener that cannot
 * start (missing directory, EACCES) only costs the proxy path, not the gateway.
 *
 * @returns {import("node:http").Server|null}
 */
export function listenProxySocket(app, mainServer, socketPath, { log = console.log } = {}) {
  if (!socketPath) return null;
  let server;
  try {
    rmSync(socketPath, { force: true });
    server = createProxySocketServer(app);
    mirrorUpgradeHandlers(server, mainServer);
  } catch (err) {
    log(`[proxy-socket] WARN could not prepare ${socketPath}: ${err.message}`);
    return null;
  }
  server.on("error", (err) => log(`[proxy-socket] WARN ${socketPath}: ${err.message}`));
  server.listen(socketPath, () => {
    // Only the socket's owner and group may connect (the caddy group, added by
    // the installer). Done after listen because Node offers no mode at bind.
    try { chmodSync(socketPath, 0o660); } catch (err) { log(`[proxy-socket] WARN chmod ${socketPath}: ${err.message}`); }
    log(`[proxy-socket] listening on ${socketPath}`);
  });
  return server;
}

/** Close the proxy listener alongside the TCP one; the socket file is stale now.
 * `force` additionally severs live connections (the TCP server's step-4
 * closeAllConnections: SSE/Turbo-Stream sockets through Caddy). */
export function closeProxySocket(server, socketPath, { force = false } = {}) {
  if (!server) return;
  try { server.close(); } catch {}
  try { server.closeIdleConnections?.(); } catch {}
  if (force) { try { server.closeAllConnections?.(); } catch {} }
  if (socketPath) { try { rmSync(socketPath, { force: true }); } catch {} }
}