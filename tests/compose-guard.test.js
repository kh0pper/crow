/**
 * The install security check on the compose MODEL Docker Compose applies
 * (servers/gateway/compose-guard.js), and that every path that runs `compose up`
 * goes through the same check (checkBundleCompose): install (single + collection
 * share runInstallJob) and Start. Docker-backed cases skip when `docker compose`
 * is not on this machine (CI has it).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execFile } from "node:child_process";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-cguard-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-cguard-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;
const DATA = process.env.CROW_DATA_DIR;
const REPO = fileURLToPath(new URL("..", import.meta.url));

const G = await import("../servers/gateway/compose-guard.js");
const B = await import("../servers/gateway/routes/bundles.js");
const { trackedBundleSet } = await import("../scripts/build-registry.mjs");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-cguard-app-"));
B._setAppBundlesForTest(FIXTURES);
const upCalls = [];
B._setComposeRunnerForTest(async (args) => { upCalls.push(args); return { stdout: "", stderr: "" }; });
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
after(() => {
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  for (const d of [CROW_HOME, DATA, FIXTURES]) rmSync(d, { recursive: true, force: true });
});

let HAVE_COMPOSE = false;
try { execFileSync("docker", ["compose", "version"], { stdio: "pipe" }); HAVE_COMPOSE = true; } catch { /* skip docker cases */ }
const dockerTest = (name, fn) => test(name, { skip: HAVE_COMPOSE ? false : "docker compose not available" }, fn);

const CTX = { crowHome: CROW_HOME, dataDir: DATA, appRoot: REPO };
const PRIV = { privileged: true };
const svc = (extra = {}) => ({ services: { app: { image: "busybox", ...extra } } });
const bundleDir = () => { const d = join(CROW_HOME, "bundles", `fx-${Math.random().toString(36).slice(2, 8)}`); mkdirSync(d, { recursive: true }); return d; };
const check = (model, { manifest = {}, consent = false, dir = bundleDir() } = {}) => G.checkComposeModel(model, { bundleDir: dir, manifest, consentVerified: consent, ctx: CTX });
const bind = (source, read_only = false) => ({ type: "bind", source, target: "/x", ...(read_only ? { read_only } : {}) });

// ---- the model check (no docker) ---------------------------------------------------

test("model: privileged, dangerous caps (any case, CAP_ prefix), shared namespaces, unconfined, volumes_from need privileged + consent", () => {
  for (const extra of [
    { privileged: true }, { cap_add: ["net_admin"] }, { cap_add: ["CAP_SYS_ADMIN"] }, { cap_add: ["ALL"] },
    { network_mode: "host" }, { network_mode: "container:abc" }, { pid: "host" }, { pid: "container:x" },
    { userns_mode: "host" }, { uts: "host" }, { cgroup: "host" },
    { security_opt: ["apparmor=unconfined"] }, { security_opt: ["seccomp:unconfined"] }, { security_opt: ["label=disable"] },
    { volumes_from: ["other"] },
  ]) {
    assert.equal(check(svc(extra)).valid, false, JSON.stringify(extra));
    assert.equal(check(svc(extra), { manifest: PRIV, consent: true }).valid, true, JSON.stringify(extra));
    assert.equal(check(svc(extra), { manifest: { ...PRIV, origin: "community" }, consent: true }).valid, false, `community: ${JSON.stringify(extra)}`);
  }
  assert.equal(check(svc({ network_mode: "service:db", cap_add: ["CHOWN"], security_opt: ["no-new-privileges:true"] })).valid, true);
});

