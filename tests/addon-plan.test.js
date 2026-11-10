/**
 * `buildAddonPlan` (scripts/addon-sandbox/plan.mjs): the file side of one
 * add-on's wall — what it binds, what it masks, what it refuses.
 *
 * Pure: scratch dirs under mkdtemp (realpath'd), a literal profile in the shape
 * `deriveProfile` returns, and (optionally) an injected `exists`. Every fd the
 * plan hands back is closed here.
 *
 * The rules under test:
 *  - code (the checkout, the node install, the installed copy) is a read-only
 *    PATH bind, at its real path;
 *  - everything an add-on can write — its data folder, its state folders, a
 *    sign-in folder, an owner-set file — is bound BY FD, never by path;
 *  - one data bind, no separate cache mount, and the caches live below it;
 *  - the door token is bind DATA at a fixed path;
 *  - a refusal that must keep the add-on off throws (ContainRefused) and leaves
 *    no fd open; an optional thing that cannot be bound lands in `refused`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContainRefused, neverBound } from "../scripts/pi-bots/pi_contain.mjs";
import { buildAddonPlan } from "../scripts/addon-sandbox/plan.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-plan-")));
after(() => rmSync(T, { recursive: true, force: true }));

const UID = process.getuid();
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
const fdCount = () => readdirSync("/proc/self/fd").length;

// ---- a fake host layout --------------------------------------------------

const HOME = mk(T, "home", "alex");
const NODE_DIR = mk(HOME, ".nvm", "versions", "node", "v24.0.0", "bin");
writeFileSync(join(NODE_DIR, "node"), "");
const NODE_BIN = join(NODE_DIR, "node");
const APP = mk(HOME, "crow");
writeFileSync(join(APP, ".env"), "SECRET=1");
mk(APP, "bundles", "other");
writeFileSync(join(APP, "bundles", "other", ".env"), "S=1");
const CROW = mk(HOME, ".crow");
const BUNDLES = mk(CROW, "bundles");
const INSTALL = mk(BUNDLES, "acme", "server");
writeFileSync(join(INSTALL, "index.js"), "");
writeFileSync(join(BUNDLES, "acme", ".env"), "ACME=1");
mk(BUNDLES, "other");
writeFileSync(join(BUNDLES, "other", ".env"), "OTHER=1");
const DATA = mk(CROW, "data");
const ADDON_DATA = mk(DATA, "acme");
mk(DATA, "other", ".cache");
for (const f of ["crow.db", "crow.db-wal", "crow.db-shm", "tasks.db", "crow.db.CORRUPT-1"]) writeFileSync(join(DATA, f), "");
mk(DATA, "backups");
const STATE = mk(CROW, "browser-sessions");
mk(CROW, "secrets");
writeFileSync(join(CROW, "mcp-addons.json"), "{}");
writeFileSync(join(CROW, "addon-walls.json"), "{}");
const SSH_DIR = mk(HOME, ".ssh");
const SSH_KEY = join(SSH_DIR, "id_ed25519");
writeFileSync(SSH_KEY, "k");
const CONFIG = mk(HOME, ".config", "acme-mcp");
const TOKEN = join(CONFIG, "token.json");
writeFileSync(TOKEN, "{}");
const KEYFILE = join(CONFIG, "key.pem");
writeFileSync(KEYFILE, "k");
writeFileSync(join(HOME, ".config", "token.json"), "{}");
const UV_DIR = mk(HOME, ".local", "bin");
writeFileSync(join(UV_DIR, "uv"), "");
const RELAY = mk(T, "relay");

// ---- helpers -------------------------------------------------------------

/** One flag's arity, so the argv can be split into mount ops. */
const ARITY = {
  "--ro-bind": 2, "--bind": 2, "--bind-fd": 2, "--ro-bind-fd": 2, "--ro-bind-data": 2,
  "--symlink": 2, "--tmpfs": 1, "--proc": 1, "--dev": 1, "--chdir": 1, "--perms": 1, "--cap-drop": 1,
};
function pairs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const n = ARITY[args[i]] ?? 0;
    if (n) { out.push([args[i], ...args.slice(i + 1, i + 1 + n)]); i += n; } else out.push([args[i]]);
  }
  return out;
}
const has = (args, flag, src, dst = src) => pairs(args).some((p) => p[0] === flag && p[1] === src && (p.length < 3 || p[2] === dst));
const masked = (args, p) => pairs(args).some((q) => (q[0] === "--tmpfs" && q[1] === p) || (q[0] === "--ro-bind" && q[1] === "/dev/null" && q[2] === p));
/** Every path a mount op takes a SOURCE from (`--*-fd` ops source from an fd number). */
const pathSources = (args) => pairs(args).filter((q) => ["--ro-bind", "--bind"].includes(q[0])).map((q) => q[1]);
const fdOps = (args) => pairs(args).filter((q) => ["--bind-fd", "--ro-bind-fd", "--ro-bind-data"].includes(q[0]));
const closePlan = (plan) => {
  for (const f of plan.fds) {
    if (f.role === "door-token") continue; // the caller's own fd
    try { closeSync(f.fd); } catch { /* already closed */ }
  }
};

