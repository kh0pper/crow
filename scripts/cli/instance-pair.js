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
 *   node scripts/cli/instance-pair.js --generate-otc            (on the PEER)
 *   node scripts/cli/instance-pair.js --peer-url https://peer.example.ts.net:8444 --otc <code>
 *   node scripts/cli/instance-pair.js --allow-re-pair <source-id>   (on the PEER, re-pair only)
 *   node scripts/cli/instance-pair.js --manual-paste
 *
 * With --peer-url, the peer's gateway must expose the /instance/enroll
 * endpoints (Phase 5-MVP wires these into routes/bundles.js sibling route
 * file servers/gateway/routes/instance-enroll.js).
 */

import { createDbClient, resolveDataDir } from "../../servers/db.js";
import { resolve as resolvePath } from "path";
import { createHash } from "crypto";
import {
  registerInstance,
  getInstance,
  updateInstance,
  getOrCreateLocalInstanceId,
  selfPairingAddress,
} from "../../servers/gateway/instance-registry.js";
import { pickPeerGatewayUrl, isTailnetAddress, rememberPeerSyncPort, forgetPeerHandshakeState } from "../../servers/shared/self-dial-address.js";
import {
  setPeerCreds,
  generateSecret,
  peerTokensPath,
} from "../../servers/shared/peer-credentials.js";
import {
  generateEnrollOtc, ENROLL_OTC_MIN_LENGTH, repairProof, repairProofKey, sha256Hex as guardSha256, writeRepairAllowance, REPAIR_ALLOW_DEFAULT_MINUTES, REPAIR_ALLOW_MAX_MINUTES,
} from "../../servers/shared/enroll-guard.js";
import { loadPeerCreds } from "../../servers/shared/peer-credentials.js";
import { createInterface } from "readline";
import { hostname as osHostname } from "os";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--peer-url") out.peerUrl = argv[++i];
    else if (a === "--peer-id") out.peerId = argv[++i];
    else if (a === "--peer-name") out.peerName = argv[++i];
    else if (a === "--manual-paste") out.manual = true;
    else if (a === "--otc") out.otc = argv[++i];
    else if (a === "--generate-otc") out.generateOtc = true;
    else if (a === "--allow-re-pair") out.allowRePair = argv[++i];
    else if (a === "--minutes") out.minutes = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Crow instance pair — provision cross-host RPC credentials.

Usage:
  node scripts/cli/instance-pair.js --generate-otc
  node scripts/cli/instance-pair.js --peer-url <url> --otc <code> [--peer-name <name>] [--peer-id <id>]
  node scripts/cli/instance-pair.js --allow-re-pair <instance-id> [--minutes <n>]
  node scripts/cli/instance-pair.js --manual-paste --peer-id <id> --peer-name <name> --peer-url <url>

Pairing ceremony (network mode):
  1. On the PEER: run --generate-otc, then set CROW_ENROLL_ENABLED=1 and
     CROW_ENROLL_OTC=<code> in the peer gateway's environment and restart it.
  2. On THIS instance: --peer-url <peer tailnet URL> --otc <code>
     (or export CROW_ENROLL_OTC=<code>). The code is single-use and expires
     CROW_ENROLL_WINDOW_MINUTES (default 30) after the peer gateway first saw it.
  3. On the PEER: remove CROW_ENROLL_ENABLED and CROW_ENROLL_OTC, restart.

  The peer refuses enrollment without a code of >= ${ENROLL_OTC_MIN_LENGTH} characters, locks a
  source after 5 wrong codes, and never accepts it over Tailscale Funnel.

Re-pairing an instance the peer already knows:
  A current CLI proves it still holds its credentials for the peer (without
  sending them), so re-pairing just works. If those credentials are lost, or
  the peer revoked this instance, the PEER's operator must first run
  --allow-re-pair <this instance's id> on the peer (single-use, default
  ${REPAIR_ALLOW_DEFAULT_MINUTES} min, max ${REPAIR_ALLOW_MAX_MINUTES}); otherwise the peer answers 409 already_paired.
  The proof is sent only for the peer whose stored address matches --peer-url
  (or the one named by --peer-id), is bound to that peer's id and this code,
  and never reveals the credentials.

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

