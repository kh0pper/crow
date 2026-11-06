/**
 * Boot hardening (security audit N1c-18): at boot the Crow home, its data dir
 * and `crow.db` (plus the `crow.db-wal` / `crow.db-shm` SQLite keeps beside it)
 * are tightened to owner-only — 0700 for directories, 0600 for files.
 *
 * The home holds the bundle `.env` files with their secrets, `secrets/` (the
 * keychain key, peer tokens) and the DB with every memory this Crow has; an
 * install made under a permissive umask left all of it group/other readable.
 * Same boot-repair shape as tightenInstancesJsonPermissions (instances.json) and
 * repairInstalledBundleAssets (bundle .env files), one level up:
 *
 *   - a path is chmod'ed only when it is the RIGHT kind (lstat — a symlink is
 *     never followed, so its target outside the instance is never changed),
 *     owned by THIS uid, and carries group/other bits;
 *   - one log line per path actually changed, none for a no-op;
 *   - it never throws and never creates state (a missing path is a skip).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, lstatSync,
  symlinkSync, unlinkSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

// Scratch instance paths BEFORE the import: the module resolves them per call
// (process.env), but the suite's own seams must not be inherited here.
const ROOT = mkdtempSync(join(tmpdir(), "crow-home-perms-"));
process.env.CROW_HOME = join(ROOT, "home");
process.env.CROW_DATA_DIR = join(ROOT, "home", "data");
delete process.env.CROW_DB_PATH;
const HOME = process.env.CROW_HOME;
const DATA = process.env.CROW_DATA_DIR;
const DB = join(DATA, "crow.db");

const { tightenCrowHomePermissions, homePermissionTargets } = await import(
  "../servers/gateway/boot/tighten-home-permissions.js"
);

after(() => rmScratch(ROOT));

const mode = (p) => statSync(p).mode & 0o777;

/**
 * An install made before this repair: a 0755 home, a 0755 data dir and a 0644
 * database with the WAL/SHM a running SQLite had already created.
 */
function permissiveLayout({ home = 0o755, data = 0o755, db = 0o644, wal = 0o644, shm = 0o644 } = {}) {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  writeFileSync(DB, "db");
  writeFileSync(`${DB}-wal`, "wal");
  writeFileSync(`${DB}-shm`, "shm");
  chmodSync(HOME, home);
  chmodSync(DATA, data);
  chmodSync(DB, db);
  chmodSync(`${DB}-wal`, wal);
  chmodSync(`${DB}-shm`, shm);
}

test("boot tightens a 0755 home, 0755 data dir and 0644 db/-wal/-shm to 0700/0600, one line each", () => {
  permissiveLayout();
  assert.equal(mode(HOME), 0o755, "precondition: the legacy home is world-readable");
  assert.equal(mode(DB), 0o644, "precondition: the legacy database is world-readable");

  const lines = [];
  const tightened = tightenCrowHomePermissions({ log: (m) => lines.push(m) });

  assert.equal(mode(HOME), 0o700, "the Crow home must not stay group/other accessible");
  assert.equal(mode(DATA), 0o700, "the data dir must not stay group/other accessible");
  assert.equal(mode(DB), 0o600, "crow.db holds every memory and credential — 0600");
  assert.equal(mode(`${DB}-wal`), 0o600, "an existing WAL is tightened too");
  assert.equal(mode(`${DB}-shm`), 0o600, "an existing SHM is tightened too");

  assert.deepEqual(tightened.map((t) => t.id), ["home", "data", "db", "db-wal", "db-shm"]);
  assert.equal(lines.length, tightened.length, "exactly one log line per path that changed");
  assert.match(lines[0], /tightened Crow home .* to 0700 \(was 755\)/);
  const dbLine = lines.find((l) => l.includes("crow.db "));
  assert.ok(dbLine, "the database change is logged");
  assert.match(dbLine, /to 0600 \(was 644\)/);
});

test("already owner-only paths are a no-op (no chmod, no log line)", () => {
  permissiveLayout({ home: 0o700, data: 0o700, db: 0o600, wal: 0o600, shm: 0o600 });
  const lines = [];
  const tightened = tightenCrowHomePermissions({ log: (m) => lines.push(m) });

  assert.deepEqual(tightened, []);
  assert.deepEqual(lines, [], "a steady-state boot is silent");
  assert.equal(mode(HOME), 0o700);
  assert.equal(mode(DB), 0o600);
});

test("a symlinked crow.db is left alone: the target outside the instance is never chmod'ed", () => {
  permissiveLayout();
  const target = join(ROOT, "elsewhere.db");
  writeFileSync(target, "the real database");
  chmodSync(target, 0o644);
  unlinkSync(DB);
  symlinkSync(target, DB);

  const tightened = tightenCrowHomePermissions({ log: () => {} });

  assert.ok(lstatSync(DB).isSymbolicLink(), "the symlink itself is untouched");
  assert.equal(mode(target), 0o644, "the target is not ours to change");
  assert.ok(!tightened.some((t) => t.id === "db"), "the db entry is skipped, not fixed");
  // The rest of the layout is still repaired — one skipped path never stops the walk.
  assert.equal(mode(HOME), 0o700);
});

test("a path owned by another user is left alone", () => {
  permissiveLayout();
  const owner = lstatSync(DB).uid;
  const foreignUid = owner === 0 ? 1 : 0; // any uid that is not ours
  const lines = [];
  const tightened = tightenCrowHomePermissions({ uid: foreignUid, log: (m) => lines.push(m) });

  assert.deepEqual(tightened, [], "another user's files are theirs to fix");
  assert.deepEqual(lines, []);
  assert.equal(mode(HOME), 0o755);
  assert.equal(mode(DB), 0o644);
});

test("missing paths and a missing home never throw and are never created", () => {
  const saved = process.env.CROW_HOME;
  try {
    process.env.CROW_HOME = join(ROOT, "does-not-exist");
    process.env.CROW_DATA_DIR = join(ROOT, "does-not-exist", "data");
    const tightened = tightenCrowHomePermissions({ log: () => {} });
    assert.deepEqual(tightened, []);
    assert.equal(existsSync(join(ROOT, "does-not-exist")), false, "boot hardening never creates state");
    assert.doesNotThrow(() =>
      tightenCrowHomePermissions({ env: { CROW_HOME: join(ROOT, "nope", "home") }, log: () => {} }),
    );
  } finally {
    process.env.CROW_HOME = saved;
    process.env.CROW_DATA_DIR = DATA;
  }
});

test("homePermissionTargets lists each path once, even when the data dir is the home", () => {
  const targets = homePermissionTargets({
    CROW_HOME: "/srv/crow-home",
    CROW_DATA_DIR: "/srv/crow-home",
    CROW_DB_PATH: "/srv/crow-home/crow.db",
  });
  const paths = targets.map((t) => t.path);
  assert.equal(new Set(paths).size, paths.length, "no path is listed twice");
  assert.deepEqual(
    targets.map((t) => [t.id, t.mode]),
    [["home", 0o700], ["db", 0o600], ["db-wal", 0o600], ["db-shm", 0o600]],
    "a home that is also the data dir is checked once, as a directory",
  );
});