/**
 * The one prepare run before an add-on's first start
 * (scripts/addon-sandbox/warmup.mjs), and the wall it runs in:
 * `warmupPlanFor`'s four shapes, `warmAddon`'s result for every outcome, and
 * gateway-wall.mjs's `purpose: "warmup"` profile.
 *
 * The spawn, the wall context and the clock are stubs: no bwrap, no npm, no uv,
 * no network.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AddonWallRefused } from "../scripts/addon-sandbox/spawn.mjs";
import { createWallContext } from "../scripts/addon-sandbox/gateway-wall.mjs";
import { _resetWarmupsForTest, warmAddon, warmupPlanFor } from "../scripts/addon-sandbox/warmup.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-warmup-")));
after(() => rmSync(T, { recursive: true, force: true }));

let seq = 0;
const freshDir = (name) => {
  const dir = join(T, name + "-" + ++seq);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const NODE_BIN = "/opt/node/bin/node";
const GIT_SHA = "a".repeat(40);

beforeEach(() => _resetWarmupsForTest());

// ---- warmupPlanFor -------------------------------------------------------

test("uv run becomes uv sync, and keeps --quiet", () => {
  assert.deepEqual(
    warmupPlanFor({ command: "/usr/local/bin/uv", args: ["run", "server.py"] }),
    { command: "/usr/local/bin/uv", args: ["sync"] },
  );
  assert.deepEqual(
    warmupPlanFor({ command: "/usr/local/bin/uv", args: ["run", "--quiet", "server.py"] }),
    { command: "/usr/local/bin/uv", args: ["sync", "--quiet"] },
  );
  assert.equal(warmupPlanFor({ command: "/usr/local/bin/uv", args: ["sync"] }), null, "not a run: nothing to prepare");
});

test("uvx prepares the --from source it will run, else its positional tool", () => {
  const ref = `git+https://example.invalid/r@${GIT_SHA}`;
  assert.deepEqual(
    warmupPlanFor({ command: "uvx", args: ["--from", ref, "tool"] }),
    { command: "uvx", args: ["--from", ref, "python", "-c", "0"] },
  );
  assert.deepEqual(
    warmupPlanFor({ command: "uvx", args: ["tool==1.0"] }),
    { command: "uvx", args: ["--from", "tool==1.0", "python", "-c", "0"] },
  );
  assert.equal(warmupPlanFor({ command: "uvx", args: ["--verbose"] }), null, "no tool named");
});

test("npx prepares through the npm beside the gateway's node", () => {
  assert.deepEqual(
    warmupPlanFor({ command: "npx", args: ["-y", "pkg@1.2.3"], nodeBin: NODE_BIN }),
    {
      command: join(dirname(NODE_BIN), "npm"),
      args: ["exec", "--yes", "--package=pkg@1.2.3", "--", NODE_BIN, "-e", "0"],
    },
  );
  assert.equal(warmupPlanFor({ command: "npx", args: [], nodeBin: NODE_BIN }), null, "no package named");
});

test("a node add-on has nothing to prepare; a uv project needs its lock file", () => {
  assert.equal(warmupPlanFor({ command: "node", args: ["server/index.js"], installDir: freshDir("node-app") }), null);

  const project = freshDir("uv-project");
  writeFileSync(join(project, "pyproject.toml"), "[project]\nname = \"x\"\n");
  let asked = 0;
  const resolveUv = () => { asked += 1; return "/usr/local/bin/uv"; };
  assert.equal(warmupPlanFor({ command: "./run.sh", args: [], installDir: project, resolveUv }), null, "no uv.lock yet");
  assert.equal(asked, 0, "a project without a lock file is not even looked at");

  writeFileSync(join(project, "uv.lock"), "version = 1\n");
  assert.deepEqual(
    warmupPlanFor({ command: "./run.sh", args: [], installDir: project, resolveUv }),
    { command: "/usr/local/bin/uv", args: ["sync", "--quiet"] },
  );
  assert.equal(asked, 1);

  assert.equal(warmupPlanFor({ command: "./run.sh", args: [], installDir: project, resolveUv: () => null }), null, "no uv here");
  assert.equal(warmupPlanFor({ command: "./run.sh", args: [], installDir: freshDir("empty-app"), resolveUv }), null);
});

// ---- warmAddon -----------------------------------------------------------

/** A wall context stub: it records the run and answers with one wall result. */
function stubWallCtx({ walled = true, cmd = "/usr/bin/bwrap", args = ["--unshare-net", "--", "/bin/sh"], env = { WARMED: "1" }, refused = null, denials = [] } = {}) {
  const starts = [];
  const counts = { cleanup: 0 };
  return {
    starts,
    counts,
    wallCtx: {
      startAddonWall: async (o) => {
        starts.push(o);
        if (refused) throw refused;
        return {
          walled,
          tier: walled ? "walled" : "nnp",
          cmd,
          args,
          env,
          stdioExtra: [],
          relay: { denials: () => denials },
          profile: { id: o.id },
          cleanup: () => { counts.cleanup += 1; },
        };
      },
    },
  };
}

