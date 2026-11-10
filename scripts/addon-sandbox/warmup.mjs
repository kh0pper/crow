/**
 * The one prepare run an add-on gets before its first real start.
 *
 * An `npx`/`uvx`/`uv run` add-on fetches its own code from a registry the first
 * time it starts, which is exactly what a walled child cannot do quietly: its
 * cache lives inside its own data folder, and the run has to finish before the
 * add-on is worth starting. So the gateway warms the cache ONCE, inside the
 * same wall the add-on will run in (internet only, no hosts, no doors), and
 * then remembers that it did: a second connect for the same command line and
 * install folder is a no-op.
 *
 * Two rules:
 *  - the warm-up never throws. Its result is data (`ok`, a reason, the child's
 *    last stderr lines, the relay's denials), so a caller can leave the add-on
 *    off and raise one card from it.
 *  - the warm-up plans nothing it cannot name exactly: an entry with no
 *    launcher to warm (`node server/index.js`) or a uv project with no lock
 *    file returns null, and the caller then does what it did before.
 *
 * Node built-ins only; the spawn and the clock are test seams.
 */
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { resolveAddonCommand } from "../../servers/shared/resolve-command.js";

/** How much of one stderr line a warm-up result keeps. */
const STDERR_LINE_MAX = 300;
/** How many stderr lines it keeps. */
const STDERR_LINES_KEPT = 20;
/** The default prepare timeout: ten minutes, not the 60 s connect cap. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** The uv on this computer, or null when it is not one this Crow may run. */
function defaultResolveUv() {
  try {
    const rc = resolveAddonCommand("uv");
    return rc && rc.missing !== true && typeof rc.command === "string" ? rc.command : null;
  } catch {
    return null;
  }
}

/** The first argument of a launcher that is not an option. */
function firstPositional(args) {
  for (const a of args) {
    if (typeof a !== "string") continue;
    if (a.startsWith("-") && a !== "-") continue;
    return a;
  }
  return null;
}

/** The `--from` value of a uvx argument list, or null. */
function fromValue(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from") return typeof args[i + 1] === "string" ? args[i + 1] : null;
    if (a.startsWith("--from=")) return a.slice("--from=".length);
  }
  return null;
}

/**
 * The command line that fills an add-on's cache, or null when there is nothing
 * to prepare.
 *
 * `command` is the launcher ALREADY resolved by the caller (the verified real
 * path), so the prepare run reaches the same binary the add-on will.
 *
 * @param {object} o
 * @param {string} o.command
 * @param {string[]} [o.args]
 * @param {string} [o.installDir]  the add-on's own folder (a uv project)
 * @param {string} [o.nodeBin]     the gateway's node (npm is looked for beside it)
 * @param {() => (string|null)} [o.resolveUv]
 * @returns {{command: string, args: string[]}|null}
 */
export function warmupPlanFor({ command, args, installDir, nodeBin = process.execPath, resolveUv } = {}) {
  if (typeof command !== "string" || !command) return null;
  const list = Array.isArray(args) ? args.map(String) : [];
  const launcher = basename(command);

  if (launcher === "uv" && list.includes("run")) {
    return { command, args: ["sync", ...(list.includes("--quiet") ? ["--quiet"] : [])] };
  }

  if (launcher === "uvx") {
    const ref = fromValue(list) ?? firstPositional(list);
    if (ref === null) return null;
    return { command, args: ["--from", ref, "python", "-c", "0"] };
  }

  if (launcher === "npx") {
    const pkg = firstPositional(list);
    if (pkg === null) return null;
    return {
      command: join(dirname(nodeBin), "npm"),
      args: ["exec", "--yes", `--package=${pkg}`, "--", nodeBin, "-e", "0"],
    };
  }

  // Anything else: only a uv project with a lock file has a cache to fill.
  if (typeof installDir !== "string" || !installDir) return null;
  const hasProject = existsSync(join(installDir, "pyproject.toml"));
  const hasLock = existsSync(join(installDir, "uv.lock"));
  if (!hasProject || !hasLock) return null;
  const uv = typeof resolveUv === "function" ? resolveUv() : defaultResolveUv();
  if (typeof uv !== "string" || !uv) return null;
  return { command: uv, args: ["sync", "--quiet"] };
}

/** One prepare run's key: the same command line in the same folder is the same run. */
function warmKey(kind, id, plan, installDir) {
  const digest = createHash("sha256")
    .update(JSON.stringify([plan.command, plan.args, installDir ?? null]))
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
 * Run the prepare command line inside the wall, once.
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
 * @param {object} [o.ownEnv]
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
  nodeBin = process.execPath,
  wallCtx,
  baseEnv = process.env,
  ownEnv = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deps = {},
} = {}) {
  const seam = deps && typeof deps === "object" ? deps : {};
  const spawnFn = typeof seam.spawn === "function" ? seam.spawn : spawnChild;
  const plan = warmupPlanFor({ command, args, installDir, nodeBin });
  if (!plan) return { ok: true, skipped: "nothing to prepare" };
  const key = warmKey(kind, id, plan, installDir);
  if (warmed.has(key)) return { ok: true, skipped: "ready" };

  let wall = null;
  try {
    wall = await wallCtx.startAddonWall({
      id,
      entry,
      command: plan.command,
      args: plan.args,
      baseEnv,
      ownEnv,
      kind,
      purpose: "warmup",
    });
  } catch (err) {
    // A wall this prepare run may not have is a refusal, never a weaker run.
    return refusedResult(err);
  }

  try {
    // The one tier that is a wall is the only one a prepare run may use: a
    // weaker tier would write the cache outside the wall's folder.
    if (!wall || wall.walled !== true) return { ok: true, skipped: "not walled" };

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

    const tail = [];
    let pendingLine = "";
    const keepLine = (line) => {
      const text = String(line).slice(0, STDERR_LINE_MAX);
      tail.push(text);
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
    if (pendingLine) { keepLine(pendingLine); pendingLine = ""; }

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
    warmed.add(key);
    return { ok: true };
  } catch (err) {
    const reason = err && typeof err.message === "string" && err.message ? err.message : "the warm-up could not run";
    return { ok: false, reason, exitCode: null, stderrLines: [], denials: [] };
  } finally {
    try { wall?.cleanup?.(); } catch { /* nothing left to close */ }
  }
}