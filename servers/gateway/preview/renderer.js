/**
 * The preview renderer: a small, networkless, sandboxed Chromium in its own container
 * (container/), started on demand for a batch of previews and stopped when quiet. A
 * core component, not a bundle. CDP runs over the `docker compose run` child's stdin and
 * stdout (cdp-pipe.js), so there is no port and nothing to find.
 *
 *   - Off until `previews_enabled` (local-only) is "true": nothing is built or run.
 *   - A containerized gateway reports no_docker before any docker call: the compose
 *     file, the seccomp path and the origin's loopback would all resolve inside its own
 *     container, not on the host.
 *   - The install check (compose-guard.js, coreAllowance "preview-renderer") runs on the
 *     model Compose will apply before every build and every run; a refusal spawns nothing.
 *   - The image is built in the background, a separate step: acquire() says "building"
 *     meanwhile, a failed build backs off for 10 minutes, and run never builds. The tag
 *     hashes the image's inputs, so instances on the same code share one image, and an
 *     image older than 30 days is rebuilt without cache (Chromium security updates).
 *   - stopped → starting → running → stopping → stopped. acquire() takes its lease
 *     first; tick() stops the renderer 2 minutes (idleMs) after the last release. A stop
 *     closes stdin, waits 5 s, SIGKILLs the compose child, then `docker rm -f` by this
 *     run's name, then sweeps: correctness never rests on `--rm` or on stdin EOF reaching
 *     the container.
 *   - Ownership is by labels (crow.component, crow.instance, crow.home), never by name:
 *     the sweep removes every container with all three of ours except the live child.
 *   - Three consecutive render timeouts (release({ timedOut: true })) trip a breaker:
 *     origin_unreachable for 5 minutes.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createPipeCdp } from "./cdp-pipe.js";
import { loadComposeModel, checkComposeModel, composeEnv } from "../compose-guard.js";
import { readSetting, upsertSetting } from "../dashboard/settings/registry.js";
import { artifactOriginInfo } from "../artifact-origin/runtime.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { resolveDataDir, createDbClient } from "../../db.js";

export const CONTAINER_DIR = fileURLToPath(new URL("./container", import.meta.url));
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The manifest the install check sees for the renderer's compose. */
export const PREVIEW_MANIFEST = Object.freeze({ id: "crow-preview", origin: "core" });
/** A child that exits before answering, with stderr like this, has no usable sandbox. */
export const SANDBOX_STDERR_RE = /no usable sandbox|namespace|zygote|sandbox/i;

const DAY_MS = 24 * 3600_000;
const START_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 5_000;
const BUILD_BACKOFF_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 60 * 60_000;
const IMAGE_MAX_AGE_MS = 30 * DAY_MS;
const BREAKER_TIMEOUTS = 3;
const BREAKER_MS = 5 * 60_000;
const STDERR_TAIL_BYTES = 65_536;
// The artifact host is interpolated into Chromium's --host-resolver-rules: a plain
// hostname or IPv4 address only (no separators, no brackets, no spaces).
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The image tag: the first 12 hex of sha256(Dockerfile + pipe-shim.sh + seccomp-chrome.json). */
export function previewImageTag(containerDir = CONTAINER_DIR) {
  const h = createHash("sha256");
  for (const f of ["Dockerfile", "pipe-shim.sh", "seccomp-chrome.json"]) h.update(readFileSync(join(containerDir, f)));
  return `crow-preview-renderer:${h.digest("hex").slice(0, 12)}`;
}

/** True inside a container (Docker or Podman). */
export function detectContainer() {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export async function previewsEnabled(db) {
  try { return (await readSetting(db, "previews_enabled")) === "true"; } catch { return false; }
}

/** Write the local-only `previews_enabled` setting ("true" / "false"). */
export async function setPreviewsEnabled(db, on) {
  await upsertSetting(db, "previews_enabled", on ? "true" : "false");
}

/** CROW_PREVIEW_IDLE_SEC (30–900, clamped) in ms; 2 minutes when unset. */
export function idleMsFromEnv(env = process.env) {
  const n = Number(env.CROW_PREVIEW_IDLE_SEC);
  if (env.CROW_PREVIEW_IDLE_SEC == null || String(env.CROW_PREVIEW_IDLE_SEC).trim() === "" || !Number.isFinite(n)) return 120_000;
  return Math.round(Math.min(900, Math.max(30, n)) * 1000);
}

/** The real docker CLI. exec resolves { code, stdout, stderr } and never rejects. */
export const dockerCli = {
  exec(args, { cwd, env, timeoutMs = 60_000 } = {}) {
    return new Promise((done) => {
      execFile("docker", args, { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || (err && err.message) || "") });
      });
    });
  },
  spawn(args, { cwd, env } = {}) {
    return spawn("docker", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  },
};

