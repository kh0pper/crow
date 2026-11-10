/**
 * `createWallContext` (scripts/addon-sandbox/gateway-wall.mjs): the Crow roots,
 * the two owner checks, the host's own names and addresses, and the three spawn
 * kinds. Pure: docker, tailscale, the interface table, the listener
 * identification and the spawn wrapper are seams, so no bwrap and no docker run
 * here.
 *
 * Scratch dirs under mkdtemp; a fake spawn wrapper records what it was handed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { AddonWallRefused } from "../scripts/addon-sandbox/spawn.mjs";
import { createWallContext } from "../scripts/addon-sandbox/gateway-wall.mjs";
import { createDockerView } from "../scripts/addon-sandbox/docker-view.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-gateway-wall-")));
after(() => rmSync(T, { recursive: true, force: true }));

let seq = 0;
const freshDir = (name) => {
  const dir = join(T, name + "-" + ++seq);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A checkout shape `profileFor` can read: the past-defaults table, and one bundle. */
function appRootWith(id = null) {
  const root = freshDir("app");
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "addon-past-defaults.json"), JSON.stringify({ version: 1, defaults: {} }));
  if (id) {
    mkdirSync(join(root, "bundles", id), { recursive: true });
    writeFileSync(join(root, "bundles", id, "manifest.json"), JSON.stringify({
      id,
      name: id,
      description: "a fixture add-on",
      type: "mcp-server",
      category: "testing",
      version: "1.0.0",
      server: { command: "node", args: [] },
    }));
  }
  return root;
}

/** The empty docker snapshot a spawn sees when nothing is running. */
const EMPTY_VIEW = {
  snapshot: async () => ({ publishes: [], containers: [], subnets: [], addonProjects: new Map() }),
};

/** A quiet `deps`: no tailscale, no interfaces, no docker. */
const quietDeps = (extra = {}) => ({
  dockerView: () => EMPTY_VIEW,
  tailscaleStatus: async () => null,
  interfaces: () => ({}),
  ...extra,
});

/** A spawn wrapper that records its options. */
function spawnRecorder() {
  const calls = [];
  return {
    calls,
    wrapAddonSpawn: async (o) => {
      calls.push(o);
      return { walled: true, tier: "walled", cmd: "/usr/bin/bwrap", args: [], env: {}, stdioExtra: [], cleanup: () => {} };
    },
  };
}

/** A docker view seam that records the options it was handed. */
function viewRecorder() {
  const opts = [];
  return {
    opts,
    dockerView: (o) => {
      opts.push(o);
      return EMPTY_VIEW;
    },
  };
}

/** One context over a fresh layout. */
function context({ deps = quietDeps(), appRoot = null, dataDir = null, gatewayEnv = {}, crowHome = null, home = null } = {}) {
  const theHome = home || freshDir("home");
  return createWallContext({
    crowHome: crowHome || join(theHome, ".crow"),
    appRoot: appRoot || appRootWith(),
    dataDir: dataDir || freshDir("data"),
    home: theHome,
    nodeBin: process.execPath,
    gatewayPort: 3001,
    gatewayEnv,
    deps,
  });
}

// ---- the Crow roots ------------------------------------------------------

test("crowRoots holds the checkout, the home, the data dir and every co-hosted home, both spellings", () => {
  const home = join(T, "roots-home");
  const realCrow = join(T, "roots-real", ".crow");
  mkdirSync(join(realCrow, "data"), { recursive: true });
  mkdirSync(join(home, ".crow-r2"), { recursive: true });
  mkdirSync(join(home, ".config"), { recursive: true });
  symlinkSync(realCrow, join(home, ".crow"));
  const crowHome = join(home, ".crow");
  const dataDir = join(crowHome, "data");
  const appRoot = appRootWith();

  // Nothing may reach docker or tailscale before a spawn asks for it.
  let probes = 0;
  const deps = {
    dockerView: () => { probes += 1; return EMPTY_VIEW; },
    tailscaleStatus: async () => { probes += 1; return null; },
  };
  const ctx = createWallContext({ crowHome, appRoot, dataDir, home, nodeBin: process.execPath, gatewayPort: 3001, gatewayEnv: {}, deps });
  assert.equal(probes, 0, "creating the context asks nothing");

  const roots = ctx.crowRoots;
  for (const p of [appRoot, crowHome, dataDir, realpathSync(crowHome), join(home, ".crow-r2")]) {
    assert.ok(roots.includes(p), "a root is missing: " + p);
  }
  assert.equal(roots.includes(join(home, ".config")), false, "an ordinary hidden entry is not a Crow root");
  assert.equal(new Set(roots).size, roots.length, "no root is listed twice");
  assert.deepEqual(ctx.crowRoots, roots, "the roots are computed once");
  assert.equal(probes, 0);
});

