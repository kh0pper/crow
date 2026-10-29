// The compose guard and the browser's profile volume (fix round 3, R1).
//
// The profile volume is `<project>_chromium-profile`. Bundle ids have no "_",
// so no other bundle's project can claim that name by prefix; and a volume
// that already exists belongs to the compose project that created it (its
// com.docker.compose.project label), which another bundle may not adopt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const G = await import("../servers/gateway/compose-guard.js");
const home = mkdtempSync(join(tmpdir(), "crow-guard-vol-"));
after(() => rmSync(home, { recursive: true, force: true }));
const CTX = (owners = {}) => ({ crowHome: home, dataDir: join(home, "data"), appRoot: home, volumeProject: (n) => (n in owners ? owners[n] : null) });
const dir = (id) => { const d = join(home, "bundles", id); mkdirSync(d, { recursive: true }); return d; };
const model = (project, volumes) => ({ name: project, services: { app: { image: "busybox", volumes: Object.keys(volumes).map((k) => ({ type: "volume", source: k, target: "/data/" + k })) } }, volumes });
const check = (id, m, owners, manifest = {}) => G.checkComposeModel(m, { bundleDir: dir(id), manifest: { id, origin: "community", ...manifest }, consentVerified: false, ctx: CTX(owners) });
const OWNERS = { "browser_chromium-profile": "browser", "crow-browser-r4_chromium-profile": "crow-browser-r4" };

test("a community bundle 'browser-chromium' cannot name the primary's profile volume (browser_chromium-profile)", () => {
  const r = check("browser-chromium", model("browser-chromium", { p: { name: "browser_chromium-profile" } }), OWNERS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /named outside this project/);
});

test("...nor r4's (crow-browser-r4_chromium-profile), under either of its own project names", () => {
  for (const project of ["browser-chromium", "crow-browser-chromium", "browser-chromium-2"]) {
    const r = check("browser-chromium", model(project, { p: { name: "crow-browser-r4_chromium-profile" } }), OWNERS);
    assert.equal(r.valid, false, project);
    assert.match(r.reason, /named outside this project/, project);
  }
});

test("the round-2 dash name was claimable by prefix: the owner label now refuses it too", () => {
  // browser-chromium-profile is "inside" project browser-chromium by name alone;
  // the volume exists and was created by project browser.
  const r = check("browser-chromium", model("browser-chromium", { p: { name: "browser-chromium-profile" } }), { "browser-chromium-profile": "browser" });
  assert.equal(r.valid, false);
  assert.match(r.reason, /already exists and belongs to compose project 'browser'/);
  // A default-named volume (<project>_<key>) another project created: refused as well.
  const d = check("browser-chromium", model("browser-chromium", { data: {} }), { "browser-chromium_data": "browser" });
  assert.equal(d.valid, false);
  assert.match(d.reason, /belongs to compose project 'browser'/);
});

test("the browser bundle keeps its own volumes; a project of its own id family, a fresh or an unlabelled volume pass", () => {
  const first = { id: "browser", origin: "first-party" };
  assert.deepEqual(G.checkComposeModel(model("browser", { "chromium-profile": { name: "browser_chromium-profile" } }),
    { bundleDir: dir("browser"), manifest: first, consentVerified: false, ctx: CTX(OWNERS) }), { valid: true });
  assert.deepEqual(G.checkComposeModel(model("crow-browser-r4", { "chromium-profile": { name: "crow-browser-r4_chromium-profile" } }),
    { bundleDir: dir("browser"), manifest: first, consentVerified: false, ctx: CTX(OWNERS) }), { valid: true }, "r4: crow-<id>-<suffix>");
  assert.deepEqual(check("thing", model("thing", { data: {} }), {}), { valid: true }, "not created yet");
  assert.deepEqual(check("thing", model("thing", { data: {} }), { thing_data: "" }), { valid: true }, "unlabelled: Compose's own adoption rule");
  assert.deepEqual(check("thing", model("thing", { data: {} }), { thing_data: "crow-thing-2" }), { valid: true }, "its own second instance");
});

test("ownableProject and the docker lookup", () => {
  assert.equal(G.ownableProject("browser", "browser"), true);
  assert.equal(G.ownableProject("browser", "crow-browser-r4"), true);
  assert.equal(G.ownableProject("browser-chromium", "browser"), false);
  assert.equal(G.ownableProject("browser-chromium", "crow-browser-r4"), false);
  assert.equal(G.dockerVolumeProject("../bad"), null, "a name docker would not accept is never looked up");
  assert.equal(G.dockerVolumeProject(`crow-test-no-such-volume-${process.pid}`), null);
});

test("the repo's browser compose names the volume <project>_chromium-profile", async () => {
  const { readFileSync } = await import("node:fs");
  const c = readFileSync(new URL("../bundles/browser/docker-compose.yml", import.meta.url), "utf8");
  assert.match(c, /\n {4}name: \$\{CROW_BROWSER_CONTAINER_NAME:-browser\}_chromium-profile\n/);
  const s = readFileSync(new URL("../scripts/ops/browser-profile-to-volume.sh", import.meta.url), "utf8");
  assert.match(s, /^VOLUME="\$\{PROJECT\}_\$\{VOLUME_KEY\}"$/m);
});