test("model: sensitive host paths are refused even with privileged consent; their parents too", () => {
  const home = homedir();
  for (const src of ["/", "/etc", "/etc/shadow", join(home, ".ssh"), join(home, ".ssh", "id_rsa"), home, CROW_HOME,
    join(CROW_HOME, "secrets"), join(CROW_HOME, "secrets", "keychain.key"), DATA, join(DATA, "other.db"),
    join(CROW_HOME, ".env"), join(CROW_HOME, "mcp-addons.json"), join(REPO, ".env"), REPO, "/home"]) {
    assert.equal(check(svc({ volumes: [bind(src, true)] }), { manifest: PRIV, consent: true }).valid, false, src);
  }
  assert.equal(check(svc({ volumes: [bind(join(CROW_HOME, "workspace", "db"))] }), { manifest: { id: "workspace" } }).valid, true, "the bundle's own CROW_HOME/<id> folder");
  assert.equal(check(svc({ volumes: [bind(join(CROW_HOME, "workspace", "db"))] }), { manifest: { id: "other" } }).valid, false, "another bundle's CROW_HOME folder");
});

test("model: the narrow exceptions — /etc/localtime read-only; crow.db and the extensions folder read-only only with privileged consent", () => {
  assert.equal(check(svc({ volumes: [bind("/etc/localtime", true)] })).valid, true);
  assert.equal(check(svc({ volumes: [bind("/etc/localtime")] })).valid, false, "read-write localtime");
  const db = join(DATA, "crow.db");
  assert.equal(check(svc({ volumes: [bind(db, true)] }), { manifest: PRIV, consent: true }).valid, true);
  assert.equal(check(svc({ volumes: [bind(db)] }), { manifest: PRIV, consent: true }).valid, false, "read-write crow.db");
  assert.equal(check(svc({ volumes: [bind(db, true)] })).valid, false, "no consent");
  const bundles = join(CROW_HOME, "bundles");
  assert.equal(check(svc({ volumes: [bind(bundles, true)] }), { manifest: PRIV, consent: true }).valid, true);
  assert.equal(check(svc({ volumes: [bind(bundles, true)] })).valid, false);
  const dir = bundleDir();
  assert.equal(check(svc({ volumes: [bind(join(dir, "data"))] }), { dir }).valid, true, "the bundle's own folder");
  assert.equal(check(svc({ volumes: [bind(join(bundles, "other", ".env"), true)] }), { dir }).valid, false, "another bundle's folder");
});

test("model: a symlink inside the bundle that points at a sensitive path is resolved and refused", () => {
  const dir = bundleDir();
  symlinkSync("/etc", join(dir, "cfg"));
  symlinkSync(join(CROW_HOME, "secrets"), join(dir, "s"));
  assert.equal(check(svc({ volumes: [bind(join(dir, "cfg"), true)] }), { dir }).valid, false);
  assert.equal(check(svc({ volumes: [bind(join(dir, "s", "x"))] }), { dir }).valid, false, "a not-yet-existing path under the link");
  assert.equal(check(svc({ build: { context: join(dir, "cfg") } }), { dir }).valid, false, "a build context through the link");
});

test("model: Docker socket read-only needs consent; read-write never", () => {
  const sock = { volumes: [bind("/var/run/docker.sock", true)] };
  assert.equal(check(svc(sock)).valid, false);
  assert.equal(check(svc(sock), { manifest: { consent_required: true }, consent: true }).valid, true);
  assert.equal(check(svc({ volumes: [bind("/var/run/docker.sock")] }), { manifest: PRIV, consent: true }).valid, false);
});

test("model: env_file, build context, secrets/configs files and bind-device volumes stay inside the bundle", () => {
  const dir = bundleDir();
  const out = "/etc/hostname";
  assert.equal(check(svc({ env_file: [{ path: join(CROW_HOME, ".env") }] }), { dir }).valid, false);
  assert.equal(check(svc({ env_file: [{ path: join(dir, "app.env") }] }), { dir }).valid, true);
  assert.equal(check(svc({ env_file: [{ path: "/opt/gpu.env" }] }), { dir, manifest: { inference: true } }).valid, true, "model bundles' shared GPU env file");
  assert.equal(check(svc({ build: { context: "/" } }), { dir }).valid, false);
  assert.equal(check(svc({ build: { context: dir, additional_contexts: { x: "/etc" } } }), { dir }).valid, false);
  assert.equal(check(svc({ build: { context: "https://example.invalid/repo.git" } }), { dir }).valid, false, "remote build contexts are refused (not modelled)");
  assert.equal(check({ ...svc(), secrets: { s: { file: out } } }, { dir }).valid, false);
  assert.equal(check({ ...svc(), configs: { c: { file: join(dir, "c.conf") } } }, { dir }).valid, true);
  assert.equal(check({ ...svc(), volumes: { v: { driver_opts: { type: "none", o: "bind", device: "/etc" } } } }, { dir, manifest: PRIV, consent: true }).valid, false);
});

