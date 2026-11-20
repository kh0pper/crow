/**
 * Shared Storage inside a bot's sandbox — a REAL bubblewrap run, both tiers.
 *
 * The point of piping the opened settings (scripts/pi-bots/mcp_writer.mjs) is that a bot's
 * child is configured WITHOUT ever reading the identity file. This test proves it where it
 * matters, inside the sandbox the bot's MCP servers actually run in:
 *
 *   contain tier (buildContainPlan) — the instance's identity.json is masked with /dev/null,
 *     so it reads EMPTY where the mask is reachable, and is refused outright (EACCES/ENOENT)
 *     where a host's real bwrap will not serve the masked path; either outcome keeps the seed
 *     out, so both are accepted and only the seed content is asserted strictly. The same
 *     sandbox's crow-storage client (the real servers/storage/s3-client.js, run by the real
 *     node) must still be configured, from the piped S3_* + CROW_STORAGE_FROM_HOST=1, with the
 *     piped endpoint and bucket prefix — and initStorageFromInstance (crow-storage's own first
 *     step) must succeed without a DB.
 *
 *   default tier (BWRAP_BASE) — the identity file IS readable there (this branch's default
 *     tier does not mask it; the identity-guard change does), and the hydrated child must not
 *     load servers/sharing/identity.js at all: an ESM loader hook records every load, and the
 *     marker file has to stay empty.
 *
 * In BOTH tiers the hydrated settings reach the probe the way they reach a real child: the
 * probe is STARTED with them on its OWN environment, taken from the bot's MCP block and
 * delivered on its argv — pi's shape (it runs inside the sandbox and starts the crow-storage
 * child with the env from its generated MCP config). They are never part of the sandbox's own
 * env: the contain plan clears it (--clearenv) and no storage name is added to the plan.
 *
 * Skipped with the harness's own reason where bubblewrap is unavailable. Every path read or
 * written here is inside this test's scratch tree (plus the read-only repo bind the child
 * imports the real s3-client from).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContainPlan, ensureContainMountPoints } from "../scripts/pi-bots/pi_contain.mjs";
import { probePiSandbox, BWRAP_BASE } from "../scripts/pi-bots/pi_sandbox.mjs";

const REPO = realpathSync(new URL("..", import.meta.url).pathname.replace(/\/$/, ""));

/**
 * The resolved DEPENDENCY directory this checkout imports from.
 *
 * A real install has a real `node_modules` INSIDE the checkout, and the contain plan binds the
 * checkout, so a contained child resolves its bare imports (s3-client.js imports `minio`) out of
 * the same tree a real contained bot gets. THIS worktree's `node_modules` is a SYMLINK to a shared
 * install elsewhere on the host: that link points outside the bound checkout, so inside the
 * sandbox it dangles and the child fails with "Cannot find package 'minio'". This test's fixture
 * therefore binds the link's TARGET read-only — the same dependency code, resolved the way node
 * resolves it. `null` on a normal checkout, where the checkout bind already covers it (and the
 * contain plan is left exactly as production uses it).
 */
const DEPS = (() => {
  const lexical = join(REPO, "node_modules");
  try {
    const resolved = realpathSync(lexical);
    return resolved === lexical ? null : resolved;
  } catch {
    return null; // no dependencies installed here: nothing to bind
  }
})();

const PROBE = probePiSandbox({ force: true });
const skip = PROBE.ok && PROBE.pidns !== false
  ? false
  : "bubblewrap with a PID namespace is unavailable here: " + (PROBE.reason || PROBE.pidnsReason || "no bwrap");

const T = realpathSync(mkdtempSync(join(tmpdir(), "crow-contain-storage-")));
after(() => rmSync(T, { recursive: true, force: true }));

const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };

const H = mk(T, "home", "alice");
const crowHome = mk(H, ".crow");
const data = mk(crowHome, "data");
const mine = mk(data, "projects", "mine", "workspace");
const session = mk(T, "session");
const cache = mk(crowHome, "bot-cache");
const shadow = mk(T, "shadow");
const piAgent = mk(H, ".pi", "agent");
writeFileSync(join(data, "crow.db"), "");

// The fixture identity: a plaintext seed in the shape loadIdentityIfPresent accepts. Its hex
// is the needle that must never appear in what the sandbox reports.
const SEED_HEX = "7c".repeat(32);
writeFileSync(join(data, "identity.json"), JSON.stringify({ version: 1, seed: SEED_HEX, crowId: "crow:fixture" }));

// The opened settings the bridge would have piped into the block.
const PIPED = {
  CROW_STORAGE_FROM_HOST: "1",
  S3_ENDPOINT: "127.0.0.1:19999",
  S3_USE_SSL: "false",
  S3_REGION: "us-east-1",
  S3_BUCKET_PREFIX: "fixture",
  S3_ACCESS_KEY: "pipedaccess",
  S3_SECRET_KEY: "pipedsecret",
};

