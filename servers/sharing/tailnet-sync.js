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
import { randomBytes } from "node:crypto";
import NoiseSecretStream from "@hyperswarm/secret-stream";
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

/**
 * Derive the ordered WebSocket dial candidates for a peer's crow_instances row.
 *
 * Primary: gateway_url, honoring its scheme. On this fleet gateway_url is a
 * Tailscale Serve HTTPS endpoint (e.g. https://grackle…ts.net:8444 → backend
 * :3002) — tailscaled terminates TLS on the Serve port and proxies the
 * upgrade to the plain-HTTP backend, so the correct dial is
 * wss://<hostname>:<port>. The HOSTNAME is load-bearing: Serve needs SNI, so
 * a raw-IP wss dial fails its TLS handshake. And plain ws:// against a Serve
 * port is the bug this replaced (HTTP 400 / TLS alert, silently retried
 * forever — the L3 outage of 2026-07-06). Port 443 is never dialed: that's
 * public Funnel, which only proxies the curated public path-list and
 * /api/instance-sync/stream is deliberately not on it.
 *
 * Fallback: ws://<tailscale_ip>:<fallbackPort> — a direct plain-WS dial of
 * the standard backend gateway port for Serve-less peers. fallbackPort is a
 * BACKEND port (the gateway listens plain HTTP), never a Serve HTTPS port.
 */
export function peerToWsUrlCandidates(peer, fallbackPort = 3002) {
  const candidates = [];
  const raw = peer?.gateway_url ? String(peer.gateway_url).trim() : "";
  if (raw) {
    let u = null;
    try { u = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { /* malformed — fall through */ }
    if (u?.hostname) {
      const isHttp = u.protocol === "http:";
      const port = u.port ? parseInt(u.port, 10) : (isHttp ? 80 : 443);
      if (port !== 443) {
        candidates.push(`${isHttp ? "ws" : "wss"}://${u.hostname}:${port}${WS_PATH}`);
      }
    }
  }
  if (peer?.tailscale_ip) {
    const direct = `ws://${peer.tailscale_ip}:${fallbackPort}${WS_PATH}`;
    if (!candidates.includes(direct)) candidates.push(direct);
  }
  return candidates;
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
export function attachFrameReader(ws) {
  const queue = [];
  const waiters = [];
  const binaryBuffer = []; // binary frames that raced the handshake — replayed at handoff
  let closed = false;
  let closeReason = null;

  function onMsg(data, isBinary) {
    if (isBinary) {
      // Binary frames belong to the post-handshake Noise/Hypercore stream.
      // The peer's Noise initiator hello commonly lands while WE are still
      // finishing handshake DB writes (feed-key persist, last_seen) — i.e.
      // before detach(). Dropping it deadlocks replication silently (the
      // responder waits forever for a hello that never re-sends), so buffer
      // for replay instead.
      binaryBuffer.push(data);
      return;
    }
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
    // Hand any raced binary frames to the caller for replay into the
    // post-handshake stream (see handoffToStream). Drain so a second
    // detach can't double-replay.
    return binaryBuffer.splice(0);
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
 * Swap the WS from JSON-handshake framing to the binary replication stream
 * without losing frames. The WS is paused across the consumer swap so no
 * frame can slip between the frame reader detaching and the duplex
 * attaching; binary frames that arrived DURING the handshake (buffered by
 * attachFrameReader) are replayed, in order, ahead of live traffic.
 */
export function handoffToStream(ws, frameReader) {
  try { ws.pause(); } catch { /* already closing — duplex teardown handles it */ }
  const buffered = frameReader.detach();
  const wsStream = createWebSocketStream(ws, { allowHalfOpen: false });
  wsStream.on("error", () => {});
  for (const frame of buffered) ws.emit("message", frame, true);
  try { ws.resume(); } catch { /* already closing */ }
  return wsStream;
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

  // Hand the WS off to Hypercore for binary replication framing. Hypercore
  // expects a NoiseSecretStream; wrap the WS Duplex first. Server side =
  // isInitiator: false (the dialer is the initiator). handoffToStream
  // replays any Noise frames that raced our handshake DB writes.
  const wsStream = handoffToStream(ws, frameReader);
  const noiseStream = new NoiseSecretStream(false, wsStream);
  noiseStream.on("error", () => {});
  await instanceSyncManager.replicate(remoteInstanceId, noiseStream);
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
    // Network-exposure invariant, defense-in-depth: instance-sync must never
    // be reachable via Tailscale Funnel. The ed25519 mutual auth below would
    // reject an outsider anyway, but a Funnel-tagged request shouldn't even
    // get a handshake. (Upgrade requests bypass the Express middleware that
    // enforces this for regular routes.)
    if (req.headers["tailscale-funnel-request"]) {
      try { socket.destroy(); } catch {}
      return;
    }
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
    this.attempt = 0; // rotates through dial candidates
    this.failCount = 0; // consecutive failures, for rate-limited logging
  }

  // Dial failures land in ws.on("error") — historically swallowed, which hid
  // a never-working dial URL for months. Log the first failure and every
  // 10th thereafter so a dead transport is visible without spamming journald.
  _noteDialFailure(wsUrl, err) {
    this.failCount += 1;
    if (this.failCount === 1 || this.failCount % 10 === 0) {
      console.warn(`[tailnet-sync] dial ${wsUrl} failed (attempt ${this.failCount}): ${err?.message || err}`);
    }
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
    const candidates = peerToWsUrlCandidates(this.peer, this.ctx.gatewayPort);
    if (candidates.length === 0) {
      // No tailnet endpoint to dial; leave for Hyperswarm.
      return;
    }
    // Ladder through candidates across retries (Serve endpoint first, then
    // the direct backend dial) so one broken path doesn't kill the transport.
    const wsUrl = candidates[this.attempt % candidates.length];
    this.attempt += 1;
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
        const incomingKeyBuf = peerKeyMsg?.feed_key_hex ? Buffer.from(peerKeyMsg.feed_key_hex, "hex") : null;
        await instanceSyncManager.initInstance(remoteInstanceId, incomingKeyBuf);
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

        // Reset retry backoff + failure counter on successful auth, and pin
        // the winning candidate so reconnects go straight back to it.
        this.retryMs = RETRY_BASE_MS;
        this.failCount = 0;
        this.attempt -= 1; // re-dial this same candidate next time

        // Hand off to Hypercore. Client side = isInitiator: true.
        // handoffToStream replays any binary frames that raced the
        // handshake (defensive — the responder shouldn't write first,
        // but symmetric handling costs nothing).
        const wsStream = handoffToStream(ws, frameReader);
        const noiseStream = new NoiseSecretStream(true, wsStream);
        noiseStream.on("error", () => {});
        await instanceSyncManager.replicate(remoteInstanceId, noiseStream);
        console.log(`[tailnet-sync] replicating with peer ${remoteInstanceId.slice(0,12)}… (client side)`);
      } catch (err) {
        console.warn(`[tailnet-sync] outbound conn error to ${wsUrl}: ${err.message}`);
        frameReader.detach();
        try { ws.close(); } catch {}
      }
    });

    ws.on("close", () => {
      this.ws = null;
      this.scheduleRetry();
    });
    ws.on("error", (err) => {
      // close will follow and schedule the retry; just make the failure
      // visible (rate-limited) — a swallowed error here hid the L3 outage.
      this._noteDialFailure(wsUrl, err);
    });
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
        sql: "SELECT id, gateway_url, tailscale_ip, sync_url, status FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
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