/** A fake child: `exitCode` 0/1 emits close at once, null never exits on its own. */
class FakeChild extends EventEmitter {
  constructor(exitCode, stderrText = "") {
    super();
    this.stderr = new EventEmitter();
    this.stdio = {};
    this.killed = null;
    this._exitCode = exitCode;
    this._stderr = stderrText;
    setImmediate(() => {
      if (this._stderr) this.stderr.emit("data", this._stderr);
      if (this._exitCode !== null) this.emit("close", this._exitCode);
    });
  }
  kill(signal) {
    this.killed = signal;
    setImmediate(() => this.emit("close", null, signal));
  }
}

/** A fake spawn that records its argv and answers with one child. */
function fakeSpawn(exitCode, { stderrText = "" } = {}) {
  const calls = [];
  return {
    calls,
    spawn: (cmd, args, opts) => {
      const child = new FakeChild(exitCode, stderrText);
      calls.push({ cmd, args, opts, child });
      return child;
    },
  };
}

const PLAN_ARGS = ["--from", "tool==1.0", "python", "-c", "0"];

test("the prepare run happens inside the wall, with the wall's command line and env", async () => {
  const stub = stubWallCtx({ args: ["--unshare-net", "--", "/bin/sh", "-c", "true"], env: { HOME: "/home/alex" } });
  const fake = fakeSpawn(0);

  const out = await warmAddon({
    id: "kiosk",
    entry: { command: "uvx" },
    command: "uvx",
    args: ["tool==1.0"],
    installDir: freshDir("kiosk"),
    wallCtx: stub.wallCtx,
    baseEnv: { PATH: "/usr/bin" },
    ownEnv: { A: "1" },
    deps: { spawn: fake.spawn },
  });

  assert.equal(out.ok, true);
  assert.equal(stub.starts.length, 1, "one wall");
  const asked = stub.starts[0];
  assert.equal(asked.purpose, "warmup");
  assert.equal(asked.id, "kiosk");
  assert.equal(asked.kind, "addon");
  assert.equal(asked.command, "uvx");
  assert.deepEqual(asked.args, PLAN_ARGS, "the prepare plan, not the add-on's own args");
  assert.deepEqual(asked.baseEnv, { PATH: "/usr/bin" });
  assert.deepEqual(asked.ownEnv, { A: "1" });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].cmd, "/usr/bin/bwrap", "the wall's command line reaches the spawn unchanged");
  assert.deepEqual(fake.calls[0].args, ["--unshare-net", "--", "/bin/sh", "-c", "true"]);
  assert.deepEqual(fake.calls[0].opts.env, { HOME: "/home/alex" });
  assert.equal(fake.calls[0].opts.cwd, "/");
  assert.deepEqual(fake.calls[0].opts.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(stub.counts.cleanup, 1, "the wall is cleaned up once");
});

