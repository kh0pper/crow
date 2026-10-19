/**
 * A second home without CROW_DATA_DIR never touches the first home's files
 * (queue item 33, 2026-10-16 incident).
 *
 * A scratch gateway with its own CROW_HOME + CROW_DB_PATH but no CROW_DATA_DIR
 * resolved the host-default ~/.crow/data, loaded the primary's
 * models/state.json, reconciled it against its own empty providers table and
 * freed the primary's port reservation. These tests boot real gateways from
 * this checkout under a fake HOME whose ~/.crow is a seeded "primary", and
 * prove every file under it is byte-identical afterwards.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import http from "node:http";

const REPO = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "crow-datadir-iso-"));
const children = [];
after(() => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
});

// The checkout .env is applied to every gateway started from it. If it names
// instance paths, the child could be handed a REAL data dir — skip rather than
// risk it (never the case in CI or a worktree).
const envFile = join(REPO, ".env");
const envFileNamesPaths = existsSync(envFile) && /^(CROW_DATA_DIR|CROW_DB_PATH|CROW_HOME)=/m.test(readFileSync(envFile, "utf8"));
const skip = envFileNamesPaths ? "checkout .env sets instance paths; run from a clean worktree" : false;

const fakeHome = join(scratch, "host");
const primaryHome = join(fakeHome, ".crow");
const primaryData = join(primaryHome, "data");

function baseEnv(extra) {
  const env = { ...process.env, HOME: fakeHome };
  for (const k of ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_BACKUP_DIR", "CROW_INSTANCES_JSON_PATH",
    "CROW_REFCOUNT_PATH", "CROW_PEER_TOKENS_PATH", "NTFY_TOPIC", "CROW_GATEWAY_URL", "PORT", "CROW_GATEWAY_PORT",
    "CROW_ALLOW_SHARED_DATA_DIR"]) delete env[k];
  env.CROW_DISABLE_HEALTH_MONITOR = "1";
  env.CROW_DISABLE_INSTANCE_SYNC = "1";
  env.CROW_DISABLE_NOSTR = "1";
  env.CROW_AUTO_UPDATE = "0";
  env.CROW_DISABLE_NTFY_AUTOWIRE = "1";
  return { ...env, ...extra };
}

function initDb(env) {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env, cwd: REPO, stdio: "pipe" });
}

/** sha256 + mtime of every file under `root`. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) { out[p + "/"] = "dir"; walk(p); }
      else out[p] = `${createHash("sha256").update(readFileSync(p)).digest("hex")}@${statSync(p).mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

function healthOnce(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", () => resolve(0));
    req.setTimeout(1000, () => { req.destroy(); resolve(0); });
  });
}

/** Start a gateway; resolve { exited, code, log } on exit or { healthy, log } when healthy. */
async function boot(env, timeoutMs = 60_000) {
  const port = await freePort();
  const child = spawn(process.execPath, ["servers/gateway/index.js", "--no-auth"], {
    env: { ...env, PORT: String(port), CROW_GATEWAY_URL: `http://127.0.0.1:${port}` }, cwd: REPO, stdio: "pipe",
  });
  children.push(child);
  let log = "";
  child.stdout.on("data", (c) => { log += c; });
  child.stderr.on("data", (c) => { log += c; });
  let exit = null;
  child.on("exit", (code) => { exit = { code }; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exit) return { exited: true, code: exit.code, log, child };
    if ((await healthOnce(port)) === 200) return { healthy: true, log: () => log, child };
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`gateway neither healthy nor exited in ${timeoutMs}ms\n${log.slice(-3000)}`);
}