/** The reason a venv interpreter outside the managed Python folders carries. */
const INTERPRETER_REASON = "the add-on's interpreter is outside the managed Python folders";

/** Point the add-on's venv interpreter at `target`, run `fn`, then drop the venv folder. */
function withVenvPython(target, fn) {
  const venvBin = mk(ADDON_DATA, ".venv", "bin");
  const link = join(venvBin, "python");
  rmSync(link, { force: true });
  symlinkSync(target, link);
  try { return fn(); } finally { rmSync(join(ADDON_DATA, ".venv"), { recursive: true, force: true }); }
}

/** A plan built while the venv interpreter points at `target`. */
const planWithVenvPython = (target, over = {}) => withVenvPython(target, () => planOf(over));

/** `p` is neither a path-bind source nor a bind destination on either side. */
const unbound = (args, p) => !pathSources(args).some((src) => src === p || src.startsWith(p + "/"))
  && !fdOps(args).some((q) => q[2] === p || q[2].startsWith(p + "/"));

/** A profile in `deriveProfile`'s shape, with only the wall-relevant fields. */
function profileOf(over = {}) {
  return {
    id: "acme",
    source: "repo",
    network: { internet: true, hosts: [] },
    doors: [],
    files: { read: [], write: [], oauthDir: null, state: [] },
    crowDb: false,
    ownEnvFile: false,
    refused: [],
    label: { en: ["use the internet", "keep files in its own folder"], es: [] },
    ...over,
  };
}

function planOf(over = {}) {
  return buildAddonPlan({
    id: "acme",
    profile: profileOf(),
    entry: { command: "node", args: ["server/index.js"] },
    home: HOME,
    crowHome: CROW,
    appRoot: APP,
    nodeBin: NODE_BIN,
    dataDir: DATA,
    gatewayPort: 3001,
    otherHomes: [],
    selfTargets: [],
    relayDir: RELAY,
    pathEnv: "",
    uid: UID,
    ...over,
  });
}

// ---- code and data -------------------------------------------------------

