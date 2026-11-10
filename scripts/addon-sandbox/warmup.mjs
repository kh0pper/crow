/**
 * The one prepare run an add-on gets before its first real start.
 *
 * An `npx`/`uvx`/`uv run` add-on fetches its own code from a registry the first
 * time it starts, which is exactly what a walled child cannot do quietly: its
 * cache lives inside its own data folder, and the run has to finish before the
 * add-on is worth starting. So the gateway warms the cache inside a wall that
 * reaches the package registries and nothing else, then remembers that it did:
 * a second connect for the same plan and install folder is a no-op.
 *
 * What a prepare run may reach is decided once, here, as an exact list of hosts
 * (`plan.hosts`, https on 443): the npm registry for `npx`, PyPI for `uv` and
 * `uvx`, plus GitHub for a tool that is a pinned git ref. A git ref on any other
 * host is refused, not widened to. Install and build scripts of third-party
 * packages do not run: npm gets `--ignore-scripts`, uv gets `--no-build` for
 * every dependency, and only the add-on's OWN project is built.
 *
 * Three rules:
 *  - the warm-up never throws. Its result is data (`ok`, a reason, the child's
 *    last stderr lines, the relay's denials), so a caller can leave the add-on
 *    off and raise one card from it.
 *  - the warm-up plans nothing it cannot name exactly: an entry with no
 *    launcher to warm (`node server/index.js`) or a uv project with no lock
 *    file plans nothing, and the caller then does what it did before.
 *  - it never sees the add-on's own env. The wall gets the plan's fixed,
 *    non-secret settings and nothing else, so a warm-up cannot use a token.
 *
 * Node built-ins only; the spawn and the clock are test seams.
 */
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { resolveAddonCommand } from "../../servers/shared/resolve-command.js";
import { launcherSpec, PinRefused } from "./pin.mjs";

/** How much of one stderr line a warm-up result keeps. */
const STDERR_LINE_MAX = 300;
/** How many stderr lines it keeps. */
const STDERR_LINES_KEPT = 20;
/** The default prepare timeout: ten minutes, not the 60 s connect cap. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** The registries npm and PyPI serve a launcher's code from. */
const NPM_HOSTS = ["registry.npmjs.org"];
const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];
/** A git ref's own hosts: a copy of the repository, and the archive it fetches. */
const GIT_HOSTS = ["github.com", "codeload.github.com"];
/** The one host a pinned git ref may name (the ref is checked for its commit too). */
const GIT_HUB = "github.com";
/** What a git ref on a host this warm-up does not fetch from is refused with. */
const OTHER_SOURCE_REASON = "its packages come from a host Crow does not fetch from";
/** A `git+https://host/…@<40 hex>` ref, split into its URL and its commit. */
const GIT_REF_RE = /^git\+([a-z][a-z0-9+.-]*:\/\/[^@\s]+)@([0-9a-f]{40})$/i;

/** The uv on this computer, or null when it is not one this Crow may run. */
function defaultResolveUv() {
  try {
    const rc = resolveAddonCommand("uv");
    return rc && rc.missing !== true && typeof rc.command === "string" ? rc.command : null;
  } catch {
    return null;
  }
}

