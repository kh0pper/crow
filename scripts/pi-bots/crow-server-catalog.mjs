#!/usr/bin/env node
/**
 * Crow Bot Builder — the per-instance Crow server catalog.
 *
 * THE INVARIANT: a bot must never resolve a Crow server bound to an instance
 * other than its own. Stated structurally, which is how this module achieves
 * it: no file that can name an instance may describe a Crow server.
 *
 * So Crow servers are DERIVED, never copied out of the user-global
 * ~/.pi/agent/mcp.json:
 *   - core servers  -> scripts/server-registry.js, run from the repo root,
 *                      env bound to THIS instance
 *   - bundle servers -> <crowHome>/mcp-addons.json, cwd under THIS instance
 * The homedir config keeps only third-party servers, which carry credentials
 * rather than instance identity.
 *
 * Imports are deliberately limited to server-registry.js and instance-paths.mjs
 * so neither ext_registry.mjs nor mcp_writer.mjs can form a cycle through here.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CORE_SERVERS,
  CONDITIONAL_SERVERS,
  ROOT,
  loadEnv,
  resolveEnvValue,
} from "../server-registry.js";
import { botsDbPath, resolveSqlitePath } from "./instance-paths.mjs";

/**
 * The env vars that name an instance. r4-deploy.sh warns that a child missing
 * any of these silently resolves to the PRIMARY instance, which is exactly the
 * failure this list exists to prevent.
 */
export const INSTANCE_ENV_KEYS = [
  "CROW_HOME",
  "CROW_DATA_DIR",
  "CROW_DB_PATH",
  "CROW_TASKS_DB_PATH",
];

/** The default primary-instance home — the one botsDbPath()/tasksDbPath() fall back to. */
const DEFAULT_CROW_HOME = join(homedir(), ".crow");

/**
 * This instance's canonical values for the four instance-scoped env vars.
 *
 * botsDbPath()/tasksDbPath() (instance-paths.mjs) read CROW_DB_PATH /
 * CROW_DATA_DIR from the environment but never CROW_HOME, so a caller that
 * hands us a `crowHome` without ALSO setting one of those two env vars would
 * otherwise resolve to the PRIMARY instance's database — silently rebinding
 * a correct block onto the wrong instance, which is worse than not rebinding
 * at all. So when the env doesn't decide, honor the crowHome argument itself
 * (unless it IS the default, in which case botsDbPath()'s own fallback is
 * already correct).
 *
 * The tasks path is normalized through resolveSqlitePath(): production stores
 * `file:` URIs in project_spaces.tasks_db_uri and better-sqlite3 has no URI
 * support, so an un-normalized value reaches a bundle as an unopenable
 * filename (the PR #278 defect).
 */
export function instanceBinding(crowHome, opts = {}) {
  let dbPath = opts.dbPath;
  if (!dbPath) {
    if (process.env.CROW_DB_PATH) {
      dbPath = process.env.CROW_DB_PATH;
    } else if (process.env.CROW_DATA_DIR) {
      dbPath = join(process.env.CROW_DATA_DIR, "crow.db");
    } else if (crowHome && crowHome !== DEFAULT_CROW_HOME) {
      dbPath = join(crowHome, "data", "crow.db");
    } else {
      dbPath = botsDbPath();
    }
  }
  const tasksPath =
    opts.tasksDbPath ||
    process.env.CROW_TASKS_DB_PATH ||
    join(dirname(dbPath), "tasks.db");
  return {
    CROW_HOME: crowHome,
    CROW_DATA_DIR: dirname(dbPath),
    CROW_DB_PATH: dbPath,
    CROW_TASKS_DB_PATH: resolveSqlitePath(tasksPath),
  };
}

/** A bundle cwd under SOME instance home: /…/.crow<suffix>/bundles/<id>. */
const INSTANCE_BUNDLE_CWD = /\/\.crow[^/]*\/bundles\/([^/]+)\/?$/;

function applyJournalGuard(env) {
  // The WAL-unlink scar: every server touching a crow.db runs journal DELETE.
  if (env && env.CROW_DB_PATH) env.CROW_JOURNAL_MODE = "DELETE";
  return env;
}