test("model: fail-closed on what it can't reason about", () => {
  assert.equal(check({}).valid, false);
  assert.equal(check(svc({ volumes: [{ type: "cluster", source: "x", target: "/x" }] })).valid, false);
  assert.equal(check(svc({ volumes: [bind("relative/path")] })).valid, false);
  assert.equal(check(svc({ volumes: ["/etc:/x"] })).valid, false, "a short-syntax string Compose did not normalize");
});

// ---- what Compose really applies (docker compose config) ----------------------------

function project(files) {
  const dir = bundleDir();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const gateDir = (dir, opts = {}) => B.checkBundleCompose(dir, { bundleId: "fx", manifest: {}, consentVerified: false, ...opts });
const C = (body) => `services:\n  app:\n    image: busybox\n${body}`;

dockerTest("parser differentials: YAML merge keys, anchors, flow style and interpolated paths are seen as Compose applies them", async () => {
  for (const files of [
    { "docker-compose.yml": `x-p: &p\n  privileged: true\nservices:\n  app:\n    image: busybox\n    <<: *p\n` },
    { "docker-compose.yml": `x-v: &v ["/etc:/host-etc"]\nservices:\n  app:\n    image: busybox\n    volumes: *v\n` },
    { "docker-compose.yml": `{"services": {"app": {"image": "busybox", "network_mode": "host"}}}\n` },
    { "docker-compose.yml": C("    volumes:\n      - ${MEDIA}:/m\n"), ".env": "MEDIA=/etc\n" },
    { "docker-compose.yml": C("    volumes:\n      - ${DB:-~/.ssh}:/k:ro\n") },
  ]) {
    const r = await gateDir(project(files), { textCheck: false });
    assert.equal(r.valid, false, JSON.stringify(files));
  }
});

dockerTest("Start-time sources: an override file and COMPOSE_FILE in .env are part of the checked model", async () => {
  const over = project({ "docker-compose.yml": C(""), "docker-compose.override.yml": "services:\n  app:\n    privileged: true\n" });
  assert.equal((await gateDir(over, { textCheck: false })).valid, false);
  const swapped = project({ "docker-compose.yml": C(""), "evil.yml": C("    network_mode: host\n"), ".env": "COMPOSE_FILE=evil.yml\n" });
  assert.equal((await gateDir(swapped, { textCheck: false })).valid, false);
  const benign = project({ "docker-compose.yml": C("    volumes:\n      - ./data:/d\n"), "docker-compose.override.yml": "services:\n  app:\n    volumes: !override\n      - ./data:/var/lib/x\n" });
  assert.equal((await gateDir(benign, { textCheck: false })).valid, true, "an operator's benign override still starts");
});

dockerTest("a required ${VAR:?} left blank (collection install) is filled with a harmless value so the rest is checked", async () => {
  const dir = project({ "docker-compose.yml": C("    volumes:\n      - ${MEDIA:?Set MEDIA}:/m\n") });
  assert.equal((await gateDir(dir)).valid, true);
  const bad = project({ "docker-compose.yml": C("    volumes:\n      - ${MEDIA:?Set MEDIA}:/m\n    privileged: true\n") });
  assert.equal((await gateDir(bad, { textCheck: false })).valid, false);
});

dockerTest("a compose file Compose cannot read is refused (fail-closed)", async () => {
  const r = await gateDir(project({ "docker-compose.yml": "services: [this, is, not, valid]\n" }), { textCheck: false });
  assert.equal(r.valid, false);
  assert.match(r.reason, /Docker Compose could not read/);
});

dockerTest("every tracked first-party compose passes the model check (with its manifest + consent), laid out as on a real host", async () => {
  // A real host: HOME/.crow is CROW_HOME and bundles run from CROW_HOME/bundles/<id>.
  const { cpSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "crow-cguard-realhome-"));
  const ch = join(home, ".crow");
  const env = { PATH: process.env.PATH, HOME: home, CROW_HOME: ch };
  const run = (args, { cwd, env: e }) => new Promise((resolve, reject) => execFile("docker", ["compose", ...args], { cwd, env: e }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout }))));
  const bad = [];
  try {
    for (const id of [...trackedBundleSet()].sort()) {
      const src = join(REPO, "bundles", id);
      if (!existsSync(join(src, "docker-compose.yml"))) continue;
      const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
      if (manifest.inference === true) continue; // model bundles: Model Catalog + gpu-orchestrator, never this route
      const dir = join(ch, "bundles", id);
      cpSync(src, dir, { recursive: true, filter: (f) => !f.includes("node_modules") });
      const loaded = await G.loadComposeModel(dir, { env, runConfig: run });
      if (loaded.error) { bad.push(`${id}: ${loaded.error}`); continue; }
      const r = G.checkComposeModel(loaded.model, { bundleDir: dir, manifest, consentVerified: true, ctx: { crowHome: ch, dataDir: join(ch, "data"), appRoot: REPO, home } });
      if (!r.valid) bad.push(`${id}: ${r.reason}`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
  assert.deepEqual(bad, [], bad.join("\n"));
});

// ---- one check on every path that runs compose up ----------------------------------

function stage(id, compose, files = {}) {
  const dir = join(FIXTURES, id);
  mkdirSync(dir, { recursive: true });
  const manifest = { id, name: id, description: "d", type: "bundle", category: "infrastructure", version: "0.1.0", docker: { composefile: "docker-compose.yml" } };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
  return manifest;
}
// Passes the text check, fails the model check: a YAML merge key that turns on privileged.
const MERGE_PRIV = `x-p: &p\n  privileged: true\nservices:\n  app:\n    image: busybox\n    <<: *p\n`;

dockerTest("collection path: a member whose model fails is refused inside install-set, before any compose up", async () => {
  stage("fx-col", MERGE_PRIV);
  const colPath = join(FIXTURES, "collections.json");
  writeFileSync(colPath, JSON.stringify({ version: 1, collections: [{ id: "fxc", name: "Fx", description: "d", icon: "home", members: [{ id: "fx-col", kind: "deploys" }] }] }));
  B._setCollectionsPathForTest(colPath);
  upCalls.length = 0;
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/bundles/api/install-set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collection_id: "fxc" }) });
    const started = await r.json();
    const { job_id } = started;
    assert.ok(job_id, `install-set started: ${JSON.stringify(started)}`);
    let job;
    for (let i = 0; i < 100; i++) {
      job = await (await fetch(`${base}/bundles/api/jobs/${job_id}`)).json();
      if (job.status && job.status !== "running") break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const log = (job.log || []).join("\n");
    assert.match(log, /Security check failed/);
    assert.match(log, /SUMMARY member fx-col failed/);
    assert.equal(upCalls.filter((a) => a[0] === "up" || a[0] === "pull").length, 0);
  } finally { server.close(); B._setCollectionsPathForTest(null); }
});


