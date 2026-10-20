/**
 * Checkout .env loader + instance-path boot gate (queue item 33).
 *
 * Run by ./run-instance-paths-gate.js, which servers/gateway/index.js imports
 * FIRST, so it is evaluated before every other module in the gateway's import
 * graph. That matters twice:
 *   - import-time path constants (identity.js DATA_DIR, sync.js PEERS_DIR,
 *     board-mcp TASKS_DB, ...) see the FINAL env, including the .env values;
 *   - nothing can open a DB or write per-instance state under the wrong
 *     paths before the gate has run.
 *
 * The .env rule is unchanged: a key already in the environment wins.
 *
 * A gateway with its own CROW_HOME uses its own data dir and DB, or it does
 * not start (rules: servers/shared/crow-home.js instancePathsVerdict). A
 * refusal exits INSTANCE_PATHS_EXIT_CODE (78) so a unit with
 * RestartPreventExitStatus=78 does not restart-loop. When the data dir is
 * derived, CROW_DATA_DIR is pinned in process.env so every later resolver,
 * bundle child and spawned server agrees.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instancePathsVerdict, INSTANCE_PATHS_EXIT_CODE } from "../../shared/crow-home.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Apply the checkout .env to `env` (env wins); returns the keys it set. */
export function applyEnvFile(envPath, env = process.env) {
  const keys = new Set();
  if (!existsSync(envPath)) return keys;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !(match[1] in env)) {
      env[match[1]] = match[2];
      keys.add(match[1]);
    }
  }
  return keys;
}

// CROW_APP_ENV_PATH is set only by scripts/run-suite.mjs (a suite run never
// applies a real checkout .env); prod leaves it unset.
export function runInstancePathsGate({ env = process.env, envPath = env.CROW_APP_ENV_PATH || resolve(appRoot, ".env"), log = console, exit = process.exit } = {}) {
  const envFileKeys = applyEnvFile(envPath, env);
  const verdict = instancePathsVerdict(env, { envFileKeys });
  if (!verdict.ok) {
    log.error(`ERROR: ${verdict.error}`);
    exit(INSTANCE_PATHS_EXIT_CODE);
    return verdict;
  }
  if (verdict.warning) log.warn(`[instance-paths] WARNING: ${verdict.warning}`);
  if (verdict.pin) {
    mkdirSync(verdict.pin.CROW_DATA_DIR, { recursive: true, mode: 0o700 });
    env.CROW_DATA_DIR = verdict.pin.CROW_DATA_DIR;
    log.log(`[instance-paths] CROW_DATA_DIR unset; using ${verdict.pin.CROW_DATA_DIR} (derived from CROW_HOME)`);
  }
  return verdict;
}
