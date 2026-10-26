/**
 * Collect the instance's secret values and (re)write the values file
 * (servers/shared/secret-values.js). Run by the bot engine at each pi spawn
 * (scripts/pi-bots/bridge.mjs PiRpc), so a secret added since the last spawn
 * is in the file before the next card can show it.
 *
 * Exact values always mask, so a source a bot can write would let a
 * prompt-injected bot plant a "secret" that hides part of its own approval
 * card (a flag, a domain). Only sources the sandbox hides from bots count:
 *
 *   source                                     bot can write it?   used
 *   keychain rows in crow.db (sealed with       no: the key is in   yes
 *     <CROW_HOME>/secrets/keychain.key)          the hidden dir; a
 *                                                forged row cannot
 *                                                be opened
 *   <CROW_HOME>/secrets/bundle-env/*.env        no: hidden dir       yes
 *     (retained generated bundle secrets)        (tmpfs, read-only)
 *   <CROW_HOME>/.env, checkout .env, env/*.env  yes                  no
 *   <CROW_HOME>/bundles/<id>/.env, manifests    yes                  no
 *   <CROW_HOME>/*-token, peer-tokens.json       yes                  no
 *   <data dir>/ntfy-push.json                   yes                  no
 *   crow.db providers.api_key                   yes (crow.db is      no
 *                                                writable)
 *   this process's own env (the operator's      no, not at runtime  in memory only
 *     unit env)                                                     (getSecretValues)
 *
 * The dropped sources' secrets still reach masking where it matters: the
 * gateway's own env carries its .env tokens in memory, and bundle generated
 * secrets are in the retained copies (and the keychain for keychain keys).
 * Defense in depth on top: a value shaped like a flag (leading "-") or a
 * domain (dot-separated labels) never counts, from any source.
 *
 * Not imported by anything that runs inside an MCP server process: only the
 * bot engine (which already opens crow.db with better-sqlite3) loads it.
 */
import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveCrowHome, resolveInstanceDataDir } from "./crow-home.js";
import { normalizeValues, primeSecretValues, safeShape, secretValuesPath, writeSecretValuesFile } from "./secret-values.js";
import { loadKeychainKey } from "../gateway/keychain/key.js";
import { readableSecretsSync } from "../gateway/keychain/store.js";

const MAX_SOURCE_BYTES = 256 * 1024;

function readSmall(path) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
}

/** KEY=value pairs of a .env text (quotes stripped, comments and `export ` skipped). */
export function parseEnvPairs(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = v;
  }
  return out;
}

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * What the installer mints (bundle-env-secrets.js): base64url secrets,
 * `base64:` Laravel keys, VAPID keys. The retained copy is filled from the
 * bundle's own .env at reinstall, which a bot can write, and also holds path
 * and compose-fallback keys: only a value of this shape counts, so a path, a
 * word or a planted flag/domain never does.
 */
const GENERATED_SHAPE = /^(?:[A-Za-z0-9_-]{32,256}={0,2}|base64:[A-Za-z0-9+/]{40,88}={0,2})$/;

/** Retained generated bundle secrets, in the hidden secrets dir. */
function retainedBundleSecrets(crowHome) {
  const out = [];
  const dir = join(crowHome, "secrets", "bundle-env");
  for (const f of listDir(dir)) {
    if (!f.isFile() || !f.name.endsWith(".env")) continue;
    const pairs = parseEnvPairs(readSmall(join(dir, f.name)));
    for (const [k, v] of Object.entries(pairs)) {
      if (!k.startsWith("CROW_") && typeof v === "string" && GENERATED_SHAPE.test(v.trim())) out.push(v.trim());
    }
  }
  return out;
}

function keychainSecrets({ dbPath, crowHome }) {
  if (!dbPath || !existsSync(dbPath)) return [];
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    return readableSecretsSync(db, loadKeychainKey({ crowHome }));
  } catch { return []; }
  finally { if (db) { try { db.close(); } catch { /* closed */ } } }
}

/**
 * The trusted sources above, normalized (6+ chars, one line, deduped, longest
 * first), minus flag- and domain-shaped values.
 * @param {object} [o]
 * @param {object} [o.env] the env to resolve paths from
 * @param {string|null} [o.dbPath] crow.db (default CROW_DB_PATH or <data>/crow.db); null skips the keychain
 */
export function collectSecretValues({ env = process.env, dbPath } = {}) {
  const crowHome = resolveCrowHome(env);
  const db = dbPath === undefined ? (env.CROW_DB_PATH || join(resolveInstanceDataDir(env), "crow.db")) : dbPath;
  return normalizeValues([...keychainSecrets({ dbPath: db, crowHome }), ...retainedBundleSecrets(crowHome)]).filter(safeShape);
}

/**
 * Collect the instance's values, hold them in this process's memory (its own
 * mask, file or no file) and, unless `write === false`, (re)write the values
 * file. Never throws.
 * @returns {{path: string, count: number, written: boolean}|null} null when nothing was written
 */
export function refreshSecretValuesFile(opts = {}) {
  const env = opts.env || process.env;
  const path = secretValuesPath(env);
  try {
    const values = collectSecretValues(opts);
    primeSecretValues(values);
    if (opts.write === false) return null;
    return writeSecretValuesFile(path, values);
  } catch (e) {
    if (typeof opts.log === "function") opts.log("secret values file not written: " + ((e && e.message) || e));
    return null;
  }
}
