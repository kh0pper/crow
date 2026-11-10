import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Isolated exactly like tests/bundles-install-job.test.js: routes/bundles.js resolves
// CROW_HOME-derived paths at module load, and servers/db.js's resolveDataDir() reads
// CROW_DATA_DIR at call time. Both point at scratch dirs created BEFORE the dynamic
// import, so nothing here can touch a real ~/.crow (or a real ~/.crow/data).
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
process.env.CROW_DATA_DIR = join(process.env.CROW_HOME, "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
// The router's construction (and the uninstall route) must not start background jobs.
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CROW_HOME = process.env.CROW_HOME;
const DATA_DIR = process.env.CROW_DATA_DIR;
const WALLS_PATH = join(CROW_HOME, "addon-walls.json");
const MCP_ADDONS_PATH = join(CROW_HOME, "mcp-addons.json");

const {
  validateInstall, addonDataDirRefusal, ensureAddonDataDir,
  runInstallJob, _createJobForTest, _getJobForTest, _finishJobForTest,
  _setAppBundlesForTest,
  default: bundlesRouter,
} = await import("../servers/gateway/routes/bundles.js");
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
  mkdirSync(ADDON_DIR, { recursive: true });
  const old = bigStat(ADDON_DIR);
  // Rename aside instead of deleting: the renamed folder keeps the original inode in use,
  // so a new folder at the same path cannot be handed the same dev/ino by the filesystem.
  const oldPath = `${ADDON_DIR}-old`;
  renameSync(ADDON_DIR, oldPath);
  assert.equal(recordKeptData(CROW_HOME, ID, old), true, "a record may outlive its folder");

  mkdirSync(ADDON_DIR);
  const st = bigStat(ADDON_DIR);
  assert.notEqual(String(st.ino), String(old.ino), "the new folder is a different folder");
  assert.notEqual(`${st.dev}:${st.ino}`, `${old.dev}:${old.ino}`, "the new folder is a different dev/ino pair");
  assert.equal(keptDataMatches(CROW_HOME, ID, ADDON_DIR), false);
  const refused = addonDataDirRefusal(STDIO_MANIFEST, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "addon_data_dir_exists");
  reset();
  rmSync(oldPath, { recursive: true, force: true });
});

test("the record stays after a successful ensureAddonDataDir, so an in-place reinstall finds it", () => {
  reset();
  ensureAddonDataDir(ID, STDIO_MANIFEST);
  assert.notEqual(keptDataRecord(CROW_HOME, ID), null, "the folder Crow made is still recorded");
  // That record is what lets a reinstall over the same folder (the install folder removed,
  // the data folder kept) go through without an uninstall.
  assert.equal(addonDataDirRefusal(STDIO_MANIFEST, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME }), null);
  ensureAddonDataDir(ID, STDIO_MANIFEST);
  assert.notEqual(keptDataRecord(CROW_HOME, ID), null, "a second pass over the same folder keeps the record");
  reset();
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

// --- the install job leaves no MCP entry behind ---------------------------------

// A repo-shaped source tree, so runInstallJob/uninstall read a manifest and copy files
// without touching the real bundles/ (the seam tests/bundles-webui-lifecycle.test.js uses).
const FIXTURES = mkdtempSync(join(tmpdir(), "crow-addon-fixtures-"));

/** Write one fixture add-on's source tree (manifest + a stub server file). */
function fixtureAddon(id, manifest) {
  const dir = join(FIXTURES, id);
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, version: "0.1.0", ...manifest }, null, 2));
  writeFileSync(join(dir, "server", "index.js"), "// stub payload\n");
  return dir;
}

/** Point manifest lookup at the fixture tree for one test, then back at the repo copy. */
async function withFixtures(fn) {
  _setAppBundlesForTest(FIXTURES);
  try { await fn(); } finally { _setAppBundlesForTest(join(REPO, "bundles")); }
}

/** An add-on the route believes is installed: source manifest, installed folder, installed.json row. */
function seedInstalled(id, manifest) {
  fixtureAddon(id, manifest);
  const installDir = join(CROW_HOME, "bundles", id);
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "manifest.json"), JSON.stringify({ id, name: id, version: "0.1.0", ...manifest }, null, 2));
  const installedPath = join(CROW_HOME, "installed.json");
  const installed = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, "utf8")) : [];
  writeFileSync(installedPath, JSON.stringify(
    [...installed.filter((i) => i.id !== id), { id, type: manifest.type || "bundle", version: "0.1.0" }], null, 2,
  ));
  return installDir;
}

