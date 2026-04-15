/**
 * Tailnet-transport for instance-sync.
 *
 * Hyperswarm's UDP-hole-punching DHT works for some NATs and fails for others
 * (we hit this with crow's residential ISP — symmetric NAT defeats hole-
 * punching, no DERP-style relay fallback). For paired Crow instances of the
 * same user we already know each peer's tailnet endpoint via
 * crow_instances.gateway_url, so we can run instance-sync over an
 * authenticated WebSocket directly through Tailscale instead.
 *
 * Wire format:
 *   1. Client opens WS to <peer-gateway>/api/instance-sync/stream.
 *   2. Client sends first text frame: {instance_id, nonce_hex, sig_hex}
 *      where sig = sign(instance_id || ":" || nonce_hex, identity.ed25519Priv).
 *   3. Server verifies sig against identity.ed25519Pubkey (same identity for
 *      paired instances). Replies with its own {instance_id, nonce_hex, sig_hex}
 *      over its own nonce so the client can verify too.
 *   4. After mutual auth, both sides:
 *        a. Run feed-key-exchange: send our outgoing feed key for them as a
 *           text frame {feed_key_hex}; persist theirs on receipt.
 *        b. Wrap the WS as a Duplex stream and call
 *           instanceSyncManager.replicate(remoteId, stream).
 *
 * Coexists with Hyperswarm — Hyperswarm stays for contact-peer (different-
 * user) traffic; tailnet-sync handles instance-sync (same-user) where we
 * have a direct tailnet path.
 */

import { WebSocketServer, WebSocket, createWebSocketStream } from "ws";
import { randomBytes, createHash } from "node:crypto";
import { sign, verify } from "./identity.js";

const WS_PATH = "/api/instance-sync/stream";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

function buildHandshakePayload(identity, localInstanceId) {
  const nonce = randomBytes(16).toString("hex");
  const message = `${localInstanceId}:${nonce}`;
  return {
    instance_id: localInstanceId,
    nonce_hex: nonce,
    sig_hex: sign(message, identity.ed25519Priv),
  };
}

function verifyHandshakePayload(payload, expectedPubkeyHex) {
  if (!payload?.instance_id || !payload?.nonce_hex || !payload?.sig_hex) return false;
  const message = `${payload.instance_id}:${payload.nonce_hex}`;
  return verify(message, payload.sig_hex, expectedPubkeyHex);
}

function gatewayUrlToWsUrl(gatewayUrl) {
  if (!gatewayUrl) return null;
  const u = String(gatewayUrl).replace(/\/$/, "");
  if (u.startsWith("https://")) return u.replace(/^https:/, "wss:") + WS_PATH;
  if (u.startsWith("http://")) return u.replace(/^http:/, "ws:") + WS_PATH;
  if (u.startsWith("wss://") || u.startsWith("ws://")) return u + WS_PATH;
  return `ws://${u}${WS_PATH}`;
}

/**
 * Attach a JSON-text-frame queue to a WebSocket and return a `readJsonFrame`
 * function that consumes frames in order. Necessary because the server
 * sometimes sends multiple text frames back-to-back during the handshake;
 * a one-shot ws.once("message") listener would miss the second frame.
 *
 * Once the WS hands off to Hypercore (binary replication), call detach() to
 * stop intercepting frames so binary data flows through cleanly.
 */
function attachFrameReader(ws) {
  const queue = [];
  const waiters = [];
  let closed = false;
  let closeReason = null;

  function onMsg(data, isBinary) {
    if (isBinary) return; // binary frames aren't ours — let Hypercore take them
    let parsed;
    try { parsed = JSON.parse(data.toString()); }
    catch { return; }
    if (waiters.length > 0) waiters.shift().resolve(parsed);
    else queue.push(parsed);
  }
  function onClose() {
    closed = true;
    closeReason = new Error("socket closed during handshake");
    for (const w of waiters) w.reject(closeReason);
    waiters.length = 0;
  }
  function onError(err) {
    closed = true;
    closeReason = err;
    for (const w of waiters) w.reject(err);
    waiters.length = 0;
  }

  ws.on("message", onMsg);
  ws.on("close", onClose);
  ws.on("error", onError);

  function detach() {
    ws.off("message", onMsg);
    ws.off("close", onClose);
    ws.off("error", onError);
  }
  function readJsonFrame(timeoutMs) {
    if (closed) return Promise.reject(closeReason || new Error("socket closed"));
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      waiters.push(w);
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error("handshake timeout"));
      }, timeoutMs);
      const origResolve = w.resolve;
      const origReject = w.reject;
      w.resolve = (v) => { clearTimeout(timer); origResolve(v); };
      w.reject = (e) => { clearTimeout(timer); origReject(e); };
    });
  }
  return { readJsonFrame, detach };
}

