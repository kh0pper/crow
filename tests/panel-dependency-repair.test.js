/**
 * Boot repair for DEPENDENCY panels (servers/gateway/routes/bundles.js
 * repairDependencyPanels): a panel another installed bundle's manifest requires is served and
 * enabled even when nobody registered it, and nothing else is touched. The served bytes come from
 * whichever copy the version rule picks: the repo's when it is a different version than the
 * installed copy (and that copy does not carry `"refresh": false`), else the installed one.
 *
 * Every path is a scratch directory passed explicitly to the function; the module's own home
 * constants are only pointed away from a real Crow home so importing the module stays inert.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-dependency-panels-home-"));
process.env.CROW_DATA_DIR = join(process.env.CROW_HOME, "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

const { repairDependencyPanels } = await import("../servers/gateway/routes/bundles.js");

const PANEL_SOURCE = "export default function panel() { return \"funkwhale panel\"; }\n";
const ROUTES_SOURCE = "export default function routes(auth) { return auth; }\n";
const NEWER_PANEL_SOURCE = "export default function panel() { return \"funkwhale panel, newer\"; }\n";
const NEWER_ROUTES_SOURCE = "export default function routes(auth) { return [auth]; }\n";

/** One throwaway world: a repo bundles root, an installed bundles root, a panels dir. */
function scratch(tag) {
  const root = mkdtempSync(join(tmpdir(), `crow-dependency-panels-${tag}-`));
  const home = join(root, "crow-home");
  const paths = {
    appBundles: join(root, "app-bundles"),
    bundlesDir: join(home, "bundles"),
    panelsDir: join(home, "panels"),
    panelsConfigPath: join(home, "panels.json"),
    mcpAddonsPath: join(home, "mcp-addons.json"),
    appRoot: join(root, "app-root"),
  };
  for (const p of [paths.appBundles, paths.bundlesDir, paths.appRoot]) mkdirSync(p, { recursive: true });
  return paths;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The repo-side manifest of an installed bundle (what its `requires` is read from). */
function repoManifest(paths, id, manifest = {}) {
  writeJson(join(paths.appBundles, id, "manifest.json"), { id, ...manifest });
}

/** The INSTALLED copy of a bundle: its manifest plus the panel files it declares. */
function installedBundle(paths, id, { manifest = { panel: `panel/${id}.js`, panelRoutes: "panel/routes.js" }, panel = true, routes = true } = {}) {
  const dir = join(paths.bundlesDir, id);
  writeJson(join(dir, "manifest.json"), { id, ...manifest });
  if (panel) writeFile(join(dir, `panel/${id}.js`), PANEL_SOURCE);
  if (routes) writeFile(join(dir, "panel/routes.js"), ROUTES_SOURCE);
  return dir;
}

/**
 * A bundle copy under either root (repo appBundles or the installed bundles dir): its manifest,
 * carrying a version, plus the panel files that manifest declares.
 */
function bundleCopy(root, id, { version, refresh, panel = PANEL_SOURCE, routes = ROUTES_SOURCE } = {}) {
  const dir = join(root, id);
  writeJson(join(dir, "manifest.json"), {
    id,
    ...(version === undefined ? {} : { version }),
    ...(refresh === undefined ? {} : { refresh }),
    panel: `panel/${id}.js`,
    panelRoutes: "panel/routes.js",
  });
  if (panel !== null) writeFile(join(dir, `panel/${id}.js`), panel);
  if (routes !== null) writeFile(join(dir, "panel/routes.js"), routes);
  return dir;
}

const status = (path) => (existsSync(path) ? statSync(path) : null);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Everything the repair may touch, as a comparable snapshot. */
function snapshot(paths) {
  const files = [
    join(paths.panelsDir, "funkwhale.js"),
    join(paths.panelsDir, "funkwhale-routes.js"),
    paths.panelsConfigPath,
  ];
  return files.map((p) => {
    const st = status(p);
    return st ? { file: p, mtimeMs: st.mtimeMs, text: readFileSync(p, "utf8") } : { file: p, missing: true };
  });
}

test("an add-on registered only in mcp-addons.json gets its panel served for a dependent bundle", () => {
  const paths = scratch("registered");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  installedBundle(paths, "funkwhale");
  writeJson(paths.mcpAddonsPath, { funkwhale: { command: "node", args: ["server.js"], env: {} } });
  writeJson(paths.panelsConfigPath, { enabled: ["clock"] });

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, ["funkwhale: panel registered for music"]);
  assert.deepEqual(out.errors, []);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale.js"), "utf8"), PANEL_SOURCE);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale-routes.js"), "utf8"), ROUTES_SOURCE);
  assert.deepEqual(readJson(paths.panelsConfigPath), { enabled: ["clock", "funkwhale"] }, "object form kept, other ids kept");
});

