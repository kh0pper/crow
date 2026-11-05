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
import { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { setupTailnetSyncServer, startTailnetSyncClients } from "../../servers/sharing/tailnet-sync.js";

/**
 * One leg of a Noise MITM: a duplex whose WRITES (ciphertext secret-stream
 * produced) go to `send` and whose incoming ciphertext is injected with
 * `feed`. A plain PassThrough cannot be used as the raw stream — secret-stream
 * reads from and writes to the same object, so a passthrough would echo our
 * own ciphertext straight back at us.
 */
function rawLeg(send) {
  const d = new Duplex({
    read() {},
    write(chunk, _enc, cb) { try { send(chunk); } catch { /* peer gone */ } cb(); },
  });
  d.on("error", () => {});
  return d;
}

const WS_PATH = "/api/instance-sync/stream";

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
      // The side's fleet-provisioned pair key (sync-fleet.mjs makeFleet).
      ...(side.pairKeyLookup ? { pairKeyLookup: side.pairKeyLookup } : {}),
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

/**
 * A transparent WebSocket relay in front of a real tailnet-sync server: it
 * dials the real server and forwards text and binary frames by opcode, so a
 * peer pointed at the relay's port speaks the handshake through it.
 *
 * `onText(dir, idx, text)` may rewrite a text frame (return a string), drop it
 * (return null) or pass it through (return undefined); `dir` is "c2s" or
 * "s2c" and `idx` is that direction's 1-based frame number. `mitmNoise`
 * terminates a NoiseSecretStream on each leg once the JSON phase is over (the
 * clients always send three text frames, the server two) and pipes the
 * plaintext across — an on-path seed holder's shape, with an unauthenticated
 * key on each leg. `dropBinary` withholds every post-JSON binary frame (a peer
 * that never finishes Noise). `binaryBytes` counts the frames actually carried.
 *
 * Every negative test that uses this relay first runs it in pass-through mode
 * as a positive control: the relay must be transparent, so the refusal can only
 * come from the MAC.
 */
export async function startWsRelay(targetPort, { onText = null, mitmNoise = false, dropBinary = false } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const conns = new Set();
  let textFrames = 0;
  let binaryFrames = 0;
  let mitmLegs = 0;
  const legErrors = [];

  const relay = (client) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${targetPort}${WS_PATH}`);
    const conn = { client, upstream, closed: false, counts: { c2s: 0, s2c: 0 }, phase: "json" };
    conns.add(conn);
    const pendingUp = []; // frames to send upstream before it is open
    const sendUp = (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else pendingUp.push(data);
    };
    const sendDown = (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    };
    upstream.once("open", () => { for (const d of pendingUp.splice(0)) upstream.send(d); });

    // The Noise MITM legs (created the moment the JSON phase ends, so their
    // initiator hello goes out before the peer's first binary frame can land).
    const startMitm = () => {
      conn.mitm = true;
      const downRaw = rawLeg((d) => sendDown(d)); // ciphertext toward our client
      const upRaw = rawLeg((d) => sendUp(d));     // ciphertext toward the real server
      // We are the responder to our client and the initiator toward the server.
      const clientLeg = new NoiseSecretStream(false, downRaw);
      const serverLeg = new NoiseSecretStream(true, upRaw);
      mitmLegs += 2;
      for (const s of [clientLeg, serverLeg]) s.on("error", (e) => legErrors.push(String(e?.message || e)));
      // Plaintext across, leg by leg, WITHOUT pipe(): a relay that relays the
      // other leg's close could never let both genuine sides reach their own
      // key check.
      clientLeg.on("data", (d) => serverLeg.write(d));
      serverLeg.on("data", (d) => clientLeg.write(d));
      conn.clientLeg = clientLeg;
      conn.serverLeg = serverLeg;
      conn.downRaw = downRaw;
      conn.upRaw = upRaw;
    };

    const oneText = (dir, text) => {
      textFrames += 1;
      conn.counts[dir] += 1;
      let out = text;
      if (onText) {
        const r = onText(dir, conn.counts[dir], text);
        if (r === null) out = null;
        else if (typeof r === "string") out = r;
      }
      if (out === null) return;
      if (dir === "c2s") sendUp(out); else sendDown(out);
      // The JSON phase is a fixed shape: the client sends C1, C2, C3 and the
      // server S1, S2. Once both are complete, everything is replication.
      if (!conn.mitm && conn.counts.c2s >= 3 && conn.counts.s2c >= 2) {
        conn.phase = "noise";
        if (mitmNoise) startMitm();
      }
    };

    const oneBinary = (dir, data) => {
      binaryFrames += 1;
      if (dropBinary) return;
      if (conn.mitm) {
        // Incoming ciphertext goes into the leg's READABLE side (secret-stream
        // reads it there); its writes are already forwarded by rawLeg.
        if (dir === "c2s") conn.downRaw.push(data); else conn.upRaw.push(data);
        return;
      }
      if (dir === "c2s") sendUp(data); else sendDown(data);
    };

    client.on("message", (data, isBinary) => {
      if (isBinary) oneBinary("c2s", data); else oneText("c2s", String(data));
    });
    upstream.on("message", (data, isBinary) => {
      if (isBinary) oneBinary("s2c", data); else oneText("s2c", String(data));
    });

    const teardown = (side) => {
      if (conn.closed) return;
      if (!conn.mitm) {
        conn.closed = true;
        for (const s of [conn.clientLeg, conn.serverLeg]) { try { s?.destroy(); } catch { /* gone */ } }
        try { client.terminate(); } catch { /* gone */ }
        try { upstream.terminate(); } catch { /* gone */ }
        conns.delete(conn);
        return;
      }
      // MITM: each leg ends on its own — one genuine side closing after its key
      // check must not be relayed into the other's handshake.
      conns.delete(conn);
      if (side === "client") {
        try { conn.clientLeg?.destroy(); } catch { /* gone */ }
        try { client.terminate(); } catch { /* gone */ }
      } else {
        try { conn.serverLeg?.destroy(); } catch { /* gone */ }
        try { upstream.terminate(); } catch { /* gone */ }
      }
    };
    client.on("close", () => teardown("client"));
    upstream.on("close", () => teardown("upstream"));
    client.on("error", () => {});
    upstream.on("error", () => {});
    if (client.readyState !== WebSocket.OPEN) teardown();
  };

  wss.on("connection", relay);
  return {
    port: wss.address().port,
    get textFrames() { return textFrames; },
    get binaryFrames() { return binaryFrames; },
    get mitmLegs() { return mitmLegs; },
    get legErrors() { return legErrors.slice(); },
    /** Drop every live connection (a relay removed mid-leg). */
    drop() { for (const c of [...conns]) { try { c.client.terminate(); } catch { /* gone */ } try { c.upstream.terminate(); } catch { /* gone */ } } },
    async close() {
      for (const c of [...conns]) {
        try { c.clientLeg?.destroy(); } catch { /* gone */ }
        try { c.serverLeg?.destroy(); } catch { /* gone */ }
        try { c.client.terminate(); } catch { /* gone */ }
        try { c.upstream.terminate(); } catch { /* gone */ }
      }
      conns.clear();
      await new Promise((r) => wss.close(r));
    },
  };
}
