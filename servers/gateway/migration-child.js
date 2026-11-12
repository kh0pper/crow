// servers/gateway/migration-child.js
//
// Run the migration registry in a FRESH child process.
//
// Convergence is the one path that migrates from a long-running process: the
// gateway pulled an update and now has to apply that update's migrations to its
// own store. Doing it in-process is unsafe — ESM caches a module by URL, so a
// migration pulled in the same update that statically imports a shared module
// the gateway already loaded links against the OLD namespace and fails with
// "does not provide an export named X", on every tick, forever, because the
// process never restarts. A child starts with an empty module graph and reads
// the tree as it is on disk now.
//
// The boot paths (the gateway's own boot and the post-listen boot step) already
// run in a fresh process and must keep calling runMigrations directly.
//
// The child's stdout is NDJSON: {"log"}, then exactly one of {"result"} or
// {"error"}. The child points console.log/info/debug at stderr before it starts
// the runner, so a migration that logs with console.* never reaches this
// stream; a migration that writes to process.stdout directly is not blocked, so
// every line's shape is checked here as well — a result needs all four arrays, an
// error needs a string. A line that looks like protocol but does not have the
// shape is a stray line and is ignored, like anything else on stdout.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A migration run is bounded so a wedged child can never hold the update tick
 *  for ever; the child applies the registry only (init-db runs in the parent's
 *  schema pre-flight). Ten minutes is ample for the per-item INSERT … SELECT
 *  migrations this registry carries, and an operator can raise the bound on a
 *  host that needs longer with CROW_MIGRATION_CHILD_TIMEOUT_MS (milliseconds),
 *  without a code change. */
export const MIGRATION_CHILD_TIMEOUT_MS = 10 * 60 * 1000;

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo's own copy, resolved from this file: in a live install that is the
 *  freshly pulled tree, which is exactly what has to be exercised. */
export function defaultMigrationChildScript() {
  return join(HERE, "..", "..", "scripts", "migrations", "run-child.mjs");
}

/** The bound for one run: an explicit option wins, then the operator's env
 *  override when it is a positive whole number of milliseconds, then the
 *  built-in default. Read per call, so a host can be unstuck without a restart. */
export function resolveMigrationTimeoutMs(explicit, env = process.env) {
  if (explicit !== undefined && explicit !== null) return explicit;
  const raw = String(env?.CROW_MIGRATION_CHILD_TIMEOUT_MS ?? "").trim();
  const n = Number(raw);
  if (raw !== "" && Number.isInteger(n) && n > 0) return n;
  return MIGRATION_CHILD_TIMEOUT_MS;
}

/** "<N> s" for an error message, without turning 700 ms into "1". */
function seconds(ms) {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : String(Number(s.toFixed(1)));
}

const RESULT_ARRAYS = ["applied", "skipped", "deferred", "newlyDeferred"];

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A result line only counts with all four arrays: anything else on stdout is a
 *  stray line, not this protocol. */
function isResult(value) {
  return isPlainObject(value) && RESULT_ARRAYS.every((k) => Array.isArray(value[k]));
}

/**
 * `runMigrations` in a child process, with the same contract: resolves with
 * `{ applied, skipped, deferred, newlyDeferred }`, rejects with the migration's
 * OWN error message (so the caller's "Update error: ..." text reads as before).
 *
 * An older tree has no run-child.mjs; then — and only then — this falls back to
 * the in-process runner, which is no worse than the behaviour it replaced, and
 * says so in the log.
 *
 * The child is killed on every rejection: a timed-out or failed run must never
 * leave a process behind holding the store. A child that reports success but
 * does not exit (a migration left a timer or a socket open) gets `graceMs` to go
 * on its own and is then SIGKILLed, so ticks cannot accumulate live children.
 *
 * @returns {Promise<{applied: string[], skipped: string[], deferred: string[], newlyDeferred: string[]}>}
 */
export async function runMigrationsInChild({
  migrationsDir,
  dbPath,
  tasksDbPath,
  sha = null,
  log = () => {},
  timeoutMs = undefined,
  graceMs = 5000,
  scriptPath = defaultMigrationChildScript(),
} = {}) {
  const script = scriptPath || defaultMigrationChildScript();
  if (!existsSync(script)) {
    log(`no migration child script at ${script} (tree predates it) — falling back to in-process migrations`);
    const { runMigrations } = await import("../../scripts/migrations/runner.mjs");
    return runMigrations({ migrationsDir, dbPath, tasksDbPath, sha, log });
  }

  const limitMs = resolveMigrationTimeoutMs(timeoutMs);
  const payload = JSON.stringify({ migrationsDir, dbPath, tasksDbPath, sha });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [script, payload], {
        env: process.env, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new Error(`migration process failed to start: ${err?.message || err}`));
      return;
    }

    const MAX_STDERR = 4 * 1024 * 1024;
    let settled = false;
    let stdoutBuf = "";
    let stderrTail = "";
    let timer = null;
    let graceTimer = null;
    let closed = false;

    const killChild = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const clearGrace = () => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
    };
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        clearGrace();
        killChild();
        reject(err);
        return;
      }
      resolve(val);
    };

    /** After the result line: the child should exit by itself; if it does not,
     *  SIGKILL it. The timer is unref'd — it must never keep the gateway awake. */
    const reapAfterResult = () => {
      clearGrace();
      if (closed) return; // it is gone: nothing to reap
      graceTimer = setTimeout(killChild, graceMs);
      if (typeof graceTimer.unref === "function") graceTimer.unref();
    };

    /** One NDJSON object. Returns true when it settled the promise. */
    const consume = (line) => {
      const text = line.trim();
      if (!text) return false;
      let obj;
      try { obj = JSON.parse(text); } catch { return false; } // never trust a stray line
      if (!obj || typeof obj !== "object") return false;
      if (typeof obj.log === "string") { log(obj.log); return false; }
      if ("error" in obj) {
        if (typeof obj.error !== "string") return false; // not this protocol
        // The migration's own message, unchanged — the caller wraps it textually.
        done(new Error(obj.error));
        return true;
      }
      if ("result" in obj) {
        if (!isResult(obj.result)) return false; // a stray line that merely looks like one
        done(null, obj.result);
        reapAfterResult();
        return true;
      }
      return false;
    };

    timer = setTimeout(() => {
      done(new Error(`migration process timed out after ${seconds(limitMs)} s`));
    }, limitMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      stdoutBuf += chunk;
      let i;
      while ((i = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (consume(line) || settled) return;
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-MAX_STDERR);
    });
    child.on("error", (err) => {
      done(new Error(`migration process failed to start: ${err?.message || err}`));
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearGrace();
      if (settled) return;
      // A last line the child wrote without a trailing newline still counts.
      if (consume(stdoutBuf) || settled) return;
      stdoutBuf = "";
      const tail = stderrTail.trim().slice(-400);
      done(new Error(`migration process exited ${code ?? signal}: ${tail}`));
    });
  });
}
