/**
 * Bundle lifecycle hooks + compose-project ownership — generic, manifest-declared.
 *
 *   docker.precreate: ["ws", "ws/staging"]   dirs under CROW_HOME created 0700 BEFORE
 *     `compose up` (Docker creates a missing bind source as ROOT).
 *   docker.pull_timeout_s: 1800               opt-in long pull/up (default: run()'s 300 s).
 *   postInstall: { script: "ops/bootstrap.sh", timeout_s: 1500 }
 *     `bash <installed bundle>/<script>` after a SUCCESSFUL `compose up -d` AND after the
 *     install is recorded; own process group (the whole group dies on timeout), stdin
 *     /dev/null, minimal env. Community bundles (origin: "community") are refused.
 *
 * Ownership: compose identifies a project by NAME only. Two Crow instances on one host
 * (crow + R4 share ~/crow) would otherwise recreate/stop/down each other's containers.
 * classifyProjectOwners() reads the working_dir label of every container in the project and
 * refuses only for another Crow install of the SAME bundle; legacy provenance only warns.
 */
import { mkdirSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { join, isAbsolute, normalize, basename } from "node:path";
import { spawn } from "node:child_process";

export const POST_INSTALL_MAX_TIMEOUT_S = 1800;
const POST_INSTALL_DEFAULT_TIMEOUT_S = 600;
const PULL_TIMEOUT_MAX_S = 3600;

export function safeRelPath(p) {
  if (typeof p !== "string" || p === "" || isAbsolute(p)) return null;
  const n = normalize(p);
  if (n.split(/[\\/]/).includes("..")) return null;
  return n;
}

export function precreateDirs(manifest, crowHome) {
  const rels = (manifest?.docker?.precreate || []).map((p) => {
    const rel = safeRelPath(p);
    if (!rel) throw new Error(`docker.precreate entry "${p}" must be a relative path inside CROW_HOME`);
    return rel;
  });
  return rels.map((rel) => {
    const abs = join(crowHome, rel);
    mkdirSync(abs, { recursive: true, mode: 0o700 });
    return abs;
  });
}

export function pullTimeoutMs(manifest) {
  const t = manifest?.docker?.pull_timeout_s;
  return Number.isInteger(t) && t > 0 ? Math.min(t, PULL_TIMEOUT_MAX_S) * 1000 : undefined;
}

export function postInstallPlan(manifest) {
  const h = manifest?.postInstall;
  if (!h) return null;
  if (manifest.origin === "community") return { refused: "post-install hooks run host shell code and are honored for first-party bundles only" };
  const script = safeRelPath(h.script);
  if (!script || !script.endsWith(".sh")) return { refused: `postInstall.script "${h.script}" must be a relative .sh path inside the bundle` };
  const t = Number.isInteger(h.timeout_s) ? h.timeout_s : POST_INSTALL_DEFAULT_TIMEOUT_S;
  return { script, timeoutMs: Math.min(Math.max(t, 1), POST_INSTALL_MAX_TIMEOUT_S) * 1000 };
}

const HOOK_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "XDG_RUNTIME_DIR"];
/** The hook sees only what docker/compose need — never the gateway's API keys or DB paths. */
export function hookEnv(destDir, crowHome, base = process.env) {
  const env = {};
  for (const k of HOOK_ENV_KEYS) if (base[k] !== undefined) env[k] = base[k];
  for (const [k, v] of Object.entries(base)) if (k.startsWith("DOCKER_")) env[k] = v;
  env.CROW_HOME = crowHome;
  env.CROW_BUNDLE_DIR = destDir;
  return env;
}

/** execFile-like, but in its own process group: a timeout kills the whole group. */
export function spawnGroup(cmd, args, { cwd, env, timeout, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false; let killTimer = null;
    const cap = (s, d) => (s.length > maxBuffer ? s : s + d);
    child.stdout.on("data", (d) => { stdout = cap(stdout, d); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d); });
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const timer = timeout ? setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 10_000);
    }, timeout) : null;
    child.on("error", (err) => { clearTimeout(timer); clearTimeout(killTimer); reject(Object.assign(err, { stdout, stderr })); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); killGroup("SIGKILL"); }
      if (code === 0 && !timedOut) return resolve({ stdout, stderr });
      const why = timedOut ? `timed out after ${Math.round(timeout / 1000)}s` : `exit ${code ?? signal}`;
      reject(Object.assign(new Error(why), { stdout, stderr: `${stderr}\n${why}` }));
    });
  });
}

