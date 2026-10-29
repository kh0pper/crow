/**
 * Peer relay (item 46 PR-B): the ONLY path by which a pi bot reaches a paired
 * peer's MCP mount.
 *
 * Kevin's ruling: no pair key, signing key or peer bearer ever reaches a bot or
 * pi process. So a bot's remote-tools proxy (scripts/pi-bots/crow-remote-proxy.mjs)
 * never talks to a peer. It calls this loopback route on its own gateway with
 * the path-scoped relay token and the per-boot signed actor headers; this
 * gateway verifies the bot, re-checks the source-side policy, and forwards to
 * the peer with the peer bearer, signing a tools/call for that verified bot
 * with the pair subkey (servers/shared/remote-actor.js). The peer's own
 * exposure gate stays the authoritative allow/deny for what runs there.
 *
 *   /peer-relay/:instanceId/<mount>/mcp     POST, GET, DELETE
 *
 * Order, every refusal a JSON-RPC-shaped error that never forwards:
 *   1. a plain loopback request (classifyPeer via "local")        else 403
 *   2. Bearer <relay token>                                          else 401
 *   3. X-Crow-Actor-{Id,Thread,Gateway,Sig}, kind "peer-relay"       else 401
 *   4. feature_flags.remote_invocation                               else 403
 *   5. <mount> is a remote capability                                else 404
 *      and the bot's row selected (instanceId, capability)          else 403
 *   6. a trusted peer row with a gateway_url                         else 404
 *      and a peer bearer                                             else 502
 *   7. a JSON-RPC batch                                              -32600
 * A peer with no pair key is forwarded unsigned (its label falls back to
 * "Crow (via <name>)"), logged once per (bot, peer) per hour. The name signed
 * is the bot row's display_name, never anything the request carries.
 *
 * Mountable on a bare express app: every dependency is a function parameter.
 */
import { Router } from "express";
import { Readable } from "node:stream";
import { classifyPeer } from "../../shared/peer-class.js";
import { TRUSTED_PEER_SQL } from "../../shared/peer-trust.js";
import { signRemoteActor } from "../../shared/remote-actor.js";
import { validatePeerRelayToken } from "../local-token.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { defaultPairKey } from "../../shared/sync-pair-binding.js";
import { getPeerCreds } from "../../shared/peer-credentials.js";
import { readSetting } from "../dashboard/settings/registry.js";
import { verifyPeerRelayActorSig } from "../../../scripts/pi-bots/actor-sig.mjs";
import { REMOTE_CANON_MOUNT, remoteServersForBot, parseRemoteInvocationFlag } from "../../../scripts/pi-bots/remote-blocks.mjs";
import { sanitizeActorName } from "../../../scripts/pi-bots/actor-env.mjs";
import { BOT_ID_RE } from "../../../scripts/pi-bots/bot-workspace-env.mjs";

const CANON_BY_SEGMENT = new Map(Object.entries(REMOTE_CANON_MOUNT).map(([canon, mount]) => [mount.slice(1), canon]));
const REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];
const UNSIGNED_LOG_WINDOW_MS = 3_600_000;
const UNSIGNED_LOG_CAP = 1024;

const unsignedLogged = new Map();
/** Test seam on module state (like remote-actor.js's _resetRemoteActorLog). */
export function _resetPeerRelayLog() { unsignedLogged.clear(); }

function noteUnsigned(bot, instanceId, now) {
  const k = `${bot}\n${instanceId}`;
  const last = unsignedLogged.get(k);
  if (last !== undefined && now - last < UNSIGNED_LOG_WINDOW_MS) return;
  unsignedLogged.delete(k);
  if (unsignedLogged.size >= UNSIGNED_LOG_CAP) unsignedLogged.delete(unsignedLogged.keys().next().value);
  unsignedLogged.set(k, now);
  console.error(`[peer-relay] forwarding unsigned for bot ${bot} to ${instanceId}: no pair key`);
}

function refuse(res, status, message, { code = -32001, id = null } = {}) {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id });
}

const header = (req, name) => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

/**
 * @param {object} o
 * @param {() => object} o.createDbClient  opens a db client (closed per request)
 * @param {object} [o.deps]
 * @param {Function} [o.deps.fetchImpl]   upstream fetch (default globalThis.fetch)
 * @param {Function} [o.deps.keyLookup]   peerId -> pair signing key hex | null
 * @param {Function} [o.deps.getCreds]    peerId -> { auth_token } | null
 * @param {Function|string} [o.deps.localId]  this instance's id (or a function returning it)
 * @param {Function} [o.deps.now]         ms clock for the remote-actor timestamp
 */
