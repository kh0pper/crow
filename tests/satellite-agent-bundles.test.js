// Satellite bundle management over the signed API (SAT-3, spec §7.0–§7.2, §8): install job
// lifecycle through bundle-core with crowHome = SAT_HOME, the memory gate, satellite compose
// rules, consent, env names-only, redacted + capped logs, signed backup manifests whose sha256
// matches the plain stream, start/stop/restart/uninstall/repin and the bot-access placeholder.
// docker / compose / cgroup / proc are injected: nothing here runs docker.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const CROW_HOME = mkdtempSync(join(tmpdir(), "satbun-crow-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satbun-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
actAsServe();

const P = await import("../servers/shared/satellite-protocol.js");
const { satelliteFetch } = await import("../servers/gateway/satellites/client.js");
const { issueCert } = await import("../servers/gateway/satellites/certs.js");
const { fakeIdentity } = await import("./helpers/fake-satellite.js");
const { startAgent } = await import("../servers/satellite/agent.js");
const { ensureSatelliteKey, writeCert, writePinned } = await import("../servers/satellite/keys.js");
const { LOG_CAP_BYTES } = await import("../servers/satellite/bundles.js");

const dirs = [CROW_HOME, process.env.CROW_DATA_DIR];
const agents = [];
after(async () => {
  for (const a of agents) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const identity = fakeIdentity();
const HOST = "satellite.example.ts.net";

function pairedHome() {
  const home = tmp("satbun-home-");
  const key = ensureSatelliteKey(home);
  const mgmt = P.generateKeypair();
  const c = issueCert({
    identity, instanceId: "inst-primary", primaryUrl: "https://crow.example.ts.net:8444",
    satellite_id: key.satellite_id, satellite_pubkey: key.ed25519_pub, mgmt_pubkey: mgmt.pubHex, now: Date.now(),
  });
  writePinned(home, {
    crow_id: c.payload.crow_id, root_pubkey: c.payload.root_pubkey, mgmt_pubkey: c.payload.mgmt_pubkey,
    primary_url: c.payload.primary_url, primary_instance_id: c.payload.primary_instance_id, target_sha: null,
  });
  writeCert(home, c);
  return { home, key, mgmt };
}

const SECRET_TOKEN = "tok-typed-secret-0123456789";
const MB = 1024 * 1024;

/** The bundle in the agent's own checkout ($SAT_HOME/app/bundles/<id>). */
function appBundle(home, id, { manifest = {}, compose = "services:\n  app:\n    image: demo:1\n", files = {} } = {}) {
  const dir = join(home, "app", "bundles", id);
  mkdirSync(join(dir, "server"), { recursive: true });
  const m = {
    id, name: id, version: "1.0.0", type: "bundle",
    satellite: { min_ram_mb: 120 }, mcp: { mem_mb: 40 },
    server: { command: "node", args: ["server/index.js"], envKeys: ["DEMO_URL", "DEMO_TOKEN", "DEMO_KEY"] },
    env_vars: [
      { name: "DEMO_URL", default: "http://localhost:3999" },
      { name: "DEMO_TOKEN", secret: true },
      { name: "DEMO_DATA" },
      { name: "DEMO_KEY", generate: "secret" },
    ],
    ...manifest,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  writeFileSync(join(dir, "server", "index.js"), "// mcp server\n");
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
  return dir;
}

const goodService = (over = {}) => ({ image: "demo:1", mem_limit: "134217728", oom_score_adj: 500, ports: [{ target: 3000, published: "3999", host_ip: "127.0.0.1", protocol: "tcp" }], ...over });

/** A fake compose + docker world, recording every call. */
function fakeDocker({ service = goodService(), logs = "" } = {}) {
  const w = { calls: [], service, logs, upFails: false, docker: [] };
  w.composeRunner = async (args, opts = {}) => {
    w.calls.push({ args, cwd: opts.cwd });
    if (args.includes("config")) return { stdout: JSON.stringify({ name: basename(opts.cwd), services: { app: w.service } }), stderr: "" };
    if (args[0] === "up" && w.upFails) throw Object.assign(new Error("up failed"), { stderr: "boom" });
    if (args[0] === "logs") return { stdout: w.logs, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  w.dockerRunner = async (cmd, args) => { w.docker.push(args); return { stdout: "" }; };
  return w;
}

const meminfo = (mb) => `MemTotal: 999424 kB\nMemAvailable: ${mb * 1024} kB\nSwapTotal: 4000000 kB\nSwapFree: 4000000 kB\n`;

async function boot({ memMb = 800, world = fakeDocker(), setup, npmRunner } = {}) {
  const s = pairedHome();
  if (setup) setup(s.home);
  const mem = { mb: memMb };
  const a = await startAgent({
    env: { CROW_HOME: s.home, CROW_SATELLITE_PORT: "0" }, out: () => {}, authLog: () => {}, sha: "a".repeat(40),
    bundleDeps: {
      composeRunner: world.composeRunner, dockerRunner: world.dockerRunner, mcpPids: () => [],
      readText: (p) => (p === "/proc/meminfo" ? meminfo(mem.mb) : null),
      npmRunner: npmRunner || (async () => { throw new Error("npm must not run in this test"); }),
    },
  });
  agents.push(a);
  return { ...s, a, world, mem };
}

const serveFetch = (port) => async (url, init = {}) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...init.headers, ...serveHeaders(null, "100.64.20.5") } });
};
const call = (t, method, path, body, { caller = "owner-local", maxBytes = 1024 * 1024 } = {}) => satelliteFetch(
  { id: t.a.satelliteId, tailnet_host: HOST, satellite_pubkey: t.a.key.ed25519_pub },
  { method, path: `/satellite/v1/${path}`, body, caller, maxBytes, fetchImpl: serveFetch(t.a.port), mgmtKey: { ed25519_priv: t.mgmt.privHex } },
);

async function waitJob(t, id) {
  for (let i = 0; i < 500; i++) {
    const r = await call(t, "GET", `jobs/${id}`);
    assert.equal(r.status, 200);
    if (r.json.status !== "running") return r.json;
    await new Promise((ok) => setTimeout(ok, 5));
  }
  throw new Error("job did not finish");
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const mode = (p) => statSync(p).mode & 0o777;

async function installDemo(t, body = {}) {
  const r = await call(t, "POST", "bundles/install", { id: "demo", env: { DEMO_TOKEN: SECRET_TOKEN }, ...body });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.match(r.json.job_id, /^[0-9a-f]{16,}$/);
  return waitJob(t, r.json.job_id);
}

// ── install ──────────────────────────────────────────────────────────────────

test("install: job copies from the agent's checkout, checks, writes .env/installed.json/mcp-addons.json, compose up", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  const job = await installDemo(t);
  assert.equal(job.status, "complete", job.log.join("\n"));
  assert.equal(job.bundle_id, "demo");
  assert.equal(job.action, "install");
  const dest = join(t.home, "bundles", "demo");
  assert.ok(existsSync(join(dest, "manifest.json")));
  assert.equal(mode(join(dest, ".env")), 0o600);
  const env = readFileSync(join(dest, ".env"), "utf8");
  assert.match(env, new RegExp(`DEMO_TOKEN=${SECRET_TOKEN}`));
  assert.match(env, /DEMO_KEY=\S{16,}/, "the generated secret is minted");
  // compose: config (model check), pull, up -d — all in the installed folder.
  const seq = t.world.calls.map((c) => c.args.find((a) => ["config", "pull", "up"].includes(a))).filter(Boolean);
  assert.deepEqual(seq, ["config", "pull", "up"]);
  assert.ok(t.world.calls.every((c) => c.cwd === dest));
  const inst = readJson(join(t.home, "installed.json"));
  assert.equal(inst.length, 1);
  assert.equal(inst[0].id, "demo");
  assert.equal(inst[0].type, "bundle");
  assert.equal(inst[0].version, "1.0.0");
  assert.equal(inst[0].compose_project, "demo");
  assert.ok(!Number.isNaN(Date.parse(inst[0].installedAt)));
  const addons = readJson(join(t.home, "mcp-addons.json"));
  assert.equal(mode(join(t.home, "mcp-addons.json")), 0o600);
  assert.equal(addons.demo.command, "node");
  assert.deepEqual(addons.demo.args, ["server/index.js"]);
  assert.equal(addons.demo.env.DEMO_TOKEN, SECRET_TOKEN);
  assert.equal(addons.demo.env.DEMO_URL, "http://localhost:3999");
  const generated = env.match(/DEMO_KEY=(\S+)/)[1];
  assert.equal(addons.demo.env.DEMO_KEY, generated);
  // The generated secret is in the satellite keychain, sealed (never plaintext).
  const rows = t.a.db.prepare("SELECT bundle_id, env_key, origin, secret_sealed, status FROM crow_keychain").all();
  assert.deepEqual(rows.map((r) => [r.bundle_id, r.env_key, r.origin, r.status]), [["demo", "DEMO_KEY", "generated", "active"]]);
  assert.ok(!rows[0].secret_sealed.includes(generated));
  assert.equal(mode(join(t.home, "secrets", "keychain.key")), 0o600);
  // No secret in the job log.
  assert.ok(!job.log.join("\n").includes(SECRET_TOKEN) && !job.log.join("\n").includes(generated));
  // Status lists it.
  assert.deepEqual((await call(t, "GET", "status")).json.installed, [{ id: "demo", version: "1.0.0" }]);
  // Audited with the caller.
  assert.ok(t.a.db.prepare("SELECT 1 FROM audit WHERE route = 'bundles/install' AND caller = 'owner-local' AND result = 'ok'").get());
  // Installed already: one install per bundle.
  assert.equal((await call(t, "POST", "bundles/install", { id: "demo" })).json.error, "already_installed");
});

test("install refusals: unknown, invalid id, not satellite, not measured, host paths, unknown or generated keys", async () => {
  const t = await boot({
    setup: (h) => {
      appBundle(h, "demo");
      appBundle(h, "plain", { manifest: { satellite: undefined } });
      appBundle(h, "unmeasured", { manifest: { satellite: true } });
    },
  });
  const refuse = async (body, status, code) => {
    const r = await call(t, "POST", "bundles/install", body);
    assert.equal(r.status, status, JSON.stringify(r.json));
    assert.equal(r.json.error, code);
    return r.json;
  };
  await refuse({ id: "nope" }, 404, "unknown_bundle");
  await refuse({ id: "../etc" }, 400, "bad_bundle_id");
  await refuse({ id: "plain" }, 403, "not_satellite");
  const nm = await refuse({ id: "unmeasured" }, 422, "not_measured");
  assert.match(nm.reason, /not measured for small servers yet/);
  await refuse({ id: "demo", env: { DEMO_DATA: "/home/someone/data" } }, 400, "host_path_refused");
  await refuse({ id: "demo", env: { DEMO_DATA: "~/data" } }, 400, "host_path_refused");
  await refuse({ id: "demo", env: { NOT_DECLARED: "x" } }, 400, "unknown_env_key");
  await refuse({ id: "demo", env: { DEMO_KEY: "chosen" } }, 400, "generated_env_key");
  await refuse({ id: "demo", env: { DEMO_TOKEN: "a\nb" } }, 400, "bad_env_value");
  await refuse({ id: "demo", env: "x" }, 400, "bad_env");
  assert.equal(t.world.calls.length, 0, "no compose run for a refused install");
  assert.ok(!existsSync(join(t.home, "bundles", "demo")));
});

test("install: a bot caller is refused (management is the owner's)", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  for (const [m, p] of [["POST", "bundles/install"], ["GET", "bundles/demo/env"], ["GET", "bundles/demo/logs"], ["GET", "bundles/demo/backups"], ["POST", "bundles/demo/stop"]]) {
    const r = await call(t, m, p, m === "POST" ? { id: "demo" } : undefined, { caller: "bot:b1" });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.error, "owner_only");
  }
});

