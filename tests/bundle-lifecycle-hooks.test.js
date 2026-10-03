/** Bundle lifecycle hooks + compose-project ownership (Crow Workspace W1, Task 3). Scratch CROW_HOME before import. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-hooks-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-hooks-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;

const L = await import("../servers/gateway/bundle-lifecycle.js");
const B = await import("../servers/gateway/routes/bundles.js");
const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-hooks-app-"));
B._setAppBundlesForTest(FIXTURES);
const ownerless = async () => ({ stdout: "", stderr: "" }); // `docker ps` → no containers
after(() => {
  B._setComposeRunnerForTest(null); B._setHookRunnerForTest(null); B._setDockerRunnerForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

const COMPOSE = "services:\n  app:\n    image: busybox:1.36\n    restart: unless-stopped\n";
function fixture(id, manifest, compose = COMPOSE) {
  const dir = join(FIXTURES, id);
  mkdirSync(join(dir, "ops"), { recursive: true });
  const full = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", docker: { composefile: "docker-compose.yml" }, ...manifest };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(full));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  writeFileSync(join(dir, "ops", "bootstrap.sh"), "#!/usr/bin/env bash\necho ok\n");
  return full;
}
async function install(id, manifest) {
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  return { out, job };
}
const installedIds = () => (existsSync(join(CROW_HOME, "installed.json")) ? JSON.parse(readFileSync(join(CROW_HOME, "installed.json"), "utf8")).map((i) => i.id) : []);

test("safeRelPath accepts plain relative paths only", () => {
  assert.equal(L.safeRelPath("workspace/backups-staging"), "workspace/backups-staging");
  for (const bad of ["", "/etc", "../x", "a/../../x", null, 3]) assert.equal(L.safeRelPath(bad), null, String(bad));
});

test("precreateDirs makes 0700 dirs under CROW_HOME and validates every entry first", () => {
  const home = mkdtempSync(join(tmpdir(), "pc-"));
  assert.deepEqual(L.precreateDirs({ docker: { precreate: ["ws", "ws/staging"] } }, home), [join(home, "ws"), join(home, "ws/staging")]);
  assert.equal(statSync(join(home, "ws")).mode & 0o777, 0o700);
  assert.throws(() => L.precreateDirs({ docker: { precreate: ["ok-first", "../escape"] } }, home), /relative path inside CROW_HOME/);
  assert.equal(existsSync(join(home, "ok-first")), false);
});

test("postInstallPlan: none, community refusal, bad path, default and clamped timeout", () => {
  assert.equal(L.postInstallPlan({}), null);
  assert.match(L.postInstallPlan({ origin: "community", postInstall: { script: "ops/x.sh" } }).refused, /first-party/);
  assert.match(L.postInstallPlan({ postInstall: { script: "../x.sh" } }).refused, /relative \.sh path/);
  assert.match(L.postInstallPlan({ postInstall: { script: "ops/x.py" } }).refused, /relative \.sh path/);
  assert.deepEqual(L.postInstallPlan({ postInstall: { script: "ops/x.sh" } }), { script: "ops/x.sh", timeoutMs: 600_000 });
  assert.equal(L.postInstallPlan({ postInstall: { script: "ops/x.sh", timeout_s: 99999 } }).timeoutMs, 1_800_000);
});

test("hookEnv is minimal: PATH/HOME/DOCKER_* + CROW_HOME + CROW_BUNDLE_DIR, nothing else from the gateway", () => {
  const env = L.hookEnv("/b/ws", "/h", { PATH: "/usr/bin", HOME: "/home/k", DOCKER_HOST: "unix:///x", ANTHROPIC_API_KEY: "sk-no", CROW_DB_PATH: "/db", USER: "k" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/k", USER: "k", DOCKER_HOST: "unix:///x", CROW_HOME: "/h", CROW_BUNDLE_DIR: "/b/ws" });
});

test("spawnGroup kills the whole process group on timeout (no orphaned grandchildren)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grp-"));
  const pidFile = join(dir, "child.pid");
  const t0 = Date.now();
  await assert.rejects(L.spawnGroup("bash", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { env: { PATH: process.env.PATH }, timeout: 500 }));
  assert.ok(Date.now() - t0 < 15_000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), "grandchild must be dead");
});

test("runPostInstall: bash <abs script>, cwd, env, timeout; failure carries a stderr tail and a re-run command", async () => {
  const dest = mkdtempSync(join(tmpdir(), "rp-"));
  mkdirSync(join(dest, "ops")); writeFileSync(join(dest, "ops", "b.sh"), "echo hi\n");
  const calls = []; const logs = [];
  const ok = await L.runPostInstall({
    manifest: { postInstall: { script: "ops/b.sh", timeout_s: 5 } }, destDir: dest, env: { CROW_HOME: "/h" },
    log: (m) => logs.push(m), runner: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: "step one\nstep two\n", stderr: "" }; },
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(calls[0].cmd, "bash");
  assert.deepEqual(calls[0].args, [join(dest, "ops", "b.sh")]);
  assert.equal(calls[0].opts.cwd, dest);
  assert.equal(calls[0].opts.timeout, 5000);
  assert.ok(logs.some((l) => l.includes("step two")));
  const bad = await L.runPostInstall({
    manifest: { postInstall: { script: "ops/b.sh" } }, destDir: dest, env: { CROW_HOME: "/h o'me", CROW_BUNDLE_DIR: dest }, log: () => {},
    runner: async () => { throw Object.assign(new Error("exit 1"), { stdout: "", stderr: "Nextcloud not ready after 600s" }); },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /post-install setup failed: .*Nextcloud not ready/);
  assert.equal(bad.rerun, `CROW_HOME='/h o'\\''me' CROW_BUNDLE_DIR='${dest}' bash '${join(dest, "ops", "b.sh")}'`);
});

test("composeProjectName fallback: COMPOSE_PROJECT_NAME > interpolated name: > dirname", () => {
  assert.equal(L.composeProjectName("name: crow-workspace\nservices: {}\n", "/x/bundles/workspace"), "crow-workspace");
  assert.equal(L.composeProjectName("services: {}\n", "/x/bundles/Work Space"), "workspace");
  const browser = "name: ${CROW_BROWSER_CONTAINER_NAME:-browser}\nservices: {}\n";
  assert.equal(L.composeProjectName(browser, "/h/bundles/browser", {}), "browser");
  assert.equal(L.composeProjectName(browser, "/h/bundles/browser", { CROW_BROWSER_CONTAINER_NAME: "crow-browser-x" }), "crow-browser-x");
  assert.equal(L.composeProjectName(browser, "/h/bundles/browser", { COMPOSE_PROJECT_NAME: "crow-browser-r4" }), "crow-browser-r4");
});

test("resolveComposeProject prefers `docker compose config` and falls back when it fails", async () => {
  const ok = async (cmd, args) => (args[0] === "compose" ? { stdout: JSON.stringify({ name: "crow-browser-r4" }), stderr: "" } : { stdout: "", stderr: "" });
  assert.equal(await L.resolveComposeProject({ projectDir: "/h/bundles/browser", composeText: "services: {}\n", envVars: {}, runner: ok }), "crow-browser-r4");
  const down = async () => { throw new Error("no docker"); };
  assert.equal(await L.resolveComposeProject({ projectDir: "/h/bundles/browser", composeText: "services: {}\n", envVars: { COMPOSE_PROJECT_NAME: "crow-browser-r4" }, runner: down }), "crow-browser-r4");
});

test("classifyProjectOwners: only another Crow install OF THIS BUNDLE is an owner; legacy paths are unrelated", async () => {
  const mine = mkdtempSync(join(tmpdir(), "own-mine-"));
  const otherHome = mkdtempSync(join(tmpdir(), "own-otherhome-"));
  mkdirSync(join(otherHome, "bundles", "ws"), { recursive: true });
  writeFileSync(join(otherHome, "installed.json"), JSON.stringify([{ id: "ws", type: "bundle" }]));
  const notInstalledHome = mkdtempSync(join(tmpdir(), "own-stale-"));
  mkdirSync(join(notInstalledHome, "bundles", "ws"), { recursive: true });
  const mk = (stdout) => async () => ({ stdout, stderr: "" });
  const args = (stdout) => ({ project: "p", projectDir: mine, bundleId: "ws", crowHome: join(mine, ".."), runner: mk(stdout) });
  assert.deepEqual(await L.classifyProjectOwners(args(`${otherHome}/bundles/ws\n`)), { owner: `${otherHome}/bundles/ws`, unrelated: [] });
  assert.deepEqual(await L.classifyProjectOwners(args("/home/k/crow-addons/llamacpp-vulkan-qwen36-35b-a3b\n")), { owner: null, unrelated: ["/home/k/crow-addons/llamacpp-vulkan-qwen36-35b-a3b"] });
  assert.deepEqual(await L.classifyProjectOwners(args("/home/k/crow/bundles/ws\n")), { owner: null, unrelated: ["/home/k/crow/bundles/ws"] }, "a repo checkout path has no installed.json listing → legacy");
  assert.deepEqual(await L.classifyProjectOwners(args(`${notInstalledHome}/bundles/ws\n`)), { owner: null, unrelated: [`${notInstalledHome}/bundles/ws`] });
  assert.deepEqual(await L.classifyProjectOwners(args(`${otherHome}/bundles/other-id\n`)), { owner: null, unrelated: [`${otherHome}/bundles/other-id`] });
  assert.deepEqual(await L.classifyProjectOwners(args(`${mine}\n${mine}\n`)), { owner: null, unrelated: [] });
  assert.deepEqual(await L.classifyProjectOwners({ ...args(""), runner: async () => { throw new Error("no docker"); } }), { owner: null, unrelated: [] });
});

test("install: precreate, pull/up with opt-in long timeout, hook AFTER installed.json, minimal env", async () => {
  B._setDockerRunnerForTest(ownerless);
  const m = fixture("hk-ok", { docker: { composefile: "docker-compose.yml", precreate: ["hk-ok-data"], pull_timeout_s: 1800 }, postInstall: { script: "ops/bootstrap.sh", timeout_s: 30 } });
  const order = [];
  B._setComposeRunnerForTest(async (args, opts) => { order.push({ step: args[0], timeout: opts.timeout }); return { stdout: "", stderr: "" }; });
  B._setHookRunnerForTest(async (cmd, args, opts) => { order.push({ step: "hook", env: opts.env, cwd: opts.cwd, recorded: installedIds().includes("hk-ok") }); return { stdout: "done\n", stderr: "" }; });
  const { out } = await install("hk-ok", m);
  assert.equal(out.ok, true, out.reason);
  assert.ok(existsSync(join(CROW_HOME, "hk-ok-data")));
  assert.deepEqual(order.map((o) => o.step), ["pull", "up", "hook"]);
  assert.equal(order[0].timeout, 1_800_000);
  assert.equal(order[1].timeout, 1_800_000);
  assert.equal(order[2].recorded, true, "installed.json is written BEFORE the hook runs");
  assert.equal(order[2].env.CROW_BUNDLE_DIR, join(CROW_HOME, "bundles", "hk-ok"));
  assert.equal(order[2].env.CROW_HOME, CROW_HOME);
  assert.equal(order[2].env.CROW_DATA_DIR, undefined, "no gateway env leaks into the hook");
});

test("install: no pull_timeout_s → compose keeps run()'s default timeout", async () => {
  B._setDockerRunnerForTest(ownerless);
  const seen = [];
  B._setComposeRunnerForTest(async (args, opts) => { seen.push(opts.timeout); return { stdout: "", stderr: "" }; });
  B._setHookRunnerForTest(null);
  const { out } = await install("hk-default", fixture("hk-default", {}));
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(seen, [undefined, undefined]);
});

test("install: a failing hook keeps the bundle installed, ends not-ok, and logs the re-run command", async () => {
  B._setDockerRunnerForTest(ownerless);
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  B._setHookRunnerForTest(async () => { throw Object.assign(new Error("exit 1"), { stderr: "boom" }); });
  const { out, job } = await install("hk-fail", fixture("hk-fail", { postInstall: { script: "ops/bootstrap.sh" } }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /post-install setup failed: .*boom/);
  assert.ok(installedIds().includes("hk-fail"));
  assert.ok(B._getJobForTest(job.id).log.some((l) => l.includes(`CROW_HOME='${CROW_HOME}' CROW_BUNDLE_DIR='${join(CROW_HOME, "bundles", "hk-fail")}' bash '${join(CROW_HOME, "bundles", "hk-fail", "ops", "bootstrap.sh")}'`)));
});

test("install: compose up failure → hook never runs; community bundle → hook refused", async () => {
  B._setDockerRunnerForTest(ownerless);
  let hookCalls = 0;
  B._setHookRunnerForTest(async () => { hookCalls++; return { stdout: "", stderr: "" }; });
  B._setComposeRunnerForTest(async (args) => { if (args[0] === "up") throw Object.assign(new Error("x"), { stderr: "port busy" }); return { stdout: "", stderr: "" }; });
  await install("hk-upfail", fixture("hk-upfail", { postInstall: { script: "ops/bootstrap.sh" } }));
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  const { out } = await install("hk-comm", fixture("hk-comm", { origin: "community", postInstall: { script: "ops/bootstrap.sh" } }));
  assert.equal(hookCalls, 0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /first-party/);
});

test("install: an unsafe precreate entry refuses the install and removes the copied files", async () => {
  B._setDockerRunnerForTest(ownerless);
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  const { out } = await install("hk-esc", fixture("hk-esc", { docker: { composefile: "docker-compose.yml", precreate: ["../outside"] } }));
  assert.equal(out.ok, false);
  assert.equal(existsSync(join(CROW_HOME, "bundles", "hk-esc")), false);
});

test("REVIEW FOCUS 6 — a second instance cannot adopt another instance's compose project", async () => {
  const id = "hk-owned";
  const m = fixture(id, { postInstall: { script: "ops/bootstrap.sh" } }, "name: crow-shared\nservices:\n  app:\n    image: busybox:1.36\n");
  const composeCalls = [];
  B._setComposeRunnerForTest(async (args) => { composeCalls.push(args[0]); return { stdout: "", stderr: "" }; });
  // The household's install lives in ANOTHER Crow home that really lists this bundle.
  const otherHome = mkdtempSync(join(tmpdir(), "hk-otherhome-"));
  mkdirSync(join(otherHome, "bundles", id), { recursive: true });
  writeFileSync(join(otherHome, "installed.json"), JSON.stringify([{ id, type: "bundle", version: "0.1.0" }]));
  const dockerCalls = [];
  B._setDockerRunnerForTest(async (cmd, args) => {
    dockerCalls.push(args);
    if (args[0] === "compose") throw new Error("config unavailable"); // exercise the fallback resolver
    return { stdout: `${otherHome}/bundles/${id}\n`, stderr: "" };
  });
  // install refused, nothing started, copied files removed
  const { out } = await install(id, m);
  assert.equal(out.ok, false);
  assert.equal(out.reason, `This extension's containers (compose project "crow-shared") belong to another Crow install on this host (${otherHome}/bundles/${id}): manage them from there.`);
  assert.deepEqual(composeCalls, []);
  assert.ok(dockerCalls.some((a) => a.includes("label=com.docker.compose.project=crow-shared")));
  assert.equal(existsSync(join(CROW_HOME, "bundles", id)), false);
  // a copy that IS installed here (older install) cannot start/stop/down the foreign project
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "docker-compose.yml"), "name: crow-shared\nservices:\n  app:\n    image: busybox:1.36\n");
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([...installedIds().map((i) => ({ id: i })), { id, type: "bundle", version: "0.1.0" }]));
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    for (const action of ["start", "stop"]) {
      const r = await post(`/bundles/api/${action}`, { bundle_id: id });
      assert.equal(r.status, 409, `${action}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /another Crow install/);
    }
    const u = await post("/bundles/api/uninstall", { bundle_id: id });
    assert.equal(u.status, 200);
    const deadline = Date.now() + 10_000;
    while (existsSync(dir) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  } finally { server.close(); }
  assert.deepEqual(composeCalls, [], "no up/stop/down ever reached the foreign project");
  assert.equal(existsSync(dir), false, "this instance's own files are still removed");
});

test("shared-storage apply is guarded: a foreign compose project gets 409 and no recreate", async () => {
  const id = "hk-ss";
  const compose = "name: crow-ss\nservices:\n  app:\n    image: busybox:1.36\n";
  const m = { ...fixture(id, {}, compose), storage: { translator: "env-s3" } };
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(m)); // the route reads the repo manifest for storage.translator
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  const otherHome = mkdtempSync(join(tmpdir(), "hk-ss-other-"));
  writeFileSync(join(otherHome, "installed.json"), JSON.stringify([{ id }]));
  B._setDockerRunnerForTest(async (cmd, args) => { if (args[0] === "compose") throw new Error("x"); return { stdout: `${otherHome}/bundles/${id}\n`, stderr: "" }; });
  const calls = [];
  B._setComposeRunnerForTest(async (args) => { calls.push(args[0]); return { stdout: "", stderr: "" }; });
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/shared-storage/apply/${id}`, { method: "POST" });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /another Crow install/);
  } finally { server.close(); }
  assert.deepEqual(calls, []);
});

async function startBundle(id) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id }) });
    return { status: r.status, body: await r.json() };
  } finally { server.close(); }
}
function seedInstalledCompose(id, compose, envText) {
  const m = fixture(id, {}, compose);
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  if (envText) writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  return dir;
}

test("run() keeps its 300 s default when a caller passes timeout: undefined", () => {
  assert.equal(B._runOptsForTest({ cwd: "/x", timeout: undefined }).timeout, 300_000);
  assert.equal(B._runOptsForTest({}).timeout, 300_000);
  assert.equal(B._runOptsForTest({ timeout: 1_800_000 }).timeout, 1_800_000);
});

test("regression (R4 browser): COMPOSE_PROJECT_NAME in .env selects the project that is queried and started", async () => {
  const id = "hk-browser";
  const dir = seedInstalledCompose(id, "name: ${CROW_BROWSER_CONTAINER_NAME:-hk-browser}\nservices:\n  app:\n    image: busybox:1.36\n", "COMPOSE_PROJECT_NAME=crow-hk-browser-r4\n");
  for (const configWorks of [true, false]) {
    const filters = [];
    B._setDockerRunnerForTest(async (cmd, args) => {
      if (args[0] === "compose") { if (!configWorks) throw new Error("no config"); return { stdout: JSON.stringify({ name: "crow-hk-browser-r4" }), stderr: "" }; }
      const f = args.find((a) => a.startsWith("label=")); filters.push(f);
      return { stdout: `${dir}\n`, stderr: "" }; // only our own project is ever queried, and it is ours
    });
    const calls = [];
    B._setComposeRunnerForTest(async (args) => { calls.push(args[0]); return { stdout: "", stderr: "" }; });
    const r = await startBundle(id);
    assert.equal(r.status, 200, `configWorks=${configWorks}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(filters, ["label=com.docker.compose.project=crow-hk-browser-r4"]);
    assert.deepEqual(calls, ["up"]);
  }
});

test("regression (legacy provenance): containers started from ~/crow-addons or a repo checkout stay controllable", async () => {
  const id = "hk-legacy";
  seedInstalledCompose(id, "services:\n  app:\n    image: busybox:1.36\n");
  for (const legacy of ["/home/k/crow-addons/hk-legacy", "/home/k/crow/bundles/hk-legacy"]) {
    B._setDockerRunnerForTest(async (cmd, args) => (args[0] === "compose" ? { stdout: JSON.stringify({ name: "hk-legacy" }), stderr: "" } : { stdout: `${legacy}\n`, stderr: "" }));
    const calls = [];
    B._setComposeRunnerForTest(async (args) => { calls.push(args[0]); return { stdout: "", stderr: "" }; });
    const r = await startBundle(id);
    assert.equal(r.status, 200, `${legacy}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(calls, ["up"]);
  }
});

test("version-bump refresh re-copies the hook script's directory for a docker bundle", async () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-repo-"));
  const id = "hk-refresh";
  mkdirSync(join(repo, id, "ops"), { recursive: true });
  writeFileSync(join(repo, id, "manifest.json"), JSON.stringify({ id, type: "bundle", version: "0.2.0", docker: { composefile: "docker-compose.yml" }, postInstall: { script: "ops/bootstrap.sh" } }));
  writeFileSync(join(repo, id, "ops", "bootstrap.sh"), "echo v2\n");
  const dest = join(CROW_HOME, "bundles", id);
  mkdirSync(join(dest, "ops"), { recursive: true });
  writeFileSync(join(dest, "manifest.json"), JSON.stringify({ id, type: "bundle", version: "0.1.0", docker: { composefile: "docker-compose.yml" }, postInstall: { script: "ops/bootstrap.sh" } }));
  writeFileSync(join(dest, "ops", "bootstrap.sh"), "echo v1\n");
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id, type: "bundle", version: "0.1.0" }]));
  await B.repairInstalledBundleAssets({ appBundles: repo, run: async () => ({ stdout: "", stderr: "" }) });
  assert.equal(readFileSync(join(dest, "ops", "bootstrap.sh"), "utf8"), "echo v2\n");
});

test("contract: missing postInstall script and unsafe precreate are manifest errors", () => {
  const root = mkdtempSync(join(tmpdir(), "hk-contract-"));
  const dir = join(root, "c1"); mkdirSync(dir);
  writeFileSync(join(dir, "docker-compose.yml"), COMPOSE);
  const r = validateManifest({ id: "c1", name: "c", description: "d", type: "bundle", category: "x", docker: { composefile: "docker-compose.yml", precreate: ["/abs"] }, postInstall: { script: "ops/missing.sh" } }, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('postInstall.script "ops/missing.sh" not found')), r.errors.join("; "));
  assert.ok(r.errors.some((e) => e.includes('docker.precreate "/abs"')), r.errors.join("; "));
});
