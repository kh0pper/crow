/**
 * What an add-on's plan does with a checkout that holds secrets or this
 * instance's own data (plan review, PR D follow-up): a generated `.mcp.json`
 * carries resolved secrets, and a data dir inside the checkout (`./data`, the
 * Docker `/app/data` layout) would be readable through the read-only checkout
 * bind. Both are masked; the add-on's own binds still land on top.
 *
 * Pure: scratch dirs under mkdtemp (realpath'd), a literal profile in the shape
 * `deriveProfile` returns. Every fd the plan hands back is closed here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContainRefused } from "../scripts/pi-bots/pi_contain.mjs";
import { buildAddonPlan } from "../scripts/addon-sandbox/plan.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-plan-secrets-")));
after(() => rmSync(T, { recursive: true, force: true }));

const UID = process.getuid();
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };

// ---- the fixture layout --------------------------------------------------

const HOME = mk(T, "home", "alex");
const NODE_DIR = mk(HOME, ".nvm", "versions", "node", "v24.0.0", "bin");
writeFileSync(join(NODE_DIR, "node"), "");
const NODE_BIN = join(NODE_DIR, "node");

// The checkout: a generated .mcp.json at its root, one inside a bundle folder,
// one below a skipped dir, and a data dir inside it.
const APP = mk(HOME, "crow");
writeFileSync(join(APP, ".env"), "SECRET=1");
writeFileSync(join(APP, ".mcp.json"), '{"mcpServers":{"memory":{"env":{"TOKEN":"x"}}}}');
mk(APP, "bundles", "acme");
writeFileSync(join(APP, "bundles", "acme", ".mcp.json"), "{}");
mk(APP, "node_modules", "dep");
writeFileSync(join(APP, "node_modules", "dep", ".mcp.json"), "{}");
const DATA_IN = mk(APP, "data");
mk(DATA_IN, "acme");

const CROW = mk(HOME, ".crow");
const BUNDLES = mk(CROW, "bundles");
mk(BUNDLES, "acme", "server");
writeFileSync(join(BUNDLES, "acme", "server", "index.js"), "");

/** A data dir outside the checkout: the layout every other test builds. */
const DATA_OUT = mk(T, "crow-data");
mk(DATA_OUT, "acme");

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
const closePlan = (plan) => {
  for (const f of plan.fds) {
    if (f.role === "door-token") continue; // the caller's own fd
    try { closeSync(f.fd); } catch { /* already closed */ }
  }
};
/** The index of the first mount op matching `want`. */
const opAt = (args, want) => pairs(args).findIndex(want);

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
    dataDir: DATA_OUT,
    gatewayPort: 3001,
    otherHomes: [],
    selfTargets: [],
    pathEnv: "",
    uid: UID,
    ...over,
  });
}

// ---- .mcp.json -----------------------------------------------------------

test("a generated .mcp.json is masked wherever the plan binds a tree by path", () => {
  const plan = planOf();
  try {
    assert.ok(has(plan.args, "--ro-bind", APP), "the checkout is bound read-only");
    assert.ok(masked(plan.args, join(APP, ".mcp.json")), "the checkout's own .mcp.json is masked");
    assert.ok(masked(plan.args, join(APP, "bundles", "acme", ".mcp.json")), "a bundle's .mcp.json is masked");
    assert.ok(!masked(plan.args, join(APP, "node_modules", "dep", ".mcp.json")), "a skipped dir is not walked");
    assert.ok(masked(plan.args, join(APP, ".env")), "the .env masks are still made");

    const ops = pairs(plan.args);
    const checkoutAt = opAt(plan.args, (q) => q[0] === "--ro-bind" && q[1] === APP);
    const maskAt = opAt(plan.args, (q) => q[0] === "--ro-bind" && q[1] === "/dev/null" && q[2] === join(APP, ".mcp.json"));
    assert.ok(checkoutAt >= 0 && maskAt > checkoutAt, "the mask comes after the bind it masks");
    assert.equal(ops.filter((q) => q[0] === "--ro-bind" && q[1] === "/dev/null" && q[2] === join(APP, ".mcp.json")).length, 1,
      "one mask for one file");
  } finally { closePlan(plan); }
});

test("a .mcp.json outside the bound trees is not named at all", () => {
  const outSide = join(T, "elsewhere", ".mcp.json");
  mk(T, "elsewhere");
  writeFileSync(outSide, "{}");
  const plan = planOf();
  try {
    assert.ok(!masked(plan.args, outSide), "an unbound file is never masked");
    assert.equal(plan.args.includes(outSide), false);
  } finally { closePlan(plan); }
});

// ---- a data dir inside the checkout --------------------------------------

