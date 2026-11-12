/**
 * Crow takes an app's API token from the app itself (paperless-ngx is the first one).
 *
 * Some apps can only be talked to with a token that the app mints INSIDE itself: you sign
 * in, create a token, and the app shows it once. Asking the operator to do that by hand is
 * the last "Finish setup" step of such a bundle. A bundle can instead declare a script Crow
 * runs once the app is up — after the first-admin script, when both are declared:
 *
 *   "firstAdmin": {
 *     "mode": "crow", "via": "setup",
 *     "setup": {
 *       "script": "scripts/first-admin.sh", "timeout_s": 240,
 *       "token": { "script": "scripts/api-token.sh", "env": "APP_API_TOKEN", "timeout_s": 120 }
 *     },
 *     "user": "admin", "secretEnv": "APP_ADMIN_PASSWORD"
 *   }
 *
 * An app whose admin Crow makes from the ENVIRONMENT (`via: "env"`) declares the same step
 * as a sibling of `secretEnv`, because it has no setup script to hang it under:
 *
 *   "firstAdmin": { "mode": "crow", "via": "env", "secretEnv": "APP_ADMIN_PASSWORD",
 *                   "token": { "script": "scripts/api-token.sh", "env": "APP_API_TOKEN",
 *                              "stdin": "admin-password" } }
 *
 * The script signs in with the admin login Crow just made, mints a token, and writes THAT
 * TOKEN — and nothing else — to fd 3 (stdout and stderr stay the run's log). The protocol:
 *
 *   bash <Crow's own copy of the bundle>/<token.script>, cwd = the installed bundle dir, in
 *   its own process group, minimal env (hookEnv) + CROW_FIRST_ADMIN_USER=<user>, when the
 *   manifest names one. The token comes BACK on fd 3, never in. At most 4096 bytes
 *   (SECRET_FD_MAX_BYTES).
 *
 *   exit 0   fd 3 holds the token (one line) — Crow saves it under `token.env`
 *   exit 4   the app is not running / not answering (nothing changed; try again later)
 *   other    failed (a timeout counts as failed)
 *
 * TWO shapes of `token.env`:
 *
 *   "APP_API_TOKEN"                       one value: fd 3 is that value, one line (today's
 *                                         protocol, unchanged)
 *   ["APP_CLIENT_ID", "APP_CLIENT_SECRET"] several values: fd 3 carries exactly ONE line per
 *                                         declared name, `NAME=value`, every declared name
 *                                         exactly once and nothing else. Each value is
 *                                         checked by acceptToken's rules for its own env_vars
 *                                         entry, and nothing is saved unless every value was
 *                                         answered and accepted.
 *
 * A two-value save is ALL OR NOTHING, from both ends. Before the script runs, an array
 * declaration whose settings are already half-filled is left alone (result "failed" with a
 * fixed sentence, the script never runs) instead of being mixed with fresh values. And once a
 * value is saved, a later save that fails (or answers "already has a value") takes the values
 * THIS run saved back out again and answers "failed": a run never reports "ok" over a set
 * that is half new and half old. Crow has no per-value remover today (the keychain store
 * deletes by row id or for a whole bundle, and the MCP-entry and .env writers have no removal
 * path), so when nothing can take a value back the run says that in its own fixed sentence
 * rather than claim a clean result.
 *
 * `"stdin": "admin-password"` makes Crow pass the keychain's admin password for this bundle
 * (`firstAdmin.secretEnv`) as ONE line on the script's stdin — exactly as the first-admin
 * protocol passes a password. Only that one value is allowed; without it stdin stays closed
 * (as it always has). The password is never in an argument, an environment variable or a log.
 *
 * A token that is saved goes exactly where the API-key card's save puts a typed one, with a
 * different policy: origin "generated", `propagate: false` (the gateway's own env is not a
 * place for it) and `firstWriterWins: true` — a value the extension already has is NEVER
 * replaced, and when that is the whole job the answer is `skipped-has-value`, not a failure
 * (with several values, a set that is half old is a failure: see above). A refused save is the
 * save's own fixed sentence.
 *
 * Saving is CONFIRMED first, and fails closed: the caller's `installStamp` is compared with
 * installed.json after the script ran (the `stillInstalled` seam). No stamp, a seam that
 * cannot answer, or an answer that says the extension is gone (or was reinstalled under a
 * NEW stamp) all mean nothing is written; `stillInstalled`'s own default answers false.
 *
 * The token never leaves this module except into that save: not in the result's fields, not
 * in a log line, not in a warn. Both the script's own fd-3 text and every line it printed
 * are scrubbed (`[hidden]`) before anything is returned, and an oversized fd-3 answer is a
 * failure rather than a truncated token.
 *
 * Like the first-admin run, the manifest and the script come from Crow's OWN copy of the
 * bundle (`scriptDir`), never from ~/.crow/bundles/<id> — that folder can be mounted into
 * the bundle's own container, so nothing in it decides what Crow runs. The installed folder
 * is only the working directory. The concurrency lock is the caller's
 * (tryBeginFirstAdminSetup): this module takes none.
 */
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { safeRelPath, spawnGroup, hookEnv, tailLines } from "./bundle-lifecycle.js";
import { saveApiKey, API_KEY_SAVE_REFUSALS, isDeniedApiKeyEnvName } from "./bundle-apikey-save.js";
import { isPlaceholderValue } from "./bundle-env-placeholders.js";

/**
 * `api_token_auto:<id>` — what the boot catch-up did for this install, as
 * `{install, at, result}`. Plain `dashboard_settings` SQL, like every other per-install
 * marker: local only, never synced, no registry entry.
 */
export const API_TOKEN_AUTO_PREFIX = "api_token_auto:";
export const apiTokenAutoKey = (bundleId) => `${API_TOKEN_AUTO_PREFIX}${bundleId}`;
/**
 * `first_admin_auto:<id>` — the install's own first-admin outcome (owned by
 * bundle-first-admin.js). The string is repeated rather than imported because that module
 * loads the database and notifications, and THIS one is imported by the manifest contract.
 */
const FIRST_ADMIN_AUTO_PREFIX = "first_admin_auto:";

/** The longest token accepted when the manifest declares no `pattern`. */
export const API_TOKEN_MIN_LENGTH = 20;
export const API_TOKEN_MAX_LENGTH = 256;

export const API_TOKEN_DEFAULT_TIMEOUT_S = 120;
export const API_TOKEN_MAX_TIMEOUT_S = 600;

