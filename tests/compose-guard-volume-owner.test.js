// The compose guard and the browser's profile volume (fix rounds 3 and 4).
//
// The profile volume is `<project>_chromium-profile`, labelled crow.bundle=browser.
// Names and project names are prefix-matched, so neither alone proves ownership:
//   - an existing volume whose crow.bundle label names another bundle is refused;
//   - an existing volume created by a compose project this bundle may not own is refused;
//   - a bundle may not declare another bundle's crow.bundle label;
//   - a community bundle may not take the id "crow" or a "crow-" prefix, nor a compose
//     project another known bundle could own (crow-browser-r4 fits browser too);
//   - a docker error while checking fails closed.
// An external volume gets the same owner check (its real name is the declared name, not
// `<project>_<name>`), before the consent gate: verified consent does not say whose data
// an existing volume holds.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const G = await import("../servers/gateway/compose-guard.js");
const home = mkdtempSync(join(tmpdir(), "crow-guard-vol-"));
after(() => rmSync(home, { recursive: true, force: true }));
const KNOWN = ["browser", "nextcloud", "workspace"];
const CTX = (vols = {}, known = KNOWN) => ({
  crowHome: home, dataDir: join(home, "data"), appRoot: home,
  volumeInfo: (n) => { const v = vols[n]; if (v instanceof Error) throw v; return v === undefined ? null : v; },
  knownBundleIds: () => known,
});
const dir = (id) => { const d = join(home, "bundles", id); mkdirSync(d, { recursive: true }); return d; };
const model = (project, volumes) => ({ name: project, services: { app: { image: "busybox", volumes: Object.keys(volumes).map((k) => ({ type: "volume", source: k, target: "/data/" + k })) } }, volumes });
const check = (id, m, vols, manifest = {}, known) => G.checkComposeModel(m, { bundleDir: dir(id), manifest: { id, origin: "community", ...manifest }, consentVerified: false, ctx: CTX(vols, known) });
// Verified consent: only a non-community manifest carrying 'privileged: true' can have it.
const consenting = (id) => ({ id, privileged: true });
const consented = (id, m, vols, known) => G.checkComposeModel(m, { bundleDir: dir(id), manifest: consenting(id), consentVerified: true, ctx: CTX(vols, known) });
const gated = (id, m, vols, known) => G.checkComposeModel(m, { bundleDir: dir(id), manifest: consenting(id), consentVerified: false, ctx: CTX(vols, known) });
const ext = (name, extra = {}) => ({ ...(name ? { name } : {}), external: true, ...extra });
const BROWSER = { project: "browser", bundle: "browser" };
const R4 = { project: "crow-browser-r4", bundle: "browser" };
const VOLS = { "browser_chromium-profile": BROWSER, "crow-browser-r4_chromium-profile": R4 };

test("a community bundle 'browser-chromium' cannot name the primary's profile volume (browser_chromium-profile)", () => {
  // First layer: its project fits the browser's "-suffix" instance names.
  const r = check("browser-chromium", model("browser-chromium", { p: { name: "browser_chromium-profile" } }), VOLS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /also belongs to the 'browser' bundle/);
  // With that layer out of the way (no known rivals), the name rule still refuses it.
  const n = check("browser-chromium", model("browser-chromium", { p: { name: "browser_chromium-profile" } }), VOLS, {}, []);
  assert.equal(n.valid, false);
  assert.match(n.reason, /named outside this project/);
});

test("...nor r4's (crow-browser-r4_chromium-profile), under any of its own project names", () => {
  for (const project of ["browser-chromium", "crow-browser-chromium", "browser-chromium-2"]) {
    const r = check("browser-chromium", model(project, { p: { name: "crow-browser-r4_chromium-profile" } }), VOLS);
    assert.equal(r.valid, false, project);
  }
});

