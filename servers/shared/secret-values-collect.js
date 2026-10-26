/**
 * Collect the instance's secret values from every source and (re)write the
 * values file (servers/shared/secret-values.js). Run by the bot engine at each
 * pi spawn (scripts/pi-bots/bridge.mjs PiRpc), so a secret added since the
 * last spawn is in the file before the next card can show it.
 *
 * Sources, each best-effort (a missing or unreadable source is skipped):
 *   - this process's env, <CROW_HOME>/.env, the checkout .env (or
 *     CROW_APP_ENV_PATH), <CROW_HOME>/env/*.env: secret-NAMED keys
 *     (isSecretEnvName) with a plausible value
 *   - bundles: <CROW_HOME>/bundles/<id>/.env — every key its manifest marks
 *     `secret: true` or `generate`, plus secret-named keys; the retained
 *     generated copies in <CROW_HOME>/secrets/bundle-env/*.env (all keys)
 *   - token files: <CROW_HOME>/*-token, peer-tokens.json (auth_token,
 *     signing_key), <data dir>/ntfy-push.json (token/password fields)
 *   - crow.db, read-only with the core better-sqlite3 build: every readable
 *     keychain entry (manual entries are where an operator keeps a sudo
 *     password) and providers.api_key
 *
 * Not imported by anything that runs inside an MCP server process: only the
 * bot engine (which already opens crow.db with better-sqlite3) loads it.
 */
import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCrowHome, resolveInstanceDataDir } from "./crow-home.js";
import {
  isSecretEnvName, normalizeValues, plausibleSecretValue, secretValuesFromEnv, secretValuesPath, writeSecretValuesFile,
} from "./secret-values.js";
import { loadKeychainKey } from "../gateway/keychain/key.js";
import { readableSecretsSync } from "../gateway/keychain/store.js";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

function envFileSecrets(path) {
  const t = readSmall(path);
  return t == null ? [] : secretValuesFromEnv(parseEnvPairs(t));
}

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function bundleSecrets(crowHome) {
  const out = [];
  for (const d of listDir(join(crowHome, "bundles"))) {
    if (!d.isDirectory()) continue;
    const dir = join(crowHome, "bundles", d.name);
    const envText = readSmall(join(dir, ".env"));
    if (envText == null) continue;
    const pairs = parseEnvPairs(envText);
    let marked = new Set();
    try {
      const manifest = JSON.parse(readSmall(join(dir, "manifest.json")) || "{}");
      marked = new Set((manifest.env_vars || []).filter((v) => v && typeof v.name === "string" && (v.secret === true || v.generate)).map((v) => v.name));
    } catch { /* no manifest: names only */ }
    for (const [k, v] of Object.entries(pairs)) {
      if (marked.has(k) ? typeof v === "string" && v.trim().length >= 6 : isSecretEnvName(k) && plausibleSecretValue(v)) out.push(v.trim());
    }
  }
  for (const f of listDir(join(crowHome, "secrets", "bundle-env"))) {
    if (!f.isFile() || !f.name.endsWith(".env")) continue;
    const pairs = parseEnvPairs(readSmall(join(crowHome, "secrets", "bundle-env", f.name)));
    for (const [k, v] of Object.entries(pairs)) if (!k.startsWith("CROW_") && typeof v === "string") out.push(v.trim());
  }
  return out;
}

function tokenFileSecrets(crowHome, dataDir) {
  const out = [];
  for (const f of listDir(crowHome)) {
    if (!f.isFile() || !/-token$/.test(f.name)) continue;
    const t = readSmall(join(crowHome, f.name));
    if (t != null) out.push(t.trim());
  }
  const walk = (node, depth, pick) => {
    if (depth > 4 || !node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && pick(k)) out.push(v);
      else if (v && typeof v === "object") walk(v, depth + 1, pick);
    }
  };
  for (const [path, pick] of [
    [join(crowHome, "peer-tokens.json"), (k) => /^(auth_token|signing_key|token)$/i.test(k)],
    [join(dataDir, "ntfy-push.json"), (k) => /token|password|secret/i.test(k)],
  ]) {
    try { walk(JSON.parse(readSmall(path) || "null"), 0, pick); } catch { /* skip */ }
  }
  return out;
}

function dbSecrets({ dbPath, crowHome }) {
  if (!dbPath || !existsSync(dbPath)) return [];
  let db;
  const out = [];
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    out.push(...readableSecretsSync(db, loadKeychainKey({ crowHome })));
    try {
      for (const r of db.prepare("SELECT api_key FROM providers WHERE api_key IS NOT NULL AND api_key != ''").all()) {
        if (plausibleSecretValue(r.api_key)) out.push(String(r.api_key).trim());
      }
    } catch { /* no providers table */ }
  } catch { /* unreadable DB: env and file sources still count */ }
  finally { if (db) { try { db.close(); } catch { /* closed */ } } }
  return out;
}

/**
 * Every source above, normalized (6+ chars, one line, deduped, longest first).
 * @param {object} [o]
 * @param {object} [o.env] the env to resolve paths from and to scan
 * @param {string} [o.appRoot] the checkout whose .env counts
 * @param {string|null} [o.dbPath] crow.db (default CROW_DB_PATH or <data>/crow.db); null skips the DB
 */
export function collectSecretValues({ env = process.env, appRoot = env.CROW_APP_ROOT || APP_ROOT, dbPath } = {}) {
  const crowHome = resolveCrowHome(env);
  const dataDir = resolveInstanceDataDir(env);
  const db = dbPath === undefined ? (env.CROW_DB_PATH || join(dataDir, "crow.db")) : dbPath;
  const vals = [...secretValuesFromEnv(env)];
  const envFiles = new Set([join(crowHome, ".env"), env.CROW_APP_ENV_PATH || join(appRoot, ".env")]);
  for (const f of listDir(join(crowHome, "env"))) if (f.isFile() && f.name.endsWith(".env")) envFiles.add(join(crowHome, "env", f.name));
  for (const p of envFiles) vals.push(...envFileSecrets(p));
  vals.push(...bundleSecrets(crowHome));
  vals.push(...tokenFileSecrets(crowHome, dataDir));
  vals.push(...dbSecrets({ dbPath: db, crowHome }));
  return normalizeValues(vals);
}

/**
 * Collect and (re)write the instance's values file. Never throws.
 * @returns {{path: string, count: number, written: boolean}|null} null when it could not be written
 */
export function refreshSecretValuesFile(opts = {}) {
  const env = opts.env || process.env;
  const path = secretValuesPath(env);
  try {
    return writeSecretValuesFile(path, collectSecretValues(opts));
  } catch (e) {
    if (typeof opts.log === "function") opts.log("secret values file not written: " + ((e && e.message) || e));
    return null;
  }
}
