/**
 * The gateway-side rules of the walls rollout (Tasks 8-9): the refusal of a
 * changed installed copy, the media add-on's local TTS ports, the prepare run's
 * place in front of the first real start, and the two card reasons that come
 * with them.
 *
 * Scratch dirs under mkdtemp; docker, tailscale, the interface table and the
 * spawn wrapper are stubs, and the gateway's prepare-run seam is a stub too, so
 * nothing here runs bwrap, npm or uv; the one child that starts is a tiny
 * fixture MCP server.
 */
import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-rollout-gateway-")));
const HOME = join(T, "crow-home");
const DATA = join(HOME, "data");
mkdirSync(DATA, { recursive: true });
// The gateway modules read this scratch instance, never ~/.crow.
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_ADDON_WALLS;
delete process.env.CROW_ADDON_WALLS_DEFAULT;
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: DATA }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
});

const { AddonWallRefused, wrapAddonSpawn } = await import("../scripts/addon-sandbox/spawn.mjs");
const { createWallContext, withGatewayTtsHosts } = await import("../scripts/addon-sandbox/gateway-wall.mjs");
const failures = await import("../scripts/addon-sandbox/failures.mjs");
const proxy = await import("../servers/gateway/proxy.js");

after(() => rmSync(T, { recursive: true, force: true }));

