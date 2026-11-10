/**
 * The environment an add-on's stdio child starts with.
 *
 * It used to be the gateway's whole environment, which (once the gateway has
 * loaded the repo .env and its systemd credentials) carries the GitHub token,
 * the local MCP token, the MinIO root password and every other service key. Now
 * a child gets three things and nothing else:
 *
 *  1. a base allowlist — the same system basics, locale, proxy/CA and non-secret
 *     Crow path keys a bot's pi process gets (servers/shared/bot-env.js), plus
 *     the Crow instance keys below;
 *  2. a key from the gateway's environment ONLY when the add-on's REVIEWED repo
 *     manifest declares it (`server.envKeys` or an `env_vars[].name`) and it is
 *     not one of the gateway's own secrets (deny list below);
 *  3. the add-on's own `env` from its mcp-addons.json entry, and its manifest's
 *     derived env (Render's AUTH_HEADER and friends).
 *
 * The manifest read is deliberately the repo copy (bundles-config getManifest):
 * a bundle's own container can write the installed copy under CROW_HOME, so the
 * installed manifest must never widen what a child receives. An add-on with no
 * repo manifest (a community or private bundle) gets no passthrough at all.
 *
 * This is hygiene, not a boundary: a child can still read the gateway's .env,
 * mcp-addons.json and secrets/ as files.
 */
import { buildBotBaseEnv, BOT_ENV_EXACT_KEYS, BOT_ENV_PREFIXES } from "../shared/bot-env.js";
import { getManifest } from "./bundles-config.js";

/** The bundle id shape every installer path accepts (skills-catalog isValidBundleId). */
const isValidBundleId = (id) => typeof id === "string" && id.length <= 64 && /^[a-z0-9][a-z0-9-]*$/.test(id);

/** The Crow instance keys an add-on child always gets when the gateway has them (no secrets). */
export const ADDON_BASE_KEYS = Object.freeze([
  "CROW_APP_ROOT", "CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_GATEWAY_PORT", "PORT",
]);

/** The gateway's own secrets: never passed to an add-on, whatever its manifest declares. */
export const ADDON_DENY_KEYS = Object.freeze([
  "CROW_LOCAL_MCP_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "PHONE_RUNNER_SECRET",
  "CROW_BROWSER_VNC_PASSWORD",
  "MINIO_ROOT_PASSWORD",
  "MINIO_ROOT_USER",
]);

/** Any key named like a database root password (e.g. WORKSPACE_DB_ROOT_PASSWORD). */
export const ADDON_DENY_KEY_RE = /_ROOT_PASSWORD$/;

/**
 * A deny-listed key a bundle may still receive because the key is that bundle's
 * OWN service credential, not Crow's: minio's root user/password, the phone
 * runner's shared secret, the browser's old VNC password. Only the bundle's own
 * repo manifest has to declare it as well (a manifest naming someone else's
 * deny-listed key gets nothing).
 */
export const DENY_KEY_OWNER = Object.freeze({
  MINIO_ROOT_USER: "minio",
  MINIO_ROOT_PASSWORD: "minio",
  PHONE_RUNNER_SECRET: "phone",
  CROW_BROWSER_VNC_PASSWORD: "browser",
});

/** True for a name the base allowlist always carries (an add-on may read it). */
export function isAddonBaseKey(name) {
  return ADDON_BASE_KEYS.includes(name)
    || BOT_ENV_EXACT_KEYS.includes(name)
    || BOT_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/** True when `key` must not be handed to add-on `id` (deny-listed and not that bundle's own). */
export function isDeniedAddonKey(key, id = null) {
  const denied = ADDON_DENY_KEYS.includes(key) || ADDON_DENY_KEY_RE.test(key);
  if (!denied) return false;
  return DENY_KEY_OWNER[key] !== id;
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

/** Every env name an add-on's repo manifest declares (server.envKeys and env_vars[].name), unique. */
export function declaredEnvKeys(manifest) {
  const keys = [];
  if (Array.isArray(manifest?.server?.envKeys)) keys.push(...manifest.server.envKeys);
  for (const v of Array.isArray(manifest?.env_vars) ? manifest.env_vars : []) {
    if (v && typeof v.name === "string") keys.push(v.name);
  }
  return [...new Set(keys.filter((k) => typeof k === "string" && k))];
}

/**
 * The keys this add-on may take from the gateway's environment: declared in its
 * reviewed repo manifest, present in `base`, and not one of the gateway's own
 * secrets. `{ }` when the bundle has no repo manifest.
 */
export function declaredPassthrough(id, base = process.env, { manifestFor = getManifest } = {}) {
  // A plain bundle id only: an mcp-addons.json key like "../x" must never resolve to a
  // manifest outside the repo's bundles folder.
  if (!isValidBundleId(id)) return {};
  const manifest = manifestFor(id);
  if (!manifest || typeof manifest !== "object") return {};
  // Only a first-party repo bundle may pull from the gateway environment; a community
  // manifest (even one vendored into the repo) gets the base and its own config env.
  if (manifest.origin === "community") return {};
  const out = {};
  for (const key of declaredEnvKeys(manifest)) {
    if (isDeniedAddonKey(key, id)) continue;
    if (typeof base?.[key] === "string") out[key] = base[key];
  }
  return out;
}