/** Env names a manifest may hand Crow: shell-safe, and none of the reserved prefixes. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV_PREFIXES = ["COMPOSE_", "DOCKER_", "CROW_"];

/** Fixed sentences: the run's answer, the contract's errors. None can contain a value. */
const COMMUNITY_REFUSAL = "API-token scripts run host shell code and are honored for first-party bundles only";
const BAD_SHAPE_REASON = "the app answered with something that is not an API token";
const OVERFLOW_REASON = "the app answered with more than an API token (the answer was discarded)";
const SAVE_FAILED_REASON = "Crow could not save the app's API token";
/** `token.stdin: "admin-password"` with nothing in the keychain to pass in: nothing ran. */
const PASSWORD_MISSING_REASON = "Crow has no admin password saved for this app, so it could not sign in to create the token";
/**
 * A two-value declaration the extension has already half-filled: the script does not run at
 * all, so nothing can be mixed. Fixed text, no value in it.
 */
const PREFILLED_PARTIAL_REASON = "Some of this extension's API settings are already filled in and others are not, so Crow left them alone.";
/**
 * The saves in one run disagreed with each other: the values this run wrote were taken back
 * out again, so the extension keeps whatever it had before the run.
 */
const MIXED_SAVE_REASON = "Some of this extension's API settings already had a value while others did not, so Crow took back the values it had just saved";
/**
 * A run could not take back the values it had already saved: the extension may now hold some
 * of them and not others. Never "ok": the half-filled state is what the operator has to fix.
 */
const NO_TAKEBACK_REASON = "Crow saved some of this extension's API settings but could not take them back, so some of them are filled in and others are not";
const UNEXPECTED_REASON = "Crow's own token setup stopped unexpectedly";
const NOT_DECLARED_REASON = "this app's API token is not minted by a setup script";
const REMOVED_REASON = "the extension was removed while Crow was creating its token";
/**
 * Nothing could CONFIRM the extension is still installed (no stamp to compare, or a seam
 * that cannot answer). Fail closed: a token is not saved for an install nobody can vouch for.
 */
const NOT_CONFIRMED_REASON = "Crow could not confirm the extension is still installed, so it did not save the token";

/**
 * The one plain sentence an install log (or the Extensions card) shows for a run's result.
 * Fixed text plus the name and the run's own scrubbed reason — never a value.
 *
 * @param {object} o
 * @param {string} o.result  runApiToken's result
 * @param {string} o.name    the bundle's display name
 * @param {string|null} [o.reason]
 * @returns {string}
 */
export function apiTokenResultMessage({ result, name, reason = null } = {}) {
  const label = name || "this app";
  if (result === "ok") return `Connected Crow to ${label} with an API token it created`;
  if (result === "skipped-has-value") return `${label} already had an API token; Crow left it alone`;
  const why = typeof reason === "string" && reason.trim() ? ` (${reason.trim()})` : "";
  return `Crow could not create ${label}'s API token; you can paste one in Configure${why}`;
}

/**
 * The one `stdin` value a token block may declare: Crow hands the script the keychain's admin
 * password for this bundle, as ONE line. Nothing else is ever passed in.
 */
export const API_TOKEN_STDIN_ADMIN_PASSWORD = "admin-password";

/** The most values one token block may mint (each is a line on fd 3 and a save). */
export const API_TOKEN_MAX_VALUES = 8;

/**
 * The token block a manifest declares: `firstAdmin.setup.token` for a `via: "setup"` admin
 * (there is a setup script to hang it under), `firstAdmin.token` — the sibling of
 * `secretEnv` — for a `via: "env"` one. Null when the declaration is absent.
 *
 * Only a `mode: "crow"` first admin has a mechanism Crow runs, so a block declared beside
 * any other mode is no token step at all: the same rule the install path applies through
 * firstAdminVia.
 */
function tokenOf(manifest) {
  const fa = manifest && typeof manifest === "object" ? manifest.firstAdmin : null;
  if (!fa || typeof fa !== "object" || Array.isArray(fa)) return null;
  if (fa.mode !== "crow") return null;
  if (fa.via === "env") {
    const token = fa.token;
    return token === undefined || token === null ? null : token;
  }
  const setup = fa.setup && typeof fa.setup === "object" ? fa.setup : null;
  const token = setup ? setup.token : undefined;
  return token === undefined || token === null ? null : token;
}

/** Where the block HAS to live, in the words a manifest author reads. */
function tokenField(manifest) {
  const via = manifest && manifest.firstAdmin && typeof manifest.firstAdmin === "object" ? manifest.firstAdmin.via : undefined;
  return via === "env" ? "firstAdmin.token" : "firstAdmin.setup.token";
}

/** A block in the wrong place: it lives beside the mechanism that makes the admin. */
function tokenMisplaced(manifest) {
  const fa = manifest && typeof manifest === "object" && manifest.firstAdmin && typeof manifest.firstAdmin === "object" && !Array.isArray(manifest.firstAdmin)
    ? manifest.firstAdmin
    : null;
  if (!fa) return null;
  const inSetup = fa.setup && typeof fa.setup === "object" && fa.setup.token !== undefined && fa.setup.token !== null;
  const atFirstAdmin = fa.token !== undefined && fa.token !== null;
  // Each location belongs to exactly one mechanism: a setup.token with any other via (or none)
  // and a firstAdmin.token outside via "env" are declarations Crow would never run.
  if (inSetup && fa.via !== "setup") {
    return 'firstAdmin.setup.token is only allowed with via "setup"; a via "env" admin declares the app\'s token as firstAdmin.token';
  }
  if (atFirstAdmin && fa.via !== "env") {
    return 'firstAdmin.token is only allowed with via "env"; a via "setup" admin declares the app\'s token as firstAdmin.setup.token';
  }
  return null;
}

/**
 * One env name's rules: declared, a secret Crow does not generate, a plain uppercase name
 * without a reserved prefix, not a name that changes how a program RUNS, and not one Crow
 * writes itself (`firstAdmin.secretEnv` / `userEnv` / `urlEnv`).
 */
function oneTokenEnvProblems(env, field, envVars, fa) {
  const problems = [];
  const name = typeof env === "string" ? env.trim() : "";
  const label = name ? `${field}.env "${name}"` : `${field}.env`;
  if (name === "" || !ENV_NAME_RE.test(name)) {
    problems.push(`${label} must be a plain uppercase env name (letters, digits and _)`);
    return problems;
  }
  const prefix = RESERVED_ENV_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) problems.push(`${label} must not start with ${prefix}: that prefix is reserved`);
  if (isDeniedApiKeyEnvName(name)) problems.push(`${label} controls how programs run, so Crow will not set it`);
  const spec = envVars.find((v) => v && v.name === name);
  if (!spec) problems.push(`${label} must name a declared env_vars entry`);
  else if (spec.generate) problems.push(`${label} is a value Crow generates, so the app's token cannot go there`);
  else if (spec.secret !== true) problems.push(`${label} must be declared with secret: true`);
  for (const other of ["secretEnv", "userEnv", "urlEnv"]) {
    const value = fa && typeof fa[other] === "string" ? fa[other].trim() : "";
    if (value && value === name) problems.push(`${field}.env must not be the same as firstAdmin.${other}`);
  }
  return problems;
}

