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
import { join, dirname } from "node:path";

import { ContainRefused, neverBound } from "../scripts/pi-bots/pi_contain.mjs";
import { buildAddonPlan } from "../scripts/addon-sandbox/plan.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-plan-")));
after(() => rmSync(T, { recursive: true, force: true }));

const UID = process.getuid();
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
/**
 * The fds this process holds on anything inside this test's scratch tree, as sorted
 * "fd -> target" strings. Only the plan opens files there, so this set is
 * deterministic, unlike a process-wide count (other threads open and close fds of
 * their own at any time). An fd that closes between the listing and its readlink is
 * not one of ours and is skipped.
 */
const scratchFds = () => {
  const out = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    let target;
    try { target = readlinkSync("/proc/self/fd/" + fd); } catch { continue; }
    if (target === T || target.startsWith(T + "/")) out.push(fd + " -> " + target);
  }
  return out.sort();
};

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
// A folder the owner chose for a sign-in file: visible (and below a visible
// folder, not a direct child of the home), so it is writable.
const SIGNIN = mk(HOME, "signin", "acme");
const TOKEN = join(SIGNIN, "token.json");
writeFileSync(TOKEN, "{}");
const KEYFILE = join(SIGNIN, "key.pem");
writeFileSync(KEYFILE, "k");
// A HIDDEN top-level entry of the home: never writable, whatever names it.
const CONFIG = mk(HOME, ".config", "acme-mcp");
writeFileSync(join(CONFIG, "token.json"), "{}");
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
    const writable = [ADDON_DATA, STATE, SIGNIN, KEYFILE];
    const sources = pathSources(plan.args);
    for (const p of writable) assert.ok(!sources.includes(p), p + " is never a path-bind source");
    const ops = fdOps(plan.args);
    for (const p of writable) assert.ok(ops.some((q) => q[2] === p), p + " is bound by fd");

    // Each fd op's number is one of the fds the plan hands over.
    const numbers = new Set(plan.fds.map((f) => String(f.childFd)));
    for (const q of ops) assert.ok(numbers.has(q[1]), "every fd op names a listed child fd");

    // The sign-in folder comes before the file inside it.
    const folderAt = plan.args.indexOf(SIGNIN);
    const fileAt = plan.args.indexOf(KEYFILE);
    assert.ok(folderAt > 0 && fileAt > folderAt, "parents before children");
    assert.equal(plan.fds.find((f) => readlinkSync("/proc/self/fd/" + f.fd) === SIGNIN).role, "oauth-dir");
    assert.equal(plan.fds.find((f) => readlinkSync("/proc/self/fd/" + f.fd) === KEYFILE).role, "file-read");
    assert.equal(plan.fds.find((f) => readlinkSync("/proc/self/fd/" + f.fd) === STATE).role, "state");
  } finally { closePlan(plan); }
});

// ---- an owner-set read folder is never widened to a write --------------

