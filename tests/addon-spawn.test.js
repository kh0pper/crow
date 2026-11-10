/**
 * `addonWallMode` and `wrapAddonSpawn` (scripts/addon-sandbox/spawn.mjs).
 *
 * Pure: the probe, the plan builder, the relay and the seccomp builder are test
 * seams, so no bwrap is needed. Two rules run through every case:
 *  - the mode is read from the gateway's env and `<CROW_HOME>/addon-walls.json`
 *    only, never from anything an add-on can write;
 *  - a wall that cannot be built keeps the add-on OFF. Nothing here returns an
 *    unwalled spawn after a walled attempt, and nothing a failed attempt opened
 *    outlives it.
 *
 * Scratch homes under mkdtemp; every real fd opened here is closed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, openSync, fstatSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { mintAddonDoorToken, validateAddonDoorToken } from "../servers/shared/addon-doors.js";
import { addonWallsPath, setWallMode } from "../servers/shared/addon-walls-file.js";
import { AddonWallRefused, addonWallMode, wrapAddonSpawn } from "../scripts/addon-sandbox/spawn.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-spawn-")));
after(() => rmSync(T, { recursive: true, force: true }));

/** The in-namespace entry the walled command runs first. */
const NETNS_ENTRY = fileURLToPath(new URL("../scripts/pi-bots/pi_netns_entry.mjs", import.meta.url));