/**
 * `token.env`, in either shape: one name (a string) or an array of names, each with its own
 * value on fd 3. Every rule applies to every name.
 */
function tokenEnvProblems(token, manifest, fa, field) {
  const problems = [];
  const envVars = manifest && Array.isArray(manifest.env_vars) ? manifest.env_vars : [];
  if (Array.isArray(token.env)) {
    if (token.env.length === 0) {
      problems.push(`${field}.env must name at least one env var (one value per name on fd 3)`);
      return problems;
    }
    if (token.env.length > API_TOKEN_MAX_VALUES) {
      problems.push(`${field}.env may name at most ${API_TOKEN_MAX_VALUES} env vars`);
    }
    const seen = new Set();
    for (const name of token.env) {
      if (typeof name === "string" && seen.has(name)) {
        problems.push(`${field}.env names "${name}" twice: each env var takes exactly one line`);
        continue;
      }
      if (typeof name === "string") seen.add(name);
      problems.push(...oneTokenEnvProblems(name, field, envVars, fa));
    }
    return problems;
  }
  const env = typeof token.env === "string" ? token.env.trim() : "";
  if (env === "") {
    problems.push(`${field}.env is missing: Crow needs the env var the minted token belongs in`);
    return problems;
  }
  problems.push(...oneTokenEnvProblems(env, field, envVars, fa));
  return problems;
}

/**
 * Every reason this manifest's token block cannot be run — [] when it can be (or when there
 * is no such block). The rules:
 *   - the block lives where the admin mechanism puts it (setup.token for via "setup",
 *     firstAdmin.token for via "env"),
 *   - first-party only (the script is host shell code),
 *   - a script that ships as a relative `.sh` path inside the bundle,
 *   - an `env` — one name, or an array of names — that names a declared `env_vars` entry Crow
 *     does not generate and does not treat as public (`secret: true`, no `generate`), whose
 *     name is a plain uppercase env name without a reserved prefix, is not one of the env
 *     names that change how a program RUNS (`isDeniedApiKeyEnvName`), and is not one Crow
 *     writes itself (`firstAdmin.secretEnv` / `userEnv` / `urlEnv`),
 *   - a `stdin`, when given, exactly `"admin-password"`,
 *   - a `timeout_s`, when given, an integer between 1 and 600.
 *
 * @param {object|null} manifest a REVIEWED manifest
 * @returns {string[]} plain sentences
 */
export function apiTokenProblems(manifest) {
  const problems = [];
  const misplaced = tokenMisplaced(manifest);
  if (misplaced) problems.push(misplaced);
  const token = tokenOf(manifest);
  if (!token) return problems;
  const field = tokenField(manifest);
  if (manifest && manifest.origin === "community") problems.push(COMMUNITY_REFUSAL);
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    problems.push(`${field} must be an object with script and env`);
    return problems;
  }
  const script = safeRelPath(token.script);
  if (!script || !script.endsWith(".sh")) {
    problems.push(`${field}.script "${String(token.script ?? "")}" must be a relative .sh path inside the bundle`);
  }
  const fa = manifest && manifest.firstAdmin && typeof manifest.firstAdmin === "object" ? manifest.firstAdmin : {};
  problems.push(...tokenEnvProblems(token, manifest, fa, field));
  if (token.stdin !== undefined && token.stdin !== API_TOKEN_STDIN_ADMIN_PASSWORD) {
    problems.push(`${field}.stdin must be "${API_TOKEN_STDIN_ADMIN_PASSWORD}" (the only value Crow passes in); leave it out when the script reads nothing`);
  }
  if (token.timeout_s !== undefined && (!Number.isInteger(token.timeout_s) || token.timeout_s < 1 || token.timeout_s > API_TOKEN_MAX_TIMEOUT_S)) {
    problems.push(`${field}.timeout_s must be an integer between 1 and ${API_TOKEN_MAX_TIMEOUT_S}`);
  }
  return problems;
}

/**
 * What the run would do: null when the bundle declares no token block, `{ refused }` when the
 * declaration cannot be run (the first of apiTokenProblems), otherwise the resolution: the
 * script's bundle-relative path, the env var(s) it fills — the declaration's own shape, a
 * string or an array — the timeout, the admin username the script signs in as, and `stdin`
 * when Crow hands the script the admin password.
 *
 * @param {object|null} manifest
 * @returns {{script: string, env: string|string[], timeoutMs: number, user: string, stdin?: string}|{refused: string}|null}
 */
export function apiTokenPlan(manifest) {
  const token = tokenOf(manifest);
  if (!token) return null;
  const problems = apiTokenProblems(manifest);
  if (problems.length > 0) return { refused: problems[0] };
  const fa = manifest && manifest.firstAdmin && typeof manifest.firstAdmin === "object" ? manifest.firstAdmin : {};
  const t = Number.isInteger(token.timeout_s) ? token.timeout_s : API_TOKEN_DEFAULT_TIMEOUT_S;
  const env = Array.isArray(token.env) ? token.env.map((n) => String(n).trim()) : token.env.trim();
  return {
    script: safeRelPath(token.script),
    env,
    timeoutMs: Math.min(Math.max(t, 1), API_TOKEN_MAX_TIMEOUT_S) * 1000,
    user: typeof fa.user === "string" ? fa.user.trim() : "",
    ...(token.stdin === API_TOKEN_STDIN_ADMIN_PASSWORD ? { stdin: API_TOKEN_STDIN_ADMIN_PASSWORD } : {}),
  };
}

/**
 * Every env name a plan fills, in the order its values are answered and saved.
 *
 * @param {{env?: string|string[]}|null} plan
 * @returns {string[]}
 */
export function apiTokenEnvNames(plan) {
  const env = plan && typeof plan === "object" ? plan.env : undefined;
  if (Array.isArray(env)) return env.map((n) => String(n));
  return typeof env === "string" && env ? [env] : [];
}

/**
 * The token a script handed back on fd 3, or null when that is not a token.
 *
 * Exactly ONE non-empty line, with at most a single trailing "\n". When the env_vars entry
 * declares a `pattern`, the line has to match it (the bundle's own grammar, e.g. paperless'
 * 40-hex token). Otherwise the line has to LOOK like a token: 20–256 printable ASCII
 * characters, no whitespace, and none of `$ # ' " \ \` { }` — the characters a settings file,
 * a shell or a template would mangle. The value is returned trimmed-free: surrounding
 * whitespace is a refusal, never something to silently trim away.
 *
 * @param {unknown} raw        the fd-3 text
 * @param {object|null} manifest
 * @param {unknown} env        the env_vars name the token goes in (its `pattern`)
 * @returns {string|null}
 */
