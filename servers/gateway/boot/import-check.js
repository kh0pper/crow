/**
 * The gateway's import check (audit N1c-3, Layer 0).
 *
 * servers/gateway/index.js has a seam as its first body statement: with
 * CROW_GATEWAY_IMPORT_CHECK=1 it prints a token and exits 0. Every module in the
 * STATIC import graph is evaluated before that statement, so "exit 0 with the
 * token on stdout" is proof that the whole graph loads in this checkout.
 *
 * That is the one crash a healthy process can predict about a sha it has not
 * restarted into: the puller runs the check before init-db, and every co-hosted
 * peer runs it before its own migrations and restart. A graph that throws while
 * loading is then rolled back instead of being booted in a crash loop under
 * systemd.
 *
 * The child gets the ORIGINAL environment (see ORIGINAL_ENV in
 * ./satellite-profile-guard.js), never process.env: the boot gate fills
 * process.env from the checkout .env and pins CROW_DATA_DIR, so an inherited
 * env would answer the instance-paths gate differently from the instance the
 * operator configured (S1). /proc/self/environ is the fallback because it is the
 * exec-time environment, immune to later edits of process.env.
 *
 * The check reaches only the STATIC graph. ~40 dynamic imports (the boot mounts,
 * schema-version, convergence) sit behind the seam and are not covered; the boot
 * guard is the backstop for those.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGINAL_ENV } from "./satellite-profile-guard.js";

/** Read by the seam in index.js. */
export const IMPORT_CHECK_ENV = "CROW_GATEWAY_IMPORT_CHECK";
/** Only printed once the whole static graph has loaded. */
export const IMPORT_CHECK_TOKEN = "crow-gateway-import-ok";
export const IMPORT_CHECK_TIMEOUT_MS = 60 * 1000;
/**
 * The seam STATEMENT, not the name: index.js discusses the name in comments and
 * a future commit could keep the comment while moving the body statement
 * further down — a name-only match would then spawn a full gateway (with the
 * live DB and its listeners) instead of a load test (S3).
 */
export const IMPORT_CHECK_SEAM_RE = /process\.env\.CROW_GATEWAY_IMPORT_CHECK\s*===\s*"1"/;

/** git with the tree's own hooks out of the picture (live installs point
 *  core.hooksPath INTO the checkout). */
const GIT_HOOKS_OFF = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

let _envOverride = null;
/** Test-only: substitute the environment the child would start from. */
export function _setOriginalEnvForTest(env) { _envOverride = env; }

/**
 * The environment to spawn the check child with — the pre-gate one.
 *
 * PRIMARY: the frozen snapshot taken by the first module the graph evaluates.
 * FALLBACK: /proc/self/environ, which is untouched by process.env edits (it is
 * the exec-time block). Linux only; elsewhere the frozen snapshot is all we have.
 */
export function originalEnv() {
  if (_envOverride) return { ..._envOverride };
  const snapshot = ORIGINAL_ENV && typeof ORIGINAL_ENV === "object" ? ORIGINAL_ENV : {};
  if (Object.keys(snapshot).length > 0) return { ...snapshot };
  try {
    const out = {};
    for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
      if (!entry) continue;
      const i = entry.indexOf("=");
      if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
    }
    if (Object.keys(out).length > 0) return out;
  } catch { /* not Linux, or /proc not mounted */ }
  return { ...process.env };
}

/**
 * Does the pulled tree carry the seam? Read from the COMMIT (git show
 * HEAD:servers/gateway/index.js), not the working file: the reset that follows a
 * failed check rewrites the worktree, and a stray local edit must never decide
 * whether a sha can answer the check. Falls back to the working file when this
 * is not a git checkout at all.
 *
 * A sha pulled from before the seam existed has no way to answer the check, and
 * running its gateway anyway would START a full server (S2), so the check is
 * SKIPPED and only logged there.
 */
