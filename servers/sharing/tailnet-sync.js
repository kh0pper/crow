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
 *   3b. Challenge-response (when the client offers `cr: 1`): the server's
 *      reply carries cr_sig over the CLIENT's nonce, the client answers with
 *      cr_proof over the SERVER's nonce, and no feed key flows before the
 *      proof verifies — so a replayed hello (either direction) gets nothing.
 *      See "challenge-response (CR)" below for mixed-version rules.
 *   4. After mutual auth, both sides:
 *        a. Run feed-key-exchange: send our outgoing feed key for them as a
 *           text frame {feed_key_hex}; persist theirs on receipt.
 *        b. Wrap the WS as a Duplex stream and call
 *           instanceSyncManager.replicate(remoteId, stream).
 *        c. Ping every HEARTBEAT_MS; a missed pong terminates a half-open
 *           link so the dialer re-dials.
 *
 * Coexists with Hyperswarm — Hyperswarm stays for contact-peer (different-
 * user) traffic; tailnet-sync handles instance-sync (same-user) where we
 * have a direct tailnet path.
 */

import { WebSocketServer, WebSocket, createWebSocketStream } from "ws";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { sign, verify } from "./identity.js";
import { livenessStatusSql } from "../shared/instance-status.js";
import { getOwnTailnetIp } from "../shared/tailnet-ip.js";
import {
  isTailnetAddress, gatewayUrlHost, lookupTailnetIpForHost, tailscaleStatusAsync, rememberPeerSyncPort,
  SYNC_PORT_KEY_PREFIX, SYNC_CR_KEY_PREFIX,
} from "../shared/self-dial-address.js";
import {
  recordDialAttempt, recordDialFailure, recordLinkUp, recordLinkClosed,
  recordNoDialAddress, clearNoDialAddress, recordAddressBackfill, forgetPeerDialHealth,
} from "../shared/peer-dial-health.js";

const WS_PATH = "/api/instance-sync/stream";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
// DIALER-RETRY: a dialer with nothing to do right now (no dial address yet,
// not the elected dialer, or already linked) re-checks on this cadence
// instead of returning for good. Before, a peer that booted with no address
// was never dialed again until a gateway restart, even after its row was fixed.
const IDLE_RECHECK_MS = 15_000;
// A peer that answers "unknown peer"/"not paired" (it revoked us, or never
// paired) is re-tried at this slow cadence, not every backoff cycle.
const REFUSED_RECHECK_MS = 30 * 60_000;
export { SYNC_PORT_KEY_PREFIX, SYNC_CR_KEY_PREFIX };
// HALF-OPEN: a link whose peer vanished without a FIN/RST (NAT rebind, host
// suspend, a tailnet path that silently drops) used to look "linked" forever
// — no data, no close, no re-dial. Both ends ping on this cadence; two whole
// intervals without a pong terminate the socket, and the dialer re-dials.
// Every ws peer auto-answers pings, so older peers need no change.
const HEARTBEAT_MS = 30_000;
// Dialer election picks the lower instance id. If the elected side cannot
// reach us (it has no address for us — black-swan's shape, 2026-08..10) no
// link would ever form. After this long with no link at all, the other side
// dials as a fallback. Long enough that the elected side always wins a normal
// boot race; the accept side refuses a fallback dial while a link is up.
const FALLBACK_DIAL_AFTER_MS = 120_000;
// The :443-row repair (repairUndialablePeerRows) re-runs from the refresh
// loop at most this often.
const REPAIR_EVERY_MS = 10 * 60_000;

/* ------------------------------------------------------- signed addresses */

let _allowLoopbackAddresses = false;
/** Test seam: the two-instance tests run both gateways on 127.0.0.1. */
export function _setAllowLoopbackAddressesForTest(v) { _allowLoopbackAddresses = !!v; }

/**
 * True for a Tailscale address: IPv4 100.64.0.0/10 (CGNAT) or IPv6
 * fd7a:115c:a1e0::/48. A learned address is only ever a TAILNET address — a
 * public, RFC1918 or metadata (169.254.x) address is never accepted, because
 * a learned gateway_url also turns on credentialed peer calls (federation
 * proxy, SSO, probes) for that row.
 */
export function isTailnetIp(ip) {
  return isTailnetAddress(ip);
}

function testLoopback(host) {
  return _allowLoopbackAddresses && /^127\./.test(String(host).replace(/^\[|\]$/g, ""));
}

/** A tailscale_ip a peer may advertise: a literal tailnet IP. */
export function sanitizeAdvertisedIp(ip) {
  if (typeof ip !== "string") return null;
  const v = ip.trim();
  if (!v || v.length > 64 || !isIP(v)) return null;
  if (!isTailnetIp(v) && !testLoopback(v)) return null;
  return v;
}

/** A backend port a peer may advertise for its direct ws:// dial. */
export function sanitizeAdvertisedPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * A gateway_url a peer may advertise: http(s), a real host, and DIALABLE by
 * this transport (a :443 Funnel URL is not — see peerToWsUrlCandidates).
 */
export function sanitizeAdvertisedGatewayUrl(url) {
  if (typeof url !== "string") return null;
  const v = url.trim();
  if (!v || v.length > 500) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  // Tailnet only: https on a MagicDNS name (*.ts.net — the Serve endpoint
  // shape), or http(s) on a literal tailnet IP.
  const host = u.hostname.toLowerCase();
  const tailnetName = u.protocol === "https:" && host.endsWith(".ts.net") && !isIP(host);
  if (!tailnetName && !isTailnetIp(host) && !testLoopback(host)) return null;
  const clean = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  return peerToWsUrlCandidates({ gateway_url: clean }).length > 0 ? clean : null;
}

function canonicalAddr(addr) {
  return JSON.stringify({ gateway_url: addr?.gateway_url ?? null, tailscale_ip: addr?.tailscale_ip ?? null, sync_port: addr?.sync_port ?? null });
}

/**
 * The address block rides the handshake with its OWN signature, bound to the
 * sender's instance_id and this connection's nonce, so it cannot be spliced
 * onto another handshake. Older peers ignore the extra fields; a peer that
 * sends none simply teaches us nothing.
 */
function addrMessage(instanceId, nonce, addr) {
  return `addr:${instanceId}:${nonce}:${canonicalAddr(addr)}`;
}

