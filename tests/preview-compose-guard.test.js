/**
 * The preview renderer's container files (servers/gateway/preview/container/) and the
 * one install-check allowance they need: `coreAllowance: "preview-renderer"` admits a
 * `seccomp=<path>` security_opt only for the shipped, hash-pinned seccomp-chrome.json.
 * Everything else in the compose is checked as for any bundle.
 *
 * The model cases ask Docker Compose for the model it will apply (as the renderer does)
 * and skip when `docker compose` is not on this machine (CI has it). The static cases
 * read the files.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(REPO, "servers", "gateway", "preview", "container");
const SECCOMP = realpathSync(join(DIR, "seccomp-chrome.json"));
const G = await import("../servers/gateway/compose-guard.js");

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-preview-guard-"));
const CROW_HOME = join(SCRATCH, "home");
const DATA = join(SCRATCH, "data");
after(() => {
  G._setPreviewSeccompPathForTest(null);
  rmSync(SCRATCH, { recursive: true, force: true });
});
const CTX = { crowHome: CROW_HOME, dataDir: DATA, appRoot: REPO };

let HAVE_COMPOSE = false;
try { execFileSync("docker", ["compose", "version"], { stdio: "pipe" }); HAVE_COMPOSE = true; } catch { /* skip model cases */ }
const dockerTest = (name, fn) => test(name, { skip: HAVE_COMPOSE ? false : "docker compose not available" }, fn);

const run = (args, { cwd, env }) => new Promise((resolve, reject) => execFile("docker", ["compose", ...args], { cwd, env }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout }))));
const env = (over = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CROW_PREVIEW_IMAGE: "crow-preview-renderer:000000000000",
  CROW_PREVIEW_SECCOMP: SECCOMP,
  CROW_PREVIEW_INSTANCE: "0a1b2c3d",
  CROW_PREVIEW_HOME: "4e5f6a7b",
  CROW_PREVIEW_ARTIFACT_HOST: "artifacts.example.test",
  ...over,
});
async function model(over = {}) {
  const loaded = await G.loadComposeModel(DIR, { env: env(over), runConfig: run, composeFile: join(DIR, "compose.yml"), cwd: DIR });
  assert.ok(loaded.model, loaded.error);
  return loaded.model;
}
const check = (m, opts = {}) => G.checkComposeModel(m, { bundleDir: DIR, manifest: null, consentVerified: false, ctx: CTX, ...opts });
const allow = (m) => check(m, { coreAllowance: "preview-renderer" });
const renderer = (m) => m.services.renderer;

// ---- the allowance, on the model Compose applies ------------------------------------

dockerTest("the compose passes with the allowance", async () => {
  const r = allow(await model());
  assert.deepEqual(r, { valid: true });
});

dockerTest("the same compose fails without it", async () => {
  const r = check(await model());
  assert.equal(r.valid, false);
  assert.match(r.reason, /security_opt seccomp=/);
});

dockerTest("the allowance plus cap_add still fails", async () => {
  const m = await model();
  renderer(m).cap_add = ["SYS_ADMIN"];
  const r = allow(m);
  assert.equal(r.valid, false);
  assert.match(r.reason, /SYS_ADMIN/);
});

dockerTest("the allowance refuses another seccomp file", async () => {
  // A byte-for-byte copy at another path: the realpath differs.
  const copy = join(SCRATCH, "seccomp-chrome.json");
  copyFileSync(SECCOMP, copy);
  const r1 = allow(await model({ CROW_PREVIEW_SECCOMP: copy }));
  assert.equal(r1.valid, false);
  assert.match(r1.reason, /security_opt seccomp=/);
  // The expected path with one byte changed: the hash differs.
  const changed = join(SCRATCH, "changed.json");
  const bytes = readFileSync(SECCOMP);
  bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x20 ? 0x09 : 0x20;
  writeFileSync(changed, bytes);
  G._setPreviewSeccompPathForTest(changed);
  try {
    const r2 = allow(await model({ CROW_PREVIEW_SECCOMP: changed }));
    assert.equal(r2.valid, false);
    assert.match(r2.reason, /security_opt seccomp=/);
    // The same override with the shipped bytes is admitted: only the hash refused it.
    copyFileSync(SECCOMP, changed);
    assert.deepEqual(allow(await model({ CROW_PREVIEW_SECCOMP: changed })), { valid: true });
  } finally {
    G._setPreviewSeccompPathForTest(null);
  }
});

dockerTest("the allowance refuses a relative seccomp path", async () => {
  const m = await model({ CROW_PREVIEW_SECCOMP: "./seccomp-chrome.json" });
  assert.ok(renderer(m).security_opt.includes("seccomp=./seccomp-chrome.json"), JSON.stringify(renderer(m).security_opt));
  const cwd = process.cwd();
  process.chdir(DIR);
  try {
    const r = allow(m);
    assert.equal(r.valid, false);
    assert.match(r.reason, /security_opt seccomp=\.\/seccomp-chrome\.json/);
  } finally {
    process.chdir(cwd);
  }
});

dockerTest("the allowance never permits host networking", async () => {
  const m = await model();
  renderer(m).network_mode = "host";
  const r = allow(m);
  assert.equal(r.valid, false);
  assert.match(r.reason, /network_mode host/);
});

test("an unknown core allowance is refused, not ignored", () => {
  const m = { name: "crow-preview-x", services: { renderer: { image: "busybox", security_opt: [`seccomp=${SECCOMP}`] } } };
  assert.equal(check(m, { coreAllowance: "preview-renderer" }).valid, true);
  const r = check(m, { coreAllowance: "something-else" });
  assert.equal(r.valid, false);
  assert.match(r.reason, /core allowance/);
});

// ---- static: the image, the shim, the compose, the profile -------------------------