test("N1: bundle ids browser-r4, crow-browser and crow cannot mount crow-browser-r4_chromium-profile", () => {
  // Each of these could match r4's project by prefix; every layer must say no.
  const cases = [
    ["browser-r4", "crow-browser-r4"],
    ["crow-browser", "crow-browser-r4"],
    ["crow", "crow-browser-r4"],
    ["crow", "crow"],
  ];
  for (const [id, project] of cases) {
    const r = check(id, model(project, { p: { name: "crow-browser-r4_chromium-profile" } }), VOLS);
    assert.equal(r.valid, false, `${id} / ${project}`);
  }
  // ...and even with the project prefix rule out of the way (no known rivals, a first-party
  // origin), the crow.bundle label alone refuses it.
  for (const id of ["browser-r4", "crow-browser", "crow"]) {
    const r = G.checkComposeModel(model("crow-browser-r4", { p: { name: "crow-browser-r4_chromium-profile" } }),
      { bundleDir: dir(id), manifest: { id }, consentVerified: false, ctx: CTX(VOLS, []) });
    assert.equal(r.valid, false, id);
    assert.match(r.reason, /belongs to the 'browser' bundle \(crow\.bundle\)/, id);
  }
});

test("community ids 'crow' and 'crow-*' are reserved; a project another known bundle could own is refused", () => {
  for (const id of ["crow", "crow-browser", "crow-anything"]) {
    const r = check(id, model(id, {}), {});
    assert.equal(r.valid, false, id);
    assert.match(r.reason, /is reserved/, id);
  }
  const rival = check("browser-r4", model("crow-browser-r4", {}), {});
  assert.equal(rival.valid, false);
  assert.match(rival.reason, /also belongs to the 'browser' bundle/);
  assert.equal(check("browser-r4", model("browser-r4", {}), {}).valid, false, "browser-r4 is also browser's '-r4' instance name");
  assert.deepEqual(check("thing", model("thing", {}), {}), { valid: true }, "an unambiguous project is fine");
  // First-party bundles keep their names (the repo's ids are reviewed together).
  assert.deepEqual(G.checkComposeModel(model("crow-browser-r4", {}), { bundleDir: dir("browser"), manifest: { id: "browser" }, consentVerified: false, ctx: CTX({}, [...KNOWN, "browser-r4"]) }), { valid: true });
});

test("a bundle may not declare another bundle's crow.bundle label; its own is fine", () => {
  const bad = check("thing", model("thing", { data: { labels: { "crow.bundle": "browser" } } }), {});
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /carries the label crow\.bundle=browser/);
  assert.deepEqual(check("thing", model("thing", { data: { labels: { "crow.bundle": "thing" } } }), {}), { valid: true });
});

test("the round-2 dash name, and default-named volumes another project created, are refused by the owner labels", () => {
  const r = check("browser-chromium", model("browser-chromium", { p: { name: "browser-chromium-profile" } }), { "browser-chromium-profile": { project: "browser", bundle: "" } }, {}, []);
  assert.equal(r.valid, false);
  assert.match(r.reason, /belongs to compose project 'browser'/);
  const d = check("browser-chromium", model("browser-chromium", { data: {} }), { "browser-chromium_data": { project: "browser", bundle: "" } }, {}, []);
  assert.equal(d.valid, false);
});

test("F7: a docker error while checking a volume's owner fails closed", () => {
  const r = check("thing", model("thing", { data: {} }), { thing_data: new Error("Cannot connect to the Docker daemon") });
  assert.equal(r.valid, false);
  assert.match(r.reason, /could not check who owns volume 'thing_data'.*refusing/);
});

test("the browser bundle keeps its own volumes (primary and r4); fresh, unlabelled and own-instance volumes pass", () => {
  const first = { id: "browser" };
  assert.deepEqual(G.checkComposeModel(model("browser", { "chromium-profile": { name: "browser_chromium-profile", labels: { "crow.bundle": "browser" } } }),
    { bundleDir: dir("browser"), manifest: first, consentVerified: false, ctx: CTX(VOLS) }), { valid: true });
  assert.deepEqual(G.checkComposeModel(model("crow-browser-r4", { "chromium-profile": { name: "crow-browser-r4_chromium-profile", labels: { "crow.bundle": "browser" } } }),
    { bundleDir: dir("browser"), manifest: first, consentVerified: false, ctx: CTX(VOLS) }), { valid: true }, "r4: crow-<id>-<suffix>");
  assert.deepEqual(check("thing", model("thing", { data: {} }), {}), { valid: true }, "not created yet");
  assert.deepEqual(check("thing", model("thing", { data: {} }), { thing_data: { project: "", bundle: "" } }), { valid: true }, "unlabelled: Compose's own adoption rule");
  assert.deepEqual(check("thing", model("thing", { data: {} }), { thing_data: { project: "crow-thing-2", bundle: "thing" } }), { valid: true }, "its own second instance");
});

