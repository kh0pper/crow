/**
 * POST /instance/enroll-request — peer-pairing endpoint.
 *
 * Called by another Crow instance during `crow instance pair --peer-url`.
 * Establishes symmetric cross-host RPC credentials in a single round-trip.
 *
 * Credential model (each arrow = one direction):
 *
 *   SOURCE → PEER outbound:
 *     - SOURCE holds: auth_token_S, signing_key_shared (in peer-tokens.json)
 *     - PEER validates:
 *         Authorization: Bearer auth_token_S  →  crow_instances[source_id].auth_token_hash
 *         HMAC with signing_key_shared        →  peer-tokens.json[source_id].signing_key
 *
 *   PEER → SOURCE outbound (return path):
 *     - PEER holds: auth_token_P, signing_key_shared (in peer-tokens.json)
 *     - SOURCE validates the symmetric mirror.
 *
 * Both sides use the same signing_key_shared to avoid proliferating secrets.
 * auth_tokens differ per direction to avoid token-reuse if one side's store leaks.
 *
 * Security model (hardened 2026-10-04, backlog ENROLL-OTC-OPTIONAL). The
 * endpoint is unauthenticated by design (first-time pairing), so every gate
 * below is load-bearing:
 *
 *   1. Off unless CROW_ENROLL_ENABLED=1.
 *   2. Source: isAllowedEnrollNetwork (dashboard/auth.js) — never over
 *      Tailscale Funnel (even with CROW_DASHBOARD_PUBLIC); a loopback socket
 *      (Serve / a same-box proxy) must name a client and every named address
 *      must be private/tailnet; never stricter-than-dashboard in reverse.
 *   3. A one-time code is MANDATORY: CROW_ENROLL_OTC must be set (>= 16 chars)
 *      or every request is refused. Compared in constant time. Wrong codes are
 *      rate-limited: a client (the proxied client address behind Serve) is
 *      locked after 5 wrong codes, the whole endpoint after 20, until the
 *      gateway restarts. Only wrong codes count.
 *   4. The OTC is single-use (a successful enroll records its digest in the
 *      local DB in the same transaction as the credential write, with a plain
 *      INSERT, so even two processes sharing a DB cannot both use it) and time-boxed: it expires
 *      CROW_ENROLL_WINDOW_MINUTES (default 30) after this gateway first saw it.
 *      One enroll at a time (a concurrent request gets 409 enroll_busy).
 *   5. An id this host already knows (a trusted or credentialed row, a revoked
 *      row, or an id with peer-tokens.json creds) is NEVER silently re-keyed or
 *      re-addressed: the request must carry a re-pair proof (enroll-guard.js:
 *      HMAC keyed by the stored hash of that peer's CURRENT bearer + the
 *      shared signing key, bound to THIS instance's id, this code's digest and
 *      every request field; trusted, non-revoked rows only), or the operator must have run
 *      `crow instance pair --allow-re-pair <id>` on THIS host (short-lived,
 *      single-use; the only way back for a revoked row). Otherwise 409 and
 *      nothing is written.
 *   6. Advertised dial addresses are kept only when tailnet/private-scoped;
 *      a dialable row is never downgraded to an undialable URL.
 *   7. The tailnet-sync challenge-response pin is never touched here.
 */

import express from "express";
import {
  getInstance,
  getOrCreateLocalInstanceId,
  selfPairingAddress,
} from "../instance-registry.js";
import {
  isDialableGatewayUrl, isPeerUsableUrl, isTailnetAddress, gatewayUrlHost, SYNC_PORT_KEY_PREFIX, ownTailnetSuffix,
} from "../../shared/self-dial-address.js";
import {
  setPeerCreds,
  getPeerCreds,
  loadPeerCreds,
  savePeerCreds,
  generateSecret,
} from "../../shared/peer-credentials.js";
import {
  ENROLL_OTC_MIN_LENGTH, MAX_REPAIR_PROOFS, sha256Hex, safeEqual, verifyRepairProofs, repairProofKey,
  hasRepairAllowance, otcFirstSeen, OTC_USED_KEY_PREFIX, REPAIR_ALLOW_KEY_PREFIX,
} from "../../shared/enroll-guard.js";
import { isAllowedEnrollNetwork } from "../dashboard/auth.js";
import { forwardedAddrs } from "../models/door-resolve.js";
import bus from "../../shared/event-bus.js";
import { hostname as osHostname } from "os";