let seq = 0;
const freshDir = (name) => {
  const dir = join(T, name + "-" + ++seq);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** What the wall hands bwrap when everything works. */
const OK_PROBE = { ok: true, pidns: true, bwrap: "/usr/bin/bwrap", setpriv: null, reason: null };
/** The probe's reason when there is no bwrap binary at all. */
const MISSING_BWRAP = "bubblewrap (bwrap) is not installed";

// ---- the mode decision ---------------------------------------------------

test("the kill switch wins over the per-host default", () => {
  const home = freshDir("kill-switch");
  const r = addonWallMode({ id: "kiosk", crowHome: home, gatewayEnv: { CROW_ADDON_WALLS: "off", CROW_ADDON_WALLS_DEFAULT: "walled" } });
  assert.equal(r.mode, "unwalled");
  assert.equal(r.source, "kill-switch");
  assert.equal(r.reason, "walls switched off by the operator (CROW_ADDON_WALLS=off)");
});

test("with no per-host default the walls are off", () => {
  const home = freshDir("default-off");
  const r = addonWallMode({ id: "kiosk", crowHome: home, gatewayEnv: {} });
  assert.equal(r.mode, "unwalled");
  assert.equal(r.source, "default");
  assert.equal(r.reason, "walls are off on this computer");
  // Anything but exactly "walled" reads as off, so a typo never walls a host by
  // accident and never unwalls one it should not.
  for (const value of ["off", "WALLED", " walled", "yes"]) {
    assert.equal(addonWallMode({ id: "kiosk", crowHome: home, gatewayEnv: { CROW_ADDON_WALLS_DEFAULT: value } }).source, "default");
  }
});

test("the owner's choice is honoured only under a walled default", () => {
  const home = freshDir("owner");
  assert.equal(setWallMode(home, "kiosk", "unwalled"), true);
  const r = addonWallMode({ id: "kiosk", crowHome: home, gatewayEnv: { CROW_ADDON_WALLS_DEFAULT: "walled" } });
  assert.equal(r.mode, "unwalled");
  assert.equal(r.source, "owner");
  assert.equal(r.reason, "your choice");
  // Another id's choice says nothing about this one.
  assert.equal(addonWallMode({ id: "studio", crowHome: home, gatewayEnv: { CROW_ADDON_WALLS_DEFAULT: "walled" } }).mode, "walled");
  // And the kill switch still wins over the owner's choice.
  assert.equal(addonWallMode({ id: "kiosk", crowHome: home, gatewayEnv: { CROW_ADDON_WALLS: "off", CROW_ADDON_WALLS_DEFAULT: "walled" } }).source, "kill-switch");
});

test("a walled default with no override walls the add-on", () => {
  const home = freshDir("walled");
  const r = addonWallMode({ id: "kiosk", crowHome: home, gatewayEnv: { CROW_ADDON_WALLS_DEFAULT: "walled" } });
  assert.equal(r.mode, "walled");
  assert.equal(r.source, "walled");
  assert.equal(setWallMode(home, "kiosk", "walled"), true);
  assert.equal(addonWallMode({ id: "kiosk", crowHome: home, gatewayEnv: { CROW_ADDON_WALLS_DEFAULT: "walled" } }).mode, "walled");
});

test("a file the add-on writes cannot liberate it, and the gateway env is the only env read", () => {
  const crowHome = freshDir("self-liberation");
  const data = join(crowHome, "data", "hostile");
  mkdirSync(data, { recursive: true });
  // What an add-on can write: its own data folder, and a crow.db-shaped decoy
  // beside it. Neither of them is the wall file.
  writeFileSync(join(data, "addon-walls.json"), JSON.stringify({ modes: { hostile: "unwalled" } }));
  writeFileSync(join(crowHome, "data", "addon-walls.json"), JSON.stringify({ modes: { hostile: "unwalled" } }));
  writeFileSync(join(crowHome, "crow.db"), JSON.stringify({ dashboard_settings: { addon_walls_hostile: "unwalled" } }));

  // Only the mode decision's two inputs matter: the gateway env it is handed
  // (which does not carry the kill switch) and the one wall file (which has no
  // choice in it). The planted copies change nothing.
  const prev = process.env.CROW_ADDON_WALLS;
  process.env.CROW_ADDON_WALLS = "off";
  try {
    const r = addonWallMode({ id: "hostile", crowHome, gatewayEnv: { CROW_ADDON_WALLS_DEFAULT: "walled" } });
    assert.equal(r.mode, "walled");
    assert.equal(r.source, "walled");
  } finally {
    if (prev === undefined) delete process.env.CROW_ADDON_WALLS;
    else process.env.CROW_ADDON_WALLS = prev;
  }

  // The one wall file is the owner's: a choice recorded there does count.
  assert.equal(setWallMode(crowHome, "hostile", "unwalled"), true);
  const r = addonWallMode({ id: "hostile", crowHome, gatewayEnv: { CROW_ADDON_WALLS_DEFAULT: "walled" } });
  assert.equal(r.mode, "unwalled");
  assert.equal(r.source, "owner");
});

test("a corrupt wall file with a walled default still walls", () => {
  const home = freshDir("corrupt");
  writeFileSync(addonWallsPath(home), "{not json");
  const r = addonWallMode({ id: "kiosk", crowHome: home, gatewayEnv: { CROW_ADDON_WALLS_DEFAULT: "walled" } });
  assert.equal(r.mode, "walled");
  assert.equal(r.source, "walled");
});

// ---- the walled spawn ----------------------------------------------------

test("no bwrap: the walled tier is refused and the child gets setpriv, or nothing", async () => {
  const base = { id: "kiosk", command: "/usr/bin/node", args: ["server/index.js"], env: { KEEP: "1" }, profile: {}, crowHome: freshDir("nnp") };
  const nnp = await wrapAddonSpawn({ ...base, deps: { probe: () => ({ ok: false, setpriv: "/usr/bin/setpriv", reason: MISSING_BWRAP }) } });
  assert.equal(nnp.walled, false);
  assert.equal(nnp.tier, "nnp");
  assert.equal(nnp.cmd, "/usr/bin/setpriv");
  assert.deepEqual(nnp.args, ["--no-new-privs", "/usr/bin/node", "server/index.js"]);
  assert.equal(nnp.reason, MISSING_BWRAP);
  assert.equal(typeof nnp.env, "object", "the nnp tier carries the env the wall built");

  const none = await wrapAddonSpawn({ ...base, deps: { probe: () => ({ ok: false, setpriv: null, reason: MISSING_BWRAP }) } });
  assert.equal(none.walled, false);
  assert.equal(none.tier, "none");
  assert.equal(none.reason, MISSING_BWRAP);
});

test("a bwrap that is installed but cannot start a sandbox is a refusal, never a weaker tier", async () => {
  const base = { id: "kiosk", command: "/usr/bin/node", args: [], profile: {}, crowHome: freshDir("blocked") };
  for (const probe of [
    { ok: false, setpriv: "/usr/bin/setpriv", reason: "bwrap cannot create a user namespace here (--unshare-user): exit 1" },
    { ok: false, setpriv: null, reason: "bwrap cannot create a user namespace here (--unshare-user): false" },
    { ok: false, setpriv: "/usr/bin/setpriv", reason: null },
  ]) {
    await assert.rejects(
      wrapAddonSpawn({ ...base, deps: { probe: () => probe } }),
      (err) => err instanceof AddonWallRefused && /bwrap is installed but cannot start a sandbox here/.test(err.message),
      JSON.stringify(probe),
    );
  }
});

test("bwrap without a PID namespace is a refusal, before anything is built", async () => {
  let planCalls = 0;
  await assert.rejects(
    wrapAddonSpawn({
      id: "kiosk",
      command: "/usr/bin/node",
      args: [],
      env: {},
      profile: {},
      crowHome: freshDir("pidns"),
      deps: {
        probe: () => ({ ok: true, pidns: false, bwrap: "/usr/bin/bwrap" }),
        buildPlan: () => { planCalls += 1; return { args: [], env: {}, unsetEnv: [], fds: [], net: { sock: null } }; },
      },
    }),
    (err) => err instanceof AddonWallRefused && /PID namespace/.test(err.message),
  );
  assert.equal(planCalls, 0, "a refusal before the plan never builds one");
});

test("a failed wall keeps the add-on off: no relay dir, no live token, no unwalled result", async () => {
  const tmp = freshDir("fail-closed");
  const netProfile = { network: { internet: true, hosts: [] }, doors: ["kiosk"] };

  // A plan that throws, after the relay dir and the door token exist.
  let minted = null;
  await assert.rejects(
    wrapAddonSpawn({
      id: "kiosk",
      command: "/usr/bin/node",
      args: [],
      env: {},
      profile: netProfile,
      crowHome: freshDir("fail-closed-home"),
      deps: {
        probe: () => OK_PROBE,
        tmpdir: () => tmp,
        mintToken: (id) => { minted = mintAddonDoorToken(id); return minted; },
        buildPlan: () => { throw new Error("boom"); },
      },
    }),
    AddonWallRefused,
  );
  assert.ok(minted, "the door token was minted before the plan ran");
  assert.equal(validateAddonDoorToken(minted, "kiosk", "POST", "/api/kiosk/internal/announce"), false, "the token is gone");
  assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("crow-addon-net-")), [], "the relay dir is gone");

  // A relay that throws, with a plan that succeeded.
  let minted2 = null;
  const plan = {
    args: ["--tmpfs", "/"],
    env: { HOME: "/home/alex" },
    unsetEnv: [],
    fds: [],
    net: { sock: "/run/crow-net/relay.sock", ports: [3001], proxyPort: 39080 },
    refused: [],
  };
  await assert.rejects(
    wrapAddonSpawn({
      id: "kiosk",
      command: "/usr/bin/node",
      args: [],
      env: {},
      profile: { network: { internet: true, hosts: [{ host: "localhost", port: 3001, scheme: "http", source: "owner" }] }, doors: ["kiosk"] },
      crowHome: freshDir("fail-closed-home-2"),
      deps: {
        probe: () => OK_PROBE,
        tmpdir: () => tmp,
        seccompSupported: () => false,
        mintToken: (id) => { minted2 = mintAddonDoorToken(id); return minted2; },
        buildPlan: () => plan,
        createRelay: () => { throw new Error("relay down"); },
      },
    }),
    AddonWallRefused,
  );
  assert.ok(minted2);
  assert.equal(validateAddonDoorToken(minted2, "kiosk", "POST", "/api/kiosk/internal/announce"), false);
  assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("crow-addon-net-")), []);
});