test("the installed copy is bound read-only at its real path; the data folder is bound by fd", () => {
  const installRoot = realpathSync(join(BUNDLES, "acme"));
  const plan = planOf();
  try {
    assert.ok(has(plan.args, "--ro-bind", installRoot), "the add-on's own code, read-only");
    assert.ok(!has(plan.args, "--bind", installRoot), "never writable");
    assert.ok(has(plan.args, "--ro-bind", realpathSync(APP)), "the checkout, read-only");
    assert.ok(has(plan.args, "--ro-bind", realpathSync(join(HOME, ".nvm", "versions", "node", "v24.0.0"))), "the node install");

    const dataOp = pairs(plan.args).find((q) => q[0] === "--bind-fd" && q[2] === ADDON_DATA);
    assert.ok(dataOp, "the data folder is bound by fd");
    const spec = plan.fds.find((f) => String(f.childFd) === dataOp[1]);
    assert.ok(spec, "the fd handed to the child is listed in fds");
    assert.equal(spec.role, "data");
    assert.equal(readlinkSync("/proc/self/fd/" + spec.fd), ADDON_DATA, "the fd really is the data folder");
    assert.equal(plan.addonDataDir, ADDON_DATA);

    for (const q of pairs(plan.args)) {
      if (q[0] === "--bind") assert.notEqual(q[1], installRoot, "the install folder is never a writable bind source");
      if (["--bind-fd", "--ro-bind-fd", "--ro-bind-data"].includes(q[0])) assert.notEqual(q[2], installRoot, "the install folder is not an fd-bind destination");
    }
    for (const src of pathSources(plan.args)) {
      assert.ok(src !== ADDON_DATA && !src.startsWith(ADDON_DATA + "/"), src + " is not a path-bind source");
    }
    assert.ok(!has(plan.args, "--bind", DATA), "the data dir itself is not a plain bind");
  } finally { closePlan(plan); }
});

test("one data bind, no cache mount: the caches live inside it", () => {
  const plan = planOf();
  try {
    for (const p of pairs(plan.args)) {
      for (const a of p.slice(1)) assert.doesNotMatch(String(a), /(^|\/)\.cache(\/|$)/, "no mount op names a .cache path");
    }
    assert.equal(plan.env.XDG_CACHE_HOME, join(ADDON_DATA, ".cache"));
    assert.equal(plan.env.npm_config_cache, join(ADDON_DATA, ".cache", "npm"));
    assert.equal(plan.env.UV_CACHE_DIR, join(ADDON_DATA, ".cache", "uv"));
    assert.equal(plan.env.TMPDIR, "/tmp");
    assert.equal(plan.env.HOME, HOME);
    assert.equal(plan.env.CROW_DATA_DIR, DATA);
  } finally { closePlan(plan); }
});

test("every source in an add-on-writable tree is bound by fd, never by path", () => {
  const plan = planOf({
    profile: profileOf({
      files: {
        read: [{ from: "ACME_KEY_FILE", path: KEYFILE, source: "owner" }],
        write: [],
        oauthDir: { from: "ACME_TOKEN_DIR", path: TOKEN, source: "owner" },
        state: ["browser-sessions"],
      },
    }),
  });
  try {
    const writable = [ADDON_DATA, STATE, CONFIG, KEYFILE];
    const sources = pathSources(plan.args);
    for (const p of writable) assert.ok(!sources.includes(p), p + " is never a path-bind source");
    const ops = fdOps(plan.args);
    for (const p of writable) assert.ok(ops.some((q) => q[2] === p), p + " is bound by fd");

    // Each fd op's number is one of the fds the plan hands over.
    const numbers = new Set(plan.fds.map((f) => String(f.childFd)));
    for (const q of ops) assert.ok(numbers.has(q[1]), "every fd op names a listed child fd");

    // The sign-in folder comes before the file inside it.
    const folderAt = plan.args.indexOf(CONFIG);
    const fileAt = plan.args.indexOf(KEYFILE);
    assert.ok(folderAt > 0 && fileAt > folderAt, "parents before children");
    assert.equal(plan.fds.find((f) => readlinkSync("/proc/self/fd/" + f.fd) === CONFIG).role, "oauth-dir");
    assert.equal(plan.fds.find((f) => readlinkSync("/proc/self/fd/" + f.fd) === KEYFILE).role, "file-read");
    assert.equal(plan.fds.find((f) => readlinkSync("/proc/self/fd/" + f.fd) === STATE).role, "state");
  } finally { closePlan(plan); }
});

// ---- the door token ------------------------------------------------------