dockerTest("install path (single and collection both run runInstallJob): refused before any compose up", async () => {
  const manifest = stage("fx-merge", MERGE_PRIV);
  upCalls.length = 0;
  const job = B._createJobForTest("fx-merge", "install");
  const out = await B.runInstallJob("fx-merge", {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  assert.equal(out.ok, false);
  assert.match(out.reason, /Security check failed/);
  assert.equal(upCalls.length, 0, "no compose pull/up ran");
});

dockerTest("Start path: an installed bundle whose model fails is not started", async () => {
  const id = "fx-start";
  const manifest = stage(id, MERGE_PRIV);
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "docker-compose.yml"), MERGE_PRIV);
  const installed = join(CROW_HOME, "installed.json");
  writeFileSync(installed, JSON.stringify([{ id, type: "bundle", version: "0.1.0" }]));
  upCalls.length = 0;
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id }) });
    const body = await r.json();
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(body.code, "compose_security_check");
    assert.equal(upCalls.filter((a) => a[0] === "up").length, 0);
  } finally { server.close(); }
});

test("model: a bundle may use its OWN subfolder of the data folder, never a sibling's or the folder itself", () => {
  const m = { id: "rk" };
  assert.equal(check(svc({ volumes: [bind(join(DATA, "rk"))] }), { manifest: m }).valid, true);
  assert.equal(check(svc({ volumes: [bind(join(DATA, "rk", "ws"))] }), { manifest: m }).valid, true);
  assert.equal(check(svc({ volumes: [bind(join(DATA, "backups"))] }), { manifest: m }).valid, false);
  assert.equal(check(svc({ volumes: [bind(DATA)] }), { manifest: m }).valid, false);
  assert.equal(check(svc({ volumes: [bind(join(DATA, "rk-other"))] }), { manifest: m }).valid, false);
});