let seq = 0;
const freshDir = (name) => {
  const dir = join(T, name + "-" + ++seq);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Write a JSON file, making its folder first. */
function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** A checkout `profileFor` can read: the past-defaults table, plus the bundles asked for. */
function appRootWith(bundles) {
  const root = freshDir("app");
  writeJson(join(root, "registry", "addon-past-defaults.json"), { version: 1, defaults: {} });
  for (const [id, manifest] of Object.entries(bundles)) {
    writeJson(join(root, "bundles", id, "manifest.json"), { id, name: id, type: "mcp-server", version: "1.0.0", server: { command: "node", args: [] }, ...manifest });
  }
  return root;
}

/** A spawn wrapper that records what it was handed. */
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

/** The empty docker snapshot a spawn sees when nothing is running. */
const EMPTY_VIEW = { snapshot: async () => ({ publishes: [], containers: [], subnets: [], addonProjects: new Map() }) };

/** A context over one scratch layout; every out-of-process answer is a stub. */
function context({ appRoot, crowHome = join(freshDir("home"), ".crow"), deps = {} } = {}) {
  const home = freshDir("operator-home");
  return createWallContext({
    crowHome,
    appRoot,
    dataDir: join(crowHome, "data"),
    home,
    nodeBin: process.execPath,
    gatewayPort: 3001,
    gatewayEnv: {},
    deps: {
      dockerView: () => EMPTY_VIEW,
      tailscaleStatus: async () => null,
      interfaces: () => ({}),
      ...deps,
    },
  });
}

// ---- review focus 7: the installed copy changed ---------------------------

test("an installed manifest whose sandbox block differs refuses the wall as installed-changed", async () => {
  const id = "quiet";
  const appRoot = appRootWith({ [id]: { sandbox: { network: "internet" } } });
  const crowHome = freshDir("changed-home");
  // The installed copy is the one unwalled code could edit.
  writeJson(join(crowHome, "bundles", id, "manifest.json"), {
    id, name: id, type: "mcp-server", version: "1.0.0",
    server: { command: "node", args: [] },
    sandbox: { network: { hosts: ["env:X"] } },
  });
  const rec = spawnRecorder();
  const ctx = context({ appRoot, crowHome, deps: rec });

  await assert.rejects(
    ctx.startAddonWall({ id, entry: {}, command: "node", args: [], kind: "addon" }),
    (err) => err instanceof AddonWallRefused && err.code === "installed-changed",
  );
  assert.equal(rec.calls.length, 0, "the changed copy never reaches the spawn wrapper");

  assert.equal(failures.wallFailureReason({ refused: "installed-changed" }), failures.INSTALLED_CHANGED_REASON);
  assert.equal(failures.INSTALLED_CHANGED_REASON, "its installed files changed; reinstall it to wall it");
});

// ---- media's local TTS ports --------------------------------------------

const KOKORO_COMPOSE = [
  "services:",
  "  kokoro:",
  "    image: example/kokoro",
  "    ports:",
  '      - "127.0.0.1:8880:8880"',
  "",
].join("\n");

/** A checkout with the media bundle and one TTS bundle beside it. */
function ttsAppRoot() {
  const root = appRootWith({
    media: { name: "Media", sandbox: { network: "internet" } },
    "kokoro-tts": { name: "Kokoro TTS", docker: { composefile: "docker-compose.yml" } },
  });
  writeFileSync(join(root, "bundles", "kokoro-tts", "docker-compose.yml"), KOKORO_COMPOSE);
  return root;
}

/** A Crow home whose installed.json lists the ids given. */
function installedHome(ids) {
  const crowHome = freshDir("tts-home");
  writeJson(join(crowHome, "installed.json"), Object.fromEntries(ids.map((id) => [id, {}])));
  return crowHome;
}

/** A docker view whose snapshot maps compose projects to add-on ids. */
const projectsView = (pairs) => ({
  snapshot: async () => ({ publishes: [], containers: [], subnets: [], addonProjects: new Map(pairs) }),
});

test("media reaches the TTS port its compose publishes, as the gateway's own exception", async () => {
  const appRoot = ttsAppRoot();
  const crowHome = installedHome(["media", "kokoro-tts"]);
  const rec = spawnRecorder();
  const ctx = context({ appRoot, crowHome, deps: { ...rec, dockerView: () => projectsView([["crow-kokoro", "kokoro-tts"]]) } });

  await ctx.startAddonWall({ id: "media", entry: {}, command: "node", args: ["server/index.js"], kind: "addon" });
  assert.equal(rec.calls.length, 1);
  const profile = rec.calls[0].profile;

  const host = profile.network.hosts.find((h) => h.source === "gateway-tts");
  assert.deepEqual(host, {
    host: "127.0.0.1",
    port: 8880,
    scheme: "http",
    from: "tts:kokoro-tts",
    source: "gateway-tts",
    ownerProject: "crow-kokoro",
  });

  const part = profile.labelParts.find((p) => p.kind === "local-host" && p.port === 8880);
  assert.deepEqual(part, { kind: "local-host", label: "Kokoro TTS", host: "127.0.0.1", port: 8880 });
  assert.equal(profile.label.en.length, profile.labelParts.length, "the phrases stay in step with the parts");
  assert.equal(profile.label.es.length, profile.labelParts.length);
  assert.ok(profile.label.en.includes("reach Kokoro TTS on this computer"), profile.label.en.join(" | "));
  assert.ok(profile.label.es.includes("acceder a Kokoro TTS en este equipo"), profile.label.es.join(" | "));
});

test("no installed TTS add-on, an ambiguous project or no docker snapshot adds no TTS host", async () => {
  const appRoot = ttsAppRoot();

  const notInstalled = spawnRecorder();
  await context({
    appRoot,
    crowHome: installedHome(["media"]),
    deps: { ...notInstalled, dockerView: () => projectsView([["crow-kokoro", "kokoro-tts"]]) },
  }).startAddonWall({ id: "media", entry: {}, command: "node", args: [], kind: "addon" });
  assert.equal(notInstalled.calls[0].profile.network.hosts.some((h) => h.source === "gateway-tts"), false);

  const ambiguous = spawnRecorder();
  await context({
    appRoot,
    crowHome: installedHome(["media", "kokoro-tts"]),
    deps: {
      ...ambiguous,
      dockerView: () => projectsView([["crow-kokoro", "kokoro-tts"], ["crow-kokoro-2", "kokoro-tts"]]),
    },
  }).startAddonWall({ id: "media", entry: {}, command: "node", args: [], kind: "addon" });
  assert.equal(ambiguous.calls[0].profile.network.hosts.some((h) => h.source === "gateway-tts"), false);

  const noView = spawnRecorder();
  await context({
    appRoot,
    crowHome: installedHome(["media", "kokoro-tts"]),
    deps: { ...noView, dockerView: () => ({ snapshot: async () => { throw new Error("docker is down"); } }) },
  }).startAddonWall({ id: "media", entry: {}, command: "node", args: [], kind: "addon" });
  assert.equal(noView.calls[0].profile.network.hosts.some((h) => h.source === "gateway-tts"), false);
});

test("only this exception's add-ons get those ports, and a stale gateway-tts host is dropped first", async () => {
  const appRoot = ttsAppRoot();
  const crowHome = installedHome(["media", "kokoro-tts", "quiet"]);
  writeJson(join(appRoot, "bundles", "quiet", "manifest.json"), {
    id: "quiet", name: "quiet", type: "mcp-server", version: "1.0.0",
    server: { command: "node", args: [] },
    sandbox: { network: "internet" },
  });
  const rec = spawnRecorder();
  const ctx = context({ appRoot, crowHome, deps: { ...rec, dockerView: () => projectsView([["crow-kokoro", "kokoro-tts"]]) } });

  await ctx.startAddonWall({ id: "quiet", entry: {}, command: "node", args: [], kind: "addon" });
  assert.equal(rec.calls[0].profile.network.hosts.some((h) => h.source === "gateway-tts"), false, "another add-on id never gets one");

  const profile = {
    network: { internet: true, hosts: [{ host: "127.0.0.1", port: 9999, scheme: "http", source: "gateway-tts", ownerProject: "whoever" }] },
    doors: [],
    labelParts: [{ kind: "internet" }, { kind: "own-folder" }],
    label: { en: ["use the internet", "keep files in its own folder"], es: ["usar internet", "guardar archivos en su propia carpeta"] },
  };
  const next = await withGatewayTtsHosts(profile, {
    id: "media",
    appRoot,
    installedIds: () => new Set(["media", "kokoro-tts"]),
    snapshot: await projectsView([["crow-kokoro", "kokoro-tts"]]).snapshot(),
  });
  assert.equal(next.network.hosts.some((h) => h.port === 9999), false, "a manifest-made host cannot claim the exception");
  assert.deepEqual(next.network.hosts.map((h) => h.port), [8880]);
  assert.notEqual(next, profile, "the caller's profile is not edited");
  assert.equal(profile.network.hosts.length, 1, "the input is untouched");
});

// ---- spawn.mjs: how a TTS host reaches the relay ------------------------

test("a gateway-tts host keeps its provenance at the relay; an owner host stays owner", async () => {
  const tmp = freshDir("relay-tmp");
  let relayOpts = null;
  const plan = {
    args: ["--tmpfs", "/"],
    env: {},
    unsetEnv: [],
    fds: [],
    net: { sock: "/run/crow-net/relay.sock", ports: [8880, 8000], proxyPort: 39080 },
    refused: [],
  };
  const wall = await wrapAddonSpawn({
    id: "media",
    command: "/usr/bin/node",
    args: ["server/index.js"],
    profile: {
      network: {
        internet: true,
        hosts: [
          { host: "127.0.0.1", port: 8880, scheme: "http", from: "tts:kokoro-tts", source: "gateway-tts", ownerProject: "p" },
          { host: "127.0.0.1", port: 8000, scheme: "http", from: "MEDIA_URL", source: "owner" },
        ],
      },
      doors: [],
    },
    entry: { command: "/usr/bin/node" },
    crowHome: freshDir("relay-home"),
    dataDir: freshDir("relay-data"),
    home: "/home/alex",
    nodeBin: "/usr/bin/node",
    gatewayPort: 3001,
    deps: {
      probe: () => ({ ok: true, pidns: true, bwrap: "/usr/bin/bwrap", setpriv: null, reason: null }),
      tmpdir: () => tmp,
      buildPlan: () => plan,
      seccompSupported: () => false,
      createRelay: (opts) => {
        relayOpts = opts;
        return { dir: opts.dir, socketPath: opts.dir + "/relay.sock", close: () => Promise.resolve() };
      },
    },
  });

  assert.deepEqual(relayOpts.addon.loopback, [
    { port: 8880, source: "gateway-tts", ownerProject: "p" },
    { port: 8000, source: "owner" },
  ]);
  await wall.cleanup();
});

// ---- the warm-up card ----------------------------------------------------

test("a failed prepare run is worded as its own reason, with the child's evidence", () => {
  assert.equal(failures.WARMUP_REASON, "could not get its packages ready inside its wall");
  assert.equal(failures.wallFailureReason({ refused: "warmup", exitCode: 3 }), `${failures.WARMUP_REASON}: stopped with exit code 3`);
  assert.equal(
    failures.wallFailureReason({ refused: "warmup", denials: ["192.0.2.9:80"] }),
    `${failures.WARMUP_REASON}: tried to reach 192.0.2.9:80, which it is not set up for`,
  );
  assert.equal(
    failures.wallFailureReason({
      refused: "warmup",
      stderrLines: ["EACCES: permission denied, open '/home/alex/x'"],
      installDir: "/home/alex/.crow/bundles/kiosk",
      dataDir: "/home/alex/.crow/data/kiosk",
    }),
    `${failures.WARMUP_REASON}: could not open a file outside its folder`,
  );
  assert.equal(failures.wallFailureReason({ refused: "warmup" }), failures.WARMUP_REASON, "no evidence: the reason alone");
  assert.equal(failures.wallFailureReason({ refused: true }), failures.REFUSED_REASON, "an uncoded refusal reads as before");
});

// ---- proxy.js: the prepare run in front of the first start ---------------

const WARMED_ID = "warmed";

/** A tiny stdio MCP server: answers initialize and tools/list, then waits for stdin to end. */
const TINY_SERVER = `
let buf = "";
function out(m) { process.stdout.write(JSON.stringify(m) + "\\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || m.id === null) continue;
    if (m.method === "initialize") {
      out({ jsonrpc: "2.0", id: m.id, result: {
        protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tiny", version: "1.0.0" },
      } });
    } else if (m.method === "tools/list") {
      out({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
    } else {
      out({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
const TINY_SERVER_PATH = join(HOME, "tiny-mcp-server.mjs");

before(() => {
  mkdirSync(join(HOME, "bundles", WARMED_ID), { recursive: true });
  writeFileSync(TINY_SERVER_PATH, TINY_SERVER);
});

beforeEach(() => {
  failures._resetWallFailuresForTest();
});

afterEach(() => {
  proxy._setProxyDepsForTest(null);
  try { proxy.connectedServers.get(WARMED_ID)?.client?.close?.(); } catch { /* already gone */ }
  proxy.connectedServers.delete(WARMED_ID);
});

test("a failed prepare run leaves the add-on off, builds no wall and raises one card", async () => {
  const emitted = [];
  let startCalls = 0;
  let warmCalls = 0;
  proxy._setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    warmAddon: async () => {
      warmCalls += 1;
      return { ok: false, reason: "the prepare run stopped with exit code 1", exitCode: 1, stderrLines: [], denials: [] };
    },
    startAddonWall: async () => {
      startCalls += 1;
      return { walled: true, tier: "walled", cmd: process.execPath, args: [], env: {}, stdioExtra: [], cleanup: () => {} };
    },
    emitFixIt: async (_db, name, payload) => { emitted.push({ name, ...payload }); },
  });

  const out = await proxy.connectAddonServer(WARMED_ID, { command: "node", args: ["server/index.js"] });
  assert.equal(out, null, "the add-on did not connect");
  const entry = proxy.connectedServers.get(WARMED_ID);
  assert.equal(entry.status, "error");
  assert.equal(entry.wall.mode, "refused");
  assert.equal(warmCalls, 1);
  assert.equal(startCalls, 0, "no wall is built after a failed prepare run");

  const deadline = Date.now() + 5000;
  while (emitted.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(emitted.length, 1, "one card");
  assert.equal(emitted[0].name, "addon-wall-failed");
  assert.equal(emitted[0].id, WARMED_ID);
  assert.equal(emitted[0].reason, `${failures.WARMUP_REASON}: stopped with exit code 1`);
  assert.match(emitted[0].ref, /^[0-9a-f]{32}$/);
});

test("with the walls off the prepare run never happens, and the child spawns as before", async () => {
  let warmCalls = 0;
  let startCalls = 0;
  proxy._setProxyDepsForTest({
    addonWallMode: () => ({ mode: "unwalled", reason: "walls are off on this computer", source: "default" }),
    warmAddon: async () => { warmCalls += 1; return { ok: true }; },
    startAddonWall: async () => { startCalls += 1; return { walled: false, tier: "none" }; },
  });

  await proxy.connectAddonServer(WARMED_ID, { command: "node", args: [TINY_SERVER_PATH] });
  const entry = proxy.connectedServers.get(WARMED_ID);
  assert.equal(entry.status, "connected", "the add-on starts exactly as it did before");
  assert.equal(entry.wall.mode, "unwalled");
  assert.equal(entry.wall.source, "default");
  assert.equal(warmCalls, 0, "nothing new runs with the walls off");
  assert.equal(startCalls, 0, "and no wall is built");
  await proxy.disconnectAddonServer(WARMED_ID);
});