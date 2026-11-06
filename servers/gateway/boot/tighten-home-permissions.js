/**
 * Boot hardening (audit N1c-18): the Crow home and this instance's database are
 * OWNER-ONLY.
 *
 * The Crow home holds everything an instance is: bundle `.env` files with their
 * secrets, `secrets/` (the keychain key, peer tokens), `installed.json`, the
 * skill state — and `data/crow.db`, which holds every memory, message and
 * credential this Crow has. An install made under a permissive umask left the
 * home 0755 and the DB 0644, so any local user could read the lot.
 *
 * Two earlier repairs fixed the worst of it the same way this one does — an
 * existing `instances.json` (instance-registry.js,
 * tightenInstancesJsonPermissions) and every installed bundle's `.env`
 * (routes/bundles.js, repairInstalledBundleAssets). This is the same shape,
 * one level up: at boot, walk the fixed list of paths that must be owner-only,
 * chmod the ones that are not, log one line each.
 *
 * Rules, all of them deliberate:
 *   - `lstat`, never `stat`: a symlink is never followed, because chmod through
 *     one would change a file OUTSIDE the instance (and `chmod` on a symlink
 *     dereferences on Linux);
 *   - only a regular file / a directory is touched — a symlink at one of these
 *     paths makes the entry skipped, not fixed;
 *   - only a path owned by THIS process's uid is touched: another user's file is
 *     theirs to fix (a root-owned ~/.crow is a real misconfiguration, and chmod
 *     would fail anyway);
 *   - a path that does not exist is skipped: boot hardening never creates state
 *     (init-db does that);
 *   - a home or data dir that resolves to the operator's whole home directory or
 *     to `/` is REFUSED: those are not this instance's files, and 0700 on a home
 *     directory would lock out everything else that reads it. One log line, no
 *     chmod;
 *   - on Windows there are no owner-only mode bits to set, so the whole step is
 *     skipped;
 *   - NEVER throws. A boot repair must not be able to block boot — EPERM, a
 *     race with a restart, a read-only home: all of them are just "not fixed".
 *
 * What this cannot fix (another owner, a symlink, an unreadable parent) is
 * reported instead by the Nest's Integrity card, which shares the same target
 * list (homePermissionTargets) but checks the EFFECTIVE mode.
 *
 * The WAL and SHM files: SQLite creates them from the DB file's own mode, so
 * tightening `crow.db` covers the ones it creates later; the ones that already
 * exist from a permissive boot are tightened here too.
 */
import { chmodSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveCrowHome, resolveInstanceDataDir } from "../../shared/crow-home.js";

/**
 * Directories boot must never chmod, even when the environment points an
 * instance at one of them: the filesystem root, and the operator's whole home
 * directory. CROW_HOME unset-and-inherited from `$HOME` is an easy mistake, and
 * chmod'ing `$HOME` to 0700 breaks every other service and shell that reads it.
 * The Nest's Integrity card shares this list, so it stays quiet about them too.
 */
function refusedDirectories() {
  const out = new Set([resolve("/")]);
  try { out.add(resolve(homedir())); } catch {}
  return out;
}

/**
 * The paths of this instance that must be owner-only, in the order they are
 * checked. Each carries:
 *   id    stable ascii key — it names the Nest health issue (`integrity:mode:<id>`)
 *   role  untranslated description for the boot log line
 *   kind  "dir" (0700) or "file" (0600)
 *   mode  the mode to set when it is not already owner-only
 *   path  the resolved path (the health card never prints it; the log does)
 *
 * Duplicates are dropped: a default install has CROW_DATA_DIR unset, so the data
 * dir is derived, but an operator may point CROW_DATA_DIR (or CROW_DB_PATH's
 * directory) at the home itself.
 *
 * Returns nothing on Windows, and nothing for a home/data dir that resolves to
 * the operator's home directory or `/` (one line on `log` says which and why).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{log?: (m: string) => void}} [opts]
 * @returns {{id:string, role:string, kind:"dir"|"file", mode:number, path:string}[]}
 */
export function homePermissionTargets(env = process.env, { log = () => {} } = {}) {
  if (process.platform === "win32") return [];
  const home = resolve(resolveCrowHome(env));
  const dataDir = resolveInstanceDataDir(env);
  const dbPath = env.CROW_DB_PATH ? resolve(env.CROW_DB_PATH) : join(dataDir, "crow.db");
  const targets = [
    { id: "home", role: "Crow home", kind: "dir", mode: 0o700, path: home },
    { id: "data", role: "data dir", kind: "dir", mode: 0o700, path: dataDir },
    { id: "db", role: "crow.db", kind: "file", mode: 0o600, path: dbPath },
    { id: "db-wal", role: "crow.db-wal", kind: "file", mode: 0o600, path: `${dbPath}-wal` },
    { id: "db-shm", role: "crow.db-shm", kind: "file", mode: 0o600, path: `${dbPath}-shm` },
  ];
  const refused = refusedDirectories();
  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.path)) return false;
    seen.add(target.path);
    if (target.kind === "dir" && refused.has(target.path)) {
      const why = "it is the home directory or the filesystem root, not this instance's own folder";
      log(`[boot] not tightening ${target.role} ${target.path}: ${why}`);
      return false;
    }
    return true;
  });
}

/**
 * Tighten this instance's home, data dir and database to owner-only.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  defaults to process.env
 * @param {number|null} [opts.uid]        defaults to this process's uid (test seam)
 * @param {(m: string) => void} [opts.log] one line per path actually changed
 * @returns {{id:string, role:string, path:string, from:number, to:number}[]}
 *          the paths it changed (empty on the steady state)
 */
export function tightenCrowHomePermissions({ env = process.env, uid = process.getuid?.() ?? null, log = (m) => console.log(m) } = {}) {
  // Windows has no owner-only mode bits: nothing to tighten, nothing to log.
  if (process.platform === "win32") return [];
  const tightened = [];
  for (const target of homePermissionTargets(env, { log })) {
    try {
      const st = lstatSync(target.path);
      const rightKind = target.kind === "dir" ? st.isDirectory() : st.isFile();
      if (!rightKind) continue;                        // a symlink (or the wrong kind): not ours to chmod through
      if (uid != null && st.uid !== uid) continue;     // another user's path: leave it alone
      const was = st.mode & 0o777;
      if ((was & 0o077) === 0) continue;               // already owner-only
      chmodSync(target.path, target.mode);
      log(`[boot] tightened ${target.role} ${target.path} to 0${target.mode.toString(8)} (was ${was.toString(8).padStart(3, "0")})`);
      tightened.push({ id: target.id, role: target.role, path: target.path, from: was, to: target.mode });
    } catch {
      // missing path, EPERM, a race with a restart, a read-only home — never throws
    }
  }
  return tightened;
}