/* ------------------------------------------------- challenge-response (CR) */
//
// The hello above signs a nonce the SENDER chose, so on its own it proves
// nothing about freshness: a captured hello replays verbatim, and the server
// answered a replay with its feed key (CR follow-up to #415). CR binds each
// side's proof to the OTHER side's fresh nonce:
//
//   client hello  {instance_id, nonce_hex=cN, sig_hex, cr: 1}
//   server hello  {instance_id, nonce_hex=sN, sig_hex,
//                  cr_sig = sign("cr-resp:<server>:<client>:<cN>:<sN>")}
//   client proof  {cr_proof = sign("cr-proof:<client>:<server>:<sN>:<cN>")}
//   ... feed keys flow only AFTER the server verified the proof.
//
// Mixed versions: an old client sends no `cr` (the server answers the old
// way); an old server sends no `cr_sig` (the client sends no proof). Once a
// peer has completed CR with us, its flag is stored (LOCAL override) and a
// later CR-less handshake under its id is REFUSED — that closes the downgrade
// a replayed pre-upgrade hello would otherwise get.
const CR_VERSION = 1;
const NONCE_RE = /^[0-9a-f]{16,128}$/;
function crRespMessage(serverId, clientId, clientNonce, serverNonce) {
  return `cr-resp:${serverId}:${clientId}:${clientNonce}:${serverNonce}`;
}
function crProofMessage(clientId, serverId, serverNonce, clientNonce) {
  return `cr-proof:${clientId}:${serverId}:${serverNonce}:${clientNonce}`;
}
function safeVerify(message, sigHex, pubkeyHex) {
  if (typeof sigHex !== "string") return false;
  try { return verify(message, sigHex, pubkeyHex); } catch { return false; }
}

/** True once `peerId` has completed a CR handshake with us (downgrade guard). */
async function peerCrRequired(ctx, peerId) {
  const localId = ctx.instanceSyncManager?.localInstanceId;
  if (!localId) return false;
  try {
    const { rows } = await ctx.db.execute({
      sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ? LIMIT 1",
      args: [`${SYNC_CR_KEY_PREFIX}${peerId}`, localId],
    });
    return Number(rows[0]?.value) >= 1;
  } catch (err) {
    // Fail CLOSED on a transient DB error (a pinned peer must not slip
    // through as legacy); only a missing table (an old DB) means "no pin".
    return !/no such table/i.test(String(err?.message || err));
  }
}