test("a prepared cache is not prepared twice", async () => {
  const stub = stubWallCtx();
  const fake = fakeSpawn(0);
  const args = {
    id: "kiosk",
    command: "uvx",
    args: ["tool==1.0"],
    installDir: freshDir("kiosk-ready"),
    wallCtx: stub.wallCtx,
    deps: { spawn: fake.spawn },
  };
  assert.equal((await warmAddon(args)).ok, true);
  const again = await warmAddon(args);
  assert.deepEqual(again, { ok: true, skipped: "ready" });
  assert.equal(fake.calls.length, 1, "no second spawn");
  assert.equal(stub.starts.length, 1, "no second wall");
  assert.equal(stub.counts.cleanup, 1);
});

test("exit 1 keeps the last stderr lines and the relay's denials, and cleans up once", async () => {
  const stub = stubWallCtx({ denials: ["192.0.2.7:443"] });
  const fake = fakeSpawn(1, { stderrText: ["first", "second", "third"].join("\n") + "\n" });
  const installDir = freshDir("kiosk-fail");

  const out = await warmAddon({
    id: "kiosk",
    command: "uvx",
    args: ["tool==1.0"],
    installDir,
    wallCtx: stub.wallCtx,
    deps: { spawn: fake.spawn },
  });

  assert.equal(out.ok, false);
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.stderrLines, ["first", "second", "third"]);
  assert.deepEqual(out.denials, ["192.0.2.7:443"]);
  assert.equal(stub.counts.cleanup, 1);

  // A failed run is not remembered as done: the next connect tries again.
  const retry = fakeSpawn(0);
  await warmAddon({ id: "kiosk", command: "uvx", args: ["tool==1.0"], installDir, wallCtx: stub.wallCtx, deps: { spawn: retry.spawn } });
  assert.equal(retry.calls.length, 1, "the same command line in the same folder is tried again");
});

test("a run that never finishes is killed, and the reason says how long it waited", async () => {
  const stub = stubWallCtx();
  const fake = fakeSpawn(null);

  const out = await warmAddon({
    id: "kiosk",
    command: "uvx",
    args: ["tool==1.0"],
    installDir: freshDir("kiosk-slow"),
    wallCtx: stub.wallCtx,
    timeoutMs: 50,
    deps: { spawn: fake.spawn },
  });

  assert.equal(out.ok, false);
  assert.equal(fake.calls[0].child.killed, "SIGKILL", "the child is killed");
  assert.match(out.reason, /minute/);
  assert.match(out.reason, /took longer than/);
  assert.equal(stub.counts.cleanup, 1);
});

test("a wall that refuses the prepare run is reported, never thrown", async () => {
  const stub = stubWallCtx({ refused: new AddonWallRefused("add-on refused: its installed files differ from Crow's copy", "installed-changed") });
  const fake = fakeSpawn(0);

  const out = await warmAddon({
    id: "kiosk",
    command: "uvx",
    args: ["tool==1.0"],
    installDir: freshDir("kiosk-refused"),
    wallCtx: stub.wallCtx,
    deps: { spawn: fake.spawn },
  });

  assert.equal(out.ok, false);
  assert.equal(out.refused, true);
  assert.match(out.reason, /installed files differ/);
  assert.equal(fake.calls.length, 0, "nothing was spawned");
  assert.equal(stub.counts.cleanup, 0, "there was no wall to clean up");
});

test("a weaker tier is not used: the prepare run is skipped and the wall cleaned up", async () => {
  const stub = stubWallCtx({ walled: false });
  const fake = fakeSpawn(0);
  const out = await warmAddon({
    id: "kiosk",
    command: "uvx",
    args: ["tool==1.0"],
    installDir: freshDir("kiosk-nnp"),
    wallCtx: stub.wallCtx,
    deps: { spawn: fake.spawn },
  });
  assert.deepEqual(out, { ok: true, skipped: "not walled" });
  assert.equal(fake.calls.length, 0);
  assert.equal(stub.counts.cleanup, 1);
});

