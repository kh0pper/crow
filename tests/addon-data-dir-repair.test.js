/**
 * Boot repair for add-on walls: an add-on installed before add-on walls existed has no
 * `<dataDir>/<id>` folder, and a walled spawn is refused without one. The repair makes
 * only the MISSING folder, only for a stdio add-on, and only on a host whose walls are on.
 *
 * Isolated exactly like tests/addon-install-data-dir.test.js: CROW_HOME/CROW_DATA_DIR
 * point at scratch dirs created BEFORE the dynamic import, so nothing here can touch a
 * real ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-addon-dirs-home-"));
process.env.CROW_DATA_DIR = join(process.env.CROW_HOME, "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
// The router's construction (and the boot repair) must not start background jobs.
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

const CROW_HOME = process.env.CROW_HOME;
const DATA_DIR = process.env.CROW_DATA_DIR;
const WALLS_PATH = join(CROW_HOME, "addon-walls.json");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");

const { repairMissingAddonDataDirs, repairInstalledBundleAssets } =
  await import("../servers/gateway/routes/bundles.js");
const { keptDataRecord, keptDataMatches } = await import("../servers/shared/addon-walls-file.js");

const WALLED = { CROW_ADDON_WALLS_DEFAULT: "walled" };

/** The stdio manifest shape `isStdioAddonManifest` answers about. */
const stdio = (id) => ({ id, name: id, version: "0.1.0", server: { command: "node", args: ["x.js"] } });
/** A docker-only add-on: no `server` block, so it owns no data folder. */
const dockerOnly = (id) => ({ id, name: id, version: "0.1.0", docker: { compose_file: "docker-compose.yml" } });

/** A scratch repo-shaped bundle source tree (`<appBundles>/<id>/manifest.json`). */
function scratchApp() {
  return mkdtempSync(join(tmpdir(), "crow-addon-dirs-app-"));
}

/** Write one add-on's manifest into an app tree. */
function writeManifest(app, manifest) {
  const dir = join(app, manifest.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** A clean slate: no wall file, no add-on data folders, no installed.json row. */
function resetHome() {
  rmSync(WALLS_PATH, { force: true });
  for (const entry of existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : []) {
    rmSync(join(DATA_DIR, entry), { recursive: true, force: true });
  }
  rmSync(INSTALLED_PATH, { force: true });
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "crow-addon-dirs-probe-"));
}

test("walls off: nothing is created, nothing is recorded, no wall file is written", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("off-addon"));
  const lines = [];
  const out = repairMissingAddonDataDirs({ installed: ["off-addon"], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: {}, log: (m) => lines.push(m) });
  assert.deepEqual(out.created, []);
  assert.equal(existsSync(join(DATA_DIR, "off-addon")), false, "walls off changes nothing");
  assert.equal(existsSync(WALLS_PATH), false, "nothing is recorded");
  assert.deepEqual(lines, []);
  resetHome();
  rmScratch(app);
});

test("walls on: the missing folder is made 0700, owned by Crow's user, and recorded", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("walled-addon"));
  const lines = [];
  const out = repairMissingAddonDataDirs({ installed: [{ id: "walled-addon" }], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: (m) => lines.push(m) });
  assert.deepEqual(out.created, ["walled-addon"]);
  assert.deepEqual(out.skipped, []);
  const dir = join(DATA_DIR, "walled-addon");
  assert.equal(statSync(dir).isDirectory(), true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(dir).uid, process.getuid());
  assert.equal(keptDataMatches(CROW_HOME, "walled-addon", dir), true, "the folder Crow made is Crow's kept data");
  assert.ok(keptDataRecord(CROW_HOME, "walled-addon"));
  assert.deepEqual(lines, ["walled-addon: data folder created for its wall"]);
  resetHome();
  rmScratch(app);
});