test("a walled spawn: the command line, the env, the fd layout and one cleanup", async () => {
  const dataDir = freshDir("walled-data");
  const scratch = join(dataDir, "payload.bin");
  writeFileSync(scratch, "payload");
  const dataFd = openSync(scratch, "r");

  const plan = {
    args: ["--tmpfs", "/", "--bind-fd", "5", "/data"],
    env: { HOME: "/home/alex", TMPDIR: "/tmp" },
    unsetEnv: ["CROW_DB_PATH"],
    fds: [{ fd: dataFd, childFd: 5, role: "data" }],
    net: { sock: "/run/crow-net/relay.sock", ports: [3001, 8000], proxyPort: 39080 },
    refused: [],
  };
  const profile = {
    network: {
      internet: true,
      hosts: [
        { host: "localhost", port: 8000, scheme: "http", source: "default-own-service" },
        { host: "100.64.20.7", port: 8004, scheme: "http", source: "owner" },
        { host: "media.example.ts.net", port: 8446, scheme: "https", source: "owner" },
      ],
    },
    doors: ["kiosk"],
  };
  let relayOpts = null;
  let relayCloses = 0;
  const tmp = freshDir("walled-tmp");

  const wall = await wrapAddonSpawn({
    id: "kiosk",
    command: "/usr/bin/node",
    args: ["server/index.js"],
    // The add-on's own env (an entry env could hold any of these); the gateway's
    // own env goes in as baseEnv and is read only through the wall's allowlist.
    ownEnv: {
      KEEP: "1",
      CROW_DB_PATH: "/home/alex/.crow/data/crow.db",
      HTTP_PROXY: "http://127.0.0.1:9",
      CROW_ADDON_DOOR_TOKEN_FILE: "/tmp/spoofed-token",
    },
    baseEnv: { PATH: "/usr/bin", CROW_LOCAL_MCP_TOKEN: "fake-local-token-0003" },
    profile,
    entry: { command: "/usr/bin/node" },
    crowHome: freshDir("walled-home"),
    dataDir,
    appRoot: "/home/alex/crow",
    home: "/home/alex",
    nodeBin: "/home/alex/.nvm/versions/node/v24.0.0/bin/node",
    gatewayPort: 3001,
    selfTargets: { names: [], addrs: [] },
    listenerOwner: () => ({ kind: "not-container" }),
    containerOwner: () => ({ kind: "not-container" }),
    deps: {
      probe: () => OK_PROBE,
      tmpdir: () => tmp,
      buildPlan: () => plan,
      seccompSupported: () => true,
      buildSeccompProgram: () => Buffer.from("filter"),
      createRelay: (opts) => {
        relayOpts = opts;
        return { dir: opts.dir, socketPath: opts.dir + "/relay.sock", close: () => { relayCloses += 1; return Promise.resolve(); } };
      },
    },
  });

  assert.equal(wall.walled, true);
  assert.equal(wall.tier, "walled");
  assert.equal(wall.cmd, "/usr/bin/bwrap");

  assert.deepEqual(wall.args, [
    ...plan.args,
    "--seccomp", "3",
    "--info-fd", "4",
    "--",
    "/home/alex/.nvm/versions/node/v24.0.0/bin/node",
    NETNS_ENTRY,
    "--sock", "/run/crow-net/relay.sock",
    "--ports", "3001,8000",
    "--proxy-port", "39080",
    "--fds", "0,1,2",
    "--",
    "/usr/bin/node", "server/index.js",
  ]);
  assert.ok(NETNS_ENTRY.endsWith("scripts/pi-bots/pi_netns_entry.mjs"));

  // The relay's policy, as the wall hands it over.
  assert.equal(relayOpts.botId, "addon:kiosk");
  assert.equal(relayOpts.gatewayPort, 3001);
  assert.deepEqual(relayOpts.egressPorts, [443]);
  assert.deepEqual(relayOpts.addon.loopback, [{ port: 8000, source: "default" }]);
  assert.deepEqual(relayOpts.addon.plainHttpHosts, [{ host: "100.64.20.7", port: 8004 }]);
  assert.deepEqual(relayOpts.addon.hosts, [{ host: "media.example.ts.net", port: 8446 }]);
  assert.equal(relayOpts.addon.internet, true);
  assert.equal(relayOpts.addon.isDoor("/api/kiosk/internal/announce", "POST"), true);
  assert.equal(relayOpts.addon.isDoor("/llm/v1/models", "GET"), false);

  // The env: no gateway database, no inherited proxy, no add-on-supplied token
  // path, and the plan's own values on top.
  assert.equal("CROW_DB_PATH" in wall.env, false);
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) assert.equal(name in wall.env, false);
  assert.equal(wall.env.CROW_ADDON_DOOR_TOKEN_FILE, "/run/crow-addon/door-token");
  assert.equal(wall.env.HOME, "/home/alex");
  assert.equal(wall.env.TMPDIR, "/tmp");
  assert.equal(wall.env.KEEP, "1");
  assert.equal(wall.env.PATH, "/usr/bin", "an allowlisted gateway key reaches it");
  assert.equal("CROW_LOCAL_MCP_TOKEN" in wall.env, false, "a gateway secret never does");

  // The fds: seccomp at 3, the info pipe at 4, the plan's bind fd at 5.
  const seccompEntry = wall.stdioExtra.find((e) => e.childFd === 3);
  assert.equal(typeof seccompEntry.fd, "number");
  assert.equal(seccompEntry.role, "seccomp");
  const infoEntry = wall.stdioExtra.find((e) => e.childFd === 4);
  assert.equal(infoEntry.pipe, "read");
  assert.equal(infoEntry.role, "info");
  const dataEntry = wall.stdioExtra.find((e) => e.childFd === 5);
  assert.equal(dataEntry.fd, dataFd);
  assert.equal(dataEntry.role, "data");

  await wall.cleanup();
  await wall.cleanup(); // idempotent
  assert.equal(relayCloses, 1);
  assert.equal(dataEntry.fd, null);
  assert.equal(seccompEntry.fd, null);
  assert.equal(readdirSync(tmp).filter((n) => n.startsWith("crow-addon-net-") || n.startsWith("crow-addon-seccomp-")).length, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(relayCloses, 1, "a second cleanup closes nothing again");

  // A second spawn: the door token reaches bwrap as bind DATA over a pipe.
  const doorFd = openSync(scratch, "r");
  const doorPlan = {
    args: ["--ro-bind-data", "6", "/run/crow-addon/door-token"],
    env: { HOME: "/home/alex" },
    unsetEnv: [],
    fds: [
      { fd: doorFd, childFd: 5, role: "data" },
      { fd: -1, childFd: 6, role: "door-token" },
    ],
    net: { sock: null, ports: [], proxyPort: null },
    refused: [],
  };
  const doorWall = await wrapAddonSpawn({
    id: "kiosk",
    command: "/usr/bin/node",
    args: ["server/index.js"],
    env: {},
    profile: { network: { internet: false, hosts: [] }, doors: ["kiosk"] },
    crowHome: freshDir("door-home"),
    dataDir,
    home: "/home/alex",
    nodeBin: "/usr/bin/node",
    gatewayPort: 3001,
    deps: {
      probe: () => OK_PROBE,
      tmpdir: () => tmp,
      buildPlan: () => doorPlan,
      seccompSupported: () => true,
      buildSeccompProgram: () => Buffer.from("filter"),
    },
  });
  const tokenEntry = doorWall.stdioExtra.find((e) => e.childFd === 6);
  assert.equal(tokenEntry.pipe, "write");
  assert.equal(tokenEntry.role, "door-token");
  assert.match(tokenEntry.data, /^[0-9a-f]{64}$/);
  assert.equal(validateAddonDoorToken(tokenEntry.data, "kiosk", "POST", "/api/kiosk/internal/announce"), true);
  assert.equal(doorWall.env.CROW_ADDON_DOOR_TOKEN_FILE, "/run/crow-addon/door-token");
  // The network-none line: no --sock/--ports/--proxy-port, and still the fds.
  assert.deepEqual(doorWall.args.slice(doorPlan.args.length), [
    "--seccomp", "3", "--info-fd", "4", "--",
    "/usr/bin/node", NETNS_ENTRY, "--fds", "0,1,2", "--", "/usr/bin/node", "server/index.js",
  ]);
  await doorWall.cleanup();
  assert.equal(validateAddonDoorToken(tokenEntry.data, "kiosk", "POST", "/api/kiosk/internal/announce"), false);
});