test("model: more host areas — /root, /boot, Docker's data, /run, /dev are refused; /proc and /sys only read-only with consent", () => {
  for (const src of ["/root", "/boot", "/var/lib/docker", "/run/systemd", "/dev/sda"]) {
    assert.equal(check(svc({ volumes: [bind(src, true)] }), { manifest: PRIV, consent: true }).valid, false, src);
  }
  assert.equal(check(svc({ volumes: [bind("/proc", true)] })).valid, false);
  assert.equal(check(svc({ volumes: [bind("/proc", true)] }), { manifest: { consent_required: true }, consent: true }).valid, true);
  assert.equal(check(svc({ volumes: [bind("/sys")] }), { manifest: { consent_required: true }, consent: true }).valid, false, "read-write /sys");
});

test("model: ipc host and host devices need privileged consent; GPU render nodes don't", () => {
  for (const extra of [{ ipc: "host" }, { devices: [{ source: "/dev/sda", target: "/dev/sda", permissions: "rwm" }] }, { devices: ["/dev/net/tun:/dev/net/tun"] }]) {
    assert.equal(check(svc(extra)).valid, false, JSON.stringify(extra));
    assert.equal(check(svc(extra), { manifest: PRIV, consent: true }).valid, true, JSON.stringify(extra));
  }
  assert.equal(check(svc({ devices: [{ source: "/dev/dri", target: "/dev/dri" }, { source: "/dev/kfd", target: "/dev/kfd" }] })).valid, true);
});

test("model: a named volume binding a relative device is refused", () => {
  assert.equal(check({ ...svc(), volumes: { v: { driver_opts: { type: "none", o: "bind", device: "../../data" } } } }).valid, false);
  assert.equal(check({ ...svc(), volumes: { v: { driver_opts: { type: "nfs", o: "addr=10.0.0.1", device: ":/export" } } } }).valid, true, "a remote NFS volume reads nothing local");
});

dockerTest("review fixtures: privileged via interpolation/yes/!!bool, long-syntax socket, // and ${R:-/} roots, COMPOSE_FILE colon form", async () => {
  for (const files of [
    { "docker-compose.yml": C("    privileged: ${P:-true}\n") },
    { "docker-compose.yml": C("    privileged: !!bool true\n") },
    { "docker-compose.yml": C("    volumes:\n      - type: bind\n        source: /run/docker.sock\n        target: /s\n") },
    { "docker-compose.yml": C("    volumes:\n      - //:/host\n") },
    { "docker-compose.yml": C("    volumes:\n      - ${R:-/}:/host\n") },
    { "docker-compose.yml": C("    volumes:\n      - ${U:-../..}/data:/d\n") },
    { "docker-compose.yml": C(""), "evil.yml": C("    privileged: true\n"), ".env": "COMPOSE_FILE: evil.yml\n" },
    { "docker-compose.yml": `services:\n  app:\n    image: busybox\n    volumes: [hv:/x]\nvolumes:\n  hv:\n    driver_opts: {type: none, o: bind, device: /}\n` },
  ]) {
    const r = await gateDir(project(files), { textCheck: false });
    assert.equal(r.valid, false, JSON.stringify(files));
  }
});

