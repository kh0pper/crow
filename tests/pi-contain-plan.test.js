// Queue item 19, step 2a: the "contain" tier's mount plan. Pure argv tests:
// no bwrap runs here (tests/pi-contain.test.js runs real sandboxes).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildContainPlan, containSelected, containExcluded, containExcludeIds, containExemptedBots,
  _resetPiContainExcludeWarningsForTest, ContainRefused, neverBound, installedBundleIds,
  ensureContainMountPoints, ensureContainOwnWorldRoot, containOwnWorldRoot, RESERVED_DATA_ENTRIES, RESERVED_DATA_FILES, isReservedDataEntry,
} from "../scripts/pi-bots/pi_contain.mjs";
import { wrapPiSpawn } from "../scripts/pi-bots/pi_sandbox.mjs";
import { RESERVED_DATA_NAMES } from "../servers/gateway/compose-guard.js";

const T = realpathSync(mkdtempSync(join(tmpdir(), "crow-contain-plan-")));
after(() => rmSync(T, { recursive: true, force: true }));
const REPO = join(dirname(new URL(import.meta.url).pathname), "..");

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
// The Google Cloud CLI's credential folder: operator secrets, never bound.
const gcloud = mk(H, ".config", "gcloud");
writeFileSync(join(gcloud, "application_default_credentials.json"), "{}");
mk(gcloud, "legacy_credentials");
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

test("CROW_PI_CONTAIN_EXCLUDE: the listed bot gets the default tier, every other bot stays contained", () => {
  const env = { CROW_PI_SANDBOX: "contain", CROW_PI_CONTAIN_EXCLUDE: "test-bot, other.v2" };
  assert.equal(containSelected(env, "test-bot"), false, "the exempt bot is not contained under =contain");
  assert.equal(containSelected(env, "other.v2"), false);
  assert.equal(containSelected(env, "real-bot"), true, "the switch still contains every other bot");
  assert.equal(containSelected(env, null), true, "a spawn with no bot id is not an exemption");
  // An exemption wins over an explicit list too: the operator's exemption is a refusal to contain.
  assert.equal(containSelected({ CROW_PI_CONTAIN_BOTS: "a,b", CROW_PI_CONTAIN_EXCLUDE: "a" }, "a"), false);
  assert.equal(containSelected({ CROW_PI_CONTAIN_BOTS: "a,b", CROW_PI_CONTAIN_EXCLUDE: "a" }, "b"), true);
  assert.equal(containSelected({ CROW_PI_SANDBOX: "off", CROW_PI_CONTAIN_EXCLUDE: "a" }, "a"), false, "off is still off");
  assert.equal(containExcluded(env, "test-bot"), true);
  assert.equal(containExcluded(env, "nobody"), false);
  assert.equal(containExcluded(env, null), false);
  // An exemption with nothing to exempt is not reported as one: a leftover
  // CROW_PI_CONTAIN_EXCLUDE beside the default tier must not label a normal bot
  // "excluded by the operator".
  assert.equal(containExcluded({ CROW_PI_CONTAIN_EXCLUDE: "a" }, "a"), false);
  assert.equal(containExcluded({ CROW_PI_CONTAIN_BOTS: "b", CROW_PI_CONTAIN_EXCLUDE: "a" }, "a"), false);
});

test("CROW_PI_CONTAIN_EXCLUDE: malformed entries are ignored with a log line, and exempt nothing", () => {
  _resetPiContainExcludeWarningsForTest();
  const malformed = "../etc/passwd";
  const entries = [];
  const orig = console.error;
  console.error = (...a) => { entries.push(a.join(" ")); };
  try {
    const parsed = containExcludeIds({ CROW_PI_CONTAIN_EXCLUDE: ` ${malformed} , has space, -leading, good-bot ,,good-bot` });
    assert.deepEqual(parsed.ids, ["good-bot"], "only the bot ids survive (duplicates collapse)");
    assert.deepEqual(parsed.ignored, [malformed, "has space", "-leading"]);
    assert.equal(containSelected({ CROW_PI_SANDBOX: "contain", CROW_PI_CONTAIN_EXCLUDE: malformed }, "../etc/passwd"), true,
      "a path in the exclude list exempts nothing");
    assert.equal(containSelected({ CROW_PI_SANDBOX: "contain", CROW_PI_CONTAIN_EXCLUDE: "has space" }, "has space"),
      true, "a malformed token cannot be matched as a bot id");
  } finally {
    console.error = orig;
  }
  assert.equal(entries.filter((l) => l.includes(malformed)).length, 1, "one log line per bad token, not one per check");
  assert.ok(entries.some((l) => l.includes("[pi-contain] CROW_PI_CONTAIN_EXCLUDE: ignoring")), entries.join(" | "));
  assert.ok(entries.every((l) => !l.includes("good-bot")), "a valid id is never logged as ignored");
  _resetPiContainExcludeWarningsForTest();
});

test("containExemptedBots: only the exemptions containment would otherwise have covered are reported", () => {
  assert.deepEqual(containExemptedBots({ CROW_PI_SANDBOX: "contain", CROW_PI_CONTAIN_EXCLUDE: "a,b" }), ["a", "b"]);
  assert.deepEqual(containExemptedBots({ CROW_PI_CONTAIN_BOTS: "a,c", CROW_PI_CONTAIN_EXCLUDE: "a,b" }), ["a"],
    "under a list, only the overlap is really exempted");
  assert.deepEqual(containExemptedBots({ CROW_PI_CONTAIN_EXCLUDE: "a" }), [], "nothing selects containment: nothing is exempted");
  assert.deepEqual(containExemptedBots({ CROW_PI_SANDBOX: "off", CROW_PI_CONTAIN_EXCLUDE: "a" }), []);
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
  // The operator's env files are masked where they exist (a tmpfs needs a mount point; a CI
  // runner has no /etc/crow).
  if (existsSync("/etc/crow")) assert.ok(has(args, "--tmpfs", "/etc/crow"), "operator env files masked");
  else assert.ok(!has(args, "--tmpfs", "/etc/crow"), "nothing to mask where /etc/crow is absent");
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
  const ADCFILE = join(gcloud, "application_default_credentials.json");
  const { args, refused } = buildContainPlan(base({
    writePaths: [join(H, ".ssh"), otherInst, gcloud], readPaths: [join(H, ".claude"), join(H, ".gnupg", "x"), ADCFILE],
  }));
  for (const p of [join(H, ".ssh"), otherInst, join(H, ".claude"), gcloud, ADCFILE]) {
    assert.ok(!pairs(args).some((q) => (q[0] === "--bind" || q[0] === "--ro-bind") && q[1] === p), p + " not bound");
  }
  const reasons = refused.map((r) => r.path);
  for (const p of [join(H, ".ssh"), otherInst, join(H, ".claude")]) assert.ok(reasons.includes(p), p + " refused");
  // The gcloud folder EXISTS here, so this is the protected-path rule and not
  // the "does not exist" refusal.
  for (const p of [gcloud, ADCFILE]) {
    assert.ok(!pairs(args).some((q) => (q[0] === "--bind" || q[0] === "--ro-bind") && (q[1] === p || String(q[1]).startsWith(gcloud + "/"))), p + " not bound");
    const hit = refused.find((r) => r.path === p);
    assert.ok(hit, p + " refused");
    assert.match(hit.reason, /a protected path \(.*\.config\/gcloud\)$/, p + " is refused as a protected path");
  }
  assert.ok(neverBound(H).includes(gcloud), "~/.config/gcloud is in the never-bound list");
  // The whole home is an ancestor of <CROW_HOME>: a write path on it now
  // refuses the spawn (the Crow-home ruling), not just the bind.
  assert.throws(() => buildContainPlan(base({ writePaths: [H] })), ContainRefused);
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
  // dataDir: null — a bound data dir carries as many top-level entries as the instance has,
  // which would decide this cap instead of the policy path under test.
  const r = buildContainPlan(base({ dataDir: null, readPaths: [big], envScanMaxEntries: 25 }));
  assert.ok(!has(r.args, "--ro-bind", big), "not bound unscanned");
  assert.ok(r.refused.some((x) => x.path === big && /too large to scan/.test(x.reason)));
  const deep = mk(T, "deep2", "a", "b", "c", "d");
  const r2 = buildContainPlan(base({ dataDir: null, readPaths: [join(T, "deep2")], envScanMaxDepth: 2 }));
  assert.ok(!has(r2.args, "--ro-bind", join(T, "deep2")), "depth cap also fails closed");
  assert.throws(() => buildContainPlan(base({ envScanMaxEntries: 3 })), ContainRefused, "the engine/checkout cannot be bound unscanned");
});

// ---- The operator's ruling (2026-11-02): a data folder that IS the Crow
// home, and rw binds over the Crow home, are refused (never masked over) ----

const bindSources = (args) => pairs(args).filter((p) => p[0] === "--bind" && p.length >= 3).map((p) => p[1]);

