#!/usr/bin/env node
/**
 * `crow instance pair` — Pair this Crow instance with a peer.
 *
 * Modes:
 *   1. Network: POSTs /instance/enroll-request to the peer gateway, which
 *      accepts credentials and returns its symmetric pair.
 *   2. Manual: prints the credentials to paste on the peer side, and reads
 *      the peer's credentials from stdin.
 *
 * Both modes:
 *   - Register the peer in this node's crow_instances table (trusted=1).
 *   - Store { auth_token, signing_key } in ~/.crow/peer-tokens.json.
 *
 * Usage:
 *   node scripts/cli/instance-pair.js --peer-url https://grackle.dachshund-chromatic.ts.net
 *   node scripts/cli/instance-pair.js --manual-paste
 *
 * With --peer-url, the peer's gateway must expose the /instance/enroll
 * endpoints (Phase 5-MVP wires these into routes/bundles.js sibling route
 * file servers/gateway/routes/instance-enroll.js).
 */

import { createDbClient } from "../../servers/db.js";
import { createHash } from "crypto";
import {
  registerInstance,
  getInstance,
  updateInstance,
  getOrCreateLocalInstanceId,
} from "../../servers/gateway/instance-registry.js";
import {
  setPeerCreds,
  generateSecret,
  peerTokensPath,
} from "../../servers/shared/peer-credentials.js";
import { createInterface } from "readline";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--peer-url") out.peerUrl = argv[++i];
    else if (a === "--peer-id") out.peerId = argv[++i];
    else if (a === "--peer-name") out.peerName = argv[++i];
    else if (a === "--manual-paste") out.manual = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Crow instance pair — provision cross-host RPC credentials.

Usage:
  node scripts/cli/instance-pair.js --peer-url <url> [--peer-name <name>]
  node scripts/cli/instance-pair.js --manual-paste --peer-id <id> --peer-name <name> --peer-url <url>

Network mode (--peer-url):
  POSTs to <peer-url>/instance/enroll-request with this node's credentials.
  Peer responds with its own symmetric credentials.

Manual mode (--manual-paste):
  Prints credentials to paste on the peer side, and reads peer's credentials
  from stdin. Useful for first-time setup before gateways can talk.

Credentials stored at: ${peerTokensPath()}`);
}

async function readJsonFromStdin() {
  const rl = createInterface({ input: process.stdin });
  let buf = "";
  for await (const line of rl) {
    buf += line + "\n";
    try {
      return JSON.parse(buf);
    } catch {
      // keep reading
    }
  }
  throw new Error("stdin closed before valid JSON was received");
}

async function networkPair(db, { peerUrl, peerName }) {
  const localId = getOrCreateLocalInstanceId();
  // Our outbound bearer (what we send to peer in Authorization: Bearer).
  // Peer stores its hash in crow_instances.auth_token_hash.
  const sourceOutboundBearer = generateSecret();
  // Shared symmetric HMAC key (same both directions for MVP).
  const sharedSigningKey = generateSecret();

  const reqBody = {
    source_instance_id: localId,
    source_name: process.env.HOSTNAME || "unknown",
    source_gateway_url: process.env.CROW_GATEWAY_URL || null,
    source_outbound_bearer: sourceOutboundBearer,
    shared_signing_key: sharedSigningKey,
    otc: process.env.CROW_ENROLL_OTC || undefined,
  };
  const url = String(peerUrl).replace(/\/+$/, "") + "/instance/enroll-request";
  console.log(`→ POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`enroll-request failed: HTTP ${res.status} — ${err}`);
  }
  const peerPayload = await res.json();
  if (!peerPayload?.peer_instance_id || !peerPayload?.peer_outbound_bearer) {
    throw new Error("peer response missing peer_instance_id or peer_outbound_bearer");
  }

  const peerId = peerPayload.peer_instance_id;
  await storePeerCredsLocally(db, {
    peerId,
    peerName: peerName || peerPayload.peer_name || peerId,
    peerGatewayUrl: peerPayload.peer_gateway_url || peerUrl,
    peerCrowId: peerPayload.peer_crow_id || peerId,
    // Creds for OUTBOUND calls us → peer:
    auth_token: sourceOutboundBearer,   // we generated; peer stored its hash
    signing_key: sharedSigningKey,      // both sides share
    // Hash of peer's outbound bearer (for us to validate inbound calls from peer):
    peerOutboundBearerHash: sha256Hex(peerPayload.peer_outbound_bearer),
  });

  console.log(`✓ Paired with peer ${peerId} (${peerName || peerPayload.peer_name || "unnamed"})`);
  console.log(`  Credentials stored: ${peerTokensPath()}`);
}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

async function manualPair(db, { peerId, peerName, peerUrl }) {
  if (!peerId || !peerName || !peerUrl) {
    throw new Error("--manual-paste requires --peer-id, --peer-name, --peer-url");
  }
  const localId = getOrCreateLocalInstanceId();
  const sourceOutboundBearer = generateSecret();
  const sharedSigningKey = generateSecret();

  console.log("=== Give these to the peer operator ===");
  console.log(JSON.stringify({
    source_instance_id: localId,
    source_name: process.env.HOSTNAME || "unknown",
    source_gateway_url: process.env.CROW_GATEWAY_URL || null,
    source_outbound_bearer: sourceOutboundBearer,
    shared_signing_key: sharedSigningKey,
  }, null, 2));
  console.log("=========================================\n");

  console.log("Paste the peer's JSON block here (must include peer_instance_id, peer_outbound_bearer) then ^D:");
  const peerPayload = await readJsonFromStdin();
  if (!peerPayload?.peer_outbound_bearer) {
    throw new Error("peer JSON missing peer_outbound_bearer");
  }

  await storePeerCredsLocally(db, {
    peerId: peerPayload.peer_instance_id || peerId,
    peerName,
    peerGatewayUrl: peerPayload.peer_gateway_url || peerUrl,
    peerCrowId: peerPayload.peer_crow_id || peerId,
    auth_token: sourceOutboundBearer,
    signing_key: sharedSigningKey,
    peerOutboundBearerHash: sha256Hex(peerPayload.peer_outbound_bearer),
  });

  console.log(`✓ Paired with peer ${peerId} (${peerName})`);
  console.log(`  Credentials stored: ${peerTokensPath()}`);
}

async function storePeerCredsLocally(db, {
  peerId,
  peerName,
  peerGatewayUrl,
  peerCrowId,
  auth_token,
  signing_key,
  peerOutboundBearerHash,
}) {
  const existing = await getInstance(db, peerId);
  if (existing) {
    await updateInstance(db, peerId, {
      name: peerName,
      gateway_url: peerGatewayUrl,
      auth_token_hash: peerOutboundBearerHash,
      trusted: 1,
    });
  } else {
    await registerInstance(db, {
      id: peerId,
      name: peerName,
      crowId: peerCrowId,
      gatewayUrl: peerGatewayUrl,
      authTokenHash: peerOutboundBearerHash,
    });
    await updateInstance(db, peerId, { trusted: 1 });
  }

  setPeerCreds(peerId, { auth_token, signing_key });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const db = await createDbClient();
  try {
    if (args.manual) {
      await manualPair(db, args);
    } else if (args.peerUrl) {
      await networkPair(db, args);
    } else {
      printHelp();
      process.exit(1);
    }
  } finally {
    try { db.close?.(); } catch {}
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
