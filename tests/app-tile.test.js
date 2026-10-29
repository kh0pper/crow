// The embedded app tile (R1.2 PR 5, Task 3): any desktop (VNC) app in a Perch
// session, generalised from the live browser tile (#589).
//
// Covers the app-keyed lease directory, enforced.json (written by the browser
// bundle's lease guard, read by the gateway against the installed manifest),
// the app tile and take-over routes (real router, real catalog, real lease
// files under a temp CROW_HOME), and the client's open-app-tile handler in a
// vm sandbox. The live half is tests/app-tile-live.test.js.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "app-tile-"));
const home = join(dir, "home");
mkdirSync(home, { recursive: true });

const lease = await import("../servers/shared/browser-lease.js");
const { appTileInfo, leaseEnforced, appLeaseDir, desktopApp, LEASE_ENFORCERS, versionAtLeast } = await import("../servers/gateway/apps/app-tile.js");
const { createAppTakeOvers, createTakeOver } = await import("../servers/gateway/browser-tile/take-over.js");
const { _resetCatalogCache } = await import("../servers/gateway/apps/catalog.js");

function bundle(id, manifest) {
  mkdirSync(join(home, "bundles", id), { recursive: true });
  writeFileSync(join(home, "bundles", id, "manifest.json"), JSON.stringify({ id, name: id, ...manifest }));
}

before(() => {
  bundle("browser", { version: "1.3.11", name: "Browser", webUI: { port: 6080, path: "/vnc.html" }, desktop: { path: "vnc.html", lease: true } });
  bundle("studio", { version: "2.0.0", name: "Studio", webUI: { port: 6090, path: "/" }, desktop: { path: "vnc.html", lease: true } });
  bundle("canvas", { version: "1.0.0", name: "Canvas", webUI: { port: 6091, path: "/" }, desktop: { path: "vnc_lite.html" } });
  bundle("wiki", { version: "1.0.0", name: "Wiki", webUI: { port: 6092, path: "/" } });
  bundle("sneaky", { version: "1.0.0", name: "Sneaky", webUI: { port: 6093, path: "/" }, desktop: { path: "../../dashboard/x", lease: true } });
  bundle("pager", { version: "1.0.0", name: "Pager", webUI: { port: 6094, path: "/" }, desktop: { path: "index.html", lease: true } });
  bundle("nested", { version: "1.0.0", name: "Nested", webUI: { port: 6095, path: "/" }, desktop: { path: "app/novnc/vnc_lite.html" } });
  writeFileSync(join(home, "installed.json"), JSON.stringify(["browser", "studio", "canvas", "wiki", "sneaky", "pager", "nested"].map((id) => ({ id }))));
});
after(() => { _resetCatalogCache(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  _resetCatalogCache();
  for (const d of ["browser-lease", "app-lease-studio", "app-lease-canvas"]) rmSync(join(home, d), { recursive: true, force: true });
});

const enforce = (id, version) => lease.writeEnforced(appLeaseDir(id, { crowHome: home }), { bundleVersion: version });

// ---------------------------------------------------------------------------

test("leaseDir keeps the browser path; other apps get app-lease-<id>", () => {
  const sd = (name) => "/state/" + name;
  assert.equal(lease.leaseDir(sd), "/state/browser-lease", "no app id: the browser's own directory");
  assert.equal(lease.leaseDir(sd, "browser"), "/state/browser-lease");
  assert.equal(lease.leaseDir(sd, "studio"), "/state/app-lease-studio");
  assert.equal(lease.leaseDir(sd, "a"), "/state/app-lease-a");
  assert.equal(lease.leaseDir(sd, "x".repeat(64)), "/state/app-lease-" + "x".repeat(64));
  assert.equal(appLeaseDir("studio", { crowHome: home }), join(home, "app-lease-studio"));
});

test("a bad app id is refused", () => {
  const sd = (name) => "/state/" + name;
  for (const bad of ["", "-x", "Studio", "a/b", "..", "../x", "a.b", "a_b", "x".repeat(65), " a", "a\n", null, 7, {}]) {
    assert.throws(() => lease.leaseDir(sd, bad), /bad app id/, JSON.stringify(bad));
    assert.equal(leaseEnforced(bad, { crowHome: home }), false);
    assert.equal(appTileInfo(bad, { crowHome: home }), null);
  }
});

test("enforced.json must match the installed version", () => {
  assert.equal(leaseEnforced("studio", { crowHome: home }), false, "no file: not enforced");
  enforce("studio", "2.0.0");
  const rec = JSON.parse(readFileSync(join(home, "app-lease-studio", "enforced.json"), "utf8"));
  assert.equal(rec.v, 1); assert.equal(rec.bundleVersion, "2.0.0"); assert.equal(typeof rec.at, "number");
  assert.equal(leaseEnforced("studio", { crowHome: home }), true, "same version: enforced");
  assert.deepEqual(readdirSync(join(home, "app-lease-studio")).filter((n) => n.endsWith(".tmp")), [], "no temp file left behind");

  enforce("studio", "1.9.0");
  assert.equal(leaseEnforced("studio", { crowHome: home }), false, "an older server's report (the bundle was upgraded since)");

  const f = join(home, "app-lease-studio", "enforced.json");
  for (const junk of ["not json", "{}", JSON.stringify({ v: 2, bundleVersion: "2.0.0", at: 1 }),
    JSON.stringify({ v: 1, bundleVersion: 2, at: 1 }), JSON.stringify({ v: 1, bundleVersion: "2.0.0", at: -1 }),
    JSON.stringify({ v: 1, bundleVersion: "2.0.0", at: 1, pad: "x".repeat(600) })]) {
    writeFileSync(f, junk);
    assert.equal(leaseEnforced("studio", { crowHome: home }), false, junk.slice(0, 40));
  }

  // A planted symlink is never followed.
  rmSync(f);
  const outside = join(dir, "forged.json");
  writeFileSync(outside, JSON.stringify({ v: 1, bundleVersion: "2.0.0", at: 1 }));
  symlinkSync(outside, f);
  assert.equal(leaseEnforced("studio", { crowHome: home }), false, "a symlinked enforced.json reads as missing");
  rmSync(f);
  enforce("studio", "2.0.0");
  assert.equal(readFileSync(outside, "utf8").includes('"at":1'), true, "the rename replaced the link's name, never its target");

  // No installed manifest: never enforced.
  rmSync(join(home, "app-lease-canvas"), { recursive: true, force: true });
  enforce("canvas", "1.0.0");
  assert.equal(leaseEnforced("canvas", { crowHome: home }), true);
  assert.equal(leaseEnforced("ghost", { crowHome: home }), false);
  assert.throws(() => lease.writeEnforced(join(home, "app-lease-canvas"), { bundleVersion: "../x" }), /bad bundle version/);
});

test("the browser bundle's lease guard reports enforcement at startup, atomically, with its own version, and never blocks on a failure", async () => {
  const { installLeaseGuard, ownBundleVersion } = await import("../bundles/browser/server/lease-guard.js");
  const manifest = JSON.parse(readFileSync(new URL("../bundles/browser/manifest.json", import.meta.url), "utf8"));
  assert.equal(ownBundleVersion(), manifest.version, "its own manifest's version");
  const registry = JSON.parse(readFileSync(new URL("../registry/add-ons.json", import.meta.url), "utf8"));
  const entry = (registry["add-ons"] || registry.addons || registry).find?.((x) => x.id === "browser");
  if (entry && entry.version) assert.equal(entry.version, manifest.version, "the registry is in sync with the manifest");

  const server = { tool() {} };
  const ldir = join(dir, "guard-lease");
  const g = installLeaseGuard(server, { dir: ldir, env: { PI_BOT_PERCH_SESSION_ID: "perchlive-1" } });
  assert.equal(g.enabled, true);
  const rec = lease.readEnforced(ldir);
  assert.equal(rec.bundleVersion, manifest.version);
  assert.deepEqual(readdirSync(ldir).filter((n) => n !== "enforced.json"), [], "only enforced.json, no temp file");

  // A write failure is logged and startup continues.
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    const failing = { ...lease, writeEnforced: () => { throw Object.assign(new Error("disk"), { code: "ENOSPC" }); } };
    const g2 = installLeaseGuard({ tool() {} }, { lease: failing, dir: join(dir, "guard-2"), env: { PI_BOT_PERCH_SESSION_ID: "perchlive-2" } });
    assert.equal(g2.enabled, true, "the guard still installs");
    const g3 = installLeaseGuard({ tool() {} }, { dir: join(dir, "guard-3"), bundleVersion: null, env: { PI_BOT_PERCH_SESSION_ID: "perchlive-3" } });
    assert.equal(g3.enabled, true);
    assert.equal(existsSync(join(dir, "guard-3", "enforced.json")), false, "no version, no report");
    // An older core without writeEnforced: nothing written, nothing logged.
    const { writeEnforced, ...older } = lease; void writeEnforced;
    installLeaseGuard({ tool() {} }, { lease: older, dir: join(dir, "guard-4"), env: { PI_BOT_PERCH_SESSION_ID: "perchlive-4" } });
  } finally { console.error = orig; }
  assert.equal(errs.length, 2);
  assert.match(errs[0], /lease enforcement not reported: ENOSPC/);
});