test("network none: no relay dir, no relay, and no proxy arguments", async () => {
  const tmp = freshDir("net-none-tmp");
  let relayCalls = 0;
  const plan = { args: ["--tmpfs", "/"], env: {}, unsetEnv: [], fds: [], net: { sock: null, ports: [], proxyPort: null }, refused: [] };
  const wall = await wrapAddonSpawn({
    id: "quiet",
    command: "/usr/bin/node",
    args: ["server/index.js"],
    env: {},
    profile: { network: { internet: false, hosts: [] }, doors: [] },
    crowHome: freshDir("net-none-home"),
    dataDir: freshDir("net-none-data"),
    home: "/home/alex",
    nodeBin: "/usr/bin/node",
    gatewayPort: 3001,
    deps: {
      probe: () => OK_PROBE,
      tmpdir: () => tmp,
      buildPlan: () => plan,
      seccompSupported: () => false,
      createRelay: () => { relayCalls += 1; return { close: () => Promise.resolve() }; },
    },
  });
  assert.equal(relayCalls, 0);
  assert.equal(wall.relay, null);
  assert.equal(readdirSync(tmp).filter((n) => n.startsWith("crow-addon-net-")).length, 0);
  const inner = wall.args.slice(wall.args.indexOf("--") + 1);
  assert.equal(inner.includes("--sock"), false);
  assert.equal(inner.includes("--ports"), false);
  assert.equal(inner.includes("--proxy-port"), false);
  assert.deepEqual(inner, [
    "/usr/bin/node", NETNS_ENTRY, "--fds", "0,1,2", "--", "/usr/bin/node", "server/index.js",
  ]);
  await wall.cleanup();
});