// ---- allowlist: anything the check does not understand is refused --------------------

test("allowlist: unknown service or top-level keys are refused, even with privileged consent", () => {
  assert.equal(check(svc({ some_future_key: true }), { manifest: PRIV, consent: true }).valid, false);
  assert.equal(check({ ...svc(), models: { m: {} } }, { manifest: PRIV, consent: true }).valid, false);
  assert.equal(check({ ...svc(), "x-anything": { privileged: true } }).valid, true, "x- extension fields are inert");
});

test("allowlist: escape-capable service keys need privileged consent", () => {
  for (const extra of [
    { cgroup_parent: "/" }, { device_cgroup_rules: ["a *:* rwm"] }, { external_links: ["other"] }, { use_api_socket: true },
    { post_start: [{ command: "id", privileged: true }] }, { pre_stop: [{ command: "id" }] }, { develop: { watch: [] } },
    { sysctls: { "kernel.shm_rmid_forced": "1" } }, { oom_score_adj: -1000 }, { runtime: "sysbox-runc" },
    { cap_add: ["SYS_TIME"] }, { cap_add: ["BPF"] }, { cap_add: ["LINUX_IMMUTABLE"] },
    { deploy: { resources: { reservations: { devices: [{ driver: "x", capabilities: ["tpu"] }] } } } },
    { volumes: [{ type: "bind", source: join(CROW_HOME, "bundles", "fx-z"), target: "/x", bind: { propagation: "rshared" } }] },
    { volumes: [{ type: "bind", source: join(CROW_HOME, "bundles", "fx-z"), target: "/x", bind: { selinux: "Z" } }] },
  ]) {
    assert.equal(check(svc(extra)).valid, false, JSON.stringify(extra));
  }
  assert.equal(check(svc({ cap_add: ["CHOWN", "NET_BIND_SERVICE"], oom_score_adj: -500, runtime: "nvidia",
    deploy: { resources: { reservations: { devices: [{ driver: "nvidia", count: 1, capabilities: [["gpu"]] }] } } } })).valid, true);
});

test("allowlist: builds can't use host network, SSH agent, build secrets, privileged builds or remote contexts", () => {
  const dir = bundleDir();
  for (const extra of [{ network: "host" }, { ssh: ["default"] }, { secrets: ["s"] }, { privileged: true }, { entitlements: ["network.host"] }]) {
    assert.equal(check(svc({ build: { context: dir, ...extra } }), { dir }).valid, false, JSON.stringify(extra));
  }
  assert.equal(check(svc({ build: { context: dir, dockerfile: "Dockerfile", args: { A: "1" } } }), { dir }).valid, true);
});

test("allowlist: networks and volumes — host network by name, non-bridge drivers, non-local volume drivers", () => {
  assert.equal(check({ ...svc({ networks: { h: null } }), networks: { h: { name: "host", external: true } } }).valid, false);
  assert.equal(check({ ...svc({ networks: { m: null } }), networks: { m: { driver: "macvlan" } } }).valid, false);
  assert.equal(check({ ...svc({ networks: { f: null } }), networks: { f: { name: "crow-federation", external: true } } }).valid, true);
  assert.equal(check(svc({ networks: { undeclared: null } })).valid, false);
  assert.equal(check({ ...svc(), volumes: { v: { driver: "some-plugin" } } }).valid, false);
  assert.equal(check(svc({ volumes: [{ type: "volume", source: "undeclared", target: "/x" }] })).valid, false);
});

test("allowlist: secrets/configs can't copy a variable from the gateway's environment", () => {
  assert.equal(check({ ...svc(), secrets: { s: { environment: "ANY_GATEWAY_SECRET" } } }, { manifest: PRIV, consent: true }).valid, false);
  assert.equal(check({ ...svc(), configs: { c: { content: "inline" } } }).valid, true);
});