function generateOtcCommand() {
  const code = generateEnrollOtc();
  console.log(`One-time pairing code (single-use):

  ${code}

On THIS host (the peer being paired with), add to the gateway's environment
(the repo .env, or a systemd drop-in) and restart the gateway:

  CROW_ENROLL_ENABLED=1
  CROW_ENROLL_OTC=${code}

On the OTHER instance, run:

  node scripts/cli/instance-pair.js --peer-url <this host's tailnet URL> --otc ${code}

The code expires CROW_ENROLL_WINDOW_MINUTES (default 30) after this gateway
first sees it. Remove both variables and restart once pairing completes.`);
}

async function allowRePairCommand(db, { allowRePair, minutes }) {
  const peerId = String(allowRePair || "").trim();
  if (!peerId) throw new Error("--allow-re-pair needs the instance id of the peer that will re-pair");
  const localId = getOrCreateLocalInstanceId();
  if (peerId === localId) throw new Error("that is this instance's own id");
  const row = await getInstance(db, peerId);
  const hasCreds = Boolean(loadPeerCreds()[peerId]);
  const dbPath = process.env.CROW_DB_PATH || resolvePath(resolveDataDir(), "crow.db");
  console.log(`  this instance: ${localId}  (DB ${dbPath})`);
  if (!row && !hasCreds) {
    throw new Error(`${peerId} is not known on this instance (${localId}) — a first pairing needs no allowance. If you meant another co-hosted instance, run with its CROW_HOME / CROW_DATA_DIR.`);
  }
  const { expiresAt, minutes: m } = await writeRepairAllowance(db, localId, peerId, { minutes });
  console.log(`✓ ${peerId}${row ? ` (${row.name}, status ${row.status})` : " (not known here yet)"} may re-pair with this gateway once,`);
  console.log(`  replacing its credentials and dial address, until ${new Date(expiresAt).toISOString()} (${m} min).`);
  console.log("  Enrollment must also be enabled with a one-time code (see --generate-otc).");
}

/**
 * Re-pair proof for the ONE peer this request is meant for: the peer named by
 * --peer-id, else the single known peer whose stored gateway_url host or
 * tailscale_ip equals the URL's host. Never a proof for any other peer. The
 * proof (servers/shared/enroll-guard.js) is bound to that peer's id and to
 * this code's digest, and keyed by hash(our current bearer) + our current
 * signing key, so it reveals neither and is useless anywhere else.
 */