// ---- the two owner checks -------------------------------------------------

test("listenerOwnerFor identifies the listener with this context's Crow roots and no docker view", async () => {
  const seen = [];
  const ctx = context({
    deps: quietDeps({
      identifyListener: async (addr, port, opts) => {
        seen.push({ addr, port, opts });
        return { kind: "own-uid" };
      },
      // A docker read that fails: the listener check must then see no docker view.
      dockerView: () => ({ snapshot: async () => { throw new Error("docker is down"); } }),
    }),
  });
  const verdict = await ctx.listenerOwnerFor("kiosk")("127.0.0.1", 8123);
  assert.equal(verdict.kind, "own-uid");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].addr, "127.0.0.1");
  assert.equal(seen[0].port, 8123);
  assert.deepEqual(seen[0].opts.crowRoots, ctx.crowRoots);
  assert.equal(seen[0].opts.addonId, "kiosk");
  assert.deepEqual(seen[0].opts.selfPids, [process.pid]);
  assert.equal(seen[0].opts.docker, null, "a failed snapshot is no docker view");
  assert.ok(seen[0].opts.addonProjects instanceof Map);
  assert.equal(seen[0].opts.addonProjects.size, 0);
});

test("containerOwnerFor: this add-on's own project passes; a bridge address with no docker view is denied", async () => {
  const view = {
    snapshot: async () => ({
      publishes: [],
      containers: [{ id: "c1", name: "own", project: "proj", ips: ["172.18.0.5"] }],
      subnets: ["172.18.0.0/16"],
      addonProjects: new Map([["proj", "kiosk"]]),
    }),
  };
  const own = context({ deps: quietDeps({ dockerView: () => view }) });
  assert.equal((await own.containerOwnerFor("kiosk")("172.18.0.5")).kind, "docker-container");

  const down = context({
    deps: quietDeps({
      dockerView: () => ({ snapshot: async () => { throw new Error("docker is down"); } }),
      interfaces: () => ({ docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4" }] }),
    }),
  });
  const verdict = await down.containerOwnerFor("kiosk")("172.17.0.55");
  assert.equal(verdict.kind, "denied");
});

// ---- the ids the docker view is handed ------------------------------------

test("the docker view gets the ids installed.json lists and the ones mcp-addons.json configures", async () => {
  const home = freshDir("configured-home");
  const crowHome = join(home, ".crow");
  mkdirSync(crowHome, { recursive: true });
  const installedPath = join(crowHome, "installed.json");
  const addonsPath = join(crowHome, "mcp-addons.json");
  writeFileSync(installedPath, JSON.stringify(["installed-only"]));
  writeFileSync(addonsPath, JSON.stringify({ "linked-one": { command: "node", args: [] } }));

  const rec = viewRecorder();
  const ctx = context({
    crowHome,
    home,
    deps: quietDeps({ ...rec, identifyListener: async () => ({ kind: "denied" }) }),
  });
  await ctx.listenerOwnerFor("linked-one")("127.0.0.1", 8123);
  assert.equal(rec.opts.length, 1, "the view is built once");

  const ids = rec.opts[0].installedIds();
  assert.ok(ids instanceof Set, "the view gets a Set");
  assert.equal(ids.has("linked-one"), true, "an id only mcp-addons.json names is configured");
  assert.equal(ids.has("installed-only"), true, "an id only installed.json lists is configured");

  // Read fresh on each call: a new entry counts without a new view.
  writeFileSync(addonsPath, JSON.stringify({ "linked-one": { command: "node" }, "linked-two": { command: "node" } }));
  const later = rec.opts[0].installedIds();
  assert.equal(later.has("linked-two"), true);
  assert.equal(later.has("linked-one"), true);
});

test("mcp-addons.json keys that are not one slug never join the ids the view gets", async () => {
  const home = freshDir("slug-home");
  const crowHome = join(home, ".crow");
  mkdirSync(crowHome, { recursive: true });
  writeFileSync(join(crowHome, "installed.json"), JSON.stringify(["installed-only"]));
  // Written as text so `__proto__` stays an ordinary key of the parsed document.
  writeFileSync(
    join(crowHome, "mcp-addons.json"),
    '{"../x":{"command":"node"},"Upper":{"command":"node"},"":{"command":"node"},"a/b":{"command":"node"},"__proto__":{"command":"node"},"good-one":{"command":"node"}}',
  );

  const rec = viewRecorder();
  const ctx = context({
    crowHome,
    home,
    deps: quietDeps({ ...rec, identifyListener: async () => ({ kind: "denied" }) }),
  });
  await ctx.listenerOwnerFor("kiosk")("127.0.0.1", 8123);
  const ids = rec.opts[0].installedIds();

  for (const odd of ["../x", "Upper", "", "a/b", "__proto__"]) {
    assert.equal(ids.has(odd), false, "not one slug: " + JSON.stringify(odd));
  }
  assert.equal(ids.has("good-one"), true);
  assert.equal(ids.has("installed-only"), true);
  assert.equal(ids.size, 2, "only the installed id and the one slug-shaped key are in the set");
});

test("an invalid or array-shaped mcp-addons.json adds nothing and does not throw", async () => {
  for (const text of ['{"linked-one": ', '["linked-one"]', "null", '"linked-one"']) {
    const home = freshDir("broken-home");
    const crowHome = join(home, ".crow");
    mkdirSync(crowHome, { recursive: true });
    writeFileSync(join(crowHome, "installed.json"), JSON.stringify(["installed-only"]));
    writeFileSync(join(crowHome, "mcp-addons.json"), text);

    const rec = viewRecorder();
    const ctx = context({
      crowHome,
      home,
      deps: quietDeps({ ...rec, identifyListener: async () => ({ kind: "denied" }) }),
    });
    await ctx.listenerOwnerFor("kiosk")("127.0.0.1", 8123);
    const ids = rec.opts[0].installedIds();
    assert.equal(ids.has("installed-only"), true, "installed.json still counts: " + text);
    assert.equal(ids.has("linked-one"), false, "the broken document adds nothing: " + text);
    assert.equal(ids.size, 1, "the narrower set: " + text);
  }
});

test("only a local stdio entry counts; a text-to-speech id counts only through installed.json", async () => {
  const home = freshDir("entry-shape-home");
  const crowHome = join(home, ".crow");
  mkdirSync(crowHome, { recursive: true });
  writeFileSync(join(crowHome, "installed.json"), JSON.stringify(["installed-only"]));
  writeFileSync(join(crowHome, "mcp-addons.json"), JSON.stringify({
    "local-one": { command: "node", args: ["server/index.js"] },
    "no-command": { args: [] },
    "empty-command": { command: "" },
    "remote-one": { command: "node", transport: "satellite" },
    "array-entry": [],
    "piper": { command: "node" },
    "kokoro-tts": { command: "node" },
  }));
  const rec = viewRecorder();
  const ctx = context({
    crowHome,
    home,
    deps: quietDeps({ ...rec, identifyListener: async () => ({ kind: "denied" }) }),
  });
  await ctx.listenerOwnerFor("kiosk")("127.0.0.1", 8123);
  const ids = rec.opts[0].installedIds();
  assert.deepEqual([...ids].sort(), ["installed-only", "local-one"]);
});

test("through the real docker view: a checkout project of an add-on with only an mcp-addons.json entry is its own", async () => {
  const home = freshDir("real-view-home");
  const crowHome = join(home, ".crow");
  mkdirSync(crowHome, { recursive: true });
  const appRoot = appRootWith();
  mkdirSync(join(appRoot, "bundles", "linked-one"), { recursive: true });
  writeFileSync(join(crowHome, "installed.json"), JSON.stringify([]));
  writeFileSync(join(crowHome, "mcp-addons.json"), JSON.stringify({ "linked-one": { command: "node", args: [] } }));
  const inspected = [{
    Id: "c1",
    Name: "/linked-one-app",
    Config: { Labels: {
      "com.docker.compose.project": "linked-one",
      "com.docker.compose.project.working_dir": join(appRoot, "bundles", "linked-one"),
    } },
    NetworkSettings: { Networks: {}, Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8600" }] } },
  }];
  const run = async (args) => {
    if (args[0] === "ps") return "c1\n";
    if (args[0] === "network" && args[1] === "ls") return "";
    if (args[0] === "network") return "[]";
    if (args[0] === "inspect") return JSON.stringify(inspected);
    return "";
  };
  const seen = [];
  const ctx = context({
    crowHome,
    home,
    appRoot,
    deps: quietDeps({
      dockerView: (o) => createDockerView({ ...o, run, ttlMs: 0 }),
      identifyListener: async (addr, port, o) => { seen.push(o); return { kind: "denied" }; },
    }),
  });
  await ctx.listenerOwnerFor("linked-one")("127.0.0.1", 8600);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].addonId, "linked-one");
  assert.equal(seen[0].addonProjects.get("linked-one"), "linked-one", "the checkout project belongs to the configured add-on");

});

// ---- the three spawn kinds ------------------------------------------------

test("a built-in's wall gets the checkout's bundle folder and a data folder Crow creates", async () => {
  const id = "probe-builtin";
  const appRoot = appRootWith(id);
  const dataDir = freshDir("builtin-data");
  const rec = spawnRecorder();
  const ctx = context({ appRoot, dataDir, deps: quietDeps(rec) });

  const wall = await ctx.startAddonWall({ id, entry: { env: {} }, command: "node", args: [], env: {}, kind: "builtin" });
  assert.equal(wall.walled, true);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].installDir, join(appRoot, "bundles", id));
  assert.equal(rec.calls[0].dataSubdir, undefined);
  assert.equal(rec.calls[0].entry.command, "node", "the entry names the command the caller resolved");
  assert.equal(statSync(join(dataDir, id)).mode & 0o777, 0o700);
});

