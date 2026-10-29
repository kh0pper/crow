// Satellite agent boot (SAT-3, spec §6.1, §6.3, §11.1): the gateway refuses the satellite
// profile; the agent's start guards exit 78; a clean boot makes satellite.db and the satellite
// key with tight modes, prints the pairing code, and announces `listening on 127.0.0.1:<port>`
// (the readiness signal, never a sleep). /health is the only route a non-Serve peer reaches.
// The last test pairs the spawned agent end to end with crow's real pairing client, reading the
// code from the agent's console the way an owner would.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

const REPO = join(import.meta.dirname, "..");
const AGENT = join(REPO, "servers", "satellite", "index.js");
const CLI = join(REPO, "servers", "satellite", "cli.js");
const GATEWAY = join(REPO, "servers", "gateway", "index.js");
const UID = String(typeof process.getuid === "function" ? process.getuid() : 0);

const dirs = [];
const kids = new Set();
after(() => {
  for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A fresh HOME + SAT_HOME and the minimal env a satellite unit would have. */
function sandbox(extra = {}) {
  const home = tmp("satboot-home-");
  const sat = join(home, ".crow-satellite");
  const env = {
    PATH: process.env.PATH, HOME: home, CROW_HOME: sat, CROW_PROFILE: "satellite",
    CROW_SATELLITE_PORT: "0", CROW_SERVE_PEER_UIDS: UID, ...extra,
  };
  return { home, sat, env };
}

/** Spawn; resolve {child, port, out} on the readiness line, or reject on exit first. */
function startAgent(env, { timeoutMs = 30000 } = {}) {
  const child = spawn(process.execPath, [AGENT], { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  kids.add(child);
  const state = { out: "", err: "" };
  child.stderr.on("data", (d) => { state.err += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no readiness line in ${timeoutMs} ms\n${state.out}\n${state.err}`)), timeoutMs);
    child.stdout.on("data", (d) => {
      state.out += d;
      const m = state.out.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), state }); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`agent exited ${code} before listening\n${state.out}\n${state.err}`)); });
  });
  return ready;
}

/** Run to exit; resolve {code, out, err}. */
function runToExit(file, env, { args = [], timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    kids.add(child);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no exit in ${timeoutMs} ms\n${out}\n${err}`)); }, timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); kids.delete(child); resolve({ code, out, err }); });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on("exit", () => { kids.delete(child); resolve(); });
    child.kill("SIGTERM");
  });
}

