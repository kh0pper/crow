/**
 * Per-instance path resolution for the Bot Builder runtime + panel.
 *
 * F3 (Bot Builder -> core): replaces the hardcoded ~/.crow-mpa literals that
 * used to pin pi-bots to the MPA instance. Working files anchor on CROW_DB_PATH
 * first (the templated pibot-*@.service env files set it), then resolveDataDir()
 * (CROW_DATA_DIR -> ~/.crow/data -> ./data). tasks DB and the per-bot workspace
 * derive from the SAME anchor, so they always sit beside the crow.db actually in
 * use. The instance SEED is the one exception — see instanceSeedDir(). All
 * functions read process.env at call time.
 */
import { dirname, join } from "node:path";
import { resolveDataDir } from "../../servers/db.js";

/** The data dir holding the crow.db this process uses. */
function botsDataDir() {
  if (process.env.CROW_DB_PATH) return dirname(process.env.CROW_DB_PATH);
  return resolveDataDir();
}

/** Absolute path to the bots crow.db for this instance. */
export function botsDbPath() {
  return process.env.CROW_DB_PATH || join(botsDataDir(), "crow.db");
}

/** Absolute path to the tasks.db for this instance. */
export function tasksDbPath() {
  return process.env.CROW_TASKS_DB_PATH || join(botsDataDir(), "tasks.db");
}

/** Per-bot workspace root: sibling of the data dir (…/pi-bots). */
export function botsWorkspaceRoot() {
  return join(dirname(botsDataDir()), "pi-bots");
}

/**
 * The data dir holding the INSTANCE identity seed (identity.json). This is an
 * instance-data-dir resource, so it anchors on resolveDataDir() — the SAME
 * anchor servers/sharing/identity.js uses for the instance's own federation
 * identity — and deliberately NOT on CROW_DB_PATH: that var asserts where the
 * sqlite file is, not where the instance lives. On grackle the two legitimately
 * differ (repo .env points CROW_DB_PATH at repo/data/crow.db while identity.json
 * lives only in ~/.crow/data, whose crow.db is a symlink to the repo file); the
 * old dirname(botsDbPath()) anchor made every bot-identity derivation throw
 * there. Hosts that point CROW_DB_PATH at a DIFFERENT instance's DB must set
 * CROW_DATA_DIR to match (scripts/pi-bots/install-runtime.sh always writes it).
 */
export function instanceSeedDir() {
  return resolveDataDir();
}