export function acceptToken(raw, manifest, env) {
  if (typeof raw !== "string" || raw === "") return null;
  let line = raw;
  if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line === "" || line.includes("\n") || line.includes("\r")) return null;
  if (line !== line.trim()) return null;
  const envVars = Array.isArray(manifest && manifest.env_vars) ? manifest.env_vars : [];
  const spec = envVars.find((v) => v && v.name === env);
  const pattern = spec && typeof spec.pattern === "string" ? spec.pattern : "";
  if (pattern) {
    let re;
    try { re = new RegExp(pattern); } catch { return null; }
    return re.test(line) ? line : null;
  }
  if (line.length < API_TOKEN_MIN_LENGTH || line.length > API_TOKEN_MAX_LENGTH) return null;
  // Printable ASCII with no whitespace at all, then the characters that are never in a token
  // a settings file could keep verbatim.
  if (!/^[\x21-\x7e]+$/.test(line)) return null;
  if (/[$#'"\\`{}]/.test(line)) return null;
  return line;
}

/**
 * The answer a script handed back on fd 3 for a whole plan: `{ values: { NAME: value } }`
 * when it is usable, null when it is not — nothing partial ever comes back.
 *
 * ONE declared env var keeps today's protocol exactly: fd 3 is the value itself, one line
 * (acceptToken's rules). SEVERAL declared names answer as `NAME=value`, one line per name,
 * each declared name exactly once and nothing else; each value is checked by acceptToken's
 * rules for its OWN env_vars entry (its own `pattern`), and one line more, one line less, a
 * repeated name, an undeclared name or a value that fails its rules refuses the whole answer
 * — so a save can never mix a fresh value with a half-read one.
 *
 * @param {unknown} raw        the fd-3 text
 * @param {object|null} manifest
 * @param {string[]} names     the env names the plan declared, in order
 * @param {{named?: boolean}} [o]  `named: true` forces the `NAME=value` shape even for one
 *                            name (an ARRAY declaration of one); default: one name = today's
 *                            bare-value line, several = named lines
 * @returns {{values: Record<string, string>}|null}
 */
export function acceptTokenValues(raw, manifest, names, { named = null } = {}) {
  const envs = (Array.isArray(names) ? names : [names]).filter((n) => typeof n === "string" && n !== "");
  if (envs.length === 0) return null;
  const multi = named === null ? envs.length > 1 : !!named;
  if (!multi) {
    const value = acceptToken(raw, manifest, envs[0]);
    return value === null ? null : { values: { [envs[0]]: value } };
  }
  if (typeof raw !== "string" || raw === "") return null;
  let text = raw;
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text === "" || text.includes("\r")) return null;
  const lines = text.split("\n");
  if (lines.length !== envs.length) return null;
  const values = {};
  for (const line of lines) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) return null;
    const name = m[1];
    if (!envs.includes(name) || Object.hasOwn(values, name)) return null;
    const value = acceptToken(m[2], manifest, name);
    if (value === null) return null;
    values[name] = value;
  }
  // Every declared name exactly once: a missing line is a partial answer, not a save.
  for (const name of envs) if (!Object.hasOwn(values, name)) return null;
  return { values };
}

/**
 * `text` with every trimmed, non-empty line of `raw` replaced by `[hidden]`, and — for every
 * raw line of the `NAME=value` shape — the value after the first `=` replaced too. Lines
 * shorter than 4 characters are ignored: replacing a stray "ok" would shred the log for
 * nothing, and a secret that short is refused by acceptToken anyway.
 *
 * The value half matters on its own because a REFUSED multi-value answer never becomes a set
 * of values (`values` stays null), so nothing else in the run knows the values to hide while
 * the script's own stdout or stderr may quote one of them.
 *
 * @param {unknown} text
 * @param {unknown} raw
 * @returns {string}
 */
export function scrubAll(text, raw) {
  let out = String(text ?? "");
  const rawText = String(raw ?? "");
  const lines = [...new Set(rawText.split("\n").map((l) => l.trim()).filter((l) => l.length >= 4))];
  // Longest first: a line that contains another would otherwise leave a fragment behind.
  for (const line of lines.sort((a, b) => b.length - a.length)) out = out.split(line).join("[hidden]");
  const values = [...new Set(rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("="))
    .map((l) => l.slice(l.indexOf("=") + 1))
    .filter((v) => v.length >= 4))];
  for (const value of values.sort((a, b) => b.length - a.length)) out = out.split(value).join("[hidden]");
  return out;
}

/** The tail of a script's stderr, minus spawnGroup's own "exit N" / "timed out" line. */
function scriptFailureReason(err) {
  const lines = String((err && err.stderr) || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^exit\s/i.test(l) && !/^timed out after\s/i.test(l));
  if (lines.length) return lines.slice(-3).join(" | ");
  if (err && err.exitCode !== undefined && err.exitCode !== null) return `the API-token script exited with code ${err.exitCode}`;
  return err && err.message ? String(err.message) : "the API-token script failed";
}

/**
 * The script Crow will run: inside `scriptDir` (Crow's own copy of the bundle) and nowhere
 * else — the real path is resolved first, so a symlink cannot point the run outside the
 * reviewed tree. Exactly what the first-admin run does with its own script.
 */
function resolveReviewedScript(scriptDir, relScript) {
  const missing = { ok: false, reason: `the API-token script ${relScript} is missing from the bundle` };
  if (typeof scriptDir !== "string" || !scriptDir) return missing;
  let root;
  try {
    root = realpathSync(scriptDir);
  } catch {
    return missing;
  }
  let real;
  try {
    real = realpathSync(join(scriptDir, relScript));
  } catch {
    return missing;
  }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (real !== root && !real.startsWith(prefix)) {
    return { ok: false, reason: `the API-token script ${relScript} is outside Crow's own copy of the bundle` };
  }
  return { ok: true, path: real };
}

/**
 * The value this extension's own MCP entry holds for one env key ("" when it holds none).
 * Read only to answer "does it already have a value"; never logged, returned or compared to
 * anything but emptiness.
 *
 * @param {string} bundleId
 * @param {string} envKey
 * @returns {Promise<string>}
 */