test("the Crow home is never a read-write bind, and a data folder that is the Crow home is refused", () => {
  const CH = mk(T, "chome");            // stands in for <CROW_HOME>
  const chData = mk(CH, "data");
  writeFileSync(join(chData, "crow.db"), "");
  mk(CH, "secrets");
  const withHome = base({ crowHome: CH, dataDir: chData, botCacheDir: mk(CH, "bot-cache") });

  const { args } = buildContainPlan(withHome);
  const ancestors = [];
  for (let a = CH; a && a !== "/"; a = dirname(a)) ancestors.push(a);
  for (const src of bindSources(args)) {
    assert.notEqual(src, CH, "the Crow home is not a rw bind source");
    assert.notEqual(src, join(CH, "secrets"), "its secrets dir is not a rw bind source");
    assert.ok(!ancestors.includes(src), src + " is an ancestor of the Crow home and is not a rw bind source");
  }
  assert.ok(bindSources(args).includes(chData), "the data dir itself stays writable");

  // the Crow home, an ancestor of it, or its secrets dir as a policy write path
  // refuses the spawn, with the reason named
  for (const entry of [CH, dirname(CH), join(CH, "secrets")]) {
    assert.throws(() => buildContainPlan({ ...withHome, writePaths: [entry] }),
      (e) => e instanceof ContainRefused && /write_paths names .*Crow home/.test(e.message), String(entry));
  }
  assert.throws(() => buildContainPlan({ ...withHome, writePaths: ["/"] }), ContainRefused, "bypass mode stays refused");

  for (const dataDir of [CH, T]) {
    assert.throws(() => buildContainPlan({ ...withHome, dataDir }),
      (e) => e instanceof ContainRefused && e.message === "contain refused: the data folder is the Crow home", String(dataDir));
  }
});

// ---- fix round 1 (F1): co-hosted Crow homes are matched by RESOLVED path ----

test("a co-hosted home is never bound: a symlinked one inside $HOME or a declared one outside it", () => {
  // A co-host reached through a `$HOME/.crow-*` symlink: the NAME is inside
  // $HOME, the home itself is not. The scan resolves it.
  const realCo = mk(T, "co-house");
  mk(realCo, "secrets");
  const linkCo = join(H, ".crow-r4");
  symlinkSync(realCo, linkCo);
  // A co-host home declared outside $HOME (a unit/env-file declaration),
  // resolved on the spawner's side before it reaches the plan.
  const declared = mk(T, "srv", "crow-r5");
  mk(declared, "secrets");

  const cases = [
    [linkCo, {}],                        // the link path
    [realCo, {}],                        // its real path
    [declared, { otherHomes: [declared] }],
    [dirname(declared), { otherHomes: [declared] }], // an ancestor of it
  ];
  for (const [p, over] of cases) {
    for (const list of ["readPaths", "writePaths"]) {
      const { args, refused } = buildContainPlan(base({ [list]: [p], ...over }));
      for (const src of [linkCo, realCo, declared]) {
        assert.ok(!has(args, "--ro-bind", src), list + " " + p + ": " + src + " is not bound read-only");
        assert.ok(!has(args, "--bind", src), list + " " + p + ": " + src + " is not bound writable");
      }
      const hit = refused.find((r) => r.path === p);
      assert.ok(hit, list + " " + p + " is refused");
      assert.equal(hit.reason, "another Crow instance's home", "the reason names only the co-host rule");
    }
  }
});

// ---- contain-tier blockers (2026-11-19 inventory): B1, B2, B4, B5 ----

/** The `[flag, src, dest]` op for one exact triple (the `pairs` helper above
 *  does not know `--remount-ro`, so these tests inspect the raw argv too). */
const opAt = (args, flag, src, dst) => args.findIndex((a, i) => a === flag && args[i + 1] === src && args[i + 2] === dst);
const remounts = (args, p) => args.findIndex((a, i) => a === "--remount-ro" && args[i + 1] === p);

// B1 — crow.db / tasks.db / the knowledge-base DBs are named in a Crow stdio
// MCP block's env, and the env-file read-only bind used to land ON TOP of the
// read-write data dir: every contained bot found its own database read-only
// ("attempt to write a readonly database").
test("B1: an MCP env file a writable bind already covers gets NO read-only bind on top", () => {
  const d = mk(T, "b1", "data");
  writeFileSync(join(d, "crow.db"), "");
  writeFileSync(join(d, "tasks.db"), "");
  const writable = mk(T, "b1", "out");
  writeFileSync(join(writable, "state.json"), "{}");
  const outside = join(T, "b1", "token.json");
  writeFileSync(outside, "{}");
  const sshFile = join(H, ".ssh", "config");
  writeFileSync(sshFile, "");
  const { args, refused } = buildContainPlan(base({
    dataDir: d, writePaths: [writable],
    mcpServers: [{
      command: "node", args: [join(addon, "server")], cwd: addon,
      env: { CROW_DB_PATH: join(d, "crow.db"), CROW_TASKS_DB_PATH: join(d, "tasks.db"), KB_MCP_DB_PATH: join(d, "crow.db"),
        STATE_FILE: join(writable, "state.json"), TOKEN_FILE: outside, SSH_FILE: sshFile },
    }],
  }));
  assert.ok(has(args, "--bind", d), "the data dir is the writable bind");
  for (const f of [join(d, "crow.db"), join(d, "tasks.db")]) {
    assert.ok(!has(args, "--ro-bind", f), f + " is not re-bound read-only over the writable data dir");
  }
  assert.ok(!has(args, "--ro-bind", join(writable, "state.json")), "a file inside a write_paths dir is covered too");
  assert.ok(has(args, "--ro-bind", outside), "a file outside every writable bind is still read-only");
  // The never-bound check is untouched: a file there is refused, covered or not.
  assert.ok(!has(args, "--ro-bind", sshFile));
  const hit = refused.find((r) => r.path === sshFile);
  assert.ok(hit && /protected path/.test(hit.reason), JSON.stringify(refused));
});

// B2 — a launcher in a folder that is never bound wholesale: bind the FILE.
test("B2: a uv launcher under ~/.local is bound as the file (never ~/.local), plus the venv and cache", () => {
  const HU = mk(T, "uvhome", "alice");
  const uvBin = join(mk(HU, ".local", "bin"), "uv");
  writeFileSync(uvBin, "#!/bin/sh\n");
  chmodSync(uvBin, 0o755);
  mk(HU, ".local", "share", "systemd");        // why ~/.local itself is refused
  const ch = mk(HU, ".crow");
  const dd = mk(ch, "data");
  // The uv allowlist only names an INSTALLED bundle (installed.json).
  writeFileSync(join(ch, "installed.json"), JSON.stringify([{ id: "google-workspace", version: "1.0.0" }]));
  const venv = mk(dd, "google-workspace", ".venv");
  const cache = mk(dd, "google-workspace", ".cache", "uv");
  const sessionUv = mk(T, "uvsess");
  const { args, refused } = buildContainPlan(base({
    home: HU, crowHome: ch, dataDir: dd, botCacheDir: mk(ch, "bot-cache"), sessionDir: sessionUv, cwd: sessionUv,
    mcpServers: [{
      command: uvBin, args: ["run", "--quiet", "--frozen", "google-workspace-mcp"],
      cwd: mk(ch, "bundles", "google-workspace"),
      env: { UV_PROJECT_ENVIRONMENT: venv, UV_CACHE_DIR: cache, UV_NO_CACHE: "1" },
    }],
  }));
  assert.ok(has(args, "--ro-bind", uvBin), "exactly the executable file");
  assert.ok(!has(args, "--ro-bind", join(HU, ".local")), "~/.local is never bound (it holds the never-bound systemd dir)");
  assert.ok(!has(args, "--ro-bind", join(HU, ".local", "bin")), "never its parent folders");
  // The install root's own refusal is not logged when the file fallback binds:
  // one line per command that ends up NOWHERE, not one per candidate shape.
  assert.ok(!refused.some((r) => r.path === join(HU, ".local")), "the refused install root is not reported when the file bound: " + JSON.stringify(refused));
  assert.ok(has(args, "--ro-bind", venv), "the project venv is read-only reachable");
  assert.ok(has(args, "--ro-bind", cache), "a cache dir the block names is read-only reachable");
  const ps = pairs(args);
  const iMask = ps.findIndex((q) => q[0] === "--tmpfs" && q[1] === join(dd, "google-workspace"));
  const iVenv = ps.findIndex((q) => q[0] === "--ro-bind" && q[1] === venv);
  assert.ok(iMask >= 0 && iVenv > iMask, "the venv bind comes AFTER the mask on the folder holding it");
});

test("B2: a symlinked launcher is mounted at the path pi execs, from its realpath target", () => {
  const HU = mk(T, "uvlink", "alice");
  const uvReal = join(mk(HU, ".local", "share", "uv", "bin"), "uv");
  writeFileSync(uvReal, "#!/bin/sh\n");
  chmodSync(uvReal, 0o755);
  const uvLink = join(mk(HU, ".local", "bin"), "uv");
  symlinkSync(uvReal, uvLink);
  const ch = mk(HU, ".crow");
  const dd = mk(ch, "data");
  const sessionL = mk(T, "uvlinksess");
  const { args } = buildContainPlan(base({
    home: HU, crowHome: ch, dataDir: dd, botCacheDir: mk(ch, "bot-cache"), sessionDir: sessionL, cwd: sessionL,
    mcpServers: [{ command: uvLink, args: ["run", "srv"], cwd: mk(ch, "bundles", "x") }],
  }));
  assert.ok(opAt(args, "--ro-bind", uvReal, uvLink) >= 0, "the resolved file is mounted at the lexical path");
  assert.ok(!has(args, "--ro-bind", join(HU, ".local", "bin")), "its parent folder is not bound");
});

test("B2: a bundle uv entry with no UV_PROJECT_ENVIRONMENT uses <data>/<bundle id>/.venv", () => {
  const ch = mk(T, "b2b", "crow");
  const dd = mk(ch, "data");
  writeFileSync(join(ch, "installed.json"), JSON.stringify([{ id: "knowledge-base-mcp", version: "1.2.0" }]));
  const venv = mk(dd, "knowledge-base-mcp", ".venv");
  const bundles = mk(ch, "bundles", "knowledge-base-mcp");
  const sessionB = mk(T, "b2bsess");
  const { args } = buildContainPlan(base({
    crowHome: ch, dataDir: dd, botCacheDir: mk(ch, "bot-cache"), sessionDir: sessionB, cwd: sessionB,
    mcpServers: [{ command: "uv", args: ["run", "kb-mcp"], cwd: bundles }],
  }));
  assert.ok(has(args, "--ro-bind", venv), "the bundle's own venv folder");
});