const DOCKERFILE = readFileSync(join(DIR, "Dockerfile"), "utf8");
const SHIM = readFileSync(join(DIR, "pipe-shim.sh"), "utf8");
const COMPOSE = readFileSync(join(DIR, "compose.yml"), "utf8");
const PROFILE = JSON.parse(readFileSync(SECCOMP, "utf8"));
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("the image never disables the sandbox", () => {
  for (const [name, text] of [["pipe-shim.sh", SHIM], ["Dockerfile", DOCKERFILE]]) {
    assert.doesNotMatch(text, /no-sandbox/, name);
    assert.doesNotMatch(text, /disable-setuid-sandbox/, name);
  }
  assert.doesNotMatch(DOCKERFILE, /chromium\.d/, "the Dockerfile writes nothing under /etc/chromium.d");
});

test("the shim runs the real binary", () => {
  const lines = code(SHIM).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#!"));
  assert.equal(lines.length, 1, "the shim is one exec line");
  const [cmd, target] = lines[0].split(/\s+/);
  assert.equal(cmd, "exec");
  assert.equal(target, "/usr/lib/chromium/chromium");
  for (const flag of ["--headless=new", "--remote-debugging-pipe", "--user-data-dir=/tmp/profile", "--no-first-run",
    "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update",
    "--disable-crash-reporter", "--disable-dev-shm-usage", "--dns-prefetch-disable", "--mute-audio"]) {
    assert.ok(lines[0].split(/\s+/).includes(flag), flag);
  }
  assert.ok(lines[0].includes('--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE ${CROW_PREVIEW_ARTIFACT_HOST}"'), "resolver rules");
  assert.match(lines[0], /about:blank 3<&0 4>&1 1>\/dev\/null 0<\/dev\/null$/);
  assert.match(DOCKERFILE, /^ENTRYPOINT \["\/usr\/local\/bin\/pipe-shim\.sh"\]$/m);
});

dockerTest("the container has no network, ports, volumes or VNC", async () => {
  const s = renderer(await model());
  assert.deepEqual(Object.keys((await model()).services), ["renderer"]);
  assert.equal(s.network_mode, "none");
  for (const k of ["ports", "expose", "volumes", "volumes_from", "devices", "networks", "env_file", "gpus", "cap_add"]) {
    assert.equal(s[k], undefined, k);
  }
  assert.deepEqual(s.cap_drop, ["ALL"]);
  assert.equal(s.read_only, true);
  assert.equal(s.user, "10001:10001");
  assert.deepEqual(s.security_opt, ["no-new-privileges:true", `seccomp=${SECCOMP}`]);
  assert.deepEqual(s.labels, { "crow.component": "preview-renderer", "crow.instance": "0a1b2c3d", "crow.home": "4e5f6a7b" });
  assert.deepEqual(s.environment, { CROW_PREVIEW_ARTIFACT_HOST: "artifacts.example.test" });
  for (const [name, text] of [["compose.yml", COMPOSE], ["Dockerfile", DOCKERFILE], ["pipe-shim.sh", SHIM]]) {
    assert.doesNotMatch(code(text), /vnc|DISPLAY|xvfb/i, name);
  }
});

dockerTest("the compose never pulls or builds on run", async () => {
  const s = renderer(await model());
  assert.equal(s.pull_policy, "never");
  assert.equal(s.image, "crow-preview-renderer:000000000000");
  assert.match(COMPOSE, /^\s+pull_policy: never$/m);
});

const rulesFor = (name) => PROFILE.syscalls.filter((r) => r.names.includes(name));
// Rules that apply on x86_64 and arm64 (Docker's own s390-only clone rule is left as is).
const onOurArches = (r) => !r.includes?.arches;

test("the profile allows chroot unconditionally", () => {
  const rules = rulesFor("chroot");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action, "SCMP_ACT_ALLOW");
  assert.equal(rules[0].includes, undefined);
  assert.equal(rules[0].args, undefined);
  assert.ok(rules[0].comment, "the change says why");
});

test("the profile's clone rule is the reviewed mask", () => {
  for (const name of ["clone", "unshare"]) {
    const withArgs = rulesFor(name).filter((r) => r.args && onOurArches(r));
    assert.equal(withArgs.length, 1, name);
    assert.equal(withArgs[0].action, "SCMP_ACT_ALLOW");
    assert.deepEqual(withArgs[0].args, [{ index: 0, value: 234881024, valueTwo: 0, op: "SCMP_CMP_MASKED_EQ" }], name);
    assert.ok(withArgs[0].comment, "the change says why");
    // Every other rule naming it is Docker's CAP_SYS_ADMIN one, which cap_drop: ALL never meets.
    for (const r of rulesFor(name).filter((x) => x !== withArgs[0] && onOurArches(x))) assert.deepEqual(r.includes, { caps: ["CAP_SYS_ADMIN"] }, name);
  }
  assert.equal(0x0E000000, 234881024);
});

test("clone3 returns ENOSYS in the profile", () => {
  const rules = rulesFor("clone3").filter((r) => r.action !== "SCMP_ACT_ALLOW");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action, "SCMP_ACT_ERRNO");
  assert.equal(rules[0].errnoRet, 38);
  assert.ok(rules[0].comment, "the rule says why");
});

test("the profile is pinned by its sha256 next to the allowance", () => {
  assert.equal(createHash("sha256").update(readFileSync(SECCOMP)).digest("hex"), G.PREVIEW_SECCOMP_SHA256);
  assert.equal(PROFILE.defaultAction, "SCMP_ACT_ERRNO");
});

test("the base image is pinned by digest", () => {
  const from = DOCKERFILE.split("\n").filter((l) => /^FROM\s/i.test(l));
  assert.equal(from.length, 1);
  assert.match(from[0], /^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}$/);
});