async function mcpEntryValue(bundleId, envKey) {
  try {
    const [{ readFileSync }, config] = await Promise.all([import("node:fs"), import("./bundles-config.js")]);
    const all = JSON.parse(readFileSync(config.MCP_ADDONS_PATH, "utf8"));
    const entry = all && typeof all === "object" ? all[bundleId] : null;
    const env = entry && typeof entry.env === "object" && entry.env ? entry.env : null;
    const value = env ? env[envKey] : undefined;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/**
 * Whether the keychain holds an ACTIVE row for this bundle + env (metadata only: the value is
 * never opened). A home with no keychain table has no row, which is not a failure.
 *
 * @param {string} bundleId
 * @param {string} envKey
 * @returns {Promise<boolean>}
 */
async function keychainHasRow(bundleId, envKey) {
  try {
    const { createDbClient } = await import("../db.js");
    let db = null;
    try {
      db = createDbClient();
      const { rows } = await db.execute({
        sql: "SELECT 1 FROM crow_keychain WHERE kind = 'extension' AND status = 'active' AND bundle_id = ? AND env_key = ? LIMIT 1",
        args: [bundleId, envKey],
      });
      return (rows || []).length > 0;
    } finally {
      try { db?.close?.(); } catch { /* already closed */ }
    }
  } catch {
    return false;
  }
}

/**
 * The seams a run uses. Injected wholesale by tests; the defaults are the real ones.
 * `stillInstalled(id, installStamp)` is asked after the script succeeded and before the
 * save: a call that answers false means the extension is gone (or was reinstalled) and
 * nothing may be written for it. The default answers FALSE (fail closed): with no installed
 * list read, nothing has confirmed the extension, and a token is not saved on a guess.
 * Every real caller injects a seam that re-reads installed.json.
 *
 * `mcpValue` / `hasKeychainRow` are the two places a value can already be, exactly the pair
 * the boot catch-up asks (catchUpHasValue). `removeValue` takes one value this run saved back
 * out again when a two-value save cannot finish: there is no per-value remover in Crow today
 * (the keychain store deletes by row id, or every row of a bundle), so the default answers
 * false and the run reports that it could not undo the save instead of pretending it did.
 */
function defaultDeps() {
  return {
    runner: spawnGroup,
    save: saveApiKey,
    stillInstalled: () => false,
    // The keychain's admin password for this bundle, read only when the manifest asks for it
    // (`token.stdin: "admin-password"`). Lazily imported for the same reason the catch-up's
    // seams are: the manifest contract imports this module and may not load the database.
    adminPassword: (o) => readAdminPassword(o),
    mcpValue: (id, envKey) => mcpEntryValue(id, envKey),
    hasKeychainRow: (id, envKey) => keychainHasRow(id, envKey),
    removeValue: async () => false,
    warn: (m) => console.warn(m),
  };
}

/**
 * The admin password the keychain holds for this bundle (`firstAdmin.secretEnv`), or null when
 * there is none to read. The value never leaves the caller's own stdin write: it is not
 * returned in a result, logged, warned, or put in an argument or an environment variable.
 *
 * @param {{bundleId: string, envKey: string, crowHome?: string|null}} o
 * @returns {Promise<string|null>}
 */
async function readAdminPassword({ bundleId, envKey, crowHome = null } = {}) {
  if (typeof bundleId !== "string" || !bundleId || typeof envKey !== "string" || !envKey) return null;
  try {
    const [{ createDbClient }, { loadKeychainKey }, { extensionSecretsFor }] = await Promise.all([
      import("../db.js"),
      import("./keychain/key.js"),
      import("./keychain/store.js"),
    ]);
    const key = loadKeychainKey({ crowHome: crowHome || undefined });
    if (!key) return null;
    let db = null;
    try {
      db = createDbClient();
      const values = await extensionSecretsFor(db, key, bundleId, [envKey]);
      const value = values && values[envKey];
      return typeof value === "string" && value !== "" ? value : null;
    } finally {
      try { db?.close?.(); } catch { /* already closed */ }
    }
  } catch {
    // A missing key file, a home that never held a secret, a damaged row: no password, and the
    // run says so without touching the app.
    return null;
  }
}

/**
 * Run this bundle's API-token script once and keep the token it mints.
 *
 * NEVER throws and NEVER returns, logs or warns with a token (or with the admin password it
 * may have passed in). Returns `{ result, reason?, log, mcpEnvUpdated? }` where
 *   - `"ok"`               the token(s) are saved (the bundle's own MCP entry may need a
 *                          restart: `mcpEnvUpdated` says so, nothing restarts here),
 *   - `"not-running"`      the script answered exit 4: the app was not up,
 *   - `"skipped-has-value"` the extension already had a value for every key; left alone,
 *   - `"failed"`           with a plain `reason` (a timeout, an exit code, an answer that is
 *                          not a token, an oversized answer, a missing admin password, a
 *                          refused save),
 *   - `"refused"`          the declaration cannot be run (see apiTokenPlan) or declares nothing.
 * `log` is the last 20 non-empty lines of the script's stdout+stderr, scrubbed.
 *
 * An ARRAY `token.env` answers one `NAME=value` line per declared name; every value is
 * accepted before ANY is saved, so a save can never mix a fresh value with a half-read one.
 * A two-value save is all or nothing at the other end too: an extension whose settings are
 * already half-filled is left alone before the script runs (PREFILLED_PARTIAL_REASON), and a
 * run whose saves disagree (one refused because the extension already has a value, or one
 * failing) takes back the values it wrote and answers "failed" — never "ok" over a set that
 * is half new and half old. When a value cannot be taken back, the reason is
 * NO_TAKEBACK_REASON, so the operator knows to look at Configure.
 *
 * The caller owns the concurrency lock (tryBeginFirstAdminSetup): this function takes none.
 *
 * @param {object} o
 * @param {string} o.bundleId
 * @param {object} o.manifest    the REVIEWED manifest, never the installed one
 * @param {string} o.scriptDir   Crow's own copy of the bundle: the script is resolved from here
 * @param {string} o.destDir     the installed bundle dir (cwd, CROW_BUNDLE_DIR)
 * @param {string|null} [o.crowHome]
 * @param {string|null} [o.installStamp]  the installed.json stamp the caller gated on. A run
 *                            without one refuses to save: there would be nothing to compare
 *                            installed.json against after the script ran
 * @param {object} [o.deps]      seams: runner, save, stillInstalled, adminPassword, warn,
 *                            mcpValue, hasKeychainRow, removeValue
 */
export async function runApiToken({ bundleId, manifest, scriptDir = null, destDir = null, crowHome = process.env.CROW_HOME || null, installStamp = null, deps = {} } = {}) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const plan = apiTokenPlan(manifest);
  if (!plan) return { result: "refused", reason: NOT_DECLARED_REASON, log: [] };
  if (plan.refused) return { result: "refused", reason: plan.refused, log: [] };
  const envs = apiTokenEnvNames(plan);

  const dir = typeof destDir === "string" && destDir ? destDir : null;
  const script = resolveReviewedScript(scriptDir, plan.script);
  if (!dir || !script.ok) {
    return { result: "failed", reason: script.ok ? "the installed extension folder is missing" : script.reason, log: [] };
  }
  const abs = script.path;

  // Fail closed before anything runs: no stamp means the extension's continued presence can
  // never be confirmed once the script is done, so there is no point running it at all.
  if (typeof installStamp !== "string" || installStamp.trim() === "") {
    return { result: "failed", reason: NOT_CONFIRMED_REASON, log: [] };
  }

  // A two-value declaration is all or nothing, and that starts before the script runs: an
  // extension whose settings are half-filled already is left exactly as it is rather than
  // mixed with fresh values. The same check the boot catch-up makes, seam for seam.
  if (Array.isArray(plan.env)) {
    const filled = [];
    for (const envKey of envs) {
      if (await catchUpHasValue(bundleId, envKey, (name) => {
        const seam = d[name];
        if (typeof seam !== "function") throw new Error(`no ${name} seam`);
        return seam;
      })) filled.push(envKey);
    }
    if (filled.length === envs.length) return { result: "skipped-has-value", log: [] };
    if (filled.length > 0) return { result: "failed", reason: PREFILLED_PARTIAL_REASON, log: [] };
  }

  // The admin password, when the manifest asks Crow to hand it in. Its absence is answered
  // BEFORE the script runs (it has nothing to sign in with) and never as a value.
  const fa = manifest && manifest.firstAdmin && typeof manifest.firstAdmin === "object" ? manifest.firstAdmin : {};
  const secretEnv = typeof fa.secretEnv === "string" ? fa.secretEnv.trim() : "";
  let password = null;
  if (plan.stdin === API_TOKEN_STDIN_ADMIN_PASSWORD) {
    if (!secretEnv) return { result: "failed", reason: PASSWORD_MISSING_REASON, log: [] };
    try {
      const read = await d.adminPassword({ bundleId, envKey: secretEnv, crowHome });
      password = typeof read === "string" && read !== "" ? read : null;
    } catch {
      password = null;
    }
    if (!password) return { result: "failed", reason: PASSWORD_MISSING_REASON, log: [] };
  }

  const log = [];
  let raw = "";
  let values = null;
  // Everything leaving this function goes through here: the script's own fd-3 text and the
  // admin password first (so a script that echoes either while debugging cannot leak it),
  // then every accepted value.
  const scrub = (text) => {
    let s = scrubAll(text, raw);
    if (password) s = s.split(password).join("[hidden]");
    for (const value of Object.values(values || {})) if (value) s = s.split(value).join("[hidden]");
    return s;
  };
  const answer = (result, reason = null, extra = {}) => ({
    result,
    ...(reason ? { reason: scrub(reason) } : {}),
    log: log.map((l) => scrub(l)),
    ...extra,
  });

  try {
    let out;
    try {
      out = await d.runner("bash", [abs], {
        cwd: dir,
        // The admin username only when the manifest names one: an empty variable is not a
        // default a script could fall back from.
        env: { ...hookEnv(dir, crowHome || ""), ...(plan.user ? { CROW_FIRST_ADMIN_USER: plan.user } : {}) },
        timeout: plan.timeoutMs,
        // stdin carries the keychain's admin password, ONE line, when the manifest asks for
        // it; without that declaration stdin stays closed, exactly as it always has.
        ...(password ? { input: `${password}\n` } : {}),
        secretFd: true,
      });
    } catch (err) {
      raw = String((err && err.secret) ?? "");
      log.push(...tailLines(`${(err && err.stdout) || ""}\n${(err && err.stderr) || ""}`, 20));
      if (err && err.secretOverflow) return answer("failed", OVERFLOW_REASON);
      if (err && err.timedOut) return answer("failed", `the API-token script timed out after ${Math.round(plan.timeoutMs / 1000)}s`);
      if (err && err.exitCode === 4) return answer("not-running");
      return answer("failed", scriptFailureReason(err));
    }

    raw = String((out && out.secret) ?? "");
    log.push(...tailLines(`${(out && out.stdout) || ""}\n${(out && out.stderr) || ""}`, 20));
    if (out && out.secretOverflow) return answer("failed", OVERFLOW_REASON);

    const accepted = acceptTokenValues(raw, manifest, envs, { named: Array.isArray(plan.env) });
    if (!accepted) return answer("failed", BAD_SHAPE_REASON);
    values = accepted.values;

    // The extension can be removed — or reinstalled, which is a NEW install stamp — while
    // the script runs. The caller's seam re-reads what it gated on: a token for something
    // that is no longer installed is not saved anywhere.
    let still = false;
    try {
      still = !!(await d.stillInstalled(bundleId, installStamp));
    } catch {
      // A seam that cannot answer has NOT confirmed the extension is there: fail closed,
      // exactly like a false answer, and save nothing.
      return answer("failed", NOT_CONFIRMED_REASON);
    }
    if (!still) return answer("failed", REMOVED_REASON);

    // The token goes where a typed key would, with the policy a value Crow minted needs:
    // recorded as generated, never propagated into the gateway's own env, and never
    // replacing a value this extension already holds. Every value was accepted above, so a
    // save can never mix a fresh value with a half-read one — and this loop keeps the other
    // half of that promise: whatever it writes, it takes back again when a later save does
    // not land, so the run never answers "ok" over a half-saved set.
    const saved = [];
    let mcpEnvUpdated = false;
    let sawHasValue = false;
    // Take back the values THIS run saved, in the order it saved them. A value that cannot be
    // removed (or whose removal throws) means the extension may now hold some but not others:
    // the run says exactly that instead of the reason that started it.
    const takeBack = async (reason) => {
      if (saved.length === 0) return answer("failed", reason);
      let removed = true;
      for (const envKey of saved) {
        let gone = false;
        try { gone = !!(await d.removeValue({ bundleId, envKey, crowHome })); } catch { gone = false; }
        if (!gone) removed = false;
      }
      return answer("failed", removed ? reason : NO_TAKEBACK_REASON);
    };
    for (const env of envs) {
      let savedResult;
      try {
        savedResult = await d.save({
          bundleId,
          manifest,
          envKey: env,
          value: values[env],
          crowHome,
          origin: "generated",
          propagate: false,
          firstWriterWins: true,
        });
      } catch {
        return await takeBack(SAVE_FAILED_REASON);
      }
      if (savedResult && savedResult.ok) {
        saved.push(env);
        if (savedResult.needs_restart) mcpEnvUpdated = true;
        continue;
      }
      const refusedWith = savedResult && typeof savedResult.error === "string" ? savedResult.error : null;
      if (refusedWith === API_KEY_SAVE_REFUSALS.has_value) {
        // The extension already had THIS one. With one name that is the whole answer (nothing
        // of ours to take back); with several it is a mixed set, settled below.
        sawHasValue = true;
        continue;
      }
      return await takeBack(refusedWith || SAVE_FAILED_REASON);
    }
    if (saved.length === 0) return answer("skipped-has-value");
    // Some names already had a value and some were saved by this run: a half-new set is a
    // failure, and the values this run wrote come back out.
    if (sawHasValue) return await takeBack(MIXED_SAVE_REASON);
    return answer("ok", null, { mcpEnvUpdated });
  } catch (err) {
    // Never throws into the caller, and never echoes anything secret — the code or name only.
    try { d.warn(`[bundles] ${bundleId}: API-token setup stopped (${(err && (err.code || err.name)) || "error"})`); } catch { /* console gone */ }
    return answer("failed", UNEXPECTED_REASON);
  }
}

/**
 * The catch-up's real seams. Built lazily and memoised by the caller: a test that injects
 * every seam never loads the database, the routes module or the config module, and the
 * manifest contract (which imports THIS file for its rules) never loads them either.
 *
 * Exported so the gateway's boot wiring (boot/post-listen.js) hands runApiTokenCatchUp
 * these and not a second copy of them.
 */
export async function apiTokenCatchUpDeps() {
  const [{ readFileSync }, config, core] = await Promise.all([
    import("node:fs"),
    import("./bundles-config.js"),
    import("./bundle-core.js"),
  ]);
  // One settings client for the whole pass, opened on first use and closed by the caller.
  let handle = null;
  const db = async () => {
    if (!handle) {
      const { createDbClient } = await import("../db.js");
      handle = createDbClient();
    }
    return handle;
  };
  const mcpEntry = (id) => {
    try {
      const all = JSON.parse(readFileSync(config.MCP_ADDONS_PATH, "utf8"));
      const entry = all && typeof all === "object" ? all[id] : null;
      return entry && typeof entry === "object" ? entry : null;
    } catch {
      return null;
    }
  };
  return {
    appBundles: () => config.APP_BUNDLES,
    bundlesDir: () => config.BUNDLES_DIR,
    crowHome: () => config.CROW_HOME,
    tokenDeps: () => ({}),
    listInstalled: () => core.readInstalled(core.installedPath(config.CROW_HOME)),
    getManifest: (id) => config.getManifest(id),
    readSetting: async (key) => {
      try {
        const client = await db();
        const { rows } = await client.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
        const value = rows?.[0]?.value;
        return value === undefined || value === null ? null : String(value);
      } catch {
        return null;
      }
    },
    writeSetting: async (key, value) => {
      try {
        const client = await db();
        await client.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [key, value, value],
        });
        return true;
      } catch {
        return false;
      }
    },
    mcpValue: (id, env) => {
      const entry = mcpEntry(id);
      const envObj = entry && typeof entry.env === "object" && entry.env ? entry.env : null;
      const value = envObj ? envObj[env] : undefined;
      return typeof value === "string" ? value : "";
    },
    mcpTransport: (id) => {
      const entry = mcpEntry(id);
      return entry && typeof entry.transport === "string" ? entry.transport : "stdio";
    },
    hasKeychainRow: async (id, env) => {
      try {
        const client = await db();
        const { rows } = await client.execute({
          sql: "SELECT 1 FROM crow_keychain WHERE kind = 'extension' AND status = 'active' AND bundle_id = ? AND env_key = ? LIMIT 1",
          args: [id, env],
        });
        return (rows || []).length > 0;
      } catch {
        // A home that never held a secret has no table: that is no row, not a failure.
        return false;
      }
    },
    tryBegin: async (id) => {
      const { tryBeginFirstAdminSetup } = await import("./bundle-first-admin-setup.js");
      return tryBeginFirstAdminSetup(id);
    },
    end: async (id) => {
      const { endFirstAdminSetup } = await import("./bundle-first-admin-setup.js");
      endFirstAdminSetup(id);
    },
    runApiToken,
    reconnect: async (id) => {
      const proxy = await import("./proxy.js");
      return proxy.reconnectAddonServer(id);
    },
    notify: async (payload) => {
      const { createNotification } = await import("../shared/notifications.js");
      const client = await db();
      return createNotification(client, payload);
    },
    now: () => Date.now(),
    close: async () => {
      try { handle?.close?.(); } catch { /* already closed */ }
      handle = null;
    },
  };
}