async function buildRepairProofs(db, reqBody, { peerUrl, peerId, otc }) {
  const creds = loadPeerCreds();
  const usable = (id) => typeof creds[id]?.auth_token === "string" && creds[id].auth_token && typeof creds[id]?.signing_key === "string";
  let target = null;
  if (peerId) {
    target = usable(peerId) ? peerId : null;
  } else {
    let host = null;
    try { host = new URL(String(peerUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch {}
    const hits = [];
    for (const id of Object.keys(creds).filter(usable)) {
      const row = await getInstance(db, id).catch(() => null);
      if (!row || !host) continue;
      let rowHost = null;
      try { rowHost = new URL(String(row.gateway_url)).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch {}
      if (rowHost === host || String(row.tailscale_ip || "").toLowerCase() === host) hits.push(id);
    }
    if (hits.length === 1) target = hits[0];
  }
  if (!target) return [];
  const key = repairProofKey(guardSha256(creds[target].auth_token), creds[target].signing_key);
  return [repairProof(key, reqBody, { targetId: target, otcDigest: guardSha256(otc) })];
}

async function networkPair(db, { peerUrl, peerName, peerId: expectPeerId, otc: otcArg }) {
  const otc = otcArg || process.env.CROW_ENROLL_OTC || "";
  if (otc.length < ENROLL_OTC_MIN_LENGTH) {
    throw new Error(`a one-time code is required (>= ${ENROLL_OTC_MIN_LENGTH} chars): on the PEER run \`node scripts/cli/instance-pair.js --generate-otc\`, follow its instructions, then pass --otc <code> here`);
  }
  const localId = getOrCreateLocalInstanceId();
  // Our outbound bearer (what we send to peer in Authorization: Bearer).
  // Peer stores its hash in crow_instances.auth_token_hash.
  const sourceOutboundBearer = generateSecret();
  // Shared symmetric HMAC key (same both directions for MVP).
  const sharedSigningKey = generateSecret();
  // Our TAILNET dial address (never CROW_GATEWAY_URL — the public :443 door).
  const self = await selfPairingAddress(db);

  const reqBody = {
    source_instance_id: localId,
    // HOSTNAME is a bash variable, not exported to node — the old
    // `process.env.HOSTNAME || "unknown"` named every pair "unknown" (raven, 2026-09-24).
    source_name: process.env.HOSTNAME || osHostname() || "unknown",
    source_gateway_url: self.gateway_url,
    source_tailscale_ip: self.tailscale_ip,
    source_sync_port: self.sync_port,
    source_outbound_bearer: sourceOutboundBearer,
    shared_signing_key: sharedSigningKey,
    otc,
  };
  const proofs = await buildRepairProofs(db, reqBody, { peerUrl, peerId: expectPeerId, otc });
  if (proofs.length) reqBody.repair_proofs = proofs;
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
  if (expectPeerId && peerId !== expectPeerId) {
    console.warn(`⚠ peer answered as ${peerId}, not the --peer-id ${expectPeerId} you named; storing it as ${peerId}`);
  }
  await storePeerCredsLocally(db, {
    peerId,
    peerName: peerName || peerPayload.peer_name || peerId,
    peerGatewayUrl: pickPeerGatewayUrl(peerPayload.peer_gateway_url, peerUrl),
    peerTailscaleIp: peerPayload.peer_tailscale_ip,
    peerSyncPort: peerPayload.peer_sync_port,
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
  const self = await selfPairingAddress(db);

  console.log("=== Give these to the peer operator ===");
  console.log(JSON.stringify({
    source_instance_id: localId,
    // HOSTNAME is a bash variable, not exported to node — the old
    // `process.env.HOSTNAME || "unknown"` named every pair "unknown" (raven, 2026-09-24).
    source_name: process.env.HOSTNAME || osHostname() || "unknown",
    source_gateway_url: self.gateway_url,
    source_tailscale_ip: self.tailscale_ip,
    source_sync_port: self.sync_port,
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
    peerGatewayUrl: pickPeerGatewayUrl(peerPayload.peer_gateway_url, peerUrl),
    peerTailscaleIp: peerPayload.peer_tailscale_ip,
    peerSyncPort: peerPayload.peer_sync_port,
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
  peerTailscaleIp,
  peerSyncPort,
  peerCrowId,
  auth_token,
  signing_key,
  peerOutboundBearerHash,
}) {
  const tailscaleIp = typeof peerTailscaleIp === "string" && isTailnetAddress(peerTailscaleIp.trim()) ? peerTailscaleIp.trim() : null;
  const existing = await getInstance(db, peerId);
  if (existing) {
    await updateInstance(db, peerId, {
      name: peerName,
      gateway_url: peerGatewayUrl,
      ...(tailscaleIp ? { tailscale_ip: tailscaleIp } : {}),
      auth_token_hash: peerOutboundBearerHash,
      trusted: 1,
    });
  } else {
    await registerInstance(db, {
      id: peerId,
      name: peerName,
      crowId: peerCrowId,
      gatewayUrl: peerGatewayUrl,
      tailscaleIp,
      authTokenHash: peerOutboundBearerHash,
    });
    await updateInstance(db, peerId, { trusted: 1 });
  }
  await rememberPeerSyncPort(db, getOrCreateLocalInstanceId(), peerId, peerSyncPort);
  await forgetPeerHandshakeState(db, getOrCreateLocalInstanceId(), peerId);

  setPeerCreds(peerId, { auth_token, signing_key });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.generateOtc) return generateOtcCommand();

  const db = await createDbClient();
  try {
    if (args.allowRePair !== undefined) {
      await allowRePairCommand(db, args);
    } else if (args.manual) {
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
