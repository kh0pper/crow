import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated exactly like tests/bundles-install-job.test.js: routes/bundles.js resolves
// CROW_HOME-derived paths at module load, and servers/db.js's resolveDataDir() reads
// CROW_DATA_DIR at call time. Both point at scratch dirs created BEFORE the dynamic
// import, so nothing here can touch a real ~/.crow (or a real ~/.crow/data).
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
process.env.CROW_DATA_DIR = join(process.env.CROW_HOME, "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

const CROW_HOME = process.env.CROW_HOME;
const DATA_DIR = process.env.CROW_DATA_DIR;
const WALLS_PATH = join(CROW_HOME, "addon-walls.json");
const MCP_ADDONS_PATH = join(CROW_HOME, "mcp-addons.json");

const { validateInstall, addonDataDirRefusal, ensureAddonDataDir } = await import("../servers/gateway/routes/bundles.js");
const { addonWallsPath, readAddonWalls, writeAddonWalls, keptDataRecord, recordKeptData, clearKeptData, keptDataMatches } =
  await import("../servers/shared/addon-walls-file.js");

// The bundle under test: 'kiosk' ships a node `server` (command + args, no `server.url`),
// a docker-compose-free mcp-server type, and no consent requirement — the plainest stdio
// add-on in the tree, so every gate ahead of the new refusal is either skipped or
// bypassed with forceInstall.
const ID = "kiosk";
const ADDON_DIR = join(DATA_DIR, ID);

/** The stdio manifest shape `addonDataDirRefusal` / `ensureAddonDataDir` answer about. */
const STDIO_MANIFEST = { id: ID, server: { command: "node", args: ["server/index.js"], envKeys: [] } };

/** A bigint lstat, the shape the record API takes and compares against. */
function bigStat(path) {
  return lstatSync(path, { bigint: true });
}

/** A clean slate: no wall file, no add-on data folder (a symlink included). */
function reset() {
  rmSync(WALLS_PATH, { force: true });
  rmSync(ADDON_DIR, { force: true, recursive: true });
}

/** A scratch directory outside the data dir, for probe folders and symlink targets. */
function scratch() {
  return mkdtempSync(join(tmpdir(), "crow-addon-probe-"));
}

test("a pre-existing data folder with no record refuses the install with 409 addon_data_dir_exists", async () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "addon_data_dir_exists");
  assert.equal(r.extra.code, "addon_data_dir_exists");
  assert.match(r.error, /already exists/);
  assert.equal(existsSync(MCP_ADDONS_PATH), false, "a refused install must not register anything");
  reset();
});

test("a symlink at the path is refused even with a record copied from its target", async () => {
  reset();
  const target = scratch();
  mkdirSync(join(target, "real"), { recursive: true });
  symlinkSync(join(target, "real"), ADDON_DIR, "dir");
  // The record names the symlink's TARGET: the path itself is a symlink, not a directory.
  assert.equal(recordKeptData(CROW_HOME, ID, bigStat(join(target, "real"))), true);
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "addon_data_dir_exists");
  assert.equal(existsSync(MCP_ADDONS_PATH), false);
  reset();
  rmSync(target, { recursive: true, force: true });
});

test("a record taken from a folder that was removed, then a new folder at the same path, is refused", () => {
  reset();
  const probe = scratch();
  mkdirSync(ADDON_DIR, { recursive: true });
  const old = bigStat(ADDON_DIR);
  rmSync(ADDON_DIR, { recursive: true, force: true });
  assert.equal(recordKeptData(CROW_HOME, ID, old), true, "a record may outlive its folder");

  // tmpfs may hand the freed inode straight back; burn through them until the new
  // folder really is a different one.
  let st = null;
  for (let i = 0; i < 20; i += 1) {
    mkdirSync(ADDON_DIR);
    st = bigStat(ADDON_DIR);
    if (String(st.ino) !== String(old.ino)) break;
    rmSync(ADDON_DIR, { recursive: true, force: true });
    mkdirSync(join(probe, `burn-${i}`));
  }
  assert.notEqual(String(st.ino), String(old.ino), "the new folder is a different folder");
  if (!existsSync(ADDON_DIR)) mkdirSync(ADDON_DIR);
  assert.equal(keptDataMatches(CROW_HOME, ID, ADDON_DIR), false);
  const refused = addonDataDirRefusal(STDIO_MANIFEST, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "addon_data_dir_exists");
  reset();
  rmSync(probe, { recursive: true, force: true });
});

