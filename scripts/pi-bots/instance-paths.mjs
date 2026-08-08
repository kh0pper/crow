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
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../../servers/db.js";

/**
 * Normalize a SQLite location that may be a `file:` URI into a plain filesystem
 * path better-sqlite3 can open.
 *
 * better-sqlite3 has NO URI support — it passes the string to SQLite as a bare
 * filename, so `new Database("file:/x/tasks.db")` fails with SQLITE_CANTOPEN
 * rather than opening `/x/tasks.db`. Production stores exactly that form in
 * `project_spaces.tasks_db_uri` (r4: `file:/home/kh0pp/.crow-r4/data/tasks.db`),
 * so every reader of that column must come through here.
 *
 * This normalizes the OPEN, deliberately not the resolution: `cardsDbForBot`
 * still returns the configured value verbatim so logs and errors name what the
 * database actually holds.
 *
 * Anything that is not a `file:`-scheme string is returned untouched — plain
 * paths, `:memory:`, null, and a path that merely CONTAINS "file:" later on.
 *
 * @param {*} p a filesystem path, a `file:` URI, or neither
 * @returns {*} a path better-sqlite3 can open, or the input unchanged
 */
export function resolveSqlitePath(p) {
  if (typeof p !== "string" || !p.startsWith("file:")) return p;
  try {
    const u = new URL(p);
    // Rebuild without search/hash: SQLite's URI syntax allows ?mode=ro and
    // friends, and left in place they become part of the filename. `localhost`
    // is the one authority SQLite (and RFC 8089) treats as the local machine.
    const host = u.hostname === "localhost" ? "" : u.hostname;
    return fileURLToPath(new URL(`file://${host}${u.pathname}`));
  } catch {
    // Not parseable as a URL — hand it back and let the caller's open fail with
    // its own error rather than swallowing the problem here.
    return p;
  }
}

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