test("install: the memory gate refuses with the shortfall in MB, counting installed bundles' headroom", async () => {
  const t = await boot({ memMb: 215, setup: (h) => { appBundle(h, "demo"); appBundle(h, "other", { manifest: { satellite: { min_ram_mb: 100 } } }); } });
  // 215 − 96 = 119 < 120.
  let r = await call(t, "POST", "bundles/install", { id: "demo" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "insufficient_memory");
  assert.equal(r.json.shortfall_mb, 1);
  assert.match(r.json.reason, /short by 1 MB/);
  t.mem.mb = 216;
  assert.equal((await installDemo(t)).status, "complete");
  // demo (120) uses nothing right now (no containers seen): it holds all 120. 315 − 96 − 120 = 99 < 100.
  t.mem.mb = 315;
  r = await call(t, "POST", "bundles/install", { id: "other" });
  assert.equal(r.json.shortfall_mb, 1);
  t.mem.mb = 316;
  const ok = await call(t, "POST", "bundles/install", { id: "other" });
  assert.equal(ok.status, 202);
  const oj = await waitJob(t, ok.json.job_id); assert.equal(oj.status, "complete", oj.log.join("\n"));
});

test("install: a compose file that breaks the satellite rules fails the job and leaves nothing behind", async () => {
  const world = fakeDocker({ service: goodService({ ports: [{ target: 3000, published: "3999", host_ip: "0.0.0.0" }] }) });
  const t = await boot({ world, setup: (h) => appBundle(h, "demo") });
  const job = await installDemo(t);
  assert.equal(job.status, "failed");
  assert.match(job.log.join("\n"), /127\.0\.0\.1/);
  assert.ok(!existsSync(join(t.home, "bundles", "demo")));
  assert.ok(!existsSync(join(t.home, "installed.json")) || readJson(join(t.home, "installed.json")).length === 0);
  assert.ok(!world.calls.some((c) => c.args[0] === "up"));
  // The shared model check runs too (a privileged service).
  world.service = goodService({ privileged: true });
  assert.equal((await installDemo(t)).status, "failed");
  // And the text check (a docker socket mount in the file itself).
  rmSync(join(t.home, "app", "bundles", "demo"), { recursive: true });
  appBundle(t.home, "demo", { compose: "services:\n  app:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n" });
  world.service = goodService();
  const j3 = await installDemo(t);
  assert.equal(j3.status, "failed");
  assert.match(j3.log.join("\n"), /Docker socket/i);
});

test("install: a failed compose up still records the bundle (Configure + Start can finish), job failed", async () => {
  const world = fakeDocker();
  world.upFails = true;
  const t = await boot({ world, setup: (h) => appBundle(h, "demo") });
  const job = await installDemo(t);
  assert.equal(job.status, "failed");
  assert.equal(readJson(join(t.home, "installed.json"))[0].id, "demo");
});

test("install: one install job at a time across the agent (each would pass the gate alone)", async () => {
  const world = fakeDocker();
  let release;
  const gate = new Promise((ok) => { release = ok; });
  const inner = world.composeRunner;
  world.composeRunner = async (args, o) => { if (args[0] === "pull") await gate; return inner(args, o); };
  // 400 − 96 = 304: room for demo (120) or other (200), never both.
  const t = await boot({ memMb: 400, world, setup: (h) => { appBundle(h, "demo"); appBundle(h, "other", { manifest: { satellite: { min_ram_mb: 200 } } }); } });
  const first = await call(t, "POST", "bundles/install", { id: "demo" });
  assert.equal(first.status, 202);
  const second = await call(t, "POST", "bundles/install", { id: "other" });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "job_running");
  release();
  assert.equal((await waitJob(t, first.json.job_id)).status, "complete");
  // Now demo's reservation is counted: other is refused by the gate, not raced past it.
  const third = await call(t, "POST", "bundles/install", { id: "other" });
  assert.equal(third.json.error, "insufficient_memory");
});