test("the kill switch wins over the per-host default: nothing is made", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("killed-addon"));
  const out = repairMissingAddonDataDirs({
    installed: ["killed-addon"], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR,
    env: { ...WALLED, CROW_ADDON_WALLS: "off" }, log: () => {},
  });
  assert.deepEqual(out, { created: [], skipped: [] });
  assert.equal(existsSync(join(DATA_DIR, "killed-addon")), false);
  assert.equal(existsSync(WALLS_PATH), false);
  resetHome();
  rmScratch(app);
});

test("a docker-only add-on needs no data folder", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, dockerOnly("docker-only-addon"));
  const out = repairMissingAddonDataDirs({ installed: ["docker-only-addon"], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: () => {} });
  assert.deepEqual(out.created, []);
  assert.equal(existsSync(join(DATA_DIR, "docker-only-addon")), false);
  assert.equal(existsSync(WALLS_PATH), false);
  resetHome();
  rmScratch(app);
});

test("an existing plain folder is left exactly as it is: file kept, mode kept, nothing recorded", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("owner-folder"));
  const dir = join(DATA_DIR, "owner-folder");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kept.txt"), "the owner's data\n");
  chmodSync(dir, 0o755);
  const out = repairMissingAddonDataDirs({ installed: ["owner-folder"], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: () => {} });
  assert.deepEqual(out, { created: [], skipped: [] });
  assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "the owner's data\n");
  assert.equal(statSync(dir).mode & 0o777, 0o755, "the folder's mode is not touched");
  assert.equal(keptDataRecord(CROW_HOME, "owner-folder"), null, "an owner's folder is never recorded as Crow's");
  assert.equal(existsSync(WALLS_PATH), false);
  resetHome();
  rmScratch(app);
});

test("a symlink at the path is left alone and reported as a skip, never followed", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("linked-addon"));
  const target = scratch();
  mkdirSync(join(target, "real"), { recursive: true });
  writeFileSync(join(target, "real", "file.txt"), "target data\n");
  chmodSync(join(target, "real"), 0o755);
  const dir = join(DATA_DIR, "linked-addon");
  symlinkSync(join(target, "real"), dir, "dir");
  const lines = [];
  const out = repairMissingAddonDataDirs({ installed: ["linked-addon"], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: (m) => lines.push(m) });
  assert.deepEqual(out.created, []);
  assert.deepEqual(out.skipped.map((s) => s.id), ["linked-addon"]);
  assert.ok(out.skipped[0].reason);
  assert.equal(lstatSync(dir).isSymbolicLink(), true, "the symlink is still a symlink");
  assert.equal(readFileSync(join(target, "real", "file.txt"), "utf8"), "target data\n");
  assert.equal(statSync(join(target, "real")).mode & 0o777, 0o755, "the target's mode is untouched");
  assert.equal(keptDataRecord(CROW_HOME, "linked-addon"), null);
  assert.equal(lines.length, 1, "one fixed line");
  assert.equal(lines[0].includes(dir), false, "the line never carries the path");
  assert.equal(lines[0].includes("linked-addon"), false, "the line is fixed text");
  resetHome();
  rmScratch(target);
  rmScratch(app);
});

test("a regular file at the path is left alone and reported as a skip", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("file-at-path"));
  const dir = join(DATA_DIR, "file-at-path");
  writeFileSync(dir, "not a folder\n");
  const out = repairMissingAddonDataDirs({ installed: ["file-at-path"], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: () => {} });
  assert.deepEqual(out.created, []);
  assert.deepEqual(out.skipped.map((s) => s.id), ["file-at-path"]);
  assert.equal(readFileSync(dir, "utf8"), "not a folder\n");
  assert.equal(keptDataRecord(CROW_HOME, "file-at-path"), null);
  resetHome();
  rmScratch(app);
});