/** One `dashboard_settings` marker value, parsed — null when it is missing or unreadable. */
function parseMarker(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The install stamp an installed.json entry carries (both spellings are in the wild).
 * Exported so the install path and the Extensions card compare the same value.
 */
export function installStampOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.installedAt === "string" && entry.installedAt) return entry.installedAt;
  if (typeof entry.installed_at === "string" && entry.installed_at) return entry.installed_at;
  return null;
}

/**
 * Whether this extension already HOLDS a value for `env`: a real (non-placeholder) value in
 * its own mcp-addons.json entry, or an active keychain row for the same bundle + env. An
 * operator's pasted token is never overwritten (review round 1, C1).
 *
 * Used by the boot catch-up AND by runApiToken's own all-or-nothing check before a two-value
 * script runs; a seam may answer synchronously (the catch-up's) or with a promise.
 */
async function catchUpHasValue(id, env, seam) {
  let fromMcp = "";
  try { fromMcp = String((await (await seam("mcpValue"))(id, env)) ?? ""); } catch { fromMcp = ""; }
  if (fromMcp.trim() !== "" && !isPlaceholderValue(fromMcp)) return true;
  try { return !!(await (await seam("hasKeychainRow"))(id, env)); } catch { return false; }
}

/**
 * The catch-up for EXISTING installs: once per gateway boot, after the add-ons have settled,
 * give every installed bundle whose app mints a token for Crow (`firstAdmin.setup.token`, or
 * `firstAdmin.token` for a `via: "env"` admin) that token — the install path ran the step
 * only from the version that shipped it, so an install made before it (or one whose app was
 * not up yet) never got one.
 *
 * Gates, all of them skips rather than failures (review round 1, C6):
 *   - the reviewed manifest declares a token block Crow may run (apiTokenPlan, not refused),
 *   - the add-on is not satellite-hosted (its tools run on another computer),
 *   - the app's admin exists for THIS install, which depends on how Crow made it (and
 *     `firstAdmin.mode` has to be "crow" at all: another mode's admin is not Crow's):
 *       * `via: "setup"` — `first_admin_auto:<id>` says Crow's own admin setup returned "ok"
 *         for THIS install (`install` equals the installed entry's stamp: an install whose
 *         admin was saved without a marker is out of scope),
 *       * `via: "env"` — the keychain holds this bundle's `firstAdmin.secretEnv` row (active):
 *         that generated password IS the admin, there is no setup run to have a marker,
 *   - not one of the token env vars holds a value yet (see catchUpHasValue: all of them are
 *     checked, so a half-filled extension is left alone rather than mixed),
 *   - `api_token_auto:<id>` does not already record a result for this install — except
 *     "not-running" (exit 4: the app was not up), which is retried on the next boot.
 *
 * The run takes the same per-bundle lock the install path and the card take (busy → skipped
 * silently), then records `api_token_auto:<id>` = `{install, at, result}`. A run whose
 * extension disappeared (or was reinstalled) while the script ran saves nothing and records
 * "failed": the run's own `stillInstalled` seam re-reads installed.json. On "ok" the
 * add-on's tools are reconnected ONCE here (this is the only caller that reconnects; the
 * install path asks for a restart instead — C7); on "failed" the operator gets one bell.
 *
 * NEVER throws, and never logs, notifies or returns with a token in it.
 *
 * @param {object} [o]
 * @param {object} [o.deps] seams: listInstalled, getManifest, readSetting, writeSetting,
 *                          mcpValue, mcpTransport, hasKeychainRow, tryBegin, end, runApiToken,
 *                          reconnect, notify, now, appBundles, bundlesDir, crowHome, tokenDeps, close
 * @returns {Promise<{checked: number, ran: Array<{id: string, result: string}>}>}
 */
