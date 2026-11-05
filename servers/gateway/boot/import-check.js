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
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGINAL_ENV } from "./satellite-profile-guard.js";

/** Read by the seam in index.js. */
export const IMPORT_CHECK_ENV = "CROW_GATEWAY_IMPORT_CHECK";
/** Only printed once the whole static graph has loaded. */
export const IMPORT_CHECK_TOKEN = "crow-gateway-import-ok";
export const IMPORT_CHECK_TIMEOUT_MS = 60 * 1000;

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
 * Does the tree on disk carry the seam? A sha pulled from before the seam
 * existed has no way to answer the check, and running its gateway anyway would
 * start a full server (S2), so the check is SKIPPED and only logged there.
 */
export function hasImportCheckSeam(appRoot) {
  try {
    return readFileSync(join(appRoot, "servers", "gateway", "index.js"), "utf8").includes(IMPORT_CHECK_ENV);
  } catch {
    return false;
  }
}

/**
 * Spawn `node servers/gateway/index.js` with the check env and judge it.
 *
 * Pass requires BOTH exit 0 and the token: a sha could exit 0 without ever
 * reaching the seam (an early `process.exit(0)` above it), and a token without
 * exit 0 means the graph threw after printing — neither proves a clean load.
 *
 * @returns {Promise<{ok:boolean, exitCode:number|null, timedOut:boolean,
 *   token:boolean, stderr:string}>} never rejects
 */
export function runImportCheck({
  appRoot, env = null, timeoutMs = IMPORT_CHECK_TIMEOUT_MS, execFileImpl = execFile,
} = {}) {
  const childEnv = { ...(env || originalEnv()), [IMPORT_CHECK_ENV]: "1" };
  return new Promise((resolve) => {
    execFileImpl(
      process.execPath,
      [join("servers", "gateway", "index.js")],
      { cwd: appRoot, env: childEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || "");
        const token = out.includes(IMPORT_CHECK_TOKEN);
        const timedOut = Boolean(err && (err.killed || err.signal));
        resolve({
          ok: !err && token,
          exitCode: err ? (typeof err.code === "number" ? err.code : null) : 0,
          timedOut,
          token,
          stderr: String(stderr || "").slice(-2000),
        });
      },
    );
  });
}

/**
 * Seam check + run, the shape both callers want.
 *
 * `reason` is what the quarantine marker records: a timeout is transient (6 h
 * TTL), a clean failure is not (it waits for main to move).
 *
 * @returns {Promise<{ok?:boolean, skipped?:string, reason?:string, detail?:object}>}
 */
export async function checkTreeImport({ appRoot, ...opts } = {}) {
  if (!hasImportCheckSeam(appRoot)) return { skipped: "no-seam" };
  const r = await runImportCheck({ appRoot, ...opts });
  if (r.ok) return { ok: true, detail: r };
  return { ok: false, reason: r.timedOut ? "import-timeout" : "import-check", detail: r };
}