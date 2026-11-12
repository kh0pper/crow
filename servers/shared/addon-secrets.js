/**
 * Add-on secrets and the keychain — the shared vocabulary, and the one place a process
 * turns an mcp-addons entry's `keychainEnv` names into a child's env.
 *
 * Shape: an add-on's secret settings live ONLY in the keychain (crow_keychain rows
 * kind ADDON_KEY_KIND, bundle_id = the entry id, env_key = the env name). mcp-addons.json
 * keeps the non-secret settings in `env` plus the NAMES of the secret ones in a sorted
 * array `keychainEnv`:
 *
 *   "home-assistant": {
 *     "command": "node", "args": ["server/index.js"],
 *     "env": { "HA_URL": "http://ha.local:8123" }, "keychainEnv": ["HA_TOKEN"]
 *   }
 *
 * A listed name is authoritative at spawn: a plain `env` value for it is ignored (one log
 * line, name only), and a value that cannot be produced from the keychain stops the add-on
 * instead of starting it with a partial env (readAddonSecretsSync / hydrateAddonEntry).
 * An entry without the field behaves exactly as it always has.
 *
 * This module is deliberately free of DB-path resolution (servers/db.js, routes/bundles.js)
 * so a child, a CLI or the wall profile can import it without dragging the gateway in; the
 * one database handle it opens is a READ-ONLY better-sqlite3 handle, required lazily, and
 * only when names were actually listed.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { isDefaultCrowHome, resolveInstanceDataDir, sameDbLocation } from "./crow-home.js";
import { isLoaderEnvName, withoutLoaderEnv } from "./loader-env.js";
import { isSecretEnvName } from "./secret-values.js";
import { extensionSecretsSync, KeychainKeyMissingError, KeychainRowsMissingError } from "../gateway/keychain/store.js";
import { KeychainKeyInvalidError, loadKeychainKey } from "../gateway/keychain/key.js";

/** The field beside `env` that lists the env names whose values live in the keychain. */
export const ADDON_KEYCHAIN_FIELD = "keychainEnv";
/** The crow_keychain `kind` an add-on's secret row has (one row per bundle id + env name). */
export const ADDON_KEY_KIND = "extension";
/** Which copy wins when the boot migration finds both a keychain row and a plain value. */
export const MIGRATION_ROW_CONFLICT = "file";

/**
 * Add-ons that read another add-on's settings (R6, spec §"shared secrets"): for each
 * add-on id, `{ sourceId: [names] }`. The source must be installed; the names are read
 * through its own entry (so its own keychain rows), never copied into the requesting
 * add-on's entry. Frozen: the operator switch is a code change, never a runtime toggle.
 */
export const ADDON_SECRET_SHARES = Object.freeze({
  "sunvox-studio": Object.freeze({
    funkwhale: Object.freeze(["FUNKWHALE_URL", "FUNKWHALE_ACCESS_TOKEN"]),
  }),
});

/** The fixed sentence every caller shows when an add-on's keys cannot be read (never a value). */
export const ADDON_KEYS_UNREADABLE =
  "its saved keys could not be read from the keychain; open Extensions and enter them again";

/** The processes allowed to unseal an add-on's secrets (the caller opts in; see below). */
export const UNSEALER_ROLES = Object.freeze(new Set(["gateway", "satellite", "bot-engine", "operator-cli"]));
const UNREADABLE_CODES = new Set(["KEY_MISSING", "ROWS_MISSING", "DB_UNREADABLE", "CHILD_CONTEXT"]);

/**
 * An add-on's listed secrets could not be produced. The message is the fixed sentence
 * above — never a value, a fragment of one, or the underlying driver error; `code` says
 * which layer failed and `names` are the env NAMES that were wanted.
 */
export class AddonKeysUnavailableError extends Error {
  constructor(code, bundleId, names = []) {
    if (!UNREADABLE_CODES.has(code)) throw new Error(`addon-secrets: unknown code ${JSON.stringify(String(code))}`);
    super(ADDON_KEYS_UNREADABLE);
    this.name = "AddonKeysUnavailableError";
    this.code = code;
    this.bundleId = typeof bundleId === "string" ? bundleId : null;
    this.names = (Array.isArray(names) ? names : []).filter((n) => typeof n === "string");
  }
}

