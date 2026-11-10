/**
 * `connectAddonServer` through the wall context (servers/gateway/proxy.js).
 *
 * A real child runs here (the hostile fixture, installed into a scratch Crow
 * home), but the wall itself is a seam: `_setProxyDepsForTest` replaces the
 * mode decision and the spawn wrapper, so no bwrap is needed. The cases are the
 * four the gateway can be in: walls off (nothing about the wall runs), a walled
 * mode whose wall is refused (nothing spawns), a wall that reports no usable
 * bwrap (`tier: "none"`, unwalled), and the env an unwalled add-on hands its
 * child.
 *
 * Scratch home under mkdtemp; the fixture is copied, never edited in place.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const FIXTURE = join(REPO, "tests", "fixtures", "addon-hostile");
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "crow-proxy-wall-")));
const ID = "addon-hostile";
const ENTRY = { command: "node", args: ["server/index.js"] };
/** The SDK merges these under the env it is given (client/stdio.js, posix list). */
const SDK_DEFAULT_ENV_KEYS = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

// A scratch instance, set before the gateway modules are imported: the proxy
// resolves the Crow home at call time, but nothing may ever see ~/.crow.
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
delete process.env.CROW_ADDON_WALLS;
delete process.env.CROW_ADDON_WALLS_DEFAULT;

cpSync(FIXTURE, join(HOME, "bundles", ID), { recursive: true });
writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: ID, type: "mcp-server", version: "1.0.0" }]));
writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({ [ID]: ENTRY }), { mode: 0o600 });

const proxy = await import("../servers/gateway/proxy.js");
const { addonStdioEnv, connectedServers, connectAddonServer, _setProxyDepsForTest } = proxy;
const { AddonWallRefused } = await import("../scripts/addon-sandbox/spawn.mjs");

/** Resolve once `check()` is true, or fail after `ms`. */
function waitFor(check, ms = 5000, what = "condition") {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = check(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for " + what));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Capture the console until `restore()` is called. */
function captureConsole() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const key of Object.keys(orig)) console[key] = (...args) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => Object.assign(console, orig) };
}

/** Run `fn` with the console captured; the collected lines are returned. */
async function withConsole(fn) {
  const capture = captureConsole();
  try {
    await fn();
  } finally {
    capture.restore();
  }
  return capture.lines;
}

/** Close the add-on's client and drop its entry. */
async function disconnect() {
  const entry = connectedServers.get(ID);
  try { await entry?.client?.close?.(); } catch { /* already gone */ }
  connectedServers.delete(ID);
}

afterEach(async () => {
  _setProxyDepsForTest(null);
  await disconnect();
});

after(() => rmSync(HOME, { recursive: true, force: true }));

// ---- walls off (the default) ---------------------------------------------

test("with the walls off the add-on connects unwalled, no wall is built, and its stderr is prefixed", async () => {
  const built = [];
  _setProxyDepsForTest({
    startAddonWall: async (o) => {
      built.push(o);
      throw new Error("the wall must not be built with the walls off");
    },
  });

  const capture = captureConsole();
  try {
    await connectAddonServer(ID, ENTRY);
    await waitFor(() => capture.lines.includes("[addon:addon-hostile] hostile-started"), 5000, "the prefixed stderr line");
  } finally {
    capture.restore();
  }
  const lines = capture.lines;

  const entry = connectedServers.get(ID);
  assert.equal(entry.status, "connected");
  assert.ok(entry.client, "the add-on's client");
  assert.equal(entry.wall.mode, "unwalled");
  assert.equal(entry.wall.tier, "none");
  assert.equal(entry.wall.reason, "walls are off on this computer");
  assert.equal(entry.wall.profile, null);
  assert.deepEqual(built, [], "nothing asked the wall context for a spawn");
  assert.ok(lines.includes("[addon:addon-hostile] hostile-started"));
});

// ---- a refused wall -------------------------------------------------------

test("a refused wall leaves the add-on off and starts nothing", async () => {
  const mark = join(HOME, "refused-wall-started");
  const built = [];
  _setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async (o) => {
      built.push(o);
      throw new AddonWallRefused("nope");
    },
  });

  const lines = await withConsole(async () => {
    await connectAddonServer(ID, { ...ENTRY, env: { HOSTILE_MARK: mark } });
  });

  const entry = connectedServers.get(ID);
  assert.equal(entry.status, "error");
  assert.equal(entry.error, "nope");
  assert.equal(entry.client, null);
  assert.equal(entry.isAddon, true);
  assert.deepEqual(entry.wall, { mode: "refused", reason: "nope" });
  assert.equal(built.length, 1, "the wall was attempted once");
  assert.equal(built[0].kind, "addon");
  assert.equal(built[0].id, ID);
  assert.equal(built[0].command, process.execPath, "the resolved launcher, not the entry's bare name");
  assert.deepEqual(built[0].args, ["server/index.js"]);
  assert.equal(existsSync(mark), false, "no child ran");
  assert.ok(!lines.some((l) => l.includes("hostile-started")), "no child ran");
});