/** The host a git ref fetches from, or null when the ref is not a `git+` source. */
function gitRefHost(ref) {
  if (typeof ref !== "string" || !ref.toLowerCase().startsWith("git+")) return null;
  const match = GIT_REF_RE.exec(ref);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return String(url.hostname || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** A git source this computer cannot prepare (no uv, or no data folder to build in). */
const GIT_PREP_REASON = "its git source cannot be prepared here";

/** True when the ref is a `git+` source at all, whether or not it parses. */
function isGitRef(ref) {
  return typeof ref === "string" && ref.toLowerCase().startsWith("git+");
}

/** The `--quiet` tail a uv step keeps when the launcher had it. */
function quietOf(list) {
  return list.includes("--quiet") || list.includes("-q") ? ["--quiet"] : [];
}

/**
 * The steps that fill an add-on's cache, the hosts they may reach, and the fixed
 * settings their env carries, or null when there is nothing to prepare.
 *
 * Every step must exit 0, in the order given.
 *
 * A plan this module will not build is answered, not thrown: `{ refused }`
 * carries the reason the add-on stays off.
 *
 * `command` in each step is the launcher ALREADY resolved by the caller (the
 * verified real path), so the prepare run reaches the same binary the add-on
 * will.
 *
 * @param {object} o
 * @param {string} o.command
 * @param {string[]} [o.args]
 * @param {string} [o.installDir]  the add-on's own folder (a uv project)
 * @param {string} [o.nodeBin]     the gateway's node (npm is looked for beside it)
 * @param {() => (string|null)} [o.resolveUv]
 * @returns {{steps: {command: string, args: string[]}[], hosts: string[], env: object}|{refused: string}|null}
 */
export function warmupPlanFor({ command, args, installDir, dataDir, nodeBin = process.execPath, resolveUv } = {}) {
  if (typeof command !== "string" || !command) return null;
  const list = Array.isArray(args) ? args.map(String) : [];
  const launcher = basename(command);

  let read;
  try {
    read = launcherSpec(command, list);
  } catch (err) {
    // The one reader both this and the pin use refused the arguments.
    if (err instanceof PinRefused) return { refused: err.message };
    throw err;
  }

  if (launcher === "uv" && list.includes("run")) {
    const quiet = quietOf(list);
    // Step 1 takes every dependency from a pre-built wheel: --no-build stops uv
    // building a source distribution, which would run that package's build
    // backend. A dependency that has ONLY a source distribution fails here, and
    // the add-on stays off rather than build third-party code.
    // Step 2 may build the add-on's OWN project (the code it ships): that build
    // is the add-on's own, and it still reaches the registries only.
    return {
      steps: [
        { command, args: ["sync", "--no-build", "--no-install-project", ...quiet] },
        { command, args: ["sync", ...quiet] },
      ],
      hosts: [...PYPI_HOSTS],
      env: {},
    };
  }

  if (read.launcher === "uvx") {
    const ref = read.from ?? read.spec;
    if (ref === null) return null;
    if (isGitRef(ref)) {
      const host = gitRefHost(ref);
      // A pinned git source must be built: it is the add-on's own pinned code,
      // so this step does not carry --no-build.
      if (host !== GIT_HUB) return { refused: OTHER_SOURCE_REASON };
      // uv has no "build only this one package" switch: --no-build and
      // --only-binary :all: refuse the git source too. So the pinned git package
      // (the add-on's own code) is built ALONE first (--no-deps, into a scratch
      // venv in the add-on's own data folder), which leaves its wheel in the
      // cache; then the real resolve runs with --no-build, so every dependency
      // must be a wheel and one that needs a source build is refused.
      // Residual: the git package's own build-backend requirements are
      // installed into uv's isolated build env the usual way.
      const uv = typeof resolveUv === "function" ? resolveUv() : defaultResolveUv();
      // The data folder is bound at its real path inside the wall.
      let dir = null;
      if (typeof dataDir === "string" && dataDir.startsWith("/")) {
        try { dir = realpathSync(dataDir); } catch { dir = null; }
      }
      if (!uv || !dir) return { refused: GIT_PREP_REASON };
      const venv = join(dir, ".cache", "crow-warm-venv");
      return {
        steps: [
          { command: uv, args: ["venv", "--quiet", "--allow-existing", venv] },
          { command: uv, args: ["pip", "install", "--quiet", "--python", join(venv, "bin", "python"), "--no-deps", ref] },
          { command, args: ["--no-build", "--from", ref, "python", "-c", "0"] },
        ],
        hosts: [...PYPI_HOSTS, ...GIT_HOSTS],
        env: {},
      };
    }
    // A PyPI tool: no build, so no third-party build script runs.
    return {
      steps: [{ command, args: ["--no-build", "--from", ref, "python", "-c", "0"] }],
      hosts: [...PYPI_HOSTS],
      env: {},
    };
  }

  if (read.launcher === "npx") {
    const pkg = read.spec;
    if (pkg === null) return null;
    return {
      steps: [{
        command: join(dirname(nodeBin), "npm"),
        args: ["exec", "--yes", "--ignore-scripts", `--package=${pkg}`, "--", nodeBin, "-e", "0"],
      }],
      hosts: [...NPM_HOSTS],
      env: { npm_config_ignore_scripts: "true" },
    };
  }

  // Anything else: only a uv project with a lock file has a cache to fill, and
  // it is prepared by the two uv steps above.
  if (typeof installDir !== "string" || !installDir) return null;
  const hasProject = existsSync(join(installDir, "pyproject.toml"));
  const hasLock = existsSync(join(installDir, "uv.lock"));
  if (!hasProject || !hasLock) return null;
  const uv = typeof resolveUv === "function" ? resolveUv() : defaultResolveUv();
  if (typeof uv !== "string" || !uv) return null;
  return {
    steps: [
      { command: uv, args: ["sync", "--no-build", "--no-install-project", "--quiet"] },
      { command: uv, args: ["sync", "--quiet"] },
    ],
    hosts: [...PYPI_HOSTS],
    env: {},
  };
}

/** One prepare run's key: the same plan in the same folder is the same run. */
function warmKey(kind, id, plan, installDir) {
  const digest = createHash("sha256")
    .update(JSON.stringify([plan.steps, plan.hosts, plan.env, installDir ?? null]))
    .digest("hex");
  return `${kind}:${id}:${digest}`;
}

/** The prepared runs this process remembers (one gateway's lifetime). */
const warmed = new Set();

/** Tests, and a simulated restart: forget every prepared key. */
export function _resetWarmupsForTest() {
  warmed.clear();
}

/** The refusal shape: the add-on stays off, and a card can be raised from it. */
function refusedResult(err) {
  const reason = err && typeof err.message === "string" && err.message ? err.message : "the warm-up could not run";
  // The refusal's own code (`installed-changed`) travels on, so the card names that rule.
  const code = err && typeof err.code === "string" && err.code ? err.code : null;
  return { ok: false, refused: true, code, reason, exitCode: null, stderrLines: [], denials: [] };
}

/**
 * A plan this module would not build: the reason, and nothing ran. It carries the
 * warm-up's own code, so the card reads the warm-up reason rather than a wall the
 * add-on never asked for.
 */
function planRefused(reason) {
  return { ok: false, refused: true, code: "warmup", reason, exitCode: null, stderrLines: [], denials: [] };
}

/**
 * The spawn's stdio layout, from the wall's extra fds, exactly as the add-on's
 * own transport lays it out: an fd entry is passed, a "read" pipe is taken, a
 * "write" pipe is filled once and ended.
 */
function stdioFrom(wall) {
  const stdio = ["ignore", "ignore", "pipe"];
  const writes = [];
  for (const spec of Array.isArray(wall.stdioExtra) ? wall.stdioExtra : []) {
    if (!spec || typeof spec !== "object") continue;
    const childFd = Number(spec.childFd);
    if (!Number.isInteger(childFd) || childFd < 3) continue;
    while (stdio.length < childFd) stdio.push("ignore");
    if (Number.isInteger(spec.fd)) stdio[childFd] = spec.fd;
    else if (spec.pipe === "read") stdio[childFd] = "pipe";
    else if (spec.pipe === "write") {
      stdio[childFd] = "pipe";
      writes.push({ childFd, data: spec.data });
    }
  }
  return { stdio, writes };
}

/**
 * Run one step inside its wall: spawn it, keep its last stderr lines, kill it
 * when it overruns, and report what it did.
 */
async function runStep(wall, spawnFn, timeoutMs) {
  const { stdio, writes } = stdioFrom(wall);
  const tail = [];
  let pendingLine = "";
  const keepLine = (line) => {
    tail.push(String(line).slice(0, STDERR_LINE_MAX));
    while (tail.length > STDERR_LINES_KEPT) tail.shift();
  };
  const onStderr = (chunk) => {
    pendingLine += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    let nl;
    while ((nl = pendingLine.indexOf("\n")) >= 0) {
      const line = pendingLine.slice(0, nl).replace(/\r$/, "");
      pendingLine = pendingLine.slice(nl + 1);
      keepLine(line);
    }
    // A line that never ends must not grow without bound.
    if (pendingLine.length > STDERR_LINE_MAX * 4) pendingLine = pendingLine.slice(-STDERR_LINE_MAX);
  };

  let child = null;
  let timedOut = false;
  const minutes = Math.max(1, Math.round(Number(timeoutMs) / 60_000));
  let timer = null;
  const exit = new Promise((resolve) => {
    try {
      child = spawnFn(wall.cmd, wall.args, {
        env: wall.env,
        cwd: "/",
        stdio,
        detached: false,
        shell: false,
      });
    } catch (err) {
      resolve({ code: null, error: true, message: err?.message });
      return;
    }
    child.on("error", (err) => resolve({ code: null, error: true, message: err?.message }));
    child.on("close", (code) => resolve({ code: Number.isInteger(code) ? code : null }));
    child.stderr?.on("data", onStderr);
    for (const { childFd, data } of writes) {
      const stream = child.stdio?.[childFd];
      if (!stream) continue;
      stream.on("error", () => { /* the child may be gone already */ });
      stream.end(data == null ? "" : String(data));
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS);
    timer.unref?.();
  });

  // The child holds the fds now; the gateway's copies go immediately.
  for (const spec of Array.isArray(wall.stdioExtra) ? wall.stdioExtra : []) {
    if (!spec || !Number.isInteger(spec.fd)) continue;
    const fd = spec.fd;
    spec.fd = null;
    try { closeSync(fd); } catch { /* already closed */ }
  }

  const outcome = await exit;
  if (timer) clearTimeout(timer);
  if (pendingLine) { keepLine(pendingLine); }

  const denials = typeof wall.relay?.denials === "function" ? wall.relay.denials() || [] : [];
  const stderrLines = tail.slice();

  if (timedOut) {
    return {
      ok: false,
      reason: `took longer than ${minutes} minute${minutes === 1 ? "" : "s"}`,
      exitCode: null,
      stderrLines,
      denials,
    };
  }
  if (outcome.error || outcome.code !== 0) {
    return {
      ok: false,
      reason: outcome.error
        ? `the prepare run could not start${outcome.message ? ` (${outcome.message})` : ""}`
        : `the prepare run stopped with exit code ${outcome.code}`,
      exitCode: outcome.code,
      stderrLines,
      denials,
    };
  }
  return { ok: true };
}

/**
 * Run the prepare steps inside walls, in order, once.
 *
 * Every step gets its own wall (one purpose, one host list, one cleanup) and
 * the first step that fails ends the run. The wall's own env is the plan's, so
 * a caller cannot hand the warm-up the add-on's credentials: an `ownEnv`
 * argument is ignored.
 *
 * @param {object} o
 * @param {string} o.id
 * @param {"addon"|"service"|"builtin"} [o.kind]
 * @param {object} [o.entry]
 * @param {string} o.command          the resolved launcher
 * @param {string[]} [o.args]
 * @param {string} [o.installDir]
 * @param {string} [o.nodeBin]
 * @param {{startAddonWall: Function}} o.wallCtx
 * @param {object} [o.baseEnv]        the gateway's env (read only through the wall's allowlist)
 * @param {number} [o.timeoutMs]
 * @param {object} [o.deps]           test seams: spawn, now
 * @returns {Promise<object>} { ok: true, skipped? } | { ok: false, reason, refused?, exitCode, stderrLines, denials }
 */
export async function warmAddon({
  id,
  kind = "addon",
  entry,
  command,
  args,
  installDir,
  dataDir,
  nodeBin = process.execPath,
  wallCtx,
  baseEnv = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deps = {},
} = {}) {
  const seam = deps && typeof deps === "object" ? deps : {};
  const spawnFn = typeof seam.spawn === "function" ? seam.spawn : spawnChild;
  let plan;
  try {
    plan = warmupPlanFor({ command, args, installDir, dataDir, nodeBin, resolveUv: seam.resolveUv });
  } catch (err) {
    const reason = err && typeof err.message === "string" && err.message ? err.message : "the warm-up could not be planned";
    return { ok: false, reason, exitCode: null, stderrLines: [], denials: [] };
  }
  if (!plan) return { ok: true, skipped: "nothing to prepare" };
  if (typeof plan.refused === "string" && plan.refused) return planRefused(plan.refused);
  const key = warmKey(kind, id, plan, installDir);
  if (warmed.has(key)) return { ok: true, skipped: "ready" };

  for (const step of plan.steps) {
    let wall = null;
    try {
      wall = await wallCtx.startAddonWall({
        id,
        entry,
        command: step.command,
        args: step.args,
        baseEnv,
        // The plan's fixed settings only: never the add-on's own env.
        ownEnv: { ...plan.env },
        kind,
        purpose: "warmup",
        warmupHosts: [...plan.hosts],
      });
    } catch (err) {
      // A wall this prepare run may not have is a refusal, never a weaker run.
      return refusedResult(err);
    }

    if (!wall || wall.walled !== true) {
      // The one tier that is a wall is the only one a prepare run may use: a
      // weaker tier would write the cache outside the wall's folder.
      try { wall?.cleanup?.(); } catch { /* nothing left to close */ }
      return { ok: true, skipped: "not walled" };
    }

    let outcome;
    try {
      outcome = await runStep(wall, spawnFn, timeoutMs);
    } catch (err) {
      const reason = err && typeof err.message === "string" && err.message ? err.message : "the warm-up could not run";
      outcome = { ok: false, reason, exitCode: null, stderrLines: [], denials: [] };
    } finally {
      try { wall.cleanup?.(); } catch { /* nothing left to close */ }
    }

    if (!outcome.ok) return outcome;
  }

  warmed.add(key);
  return { ok: true };
}