/**
 * Rebind a server block that did NOT come from the catalog — a third-party or
 * `crow-browser` entry out of the homedir config — onto this instance.
 *
 * Returns {block, rebound} or {disabled, reason}. `optIn` is stripped: pi
 * activates an optIn server only when a project file says {"enabled": true},
 * so a verbatim copy of an optIn block silently never loads. Selecting the
 * server IS the opt-in.
 *
 * The /.crow anchor is deliberate. `/home/kh0pp/crow/bundles/browser` and
 * `/home/kh0pp/crow` do not match, so the repo is left alone — it is
 * instance-neutral, correctly.
 */
export function rebindBlock(name, block, binding, crowHome) {
  const clone = JSON.parse(JSON.stringify(block));
  delete clone.optIn;
  const rebound = [];
  if (clone.env) {
    for (const k of INSTANCE_ENV_KEYS) {
      if (k in clone.env && clone.env[k] !== binding[k]) {
        clone.env[k] = binding[k];
        rebound.push(k);
      }
    }
  }
  const m = clone.cwd ? INSTANCE_BUNDLE_CWD.exec(clone.cwd) : null;
  if (m) {
    const target = join(crowHome, "bundles", m[1]);
    if (!existsSync(target)) {
      return {
        disabled: true,
        reason: `bundle '${m[1]}' is not installed on this instance (${target})`,
      };
    }
    if (clone.cwd !== target) {
      clone.cwd = target;
      rebound.push("cwd");
    }
  }
  applyJournalGuard(clone.env);
  return { block: clone, rebound };
}

function readAddons(crowHome) {
  try {
    return JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

/**
 * Build a core-server block from its registry entry. Instance-scoped env keys
 * come from the binding; everything else resolves against the repo .env.
 * Returns {block, missing} — `missing` names required templates (no `:-`
 * default) that resolved empty.
 */
function coreBlock(spec, binding, repoEnv, node) {
  const env = {};
  const missing = [];
  for (const [k, tmpl] of Object.entries(spec.mcpEnv || {})) {
    if (INSTANCE_ENV_KEYS.includes(k)) {
      env[k] = binding[k];
      continue;
    }
    const v = resolveEnvValue(tmpl, repoEnv);
    if (!v && /\$\{\w+\}/.test(tmpl)) missing.push(k);
    else env[k] = v;
  }
  applyJournalGuard(env);
  return { block: { command: node, args: [...spec.args], cwd: ROOT, env }, missing };
}

/**
 * Every Crow server available to THIS instance, plus the ones that exist but
 * cannot be spawned here and why.
 *
 * `unconfigured` is not an error channel — it is what the GUI renders so an
 * operator sees "crow-storage: unconfigured, missing MINIO_ENDPOINT" instead
 * of an opaque spawn failure.
 *
 * `coreNames` names the subset of `servers` sourced from the registry
 * (CORE_SERVERS + CONDITIONAL_SERVERS) rather than from mcp-addons.json. It
 * exists so a consumer that wants ONLY the registry-sourced servers (the ones
 * that vanish from the picker once Crow entries leave the homedir config) can
 * select them without re-deriving the split — `probeExtensions` already owns
 * the addon half of `servers` and is already instance-correct, so folding
 * addons back in elsewhere would double-list and double-spawn them.
 */
export function crowServerCatalog(crowHome = process.env.CROW_HOME || join(homedir(), ".crow"), opts = {}) {
  const binding = opts.binding || instanceBinding(crowHome, opts);
  const node = opts.node || process.execPath;
  const repoEnv = loadEnv();
  const servers = {};
  const unconfigured = {};
  const coreNames = [];

  for (const spec of CORE_SERVERS) {
    const { block } = coreBlock(spec, binding, repoEnv, node);
    servers[spec.name] = block;
    coreNames.push(spec.name);
  }
  for (const spec of CONDITIONAL_SERVERS) {
    const { block, missing } = coreBlock(spec, binding, repoEnv, node);
    if (missing.length) unconfigured[spec.name] = `unconfigured: missing ${missing.join(", ")}`;
    else servers[spec.name] = block;
    coreNames.push(spec.name);
  }
  for (const [id, addon] of Object.entries(readAddons(crowHome))) {
    const cwd = resolve(addon.cwd || join(crowHome, "bundles", id));
    if (!existsSync(cwd)) {
      unconfigured[id] = `bundle not installed on this instance (${cwd})`;
      continue;
    }
    const r = rebindBlock(id, { ...addon, cwd }, binding, crowHome);
    if (r.disabled) unconfigured[id] = r.reason;
    else servers[id] = r.block;
  }
  return { servers, unconfigured, coreNames };
}