test("the door token is bind data at a fixed path, never a file in a writable tree", () => {
  const tokenFile = join(T, "door-token");
  writeFileSync(tokenFile, "a-door-token");
  const tfd = openSync(tokenFile, "r");
  let plan;
  try {
    plan = planOf({ doorTokenFd: tfd });
    const ops = pairs(plan.args).filter((q) => q[0] === "--ro-bind-data");
    assert.equal(ops.length, 1);
    assert.equal(ops[0][2], "/run/crow-addon/door-token");
    assert.ok(pairs(plan.args).some((q) => q[0] === "--perms" && q[1] === "0400"), "0400 on the token");
    const spec = plan.fds.find((f) => f.role === "door-token");
    assert.equal(spec.fd, tfd);
    assert.equal(String(spec.childFd), ops[0][1]);
    for (const a of plan.args) assert.notEqual(a, tokenFile, "the token file's path never appears");
    assert.ok(!pathSources(plan.args).some((p) => p.startsWith(ADDON_DATA)), "not through the data tree either");
  } finally {
    if (plan) closePlan(plan);
    closeSync(tfd);
  }
});

// ---- network -------------------------------------------------------------

test("selfTargets are passed through untouched; hosts and doors decide the ports", () => {
  const selfTargets = ["crow.example.ts.net", "100.64.20.5"];
  const plan = planOf({
    selfTargets,
    profile: profileOf({
      doors: ["acme"],
      network: {
        internet: true,
        hosts: [{ host: "localhost", port: 8000, scheme: "http", from: "ACME_URL", source: "owner" }],
      },
    }),
  });
  try {
    assert.deepEqual(plan.net.selfTargets, selfTargets);
    assert.deepEqual(plan.net.ports, [3001, 8000].sort((a, b) => a - b));
    assert.equal(plan.net.sock, "/run/crow-net/relay.sock");
    assert.ok(plan.net.proxyPort > 0 && !plan.net.ports.includes(plan.net.proxyPort));
    assert.ok(has(plan.args, "--ro-bind", RELAY, "/run/crow-net"), "the relay folder is mounted read-only");
    assert.equal(plan.env.HTTPS_PROXY, "http://127.0.0.1:" + plan.net.proxyPort);
    assert.equal(plan.env.NODE_USE_ENV_PROXY, "1");
  } finally { closePlan(plan); }
});

test("a profile with no internet and no hosts gets no relay, no ports and no proxy env", () => {
  const plan = planOf({ profile: profileOf({ network: { internet: false, hosts: [] } }) });
  try {
    assert.deepEqual(plan.net, { sock: null, ports: [], proxyPort: null, selfTargets: [] });
    assert.ok(!has(plan.args, "--ro-bind", RELAY, "/run/crow-net"));
    assert.equal("HTTP_PROXY" in plan.env, false);
    assert.ok(plan.args.includes("--unshare-net"), "still its own (empty) network namespace");
  } finally { closePlan(plan); }
});

test("a local-only profile gets its loopback port and no proxy variables", () => {
  const plan = planOf({
    profile: profileOf({
      network: { internet: false, hosts: [{ host: "127.0.0.1", port: 8811, scheme: "tcp", from: "ACME_HOST", source: "owner" }] },
    }),
  });
  try {
    assert.deepEqual(plan.net.ports, [8811]);
    assert.equal(plan.net.sock, "/run/crow-net/relay.sock");
    assert.equal("HTTPS_PROXY" in plan.env, false);
  } finally { closePlan(plan); }
});

// ---- never bound ---------------------------------------------------------

test("neverBound(home) never appears as a bind source, including through a symlinked value", () => {
  const linkDir = mk(CONFIG, "keys");
  const link = join(linkDir, "key-link.pem");
  symlinkSync(SSH_KEY, link);
  const plan = planOf({
    profile: profileOf({
      files: {
        read: [
          { from: "ACME_KEY_FILE", path: SSH_KEY, source: "owner" },
          { from: "ACME_LINK_FILE", path: link, source: "owner" },
          { from: "ACME_SECRETS", path: join(CROW, "secrets"), source: "owner" },
        ],
        write: [],
        oauthDir: null,
        state: [],
      },
    }),
  });
  try {
    const never = neverBound(HOME);
    for (const src of pathSources(plan.args)) {
      for (const n of never) {
        assert.ok(src !== n && !src.startsWith(n + "/"), src + " is a protected path");
      }
    }
    const opDestinations = fdOps(plan.args).map((q) => q[2]);
    for (const n of never) {
      for (const d of opDestinations) assert.ok(d !== n && !d.startsWith(n + "/"), n + " is never a bind destination");
    }
    const refusedPaths = plan.refused.map((r) => r.path);
    assert.ok(refusedPaths.includes(SSH_KEY), "a key file is refused");
    assert.ok(refusedPaths.includes(link), "a symlinked value is refused");
  } finally { closePlan(plan); }
});