/**
 * Everything the probe is STARTED with, on its argv: the bot's MCP block (command + the env a
 * hydrated crow-storage child runs with, as scripts/pi-bots/mcp_writer.mjs writes it) plus the
 * two fixture paths the probe itself needs. Delivered this way — not as sandbox env — because
 * that is the route the settings take in production, and because the contain tier's plan
 * starts with --clearenv, so the sandbox's env can never carry them.
 * One arg, marker-prefixed, so a cleared env changes nothing about the probe's own inputs.
 */
const CHILD_ARGV = "CROW_TEST_CHILD=" + JSON.stringify({
  command: "node",
  env: PIPED,
  app: REPO,
  identity: join(data, "identity.json"),
});

/**
 * The probe a bot's hydrated crow-storage child runs INSIDE the sandbox: it reads its MCP block
 * off argv and starts itself with that block's env (exactly what pi does to an MCP child), then
 * reads the identity file and does what the child does (adoptHostStorage, then crow-storage's
 * own initStorageFromInstance) and reports what it got.
 */
const PROBE_SCRIPT = `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const child = JSON.parse(process.argv.find((a) => a.startsWith("CROW_TEST_CHILD=")).slice("CROW_TEST_CHILD=".length));
Object.assign(process.env, child.env);
const out = {};
try {
  out.identityBytes = fs.readFileSync(child.identity).length;
  out.identity = "readable";
} catch (e) {
  out.identityBytes = null;
  out.identity = "ERR:" + (e.code || e.message);
}
const s3 = await import(pathToFileURL(join(child.app, "servers", "storage", "s3-client.js")).href);
out.mode = s3.adoptHostStorage();
out.configured = s3.isConfigured();
out.origin = s3.getStorageOrigin();
out.bucket = s3.defaultBucket();
out.childInit = await s3.initStorageFromInstance(null);
console.log(JSON.stringify(out));
`;

/** The contain tier's plan for this scratch bot, as pi_sandbox.mjs builds it. */
function containPlan() {
  return buildContainPlan({
    home: H, uid: process.getuid(), nodeBin: process.execPath,
    appRoot: REPO, piAgentDir: piAgent, shadowAgentDir: shadow,
    crowHome, dataDir: data, botCacheDir: cache,
    sessionDir: session, cwd: session, workspaceDir: mine,
    writePaths: [], readPaths: DEPS ? [DEPS] : [],
    // A symlinked dependency tree is bound read-only above, and the .env scan walks every bound
    // dir. Its production caps (entries AND depth) would DROP so large a policy path, so this
    // fixture lifts both (every .env found down there is still masked, as in production).
    envScanMaxEntries: Number.MAX_SAFE_INTEGER,
    envScanMaxDepth: 64,
    mcpServers: [{ command: "node", args: [join(REPO, "servers", "storage", "index.js")], cwd: REPO,
      env: { CROW_DB_PATH: join(data, "crow.db"), ...PIPED } }],
    systemDirs: ["/usr", "/etc"],
  });
}

/**
 * Run one node script inside the sandbox `sandboxArgs` describes, handing it the bot's MCP block
 * as the last argv element — the same delivery for BOTH tiers. Nothing the hydrated settings
 * travel under is added to the sandbox's env.
 */
function inSandbox(sandboxArgs, script, { env = {}, nodeArgs = [] } = {}) {
  return spawnSync(PROBE.bwrap, [...sandboxArgs, "--", process.execPath, ...nodeArgs,
    "--input-type=module", "-e", script, CHILD_ARGV], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...env },
    encoding: "utf8", timeout: 180_000,
  });
}

/** The contain tier: the spawn env is what production gives bwrap (this process's env plus the
 *  plan's), and the hydrated settings ride on the child's argv like every other child's. */
function inPlan(plan, script) {
  return inSandbox(plan.args, script, { env: plan.env });
}

const lastJson = (stdout) => JSON.parse(String(stdout).trim().split("\n").filter(Boolean).pop());

test("the contain plan masks the fixture identity file (checked on every host, with or without bwrap)", () => {
  const p = containPlan();
  assert.ok(p.args.some((a, i) => a === "--ro-bind" && p.args[i + 1] === "/dev/null" && p.args[i + 2] === join(data, "identity.json")),
    "identity.json is masked with /dev/null in the contain tier");
});

