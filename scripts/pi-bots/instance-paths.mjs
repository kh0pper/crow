/**
 * Per-instance path resolution for the Bot Builder runtime + panel.
 *
 * F3 (Bot Builder -> core): replaces the hardcoded ~/.crow-mpa literals that
 * used to pin pi-bots to the MPA instance. Anchors on CROW_DB_PATH first
 * (pibot-gateways.service sets it even when CROW_DATA_DIR is absent), then
 * resolveDataDir() (CROW_DATA_DIR -> ~/.crow/data -> ./data). tasks DB and the
 * per-bot workspace derive from the SAME anchor, so they always sit beside the
 * crow.db actually in use. All functions read process.env at call time.
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
