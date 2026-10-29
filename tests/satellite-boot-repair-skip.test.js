// Boot repair never treats a satellite-hosted bundle as local (SAT-5, spec §8): no copy into
// ~/.crow/bundles, its mcp-addons satellite entry untouched, skills still synced from crow's
// checkout; the keychain backfill skips it too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const put = (root, rel, c) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
let HOME, B;
before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "crowhome-satskip-"));
  process.env.CROW_HOME = HOME;
  B = await import("../servers/gateway/routes/bundles.js");
});
after(() => { rmSync(HOME, { recursive: true, force: true }); delete process.env.CROW_HOME; });
const run = async () => { throw new Error("no command may run for a satellite bundle"); };

test("repairInstalledBundleAssets skips satellite entries (skills only)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "satskip-repo-"));
  put(repo, "demo/manifest.json", JSON.stringify({ id: "demo", version: "2.0.0", type: "bundle", satellite: { min_ram_mb: 100 },
    server: { command: "node", args: ["server/index.js"] }, panel: "panel/demo.js", skills: ["skills/demo.md"],
    env_vars: [{ name: "S", secret: true, generate: "secret" }] }));
  put(repo, "demo/server/index.js", "// v2\n");
  put(repo, "demo/panel/demo.js", "export default {};\n");
  put(repo, "demo/skills/demo.md", "# demo v2\n");
  put(HOME, "installed.json", JSON.stringify([{ id: "demo", mode: "satellite", host: "sat_aaaaaaaaaaaaaaaaaaaa", version: "1.0.0" }]));
  const entry = { transport: "satellite", satellite_id: "sat_aaaaaaaaaaaaaaaaaaaa", bundle: "demo" };
  put(HOME, "mcp-addons.json", JSON.stringify({ demo: entry }));
  const { repaired, errors } = await B.repairInstalledBundleAssets({ appBundles: repo, run, skillMode: "on", log: () => {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(repaired, []);
  assert.ok(!existsSync(join(HOME, "bundles", "demo")), "nothing copied into the local bundles dir");
  assert.deepEqual(JSON.parse(readFileSync(join(HOME, "mcp-addons.json"), "utf8")).demo, entry);
  assert.equal(readFileSync(join(HOME, "skills", "demo.md"), "utf8"), "# demo v2\n", "skills still come from crow's checkout");
  const n = await B.backfillBundleKeychain({ log: () => {} });
  assert.equal(n, 0);
});

test("a local install of a bundle hosted on a satellite is refused (one host per bundle id)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "satskip-repo2-"));
  put(repo, "demo/manifest.json", JSON.stringify({ id: "demo", version: "2.0.0", type: "bundle", satellite: { min_ram_mb: 100 } }));
  put(HOME, "installed.json", JSON.stringify([{ id: "demo", mode: "satellite", host: "sat_aaaaaaaaaaaaaaaaaaaa", version: "1.0.0" }]));
  B._setAppBundlesForTest(repo);
  try {
    const v = await B.validateInstall("demo");
    assert.equal(v.ok, false);
    assert.equal(v.status, 409);
    assert.equal(v.code, "installed_on_satellite");
    assert.equal(v.extra.host, "sat_aaaaaaaaaaaaaaaaaaaa");
  } finally {
    B._setAppBundlesForTest(join(import.meta.dirname, "..", "bundles"));
  }
});

test("M3: a local install writes installed.json from a fresh read — a satellite entry written meanwhile survives", async () => {
  const repo = mkdtempSync(join(tmpdir(), "satskip-repo3-"));
  const id = "localdemo";
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: [] };
  put(repo, `${id}/manifest.json`, JSON.stringify(manifest));
  const gw = join(mkdtempSync(join(tmpdir(), "satskip-gw-")), ".env");
  writeFileSync(gw, "# gateway\n");
  B._setAppBundlesForTest(repo);
  B._setAppEnvPathForTest(gw);
  B._setRestartHookForTest(() => {});
  try {
    put(HOME, "installed.json", "[]");
    const snapshot = []; // validation saw an empty installed.json
    // ...then a satellite install was recorded before this install wrote its entry.
    const sat = { id: "remote", mode: "satellite", host: "sat_aaaaaaaaaaaaaaaaaaaa", version: "1.0.0" };
    put(HOME, "installed.json", JSON.stringify([sat]));
    const job = B._createJobForTest(id, "install");
    const r = await B.runInstallJob(id, {}, { job, installedSnapshot: snapshot, consentVerified: false, manifest });
    assert.equal(r.ok, true, r.reason);
    const after = JSON.parse(readFileSync(join(HOME, "installed.json"), "utf8"));
    assert.deepEqual(after.find((e) => e.id === "remote"), sat, "the satellite record is kept");
    assert.equal(after.filter((e) => e.id === id).length, 1);
  } finally {
    B._setAppBundlesForTest(join(import.meta.dirname, "..", "bundles"));
    B._setAppEnvPathForTest(null);
    B._setRestartHookForTest(null);
  }
});
