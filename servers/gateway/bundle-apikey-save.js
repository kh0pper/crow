/**
 * An API-key card's save: ONE typed, user-supplied third-party key for one declared
 * secret env var of an installed add-on.
 *
 * The card exists because a bundle whose secret is a key the operator creates somewhere
 * else (`env_vars[].explain` + `signup_url`, see dashboard/shared/api-key-card.js) is
 * still "needs setup" until that key arrives, and Configure is a wall of fields. The
 * route (POST /bundles/api/apikey-save) is owner-only and hands the REVIEWED manifest
 * (`bundles-config.getManifest`) in here, never the installed copy: the installed tree
 * can be written from inside the bundle's own container.
 *
 * What a save may set: only an env_vars entry that the reviewed manifest declares with
 * `secret: true` and no `generate`. A generated key is Crow's, and a non-secret one is
 * not a secret. On top of that, `isDeniedApiKeyEnvName` refuses the names that change
 * how a program runs rather than what it talks to (NODE_OPTIONS, LD_PRELOAD,
 * PYTHONPATH, the *_PROXY family, and the CROW_, COMPOSE_ and DOCKER_ prefixes): this
 * route writes into the environment of a child process and, for a docker bundle, into its
 * compose .env.
 *
 * The value never leaves this module except into the keychain, the add-on's
 * mcp-addons.json entry and the bundle's .env. No return value, error sentence, log
 * line or bell carries it: the refusals below are fixed sentences, and the one log line
 * names the bundle id and the env var.
 *
 * Write order, and why:
 *   1. the keychain, ALWAYS (no checkbox — the operator typed a key, so Crow keeps it;
 *      an existing entry for the same bundle+env key is updated, so re-entering a
 *      rotated key works). A keychain that will not open stops the save there: nothing
 *      else is written.
 *   2. the add-on's mcp-addons.json entry (applyEnvToMcpAddons with the reviewed
 *      manifest, `edited` = this key, `owner: true` — the local owner's own request is
 *      what the wall's host/bind rules read as provenance). An MCP child is spawned
 *      with ITS entry and never reads the bundle's .env, so this is the copy its own
 *      tools use. A running child keeps the old env until the gateway restarts, which
 *      the answer reports (`needs_restart`) and never starts.
 *   3. an EXISTING bundles/<id>/.env, line-preserving, plus the gateway's own env for a
 *      docker bundle (propagateBundleEnvToGateway) — exactly what Configure's save does,
 *      so a docker bundle's container gets the key too. A bundle without a .env is not
 *      given one.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateEnvText } from "./bundle-env-codec.js";
import { writePrivateFile, envPatternViolation } from "./bundle-env-secrets.js";

/** The longest key this route accepts (a typed secret is a token, not a document). */
export const API_KEY_MAX_LENGTH = 1024;

/**
 * Env names that control how a program RUNS (its loader, interpreter, shell or proxy),
 * never what it talks to. Matched case-insensitively; the prefixes catch the per-runtime
 * families (LD_*, PYTHON*, CROW_* …) and `*_PROXY`/`PROXY_*` covers the proxy set.
 */
const DENIED_EXACT = Object.freeze([
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
  "BASH_ENV", "ENV", "PATH", "HOME", "IFS", "SHELL",
  "GCONV_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SSLKEYLOGFILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS",
  "PAGER", "EDITOR", "VISUAL", "LESSOPEN", "TMPDIR", "LOCPATH", "HOSTALIASES", "RES_OPTIONS", "LANG",
]);
const DENIED_PREFIXES = Object.freeze([
  "LD_", "DYLD_", "PYTHON", "PERL5", "RUBY", "JAVA_", "_JAVA_", "JDK_JAVA_",
  "CROW_", "COMPOSE_", "DOCKER_",
  "NODE_", "OPENSSL_", "GIT_", "GLIBC_", "MALLOC_", "BASH_FUNC_", "NPM_CONFIG_", "PIP_", "UV_", "XDG_", "LC_",
]);