// A known-enforcer table with studio in it (the marker path; the shipped table is the browser only).
const STUDIO_ENFORCES = Object.freeze({ studio: "2.0.0" });

test("unconfirmed lease gets no take over", () => {
  const studio = () => appTileInfo("studio", { crowHome: home, enforcers: STUDIO_ENFORCES });
  assert.deepEqual(studio(), { id: "studio", label: "Studio", src: "/proxy/studio/vnc.html?view_only=true&autoconnect=true&resize=scale", takeOver: false },
    "lease declared, no enforced.json: a watch-only tile");
  enforce("studio", "2.0.0");
  assert.equal(studio().takeOver, true, "a known enforcer, declared and enforced for the installed version");
  enforce("studio", "1.9.0");
  assert.equal(studio().takeOver, false, "enforced for another version");

  enforce("canvas", "1.0.0");
  assert.equal(appTileInfo("canvas", { crowHome: home }).takeOver, false, "enforced but not declared (desktop.lease absent)");
  assert.equal(appTileInfo("canvas", { crowHome: home }).src, "/proxy/canvas/vnc_lite.html?view_only=true&autoconnect=true&resize=scale");

  assert.equal(appTileInfo("wiki", { crowHome: home }), null, "a page app has no tile");
  assert.equal(appTileInfo("sneaky", { crowHome: home }), null, "a desktop path that climbs out is refused");
  assert.equal(appTileInfo("pager", { crowHome: home }), null, "a desktop path that is not a noVNC page is refused");
  assert.equal(appTileInfo("nested", { crowHome: home }).src, "/proxy/nested/app/novnc/vnc_lite.html?view_only=true&autoconnect=true&resize=scale");
  assert.equal(desktopApp("ghost", { crowHome: home }), null);
});

test("a non-allowlisted app with a valid enforced.json gets no take over; a known enforcer needs its first enforcing version", () => {
  assert.deepEqual({ ...LEASE_ENFORCERS }, { browser: "1.3.9" });
  enforce("studio", "2.0.0");
  assert.equal(leaseEnforced("studio", { crowHome: home }), true, "the marker is valid for the installed version");
  assert.equal(appTileInfo("studio", { crowHome: home }).takeOver, false, "but studio is not a known enforcer");

  // A known enforcer installed below its first enforcing version, with a matching marker.
  assert.equal(appTileInfo("studio", { crowHome: home, enforcers: { studio: "2.1.0" } }).takeOver, false, "2.0.0 predates its lease guard");
  assert.equal(appTileInfo("studio", { crowHome: home, enforcers: { studio: "2.0.0" } }).takeOver, true, "2.0.0 is the first");

  for (const [a, b, want] of [["1.3.11", "1.3.9", true], ["1.3.9", "1.3.9", true], ["1.3.8", "1.3.9", false], ["2", "1.3.9", true],
    ["1.3", "1.3.0", true], ["1.3.9-beta", "1.3.9", false], ["", "1.3.9", false], [null, "1.3.9", false]]) {
    assert.equal(versionAtLeast(a, b), want, a + " >= " + b);
  }
});