test("no seccomp table: the tier says so and child fd 3 is never used", async () => {
  const plan = { args: ["--tmpfs", "/"], env: {}, unsetEnv: [], fds: [], net: { sock: null, ports: [], proxyPort: null }, refused: [] };
  const wall = await wrapAddonSpawn({
    id: "quiet",
    command: "/usr/bin/node",
    args: [],
    env: {},
    profile: { network: { internet: false, hosts: [] }, doors: [] },
    crowHome: freshDir("noseccomp-home"),
    dataDir: freshDir("noseccomp-data"),
    home: "/home/alex",
    nodeBin: "/usr/bin/node",
    gatewayPort: 3001,
    deps: {
      probe: () => OK_PROBE,
      tmpdir: () => freshDir("noseccomp-tmp"),
      buildPlan: () => plan,
      seccompSupported: () => false,
    },
  });
  assert.equal(wall.tier, "walled-noseccomp");
  assert.equal(wall.args.includes("--seccomp"), false);
  assert.equal(wall.stdioExtra.some((e) => e.childFd === 3), false);
  assert.equal(wall.args.includes("--info-fd"), true);
  await wall.cleanup();
});

test("a plan fd layout the wall cannot pass is a refusal that closes every plan fd", async () => {
  const dir = freshDir("fd-layout");
  const file = join(dir, "payload.bin");
  writeFileSync(file, "payload");
  const closed = (fd, what) => assert.throws(
    () => fstatSync(fd),
    (err) => err && err.code === "EBADF",
    what + ": the fd is closed",
  );

  const cases = [
    { what: "child fd 3 (bwrap's seccomp slot)", spec: (fd) => ({ fd, childFd: 3, role: "data" }) },
    { what: "child fd 4 (bwrap's info slot)", spec: (fd) => ({ fd, childFd: 4, role: "data" }) },
    { what: "a child fd that is not a whole number", spec: (fd) => ({ fd, childFd: "5", role: "data" }) },
    { what: "a door token entry with no token minted", spec: (fd) => ({ fd, childFd: 6, role: "door-token" }) },
  ];

  for (const c of cases) {
    const keep = openSync(file, "r");
    const refused = openSync(file, "r");
    const plan = {
      args: ["--tmpfs", "/"],
      env: {},
      unsetEnv: [],
      fds: [{ fd: keep, childFd: 5, role: "data" }, c.spec(refused)],
      net: { sock: null, ports: [], proxyPort: null },
      refused: [],
    };
    await assert.rejects(
      wrapAddonSpawn({
        id: "quiet",
        command: "/usr/bin/node",
        args: [],
        profile: { network: { internet: false, hosts: [] }, doors: [] },
        crowHome: freshDir("fd-layout-home"),
        dataDir: dir,
        home: "/home/alex",
        nodeBin: "/usr/bin/node",
        gatewayPort: 3001,
        deps: {
          probe: () => OK_PROBE,
          tmpdir: () => freshDir("fd-layout-tmp"),
          buildPlan: () => plan,
          seccompSupported: () => false,
        },
      }),
      (err) => err instanceof AddonWallRefused,
      c.what,
    );
    closed(keep, c.what + ": the fd before it");
    closed(refused, c.what);
  }
});