test("contain tier: the identity never reads the seed and the hydrated crow-storage child is still configured", { skip, timeout: 180_000 }, () => {
  const p = containPlan();
  ensureContainMountPoints(p.mountPoints);
  const r = inPlan(p, PROBE_SCRIPT);
  assert.equal(r.status, 0, "the probe ran inside the sandbox: " + (r.stderr || "") + (r.stdout || ""));
  const out = lastJson(r.stdout);

  // The identity file is unreachable, in one of two equally good ways: /dev/null is zero bytes
  // (a masked path that reads EMPTY), or the sandbox refuses the masked path outright
  // (EACCES/ENOENT on a host whose real bwrap will not serve it). Whichever a host does, the
  // SEED must never come back — that part is asserted strictly below.
  assert.ok(
    out.identity === "readable" || out.identity === "ERR:EACCES" || out.identity === "ERR:ENOENT",
    `the masked identity path is either empty-readable or refused, got ${out.identity}`);
  if (out.identity === "readable") {
    assert.equal(out.identityBytes, 0, "a masked identity reads EMPTY, never the seed");
  } else {
    assert.equal(out.identityBytes, null, "a refused identity read returns no bytes at all");
  }
  assert.equal(String(r.stdout).includes(SEED_HEX), false, "the seed appears nowhere in the sandbox's output");
  assert.equal(String(r.stderr).includes(SEED_HEX), false, "the seed appears nowhere in the sandbox's stderr");

  // …and the child is configured from the piped settings all the same.
  assert.equal(out.mode, "hydrated");
  assert.equal(out.configured, true, "storage is configured without any identity");
  assert.equal(out.origin, "http://127.0.0.1:19999");
  assert.equal(out.bucket, "fixture-files", "the piped bucket prefix, not crow-files");
  assert.equal(out.childInit, true, "crow-storage's own initStorageFromInstance returns true");
});

test("default tier: the identity IS readable there, and the hydrated child never loads it", { skip, timeout: 180_000 }, () => {
  const spyDir = mk(T, "spy");
  writeFileSync(join(spyDir, "hook.mjs"), `
import { appendFileSync } from "node:fs";
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (/\\/servers\\/sharing\\/identity\\.js$/.test(r.url)) appendFileSync(process.env.CROW_SPY_MARKER, r.url + "\\n");
  return r;
}
`);
  writeFileSync(join(spyDir, "load.mjs"), `
import { register } from "node:module";
register(new URL("./hook.mjs", import.meta.url));
`);
  const marker = join(spyDir, "loads.txt");
  // The SAME delivery as the contain tier: the block rides on the probe's argv, so the two legs
  // test the same thing — a child configured from its MCP block, never from the sandbox's env.
  const r = inSandbox(BWRAP_BASE, PROBE_SCRIPT, {
    env: { CROW_SPY_MARKER: marker },
    nodeArgs: ["--import", join(spyDir, "load.mjs")],
  });
  assert.equal(r.status, 0, "the probe ran inside the sandbox: " + (r.stderr || "") + (r.stdout || ""));
  const out = lastJson(r.stdout);

  // The control: in this tier the identity file really is readable, so "not loaded" is a
  // decision the child made, not something the sandbox forced on it.
  assert.equal(out.identity, "readable");
  assert.ok(out.identityBytes > 0, "the default tier leaves identity.json readable");
  assert.equal(existsSync(marker), false, "the hydrated child never even LOADS servers/sharing/identity.js");

  assert.equal(out.mode, "hydrated");
  assert.equal(out.configured, true);
  assert.equal(out.origin, "http://127.0.0.1:19999");
  assert.equal(out.bucket, "fixture-files");
  assert.equal(out.childInit, true);
});

test("default tier: the same subprocess DOES load identity.js when nothing was piped (spy control)", { skip, timeout: 180_000 }, () => {
  // Without the marker the child is on the OWNER path, which reads the identity — the spy has
  // to see that, or the test above could pass by never loading anything at all.
  const spyDir = mk(T, "spy-control");
  writeFileSync(join(spyDir, "hook.mjs"), `
import { appendFileSync } from "node:fs";
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (/\\/servers\\/sharing\\/identity\\.js$/.test(r.url)) appendFileSync(process.env.CROW_SPY_MARKER, r.url + "\\n");
  return r;
}
`);
  writeFileSync(join(spyDir, "load.mjs"), `
import { register } from "node:module";
register(new URL("./hook.mjs", import.meta.url));
`);
  const marker = join(spyDir, "loads.txt");
  const script = `
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const s3 = await import(pathToFileURL(join(process.env.CROW_TEST_APP, "servers", "storage", "s3-client.js")).href);
const adopted = s3.adoptHostStorage();
if (adopted === null) await s3.useDbStorageConfigFromInstance({ execute: async () => ({ rows: [] }) });
`;
  const r = spawnSync(PROBE.bwrap, [...BWRAP_BASE, "--", process.execPath, "--import", join(spyDir, "load.mjs"),
    "--input-type=module", "-e", script], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", CROW_TEST_APP: REPO, CROW_SPY_MARKER: marker, CROW_DATA_DIR: data },
    encoding: "utf8", timeout: 180_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(marker), "the owner path loads identity.js — the spy is real");
  assert.match(readFileSync(marker, "utf8"), /servers\/sharing\/identity\.js/);
});