test("a genuine kept data folder (record taken from its own lstat) is allowed", async () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  assert.equal(recordKeptData(CROW_HOME, ID, bigStat(ADDON_DIR)), true);
  assert.equal(keptDataMatches(CROW_HOME, ID, ADDON_DIR), true);
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.id, ID);
  reset();
});

test("a legacy plain-string keptData entry grants nothing", async () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  writeFileSync(WALLS_PATH, JSON.stringify({ keptData: [ID] }));
  assert.equal(keptDataRecord(CROW_HOME, ID), null);
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "addon_data_dir_exists");
  reset();
});

test("a record missing a field grants nothing", () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  const st = bigStat(ADDON_DIR);
  const full = { id: ID, dev: String(st.dev), ino: String(st.ino), uid: Number(st.uid) };
  for (const missing of ["dev", "ino", "uid"]) {
    const partial = { ...full };
    delete partial[missing];
    writeFileSync(WALLS_PATH, JSON.stringify({ keptData: [partial] }));
    assert.equal(keptDataRecord(CROW_HOME, ID), null, `a record without ${missing} is ignored`);
    assert.equal(keptDataMatches(CROW_HOME, ID, ADDON_DIR), false);
    assert.equal(
      addonDataDirRefusal(STDIO_MANIFEST, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME }).code,
      "addon_data_dir_exists",
    );
  }
  reset();
});

test("the path is absent while a record exists → allowed, and the record is gone afterwards", async () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  const st = bigStat(ADDON_DIR);
  assert.equal(recordKeptData(CROW_HOME, ID, st), true);
  rmSync(ADDON_DIR, { recursive: true, force: true });
  assert.notEqual(keptDataRecord(CROW_HOME, ID), null, "the record survives the folder for now");

  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, true);
  assert.equal(keptDataRecord(CROW_HOME, ID), null, "the stale record is dropped");
  reset();
});

test("a keptData file planted INSIDE the add-on's data folder grants nothing", async () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  writeFileSync(join(ADDON_DIR, "addon-walls.json"), JSON.stringify({ keptData: [{ id: ID }] }));
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "addon_data_dir_exists");
  reset();
});

test("an unparsable <CROW_HOME>/addon-walls.json grants nothing", async () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  writeFileSync(WALLS_PATH, "{ this is not json");
  assert.deepEqual(readAddonWalls(CROW_HOME), {});
  assert.equal(keptDataRecord(CROW_HOME, ID), null);
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "addon_data_dir_exists");
  reset();
});

test("addon-walls.json round-trips, is 0600, and keeps one record per id in id order", () => {
  reset();
  assert.equal(addonWallsPath(CROW_HOME), WALLS_PATH);
  assert.deepEqual(readAddonWalls(CROW_HOME), {}, "a missing file reads as {}");

  const probe = scratch();
  const dirB = join(probe, "b");
  const dirA1 = join(probe, "a1");
  const dirA2 = join(probe, "a2");
  for (const d of [dirB, dirA1, dirA2]) mkdirSync(d, { recursive: true });

  writeAddonWalls(CROW_HOME, { keptData: [] });
  assert.equal(statSync(WALLS_PATH).mode & 0o777, 0o600);
  assert.deepEqual(readAddonWalls(CROW_HOME), { keptData: [] });

  assert.equal(recordKeptData(CROW_HOME, "b-addon", bigStat(dirB)), true);
  assert.equal(recordKeptData(CROW_HOME, "a-addon", bigStat(dirA1)), true);
  const doc = readAddonWalls(CROW_HOME);
  assert.deepEqual(doc.keptData.map((r) => r.id), ["a-addon", "b-addon"], "one record per id, in id order");
  const rec = keptDataRecord(CROW_HOME, "a-addon");
  assert.deepEqual(rec, {
    id: "a-addon",
    dev: String(bigStat(dirA1).dev),
    ino: String(bigStat(dirA1).ino),
    uid: Number(bigStat(dirA1).uid),
  });
  assert.equal(typeof rec.dev, "string");
  assert.equal(typeof rec.ino, "string");
  assert.equal(typeof rec.uid, "number");
  assert.equal(statSync(WALLS_PATH).mode & 0o777, 0o600, "the rename/chmod keeps the file private");

  // A second record for the same id replaces the first.
  assert.equal(recordKeptData(CROW_HOME, "a-addon", bigStat(dirA2)), true);
  assert.deepEqual(readAddonWalls(CROW_HOME).keptData.map((r) => r.id), ["a-addon", "b-addon"]);
  assert.equal(keptDataRecord(CROW_HOME, "a-addon").ino, String(bigStat(dirA2).ino));
  assert.equal(keptDataMatches(CROW_HOME, "a-addon", dirA1), false, "the replaced folder matches nothing");

  assert.equal(clearKeptData(CROW_HOME, "a-addon"), true);
  assert.equal(keptDataRecord(CROW_HOME, "a-addon"), null);
  assert.deepEqual(readAddonWalls(CROW_HOME).keptData.map((r) => r.id), ["b-addon"]);

  // An id this file may never hold is a no-op, never a write.
  assert.equal(recordKeptData(CROW_HOME, "../x", bigStat(dirA1)), false);
  assert.equal(recordKeptData(CROW_HOME, "Upper", bigStat(dirA1)), false);
  assert.equal(clearKeptData(CROW_HOME, "../x"), false);
  assert.equal(keptDataRecord(CROW_HOME, "../x"), null);
  assert.equal(keptDataMatches(CROW_HOME, "../x", dirA1), false);
  assert.deepEqual(readAddonWalls(CROW_HOME).keptData.map((r) => r.id), ["b-addon"]);
  assert.equal(JSON.parse(readFileSync(WALLS_PATH, "utf8")).keptData.some((r) => r.id === "../x"), false);
  reset();
  rmSync(probe, { recursive: true, force: true });
});