test("a second run copies nothing and rewrites nothing", () => {
  const paths = scratch("idempotent");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  installedBundle(paths, "funkwhale");
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, { enabled: ["clock"] });

  const first = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });
  assert.equal(first.repaired.length, 1);

  // A timestamp from the past: any rewrite of these files shows up as a different mtime.
  const past = new Date("2020-01-01T00:00:00.000Z");
  for (const p of [join(paths.panelsDir, "funkwhale.js"), join(paths.panelsDir, "funkwhale-routes.js"), paths.panelsConfigPath]) {
    utimesSync(p, past, past);
  }
  const before = snapshot(paths);

  const second = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(second.repaired, []);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(snapshot(paths), before, "files and panels.json are byte for byte and timestamp for timestamp unchanged");
});

test("a bare-array panels.json is written back as an array", () => {
  const paths = scratch("array-form");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  installedBundle(paths, "funkwhale");
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, ["clock"]);

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, ["funkwhale: panel registered for music"]);
  const cfg = readJson(paths.panelsConfigPath);
  assert.ok(Array.isArray(cfg), "the file keeps its bare-array shape");
  assert.deepEqual(cfg, ["clock", "funkwhale"]);
});

test("a dependency that is neither installed nor registered gets nothing", () => {
  const paths = scratch("not-installed");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  writeJson(paths.mcpAddonsPath, {});
  writeJson(paths.panelsConfigPath, ["clock"]);
  const before = readFileSync(paths.panelsConfigPath, "utf8");

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, []);
  assert.deepEqual(out.errors, []);
  assert.equal(existsSync(join(paths.panelsDir, "funkwhale.js")), false, "nothing copied");
  assert.equal(readFileSync(paths.panelsConfigPath, "utf8"), before, "panels.json untouched");
});

test("a bundle no installed manifest depends on is never repaired", () => {
  const paths = scratch("no-dependents");
  repoManifest(paths, "gallery", { requires: { bundles: [] } });
  installedBundle(paths, "gallery");
  writeJson(paths.mcpAddonsPath, { gallery: { env: {} } });
  writeJson(paths.panelsConfigPath, ["clock"]);

  const out = repairDependencyPanels({ installedIds: ["gallery"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, []);
  assert.deepEqual(out.errors, []);
  assert.equal(existsSync(join(paths.panelsDir, "gallery.js")), false);
});

test("an already-enabled dependency panel is copied but panels.json is left alone", () => {
  const paths = scratch("enabled-missing-file");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  installedBundle(paths, "funkwhale");
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, { enabled: ["funkwhale"] });
  const before = readFileSync(paths.panelsConfigPath, "utf8");

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, ["funkwhale: panel refreshed for music"]);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale.js"), "utf8"), PANEL_SOURCE);
  assert.equal(readFileSync(paths.panelsConfigPath, "utf8"), before, "an id it already lists is not rewritten");
});

test("a dependency whose installed copy declares no panel, or lacks the declared file, is skipped quietly", () => {
  const noDeclaration = scratch("no-declaration");
  repoManifest(noDeclaration, "music", { requires: { bundles: ["funkwhale"] } });
  installedBundle(noDeclaration, "funkwhale", { manifest: {} });
  writeJson(noDeclaration.mcpAddonsPath, { funkwhale: { env: {} } });

  const a = repairDependencyPanels({ installedIds: ["music"], ...noDeclaration, log: () => {} });
  assert.deepEqual(a.repaired, []);
  assert.deepEqual(a.errors, []);
  assert.equal(existsSync(join(noDeclaration.panelsDir, "funkwhale.js")), false);

  const missingFile = scratch("missing-panel-file");
  repoManifest(missingFile, "music", { requires: { bundles: ["funkwhale"] } });
  installedBundle(missingFile, "funkwhale", { panel: false });
  writeJson(missingFile.mcpAddonsPath, { funkwhale: { env: {} } });

  const b = repairDependencyPanels({ installedIds: ["music"], ...missingFile, log: () => {} });
  assert.deepEqual(b.repaired, []);
  assert.deepEqual(b.errors, []);
  assert.equal(existsSync(join(missingFile.panelsDir, "funkwhale.js")), false);
  assert.equal(existsSync(missingFile.panelsConfigPath), false, "panels.json is not created for nothing");
});

test("a dependency's installed copy at an older version than the repo is served from the repo", () => {
  const paths = scratch("repo-newer");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  bundleCopy(paths.bundlesDir, "funkwhale", { version: "1.0.7" });
  bundleCopy(paths.appBundles, "funkwhale", { version: "1.0.8", panel: NEWER_PANEL_SOURCE, routes: NEWER_ROUTES_SOURCE });
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, ["clock"]);

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, ["funkwhale: panel registered for music"]);
  assert.deepEqual(out.errors, []);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale.js"), "utf8"), NEWER_PANEL_SOURCE, "the repo's panel, not the installed one");
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale-routes.js"), "utf8"), NEWER_ROUTES_SOURCE, "the repo's routes, not the installed one");
  assert.equal(readFileSync(join(paths.bundlesDir, "funkwhale", "panel/routes.js"), "utf8"), ROUTES_SOURCE, "the installed bundle dir is left as it was");
});