/** Raw HTTP so the test controls every header (fetch adds none we'd have to undo). */
function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: {
      ...(data !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers,
    } }, (res) => {
      let text = "";
      res.on("data", (d) => { text += d; });
      res.on("end", () => resolve({ status: res.status ?? res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const SERVE = { "x-forwarded-for": "100.64.20.5", "x-forwarded-host": "satellite.example.ts.net" };
const SEED = JSON.stringify({ version: 1, seed: "c2VlZA==" });

// ── the gateway refuses the satellite profile ───────────────────────────────

test("gateway: CROW_PROFILE=satellite exits 78 with one line, before any listener", async () => {
  const home = tmp("satboot-gw-");
  const r = await runToExit(GATEWAY, {
    PATH: process.env.PATH, HOME: home, CROW_HOME: join(home, ".crow-x"), CROW_PROFILE: "satellite",
    CROW_GATEWAY_PORT: "0", CROW_APP_ENV_PATH: join(home, "no.env"),
  });
  assert.equal(r.code, 78, r.err);
  const lines = r.err.trim().split("\n");
  assert.equal(lines.length, 1, r.err);
  assert.match(lines[0], /satellite/i);
  assert.equal(existsSync(join(home, ".crow-x")), false, "the gateway made no instance state");
});

// ── the agent's start guards ────────────────────────────────────────────────

const guardCases = [
  ["seed identity.json in CROW_DATA_DIR", (s) => {
    const d = join(s.home, "data-elsewhere"); mkdirSync(d); writeFileSync(join(d, "identity.json"), SEED);
    s.env.CROW_DATA_DIR = d;
  }, /identity/],
  ["seed identity.json under ~/.crow/data", (s) => {
    mkdirSync(join(s.home, ".crow", "data"), { recursive: true }); writeFileSync(join(s.home, ".crow", "data", "identity.json"), SEED);
  }, /identity/],
  ["seed identity.json.*.bak under another ~/.crow-* dir", (s) => {
    mkdirSync(join(s.home, ".crow-old")); writeFileSync(join(s.home, ".crow-old", "identity.json.before-pairing.bak"), SEED);
  }, /identity/],
  ["seed identity.json in SAT_HOME", (s) => {
    mkdirSync(s.sat, { recursive: true }); writeFileSync(join(s.sat, "identity.json"), SEED);
  }, /identity/],
  ["CROW_TRUSTED_PROXIES set", (s) => { s.env.CROW_TRUSTED_PROXIES = "loopback"; }, /CROW_TRUSTED_PROXIES/],
  ["CROW_DASHBOARD_PUBLIC set", (s) => { s.env.CROW_DASHBOARD_PUBLIC = "true"; }, /CROW_DASHBOARD_PUBLIC/],
  ["bind 0.0.0.0", (s) => { s.env.CROW_SATELLITE_HOST = "0.0.0.0"; }, /0\.0\.0\.0/],
  ["bind ::", (s) => { s.env.CROW_SATELLITE_HOST = "::"; }, /::/],
  ...["0", "0.0", "00.0.0.0", "0x0.0.0.0", "::ffff:0.0.0.0", "[::]", "100.64.20.9", "10.0.0.5"].map((h) =>
    [`bind ${h} (not loopback)`, (s) => { s.env.CROW_SATELLITE_HOST = h; }, /not loopback/]),
  ["CROW_SERVE_PEER_UIDS=off", (s) => { s.env.CROW_SERVE_PEER_UIDS = "off"; }, /CROW_SERVE_PEER_UIDS=off/],
  ["symlinked CROW_DATA_DIR holding a seed", (s) => {
    const real = join(s.home, "real-data"); mkdirSync(real); writeFileSync(join(real, "identity.json"), SEED);
    symlinkSync(real, join(s.home, "data-link")); s.env.CROW_DATA_DIR = join(s.home, "data-link");
  }, /identity/],
  ["symlinked ~/.crow root holding a seed", (s) => {
    const real = join(s.home, "elsewhere"); mkdirSync(join(real, "data"), { recursive: true });
    writeFileSync(join(real, "data", "identity.json"), SEED); symlinkSync(real, join(s.home, ".crow"));
  }, /identity/],
  ["symlinked identity.json pointing at a seed", (s) => {
    writeFileSync(join(s.home, "seed-file"), SEED); mkdirSync(join(s.home, ".crow-z"));
    symlinkSync(join(s.home, "seed-file"), join(s.home, ".crow-z", "identity.json"));
  }, /identity/],
];

for (const [name, arrange, msg] of guardCases) {
  test(`guard: ${name} → exit 78, one plain line, nothing written`, async () => {
    const s = sandbox();
    arrange(s);
    const r = await runToExit(AGENT, s.env);
    assert.equal(r.code, 78, r.out + r.err);
    assert.match(r.err, msg);
    assert.equal(r.err.trim().split("\n").length, 1, r.err);
    assert.equal(existsSync(join(s.sat, "satellite.db")), false);
    assert.equal(existsSync(join(s.sat, "secrets")), false);
  });
}

// ── a clean boot ────────────────────────────────────────────────────────────

test("boot: db + key with tight modes, the code on the console, /health, non-Serve → 404", async () => {
  const s = sandbox();
  // An identity.json WITHOUT a seed is not a full Crow identity: it does not trip the guard.
  mkdirSync(join(s.home, ".crow-notes"));
  writeFileSync(join(s.home, ".crow-notes", "identity.json"), JSON.stringify({ name: "x" }));
  const { child, port, state } = await startAgent(s.env);

  const code = state.out.match(/^Pairing code: {3}([0-9A-Z]{4}(?:-[0-9A-Z]{4}){5}) {3}\(expires \d\d:\d\d\)$/m);
  assert.ok(code, state.out);
  const idLine = state.out.match(/^This server id: (sat_[a-z2-7]{4}(?:-[a-z2-7]{4}){4})$/m);
  assert.ok(idLine, state.out);

  assert.equal(statSync(join(s.sat, "satellite.db")).mode & 0o777, 0o600);
  assert.equal(statSync(join(s.sat, "secrets")).mode & 0o777, 0o700);
  const keyFile = join(s.sat, "secrets", "satellite-key.json");
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const key = JSON.parse(readFileSync(keyFile, "utf8"));
  assert.deepEqual(Object.keys(key).sort(), ["created_at", "ed25519_priv", "ed25519_pub", "satellite_id", "version"]);
  assert.equal(idLine[1], `sat_${key.satellite_id.slice(4).match(/.{4}/g).join("-")}`);
  // The code is stored only as a one-way value.
  const db = readFileSync(join(s.sat, "satellite.db"));
  assert.equal(db.includes(Buffer.from(code[1].replace(/-/g, ""))), false);
  assert.equal(db.includes(Buffer.from(code[1])), false);

  for (const headers of [{}, SERVE]) {
    const h = await request(port, { path: "/health", headers });
    assert.equal(h.status, 200);
    const j = JSON.parse(h.text);
    assert.deepEqual(Object.keys(j).sort(), ["ok", "protocol", "time"]);
    assert.equal(j.ok, true);
    assert.equal(j.protocol, 1);
    assert.match(j.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  // Not Serve: plain loopback, forged Serve shape from a wrong uid is covered in-process.
  for (const path of ["/satellite/v1/pair/hello", "/satellite/v1/anything", "/"]) {
    const r = await request(port, { method: "POST", path, body: { nonce_c: "0".repeat(32) } });
    assert.equal(r.status, 404, path);
    assert.equal(r.text, "", path);
  }
  // Serve: the hello answers.
  const hello = await request(port, { method: "POST", path: "/satellite/v1/pair/hello", headers: SERVE, body: { nonce_c: "1".repeat(32) } });
  assert.equal(hello.status, 200, hello.text);
  assert.equal(JSON.parse(hello.text).satellite_id, key.satellite_id);
  await stop(child);

  // A second boot keeps the same key and prints a fresh code (the first one is voided).
  const again = await startAgent(s.env);
  assert.match(again.state.out, new RegExp(`This server id: ${idLine[1]}`));
  const code2 = again.state.out.match(/^Pairing code: {3}(\S+)/m);
  assert.notEqual(code2[1], code[1]);
  await stop(again.child);

  // cli status (agent stopped or running: it reads the files and db directly).
  const st = execFileSync(process.execPath, [CLI, "status"], { env: s.env, cwd: REPO }).toString();
  assert.match(st, /not paired/i);
  assert.match(st, new RegExp(idLine[1]));
});

// ── end to end with crow's real pairing client ──────────────────────────────

test("e2e: crow's pairing client pairs the spawned agent with the code from its console", async () => {
  const s = sandbox();
  const crowHome = tmp("satboot-crow-");
  process.env.CROW_HOME = crowHome; // crow's mgmt key lands here (this test process only)
  const { createDbClient } = await import("../servers/db.js");
  const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
  const { createPairingService } = await import("../servers/gateway/satellites/pairing.js");
  const S = await import("../servers/gateway/satellites/store.js");
  const { fakeIdentity } = await import("./helpers/fake-satellite.js");
  const db = createDbClient(join(crowHome, "crow.db"));
  await db.executeMultiple(SATELLITE_DDL);
  const identity = fakeIdentity();

  const { child, port, state } = await startAgent(s.env);
  const printed = state.out.match(/^Pairing code: {3}(\S+)/m)[1];

  // fetchImpl: crow → "https://satellite.example.ts.net/..." becomes Serve's hop to the agent.
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...init.headers, ...SERVE } });
  };
  const svc = createPairingService({
    fetchImpl, whoisImpl: async () => ({ node: "satellite", tags: ["tag:vps"] }), identityFn: () => identity,
    instanceIdFn: () => "inst-primary", primaryUrlFn: async () => "https://crow.example.ts.net:8444",
    targetShaFn: () => "b".repeat(40),
  });
  // `cli.js pair-code` while the agent runs: a fresh code, and the printed one is void.
  const pc = await runToExit(CLI, s.env, { args: ["pair-code"] });
  assert.equal(pc.code, 0, pc.err);
  const fresh = pc.out.match(/^Pairing code: {3}([0-9A-Z]{4}(?:-[0-9A-Z]{4}){5}) {3}\(expires \d\d:\d\d\)$/m)[1];
  assert.notEqual(fresh, printed);

  const stale = await svc.startPairing({ host: "satellite.example.ts.net" });
  await assert.rejects(svc.completePairing({ db, pairing_id: stale.pairing_id, code: printed, name: "vps" }),
    (e) => e.code === "pairing_refused" && e.detail === "bad_mac");

  const start = await svc.startPairing({ host: "satellite.example.ts.net" });
  assert.match(state.out, new RegExp(`This server id: ${start.fingerprint}`));
  const done = await svc.completePairing({ db, pairing_id: start.pairing_id, code: fresh, name: "vps" });
  assert.equal((await S.getSatellite(db, done.satellite_id)).status, "active");

  // The agent logged the pairing and wrote its files.
  const deadline = Date.now() + 10000;
  while (!state.out.includes(`Paired with ${identity.crowId}`) && Date.now() < deadline) await new Promise((r) => setImmediate(r));
  assert.match(state.out, new RegExp(`Paired with ${identity.crowId}`));
  for (const f of ["cert.json", "pinned.json"]) assert.equal(statSync(join(s.sat, f)).mode & 0o777, 0o600);
  const pinned = JSON.parse(readFileSync(join(s.sat, "pinned.json"), "utf8"));
  assert.equal(pinned.crow_id, identity.crowId);
  assert.equal(pinned.root_pubkey, identity.ed25519Pubkey);
  assert.equal(pinned.mgmt_pubkey, JSON.parse((await S.getSatellite(db, done.satellite_id)).cert_json).payload.mgmt_pubkey);
  assert.equal(pinned.primary_url, "https://crow.example.ts.net:8444");
  assert.equal(pinned.primary_instance_id, "inst-primary");
  assert.equal(pinned.target_sha, "b".repeat(40));

  // Paired: both pairing routes are 409.
  for (const p of ["/satellite/v1/pair/hello", "/satellite/v1/pair/complete"]) {
    const r = await request(port, { method: "POST", path: p, headers: SERVE, body: { nonce_c: "2".repeat(32) } });
    assert.equal(r.status, 409, p);
    assert.equal(JSON.parse(r.text).error, "already_paired");
  }
  const st = execFileSync(process.execPath, [CLI, "status"], { env: s.env, cwd: REPO }).toString();
  assert.match(st, /^paired/im);
  assert.match(st, new RegExp(identity.crowId));
  assert.match(st, /expires \d{4}-\d\d-\d\dT/);
  const again = await runToExit(CLI, s.env, { args: ["pair-code"] });
  assert.notEqual(again.code, 0);
  assert.match(again.err, /already paired/i);
  assert.doesNotMatch(again.out, /Pairing code/);
  await stop(child);

  // Paired boot: no code. Then a lost pin (a crash between the two writes, or a deleted file):
  // the cert alone is not a pairing, the agent comes up unpaired and prints a code.
  const paired = await startAgent(s.env);
  assert.match(paired.state.out, /^Paired; pairing routes are off$/m);
  assert.doesNotMatch(paired.state.out, /Pairing code/);
  await stop(paired.child);
  unlinkSync(join(s.sat, "pinned.json"));
  const lost = await startAgent(s.env);
  assert.match(lost.state.out, /^Pairing code: {3}\S+/m);
  const h = await request(lost.port, { method: "POST", path: "/satellite/v1/pair/hello", headers: SERVE, body: { nonce_c: "3".repeat(32) } });
  assert.equal(h.status, 200);
  const st2 = execFileSync(process.execPath, [CLI, "status"], { env: s.env, cwd: REPO }).toString();
  assert.match(st2, /^not paired/m);
  await stop(lost.child);
});