export async function runApiTokenCatchUp({ deps = {} } = {}) {
  const injected = deps && typeof deps === "object" ? deps : {};
  let real = null;
  const seam = async (name) => {
    if (injected[name] !== undefined) return injected[name];
    if (!real) real = await apiTokenCatchUpDeps();
    return real[name];
  };
  const summary = { checked: 0, ran: [] };
  try {
    let installed = [];
    try { installed = (await (await seam("listInstalled"))()) || []; } catch { installed = []; }
    for (const entry of Array.isArray(installed) ? installed : []) {
      const id = entry && typeof entry.id === "string" ? entry.id : "";
      if (!id) continue;
      summary.checked += 1;
      try {
        const result = await catchUpOne(id, entry, seam);
        if (result) summary.ran.push({ id, result });
      } catch {
        // One bundle's failure never stops the others (and never escapes this function).
      }
    }
  } catch {
    /* nothing installed, no readable list: nothing to catch up */
  } finally {
    try { await (injected.close ? injected.close() : real?.close?.()); } catch { /* already closed */ }
  }
  return summary;
}

/**
 * One bundle's catch-up. Returns the run's result word, or null when the gates skipped it.
 * Throws only into runApiTokenCatchUp's per-bundle catch; the lock is always released.
 */
async function catchUpOne(id, entry, seam) {
  const manifest = await (await seam("getManifest"))(id);
  const plan = apiTokenPlan(manifest);
  if (!plan || plan.refused) return null;

  // A satellite-hosted add-on's tools run on its own box: its token is that box's business.
  const transport = String((await (await seam("mcpTransport"))(id)) ?? "").toLowerCase();
  if (transport === "satellite") return null;

  // The app's admin has to exist for THIS install before a token can. How Crow made it decides
  // what proves it: a `via: "setup"` run records `first_admin_auto:<id>`, while a `via: "env"`
  // admin IS the generated password the keychain holds (nothing else ran, so there is no
  // marker to read).
  const installAt = installStampOf(entry);
  if (!installAt) return null;
  const fa = manifest && manifest.firstAdmin && typeof manifest.firstAdmin === "object" ? manifest.firstAdmin : {};
  // Only a `mode: "crow"` admin is one Crow made (firstAdminVia's rule): another mode's admin
  // is the operator's own, so no token script of Crow's may sign in as it.
  if (fa.mode !== "crow") return null;
  if (fa.via === "env") {
    const secretEnv = typeof fa.secretEnv === "string" ? fa.secretEnv.trim() : "";
    if (!secretEnv) return null;
    let hasAdmin = false;
    try { hasAdmin = !!(await (await seam("hasKeychainRow"))(id, secretEnv)); } catch { hasAdmin = false; }
    if (!hasAdmin) return null;
  } else {
    const auto = parseMarker(await (await seam("readSetting"))(`${FIRST_ADMIN_AUTO_PREFIX}${id}`));
    if (!auto || auto.result !== "ok" || auto.install !== installAt) return null;
  }

  // A value the operator pasted (or a token Crow already saved) is never replaced — for ANY of
  // the env vars this block fills, so a half-filled extension is never mixed with fresh values.
  for (const env of apiTokenEnvNames(plan)) {
    if (await catchUpHasValue(id, env, seam)) return null;
  }

  // One run per install, except the "the app was not up" answer, retried next boot only.
  const prior = parseMarker(await (await seam("readSetting"))(apiTokenAutoKey(id)));
  if (prior && prior.install === installAt && typeof prior.result === "string" && prior.result !== "not-running") return null;

  // The same lock the install path and the card take: a run already in flight is skipped
  // silently (it will record its own result).
  const begin = await seam("tryBegin");
  const end = await seam("end");
  if (!begin(id)) return null;
  let run;
  try {
    const runApiTokenSeam = await seam("runApiToken");
    const tokenDeps = (await seam("tokenDeps"))() || {};
    run = await runApiTokenSeam({
      bundleId: id,
      manifest,
      scriptDir: join((await seam("appBundles"))(), id),
      destDir: join((await seam("bundlesDir"))(), id),
      crowHome: (await seam("crowHome"))() || null,
      // The stamp this run was gated on: the guard below compares it with what
      // installed.json says AFTER the script ran.
      installStamp: installAt,
      deps: {
        ...tokenDeps,
        // Re-read the installed list: a bundle removed (or reinstalled, a new stamp)
        // while the script ran must get no token. Authoritative: it wins over tokenDeps.
        stillInstalled: async (bundleId, stamp) => {
          if (!stamp) return false;
          let list = [];
          try { list = (await (await seam("listInstalled"))()) || []; } catch { return false; }
          const current = Array.isArray(list) ? list.find((e) => e && e.id === bundleId) : null;
          return installStampOf(current) === stamp;
        },
      },
    });
  } finally {
    try { await end(id); } catch { /* the lock is a Set: a failed release changes nothing else */ }
  }

  const result = run && typeof run.result === "string" ? run.result : "failed";
  const at = new Date((await seam("now"))()).toISOString();
  try { await (await seam("writeSetting"))(apiTokenAutoKey(id), JSON.stringify({ install: installAt, at, result })); } catch { /* no marker: retried next boot */ }

  if (result === "ok") {
    // This caller reconnects (once), so the add-on's tools pick the token up without a
    // gateway restart; a failed reconnect is reported nowhere and needs no retry loop.
    try { await (await seam("reconnect"))(id); } catch { /* the value is saved either way */ }
  } else if (result === "failed") {
    const name = (manifest && typeof manifest.name === "string" && manifest.name) || id;
    try {
      await (await seam("notify"))({
        title: `${name}: API token not created`,
        body: `Crow could not create an API token for ${name}. You can paste one in Configure.`,
        type: "system",
        source: "add-ons",
        priority: "normal",
      });
    } catch { /* a bell that cannot be written never undoes anything */ }
  }
  return result;
}