export const ENROLL_FAIL_PER_SOURCE = 5;
export const ENROLL_FAIL_GLOBAL = 20;
const DEFAULT_WINDOW_MINUTES = 30;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAIR_CLI = "node scripts/cli/instance-pair.js";

function windowMs(env = process.env) {
  const n = parseInt(env.CROW_ENROLL_WINDOW_MINUTES || "", 10);
  const m = Number.isInteger(n) && n > 0 ? Math.min(n, 24 * 60) : DEFAULT_WINDOW_MINUTES;
  return m * 60_000;
}

/** The client a failure is charged to: the proxied client behind a loopback
 * proxy (Serve replaces X-Forwarded-For with the real tailnet client), else
 * the TCP peer. Only called after isAllowedEnrollNetwork passed. */
function clientKey(req) {
  const sock = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  const hops = forwardedAddrs(req.headers || {});
  return (hops.length ? String(hops[hops.length - 1]).replace(/^::ffff:/, "") : sock) || "unknown";
}

/** Kept as the route-level name; the decision lives with the dashboard gate. */
export const enrollSourceAllowed = (req) => isAllowedEnrollNetwork(req);

function isDialPrivateV4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  // 10/8 and 192.168/16 (LAN); NOT 172.16/12 (docker bridges) or loopback.
  return a === 10 || (a === 192 && b === 168);
}

/** `<tailnet>.ts.net` of a host, or null. */
function tailnetSuffix(host) {
  const parts = String(host || "").toLowerCase().split(".");
  if (parts.length < 3 || parts[parts.length - 1] !== "net" || parts[parts.length - 2] !== "ts") return null;
  return parts.slice(-3).join(".");
}

/**
 * A peer-advertised gateway_url we are willing to store: a tailnet IP, a
 * MagicDNS name in OUR tailnet (`ownTailnet` = `<tailnet>.ts.net`, from our
 * own advertised address; other tailnets' — possibly public Funnel — hosts are
 * refused), or a 10/8 / 192.168/16 LAN address. Anything else is dropped.
 */
export function acceptableAdvertisedUrl(raw, { ownTailnet = null } = {}) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const url = raw.trim().replace(/\/+$/, "");
  if (!isPeerUsableUrl(url)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.username || u.password) return null;
  const host = gatewayUrlHost(url);
  if (!host) return null;
  if (isTailnetAddress(host) || isDialPrivateV4(host)) return url;
  if (ownTailnet && tailnetSuffix(host) === ownTailnet) return url;
  return null;
}

