/**
 * Satellite management keys (SAT-1, spec §3.1): one Ed25519 key per satellite, made by crow at
 * pairing, held only by crow. It signs every request crow sends to that satellite.
 *
 * File: <secretsDir()>/satellites/<satellite_id>.mgmt.json (dir 0700, file 0600),
 * `{version:1, satellite_id, ed25519_priv, ed25519_pub, created_at}`.
 */
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { secretsDir } from "../../shared/secret-values.js";
import { ensureSecretsDir } from "../../shared/peer-credentials.js";
import { writePrivateFile } from "../bundle-env-secrets.js";
import { generateKeypair, isSatelliteId } from "../../shared/satellite-protocol.js";

function checkId(satId) {
  if (!isSatelliteId(satId)) throw new TypeError("mgmt-keys: not a satellite id");
}

export function satellitesSecretsDir(env = process.env) {
  return join(secretsDir(env), "satellites");
}

export function mgmtKeyPath(satId, env = process.env) {
  checkId(satId);
  return join(satellitesSecretsDir(env), `${satId}.mgmt.json`);
}

/**
 * Make and store a new mgmt key. Refuses to replace an existing file unless `replace` is set
 * (the pairing flow sets it only after checking no live satellite row uses the old key); a
 * replaced key is shredded first.
 */
export function createMgmtKey(satId, { replace = false, env = process.env, now = Date.now() } = {}) {
  const path = mgmtKeyPath(satId, env);
  if (existsSync(path)) {
    if (!replace) throw new Error(`mgmt-keys: a key for ${satId} already exists`);
    shredMgmtKey(satId, { env });
  }
  ensureSecretsDir(secretsDir(env));
  ensureSecretsDir(satellitesSecretsDir(env));
  const kp = generateKeypair();
  const rec = { version: 1, satellite_id: satId, ed25519_priv: kp.privHex, ed25519_pub: kp.pubHex, created_at: new Date(now).toISOString() };
  writePrivateFile(path, JSON.stringify(rec));
  return rec;
}

/** The stored key, or null when there is none (or it is unreadable / malformed). */
export function loadMgmtKey(satId, { env = process.env } = {}) {
  const path = mgmtKeyPath(satId, env);
  let rec;
  try { rec = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (!rec || rec.version !== 1 || rec.satellite_id !== satId
    || !/^[0-9a-f]{64}$/.test(rec.ed25519_priv) || !/^[0-9a-f]{64}$/.test(rec.ed25519_pub)) return null;
  return rec;
}

/** Overwrite the file with random bytes, fsync, unlink. Missing is fine. */
export function shredMgmtKey(satId, { env = process.env } = {}) {
  const path = mgmtKeyPath(satId, env);
  let fd;
  try { fd = openSync(path, "r+"); } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  try {
    const size = Math.max(fstatSync(fd).size, 256);
    writeSync(fd, randomBytes(size), 0, size, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

// ── rotation (spec §3.2; the old key stays live until the satellite answers 200) ───────────────
//
// A rotation stages the new key in <id>.mgmt.next.json (same format and modes). The live
// <id>.mgmt.json is only replaced by promoteStagedMgmtKey, after the satellite has accepted the
// cert that names the new key; until then every request is still signed with the old key.

export function stagedMgmtKeyPath(satId, env = process.env) {
  checkId(satId);
  return join(satellitesSecretsDir(env), `${satId}.mgmt.next.json`);
}

function loadKeyFile(path, satId) {
  let rec;
  try { rec = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (!rec || rec.version !== 1 || rec.satellite_id !== satId
    || !/^[0-9a-f]{64}$/.test(rec.ed25519_priv) || !/^[0-9a-f]{64}$/.test(rec.ed25519_pub)) return null;
  return rec;
}

function shredPath(path) {
  let fd;
  try { fd = openSync(path, "r+"); } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  try {
    const size = Math.max(fstatSync(fd).size, 256);
    writeSync(fd, randomBytes(size), 0, size, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

/** A staged key for a rotation; an earlier staged key is shredded first (it was never promoted). */
export function createStagedMgmtKey(satId, { env = process.env, now = Date.now() } = {}) {
  const path = stagedMgmtKeyPath(satId, env);
  shredPath(path);
  ensureSecretsDir(secretsDir(env));
  ensureSecretsDir(satellitesSecretsDir(env));
  const kp = generateKeypair();
  const rec = { version: 1, satellite_id: satId, ed25519_priv: kp.privHex, ed25519_pub: kp.pubHex, created_at: new Date(now).toISOString() };
  writePrivateFile(path, JSON.stringify(rec));
  return rec;
}

export function loadStagedMgmtKey(satId, { env = process.env } = {}) {
  return loadKeyFile(stagedMgmtKeyPath(satId, env), satId);
}

/** The staged key becomes the live key (old live key shredded) when it is `expectedPub`. Returns the new key record. */
export function promoteStagedMgmtKey(satId, { env = process.env, expectedPub } = {}) {
  const staged = loadStagedMgmtKey(satId, { env });
  if (!staged) throw new Error(`mgmt-keys: no staged key for ${satId}`);
  // The caller names the key it sent in the cert: a staged file swapped meanwhile is never promoted.
  if (typeof expectedPub !== "string" || staged.ed25519_pub !== expectedPub) throw new Error(`mgmt-keys: staged key for ${satId} is not the expected one`);
  shredMgmtKey(satId, { env });
  writePrivateFile(mgmtKeyPath(satId, env), JSON.stringify(staged));
  shredPath(stagedMgmtKeyPath(satId, env));
  return staged;
}

export function discardStagedMgmtKey(satId, { env = process.env } = {}) {
  shredPath(stagedMgmtKeyPath(satId, env));
}
