/**
 * The environment a walled add-on starts with, built by the wall itself.
 *
 * Defence in depth on top of the callers' own env hygiene: whatever env a spawn
 * site passes in, the wall never spreads it. The child gets exactly
 *   1. the allowlisted keys of the gateway's env (`WALL_BASE_ENV_ALLOW`),
 *   2. the keys the add-on's REVIEWED repo manifest declares (repo source only;
 *      a local or third-party manifest declares nothing here), minus the
 *      gateway secrets in `WALL_ENV_DENY`, read from the gateway's env,
 *   3. the add-on's own env (its mcp-addons.json `env`, a service connection's
 *      values, a built-in's own vars, the derived keys), which wins.
 * Keys in `WALL_ENV_DENY` are never taken from the gateway's env, whatever a
 * manifest declares. A key the add-on's own env sets is the owner's value.
 *
 * TODO(Phase 0): when lane B's env hygiene PR is on main, replace
 * `WALL_BASE_ENV_ALLOW` with `ADDON_ENV_ALLOW` imported from
 * `servers/gateway/addon-env.js`, so the wall and the callers share one list.
 */

/** The gateway env keys every add-on may see (backendEnv-style base + Crow's paths). */
export const WALL_BASE_ENV_ALLOW = Object.freeze([
  "PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
  "NODE_ENV", "NODE_EXTRA_CA_CERTS",
  "CROW_APP_ROOT", "CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_GATEWAY_PORT", "PORT",
]);

/** Gateway secrets that never come from the gateway env into a wall, even when declared. */
export const WALL_ENV_DENY = Object.freeze([
  "CROW_LOCAL_MCP_TOKEN", "MINIO_ROOT_PASSWORD", "MINIO_ROOT_USER", "PHONE_RUNNER_SECRET",
  "CROW_BROWSER_VNC_PASSWORD", "CROW_DASHBOARD_PASSWORD", "CROW_SESSION_SECRET",
]);

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The env names a manifest declares: `server.envKeys` and `env_vars[].name`.
 * Only a repo-sourced manifest declares anything (its policy is reviewed).
 */
export function declaredEnvKeys(manifest, source) {
  if (source !== "repo" || !manifest || typeof manifest !== "object") return [];
  const out = new Set();
  const keys = manifest.server && Array.isArray(manifest.server.envKeys) ? manifest.server.envKeys : [];
  for (const k of keys) if (typeof k === "string" && ENV_NAME_RE.test(k)) out.add(k);
  for (const v of Array.isArray(manifest.env_vars) ? manifest.env_vars : []) {
    if (v && typeof v.name === "string" && ENV_NAME_RE.test(v.name)) out.add(v.name);
  }
  return [...out].sort();
}

/**
 * Build the child env.
 * @param {object} o
 * @param {object} [o.baseEnv]       the gateway's env (only read through the lists)
 * @param {object} [o.ownEnv]        the add-on's own env, used as given
 * @param {string[]} [o.declaredKeys] from `declaredEnvKeys`
 * @returns {object}
 */
export function wallChildEnv({ baseEnv = {}, ownEnv = {}, declaredKeys = [] } = {}) {
  const base = baseEnv && typeof baseEnv === "object" ? baseEnv : {};
  const own = ownEnv && typeof ownEnv === "object" ? ownEnv : {};
  const deny = new Set(WALL_ENV_DENY);
  const env = {};
  for (const k of WALL_BASE_ENV_ALLOW) {
    if (typeof base[k] === "string") env[k] = base[k];
  }
  for (const k of Array.isArray(declaredKeys) ? declaredKeys : []) {
    if (typeof k !== "string" || !ENV_NAME_RE.test(k) || deny.has(k)) continue;
    if (typeof base[k] === "string") env[k] = base[k];
  }
  for (const [k, v] of Object.entries(own)) {
    if (ENV_NAME_RE.test(k) && typeof v === "string") env[k] = v;
  }
  return env;
}
