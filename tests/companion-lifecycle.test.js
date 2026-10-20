/**
 * AI Companion lifecycle (queue item 39): the installed copy carries its build
 * (compose file, Dockerfile, scripts), so Extensions and Settings manage it from
 * CROW_HOME/bundles/companion like every other compose bundle; the image is stamped
 * with its build inputs so a stale one shows "Rebuild needed"; Settings saves report a
 * failed restart; the container no longer mounts every extension's folder.
 *
 * Scratch CROW_HOME / CROW_DATA_DIR only (set before the imports). Compose and docker
 * calls are stubbed, except the guard's `docker compose config` (skipped without docker).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-companion-life-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-companion-life-data-"));
process.env.CROW_AUTO_UPDATE = "0";
const CROW_HOME = process.env.CROW_HOME;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const REPO_BUNDLE = join(REPO, "bundles", "companion");

const B = await import("../servers/gateway/routes/bundles.js");
const { buildInputsHash } = await import("../servers/gateway/bundle-build-inputs.js");
const { buildStaleness } = await import("../servers/gateway/dashboard/panels/extensions/data-queries.js");
const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");
const { loadCollections } = await import("../servers/gateway/dashboard/panels/extensions/collections.js");

const composeCalls = [];
let composeImpl = async () => ({ stdout: "", stderr: "" });
B._setComposeRunnerForTest(async (args, opts) => { composeCalls.push({ args, opts }); return composeImpl(args, opts); });
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
after(() => {
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
  rmSync(process.env.CROW_DATA_DIR, { recursive: true, force: true });
});

let HAVE_COMPOSE = false;
try { execFileSync("docker", ["compose", "version"], { stdio: "pipe" }); HAVE_COMPOSE = true; } catch { /* skip */ }
const dockerTest = (name, fn) => test(name, { skip: HAVE_COMPOSE ? false : "docker compose not available" }, fn);

const read = (rel) => readFileSync(join(REPO_BUNDLE, rel), "utf8");
const manifest = JSON.parse(read("manifest.json"));

function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// ---- the shipped files ---------------------------------------------------------------

test("compose: no mount of the extensions folder; crow.db read-only from this instance; build-input label; per-project names", () => {
  const compose = read("docker-compose.yml");
  assert.doesNotMatch(compose, /crow-bundles/);
  assert.doesNotMatch(compose, /\.crow\/bundles/);
  assert.match(compose, /- \$\{CROW_DB_PATH:-\$\{CROW_DATA_DIR:-\$\{CROW_HOME:-~\/\.crow\}\/data\}\/crow\.db\}:\/crow-data\/crow\.db:ro/);
  assert.match(compose, /crow\.build-inputs: "\$\{CROW_BUILD_INPUTS:-\}"/);
  assert.match(compose, /image: crow-\$\{COMPOSE_PROJECT_NAME:-companion\}/);
  assert.match(compose, /container_name: crow-\$\{COMPOSE_PROJECT_NAME:-companion\}/);
  for (const v of ["companion-models:", "companion-cache:", "companion-history:"]) assert.ok(compose.includes(v), `volume ${v} kept`);
});

test("scripts: nothing reads /crow-bundles; the Calls scripts come from the gateway", () => {
  for (const f of ["entrypoint.sh", "inject-call-enhancements.sh", "generate-config.py", "notify-bridge.py"]) {
    assert.doesNotMatch(read(`scripts/${f}`), /\/crow-bundles/, f);
  }
  assert.match(read("scripts/entrypoint.sh"), /fetch-calls-scripts\.sh "\$CALLS_DIR"/);
  assert.match(read("Dockerfile"), /COPY scripts\/fetch-calls-scripts\.sh \/app\/scripts\/fetch-calls-scripts\.sh/);
});