export function instanceEnrollRouter(db, { execFileSyncImpl, now = () => Date.now() } = {}) {
  const router = express.Router();

  // Per-process brute-force budget (wrong codes only).
  const failuresBySource = new Map();
  let totalFailures = 0;
  let inFlight = false;

  const configuredOtc = () => {
    const v = process.env.CROW_ENROLL_OTC;
    return typeof v === "string" && v.length >= ENROLL_OTC_MIN_LENGTH ? v : null;
  };

  // Start the OTC's time box at boot, so a code left configured since an old
  // ceremony does not get a fresh window from whoever probes first.
  if (process.env.CROW_ENROLL_ENABLED === "1" && configuredOtc()) {
    Promise.resolve()
      .then(() => otcFirstSeen(db, getOrCreateLocalInstanceId(), sha256Hex(configuredOtc()), now()))
      .catch(() => {});
  }

  function recordFailure(source) {
    totalFailures += 1;
    const n = (failuresBySource.get(source) || 0) + 1;
    failuresBySource.set(source, n);
    if (n === ENROLL_FAIL_PER_SOURCE) console.warn(`[instance-enroll] source ${source} locked after ${n} wrong codes`);
    if (totalFailures === ENROLL_FAIL_GLOBAL) console.warn(`[instance-enroll] enrollment LOCKED after ${totalFailures} wrong codes — restart the gateway with a new CROW_ENROLL_OTC`);
  }

  router.post("/instance/enroll-request", express.json({ limit: "8kb" }), async (req, res) => {
    if (process.env.CROW_ENROLL_ENABLED !== "1") {
      return res.status(403).json({ error: "enrollment_disabled", hint: "set CROW_ENROLL_ENABLED=1 and CROW_ENROLL_OTC on the peer during pairing" });
    }
    if (!isAllowedEnrollNetwork(req)) {
      return res.status(403).json({ error: "enroll_source_refused", hint: "enrollment is only reachable from an IPv4 tailnet / LAN client dialing the peer's tailnet URL (Serve or tailnet IP:port) — never over Funnel, a public proxy, bare loopback or IPv6" });
    }
    const source = clientKey(req);
    if (totalFailures >= ENROLL_FAIL_GLOBAL || (failuresBySource.get(source) || 0) >= ENROLL_FAIL_PER_SOURCE) {
      return res.status(429).json({ error: "enroll_locked", hint: "too many wrong one-time codes; restart the peer gateway with a new CROW_ENROLL_OTC" });
    }
    const expectedOtc = configuredOtc();
    if (!expectedOtc) {
      return res.status(403).json({
        error: "otc_required",
        hint: `enrollment needs a one-time code of at least ${ENROLL_OTC_MIN_LENGTH} characters: run \`${PAIR_CLI} --generate-otc\` on this peer, set CROW_ENROLL_OTC in its gateway environment and restart it`,
      });
    }

    const body = req.body || {};
    const {
      source_instance_id,
      source_name,
      source_gateway_url,
      source_tailscale_ip,
      source_sync_port,
      source_outbound_bearer,
      shared_signing_key,
      otc,
      repair_proofs,
    } = body;

    if (!source_instance_id || typeof source_instance_id !== "string" || !ID_RE.test(source_instance_id)) {
      return res.status(400).json({ error: "source_instance_id required ([A-Za-z0-9._:-], <=128 chars)" });
    }
    if (!source_outbound_bearer || typeof source_outbound_bearer !== "string" || source_outbound_bearer.length < 32) {
      return res.status(400).json({ error: "source_outbound_bearer required (>=32 chars)" });
    }
    if (!shared_signing_key || typeof shared_signing_key !== "string" || shared_signing_key.length < 32) {
      return res.status(400).json({ error: "shared_signing_key required (>=32 chars)" });
    }
    if (repair_proofs !== undefined && (!Array.isArray(repair_proofs) || repair_proofs.length > MAX_REPAIR_PROOFS)) {
      return res.status(400).json({ error: `repair_proofs must be an array of at most ${MAX_REPAIR_PROOFS}` });
    }

    if (typeof otc !== "string" || !otc) {
      return res.status(401).json({ error: "otc_required", hint: "pass the peer's one-time code: --otc <code> (or CROW_ENROLL_OTC in the CLI's environment)" });
    }
    if (!safeEqual(otc, expectedOtc)) {
      recordFailure(source);
      return res.status(401).json({ error: "otc_mismatch" });
    }

    // One enroll at a time in this process; across processes the plain
    // INSERT of the used-code mark below is the claim.
    if (inFlight) return res.status(409).json({ error: "enroll_busy", hint: "another enrollment is in progress; retry" });
    inFlight = true;
    try {
      const localId = getOrCreateLocalInstanceId();
      const digest = sha256Hex(expectedOtc);
      const t = now();
      const firstSeen = await otcFirstSeen(db, localId, digest, t);
      if (t - firstSeen > windowMs()) {
        return res.status(403).json({ error: "enroll_window_expired", hint: "this one-time code's pairing window has closed; set a new CROW_ENROLL_OTC and restart" });
      }
      const usedKey = `${OTC_USED_KEY_PREFIX}${digest}`;
      const usedRow = await db.execute({ sql: "SELECT 1 FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [usedKey, localId] });
      if (usedRow.rows.length) {
        return res.status(403).json({ error: "otc_used", hint: "this one-time code was already used; set a new CROW_ENROLL_OTC and restart" });
      }
      if (source_instance_id === localId) {
        return res.status(400).json({ error: "cannot enroll this instance's own id" });
      }

      const existing = await getInstance(db, source_instance_id);
      const existingCreds = getPeerCreds(source_instance_id);
      const bareRow = Boolean(existing) && !Number(existing.trusted) && !existing.auth_token_hash && existing.status !== "revoked";
      const fresh = (!existing || bareRow) && !existingCreds;
      let usedAllowance = false;
      if (!fresh) {
        const proofOk = Boolean(existing)
          && Number(existing.trusted) === 1
          && (existing.status === "active" || existing.status === "offline")
          && verifyRepairProofs(
            repairProofKey(existing.auth_token_hash, existingCreds?.signing_key),
            body, repair_proofs, { targetId: localId, otcDigest: digest },
          );
        if (!proofOk) {
          usedAllowance = await hasRepairAllowance(db, localId, source_instance_id, { now: t });
          if (!usedAllowance) {
            // Not a brute-force signal (the code was right) — not counted.
            return res.status(409).json({
              error: "already_paired",
              hint: `instance ${source_instance_id} is already known here; re-pairing needs proof of its current credentials (sent by an up-to-date \`crow instance pair\` that still holds them — pass --peer-id ${localId} if the URL does not match the stored peer) or, on THIS host, \`${PAIR_CLI} --allow-re-pair ${source_instance_id}\``,
            });
          }
        }
      }
      const mode = fresh ? (existing ? "known-uncredentialed" : "new") : (usedAllowance ? "re-pair: operator allowance" : "re-pair: current-credential proof");

      // Our TAILNET dial address — never CROW_GATEWAY_URL (the public
      // Funnel URL on crow; instance sync never dials :443). Resolved before
      // anything is written.
      const self = await selfPairingAddress(db, execFileSyncImpl ? { execFileSyncImpl } : {});

      const sourceHash = sha256Hex(source_outbound_bearer);
      // Our own tailnet (for MagicDNS names): from our advertised URL, else
      // from tailscaled itself (a host advertising a bare IP still knows it).
      const ownTailnet = tailnetSuffix(gatewayUrlHost(self.gateway_url))
        || ownTailnetSuffix(execFileSyncImpl ? { execFileSyncImpl } : {});
      let srcUrl = acceptableAdvertisedUrl(source_gateway_url, { ownTailnet });
      // A dialable advertised URL wins; an undialable one (an old peer's
      // CROW_GATEWAY_URL — the :443 door) never replaces a dialable row.
      // A known-but-uncredentialed row (registered by the operator, never
      // paired) keeps the address the operator gave it: the enroller may only
      // fill blanks there.
      let gatewayUrl = srcUrl && (isDialableGatewayUrl(srcUrl) || !isDialableGatewayUrl(existing?.gateway_url))
        ? srcUrl : (existing?.gateway_url || srcUrl || null);
      let tailscaleIp = typeof source_tailscale_ip === "string" && isTailnetAddress(source_tailscale_ip.trim())
        ? source_tailscale_ip.trim() : null;
      const port = Number(source_sync_port);
      const portOk = Number.isInteger(port) && port > 0 && port < 65536;
      // An advertised URL we cannot accept (e.g. a MagicDNS name when our own
      // tailnet is unknown) must not leave a NEW peer with no address — the
      // federation proxy skips address-less rows. Fall back to the verified
      // tailnet IP + backend port; refuse if even that is missing.
      if (!srcUrl && !existing && tailscaleIp && portOk) {
        srcUrl = `http://${tailscaleIp.includes(":") ? `[${tailscaleIp}]` : tailscaleIp}:${port}`;
        gatewayUrl = srcUrl;
      }
      // (source_sync_port is the source's gateway backend port — selfPairingAddress.)
      if (!gatewayUrl && !existing) {
        return res.status(400).json({ error: "gateway_url_unacceptable", hint: "the advertised gateway_url must be a tailnet IP, a MagicDNS name in this host's tailnet, or a LAN (10/8, 192.168/16) address; or advertise source_tailscale_ip + source_sync_port" });
      }
      if (bareRow) {
        gatewayUrl = existing.gateway_url || gatewayUrl;
        if (existing.tailscale_ip) tailscaleIp = null;
      }
      const name = typeof source_name === "string" && source_name.trim() ? source_name.trim().slice(0, 128) : null;

      const stmts = [
        // The claim: a plain INSERT — a second use (any process) violates the
        // primary key and rolls the whole enrollment back.
        { sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, ?, datetime('now'))", args: [usedKey, localId, String(t)] },
        // Any allowance for this id is spent by ANY successful enroll of it.
        { sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [`${REPAIR_ALLOW_KEY_PREFIX}${source_instance_id}`, localId] },
      ];
      if (existing) {
        stmts.push({
          // Compare-and-swap on the hash we authorized against.
          sql: `UPDATE crow_instances SET name = ?, gateway_url = ?, tailscale_ip = COALESCE(?, tailscale_ip),
                  auth_token_hash = ?, trusted = 1,
                  status = CASE WHEN status = 'revoked' THEN 'active' ELSE status END,
                  updated_at = datetime('now')
                WHERE id = ? AND auth_token_hash IS ? AND status IS ? AND COALESCE(trusted, 0) = ?`,
          args: [name || existing.name, gatewayUrl, tailscaleIp, sourceHash, source_instance_id,
            existing.auth_token_hash ?? null, existing.status ?? null, Number(existing.trusted) || 0],
        });
        // Abort (NOT NULL violation) if the CAS above matched no row: the row
        // changed since it was authorized.
        stmts.push({ sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value) SELECT NULL, NULL, NULL WHERE changes() = 0", args: [] });
      } else {
        stmts.push({
          sql: `INSERT INTO crow_instances (id, name, crow_id, tailscale_ip, gateway_url, sync_profile, is_home, auth_token_hash, last_seen_at, status, trusted)
                VALUES (?, ?, ?, ?, ?, 'full', 0, ?, datetime('now'), 'active', 1)`,
          args: [source_instance_id, name || source_instance_id, source_instance_id, tailscaleIp, gatewayUrl, sourceHash],
        });
      }
      if (portOk && !bareRow) {
        stmts.push({
          sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          args: [`${SYNC_PORT_KEY_PREFIX}${source_instance_id}`, localId, String(port)],
        });
      } else if (portOk) {
        stmts.push({
          sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(key, instance_id) DO NOTHING`,
          args: [`${SYNC_PORT_KEY_PREFIX}${source_instance_id}`, localId, String(port)],
        });
      }

      // peer-tokens.json first (a file, outside the transaction); restored if
      // the transaction rolls back, so a failure leaves the old pairing intact.
      const peerOutboundBearer = generateSecret();
      const prevAll = loadPeerCreds();
      const hadPrev = Object.prototype.hasOwnProperty.call(prevAll, source_instance_id);
      const prevCreds = prevAll[source_instance_id];
      setPeerCreds(source_instance_id, { auth_token: peerOutboundBearer, signing_key: shared_signing_key });
      try {
        await db.batch(stmts);
      } catch (err) {
        // Compare-and-restore: only undo OUR write — if another process has
        // since written this id's creds (and committed), leave them.
        const all = loadPeerCreds();
        if (all[source_instance_id]?.auth_token === peerOutboundBearer) {
          if (hadPrev) all[source_instance_id] = prevCreds; else delete all[source_instance_id];
          savePeerCreds(all);
        }
        const msg = String(err?.message || "");
        if (/constraint/i.test(msg) && /dashboard_settings_overrides\.key/.test(msg) && /UNIQUE|PRIMARY/i.test(msg)) {
          return res.status(403).json({ error: "otc_used", hint: "this one-time code was already used; set a new CROW_ENROLL_OTC and restart" });
        }
        if (/constraint/i.test(msg)) {
          return res.status(409).json({ error: "enroll_conflict", hint: "the peer row changed during enrollment (concurrent pairing of this id); retry with a new code if needed" });
        }
        throw err;
      }
      try {
        bus.emit("crow_instances:row_updated", { id: source_instance_id, changed: ["trusted", "status"], fields: { trusted: 1, status: "active" } });
      } catch { /* subscriber failures are not primary-write failures */ }

      // NOTE: the tailnet-sync challenge-response pin (tailnet_sync_cr:<id>)
      // is deliberately NOT touched here: clearing it on an inbound request
      // would let an enroller downgrade a pinned peer to the replayable
      // legacy handshake. Only the operator's local `crow instance pair`
      // (scripts/cli/instance-pair.js) clears it.
      console.log(`[instance-enroll] enrolled ${source_instance_id} from ${source} (${mode})`);
      return res.json({
        peer_instance_id: localId,
        peer_crow_id: localId,
        peer_name: osHostname(),
        peer_gateway_url: self.gateway_url,
        peer_tailscale_ip: self.tailscale_ip,
        peer_sync_port: self.sync_port,
        peer_outbound_bearer: peerOutboundBearer,
      });
    } catch (err) {
      console.error("[instance-enroll] error:", err);
      return res.status(500).json({ error: "enroll_failed" });
    } finally {
      inFlight = false;
    }
  });

  return router;
}