async function markPeerCr(ctx, peerId) {
  const localId = ctx.instanceSyncManager?.localInstanceId;
  if (!localId) return;
  try {
    const r = await ctx.db.execute({
      sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            WHERE dashboard_settings_overrides.value IS NOT excluded.value`,
      args: [`${SYNC_CR_KEY_PREFIX}${peerId}`, localId, String(CR_VERSION)],
    });
    if (Number(r.rowsAffected ?? 0) > 0) {
      console.log(`[tailnet-sync] peer ${String(peerId).slice(0, 12)}… completed a challenge-response handshake; CR-less handshakes from it are refused from now on`);
    }
  } catch { /* table missing on an old DB — no downgrade guard, CR still enforced per-connection */ }
}

/**
 * Arm the half-open detector on a replicating socket: ping every
 * `ctx.heartbeatMs` (0 disables), terminate when two whole intervals pass
 * without a pong. Cleared on close.
 */
function armHeartbeat(ws, ctx, peerId) {
  const every = ctx.heartbeatMs ?? HEARTBEAT_MS;
  if (!every || every <= 0) return;
  let missed = 0;
  const onPong = () => { missed = 0; };
  ws.on("pong", onPong);
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Two whole intervals without a pong (margin for a pong queued behind a
    // large backlog on a slow relayed path).
    if (missed >= 2) {
      console.warn(`[tailnet-sync] link to ${String(peerId).slice(0, 12)}… missed its heartbeat (no pong in ${2 * every} ms) — half-open; terminating so the dialer re-dials`);
      recordDialFailure(peerId, `link half-open: no pong in ${2 * every} ms`);
      clearInterval(timer);
      try { ws.terminate(); } catch { /* already gone */ }
      return;
    }
    missed += 1;
    try { ws.ping(); } catch { /* close follows */ }
  }, every);
  timer.unref?.();
  ws.once("close", () => { clearInterval(timer); ws.off("pong", onPong); });
}

function buildHandshakePayload(identity, localInstanceId, addr = null, extra = null) {
  const nonce = randomBytes(16).toString("hex");
  const message = `${localInstanceId}:${nonce}`;
  const payload = {
    instance_id: localInstanceId,
    nonce_hex: nonce,
    sig_hex: sign(message, identity.ed25519Priv),
    ...(extra || {}),
  };
  if (addr && (addr.gateway_url || addr.tailscale_ip)) {
    const clean = { gateway_url: addr.gateway_url || null, tailscale_ip: addr.tailscale_ip || null, sync_port: addr.sync_port || null };
    payload.addr = clean;
    payload.addr_sig = sign(addrMessage(localInstanceId, nonce, clean), identity.ed25519Priv);
  }
  return payload;
}

function verifyHandshakePayload(payload, expectedPubkeyHex) {
  if (!payload?.instance_id || !payload?.nonce_hex || !payload?.sig_hex) return false;
  // Hex nonces only: keeps the hello message space disjoint from the
  // colon-delimited CR messages, so no signature can be reused across them.
  if (typeof payload.nonce_hex !== "string" || !NONCE_RE.test(payload.nonce_hex)) return false;
  if (typeof payload.instance_id !== "string" || payload.instance_id.includes(":")) return false;
  const message = `${payload.instance_id}:${payload.nonce_hex}`;
  try { return verify(message, payload.sig_hex, expectedPubkeyHex); } catch { return false; }
}

/**
 * The peer's self-advertised dial address from an ALREADY-VERIFIED handshake,
 * or null when absent, unsigned, badly signed, or not a usable address.
 */
export function verifiedAdvertisedAddress(payload, expectedPubkeyHex) {
  if (!payload?.addr || typeof payload.addr !== "object" || typeof payload.addr_sig !== "string") return null;
  const raw = { gateway_url: payload.addr.gateway_url ?? null, tailscale_ip: payload.addr.tailscale_ip ?? null, sync_port: payload.addr.sync_port ?? null };
  let ok = false;
  try { ok = verify(addrMessage(payload.instance_id, payload.nonce_hex, raw), payload.addr_sig, expectedPubkeyHex); } catch { ok = false; }
  if (!ok) return null;
  const out = {};
  const gw = sanitizeAdvertisedGatewayUrl(raw.gateway_url);
  const ip = sanitizeAdvertisedIp(raw.tailscale_ip);
  const port = sanitizeAdvertisedPort(raw.sync_port);
  if (gw) out.gateway_url = gw;
  if (ip) out.tailscale_ip = ip;
  if (port && (ip || gw)) out.sync_port = port;
  return Object.keys(out).length ? out : null;
}

let _ownIpFailedAt = 0;
/**
 * This instance's dial address to advertise: its own crow_instances row
 * (gateway_url is the operator's CROW_PEER_GATEWAY_URL, set at boot), plus
 * this host's tailnet IP. ctx.selfAddress overrides (tests). Never throws.
 */
async function resolveSelfAddress(ctx) {
  try {
    if (typeof ctx.selfAddress === "function") {
      const a = (await ctx.selfAddress()) || {};
      return { gateway_url: sanitizeAdvertisedGatewayUrl(a.gateway_url), tailscale_ip: sanitizeAdvertisedIp(a.tailscale_ip), sync_port: sanitizeAdvertisedPort(a.sync_port) };
    }
    let row = null;
    try {
      const { rows } = await ctx.db.execute({
        sql: "SELECT gateway_url, tailscale_ip FROM crow_instances WHERE id = ? LIMIT 1",
        args: [ctx.instanceSyncManager.localInstanceId],
      });
      row = rows[0] || null;
    } catch { row = null; }
    let ip = sanitizeAdvertisedIp(row?.tailscale_ip);
    // `tailscale ip -4` blocks for up to 3 s when tailscaled is wedged; a
    // failed probe is retried at most every 10 minutes from here.
    if (!ip && Date.now() - _ownIpFailedAt > 600_000) {
      ip = sanitizeAdvertisedIp(getOwnTailnetIp());
      if (!ip) _ownIpFailedAt = Date.now();
    }
    // sync_port: this gateway's own backend port, so a peer that learns our
    // tailscale_ip dials ws://<ip>:<port> instead of guessing 3001/3002.
    return { gateway_url: sanitizeAdvertisedGatewayUrl(row?.gateway_url), tailscale_ip: ip, sync_port: sanitizeAdvertisedPort(ctx.syncPort) };
  } catch {
    return null;
  }
}

/**
 * Backfill a peer's MISSING dial address from its verified handshake.
 * Only empty columns are filled — an operator-set value is never
 * overwritten — and only for a live paired row. Refreshes the running
 * dialer's snapshot so the learned address is dialed without a restart.
 * Never throws. Returns the fields written ({} when none).
 */
export async function backfillPeerAddress(ctx, peerId, addr) {
  const written = {};
  if (!addr || !peerId) return written;
  const { db } = ctx;
  try {
    const { rows } = await db.execute({
      sql: "SELECT gateway_url, tailscale_ip FROM crow_instances WHERE id = ? AND status IN ('active','offline') LIMIT 1",
      args: [peerId],
    });
    const row = rows[0];
    if (!row) return written;
    if (addr.sync_port) {
      // Not a crow_instances column (no schema change): a LOCAL-scope
      // override (never synced), keyed per peer. Refreshed on every signed
      // handshake — it is the peer's own port, not operator data.
      const localId = ctx.instanceSyncManager?.localInstanceId;
      if (localId && await rememberPeerSyncPort(db, localId, peerId, addr.sync_port)) written.sync_port = addr.sync_port;
    }
    for (const col of ["gateway_url", "tailscale_ip"]) {
      if (!addr[col]) continue;
      const current = row[col] != null ? String(row[col]).trim() : "";
      if (current === "") {
        const r = await db.execute({
          sql: `UPDATE crow_instances SET ${col} = ?, updated_at = datetime('now') WHERE id = ? AND (${col} IS NULL OR TRIM(${col}) = '')`,
          args: [addr[col], peerId],
        });
        if (Number(r.rowsAffected ?? 0) > 0) written[col] = addr[col];
      }
    }
  } catch (err) {
    console.warn(`[tailnet-sync] address backfill for ${String(peerId).slice(0, 12)}… failed: ${err.message}`);
    return written;
  }
  if (Object.keys(written).length) {
    console.log(`[tailnet-sync] learned dial address for ${String(peerId).slice(0, 12)}… from its signed handshake: ${JSON.stringify(written)}`);
    recordAddressBackfill(peerId, written);
    // Refresh the running dialer's snapshot WITHOUT waking it: the address
    // arrived on a handshake that is about to become the link, and a kick
    // here would race it into a second, duplicate link. The idle re-check
    // dials the learned address only if that link is gone.
    const dialer = ctx.dialers?.get?.(peerId);
    if (dialer) dialer.peer = { ...dialer.peer, ...written };
  }
  return written;
}

/**
 * Human-readable reasons a peer row yields no dial candidate — the text the
 * health notification and the Instances page show.
 */
export function describeMissingDialAddress(peer) {
  const out = [];
  const raw = peer?.gateway_url ? String(peer.gateway_url).trim() : "";
  if (!raw) out.push("gateway_url is empty");
  else {
    let u = null;
    try { u = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { u = null; }
    if (!u?.hostname) out.push("gateway_url is malformed");
    else {
      const port = u.port ? parseInt(u.port, 10) : (u.protocol === "http:" ? 80 : 443);
      if (port === 443) out.push(`gateway_url ${u.host} is on port 443 (public Funnel), which instance sync never dials`);
    }
  }
  if (!peer?.tailscale_ip) out.push("tailscale_ip is empty");
  return out;
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
 * Fallback: ws://<tailscale_ip>:<port> direct plain-WS dials of the COMMON
 * backend gateway ports for Serve-less peers. The peer's real backend port
 * isn't advertised in its crow_instances row (gateway_url carries the Serve
 * HTTPS port, not the backend), so the ladder tries the caller's own port
 * plus the fleet-standard 3001/3002 (#144 minor: a single hardcoded 3002
 * was wrong for any non-3002 peer). All fallback ports are BACKEND ports
 * (the gateway listens plain HTTP), never Serve HTTPS ports. Bare IPv6
 * addresses are bracketed for the URL (#144 minor).
 */
export function peerToWsUrlCandidates(peer, fallbackPort = 3002, standardPorts = [3001, 3002]) {
  const candidates = [];
  const raw = peer?.gateway_url ? String(peer.gateway_url).trim() : "";
  if (raw) {
    let u = null;
    try { u = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { /* malformed — fall through */ }
    if (u?.hostname) {
      const isHttp = u.protocol === "http:";
      const port = u.port ? parseInt(u.port, 10) : (isHttp ? 80 : 443);
      if (port !== 443) {
        // u.hostname keeps IPv6 brackets — safe to re-embed verbatim.
        candidates.push(`${isHttp ? "ws" : "wss"}://${u.hostname}:${port}${WS_PATH}`);
      }
    }
  }
  if (peer?.tailscale_ip) {
    const ip = String(peer.tailscale_ip);
    const host = ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
    // The peer's own advertised backend port (learned from its signed
    // handshake) leads; the guessed ports follow.
    const learned = sanitizeAdvertisedPort(peer.sync_port);
    for (const port of new Set([...(learned ? [learned] : []), fallbackPort, ...standardPorts])) {
      const direct = `ws://${host}:${port}${WS_PATH}`;
      if (!candidates.includes(direct)) candidates.push(direct);
    }
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
async function handleAcceptedConnection(ws, peerHandshake, frameReader, ctx, markPending = () => {}) {
  const { identity, instanceSyncManager, db, log = console } = ctx;
  const remoteInstanceId = peerHandshake.instance_id;

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

  // A FALLBACK dial (from the side that lost the dialer election — its id
  // sorts after ours) is refused while a tailnet link already exists, or
  // while our own elected dial to it is in flight: one dedicated link per
  // pair. The elected direction is always accepted.
  const fallbackRefused = () => {
    if (remoteInstanceId <= instanceSyncManager.localInstanceId) return false;
    const ownWs = ctx.dialers?.get?.(remoteInstanceId)?.ws;
    return Boolean(instanceSyncManager.hasDedicatedStream?.(remoteInstanceId) || (ownWs && ownWs.readyState <= WebSocket.OPEN));
  };
  if (fallbackRefused()) {
    ws.close(1013, "already linked");
    return;
  }

  // Challenge-response: a CR-capable client gets a reply bound to ITS nonce
  // and must answer OUR nonce before any feed key flows. A CR-less hello
  // from a peer that has done CR before is a downgrade (a replayed old
  // hello) and is refused.
  const useCr = !ctx.legacyHandshake && Number.isInteger(peerHandshake.cr) && peerHandshake.cr >= CR_VERSION;
  if (!useCr && !ctx.legacyHandshake && await peerCrRequired(ctx, remoteInstanceId)) {
    log.warn?.(`[tailnet-sync] refusing a handshake without challenge-response from ${remoteInstanceId} (it has completed CR before — replay or downgrade)`);
    ws.close(1008, "challenge required");
    return;
  }

  // Our own handshake (proves to the client we hold the same identity), with
  // our signed dial address — sent only AFTER the peer is known to be a live
  // paired instance here, so a revoked/unknown instance learns nothing.
  const localId = instanceSyncManager.localInstanceId;
  const ourHs = buildHandshakePayload(identity, localId, await resolveSelfAddress(ctx));
  if (useCr) ourHs.cr_sig = sign(crRespMessage(localId, remoteInstanceId, peerHandshake.nonce_hex, ourHs.nonce_hex), identity.ed25519Priv);
  ws.send(JSON.stringify(ourHs));

  if (useCr) {
    let proof;
    try { proof = await frameReader.readJsonFrame(HANDSHAKE_TIMEOUT_MS); }
    catch (err) {
      log.warn?.(`[tailnet-sync] challenge proof missing from ${remoteInstanceId}: ${err.message}`);
      try { ws.close(1008, "no proof"); } catch {}
      return;
    }
    if (!safeVerify(crProofMessage(remoteInstanceId, localId, ourHs.nonce_hex, peerHandshake.nonce_hex), proof?.cr_proof, identity.ed25519Pubkey)) {
      log.warn?.(`[tailnet-sync] challenge proof INVALID from ${remoteInstanceId} (replayed hello?)`);
      ws.close(1008, "bad proof");
      return;
    }
    await markPeerCr(ctx, remoteInstanceId);
    // Our own dial may have started while we waited for the proof.
    if (fallbackRefused()) {
      ws.close(1013, "already linked");
      return;
    }
  }
  // Only an AUTHENTICATED inbound (proof verified, or a legacy peer) holds
  // off our dialer — a replayed hello that never proves must not be able to
  // park our dialer for a handshake timeout at a time.
  markPending();

  // Learn the peer's dial address if our row lacks it (signed, verified above).
  await backfillPeerAddress(ctx, remoteInstanceId, verifiedAdvertisedAddress(peerHandshake, identity.ed25519Pubkey));

  // Ensure our outFeed exists, then exchange feed keys.
  // 2d F3: pass NO key here. This call's only job is arming the out-feed for
  // getOutFeedKey below. Passing the :222 snapshot's sync_url was harmless
  // when a mismatched key no-oped, but under key-aware initInstance a stale
  // snapshot would swap a concurrently-rotated in-feed BACK to its dead key.
  // The authenticated receipt at the feed-key exchange below drives any swap.
  await instanceSyncManager.initInstance(remoteInstanceId, null);
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
    const keyBuf = instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, peerKeyMsg.feed_key_hex);
    if (keyBuf) {
      try {
        await db.execute({
          sql: "UPDATE crow_instances SET sync_url = ?, updated_at = datetime('now') WHERE id = ?",
          args: [peerKeyMsg.feed_key_hex, remoteInstanceId],
        });
        await instanceSyncManager.initInstance(remoteInstanceId, keyBuf);
        console.log(`[tailnet-sync] persisted feed key from peer ${remoteInstanceId.slice(0,12)}…`);
      } catch (err) {
        log.warn?.(`[tailnet-sync] persisting feed key failed: ${err.message}`);
      }
    }
  }

  // Mark peer as active now — we just had a successful authenticated connection.
  try {
    await db.execute({
      sql: `UPDATE crow_instances SET status=${livenessStatusSql("active")}, last_seen_at=datetime('now') WHERE id = ?`,
      args: [remoteInstanceId],
    });
  } catch {}

  // Hand the WS off to Hypercore for binary replication framing. Hypercore
  // expects a NoiseSecretStream; wrap the WS Duplex first. Server side =
  // isInitiator: false (the dialer is the initiator). handoffToStream
  // replays any Noise frames that raced our handshake DB writes.
  // The socket may have closed while we awaited the DB writes above; a
  // stream built on a closed socket never emits close (phantom link).
  if (ws.readyState !== WebSocket.OPEN) { frameReader.detach(); return; }
  const wsStream = handoffToStream(ws, frameReader);
  const noiseStream = new NoiseSecretStream(false, wsStream);
  // A socket that closes before the Noise handshake completes leaves the
  // Noise stream open — a phantom "dedicated stream" that made the dialer
  // idle forever. The socket's close always ends the stream.
  ws.once("close", () => { try { noiseStream.destroy(); } catch { /* already closed */ } });
  noiseStream.on("error", () => {});
  noiseStream.once("close", () => recordLinkClosed(remoteInstanceId));
  armHeartbeat(ws, ctx, remoteInstanceId);
  await instanceSyncManager.replicate(remoteInstanceId, noiseStream, { dedicated: true });
  recordLinkUp(remoteInstanceId, { direction: "inbound" });
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
        // Mark the peer's inbound handshake in flight (from authentication
        // until it becomes a replicating link or fails) so our own dialer
        // does not race it. handleAcceptedConnection decides WHEN — after
        // the challenge-response proof, not on the bare (replayable) hello.
        const pending = (ctx.inboundPending ||= new Map());
        const pid = String(peerHs.instance_id);
        let marked = false;
        const markPending = () => { if (marked) return; marked = true; pending.set(pid, (pending.get(pid) || 0) + 1); };
        try {
          await handleAcceptedConnection(ws, peerHs, frameReader, ctx, markPending);
        } finally {
          if (marked) {
            const n = (pending.get(pid) || 1) - 1;
            if (n > 0) pending.set(pid, n); else pending.delete(pid);
          }
        }
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
 *
 * Never parks for good (DIALER-RETRY): every branch that has nothing to do
 * right now — no dial address, not the elected dialer, already linked —
 * re-checks on an idle timer, and a refreshed row with a usable address is
 * dialed at once (updatePeer). A peer with no usable address and no link is
 * recorded in peer-dial-health, which raises a health warning.
 */
// Exported for tests (backoff-cycle behavior); production callers construct
// it only via startTailnetSyncClients' refresh loop.
export class PeerDialer {
  constructor(peerRow, ctx) {
    this.peer = peerRow;
    this.ctx = ctx;
    this.ws = null;
    this.retryMs = RETRY_BASE_MS;
    this.timer = null;
    this.stopped = false;
    this.attempt = 0; // rotates through dial candidates
    this.failCount = 0; // consecutive failures, for rate-limited logging
    this.idle = false; // parked on the idle re-check (nothing to dial right now)
    this.passiveSince = Date.now(); // non-elected side: when we last saw a link (or booted)
    this._noAddrLogged = false;
  }

  // Dial failures land in ws.on("error") — historically swallowed, which hid
  // a never-working dial URL for months. Log the first failure and every
  // 10th thereafter so a dead transport is visible without spamming journald.
  _noteDialFailure(wsUrl, err) {
    this.failCount += 1;
    recordDialFailure(this.peer.id, `${wsUrl}: ${err?.message || err}`);
    if (this.failCount === 1 || this.failCount % 10 === 0) {
      console.warn(`[tailnet-sync] dial ${wsUrl} failed (attempt ${this.failCount}): ${err?.message || err}`);
    }
  }

  start() { this.connect(); }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) try { this.ws.terminate(); } catch {}
  }

  _setTimer(fn, ms) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
    this.timer.unref?.();
  }

  scheduleRetry() {
    if (this.stopped) return;
    this.idle = false;
    this._setTimer(() => this.connect(), this.retryMs);
    // #144 minor: grow the backoff only after a FULL ladder cycle, so a
    // healthy candidate later in the ladder gets its first try at the base
    // delay instead of inheriting the exponential penalty earned by the
    // candidates before it. _candCount is stamped by connect().
    const cycle = Math.max(1, this._candCount || 1);
    if (this.attempt % cycle === 0) {
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    }
  }

  scheduleIdle() {
    if (this.stopped) return;
    this.idle = true;
    this._setTimer(() => this.connect(), this.ctx.idleRecheckMs ?? IDLE_RECHECK_MS);
  }

  /**
   * Swap in a fresher crow_instances snapshot (refresh loop, or an address
   * learned from a signed handshake). A dialer parked idle for lack of an
   * address dials immediately once the row yields a candidate.
   */
  updatePeer(row) {
    this.peer = row;
    if (this.stopped || this.ws || !this.idle) return;
    if (peerToWsUrlCandidates(row, this.ctx.gatewayPort, this.ctx.standardPorts).length === 0) return;
    this.connect();
  }

  async connect() {
    if (this.stopped) return;
    // One timeline per dialer: a direct call (refresh kick) supersedes any
    // pending timer, and a socket still connecting/open is never doubled.
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const { identity, instanceSyncManager, db } = this.ctx;
    if (this.peer.id === instanceSyncManager.localInstanceId) return; // self
    const peerId = this.peer.id;
    const candidates = peerToWsUrlCandidates(this.peer, this.ctx.gatewayPort, this.ctx.standardPorts);
    this._candCount = candidates.length; // backoff grows once per full ladder cycle
    const anyLink = instanceSyncManager.hasActiveStream?.(peerId) ?? false;
    const tailnetLink = instanceSyncManager.hasDedicatedStream?.(peerId) ?? false;

    if (candidates.length === 0) {
      // No tailnet endpoint to dial. Fine while ANY link carries sync (the
      // peer dialed us, or Hyperswarm connected); otherwise it is a health
      // condition, not a silent no-op.
      if (anyLink) {
        clearNoDialAddress(peerId);
      } else {
        const missing = describeMissingDialAddress(this.peer);
        recordNoDialAddress(peerId, missing);
        if (!this._noAddrLogged) {
          this._noAddrLogged = true;
          console.warn(`[tailnet-sync] no dial address for peer ${String(peerId).slice(0, 12)}… (${this.peer.name || "unnamed"}): ${missing.join("; ")} — will re-check`);
        }
      }
      return this.scheduleIdle();
    }
    clearNoDialAddress(peerId);
    this._noAddrLogged = false;

    if (tailnetLink || this.ctx.inboundPending?.has(peerId)) {
      // Already linked (in either direction), or the peer's inbound
      // handshake is mid-flight — one dedicated link per pair.
      this.passiveSince = Date.now();
      return this.scheduleIdle();
    }

    // Deterministic dialer election: exactly one side dials, the other side
    // accepts. We dial only when our id sorts BEFORE the peer's id. This
    // prevents both sides from opening their own connection (and calling
    // feed.replicate on the same feed twice, which throws inside Hypercore).
    // The non-elected side dials only as a FALLBACK after a long stretch with
    // no link at all (the elected side may simply not know our address); the
    // accept side refuses a fallback while any tailnet link is up.
    let role = "dialer";
    if (instanceSyncManager.localInstanceId >= peerId) {
      if (anyLink) this.passiveSince = Date.now();
      const after = this.ctx.fallbackDialAfterMs ?? FALLBACK_DIAL_AFTER_MS;
      if (anyLink || Date.now() - this.passiveSince < after) return this.scheduleIdle();
      role = "fallback";
    }

    // Ladder through candidates across retries (Serve endpoint first, then
    // the direct backend dial) so one broken path doesn't kill the transport.
    const wsUrl = candidates[this.attempt % candidates.length];
    this.attempt += 1;
    this.idle = false;
    recordDialAttempt(peerId, { url: wsUrl, role });

    let ws;
    // TLS verification is ON for wss candidates (#144 follow-up): every wss
    // candidate is hostname-based (the fleet's wss candidates are all ts.net hostnames; a raw-IP https gateway_url would emit raw-IP wss, whose cert won't verify — the ws:// tailnet fallback recovers when tailscale_ip is set), and
    // the fleet's Serve endpoints carry real LE certs — SNI + verification
    // both work. ws:// candidates are unaffected. A deployment fronting its
    // gateway with a self-signed cert should use an http/ws gateway_url or a
    // real cert; silently accepting any cert on an authenticated sync
    // transport was the worse default.
    try { ws = new WebSocket(wsUrl, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS }); }
    catch (err) {
      console.warn(`[tailnet-sync] dial failed for ${wsUrl}: ${err.message}`);
      recordDialFailure(peerId, `${wsUrl}: ${err.message}`);
      return this.scheduleRetry();
    }
    this.ws = ws;
    let linked = false;
    let closedByUs = false;
    let peerCloseCode = 0; // set when the PEER closed (refusal codes arrive before any frame)

    const frameReader = attachFrameReader(ws);
    ws.once("open", async () => {
      try {
        // Send our handshake (with our signed dial address), offering CR.
        const ourHs = buildHandshakePayload(identity, instanceSyncManager.localInstanceId, await resolveSelfAddress(this.ctx),
          this.ctx.legacyHandshake ? null : { cr: CR_VERSION });
        ws.send(JSON.stringify(ourHs));
        // Read server handshake.
        const serverHs = await frameReader.readJsonFrame(HANDSHAKE_TIMEOUT_MS);
        if (!verifyHandshakePayload(serverHs, identity.ed25519Pubkey)) {
          console.warn(`[tailnet-sync] server handshake sig invalid from ${wsUrl}`);
          recordDialFailure(peerId, `${wsUrl}: server handshake signature invalid`);
          closedByUs = true;
          ws.close(1008, "bad sig");
          frameReader.detach();
          return;
        }
        // The server must be the instance we dialed. With learned host IPs
        // and a port ladder, a co-hosted instance sharing the identity could
        // otherwise answer for another one and be adopted silently.
        const remoteInstanceId = serverHs.instance_id;
        if (remoteInstanceId !== peerId && remoteInstanceId !== instanceSyncManager.localInstanceId) {
          console.warn(`[tailnet-sync] ${wsUrl} answered as ${String(remoteInstanceId).slice(0, 12)}…, not the peer we dialed; closing`);
          recordDialFailure(peerId, `${wsUrl}: answered as a different instance (${String(remoteInstanceId).slice(0, 12)}…)`);
          closedByUs = true;
          ws.close(1008, "wrong instance");
          frameReader.detach();
          return;
        }
        if (remoteInstanceId === instanceSyncManager.localInstanceId) {
          console.warn(`[tailnet-sync] server claims our own instance_id; closing`);
          recordDialFailure(peerId, `${wsUrl}: answered with this instance's own id`);
          closedByUs = true;
          ws.close(1008, "self");
          frameReader.detach();
          return;
        }
        // The server's instance must still be a live paired peer HERE. A
        // revoked (or paused/unknown) peer is refused before any feed is
        // armed — otherwise a reconnect between the revoke and the next 60 s
        // dialer rescan re-opened the revoked peer's feeds (review I2).
        const { rows: liveRows } = await db.execute({
          sql: "SELECT 1 FROM crow_instances WHERE id = ? AND status IN ('active','offline') LIMIT 1",
          args: [remoteInstanceId],
        });
        if (liveRows.length === 0) {
          console.warn(`[tailnet-sync] server ${String(remoteInstanceId).slice(0, 12)}… is not a live paired peer here; closing`);
          recordDialFailure(peerId, `${wsUrl}: answered as ${String(remoteInstanceId).slice(0, 12)}…, not a live paired peer`);
          closedByUs = true;
          ws.close(1008, "not paired");
          frameReader.detach();
          return;
        }

        // Challenge-response: the server's reply must be bound to OUR fresh
        // nonce (a replayed server hello is not); then we answer its nonce.
        // A CR-less reply from a server that has done CR with us before is a
        // downgrade and is refused.
        if (!this.ctx.legacyHandshake) {
          if (serverHs.cr_sig !== undefined) {
            if (!safeVerify(crRespMessage(remoteInstanceId, instanceSyncManager.localInstanceId, ourHs.nonce_hex, serverHs.nonce_hex), serverHs.cr_sig, identity.ed25519Pubkey)) {
              console.warn(`[tailnet-sync] ${wsUrl} challenge response invalid (not bound to our nonce — replayed?); closing`);
              recordDialFailure(peerId, `${wsUrl}: challenge response invalid`);
              closedByUs = true;
              ws.close(1008, "bad challenge response");
              frameReader.detach();
              return;
            }
            ws.send(JSON.stringify({ cr_proof: sign(crProofMessage(instanceSyncManager.localInstanceId, remoteInstanceId, serverHs.nonce_hex, ourHs.nonce_hex), identity.ed25519Priv) }));
            await markPeerCr(this.ctx, remoteInstanceId);
          } else if (await peerCrRequired(this.ctx, remoteInstanceId)) {
            console.warn(`[tailnet-sync] ${wsUrl} answered without challenge-response, but this peer has done CR before (replay or downgrade); closing`);
            recordDialFailure(peerId, `${wsUrl}: answered without challenge-response (downgrade refused)`);
            closedByUs = true;
            ws.close(1008, "challenge required");
            frameReader.detach();
            return;
          }
        }

        // Learn the server's dial address if our row lacks it.
        await backfillPeerAddress(this.ctx, remoteInstanceId, verifiedAdvertisedAddress(serverHs, identity.ed25519Pubkey));

        // Receive server's feed key.
        const peerKeyMsg = await frameReader.readJsonFrame(HANDSHAKE_TIMEOUT_MS);
        const incomingKeyBuf = peerKeyMsg?.feed_key_hex
          ? instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, peerKeyMsg.feed_key_hex)
          : null;
        await instanceSyncManager.initInstance(remoteInstanceId, incomingKeyBuf);
        const ourOutKey = instanceSyncManager.getOutFeedKey(remoteInstanceId);
        ws.send(JSON.stringify({ feed_key_hex: ourOutKey ? ourOutKey.toString("hex") : null }));

        // Persist peer key if new (gated on the same validation result used for init above).
        if (incomingKeyBuf) {
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
          sql: `UPDATE crow_instances SET status=${livenessStatusSql("active")}, last_seen_at=datetime('now') WHERE id = ?`,
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
        if (ws.readyState !== WebSocket.OPEN) { frameReader.detach(); return; } // closed mid-handshake: close handler retries
        const wsStream = handoffToStream(ws, frameReader);
        const noiseStream = new NoiseSecretStream(true, wsStream);
        // A socket that closes before the Noise handshake completes leaves the
        // Noise stream open — a phantom "dedicated stream" that made the dialer
        // idle forever. The socket's close always ends the stream.
        ws.once("close", () => { try { noiseStream.destroy(); } catch { /* already closed */ } });
        noiseStream.on("error", () => {});
        noiseStream.once("close", () => recordLinkClosed(remoteInstanceId));
        armHeartbeat(ws, this.ctx, remoteInstanceId);
        await instanceSyncManager.replicate(remoteInstanceId, noiseStream, { dedicated: true });
        linked = true;
        recordLinkUp(remoteInstanceId, { direction: "outbound" });
        console.log(`[tailnet-sync] replicating with peer ${remoteInstanceId.slice(0,12)}… (client side${role === "fallback" ? ", fallback dial" : ""})`);
      } catch (err) {
        frameReader.detach();
        // A peer refusal (1013 already linked, 1008 unknown peer, …) closes
        // before any frame; the close handler already classified it — don't
        // overwrite that with the generic "socket closed during handshake".
        if (peerCloseCode) return;
        console.warn(`[tailnet-sync] outbound conn error to ${wsUrl}: ${err.message}`);
        recordDialFailure(peerId, `${wsUrl}: ${err.message}`);
        frameReader.detach();
        closedByUs = true;
        try { ws.close(); } catch {}
      }
    });

    ws.on("close", (code, reason) => {
      if (this.ws === ws) this.ws = null;
      const why = reason?.length ? String(reason) : "";
      if (!closedByUs) peerCloseCode = code || -1;
      if (linked) this.passiveSince = Date.now();
      if (closedByUs && !linked) return this.scheduleRetry(); // our refusal; failure already recorded
      // Peer already linked to us — nothing failed, nothing to retry.
      if (code === 1013) return this.scheduleIdle();
      if (!linked && code && code !== 1000 && code !== 1005 && code !== 1006) {
        // Refused by the peer (bad sig, unknown peer, …).
        recordDialFailure(peerId, `${wsUrl}: closed by peer (${code}${why ? ` ${why}` : ""})`);
      }
      if (!linked && code === 1008 && (why === "unknown peer" || why === "not paired")) {
        // It revoked us (or never paired): stop hammering it.
        this.idle = true;
        return this._setTimer(() => this.connect(), this.ctx.refusedRecheckMs ?? REFUSED_RECHECK_MS);
      }
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
 * Boot repair for peer rows the transport can never dial: gateway_url is the
 * :443 door (what pairing used to hand out) and tailscale_ip is empty — the
 * exact shape that stalled black-swan for six weeks. The URL's MagicDNS HOST
 * is right even though its port is not, so tailscaled already knows the
 * host's tailnet address: fill tailscale_ip from `tailscale status --json`.
 * The dial ladder then reaches the backend directly, the peer's signed
 * handshake teaches its real port and (backfillPeerAddress) replaces the
 * undialable URL. Only an EMPTY tailscale_ip is filled; only a tailnet
 * address is written. Runs at boot and then from the refresh loop (at most
 * every REPAIR_EVERY_MS), so a row paired after boot or a tailscaled that
 * came up late is repaired without a restart. Never throws. Returns the
 * repaired peer ids.
 */
const _repairWarned = new Set();
export async function repairUndialablePeerRows(ctx) {
  const repaired = [];
  const { db, instanceSyncManager } = ctx;
  // One async `tailscale status --json` per pass (lazily, only when a row
  // needs it) — never a blocking exec, never one per row.
  let statusP = null;
  const lookup = ctx.lookupTailnetIp || (async (host) => {
    statusP ||= tailscaleStatusAsync();
    const status = await statusP;
    return status ? lookupTailnetIpForHost(host, { status }) : null;
  });
  let rows = [];
  try {
    ({ rows } = await db.execute({
      sql: "SELECT id, name, gateway_url, tailscale_ip FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
      args: [instanceSyncManager.localInstanceId],
    }));
  } catch { return repaired; }
  for (const r of rows) {
    const url = r.gateway_url ? String(r.gateway_url).trim() : "";
    if (!url || (r.tailscale_ip && String(r.tailscale_ip).trim())) continue;
    if (peerToWsUrlCandidates({ gateway_url: url }).length > 0) continue; // dialable as-is
    const host = gatewayUrlHost(url);
    let ip = null;
    try { ip = host ? await lookup(host) : null; } catch { ip = null; }
    if (!ip || !(isTailnetIp(ip) || testLoopback(ip))) {
      if (_repairWarned.has(r.id)) continue;
      _repairWarned.add(r.id);
      console.warn(`[tailnet-sync] peer ${String(r.id).slice(0, 12)}… (${r.name || "unnamed"}) has undialable gateway_url ${url} and no tailscale_ip; ${host ? `tailnet lookup of ${host} found nothing` : "no host to look up"} — waiting for its signed handshake`);
      continue;
    }
    try {
      const u = await db.execute({
        sql: "UPDATE crow_instances SET tailscale_ip = ?, updated_at = datetime('now') WHERE id = ? AND (tailscale_ip IS NULL OR TRIM(tailscale_ip) = '')",
        args: [ip, r.id],
      });
      if (Number(u.rowsAffected ?? 0) > 0) {
        repaired.push(r.id);
        recordAddressBackfill(r.id, { tailscale_ip: ip });
        console.log(`[tailnet-sync] repaired peer ${String(r.id).slice(0, 12)}… (${r.name || "unnamed"}): undialable gateway_url ${url}; tailscale_ip ${ip} from the tailnet (MagicDNS ${host})`);
      }
    } catch (err) {
      console.warn(`[tailnet-sync] repair of ${String(r.id).slice(0, 12)}… failed: ${err.message}`);
    }
  }
  return repaired;
}

/**
 * For each paired instance (other than self), open a persistent WebSocket
 * to its gateway_url and run instance-sync over it. Reconnects with
 * exponential backoff.
 */
export async function startTailnetSyncClients(ctx) {
  const { db, instanceSyncManager } = ctx;
  const dialers = new Map();
  // Shared with the accept side (same ctx object at boot) so an address
  // learned from an inbound handshake reaches the running dialer at once.
  ctx.dialers = dialers;
  // Per-peer heal-failure counters (peerId → consecutive failure count). A
  // wedged initInstance (e.g. a held rocksdb dir lock) used to warn on EVERY
  // 60s rescan — one line per minute per peer, forever. Same observability
  // contract as the nostr crash guard: log at #1, #10, #100, …, plus one
  // "recovered" line when a failing peer heals (episode boundary visible,
  // next episode logs #1 immediately). Entries are dropped alongside the
  // peer's dialer when it leaves scope, so re-pair churn cannot grow the Map.
  const healFailures = new Map();

  async function refresh() {
    let rows;
    try {
      const r = await db.execute({
        sql: "SELECT id, name, gateway_url, tailscale_ip, sync_url, status FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
        args: [instanceSyncManager.localInstanceId],
      });
      rows = r.rows;
    } catch (err) {
      console.warn(`[tailnet-sync] refresh failed: ${err.message}`);
      return;
    }
    // Learned backend ports (signed handshakes), kept in local overrides.
    const ports = new Map();
    try {
      const { rows: pr } = await db.execute({
        sql: "SELECT key, value FROM dashboard_settings_overrides WHERE key LIKE ? AND instance_id = ?",
        args: [`${SYNC_PORT_KEY_PREFIX}%`, instanceSyncManager.localInstanceId],
      });
      for (const r of pr) ports.set(String(r.key).slice(SYNC_PORT_KEY_PREFIX.length), sanitizeAdvertisedPort(r.value));
    } catch { /* table missing on an old DB — ladder guesses only */ }
    const seenIds = new Set();
    for (const raw of rows) {
      const peer = ports.get(raw.id) ? { ...raw, sync_port: ports.get(raw.id) } : raw;
      seenIds.add(peer.id);
      // 2d C4: converge the in-feed with the persisted sync_url every rescan —
      // heals manual crow_update_instance edits and any missed key exchange
      // within 60s, no restart. Cheap fast-path (Map lookup + Buffer compare)
      // when nothing changed. Own try/catch: refresh runs on a bare
      // setInterval and an escaped rejection would still crash the gateway —
      // the nostr crash guard (nostr-crash-guard.js) swallows ONLY
      // SendingOnClosedConnection and RETHROWS everything else, so this local
      // catch stays load-bearing. Placed BEFORE both
      // continues below (R3 F-C): after the dialers.has() continue it would
      // never heal the steady state, which is exactly the case that needs
      // healing (an already-dialing peer whose row drifted).
      try {
        const keyBuf = peer.sync_url ? instanceSyncManager.validateIncomingFeedKey?.(peer.id, peer.sync_url) ?? null : null;
        await instanceSyncManager.initInstance(peer.id, keyBuf);
        const failures = healFailures.get(peer.id);
        if (failures) {
          // Distinct wording on purpose: greps/alerts keyed on the failure
          // class "refresh heal for" must not also match recoveries.
          console.warn(`[tailnet-sync] heal recovered for ${peer.id.slice(0,12)}… after ${failures} failure(s)`);
          healFailures.delete(peer.id);
        }
      } catch (err) {
        const n = (healFailures.get(peer.id) || 0) + 1;
        healFailures.set(peer.id, n);
        if (Number.isInteger(Math.log10(n))) {
          console.warn(`[tailnet-sync] refresh heal for ${peer.id.slice(0,12)}…: ${err.message} (#${n})`);
        }
      }
      // DIALER-RETRY: EVERY live peer gets a dialer, address or not. The old
      // `if (!peer.gateway_url) continue` meant a tailscale_ip-only peer was
      // never dialed, and a peer with no address at all was never reported.
      if (dialers.has(peer.id)) {
        // #144 minor: keep the dialer's row snapshot fresh — a changed
        // gateway_url/tailscale_ip previously kept dialing the OLD address
        // until a gateway restart. updatePeer also wakes a dialer parked for
        // lack of an address the moment the row gains one.
        dialers.get(peer.id).updatePeer(peer);
        continue;
      }
      const dialer = new PeerDialer(peer, ctx);
      dialers.set(peer.id, dialer);
      dialer.start();
    }
    // Stop dialers for peers no longer in scope (revoked, etc.)
    for (const [id, dialer] of dialers) {
      if (!seenIds.has(id)) {
        dialer.stop(); dialers.delete(id); forgetPeerDialHealth(id);
        // Its learned port goes with it (revoked / paused / unpaired). The CR
        // pin deliberately STAYS: a pause → un-pause must not open a legacy
        // replay window. Only the operator's local `crow instance pair`
        // clears it.
        db.execute({
          sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
          args: [`${SYNC_PORT_KEY_PREFIX}${id}`, instanceSyncManager.localInstanceId],
        }).catch(() => {});
      }
    }
    for (const id of healFailures.keys()) {
      if (!seenIds.has(id)) healFailures.delete(id);
    }
    // F5 gauge: parked emit-queue sizes ({peerId: count}), visible BEFORE the
    // 256-cap overflow warn drops entries. Placed AFTER the per-peer loop so a
    // zero-peer refresh still reports (R2 Q7). Own try/catch: refresh runs on
    // a bare setInterval, and the process-level nostr crash guard RETHROWS
    // non-nostr errors — an escaped throw here would crash the gateway.
    // Optional chaining guards older/stub managers that lack the method.
    try {
      const stats = instanceSyncManager.pendingEmitStats?.();
      const parts = stats
        ? Object.entries(stats).map(([id, n]) => `${String(id).slice(0, 12)}=${n}`)
        : [];
      if (parts.length > 0) {
        console.warn(`[instance-sync] pending emit queues: ${parts.join(", ")}`);
      }
    } catch (err) {
      console.warn(`[tailnet-sync] pending-emit gauge failed: ${err.message}`);
    }
  }

  let lastRepairAt = 0;
  async function refreshWithRepair() {
    if (Date.now() - lastRepairAt >= (ctx.repairEveryMs ?? REPAIR_EVERY_MS)) {
      lastRepairAt = Date.now();
      await repairUndialablePeerRows(ctx);
    }
    await refresh();
  }

  await refreshWithRepair();
  // Periodically rescan in case new peers get paired or gateway_urls change.
  const rescan = setInterval(refreshWithRepair, 60_000);
  rescan.unref?.();

  return {
    dialers,
    __refreshForTest: refresh,
    stop() {
      clearInterval(rescan);
      for (const d of dialers.values()) d.stop();
      dialers.clear();
    },
  };
}