/** The rule, as data, for a reader (or a test) that wants the whole list at once. */
export const API_KEY_ENV_DENY = Object.freeze({ exact: DENIED_EXACT, prefixes: DENIED_PREFIXES, proxy: "*_PROXY / PROXY_*" });

/**
 * Whether this env name may never be set from an API-key card. An empty name is refused
 * too (there is nothing to declare).
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isDeniedApiKeyEnvName(name) {
  const n = typeof name === "string" ? name.trim().toUpperCase() : "";
  if (n === "") return true;
  if (API_KEY_ENV_DENY.exact.includes(n)) return true;
  if (API_KEY_ENV_DENY.prefixes.some((p) => n.startsWith(p))) return true;
  return /(^|_)PROXY(_|$)/.test(n);
}

/**
 * One fixed sentence per refusal — the route answers with these verbatim and nothing
 * else. None of them can contain a value: they are constants.
 */
export const API_KEY_SAVE_REFUSALS = Object.freeze({
  no_manifest: "Crow has no reviewed manifest for this extension, so it cannot save a key for it.",
  undeclared: "This extension does not declare that setting.",
  generated: "Crow generates that value itself, so it cannot be set here.",
  not_secret: "That setting is not a secret, so it is not saved here.",
  denied: "That setting controls how programs run, so Crow will not set it.",
  empty: "Enter the key you want to save.",
  too_long: "That key is too long.",
  invalid: "That key cannot be saved: it contains a line break or a character the settings file cannot hold.",
  pattern: "That key does not have the format this extension expects.",
  keychain: "Crow could not open its keychain, so the key was not saved.",
  env_write: "Crow saved the key but could not write the extension's settings file.",
});

/** The refusal answer, with the HTTP status the route answers with. */
function refuse(code, status = 400) {
  return { ok: false, status, error: API_KEY_SAVE_REFUSALS[code] };
}

/**
 * Everything a save touches, resolved from the real modules at CALL time. Lazy on
 * purpose: this module is imported by the manifest contract (for the denied-name rule)
 * and by the Extensions renderer (shared/api-key-card.js), neither of which may load the
 * routes module or the database.
 */
async function defaultDeps(bundleId, crowHome) {
  const [routes, config, keychain, db] = await Promise.all([
    import("./routes/bundles.js"),
    import("./bundles-config.js"),
    import("./keychain/store.js"),
    import("../db.js"),
  ]);
  return {
    bundleDir: join(config.BUNDLES_DIR, bundleId),
    findInvalidEnv: routes.findInvalidEnv,
    // The same write Configure's save makes: declared keys only, this key marked as the
    // owner's own edit, and the local-owner provenance the wall rules read.
    applyEnv: (id, values, reviewed) => routes.applyEnvToMcpAddons(id, values, config.MCP_ADDONS_PATH, reviewed, {
      edited: Object.keys(values),
      owner: true,
    }),
    propagate: routes.propagateBundleEnvToGateway,
    needsConfig: (id) => config.needsConfigKeys(id),
    openDb: () => db.createDbClient(),
    ensureWriteKey: (handle) => keychain.ensureWriteKey(handle, { crowHome: crowHome || undefined }),
    save: keychain.saveExtensionSecret,
    envPatternViolation,
    now: () => Date.now(),
    warn: (m) => console.warn(m),
  };
}

/**
 * Save one API key for an installed add-on.
 *
 * @param {object} o
 * @param {string} o.bundleId
 * @param {object|null} o.manifest   the REVIEWED manifest (bundles-config.getManifest)
 * @param {unknown} o.envKey         the env_vars name the card was built for
 * @param {unknown} o.value          the key the operator pasted
 * @param {string|null} [o.crowHome]
 * @param {object} [o.deps]          seams: bundleDir, findInvalidEnv, applyEnv, propagate,
 *                                   needsConfig, openDb, ensureWriteKey, save,
 *                                   envPatternViolation, now, warn
 * @returns {Promise<{ok: true, needs_restart: boolean, needs_config: string[]}|{ok: false, status: number, error: string}>}
 *          An ok carries the two facts the card needs and nothing else. Never the value.
 */