/**
 * Server-side handler for an authenticated WS connection.
 * Performs reverse handshake, feed-key exchange, then pipes Hypercore replication.
 */
async function handleAcceptedConnection(ws, peerHandshake, frameReader, ctx) {
  const { identity, instanceSyncManager, db, log = console } = ctx;
  const remoteInstanceId = peerHandshake.instance_id;

  // Send our own handshake (proves to client we hold the same identity).
  ws.send(JSON.stringify(buildHandshakePayload(identity, instanceSyncManager.localInstanceId)));

  // Refuse self-loopback (same instance_id — no value in syncing with self).
  if (remoteInstanceId === instanceSyncManager.localInstanceId) {
    log.warn?.(`[tailnet-sync] rejecting self-loopback from ${remoteInstanceId}`);
    ws.close(1008, "self-loopback");
    return;
  }

  // Look up the peer's row in our instance registry (must be paired).
  let peerRow;
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, sync_url FROM crow_instances WHERE id = ? AND status IN ('active','offline') LIMIT 1",
      args: [remoteInstanceId],
    });
    if (rows.length === 0) {
      log.warn?.(`[tailnet-sync] rejecting unknown peer instance_id=${remoteInstanceId}`);
      ws.close(1008, "unknown peer");
      return;
    }
    peerRow = rows[0];
  } catch (err) {
    log.warn?.(`[tailnet-sync] db lookup failed: ${err.message}`);
    ws.close(1011, "db error");
    return;
  }

  // Ensure our outFeed exists, then exchange feed keys.
  await instanceSyncManager.initInstance(remoteInstanceId, peerRow.sync_url ? Buffer.from(peerRow.sync_url, "hex") : null);
  const ourOutKey = instanceSyncManager.getOutFeedKey(remoteInstanceId);
  ws.send(JSON.stringify({ feed_key_hex: ourOutKey ? ourOutKey.toString("hex") : null }));

  let peerKeyMsg;
  try { peerKeyMsg = await frameReader.readJsonFrame(HANDSHAKE_TIMEOUT_MS); }
  catch (err) {
    log.warn?.(`[tailnet-sync] feed-key frame missing from ${remoteInstanceId}: ${err.message}`);
    ws.close(1002, "no feed key");
    return;
  }
  if (peerKeyMsg?.feed_key_hex && peerKeyMsg.feed_key_hex !== peerRow.sync_url) {
    try {
      await db.execute({
        sql: "UPDATE crow_instances SET sync_url = ?, updated_at = datetime('now') WHERE id = ?",
        args: [peerKeyMsg.feed_key_hex, remoteInstanceId],
      });
      await instanceSyncManager.initInstance(remoteInstanceId, Buffer.from(peerKeyMsg.feed_key_hex, "hex"));
      console.log(`[tailnet-sync] persisted feed key from peer ${remoteInstanceId.slice(0,12)}…`);
    } catch (err) {
      log.warn?.(`[tailnet-sync] persisting feed key failed: ${err.message}`);
    }
  }

  // Mark peer as active now — we just had a successful authenticated connection.
  try {
    await db.execute({
      sql: "UPDATE crow_instances SET status='active', last_seen_at=datetime('now') WHERE id = ?",
      args: [remoteInstanceId],
    });
  } catch {}

  // Hand the WS off to Hypercore for binary replication framing.
  frameReader.detach();
  const stream = createWebSocketStream(ws, { allowHalfOpen: false });
  stream.on("error", () => {}); // hypercore-protocol logs its own errors; suppress to avoid crashes
  await instanceSyncManager.replicate(remoteInstanceId, stream);
  console.log(`[tailnet-sync] replicating with peer ${remoteInstanceId.slice(0,12)}… (server side)`);
}