// ---------------------------------------------------------------------------
// the routes, over an engine built from the real helpers
// ---------------------------------------------------------------------------
// I1 (a): the browser is offered Take over whenever its own /browser/take-over
// route would accept; it never waits for enforced.json.
test("the browser's Take over follows its own route, not the marker; every other app keeps the marker rule", () => {
  assert.equal(readdirSync(home).includes("browser-lease"), false, "no marker, no lease dir");
  assert.equal(appTileInfo("browser", { crowHome: home }).takeOver, true, "installed: offered with no enforced.json");
  assert.equal(appTileInfo("browser", { crowHome: home, browserAccepts: () => true }).takeOver, true);
  assert.equal(appTileInfo("browser", { crowHome: home, browserAccepts: () => false }).takeOver, false, "the route would refuse: not offered");
  // An old or mismatched marker does not matter to the browser.
  enforce("browser", "1.3.10");
  assert.equal(appTileInfo("browser", { crowHome: home }).takeOver, true);
  // The browser installed below the lease guard's version: its route still accepts, so it is offered.
  const mf = join(home, "bundles", "browser", "manifest.json");
  const orig = readFileSync(mf, "utf8");
  try {
    writeFileSync(mf, JSON.stringify({ ...JSON.parse(orig), version: "1.3.8" }));
    _resetCatalogCache();
    assert.equal(appTileInfo("browser", { crowHome: home }).takeOver, true);
  } finally { writeFileSync(mf, orig); _resetCatalogCache(); }
  // Not installed: the route's browserInstalled() is false.
  const other = mkdtempSync(join(dir, "nobrowser-"));
  mkdirSync(join(other, "bundles", "browser"), { recursive: true });
  writeFileSync(join(other, "bundles", "browser", "manifest.json"), JSON.stringify({ id: "browser", name: "Browser", version: "1.3.11", webUI: { port: 6080, path: "/vnc.html" }, desktop: { path: "vnc.html", lease: true } }));
  writeFileSync(join(other, "installed.json"), "[]");
  assert.equal(appTileInfo("browser", { crowHome: other }), null, "not installed: no tile at all");
  // Studio with a valid marker but not a known enforcer: still nothing.
  enforce("studio", "2.0.0");
  assert.equal(appTileInfo("studio", { crowHome: home }).takeOver, false);
});