test("a project-service child gets its own services/<uuid> folder below the add-on's data folder", async () => {
  const id = "probe-service";
  const appRoot = appRootWith(id);
  const dataDir = freshDir("service-data");
  mkdirSync(join(dataDir, id), { recursive: true, mode: 0o755 });
  const rec = spawnRecorder();
  const ctx = context({ appRoot, dataDir, deps: quietDeps(rec) });
  const subdir = "services/0a1b2c3d-0000-4000-8000-00000000abcd";

  await ctx.startAddonWall({ id, entry: {}, command: "node", args: ["server/index.js"], env: {}, kind: "service", dataSubdir: subdir });
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].dataSubdir, subdir);
  assert.equal(rec.calls[0].installDir, undefined, "a service child runs the installed copy");
  assert.equal(statSync(join(dataDir, id, "services")).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, id, subdir)).mode & 0o777, 0o700);
});

test("a refusal keeps the add-on off: a missing data folder, an unreadable past-defaults table, a bad id", async () => {
  const dataDir = freshDir("refuse-data");
  const rec = spawnRecorder();

  // A service child of an add-on that has no data folder: the wall has nowhere
  // to put its writable folder, so the child stays off.
  const missing = context({ appRoot: appRootWith("probe-missing"), dataDir, deps: quietDeps(rec) });
  await assert.rejects(
    missing.startAddonWall({ id: "probe-missing", entry: {}, command: "node", args: [], env: {}, kind: "service", dataSubdir: "services/0a1b2c3d-0000-4000-8000-00000000abcd" }),
    (err) => err instanceof AddonWallRefused && /data folder is missing/.test(err.message),
  );

  // No past-defaults table: a legacy default would read as owner-entered.
  const noTable = freshDir("app-no-table");
  mkdirSync(join(noTable, "bundles", "probe-missing"), { recursive: true });
  const unreadable = context({ appRoot: noTable, dataDir, deps: quietDeps(rec) });
  await assert.rejects(
    unreadable.startAddonWall({ id: "probe-missing", entry: {}, command: "node", args: [], env: {}, kind: "builtin" }),
    (err) => err instanceof AddonWallRefused && /past-defaults/.test(err.message),
  );

  // A table that parses but carries no defaults map is as good as unreadable.
  const emptyTable = freshDir("app-empty-table");
  mkdirSync(join(emptyTable, "registry"), { recursive: true });
  writeFileSync(join(emptyTable, "registry", "addon-past-defaults.json"), JSON.stringify({ version: 1 }));
  const noDefaults = context({ appRoot: emptyTable, dataDir, deps: quietDeps(rec) });
  await assert.rejects(
    noDefaults.startAddonWall({ id: "probe-missing", entry: {}, command: "node", args: [], env: {}, kind: "builtin" }),
    (err) => err instanceof AddonWallRefused,
  );

  // A profile that cannot be derived refuses too (the id names folders, so it is a slug or nothing).
  const bad = context({ appRoot: appRootWith("probe-missing"), dataDir, deps: quietDeps(rec) });
  await assert.rejects(
    bad.startAddonWall({ id: "../probe-missing", entry: {}, command: "node", args: [], env: {}, kind: "addon" }),
    (err) => err instanceof AddonWallRefused,
  );

  assert.deepEqual(rec.calls, [], "a refused wall never reaches the spawn wrapper");
});

