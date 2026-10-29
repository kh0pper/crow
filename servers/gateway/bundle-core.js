/**
 * bundle-core — the parts of the extension installer that need no instance database,
 * dashboard, gateway env, providers, push or model orchestration: the in-process job
 * registry, the docker / docker compose runners, installed.json read and write, the
 * compose text check, and the install-time .env writer.
 *
 * A full Crow uses these through routes/bundles.js (which imports them back and
 * re-exports the names its importers and tests already use). The satellite agent
 * imports this module directly to install bundles on a small server without the
 * gateway. tests/bundle-core-imports.test.js keeps its import graph clean.
 *
 * Paths come from a `crowHome` argument, or from CROW_HOME at call time — never at
 * import time.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname, relative as relativePath, isAbsolute } from "node:path";
import { resolveCrowHome } from "../shared/crow-home.js";
import { composeEnv as composeEnvFor, hostGrants } from "./compose-guard.js";
import { formatEnvLines, updateEnvText, pathEnvKeys } from "./bundle-env-codec.js";
import { parseEnvText, writePrivateFile } from "./bundle-env-secrets.js";
import { isPlaceholderValue } from "./bundle-env-placeholders.js";

// -----------------------------------------------------------------------
// Job registry (in-process)
// -----------------------------------------------------------------------

// In-memory job tracking (simple — no DB table needed for MVP)
export const jobs = new Map();
let jobCounter = 0;

// Called on every job mutation (appendLog / finishJob). A full Crow wires it to the
// dashboard's jobs:changed event (routes/bundles.js); nothing else depends on it.
let _onJobChanged = null;
/** Set (or clear, with null) the job-changed callback `(job) => void`. Its errors are swallowed. */
export function setJobChangedHook(fn) { _onJobChanged = typeof fn === "function" ? fn : null; }
function emitJobChanged(job) {
  try { if (_onJobChanged) _onJobChanged(job); } catch {}
}

export function createJob(bundleId, action) {
  const id = String(++jobCounter);
  const job = {
    id,
    bundleId,
    action,
    status: "running",
    log: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.set(id, job);
  // NOTE: eviction is armed in finishJob(), NOT here. A collection install can
  // run for tens of minutes (multi-GB image pulls); a creation-time timer would
  // delete the job mid-flight, the client's poll would 404, and its catch-path
  // would mistake that for a gateway restart (spurious reload + lost summary).
  return job;
}

export function appendLog(job, line) {
  job.log.push(line);
  emitJobChanged(job);
}

export const JOB_TTL_MS = 600_000;

export function finishJob(job, status) {
  job.status = status;
  job.completedAt = new Date().toISOString();
  // Evict N minutes after the job ENDS — never while it runs.
  const timer = setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
  if (typeof timer.unref === "function") timer.unref();
  // Non-enumerable: GET /bundles/api/jobs/:id does res.json(job); an enumerable
  // Timeout (circular _idlePrev/_idleNext) would make JSON.stringify throw.
  Object.defineProperty(job, "_evictTimer", { value: timer, configurable: true, writable: true });
  emitJobChanged(job);
}

// -----------------------------------------------------------------------
// installed.json
// -----------------------------------------------------------------------

/** The installed.json path of a Crow home (resolved at call time when omitted). */
export function installedPath(crowHome = resolveCrowHome()) { return join(crowHome, "installed.json"); }

/** Read installed.json as array */
export function readInstalled(path) {
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(data) ? data : Object.entries(data).map(([id, v]) => ({ id, ...v }));
    }
  } catch { /* ignore */ }
  return [];
}

/** Write installed.json (creates the parent dir). */
export function writeInstalled(path, arr) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(arr, null, 2));
}

// -----------------------------------------------------------------------
// Command runners: docker, docker compose
// -----------------------------------------------------------------------

/** run()'s timeout: an explicit `timeout: undefined` (e.g. no pull_timeout_s) must keep the 300 s default. */
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
export function _runOptsForTest(opts = {}) { return { ...opts, timeout: opts.timeout ?? DEFAULT_RUN_TIMEOUT_MS }; }