// A data dir under the checkout cannot be bound read-write (the rw side of the
// bind policy refuses code), so such a plan FAILS CLOSED: the add-on is off and
// nothing of the data dir can reach it — not through the checkout bind either.
test("a data dir inside the checkout refuses the plan, so nothing of it is bound", () => {
  for (const profile of [profileOf(), profileOf({ crowDb: true })]) {
    assert.throws(() => planOf({ dataDir: DATA_IN, profile }),
      (e) => e instanceof ContainRefused && /cannot be bound read-write/.test(e.message) && /never writable/.test(e.message),
      "the data folder under the checkout is refused");
  }
});

// The mask is added wherever the data dir really sits under the checkout, so a
// policy that ever allows that layout still never shows the data dir through
// the read-only checkout bind. Here the reachable half of the same rule: a Crow
// home inside the checkout, with the data dir outside it.
test("a Crow home inside the checkout is masked, and the add-on's own folders are bound after the mask", () => {
  const crowdIn = mk(APP, "crow-home");
  mk(crowdIn, "bundles", "acme", "server");
  writeFileSync(join(crowdIn, "bundles", "acme", "server", "index.js"), "");
  mk(crowdIn, "secrets");
  writeFileSync(join(crowdIn, "secrets", "keychain.key"), "k");
  mk(crowdIn, "browser-sessions");
  const plan = planOf({
    crowHome: crowdIn,
    profile: profileOf({ files: { read: [], write: [], oauthDir: null, state: ["browser-sessions"] } }),
  });
  try {
    assert.ok(masked(plan.args, crowdIn), "the Crow home is masked under the checkout bind");
    const maskAt = opAt(plan.args, (q) => q[0] === "--tmpfs" && q[1] === crowdIn);
    assert.ok(maskAt >= 0, "the mask is in the argv");

    const install = realpathSync(join(crowdIn, "bundles", "acme"));
    const installAt = opAt(plan.args, (q) => q[0] === "--ro-bind" && q[1] === install);
    assert.ok(installAt >= 0, "the install folder still gets its own read-only bind");
    assert.ok(installAt > maskAt, "and lands after the mask");

    // A read-write bind under the checkout is refused, so the state folder is
    // never writable there either.
    const state = join(crowdIn, "browser-sessions");
    assert.equal(pairs(plan.args).some((q) => q[0] === "--bind-fd" && q[2] === state), false, "no read-write bind under the checkout");
    assert.ok(plan.refused.some((r) => r.path === state && /never writable/.test(r.reason)),
      "the state folder is refused: " + JSON.stringify(plan.refused));

    assert.equal(plan.args.some((a) => a.includes("keychain.key")), false, "no Crow secret is named");
    assert.equal(plan.refused.some((r) => r.path === join(crowdIn, "secrets")), false, "the secrets folder is not even refused: nothing names it");
  } finally { closePlan(plan); }
});

// ---- a data dir outside the checkout -------------------------------------

test("a data dir outside the checkout keeps the data-dir ops exactly as before", () => {
  const plan = planOf({ dataDir: DATA_OUT });
  try {
    const own = realpathSync(join(DATA_OUT, "acme"));
    assert.ok(!masked(plan.args, DATA_OUT), "nothing masks the data dir");
    const ops = pairs(plan.args);
    assert.equal(ops.filter((q) => q[0] === "--bind-fd" && q[2] === own).length, 1, "one data bind, of the own folder");
    assert.ok(!ops.some((q) => q[0] === "--bind-fd" && q[2] === DATA_OUT), "the data dir itself is not bound");
    assert.equal(plan.env.CROW_DATA_DIR, DATA_OUT);
    assert.equal(plan.unsetEnv.includes("CROW_DB_PATH"), true);
  } finally { closePlan(plan); }

  const dbPlan = planOf({ dataDir: DATA_OUT, profile: profileOf({ crowDb: true }) });
  try {
    const data = realpathSync(DATA_OUT);
    const op = pairs(dbPlan.args).find((q) => q[0] === "--bind-fd" && q[2] === data);
    assert.ok(op, "a crow.db plan binds the data dir itself, by fd");
    assert.ok(!masked(dbPlan.args, data), "and it is not masked");
    assert.ok(!masked(dbPlan.args, join(data, "acme")), "the own folder is not masked");
    assert.equal(dbPlan.env.CROW_DB_PATH, join(DATA_OUT, "crow.db"));
  } finally { closePlan(dbPlan); }
});
test("a tree too large to scan for .mcp.json is refused, never bound with one left unmasked", () => {
  assert.throws(() => planOf({ secretScanMaxEntries: 3 }), (err) => err instanceof ContainRefused && /too large to scan for secret files/.test(err.message));
});