// ---- the host's own names and addresses ----------------------------------

test("selfTargets: the machine name, the tailnet name, the configured names, and every address", async () => {
  const ctx = context({
    gatewayEnv: {
      CROW_GATEWAY_URL: "https://gateway.example.ts.net/",
      CROW_PUBLIC_URL: "https://public.example.com",
    },
    deps: quietDeps({
      tailscaleStatus: async () => ({ Self: { DNSName: "Crow.Example.TS.net.", TailscaleIPs: ["100.64.20.5", "fd7a:115c:a1e0::7"] } }),
      interfaces: () => ({ lo: [{ address: "127.0.0.1" }], eth0: [{ address: "192.0.2.10" }] }),
    }),
  });

  const targets = await ctx.selfTargets();
  for (const name of [hostname().toLowerCase(), "crow.example.ts.net", "gateway.example.ts.net", "public.example.com"]) {
    assert.ok(targets.names.includes(name), "a name is missing: " + name);
  }
  for (const addr of ["100.64.20.5", "fd7a:115c:a1e0::7", "127.0.0.1", "192.0.2.10"]) {
    assert.ok(targets.addrs.includes(addr), "an address is missing: " + addr);
  }
  // A copy: a caller that edits its answer cannot change the cache.
  targets.names.push("added.example.com");
  assert.equal((await ctx.selfTargets()).names.includes("added.example.com"), false);
});