dockerTest("allowlist on real Compose output: use_api_socket, a host network by name, a secret from the environment", async () => {
  for (const files of [
    { "docker-compose.yml": C("    use_api_socket: true\n") },
    { "docker-compose.yml": C("    networks: [h]\n") + "networks:\n  h:\n    name: host\n    external: true\n" },
    { "docker-compose.yml": C("    secrets: [s]\n") + "secrets:\n  s:\n    environment: PATH\n" },
    { "docker-compose.yml": C("    build:\n      context: .\n      network: host\n") },
  ]) {
    const r = await gateDir(project(files), { textCheck: false });
    assert.equal(r.valid, false, JSON.stringify(files));
  }
});

// ---- authorization: whose consent a later Start runs with ----------------------------

function seedInstalled(id, manifest, record) {
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, version: "0.1.0", type: "bundle", ...manifest }));
  const path = join(CROW_HOME, "installed.json");
  const list = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  writeFileSync(path, JSON.stringify([...list.filter((x) => x.id !== id), { id, type: "bundle", version: "0.1.0", ...record }]));
}

test("install records the consent the owner gave, and only for a bundle that asked for it", () => {
  assert.deepEqual(B._consentRecordForTest({ privileged: true }, true), { consent: { verified: true, privileged: true, consent_required: false } });
  assert.deepEqual(B._consentRecordForTest({}, true), {});
});

test("Start runs with the install-time consent: never a peer's, never for privileges added later", () => {
  seedInstalled("fx-c1", { privileged: true }, B._consentRecordForTest({ privileged: true }, true));
  assert.equal(B._startConsentForTest("fx-c1").consentVerified, true);
  assert.equal(B._startConsentForTest("fx-c1", { crossHost: true }).consentVerified, false, "a peer instance can't use the owner's consent");
  // installed as consent_required only; a refresh made the manifest privileged
  seedInstalled("fx-c2", { privileged: true, consent_required: true }, B._consentRecordForTest({ consent_required: true }, true));
  const sc = B._startConsentForTest("fx-c2");
  assert.equal(sc.manifest.privileged, false, "privileged was never consented to");
  assert.equal(sc.manifest.consent_required, true);
  seedInstalled("fx-c3", { privileged: true }, { consent: { verified: false, privileged: true } });
  assert.equal(B._startConsentForTest("fx-c3").consentVerified, false);
  seedInstalled("fx-c4", { privileged: true }, {});
  assert.equal(B._startConsentForTest("fx-c4").consentVerified, true, "a record from before consent was kept: installed through the gate of its time");
  assert.equal(B._startConsentForTest("fx-not-installed").consentVerified, false);
});

dockerTest("Compose never sees the gateway's secrets: ${ANY_VAR} interpolates to empty", async () => {
  process.env.CROW_TEST_GATEWAY_SECRET = "gw-secret-value-xyz";
  try {
    const dir = project({ "docker-compose.yml": C("    environment:\n      - LEAK=${CROW_TEST_GATEWAY_SECRET:-}\n") });
    const run = (args, { cwd, env }) => new Promise((resolve, reject) => execFile("docker", ["compose", ...args], { cwd, env }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve({ stdout }))));
    const { model } = await G.loadComposeModel(dir, { env: B.composeEnv(), runConfig: run });
    assert.ok(model, "model loaded");
    assert.ok(!JSON.stringify(model).includes("gw-secret-value-xyz"));
  } finally { delete process.env.CROW_TEST_GATEWAY_SECRET; }
});

dockerTest("services behind an inactive profile are checked too (a hook or an operator can start them)", async () => {
  const dir = project({ "docker-compose.yml": C("") + "  extra:\n    image: busybox\n    profiles: [bridge]\n    privileged: true\n" });
  assert.equal((await gateDir(dir, { textCheck: false })).valid, false);
});

dockerTest("managed hosting: host networking is refused from the resolved model too (${N:-host}, LAN-level drivers)", async () => {
  const { validateInstall } = B;
  const prev = process.env.CROW_HOSTED;
  process.env.CROW_HOSTED = "1";
  try {
    for (const [id, compose] of [
      ["fx-hosted-a", C("    network_mode: ${N:-host}\n")],
      ["fx-hosted-b", C("    networks: [lan]\n") + "networks:\n  lan:\n    driver: macvlan\n"],
    ]) {
      stage(id, compose);
      const r = await validateInstall(id, { forceInstall: true });
      assert.equal(r.code, "hosted_forbidden", `${id}: ${JSON.stringify(r)}`);
    }
  } finally { if (prev === undefined) delete process.env.CROW_HOSTED; else process.env.CROW_HOSTED = prev; }
});

