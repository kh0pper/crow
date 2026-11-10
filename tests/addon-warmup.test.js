/**
 * The prepare run before an add-on's first start
 * (scripts/addon-sandbox/warmup.mjs), and the wall it runs in:
 * `warmupPlanFor`'s steps, hosts and env for every launcher, `warmAddon`'s
 * result for every outcome, and gateway-wall.mjs's `purpose: "warmup"` profile.
 *
 * The spawn, the wall context and the clock are stubs: no bwrap, no npm, no uv,
 * no network.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AddonWallRefused } from "../scripts/addon-sandbox/spawn.mjs";
import { createWallContext } from "../scripts/addon-sandbox/gateway-wall.mjs";
import { buildAddonPlan } from "../scripts/addon-sandbox/plan.mjs";
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
const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];
const NPM_PATH = join(dirname(NODE_BIN), "npm");

beforeEach(() => _resetWarmupsForTest());

// ---- warmupPlanFor -------------------------------------------------------

test("uv run becomes two uv syncs: dependencies from wheels, then the add-on's own project", () => {
  const quiet = warmupPlanFor({ command: "/usr/local/bin/uv", args: ["run", "server.py"] });
  assert.deepEqual(quiet, {
    steps: [
      { command: "/usr/local/bin/uv", args: ["sync", "--no-build", "--no-install-project"] },
      { command: "/usr/local/bin/uv", args: ["sync"] },
    ],
    hosts: PYPI_HOSTS,
    env: {},
  });

  const louder = warmupPlanFor({ command: "/usr/local/bin/uv", args: ["run", "--quiet", "server.py"] });
  assert.deepEqual(louder.steps, [
    { command: "/usr/local/bin/uv", args: ["sync", "--no-build", "--no-install-project", "--quiet"] },
    { command: "/usr/local/bin/uv", args: ["sync", "--quiet"] },
  ]);
  assert.equal(warmupPlanFor({ command: "/usr/local/bin/uv", args: ["sync"] }), null, "not a run: nothing to prepare");
});

test("uvx prepares the --from source it will run, else its positional tool", () => {
  assert.deepEqual(
    warmupPlanFor({ command: "uvx", args: ["tool==1.0"] }),
    {
      steps: [{ command: "uvx", args: ["--no-build", "--from", "tool==1.0", "python", "-c", "0"] }],
      hosts: PYPI_HOSTS,
      env: {},
    },
    "a PyPI tool is never built",
  );
  assert.deepEqual(
    warmupPlanFor({ command: "uvx", args: ["--from=tool==1.0", "tool"] }),
    {
      steps: [{ command: "uvx", args: ["--no-build", "--from", "tool==1.0", "python", "-c", "0"] }],
      hosts: PYPI_HOSTS,
      env: {},
    },
  );
  assert.equal(warmupPlanFor({ command: "uvx", args: [] }), null, "no tool named");
});

test("a pinned github ref: only the git package is built (alone, --no-deps), then every dependency must be a wheel", () => {
  const ref = `git+https://github.com/owner/repo@${GIT_SHA}`;
  const data = freshDir("git-data");
  const plan = warmupPlanFor({ command: "/opt/uv/uvx", args: ["--from", ref, "tool"], dataDir: data, resolveUv: () => "/opt/uv/uv" });
  const venv = join(data, ".cache", "crow-warm-venv");
  assert.deepEqual(plan.steps, [
    { command: "/opt/uv/uv", args: ["venv", "--quiet", "--allow-existing", venv] },
    { command: "/opt/uv/uv", args: ["pip", "install", "--quiet", "--python", join(venv, "bin", "python"), "--no-deps", ref] },
    { command: "/opt/uv/uvx", args: ["--no-build", "--from", ref, "python", "-c", "0"] },
  ]);
  // The one step that may build is the git package with no dependencies at all.
  assert.ok(plan.steps[1].args.includes("--no-deps"));
  // The resolve of the whole tree builds nothing: a dependency that needs a
  // source build makes uv refuse ("Building source distributions is disabled").
  assert.equal(plan.steps[2].args[0], "--no-build");
  assert.deepEqual(plan.hosts, [...PYPI_HOSTS, "github.com", "codeload.github.com"]);
  assert.deepEqual(plan.env, {});
});

test("a pinned github ref with no uv or no data folder is refused, never built some other way", () => {
  const ref = `git+https://github.com/owner/repo@${GIT_SHA}`;
  const refused = { refused: "its git source cannot be prepared here" };
  assert.deepEqual(warmupPlanFor({ command: "uvx", args: ["--from", ref, "tool"], dataDir: freshDir("g2"), resolveUv: () => null }), refused);
  assert.deepEqual(warmupPlanFor({ command: "uvx", args: ["--from", ref, "tool"], resolveUv: () => "/opt/uv/uv" }), refused);
  assert.deepEqual(warmupPlanFor({ command: "uvx", args: ["--from", ref, "tool"], dataDir: join(T, "missing"), resolveUv: () => "/opt/uv/uv" }), refused);
});

test("a git ref on any other host is refused, not widened to", () => {
  const ref = `git+https://example.invalid/repo@${GIT_SHA}`;
  assert.deepEqual(warmupPlanFor({ command: "uvx", args: ["--from", ref, "tool"] }), {
    refused: "its packages come from a host Crow does not fetch from",
  });
});

test("an unsupported launcher option is a refusal, never a throw", () => {
  assert.deepEqual(warmupPlanFor({ command: "uvx", args: ["--with", "evil", "tool==1.0"] }), {
    refused: "--with: this launcher option is not supported for a walled add-on",
  });
  assert.deepEqual(warmupPlanFor({ command: "npx", args: ["-p", "evil", "pkg@1.2.3"] }), {
    refused: "-p: this launcher option is not supported for a walled add-on",
  });
});

test("npx prepares through the npm beside the gateway's node, without install scripts", () => {
  assert.deepEqual(
    warmupPlanFor({ command: "npx", args: ["-y", "pkg@1.2.3"], nodeBin: NODE_BIN }),
    {
      steps: [{
        command: NPM_PATH,
        args: ["exec", "--yes", "--ignore-scripts", "--package=pkg@1.2.3", "--", NODE_BIN, "-e", "0"],
      }],
      hosts: ["registry.npmjs.org"],
      env: { npm_config_ignore_scripts: "true" },
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
    {
      steps: [
        { command: "/usr/local/bin/uv", args: ["sync", "--no-build", "--no-install-project", "--quiet"] },
        { command: "/usr/local/bin/uv", args: ["sync", "--quiet"] },
      ],
      hosts: PYPI_HOSTS,
      env: {},
    },
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

const PLAN_ARGS = ["--no-build", "--from", "tool==1.0", "python", "-c", "0"];

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
    ownEnv: { SECRET_TOKEN: "s3cr3t" },
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
  assert.deepEqual(asked.warmupHosts, PYPI_HOSTS, "the plan's hosts, and nothing else");
  assert.deepEqual(asked.ownEnv, {}, "the plan's own settings only");
  assert.equal("SECRET_TOKEN" in asked.ownEnv, false, "the caller's own env never reaches the wall");

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].cmd, "/usr/bin/bwrap", "the wall's command line reaches the spawn unchanged");
  assert.deepEqual(fake.calls[0].args, ["--unshare-net", "--", "/bin/sh", "-c", "true"]);
  assert.deepEqual(fake.calls[0].opts.env, { HOME: "/home/alex" });
  assert.equal(fake.calls[0].opts.cwd, "/");
  assert.deepEqual(fake.calls[0].opts.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(stub.counts.cleanup, 1, "the wall is cleaned up once");
});

test("an npx prepare run asks for the npm registry and carries npm's own no-scripts setting", async () => {
  const stub = stubWallCtx();
  const fake = fakeSpawn(0);
  const out = await warmAddon({
    id: "npx-addon",
    command: "npx",
    args: ["-y", "pkg@1.2.3"],
    installDir: freshDir("npx-addon"),
    nodeBin: NODE_BIN,
    wallCtx: stub.wallCtx,
    deps: { spawn: fake.spawn },
  });

  assert.equal(out.ok, true);
  const asked = stub.starts[0];
  assert.equal(asked.command, NPM_PATH, "the npm beside the gateway's node");
  assert.ok(asked.args.includes("--ignore-scripts"), asked.args.join(" "));
  assert.deepEqual(asked.warmupHosts, ["registry.npmjs.org"]);
  assert.deepEqual(asked.ownEnv, { npm_config_ignore_scripts: "true" });
});

test("the first failing step ends the plan: the second step never runs", async () => {
  const stub = stubWallCtx();
  const fake = fakeSpawn(1);
  const out = await warmAddon({
    id: "uv-project",
    command: "/usr/local/bin/uv",
    args: ["run", "server.py"],
    installDir: freshDir("uv-project-run"),
    wallCtx: stub.wallCtx,
    deps: { spawn: fake.spawn },
  });

  assert.equal(out.ok, false);
  assert.equal(out.exitCode, 1);
  assert.equal(stub.starts.length, 1, "one wall, for the first step");
  assert.equal(fake.calls.length, 1, "the second step was not run");
  assert.equal(stub.counts.cleanup, 1);
  assert.deepEqual(stub.starts[0].warmupHosts, PYPI_HOSTS);
});

test("a plan that cannot be built is a refusal, never a throw and never a wall", async () => {
  const stub = stubWallCtx();
  const fake = fakeSpawn(0);

  const option = await warmAddon({
    id: "kiosk",
    command: "uvx",
    args: ["--with", "evil", "tool==1.0"],
    installDir: freshDir("kiosk-with"),
    wallCtx: stub.wallCtx,
    deps: { spawn: fake.spawn },
  });
  assert.equal(option.ok, false);
  assert.equal(option.refused, true);
  assert.equal(option.code, "warmup", "a plan refusal carries the warm-up's own code");
  assert.match(option.reason, /not supported for a walled add-on/);

  const ref = `git+https://example.invalid/repo@${GIT_SHA}`;
  const host = await warmAddon({
    id: "kiosk",
    command: "uvx",
    args: ["--from", ref, "tool"],
    installDir: freshDir("kiosk-git"),
    wallCtx: stub.wallCtx,
    deps: { spawn: fake.spawn },
  });
  assert.equal(host.ok, false);
  assert.equal(host.refused, true);
  assert.equal(host.code, "warmup");
  assert.equal(host.reason, "its packages come from a host Crow does not fetch from");

  assert.equal(stub.starts.length, 0, "no wall is built for a plan that was refused");
  assert.equal(fake.calls.length, 0);
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
  assert.equal(out.code, "installed-changed", "a wall refusal keeps its own code");
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

test("a warm-up wall reaches the plan's registries only: no internet, no door", async () => {
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
    warmupHosts: ["pypi.org"],
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].profile.network, {
    internet: false,
    hosts: [{ host: "pypi.org", port: 443, scheme: "https", from: "warmup", source: "warmup" }],
  });
  assert.deepEqual(calls[0].profile.doors, []);

  // A warm-up that names no host reaches nothing at all.
  await ctx.startAddonWall({ id, entry: {}, command: "uvx", args: ["tool==1.0"], kind: "addon", purpose: "warmup", warmupHosts: [] });
  assert.deepEqual(calls[1].profile.network, { internet: false, hosts: [] });

  // The same id for a real start keeps its own policy.
  await ctx.startAddonWall({
    id,
    entry: { env: { KIT_URL: "http://192.0.2.10:8080" } },
    command: "node",
    args: ["server/index.js"],
    kind: "addon",
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].profile.network.internet, false);
  assert.equal(calls[2].profile.network.hosts.length, 1, "a real start keeps its listed host");
});

/** A scratch checkout with a bundle whose own server code opens crow.db. */
function crowDbAppRoot(id) {
  const root = freshDir("app-crowdb");
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "addon-past-defaults.json"), JSON.stringify({ version: 1, defaults: {} }));
  mkdirSync(join(root, "bundles", id, "server"), { recursive: true });
  writeFileSync(join(root, "bundles", id, "server", "index.js"),
    'import { createDbClient } from "../../../servers/db.js";\n');
  writeFileSync(join(root, "bundles", id, "manifest.json"), JSON.stringify({
    id, name: id, type: "mcp-server", version: "1.0.0",
    server: { command: "node", args: ["server/index.js"] },
    env_vars: ["KIT_URL", "ACME_OUT", "ACME_KEY", "ACME_TOKEN_FILE"].map((name) => ({ name })),
    sandbox: {
      ownEnvFile: true,
      files: { read: ["env:ACME_KEY"], write: ["env:ACME_OUT"], oauthDir: "env:ACME_TOKEN_FILE" },
      network: { internet: true, hosts: ["env:KIT_URL"] },
      doors: [],
    },
  }));
  return root;
}

