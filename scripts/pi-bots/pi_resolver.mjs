/**
 * pi engine resolution — find the pi CLI and node binary without assuming any
 * host-specific layout (the old code hardcoded the maintainer's
 * ~/.nvm/versions/node/v20.20.2 paths, which exist on exactly one machine).
 *
 * Ladder (first hit wins):
 *   1. PIBOT_PI_CLI env — explicit operator override, trusted verbatim (a bad
 *      path surfaces as an honest spawn error rather than being second-guessed).
 *   2. <CROW_HOME>/bundles/bot-engine/<pkg>/dist/cli.js — the bot-engine
 *      extension payload (per-instance, npm-installed at bundle install time).
 *   3. <repo>/node_modules/<pkg>/dist/cli.js — pi as a declared dependency.
 *   4. <dirname(execPath)>/../lib/node_modules/<pkg>/dist/cli.js — the global
 *      npm root of the RUNNING node. Covers nvm (<prefix>/bin/node +
 *      <prefix>/lib/node_modules), /usr/local, and Debian's /usr layout.
 *   5. null — callers must surface "bot engine (pi) is not installed", never a
 *      buried ENOENT/MODULE_NOT_FOUND from a phantom path.
 */
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const PI_CLI_REL = join(
  "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"
);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The node that runs the bridge is the node that runs pi. */
export function resolveNodeBin() {
  return process.execPath;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]       defaults to process.env
 * @param {string} [opts.crowHome]  defaults to CROW_HOME || ~/.crow
 * @param {string} [opts.repoRoot]  defaults to this repo checkout
 * @param {string} [opts.execPath]  defaults to process.execPath
 * @returns {{cliPath: string, source: "env"|"bundle"|"repo"|"global"} | null}
 */
export function resolvePiCli(opts = {}) {
  const env = opts.env || process.env;
  const crowHome = opts.crowHome || env.CROW_HOME || join(homedir(), ".crow");
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const execPath = opts.execPath || process.execPath;

  if (env.PIBOT_PI_CLI) return { cliPath: env.PIBOT_PI_CLI, source: "env" };

  const bundle = join(crowHome, "bundles", "bot-engine", PI_CLI_REL);
  if (existsSync(bundle)) return { cliPath: bundle, source: "bundle" };

  const repo = join(repoRoot, PI_CLI_REL);
  if (existsSync(repo)) return { cliPath: repo, source: "repo" };

  const global = join(dirname(execPath), "..", "lib", PI_CLI_REL);
  if (existsSync(global)) return { cliPath: global, source: "global" };

  return null;
}

/** resolvePiCli or throw the honest missing-engine error (never a phantom path). */
export function requirePiCli(opts = {}) {
  const resolved = resolvePiCli(opts);
  if (!resolved) throw new Error(missingEngineMessage());
  return resolved;
}

/** One-line, actionable message for every missing-engine surface. */
export function missingEngineMessage() {
  return (
    "bot engine (pi) is not installed — install the bot-engine extension, " +
    "run `npm i -g @earendil-works/pi-coding-agent` under the gateway's node, " +
    "or set PIBOT_PI_CLI to the engine's dist/cli.js"
  );
}
