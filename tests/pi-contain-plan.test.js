// Queue item 19, step 2a: the "contain" tier's mount plan. Pure argv tests:
// no bwrap runs here (tests/pi-contain.test.js runs real sandboxes).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContainPlan, containSelected, ContainRefused } from "../scripts/pi-bots/pi_contain.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "crow-contain-plan-")));
after(() => rmSync(T, { recursive: true, force: true }));

// A fake host layout under T.
const H = join(T, "home", "alice");
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
const node = mk(H, ".nvm", "versions", "node", "v24.0.0");
mk(node, "bin"); writeFileSync(join(node, "bin", "node"), "");
const cliRoot = mk(node, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
mk(cliRoot, "dist"); writeFileSync(join(cliRoot, "dist", "cli.js"), "");
const app = mk(H, "crow");
const piLab = mk(H, "pi-lab");
const agent = mk(H, ".pi", "agent");
for (const d of ["pkg", "agents", "prompts", "bin", "sessions"]) mk(agent, d);
const shadow = mk(T, "shadow");
const crowHome = mk(H, ".crow");
const data = mk(crowHome, "data");
writeFileSync(join(data, "crow.db"), "");
writeFileSync(join(data, "identity.json"), "{}");
mk(crowHome, "secrets");
const otherInst = mk(H, ".crow-other", "data");
mk(H, ".ssh"); mk(H, ".claude"); mk(H, ".gnupg");
const session = mk(T, "sess", "bot-a");
const work = mk(crowHome, "data", "projects", "p1", "workspace");
const notes = mk(H, "notes");
const out = mk(H, "out");
const cache = mk(crowHome, "bot-cache");
const addon = mk(crowHome, "bundles", "tasks");

function base(over = {}) {
  return {
    home: H, uid: 1000, nodeBin: join(node, "bin", "node"), cliPath: join(cliRoot, "dist", "cli.js"),
    appRoot: app, piLabDir: piLab, piAgentDir: agent, shadowAgentDir: shadow,
    crowHome, dataDir: data, botCacheDir: cache,
    sessionDir: session, cwd: session, workspaceDir: null,
    writePaths: [], readPaths: [], mcpServers: [],
    exists: undefined, systemDirs: ["/usr", "/etc"], ...over,
  };
}
const pairs = (args) => {
  const o = [];
  for (let i = 0; i < args.length; i++) {
    if (["--ro-bind", "--bind", "--symlink"].includes(args[i])) { o.push([args[i], args[i + 1], args[i + 2]]); i += 2; }
    else if (["--tmpfs", "--dev", "--proc", "--chdir"].includes(args[i])) { o.push([args[i], args[i + 1]]); i += 1; }
    else o.push([args[i]]);
  }
  return o;
};
const has = (args, flag, src, dst = src) => pairs(args).some((p) => p[0] === flag && p[1] === src && (p.length < 3 || p[2] === dst));

test("containSelected: CROW_PI_SANDBOX=contain for all, CROW_PI_CONTAIN_BOTS for listed ids only", () => {
  assert.equal(containSelected({ CROW_PI_SANDBOX: "contain" }, "x"), true);
  assert.equal(containSelected({ CROW_PI_CONTAIN_BOTS: "a, b" }, "b"), true);
  assert.equal(containSelected({ CROW_PI_CONTAIN_BOTS: "a,b" }, "c"), false);
  assert.equal(containSelected({}, "a"), false);
  assert.equal(containSelected({ CROW_PI_SANDBOX: "off", CROW_PI_CONTAIN_BOTS: "a" }, "a"), false, "off wins");
});

test("an empty root: tmpfs /, system dirs read-only, private /tmp and /run, a fresh home", () => {
  const { args } = buildContainPlan(base());
  assert.deepEqual(args.slice(0, 2), ["--tmpfs", "/"]);
  assert.ok(has(args, "--ro-bind", "/usr"));
  assert.ok(has(args, "--ro-bind", "/etc"));
  assert.ok(has(args, "--tmpfs", "/tmp"));
  assert.ok(has(args, "--tmpfs", "/run"));
  assert.ok(has(args, "--tmpfs", H), "home is an empty tmpfs");
  assert.ok(has(args, "--dev", "/dev"));
  assert.ok(has(args, "--proc", "/proc"));
  assert.ok(args.includes("--unshare-pid"), "own pid namespace: no signals to host processes");
  assert.ok(args.includes("--unshare-user") && args.includes("--unshare-ipc") && args.includes("--unshare-uts"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(!args.includes("--die-with-parent") && !args.includes("--new-session"));
  assert.ok(has(args, "--tmpfs", "/etc/crow"), "operator env files masked");
});

test("engine paths read-only: node install, pi package, checkout, pi-lab", () => {
  const { args } = buildContainPlan(base());
  assert.ok(has(args, "--ro-bind", node));
  assert.ok(has(args, "--ro-bind", app));
  assert.ok(has(args, "--ro-bind", piLab));
  assert.ok(!has(args, "--bind", app), "the checkout is never writable");
});

test("pi agent dir: a writable SHADOW at the real path, real subdirs read-only on top, sessions not exposed", () => {
  const { args } = buildContainPlan(base());
  assert.ok(has(args, "--bind", shadow, agent));
  for (const d of ["pkg", "agents", "prompts", "bin"]) assert.ok(has(args, "--ro-bind", join(agent, d)), d);
  assert.ok(!pairs(args).some((p) => p[1] === join(agent, "sessions")), "the operator's pi sessions stay hidden");
  const iShadow = pairs(args).findIndex((p) => p[0] === "--bind" && p[1] === shadow);
  const iPkg = pairs(args).findIndex((p) => p[0] === "--ro-bind" && p[1] === join(agent, "pkg"));
  assert.ok(iShadow < iPkg, "shadow mounted before the subdirs that sit on it");
});

test("instance data dir read-write with its secrets masked; the rest of CROW_HOME is not bound", () => {
  const { args } = buildContainPlan(base());
  assert.ok(has(args, "--bind", data));
  assert.ok(has(args, "--ro-bind", "/dev/null", join(data, "identity.json")), "identity masked by default");
  assert.ok(!pairs(args).some((p) => p[1] === crowHome), "CROW_HOME itself is not bound");
  assert.ok(!pairs(args).some((p) => p[1] && p[1].startsWith(join(crowHome, "secrets"))));
  const masked = buildContainPlan(base({ unmaskIdentity: true })).args;
  assert.ok(!has(masked, "--ro-bind", "/dev/null", join(data, "identity.json")), "a sharing bot keeps its identity");
});

test("bot paths: session and cwd rw, workspace rw, write_paths rw, read_paths ro, all realpath'd", () => {
  const link = join(T, "link-to-notes");
  symlinkSync(notes, link);
  const { args } = buildContainPlan(base({ workspaceDir: work, writePaths: [out], readPaths: [link] }));
  assert.ok(has(args, "--bind", session));
  assert.ok(has(args, "--bind", work));
  assert.ok(has(args, "--bind", out));
  assert.ok(has(args, "--ro-bind", notes), "a symlinked read path is bound at its real path");
  assert.ok(has(args, "--chdir", session));
});

test("never bound, whatever the policy says: key dirs, assistant config, other instances, the whole home", () => {
  const { args, refused } = buildContainPlan(base({
    writePaths: [join(H, ".ssh"), H, otherInst], readPaths: [join(H, ".claude"), join(H, ".gnupg", "x")],
  }));
  for (const p of [join(H, ".ssh"), H, otherInst, join(H, ".claude")]) {
    assert.ok(!pairs(args).some((q) => (q[0] === "--bind" || q[0] === "--ro-bind") && q[1] === p), p + " not bound");
  }
  const reasons = refused.map((r) => r.path);
  for (const p of [join(H, ".ssh"), H, otherInst, join(H, ".claude")]) assert.ok(reasons.includes(p), p + " refused");
});

test("a write path covering the checkout or the engine is refused (code stays read-only)", () => {
  const { args, refused } = buildContainPlan(base({ writePaths: [app, join(app, "servers"), node] }));
  assert.ok(!has(args, "--bind", app) && !has(args, "--bind", join(app, "servers")) && !has(args, "--bind", node));
  assert.equal(refused.length, 3);
});

test("bypass mode (\"/\" in a path list) cannot be contained: ContainRefused", () => {
  assert.throws(() => buildContainPlan(base({ writePaths: ["/"] })), ContainRefused);
  assert.throws(() => buildContainPlan(base({ readPaths: ["/"] })), ContainRefused);
});

test("missing paths are skipped and reported, not bound", () => {
  const { args, refused } = buildContainPlan(base({ readPaths: [join(H, "nope")] }));
  assert.ok(!pairs(args).some((p) => p[1] === join(H, "nope")));
  assert.ok(refused.some((r) => r.path === join(H, "nope") && /does not exist/.test(r.reason)));
});

test("MCP servers: cwd and an absolute command's install root read-only; files named in env read-only", () => {
  const venvBin = mk(H, "proj", ".venv", "bin");
  writeFileSync(join(venvBin, "srv"), "");
  const tokenFile = join(H, "proj", "token.json");
  writeFileSync(tokenFile, "{}");
  const { args } = buildContainPlan(base({ mcpServers: [
    { command: join(venvBin, "srv"), cwd: join(H, "proj"), env: { TOKEN_FILE: tokenFile, NAME: "x" } },
    { command: "node", args: ["server/index.js"], cwd: addon },
    { command: "npx", args: ["-y", "pkg"], cwd: H },
  ] }));
  assert.ok(has(args, "--ro-bind", join(H, "proj")));
  assert.ok(has(args, "--ro-bind", addon));
  assert.ok(!pairs(args).some((p) => p[0] !== "--tmpfs" && p[1] === H), "a server cwd of HOME does not bind the whole home");
});

test("bot cache: one per instance, read-write, and the cache env points at it", () => {
  const { args, env } = buildContainPlan(base());
  assert.ok(has(args, "--bind", cache));
  assert.equal(env.npm_config_cache, join(cache, "npm"));
  assert.equal(env.UV_CACHE_DIR, join(cache, "uv"));
  assert.equal(env.XDG_CACHE_HOME, cache);
  assert.equal(env.TMPDIR, "/tmp");
});

test("mount order: parents before children, masks after the dirs they sit in", () => {
  const { args } = buildContainPlan(base({ workspaceDir: work }));
  const ps = pairs(args);
  const idx = (f, p) => ps.findIndex((q) => q[0] === f && (q[2] || q[1]) === p);
  assert.ok(idx("--tmpfs", H) < idx("--ro-bind", app));
  assert.ok(idx("--bind", data) < idx("--bind", work));
  assert.ok(idx("--bind", data) < idx("--ro-bind", join(data, "identity.json")));
});

// ---- rev 2 (plan review C2, C3, C9) ----

test("C9: the data dir keeps only the DBs, the bot's own project and the keep-list; everything else present is masked", () => {
  const d = mk(T, "c9", "data");
  for (const f of ["crow.db", "crow.db-wal", "tasks.db", "crow.db.CORRUPT-1", "identity.json", "notes.txt"]) writeFileSync(join(d, f), "");
  for (const x of ["backups", "peers", "instance-sync", "artifacts", join("projects", "mine", "workspace"), join("projects", "theirs")]) mk(d, x);
  const ws = join(d, "projects", "mine", "workspace");
  const { args } = buildContainPlan(base({ dataDir: d, workspaceDir: ws, dataKeep: ["artifacts"] }));
  const masked = (p) => has(args, "--tmpfs", p) || has(args, "--ro-bind", "/dev/null", p);
  for (const p of ["crow.db.CORRUPT-1", "identity.json", "notes.txt", "backups", "peers", "instance-sync", join("projects", "theirs")]) {
    assert.ok(masked(join(d, p)), p + " masked");
  }
  for (const p of ["crow.db", "crow.db-wal", "tasks.db", "artifacts", join("projects", "mine")]) assert.ok(!masked(join(d, p)), p + " kept");
  const ps = pairs(args);
  const iMaskTheirs = ps.findIndex((q) => q[0] === "--tmpfs" && q[1] === join(d, "projects", "theirs"));
  const iWs = ps.findIndex((q) => q[0] === "--bind" && q[1] === ws);
  assert.ok(iWs > 0 && iMaskTheirs > 0);
});

test("C3: .env files in bound dirs and in the checkout's bundles are masked; a symlinked .env masks its bound target", () => {
  const appX = mk(T, "c3", "app");
  writeFileSync(join(appX, ".env"), "SECRET=1");
  writeFileSync(join(appX, ".env.local"), "S=1");
  mk(appX, "bundles", "minio"); writeFileSync(join(appX, "bundles", "minio", ".env"), "P=1");
  const addonX = mk(T, "c3", "addon"); const sharedEnv = mk(T, "c3", "envdir");
  writeFileSync(join(sharedEnv, "rocm.env"), "R=1");
  symlinkSync(join(sharedEnv, "rocm.env"), join(addonX, ".env"));
  const { args } = buildContainPlan(base({ appRoot: appX, mcpServers: [{ command: "node", cwd: addonX }], readPaths: [sharedEnv] }));
  for (const p of [join(appX, ".env"), join(appX, ".env.local"), join(appX, "bundles", "minio", ".env"), join(sharedEnv, "rocm.env")]) {
    assert.ok(has(args, "--ro-bind", "/dev/null", p), p + " masked");
  }
});

test("C9b: a policy write path into a hidden home entry is refused (rc files, PATH dirs, config)", () => {
  writeFileSync(join(H, ".bashrc"), "");
  mk(H, ".local", "bin"); mk(H, ".config", "autostart");
  const { args, refused } = buildContainPlan(base({ writePaths: [join(H, ".bashrc"), join(H, ".local", "bin"), join(H, ".config", "autostart"), out] }));
  for (const p of [join(H, ".bashrc"), join(H, ".local", "bin"), join(H, ".config", "autostart")]) {
    assert.ok(!has(args, "--bind", p), p);
    assert.ok(refused.some((r) => r.path === p && /hidden entry/.test(r.reason)), p + " refused");
  }
  assert.ok(has(args, "--bind", out), "a visible dir stays writable");
});

test("instance secrets: read_paths covering CROW_HOME (tokens, secrets/, env/) are refused", () => {
  writeFileSync(join(crowHome, "board-token"), "");
  const { args, refused } = buildContainPlan(base({ readPaths: [crowHome, join(crowHome, "secrets"), join(crowHome, "board-token")] }));
  for (const p of [crowHome, join(crowHome, "secrets"), join(crowHome, "board-token")]) {
    assert.ok(!has(args, "--ro-bind", p), p);
    assert.ok(refused.some((r) => r.path === p), p + " refused");
  }
});

test("C2: pi packages outside the agent dir are bound read-only; one that cannot be bound refuses the spawn", () => {
  const sh = mk(T, "c2", "shadow");
  writeFileSync(join(sh, "settings.json"), JSON.stringify({ packages: ["pkg/superpowers", "../../pi-lab", "npm-name"] }));
  const { args } = buildContainPlan(base({ shadowAgentDir: sh }));
  assert.ok(has(args, "--ro-bind", piLab), "relative package root bound");
  const sh2 = mk(T, "c2", "shadow2");
  writeFileSync(join(sh2, "settings.json"), JSON.stringify({ packages: [join(H, ".ssh")] }));
  assert.throws(() => buildContainPlan(base({ shadowAgentDir: sh2 })), ContainRefused);
  const sh3 = mk(T, "c2", "shadow3");
  writeFileSync(join(sh3, "settings.json"), JSON.stringify({ packages: [join(H, "gone-pkg")] }));
  assert.doesNotThrow(() => buildContainPlan(base({ shadowAgentDir: sh3 })), "a package missing on the host too is not a refusal");
});

test("C5: DNS stub dir bound when present", () => {
  const { args } = buildContainPlan(base());
  if (existsSync("/run/systemd/resolve")) assert.ok(has(args, "--ro-bind", "/run/systemd/resolve"));
});

// ---- security review (MEDIUM): .env masking at any depth, fail closed ----

test(".env files are masked at any depth: nested project folders and bundles/x/sub/.env", () => {
  const appY = mk(T, "deep", "app");
  mk(appY, "bundles", "x", "sub");
  writeFileSync(join(appY, "bundles", "x", "sub", ".env"), "S=1");
  mk(appY, "a", "b", "c", "d");
  writeFileSync(join(appY, "a", "b", "c", "d", ".env.production"), "S=1");
  mk(appY, "node_modules", "pkg"); writeFileSync(join(appY, "node_modules", "pkg", ".env"), "pkg-fixture");
  const { args } = buildContainPlan(base({ appRoot: appY }));
  assert.ok(has(args, "--ro-bind", "/dev/null", join(appY, "bundles", "x", "sub", ".env")));
  assert.ok(has(args, "--ro-bind", "/dev/null", join(appY, "a", "b", "c", "d", ".env.production")));
});

test("a bound path that is itself a bundles root has every bundle's .env masked", () => {
  const broot = mk(T, "broot", "bundles");
  for (const b of ["minio", "workspace"]) { mk(broot, b); writeFileSync(join(broot, b, ".env"), "P=1"); }
  mk(broot, "browser", "server"); writeFileSync(join(broot, "browser", "server", ".env.local"), "P=1");
  const { args } = buildContainPlan(base({ readPaths: [broot] }));
  assert.ok(has(args, "--ro-bind", broot));
  for (const p of [join(broot, "minio", ".env"), join(broot, "workspace", ".env"), join(broot, "browser", "server", ".env.local")]) {
    assert.ok(has(args, "--ro-bind", "/dev/null", p), p);
  }
});

test("scan cap: a policy path too large to scan is not bound; an engine dir too large refuses the spawn", () => {
  const big = mk(T, "big", "tree");
  for (let i = 0; i < 30; i++) writeFileSync(join(big, "f" + i), "");
  const r = buildContainPlan(base({ readPaths: [big], envScanMaxEntries: 25 }));
  assert.ok(!has(r.args, "--ro-bind", big), "not bound unscanned");
  assert.ok(r.refused.some((x) => x.path === big && /too large to scan/.test(x.reason)));
  const deep = mk(T, "deep2", "a", "b", "c", "d");
  const r2 = buildContainPlan(base({ readPaths: [join(T, "deep2")], envScanMaxDepth: 2 }));
  assert.ok(!has(r2.args, "--ro-bind", join(T, "deep2")), "depth cap also fails closed");
  assert.throws(() => buildContainPlan(base({ envScanMaxEntries: 3 })), ContainRefused, "the engine/checkout cannot be bound unscanned");
});