async function routes({ enforcers } = {}) {
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { default: express } = await import("express");
  const browserCalls = [];
  const browser = createTakeOver({ dir: () => { browserCalls.push("dir"); return appLeaseDir("browser", { crowHome: home }); }, onHeld: () => {}, isAlive: () => true });
  const engine = {
    browserTakeOver: browser,
    appTile: (id) => appTileInfo(id, { crowHome: home, enforcers }),
    appTakeOverOffered: (id) => { const a = appTileInfo(id, { crowHome: home, enforcers }); return !!a && a.takeOver; },
    appTakeOvers: createAppTakeOvers({
      browser,
      dirFor: (id) => (desktopApp(id, { crowHome: home }) ? appLeaseDir(id, { crowHome: home }) : null),
      isAlive: () => true,
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(perchInteractiveApiRouter((req, res, next) => next(), { engine: () => engine, annotate: async (m) => m, providerModels: () => [], piProviders: () => null }));
  const srv = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  const base = "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api/";
  const call = async (method, path) => {
    const r = await fetch(base + path, { method });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { engine, call, browserCalls, close: () => { engine.appTakeOvers.close(); return new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }); } };
}

test("take-over route refuses a non-desktop app", async () => {
  const r = await routes();
  try {
    assert.deepEqual(await r.call("POST", "apps/wiki/take-over"), { status: 404, body: { error: "not_desktop" } }, "a page app");
    assert.deepEqual(await r.call("POST", "apps/ghost/take-over"), { status: 404, body: { error: "not_desktop" } }, "not installed");
    assert.deepEqual(await r.call("POST", "apps/sneaky/take-over"), { status: 404, body: { error: "not_desktop" } }, "a bad desktop path");
    assert.equal((await r.call("POST", "apps/Bad_Id/take-over")).status, 400);
    assert.equal((await r.call("GET", "apps/wiki/tile")).status, 404);
    assert.equal((await r.call("GET", "apps/Bad_Id/tile")).status, 400);
    assert.equal(r.engine.appTakeOvers.get("wiki"), null, "no controller was made for a refused app");
    assert.equal(existsSync(join(home, "app-lease-wiki")), false, "and no lease directory");

    // Declared but unconfirmed: refused, nothing taken.
    assert.deepEqual(await r.call("POST", "apps/studio/take-over"), { status: 409, body: { error: "lease_not_enforced" } });
    assert.deepEqual(await r.call("POST", "apps/canvas/take-over"), { status: 409, body: { error: "lease_not_enforced" } }, "no lease declared");
    assert.equal(await lease.readLease(join(home, "app-lease-studio")), null);
    assert.deepEqual((await r.call("GET", "apps/studio/tile")).body,
      { id: "studio", label: "Studio", src: "/proxy/studio/vnc.html?view_only=true&autoconnect=true&resize=scale", takeOver: false });
    assert.deepEqual((await r.call("POST", "apps/studio/heartbeat")).body, { state: "idle" }, "never taken: idle");

    // A valid marker for a non-allowlisted app: still refused, nothing taken.
    enforce("studio", "2.0.0");
    assert.deepEqual(await r.call("POST", "apps/studio/take-over"), { status: 409, body: { error: "lease_not_enforced" } });
    assert.equal(await lease.readLease(join(home, "app-lease-studio")), null);
    assert.equal(r.engine.appTakeOvers.get("studio"), null);

    // The browser on the app routes: offered whenever its own route accepts (no marker).
    assert.equal((await r.call("GET", "apps/browser/tile")).body.takeOver, true);
    assert.deepEqual(await r.call("POST", "apps/browser/take-over"), { status: 200, body: { state: "held" } });
    assert.equal((await lease.readLease(join(home, "browser-lease"))).holder.kind, "operator");
    assert.equal(await lease.readLease(join(home, "app-lease-studio")), null, "another app's lease is untouched");
    assert.deepEqual((await r.call("POST", "apps/browser/heartbeat")).body, { state: "held" });
    assert.deepEqual((await r.call("GET", "apps/browser/state")).body, { state: "held" });
    assert.deepEqual((await r.call("GET", "browser/state")).body, { state: "held" }, "the same controller as /browser/*");
    // A bot now waits on the operator.
    const acq = await lease.acquire(join(home, "browser-lease"), { kind: "bot", sessionId: "perchlive-9", botId: null });
    assert.equal(acq.ok, false); assert.equal(acq.reason, "operator");
    assert.deepEqual(await r.call("POST", "apps/browser/hand-back"), { status: 200, body: { state: "idle" } });
    assert.equal((await lease.readLease(join(home, "browser-lease"))).holder, null);
    assert.ok(r.browserCalls.length > 0, "the browser's own controller did the work");

    // Another bot holding at take time: 409 other_bot, as on /browser/*.
    const real = r.engine.browserTakeOver.takeOver;
    r.engine.browserTakeOver.takeOver = () => Promise.resolve({ state: "other_bot" });
    try {
      assert.deepEqual(await r.call("POST", "apps/browser/take-over"), { status: 409, body: { error: "other_bot" } });
    } finally { r.engine.browserTakeOver.takeOver = real; }
  } finally { await r.close(); }
});

// The marker path on the routes: an app the enforcer table knows (studio here).
test("app take-over routes keep the marker rule for a non-browser app; hand back of an app nobody took makes no lease dir", async () => {
  const r = await routes({ enforcers: STUDIO_ENFORCES });
  try {
    assert.deepEqual(await r.call("POST", "apps/studio/hand-back"), { status: 200, body: { state: "idle" } }, "never taken: idle");
    assert.equal(existsSync(join(home, "app-lease-studio")), false, "hand back created no lease directory");
    assert.equal(r.engine.appTakeOvers.get("studio"), null, "nor a controller");
    assert.deepEqual(await r.call("POST", "apps/wiki/hand-back"), { status: 404, body: { error: "not_desktop" } });

    assert.deepEqual(await r.call("POST", "apps/studio/take-over"), { status: 409, body: { error: "lease_not_enforced" } }, "declared, no marker");
    enforce("studio", "2.0.0");
    assert.equal((await r.call("GET", "apps/studio/tile")).body.takeOver, true);
    assert.deepEqual(await r.call("POST", "apps/studio/take-over"), { status: 200, body: { state: "held" } });
    assert.equal((await lease.readLease(join(home, "app-lease-studio"))).holder.kind, "operator");
    // An upgrade since its server started: hand back still works; take over does not.
    enforce("studio", "1.9.0");
    assert.deepEqual(await r.call("POST", "apps/studio/hand-back"), { status: 200, body: { state: "idle" } });
    assert.equal((await lease.readLease(join(home, "app-lease-studio"))).holder, null);
    assert.deepEqual(await r.call("POST", "apps/studio/take-over"), { status: 409, body: { error: "lease_not_enforced" } });
  } finally { await r.close(); }
  // A fresh gateway (no controller) with a lease dir on disk: hand back frees it.
  const r2 = await routes({ enforcers: STUDIO_ENFORCES });
  try {
    assert.ok(existsSync(join(home, "app-lease-studio")));
    assert.deepEqual(await r2.call("POST", "apps/studio/hand-back"), { status: 200, body: { state: "idle" } });
    assert.ok(r2.engine.appTakeOvers.get("studio"), "made for an existing lease dir");
  } finally { await r2.close(); }
});

test("the real engine answers appTile from its own CROW_HOME", async () => {
  process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
  const { createInteractiveEngine } = await import("../servers/gateway/perch-interactive.js");
  const engine = createInteractiveEngine({ crowHome: home, env: { CROW_HOME: home }, log: () => {}, notifications: {} });
  try {
    assert.deepEqual(engine.appTile("browser"),
      { id: "browser", label: "Browser", src: "/proxy/browser/vnc.html?view_only=true&autoconnect=true&resize=scale", takeOver: true },
      "the browser installed: offered with no enforced.json, as /browser/take-over would accept");
    assert.equal(engine.appTakeOverOffered("browser"), true);
    const off = createInteractiveEngine({ crowHome: home, env: { CROW_HOME: home }, log: () => {}, notifications: {}, browserLease: { installed: false } });
    try {
      assert.equal(off.appTile("browser").takeOver, false, "the engine's browser route would refuse (no browser): not offered");
      assert.equal(off.appTakeOverOffered("browser"), false);
    } finally { await off.stopAll({ timeoutMs: 100 }); }
    assert.equal(engine.appTakeOverOffered("studio"), false);
    assert.equal(engine.appTile("wiki"), null);
    assert.equal(engine.appTakeOvers.get("browser"), engine.browserTakeOver, "the browser keeps its own controller");
  } finally { await engine.stopAll({ timeoutMs: 100 }); }
});

// ---------------------------------------------------------------------------
// the client: crow:open-app-tile in the hub's scope
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const attrs = {};
  const node = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null,
    className: "", textContent: "", hidden: false, disabled: false, type: "", onclick: null,
    style: {}, scrollTop: 0, scrollHeight: 0, focused: 0,
    focus() { node.focused += 1; sandboxRef.active = node; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { return this.appendChild(c); },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    querySelector(sel) { return sel === ".shell-app-label" ? (node.children.find((c) => c.className === "shell-app-label") || null) : null; },
    get firstChild() { return this.children[0] || null; },
  };
  Object.defineProperty(node, "innerHTML", { set() { throw new Error("innerHTML sink reached"); }, get() { return ""; } });
  return node;
}
const sandboxRef = { active: null };
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
function walk(n, fn) { fn(n); for (const c of n.children) walk(c, fn); }
const byClass = (n, cls) => { const o = []; walk(n, (x) => { if (String(x.className || "").split(/\s+/).includes(cls)) o.push(x); }); return o; };

async function hub({ newMode = true, sid = "perchlive-aaaaaaaa", links = [{ id: "studio", label: "Studio", kind: "desktop" }, { id: "wiki", label: "Wiki", kind: "page" }], tile, lang = "en" } = {}) {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const { perchBrowserTileJs } = await import("../servers/gateway/dashboard/perch-hub/browser-tile.js");
  const { perchTakeOverJs } = await import("../servers/gateway/dashboard/perch-hub/take-over.js");
  const src = perchHubJs(lang);
  const lift = (name) => {
    const start = src.indexOf("function " + name + "(");
    let depth = 0;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (!depth) return src.slice(start, i + 1); }
    }
    throw new Error(name);
  };
  const transcript = makeEl("div");
  const root = makeEl("div");
  const input = makeEl("textarea");
  const mine = makeEl("button"); mine.hidden = false;   /* "You have the browser · Hand back", shown */
  const sheet = newMode ? makeEl("dialog") : null;
  const anchors = links.map((l) => {
    const a = makeEl("a"); a.className = "shell-app";
    a.setAttribute("data-app-id", l.id); a.setAttribute("data-app-kind", l.kind);
    a.setAttribute("href", l.href || "/proxy/" + l.id + "/vnc.html?autoconnect=true&resize=scale&view_only=false");
    const lb = makeEl("span"); lb.className = "shell-app-label"; lb.textContent = l.label; a.appendChild(lb);
    return a;
  });
  const calls = [];
  const answer = tile || ((path) => {
    if (path.endsWith("/apps/studio/tile")) return { status: 200, body: { id: "studio", label: "Studio", src: "/proxy/studio/vnc.html?view_only=true&autoconnect=true&resize=scale", takeOver: true } };
    if (path.endsWith("/apps/studio/take-over") || path.endsWith("/apps/studio/heartbeat")) return { status: 200, body: { state: "held" } };
    if (path.endsWith("/apps/studio/hand-back")) return { status: 200, body: { state: "idle" } };
    return { status: 404, body: {} };
  });
  const docT = new EventTarget();
  const timers = [];
  const sandbox = {
    console, API: "/dashboard/perch-api", HUB: { streams: {} }, navigator: {}, window: { innerWidth: 390 },
    location: { search: "", pathname: "/dashboard/perch", hash: "" }, history: { replaceState() {} },
    current: { sid },
    document: {
      visibilityState: "visible", cookie: "crow_csrf=t", body: makeEl("body"),
      createElement: (t) => makeEl(t),
      addEventListener: (...a) => docT.addEventListener(...a),
      dispatchEvent: (ev) => docT.dispatchEvent(ev),
      querySelectorAll: (sel) => (sel === 'a.shell-app[data-app-kind="desktop"]' ? anchors.filter((a) => a.getAttribute("data-app-kind") === "desktop") : []),
    },
    el: (id) => ({ "perch-transcript": transcript, "perch-hub-root": root, "perch-input": input, "perch-session-sheet": sheet, "perch-browser-mine": mine }[id] || null),
    live: () => true,
    bindOnce: (target, type, key, fn) => target.addEventListener(type, fn),
    fetch: (url, opts = {}) => {
      const path = String(url).split("?")[0];
      calls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
      const r = answer(path, calls[calls.length - 1]);
      return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body) });
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    AbortController, CustomEvent, Event, Date, Math, JSON, Promise, encodeURIComponent, Number, String, Array,
    line: (cls, text) => { const d = makeEl("div"); d.className = cls; d.textContent = text == null ? "" : String(text); return d; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`(function(){\n${lift("csrf")}\n${lift("perchApi")}\n${perchBrowserTileJs(lang)}\n${perchTakeOverJs(lang)}\n;globalThis.__reset=resetBrowserTiles;globalThis.__resetApps=resetAppTiles;\n})();`, sandbox);
  const open = async (appId) => {
    const ev = new CustomEvent("crow:open-app-tile", { detail: { appId }, cancelable: true });
    sandbox.document.dispatchEvent(ev);
    await tick();
    return ev.defaultPrevented;
  };
  const fireTimers = async () => { while (timers.length) timers.shift().fn(); await tick(); };
  return { sandbox, transcript, root, input, mine, calls, open, fireTimers, timers };
}