test("a missing dataDir is a skip, not a tree: nothing is made and nothing throws", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("no-parent"));
  const missing = join(scratch(), "does-not-exist");
  const out = repairMissingAddonDataDirs({ installed: ["no-parent"], appBundles: app, crowHome: CROW_HOME, dataDir: missing, env: WALLED, log: () => {} });
  assert.deepEqual(out.created, []);
  assert.deepEqual(out.skipped.map((s) => s.id), ["no-parent"]);
  assert.equal(existsSync(missing), false, "never recursive: the data dir is not created");
  resetHome();
  rmScratch(app);
});

test("a second call is a no-op: the folder the first call made is left as it is", () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("twice-addon"));
  const first = repairMissingAddonDataDirs({ installed: ["twice-addon"], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: () => {} });
  assert.deepEqual(first.created, ["twice-addon"]);
  const wallsBefore = readFileSync(WALLS_PATH, "utf8");
  const second = repairMissingAddonDataDirs({ installed: ["twice-addon"], appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: () => {} });
  assert.deepEqual(second, { created: [], skipped: [] });
  assert.equal(readFileSync(WALLS_PATH, "utf8"), wallsBefore, "nothing is written on a folder that already exists");
  assert.equal(keptDataMatches(CROW_HOME, "twice-addon", join(DATA_DIR, "twice-addon")), true);
  resetHome();
  rmScratch(app);
});

test("an invalid id and a satellite entry are skipped", () => {
  resetHome();
  const app = scratchApp();
  // Both would qualify as stdio add-ons if their entry were valid: the entry is the rule.
  writeManifest(app, stdio("sat-addon"));
  const out = repairMissingAddonDataDirs({
    installed: ["../x", { id: "sat-addon", mode: "satellite", host: "sat-1" }],
    appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: () => {},
  });
  assert.deepEqual(out.created, []);
  assert.deepEqual(out.skipped.map((s) => s.id).sort(), ["../x", "sat-addon"]);
  assert.equal(existsSync(join(DATA_DIR, "sat-addon")), false, "a satellite-hosted add-on has no folder here");
  assert.equal(existsSync(WALLS_PATH), false);
  resetHome();
  rmScratch(app);
});

test("hostile installed entries never throw", () => {
  resetHome();
  const app = scratchApp();
  const out = repairMissingAddonDataDirs({
    installed: [null, 42, {}, { id: 7 }, { id: "../etc" }],
    appBundles: app, crowHome: CROW_HOME, dataDir: DATA_DIR, env: WALLED, log: () => {},
  });
  assert.deepEqual(out.created, []);
  resetHome();
  rmScratch(app);
});

// --- through the boot repair ---------------------------------------------------

test("the boot repair reports a data folder it made, before the per-bundle loop", async () => {
  resetHome();
  const app = scratchApp();
  writeManifest(app, stdio("repair-addon"));
  writeFileSync(INSTALLED_PATH, JSON.stringify([{ id: "repair-addon", type: "bundle" }]));
  const lines = [];
  try {
    const out = await repairInstalledBundleAssets({
      appBundles: app,
      run: async () => ({ stdout: "", stderr: "" }),
      skillMode: "off",
      log: (m) => lines.push(m),
      env: WALLED,
    });
    assert.ok(
      out.repaired.includes("repair-addon: data folder created for its wall"),
      JSON.stringify(out.repaired),
    );
    assert.deepEqual(out.errors, []);
    assert.equal(existsSync(join(DATA_DIR, "repair-addon")), true);
    assert.equal(keptDataMatches(CROW_HOME, "repair-addon", join(DATA_DIR, "repair-addon")), true);
    // Idempotent through the boot repair too: a second boot creates nothing.
    const again = await repairInstalledBundleAssets({
      appBundles: app, run: async () => ({ stdout: "", stderr: "" }), skillMode: "off", log: () => {}, env: WALLED,
    });
    assert.ok(!again.repaired.includes("repair-addon: data folder created for its wall"));
  } finally {
    resetHome();
    rmScratch(app);
  }
});