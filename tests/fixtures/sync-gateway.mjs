/**
 * One REAL tailnet-sync "gateway" for the two-instance harness
 * (tests/fixtures/sync-fleet.mjs): an http server running
 * setupTailnetSyncServer, plus the real startTailnetSyncClients refresh loop
 * on demand. Rows move only over the real WebSocket → Noise → Hypercore path.
 *
 * Also: a TCP relay that can turn every CURRENT connection half-open (stops
 * forwarding both ways without a FIN/RST) while still relaying new ones —
 * the shape of a NAT rebind / suspended host / silently dropping path.
 */
import { createServer } from "node:http";
import net from "node:net";
import { setupTailnetSyncServer, startTailnetSyncClients } from "../../servers/sharing/tailnet-sync.js";

export async function startGateway(fleet, side, ctxOverrides = {}) {
  const http = createServer();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;
  const g = {
    side, http, port, clients: null, advertise: null, upgrades: 0,
    ctx: {
      identity: fleet.identity, instanceSyncManager: side.mgr, db: side.db, gatewayPort: port,
      idleRecheckMs: 40, fallbackDialAfterMs: 500, log: { warn: () => {} },
      // Never ladder onto 3001/3002: on a dev box those are LIVE gateways.
      standardPorts: [],
      // Never shell out to the dev box's tailscaled.
      lookupTailnetIp: async () => null,
      ...ctxOverrides,
    },
  };
  if (!("selfAddress" in ctxOverrides)) g.ctx.selfAddress = async () => g.advertise;
  // Count upgrade attempts on the sync path BEFORE the handler runs: an
  // independent record of who dialed whom.
  http.prependListener("upgrade", (req) => { if (req.url?.startsWith("/api/instance-sync/stream")) g.upgrades += 1; });
  setupTailnetSyncServer(http, g.ctx);
  // Upgraded sockets leave the http server's connection tracking, so
  // http.close() would wait on a live inbound link forever.
  const upgraded = new Set();
  http.on("upgrade", (_req, socket) => { upgraded.add(socket); socket.once("close", () => upgraded.delete(socket)); });
  g.startClients = async () => { g.clients = await startTailnetSyncClients(g.ctx); };
  g.stopClients = () => { g.clients?.stop(); g.clients = null; };
  g.close = async () => {
    g.stopClients();
    for (const sock of upgraded) sock.destroy();
    http.closeAllConnections?.();
    await new Promise((r) => http.close(r));
  };
  return g;
}

export async function startBlackholeRelay(targetPort) {
  const conns = new Set();
  const sockets = new Set(); // every socket ever opened, for teardown
  let accepted = 0;
  const server = net.createServer((client) => {
    accepted += 1;
    const upstream = net.connect(targetPort, "127.0.0.1");
    const c = { client, upstream, dead: false };
    sockets.add(client); sockets.add(upstream);
    conns.add(c);
    client.on("data", (d) => { if (!c.dead) upstream.write(d); });
    upstream.on("data", (d) => { if (!c.dead) client.write(d); });
    const end = () => {
      conns.delete(c);
      // A blackholed connection never propagates a close either: the far
      // end must discover it on its own.
      if (!c.dead) { client.destroy(); upstream.destroy(); }
    };
    client.on("close", end); upstream.on("close", end);
    client.on("error", () => {}); upstream.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    get accepted() { return accepted; },
    /** Every CURRENT connection goes silent both ways (no FIN, no RST). */
    blackhole() { for (const c of conns) c.dead = true; },
    async close() {
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      conns.clear();
      await new Promise((r) => server.close(r));
    },
  };
}