const BROWSER_LINK = { id: "browser", label: "Browser Automation", kind: "desktop" };
const PW_ENTRY = { id: 41, bundle_id: "browser", env_key: "CROW_BROWSER_VNC_PASSWORD", readable: true };
function browserServer({ takeOver = true, reveal } = {}) {
  return (path, call) => {
    if (path.endsWith("/apps/browser/tile")) return { status: 200, body: { id: "browser", label: "Browser Automation", src: "/proxy/browser/vnc.html?view_only=true&autoconnect=true&resize=scale", takeOver } };
    if (path.endsWith("/browser/take-over") || path.endsWith("/browser/heartbeat")) return { status: 200, body: { state: "held" } };
    if (path.endsWith("/browser/hand-back")) return { status: 200, body: { state: "idle" } };
    if (path.endsWith("/keychain/api/entries")) return { status: 200, body: { entries: [PW_ENTRY], reauth_method: "password" } };
    if (path.endsWith("/keychain/api/reveal")) return reveal ? reveal(call) : { status: 200, body: { secret: "vnc-Secret-77" } };
    if (path.endsWith("/keychain/api/reauth")) return { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  };
}

test("the client opens a tile only for a known desktop app in an open new-mode session, watch-only, with Take over when offered", async () => {
  const h = await hub();
  assert.equal(await h.open("wiki"), false, "a page app: not handled, the link navigates");
  assert.equal(await h.open("ghost"), false, "an app the page never offered");
  assert.equal(await h.open("../x"), false, "a bad id");
  assert.equal(byClass(h.transcript, "ph-atile").length, 0);

  assert.equal(await h.open("studio"), true, "a desktop app: handled");
  const [tile] = byClass(h.transcript, "ph-atile");
  assert.ok(tile);
  assert.equal(tile.getAttribute("data-app"), "studio");
  assert.equal(byClass(tile, "at-name")[0].textContent, "Studio");
  const frame = byClass(tile, "at-vnc")[0];
  assert.equal(frame.getAttribute("src"), "/proxy/studio/vnc.html?view_only=true&autoconnect=true&resize=scale");
  assert.equal(byClass(tile, "at-take")[0].hidden, false, "offered");
  await h.fireTimers();
  assert.ok(tile.focused >= 1, "focus moves into the tile");

  assert.equal(await h.open("studio"), true, "again: the same tile");
  assert.equal(byClass(h.transcript, "ph-atile").length, 1);

  // Take over: the #589 sheet on the app's own routes, no password row.
  byClass(tile, "at-take")[0].onclick();
  await tick();
  const sheet = byClass(h.root, "ph-tosheet")[0];
  assert.ok(sheet, "the Take over sheet");
  assert.equal(byClass(sheet, "to-host")[0].textContent, "Studio");
  assert.ok(h.calls.some((c) => c.method === "POST" && c.path.endsWith("/apps/studio/take-over")));
  assert.ok(!h.calls.some((c) => c.path.includes("/browser/") || c.path.includes("/keychain/")), "never the browser's routes or its password");
  assert.equal(byClass(sheet, "to-vnc")[0].getAttribute("src"), "/proxy/studio/vnc.html?autoconnect=true&resize=scale&view_only=false");
  byClass(sheet, "to-back")[0].onclick();
  await tick();
  assert.ok(h.calls.some((c) => c.method === "POST" && c.path.endsWith("/apps/studio/hand-back")));
  assert.equal(byClass(h.root, "ph-tosheet").length, 0, "handed back: the sheet closes");

  // Close drops the tile; a new transcript drops any.
  byClass(tile, "at-close")[0].onclick();
  assert.equal(byClass(h.transcript, "ph-atile").length, 0);
  assert.equal(frame.getAttribute("src"), "about:blank");
  await h.open("studio");
  h.sandbox.__reset();
  assert.equal(byClass(h.transcript, "ph-atile").length, 0);
});

test("the client: no session or old mode is not handled; an unconfirmed or refused app gets no Take over", async () => {
  assert.equal(await (await hub({ newMode: false })).open("studio"), false, "old mode");
  assert.equal(await (await hub({ sid: null })).open("studio"), false, "no open session");

  const watch = await hub({ tile: () => ({ status: 200, body: { id: "studio", label: "Studio", src: "/proxy/studio/vnc.html?x", takeOver: false } }) });
  await watch.open("studio");
  const t1 = byClass(watch.transcript, "ph-atile")[0];
  assert.equal(byClass(t1, "at-take")[0].hidden, true, "not offered: watch-only");
  assert.equal(byClass(t1, "at-vnc")[0].getAttribute("src"), "/proxy/studio/vnc.html?view_only=true&autoconnect=true&resize=scale", "the tile builds its own query");
  byClass(t1, "at-take")[0].onclick();
  await tick();
  assert.equal(byClass(watch.root, "ph-tosheet").length, 0, "a hidden Take over does nothing");

  for (const src of ["/proxy/other/vnc.html", "https://evil.example/vnc.html", "/proxy/studio/../../dashboard", "/proxy/studio//x", "javascript:alert(1)", "/proxy/studio/index.html", "/proxy/studio/vnc.html.evil", "/proxy/studio/x/vnc.htm"]) {
    const bad = await hub({ tile: () => ({ status: 200, body: { id: "studio", label: "Studio", src, takeOver: true } }) });
    assert.equal(await bad.open("studio"), true);
    const t = byClass(bad.transcript, "ph-atile")[0];
    assert.equal(byClass(t, "at-vnc").length, 0, "no frame for " + src);
    assert.equal(byClass(t, "at-take")[0].hidden, true);
    assert.equal(byClass(t, "at-note")[0].hidden, false, "it says it can't be shown");
  }
  const gone = await hub({ tile: () => ({ status: 404, body: { error: "not_desktop" } }) });
  await gone.open("studio");
  assert.equal(byClass(byClass(gone.transcript, "ph-atile")[0], "at-note")[0].textContent, "This app can't be shown here.");
});

test("the Take over sheet refuses an app whose base is not a noVNC page (never the browser's sheet instead)", async () => {
  const h = await hub();
  for (const base of ["/proxy/studio/index.html", "/proxy/studio/vnc.html/x", "/proxy/other/vnc.html", "/proxy/studio/../vnc.html"]) {
    h.sandbox.document.dispatchEvent(new CustomEvent("perch:browser-takeover", { detail: { sid: "perchlive-aaaaaaaa", anchor: null, app: { id: "studio", label: "Studio", base } } }));
    await tick();
    assert.equal(byClass(h.root, "ph-tosheet").length, 0, base);
  }
  assert.deepEqual(h.calls, [], "no take-over request at all");
  h.sandbox.document.dispatchEvent(new CustomEvent("perch:browser-takeover", { detail: { sid: "perchlive-aaaaaaaa", anchor: null, app: { id: "studio", label: "Studio", base: "/proxy/studio/novnc/vnc_lite.html" } } }));
  await tick();
  assert.equal(byClass(byClass(h.root, "ph-tosheet")[0], "to-vnc")[0].getAttribute("src"), "/proxy/studio/novnc/vnc_lite.html?autoconnect=true&resize=scale&view_only=false");
});

test("the client code is template-safe in both languages", async () => {
  const { perchBrowserTileJs } = await import("../servers/gateway/dashboard/perch-hub/browser-tile.js");
  const { perchTakeOverJs } = await import("../servers/gateway/dashboard/perch-hub/take-over.js");
  const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const lang of ["en", "es"]) {
    for (const js of [perchBrowserTileJs(lang), perchTakeOverJs(lang)]) {
      assert.equal(js.includes("`"), false);
      assert.equal(js.includes("${"), false);
      assert.equal(js.includes("localStorage"), false);
      assert.doesNotThrow(() => new Function(js));
    }
  }
  for (const k of ["perch.appTileWatching", "perch.appTileClose", "perch.appTileUnavailable", "perch.appTileOpen"]) {
    assert.ok(translations[k] && translations[k].en && translations[k].es, k);
  }
});