test("a manifest default is never bound; the same paths owner-set are refused by the refuse list", () => {
  const hostile = [join(APP, ".env"), join(CROW, "mcp-addons.json"), join(CROW, "secrets", "keychain.key"), HOME + "/crow/other.env"];
  const withDefaults = planOf({
    profile: profileOf({
      files: {
        read: hostile.map((p, i) => ({ from: "D" + i, path: p, source: "default" })),
        write: hostile.map((p, i) => ({ from: "W" + i, path: p, source: "default" })),
        oauthDir: { from: "OAUTH_DIR", path: join(CROW, "secret-dir"), source: "default" },
        state: [],
      },
    }),
  });
  try {
    for (const r of withDefaults.refused) {
      if (hostile.includes(r.path)) assert.equal(r.reason, "a manifest default is never bound");
    }
    for (const p of hostile) {
      assert.ok(withDefaults.refused.some((r) => r.path === p), p + " refused");
      assert.ok(!pathSources(withDefaults.args).includes(p), p + " not bound");
      assert.ok(!fdOps(withDefaults.args).some((q) => q[2] === p), p + " not bound by fd either");
    }
    assert.ok(withDefaults.refused.some((r) => r.path === join(CROW, "secret-dir") && r.reason === "a manifest default is never bound"));
  } finally { closePlan(withDefaults); }

  const ownerSet = planOf({
    profile: profileOf({
      files: {
        read: hostile.map((p, i) => ({ from: "D" + i, path: p, source: "owner" })),
        write: [],
        oauthDir: null,
        state: [],
      },
    }),
  });
  try {
    for (const p of hostile) assert.ok(ownerSet.refused.some((r) => r.path === p), p + " refused even as an owner value");
    assert.ok(ownerSet.refused.some((r) => r.path === join(CROW, "mcp-addons.json") && /add-on registry/.test(r.reason)));
    assert.ok(ownerSet.refused.some((r) => r.path === join(CROW, "secrets", "keychain.key") && /Crow secret/.test(r.reason)));
    assert.ok(ownerSet.refused.some((r) => r.path === join(APP, ".env") && /environment file/.test(r.reason)));
  } finally { closePlan(ownerSet); }
});

// ---- the sign-in folder --------------------------------------------------

test("an owner-set sign-in folder is bound read-write as a directory; a direct child of home is refused", () => {
  const plan = planOf({
    profile: profileOf({
      files: { read: [], write: [], oauthDir: { from: "ACME_TOKEN_DIR", path: TOKEN, source: "owner" }, state: [] },
    }),
  });
  try {
    const op = fdOps(plan.args).find((q) => q[2] === CONFIG);
    assert.ok(op, "the folder is bound by fd");
    assert.equal(plan.fds.find((f) => String(f.childFd) === op[1]).role, "oauth-dir");
    assert.ok(!pathSources(plan.args).includes(CONFIG), "never a path-bind source");
  } finally { closePlan(plan); }

  const childOfHome = planOf({
    profile: profileOf({
      files: { read: [], write: [], oauthDir: { from: "ACME_TOKEN_DIR", path: join(HOME, ".config", "token.json"), source: "owner" }, state: [] },
    }),
  });
  try {
    assert.ok(childOfHome.refused.some((r) => r.path === join(HOME, ".config", "token.json") && /direct child of the home/.test(r.reason)));
    assert.ok(!fdOps(childOfHome.args).some((q) => q[2] === join(HOME, ".config")), "~/.config is not bound");
  } finally { closePlan(childOfHome); }

  const missingFile = planOf({
    profile: profileOf({
      files: { read: [], write: [], oauthDir: { from: "ACME_TOKEN_DIR", path: join(CONFIG, "nope.json"), source: "owner" }, state: [] },
    }),
  });
  try {
    assert.ok(missingFile.refused.some((r) => r.path === join(CONFIG, "nope.json") && /does not contain/.test(r.reason)));
  } finally { closePlan(missingFile); }
});