export function hasImportCheckSeam(appRoot, { execFileSyncImpl = execFileSync } = {}) {
  let src = null;
  try {
    src = String(execFileSyncImpl("git", [...GIT_HOOKS_OFF, "show", `HEAD:servers/gateway/index.js`], {
      cwd: appRoot, stdio: ["ignore", "pipe", "ignore"], timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    }));
  } catch { /* not a git checkout, or no such blob */ }
  if (typeof src !== "string") {
    try { src = readFileSync(join(appRoot, "servers", "gateway", "index.js"), "utf8"); } catch { return false; }
  }
  return IMPORT_CHECK_SEAM_RE.test(src);
}

/**
 * Spawn `node servers/gateway/index.js` with the check env and judge it.
 *
 * Pass requires BOTH exit 0 and the token: a sha could exit 0 without ever
 * reaching the seam (an early `process.exit(0)` above it), and a token without
 * exit 0 means the graph threw after printing — neither proves a clean load.
 *
 * The child is DETACHED so it leads its own process group, and the deadline
 * kills the whole group. A graph that spawns a grandchild inheriting stdout
 * would otherwise (a) turn a clean exit into a reported timeout, because the
 * parent's pipe only closes when the last holder does, and (b) leak that
 * grandchild past the check. Group-killed, the same fixture is a plain timeout
 * with nothing left running.
 *
 * @returns {Promise<{ok:boolean, exitCode:number|null, timedOut:boolean,
 *   token:boolean, stderr:string}>} never rejects
 */
export function runImportCheck({
  appRoot, env = null, timeoutMs = IMPORT_CHECK_TIMEOUT_MS, spawnImpl = spawn,
} = {}) {
  const childEnv = { ...(env || originalEnv()), [IMPORT_CHECK_ENV]: "1" };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [join("servers", "gateway", "index.js")], {
        cwd: appRoot, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, exitCode: null, timedOut: false, token: false, stderr: String(err?.message || err) });
      return;
    }
    const MAX = 4 * 1024 * 1024;
    let out = "";
    let errOut = "";
    let timedOut = false;
    let done = false;
    let timer = null;

    /** Kill the whole group: the child AND anything it spawned. */
    const killGroup = () => {
      try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* not a group leader (or not POSIX) */ }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Even on a clean exit: a grandchild that inherited the pipes must not
      // outlive the check.
      killGroup();
      resolve(result);
    };
    timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      // If a grandchild somehow keeps the pipes open, never hang the tick.
      setTimeout(() => finish({
        ok: false, exitCode: null, timedOut: true, token: out.includes(IMPORT_CHECK_TOKEN),
        stderr: String(errOut || "").slice(-2000),
      }), 2000).unref();
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => { if (out.length < MAX) out += d; });
    child.stderr?.on("data", (d) => { if (errOut.length < MAX) errOut += d; });
    child.on("error", (err) => {
      finish({
        ok: false, exitCode: null, timedOut, token: false,
        stderr: `${errOut}${String(err?.message || err)}`.slice(-2000),
      });
    });
    child.on("close", (code, signal) => {
      const token = out.includes(IMPORT_CHECK_TOKEN);
      finish({
        ok: !timedOut && code === 0 && !signal && token,
        exitCode: timedOut ? null : (typeof code === "number" ? code : null),
        timedOut,
        token,
        stderr: String(errOut || "").slice(-2000),
      });
    });
  });
}

/**
 * Seam check + run, the shape both callers want.
 *
 * `reason` is what the quarantine marker records: a timeout is transient (6 h
 * TTL), a clean failure is not (it waits for main to move). A failed npm
 * install never reaches this function: the puller rolls back on its own exit
 * code first, with `deps-failed`.
 *
 * @returns {Promise<{ok?:boolean, skipped?:string, reason?:string, detail?:object}>}
 */
export async function checkTreeImport({ appRoot, ...opts } = {}) {
  if (!hasImportCheckSeam(appRoot)) return { skipped: "no-seam" };
  const r = await runImportCheck({ appRoot, ...opts });
  if (r.ok) return { ok: true, detail: r };
  return { ok: false, reason: r.timedOut ? "import-timeout" : "import-check", detail: r };
}