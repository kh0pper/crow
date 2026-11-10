/**
 * The environment an add-on's stdio child starts with.
 *
 * It used to be the gateway's whole environment, which (once the gateway has
 * loaded the repo .env and its systemd credentials) carries the GitHub token,
 * the local MCP token, the MinIO root password and every other service key. Now
 * a child gets four things and nothing else:
 *
 *  1. a base allowlist — the same system basics, locale, proxy/CA and non-secret
 *     Crow path keys a bot's pi process gets (servers/shared/bot-env.js), plus
 *     the Crow instance keys below;
 *  2. a key from the gateway's environment ONLY when the add-on's entry in the
 *     REVIEWED, tracked registry declares it (`server.envKeys` or an
 *     `env_vars[].name`) and it is not one of the gateway's own secrets (deny
 *     list below);
 *  3. for the four bundles that read the app's own storage client, the env
 *     fallback that client needs (STORAGE_ENV_CONSUMERS, below);
 *  4. the add-on's own `env` from its mcp-addons.json entry, and its manifest's
 *     derived env (Render's AUTH_HEADER and friends).
 *
 * Why the registry and not the checkout's bundles/ folder: `getManifest` reads
 * whatever happens to be there, and a real host's checkout can hold an untracked
 * folder or a symlink with any manifest inside it. registry/add-ons.json is the
 * committed artifact `npm run build-registry` generates from git-tracked,
 * contract-valid, non-draft manifests, so "an entry in the registry" means
 * "reviewed and published". It also mirrors each manifest's envKeys/env_vars
 * byte for byte, so the passthrough reads them from there and never from the
 * installed copy (which the bundle's own container can write).
 *
 * This is hygiene, not a boundary: a child can still read the gateway's .env,
 * mcp-addons.json and secrets/ as files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBotBaseEnv, BOT_ENV_EXACT_KEYS, BOT_ENV_PREFIXES } from "../shared/bot-env.js";
import { APP_ROOT } from "./bundles-config.js";

/** The bundle id shape every installer path accepts (skills-catalog isValidBundleId). */
const isValidBundleId = (id) => typeof id === "string" && id.length <= 64 && /^[a-z0-9][a-z0-9-]*$/.test(id);

/** The Crow instance keys an add-on child always gets when the gateway has them (no secrets). */
export const ADDON_BASE_KEYS = Object.freeze([
  "CROW_APP_ROOT", "CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_GATEWAY_PORT", "PORT",
]);

/** The gateway's own secrets: never passed to an add-on from the gateway's environment, whatever its entry declares. */
export const ADDON_DENY_KEYS = Object.freeze([
  "CROW_LOCAL_MCP_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "PHONE_RUNNER_SECRET",
  "CROW_BROWSER_VNC_PASSWORD",
  "MINIO_ROOT_PASSWORD",
  "MINIO_ROOT_USER",
  // Object storage credentials (the env fallback of servers/storage/s3-client.js).
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  // Push and OAuth secrets of the gateway's own services.
  "VAPID_PRIVATE_KEY",
  "CROW_OAUTH_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "CLOUDFLARE_TUNNEL_TOKEN",
  "NTFY_AUTH_TOKEN",
  // Instance-admin and pairing tokens.
  "CROW_BACKUP_TOKEN",
  "CROW_SETUP_TOKEN",
  "CROW_ENROLL_OTC",
  // The peer credential store (every pair's bearer and signing key) and the
  // systemd credentials folder: no child learns where either lives.
  "CROW_PEER_TOKENS_PATH",
  "CREDENTIALS_DIRECTORY",
  // Shared HMAC secret for time-limited TURN credentials.
  "TURN_SECRET",
]);

/** Any key named like a database root password (e.g. WORKSPACE_DB_ROOT_PASSWORD). */
export const ADDON_DENY_KEY_RE = /_ROOT_PASSWORD$/;