// ---- review round A ------------------------------------------------------------------

test("devices: a GPU-looking path that climbs out (/dev/dri/../nvme0n1) is a raw disk, not a GPU", () => {
  for (const src of ["/dev/dri/../nvme0n1", "/dev/dri/../../etc", "/dev/kfd/.."]) {
    assert.equal(check(svc({ devices: [{ source: src, target: "/dev/dri", permissions: "rwm" }] })).valid, false, src);
  }
  assert.equal(check(svc({ devices: [{ source: "/dev/dri/renderD128", target: "/dev/dri/renderD128" }] })).valid, true);
});

test("inside Crow's home only the bundle's own places are mountable (peer tokens, identity, keystores are not)", () => {
  const m = { manifest: { id: "fx" } };
  for (const f of ["peer-tokens.json", "identity.json", "board-token", ".keystore-env", "android-keystore", "installed.json", "panels", "skills", "other-bundle"]) {
    assert.equal(check(svc({ volumes: [bind(join(CROW_HOME, f), true)] }), m).valid, false, f);
  }
  for (const f of ["fx", "fx-downloads", join("media", "fx")]) {
    assert.equal(check(svc({ volumes: [bind(join(CROW_HOME, f))] }), m).valid, true, f);
  }
  assert.equal(check(svc({ volumes: [bind(join(CROW_HOME, "media"))] }), m).valid, false, "the whole media folder");
});

test("host code and config locations are refused: system dirs, the gateway checkout, home dot-folders, ~/bin", () => {
  const home = homedir();
  for (const src of ["/usr/local/bin", "/opt/x", "/var/spool/cron", "/var/lib/x", "/lib/systemd", join(home, ".config", "systemd", "user"),
    join(home, ".bashrc"), join(home, ".local", "bin"), join(home, "bin"), join(REPO, "servers"), join(REPO, ".env")]) {
    assert.equal(check(svc({ volumes: [bind(src)] }), { manifest: PRIV, consent: true }).valid, false, src);
  }
  for (const src of [join(home, "Music"), "/srv/media", "/mnt/external/films", "/media/usb"]) {
    assert.equal(check(svc({ volumes: [bind(src, true)] })).valid, true, src);
  }
});

test("external volumes (another project's data) and external networks other than crow-federation need privileged consent", () => {
  assert.equal(check({ ...svc({ volumes: [{ type: "volume", source: "db", target: "/d" }] }), volumes: { db: { external: true, name: "crow-workspace_db" } } }).valid, false);
  assert.equal(check({ ...svc({ networks: { n: null } }), networks: { n: { external: true, name: "crow-workspace_internal" } } }).valid, false);
  assert.equal(check({ ...svc({ networks: { f: null } }), networks: { f: { external: true, name: "crow-federation" } } }).valid, true);
});

test("a signed peer instance can't install, mint consent, uninstall or re-apply storage here", async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.crossHostAuth = { sourceInstanceId: "peer-x" }; next(); });
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [method, path] of [["POST", "/bundles/api/install"], ["POST", "/bundles/api/install-set"], ["GET", "/bundles/api/consent-challenge/browser"],
      ["POST", "/bundles/api/uninstall"], ["POST", "/bundles/api/shared-storage/apply/funkwhale"], ["POST", "/bundles/api/repin"],
      ["POST", "/bundles/api/INSTALL"], ["POST", "/bundles/api/install/"], ["GET", "/bundles/api/Consent-Challenge/browser"],
      ["GET", "/BUNDLES/api/consent-challenge/browser"], ["POST", "/bundles/api/Install-Set/"], ["POST", "/bundles/api//install"]]) {
      const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ bundle_id: "browser" }) } : {}) });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  } finally { server.close(); }
});
