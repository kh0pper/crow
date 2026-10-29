// crow's records of satellite-hosted bundles (SAT-5, spec §8): installed.json mode:"satellite",
// the mcp-addons satellite entry (mode 600), skills from crow's own checkout, one host per
// bundle id both ways, and unpair removing every record of that satellite.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "satinst-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satinst-data-"));
const dirs = [HOME, process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const I = await import("../servers/gateway/satellites/installs.js");

const SAT = "sat_aaaaaaaaaaaaaaaaaaaa";
const SAT2 = "sat_bbbbbbbbbbbbbbbbbbbb";

function scratch() {
  const home = mkdtempSync(join(tmpdir(), "satinst-h-"));
  const app = mkdtempSync(join(tmpdir(), "satinst-app-"));
  dirs.push(home, app);
  const b = join(app, "demo");
  mkdirSync(join(b, "skills"), { recursive: true });
  writeFileSync(join(b, "manifest.json"), JSON.stringify({ id: "demo", version: "1.2.0", satellite: { min_ram_mb: 100 }, skills: ["skills/demo.md"] }));
  writeFileSync(join(b, "skills", "demo.md"), "# demo skill\n");
  return { paths: I.installPaths(home), app };
}
const readJ = (p) => JSON.parse(readFileSync(p, "utf8"));

test("record: installed.json satellite entry, mcp-addons satellite entry at 0600, skill synced", () => {
  const { paths, app } = scratch();
  const r = I.recordSatelliteInstall({ id: "demo", satelliteId: SAT, version: "1.2.0", appBundles: app, paths, skillMode: "on" });
  assert.equal(r.ok, true);
  const inst = readJ(paths.installed);
  assert.equal(inst.length, 1);
  assert.equal(inst[0].id, "demo");
  assert.equal(inst[0].mode, "satellite");
  assert.equal(inst[0].host, SAT);
  assert.equal(inst[0].version, "1.2.0");
  assert.deepEqual(readJ(paths.addons).demo, { transport: "satellite", satellite_id: SAT, bundle: "demo" });
  assert.equal(statSync(paths.addons).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(paths.skillsDir, "demo.md"), "utf8"), "# demo skill\n");
  assert.ok(!existsSync(join(paths.bundlesDir, "demo")), "nothing is copied into the local bundles dir");
  assert.deepEqual(I.bundleHost("demo", paths), { where: "satellite", host: SAT });
  // Idempotent for the same satellite.
  assert.equal(I.recordSatelliteInstall({ id: "demo", satelliteId: SAT, version: "1.3.0", appBundles: app, paths, skillMode: "on" }).ok, true);
  assert.equal(readJ(paths.installed).length, 1);
  assert.equal(readJ(paths.installed)[0].version, "1.3.0");
});

test("one host per bundle id: local install, local folder, local addon, other satellite all refuse", () => {
  const { paths, app } = scratch();
  writeFileSync(paths.installed, JSON.stringify([{ id: "demo", version: "1.0.0" }]));
  assert.deepEqual(I.bundleHost("demo", paths), { where: "local" });
  assert.equal(I.recordSatelliteInstall({ id: "demo", satelliteId: SAT, appBundles: app, paths }).code, "installed_locally");

  const p2 = scratch();
  mkdirSync(join(p2.paths.bundlesDir, "demo"), { recursive: true });
  assert.equal(I.recordSatelliteInstall({ id: "demo", satelliteId: SAT, appBundles: p2.app, paths: p2.paths }).code, "installed_locally");

  const p3 = scratch();
  writeFileSync(p3.paths.addons, JSON.stringify({ demo: { command: "node" } }));
  assert.equal(I.recordSatelliteInstall({ id: "demo", satelliteId: SAT, appBundles: p3.app, paths: p3.paths }).code, "installed_locally");

  const p4 = scratch();
  assert.equal(I.recordSatelliteInstall({ id: "demo", satelliteId: SAT, appBundles: p4.app, paths: p4.paths, skillMode: "off" }).ok, true);
  assert.equal(I.recordSatelliteInstall({ id: "demo", satelliteId: SAT2, appBundles: p4.app, paths: p4.paths }).code, "installed_on_other_server");

  const p5 = scratch();
  writeFileSync(p5.paths.addons, "{not json");
  assert.deepEqual(I.bundleHost("demo", p5.paths), { where: "local" }, "an unreadable mcp-addons.json fails closed");
});

test("remove: only the hosting satellite's records go; unpair removes all of them and their skills", () => {
  const { paths, app } = scratch();
  writeFileSync(paths.installed, JSON.stringify([{ id: "keep", version: "1" }]));
  writeFileSync(paths.addons, JSON.stringify({ keep: { command: "node" } }));
  assert.equal(I.recordSatelliteInstall({ id: "demo", satelliteId: SAT, appBundles: app, paths, skillMode: "on" }).ok, true);
  assert.equal(I.removeSatelliteInstall({ id: "demo", satelliteId: SAT2, appBundles: app, paths }).code, "not_on_this_server");
  assert.equal(I.removeSatelliteInstall({ id: "keep", satelliteId: SAT, appBundles: app, paths }).code, "not_on_this_server");
  const ids = I.removeAllForSatellite({ satelliteId: SAT, appBundles: app, paths });
  assert.deepEqual(ids, ["demo"]);
  assert.deepEqual(readJ(paths.installed).map((r) => r.id), ["keep"]);
  assert.deepEqual(Object.keys(readJ(paths.addons)), ["keep"]);
  assert.ok(!existsSync(join(paths.skillsDir, "demo.md")), "the unedited skill is removed");
  assert.deepEqual(I.bundleHost("demo", paths), { where: null });
});