test("manifest: version bumped, refreshFiles ships the build, consent text no longer offers the extensions folder", () => {
  assert.notEqual(manifest.version, "1.0.4");
  assert.deepEqual(manifest.refreshFiles, ["docker-compose.yml", "Dockerfile", ".dockerignore", "scripts"]);
  assert.match(manifest.install_consent_messages.en, /does not mount your other extensions' folders/);
  assert.match(manifest.install_consent_messages.es, /No monta las carpetas de tus demás extensiones/);
  const ignore = read(".dockerignore");
  for (const l of [".env", ".env.*", "eikanya-models"]) assert.ok(ignore.split("\n").includes(l), `.dockerignore keeps ${l} out of the build`);
});

// ---- the version refresh carries the build to an install that lacks it --------------

test("version refresh: a legacy install (no compose, no Dockerfile) gets them; .env and data stay", async () => {
  const appBundles = mkdtempSync(join(tmpdir(), "crow-companion-life-app-"));
  cpSync(REPO_BUNDLE, join(appBundles, "companion"), { recursive: true, filter: (s) => !s.endsWith("/.env") });
  const dest = join(CROW_HOME, "bundles", "companion");
  put(dest, "manifest.json", JSON.stringify({ ...manifest, version: "1.0.4", refreshFiles: undefined }));
  put(dest, "settings-section.js", "// old\n");
  put(dest, "scripts/entrypoint.sh", "#!/bin/bash\n# old\n");
  // An absolute EIKANYA folder (crow's value) is a read-only bind: refreshFiles still copies all four.
  const envText = `COMPANION_AVATAR=keep\nEIKANYA_MODELS_DIR=${join(CROW_HOME, "live2d-models")}\n`;
  put(dest, ".env", envText);
  put(dest, "eikanya-models/m/x.json", "{}");
  put(CROW_HOME, "installed.json", JSON.stringify([{ id: "companion", version: "1.0.0" }]));
  const out = await B.repairInstalledBundleAssets({ appBundles, run: async () => ({ stdout: "" }), skillMode: "off", log: () => {} });
  assert.deepEqual(out.errors, []);
  for (const f of ["docker-compose.yml", "Dockerfile", ".dockerignore", "scripts/fetch-calls-scripts.sh"]) {
    assert.ok(existsSync(join(dest, f)), `${f} copied`);
  }
  assert.equal(readFileSync(join(dest, "docker-compose.yml"), "utf8"), read("docker-compose.yml"));
  assert.match(readFileSync(join(dest, "scripts/entrypoint.sh"), "utf8"), /fetch-calls-scripts/);
  assert.equal(readFileSync(join(dest, ".env"), "utf8"), envText);
  assert.ok(existsSync(join(dest, "eikanya-models/m/x.json")));
  assert.equal(JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")).version, manifest.version);
  // The refresh never runs compose: nothing restarts on its own.
  assert.equal(composeCalls.length, 0);
  // After the refresh, the installed copy hashes exactly like the repo copy.
  assert.equal(buildInputsHash(dest), buildInputsHash(REPO_BUNDLE));
});

// ---- one start path ------------------------------------------------------------------

test("composeStartSteps: build first (long timeout + buffer + hash), then a quick up --no-build; no build when told not to", () => {
  const hash = buildInputsHash(REPO_BUNDLE);
  const steps = B._composeStartStepsForTest(REPO_BUNDLE, read("docker-compose.yml"), { recreate: true });
  assert.deepEqual(steps.map((x) => x.args), [["build"], ["up", "-d", "--no-build", "--force-recreate"]]);
  assert.ok(steps[0].opts.timeout >= 45 * 60_000);
  assert.ok(steps[0].opts.maxBuffer >= 16 * 1024 * 1024);
  assert.equal(steps[1].opts.timeout, undefined, "the up step keeps the short default");
  for (const st of steps) assert.deepEqual(st.opts.extraEnv, { CROW_BUILD_INPUTS: hash });
  const reuse = B._composeStartStepsForTest(REPO_BUNDLE, read("docker-compose.yml"), { build: false });
  assert.deepEqual(reuse.map((x) => x.args), [["up", "-d", "--no-build"]]);
  const plain = B._composeStartStepsForTest(REPO_BUNDLE, "services:\n  a:\n    image: nginx\n", { timeout: 1234 });
  assert.deepEqual(plain.map((x) => x.args), [["up", "-d"]]);
  assert.equal(plain[0].opts.timeout, 1234);
  assert.equal(plain[0].opts.extraEnv, undefined);
  const untracked = B._composeStartStepsForTest(REPO_BUNDLE, "services:\n  a:\n    build: .\n");
  assert.equal(untracked[0].opts.extraEnv, undefined, "a compose that does not stamp the label gets no hash");
});

test("startInstalledBundle: no compose file → 404, nothing run", async () => {
  const r = await B.startInstalledBundle("not-installed-x");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

function installCompanionCopy() {
  const dest = join(CROW_HOME, "bundles", "companion");
  for (const f of ["docker-compose.yml", "Dockerfile", ".dockerignore", "manifest.json"]) cpSync(join(REPO_BUNDLE, f), join(dest, f));
  cpSync(join(REPO_BUNDLE, "scripts"), join(dest, "scripts"), { recursive: true });
  writeFileSync(join(dest, ".env"), `EIKANYA_MODELS_DIR=${join(CROW_HOME, "live2d-models")}\nCOMPANION_AVATAR=mao_pro\n`);
  mkdirSync(join(CROW_HOME, "live2d-models"), { recursive: true });
  writeFileSync(join(process.env.CROW_DATA_DIR, "crow.db"), "");
  put(CROW_HOME, "installed.json", JSON.stringify([{ id: "companion", version: "1.0.0" }]));
  return dest;
}

dockerTest("startInstalledBundle: the installed Companion passes the guard, builds then ups with its hash, and REPORTS a compose failure", async () => {
  const dest = installCompanionCopy();
  composeCalls.length = 0;
  const ok = await B.startInstalledBundle("companion", { recreate: true });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.built, true);
  const runs = composeCalls.filter((c) => c.args[0] === "build" || c.args[0] === "up");
  assert.deepEqual(runs.map((c) => c.args), [["build"], ["up", "-d", "--no-build", "--force-recreate"]]);
  for (const c of runs) {
    assert.equal(c.opts.cwd, dest);
    assert.equal(c.opts.extraEnv.CROW_BUILD_INPUTS, buildInputsHash(dest));
  }

  composeImpl = async (args) => { if (args[0] === "build") throw Object.assign(new Error("exit 1"), { stderr: "Error: image build failed: boom" }); return { stdout: "" }; };
  composeCalls.length = 0;
  const bad = await B.startInstalledBundle("companion", { recreate: true });
  composeImpl = async () => ({ stdout: "", stderr: "" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 500);
  assert.match(bad.error, /image build failed: boom/);
  assert.equal(composeCalls.filter((c) => c.args[0] === "up").length, 0, "a failed build never touches the running container");

  // The old whole-folder mount is refused now, even with the Companion's consent.
  writeFileSync(join(dest, "docker-compose.yml"), read("docker-compose.yml").replace("    volumes:\n", "    volumes:\n      - ${CROW_HOME}/bundles:/crow-bundles:ro\n"));
  composeCalls.length = 0;
  const refused = await B.startInstalledBundle("companion");
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.equal(composeCalls.filter((c) => c.args[0] === "up" || c.args[0] === "build").length, 0);
  cpSync(join(REPO_BUNDLE, "docker-compose.yml"), join(dest, "docker-compose.yml"));
});

dockerTest("startInstalledBundle build if-stale: builds only when the container label differs from the installed hash", async () => {
  const dest = installCompanionCopy();
  const want = buildInputsHash(dest);
  let label = want;
  composeImpl = async (args) => (args[0] === "ps" ? { stdout: JSON.stringify({ Service: "companion", State: "running", Labels: `a=b,crow.build-inputs=${label}` }) + "\n" } : { stdout: "" });
  try {
    composeCalls.length = 0;
    const fresh = await B.startInstalledBundle("companion", { recreate: true, build: "if-stale" });
    assert.equal(fresh.ok, true, fresh.error);
    assert.equal(fresh.built, false);
    assert.deepEqual(composeCalls.filter((c) => c.args[0] !== "ps").map((c) => c.args).filter((a) => a[0] !== "config"), [["up", "-d", "--no-build", "--force-recreate"]]);
    label = "0000";
    composeCalls.length = 0;
    const stale = await B.startInstalledBundle("companion", { recreate: true, build: "if-stale" });
    assert.equal(stale.built, true);
    composeCalls.length = 0;
    const never = await B.startInstalledBundle("companion", { recreate: true, build: "never" });
    assert.equal(never.built, false);
  } finally {
    composeImpl = async () => ({ stdout: "", stderr: "" });
  }
});

dockerTest("startInstalledBundle: one start at a time per bundle (a second one gets 409)", async () => {
  installCompanionCopy();
  let release;
  const gate = new Promise((r) => { release = r; });
  composeImpl = async (args) => { if (args[0] === "build") await gate; return { stdout: "" }; };
  try {
    const first = B.startInstalledBundle("companion");
    // Wait until the first run is inside its build.
    for (let i = 0; i < 200 && !composeCalls.some((c) => c.args[0] === "build"); i++) await new Promise((r) => setTimeout(r, 10));
    const second = await B.startInstalledBundle("companion");
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.equal(second.code, "bundle_start_in_progress");
    release();
    assert.equal((await first).ok, true);
    const third = await B.startInstalledBundle("companion");
    assert.equal(third.ok, true, "the lock is released after a run");
  } finally {
    composeImpl = async () => ({ stdout: "", stderr: "" });
  }
});

dockerTest("startInstalledBundle: a container started from another folder with a different .env is not re-created until they match", async () => {
  const dest = installCompanionCopy();
  const legacy = mkdtempSync(join(tmpdir(), "crow-companion-life-legacy-"));
  const legacyDir = join(legacy, "bundles", "companion");
  put(legacyDir, ".env", `EIKANYA_MODELS_DIR=${join(CROW_HOME, "live2d-models")}\nCOMPANION_AVATAR=other\nCROW_LOCAL_MCP_TOKEN=s3cret-value\n# COMPANION_PROFILE_1_NAME=off\n`);
  B._setDockerRunnerForTest(async (cmd, args) => (args[0] === "ps" ? { stdout: `${legacyDir}\n` } : { stdout: "" }));
  try {
    composeCalls.length = 0;
    const r = await B.startInstalledBundle("companion", { recreate: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.code, "legacy_env_differs");
    assert.match(r.error, /COMPANION_AVATAR, CROW_LOCAL_MCP_TOKEN/);
    assert.doesNotMatch(r.error, /s3cret-value|other/, "names only, never values");
    assert.equal(composeCalls.filter((c) => c.args[0] === "up" || c.args[0] === "build").length, 0);
    // Reconciled (the legacy .env copied over the installed one): it starts.
    cpSync(join(legacyDir, ".env"), join(dest, ".env"));
    const ok = await B.startInstalledBundle("companion", { recreate: true });
    assert.equal(ok.ok, true, ok.error);
  } finally {
    B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
    rmSync(legacy, { recursive: true, force: true });
  }
});

dockerTest("startInstalledBundle: docker not answering the container listing → refused (503), never guessed", async () => {
  installCompanionCopy();
  B._setDockerRunnerForTest(async () => { throw new Error("timeout"); });
  try {
    composeCalls.length = 0;
    const r = await B.startInstalledBundle("companion", { recreate: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(r.code, "ownership_unknown");
    assert.equal(composeCalls.filter((c) => c.args[0] === "up" || c.args[0] === "build").length, 0);
  } finally {
    B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  }
});

dockerTest("while a start holds the bundle, Stop and the shared-storage re-apply refuse (409)", async () => {
  installCompanionCopy();
  let release;
  const gate = new Promise((r) => { release = r; });
  composeImpl = async (args) => { if (args[0] === "build") await gate; return { stdout: "" }; };
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { authenticated: true }; next(); });
  app.use(B.default());
  const srv = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  try {
    const first = B.startInstalledBundle("companion");
    for (let i = 0; i < 200 && !B.bundleStartInProgress("companion"); i++) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 200 && !composeCalls.some((c) => c.args[0] === "build"); i++) await new Promise((r) => setTimeout(r, 10));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const stop = await fetch(`${base}/bundles/api/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: "companion" }) });
    assert.equal(stop.status, 409);
    assert.equal((await stop.json()).code, "bundle_start_in_progress");
    const apply = await fetch(`${base}/bundles/api/shared-storage/apply/companion`, { method: "POST" });
    assert.equal(apply.status, 409);
    release();
    assert.equal((await first).ok, true);
    assert.equal(B.bundleStartInProgress("companion"), false);
  } finally {
    release();
    composeImpl = async () => ({ stdout: "", stderr: "" });
    srv.close();
  }
});

dockerTest("shipped compose, real `docker compose config`: prod names and volumes unchanged; a second project gets its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-companion-life-cfg-"));
  const run = (sub) => {
    const d = join(dir, sub, "companion");
    mkdirSync(d, { recursive: true });
    cpSync(join(REPO_BUNDLE, "docker-compose.yml"), join(d, "docker-compose.yml"));
    return d;
  };
  const cfg = (d) => JSON.parse(execFileSync("docker", ["compose", "config", "--format", "json"], { cwd: d, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, CROW_HOME: "/x/crow-home" } }));
  const prod = cfg(run("a"));
  assert.equal(prod.name, "companion");
  assert.equal(prod.services.companion.container_name, "crow-companion");
  assert.equal(prod.services.companion.image, "crow-companion");
  assert.deepEqual(Object.values(prod.volumes).map((v) => v.name).sort(), ["companion_companion-cache", "companion_companion-history", "companion_companion-models"]);
  const binds = prod.services.companion.volumes.filter((v) => v.type === "bind").map((v) => v.source);
  assert.ok(binds.includes("/x/crow-home/data/crow.db"));
  assert.ok(!binds.some((b) => b.includes("bundles")), "no extensions folder");
  const second = run("b");
  writeFileSync(join(second, ".env"), "COMPOSE_PROJECT_NAME=companion-two\n");
  const two = cfg(second);
  assert.equal(two.services.companion.container_name, "crow-companion-two");
  assert.equal(two.services.companion.image, "crow-companion-two");
  rmSync(dir, { recursive: true, force: true });
});

test("install's compose up goes through composeStartSteps (build timeout, buffer, hash)", () => {
  const src = readFileSync(join(REPO, "servers", "gateway", "routes", "bundles.js"), "utf8");
  assert.match(src, /const steps = composeStartSteps\(destDir, composeContent, \{ timeout: pullTimeoutMs\(manifest\) \}\);/);
  assert.match(src, /for \(const st of steps\) await runCompose\(st\.args, st\.opts\);/);
});

// ---- Settings: a save restarts through the start path and reports failures ------------

test("Settings save: restarts with build if-stale; a failure is reported (not swallowed); the .env is saved either way", async () => {
  const dest = join(CROW_HOME, "bundles", "companion");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, ".env"), "");
  const section = (await import(join(REPO_BUNDLE, "settings-section.js"))).default;
  const KEY = Symbol.for("crow.startInstalledBundle");
  const real = globalThis[KEY];
  assert.equal(real, B.startInstalledBundle, "routes/bundles.js publishes its start path for the installed settings file");
  const calls = [];
  const reply = () => { const r = { body: null, json(b) { r.body = b; } }; return r; };
  globalThis[KEY] = async (id, opts) => { calls.push({ id, opts }); return { ok: false, status: 403, error: "Security check failed: nope" }; };
  try {
    const res = reply();
    const handled = await section.handleAction({ req: { body: { action: "update_companion_persona", persona: "", character_name: "Robin", avatar: "" } }, res, db: null });
    assert.equal(handled, true);
    assert.deepEqual(calls, [{ id: "companion", opts: { recreate: true, build: "if-stale" } }]);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.saved, true);
    assert.match(res.body.error, /did not restart: Security check failed: nope/);
    assert.match(readFileSync(join(dest, ".env"), "utf8"), /COMPANION_CHARACTER_NAME=Robin/);

    globalThis[KEY] = async () => ({ ok: true, message: "started" });
    const res2 = reply();
    await section.handleAction({ req: { body: { action: "update_companion_ai", ai_profile: "" } }, res: res2, db: null });
    assert.deepEqual(res2.body, { ok: true });

    globalThis[KEY] = async () => { throw new Error("gateway module missing"); };
    const res3 = reply();
    await section.handleAction({ req: { body: { action: "update_companion_household" } }, res: res3, db: null });
    assert.equal(res3.body.ok, false);
    assert.match(res3.body.error, /gateway module missing/);
  } finally {
    globalThis[KEY] = real;
  }
});

// ---- Extensions: Rebuild when the image is stale ---------------------------------------

test("buildStaleness: label vs the installed hash; null when not tracked or no containers", () => {
  const want = buildInputsHash(REPO_BUNDLE);
  assert.equal(buildStaleness(REPO_BUNDLE, [{ Labels: `a=b,crow.build-inputs=${want}` }]), false);
  assert.equal(buildStaleness(REPO_BUNDLE, [{ Labels: "a=b,crow.build-inputs=0000" }]), true);
  assert.equal(buildStaleness(REPO_BUNDLE, [{ Labels: "a=b" }]), true, "built before the label, or by hand");
  assert.equal(buildStaleness(REPO_BUNDLE, []), null);
  const plain = mkdtempSync(join(tmpdir(), "crow-companion-life-plain-"));
  put(plain, "docker-compose.yml", "services:\n  a:\n    image: nginx\n");
  assert.equal(buildStaleness(plain, [{ Labels: "" }]), null);
});

function renderInstalled(status, lang) {
  return buildExtensionsHTML({
    installed: { companion: { version: "1.1.0" } },
    available: [{ id: "companion", name: "AI Companion", type: "bundle", category: "ai", version: "1.1.0" }],
    collections: loadCollections(), registrySource: "local", communityStores: [],
    bundleStatus: { companion: status }, lang,
  }).viewsHtml;
}

test("Extensions: a stale running image shows Rebuild + badge (en/es); a current one shows Restart", () => {
  const en = renderInstalled({ running: true, containers: 1, buildStale: true }, "en");
  const item = en.split('ext-installed__item" data-addon-id="companion"')[1];
  assert.match(item, /data-testid="rebuild-needed"/);
  assert.match(item, /data-rebuild="1"[^>]*>Rebuild</);
  assert.doesNotMatch(item.split("ext-installed__actions")[1].split("</div>")[0], />Restart</);
  const es = renderInstalled({ running: true, containers: 1, buildStale: true }, "es");
  assert.match(es, />Reconstruir</);
  assert.match(es, /Hay que reconstruir/);
  const fresh = renderInstalled({ running: true, containers: 1, buildStale: false }, "en");
  assert.doesNotMatch(fresh, /rebuild-needed/);
  assert.match(fresh, />Restart</);
  const stopped = renderInstalled({ running: false, containers: 1, buildStale: true }, "en");
  assert.match(stopped, /rebuild-needed/);
  assert.match(stopped, /data-action="start"[^>]*>Start</);
});
