import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

const { validateInstall, addonDataDirRefusal } = await import("../servers/gateway/routes/bundles.js");
const { addonWallsPath, readAddonWalls, writeAddonWalls, hasKeptData, markKeptData, clearKeptData } =
  await import("../servers/shared/addon-walls-file.js");

// The bundle under test: 'kiosk' ships a node `server` (command + args, no `server.url`),
// a docker-compose-free mcp-server type, and no consent requirement — the plainest stdio
// add-on in the tree, so every gate ahead of the new refusal is either skipped or
// bypassed with forceInstall.
const ID = "kiosk";
const ADDON_DIR = join(DATA_DIR, ID);

/** A clean slate: no wall file, no add-on data folder (a symlink included). */
function reset() {
  rmSync(WALLS_PATH, { force: true });
  rmSync(ADDON_DIR, { force: true, recursive: true });
}

test("a pre-existing data folder refuses the install with 409 addon_data_dir_exists", async () => {
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

test("a pre-existing data folder that is a symlink is refused too", async () => {
  reset();
  const target = mkdtempSync(join(tmpdir(), "crow-addon-probe-"));
  symlinkSync(target, ADDON_DIR, "dir");
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "addon_data_dir_exists");
  assert.equal(existsSync(MCP_ADDONS_PATH), false);
  reset();
  rmSync(target, { recursive: true, force: true });
});

test("no existing data folder → the install is allowed", async () => {
  reset();
  assert.equal(existsSync(ADDON_DIR), false);
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.id, ID);
});

test("a kept data folder recorded in <CROW_HOME>/addon-walls.json is allowed", async () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  writeFileSync(WALLS_PATH, JSON.stringify({ keptData: [ID] }));
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.id, ID);
  reset();
});

test("a keptData file planted INSIDE the add-on's data folder grants nothing", async () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  writeFileSync(join(ADDON_DIR, "addon-walls.json"), JSON.stringify({ keptData: [ID] }));
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
  assert.equal(hasKeptData(CROW_HOME, ID), false);
  const r = await validateInstall(ID, { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "addon_data_dir_exists");
  reset();
});

test("addon-walls.json round-trips, is 0600, and keptData stays sorted and unique", () => {
  reset();
  assert.equal(addonWallsPath(CROW_HOME), WALLS_PATH);
  assert.deepEqual(readAddonWalls(CROW_HOME), {}, "a missing file reads as {}");

  writeAddonWalls(CROW_HOME, { keptData: ["b-addon"] });
  assert.equal(statSync(WALLS_PATH).mode & 0o777, 0o600);
  assert.deepEqual(readAddonWalls(CROW_HOME), { keptData: ["b-addon"] });

  assert.equal(markKeptData(CROW_HOME, "a-addon"), true);
  assert.equal(markKeptData(CROW_HOME, "a-addon"), true);
  assert.deepEqual(readAddonWalls(CROW_HOME).keptData, ["a-addon", "b-addon"], "sorted, one entry per id");
  assert.equal(hasKeptData(CROW_HOME, "a-addon"), true);
  assert.equal(statSync(WALLS_PATH).mode & 0o777, 0o600, "the rename/chmod keeps the file private");

  assert.equal(clearKeptData(CROW_HOME, "a-addon"), true);
  assert.equal(hasKeptData(CROW_HOME, "a-addon"), false);
  assert.deepEqual(readAddonWalls(CROW_HOME).keptData, ["b-addon"]);

  // An id this file may never hold is a no-op, never a write.
  assert.equal(markKeptData(CROW_HOME, "../x"), false);
  assert.equal(markKeptData(CROW_HOME, "Upper"), false);
  assert.equal(clearKeptData(CROW_HOME, "../x"), false);
  assert.equal(hasKeptData(CROW_HOME, "../x"), false);
  assert.deepEqual(readAddonWalls(CROW_HOME).keptData, ["b-addon"]);
  assert.equal(JSON.parse(readFileSync(WALLS_PATH, "utf8")).keptData.includes("../x"), false);
  reset();
});

test("a remote MCP (server.url) or an add-on with no server is never refused by the data-dir rule", () => {
  reset();
  mkdirSync(ADDON_DIR, { recursive: true });
  const remote = { id: ID, server: { url: "https://example.invalid/mcp", envKeys: [] } };
  assert.equal(addonDataDirRefusal(remote, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME }), null);
  const noServer = { id: ID, type: "skill" };
  assert.equal(addonDataDirRefusal(noServer, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME }), null);
  // The same folder, for a stdio manifest, IS refused — so the two nulls above are the rule, not an absent dir.
  const stdio = { id: ID, server: { command: "node", args: ["server/index.js"], envKeys: [] } };
  const refused = addonDataDirRefusal(stdio, ID, { dataDir: DATA_DIR, crowHome: CROW_HOME });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "addon_data_dir_exists");
  reset();
});