test("an entry with nothing to prepare never touches the wall, and a throwing spawn is a result", async () => {
  const stub = stubWallCtx();
  const out = await warmAddon({
    id: "kiosk",
    command: "node",
    args: ["server/index.js"],
    installDir: freshDir("kiosk-node"),
    wallCtx: stub.wallCtx,
  });
  assert.deepEqual(out, { ok: true, skipped: "nothing to prepare" });
  assert.equal(stub.starts.length, 0);

  const boom = await warmAddon({
    id: "kiosk",
    command: "uvx",
    args: ["tool==1.0"],
    installDir: freshDir("kiosk-boom"),
    wallCtx: stub.wallCtx,
    deps: { spawn: () => { throw new Error("spawn is broken"); } },
  });
  assert.equal(boom.ok, false);
  assert.match(boom.reason, /spawn is broken/);
  assert.equal(stub.counts.cleanup, 1);
});

// ---- the wall's own purpose ----------------------------------------------

/** A scratch checkout `profileFor` can read, plus one bundle. */
function appRootWith(id) {
  const root = freshDir("app");
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "addon-past-defaults.json"), JSON.stringify({ version: 1, defaults: {} }));
  mkdirSync(join(root, "bundles", id), { recursive: true });
  writeFileSync(join(root, "bundles", id, "manifest.json"), JSON.stringify({
    id,
    name: id,
    type: "mcp-server",
    version: "1.0.0",
    server: { command: "node", args: [] },
    sandbox: {
      network: { internet: false, hosts: ["env:KIT_URL"] },
      doors: [],
    },
  }));
  return root;
}

test("a warm-up wall reaches the internet only: no listed host, no door", async () => {
  const id = "kiosk";
  const appRoot = appRootWith(id);
  const calls = [];
  const ctx = createWallContext({
    crowHome: join(freshDir("home"), ".crow"),
    appRoot,
    dataDir: freshDir("data"),
    home: freshDir("operator-home"),
    nodeBin: process.execPath,
    gatewayPort: 3001,
    gatewayEnv: {},
    deps: {
      dockerView: () => ({ snapshot: async () => ({ publishes: [], containers: [], subnets: [], addonProjects: new Map() }) }),
      tailscaleStatus: async () => null,
      interfaces: () => ({}),
      wrapAddonSpawn: async (o) => {
        calls.push(o);
        return { walled: true, tier: "walled", cmd: "/usr/bin/bwrap", args: [], env: {}, stdioExtra: [], cleanup: () => {} };
      },
    },
  });

  await ctx.startAddonWall({
    id,
    entry: { env: { KIT_URL: "http://192.0.2.10:8080" } },
    command: "uvx",
    args: ["tool==1.0"],
    kind: "addon",
    purpose: "warmup",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].profile.network, { internet: true, hosts: [] });
  assert.deepEqual(calls[0].profile.doors, []);

  // The same id for a real start keeps its own policy.
  await ctx.startAddonWall({
    id,
    entry: { env: { KIT_URL: "http://192.0.2.10:8080" } },
    command: "node",
    args: ["server/index.js"],
    kind: "addon",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].profile.network.internet, false);
  assert.equal(calls[1].profile.network.hosts.length, 1, "a real start keeps its listed host");
});

test("a purpose the wall does not know is refused", async () => {
  const id = "kiosk";
  const calls = [];
  const ctx = createWallContext({
    crowHome: join(freshDir("home"), ".crow"),
    appRoot: appRootWith(id),
    dataDir: freshDir("data"),
    home: freshDir("operator-home"),
    nodeBin: process.execPath,
    gatewayPort: 3001,
    gatewayEnv: {},
    deps: {
      dockerView: () => ({ snapshot: async () => ({ publishes: [], containers: [], subnets: [], addonProjects: new Map() }) }),
      tailscaleStatus: async () => null,
      interfaces: () => ({}),
      wrapAddonSpawn: async (o) => { calls.push(o); return { walled: true, tier: "walled", cleanup: () => {} }; },
    },
  });

  await assert.rejects(
    ctx.startAddonWall({ id, entry: {}, command: "node", args: [], kind: "addon", purpose: "bogus" }),
    (err) => err instanceof AddonWallRefused && /purpose/.test(err.message),
  );
  assert.equal(calls.length, 0, "a refused purpose never reaches the wrap");
});