/** Wait until the log shows the boot native-model reconcile finished (any branch). */
async function waitForReconcile(r, timeoutMs = 60_000) {
  // "done"/"skipped"/"failed" end every branch; ": freed" is what origin/main
  // printed when it freed the primary's reservation (so the test is red there).
  const re = /native model reconcile( done| skipped| failed|: freed)/;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (re.test(r.log())) return;
    if (r.child.exitCode !== null) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`no reconcile line\n${r.log().slice(-3000)}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000); });
}

// The primary: an init-db'd DB, an instance-id, and model state holding a
// reservation whose owner pid is dead. A second instance whose DB has no row
// for it is exactly what freed the real one.
function seedPrimary() {
  mkdirSync(join(primaryData, "models"), { recursive: true });
  initDb(baseEnv({ CROW_DATA_DIR: primaryData }));
  writeFileSync(join(primaryData, "instance-id"), "f".repeat(32));
  writeFileSync(join(primaryData, "models", "state.json"), JSON.stringify({
    reservations: { "primary-model": { port: 18100, owner: { crowHome: primaryData, pid: 2147483646 }, createdAt: "2026-10-16T00:00:00.000Z" } },
    journal: {}, registry: {}, conversions: {}, runtimeOverride: null, runtimeOverrides: {},
  }, null, 2));
}

for (const [label, dbRel, dataRel] of [
  ["DB inside <home>/data", ["data", "crow.db"], ["data"]],
  ["DB directly in <home> (the exact 10-16 env)", ["crow.db"], []],
]) {
  test(`10-16 shape, ${label}: CROW_HOME + CROW_DB_PATH, no CROW_DATA_DIR — boots on its own data, the primary stays byte-identical`, { skip, timeout: 180_000 }, async () => {
    if (!existsSync(join(primaryData, "crow.db"))) seedPrimary();
    const before = snapshot(primaryHome);
    const home2 = join(fakeHome, `.crow-second-${dbRel.length}`);
    mkdirSync(join(home2, ...dbRel.slice(0, -1)), { recursive: true });
    const env = baseEnv({ CROW_HOME: home2, CROW_DB_PATH: join(home2, ...dbRel) });
    initDb(env);

    const r = await boot(env);
    assert.ok(r.healthy, `second gateway should boot\n${typeof r.log === "function" ? r.log() : r.log}`);
    try {
      // The reconcile runs after listen, unawaited: wait for its log line.
      await waitForReconcile(r);
    } finally {
      await stop(r.child);
    }
    const log = r.log();
    // The incident assertions first: these are what origin/main failed.
    const state = JSON.parse(readFileSync(join(primaryData, "models", "state.json"), "utf8"));
    assert.ok(state.reservations["primary-model"], `the primary's reservation is still there\n${log.slice(-2000)}`);
    assert.deepEqual(snapshot(primaryHome), before, "no file under the primary home changed or appeared");
    // The second instance used its own data dir, and its reconcile really ran.
    const ownData = join(home2, ...dataRel);
    assert.match(log, new RegExp(`CROW_DATA_DIR unset; using ${ownData.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
    assert.match(log, /native model reconcile done/);
    assert.ok(existsSync(join(ownData, "instance-id")), "instance-id written in its own data dir");
  });
}

test("CROW_HOME alone, no own data dir yet, while the primary DB exists: refuses to start, touches nothing", { skip, timeout: 120_000 }, async () => {
  if (!existsSync(join(primaryData, "crow.db"))) seedPrimary();
  const before = snapshot(primaryHome);
  const home3 = join(fakeHome, ".crow-third");
  const r = await boot(baseEnv({ CROW_HOME: home3 }));
  assert.ok(r.exited, "must not come up");
  assert.equal(r.code, 78, "EX_CONFIG, so RestartPreventExitStatus=78 stops a restart loop");
  assert.match(r.log, /Refusing to start/);
  assert.match(r.log, /CROW_DATA_DIR=.*\.crow-third\/data/);
  assert.equal(existsSync(join(home3, "data")), false, "no data dir was created for it");
  assert.deepEqual(snapshot(primaryHome), before);
});

test("CROW_DATA_DIR pointing at the primary's data dir: refuses to start, touches nothing", { skip, timeout: 120_000 }, async () => {
  if (!existsSync(join(primaryData, "crow.db"))) seedPrimary();
  const before = snapshot(primaryHome);
  const r = await boot(baseEnv({ CROW_HOME: join(fakeHome, ".crow-fourth"), CROW_DATA_DIR: primaryData }));
  assert.ok(r.exited);
  assert.equal(r.code, 78, "EX_CONFIG, so RestartPreventExitStatus=78 stops a restart loop");
  assert.match(r.log, /host-default instance's data dir/);
  assert.deepEqual(snapshot(primaryHome), before);
});