// ---- the state allowlist -------------------------------------------------

test("state folders are bound read-write by fd; a missing one is skipped and a symlink is refused", () => {
  const plan = planOf({ profile: profileOf({ files: { read: [], write: [], oauthDir: null, state: ["browser-sessions", "no-such-state"] } }) });
  try {
    const op = fdOps(plan.args).find((q) => q[2] === STATE);
    assert.ok(op);
    assert.equal(plan.fds.find((f) => String(f.childFd) === op[1]).role, "state");
    assert.ok(!plan.refused.some((r) => r.path === join(CROW, "no-such-state")), "a missing state folder is skipped silently");
  } finally { closePlan(plan); }
});

// ---- crow.db -------------------------------------------------------------

test("a crow.db profile binds the data folder read-write and masks everything else present", () => {
  const plan = planOf({ profile: profileOf({ crowDb: true }) });
  try {
    const op = pairs(plan.args).find((q) => q[0] === "--bind-fd" && q[2] === DATA);
    assert.ok(op, "the data dir itself is bound, by fd");
    assert.equal(plan.fds.find((f) => String(f.childFd) === op[1]).role, "crow-data");
    for (const p of ["crow.db.CORRUPT-1", "backups", "tasks.db", "other"]) assert.ok(masked(plan.args, join(DATA, p)), p + " masked");
    for (const p of ["crow.db", "crow.db-wal", "crow.db-shm", "acme"]) assert.ok(!masked(plan.args, join(DATA, p)), p + " kept");
    assert.equal(plan.env.CROW_DB_PATH, join(DATA, "crow.db"));
    assert.deepEqual(plan.unsetEnv, []);
    assert.equal(plan.addonDataDir, ADDON_DATA);
  } finally { closePlan(plan); }
});

test("a non-crowDb plan has no data-dir bind, no CROW_DB_PATH, and unsets it", () => {
  const plan = planOf();
  try {
    assert.ok(!pairs(plan.args).some((q) => q[0] === "--bind-fd" && q[2] === DATA));
    assert.equal("CROW_DB_PATH" in plan.env, false);
    assert.deepEqual(plan.unsetEnv, ["CROW_DB_PATH"]);
    // The masking loop is the crow.db one: a non-crowDb plan masks nothing of DATA.
    assert.ok(!masked(plan.args, join(DATA, "tasks.db")));
    // Another add-on's cache is never a bind source.
    for (const src of pathSources(plan.args)) {
      assert.ok(src !== join(DATA, "other") && !src.startsWith(join(DATA, "other") + "/"), src);
    }
  } finally { closePlan(plan); }
});

// ---- env files, masks ----------------------------------------------------

test("the add-on's own .env stays readable; every other bound .env is masked", () => {
  const ownEnv = realpathSync(join(BUNDLES, "acme", ".env"));
  const plan = planOf({ profile: profileOf({ ownEnvFile: true }) });
  try {
    assert.ok(!masked(plan.args, ownEnv), "bundles/acme/.env is kept readable");
    assert.ok(masked(plan.args, join(APP, ".env")), "the checkout's .env is masked");
    assert.ok(masked(plan.args, join(APP, "bundles", "other", ".env")), "another bundle's .env in the checkout is masked");
    assert.ok(!plan.args.includes(join(BUNDLES, "other", ".env")), "an unbound bundle's .env is not named at all");
  } finally { closePlan(plan); }

  const plain = planOf();
  try {
    assert.ok(masked(plain.args, ownEnv), "without ownEnvFile the add-on's own .env is masked too");
  } finally { closePlan(plain); }
});

