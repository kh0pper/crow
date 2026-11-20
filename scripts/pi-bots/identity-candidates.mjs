/**
 * The instance identity files a bot must never read — ONE list, for the bridge
 * and for the boot check.
 *
 * `<dataDir>/identity.json` holds the MASTER SEED every instance key and every
 * bot key is derived from (servers/sharing/identity.js). Both sandbox tiers hide
 * it unconditionally (default tier: hidden_files.mjs / --dev-bind /dev/null;
 * contain tier: the reserved data-dir entry), and there is no opt-out.
 *
 * Why this module exists: the mask used to be built from ONE anchor,
 * `dirname(CROW_DB)`, while the seed is READ from a different resolver
 * (identity.js's own data dir) and the boot check used a third
 * (resolveInstanceDataDir()). Those are not the same directory on every host —
 * instance-paths.mjs documents a real install where the repo `.env` points
 * CROW_DB_PATH at `repo/data/crow.db` while the seed lives only in
 * `~/.crow/data` (whose crow.db is a symlink to the repo file). Masking only the
 * DB anchor left the file the gateway actually loads readable inside every bot.
 * So `identityCandidates()` returns EVERY candidate, and both callers use it:
 *
 *   - this instance: `dirname(CROW_DB)` (the DB anchor) AND the seed dir from
 *     identity.js's own resolver (`identityDataDir`) — both, always, so no host
 *     layout can pick the wrong one. `identityAnchors()` resolves those two from
 *     the authorities (identity.js's resolver, the pi-bots DB path) plus the
 *     backup dir rule, and is what the boot check uses; the bridge's spawn path
 *     is a SYNCHRONOUS constructor, so it passes the same three values resolved
 *     the same way (identityDataDir(process.env), dirname(CROW_DB),
 *     resolveBackupDir(process.env)). Either way the LIST — which files, which
 *     copies, which roots, deduped — is this one function;
 *   - every co-hosted Crow home's own `<home>/data`;
 *   - every copy of any of those files that holds the same seed
 *     (hidden_files.mjs's isIdentityFileName: `identity.json.bak`,
 *     `identity.json~`, `identity.json-<date>`, and this repo's own backup
 *     copies `<stem>-identity-<date>.json`);
 *   - the repo's backup output directories (`resolveBackupDir(env)`:
 *     `CROW_BACKUP_DIR`, else `~/backups/crow`), where scripts/backup.sh writes
 *     `<stem>-identity-<date>.json`. They carry no plain `identity.json`, and
 *     they are trusted ROOTS, so a backup copy inside them is maskable at all.
 *
 * Deduped by realpath, so a data dir reached twice (the DB anchor under a
 * symlink, a co-host whose home IS this home) is one entry.
 *
 * The plain `<dir>/identity.json` is listed whether or not it EXISTS: a file
 * that appears between the listing and the spawn is masked by that same
 * candidate. What each tier does with a file that is not there yet is documented
 * at the NIT note in hidden_files.mjs (the default tier cannot mask a missing
 * file without creating it; the contain tier masks the reserved name always).
 *
 * This module stays dependency-free on purpose (node builtins + the name rule):
 * the boot check and the sandbox code are imported by a settings section and by
 * unit tests that must run without a database driver or a crypto library, so the
 * three anchors are resolved by `identityAnchors()` — the only thing here that
 * imports them, and it does so lazily.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { IDENTITY_FILE_NAME, isIdentityFileName } from "./hidden_files.mjs";

/**
 * The two anchors and the backup dirs, from the authorities themselves:
 * identity.js's own data-dir resolver, the pi-bots DB-path resolver
 * (botsDbDir = dirname(CROW_DB)), and servers/shared/backup-naming.js's
 * resolveBackupDir. Imported lazily so this module (imported by the boot check
 * and its tests) needs no third-party package to answer a masking question.
 *
 * @param {{env?: object}} [o]
 * @returns {Promise<{seedDir:string, dbDir:string, backupDirs:string[]}>}
 */
export async function identityAnchors({ env = process.env } = {}) {
  const [{ identityDataDir }, { botsDbDir }, { resolveBackupDir }] = await Promise.all([
    import("../../servers/sharing/identity.js"),
    import("./instance-paths.mjs"),
    import("../../servers/shared/backup-naming.js"),
  ]);
  return { seedDir: identityDataDir(env), dbDir: botsDbDir(), backupDirs: [resolveBackupDir(env)] };
}

/** realpath when the path is there, the path itself otherwise. */
function realOrSelf(p, realpath) {
  try { return realpath(p); } catch { return p; }
}