/** True for a name the base allowlist always carries (an add-on may read it). */
export function isAddonBaseKey(name) {
  return ADDON_BASE_KEYS.includes(name)
    || BOT_ENV_EXACT_KEYS.includes(name)
    || BOT_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * True when `key` must not be handed to an add-on from the gateway's environment.
 *
 * The deny list has no owner exceptions: a key that is the gateway's own secret
 * is not an add-on's just because the add-on shares its name. An add-on that
 * really owns a credential receives it through its own mcp-addons.json `env`
 * (written at install from its manifest's `env_vars`), which the spawn merges
 * after the passthrough and which is not the gateway's environment.
 */
export function isDeniedAddonKey(key) {
  return ADDON_DENY_KEYS.includes(key) || ADDON_DENY_KEY_RE.test(key);
}

/**
 * The bundles whose server code appImports the app's storage client
 * (servers/storage/s3-client.js) and therefore reads its env fallback. A grep for
 * that import under bundles/*\/server/ gives: artifacts
 * (server/blob-store-minio.js), data-dashboard (server/server.js), studio
 * (server/index.js) and sunvox-studio (server/server.js). Panel code that
 * imports it (studio, podcast, meta-glasses) runs inside the gateway process and
 * is not a spawned child, so it is deliberately not listed.
 *
 * A frozen, code-held table. Giving each add-on scoped storage access instead
 * (a per-bundle credential for one prefix) is a later phase; until then these
 * four keep exactly the storage environment they read today.
 */
export const STORAGE_ENV_CONSUMERS = Object.freeze(["artifacts", "data-dashboard", "studio", "sunvox-studio"]);

/**
 * Exactly the env names servers/storage/s3-client.js reads in its env fallback
 * (envStorageConfig: S3_ENDPOINT family first, then the older MINIO_* family).
 * A consumer gets them from the gateway's environment even though several are
 * deny-listed, and no other add-on ever does.
 */
export const STORAGE_ENV_KEYS = Object.freeze([
  "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_USE_SSL", "S3_REGION",
  "MINIO_ENDPOINT", "MINIO_PORT", "MINIO_USE_SSL", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD",
]);

/** True when `id` is one of the four bundles that read the storage client's env fallback. */
export function isStorageEnvConsumer(id) {
  return STORAGE_ENV_CONSUMERS.includes(id);
}

/**
 * The storage env a consumer keeps (STORAGE_ENV_KEYS present in `base`), `{}` for
 * every other add-on. Values only: a key absent from the gateway's environment is
 * not invented here.
 */
export function storagePassthrough(id, base = process.env) {
  if (!isStorageEnvConsumer(id)) return {};
  const out = {};
  for (const key of STORAGE_ENV_KEYS) {
    if (typeof base?.[key] === "string") out[key] = base[key];
  }
  return out;
}

/**
 * The allowlisted base an add-on child starts from. Always the allowlist: the
 * bot env module's full-environment mode (CROW_BOT_ENV_PASSTHROUGH=1) is turned
 * off here, and CROW_BOT_ENV_ALLOW cannot widen it.
 */
export function addonBaseEnv(source = process.env) {
  const env = buildBotBaseEnv({ ...(source || {}), CROW_BOT_ENV_PASSTHROUGH: "" }, { extraAllow: "" });
  for (const key of ADDON_BASE_KEYS) {
    if (typeof source?.[key] === "string") env[key] = source[key];
  }
  return env;
}

/** The published registry (registry/add-ons.json), read once per process. */
const REGISTRY_PATH = join(APP_ROOT, "registry", "add-ons.json");
let _registryEntries = null;

function registryEntries() {
  if (_registryEntries) return _registryEntries;
  _registryEntries = new Map();
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")); } catch { return _registryEntries; }
  for (const entry of Array.isArray(parsed?.["add-ons"]) ? parsed["add-ons"] : []) {
    if (entry && typeof entry.id === "string") _registryEntries.set(entry.id, entry);
  }
  return _registryEntries;
}

/**
 * The id's entry in the tracked registry, or null. Not in the registry means not
 * published: an untracked folder, a draft, a symlink or a community listing gets
 * no passthrough.
 */
export function registryEntryFor(id) {
  if (!isValidBundleId(id)) return null;
  return registryEntries().get(id) ?? null;
}

/**
 * Every env name an add-on's registry entry declares for its own server: `server.envKeys`
 * and the `env_vars[].name`s that are meant to reach it. An env var with `propagate: false`
 * or a `generate` kind is the installer's (a token minted into the bundle's settings file,
 * a password kept in the keychain): the gateway never has it, and it is not a passthrough.
 */
export function declaredEnvKeys(manifest) {
  const keys = [];
  if (Array.isArray(manifest?.server?.envKeys)) keys.push(...manifest.server.envKeys);
  for (const v of Array.isArray(manifest?.env_vars) ? manifest.env_vars : []) {
    if (!v || typeof v.name !== "string") continue;
    if (v.propagate === false || v.generate) continue;
    keys.push(v.name);
  }
  return [...new Set(keys.filter((k) => typeof k === "string" && k))];
}

/**
 * The keys this add-on may take from the gateway's environment: declared in its
 * registry entry, present in `base`, and not one of the gateway's own secrets.
 * `{}` when the bundle has no registry entry.
 *
 * `base` should already have credential-applied names dropped (proxy.js does):
 * a key applied from systemd credentials is not the gateway's environment to give.
 */
export function declaredPassthrough(id, base = process.env, { registryFor = registryEntryFor } = {}) {
  // A plain bundle id only: an mcp-addons.json key like "../x" must never resolve to a
  // registry entry outside the repo's bundles.
  if (!isValidBundleId(id)) return {};
  const entry = registryFor(id);
  if (!entry || typeof entry !== "object") return {};
  // Only a first-party published bundle may pull from the gateway environment; a
  // community listing (even one vendored into the repo) gets the base and its own config env.
  if (entry.origin === "community") return {};
  const out = {};
  for (const key of declaredEnvKeys(entry)) {
    if (isDeniedAddonKey(key)) continue;
    if (typeof base?.[key] === "string") out[key] = base[key];
  }
  return out;
}