// ---- the root and the namespaces ----------------------------------------

test("an empty root, a private home, and the namespace flags", () => {
  const plan = planOf();
  try {
    assert.deepEqual(plan.args.slice(0, 2), ["--tmpfs", "/"]);
    assert.ok(has(plan.args, "--proc", "/proc"));
    assert.ok(has(plan.args, "--dev", "/dev"));
    assert.ok(has(plan.args, "--tmpfs", "/tmp"));
    assert.ok(has(plan.args, "--tmpfs", "/var/tmp"));
    assert.ok(has(plan.args, "--tmpfs", "/run"));
    assert.ok(has(plan.args, "--tmpfs", HOME), "a private tmpfs home");
    for (const f of ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
      "--unshare-net", "--die-with-parent", "--new-session"]) {
      assert.ok(plan.args.includes(f), f);
    }
    assert.ok(pairs(plan.args).some((q) => q[0] === "--cap-drop" && q[1] === "ALL"));
    assert.ok(pairs(plan.args).some((q) => q[0] === "--chdir" && q[1] === realpathSync(join(BUNDLES, "acme"))));
  } finally { closePlan(plan); }
});

test("a uv entry binds the uv file, not ~/.local, and sets UV_PROJECT_ENVIRONMENT", () => {
  const pythonRoot = mk(HOME, ".local", "share", "uv", "python", "cpython-3.13");
  const pythonBin = mk(pythonRoot, "bin");
  writeFileSync(join(pythonBin, "python3"), "");
  // A venv's `python` is a symlink into the interpreter install, so the plan
  // binds the install's root and not the venv folder.
  const plan = planWithVenvPython(join(pythonBin, "python3"), { entry: { command: "uv", args: ["run", "server"] }, pathEnv: UV_DIR });
  try {
    assert.ok(has(plan.args, "--ro-bind", join(UV_DIR, "uv")), "the uv file itself, read-only");
    assert.ok(!has(plan.args, "--ro-bind", join(HOME, ".local")), "never the whole ~/.local");
    assert.ok(has(plan.args, "--ro-bind", pythonRoot), "the interpreter install, read-only");
    assert.equal(plan.env.UV_PROJECT_ENVIRONMENT, join(ADDON_DATA, ".venv"));
  } finally { closePlan(plan); }
});

// ---- the venv interpreter symlink is the add-on's choice ------------------

test("a venv interpreter inside uv's managed Pythons is bound read-only at its install root", () => {
  const pythonRoot = mk(HOME, ".local", "share", "uv", "python", "cpython-3.12-linux");
  const pythonBin = mk(pythonRoot, "bin");
  const python3 = join(pythonBin, "python3");
  writeFileSync(python3, "");
  const plan = planWithVenvPython(python3);
  try {
    assert.ok(has(plan.args, "--ro-bind", pythonRoot), "--ro-bind " + pythonRoot + " is present");
    assert.ok(!plan.refused.some((r) => r.reason === INTERPRETER_REASON), "a managed interpreter draws no refusal");
  } finally { closePlan(plan); }
});

test("a venv interpreter symlinked at another add-on's data folder is refused and nothing of it is bound", () => {
  const otherRoot = mk(DATA, "other", "a");
  const target = join(mk(otherRoot, "bin"), "python");
  writeFileSync(target, "");
  const plan = planWithVenvPython(target);
  try {
    assert.ok(plan.refused.some((r) => r.path === otherRoot && r.reason === INTERPRETER_REASON), "the interpreter root is refused: " + JSON.stringify(plan.refused));
    assert.ok(unbound(plan.args, join(DATA, "other")), "no bind source or destination under " + join(DATA, "other"));
  } finally { closePlan(plan); }
});