export function peerRelayRouter({ createDbClient, deps = {} } = {}) {
  if (typeof createDbClient !== "function") throw new TypeError("peerRelayRouter: createDbClient is required");
  const fetchImpl = deps.fetchImpl || ((...a) => globalThis.fetch(...a));
  const keyLookup = deps.keyLookup || defaultPairKey;
  const getCreds = deps.getCreds || getPeerCreds;
  const localIdFn = typeof deps.localId === "function" ? deps.localId
    : typeof deps.localId === "string" ? () => deps.localId
      : getOrCreateLocalInstanceId;
  const now = deps.now || (() => Date.now());

  const router = Router();
  router.all("/peer-relay/:instanceId/:mount/mcp", async (req, res) => {
    const id = req.body && typeof req.body === "object" && !Array.isArray(req.body) && req.body.id !== undefined ? req.body.id : null;
    if (!["POST", "GET", "DELETE"].includes(req.method)) return refuse(res, 405, "method not allowed", { id });

    // 1. Only this host's own processes, unproxied.
    let via = null;
    try { via = classifyPeer(req).via; } catch { via = null; }
    if (via !== "local") return refuse(res, 403, "the peer relay is local only", { id });

    let db;
    try {
      db = createDbClient();
      // 2. The relay token.
      const auth = header(req, "authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      let tokenOk = false;
      try { tokenOk = !!token && await validatePeerRelayToken(db, token); } catch { tokenOk = false; }
      if (!tokenOk) return refuse(res, 401, "a valid relay token is required", { id });

      // 3. The signed actor: never relay unattributed (that would lend the bot this gateway's peer bearer).
      const bot = header(req, "x-crow-actor-id");
      const threadId = header(req, "x-crow-actor-thread");
      const gatewayType = header(req, "x-crow-actor-gateway");
      const sig = header(req, "x-crow-actor-sig");
      if (typeof bot !== "string" || !BOT_ID_RE.test(bot) || !verifyPeerRelayActorSig({ botId: bot, threadId, gatewayType, sig })) {
        return refuse(res, 401, "a signed bot actor is required", { id });
      }

      // 4. The instance switch.
      let flagRaw = null;
      try { flagRaw = await readSetting(db, "feature_flags"); } catch { flagRaw = null; }
      if (!parseRemoteInvocationFlag(flagRaw)) return refuse(res, 403, "remote invocation is off", { id });

      // 5. The bot's own selection, from its row.
      const instanceId = req.params.instanceId;
      const canonicalId = CANON_BY_SEGMENT.get(req.params.mount);
      if (!canonicalId) return refuse(res, 404, "not a remote capability mount", { id });
      const mount = REMOTE_CANON_MOUNT[canonicalId];
      let row = null;
      try {
        const r = await db.execute({ sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE bot_id = ?", args: [bot] });
        row = r.rows[0] || null;
      } catch (err) {
        // The relay's own fault, not the bot's: never a misleading "not selected".
        console.error(`[peer-relay] bot lookup failed: ${err && err.message}`);
        return refuse(res, 503, "the peer relay could not read the bot's settings", { id });
      }
      let def = null;
      try { def = row && row.definition ? JSON.parse(row.definition) : null; } catch { def = null; }
      const selected = !!row && remoteServersForBot(def).some((s) => s.instanceId === instanceId && s.canonicalId === canonicalId);
      if (!selected) return refuse(res, 403, "capability not selected for this bot", { id });

      // 6. A trusted peer, and its bearer.
      let peer = null;
      try {
        const r = await db.execute({
          sql: `SELECT id, gateway_url FROM crow_instances WHERE id = ? AND ${TRUSTED_PEER_SQL} AND gateway_url IS NOT NULL AND gateway_url != ''`,
          args: [instanceId],
        });
        peer = r.rows[0] || null;
      } catch { peer = null; }
      if (!peer) return refuse(res, 404, "unknown or untrusted peer", { id });
      let creds = null;
      try { creds = await getCreds(instanceId); } catch { creds = null; }
      if (!creds || typeof creds.auth_token !== "string" || !creds.auth_token) return refuse(res, 502, "no credentials for this peer", { id });

      // 7. Batches are never relayed (the receiver verifies single objects only).
      if (Array.isArray(req.body)) return refuse(res, 400, "batch requests are not relayed", { code: -32600 });

      // 8. Forward.
      const headers = { authorization: `Bearer ${creds.auth_token}` };
      for (const h of REQUEST_HEADERS) { const v = header(req, h); if (v !== undefined) headers[h] = v; }
      let body;
      if (req.method === "POST") {
        if (!req.body || typeof req.body !== "object") return refuse(res, 400, "a JSON-RPC body is required", { code: -32600 });
        body = JSON.stringify(req.body);
        if (req.body.method === "tools/call") {
          let key = null;
          try { key = await keyLookup(instanceId); } catch { key = null; }
          let src = null;
          try { src = await localIdFn(); } catch { src = null; }
          const signed = key && src ? signRemoteActor({
            signingKeyHex: key, bot, name: sanitizeActorName(row.display_name, bot), src, aud: instanceId, mount, body: req.body, now: now(),
          }) : null;
          if (signed) Object.assign(headers, signed);
          else noteUnsigned(bot, instanceId, now());
        }
      }
      try { db.close(); } catch {}
      db = null;

      const url = `${String(peer.gateway_url).replace(/\/+$/, "")}${mount}/mcp`;
      const ac = new AbortController();
      res.on("close", () => { if (!res.writableEnded) ac.abort(); });
      let upstream;
      try {
        upstream = await fetchImpl(url, { method: req.method, headers, body, signal: ac.signal });
      } catch {
        if (ac.signal.aborted) return;
        return refuse(res, 502, "the peer is unreachable", { id });
      }

      // 9. Stream the answer back (SSE included).
      res.status(upstream.status);
      for (const h of RESPONSE_HEADERS) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
      if (!upstream.body) return res.end();
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      const stream = Readable.fromWeb(upstream.body);
      stream.on("error", () => { try { res.end(); } catch {} });
      stream.pipe(res);
    } catch (err) {
      // The message only: never headers, tokens or keys.
      console.error(`[peer-relay] relay error: ${err && err.message}`);
      return refuse(res, 500, "peer relay error", { id });
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  });
  return router;
}