test("ensureAddonDataDir creates a fresh folder 0700 and records it", () => {
  reset();
  assert.equal(existsSync(ADDON_DIR), false);
  ensureAddonDataDir(ID, STDIO_MANIFEST);
  assert.equal(statSync(ADDON_DIR).mode & 0o777, 0o700);
  const st = bigStat(ADDON_DIR);
  const rec = keptDataRecord(CROW_HOME, ID);
  assert.notEqual(rec, null, "the folder Crow made is recorded");
  assert.equal(rec.dev, String(st.dev));
  assert.equal(rec.ino, String(st.ino));
  assert.equal(rec.uid, Number(st.uid));
  assert.equal(keptDataMatches(CROW_HOME, ID, ADDON_DIR), true);
  reset();
});

test("a second ensureAddonDataDir call with the matching record succeeds", () => {
  reset();
  ensureAddonDataDir(ID, STDIO_MANIFEST);
  const before = keptDataRecord(CROW_HOME, ID);
  ensureAddonDataDir(ID, STDIO_MANIFEST);
  assert.deepEqual(keptDataRecord(CROW_HOME, ID), before, "the matching folder is kept as it is");
  reset();
});

test("ensureAddonDataDir throws when a folder appeared with no record", () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  assert.throws(
    () => ensureAddonDataDir(ID, STDIO_MANIFEST),
    /a folder for this add-on appeared during the install; remove or rename it, then install again/,
  );
  assert.equal(keptDataRecord(CROW_HOME, ID), null, "a refused folder is never recorded");
  reset();
});

test("ensureAddonDataDir throws when the path is a symlink", () => {
  reset();
  const target = scratch();
  mkdirSync(join(target, "real"), { recursive: true });
  symlinkSync(join(target, "real"), ADDON_DIR, "dir");
  // Even a record naming the target's own folder does not make a symlink acceptable.
  recordKeptData(CROW_HOME, ID, bigStat(join(target, "real")));
  assert.throws(
    () => ensureAddonDataDir(ID, STDIO_MANIFEST),
    /a folder for this add-on appeared during the install/,
  );
  reset();
  rmSync(target, { recursive: true, force: true });
});

test("a remote MCP (server.url) or an add-on with no server is never refused by the data-dir rule", () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  const remote = { id: ID, server: { url: "https://example.invalid/mcp", envKeys: [] } };
  assert.equal(addonDataDirRefusal(remote, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME }), null);
  const noServer = { id: ID, type: "skill" };
  assert.equal(addonDataDirRefusal(noServer, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME }), null);
  // …and neither kind gets a data folder made for it.
  ensureAddonDataDir(ID, remote);
  ensureAddonDataDir(ID, noServer);
  // The same folder, for a stdio manifest, IS refused — so the two nulls above are the rule, not an absent dir.
  const refused = addonDataDirRefusal(STDIO_MANIFEST, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "addon_data_dir_exists");
  reset();
});