test("selfTargets: a failed tailscale read still gives the interface addresses", async () => {
  const ctx = context({
    deps: quietDeps({
      tailscaleStatus: async () => { throw new Error("no tailscale here"); },
      interfaces: () => ({ lo: [{ address: "127.0.0.1" }] }),
    }),
  });
  const targets = await ctx.selfTargets();
  assert.deepEqual(targets.names, [hostname().toLowerCase()]);
  assert.deepEqual(targets.addrs, ["127.0.0.1"]);
});

test("a service child's folder is never created through a planted symlink or from a path-shaped uuid", async () => {
  const id = "probe-service";
  const appRoot = appRootWith(id);
  const dataDir = freshDir("service-data");
  mkdirSync(join(dataDir, id), { recursive: true, mode: 0o700 });
  // The add-on owns <data>/<id>: it plants services -> another add-on's folder.
  const victim = freshDir("victim");
  symlinkSync(victim, join(dataDir, id, "services"));
  const rec = spawnRecorder();
  const ctx = context({ appRoot, dataDir, deps: quietDeps(rec) });

  await assert.rejects(
    ctx.startAddonWall({ id, entry: {}, command: "node", args: [], env: {}, kind: "service", dataSubdir: "services/0a1b2c3d-0000-4000-8000-00000000abcd" }),
    (err) => err instanceof AddonWallRefused,
  );
  assert.deepEqual(readdirSync(victim), [], "nothing was created where the symlink points");
  assert.equal(rec.calls.length, 0);

  // A uuid from crow.db that is shaped like a path is refused before any mkdir.
  for (const bad of ["services/../../escape", "services/0a1b2c3d/../x", "../x", "services/ABCDEFGH"]) {
    await assert.rejects(
      ctx.startAddonWall({ id, entry: {}, command: "node", args: [], env: {}, kind: "service", dataSubdir: bad }),
      (err) => err instanceof AddonWallRefused && /invalid data subfolder/.test(err.message),
      bad,
    );
  }
  assert.equal(existsSync(join(dataDir, "escape")), false);
  assert.equal(rec.calls.length, 0);
});