/** Run a shell command safely with execFile */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, _runOptsForTest(opts), (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Detect available Docker Compose command.
 * Returns { cmd, args } for either `docker compose` (v2) or `python3 -m compose` (v1 fallback).
 */
let _composeCmd = null;
export async function getComposeCmd() {
  if (_composeCmd) return _composeCmd;
  // Try docker compose v2 first
  try {
    await run("docker", ["compose", "version"]);
    _composeCmd = { cmd: "docker", prefix: ["compose"] };
    return _composeCmd;
  } catch {}
  // Try python3 -m compose (docker-compose v1 via python package)
  try {
    await run("python3", ["-m", "compose", "version"]);
    _composeCmd = { cmd: "python3", prefix: ["-m", "compose"] };
    return _composeCmd;
  } catch {}
  // Try docker-compose binary directly
  try {
    await run("docker-compose", ["version"]);
    _composeCmd = { cmd: "docker-compose", prefix: [] };
    return _composeCmd;
  } catch {}
  throw new Error("No docker compose command found. Install docker-compose-plugin or docker-compose.");
}

/**
 * The environment every gateway-driven `docker compose` run gets.
 *
 * `run()` passes no `env`, so compose would otherwise inherit the gateway's
 * environment verbatim — and `crow-gateway.service` does not set CROW_HOME, while
 * `crow-r4-gateway.service` does. The browser bundle's mount requires it
 * (`${CROW_HOME:?…}`), so an unset value fails the run outright. Resolving it here
 * means every compose run names its instance explicitly rather than depending on
 * whichever unit happened to export it.
 *
 * Only an ALLOWLIST of the gateway's own variables goes through: Compose interpolates
 * `${ANY_VAR}` from this env, so passing all of it would let a compose file copy any
 * gateway secret (API keys, tokens) into its container. A bundle's own settings come
 * from its .env, which Compose reads itself.
 *
 * `crowHome`: the instance whose compose runs these are (a full Crow passes its own;
 * omitted, CROW_HOME is read at call time).
 */
export function composeEnv(base = process.env, crowHome = resolveCrowHome()) {
  return composeEnvFor(base, crowHome); // the shared allowlist (compose-guard.js), with this instance's CROW_HOME
}

// Test-only: replace every `docker compose` invocation (pull/up/down/...) with a
// stub `(composeArgs, opts) => Promise`. null restores the real runner.
let _composeRunnerForTest = null;
export function _setComposeRunnerForTest(fn) { _composeRunnerForTest = fn || null; }

// Test-only: replace the `docker` CLI runner (ps / inspect / ntfy provisioning).
let _dockerRunnerForTest = null;
export function _setDockerRunnerForTest(fn) { _dockerRunnerForTest = fn || null; }
/** The `docker` CLI runner: the test stub when one is set, else run(). */
export function dockerRunner() { return _dockerRunnerForTest || run; }

export const nonBlankEnv = (v) => v !== undefined && v !== null && String(v).trim() !== "";

/** Keys a compose file interpolates as HARD-FAIL: `${KEY:?…}` or `${KEY?…}`. */
export function hardFailComposeKeys(composeText) {
  const keys = new Set();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g;
  let m;
  while ((m = re.exec(String(composeText || ""))) !== null) keys.add(m[1]);
  return keys;
}

/**
 * Run a docker compose command with the detected compose variant. `extraEnv` (teardown
 * only, see runComposeTeardown) is merged AFTER the allowlist: Compose ranks the shell env
 * above the .env file, so it wins over a blank line there. `crowHome` (not passed on) names
 * the instance for composeEnv.
 */
export async function runCompose(composeArgs, opts = {}) {
  const { crowHome, ...callOpts } = opts;
  if (_composeRunnerForTest) return _composeRunnerForTest(composeArgs, callOpts);
  const compose = await getComposeCmd();
  const { extraEnv, ...rest } = callOpts;
  return run(compose.cmd, [...compose.prefix, ...composeArgs], { ...rest, env: { ...composeEnv(callOpts.env, crowHome), ...(extraEnv || {}) } });
}

// An absolute path: a hard-fail key is often a bind-mount source (`${MEDIA:?}:/data`), where
// a bare word would be read as an undefined named volume and fail the retry.
export const TEARDOWN_DUMMY = "/nonexistent/crow-teardown-unset";
// Compose v2: "required variable X is missing a value"; v1: "Missing mandatory value for …".
export const MISSING_VAR_RE = /required variable \w+ is missing a value|Missing mandatory value for/;

/** The hard-fail keys blank in the bundle's .env (and not set by Crow's compose env). */
export function blankHardFailKeys(cwd, composeRel = "docker-compose.yml", crowHome = resolveCrowHome()) {
  const dir = join(cwd, dirname(composeRel));
  let text = "";
  for (const f of [join(cwd, composeRel), join(dir, "docker-compose.override.yml")]) {
    try { text += readFileSync(f, "utf8") + "\n"; } catch { /* absent */ }
  }
  let envVars = {};
  try { envVars = parseEnvText(readFileSync(join(dir, ".env"), "utf8")); } catch { /* no .env: every hard-fail key is blank */ }
  const base = composeEnv(process.env, crowHome);
  return [...hardFailComposeKeys(text)].filter((k) => !nonBlankEnv(envVars[k]) && !nonBlankEnv(base[k]));
}

/**
 * `down` / `stop` for an installed bundle. A `${KEY:?…}` whose KEY is blank or missing in
 * the bundle's .env makes EVERY compose command fail, teardown included — and an uninstall
 * that cannot `down` would orphan running containers. Retry once with a throwaway value for
 * each such key: `down`/`stop` never use those values, so it cannot reach a container.
 * Keys set in .env (or by Crow's own compose env) are never overridden. Never used for
 * `up`/`pull`/`config`: those keep failing loudly. A final error carries `blankKeys`.
 */
export async function runComposeTeardown(args, { cwd, composeRel = "docker-compose.yml", crowHome }) {
  try {
    return await runCompose(args, { cwd, crowHome });
  } catch (err) {
    if (!MISSING_VAR_RE.test(`${err?.stderr || ""}\n${err?.message || ""}`)) throw err;
    const keys = blankHardFailKeys(cwd, composeRel, crowHome);
    if (keys.length === 0) throw err;
    try {
      return await runCompose(args, { cwd, crowHome, extraEnv: Object.fromEntries(keys.map((k) => [k, TEARDOWN_DUMMY])) });
    } catch (err2) {
      err2.blankKeys = keys;
      throw err2;
    }
  }
}

/**
 * Whether any container of compose project `project` is running (or restarting, or paused:
 * still there, and orphaned if the folder goes), asked of docker directly
 * (a `docker compose ps` would fail on the same blank key that failed the teardown).
 * Throws when docker can't be asked.
 */
export async function composeProjectRunning(project) {
  const runner = dockerRunner();
  const { stdout } = await runner("docker", ["ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "status=running", "--filter", "status=restarting", "--filter", "status=paused", "--format", "{{.ID}}"], { timeout: 15_000 });
  return String(stdout || "").trim() !== "";
}

/**
 * True when any of the bundle's compose services is running. A failed `ps`
 * (no docker, compose error) answers true: callers use this to decide whether
 * to WARN about a stale container, and a missing warning is the worse error.
 */
export async function composeServiceRunning(bundleDir, { crowHome } = {}) {
  try {
    const { stdout } = await runCompose(["ps", "--format", "json"], { cwd: bundleDir, crowHome });
    const rows = String(stdout || "").trim().split("\n").filter(Boolean).flatMap((line) => {
      try { const j = JSON.parse(line); return Array.isArray(j) ? j : [j]; } catch { return []; }
    });
    return rows.some((c) => c && c.State === "running");
  } catch {
    return true;
  }
}

// -----------------------------------------------------------------------
// Compose text check
// -----------------------------------------------------------------------

// The one /etc mount allowed: /etc/localtime, read-only, same path on both sides, short
// syntax, nothing after `:ro` but whitespace + a comment. It is public data on any host.
const TZ_MOUNT_LINE = /^( *)- +(["']?)\/etc\/localtime:\/etc\/localtime:ro\2(?:[ \t]+#.*)?$/;

/** Text with the allowed timezone mounts removed — only when the NEXT non-blank line is not
 * more indented (a more-indented line would continue the scalar: `:ro` + `\n  ,rw`). */
function withoutTzMounts(content) {
  const lines = content.split("\n");
  return lines.filter((line, i) => {
    const m = line.match(TZ_MOUNT_LINE);
    if (!m) return true;
    const next = lines.slice(i + 1).find((l) => l.trim() !== "");
    if (next === undefined) return false;
    const ind = next.match(/^[ \t]*/)[0];
    return ind.includes("\t") || ind.length > m[1].length; // keep (so the /etc rule refuses it) if it continues
  }).join("\n");
}

export const HOST_NETWORK = /network_mode["']?\s*:\s*["']?host/i;

// Compose picks these up instead of, or on top of, docker-compose.yml; the check reads
// only docker-compose.yml, so a bundle shipping one would run unchecked config.
export const OTHER_COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml",
  "docker-compose.override.yml", "docker-compose.override.yaml", "compose.override.yml", "compose.override.yaml"];

/**
 * Inspect a compose file for security concerns (PR 0).
 * Rejects: sensitive host mounts, privileged mode, dangerous capabilities.
 *
 * A TEXT check, not a YAML parse: it catches the written forms our bundles and reviewed
 * add-ons use, and errs toward refusing. Known gaps (flow/JSON-style keys, interpolated
 * host paths, `..` paths, `secrets: file:`) are listed in the private engineering notes;
 * tests/bundle-compose-gate.test.js runs it over every first-party bundle.
 *
 * @param {string} composePath - path to docker-compose.yml
 * @param {string} bundleId
 * @param {object} [opts]
 * @param {object} [opts.manifest] - bundle manifest; if it has `privileged: true`
 *   AND `opts.consentVerified` is true, NET_ADMIN/host-network/privileged are allowed
 *   (never for an `origin: "community"` bundle).
 *   Read-only Docker socket mounts are allowed when manifest declares `consent_required: true`
 *   (and consent has been verified) — bundles like netdata/dozzle need this.
 * @param {boolean} [opts.consentVerified=false] - true when the install request supplied a
 *   valid consent token consumed by validateConsentToken().
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateComposeFile(composePath, bundleId, opts = {}) {
  const { manifest, consentVerified = false } = opts;
  const isPrivilegedAllowed = !!(manifest?.privileged && consentVerified && manifest?.origin !== "community");
  const isConsentBundle = !!(manifest?.consent_required && consentVerified);
  try {
    const content = readFileSync(composePath, "utf8");

    const other = OTHER_COMPOSE_FILES.filter((f) => existsSync(join(dirname(composePath), f)));
    if (other.length) {
      return { valid: false, reason: `Bundle ships another compose file (${other.join(", ")}) that Docker Compose would use; only docker-compose.yml is allowed` };
    }

    // Compose reads COMPOSE_* from the project's .env (COMPOSE_FILE swaps the very file
    // checked here); .env.example becomes .env when an install sends no values.
    for (const f of [".env", ".env.example"]) {
      let t = "";
      try { t = readFileSync(join(dirname(composePath), f), "utf8"); } catch { continue; }
      // COMPOSE_PROJECT_NAME is allowed (a co-hosted instance names its own project; the
      // model check holds it to <id>/crow-<id>[-suffix]). Any other COMPOSE_* is refused.
      if (/^\s*(?:export\s+)?COMPOSE_(?!PROJECT_NAME\s*[=:])[A-Za-z0-9_]*\s*[=:]/m.test(t)) {
        return { valid: false, reason: `Bundle ${f} sets a COMPOSE_* variable, which would change what Docker Compose runs` };
      }
    }

    // Config pulled in from other files is never read by this check.
    if (/^["']?include["']?\s*:/m.test(content) || /extends["']?\s*:\s*\{[^}]*\bfile\s*:/.test(content) || /^(\s*)extends\s*:\s*\n(?:\1\s+.*\n)*?\1\s+file\s*:/m.test(content)) {
      return { valid: false, reason: "Compose file uses include: or extends: file:, which pull in config this check cannot see" };
    }

    // Host files outside the bundle can't be read in: env_file, secrets/configs `file:`,
    // and the build context must be relative paths inside the bundle (no /, ~, ..).
    // A manifest that declares host_grants.env_files may name a shared env file under
    // ~/.crow/env (the model check verifies exactly which one).
    const outside = (v) => /^["']?(?:\/|~|\$\{?HOME\b)/.test(v) || /(?:^|\/)\.\.(?:\/|["']?\s*$)/.test(v.replace(/\s+#.*$/, "").trim());
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let m = l.match(/^(\s*)(?:-\s+)?(env_file|file|context|path)\s*:\s*(.*)$/) || l.match(/^(\s*)()build\s*:\s*(\S.*)$/);
      if (m && m[3] && outside(m[3].trim())) {
        if (!(m[2] === "env_file" && hostGrants(manifest).envFiles.length > 0)) {
          return { valid: false, reason: `Compose file reads a host path outside the bundle (${(m[2] || "build").trim()})` };
        }
      }
      m = l.match(/^(\s*)env_file\s*:\s*$/);
      if (m) {
        for (let j = i + 1; j < lines.length; j++) {
          const item = lines[j].match(/^(\s*)-\s+(?:path\s*:\s*)?(.*)$/);
          if (!item || item[1].length <= m[1].length) break;
          if (outside(item[2].trim()) && !(hostGrants(manifest).envFiles.length > 0)) {
            return { valid: false, reason: "Compose file reads a host path outside the bundle (env_file)" };
          }
        }
      }
    }

    // Sensitive host paths that should never be mounted (regardless of consent).
    // Short syntax (`- /etc:/x`) and long syntax (`source: /etc`).
    const mountText = withoutTzMounts(content);
    const sensitivePatterns = [
      /^\s*-\s+["']?\/:/m,                    // root mount /
      /^\s*-\s+["']?\/etc[/:]/m,              // /etc
      /^\s*-\s+["']?~?\/?\.ssh[/:]/m,         // ~/.ssh
      /^\s*-\s+["']?~?\/?\.crow\/data[/:]/m,  // ~/.crow/data
      /^\s*(?:-\s+)?source:\s*["']?\/(?:["'\s]|$)/m,                // source: /
      /^\s*(?:-\s+)?source:\s*["']?\/etc(?:[/"'\s]|$)/m,            // source: /etc
      /^\s*(?:-\s+)?source:\s*["']?~?\/?\.ssh(?:[/"'\s]|$)/m,       // source: ~/.ssh
      /^\s*(?:-\s+)?source:\s*["']?~?\/?\.crow\/data(?:[/"'\s]|$)/m, // source: ~/.crow/data
      /^\s*(?:-\s+)?source:\s*["']?(?:[^"'\s]*\/)?\.\.(?:[/"'\s]|$)/m, // source: ../
    ];

    // A short-syntax source with a `..` step climbs out of the bundle dir (../../data is
    // the Crow data dir). ${...} is masked so its `:-` is not taken as the separator.
    for (const l of mountText.split("\n")) {
      const item = l.match(/^\s*-\s+["']?(.*)$/);
      if (!item) continue;
      const host = item[1].replace(/\$\{[^}]*\}/g, "X").split(":")[0];
      if (/(?:^|\/)\.\.(?:\/|["']?\s*$)/.test(host)) {
        return { valid: false, reason: "Compose file mounts a host path outside the bundle (a .. step)" };
      }
    }

    for (const pattern of sensitivePatterns) {
      if (pattern.test(mountText)) {
        return { valid: false, reason: `Compose file mounts a sensitive host path (matched: ${pattern.source})` };
      }
    }

    // Docker socket — allowed read-only ONLY when manifest has consent_required and consent was verified
    // (netdata, dozzle pattern). Read-write Docker socket is never allowed via this path.
    const rwSocketPattern = /^\s*-\s+["']?\/var\/run\/docker\.sock(?!\s*:[^:]*:\s*ro)/m;
    const anySocketPattern = /^\s*-\s+["']?\/var\/run\/docker/m;
    if (rwSocketPattern.test(content)) {
      return { valid: false, reason: "Read-write Docker socket mounts are not permitted" };
    }
    if (anySocketPattern.test(content) && !isConsentBundle && !isPrivilegedAllowed) {
      return { valid: false, reason: "Docker socket mount requires manifest 'consent_required: true' and verified consent" };
    }

    // Privileged mode (any case, quoted key or value)
    if (/^\s*["']?privileged["']?\s*:\s*["']?true\b/im.test(content) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file uses privileged mode but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    // Dangerous capabilities (NET_ADMIN etc., or cap_add ALL) — gated by manifest.privileged + consent
    const allCaps = /cap_add["']?\s*:\s*\[[^\]]*\bALL\b/i.test(content) || /^\s*-\s*["']?(?:CAP_)?ALL["']?\s*$/m.test(content);
    if ((/NET_ADMIN|SYS_ADMIN|SYS_PTRACE|SYS_RAWIO|NET_RAW/m.test(content) || allCaps) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file requests dangerous capabilities (NET_ADMIN, SYS_ADMIN, NET_RAW, etc.) but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    // Host networking, another container's network, or the host's PID/user namespace —
    // gated by manifest.privileged + consent (`network_mode: service:x` stays in this file).
    const sharedNs = /network_mode["']?\s*:\s*["']?container:/i.test(content)
      || /^\s*["']?(?:pid|userns_mode)["']?\s*:\s*["']?(?:host|container:)/im.test(content);
    if ((HOST_NETWORK.test(content) || sharedNs) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file uses host networking (or shares another namespace) but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `Could not read compose file: ${err.message}` };
  }
}

// -----------------------------------------------------------------------
// Install-time .env
// -----------------------------------------------------------------------

/**
 * Write the bundle's .env at install time. Ladder:
 *   1. Provided non-empty values → written verbatim.
 *   2. Zero usable values → copy .env.example if present (this fallback was
 *      previously dead for UI installs: the install modal always sends an
 *      env_vars OBJECT, and the old `else if` only ran for non-objects).
 *   3. Still nothing, but the manifest declares env vars → a comment-only
 *      placeholder .env. Without ANY .env the needs-setup badge fails closed
 *      (resolveEffectiveEnv managed:false — bundles-config.js) and a bundle
 *      whose required key has no default AND no .env.example can NEVER badge
 *      (vaultwarden, gitea, immich, adguard-home, … — roughly twenty such
 *      bundles ship today; NOT frigate, whose .env.example takes rung 2).
 *      Comment-only on purpose: `KEY=` lines would set empty-string env vars
 *      in the container, which is not the same as unset.
 * Never clobbers an existing .env via the fallback paths.
 *
 * @param {string} destDir           installed bundle dir (~/.crow/bundles/<id>)
 * @param {object|null} envVars      values from the install modal / CLI
 * @param {object|null} manifest     the bundle manifest (for env_vars)
 * @param {(msg:string)=>void} [log] install-job logger
 *
 * Every rung writes mode 600 — bundle .env files hold secrets.
 */
export function writeInstallEnv(destDir, envVars, manifest, log = () => {}, { baseText = null, baseIsExample = false, crowHome = null, retained = null, clear = [] } = {}) {
  const envPath = join(destDir, ".env");
  const examplePath = join(destDir, ".env.example");
  const usable = {};
  if (envVars && typeof envVars === "object") {
    for (const [k, v] of Object.entries(envVars)) if (v !== undefined && v !== "") usable[k] = v;
  }
  const count = Object.keys(usable).length;
  const pathKeys = pathEnvKeys(manifest);
  // Keys the owner emptied in the form on a reinstall (clearedInstallEnv): set blank, so
  // compose falls back to its own default. Only meaningful over an existing .env.
  const clearSet = new Set(Array.isArray(clear) ? clear.filter((k) => !Object.hasOwn(usable, k)) : []);
  const cleared = Object.fromEntries([...clearSet].map((k) => [k, ""]));
  // Keys with env_vars[].default_in_crow_home that would install blank or as an example
  // value get a folder inside this instance's CROW_HOME, created now (by the gateway user,
  // so Docker never creates it as root).
  // An existing .env (reinstall) is never "fixed" behind the user's back: there only a
  // blank or missing key gets the default; the checklist flags a placeholder instead.
  const homeDefaults = (base, { replacePlaceholders = true } = {}) => {
    const out = {};
    if (!crowHome) return out;
    const baseEnv = parseEnvText(base || "");
    for (const v of manifest?.env_vars || []) {
      const rel = crowHomeDefaultRel(v);
      if (!rel || clearSet.has(v.name)) continue;
      const cur = usable[v.name] ?? baseEnv[v.name];
      if (cur !== undefined && cur !== "" && !(replacePlaceholders && isPlaceholderValue(cur))) continue;
      // A reinstall over kept data: the path the earlier install used (retained at uninstall).
      const kept = retained?.[v.name];
      if (kept && !isPlaceholderValue(kept)) { out[v.name] = kept; continue; }
      const dir = join(crowHome, rel);
      try { mkdirSync(dir, { recursive: true, mode: 0o755 }); } catch { continue; }
      out[v.name] = dir;
    }
    if (Object.keys(out).length) log(`Set ${Object.keys(out).join(", ")} (the earlier install's path, else a folder inside Crow's home; change it in Configure)`);
    return out;
  };
  if (typeof baseText === "string") {
    // Seeded from an existing .env / .env.example: line-preserving (C4) — the base's
    // own lines (comments, legacy values, ${VAR} references) stay byte-for-byte.
    writePrivateFile(envPath, updateEnvText(baseText, { ...homeDefaults(baseText, { replacePlaceholders: baseIsExample }), ...cleared, ...usable }, { pathKeys }));
    log(`Wrote ${count} env vars`);
    return;
  }
  if (count > 0) {
    writePrivateFile(envPath, formatEnvLines({ ...homeDefaults(""), ...usable }, { pathKeys }));
    log(`Wrote ${count} env vars`);
    return;
  }
  if (existsSync(envPath)) { chmodSync(envPath, 0o600); return; }
  if (existsSync(examplePath)) {
    // Example values are documentation, never live config: placeholder lines become
    // comments (the checklist then lists the key), the rest is kept.
    const text = scrubPlaceholderLines(readFileSync(examplePath, "utf8"));
    writePrivateFile(envPath, updateEnvText(text, homeDefaults(text), { pathKeys }));
    log("Created .env from .env.example (example values left out)");
    return;
  }
  const defaults = homeDefaults("");
  if (Object.keys(defaults).length) {
    writePrivateFile(envPath, formatEnvLines(defaults, { pathKeys }));
    return;
  }
  if ((manifest?.env_vars || []).length > 0) {
    writePrivateFile(envPath, "# Managed by Crow — no values provided at install; configure via the dashboard Extensions panel.\n");
    log("Wrote placeholder .env (no values provided — configure via Extensions)");
  }
}

/** env_vars[].default_in_crow_home as a safe relative path, or null. */
export function crowHomeDefaultRel(v) {
  const rel = v?.default_in_crow_home;
  if (typeof rel !== "string" || rel === "" || isAbsolute(rel) || rel.includes("\\") || rel.includes("$")) return null;
  const norm = relativePath(".", rel);
  if (!norm || norm.startsWith("..") || isAbsolute(norm)) return null;
  return norm;
}

/** .env text with every KEY=<placeholder> line turned into a comment naming only the key. */
export function scrubPlaceholderLines(text) {
  return String(text || "").split("\n").map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return line;
    const val = parseEnvText(`${m[2]}=${m[3]}`)[m[2]];
    return isPlaceholderValue(val) ? `# ${m[2]}= (example value left out: set it in Extensions)` : line;
  }).join("\n");
}