test("B2: an MCP command under a never-bound path (~/.ssh) is still refused", () => {
  const cmd = join(H, ".ssh", "srv");
  writeFileSync(cmd, "");
  const { args, refused } = buildContainPlan(base({ mcpServers: [{ command: cmd, cwd: addon }] }));
  assert.ok(!pairs(args).some((q) => (q[0] === "--ro-bind" || q[0] === "--bind") && (q[1] === cmd || q[2] === cmd || q[1] === join(H, ".ssh"))));
  assert.ok(refused.some((r) => r.path === cmd && /protected path/.test(r.reason)), JSON.stringify(refused));
});

// B4 — a masked data folder is a read-only empty mount: a write into another
// project's folder must FAIL, not be swallowed by a scratch tmpfs.
test("B4: every masked data folder is an empty mount remounted READ-ONLY, after any bind inside it", () => {
  const d = mk(T, "b4", "data");
  const mine = mk(d, "projects", "mine", "workspace");
  mk(d, "projects", "theirs");
  mk(d, "backups");
  const bundle = mk(d, "google-workspace");
  const token = join(bundle, "token.json");
  writeFileSync(token, "{}");
  const { args } = buildContainPlan(base({
    dataDir: d, workspaceDir: mine,
    mcpServers: [{ command: "node", cwd: addon, env: { GOOGLE_TOKEN_FILE: token } }],
  }));
  for (const p of [join(d, "projects", "theirs"), join(d, "backups"), bundle]) {
    assert.ok(has(args, "--tmpfs", p), p + " masked");
    assert.ok(remounts(args, p) >= 0, p + " remounted read-only");
  }
  // A read-only FILE bind inside a mask (an MCP server's token) still needs its
  // mount point: it is mounted while the tmpfs is writable, and the remount
  // comes last.
  const iTok = opAt(args, "--ro-bind", token, token);
  const iBundle = remounts(args, bundle);
  assert.ok(iTok > 0, "the token file is bound");
  assert.ok(iTok < iBundle, "its mount point is created before the mask is remounted read-only");
  // A file mask is still /dev/null (a write there fails at open).
  writeFileSync(join(d, "identity.json"), "{}");
  const r2 = buildContainPlan(base({ dataDir: d }));
  assert.ok(has(r2.args, "--ro-bind", "/dev/null", join(d, "identity.json")));
});

// B5 — the legacy self-authoring staging dir under <crowHome>/pi-bots/<id> is
// the bot's OWN state and the path the Bot Builder review UI scans, so the
// bot's own world root is writable under contain (and nothing beside it).
test("B5: the bot's own pi-bots/<id> folder is writable; another bot's is still refused", () => {
  const stage = mk(crowHome, "pi-bots", "hank", "proposed-skills");
  const other = mk(crowHome, "pi-bots", "other", "proposed-skills");
  const ownRoot = join(crowHome, "pi-bots", "hank");
  const { args, refused } = buildContainPlan(base({ botStateDir: ownRoot, writePaths: [stage, other] }));
  assert.ok(has(args, "--bind", stage), "the bot's own staging dir is writable");
  assert.ok(!has(args, "--bind", other), "another bot's folder is not");
  assert.ok(refused.some((r) => r.path === other && /hidden entry/.test(r.reason)), JSON.stringify(refused));
  // Without the input (or with one outside <crowHome>/pi-bots) the hidden-entry
  // rule stands unchanged: the staging dir is dropped, not silently widened.
  const noInput = buildContainPlan(base({ writePaths: [stage] }));
  assert.ok(!has(noInput.args, "--bind", stage));
  assert.ok(noInput.refused.some((r) => r.path === stage && /hidden entry/.test(r.reason)));
  const elsewhere = mk(crowHome, "state", "hank");
  const notABotRoot = buildContainPlan(base({ botStateDir: join(crowHome, "state"), writePaths: [elsewhere] }));
  assert.ok(!has(notABotRoot.args, "--bind", elsewhere), "a world root outside pi-bots/ widens nothing");
});

// ---- B13 (contain-tier finding, 2026-11-19): the bot's OWN world root must EXIST before the plan,
// or it is dropped and the sandbox's empty tmpfs $HOME swallows the write (travel-agent's
// contain-smoke.txt: the write "succeeded" and vanished, where the loose tier creates the folder).
// The SPAWNER makes it (pi_contain.mjs ensureContainOwnWorldRoot), strictly inside this instance's
// <crowHome>/pi-bots and never through a symlink; anything else stays dropped, and the plan now
// NAMES a dropped writable path (`droppedWrites`) so the containment status can say so.

/** The plan inputs for an own-root case, on its own scratch Crow home. */
const ownRootBase = (ch, over = {}) => base({
  crowHome: ch, dataDir: mk(ch, "data"), botCacheDir: mk(ch, "bot-cache"), ...over,
});

test("B13: a missing own world root inside pi-bots is created (0700, this uid) and bound writable", () => {
  const ch = mk(T, "b13", "crow");
  const ownRoot = join(ch, "pi-bots", "travel-agent");
  assert.equal(existsSync(ownRoot), false, "the fixture starts with no own root: the travel-agent case");
  const made = ensureContainOwnWorldRoot(ownRoot, { crowHome: ch });
  assert.equal(made, ownRoot);
  const st = statSync(ownRoot);
  assert.equal(st.isDirectory(), true);
  assert.equal(st.mode & 0o777, 0o700, "0700, the shape every folder this spawner makes for a sandbox has");
  assert.equal(st.uid, process.getuid());
  const { args, droppedWrites } = buildContainPlan(ownRootBase(ch, {
    botStateDir: ownRoot, writePaths: [ownRoot, join(ownRoot, "proposed-skills")],
  }));
  assert.ok(has(args, "--bind", ownRoot), "the root is a writable bind");
  assert.deepEqual(droppedWrites, [], "neither the root nor a missing child UNDER a bound root is dropped");
});

test("B13b: a symlinked own root pointing outside pi-bots is neither created nor bound", () => {
  const ch = mk(T, "b13b", "crow");
  const botsRoot = mk(ch, "pi-bots");
  const outside = mk(T, "b13b", "outside");
  const link = join(botsRoot, "wanderer");
  symlinkSync(outside, link);
  assert.equal(ensureContainOwnWorldRoot(link, { crowHome: ch }), null, "nothing is created through the link");
  assert.deepEqual(readdirSync(outside), [], "and nothing appears at what it names");
  const missing = join(link, "proposed-skills");
  const { args, refused, droppedWrites } = buildContainPlan(ownRootBase(ch, { botStateDir: link, writePaths: [missing] }));
  assert.ok(!has(args, "--bind", outside), "what the link names is not bound");
  assert.ok(!has(args, "--bind", link), "nor the link path");
  assert.ok(refused.some((r) => r.path === missing && /does not exist/.test(r.reason)),
    "the write path is refused: " + JSON.stringify(refused));
  assert.deepEqual(droppedWrites, [missing], "and the drop is named");
});

test("B13c: a missing write_path outside pi-bots is never created, and the plan reports the drop", () => {
  const ch = mk(T, "b13c", "crow");
  const ownRoot = mk(ch, "pi-bots", "smith");
  const missing = join(T, "b13c", "work", "not-yet");
  const { args, droppedWrites } = buildContainPlan(ownRootBase(ch, { botStateDir: ownRoot, writePaths: [missing] }));
  assert.equal(existsSync(missing), false, "building a plan creates nothing");
  assert.equal(ensureContainOwnWorldRoot(missing, { crowHome: ch }), null, "the spawner creates nothing outside pi-bots");
  assert.equal(existsSync(missing), false, "an arbitrary write path is never created");
  assert.ok(!has(args, "--bind", missing));
  assert.deepEqual(droppedWrites, [missing], "the drop is recorded, so the containment status can name it");
  // A configured bot path (session dir / cwd) that is gone is reported the same way, once.
  const gone = join(T, "b13c", "session-gone");
  const r2 = buildContainPlan(ownRootBase(ch, { botStateDir: ownRoot, sessionDir: gone, cwd: gone }));
  assert.equal(existsSync(gone), false);
  assert.deepEqual(r2.droppedWrites, [gone], "deduped, and it is the path the operator configured");
});

test("B13d: an existing own world root is left exactly as it is", () => {
  const ch = mk(T, "b13d", "crow");
  const ownRoot = mk(ch, "pi-bots", "keeper");
  writeFileSync(join(ownRoot, "keep.txt"), "keep");
  chmodSync(ownRoot, 0o755);
  const before = statSync(ownRoot);
  assert.equal(ensureContainOwnWorldRoot(ownRoot, { crowHome: ch }), null, "nothing to create");
  const after = statSync(ownRoot);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o755, "the mode is not rewritten");
  assert.equal(readFileSync(join(ownRoot, "keep.txt"), "utf8"), "keep");
  const { args } = buildContainPlan(ownRootBase(ch, { botStateDir: ownRoot, writePaths: [ownRoot] }));
  assert.ok(has(args, "--bind", ownRoot), "and the plan binds it as before");
});