/**
 * Did a save fail because the keychain would not take (or prove) this add-on's keys?
 *
 * The writers answer these with one fixed sentence of their own ("could not confirm the new
 * key was saved" in Configure, "Crow could not open its keychain" on an API-key card) instead
 * of a driver error — and never with a value. The two extra codes come from keychain/key.js
 * (KEYCHAIN_KEY_INVALID: a damaged key file while rows exist) and
 * gateway/addon-secrets-seal.js (KEYCHAIN_KEY_MISSING_ROWS: the key file is gone while
 * rows depend on it). They are matched by code because a module that must stay free of
 * the database (bundle-apikey-save.js is imported by the manifest contract) cannot
 * import the seal to reach its class.
 */
export function isAddonKeychainSaveFailure(err) {
  if (err instanceof AddonKeysUnavailableError) return true;
  const code = err && typeof err === "object" ? err.code : null;
  return code === "KEYCHAIN_KEY_INVALID" || code === "KEYCHAIN_KEY_MISSING_ROWS";
}

// ─── the role this process registered, if any (0.5: a caller opts in) ────────

let registeredUnsealer = null;

/**
 * Register THIS process as one of the allowed unsealers, once, in the gateway's entry
 * point or the satellite agent's. A module shared with an add-on child calls
 * processUnsealer() instead: the child never registers, gets null, and falls back to its
 * own env — it can never unseal its siblings' secrets.
 */
export function registerAddonUnsealer(role) {
  if (!UNSEALER_ROLES.has(role)) throw new Error(`addon-secrets: ${JSON.stringify(String(role))} is not an unsealer role`);
  if (registeredUnsealer !== null && registeredUnsealer !== role) {
    throw new Error(`addon-secrets: this process already registered as the ${registeredUnsealer} unsealer`);
  }
  registeredUnsealer = role;
  return role;
}

/** The role this process registered (null in a child / an unregistered CLI). */
export function processUnsealer() {
  return registeredUnsealer;
}

// ─── what counts as a secret (0.2) ───────────────────────────────────────────

/** Manifest `generate` kinds whose value is a credential. */
const SECRET_GENERATE_KINDS = new Set(["secret", "laravel_key", "vapid_private_key", "hex32"]);
/** The `generate` kinds the test list treats as NOT secret (a public half, an id). */
const PUBLIC_GENERATE_KINDS = new Set(["vapid_public_key", "garage_key_id"]);
/** Public halves: a name rule cannot override this (MASTODON_VAPID_PUBLIC_KEY is public). */
const PUBLIC_KEY_NAME_RE = /_PUBLIC_KEY$/;
/** Suffixes whose value is a location, read by the wall/child as a location (0.2 rule 4). */
const LOCATION_SUFFIX_RE = /_(?:FILE|PATH|DIR|URL|BASE_URL|HOST|PORT)$/;

/**
 * Is this env name, in this manifest field, a secret worth keeping in the keychain?
 *
 *   1. a `store_as` field → no: the entry never holds that plaintext (its keychain row
 *      holds the PLAINTEXT token, so sealing a hash would overwrite the real secret);
 *   2. an explicit `secret: true` → yes;
 *   3. a credential-shaped `generate` kind → yes; a public one → no;
 *   4. a name that reads like a credential (secret-values.js isSecretEnvName) AND is not a
 *      location/mount suffix, and not a public half;
 *   5. a loader name (NODE_OPTIONS, LD_PRELOAD) → never, whatever the manifest says.
 *
 * `spec` is the manifest's `env_vars` entry (null when the manifest does not declare it).
 */