// I4: an app tile for "browser" takes the browser path, password and all.
test("the browser's app tile takes the browser path: /browser/take-over, the keychain lookup, a view_only=false viewer", async () => {
  const h = await hub({ links: [BROWSER_LINK], tile: browserServer() });
  assert.equal(await h.open("browser"), true);
  const tile = byClass(h.transcript, "ph-atile")[0];
  assert.equal(byClass(tile, "at-name")[0].textContent, "Browser Automation");
  assert.equal(byClass(tile, "at-take")[0].hidden, false, "offered (the route would accept)");
  byClass(tile, "at-take")[0].onclick();
  await tick();
  const sheet = byClass(h.root, "ph-tosheet")[0];
  assert.ok(sheet, "the Take over sheet");
  assert.ok(h.calls.some((c) => c.method === "POST" && c.path === "/dashboard/perch-api/browser/take-over"), "the browser's own route");
  assert.ok(!h.calls.some((c) => c.path.includes("/apps/browser/take-over")), "never the generic app route");
  const lookups = h.calls.filter((c) => c.method === "GET" && c.path === "/dashboard/keychain/api/entries");
  assert.equal(lookups.length, 2, "the tile's lookup and the sheet's own");
  assert.equal(byClass(sheet, "to-copy")[0].hidden, false, "the sheet's Copy password, as today");
  assert.equal(byClass(sheet, "to-vnc")[0].getAttribute("src"), "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false");
  byClass(sheet, "to-back")[0].onclick();
  await tick();
  assert.ok(h.calls.some((c) => c.method === "POST" && c.path === "/dashboard/perch-api/browser/hand-back"));
});