function isDir(p) {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

/** Every identity-named file directly in `dir` (may be empty or missing). */
function identityNamesIn(dir, readdir, realpath) {
  let names = [];
  try { names = readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!isIdentityFileName(n)) continue;
    const p = join(dir, n);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    // A symlink is RESOLVED to its target: a target under a trusted root is
    // listed at its real path (masking the target hides the link's content
    // too), and one that leaves every root is listed there, where wrapPiSpawn
    // refuses it (a candidate outside the roots is never masked).
    if (!st.isFile() && !st.isSymbolicLink()) continue;
    out.push(realOrSelf(p, realpath));
  }
  return out;
}

/**
 * Every identity candidate on this host.
 *
 * `seedDir` and `dbDir` are REQUIRED: pass `identityAnchors()`'s answer (the
 * bridge and the boot check both do), never a guess. Both anchors are always
 * scanned, so a caller that passes one is still covered for the other.
 *
 * @param {object} o
 * @param {string} o.seedDir this instance's SEED dir (identity.js's own resolver)
 * @param {string} o.dbDir this instance's DB anchor (dirname(CROW_DB))
 * @param {string[]} [o.backupDirs] the repo's backup dirs (default: none — a
 *   caller that has identityAnchors() passes them)
 * @param {string[]} [o.homes] every co-hosted Crow home; each contributes
 *   `<home>/data`
 * @param {string[]} [o.dataDirs] extra data dirs to scan (a caller that already
 *   resolved a co-host's data dir itself)
 * @param {string} [o.crowHome] this instance's Crow home (accepted so a caller
 *   names what it is scanning; resolution needs nothing from it)
 * @param {Function} [o.readdir] test seam
 * @param {Function} [o.realpath] test seam
 * @returns {{files:string[], present:string[], seedDir:string, dbDir:string, dataDirs:string[], backupDirs:string[], roots:string[]}}
 *   `files` — every candidate path (sorted, deduped, plain names included even
 *   when absent); `present` — the subset that exists right now; `seedDir` /
 *   `dbDir` — the two anchors, resolved (the contain tier's plan binds the DB
 *   anchor and calls it its data dir, so a plan builder passes `dbDir`);
 *   `dataDirs` / `backupDirs` — the dirs holding them, resolved; `roots` — every
 *   existing dir a candidate must sit under for the default tier to mask it (the
 *   caller adds its Crow homes and the app root).
 */
export function identityCandidates({
  seedDir,
  dbDir,
  backupDirs = [],
  homes = [],
  dataDirs = [],
  crowHome = null,
  readdir = readdirSync,
  realpath = realpathSync,
} = {}) {
  void crowHome;
  for (const [name, v] of [["seedDir", seedDir], ["dbDir", dbDir]]) {
    if (typeof v !== "string" || !v) {
      throw new Error("identityCandidates: " + name + " is required (use identityAnchors())");
    }
  }
  const backups = (Array.isArray(backupDirs) ? backupDirs : []).filter((d) => typeof d === "string" && d);

  const seedReal = realOrSelf(seedDir, realpath);
  const dbReal = realOrSelf(dbDir, realpath);
  const wantedDataDirs = [
    seedReal,
    dbReal,
    ...(Array.isArray(homes) ? homes : []).filter((h) => typeof h === "string" && h).map((h) => join(h, "data")),
    ...(Array.isArray(dataDirs) ? dataDirs : []),
  ].filter((d) => typeof d === "string" && d);

  const seenDirs = new Set();
  const resolvedDataDirs = [];
  for (const d of wantedDataDirs) {
    const real = realOrSelf(d, realpath);
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    resolvedDataDirs.push(real);
  }

  const seenBackups = new Set();
  const resolvedBackupDirs = [];
  for (const d of backups) {
    const real = realOrSelf(d, realpath);
    if (seenBackups.has(real)) continue;
    seenBackups.add(real);
    resolvedBackupDirs.push(real);
  }

  const files = new Set();
  const present = new Set();
  for (const d of resolvedDataDirs) {
    if (!isDir(d)) continue;
    const plain = join(d, IDENTITY_FILE_NAME);
    files.add(plain);
    if (existsSync(plain)) present.add(plain);
    for (const f of identityNamesIn(d, readdir, realpath)) {
      files.add(f);
      if (existsSync(f)) present.add(f);
    }
  }
  // A backup dir never holds `identity.json` (scripts/backup.sh writes
  // `<stem>-identity-<date>.json`): only the copies that are really there.
  for (const d of resolvedBackupDirs) {
    if (!isDir(d)) continue;
    for (const f of identityNamesIn(d, readdir, realpath)) {
      files.add(f);
      if (existsSync(f)) present.add(f);
    }
  }

  const roots = [...resolvedDataDirs, ...resolvedBackupDirs].filter(isDir);
  return {
    files: [...files].sort(),
    present: [...present].sort(),
    seedDir: seedReal,
    dbDir: dbReal,
    dataDirs: resolvedDataDirs,
    backupDirs: resolvedBackupDirs,
    roots,
  };
}