const label8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
const lastLines = (s) => String(s || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ").slice(0, 400);

/**
 * @param {object} o
 * @param {string} o.crowHome
 * @param {object} o.db                      readSetting / upsertSetting client
 * @param {object} [o.docker]                { exec(args, {cwd, env, timeoutMs}), spawn(args, {cwd, env}) }
 * @param {() => number} [o.now]
 * @param {number} [o.idleMs]
 * @param {() => boolean} [o.inContainer]
 * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers]
 * @param {string} [o.containerDir]
 * @param {string | (() => string)} [o.instanceId]
 * @param {() => ({baseUrl: string} | null)} [o.originInfo]
 */
export function createPreviewRenderer({
  crowHome, db, docker = dockerCli, now = Date.now, idleMs = 120_000, inContainer = detectContainer,
  timers = { setTimeout, clearTimeout }, containerDir = CONTAINER_DIR, instanceId = getOrCreateLocalInstanceId,
  originInfo = artifactOriginInfo, log = console,
}) {
  const composeFile = join(containerDir, "compose.yml");
  let labels = null;
  const ids = () => {
    if (!labels) {
      let home;
      try { home = realpathSync(crowHome); } catch { home = resolve(crowHome); }
      const inst = label8(typeof instanceId === "function" ? instanceId() : instanceId);
      labels = { inst, home: label8(home), project: `crow-preview-${inst}` };
    }
    return labels;
  };
  const baseEnv = () => composeEnv(process.env, crowHome);

  let st = "stopped";
  let run = null;          // { child, cdp, name, exitP, closeP, stopping }
  let startP = null;
  let stopP = null;
  let leases = 0;
  let lastRelease = now();
  let offReason = null;
  let timeouts = 0;
  let trippedUntil = 0;
  let bstate = "absent";
  let buildTag = null;
  let buildFailedAt = 0;
  let tail = Buffer.alloc(0);

  /** Resolves true when p settles within ms, false otherwise. */
  const within = (p, ms) => new Promise((r) => {
    const h = timers.setTimeout(() => r(false), ms);
    p.then(() => { timers.clearTimeout(h); r(true); });
  });

  function artifactHost() {
    let info = null;
    try { info = originInfo(); } catch { /* unconfigured */ }
    if (!info?.baseUrl) return { error: "the artifact origin is not configured" };
    let host;
    try { host = new URL(info.baseUrl).hostname; } catch { return { error: "the artifact origin URL does not parse" }; }
    if (!HOST_RE.test(host)) return { error: `the artifact origin host '${host.slice(0, 80)}' is not a plain hostname or IPv4 address` };
    return { host };
  }

  // Every compose call gets every variable: compose.yml uses plain ${VAR}.
  function composeVars(host) {
    const { inst, home } = ids();
    return {
      ...baseEnv(),
      CROW_PREVIEW_IMAGE: previewImageTag(containerDir),
      CROW_PREVIEW_SECCOMP: realpathSync(join(containerDir, "seccomp-chrome.json")),
      CROW_PREVIEW_INSTANCE: inst,
      CROW_PREVIEW_HOME: home,
      CROW_PREVIEW_ARTIFACT_HOST: host,
    };
  }

  /** The install check on the model Compose will apply; null when it passes, else why. */
  async function guard(env) {
    const { project } = ids();
    const loaded = await loadComposeModel(containerDir, {
      env, composeFile, cwd: containerDir,
      runConfig: async (args, { cwd, env: e }) => {
        const r = await docker.exec(["compose", "-p", project, ...args], { cwd, env: e, timeoutMs: 60_000 });
        if (r.code !== 0) throw Object.assign(new Error(r.stderr || "docker compose config failed"), { stderr: r.stderr });
        return { stdout: r.stdout };
      },
    });
    if (loaded.error) return loaded.error;
    const verdict = checkComposeModel(loaded.model, {
      bundleDir: containerDir, manifest: PREVIEW_MANIFEST, coreAllowance: "preview-renderer",
      ctx: { crowHome, dataDir: resolveDataDir(), appRoot: APP_ROOT, home: process.env.HOME || homedir() },
    });
    return verdict.valid ? null : verdict.reason;
  }

  function kickBuild(env, { noCache }) {
    const { project } = ids();
    bstate = "building";
    buildTag = env.CROW_PREVIEW_IMAGE;
    (async () => {
      const refusal = await guard(env);
      if (refusal) throw new Error(`the install check refused the preview compose: ${refusal}`);
      const r = await docker.exec(["compose", "-p", project, "-f", composeFile, "build", ...(noCache ? ["--no-cache"] : []), "renderer"],
        { cwd: containerDir, env, timeoutMs: BUILD_TIMEOUT_MS });
      if (r.code !== 0) throw new Error(`docker compose build failed: ${lastLines(r.stderr || r.stdout)}`);
    })().then(() => {
      bstate = "ready";
      log.log?.(`[preview] image ${buildTag} built`);
    }, (err) => {
      bstate = "failed";
      buildFailedAt = now();
      log.warn?.(`[preview] build failed (retry in 10 min): ${err.message}`);
    });
  }

  /** null when the image is ready; otherwise the reason to give (and a build may start). */
  async function ensureImage(env) {
    const tag = env.CROW_PREVIEW_IMAGE;
    if (bstate === "building") return "building";
    if (bstate === "failed" && buildTag === tag && now() - buildFailedAt < BUILD_BACKOFF_MS) return "build_failed";
    const r = await docker.exec(["image", "inspect", "--format", "{{.Created}}", tag], { env: baseEnv(), timeoutMs: 30_000 });
    const created = r.code === 0 ? Date.parse(r.stdout.trim()) : NaN;
    if (Number.isFinite(created) && now() - created <= IMAGE_MAX_AGE_MS) {
      bstate = "ready";
      buildTag = tag;
      return null;
    }
    kickBuild(env, { noCache: Number.isFinite(created) });
    return "building";
  }

  function appendTail(chunk) {
    const all = Buffer.concat([tail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    tail = all.length > STDERR_TAIL_BYTES ? Buffer.from(all.subarray(all.length - STDERR_TAIL_BYTES)) : all;
  }

  async function removeByName(name) {
    await docker.exec(["rm", "-f", name], { env: baseEnv(), timeoutMs: 30_000 });
  }

  async function sweep() {
    if (inContainer()) return { removed: [] };
    const { inst, home } = ids();
    const r = await docker.exec(["ps", "-a", "--filter", "label=crow.component=preview-renderer", "--filter", `label=crow.instance=${inst}`,
      "--filter", `label=crow.home=${home}`, "--format", "{{.Names}}"], { env: baseEnv(), timeoutMs: 30_000 });
    if (r.code !== 0) return { removed: [] };
    const live = run?.name;
    const names = r.stdout.split(/\s+/).filter((n) => n && n !== live && NAME_RE.test(n));
    if (!names.length) return { removed: [] };
    const rm = await docker.exec(["rm", "-f", ...names], { env: baseEnv(), timeoutMs: 60_000 });
    return { removed: rm.code === 0 ? names : [] };
  }

  async function cleanupFailedStart(me, { kill }) {
    if (kill) {
      try { me.child.kill("SIGKILL"); } catch { /* gone */ }
      await within(me.exitP, 2_000);
    }
    me.cdp.close();
    if (run === me) run = null;
    st = "stopped";
    await removeByName(me.name);
    await sweep();
  }

  async function spawnRun(env) {
    const { inst, project } = ids();
    const name = `crow-preview-${inst}-${randomBytes(4).toString("hex")}`;
    st = "starting";
    tail = Buffer.alloc(0);
    let child;
    try {
      child = docker.spawn(["compose", "-p", project, "-f", composeFile, "run", "--rm", "-T", "-q", "--no-deps", "--pull", "never", "--name", name, "renderer"],
        { cwd: containerDir, env });
    } catch (err) {
      st = "stopped";
      log.warn?.(`[preview] could not start docker compose: ${err.message}`);
      return "start_failed";
    }
    // Drained from spawn until exit, so a chatty browser never blocks on a full pipe.
    child.stderr.on("data", appendTail);
    child.stdin.on("error", () => { /* EPIPE after exit */ });
    const exitP = new Promise((r) => { child.once("exit", r); child.once("error", r); });
    const closeP = new Promise((r) => { child.once("close", r); child.once("error", r); });
    const cdp = createPipeCdp({ input: child.stdin, output: child.stdout });
    const me = { child, cdp, name, exitP, closeP, stopping: false };
    run = me;

    let timer;
    const outcome = await new Promise((r) => {
      timer = timers.setTimeout(() => r("timeout"), START_TIMEOUT_MS);
      cdp.send("Browser.getVersion").then(() => r("ok"), () => { /* the close or exit says why */ });
      cdp.closed.then(({ reason }) => { if (reason === "bad_frame") r("bad_frame"); });
      exitP.then(() => r("exit"));
    });
    timers.clearTimeout(timer);

    if (outcome === "ok") {
      st = "running";
      exitP.then(() => onUnexpectedExit(me));
      return null;
    }
    if (outcome === "exit") {
      await within(closeP, 1_000); // the rest of stderr
      const why = SANDBOX_STDERR_RE.test(tail.toString("utf8")) ? "sandbox_unavailable" : "start_failed";
      log.warn?.(`[preview] the renderer exited before answering (${why}): ${lastLines(tail.toString("utf8"))}`);
      await cleanupFailedStart(me, { kill: false });
      return why;
    }
    log.warn?.(`[preview] the renderer did not start (${outcome === "timeout" ? "no answer in 20 s" : "stdout is not CDP"}): ${lastLines(tail.toString("utf8"))}`);
    await cleanupFailedStart(me, { kill: true });
    return "start_failed";
  }

  function onUnexpectedExit(me) {
    if (me.stopping || run !== me) return;
    run = null;
    st = "stopped";
    me.cdp.close();
    log.warn?.(`[preview] the renderer exited: ${lastLines(tail.toString("utf8"))}`);
    removeByName(me.name).then(() => sweep()).catch(() => { /* the boot sweep catches it */ });
  }

  async function startSequence() {
    if (inContainer()) return "no_docker";
    const info = await docker.exec(["info", "--format", "{{.ServerVersion}}"], { env: baseEnv(), timeoutMs: 15_000 });
    if (info.code !== 0) return "no_docker";
    const h = artifactHost();
    if (h.error) {
      log.warn?.(`[preview] not starting: ${h.error}`);
      return "start_failed";
    }
    const env = composeVars(h.host);
    const img = await ensureImage(env);
    if (img) return img;
    const refusal = await guard(env);
    if (refusal) {
      log.warn?.(`[preview] the install check refused the preview compose: ${refusal}`);
      return "start_failed";
    }
    return spawnRun(env);
  }

  async function ready() {
    if (!(await previewsEnabled(db))) return "not_enabled";
    if (now() < trippedUntil) return "origin_unreachable";
    while (stopP) await stopP;
    if (st === "running" && run) return null;
    if (!startP) startP = startSequence().finally(() => { startP = null; });
    const off = await startP;
    if (off) return off;
    return st === "running" && run ? null : "start_failed";
  }

  async function doStop(me) {
    st = "stopping";
    me.stopping = true;
    try { me.child.stdin.end(); } catch { /* already closed */ }
    const exited = await within(me.exitP, STOP_GRACE_MS);
    if (!exited) {
      try { me.child.kill("SIGKILL"); } catch { /* gone */ }
      await within(me.exitP, 2_000);
    }
    me.cdp.close();
    await removeByName(me.name);
    if (run === me) run = null;
    st = "stopped";
    await sweep();
  }

  async function stop() {
    if (startP) await startP.catch(() => {});
    if (stopP) return stopP;
    if (!run) return;
    stopP = doStop(run).finally(() => { stopP = null; });
    return stopP;
  }

  return {
    async acquire() {
      leases++;
      let held = true;
      const drop = () => { if (held) { held = false; leases--; return true; } return false; };
      let off;
      try {
        off = await ready();
      } catch (err) {
        log.warn?.(`[preview] start failed: ${err.message}`);
        off = "start_failed";
      }
      if (off) {
        drop();
        offReason = off;
        return { off };
      }
      offReason = null;
      return {
        cdp: run.cdp,
        release({ timedOut = false } = {}) {
          if (!drop()) return;
          lastRelease = now();
          if (!timedOut) { timeouts = 0; return; }
          if (++timeouts >= BREAKER_TIMEOUTS) {
            timeouts = 0;
            trippedUntil = now() + BREAKER_MS;
            log.warn?.("[preview] three render timeouts in a row: previews paused for 5 minutes");
          }
        },
      };
    },
    async tick() {
      if (st !== "running") return "idle";
      if (leases > 0 || now() - lastRelease <= idleMs) return "kept";
      await stop();
      return "stopped";
    },
    sweep,
    /** Stop now, leases or not (the off switch). */
    stop,
    /** Start the image build if previews are on and it is missing or stale; never runs. */
    async prepare() {
      if (!(await previewsEnabled(db))) return "not_enabled";
      if (inContainer()) return "no_docker";
      const info = await docker.exec(["info", "--format", "{{.ServerVersion}}"], { env: baseEnv(), timeoutMs: 15_000 });
      if (info.code !== 0) return "no_docker";
      const h = artifactHost();
      if (h.error) return "start_failed";
      return ensureImage(composeVars(h.host));
    },
    /** `docker image rm` of the shared tag, only when no preview container runs it. */
    async removeImage() {
      if (inContainer()) return { removed: false, reason: "no_docker" };
      const tag = previewImageTag(containerDir);
      const ps = await docker.exec(["ps", "-q", "--filter", "label=crow.component=preview-renderer", "--filter", `ancestor=${tag}`], { env: baseEnv(), timeoutMs: 30_000 });
      if (ps.code !== 0) return { removed: false, reason: "no_docker" };
      if (ps.stdout.trim()) return { removed: false, reason: "in_use" };
      const r = await docker.exec(["image", "rm", tag], { env: baseEnv(), timeoutMs: 60_000 });
      if (r.code !== 0) return { removed: false, reason: lastLines(r.stderr) || "failed" };
      if (buildTag === tag) bstate = "absent";
      return { removed: true };
    },
    state: () => st,
    lastOff: () => offReason,
    buildState: () => bstate,
    stderrTail: () => tail.toString("utf8"),
    /** This run's container name (null when stopped). */
    runName: () => run?.name ?? null,
    /** Tests only: the live compose child. */
    _childForTest: () => run?.child ?? null,
  };
}

// ---- the gateway's one renderer ---------------------------------------------------------

let singleton = null;

/** The process's renderer (created on first use). */
export function previewRenderer() {
  if (!singleton) singleton = createPreviewRenderer({ crowHome: resolveCrowHome(), db: createDbClient(), idleMs: idleMsFromEnv() });
  return singleton;
}

/** Tests only: replace the process's renderer (null resets). */
export function _setPreviewRendererForTest(r) { singleton = r; }

/**
 * Boot: sweep what an earlier process left, and tick every 30 s. Skipped on a --no-auth
 * gateway (a loopback secondary that never renders previews, and must not sweep the
 * primary's live container: same instance, same home, same labels).
 */
export function startPreviewRendererTimers({ noAuth = false } = {}) {
  if (noAuth) return null;
  const r = previewRenderer();
  r.sweep().then(({ removed }) => {
    if (removed.length) console.log(`[preview] removed ${removed.length} leftover preview container(s)`);
  }).catch(() => { /* never fatal */ });
  const iv = setInterval(() => { r.tick().catch(() => { /* next tick */ }); }, 30_000);
  iv.unref?.();
  return iv;
}