function tailLines(text, n) {
  return String(text || "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n);
}

/** Never throws. */
export async function runPostInstall({ manifest, destDir, env, log, runner }) {
  const plan = postInstallPlan(manifest);
  if (!plan) return { ok: true, skipped: true };
  if (plan.refused) return { ok: false, reason: plan.refused };
  const abs = join(destDir, plan.script);
  if (!existsSync(abs)) return { ok: false, reason: `post-install script ${plan.script} is missing from the bundle` };
  const rerun = `bash ${abs}`;
  log(`Running post-install setup (${plan.script}, up to ${plan.timeoutMs / 1000}s)…`);
  try {
    const { stdout } = await runner("bash", [abs], { cwd: destDir, env, timeout: plan.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    for (const line of tailLines(stdout, 40)) log(`  ${line}`);
    return { ok: true };
  } catch (err) {
    const tail = tailLines(`${err?.stdout || ""}\n${err?.stderr || err?.message || ""}`, 8).join(" | ");
    return { ok: false, reason: `post-install setup failed: ${tail || "no output"}`, rerun };
  }
}

const normProject = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "");

/**
 * Fallback project name when `docker compose config` cannot run: COMPOSE_PROJECT_NAME
 * from the project .env, then a top-level `name:` with ${VAR}/${VAR:-default} resolved
 * against that .env, then the normalized dirname — compose's own precedence.
 */
export function composeProjectName(composeText, projectDir, envVars = {}) {
  if (envVars.COMPOSE_PROJECT_NAME) return normProject(envVars.COMPOSE_PROJECT_NAME);
  const m = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(String(composeText || ""));
  if (m) {
    const v = m[1].replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (_, k, d) => envVars[k] || d || "");
    if (normProject(v)) return normProject(v);
  }
  return normProject(basename(String(projectDir)));
}

/** The project compose itself would use (`config --format json` → .name), else the fallback. */
export async function resolveComposeProject({ projectDir, composeText, envVars = {}, runner, env }) {
  try {
    const { stdout } = await runner("docker", ["compose", "config", "--format", "json"], { cwd: projectDir, env, timeout: 15_000 });
    const name = JSON.parse(String(stdout || "{}")).name;
    if (name) return name;
  } catch { /* docker down or an unset :? var — fall back */ }
  return composeProjectName(composeText, projectDir, envVars);
}

// Local helpers (not imported from routes/bundles.js — that would be circular).
function realOrSelf(p) { try { return realpathSync(p); } catch { return p; } }

function installedListsId(installedPath, id) {
  try {
    const d = JSON.parse(readFileSync(installedPath, "utf8"));
    const arr = Array.isArray(d) ? d : Object.entries(d).map(([k, v]) => ({ id: k, ...v }));
    return arr.some((e) => (typeof e === "string" ? e : e && e.id) === id);
  } catch {
    return false;
  }
}

/**
 * Who else has containers in `project`?
 *   owner     — another Crow install OF THIS BUNDLE: <H>/bundles/<id>[/subdir], H ≠ crowHome,
 *               and <H>/installed.json lists <id>. Callers refuse.
 *   unrelated — every other foreign working_dir (a legacy ~/crow-addons path, a repo
 *               checkout, a stale home). Callers warn and proceed, exactly as before.
 * Docker unreachable → nobody (compose will fail on its own).
 */
export async function classifyProjectOwners({ project, projectDir, bundleId, crowHome, runner }) {
  let stdout = "";
  try {
    ({ stdout } = await runner("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", '{{.Label "com.docker.compose.project.working_dir"}}'], { timeout: 15_000 }));
  } catch {
    return { owner: null, unrelated: [] };
  }
  const mine = realOrSelf(projectDir);
  const myHome = realOrSelf(crowHome);
  const marker = `/bundles/${bundleId}`;
  let owner = null;
  const unrelated = [];
  for (const d of [...new Set(String(stdout).split("\n").map((l) => l.trim()).filter(Boolean))]) {
    const r = realOrSelf(d);
    if (r === mine) continue;
    const at = r.lastIndexOf(marker);
    const rest = at >= 0 ? r.slice(at + marker.length) : null;
    const home = at >= 0 && (rest === "" || rest.startsWith("/")) ? r.slice(0, at) : null;
    if (!owner && home && home !== myHome && installedListsId(join(home, "installed.json"), bundleId)) owner = d;
    else unrelated.push(d);
  }
  return { owner, unrelated };
}