test("ownableProject, reservedCommunityId and the docker lookup", () => {
  assert.equal(G.ownableProject("browser", "browser"), true);
  assert.equal(G.ownableProject("browser", "crow-browser-r4"), true);
  assert.equal(G.ownableProject("browser-chromium", "browser"), false);
  assert.equal(G.reservedCommunityId("crow"), true);
  assert.equal(G.reservedCommunityId("crowdsec"), false, "not the crow- prefix");
  assert.equal(G.dockerVolumeInfo("../bad"), null, "a name docker would not accept is never looked up");
  assert.equal(G.dockerVolumeInfo(`crow-test-no-such-volume-${process.pid}`), null, "no such volume: null, not an error");
});

test("the repo's browser compose names and labels the volume; the migration labels it the same way", () => {
  const c = readFileSync(new URL("../bundles/browser/docker-compose.yml", import.meta.url), "utf8");
  assert.match(c, /\n {4}name: \$\{CROW_BROWSER_CONTAINER_NAME:-browser\}_chromium-profile\n/);
  assert.match(c, /\n {4}labels:\n {6}crow\.bundle: browser\n/);
  const s = readFileSync(new URL("../scripts/ops/browser-profile-to-volume.sh", import.meta.url), "utf8");
  assert.match(s, /^VOLUME="\$\{PROJECT\}_\$\{VOLUME_KEY\}"$/m);
  assert.match(s, /volume create .*--label crow\.bundle=browser "\$VOLUME"/);
});

test("an external volume is refused even with verified consent when its owner is another bundle's", () => {
  const m = model("thing", { data: ext("nextcloud_data") });
  const r = consented("thing", m, { nextcloud_data: { project: "nextcloud", bundle: "nextcloud" } });
  assert.equal(r.valid, false);
  assert.match(r.reason, /volume 'nextcloud_data' already exists and belongs to the 'nextcloud' bundle/);
  assert.match(r.reason, /another bundle's data/);
  // The project label alone is enough (a volume with no crow.bundle label).
  const p = consented("thing", m, { nextcloud_data: { project: "nextcloud", bundle: "" } });
  assert.equal(p.valid, false);
  assert.match(p.reason, /belongs to compose project 'nextcloud'/);
  // A docker error while looking the external volume up fails closed too.
  const e = consented("thing", m, { nextcloud_data: new Error("Cannot connect to the Docker daemon") });
  assert.equal(e.valid, false);
  assert.match(e.reason, /could not check who owns volume 'nextcloud_data'.*refusing/);
});

test("an external volume this bundle's own project created passes with consent and is consent-gated without", () => {
  const m = model("browser", { profile: ext("browser_r4-profile") });
  const vols = { "browser_r4-profile": { project: "crow-browser-r4", bundle: "browser" } };
  assert.deepEqual(consented("browser", m, vols), { valid: true });
  const r = gated("browser", m, vols);
  assert.equal(r.valid, false, "no verified consent: the external volume still needs it");
  assert.match(r.reason, /the external volume 'browser_r4-profile'/);
});

test("an unknown external volume (not created yet) stays consent-gated", () => {
  const m = model("thing", { data: ext("thing-shared-data") });
  const r = gated("thing", m, {});
  assert.equal(r.valid, false);
  assert.match(r.reason, /the external volume 'thing-shared-data'/);
  assert.deepEqual(consented("thing", m, {}), { valid: true });
  assert.deepEqual(consented("thing", m, { "thing-shared-data": { project: "", bundle: "" } }), { valid: true }, "unlabelled: still consent-gated only");
  // A default-named external volume is looked up (consent, no owner label): allowed.
  assert.deepEqual(consented("thing", model("thing", { data: ext() }), {}), { valid: true });
});

test("without a volume lookup in ctx an external volume is consent-gated exactly as before", () => {
  const ctx = { crowHome: home, dataDir: join(home, "data"), appRoot: home };
  const m = model("thing", { data: ext("thing_shared", { labels: { "crow.bundle": "thing" } }) });
  const noConsent = G.checkComposeModel(m, { bundleDir: dir("thing"), manifest: consenting("thing"), consentVerified: false, ctx });
  assert.equal(noConsent.valid, false);
  assert.match(noConsent.reason, /the external volume 'thing_shared'/);
  assert.deepEqual(G.checkComposeModel(m, { bundleDir: dir("thing"), manifest: consenting("thing"), consentVerified: true, ctx }), { valid: true });
});