test("B13e: the spawner creates a missing own world root BEFORE it builds the plan", () => {
  const ch = mk(T, "b13e", "crow");
  const ownRoot = join(ch, "pi-bots", "travel-agent");
  assert.equal(existsSync(ownRoot), false);
  const saved = { bots: process.env.CROW_PI_CONTAIN_BOTS, sb: process.env.CROW_PI_SANDBOX };
  process.env.CROW_PI_CONTAIN_BOTS = "travel-agent";
  process.env.CROW_PI_SANDBOX = "contain";
  try {
    const launch = wrapPiSpawn(process.execPath, ["-e", ""], {
      env: {}, botId: "travel-agent", probe: { ok: true, pidns: true, bwrap: "/bin/true" },
      contain: ownRootBase(ch, { botStateDir: ownRoot, writePaths: [ownRoot] }),
    });
    assert.equal(existsSync(ownRoot), true, "the spawner made the root before bwrap ran");
    assert.equal(statSync(ownRoot).mode & 0o777, 0o700);
    assert.ok(has(launch.args, "--bind", ownRoot), "and the plan bound it writable");
    assert.equal(launch.ownWorldRoot, ownRoot);
    assert.deepEqual(launch.droppedWrites, []);
  } finally {
    if (saved.bots === undefined) delete process.env.CROW_PI_CONTAIN_BOTS; else process.env.CROW_PI_CONTAIN_BOTS = saved.bots;
    if (saved.sb === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = saved.sb;
  }
});

// The id the own root is derived from is the SPAWNER's, never one a def names: a def is
// bot-writable (crow.db, which holds the defs, is bound read-write into every contained bot), so a
// def pointing its session_dir at another bot's folder must not make this spawner CREATE it, nor
// make that folder "this bot's own" in the plan.
test("B13f: a def's session_dir never decides the own root — the spawner's bot id does", () => {
  // A scratch Crow home shaped like a real one (a dot folder of $HOME): the hidden-entry rule the
  // plan applies to policy write paths is about that shape.
  const ch = mk(H, ".crow-b13f");
  const theirs = join(ch, "pi-bots", "victim");
  // A def that names another bot: the exact shape a bot could write into its own definition.
  const def = { bot_id: "victim", session_dir: theirs };
  assert.equal(containOwnWorldRoot({ crowHome: ch, botId: "attacker", def }), join(ch, "pi-bots", "attacker"),
    "the root is <crowHome>/pi-bots/<the id the spawner was given>");
  assert.equal(containOwnWorldRoot({ crowHome: ch, botId: "../victim" }), null, "a path is not a bot id: no folder is derived");
  assert.equal(containOwnWorldRoot({ crowHome: ch, botId: "Server Name" }), null);
  assert.equal(containOwnWorldRoot({ crowHome: ch, botId: null }), null, "no trusted id, no derived folder");
  assert.equal(containOwnWorldRoot({ crowHome: "", botId: "attacker" }), null);

  // What the spawner creates is exactly that root: the folder the def names is untouched.
  const own = containOwnWorldRoot({ crowHome: ch, botId: "attacker" });
  assert.equal(ensureContainOwnWorldRoot(own, { crowHome: ch }), own);
  assert.equal(existsSync(join(ch, "pi-bots", "attacker")), true);
  assert.equal(existsSync(theirs), false, "a def pointing session_dir at another bot's missing root creates nothing");

  // … and the plan does not treat the other bot's folder as own: a write path there is refused by
  // the ordinary hidden-entry rule, not widened (the folder exists here — a def naming it must
  // never be what makes it, which is what the assertion above just proved).
  const stage = mk(ch, "pi-bots", "victim", "proposed-skills");
  const plan = buildContainPlan(ownRootBase(ch, { botStateDir: own, writePaths: [stage] }));
  assert.ok(!has(plan.args, "--bind", stage), "another bot's folder is never bound as the bot's own world");
  assert.ok(plan.refused.some((r) => r.path === stage && /hidden entry/.test(r.reason)), JSON.stringify(plan.refused));

  // The wiring itself lives in bridge.mjs's containInputs (not exported): read it, because the
  // whole point is that a def is not consulted when the own root is derived.
  const src = readFileSync(join(REPO, "scripts", "pi-bots", "bridge.mjs"), "utf8");
  const lines = src.split("\n").filter((l) => /\bbotStateDir\b/.test(l));
  assert.ok(lines.length > 0, "bridge.mjs still carries the own-root input");
  assert.ok(lines.every((l) => !l.includes("session_dir")), "no botStateDir line reads the def: " + lines.join(" | "));
  assert.match(src, /botStateDir\s*=\s*ownWorldRoot/, "the plan's own root is the derived one: " + lines.join(" | "));
  assert.match(src, /containOwnWorldRoot\(\{\s*crowHome,\s*botId:\s*opts\.botId\s*\}\)/,
    "derived from <crowHome> and THIS spawner's bot id only");
});

// A Crow home (or an ancestor of it) is often a SYMLINK. The own root then has to be resolved
// through the home's realpath before the strictly-inside check, or botsRoot (real) and the target
// (unresolved) never match and NOTHING is created.
test("B13g: a symlinked Crow home still gets its bot's own root, under the REAL pi-bots", () => {
  const realHome = mk(T, "b13g", "real-crow");
  const linkedHome = join(T, "b13g", "linked-crow");
  symlinkSync(realHome, linkedHome);
  const ownRoot = join(linkedHome, "pi-bots", "travel-agent");
  const made = ensureContainOwnWorldRoot(ownRoot, { crowHome: linkedHome });
  assert.equal(made, join(realHome, "pi-bots", "travel-agent"), "created under the REAL pi-bots");
  const st = statSync(made);
  assert.ok(st.isDirectory() && (st.mode & 0o777) === 0o700);
  assert.equal(st.uid, process.getuid());
  assert.equal(existsSync(ownRoot), true, "reachable through the linked home as well");
  assert.deepEqual(readdirSync(join(realHome, "pi-bots")), ["travel-agent"], "exactly the bot's own folder");
  // The plan over the same linked home binds it at its resolved path and drops nothing.
  const { args, droppedWrites } = buildContainPlan(ownRootBase(linkedHome, { botStateDir: ownRoot, writePaths: [ownRoot] }));
  assert.ok(has(args, "--bind", made), "bound at the resolved path");
  assert.deepEqual(droppedWrites, []);
  // The real spelling of the same home works too (a caller holding the resolved CROW_HOME).
  assert.equal(ensureContainOwnWorldRoot(join(realHome, "pi-bots", "second"), { crowHome: realHome }),
    join(realHome, "pi-bots", "second"));
});

// Every link on the way is refused rather than followed: a symlinked pi-bots (the whole tree), a
// symlinked intermediate component of a nested own path, the pi-bots root itself, and a `..`.
test("B13h: a symlinked pi-bots, a symlinked component, the pi-bots root and a `..` are refused", () => {
  // pi-bots itself is a symlink: not this instance's own tree, so nothing is created through it.
  const ch1 = mk(T, "b13h", "linked-bots");
  const outside = mk(T, "b13h", "outside");
  symlinkSync(outside, join(ch1, "pi-bots"));
  assert.equal(ensureContainOwnWorldRoot(join(ch1, "pi-bots", "travel-agent"), { crowHome: ch1 }), null);
  assert.deepEqual(readdirSync(outside), [], "nothing appears at what the link names");
  assert.equal(existsSync(join(ch1, "pi-bots", "travel-agent")), false);

  // A symlinked INTERMEDIATE component of a nested own path (its target is INSIDE pi-bots, so the
  // strictly-inside check alone would accept it): the walk sees the link and refuses.
  const ch2 = mk(T, "b13h2", "crow");
  const peer = mk(ch2, "pi-bots", "peer-bot");
  symlinkSync(peer, join(mk(ch2, "pi-bots"), "linked"));
  const logs = [];
  const origError = console.error;
  console.error = (...a) => { logs.push(a.join(" ")); };
  try {
    assert.equal(ensureContainOwnWorldRoot(join(ch2, "pi-bots", "linked", "deep", "root"), { crowHome: ch2 }), null);
  } finally { console.error = origError; }
  assert.deepEqual(readdirSync(peer), [], "the link's target is untouched");
  assert.equal(existsSync(join(ch2, "pi-bots", "linked", "deep")), false, "nothing is created through the link");
  assert.ok(logs.some((l) => /is a symlink/.test(l)), logs.join(" | "));

  // The pi-bots root itself is never a bot's own root.
  const ch3 = mk(T, "b13h3", "crow");
  assert.equal(ensureContainOwnWorldRoot(join(ch3, "pi-bots"), { crowHome: ch3 }), null);
  assert.equal(existsSync(join(ch3, "pi-bots")), false, "nothing is created for the root itself");

  // A `..` traversal is refused, even one that resolves back inside pi-bots (join() would have
  // normalised it away, so the spellings are built by hand).
  const ch4 = mk(T, "b13h4", "crow");
  assert.equal(ensureContainOwnWorldRoot(ch4 + "/pi-bots/../pi-bots/bot", { crowHome: ch4 }), null);
  assert.equal(ensureContainOwnWorldRoot(ch4 + "/pi-bots/x/../../escape", { crowHome: ch4 }), null);
  assert.equal(existsSync(join(ch4, "pi-bots")), false, "and nothing is created");
});

// ---- contain-tier blockers, fix round 2: B6 (uv binds), B7 (command files) ----

// B6 — the uv venv/cache bind used to accept ANY existing directory under the
// data dir (a DENYLIST of top-level names plus a venv shape), so a block could
// re-expose another bundle's venv, or a `.venv` planted inside another project's
// data area, over the mask that hides them. It is now an ALLOWLIST: only the
// block's OWN bundle folder, whose id comes from the block's cwd (or absolute
// command) resolved under <crowHome>/bundles/<id>.
test("B6: a uv venv is bound only at the block's OWN <data>/<bundle id>/.venv", () => {
  const ch = mk(T, "b6", "crow");
  const d = mk(ch, "data");
  const own = mk(ch, "bundles", "google-workspace");
  mk(ch, "bundles", "other-bundle");
  // The installer's records: only an id listed here may name a data folder.
  writeFileSync(join(ch, "installed.json"), JSON.stringify(["google-workspace", "other-bundle", "linked-bundle"]));
  const ownVenv = mk(d, "google-workspace", ".venv");   // the installer's shape
  const otherVenv = mk(d, "other-bundle", ".venv");     // another bundle's venv
  const planted = mk(d, "projects", "x", ".venv");      // a .venv planted in a project folder
  const sessionB6 = mk(T, "b6", "session");

  const planFor = (block) => buildContainPlan(base({
    crowHome: ch, dataDir: d, sessionDir: sessionB6, cwd: sessionB6,
    mcpServers: [{ args: ["run", "srv"], ...block }],
  }));
  const uv = (env, cwd = own) => planFor({ command: "uv", cwd, env });

  // The block's own bundle venv: bound (its bind sorts after the folder's mask).
  const ok = uv({ UV_PROJECT_ENVIRONMENT: ownVenv });
  assert.ok(has(ok.args, "--ro-bind", ownVenv), "the block's own bundle venv is bound read-only");
  assert.ok(!ok.refused.some((r) => r.path === ownVenv), JSON.stringify(ok.refused));

  // The bundle id also comes from an ABSOLUTE COMMAND under
  // <crowHome>/bundles/<id>, so a launcher installed there keeps its venv.
  const bundledUv = join(mk(own, "bin"), "uv");
  writeFileSync(bundledUv, "#!/bin/sh\n");
  chmodSync(bundledUv, 0o755);
  const byCommand = planFor({ command: bundledUv, cwd: sessionB6 });
  assert.ok(has(byCommand.args, "--ro-bind", ownVenv), "the id derived from the command binds the same venv");

  // Another bundle's venv: refused, with the allowlist named.
  const other = uv({ UV_PROJECT_ENVIRONMENT: otherVenv });
  assert.ok(!has(other.args, "--ro-bind", otherVenv), "another bundle's venv is not bound");
  assert.ok(other.refused.some((r) => r.path === otherVenv && /OWN <data>\/google-workspace\/\.venv/.test(r.reason)),
    "another bundle's venv is refused: " + JSON.stringify(other.refused));

  // A `.venv` planted under <data>/projects/<x>: refused the same way.
  const projects = uv({ UV_PROJECT_ENVIRONMENT: planted });
  assert.ok(!has(projects.args, "--ro-bind", planted), "a .venv under projects/ is not bound");
  assert.ok(projects.refused.some((r) => r.path === planted && /OWN <data>\/google-workspace\/\.venv/.test(r.reason)),
    "a .venv under projects/ is refused: " + JSON.stringify(projects.refused));

  // A venv at the allowlisted path that is a SYMLINK elsewhere: the realpath is
  // what must equal <data>/<bundle id>/.venv, so neither side is bound.
  const elsewhere = mk(T, "b6", "elsewhere-venv");
  const linkedBundle = mk(ch, "bundles", "linked-bundle");
  const linkedVenv = join(mk(d, "linked-bundle"), ".venv");
  symlinkSync(elsewhere, linkedVenv);
  const linked = planFor({ command: "uv", cwd: linkedBundle, env: { UV_PROJECT_ENVIRONMENT: linkedVenv } });
  assert.ok(!has(linked.args, "--ro-bind", linkedVenv), "the symlinked venv path is not bound");
  assert.ok(!has(linked.args, "--ro-bind", elsewhere), "nor is what it resolves to");
  assert.ok(linked.refused.some((r) => r.path === linkedVenv && /OWN <data>\/linked-bundle\/\.venv/.test(r.reason)),
    "a symlink resolving elsewhere is refused: " + JSON.stringify(linked.refused));

  // No derivable bundle id (a cwd outside <crowHome>/bundles): nothing out of
  // the data dir is bound, and the refusal says why.
  const noId = uv({ UV_PROJECT_ENVIRONMENT: ownVenv }, sessionB6);
  assert.ok(!has(noId.args, "--ro-bind", ownVenv), "no bundle id means no venv bind");
  assert.ok(noId.refused.some((r) => r.path === ownVenv && /no derivable bundle id/.test(r.reason)),
    "a block with no bundle id is refused: " + JSON.stringify(noId.refused));
});

test("B6: a uv cache is bound only inside the block's OWN bundle data folder", () => {
  const ch = mk(T, "b6c", "crow");
  const d = mk(ch, "data");
  const own = mk(ch, "bundles", "google-workspace");
  mk(ch, "bundles", "other-bundle");
  writeFileSync(join(ch, "installed.json"), JSON.stringify(["google-workspace", "other-bundle"]));
  const sessionB6c = mk(T, "b6c", "session");
  const ownCache = mk(d, "google-workspace", ".cache", "uv");
  const peerCache = mk(d, "other-bundle", ".cache", "uv");  // another bundle's folder
  const sharedCache = mk(d, "uv-cache");                     // directly in the data dir
  const projectCache = mk(d, "projects", "x", "uv");         // another project's folder

  const cacheIn = (cache, cwd = own) => buildContainPlan(base({
    crowHome: ch, dataDir: d, sessionDir: sessionB6c, cwd: sessionB6c,
    mcpServers: [{ command: "uv", args: ["run", "srv"], cwd, env: { UV_CACHE_DIR: cache } }],
  }));

  const ok = cacheIn(ownCache);
  assert.ok(has(ok.args, "--ro-bind", ownCache), "a cache inside the block's own bundle folder is bound");
  assert.ok(!ok.refused.some((r) => r.path === ownCache), JSON.stringify(ok.refused));

  for (const cache of [peerCache, sharedCache, projectCache]) {
    const { args, refused } = cacheIn(cache);
    assert.ok(!has(args, "--ro-bind", cache), cache + " is not bound as a uv cache");
    assert.ok(refused.some((r) => r.path === cache && /OWN <data>\/google-workspace\//.test(r.reason)),
      cache + " refused, not silently dropped: " + JSON.stringify(refused));
  }

  // No bundle id, no cache bind either.
  const noId = cacheIn(ownCache, sessionB6c);
  assert.ok(!has(noId.args, "--ro-bind", ownCache));
  assert.ok(noId.refused.some((r) => r.path === ownCache && /no derivable bundle id/.test(r.reason)), JSON.stringify(noId.refused));
});

// B7 — the command-file fallback used to bind ANY file, so a def naming
// ~/.npmrc had an operator setting mounted read-only as an "MCP command".
test("B7: a command file must be a regular executable and not a dotfile directly in $HOME", () => {
  const npmrc = join(H, ".npmrc");
  writeFileSync(npmrc, "registry=https://example.invalid/\n", { mode: 0o600 });
  const dataFile = join(H, "settings.json");          // a plain data file in the home
  writeFileSync(dataFile, "{}");
  const dotCmd = join(H, ".hidden-cmd");              // executable, but a hidden rc-shaped name
  writeFileSync(dotCmd, "#!/bin/sh\n");
  chmodSync(dotCmd, 0o755);
  // Not a PATH folder: the operator's own ~/bin and ~/.local/bin are judged separately
  // (B10, below), so an accepted file bind is a folder outside them.
  const okCmd = join(mk(H, "tools"), "mytool");
  writeFileSync(okCmd, "#!/bin/sh\n");
  chmodSync(okCmd, 0o755);

  const { args, refused } = buildContainPlan(base({ mcpServers: [
    { command: npmrc, cwd: addon }, { command: dataFile, cwd: addon }, { command: dotCmd, cwd: addon },
  ] }));
  for (const p of [npmrc, dataFile, dotCmd]) {
    assert.ok(!has(args, "--ro-bind", p), p + " is not bound");
    assert.ok(refused.some((r) => r.path === p && /executable regular file/.test(r.reason)), p + " refused: " + JSON.stringify(refused));
  }
  assert.ok(refused.some((r) => r.path === npmrc && /dotfile directly in the home/.test(r.reason)), "~/.npmrc is refused as a dotfile in $HOME");

  const ok = buildContainPlan(base({ mcpServers: [{ command: okCmd, cwd: addon }] }));
  assert.ok(has(ok.args, "--ro-bind", okCmd), "an executable outside the PATH folders is bound as the file (its install root is the home, never bound)");
  assert.ok(!ok.refused.some((r) => r.path === H), "the home's own refusal is not logged when the file binds: " + JSON.stringify(ok.refused));
});

// ---- contain-tier blockers, fix round 3: B8 (the uv bundle id is validated) ----

// B8 — bundleIdFor took the first path segment under <crowHome>/bundles as a bundle id and
// checked it against nothing: a block whose cwd was <crowHome>/bundles/projects/... derived
// the id "projects", and <data>/projects/<someone else's project> was then bound read-only
// OVER the mask that hides it. The id must now pass the installer's bundle-id rule, be
// INSTALLED here (installed.json, read fail-closed) and not be a reserved data-dir entry;
// the cache is the one fixed path <data>/<id>/.cache/uv, nothing else in the folder.
test("B8: a uv bundle id must be well-formed, installed, and not a reserved data-dir entry", () => {
  const ch = mk(T, "b8", "crow");
  const d = mk(ch, "data");
  const sessionB8 = mk(T, "b8", "session");
  // The instance's own entries: another project's folder, with the `.venv` and cache a
  // block would love to reach.
  const theirs = mk(d, "projects", "theirs", ".venv");
  const theirsCache = mk(d, "projects", "theirs", ".cache", "uv");
  // A bundle the operator really installed, and one that is not installed here.
  const installed = mk(ch, "bundles", "installed-bundle");
  const installedVenv = mk(d, "installed-bundle", ".venv");
  const installedCache = mk(d, "installed-bundle", ".cache", "uv");
  const notInstalled = mk(ch, "bundles", "not-installed-bundle");
  const notInstalledVenv = mk(d, "not-installed-bundle", ".venv");
  for (const bad of ["UPPER", "dotted.id"]) { mk(ch, "bundles", bad, ".venv"); mk(d, bad, ".venv"); }
  // installed.json names the reserved and malformed ids on purpose: a record in the file
  // can never re-open the instance's own data entries.
  writeFileSync(join(ch, "installed.json"), JSON.stringify(["installed-bundle", "projects", "UPPER", "dotted.id"]));

  const planFor = (block) => buildContainPlan(base({
    crowHome: ch, dataDir: d, sessionDir: sessionB8, cwd: sessionB8,
    mcpServers: [{ command: "uv", args: ["run", "srv"], ...block }],
  }));

  // The bug: a cwd under <crowHome>/bundles/projects/... used to derive the id "projects".
  const viaProjects = planFor({ cwd: mk(ch, "bundles", "projects", "x"), env: { UV_PROJECT_ENVIRONMENT: theirs, UV_CACHE_DIR: theirsCache } });
  for (const p of [theirs, theirsCache]) assert.ok(!has(viaProjects.args, "--ro-bind", p), p + " is never bound through a reserved id");
  assert.ok(viaProjects.refused.some((r) => r.path === theirs && /reserved data-dir entry/.test(r.reason)),
    "the reserved id is named in the refusal: " + JSON.stringify(viaProjects.refused));

  // A cwd that walks out of bundles/ names no bundle either.
  const traversal = planFor({ cwd: join(ch, "bundles", "..", "data", "projects", "theirs"), env: { UV_PROJECT_ENVIRONMENT: theirs } });
  assert.ok(!has(traversal.args, "--ro-bind", theirs), "a traversing cwd binds nothing");

  // Malformed ids: uppercase and dots are not bundle ids.
  for (const bad of ["UPPER", "dotted.id"]) {
    const venv = join(d, bad, ".venv");
    const plan = planFor({ cwd: mk(ch, "bundles", bad), env: { UV_PROJECT_ENVIRONMENT: venv } });
    assert.ok(!has(plan.args, "--ro-bind", venv), bad + " is not a bundle id: nothing bound");
    assert.ok(plan.refused.some((r) => r.path === venv && /not a bundle id/.test(r.reason)),
      bad + " refused as an invalid id: " + JSON.stringify(plan.refused));
  }

  // Well-formed but not installed here: nothing bound.
  const missing = planFor({ cwd: notInstalled, env: { UV_PROJECT_ENVIRONMENT: notInstalledVenv } });
  assert.ok(!has(missing.args, "--ro-bind", notInstalledVenv), "a non-installed bundle id binds nothing");
  assert.ok(missing.refused.some((r) => r.path === notInstalledVenv && /not installed here/.test(r.reason)),
    "the missing install record is named: " + JSON.stringify(missing.refused));

  // An installed bundle: its own venv and the ONE fixed cache path are bound.
  const ok = planFor({ cwd: installed, env: { UV_PROJECT_ENVIRONMENT: installedVenv, UV_CACHE_DIR: installedCache } });
  assert.ok(has(ok.args, "--ro-bind", installedVenv), "the installed bundle's venv is bound read-only");
  assert.ok(has(ok.args, "--ro-bind", installedCache), "the fixed cache path is bound read-only");
  assert.ok(!ok.refused.some((r) => r.path === installedVenv || r.path === installedCache), JSON.stringify(ok.refused));

  // Any OTHER cache path under the bundle's own folder is refused: it used to be enough to
  // be somewhere inside <data>/<id>/.
  const strayCache = mk(d, "installed-bundle", "tmp", "uv");
  const stray = planFor({ cwd: installed, env: { UV_CACHE_DIR: strayCache } });
  assert.ok(!has(stray.args, "--ro-bind", strayCache), "a cache elsewhere in the bundle folder is not bound");
  assert.ok(stray.refused.some((r) => r.path === strayCache && /\.cache\/uv \(that exact resolved path\)/.test(r.reason)),
    "the one fixed path is named in the refusal: " + JSON.stringify(stray.refused));
});

test("B8: an unreadable installed.json binds nothing (fail closed)", () => {
  const ch = mk(T, "b8u", "crow");
  const d = mk(ch, "data");
  const bundle = mk(ch, "bundles", "some-bundle");
  const venv = mk(d, "some-bundle", ".venv");
  const sessionB8u = mk(T, "b8u", "session");
  mk(ch, "installed.json"); // a directory where the record should be: unreadable
  const { args, refused } = buildContainPlan(base({
    crowHome: ch, dataDir: d, sessionDir: sessionB8u, cwd: sessionB8u,
    mcpServers: [{ command: "uv", args: ["run", "srv"], cwd: bundle, env: { UV_PROJECT_ENVIRONMENT: venv } }],
  }));
  assert.ok(!has(args, "--ro-bind", venv), "no bind without a readable installed.json");
  assert.ok(refused.some((r) => r.path === venv && /installed here cannot be read/.test(r.reason)),
    "the unreadable record is named: " + JSON.stringify(refused));
});

// ---- security review (2026-11-20): B9 (installed = both records), B10 (PATH folders),
// B11 (an entry that is not there yet is masked too), B12 (the reserved list is derived) ----

// B9 — installedBundleIds read only installed.json. An add-on can be registered ONLY in
// <crowHome>/mcp-addons.json (its bundle dir on disk, its MCP block in that file) and is
// installed all the same — that is the MPA layout and the real host's knowledge-base /
// fed-gov / texas-gov add-ons — so its uv venv was refused.
test("B9: the installed set is the UNION of installed.json and mcp-addons.json (both shapes)", () => {
  const ch = mk(T, "b9", "crow");
  const d = mk(ch, "data");
  const onlyAddons = mk(ch, "bundles", "kb-addon");       // registered in mcp-addons.json only
  const onlyInstalled = mk(ch, "bundles", "wired-addon"); // recorded in installed.json only
  writeFileSync(join(ch, "installed.json"), JSON.stringify([{ id: "wired-addon", version: "1.0.0" }]));
  writeFileSync(join(ch, "mcp-addons.json"), JSON.stringify({ "kb-addon": { command: "uv", args: ["run", "kb"] } }), { mode: 0o600 });
  const addonVenv = mk(d, "kb-addon", ".venv");
  const wiredVenv = mk(d, "wired-addon", ".venv");
  const sessionB9 = mk(T, "b9", "session");
  const planFor = (block) => buildContainPlan(base({
    crowHome: ch, dataDir: d, sessionDir: sessionB9, cwd: sessionB9,
    mcpServers: [{ command: "uv", args: ["run", "srv"], ...block }],
  }));

  assert.deepEqual([...installedBundleIds(ch)].sort(), ["kb-addon", "wired-addon"], "the union of both records");
  const viaAddons = planFor({ cwd: onlyAddons, env: { UV_PROJECT_ENVIRONMENT: addonVenv } });
  assert.ok(has(viaAddons.args, "--ro-bind", addonVenv), "an add-on recorded only in mcp-addons.json is installed: its venv binds");
  assert.ok(!viaAddons.refused.some((r) => r.path === addonVenv), JSON.stringify(viaAddons.refused));
  const viaInstalled = planFor({ cwd: onlyInstalled, env: { UV_PROJECT_ENVIRONMENT: wiredVenv } });
  assert.ok(has(viaInstalled.args, "--ro-bind", wiredVenv), "an install recorded only in installed.json still binds");

  // Both shapes installed.json is written in (an array of records, an id-keyed object), and
  // the one shape mcp-addons.json has. Neither file alone is required (the MPA layout has no
  // installed.json).
  const objShape = mk(T, "b9", "obj");
  writeFileSync(join(objShape, "installed.json"), JSON.stringify({ "wired-addon": { version: "2.0.0" } }));
  writeFileSync(join(objShape, "mcp-addons.json"), JSON.stringify({ "kb-addon": {} }));
  assert.deepEqual([...installedBundleIds(objShape)].sort(), ["kb-addon", "wired-addon"]);
  const addonsOnly = mk(T, "b9", "addons-only");
  writeFileSync(join(addonsOnly, "mcp-addons.json"), JSON.stringify({ "kb-addon": {} }));
  assert.deepEqual([...installedBundleIds(addonsOnly)], ["kb-addon"], "no installed.json is not a failure");
  const installedOnly = mk(T, "b9", "installed-only");
  writeFileSync(join(installedOnly, "installed.json"), JSON.stringify(["wired-addon"]));
  assert.deepEqual([...installedBundleIds(installedOnly)], ["wired-addon"], "no mcp-addons.json is not a failure");

  // Fail closed: an unreadable or corrupt record on EITHER side yields null, so nothing is
  // bound out of the data dir.
  for (const [which, body] of [["installed.json", "{"], ["mcp-addons.json", "{"], ["mcp-addons.json", "[1,2]"], ["installed.json", "null"]]) {
    const bad = mk(T, "b9", "bad-" + which.replace(/\W/g, "") + "-" + body.length + "-" + (body === "[1,2]" ? "arr" : body === "null" ? "nil" : "cut"));
    writeFileSync(join(bad, "mcp-addons.json"), JSON.stringify({ "kb-addon": {} }));
    writeFileSync(join(bad, "installed.json"), JSON.stringify(["wired-addon"]));
    writeFileSync(join(bad, which), body);
    assert.equal(installedBundleIds(bad), null, which + " = " + JSON.stringify(body) + " fails closed");
  }
  // A directory where a record should be is unreadable, not missing.
  const asDir = mk(T, "b9", "asdir");
  mk(asDir, "mcp-addons.json");
  assert.equal(installedBundleIds(asDir), null);

  // … and the plan refuses the venv of an add-on that cannot be established as installed.
  const broken = mk(T, "b9", "broken");
  const bd = mk(broken, "data");
  mk(broken, "bundles", "kb-addon");
  writeFileSync(join(broken, "installed.json"), JSON.stringify(["kb-addon"]));
  writeFileSync(join(broken, "mcp-addons.json"), "not json");
  const brokenVenv = mk(bd, "kb-addon", ".venv");
  const brokenPlan = buildContainPlan(base({
    crowHome: broken, dataDir: bd, sessionDir: sessionB9, cwd: sessionB9,
    mcpServers: [{ command: "uv", args: ["run", "srv"], cwd: join(broken, "bundles", "kb-addon"), env: { UV_PROJECT_ENVIRONMENT: brokenVenv } }],
  }));
  assert.ok(!has(brokenPlan.args, "--ro-bind", brokenVenv), "a corrupt mcp-addons.json binds nothing");
  assert.ok(brokenPlan.refused.some((r) => r.path === brokenVenv && /cannot be read/.test(r.reason)), JSON.stringify(brokenPlan.refused));
});

// B10 — the command-file fallback bound ANY executable file, including one in ~/bin or
// ~/.local/bin: the operator's own PATH folders, where a name is what a shell would run.
// Only the block's PINNED launcher (command_sha256, re-hashed at spawn) or a uv/uvx
// launcher may come out of them.
test("B10: a command in ~/bin or ~/.local/bin is refused unless it is the pinned launcher or uv", () => {
  const binTool = join(mk(H, "bin"), "tool");
  writeFileSync(binTool, "#!/bin/sh\n");
  chmodSync(binTool, 0o755);
  const localBin = mk(H, ".local", "bin");
  const localTool = join(localBin, "tool");
  writeFileSync(localTool, "#!/bin/sh\n");
  chmodSync(localTool, 0o755);

  const { args, refused } = buildContainPlan(base({ mcpServers: [
    { command: binTool, cwd: addon }, { command: localTool, cwd: addon },
  ] }));
  for (const p of [binTool, localTool]) {
    assert.ok(!has(args, "--ro-bind", p), p + " is not bound");
    assert.ok(!pairs(args).some((q) => (q[0] === "--ro-bind" || q[0] === "--bind") && q[1] === dirname(p)), dirname(p) + " is not bound either");
    assert.ok(refused.some((r) => r.path === p && /PATH folder/.test(r.reason)), p + " refused as a PATH folder: " + JSON.stringify(refused));
  }

  // The uv launcher the installer itself puts in ~/.local/bin keeps working.
  const uvLauncher = join(localBin, "uv");
  writeFileSync(uvLauncher, "#!/bin/sh\n");
  chmodSync(uvLauncher, 0o755);
  const uvPlan = buildContainPlan(base({ mcpServers: [{ command: uvLauncher, args: ["run", "srv"], cwd: addon }] }));
  assert.ok(has(uvPlan.args, "--ro-bind", uvLauncher), "a uv launcher in ~/.local/bin is still bound as the file");

  // … and so does a launcher the spawner PINNED for this block.
  const pinned = buildContainPlan(base({ mcpServers: [{ command: binTool, cwd: addon, command_sha256: "a".repeat(64) }] }));
  assert.ok(has(pinned.args, "--ro-bind", binTool), "a pinned launcher in ~/bin is bound");
  // A pin of the wrong shape is no pin.
  const badPin = buildContainPlan(base({ mcpServers: [{ command: binTool, cwd: addon, command_sha256: "not-a-sha" }] }));
  assert.ok(!has(badPin.args, "--ro-bind", binTool), "a malformed pin does not open the PATH folder");
});

// B11 — the data dir root is read-write (SQLite needs it), so masking only what is on disk
// left a hole: a bot could CREATE <data>/<installed id>/.venv, code that add-on's uv then
// runs OUTSIDE the sandbox. Every reserved name and every installed id is masked whether or
// not it exists, and the mount point is made by the SPAWNER before exec (never by the plan,
// never by bwrap inventing one).
test("B11: a reserved name or an installed id that does not exist yet is masked read-only", () => {
  const ch = mk(T, "b11", "crow");
  const d = mk(ch, "data");
  writeFileSync(join(d, "crow.db"), "");
  writeFileSync(join(d, "identity.json"), "{}");
  writeFileSync(join(ch, "installed.json"), JSON.stringify(["not-yet-run", "projects", "UPPER", "dotted.id"]));
  writeFileSync(join(ch, "mcp-addons.json"), JSON.stringify({ "addon-only": {} }));
  const sessionB11 = mk(T, "b11", "session");
  const plan = buildContainPlan(base({ crowHome: ch, dataDir: d, sessionDir: sessionB11, cwd: sessionB11 }));
  const { args } = plan;
  const names = ["peers", "backups", "deleted-projects", "history", "previews", "kb-media",
    "glasses-photos", "legacy", "models", "instance-sync", "not-yet-run", "addon-only"];

  // The PLAN creates nothing: it names the mount points the spawner has to make.
  for (const name of names) assert.ok(!existsSync(join(d, name)), name + " is not created by building a plan");
  for (const name of names) assert.ok(plan.mountPoints.includes(join(d, name)), name + " is a named mount point");

  // The spawner makes them: empty, plain, 0700, this uid.
  const made = ensureContainMountPoints(plan.mountPoints);
  for (const name of names) {
    const p = join(d, name);
    assert.ok(has(args, "--tmpfs", p), name + " is masked even though it did not exist at spawn");
    assert.ok(remounts(args, p) >= 0, name + " is remounted read-only");
    assert.ok(made.includes(p), name + " was made by the spawner");
    const st = statSync(p);
    assert.ok(st.isDirectory(), name + " mount point is a directory");
    assert.equal(st.mode & 0o777, 0o700, name + " mount point is 0700, the shape the installer makes");
    assert.equal(st.uid, process.getuid(), name + " mount point belongs to this uid");
  }
  // Idempotent and quiet: a second spawn keeps the folders (they are the installer's shape).
  assert.deepEqual(ensureContainMountPoints(plan.mountPoints), [], "nothing is created twice");
  // A reserved name is never a bundle id, and a malformed id is not created either.
  assert.ok(has(args, "--tmpfs", join(d, "projects")));
  for (const notId of ["UPPER", "dotted.id"]) assert.ok(!existsSync(join(d, notId)), notId + " is not a bundle id: nothing is created");
  // DB files stay reachable (SQLite writes beside them).
  assert.ok(!has(args, "--tmpfs", join(d, "crow.db")));

  // FILE-shaped reserved names are never created here: an empty instance-id makes
  // getOrCreateLocalInstanceId throw and an empty identity.json breaks JSON.parse, so a
  // missing one is left alone (the module header documents the residual).
  assert.ok(!existsSync(join(d, "instance-id")), "a missing instance-id is not created");
  assert.ok(RESERVED_DATA_FILES.includes("instance-id") && RESERVED_DATA_FILES.includes("identity.json"));
  assert.ok(!RESERVED_DATA_ENTRIES.filter((n) => !RESERVED_DATA_FILES.includes(n)).includes("instance-id"),
    "instance-id is a file, handled apart from the directory names");

  // A present reserved entry is masked by its real shape (a file stays /dev/null).
  assert.ok(has(args, "--ro-bind", "/dev/null", join(d, "identity.json")));
  // The keep-list still wins, so the operator can re-expose a bundle's data folder.
  const kept = buildContainPlan(base({ crowHome: ch, dataDir: d, sessionDir: sessionB11, cwd: sessionB11, dataKeep: ["addon-only"] }));
  assert.ok(!has(kept.args, "--tmpfs", join(d, "addon-only")));
  assert.ok(!kept.mountPoints.includes(join(d, "addon-only")));
});

// The mount point is a PRECONDITION of the spawn, not a best-effort side effect: a symlink
// there (a bot, or anyone who can write the data dir) must refuse the spawn, and so must a
// name that is a file or a dir another uid made. This is the fix for the real-bwrap finding
// that `<data>/<absent id>/.venv` could be created because nothing had made the mount point.
test("B11b: a mount point that is a symlink, a file, or not this uid's refuses the spawn", () => {
  const ch = mk(T, "b11b", "crow");
  const d = mk(ch, "data");
  writeFileSync(join(d, "crow.db"), "");
  const sessionB11b = mk(T, "b11b", "session");

  // A symlink where the mask has to land: it is planned as an absent name (a plain, empty
  // dir), and a symlink planted before exec — the race this check exists for — is refused
  // instead of taking the empty mount onto whatever the link names.
  const target = mk(T, "b11b", "elsewhere");
  const withLink = buildContainPlan(base({ crowHome: ch, dataDir: d, sessionDir: sessionB11b, cwd: sessionB11b }));
  assert.ok(withLink.mountPoints.includes(join(d, "peers")), "peers was absent when the plan was built");
  symlinkSync(target, join(d, "peers"));
  assert.throws(() => ensureContainMountPoints(withLink.mountPoints),
    (e) => e instanceof ContainRefused && /is a symlink/.test(e.message), "a symlinked mount point refuses the spawn");

  // A FILE at the name: an empty directory mount cannot land on it.
  rmSync(join(d, "peers"), { force: true });
  writeFileSync(join(d, "peers"), "not a directory");
  assert.throws(() => ensureContainMountPoints(withLink.mountPoints),
    (e) => e instanceof ContainRefused && /is not a directory/.test(e.message), "a file at the name refuses the spawn");

  // A dir another uid owns is not this spawner's to mount over — an EXISTING one exactly
  // like a freshly made one (the uid is a parameter so an unprivileged test can pin it).
  rmSync(join(d, "peers"), { force: true });
  mkdirSync(join(d, "peers"), { mode: 0o700 });
  assert.throws(() => ensureContainMountPoints([join(d, "peers")], { uid: process.getuid() + 1 }),
    (e) => e instanceof ContainRefused && /belongs to uid/.test(e.message),
    "a folder that ALREADY exists and belongs to another uid refuses the spawn");
  assert.throws(() => ensureContainMountPoints([join(d, "peers-made-now")], { uid: process.getuid() + 1 }),
    (e) => e instanceof ContainRefused && /belongs to uid/.test(e.message),
    "a folder this spawn makes for another uid refuses the spawn");
  assert.doesNotThrow(() => ensureContainMountPoints(withLink.mountPoints), "this uid's own dirs are fine");
});

// The absent-entry mask set has exactly two sources: the reserved list, and the bundle ids
// THIS instance records (installed.json ∪ mcp-addons.json). Nothing reads the repository's
// registry, and a bundle that is merely shipped in the checkout is not installed.
test("B11c: the absent-entry masks come only from the reserved list and this instance's own installer records", () => {
  const ch = mk(T, "b11c", "crow");
  const d = mk(ch, "data");
  writeFileSync(join(d, "crow.db"), "");
  mk(d, "projects");
  writeFileSync(join(ch, "installed.json"), JSON.stringify(["here-from-installed"]));
  writeFileSync(join(ch, "mcp-addons.json"), JSON.stringify({ "here-from-addons": {} }));
  const sessionB11c = mk(T, "b11c", "session");
  const plan = buildContainPlan(base({ crowHome: ch, dataDir: d, sessionDir: sessionB11c, cwd: sessionB11c }));

  const dirNames = RESERVED_DATA_ENTRIES.filter((n) => !RESERVED_DATA_FILES.includes(n) && !/^(crow|tasks)\.db/.test(n));
  const expected = new Set([...dirNames.filter((n) => n !== "projects").map((n) => join(d, n)),
    join(d, "here-from-installed"), join(d, "here-from-addons")]);
  assert.deepEqual(new Set(plan.mountPoints), expected,
    "the mount points are the absent reserved dir names plus this instance's own recorded ids");
  assert.equal(plan.mountPoints.length, expected.size, "no duplicates");

  // Every masked data-dir destination is one of those two sources (present entries included).
  const maskedDests = pairs(plan.args).filter((q) => q[0] === "--tmpfs" && String(q[1]).startsWith(join(d, "/"))).map((q) => q[1]);
  const allowed = new Set([...RESERVED_DATA_ENTRIES, "here-from-installed", "here-from-addons"]);
  for (const dest of maskedDests) {
    assert.ok(allowed.has(dest.slice(d.length + 1)), dest + " is not a reserved name or an installed id of this instance");
  }

  // The repository's registry is not a source: a bundle that ships in the checkout but is
  // not installed here is never masked (nor bound). A registry id that HAPPENS to be a
  // reserved data-dir name (`artifacts`, `media` are shipped bundles) is masked because it is
  // reserved, which is exactly the distinction this asserts.
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"));
  const registryIds = (registry["add-ons"] || []).map((a) => a.id).filter(Boolean);
  assert.ok(registryIds.length > 20, "the registry was read (" + registryIds.length + " ids)");
  const leaked = registryIds.filter((id) => !isReservedDataEntry(id)
    && (plan.mountPoints.includes(join(d, id)) || maskedDests.includes(join(d, id))));
  assert.deepEqual(leaked, [], "no registry bundle id is masked unless this instance records it");
});

// Documented residual, decided in the contain-tier review: a top-level name that is neither
// reserved nor installed AT SPAWN is creatable. Nothing on the host trusts a name Crow did
// not install (a bundle's own folder is only bound for an id both installer records know, and
// every reserved name is masked), and from the next spawn on the name is a PRESENT entry, so
// it is masked like any other. Closing it would need a read-only data dir, which SQLite rules
// out (see the module header).
test("B11d: a top-level name that is neither reserved nor installed stays creatable, and the next spawn masks it", () => {
  const ch = mk(T, "b11d", "crow");
  const d = mk(ch, "data");
  writeFileSync(join(d, "crow.db"), "");
  const sessionB11d = mk(T, "b11d", "session");
  const over = { crowHome: ch, dataDir: d, sessionDir: sessionB11d, cwd: sessionB11d };
  const first = buildContainPlan(base(over));
  assert.ok(!first.mountPoints.includes(join(d, "totally-new")), "an unknown name is not a mount point");
  assert.ok(!has(first.args, "--tmpfs", join(d, "totally-new")));
  // What a bot can do in the writable data-dir root, and why it is accepted: the name is
  // nobody's — no installer record, no reserved use — so no host process reads it.
  mk(d, "totally-new");
  writeFileSync(join(d, "totally-new", "planted.txt"), "x");
  // The next spawn sees it as a present entry and masks it read-only.
  const second = buildContainPlan(base(over));
  assert.ok(has(second.args, "--tmpfs", join(d, "totally-new")), "the next spawn masks the name it found");
  assert.ok(remounts(second.args, join(d, "totally-new")) >= 0);
  assert.ok(!second.mountPoints.includes(join(d, "totally-new")), "masked as a present entry, not an absent one");
});

// B12 — the reserved list is not a second copy that can drift: it is derived from the
// gateway's own list of names Crow's data uses, a hard-coded floor under it keeps the
// derivation from shrinking silently, and the data-dir names the servers and the spawner
// scripts actually join or resolve a path onto are all in it.
test("B12: every data-dir name the gateway itself uses is a reserved entry", () => {
  // The hard-coded MINIMUM. The derivation above could lose a name and every other
  // assertion here would still pass (a smaller list masks fewer names, it does not fail),
  // so the names Crow's own processes read or write directly under the data dir are spelled
  // out: each belongs to the instance, never to a bundle, and none may ever leave the list.
  const MINIMUM = [
    "projects", "peers", "instance-sync", "backups", "pi-bots", "secrets", "env", "history",
    "previews", "deleted-projects", "artifacts", "models", "legacy", "kb-media", "glasses-photos",
    "tmp", "logs", "uploads", "storage", "sync", "tasks", "identity.json", "instance-id",
    "orchestrator-refcounts.json",
  ];
  for (const name of MINIMUM) {
    assert.ok(isReservedDataEntry(name), name + " must ALWAYS be a reserved data-dir entry (the hard-coded floor)");
  }
  // The database files and their journals are reserved as a FAMILY (DB_FILE_RE), not by name.
  for (const db of ["crow.db", "tasks.db", "crow.db-wal", "crow.db-shm", "crow.db-journal",
    "tasks.db-wal", "tasks.db-shm", "tasks.db-journal"]) {
    assert.ok(isReservedDataEntry(db), db + " is reserved (DB_FILE_RE)");
  }
  // A FILE-shaped name must never be CREATED as an empty mount point: the plan would leave a
  // directory where a host process reads a JSON file.
  for (const name of ["identity.json", "instance-id", "orchestrator-refcounts.json"]) {
    assert.ok(RESERVED_DATA_FILES.includes(name), name + " is file-shaped and is handled by RESERVED_DATA_FILES");
  }

  for (const name of RESERVED_DATA_NAMES) {
    assert.ok(RESERVED_DATA_ENTRIES.includes(name), name + " (servers/gateway/compose-guard.js) is reserved for the bot mask too");
  }
  for (const p of ["data", "secrets", "bundles", "skills", "pi-bots", "env"]) {
    if (p === "data" || p === "secrets" || p === "bundles" || p === "skills") continue; // <crowHome> names, not data-dir ones
    assert.ok(RESERVED_DATA_ENTRIES.includes(p), p + " is reserved");
  }

  // Walk servers/ and scripts/ for `join(<something data-ish>, "<name>")` — and the
  // `resolve(...)` form, which is how shared/lifecycle.js spells the refcount file — and
  // require each name to be reserved: that is how a new top-level entry of the data dir is
  // spelled, in the servers and in the spawner's own scripts alike.
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(join(REPO, "servers"));
  walk(join(REPO, "scripts"));
  assert.ok(files.length > 300, "both trees were walked (" + files.length + " files)");
  assert.ok(files.some((f) => f.startsWith(join(REPO, "servers", "shared") + "/")), "servers/shared is walked");
  assert.ok(files.some((f) => f.startsWith(join(REPO, "scripts", "pi-bots") + "/")), "scripts/ is walked");
  assert.ok(files.some((f) => f.endsWith(".mjs")), ".mjs files are walked (the spawner and its scripts are .mjs)");
  const RE = /(?:join|resolve)\(\s*([A-Za-z_$][\w$]*(?:\(\))?)\s*,\s*"([A-Za-z0-9._-]+)"/g;
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(RE)) {
      const [, ident, name] = m;
      if (!/data/i.test(ident)) continue;      // not a data-dir anchor (a bundle folder, a home, …)
      if (name === ".." || name === ".") continue;
      // A LEADING dot is never a top-level instance name: the `.cache`/`.venv` joins in
      // scripts/addon-sandbox/plan.mjs are inside an add-on's own `<data>/<id>` folder.
      if (name.startsWith(".")) continue;
      if (!isReservedDataEntry(name)) offenders.push(name + "  <- " + f.replace(T, "<T>"));
    }
  }
  assert.deepEqual(offenders, [], "a name join()ed or resolve()d onto a data dir must be reserved");
});
