/**
 * The ONE resolver for per-instance filesystem roots.
 *
 * A host can run more than one Crow gateway from the same checkout (crow runs
 * the primary with CROW_HOME unset and r4 with CROW_HOME=~/.crow-r4). Every
 * file that belongs to an instance — instances.json, peer tokens, refcounts,
 * installed.json, user skills, cookie secrets — must hang off THIS instance's
 * root, never a hardcoded `homedir()/.crow`, or the second gateway silently
 * reads and overwrites the first one's state.
 *
 * Resolution (all read the env at call time, so tests can swap it):
 *   resolveCrowHome()         CROW_HOME → ~/.crow
 *   resolveInstanceDataDir()  CROW_DATA_DIR → ~/.crow/data
 *
 * resolveInstanceDataDir deliberately mirrors the existing instance-id /
 * ntfy resolution (CROW_DATA_DIR, else ~/.crow/data) and does NOT derive from
 * CROW_HOME: the crow.db location (servers/db.js resolveDataDir) has the same
 * rule, and an instance's identity files must sit beside the DB it actually
 * uses. Every co-hosted unit in the fleet sets CROW_DATA_DIR explicitly;
 * coHostedDataDirWarning() flags the one config that would share a data dir.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** This instance's home (bundles, installed.json, skills, tokens). */
export function resolveCrowHome(env = process.env) {
  return env.CROW_HOME || join(homedir(), ".crow");
}

/** True when this instance uses the host-default home (~/.crow). */
export function isDefaultCrowHome(env = process.env) {
  if (!env.CROW_HOME) return true;
  return resolve(env.CROW_HOME) === resolve(homedir(), ".crow");
}

/** This instance's data dir for identity/state files (instance-id, refcounts, ntfy). */
export function resolveInstanceDataDir(env = process.env) {
  return env.CROW_DATA_DIR ? resolve(env.CROW_DATA_DIR) : resolve(homedir(), ".crow", "data");
}

/** Path to a file directly under this instance's home. */
export function crowHomePath(...parts) {
  return join(resolveCrowHome(), ...parts);
}

/**
 * A warning string when this instance has its own CROW_HOME but no
 * CROW_DATA_DIR — its DB, instance-id and refcounts would then resolve to the
 * host-default ~/.crow/data and be shared with the primary instance. null when
 * the config is fine.
 */
export function coHostedDataDirWarning(env = process.env) {
  if (isDefaultCrowHome(env) || env.CROW_DATA_DIR) return null;
  return `CROW_HOME=${env.CROW_HOME} is set but CROW_DATA_DIR is not — this instance's ` +
    `instance-id, refcounts${env.CROW_DB_PATH ? "" : " and database"} resolve to the host-default ` +
    `~/.crow/data and are SHARED with the primary instance. ` +
    `Set CROW_DATA_DIR=${join(env.CROW_HOME, "data")} in its unit.`;
}

/** This instance's id from <data dir>/instance-id, without ever creating it. */
export function readLocalInstanceIdOrNull(env = process.env) {
  try {
    const id = readFileSync(join(resolveInstanceDataDir(env), "instance-id"), "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}
