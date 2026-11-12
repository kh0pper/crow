/**
 * `requires.bundles` must count an add-on that is registered only in mcp-addons.json as
 * installed (servers/gateway/routes/bundles.js dependencyInstalledIds): such an add-on has its
 * bundle dir and its MCP entry but no installed.json record. A dependent bundle (music requires
 * funkwhale) installs against it, and the consent prereq list does not call it missing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// bundles.js resolves CROW_HOME, BUNDLES_DIR, INSTALLED_PATH and MCP_ADDONS_PATH at module
// load: point them at a scratch home before the import, so nothing here reads or writes a
// real Crow home.
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-addons-only-home-"));
process.env.CROW_DATA_DIR = join(process.env.CROW_HOME, "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

const { dependencyInstalledIds, validateInstall } = await import("../servers/gateway/routes/bundles.js");

const HOME = process.env.CROW_HOME;
const DEFAULT_ADDONS_PATH = join(HOME, "mcp-addons.json");

function scratchPath(name) {
  return join(mkdtempSync(join(tmpdir(), "crow-addons-only-")), name);
}

function writeRaw(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeJson(path, data) {
  writeRaw(path, JSON.stringify(data, null, 2));
}

function removeIfPresent(path) {
  rmSync(path, { force: true });
}

test("ids come from installed.json entries and from mcp-addons keys together", () => {
  const addonsPath = scratchPath("mcp-addons.json");
  writeJson(addonsPath, { funkwhale: { env: {} }, gallery: {} });

  const ids = dependencyInstalledIds([{ id: "music" }, "clock"], addonsPath);

  assert.deepEqual([...ids].sort(), ["clock", "funkwhale", "gallery", "music"]);
});

test("the module's own mcp-addons.json is the file read", () => {
  writeJson(DEFAULT_ADDONS_PATH, { funkwhale: {} });
  try {
    assert.ok(dependencyInstalledIds([]).has("funkwhale"));
  } finally {
    removeIfPresent(DEFAULT_ADDONS_PATH);
  }
});

test("a missing mcp-addons file contributes nothing", () => {
  const addonsPath = scratchPath("absent.json");

  assert.deepEqual([...dependencyInstalledIds([{ id: "music" }], addonsPath)], ["music"]);
});

test("an unparseable mcp-addons file contributes nothing", () => {
  const addonsPath = scratchPath("broken.json");
  writeRaw(addonsPath, "{ not json");

  assert.deepEqual([...dependencyInstalledIds([{ id: "music" }], addonsPath)], ["music"]);
});

test("an array-shaped mcp-addons file contributes no ids", () => {
  const addonsPath = scratchPath("array.json");
  writeJson(addonsPath, ["funkwhale"]);

  assert.deepEqual([...dependencyInstalledIds([{ id: "music" }], addonsPath)], ["music"]);
});

test("validateInstall lets a dependency that is only an mcp-addons key through", async () => {
  removeIfPresent(DEFAULT_ADDONS_PATH);
  writeJson(DEFAULT_ADDONS_PATH, { funkwhale: { env: {} } });
  try {
    const out = await validateInstall("music", { forceInstall: true });
    assert.notEqual(out.code, "missing_dependencies");
    assert.deepEqual(out.extra?.missing_dependencies ?? [], []);
    assert.equal(out.ok, true);
  } finally {
    removeIfPresent(DEFAULT_ADDONS_PATH);
  }
});

test("validateInstall still refuses a dependency found in neither place", async () => {
  removeIfPresent(DEFAULT_ADDONS_PATH);

  const out = await validateInstall("music");

  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(out.code, "missing_dependencies");
  assert.deepEqual(out.extra.missing_dependencies, ["funkwhale"]);
});