test("install: a failed install marks the keychain rows it saved as removed", async () => {
  const world = fakeDocker({ service: goodService({ privileged: true }) });
  const t = await boot({ world, setup: (h) => appBundle(h, "demo") });
  assert.equal((await installDemo(t)).status, "failed");
  assert.deepEqual(t.a.db.prepare("SELECT env_key, status FROM crow_keychain").all(), [{ env_key: "DEMO_KEY", status: "extension_removed" }]);
});

test("install: consent never unlocks a privileged-equivalent (consent verified, compose still refused)", async () => {
  const world = fakeDocker({ service: goodService({ volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", read_only: true }] }) });
  const t = await boot({ world, setup: (h) => appBundle(h, "demo", { manifest: { consent_required: true } }) });
  const ch = await call(t, "POST", "bundles/install", { id: "demo" });
  const c = await call(t, "POST", "bundles/demo/consent", { token: ch.json.challenge.token, accept: true });
  const job = await installDemo(t, { consent_token: c.json.consent_token });
  assert.equal(job.status, "failed");
  assert.match(job.log.join("\n"), /socket/i);
  // A manifest that declares privileged never gets as far as a job.
  rmSync(join(t.home, "app", "bundles", "demo"), { recursive: true });
  appBundle(t.home, "demo", { manifest: { privileged: true } });
  const r = await call(t, "POST", "bundles/install", { id: "demo" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "never_satellite");
});

test("install: one running job per bundle", async () => {
  const world = fakeDocker();
  let release;
  const gate = new Promise((ok) => { release = ok; });
  const inner = world.composeRunner;
  world.composeRunner = async (args, o) => { if (args[0] === "pull") await gate; return inner(args, o); };
  const t = await boot({ world, setup: (h) => appBundle(h, "demo") });
  const first = await call(t, "POST", "bundles/install", { id: "demo" });
  assert.equal(first.status, 202);
  const second = await call(t, "POST", "bundles/install", { id: "demo" });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "job_running");
  release();
  assert.equal((await waitJob(t, first.json.job_id)).status, "complete");
});

test("consent: challenge → signed answer → single-use consent token → install", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo", { manifest: { consent_required: true, install_consent_message: "This one reads logs." } }) });
  const r = await call(t, "POST", "bundles/install", { id: "demo" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "consent_required");
  assert.match(r.json.challenge.token, /^[0-9a-f]{32}$/);
  assert.equal(r.json.challenge.message, "This one reads logs.");
  assert.ok(Date.parse(r.json.challenge.expires_at) > Date.now());
  assert.equal((await call(t, "POST", "bundles/demo/consent", { token: "f".repeat(32), accept: true })).json.error, "consent_invalid");
  assert.equal((await call(t, "POST", "bundles/demo/consent", { token: r.json.challenge.token })).json.error, "consent_declined");
  const r2 = await call(t, "POST", "bundles/install", { id: "demo" });
  const c = await call(t, "POST", "bundles/demo/consent", { token: r2.json.challenge.token, accept: true });
  assert.equal(c.status, 200);
  assert.match(c.json.consent_token, /^[0-9a-f]{32}$/);
  assert.equal((await call(t, "POST", "bundles/demo/consent", { token: r2.json.challenge.token, accept: true })).json.error, "consent_invalid", "a challenge answers once");
  assert.equal((await call(t, "POST", "bundles/install", { id: "demo", consent_token: "0".repeat(32) })).json.error, "consent_invalid");
  const job = await installDemo(t, { consent_token: c.json.consent_token });
  assert.equal(job.status, "complete");
  assert.deepEqual(readJson(join(t.home, "installed.json"))[0].consent, { verified: true, privileged: false, consent_required: true });
});

test("install: a bundle's own package.json gets npm ci (no scripts, no dev deps) in the installed folder", async () => {
  const npm = [];
  const t = await boot({
    npmRunner: async (cmd, args, opts) => { npm.push({ cmd, args, cwd: opts.cwd }); return { stdout: "" }; },
    setup: (h) => appBundle(h, "demo", { files: { "package.json": "{}", "package-lock.json": "{}" } }),
  });
  assert.equal((await installDemo(t)).status, "complete");
  assert.equal(npm.length, 1);
  assert.equal(npm[0].cmd, "npm");
  assert.equal(npm[0].args[0], "ci");
  assert.ok(npm[0].args.includes("--ignore-scripts") && npm[0].args.includes("--omit=dev"));
  assert.equal(npm[0].cwd, join(t.home, "bundles", "demo"));
});

// ── env ──────────────────────────────────────────────────────────────────────

test("env: names and set/unset out, never values; PUT sets and unsets, refusing host paths and generated keys", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  await installDemo(t);
  const g = await call(t, "GET", "bundles/demo/env");
  assert.equal(g.status, 200);
  const text = JSON.stringify(g.json);
  assert.ok(!text.includes(SECRET_TOKEN) && !text.includes("localhost:3999"), "no value ever leaves");
  const byName = Object.fromEntries(g.json.keys.map((k) => [k.name, k]));
  assert.deepEqual(Object.keys(byName).sort(), ["DEMO_DATA", "DEMO_KEY", "DEMO_TOKEN", "DEMO_URL"]);
  assert.equal(byName.DEMO_TOKEN.set, true);
  assert.equal(byName.DEMO_DATA.set, false);
  assert.equal(byName.DEMO_KEY.generated, true);
  assert.deepEqual(Object.keys(byName.DEMO_TOKEN).sort(), ["generated", "name", "secret", "set"]);

  const p = await call(t, "PUT", "bundles/demo/env", { env: { DEMO_DATA: "relative-dir", DEMO_TOKEN: null } });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.restart_needed, true);
  const after1 = Object.fromEntries(p.json.keys.map((k) => [k.name, k.set]));
  assert.deepEqual([after1.DEMO_DATA, after1.DEMO_TOKEN], [true, false]);
  const env = readFileSync(join(t.home, "bundles", "demo", ".env"), "utf8");
  assert.ok(!env.includes(SECRET_TOKEN));
  assert.match(env, /DEMO_DATA=relative-dir/);
  assert.equal(mode(join(t.home, "bundles", "demo", ".env")), 0o600);
  assert.equal(readJson(join(t.home, "mcp-addons.json")).demo.env.DEMO_TOKEN, undefined, "the MCP entry follows");
  for (const [env2, code] of [[{ DEMO_DATA: "/srv/x" }, "host_path_refused"], [{ DEMO_KEY: "x" }, "generated_env_key"], [{ NOPE: "x" }, "unknown_env_key"], [{ DEMO_DATA: "a\0b" }, "bad_env_value"]]) {
    const r = await call(t, "PUT", "bundles/demo/env", { env: env2 });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, code);
  }
  assert.equal((await call(t, "GET", "bundles/nope/env")).json.error, "not_installed");
});

// ── logs ─────────────────────────────────────────────────────────────────────

test("logs: tail/since reach compose; redacted against env values and keychain entries; 256 KiB cap keeps the newest", async () => {
  const world = fakeDocker();
  const t = await boot({ world, setup: (h) => appBundle(h, "demo") });
  await installDemo(t);
  const generated = readFileSync(join(t.home, "bundles", "demo", ".env"), "utf8").match(/DEMO_KEY=(\S+)/)[1];
  world.logs = `app-1 | token=${SECRET_TOKEN}\napp-1 | key=${generated}\napp-1 | fine\n`;
  const r = await call(t, "GET", "bundles/demo/logs?tail=50&since=2026-10-29T00:00:00Z");
  assert.equal(r.status, 200);
  assert.ok(!r.json.log.includes(SECRET_TOKEN));
  assert.ok(!r.json.log.includes(generated));
  assert.match(r.json.log, /token=\[redacted\]/);
  assert.match(r.json.log, /fine/);
  assert.equal(r.json.truncated, false);
  const last = world.calls.at(-1).args;
  assert.deepEqual(last.slice(0, 3), ["logs", "--no-color", "--tail"]);
  assert.equal(last[3], "50");
  assert.deepEqual(last.slice(4), ["--since=2026-10-29T00:00:00Z"]);
  // Default tail 200, no since.
  await call(t, "GET", "bundles/demo/logs");
  assert.deepEqual(world.calls.at(-1).args, ["logs", "--no-color", "--tail", "200"]);
  // Cap.
  assert.equal(LOG_CAP_BYTES, 262144);
  world.logs = "old-line\n" + "x".repeat(LOG_CAP_BYTES) + `\nnewest ${SECRET_TOKEN}\n`;
  const big = await call(t, "GET", "bundles/demo/logs", undefined, { maxBytes: 2 * 1024 * 1024 });
  assert.equal(big.json.truncated, true);
  assert.ok(Buffer.byteLength(big.json.log) <= LOG_CAP_BYTES);
  assert.match(big.json.log, /newest \[redacted\]/);
  assert.ok(!big.json.log.includes("old-line"));
  for (const q of ["tail=0", "tail=abc", "tail=100000", "since=;rm", "since=-1h", "since=--follow"]) {
    const bad = await call(t, "GET", `bundles/demo/logs?${q}`);
    assert.equal(bad.status, 400, q);
  }
});

// ── backups ──────────────────────────────────────────────────────────────────

test("backups: signed manifest [{name,size,sha256,created_at}]; the plain stream hashes to it", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  await installDemo(t);
  const dir = join(t.home, "backups", "demo");
  mkdirSync(dir, { recursive: true });
  const dump = Buffer.from("gitea dump bytes ".repeat(5000));
  writeFileSync(join(dir, "gitea-dump-2026-10-29.zip"), dump);
  writeFileSync(join(t.home, "outside.txt"), "not a backup");
  symlinkSync(join(t.home, "outside.txt"), join(dir, "link.zip"));
  mkdirSync(join(dir, "subdir"));
  const m = await call(t, "GET", "bundles/demo/backups");
  assert.equal(m.status, 200, "satelliteFetch verified the response signature");
  assert.deepEqual(m.json.backups.map((b) => b.name), ["gitea-dump-2026-10-29.zip"], "no symlinks, no dirs");
  const b = m.json.backups[0];
  assert.deepEqual(Object.keys(b).sort(), ["created_at", "name", "sha256", "size"]);
  assert.equal(b.size, dump.length);
  assert.equal(b.sha256, createHash("sha256").update(dump).digest("hex"));

  // The stream: signed request, plain bytes back.
  const path = `/satellite/v1/bundles/demo/backups/${b.name}`;
  const headers = P.signRequest(t.mgmt.privHex, { method: "GET", pathQuery: path, body: "", satelliteId: t.a.satelliteId, caller: "owner-local" });
  const res = await fetch(`http://127.0.0.1:${t.a.port}${path}`, { headers: { ...headers, ...serveHeaders(null, "100.64.20.5") } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  const got = Buffer.from(await res.arrayBuffer());
  assert.equal(createHash("sha256").update(got).digest("hex"), b.sha256);
  // Audited on the response's "finish", which may land just after the client has the bytes.
  const auditRow = () => t.a.db.prepare("SELECT result FROM audit WHERE route = ? AND caller = 'owner-local'").get(`bundles/demo/backups/${b.name}`);
  for (let i = 0; i < 200 && !auditRow(); i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.deepEqual(auditRow(), { result: "ok" });

  for (const [name, code] of [["link.zip", "not_found"], ["subdir", "not_found"], ["missing.zip", "not_found"], ["..%2Foutside.txt", "bad_name"], [".hidden", "bad_name"]]) {
    const r = await call(t, "GET", `bundles/demo/backups/${name}`);
    assert.equal(r.json?.error, code, name);
  }
  // Unsigned: nothing.
  const unsigned = await fetch(`http://127.0.0.1:${t.a.port}${path}`, { headers: serveHeaders(null, "100.64.20.5") });
  assert.equal(unsigned.status, 401);
  // No backups dir yet: an empty list.
  rmSync(dir, { recursive: true });
  assert.deepEqual((await call(t, "GET", "bundles/demo/backups")).json, { backups: [] });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test("start/stop/restart: compose up -d (re-checked) / stop / restart; uninstall downs and removes; repin; bot-access 501", async () => {
  const world = fakeDocker();
  const t = await boot({ world, setup: (h) => appBundle(h, "demo", { manifest: { server: { command: "./run.sh", args: [], envKeys: [] } }, files: { "run.sh": "#!/bin/sh\necho one\n" } }) });
  chmodSync(join(t.home, "app", "bundles", "demo", "run.sh"), 0o755);
  await installDemo(t);
  const pin1 = readJson(join(t.home, "mcp-addons.json")).demo.command_sha256;
  assert.match(pin1, /^[0-9a-f]{64}$/);

  world.calls.length = 0;
  assert.deepEqual((await call(t, "POST", "bundles/demo/stop")).json, { ok: true });
  assert.deepEqual(world.calls.map((c) => c.args), [["stop"]]);
  world.calls.length = 0;
  assert.deepEqual((await call(t, "POST", "bundles/demo/start")).json, { ok: true });
  assert.deepEqual(world.calls.map((c) => (c.args.includes("config") ? "config" : c.args.join(" "))), ["config", "up -d"]);
  world.calls.length = 0;
  assert.deepEqual((await call(t, "POST", "bundles/demo/restart")).json, { ok: true });
  // Restart re-checks and recreates, so a changed .env applies.
  assert.deepEqual(world.calls.map((c) => (c.args.includes("config") ? "config" : c.args.join(" "))), ["config", "up -d --force-recreate"]);
  // Start re-runs the satellite rules: a model that no longer passes is not started.
  world.service = goodService({ network_mode: "host" });
  world.calls.length = 0;
  const bad = await call(t, "POST", "bundles/demo/start");
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, "compose_refused");
  assert.ok(!world.calls.some((c) => c.args[0] === "up"));
  world.service = goodService();

  // repin after the launcher changed.
  writeFileSync(join(t.home, "bundles", "demo", "run.sh"), "#!/bin/sh\necho two\n");
  const rp = await call(t, "POST", "bundles/repin", { id: "demo" });
  assert.equal(rp.status, 200, JSON.stringify(rp.json));
  assert.notEqual(rp.json.sha256, pin1);
  assert.equal(readJson(join(t.home, "mcp-addons.json")).demo.command_sha256, rp.json.sha256);

  const ba = await call(t, "POST", "bundles/demo/bot-access", {});
  assert.equal(ba.status, 501);
  assert.equal(ba.json.error, "not_supported");

  assert.equal((await call(t, "POST", "bundles/nope/stop")).json.error, "not_installed");

  world.calls.length = 0;
  const u = await call(t, "POST", "bundles/uninstall", { id: "demo" });
  assert.equal(u.status, 202);
  const uj = await waitJob(t, u.json.job_id);
  assert.equal(uj.status, "complete", uj.log.join("\n"));
  assert.deepEqual(world.calls.map((c) => c.args), [["down"]]);
  assert.ok(!existsSync(join(t.home, "bundles", "demo")));
  assert.deepEqual(readJson(join(t.home, "installed.json")), []);
  assert.equal(readJson(join(t.home, "mcp-addons.json")).demo, undefined);
  assert.equal((await call(t, "POST", "bundles/uninstall", { id: "demo" })).json.error, "not_installed");
});

test("uninstall marks the bundle's keychain rows removed (kept for a reinstall), jobs/:id unknown is 404", async () => {
  const t = await boot({ setup: (h) => appBundle(h, "demo") });
  await installDemo(t);
  const u = await call(t, "POST", "bundles/uninstall", { id: "demo" });
  await waitJob(t, u.json.job_id);
  assert.deepEqual(t.a.db.prepare("SELECT env_key, status FROM crow_keychain").all(), [{ env_key: "DEMO_KEY", status: "extension_removed" }]);
  const j = await call(t, "GET", "jobs/ffffffffffffffff");
  assert.equal(j.status, 404);
  assert.equal(j.json.error, "unknown_job");
  // A job survives in satellite.db (crow polls after an agent restart).
  const row = t.a.db.prepare("SELECT id, action, status FROM jobs WHERE id = ?").get(u.json.job_id);
  assert.deepEqual(row, { id: u.json.job_id, action: "uninstall", status: "complete" });
});