test("a dependency at the repo's own version is served from its installed copy", () => {
  const paths = scratch("versions-equal");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  bundleCopy(paths.bundlesDir, "funkwhale", { version: "1.0.8" });
  bundleCopy(paths.appBundles, "funkwhale", { version: "1.0.8", panel: NEWER_PANEL_SOURCE, routes: NEWER_ROUTES_SOURCE });
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, ["clock"]);

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, ["funkwhale: panel registered for music"]);
  assert.deepEqual(out.errors, []);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale.js"), "utf8"), PANEL_SOURCE);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale-routes.js"), "utf8"), ROUTES_SOURCE);
});

test("a dependency whose installed copy opts out of refresh is served from the installed copy", () => {
  const paths = scratch("refresh-false");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  bundleCopy(paths.bundlesDir, "funkwhale", { version: "1.0.7", refresh: false });
  bundleCopy(paths.appBundles, "funkwhale", { version: "1.0.8", panel: NEWER_PANEL_SOURCE, routes: NEWER_ROUTES_SOURCE });
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, ["clock"]);

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, ["funkwhale: panel registered for music"]);
  assert.deepEqual(out.errors, []);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale.js"), "utf8"), PANEL_SOURCE);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale-routes.js"), "utf8"), ROUTES_SOURCE);
});

test("an enabled dependency whose served files already match their source is left untouched", () => {
  const paths = scratch("enabled-current");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  bundleCopy(paths.bundlesDir, "funkwhale", { version: "1.0.7" });
  bundleCopy(paths.appBundles, "funkwhale", { version: "1.0.8", panel: NEWER_PANEL_SOURCE, routes: NEWER_ROUTES_SOURCE });
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, { enabled: ["funkwhale"] });
  writeFile(join(paths.panelsDir, "funkwhale.js"), NEWER_PANEL_SOURCE);
  writeFile(join(paths.panelsDir, "funkwhale-routes.js"), NEWER_ROUTES_SOURCE);
  // A timestamp from the past: any rewrite of these files shows up as a different mtime.
  const past = new Date("2020-01-01T00:00:00.000Z");
  for (const p of [join(paths.panelsDir, "funkwhale.js"), join(paths.panelsDir, "funkwhale-routes.js"), paths.panelsConfigPath]) {
    utimesSync(p, past, past);
  }
  const before = snapshot(paths);

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, []);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(snapshot(paths), before, "nothing was copied and panels.json was not touched");
});

test("an enabled dependency with a stale served routes file is refreshed and panels.json is kept", () => {
  const paths = scratch("enabled-stale-routes");
  repoManifest(paths, "music", { requires: { bundles: ["funkwhale"] } });
  bundleCopy(paths.bundlesDir, "funkwhale", { version: "1.0.7" });
  bundleCopy(paths.appBundles, "funkwhale", { version: "1.0.8", panel: NEWER_PANEL_SOURCE, routes: NEWER_ROUTES_SOURCE });
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, { enabled: ["funkwhale"] });
  writeFile(join(paths.panelsDir, "funkwhale.js"), NEWER_PANEL_SOURCE);
  writeFile(join(paths.panelsDir, "funkwhale-routes.js"), ROUTES_SOURCE); // one version behind
  const before = readFileSync(paths.panelsConfigPath, "utf8");

  const out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} });

  assert.deepEqual(out.repaired, ["funkwhale: panel refreshed for music"]);
  assert.deepEqual(out.errors, []);
  assert.equal(readFileSync(join(paths.panelsDir, "funkwhale-routes.js"), "utf8"), NEWER_ROUTES_SOURCE);
  assert.equal(readFileSync(paths.panelsConfigPath, "utf8"), before, "an id it already lists is not rewritten");
});

test("an unreadable repo manifest is reported, and the pass still finishes", () => {
  const paths = scratch("broken-manifest");
  writeFile(join(paths.appBundles, "music", "manifest.json"), "{ not json\n");
  repoManifest(paths, "funkwhale", {});
  installedBundle(paths, "funkwhale");
  writeJson(paths.mcpAddonsPath, { funkwhale: { env: {} } });
  writeJson(paths.panelsConfigPath, ["clock"]);
  const before = readFileSync(paths.panelsConfigPath, "utf8");

  let out;
  assert.doesNotThrow(() => { out = repairDependencyPanels({ installedIds: ["music"], ...paths, log: () => {} }); });

  assert.deepEqual(out.repaired, []);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].id, "music");
  assert.ok(out.errors[0].error, "the failure is described");
  assert.equal(readFileSync(paths.panelsConfigPath, "utf8"), before, "and nothing was written");
});