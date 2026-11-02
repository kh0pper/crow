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
 *   resolveInstanceDataDir()  CROW_DATA_DIR
 *                             → (non-default home) dirname(CROW_DB_PATH)
 *                             → (non-default home) <CROW_HOME>/data
 *                             → ~/.crow/data
 *
 * A non-default CROW_HOME never falls back to the host-default ~/.crow/data
 * (queue item 33, 2026-10-16): a second gateway that did reconciled the
 * primary's model state against its own DB and freed the primary's port
 * reservation. dirname(CROW_DB_PATH) is the rule init-db, project-spaces,
 * the migration guard and the pi-bots instance paths already use, so one
 * instance never gets two data dirs. servers/db.js resolveDataDir and
 * servers/sharing/identity.js call resolveInstanceDataDir for a non-default
 * home. The gateway enforces the layout at boot with instancePathsVerdict()
 * (servers/gateway/boot/instance-paths-gate.js): derive, or refuse to start.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The env keys that decide which instance a process is (instancePathsVerdict
 * below). They are fixed at boot: nothing may change them in a running
 * process (scheduleGatewayRestart's unsupervised .env reload skips them).
 */
export const INSTANCE_PATH_ENV_KEYS = Object.freeze(["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_ALLOW_SHARED_DATA_DIR"]);

/**
 * INSTANCE_PATH_ENV_KEYS plus the other per-instance file locations a process
 * resolves once (tasks DB, instance registry, refcounts, backups, reservation
 * file, app root, bundles dir, the suite's .env seam, and the Schedule page's ledger and
 * machine-timer folder). A bundle can never
 * write, re-comment or reload any of them (routes/bundles.js).
 */
export const PINNED_PATH_ENV_KEYS = Object.freeze([
  ...INSTANCE_PATH_ENV_KEYS,
  "CROW_TASKS_DB_PATH", "CROW_INSTANCES_JSON_PATH", "CROW_REFCOUNT_PATH", "CROW_BACKUP_DIR",
  "CROW_BOX_RESERVATION_PATH", "CROW_APP_ROOT", "CROW_BUNDLES_DIR", "CROW_APP_ENV_PATH",
  // The Schedule page's read-only sources: a bundle must never point them at another file.
  "CROW_BOX_LEDGER_PATH", "CROW_HOST_TIMERS_DIR",
]);

/** This instance's home (bundles, installed.json, skills, tokens). */
export function resolveCrowHome(env = process.env) {
  return env.CROW_HOME || join(homedir(), ".crow");
}

/** True when this instance uses the host-default home (~/.crow). */
export function isDefaultCrowHome(env = process.env, homeDir = homedir()) {
  if (!env.CROW_HOME) return true;
  return resolve(env.CROW_HOME) === resolve(homeDir, ".crow");
}

/** This instance's data dir for identity/state files (instance-id, refcounts, ntfy, model state). */
export function resolveInstanceDataDir(env = process.env, homeDir = homedir()) {
  if (env.CROW_DATA_DIR) return resolve(env.CROW_DATA_DIR);
  if (!isDefaultCrowHome(env, homeDir)) {
    return env.CROW_DB_PATH ? dirname(resolve(env.CROW_DB_PATH)) : resolve(env.CROW_HOME, "data");
  }
  return resolve(homeDir, ".crow", "data");
}

/** Path to a file directly under this instance's home. */
export function crowHomePath(...parts) {
  return join(resolveCrowHome(), ...parts);
}

/** realpath of `p`, following symlinks of its deepest existing ancestor. */
function realOrResolved(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** True when `p` is `root` or inside it, after following symlinks. */
export function isWithin(p, root) {
  const a = realOrResolved(p);
  const b = realOrResolved(root);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * True when `dbPath` is the data dir's own crow.db: in that directory, or the
 * same file through a symlink (some hosts and migrated wizard installs link
 * <data>/crow.db or ./data to one copy). Relative paths resolve against the
 * cwd, as better-sqlite3 opens them.
 */
export function sameDbLocation(dbPath, dataDir) {
  if (realOrResolved(dirname(resolve(dbPath))) === realOrResolved(dataDir)) return true;
  const own = join(dataDir, "crow.db");
  if (!existsSync(own) || !existsSync(dbPath)) return false;
  try { return realpathSync(own) === realpathSync(dbPath); } catch { return false; }
}

/**
 * A warning string when this instance has its own CROW_HOME but its data dir
 * is the host-default ~/.crow/data (or inside it) — its DB, instance-id and
 * model state are then SHARED with the host-default instance. The gateway
 * refuses that layout at boot unless CROW_ALLOW_SHARED_DATA_DIR=1, so this is
 * the standing reminder for the allowed case. null when the config is fine.
 */
export function coHostedDataDirWarning(env = process.env) {
  if (isDefaultCrowHome(env)) return null;
  const dataDir = resolveInstanceDataDir(env);
  if (!isWithin(dataDir, resolve(homedir(), ".crow", "data"))) return null;
  return `CROW_HOME=${env.CROW_HOME} uses the host-default data dir ${dataDir} — this instance's ` +
    `instance-id, identity and model state are SHARED with any host-default instance on this machine. ` +
    `Set CROW_DATA_DIR=${join(env.CROW_HOME, "data")} in its unit.`;
}

/** Exit code for a refused instance layout (EX_CONFIG); units set RestartPreventExitStatus=78. */
export const INSTANCE_PATHS_EXIT_CODE = 78;

/**
 * Boot gate for a gateway's instance paths (queue item 33). Pure apart from
 * existence checks. `envFileKeys` = the keys the checkout .env supplied (that
 * file belongs to the host-default instance unless it names CROW_HOME itself).
 *
 * Default home → ok; a DB that is not the data dir's own crow.db only warns
 * (dev, Docker and older installs use that layout). Non-default home:
 *   1. CROW_DATA_DIR / CROW_DB_PATH from the checkout .env, CROW_HOME not → refuse
 *   2. data dir or DB inside the host-default ~/.crow/data → refuse
 *   3. no CROW_DATA_DIR and no CROW_DB_PATH, <home>/data holds no instance
 *      (no instance-id), while the
 *      host-default crow.db exists → refuse (a fresh second instance, or one
 *      whose data really is in ~/.crow/data — deriving would fork it onto an
 *      empty DB)
 *   otherwise ok; `pin` = { CROW_DATA_DIR } when the data dir was derived.
 * CROW_ALLOW_SHARED_DATA_DIR=1 waives 1 and 2 only — it never changes where a
 * path points, so it cannot fork a legacy instance; 3 always refuses.
 *
 * @returns {{ ok: boolean, error?: string, warning: string|null, pin: object|null }}
 */
export function instancePathsVerdict(env = process.env, { envFileKeys = new Set(), homeDir = homedir(), exists = existsSync } = {}) {
  const defData = resolve(homeDir, ".crow", "data");
  const dataDir = resolveInstanceDataDir(env, homeDir);
  const dbPath = env.CROW_DB_PATH ? resolve(env.CROW_DB_PATH) : join(dataDir, "crow.db");

  if (isDefaultCrowHome(env, homeDir)) {
    const warning = env.CROW_DB_PATH && !sameDbLocation(dbPath, dataDir)
      ? `crow.db is ${dbPath} but the data dir is ${dataDir}: instance-id, identity, peers, refcounts and ` +
        `model state live in the data dir, so any other gateway using ${dataDir} shares them. ` +
        `The boot model reconcile may be skipped until the two agree.`
      : null;
    return { ok: true, warning, pin: null };
  }

  const home = resolve(env.CROW_HOME);
  const ownData = join(home, "data");
  const waivable = [];
  if (!envFileKeys.has("CROW_HOME")) {
    for (const k of ["CROW_DATA_DIR", "CROW_DB_PATH"]) {
      if (envFileKeys.has(k)) waivable.push(`${k} came from the checkout .env, which belongs to the host-default instance`);
    }
  }
  if (isWithin(dataDir, defData)) waivable.push(`its data dir ${dataDir} is the host-default instance's data dir`);
  if (isWithin(dbPath, defData) && !isWithin(dataDir, defData)) waivable.push(`its database ${dbPath} is inside the host-default instance's data dir`);
  const fixed = [];
  // Keyed on instance evidence, not the directory: a stray <home>/data, even
  // one holding a fresh crow.db from init-db, is not an instance until a
  // gateway gave it an instance-id.
  const ownInstance = exists(join(ownData, "instance-id"));
  if (!env.CROW_DATA_DIR && !env.CROW_DB_PATH && !ownInstance && exists(join(defData, "crow.db"))) {
    fixed.push(`CROW_DATA_DIR is unset and ${ownData} holds no instance yet, while a host-default database exists at ${join(defData, "crow.db")}`);
  }

  const allow = env.CROW_ALLOW_SHARED_DATA_DIR === "1";
  const blocking = allow ? fixed : [...waivable, ...fixed];
  if (blocking.length) {
    return {
      ok: false,
      warning: null,
      pin: null,
      error: `CROW_HOME=${env.CROW_HOME} is a separate instance, but ${[...waivable, ...fixed].join("; ")}. ` +
        `Refusing to start so it cannot read or overwrite another instance's files. ` +
        `Set CROW_DATA_DIR=${ownData} (and CROW_DB_PATH inside it) in this instance's unit. ` +
        `If this instance really owns the host-default data, set both CROW_DATA_DIR=${defData} and CROW_ALLOW_SHARED_DATA_DIR=1.`,
    };
  }
  const warning = allow && waivable.length
    ? `CROW_HOME=${env.CROW_HOME}: ${waivable.join("; ")}. Continuing because CROW_ALLOW_SHARED_DATA_DIR=1 — this instance shares files with the host-default one.`
    : null;
  return { ok: true, warning, pin: env.CROW_DATA_DIR ? null : { CROW_DATA_DIR: dataDir } };
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

/**
 * Queue item 19, step 1: a co-hosted instance (its own CROW_HOME) that still
 * reads the SHARED checkout .env inherits the primary instance's secrets
 * (tokens, passwords) into its own process. Returns a warning naming the
 * inherited secret-like KEYS (never values), or null. `appEnvIsDefault` is
 * true when CROW_APP_ENV_PATH is unset, i.e. the checkout .env was applied.
 * `secretNameRe` is bot-env.js's SECRET_NAME_RE (passed in to avoid a cycle).
 */
export function inheritedSecretsWarning(env, { envFileKeys = new Set(), appEnvIsDefault = true, secretNameRe, homeDir = homedir() } = {}) {
  if (!appEnvIsDefault || isDefaultCrowHome(env, homeDir) || !secretNameRe) return null;
  const keys = [...envFileKeys].filter((k) => secretNameRe.test(k) && !/_PATH$|_FILE$|_DIR$|_URL$/.test(k)).sort();
  if (!keys.length) return null;
  return `this instance (CROW_HOME=${resolveCrowHome(env)}) inherits ${keys.length} secret-like key(s) from the shared checkout .env: ` +
    `${keys.join(", ")}. Give it its own app env file (CROW_APP_ENV_PATH) with only the keys it needs.`;
}