/**
 * Wire the /api/instance-sync/stream WebSocket endpoint onto the http server.
 * Call from gateway boot after http.listen().
 */
export function setupTailnetSyncServer(server, ctx) {
  const { identity, log = console } = ctx;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    if (!req.url || !req.url.startsWith(WS_PATH)) return; // let other handlers process
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const frameReader = attachFrameReader(ws);
      try {
        // Read peer's handshake first.
        const peerHs = await frameReader.readJsonFrame(HANDSHAKE_TIMEOUT_MS);
        if (!verifyHandshakePayload(peerHs, identity.ed25519Pubkey)) {
          log.warn?.(`[tailnet-sync] handshake sig invalid from ${req.socket.remoteAddress}`);
          ws.close(1008, "bad sig");
          frameReader.detach();
          return;
        }
        await handleAcceptedConnection(ws, peerHs, frameReader, ctx);
      } catch (err) {
        log.warn?.(`[tailnet-sync] inbound conn error: ${err.message}`);
        frameReader.detach();
        try { ws.close(1011, "internal error"); } catch {}
      }
    });
  });

  console.log(`[tailnet-sync] WebSocket endpoint mounted at ${WS_PATH}`);
}

/**
 * Outbound dialer state per peer.
 */
class PeerDialer {
  constructor(peerRow, ctx) {
    this.peer = peerRow;
    this.ctx = ctx;
    this.ws = null;
    this.retryMs = RETRY_BASE_MS;
    this.timer = null;
    this.stopped = false;
  }