test("the services folder swapped for a symlink between the two steps is refused", async () => {
  const id = "probe-service";
  const appRoot = appRootWith(id);
  const dataDir = freshDir("service-swap");
  mkdirSync(join(dataDir, id), { recursive: true, mode: 0o700 });
  const victim = freshDir("swap-victim");
  const rec = spawnRecorder();
  const ctx = context({
    appRoot,
    dataDir,
    deps: quietDeps({
      ...rec,
      // Runs after `services` was created through its directory fd and before the
      // same name is opened again: the window a rename or a symlink aims at.
      afterServicesDir: (servicesPath) => {
        rmSync(servicesPath, { recursive: true, force: true });
        symlinkSync(victim, servicesPath);
      },
    }),
  });

  await assert.rejects(
    ctx.startAddonWall({ id, entry: {}, command: "node", args: [], env: {}, kind: "service", dataSubdir: "services/0a1b2c3d-0000-4000-8000-00000000abcd" }),
    (err) => err instanceof AddonWallRefused,
  );
  assert.deepEqual(readdirSync(victim), [], "nothing was created where the symlink points");
  assert.equal(rec.calls.length, 0);
});

test("an id that is not one slug is refused before any filesystem call", async () => {
  const dataDir = freshDir("bad-id-data");
  const rec = spawnRecorder();
  const ctx = context({ appRoot: appRootWith("probe-service"), dataDir, deps: quietDeps(rec) });
  for (const id of ["../probe-service", "Probe-Service", "probe/service", "", "probe service"]) {
    await assert.rejects(
      ctx.startAddonWall({ id, entry: {}, command: "node", args: [], env: {}, kind: "service", dataSubdir: "services/0a1b2c3d-0000-4000-8000-00000000abcd" }),
      (err) => err instanceof AddonWallRefused && /invalid add-on id/.test(err.message),
      JSON.stringify(id),
    );
    await assert.rejects(
      ctx.startAddonWall({ id, entry: {}, command: "node", args: [], env: {}, kind: "builtin" }),
      (err) => err instanceof AddonWallRefused && /invalid add-on id/.test(err.message),
      JSON.stringify(id),
    );
  }
  assert.deepEqual(readdirSync(dataDir), [], "nothing was created for an id that names no folder");
  assert.equal(rec.calls.length, 0);
});

test("with no docker view every interface but loopback and the default route counts as a bridge", async () => {
  const ipv4 = [
    "Iface\tDestination\tGateway\t\tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eno1\t00000000\t0102A8C0\t\t0003\t0\t0\t100\t00000000\t0\t0\t0",
    "mybr0\t0030AC0A\t00000000\t\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
  ].join("\n");
  const interfaces = () => ({
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
    eno1: [{ address: "10.20.30.5", netmask: "255.255.255.0", family: "IPv4" }],
    mybr0: [{ address: "172.30.0.1", netmask: "255.255.0.0", family: "IPv4" }],
  });
  const noDocker = () => ({ snapshot: async () => { throw new Error("docker is down"); } });

  const ctx = context({ deps: quietDeps({ dockerView: noDocker, interfaces, routes: () => ({ v4: ipv4, v6: "" }) }) });
  const owner = ctx.containerOwnerFor("kiosk");
  assert.equal((await owner("172.30.0.5")).kind, "denied", "a custom-named bridge is a bridge range");
  assert.equal((await owner("10.20.30.9")).kind, "not-container", "the default route's interface is not");
  assert.equal((await owner("127.0.0.5")).kind, "not-container", "loopback never is");

  // No route table at all: no default-route interface is known, so every
  // non-loopback address is refused unless a container of this project holds it.
  const blind = context({ deps: quietDeps({ dockerView: noDocker, interfaces, routes: () => { throw new Error("no route table"); } }) });
  assert.equal((await blind.containerOwnerFor("kiosk")("10.20.30.9")).kind, "denied");
  assert.equal((await blind.containerOwnerFor("kiosk")("127.0.0.5")).kind, "not-container");
});

test("a service child's folder is created when the data dir is reached through a symlink", async () => {
  const id = "probe-service";
  const appRoot = appRootWith(id);
  const realData = freshDir("service-data-real");
  mkdirSync(join(realData, id), { recursive: true, mode: 0o700 });
  const linkParent = freshDir("service-data-link");
  const dataDir = join(linkParent, "data");
  symlinkSync(realData, dataDir);
  const rec = spawnRecorder();
  const ctx = context({ appRoot, dataDir, deps: quietDeps(rec) });
  const subdir = "services/0a1b2c3d-0000-4000-8000-0000000000cc";
  await ctx.startAddonWall({ id, entry: {}, command: "node", args: [], kind: "service", dataSubdir: subdir });
  assert.equal(rec.calls.length, 1);
  assert.equal(statSync(join(realData, id, subdir)).isDirectory(), true);
});
