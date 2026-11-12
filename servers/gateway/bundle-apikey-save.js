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
 *
 * Two callers, two policies. The card (a person typing a key) keeps today's behaviour:
 * `origin: "typed"`, writes overwrite, and a docker bundle's env is propagated. A run that
 * generates a value itself (Crow's API-token hand-over) asks for the opposite, so it never
 * replaces a value the operator already has:
 *   - `origin` — what the keychain row records ("typed" | "generated"),
 *   - `propagate: false` — step 3 writes .env but never touches the gateway's own env,
 *   - `firstWriterWins: true` — stop before anything if the extension already holds a value
 *     (`hasValue`), write the keychain row ATOMICALLY (`rememberExtensionSecret`: null means
 *     somebody else's row won, so nothing else is written), re-read the bundle's own MCP
 *     entry before writing it (a Configure save in another request may have won the race)
 *     and re-read the bundle's .env before writing that (step 3: an operator's real value
 *     there is kept, and the save still answers ok — the keychain and the MCP entry are
 *     already written by then). A .env that cannot be read or parsed counts as that same
 *     "keep": an unreadable file is never overwritten on a guess.
 *     Every one of those answers is the same fixed `has_value` refusal, 409, except the .env
 *     one, which is not a failure.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateEnvText, parseEnvText } from "./bundle-env-codec.js";
import { writePrivateFile, envPatternViolation } from "./bundle-env-secrets.js";
import { isPlaceholderValue } from "./bundle-env-placeholders.js";

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
  rotating: "This key is rotated from the extension's Configure page, so it cannot be saved from this card. Open Configure for this extension to change it.",
  generated: "Crow generates that value itself, so it cannot be set here.",
  not_secret: "That setting is not a secret, so it is not saved here.",
  denied: "That setting controls how programs run, so Crow will not set it.",
  empty: "Enter the key you want to save.",
  too_long: "That key is too long.",
  invalid: "That key cannot be saved: it contains a line break or a character the settings file cannot hold.",
  pattern: "That key does not have the format this extension expects.",
  keychain: "Crow could not open its keychain, so the key was not saved.",
  env_write: "Crow saved the key but could not write the extension's settings file.",
  has_value: "This extension already has a value for that key; Crow left it alone.",
});

/**
 * The refusal answer, with the HTTP status the route answers with.
 */
function refuse(code, status = 400) {
  return { ok: false, status, error: API_KEY_SAVE_REFUSALS[code] };
}

/**
 * The bundle's own mcp-addons.json entry value for one env key — the copy its own MCP child
 * runs with ("" when the file, the entry or the key is missing). Never a secret of ours to
 * print: callers only compare it.
 */
