/**
 * Loader/injection environment names — the env vars that make a loader or interpreter run
 * other code, or load other libraries, before the program itself starts (NODE_OPTIONS'
 * --require, PYTHONSTARTUP's file, LD_PRELOAD's library).
 *
 * One leaf module, three readers: the manifest contract (scripts/lib/bundle-contract.mjs)
 * refuses a manifest declaring one, routes/bundles.js (mcpAddonEntryFor) never copies one
 * into an mcp-addons entry, and anything that spawns a child can strip them with
 * withoutLoaderEnv(). Deliberately import-free: every caller may be a boot path or a CLI
 * script that must not drag in a dependency graph, and the gateway route imports it too.
 */

/** Exact names that are always a loader concern. */
export const LOADER_ENV_EXACT = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONUSERBASE",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
]);

/** Prefixes whose whole family is a loader concern (glibc / dyld). */
export const LOADER_ENV_PREFIXES = Object.freeze(["LD_", "DYLD_"]);

const LOADER_ENV_EXACT_SET = new Set(LOADER_ENV_EXACT);

/**
 * Is `name` a loader/injection env name? Case-insensitive (a manifest may write
 * `node_options`); no trimming, so a padded name is just a different, harmless name.
 */
export function isLoaderEnvName(name) {
  if (typeof name !== "string") return false;
  const upper = name.toUpperCase();
  if (LOADER_ENV_EXACT_SET.has(upper)) return true;
  return LOADER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * A NEW plain object with the loader names removed; every other own enumerable entry is
 * copied as-is. A null/undefined/non-object env yields {} — a caller handing a child an
 * env it cannot inspect gets no environment rather than an unstripped one.
 */
export function withoutLoaderEnv(env) {
  const out = {};
  if (env === null || typeof env !== "object") return out;
  for (const [key, value] of Object.entries(env)) {
    if (isLoaderEnvName(key)) continue;
    out[key] = value;
  }
  return out;
}