export function isAddonSecretKey(name, spec = null) {
  if (typeof name !== "string" || name === "") return false;
  if (isLoaderEnvName(name)) return false;
  if (spec) {
    if (spec.store_as) return false;
    if (spec.secret === true) return true;
    const generate = typeof spec.generate === "string" ? spec.generate : "";
    if (SECRET_GENERATE_KINDS.has(generate)) return true;
    if (PUBLIC_GENERATE_KINDS.has(generate)) return false;
  }
  if (PUBLIC_KEY_NAME_RE.test(name.toUpperCase())) return false;
  if (LOCATION_SUFFIX_RE.test(name.toUpperCase())) return false;
  return isSecretEnvName(name);
}

const nonEmptyString = (v) => typeof v === "string" && v !== "";
const sameValue = (a, b) => String(a) === String(b);

/**
 * Split one save's env into the values a writer may seal and the ones it must keep plain.
 *
 * Per 0.2 a value is sealed only when it is a non-empty string, it is not equal to the
 * field's manifest `default`, and the field is not `keychain_configure: false` (the setup
 * applied route saves that one once; Configure must not overwrite the stored copy).
 * `listed` is the entry's CURRENT keychainEnv: those names are authoritative (0.3), so a
 * non-empty value for one is sealed even when the classifier would keep it plain. Loader
 * names and empty/non-string values are never sealed.
 *
 * @returns {{ seal: Record<string, string>, keep: Record<string, unknown> }}
 */
export function sealableEnv(env, manifest = null, { listed = [] } = {}) {
  const specs = new Map();
  for (const v of (manifest && Array.isArray(manifest.env_vars) ? manifest.env_vars : [])) {
    if (v && typeof v.name === "string" && !specs.has(v.name)) specs.set(v.name, v);
  }
  const always = new Set((Array.isArray(listed) ? listed : []).filter((n) => typeof n === "string"));
  const seal = {};
  const keep = {};
  const source = env && typeof env === "object" ? env : {};
  for (const [name, value] of Object.entries(source)) {
    const spec = specs.get(name) || null;
    if (isLoaderEnvName(name) || !nonEmptyString(value)) { keep[name] = value; continue; }
    if (always.has(name)) { seal[name] = value; continue; }
    if (!isAddonSecretKey(name, spec)) { keep[name] = value; continue; }
    if (spec && spec.default !== undefined && spec.default !== null && sameValue(value, spec.default)) { keep[name] = value; continue; }
    if (spec && spec.keychain_configure === false) { keep[name] = value; continue; }
    seal[name] = value;
  }
  return { seal, keep };
}

// ─── the sealing switch (0.3 / 0.10) ────────────────────────────────────────

/**
 * May this process seal add-on secrets into the keychain at all?
 *
 *   - `CROW_ADDON_SECRETS_KEYCHAIN=0` turns it off (the operator opt-out);
 *   - a split-DB host (the host-default CROW_HOME shared by two gateways with different
 *     CROW_DB_PATH) is OFF: the two gateways would keep keychain rows in different DBs
 *     while both spawn from the same entry, so neither could prove the other's rows;
 *   - PR1 ships the machinery with sealing OFF: nothing turns it on until
 *     `CROW_ADDON_SECRETS_KEYCHAIN=1`. (PR2 deletes this line and turns it on by default.)
 *
 * Readers never consult this: an entry that already lists names is hydrated either way.
 */
export function addonSecretsSealingOn(env = process.env) {
  const e = env || {};
  if (e.CROW_ADDON_SECRETS_KEYCHAIN === "0") return false;
  if (isDefaultCrowHome(e) && e.CROW_DB_PATH && !sameDbLocation(resolve(e.CROW_DB_PATH), resolveInstanceDataDir(e))) return false;
  if (e.CROW_ADDON_SECRETS_KEYCHAIN !== "1") return false; // PR1 only (Task 2.4 removes this line)
  return true;
}

// ─── reading the field (0.1) ────────────────────────────────────────────────

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_KEYCHAIN_ENV_NAMES = 64;