  start() { this.connect(); }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ws) try { this.ws.terminate(); } catch {}
  }

  scheduleRetry() {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  async connect() {
    if (this.stopped) return;
    const { identity, instanceSyncManager, db } = this.ctx;
    const wsUrl = gatewayUrlToWsUrl(this.peer.gateway_url);
    if (!wsUrl) {
      // No tailnet endpoint to dial; leave for Hyperswarm.
      return;
    }
    if (this.peer.id === instanceSyncManager.localInstanceId) return; // self
    // Deterministic dialer election: exactly one side dials, the other side
    // accepts. We dial only when our id sorts BEFORE the peer's id. This
    // prevents both sides from opening their own connection (and calling
    // feed.replicate on the same feed twice, which throws inside Hypercore).
    if (instanceSyncManager.localInstanceId >= this.peer.id) {
      // Wait passively for the peer's inbound dial.
      return;
    }

    let ws;
    try { ws = new WebSocket(wsUrl, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS, rejectUnauthorized: false }); }
    catch (err) {
      console.warn(`[tailnet-sync] dial failed for ${wsUrl}: ${err.message}`);
      return this.scheduleRetry();
    }
    this.ws = ws;

    const frameReader = attachFrameReader(ws);
    ws.once("open", async () => {
      try {
        // Send our handshake.
        ws.send(JSON.stringify(buildHandshakePayload(identity, instanceSyncManager.localInstanceId)));
        // Read server handshake.
        const serverHs = await frameReader.readJsonFrame(HANDSHAKE_TIMEOUT_MS);
        if (!verifyHandshakePayload(serverHs, identity.ed25519Pubkey)) {
          console.warn(`[tailnet-sync] server handshake sig invalid from ${wsUrl}`);
          ws.close(1008, "bad sig");
          frameReader.detach();
          return;
        }
        // Server said its instance_id. If matches a different paired record,
        // adopt that as the canonical remote id so feeds align.
        const remoteInstanceId = serverHs.instance_id;
        if (remoteInstanceId === instanceSyncManager.localInstanceId) {
          console.warn(`[tailnet-sync] server claims our own instance_id; closing`);
          ws.close(1008, "self");
          frameReader.detach();
          return;
        }

        // Receive server's feed key.
        const peerKeyMsg = await frameReader.readJsonFrame(HANDSHAKE_TIMEOUT_MS);
        const incomingKeyHex = peerKeyMsg?.feed_key_hex || null;
        const incomingKeyBuf = incomingKeyHex ? Buffer.from(incomingKeyHex, "hex") : null;
        console.log(`[tailnet-sync] client step:initInstance peer=${remoteInstanceId.slice(0,12)} keyLen=${incomingKeyBuf?.length || 0} hex=${incomingKeyHex?.slice(0,16) || "null"}`);
        try {
          await instanceSyncManager.initInstance(remoteInstanceId, incomingKeyBuf);
        } catch (err) {
          console.warn(`[tailnet-sync] client initInstance err: ${err.code || ""} ${err.message}\n  cause: ${err.cause?.message || ""}\n  stack: ${err.stack?.split("\n").slice(0,5).join(" | ")}`);
          throw err;
        }
        const ourOutKey = instanceSyncManager.getOutFeedKey(remoteInstanceId);
        ws.send(JSON.stringify({ feed_key_hex: ourOutKey ? ourOutKey.toString("hex") : null }));

        // Persist peer key if new.
        if (peerKeyMsg?.feed_key_hex) {
          const { rows } = await db.execute({
            sql: "SELECT sync_url FROM crow_instances WHERE id = ?",
            args: [remoteInstanceId],
          });
          if (rows[0]?.sync_url !== peerKeyMsg.feed_key_hex) {
            await db.execute({
              sql: "UPDATE crow_instances SET sync_url = ?, updated_at = datetime('now') WHERE id = ?",
              args: [peerKeyMsg.feed_key_hex, remoteInstanceId],
            });
            console.log(`[tailnet-sync] persisted feed key from peer ${remoteInstanceId.slice(0,12)}…`);
          }
        }

        // Mark peer as active.
        await db.execute({
          sql: "UPDATE crow_instances SET status='active', last_seen_at=datetime('now') WHERE id = ?",
          args: [remoteInstanceId],
        }).catch(() => {});

        // Reset retry backoff on successful auth.
        this.retryMs = RETRY_BASE_MS;

        // Hand off to Hypercore.
        frameReader.detach();
        const stream = createWebSocketStream(ws, { allowHalfOpen: false });
        stream.on("error", () => {});
        await instanceSyncManager.replicate(remoteInstanceId, stream);
        console.log(`[tailnet-sync] replicating with peer ${remoteInstanceId.slice(0,12)}… (client side)`);
      } catch (err) {
        console.warn(`[tailnet-sync] outbound conn error to ${wsUrl}: ${err.message}\n${err.stack?.split("\n").slice(0,4).join("\n")}`);
        frameReader.detach();
        try { ws.close(); } catch {}
      }
    });

    ws.on("close", () => {
      this.ws = null;
      this.scheduleRetry();
    });
    ws.on("error", () => { /* ignore — close will follow */ });
  }
}

/**
 * For each paired instance (other than self), open a persistent WebSocket
 * to its gateway_url and run instance-sync over it. Reconnects with
 * exponential backoff.
 */
export async function startTailnetSyncClients(ctx) {
  const { db, instanceSyncManager } = ctx;
  const dialers = new Map();

  async function refresh() {
    let rows;
    try {
      const r = await db.execute({
        sql: "SELECT id, gateway_url, sync_url, status FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
        args: [instanceSyncManager.localInstanceId],
      });
      rows = r.rows;
    } catch (err) {
      console.warn(`[tailnet-sync] refresh failed: ${err.message}`);
      return;
    }
    const seenIds = new Set();
    for (const peer of rows) {
      seenIds.add(peer.id);
      if (!peer.gateway_url) continue;
      if (dialers.has(peer.id)) continue;
      const dialer = new PeerDialer(peer, ctx);
      dialers.set(peer.id, dialer);
      dialer.start();
    }
    // Stop dialers for peers no longer in scope (revoked, etc.)
    for (const [id, dialer] of dialers) {
      if (!seenIds.has(id)) { dialer.stop(); dialers.delete(id); }
    }
  }

  await refresh();
  // Periodically rescan in case new peers get paired or gateway_urls change.
  const rescan = setInterval(refresh, 60_000);
  rescan.unref?.();

  return {
    dialers,
    stop() {
      clearInterval(rescan);
      for (const d of dialers.values()) d.stop();
      dialers.clear();
    },
  };
}