// ---- a wall with no usable bwrap -----------------------------------------

test("a wall that reports no usable bwrap connects unwalled and says so", async () => {
  _setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async () => ({ walled: false, tier: "none", reason: "bubblewrap (bwrap) is not installed" }),
  });

  await withConsole(async () => { await connectAddonServer(ID, ENTRY); });

  const entry = connectedServers.get(ID);
  assert.equal(entry.status, "connected");
  assert.equal(entry.wall.mode, "unwalled");
  assert.equal(entry.wall.tier, "none");
  assert.equal(entry.wall.reason, "bubblewrap (bwrap) is not installed");
});

test("the nnp tier spawns with the env the wall built", async () => {
  _setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async () => ({
      walled: false,
      tier: "nnp",
      cmd: process.execPath,
      args: [join(HOME, "bundles", ID, "server", "index.js")],
      env: { ...process.env, MARK: "wall" },
      profile: { id: ID, network: { internet: false, hosts: [] } },
    }),
  });

  await withConsole(async () => { await connectAddonServer(ID, ENTRY); });

  const entry = connectedServers.get(ID);
  assert.equal(entry.status, "connected");
  assert.equal(entry.wall.tier, "nnp");
  const pid = entry.client?._transport?.pid;
  assert.ok(Number.isInteger(pid) && pid > 0, "the add-on's pid");
  const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
  assert.ok(env.includes("MARK=wall"), "the setpriv child runs with the wall's env: " + env.filter((p) => p.startsWith("MARK=")).join(" "));
});

test("a connected walled add-on keeps its relay beside the entry, not in its data", async () => {
  const relay = { socketPath: "/run/crow-net/relay.sock", close: () => {} };
  const mark = join(HOME, "walled-entry-started");
  _setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async () => ({
      walled: true,
      tier: "walled",
      cmd: process.execPath,
      args: [join(HOME, "bundles", ID, "server", "index.js")],
      env: { ...process.env, HOSTILE_MARK: mark },
      stdioExtra: [],
      relay,
      profile: { id: ID, network: { internet: false, hosts: [] } },
      cleanup: () => {},
    }),
  });

  await withConsole(async () => { await connectAddonServer(ID, ENTRY); });

  const entry = connectedServers.get(ID);
  assert.equal(entry.status, "connected");
  assert.equal(entry.wall.mode, "walled");
  assert.equal(entry.wall.tier, "walled");
  assert.equal(existsSync(mark), true, "the wall's command line is what ran");
  assert.equal("relay" in entry.wall, false);
  assert.equal(JSON.stringify(entry.wall).includes("relay"), false);
  const snapshot = JSON.parse(JSON.stringify({ ...entry, client: null }));
  assert.equal(JSON.stringify(snapshot).includes("socketPath"), false, "the relay is not part of an entry's JSON view");
  assert.equal("_wallRelay" in snapshot, false, "and it is not an enumerable key of the entry");
  const held = Object.getOwnPropertyDescriptor(entry, "_wallRelay");
  assert.ok(held, "the relay is kept for later tasks");
  assert.equal(held.enumerable, false);
  assert.equal(held.value, relay);
});

// ---- the child's environment ---------------------------------------------

test("an unwalled add-on's child env is addonStdioEnv plus the SDK's own defaults, nothing else", async () => {
  await withConsole(async () => { await connectAddonServer(ID, ENTRY); });

  const entry = connectedServers.get(ID);
  const pid = entry.client?._transport?.pid;
  assert.ok(Number.isInteger(pid) && pid > 0, "the add-on's pid");

  const actual = readFileSync(`/proc/${pid}/environ`, "utf8")
    .split("\0")
    .filter(Boolean)
    .map((pair) => pair.slice(0, pair.indexOf("=")))
    .sort();
  const expected = new Set(Object.keys(addonStdioEnv(ENTRY, process.env, ID)));
  for (const key of SDK_DEFAULT_ENV_KEYS) if (typeof process.env[key] === "string") expected.add(key);
  assert.deepEqual(actual, [...expected].sort());
  assert.ok(actual.includes("CROW_ADDON_HOST"), "the gateway-supervised marker");
});