/**
 * The usable names in an entry's `keychainEnv`: strings shaped like env names, never a
 * loader name, deduped, at most 64. Anything else is dropped with one log line that
 * carries only names (a malformed entry could hold a value in that array, so a string
 * that is not name-shaped is reported as a count, never printed).
 */
export function keychainEnvNames(entry) {
  const raw = entry && Array.isArray(entry[ADDON_KEYCHAIN_FIELD]) ? entry[ADDON_KEYCHAIN_FIELD] : [];
  const out = [];
  const seen = new Set();
  const dropped = [];
  let droppedOther = 0;
  for (const name of raw) {
    if (typeof name !== "string" || !ENV_NAME_RE.test(name)) { droppedOther++; continue; }
    if (seen.has(name)) continue;
    if (isLoaderEnvName(name)) { seen.add(name); dropped.push(name); continue; }
    if (out.length >= MAX_KEYCHAIN_ENV_NAMES) { seen.add(name); dropped.push(name); continue; }
    seen.add(name);
    out.push(name);
  }
  if (dropped.length || droppedOther > 0) {
    const extra = droppedOther > 0 ? [`${droppedOther} non-name entr${droppedOther === 1 ? "y" : "ies"}`] : [];
    console.warn(`add-on entry: ignoring unusable ${ADDON_KEYCHAIN_FIELD} name(s): ${[...dropped, ...extra].join(", ")}`);
  }
  return out;
}

/**
 * The env names an entry would configure, WITHOUT unsealing anything: every non-empty
 * `env` value plus every listed keychain name. For predicates ("is this add-on
 * configured?") that must never read a secret.
 */
export function entryConfiguredNames(entry) {
  const names = new Set();
  const env = entry && entry.env && typeof entry.env === "object" ? entry.env : {};
  for (const [name, value] of Object.entries(env)) if (typeof value === "string" && value !== "") names.add(name);
  for (const name of keychainEnvNames(entry)) names.add(name);
  return [...names].sort();
}

// ─── unsealing (0.5 / 0.7) ─────────────────────────────────────────────────

let DatabaseCtor = null;
/** better-sqlite3, required only when a read actually opens a file (never at import). */
function betterSqlite3() {
  if (!DatabaseCtor) DatabaseCtor = createRequire(import.meta.url)("better-sqlite3");
  return DatabaseCtor;
}

function mapReadError(err, bundleId, names) {
  if (err instanceof AddonKeysUnavailableError) return err;
  if (err instanceof KeychainRowsMissingError) return new AddonKeysUnavailableError("ROWS_MISSING", bundleId, names);
  if (err instanceof KeychainKeyMissingError || err instanceof KeychainKeyInvalidError) return new AddonKeysUnavailableError("KEY_MISSING", bundleId, names);
  return new AddonKeysUnavailableError("DB_UNREADABLE", bundleId, names);
}

/**
 * The listed secrets of one add-on, SYNCHRONOUSLY: `{ NAME: plaintext }`, all names or a
 * throw. Only a process that registered an unsealer role (or passed one) may call this —
 * anything else, and any process with CROW_ADDON_HOST set (an add-on child's env), gets
 * CHILD_CONTEXT before a file is opened. A missing/invalid key is KEY_MISSING, an
 * unreadable DB (or a missing `dbPath`) is DB_UNREADABLE, and any name that has no
 * active row under THIS key, or whose row fails to open, is ROWS_MISSING.
 *
 * This is the ONLY way a plaintext add-on secret leaves the keychain, and its callers
 * pass it straight into a child's env: never into a file, a log, an audit row or a
 * notification.
 *
 * `dbPath`/`keyPath` come from gatewayKeychainPaths() (gateway) or the satellite's own
 * paths — this module resolves no paths itself. `rawDb`/`key` are for tests and for a
 * caller that already holds them; a caller-provided handle is never closed here.
 */