test("a warm-up wall carries none of the add-on's own things: no crow.db, no files, no own .env", async () => {
  const id = "ledger";
  const appRoot = crowDbAppRoot(id);
  const operatorHome = freshDir("operator-home");
  const crowHome = join(operatorHome, ".crow");
  mkdirSync(join(crowHome, "bundles", id), { recursive: true });
  const dataDir = join(crowHome, "data");
  mkdirSync(join(dataDir, id), { recursive: true });
  writeFileSync(join(dataDir, "crow.db"), "");
  const entry = {
    command: "node",
    args: ["server/index.js"],
    env: {
      KIT_URL: "https://example.invalid:8443",
      ACME_OUT: join(operatorHome, "notes", "out.txt"),
      ACME_KEY: join(operatorHome, "notes", "key.pem"),
      ACME_TOKEN_FILE: join(operatorHome, "signin", "token.json"),
    },
    ownerSet: ["ACME_OUT", "ACME_KEY", "ACME_TOKEN_FILE"],
  };

  const calls = [];
  const ctx = createWallContext({
    crowHome,
    appRoot,
    dataDir,
    home: operatorHome,
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

  // The add-on's own start: its profile does carry crow.db and its files.
  await ctx.startAddonWall({ id, entry, command: "node", args: ["server/index.js"], kind: "addon" });
  assert.equal(calls[0].profile.crowDb, true, "this bundle's own server code opens crow.db");
  assert.ok(calls[0].profile.files.write.length > 0, "and it has an owner file to write");
  assert.equal(calls[0].profile.ownEnvFile, true);

  await ctx.startAddonWall({
    id, entry, command: "uvx", args: ["tool==1.0"], kind: "addon", purpose: "warmup", warmupHosts: ["pypi.org"],
  });
  const warm = calls[1].profile;
  assert.equal(warm.crowDb, false, "a prepare run gets no crow.db");
  assert.deepEqual(warm.files, { read: [], write: [], oauthDir: null, state: [] }, "and no owner file, folder or state folder");
  assert.equal(warm.ownEnvFile, false, "and no own .env");

  // A plan built from that profile never touches crow.db.
  const plan = buildAddonPlan({
    id,
    profile: warm,
    entry: { command: "uvx", args: ["tool==1.0"] },
    home: operatorHome,
    crowHome,
    appRoot,
    nodeBin: process.execPath,
    dataDir,
    gatewayPort: 3001,
    otherHomes: [],
    selfTargets: [],
  });
  try {
    assert.equal("CROW_DB_PATH" in plan.env, false, "no crow.db path in the child env");
    assert.ok(plan.unsetEnv.includes("CROW_DB_PATH"));
    const bound = [];
    for (let i = 0; i + 2 < plan.args.length; i++) {
      if (["--bind-fd", "--ro-bind-fd", "--ro-bind"].includes(plan.args[i])) bound.push(plan.args[i + 2]);
    }
    assert.equal(bound.includes(dataDir), false, "the whole data folder is not bound");
    assert.equal(plan.args.includes(join(dataDir, "crow.db")), false, "crow.db is not named at all");
    assert.deepEqual(plan.fds.map((f) => f.role), ["data"], "only the add-on's own data folder is bound by fd");
  } finally {
    for (const f of plan.fds) { try { closeSync(f.fd); } catch { /* already closed */ } }
  }
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