export async function saveApiKey({ bundleId, manifest, envKey, value, crowHome = process.env.CROW_HOME || null, deps = {} } = {}) {
  if (!manifest || typeof manifest !== "object") return refuse("no_manifest");
  const key = typeof envKey === "string" ? envKey.trim() : "";
  const envVars = Array.isArray(manifest.env_vars) ? manifest.env_vars : [];
  const spec = key === "" ? null : envVars.find((v) => v && v.name === key);
  if (!spec) return refuse("undeclared");
  if (spec.generate) return refuse("generated");
  if (spec.secret !== true) return refuse("not_secret");
  if (isDeniedApiKeyEnvName(key)) return refuse("denied");
  // A key with a previous-key slot has its own rotation rule in Configure's save: not here.
  if (typeof spec.previous_key === "string" && spec.previous_key) return refuse("undeclared");

  if (typeof value !== "string" || value.trim() === "") return refuse("empty");
  if (value.length > API_KEY_MAX_LENGTH) return refuse("too_long");

  const d = { ...(await defaultDeps(bundleId, crowHome)), ...(deps || {}) };
  const values = { [key]: value };

  // A value that would add lines to a .env file (or a name that is not a plain env name)
  // is refused by the SAME check Configure's save uses, then the manifest's own pattern.
  let invalid = null;
  try { invalid = d.findInvalidEnv(values); } catch { invalid = null; }
  if (invalid) return refuse("invalid");
  let offPattern = null;
  try { offPattern = d.envPatternViolation(manifest, values); } catch { offPattern = null; }
  if (offPattern) return refuse("pattern");

  const name = typeof manifest.name === "string" && manifest.name ? manifest.name : bundleId;

  // 1. The keychain, before anything else: no keychain, no write.
  let db = null;
  try {
    db = await d.openDb();
    const writeKey = await d.ensureWriteKey(db);
    await d.save(db, writeKey, {
      bundleId,
      envKey: key,
      label: `${name} - ${key}`,
      secret: value,
      origin: "typed",
      now: new Date(d.now()),
    });
  } catch (err) {
    // The cause's own code/name only: never the value, never the message (a driver's
    // message can quote the row it failed on).
    try { d.warn(`[bundles] ${bundleId}: ${key} was not saved to the keychain (${err && err.code ? err.code : "keychain"})`); } catch { /* console gone */ }
    return refuse("keychain", 500);
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }

  // 2. The add-on's MCP entry. Not an MCP add-on is no error: the keychain holds the key
  // and a later Configure save writes whatever else this bundle reads.
  let mcpUpdated = false;
  try { mcpUpdated = !!(await d.applyEnv(bundleId, values, manifest)); } catch { mcpUpdated = false; }

  // 3. An existing bundle .env, then the gateway's own env for a docker bundle.
  let gatewayUpdated = false;
  let envWritten = false;
  try {
    const envPath = join(d.bundleDir, ".env");
    if (existsSync(envPath)) {
      // Only a regular file: a symlink planted from inside the container must not make this
      // write copy (or overwrite) a file elsewhere.
      if (!lstatSync(envPath).isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
      const text = readFileSync(envPath, "utf8");
      writePrivateFile(envPath, updateEnvText(text, values));
      envWritten = true;
    }
  } catch (err) {
    try { d.warn(`[bundles] ${bundleId}: ${key} was saved but the bundle's .env could not be written (${err && err.code ? err.code : "write"})`); } catch { /* console gone */ }
    return refuse("env_write", 500);
  }
  if (envWritten) {
    try { gatewayUpdated = !!d.propagate(bundleId, values); } catch { gatewayUpdated = false; }
  }

  let needsConfig = [];
  try {
    const missing = d.needsConfig(bundleId);
    needsConfig = Array.isArray(missing) ? missing : [];
  } catch { needsConfig = []; }

  return { ok: true, needs_restart: mcpUpdated || gatewayUpdated, needs_config: needsConfig };
}