export function readAddonSecretsSync(bundleId, names, { unsealer, dbPath, keyPath, rawDb = null, key = null, env = process.env } = {}) {
  const wanted = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === "string" && n !== ""))];
  if (!UNSEALER_ROLES.has(unsealer) || (env && env.CROW_ADDON_HOST)) {
    throw new AddonKeysUnavailableError("CHILD_CONTEXT", bundleId, wanted);
  }
  if (wanted.length === 0) return {};
  let db = rawDb;
  let opened = false;
  try {
    if (!db) {
      if (typeof dbPath !== "string" || dbPath === "") throw new AddonKeysUnavailableError("DB_UNREADABLE", bundleId, wanted);
      const Database = betterSqlite3();
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      opened = true;
      db.pragma("busy_timeout = 2000");
    }
    // No `keyPath` and no `key` is KEY_MISSING, never "load the default ~/.crow key": this
    // module resolves no paths (see the header), and a reader that guessed a home could unseal
    // against an instance it was not given. Every real caller passes both paths.
    const k = key || (typeof keyPath === "string" && keyPath !== "" ? loadKeychainKey({ path: keyPath }) : null);
    if (!k) throw new AddonKeysUnavailableError("KEY_MISSING", bundleId, wanted);
    return extensionSecretsSync(db, k, bundleId, wanted, { kind: ADDON_KEY_KIND });
  } catch (err) {
    throw mapReadError(err, bundleId, wanted);
  } finally {
    if (opened && db) { try { db.close(); } catch { /* already closed */ } }
  }
}

// Once per process per (add-on, name): "the keychain value wins over this plain one".
const plainIgnored = new Set();

/**
 * An entry ready to spawn: its `keychainEnv` values unsealed into `env` and the listed
 * names' plain values dropped. With no names the SAME object comes back and nothing is
 * opened (today's behaviour, byte for byte).
 *
 * The result is for the spawning process only: NEVER write it back to mcp-addons.json
 * (that would put plaintext on disk) and NEVER hand it to the wall or an approval card as
 * `entry` (a secret must not travel where the entry travels).
 */
export function hydrateAddonEntry(bundleId, entry, opts = {}) {
  const listed = keychainEnvNames(entry);
  if (listed.length === 0) return entry;
  const secrets = readAddonSecretsSync(bundleId, listed, opts);
  const plain = entry && entry.env && typeof entry.env === "object" ? entry.env : {};
  const rest = { ...plain };
  for (const name of listed) {
    if (!Object.prototype.hasOwnProperty.call(rest, name)) continue;
    delete rest[name];
    const key = `${bundleId}\u0000${name}`;
    if (!plainIgnored.has(key)) {
      plainIgnored.add(key);
      console.warn(`add-on ${bundleId}: using the keychain value for ${name} (ignoring the plain one in mcp-addons.json)`);
    }
  }
  const out = { ...entry, env: { ...withoutLoaderEnv(rest), ...withoutLoaderEnv(secrets) } };
  delete out[ADDON_KEYCHAIN_FIELD];
  return out;
}

/**
 * Another add-on's shared settings (ADDON_SECRET_SHARES, R6): hydrate the SOURCE add-on's
 * entry through `readEntry` (which the caller owns) and return only the named values. Not
 * installed → {}; the source's own unreadable keys propagate (the caller must not start
 * the requesting add-on with half a share). `shares` is a test/service seam for the
 * switch, whose default is the frozen table.
 */
export function sharedAddonEnv(id, readEntry, opts = {}) {
  const shares = opts.shares || ADDON_SECRET_SHARES;
  const spec = shares && typeof shares === "object" ? shares[id] : null;
  if (!spec || typeof readEntry !== "function") return {};
  const out = {};
  for (const [sourceId, wanted] of Object.entries(spec)) {
    let entry = null;
    try { entry = readEntry(sourceId); } catch { entry = null; } // a broken source file is "not installed"
    if (!entry) continue;
    const hydrated = hydrateAddonEntry(sourceId, entry, opts);
    const env = hydrated && hydrated.env && typeof hydrated.env === "object" ? hydrated.env : {};
    for (const name of Array.isArray(wanted) ? wanted : []) {
      if (typeof env[name] === "string" && env[name] !== "") out[name] = env[name];
    }
  }
  return out;
}