// I1 (b): the browser's watch view meets noVNC's password prompt: the sheet's Copy password, same flow.
test("the browser's watch-only tile has the sheet's Copy password: keychain lookup, re-auth, reveal, wiped on close", async () => {
  let reveals = 0;
  const h = await hub({ links: [BROWSER_LINK], tile: browserServer({ takeOver: false, reveal: () => (++reveals === 1 ? { status: 403, body: { code: "reauth_required" } } : { status: 200, body: { secret: "vnc-Secret-77" } }) }) });
  await h.open("browser");
  const tile = byClass(h.transcript, "ph-atile")[0];
  const copy = byClass(tile, "to-copy")[0];
  assert.ok(copy, "a Copy password row in the tile");
  assert.equal(copy.textContent, "Copy password");
  assert.equal(copy.hidden, false, "the browser entry was found");
  copy.onclick();
  await tick();
  const reauth = byClass(tile, "to-reauth")[0];
  assert.equal(reauth.hidden, false, "the keychain asks for a re-auth first, as in the sheet");
  byClass(tile, "to-reauth-input")[0].value = "hunter2";
  byClass(tile, "to-reauth-go")[0].onclick();
  await tick();
  const re = h.calls.find((c) => c.path === "/dashboard/keychain/api/reauth");
  assert.deepEqual(re.body, { password: "hunter2" });
  assert.equal(reauth.hidden, true);
  const pw = byClass(tile, "to-pw")[0];
  assert.equal(pw.textContent, "vnc-Secret-77", "no clipboard here: shown briefly");
  assert.deepEqual(h.calls.filter((c) => c.path === "/dashboard/keychain/api/reveal").map((c) => c.body), [{ id: 41, purpose: "copy" }, { id: 41, purpose: "copy" }]);
  byClass(tile, "at-close")[0].onclick();
  assert.equal(pw.textContent, "", "closing the tile wipes it");
  assert.equal(byClass(tile, "to-reauth-input")[0].value, "");

  // Another app's tile has no password row and makes no keychain call.
  const s2 = await hub();
  await s2.open("studio");
  assert.equal(byClass(byClass(s2.transcript, "ph-atile")[0], "to-copy").length, 0);
  assert.ok(!s2.calls.some((c) => c.path.includes("/keychain/")));
});

// I1 (c): whenever Take over is not offered, the tile links to the app's page.
test("the tile offers Open to the app's page whenever Take over is not offered (en + es)", async () => {
  const watch = await hub({ tile: () => ({ status: 200, body: { id: "studio", label: "Studio", src: "/proxy/studio/vnc.html", takeOver: false } }) });
  await watch.open("studio");
  const t = byClass(watch.transcript, "ph-atile")[0];
  const open = byClass(t, "at-open")[0];
  assert.equal(open.hidden, false);
  assert.equal(open.textContent, "Open");
  assert.equal(open.getAttribute("href"), "/proxy/studio/vnc.html?autoconnect=true&resize=scale&view_only=false", "the launcher's own link");
  assert.equal(open.getAttribute("data-turbo"), "false");

  const offered = await hub();
  await offered.open("studio");
  assert.equal(byClass(byClass(offered.transcript, "ph-atile")[0], "at-open")[0].hidden, true, "Take over offered: no Open");

  const gone = await hub({ tile: () => ({ status: 404, body: { error: "not_desktop" } }) });
  await gone.open("studio");
  assert.equal(byClass(byClass(gone.transcript, "ph-atile")[0], "at-open")[0].hidden, false, "can't be shown: Open still");

  const es = await hub({ lang: "es", tile: () => ({ status: 200, body: { id: "studio", label: "Studio", src: "/proxy/studio/vnc.html", takeOver: false } }) });
  await es.open("studio");
  assert.equal(byClass(byClass(es.transcript, "ph-atile")[0], "at-open")[0].textContent, "Abrir");

  // A launcher href that is not this app's proxy page gives no Open link.
  for (const href of ["/dashboard/x", "https://evil.example/", "/proxy/other/vnc.html", "/proxy/studio/../../dashboard", "/proxy/studio//x"]) {
    const bad = await hub({ links: [{ id: "studio", label: "Studio", kind: "desktop", href }], tile: () => ({ status: 200, body: { id: "studio", label: "Studio", src: "/proxy/studio/vnc.html", takeOver: false } }) });
    await bad.open("studio");
    assert.equal(byClass(byClass(bad.transcript, "ph-atile")[0], "at-open").length, 0, href);
  }
});

