#!/usr/bin/env node
/**
 * crow-satellite CLI (SAT-3, spec §4.1 step 6, §3.3):
 *   pair-code   void every live code and print a fresh one (console only). Writes satellite.db
 *               directly, so it works while the agent runs. Refused while paired.
 *   status      paired / not paired, satellite id, crow id, cert expiry.
 *   self-check  load the agent's whole module graph and exit 0 (update.js runs it in the NEW tree
 *               after a fast-forward, before restarting into it).
 *   migrate     apply satellite.db's pending SAT_SCHEMA_VERSION migrations (update.js, new tree).
 * SAT_HOME = CROW_HOME (default ~/.crow-satellite).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatFingerprint } from "../shared/satellite-protocol.js";
import { resolveSatHome } from "./agent.js";
import { currentVersion, openSatelliteDb } from "./db.js";
import { loadSatelliteKey, readCert, readPinned } from "./keys.js";
import { certIsLive, issuePairCode, pairCodeLines } from "./pairing.js";

process.umask(0o077);
const satHome = resolveSatHome(process.env);
const cmd = process.argv[2];

function needKey() {
  const key = loadSatelliteKey(satHome);
  if (!key) {
    console.error(`no satellite key in ${satHome}; start the agent once first`);
    process.exit(1);
  }
  return key;
}

if (cmd === "status") {
  const key = needKey();
  const cert = readCert(satHome);
  const pinned = readPinned(satHome);
  const paired = certIsLive(cert, pinned, key.ed25519_pub);
  console.log(paired ? "paired" : "not paired");
  console.log(`satellite id: ${formatFingerprint(key.satellite_id)}`);
  if (pinned?.crow_id) console.log(`crow id: ${pinned.crow_id}`);
  if (cert?.payload?.expires_at) console.log(`cert expires ${cert.payload.expires_at}`);
} else if (cmd === "pair-code") {
  const key = needKey();
  if (certIsLive(readCert(satHome), readPinned(satHome), key.ed25519_pub)) {
    console.error("already paired; unpair from crow (or run the installer with --repair) before making a pairing code");
    process.exit(1);
  }
  if (!existsSync(join(satHome, "satellite.db"))) {
    console.error(`no satellite.db in ${satHome}; start the agent once first`);
    process.exit(1);
  }
  const db = openSatelliteDb(satHome);
  try {
    for (const line of pairCodeLines(issuePairCode(db), key.satellite_id)) console.log(line);
  } finally {
    db.close();
  }
} else if (cmd === "self-check") {
  await import("./agent.js"); // its graph covers bundles.js, mcp-host.js, update.js and the rest
  console.log("ok");
} else if (cmd === "migrate") {
  const db = openSatelliteDb(satHome);
  try {
    console.log(`satellite.db at schema ${currentVersion(db)}`);
  } finally {
    db.close();
  }
} else {
  console.error("usage: cli.js pair-code | status | self-check | migrate");
  process.exit(2);
}