/** The bundles router over real HTTP on a loopback port. */
async function withRouter(fn) {
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

/** POST the uninstall and wait for its job to reach a terminal status. */
async function uninstall(base, bundleId) {
  const res = await fetch(`${base}/bundles/api/uninstall`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle_id: bundleId }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `uninstall POST rejected: ${JSON.stringify(body)}`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = _getJobForTest(body.job_id);
    if (job && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`uninstall job ${body.job_id} never finished`);
}

// A stdio add-on of the plainest shape: a node `server` block and nothing that needs
// docker, a panel or a skill, so the uninstall has no side path to fail on.
const FIXTURE_MANIFEST = { type: "bundle", server: { command: "node", args: ["server/index.js"], envKeys: [] } };

const MISMATCH_LINE = "Kept data folder was not recorded: it is not the folder Crow made";
const NOT_OURS_LINE = "Kept data folder was not recorded: it is not a plain folder owned by Crow";

function cleanupFixture(id) {
  rmSync(join(CROW_HOME, "bundles", id), { recursive: true, force: true });
  rmSync(join(DATA_DIR, id), { recursive: true, force: true });
  rmSync(join(FIXTURES, id), { recursive: true, force: true });
  if (existsSync(WALLS_PATH)) clearKeptData(CROW_HOME, id);
}

test("runInstallJob fails before registering the MCP server when the data folder is not Crow's", async () => {
  const id = "fx-datadir-refused";
  const manifest = { ...FIXTURE_MANIFEST, id, name: id, version: "0.1.0", type: "mcp-server" };
  fixtureAddon(id, manifest);
  // The folder nobody recorded: the install must fail instead of starting inside it.
  mkdirSync(join(DATA_DIR, id), { recursive: true });
  rmSync(MCP_ADDONS_PATH, { force: true });
  const job = _createJobForTest(id, "install");
  try {
    await withFixtures(async () => {
      const out = await runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
      assert.equal(out.ok, false, "an install must not report success without its data folder");
      assert.match(String(out.reason), /a folder for this add-on appeared during the install/);
      const doc = existsSync(MCP_ADDONS_PATH) ? JSON.parse(readFileSync(MCP_ADDONS_PATH, "utf8")) : {};
      assert.equal(doc[id] ?? null, null, "no MCP entry may be left for an add-on whose data folder was refused");
      assert.ok(job.log.some((l) => /^Install failed: a folder for this add-on appeared/.test(l)), job.log.join("\n"));
    });
  } finally {
    _finishJobForTest(job, "failed");
  }
  assert.equal(keptDataRecord(CROW_HOME, id), null, "the refused folder is never recorded");
  cleanupFixture(id);
});

// --- the uninstall route's kept-data decision -----------------------------------

test("an uninstall keeps the record of the folder Crow made, without rewriting it", async () => {
  const id = "fx-kept-same";
  const keptDir = join(DATA_DIR, id);
  await withFixtures(async () => {
    seedInstalled(id, FIXTURE_MANIFEST);
    mkdirSync(keptDir, { recursive: true });
    assert.equal(recordKeptData(CROW_HOME, id, bigStat(keptDir)), true);
    const before = readFileSync(WALLS_PATH, "utf8");
    const record = keptDataRecord(CROW_HOME, id);

    await withRouter(async (base) => {
      const job = await uninstall(base, id);
      assert.equal(job.status, "complete", job.log.join("\n"));
      assert.ok(!job.log.some((l) => l.includes("Kept data folder was not recorded")), job.log.join("\n"));
      assert.equal(readFileSync(WALLS_PATH, "utf8"), before, "the matching record is left exactly as it is");
      assert.deepEqual(keptDataRecord(CROW_HOME, id), record);
    });
  });
  cleanupFixture(id);
});

test("an uninstall records a plain folder Crow owns when there was no record yet", async () => {
  const id = "fx-kept-norecord";
  const keptDir = join(DATA_DIR, id);
  await withFixtures(async () => {
    seedInstalled(id, FIXTURE_MANIFEST);
    mkdirSync(keptDir, { recursive: true });
    assert.equal(keptDataRecord(CROW_HOME, id), null, "nothing recorded before the uninstall");
    const st = bigStat(keptDir);

    await withRouter(async (base) => {
      const job = await uninstall(base, id);
      assert.equal(job.status, "complete", job.log.join("\n"));
      assert.ok(!job.log.some((l) => l.includes("Kept data folder was not recorded")), job.log.join("\n"));
      const rec = keptDataRecord(CROW_HOME, id);
      assert.notEqual(rec, null, "the folder the install made is kept by the uninstall");
      assert.equal(rec.dev, String(st.dev));
      assert.equal(rec.ino, String(st.ino));
      // A reinstall over that same folder is therefore allowed.
      assert.equal(keptDataMatches(CROW_HOME, id, keptDir), true);
    });
  });
  cleanupFixture(id);
});

test("an uninstall does not re-record a folder swapped in after the install", async () => {
  const id = "fx-kept-swapped";
  const keptDir = join(DATA_DIR, id);
  const movedAside = `${keptDir}-moved-aside`;
  await withFixtures(async () => {
    seedInstalled(id, FIXTURE_MANIFEST);
    // The folder the install made, recorded from its own lstat.
    mkdirSync(keptDir, { recursive: true });
    assert.equal(recordKeptData(CROW_HOME, id, bigStat(keptDir)), true);
    const record = keptDataRecord(CROW_HOME, id);
    const walls = readFileSync(WALLS_PATH, "utf8");

    // Swapped in after the install: the original moves aside, a new folder takes the path.
    renameSync(keptDir, movedAside);
    mkdirSync(keptDir);

    await withRouter(async (base) => {
      const job = await uninstall(base, id);
      assert.equal(job.status, "complete", job.log.join("\n"));
      assert.ok(job.log.includes(MISMATCH_LINE), job.log.join("\n"));
      assert.ok(!job.log.includes(NOT_OURS_LINE), "the record exists, so this is the mismatch case");
      assert.equal(readFileSync(WALLS_PATH, "utf8"), walls, "nothing is written for a folder that is not the recorded one");
      assert.deepEqual(keptDataRecord(CROW_HOME, id), record, "the record still names the folder Crow made");

      // A later reinstall over the swapped-in folder is refused.
      const r = await validateInstall(id, { forceInstall: true });
      assert.equal(r.ok, false);
      assert.equal(r.status, 409);
      assert.equal(r.code, "addon_data_dir_exists");
      assert.equal(r.extra.code, "addon_data_dir_exists");
    });
  });
  rmSync(movedAside, { recursive: true, force: true });
  cleanupFixture(id);
});