function readMcpEntryValue(path, bundleId, envKey) {
  let all;
  try { all = JSON.parse(readFileSync(path, "utf8")); } catch { return ""; }
  const entry = all && typeof all === "object" ? all[bundleId] : null;
  const env = entry && typeof entry === "object" ? entry.env : null;
  const v = env && typeof env === "object" ? env[envKey] : undefined;
  return typeof v === "string" ? v : "";
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
    // The atomic first-writer-wins write: null means an active row under this key already
    // existed, so nothing was written.
    remember: keychain.rememberExtensionSecret,
    // This bundle's own MCP entry value (one key). Compared only; never logged or returned.
    mcpValue: (id, envKey) => readMcpEntryValue(config.MCP_ADDONS_PATH, id, envKey),
    // "Does this extension already hold a value for that key?" — the entry its own MCP child
    // runs with, or an active keychain row (metadata only: the value is never opened). A
    // home with no keychain table yet has no rows.
    hasValue: async (id, envKey) => {
      const fromMcp = readMcpEntryValue(config.MCP_ADDONS_PATH, id, envKey);
      if (fromMcp.trim() !== "" && !isPlaceholderValue(fromMcp)) return true;
      let handle = null;
      try {
        handle = db.createDbClient();
        const { rows } = await handle.execute({
          sql: "SELECT 1 FROM crow_keychain WHERE kind = 'extension' AND status = 'active' AND bundle_id = ? AND env_key = ? LIMIT 1",
          args: [id, envKey],
        });
        return (rows || []).length > 0;
      } catch {
        // A missing table (a home that never held a secret) is no row, not a failure to answer.
        return false;
      } finally {
        try { handle?.close?.(); } catch { /* already closed */ }
      }
    },
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
 * @param {"typed"|"generated"} [o.origin]        what the keychain row records about where the value came from
 * @param {boolean} [o.propagate]     whether a docker bundle's gateway env is updated too (default true)
 * @param {boolean} [o.firstWriterWins]  never replace a value this extension already holds (default false)
 * @param {object} [o.deps]          seams: bundleDir, findInvalidEnv, applyEnv, propagate,
 *                                   needsConfig, openDb, ensureWriteKey, save, remember,
 *                                   hasValue, mcpValue, envPatternViolation, now, warn
 * @returns {Promise<{ok: true, needs_restart: boolean, needs_config: string[]}|{ok: false, status: number, error: string}>}
 *          An ok carries the two facts the card needs and nothing else. Never the value.
 */
export async function saveApiKey({
  bundleId,
  manifest,
  envKey,
  value,
  crowHome = process.env.CROW_HOME || null,
  deps = {},
  origin = "typed",
  propagate = true,
  firstWriterWins = false,
} = {}) {
  if (!manifest || typeof manifest !== "object") return refuse("no_manifest");
  const key = typeof envKey === "string" ? envKey.trim() : "";
  const envVars = Array.isArray(manifest.env_vars) ? manifest.env_vars : [];
  const spec = key === "" ? null : envVars.find((v) => v && v.name === key);
  if (!spec) return refuse("undeclared");
  if (spec.generate) return refuse("generated");
  if (spec.secret !== true) return refuse("not_secret");
  if (isDeniedApiKeyEnvName(key)) return refuse("denied");
  // A key with a previous-key slot has its own rotation rule in Configure's save: not here.
  if (typeof spec.previous_key === "string" && spec.previous_key) return refuse("rotating");

  // The seams: the caller's, and for anything it did not inject the real module's — resolved
  // one at a time, only when that seam is used, so a fully injected call (a test, the
  // contract) never loads the routes module or opens a database.
  const injected = deps && typeof deps === "object" ? deps : {};
  let defaults = null;
  const seam = async (name) => {
    if (injected[name] !== undefined) return injected[name];
    if (!defaults) defaults = await defaultDeps(bundleId, crowHome);
    return defaults[name];
  };
  const warn = async (message) => { try { (await seam("warn"))(message); } catch { /* console gone */ } };

  // First-writer-wins answers before anything is written (and before the value is even
  // looked at: a key this extension already holds is left alone whatever was handed in).
  if (firstWriterWins) {
    let has = false;
    try { has = !!(await (await seam("hasValue"))(bundleId, key)); } catch { has = false; }
    if (has) return refuse("has_value", 409);
  }

  if (typeof value !== "string" || value.trim() === "") return refuse("empty");
  if (value.length > API_KEY_MAX_LENGTH) return refuse("too_long");

  const values = { [key]: value };

  // A value that would add lines to a .env file (or a name that is not a plain env name)
  // is refused by the SAME check Configure's save uses, then the manifest's own pattern.
  let invalid = null;
  try { invalid = (await seam("findInvalidEnv"))(values); } catch { invalid = null; }
  if (invalid) return refuse("invalid");
  let offPattern = null;
  try { offPattern = (await seam("envPatternViolation"))(manifest, values); } catch { offPattern = null; }
  if (offPattern) return refuse("pattern");

  const name = typeof manifest.name === "string" && manifest.name ? manifest.name : bundleId;

  // 1. The keychain, before anything else: no keychain, no write.
  let db = null;
  try {
    db = await (await seam("openDb"))();
    const writeKey = await (await seam("ensureWriteKey"))(db);
    const entry = {
      bundleId,
      envKey: key,
      label: `${name} - ${key}`,
      secret: value,
      origin,
      now: new Date((await seam("now"))()),
    };
    if (firstWriterWins) {
      // ONE atomic INSERT … ON CONFLICT: a row another save inserted first wins, and this
      // call wrote nothing at all — so nothing else is written either.
      //
      // NOTE: `remember` is only first-writer-wins for a row that does not exist yet.
      // rememberExtensionSecret OVERWRITES an active row sealed under a DIFFERENT key_id
      // (the same extension key re-sealed with this box's key), so first-writer-wins here
      // rests on the `hasValue` check above — an extension that already holds a value
      // never reaches this write at all.
      const id = await (await seam("remember"))(db, writeKey, entry);
      if (id === null || id === undefined) return refuse("has_value", 409);
    } else {
      await (await seam("save"))(db, writeKey, entry);
    }
  } catch (err) {
    // The cause's own code/name only: never the value, never the message (a driver's
    // message can quote the row it failed on).
    await warn(`[bundles] ${bundleId}: ${key} was not saved to the keychain (${err && err.code ? err.code : "keychain"})`);
    return refuse("keychain", 500);
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }

  // First-writer-wins has already claimed its keychain row, so asking `hasValue` again would
  // always answer yes. What CAN still have changed is the bundle's own MCP entry (a Configure
  // save in a parallel request): re-read just that one value and leave it alone if it exists.
  if (firstWriterWins) {
    let existing = "";
    try { existing = (await seam("mcpValue"))(bundleId, key); } catch { existing = ""; }
    if (typeof existing === "string" && existing.trim() !== "" && !isPlaceholderValue(existing)) {
      return refuse("has_value", 409);
    }
  }

  // 2. The add-on's MCP entry. Not an MCP add-on is no error: the keychain holds the key
  // and a later Configure save writes whatever else this bundle reads.
  let mcpUpdated = false;
  try { mcpUpdated = !!(await (await seam("applyEnv"))(bundleId, values, manifest)); } catch { mcpUpdated = false; }

  // 3. An existing bundle .env, then the gateway's own env for a docker bundle.
  // First-writer-wins re-checks HERE too: the keychain row and the MCP entry are already
  // written by now, so a value the operator put in the .env meanwhile is left alone rather
  // than refused — the save finishes (known, harmless: the keychain row this call wrote
  // stays, and the add-on keeps the operator's value).
  let gatewayUpdated = false;
  let envWritten = false;
  try {
    const envPath = join(await seam("bundleDir"), ".env");
    if (existsSync(envPath)) {
      // Only a regular file: a symlink planted from inside the container must not make this
      // write copy (or overwrite) a file elsewhere.
      if (!lstatSync(envPath).isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
      let text = "";
      let keepExisting = false;
      if (firstWriterWins) {
        // A .env this call cannot READ or PARSE is treated as one that already holds the
        // operator's own value: the write is skipped and the save still answers ok, so a file
        // Crow cannot inspect is never replaced on a guess. Keeping the operator's value is
        // allowed because the app's own container never reads THIS token out of .env (it is
        // Crow's credential for talking to the app, and the copy that matters is the MCP entry
        // written above); likewise the `has_value` stop on that entry leaves the generated
        // keychain row this call already wrote behind — unreferenced, and harmless.
        try {
          text = readFileSync(envPath, "utf8");
          const existing = parseEnvText(text)[key];
          keepExisting = typeof existing === "string" && existing.trim() !== "" && !isPlaceholderValue(existing);
        } catch {
          keepExisting = true;
        }
      } else {
        text = readFileSync(envPath, "utf8");
      }
      if (!keepExisting) {
        writePrivateFile(envPath, updateEnvText(text, values));
        envWritten = true;
      }
    }
  } catch (err) {
    await warn(`[bundles] ${bundleId}: ${key} was saved but the bundle's .env could not be written (${err && err.code ? err.code : "write"})`);
    return refuse("env_write", 500);
  }
  if (envWritten && propagate) {
    try { gatewayUpdated = !!(await (await seam("propagate"))(bundleId, values)); } catch { gatewayUpdated = false; }
  }

  let needsConfig = [];
  try {
    const missing = (await seam("needsConfig"))(bundleId);
    needsConfig = Array.isArray(missing) ? missing : [];
  } catch { needsConfig = []; }

  return { ok: true, needs_restart: mcpUpdated || gatewayUpdated, needs_config: needsConfig };
}