test("an owner-set files.read folder is bound with --ro-bind-fd; a files.write folder keeps --bind-fd", () => {
  const readDir = mk(HOME, "shared", "read-dir");
  writeFileSync(join(readDir, "notes.txt"), "");
  const writeDir = mk(HOME, "shared", "write-dir");
  writeFileSync(join(writeDir, "out.txt"), "");
  const plan = planOf({
    profile: profileOf({
      files: {
        read: [{ from: "ACME_READ_DIR", path: readDir, source: "owner" }],
        write: [{ from: "ACME_WRITE_DIR", path: writeDir, source: "owner" }],
        oauthDir: null,
        state: [],
      },
    }),
  });
  try {
    const readReal = realpathSync(readDir);
    const writeReal = realpathSync(writeDir);
    const ops = fdOps(plan.args);

    const roOp = ops.find((q) => q[0] === "--ro-bind-fd" && q[2] === readReal);
    assert.ok(roOp, "the read folder is bound with --ro-bind-fd: " + JSON.stringify(ops));
    const readSpec = plan.fds.find((f) => String(f.childFd) === roOp[1]);
    assert.ok(readSpec, "its fd is handed over");
    assert.equal(readSpec.role, "dir-read");
    assert.equal(readlinkSync("/proc/self/fd/" + readSpec.fd), readReal, "the fd really is the folder");
    assert.ok(!has(plan.args, "--bind-fd", roOp[1], readReal), "never the same fd as a read-write bind");
    assert.ok(!ops.some((q) => q[0] === "--bind-fd" && q[2] === readReal), "no read-write bind of the read folder");
    assert.ok(!pathSources(plan.args).includes(readReal), "never a path-bind source either");
    assert.ok(!plan.refused.some((r) => r.path === readDir), "nothing refused: " + JSON.stringify(plan.refused));

    const writeOp = ops.find((q) => q[2] === writeReal);
    assert.ok(writeOp, "the write folder is bound by fd");
    assert.equal(writeOp[0], "--bind-fd", "a write folder keeps the read-write bind");
    assert.equal(plan.fds.find((f) => String(f.childFd) === writeOp[1]).role, "dir-write");
  } finally {
    closePlan(plan);
    rmSync(join(HOME, "shared"), { recursive: true, force: true });
  }
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
  const linkDir = mk(SIGNIN, "keys");
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
    const op = fdOps(plan.args).find((q) => q[2] === SIGNIN);
    assert.ok(op, "the folder is bound by fd");
    assert.equal(plan.fds.find((f) => String(f.childFd) === op[1]).role, "oauth-dir");
    assert.ok(!pathSources(plan.args).includes(SIGNIN), "never a path-bind source");
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

  // A sign-in folder one level further down a hidden entry is refused too:
  // `~/.config/<app>` is still a hidden entry of the home.
  const hiddenDir = planOf({
    profile: profileOf({
      files: { read: [], write: [], oauthDir: { from: "ACME_TOKEN_DIR", path: join(CONFIG, "token.json"), source: "owner" }, state: [] },
    }),
  });
  try {
    assert.ok(hiddenDir.refused.some((r) => r.path === join(CONFIG, "token.json") && /hidden entry of the home/.test(r.reason)),
      "the hidden folder is refused: " + JSON.stringify(hiddenDir.refused));
    assert.ok(!fdOps(hiddenDir.args).some((q) => q[2] === CONFIG), "~/.config/acme-mcp is not bound");
  } finally { closePlan(hiddenDir); }

  const missingFile = planOf({
    profile: profileOf({
      files: { read: [], write: [], oauthDir: { from: "ACME_TOKEN_DIR", path: join(SIGNIN, "nope.json"), source: "owner" }, state: [] },
    }),
  });
  try {
    assert.ok(missingFile.refused.some((r) => r.path === join(SIGNIN, "nope.json") && /does not contain/.test(r.reason)));
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

test("ownEnvFile: the own .env is masked, then re-bound by fd on top of its own mask", () => {
  const ownEnv = realpathSync(join(BUNDLES, "acme", ".env"));
  const plan = planOf({ profile: profileOf({ ownEnvFile: true }) });
  try {
    const ops = pairs(plan.args);
    const maskAt = ops.findIndex((q) => q[0] === "--ro-bind" && q[1] === "/dev/null" && q[2] === ownEnv);
    const bindAt = ops.findIndex((q) => q[0] === "--ro-bind-fd" && q[2] === ownEnv);
    assert.ok(maskAt >= 0, "the own .env is masked like every other");
    assert.ok(bindAt >= 0, "and re-bound by fd");
    assert.ok(bindAt > maskAt, "the fd bind comes after the mask, so it lands on top");
    const spec = plan.fds.find((f) => f.role === "own-env");
    assert.ok(spec, "the own .env fd is listed with its own role");
    assert.equal(String(spec.childFd), ops[bindAt][1]);
    assert.equal(readlinkSync("/proc/self/fd/" + spec.fd), ownEnv, "the fd really is the own .env");

    assert.ok(masked(plan.args, join(APP, ".env")), "the checkout's .env is masked");
    assert.ok(masked(plan.args, join(APP, "bundles", "other", ".env")), "another bundle's .env in the checkout is masked");
    assert.ok(!plan.refused.some((r) => r.path === ownEnv), "nothing was refused");
  } finally { closePlan(plan); }

  const plain = planOf();
  try {
    assert.ok(masked(plain.args, ownEnv), "without ownEnvFile the own .env is masked too");
    assert.ok(!fdOps(plain.args).some((q) => q[2] === ownEnv), "and nothing is bound over the mask");
  } finally { closePlan(plain); }
});

test("ownEnvFile with a symlinked own .env: refused, and the target stays masked", (t) => {
  const own = join(BUNDLES, "acme", ".env");
  const target = join(APP, ".env");
  rmSync(own, { force: true });
  try {
    symlinkSync(target, own);
  } catch (err) {
    writeFileSync(own, "ACME=1");
    if (err && (err.code === "EPERM" || err.code === "ENOSYS")) { t.skip("this host does not allow symlinks in the scratch dir"); return; }
    throw err;
  }
  let plan;
  try {
    plan = planOf({ profile: profileOf({ ownEnvFile: true }) });
    assert.ok(!fdOps(plan.args).some((q) => q[2] === own),
      "no fd bind of a symlinked own .env: " + JSON.stringify(fdOps(plan.args)));
    assert.equal(plan.fds.some((f) => f.role === "own-env"), false, "no own-env fd is handed over");
    assert.ok(masked(plan.args, realpathSync(target)), "the target the add-on named stays masked");
    assert.ok(plan.refused.some((r) => r.path === own && /symlink/.test(r.reason)),
      "the own .env is refused: " + JSON.stringify(plan.refused));
    // Another bundle's .env and the checkout's .env stay masked, and no bundle
    // other than this one is even named.
    assert.ok(masked(plan.args, realpathSync(join(APP, ".env"))));
    assert.ok(!plan.args.includes(join(BUNDLES, "other", ".env")), "an unbound bundle's .env is not named at all");
  } finally {
    if (plan) closePlan(plan);
    rmSync(own, { force: true });
    writeFileSync(own, "ACME=1");
  }
});

// ---- a read-write bind never lands in a hidden home entry ----------------

test("a read-write bind is refused under a hidden home entry, except the add-on's own trees", () => {
  const uvToken = join(UV_DIR, "tok.json");
  writeFileSync(uvToken, "{}");
  const bashrc = join(HOME, ".bashrc");
  writeFileSync(bashrc, "");
  const unit = join(HOME, ".config", "systemd", "user", "x.conf");
  mk(dirname(unit));
  writeFileSync(unit, "");
  const autoItem = join(HOME, ".config", "autostart", "x", "y.json");
  mk(dirname(autoItem));
  writeFileSync(autoItem, "");
  const notes = mk(HOME, "notes");
  const noteFile = join(notes, "out.txt");
  writeFileSync(noteFile, "");

  try {
    // An owner-set sign-in file inside a PATH directory (~/.local/bin).
    const pathDir = planOf({
      profile: profileOf({ files: { read: [], write: [], oauthDir: { from: "ACME_TOKEN", path: uvToken, source: "owner" }, state: [] } }),
    });
    try {
      assert.ok(pathDir.refused.some((r) => r.path === uvToken && /hidden entry of the home/.test(r.reason)),
        "~/.local/bin/tok.json is refused: " + JSON.stringify(pathDir.refused));
      assert.ok(!fdOps(pathDir.args).some((q) => q[2] === UV_DIR), "~/.local/bin is not bound read-write");
      assert.ok(!has(pathDir.args, "--bind", UV_DIR), "nor by path");
    } finally { closePlan(pathDir); }

    const writes = planOf({
      profile: profileOf({
        files: {
          read: [],
          write: [
            { from: "RC", path: bashrc, source: "owner" },
            { from: "UNIT", path: unit, source: "owner" },
            { from: "AUTO", path: autoItem, source: "owner" },
            { from: "NOTE", path: noteFile, source: "owner" },
          ],
          oauthDir: null,
          state: ["browser-sessions"],
        },
      }),
    });
    try {
      for (const p of [bashrc, unit, autoItem]) {
        assert.ok(writes.refused.some((r) => r.path === p), p + " refused: " + JSON.stringify(writes.refused));
        assert.ok(!fdOps(writes.args).some((q) => q[2] === p), p + " not bound");
      }
      assert.ok(writes.refused.some((r) => r.path === unit && /autostart or systemd/.test(r.reason)),
        "a unit file is refused for the systemd component");
      assert.ok(writes.refused.some((r) => r.path === autoItem && /autostart or systemd/.test(r.reason)),
        "an autostart entry is refused for the autostart component");

      // The add-on's own trees stay writable: its data folder, its state
      // folder (itself under the hidden Crow home), and a visible owner path.
      assert.ok(fdOps(writes.args).some((q) => q[2] === ADDON_DATA), "the own data folder is bound");
      assert.ok(fdOps(writes.args).some((q) => q[2] === STATE), "the own state folder is bound");
      assert.ok(fdOps(writes.args).some((q) => q[2] === noteFile), "a visible owner-set write path is bound");
    } finally { closePlan(writes); }
  } finally {
    rmSync(uvToken, { force: true });
    rmSync(unit, { force: true });
    rmSync(join(HOME, ".config", "systemd"), { recursive: true, force: true });
    rmSync(join(HOME, ".config", "autostart"), { recursive: true, force: true });
    rmSync(notes, { recursive: true, force: true });
    rmSync(bashrc, { force: true });
  }
});

// ---- .env files inside a folder bound by fd -----------------------------

test("a .env inside a folder bound by fd is masked, at any depth", () => {
  const stateEnv = join(STATE, ".env");
  const stateDeep = join(mk(STATE, "sub"), ".env.local");
  const signEnv = join(SIGNIN, ".env");
  const signDeep = join(mk(SIGNIN, "sub"), ".env.local");
  for (const p of [stateEnv, stateDeep, signEnv, signDeep]) writeFileSync(p, "SECRET=1");
  const plan = planOf({
    profile: profileOf({ files: { read: [], write: [], oauthDir: { from: "ACME_TOKEN", path: TOKEN, source: "owner" }, state: ["browser-sessions"] } }),
  });
  try {
    assert.ok(fdOps(plan.args).some((q) => q[2] === STATE), "the state folder is still bound");
    assert.ok(fdOps(plan.args).some((q) => q[2] === SIGNIN), "the sign-in folder is still bound");
    for (const p of [stateEnv, stateDeep, signEnv, signDeep]) assert.ok(masked(plan.args, p), p + " masked");
    // The mask sits after the bind of the folder holding it.
    const ops = pairs(plan.args);
    const bindAt = ops.findIndex((q) => q[2] === STATE && q[0] !== "--ro-bind");
    const maskAt = ops.findIndex((q) => q[0] === "--ro-bind" && q[1] === "/dev/null" && q[2] === stateEnv);
    assert.ok(bindAt >= 0 && maskAt > bindAt, "the folder's bind comes first, then the mask");
  } finally {
    closePlan(plan);
    for (const p of [stateEnv, stateDeep, signEnv, signDeep]) rmSync(p, { force: true });
    rmSync(join(STATE, "sub"), { recursive: true, force: true });
    rmSync(join(SIGNIN, "sub"), { recursive: true, force: true });
  }
});

test("a folder bound by fd that is too large to scan is not bound, and its fd is closed", () => {
  const filler = [];
  for (let i = 0; i < 6; i++) {
    const p = join(STATE, "f" + i);
    writeFileSync(p, "");
    filler.push(p);
  }
  const before = scratchFds();
  let plan;
  try {
    plan = planOf({
      envScanMaxEntries: 3,
      profile: profileOf({ files: { read: [], write: [], oauthDir: null, state: ["browser-sessions"] } }),
    });
    assert.ok(plan.refused.some((r) => r.path === STATE && /too large to scan for .env files/.test(r.reason)),
      "the state folder is refused: " + JSON.stringify(plan.refused));
    assert.ok(!fdOps(plan.args).some((q) => q[2] === STATE), "the state folder is not bound");
    for (const f of plan.fds) assert.notEqual(readlinkSync("/proc/self/fd/" + f.fd), STATE, "no fd for it is handed over");
  } finally {
    if (plan) closePlan(plan);
    for (const p of filler) rmSync(p, { force: true });
  }
  assert.deepEqual(scratchFds(), before, "the dropped fd was closed by the plan");
});

// ---- the command file ---------------------------------------------------

test("a command inside a tree the add-on can write is either already visible or refused", () => {
  // Already visible: inside the install folder and inside the own data folder.
  const inInstall = join(BUNDLES, "acme", "server", "index.js");
  const visible = planOf({ entry: { command: inInstall, args: [] }, pathEnv: "" });
  try {
    assert.ok(!has(visible.args, "--ro-bind", inInstall), "the install folder's own file is not bound again");
    assert.ok(!visible.refused.some((r) => r.path === inInstall), "and not refused either");
  } finally { closePlan(visible); }

  const ownRun = join(ADDON_DATA, "run.sh");
  writeFileSync(ownRun, "#!/bin/sh\n");
  const inData = planOf({ entry: { command: ownRun, args: [] }, pathEnv: "" });
  try {
    assert.ok(!has(inData.args, "--ro-bind", ownRun), "the data folder's own file is not bound again");
    assert.ok(!inData.refused.some((r) => r.path === ownRun), "and not refused either");
  } finally {
    closePlan(inData);
    rmSync(ownRun, { force: true });
  }

  // Refused: another add-on's data folder, a state folder, an owner-set write
  // path, and the Crow home outside the install folder.
  const otherRun = join(mk(DATA, "other", "bin"), "run.sh");
  writeFileSync(otherRun, "#!/bin/sh\n");
  const stateRun = join(STATE, "run.sh");
  writeFileSync(stateRun, "#!/bin/sh\n");
  const notes = mk(HOME, "notes");
  const noteRun = join(notes, "run.sh");
  writeFileSync(noteRun, "#!/bin/sh\n");
  writeFileSync(join(notes, "out.txt"), "");
  const profile = profileOf({
    files: { read: [], write: [{ from: "NOTE", path: notes, source: "owner" }], oauthDir: null, state: ["browser-sessions"] },
  });
  try {
    for (const [cmd, reason] of [[otherRun, /another add-on's data folder/], [stateRun, /this add-on can write/], [noteRun, /this add-on can write/]]) {
      const plan = planOf({ entry: { command: cmd, args: [] }, pathEnv: "", profile });
      try {
        assert.ok(plan.refused.some((r) => r.path === cmd && reason.test(r.reason)),
          cmd + " refused: " + JSON.stringify(plan.refused));
        assert.ok(unbound(plan.args, cmd), cmd + " is not a bind source");
      } finally { closePlan(plan); }
    }
  } finally {
    rmSync(otherRun, { force: true });
    rmSync(stateRun, { force: true });
    rmSync(notes, { recursive: true, force: true });
  }
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
    const before = scratchFds();
    assert.throws(() => planOf({ id: "not-installed" }), ContainRefused, "no install folder");
    assert.throws(() => planOf({ dataDir: join(CROW, "no-such-data") }), ContainRefused, "no data folder");
    assert.deepEqual(scratchFds(), before, "a refusal before any open leaks nothing");

    // A checked open that walks several components and then refuses the leaf.
    mk(BUNDLES, "linked-data", "server");
    const linked = join(CROW, "linked-data");
    symlinkSync(APP, linked);
    const beforeWalk = scratchFds();
    assert.throws(() => planOf({ id: "linked-data", dataDir: CROW }), ContainRefused, "a symlinked data leaf refuses");
    assert.deepEqual(scratchFds(), beforeWalk, "no fd left open by the failed walk");
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "ENOSYS")) { t.skip("this host does not allow symlinks in the scratch dir"); return; }
    throw err;
  }
});

test("a missing install folder refuses with a reason naming it", () => {
  assert.throws(() => planOf({ id: "not-installed" }),
    (e) => e instanceof ContainRefused && /does not exist/.test(e.message) && e.message.includes(join(BUNDLES, "not-installed")));
});

// ---- the id is a slug ----------------------------------------------------

test("an add-on id that is not one lowercase slug is refused before anything is opened", () => {
  const before = scratchFds();
  for (const bad of ["../x", "a/b", ".", "..", "", "A", undefined]) {
    assert.throws(() => planOf({ id: bad }),
      (e) => e instanceof ContainRefused && /invalid add-on id/.test(e.message),
      "id " + JSON.stringify(bad) + " is refused");
  }
  assert.deepEqual(scratchFds(), before, "no fd left open by a refused id");
});

// ---- a read-write data bind answers to the write side of the list --------

test("a data folder whose real path lands on the checkout is refused for the read-write bind", (t) => {
  // A symlinked dataDir whose target is inside the checkout: code is never
  // writable, so neither bind may be handed that folder.
  const target = mk(APP, "rw-data-probe");
  mk(target, "acme");
  const link = join(T, "rw-data-link");
  try {
    symlinkSync(target, link);
  } catch (err) {
    rmSync(target, { recursive: true, force: true });
    if (err && (err.code === "EPERM" || err.code === "ENOSYS")) { t.skip("this host does not allow symlinks in the scratch dir"); return; }
    throw err;
  }
  try {
    const before = scratchFds();
    assert.throws(() => planOf({ dataDir: link }),
      (e) => e instanceof ContainRefused && /cannot be bound read-write/.test(e.message) && /never writable/.test(e.message),
      "the <id> folder inside the checkout is refused");
    assert.deepEqual(scratchFds(), before, "no fd left open");

    assert.throws(() => planOf({ dataDir: link, profile: profileOf({ crowDb: true }) }),
      (e) => e instanceof ContainRefused && /cannot be bound read-write/.test(e.message) && /never writable/.test(e.message),
      "a crow.db profile is refused the same folder");
    assert.deepEqual(scratchFds(), before, "no fd left open");
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ---- ADDON_TOKEN_DIRS: a repo-sourced profile only -----------------------

test("an ADDON_TOKEN_DIRS entry applies only to a profile whose source is the repo copy", () => {
  // The shipped table is empty by design, so the lookup is fed the same shape
  // through the injected table.
  const tokenDir = mk(HOME, ".local", "share", "acme");
  const out = join(tokenDir, "out.json");
  writeFileSync(out, "{}");
  const outReal = realpathSync(out);
  const files = { read: [], write: [{ from: "ACME_OUT", path: out, source: "owner" }], oauthDir: null, state: [] };
  const tokenDirsTable = { acme: [".local/share/acme"] };
  const bound = (plan) => fdOps(plan.args).some((q) => q[0] === "--bind-fd" && q[2] === outReal);
  try {
    const fromRepo = planOf({ tokenDirsTable, profile: profileOf({ source: "repo", files }) });
    try {
      assert.ok(bound(fromRepo), "a repo-sourced profile binds the token dir file: " + JSON.stringify(fromRepo.refused));
      assert.ok(!fromRepo.refused.some((r) => r.path === out), "and refuses nothing for it");
    } finally { closePlan(fromRepo); }

    // Any other source (or none) gets no token dir: a hidden entry of the home
    // stays unwritable.
    for (const source of ["installed", undefined]) {
      const other = planOf({ tokenDirsTable, profile: profileOf({ source, files }) });
      try {
        assert.ok(other.refused.some((r) => r.path === out && /hidden entry of the home/.test(r.reason)),
          "source " + JSON.stringify(source) + ": " + JSON.stringify(other.refused));
        assert.ok(!bound(other), "source " + JSON.stringify(source) + " does not bind it");
      } finally { closePlan(other); }
    }
  } finally {
    rmSync(tokenDir, { recursive: true, force: true });
  }
});

// ---- nothing under the data dir except the add-on's own folder -----------

test("nothing under the data dir is a bind source except this add-on's own folder (data dir outside the Crow home)", () => {
  const OUT_DATA = mk(T, "var-data");
  const ownFolder = mk(OUT_DATA, "acme");
  mk(OUT_DATA, "other");
  writeFileSync(join(OUT_DATA, "other", "secret.txt"), "");
  for (const f of ["crow.db", "crow.db-wal", "crow.db-shm", "tasks.db", "backups"]) writeFileSync(join(OUT_DATA, f), "");
  const ownFile = join(ownFolder, "x.json");
  writeFileSync(ownFile, "{}");
  const OTHER_DATA_REASON = /another add-on's data, or Crow's own data/;

  const planWith = (mode, p, over = {}) => {
    const files = mode === "read"
      ? { read: [{ from: "P", path: p, source: "owner" }], write: [], oauthDir: null, state: [] }
      : { read: [], write: [{ from: "P", path: p, source: "owner" }], oauthDir: null, state: [] };
    return planOf({ dataDir: OUT_DATA, profile: profileOf({ files, ...over }) });
  };
  const boundByFd = (plan, p) => fdOps(plan.args).some((q) => q[2] === realpathSync(p));

  try {
    // A non-crowDb profile: another add-on's data, the DBs beside it and the
    // data dir's own entries are never bind sources.
    for (const [label, mode, p] of [
      ["an owner-set read of another add-on's data", "read", join(OUT_DATA, "other", "secret.txt")],
      ["an owner-set write of tasks.db", "write", join(OUT_DATA, "tasks.db")],
      ["an owner-set read of crow.db", "read", join(OUT_DATA, "crow.db")],
    ]) {
      const plan = planWith(mode, p);
      try {
        assert.ok(plan.refused.some((r) => r.path === p && OTHER_DATA_REASON.test(r.reason)),
          label + " is refused: " + JSON.stringify(plan.refused));
        assert.ok(!boundByFd(plan, p), label + " is not bound");
      } finally { closePlan(plan); }
    }

    // A crow.db profile keeps its data-dir bind and its masks unchanged, and
    // the DB files beside the add-on's own folder stay readable.
    const dbPlan = planOf({ dataDir: OUT_DATA, profile: profileOf({ crowDb: true }) });
    try {
      const op = pairs(dbPlan.args).find((q) => q[0] === "--bind-fd" && q[2] === realpathSync(OUT_DATA));
      assert.ok(op, "the data dir itself is bound by fd");
      assert.equal(dbPlan.fds.find((f) => String(f.childFd) === op[1]).role, "crow-data");
      for (const p of ["tasks.db", "backups", "other"]) assert.ok(masked(dbPlan.args, join(OUT_DATA, p)), p + " masked");
      for (const p of ["crow.db", "crow.db-wal", "crow.db-shm", "acme"]) assert.ok(!masked(dbPlan.args, join(OUT_DATA, p)), p + " kept");
    } finally { closePlan(dbPlan); }

    const dbRead = planWith("read", join(OUT_DATA, "crow.db"), { crowDb: true });
    try {
      assert.ok(!dbRead.refused.some((r) => OTHER_DATA_REASON.test(r.reason)),
        "a crow.db profile may read crow.db: " + JSON.stringify(dbRead.refused));
      assert.ok(boundByFd(dbRead, join(OUT_DATA, "crow.db")), "and it is bound read-only by fd");
    } finally { closePlan(dbRead); }

    // The add-on's own folder below the data dir is still a bind source.
    const ownPlan = planWith("write", ownFile);
    try {
      assert.ok(boundByFd(ownPlan, ownFile), "its own data file is bound: " + JSON.stringify(ownPlan.refused));
      assert.ok(!ownPlan.refused.some((r) => OTHER_DATA_REASON.test(r.reason)), "nothing of the data rule fires for it");
    } finally { closePlan(ownPlan); }

    // The same with the data dir INSIDE the Crow home (the existing layout).
    const insideOwn = planOf();
    try {
      assert.ok(fdOps(insideOwn.args).some((q) => q[2] === ADDON_DATA), "the own data folder is still bound");
    } finally { closePlan(insideOwn); }

    const insideOther = planOf({
      profile: profileOf({ files: { read: [{ from: "P", path: join(DATA, "other", ".cache"), source: "owner" }], write: [], oauthDir: null, state: [] } }),
    });
    try {
      assert.ok(insideOther.refused.some((r) => r.path === join(DATA, "other", ".cache") && OTHER_DATA_REASON.test(r.reason)),
        "another add-on's folder inside the home data dir is refused: " + JSON.stringify(insideOther.refused));
      assert.ok(!fdOps(insideOther.args).some((q) => q[2] === join(DATA, "other", ".cache")), "and not bound");
    } finally { closePlan(insideOther); }

    const insideDb = planOf({ profile: profileOf({ crowDb: true }) });
    try {
      assert.ok(pairs(insideDb.args).some((q) => q[0] === "--bind-fd" && q[2] === DATA), "the data dir bind is unchanged");
      assert.ok(masked(insideDb.args, join(DATA, "tasks.db")) && !masked(insideDb.args, join(DATA, "crow.db")), "the masks are unchanged");
    } finally { closePlan(insideDb); }
  } finally {
    rmSync(OUT_DATA, { recursive: true, force: true });
  }
});

// ---- a folder that contains the data dir is never a bind source ---------

test("a folder that contains the data dir is refused for a read and a write; a sibling folder is not", () => {
  const MEDIA = mk(T, "srv", "media");
  const OUT_DATA = mk(MEDIA, "crow-data");
  mk(OUT_DATA, "acme");
  const SIBLING = mk(T, "srv", "other");
  const siblingFile = join(SIBLING, "notes.txt");
  writeFileSync(siblingFile, "");
  const OTHER_DATA_REASON = /another add-on's data, or Crow's own data/;
  const planWith = (mode, p) => planOf({
    dataDir: OUT_DATA,
    profile: profileOf({
      files: mode === "read"
        ? { read: [{ from: "P", path: p, source: "owner" }], write: [], oauthDir: null, state: [] }
        : { read: [], write: [{ from: "P", path: p, source: "owner" }], oauthDir: null, state: [] },
    }),
  });
  const boundByFd = (plan, p) => fdOps(plan.args).some((q) => q[2] === realpathSync(p));

  try {
    for (const mode of ["read", "write"]) {
      // An ancestor of the data dir would hand over every add-on's folder and
      // Crow's own DB through one bind.
      const plan = planWith(mode, MEDIA);
      try {
        assert.ok(plan.refused.some((r) => r.path === MEDIA && OTHER_DATA_REASON.test(r.reason)),
          mode + ": the containing folder is refused: " + JSON.stringify(plan.refused));
        assert.ok(!boundByFd(plan, MEDIA), mode + ": never bound by fd");
        assert.ok(!pathSources(plan.args).includes(realpathSync(MEDIA)), mode + ": never a path-bind source");
      } finally { closePlan(plan); }

      // A folder beside the data dir says nothing about it.
      const sibling = planWith(mode, siblingFile);
      try {
        assert.ok(!sibling.refused.some((r) => OTHER_DATA_REASON.test(r.reason)),
          mode + ": the sibling draws no data-dir refusal: " + JSON.stringify(sibling.refused));
        assert.ok(boundByFd(sibling, siblingFile), mode + ": the sibling is bound");
      } finally { closePlan(sibling); }
    }
  } finally {
    rmSync(join(T, "srv"), { recursive: true, force: true });
  }
});

// ---- the autostart/systemd rule is about the inside of the home ----------

test("the autostart/systemd rule looks only at the part of a path inside the home", () => {
  // A data dir below a folder named `systemd`, outside the home: still bound.
  const OUT_DATA = mk(T, "systemd", "data");
  mk(OUT_DATA, "acme");
  const dataPlan = planOf({ dataDir: OUT_DATA });
  try {
    assert.ok(fdOps(dataPlan.args).some((q) => q[0] === "--bind-fd" && q[2] === realpathSync(join(OUT_DATA, "acme"))),
      "the own data folder is still bound: " + JSON.stringify(dataPlan.refused));
  } finally { closePlan(dataPlan); }

  const inside = join(mk(HOME, "projects", "systemd"), "out.txt");
  const outsideDir = mk(T, "autostart");
  const outside = join(outsideDir, "out.txt");
  writeFileSync(inside, "");
  writeFileSync(outside, "");
  const plan = planOf({
    profile: profileOf({
      files: {
        read: [],
        write: [{ from: "IN", path: inside, source: "owner" }, { from: "OUT", path: outside, source: "owner" }],
        oauthDir: null,
        state: [],
      },
    }),
  });
  try {
    assert.ok(plan.refused.some((r) => r.path === inside && /autostart or systemd/.test(r.reason)),
      "a systemd component inside the home is refused: " + JSON.stringify(plan.refused));
    assert.ok(!plan.refused.some((r) => r.path === outside), "outside the home the rule does not fire: " + JSON.stringify(plan.refused));
    assert.ok(fdOps(plan.args).some((q) => q[2] === realpathSync(outside)), "and the file is bound");
  } finally {
    closePlan(plan);
    rmSync(join(HOME, "projects"), { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ---- installDir: a built-in's own copy of its bundle ---------------------

test("installDir names the checkout's copy of the bundle: bound read-only and the working directory", () => {
  const repoInstall = mk(APP, "bundles", "acme");
  writeFileSync(join(repoInstall, "index.js"), "");
  const plan = planOf({ installDir: join(APP, "bundles", "acme") });
  try {
    const real = realpathSync(repoInstall);
    assert.ok(has(plan.args, "--ro-bind", real), "the checkout's copy is bound at its real path");
    assert.ok(!has(plan.args, "--bind", real), "never writable");
    assert.ok(pairs(plan.args).some((q) => q[0] === "--chdir" && q[1] === real), "the add-on starts in it");
    assert.ok(!has(plan.args, "--ro-bind", realpathSync(join(BUNDLES, "acme"))), "the installed copy is not bound instead");
    assert.ok(!plan.refused.some((r) => r.path === real || r.path === join(APP, "bundles", "acme")),
      "nothing was refused: " + JSON.stringify(plan.refused));
  } finally { closePlan(plan); }
});

test("an install folder outside the two allowed shapes is refused", () => {
  const elsewhere = mk(HOME, "elsewhere", "acme");
  const before = scratchFds();
  for (const bad of [elsewhere, join(BUNDLES, "other"), join(APP, "bundles", "other"), "bundles/acme", ""]) {
    assert.throws(() => planOf({ installDir: bad }),
      (e) => e instanceof ContainRefused && /install folder not allowed/.test(e.message),
      "install folder " + JSON.stringify(bad) + " is refused");
  }
  assert.deepEqual(scratchFds(), before, "a refused install folder leaves no fd open");
  rmSync(elsewhere, { recursive: true, force: true });
});

// ---- dataSubdir: one project-service child's folder ----------------------

test("dataSubdir: a service child's data bind is its own subfolder, not the add-on's data folder", () => {
  const subReal = realpathSync(mk(ADDON_DATA, "services", "0f0e0d0c-aaaa"));
  const plan = planOf({ dataSubdir: "services/0f0e0d0c-aaaa" });
  try {
    const dataBinds = fdOps(plan.args).filter((q) => q[0] === "--bind-fd");
    assert.deepEqual(dataBinds.map((q) => q[2]), [subReal], "one read-write data bind, of the subfolder");
    assert.ok(!fdOps(plan.args).some((q) => q[2] === ADDON_DATA), "the add-on's whole data folder is never a destination");
    assert.equal(plan.addonDataDir, subReal);
    assert.equal(plan.env.XDG_CACHE_HOME, join(subReal, ".cache"));
    assert.equal(plan.env.npm_config_cache, join(subReal, ".cache", "npm"));
    assert.ok(plan.env.UV_CACHE_DIR.startsWith(subReal));
    assert.equal(readlinkSync("/proc/self/fd/" + plan.fds.find((f) => f.role === "data").fd), subReal,
      "the fd really is the subfolder");
  } finally { closePlan(plan); }
});

test("two service subfolders of one add-on never name each other", () => {
  const a = realpathSync(mk(ADDON_DATA, "services", "aaaaaaaa-1"));
  const b = realpathSync(mk(ADDON_DATA, "services", "bbbbbbbb-2"));
  const pa = planOf({ dataSubdir: "services/aaaaaaaa-1" });
  const pb = planOf({ dataSubdir: "services/bbbbbbbb-2" });
  try {
    for (const [own, other, plan] of [[a, b, pa], [b, a, pb]]) {
      const dests = fdOps(plan.args).map((q) => q[2]);
      assert.ok(dests.includes(own), own + " is bound");
      assert.ok(!dests.some((d) => d === other || d.startsWith(other + "/")), other + " is never a destination");
      assert.ok(!pathSources(plan.args).some((s) => s === other || s.startsWith(other + "/")), other + " is never a source");
      assert.equal(plan.addonDataDir, own);
    }
  } finally {
    closePlan(pa);
    closePlan(pb);
  }
});

test("a crow.db service child: the add-on's data folder is masked, then its subfolder bound on top", () => {
  const subReal = realpathSync(mk(ADDON_DATA, "services", "0f0e0d0c-aaaa"));
  const plan = planOf({ profile: profileOf({ crowDb: true }), dataSubdir: "services/0f0e0d0c-aaaa" });
  try {
    assert.ok(masked(plan.args, ADDON_DATA), "the add-on's whole data folder is masked");
    const ops = pairs(plan.args);
    const maskAt = ops.findIndex((q) => (q[0] === "--tmpfs" && q[1] === ADDON_DATA)
      || (q[0] === "--ro-bind" && q[1] === "/dev/null" && q[2] === ADDON_DATA));
    const bindAt = ops.findIndex((q) => q[0] === "--bind-fd" && q[2] === subReal);
    assert.ok(maskAt >= 0, "the data folder's mask is in the argv");
    assert.ok(bindAt >= 0, "the subfolder is bound by fd");
    assert.ok(bindAt > maskAt, "the subfolder's bind comes after the mask");
    assert.equal(plan.addonDataDir, subReal);
    assert.equal(plan.env.XDG_CACHE_HOME, join(subReal, ".cache"));
  } finally { closePlan(plan); }
});

test("a data subfolder that is not one services/<uuid> segment is refused before anything is opened", () => {
  const before = scratchFds();
  for (const bad of ["../x", "services/../../etc", "services/ABC12345", "x/aaaaaaaa", "services/aaaa",
    "services/", "services/0f0e0d0c-aaaa/../x", ""]) {
    assert.throws(() => planOf({ dataSubdir: bad }),
      (e) => e instanceof ContainRefused && /invalid data subfolder/.test(e.message),
      "subfolder " + JSON.stringify(bad) + " is refused");
  }
  assert.deepEqual(scratchFds(), before, "a refused subfolder leaves no fd open");
});

test("a data subfolder that is a symlink into another add-on's data folder is refused", (t) => {
  const services = mk(ADDON_DATA, "services");
  const link = join(services, "0f0e0d0c-cafe");
  const target = mk(DATA, "other", "x");
  try {
    symlinkSync(target, link);
  } catch (err) {
    rmSync(services, { recursive: true, force: true });
    if (err && (err.code === "EPERM" || err.code === "ENOSYS")) { t.skip("this host does not allow symlinks in the scratch dir"); return; }
    throw err;
  }
  const before = scratchFds();
  try {
    assert.throws(() => planOf({ dataSubdir: "services/0f0e0d0c-cafe" }),
      (e) => e instanceof ContainRefused && /symlink/.test(e.message));
    assert.deepEqual(scratchFds(), before, "the refused walk leaves no fd open");
  } finally {
    rmSync(services, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ---- the door-token placeholder -----------------------------------------

test("doorTokenFd -1 is accepted as the caller's placeholder and still plans the bind", () => {
  const plan = planOf({ doorTokenFd: -1 });
  try {
    const spec = plan.fds.find((f) => f.role === "door-token");
    assert.ok(spec, "the placeholder is one of the fds the plan hands over");
    assert.deepEqual({ fd: spec.fd, role: spec.role }, { fd: -1, role: "door-token" });
    const ops = pairs(plan.args);
    const bindAt = ops.findIndex((q) => q[0] === "--ro-bind-data" && q[2] === "/run/crow-addon/door-token");
    assert.ok(bindAt >= 0, "the bind-data op is in the argv");
    assert.equal(ops[bindAt][1], String(spec.childFd), "it names the placeholder's child fd");
    assert.ok(bindAt > 0 && ops[bindAt - 1][0] === "--perms" && ops[bindAt - 1][1] === "0400", "0400 precedes it");
  } finally { closePlan(plan); }
});