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
// {"error"}. Only that is parsed; anything else on stdout is ignored.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A migration run is bounded: a wedged child must never hold the update tick
 *  forever (a guarded SCHEMA_GENERATION pass on a large store is the slow end). */
export const MIGRATION_CHILD_TIMEOUT_MS = 10 * 60 * 1000;

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo's own copy, resolved from this file: in a live install that is the
 *  freshly pulled tree, which is exactly what has to be exercised. */
export function defaultMigrationChildScript() {
  return join(HERE, "..", "..", "scripts", "migrations", "run-child.mjs");
}

const emptyResult = () => ({ applied: [], skipped: [], deferred: [], newlyDeferred: [] });

/** "<N> s" for an error message, without turning 700 ms into "1". */
function seconds(ms) {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : String(Number(s.toFixed(1)));
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
 * leave a process behind holding the store.
 *
 * @returns {Promise<{applied: string[], skipped: string[], deferred: string[], newlyDeferred: string[]}>}
 */
export async function runMigrationsInChild({
  migrationsDir,
  dbPath,
  tasksDbPath,
  sha = null,
  log = () => {},
  timeoutMs = MIGRATION_CHILD_TIMEOUT_MS,
  scriptPath = defaultMigrationChildScript(),
} = {}) {
  const script = scriptPath || defaultMigrationChildScript();
  if (!existsSync(script)) {
    log(`no migration child script at ${script} (tree predates it) — falling back to in-process migrations`);
    const { runMigrations } = await import("../../scripts/migrations/runner.mjs");
    return runMigrations({ migrationsDir, dbPath, tasksDbPath, sha, log });
  }

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
    let result = null;
    let stdoutBuf = "";
    let stderrTail = "";
    let timer = null;

    const killChild = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        killChild();
        reject(err);
        return;
      }
      resolve(val);
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
        // The migration's own message, unchanged — the caller wraps it textually.
        done(new Error(String(obj.error)));
        return true;
      }
      if ("result" in obj) {
        result = obj.result;
        done(null, result ?? emptyResult());
        return true;
      }
      return false;
    };

    timer = setTimeout(() => {
      done(new Error(`migration process timed out after ${seconds(timeoutMs)} s`));
    }, timeoutMs);

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
      if (settled) return;
      // A last line the child wrote without a trailing newline still counts.
      if (consume(stdoutBuf) || settled) return;
      stdoutBuf = "";
      const tail = stderrTail.trim().slice(-400);
      done(new Error(`migration process exited ${code ?? signal}: ${tail}`));
    });
  });
}