test("a venv interpreter symlinked into the owner's home is refused and nothing of it is bound", () => {
  const notesRoot = mk(HOME, "notes", "x");
  const target = join(mk(notesRoot, "bin"), "python");
  writeFileSync(target, "");
  const plan = planWithVenvPython(target);
  try {
    assert.ok(plan.refused.some((r) => r.path === notesRoot && r.reason === INTERPRETER_REASON), "the interpreter root is refused: " + JSON.stringify(plan.refused));
    assert.ok(unbound(plan.args, notesRoot), "never bound: " + notesRoot);
    assert.ok(unbound(plan.args, join(HOME, "notes")), "not through the folder holding it either");
  } finally { closePlan(plan); }
});

test("a venv interpreter symlinked into the Crow home is refused and nothing of it is bound", () => {
  const otherRoot = mk(BUNDLES, "other", "x");
  const target = join(mk(otherRoot, "bin"), "python");
  writeFileSync(target, "");
  const plan = planWithVenvPython(target);
  try {
    assert.ok(plan.refused.some((r) => r.path === otherRoot && r.reason === INTERPRETER_REASON), "the interpreter root is refused: " + JSON.stringify(plan.refused));
    assert.ok(unbound(plan.args, otherRoot), "never bound: " + otherRoot);
  } finally { closePlan(plan); }
});

test("an absolute command naming a Crow-home secret is refused and nothing is bound", () => {
  const secret = join(CROW, "secrets", "run");
  writeFileSync(secret, "#!/bin/sh\n");
  const plan = planOf({ entry: { command: secret, args: [] }, pathEnv: "" });
  try {
    assert.ok(plan.refused.some((r) => r.path === secret), "the command is refused: " + JSON.stringify(plan.refused));
    assert.ok(unbound(plan.args, secret), "never bound: " + secret);
  } finally { closePlan(plan); }
});

test("an absolute command naming another bundle in the Crow home is refused by the refuse list", () => {
  const command = join(BUNDLES, "other", "run.sh");
  writeFileSync(command, "#!/bin/sh\n");
  const plan = planOf({ entry: { command, args: [] }, pathEnv: "" });
  try {
    assert.ok(plan.refused.some((r) => r.path === command && /Crow home/.test(r.reason)), "refused by the Crow-home rule: " + JSON.stringify(plan.refused));
    assert.ok(unbound(plan.args, command), "never bound: " + command);
  } finally { closePlan(plan); }
});

test("an absolute command outside /usr and /opt binds the command FILE, not its root", () => {
  const binDir = mk(T, "addon-bin", "bin");
  writeFileSync(join(binDir, "run.sh"), "#!/bin/sh\n");
  const plan = planOf({ entry: { command: join(binDir, "run.sh"), args: [] } });
  try {
    assert.ok(has(plan.args, "--ro-bind", join(binDir, "run.sh")), "the file itself");
    assert.ok(!has(plan.args, "--ro-bind", binDir), "not the folder holding it");
    assert.ok(!has(plan.args, "--ro-bind", T), "and not an ancestor of it");
  } finally { closePlan(plan); }
});

// ---- refusals keep the add-on off ---------------------------------------

test("a refusal from the plan closes every fd it opened", (t) => {
  try {
    const before = fdCount();
    assert.throws(() => planOf({ id: "not-installed" }), ContainRefused, "no install folder");
    assert.throws(() => planOf({ dataDir: join(CROW, "no-such-data") }), ContainRefused, "no data folder");
    assert.equal(fdCount(), before, "a refusal before any open leaks nothing");

    // A checked open that walks several components and then refuses the leaf.
    mk(BUNDLES, "linked-data", "server");
    const linked = join(CROW, "linked-data");
    symlinkSync(APP, linked);
    const beforeWalk = fdCount();
    assert.throws(() => planOf({ id: "linked-data", dataDir: CROW }), ContainRefused, "a symlinked data leaf refuses");
    assert.equal(fdCount(), beforeWalk, "no fd left open by the failed walk");
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "ENOSYS")) { t.skip("this host does not allow symlinks in the scratch dir"); return; }
    throw err;
  }
});

test("a missing install folder refuses with a reason naming it", () => {
  assert.throws(() => planOf({ id: "not-installed" }),
    (e) => e instanceof ContainRefused && /does not exist/.test(e.message) && e.message.includes(join(BUNDLES, "not-installed")));
});