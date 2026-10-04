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
 * Security model:
 *   - Unauthenticated on purpose (first-time pairing, no trust yet).
 *   - Gated by env CROW_ENROLL_ENABLED=1 — operator turns on during ceremony, off after.
 *   - Optional CROW_ENROLL_OTC for a shared-secret gate.
 *   - Runs over Tailscale in practice.
 */

import express from "express";
import { createHash } from "crypto";
import {
  registerInstance,
  getInstance,
  updateInstance,
  getOrCreateLocalInstanceId,
  selfPairingAddress,
} from "../instance-registry.js";
import { isDialableGatewayUrl, isTailnetAddress, rememberPeerSyncPort } from "../../shared/self-dial-address.js";
import {
  setPeerCreds,
  generateSecret,
} from "../../shared/peer-credentials.js";
import { hostname as osHostname } from "os";

export function instanceEnrollRouter(db, { execFileSyncImpl } = {}) {
  const router = express.Router();

  router.post("/instance/enroll-request", express.json({ limit: "8kb" }), async (req, res) => {
    if (process.env.CROW_ENROLL_ENABLED !== "1") {
      return res.status(403).json({ error: "enrollment_disabled", hint: "set CROW_ENROLL_ENABLED=1 on the peer during pairing" });
    }

    const {
      source_instance_id,
      source_name,
      source_gateway_url,
      source_tailscale_ip,
      source_sync_port,
      source_outbound_bearer,
      shared_signing_key,
      otc,
    } = req.body || {};

    if (!source_instance_id || typeof source_instance_id !== "string") {
      return res.status(400).json({ error: "source_instance_id required" });
    }
    if (!source_outbound_bearer || typeof source_outbound_bearer !== "string" || source_outbound_bearer.length < 32) {
      return res.status(400).json({ error: "source_outbound_bearer required (>=32 chars)" });
    }
    if (!shared_signing_key || typeof shared_signing_key !== "string" || shared_signing_key.length < 32) {
      return res.status(400).json({ error: "shared_signing_key required (>=32 chars)" });
    }

    if (process.env.CROW_ENROLL_OTC && process.env.CROW_ENROLL_OTC !== otc) {
      return res.status(401).json({ error: "otc_mismatch" });
    }

    try {
      // Store source's auth_token_hash + name + gateway_url in our crow_instances,
      // and promote to trusted=1.
      const sourceHash = createHash("sha256").update(source_outbound_bearer).digest("hex");
      const existing = await getInstance(db, source_instance_id);
      // A dialable advertised URL wins; an undialable one (an old peer's
      // CROW_GATEWAY_URL — the :443 door) never replaces a dialable row.
      const srcUrl = typeof source_gateway_url === "string" && source_gateway_url.trim() ? source_gateway_url.trim() : null;
      const gatewayUrl = srcUrl && (isDialableGatewayUrl(srcUrl) || !isDialableGatewayUrl(existing?.gateway_url))
        ? srcUrl : (existing?.gateway_url || srcUrl || null);
      const tailscaleIp = typeof source_tailscale_ip === "string" && isTailnetAddress(source_tailscale_ip.trim())
        ? source_tailscale_ip.trim() : null;
      if (existing) {
        await updateInstance(db, source_instance_id, {
          name: source_name || existing.name,
          gateway_url: gatewayUrl,
          ...(tailscaleIp ? { tailscale_ip: tailscaleIp } : {}),
          auth_token_hash: sourceHash,
          trusted: 1,
        });
      } else {
        await registerInstance(db, {
          id: source_instance_id,
          name: source_name || source_instance_id,
          crowId: source_instance_id,
          gatewayUrl,
          tailscaleIp,
          authTokenHash: sourceHash,
        });
        await updateInstance(db, source_instance_id, { trusted: 1 });
      }

      // Store source-side creds in our peer-tokens.json.
      // auth_token = what WE send to source on outbound calls (generated below)
      // signing_key = the shared symmetric HMAC key
      const peerOutboundBearer = generateSecret();
      setPeerCreds(source_instance_id, {
        auth_token: peerOutboundBearer,
        signing_key: shared_signing_key,
      });

      const localId = getOrCreateLocalInstanceId();
      await rememberPeerSyncPort(db, localId, source_instance_id, source_sync_port);
      // NOTE: the tailnet-sync challenge-response pin (tailnet_sync_cr:<id>)
      // is deliberately NOT touched here. This endpoint is reachable by any
      // host while enrollment is enabled (the OTC is optional), so clearing
      // the pin on an inbound request would let anyone downgrade a pinned
      // peer to the replayable legacy handshake. Only the operator's local
      // `crow instance pair` (scripts/cli/instance-pair.js) or a revoke
      // clears it.
      // Our TAILNET dial address — never CROW_GATEWAY_URL (the public
      // Funnel URL on crow; instance sync never dials :443).
      const self = await selfPairingAddress(db, execFileSyncImpl ? { execFileSyncImpl } : {});
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
      return res.status(500).json({ error: String(err.message || err) });
    }
  });

  return router;
}
