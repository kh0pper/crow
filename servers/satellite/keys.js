/**
 * The satellite's own files (SAT-3, spec §3.1, §6.3):
 *   $SAT_HOME/secrets/satellite-key.json  (dir 0700, file 0600)
 *       {version, satellite_id, ed25519_priv, ed25519_pub, created_at}, made on first boot
 *   $SAT_HOME/cert.json    (0600) the crow-signed cert {payload, sig}
 *   $SAT_HOME/pinned.json  (0600) {crow_id, root_pubkey, mgmt_pubkey, primary_url,
 *                                  primary_instance_id, target_sha}
 *   $SAT_HOME/cert.next.json (0600) a renewed/rotated cert while it is being committed
 *                                  (see servers/satellite/certs.js for the write order)
 * Writes are atomic (temp file + rename) through the gateway's writePrivateFile.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateKeypair, satelliteIdFromPub } from "../shared/satellite-protocol.js";
import { ensureSecretsDir } from "../shared/peer-credentials.js";
import { writePrivateFile } from "../gateway/bundle-env-secrets.js";

const HEX64 = /^[0-9a-f]{64}$/;

export const secretsPath = (satHome) => join(satHome, "secrets");
export const keyPath = (satHome) => join(secretsPath(satHome), "satellite-key.json");
export const certPath = (satHome) => join(satHome, "cert.json");
export const pinnedPath = (satHome) => join(satHome, "pinned.json");
export const stagedCertPath = (satHome) => join(satHome, "cert.next.json");

function validKey(rec) {
  return !!rec && rec.version === 1 && HEX64.test(rec.ed25519_priv ?? "") && HEX64.test(rec.ed25519_pub ?? "")
    && rec.satellite_id === satelliteIdFromPub(rec.ed25519_pub);
}

/** The stored key, or null when absent. Throws on a present but malformed file (never replaced). */
export function loadSatelliteKey(satHome) {
  const p = keyPath(satHome);
  if (!existsSync(p)) return null;
  const rec = JSON.parse(readFileSync(p, "utf8"));
  if (!validKey(rec)) throw new Error(`${p} is not a valid satellite key; refusing to replace it`);
  return rec;
}

/** Load the satellite key, making it on first boot. */
export function ensureSatelliteKey(satHome, { now = Date.now() } = {}) {
  ensureSecretsDir(secretsPath(satHome));
  const have = loadSatelliteKey(satHome);
  if (have) return have;
  const kp = generateKeypair();
  const rec = {
    version: 1, satellite_id: satelliteIdFromPub(kp.pubHex), ed25519_priv: kp.privHex, ed25519_pub: kp.pubHex,
    created_at: new Date(now).toISOString(),
  };
  writePrivateFile(keyPath(satHome), JSON.stringify(rec));
  return rec;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export const readCert = (satHome) => readJson(certPath(satHome));
export const readPinned = (satHome) => readJson(pinnedPath(satHome));
export const writeCert = (satHome, cert) => writePrivateFile(certPath(satHome), JSON.stringify(cert));
export const writePinned = (satHome, pinned) => writePrivateFile(pinnedPath(satHome), JSON.stringify(pinned));
export const readStagedCert = (satHome) => readJson(stagedCertPath(satHome));
export const writeStagedCert = (satHome, cert) => writePrivateFile(stagedCertPath(satHome), JSON.stringify(cert));
export const removeStagedCert = (satHome) => rmSync(stagedCertPath(satHome), { force: true });
/** Unpair: any staged cert first (so boot can never roll it forward), then the cert, then the pin. */
export function removePairingFiles(satHome) {
  removeStagedCert(satHome);
  rmSync(certPath(satHome), { force: true });
  rmSync(pinnedPath(satHome), { force: true });
}