test("another app's sheet never hides the browser's \"You have the browser\" control; the browser's own sheet does", async () => {
  const h = await hub();
  await h.open("studio");
  byClass(byClass(h.transcript, "ph-atile")[0], "at-take")[0].onclick();
  await tick();
  assert.ok(byClass(h.root, "ph-tosheet")[0], "studio's sheet is open");
  assert.equal(h.mine.hidden, false, "the browser's control is untouched");
  byClass(byClass(h.root, "ph-tosheet")[0], "to-back")[0].onclick();
  await tick();
  assert.equal(h.mine.hidden, false);

  const b = await hub({ links: [BROWSER_LINK], tile: browserServer() });
  await b.open("browser");
  byClass(byClass(b.transcript, "ph-atile")[0], "at-take")[0].onclick();
  await tick();
  assert.equal(b.mine.hidden, true, "the browser's sheet hides it while open, as before");
});

test("a 1.3.10-shaped installed browser (no desktop, no mcpServers) is a page link the Perch handler leaves alone", async () => {
  const { listApps } = await import("../servers/gateway/apps/catalog.js");
  const { clientApp } = await import("../servers/gateway/apps/launcher.js");
  const old = mkdtempSync(join(dir, "browser-1310-"));
  const repoMf = JSON.parse(readFileSync(new URL("../bundles/browser/manifest.json", import.meta.url), "utf8"));
  const { desktop, mcpServers, ...mf1310 } = repoMf;
  assert.ok(desktop && mcpServers, "the repo manifest has both (so the strip is real)");
  mkdirSync(join(old, "bundles", "browser"), { recursive: true });
  writeFileSync(join(old, "bundles", "browser", "manifest.json"), JSON.stringify({ ...mf1310, version: "1.3.10" }));
  writeFileSync(join(old, "installed.json"), JSON.stringify([{ id: "browser" }]));
  _resetCatalogCache();
  const app = listApps({ crowHome: old }).find((a) => a.id === "browser");
  assert.equal(app.kind, "page");
  assert.equal(app.desktopPath, null);
  assert.equal(app.label, "Browser Automation", "the manifest's name, not \"VNC Viewer\"");
  assert.equal(app.href, "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false", "its noVNC page is pinned too");
  assert.equal(appTileInfo("browser", { crowHome: old }), null, "no tile");
  const c = clientApp(app);
  const h = await hub({ links: [{ id: c.id, label: c.label, kind: c.kind, href: c.href }] });
  assert.equal(await h.open("browser"), false, "not handled: the link navigates");
  assert.equal(byClass(h.transcript, "ph-atile").length, 0);
  assert.deepEqual(h.calls, [], "no tile request");
  _resetCatalogCache();
});

// Password hygiene: a Turbo snapshot and a retired hub keep nothing of the password.
test("turbo:before-cache wipes the sheet's and the browser tile's revealed password and typed re-auth", async () => {
  const h = await hub({ links: [BROWSER_LINK], tile: browserServer() });
  await h.open("browser");
  const tile = byClass(h.transcript, "ph-atile")[0];
  byClass(tile, "to-copy")[0].onclick();
  await tick();
  const tilePw = byClass(tile, "to-pw")[0];
  assert.equal(tilePw.textContent, "vnc-Secret-77", "the tile shows it (no clipboard)");
  byClass(tile, "to-reauth-input")[0].value = "typed";
  byClass(tile, "at-take")[0].onclick();
  await tick();
  const sheet = byClass(h.root, "ph-tosheet")[0];
  byClass(sheet, "to-copy")[0].onclick();
  await tick();
  const sheetPw = byClass(sheet, "to-pw")[0];
  assert.equal(sheetPw.textContent, "vnc-Secret-77", "the sheet shows it too");
  byClass(sheet, "to-reauth-input")[0].value = "typed";

  h.sandbox.document.dispatchEvent(new Event("turbo:before-cache"));
  assert.equal(sheetPw.textContent, ""); assert.equal(sheetPw.hidden, true);
  assert.equal(byClass(sheet, "to-reauth-input")[0].value, "");
  assert.equal(tilePw.textContent, ""); assert.equal(tilePw.hidden, true);
  assert.equal(byClass(tile, "to-reauth-input")[0].value, "");
});

test("HUB.retire resets the app tiles, wiping the browser tile's password and its pending re-auth", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const src = perchHubJs("en");
  const at = src.indexOf("HUB.retire=function(){");
  const body = src.slice(at, src.indexOf("\n  };", at));
  assert.ok(at > -1 && /\bresetAppTiles\(\);/.test(body), "HUB.retire calls resetAppTiles()");

  let reveals = 0;
  const h = await hub({ links: [BROWSER_LINK], tile: browserServer({ takeOver: false, reveal: () => (++reveals === 1 ? { status: 403, body: { code: "reauth_required" } } : { status: 200, body: { secret: "vnc-Secret-77" } }) }) });
  await h.open("browser");
  const tile = byClass(h.transcript, "ph-atile")[0];
  byClass(tile, "to-copy")[0].onclick();
  await tick();
  assert.equal(byClass(tile, "to-reauth")[0].hidden, false, "a re-auth is pending (its retry callback held)");
  byClass(tile, "to-reauth-input")[0].value = "typed";
  const reauthGo = byClass(tile, "to-reauth-go")[0];
  h.sandbox.__resetApps();          /* what HUB.retire now runs */
  assert.equal(byClass(h.transcript, "ph-atile").length, 0, "the tile is gone");
  assert.equal(byClass(tile, "to-reauth-input")[0].value, "", "the typed re-auth is wiped");
  // A late confirm on the dropped row does nothing: no retry, no reveal.
  reauthGo.onclick();
  await tick();
  assert.equal(reveals, 1, "the pending retry never runs after retire");
  assert.equal(byClass(tile, "to-pw")[0].textContent, "");
});
