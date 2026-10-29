// Satellite agent request auth, signed JSON responses, cert renewal/rotation, unpair, status and
// the scheduler (SAT-3, spec §3.2, §3.3, §5.1, §5.2, §6.3, §11.1, §14). The agent runs in-process
// on a real loopback socket with an injected clock; crow's real signed client (satelliteFetch)
// drives it through a fetchImpl that plays Tailscale Serve (tests/fixtures/serve-peer.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const CROW_HOME = mkdtempSync(join(tmpdir(), "satauth-crow-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satauth-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
actAsServe();

const P = await import("../servers/shared/satellite-protocol.js");
const { satelliteFetch } = await import("../servers/gateway/satellites/client.js");
const { issueCert } = await import("../servers/gateway/satellites/certs.js");
const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const S = await import("../servers/gateway/satellites/store.js");
const { createPairingService } = await import("../servers/gateway/satellites/pairing.js");
const { fakeIdentity } = await import("./helpers/fake-satellite.js");
const { startAgent } = await import("../servers/satellite/agent.js");
const { ensureSatelliteKey, writeCert, writePinned, stagedCertPath } = await import("../servers/satellite/keys.js");
const { openSatelliteDb } = await import("../servers/satellite/db.js");
const { createNonceGuard, createSendSigned, createRefusalCounter } = await import("../servers/satellite/auth.js");
const { applyNewCert, recoverStagedCert } = await import("../servers/satellite/certs.js");
const { readCert, readPinned } = await import("../servers/satellite/keys.js");
const { createScheduler, NONCE_KEEP_MS, AUDIT_KEEP_MS } = await import("../servers/satellite/scheduler.js");
const { parseMeminfo, parsePsiSomeAvg10, collectStatus, STATUS_MAX_BYTES } = await import("../servers/satellite/status.js");

const dirs = [CROW_HOME, process.env.CROW_DATA_DIR];
const agents = [];
after(async () => {
  for (const a of agents) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const HOST = "satellite.example.ts.net";
const DAY = 86400000;
const identity = fakeIdentity();
const PRIMARY_URL = "https://crow.example.ts.net:8444";

const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A cert from crow's real issuer for this satellite key. */
function cert(key, mgmtPub, { issuedAt = Date.now(), who = identity } = {}) {
  return issueCert({
    identity: who, instanceId: "inst-primary", primaryUrl: PRIMARY_URL,
    satellite_id: key.satellite_id, satellite_pubkey: key.ed25519_pub, mgmt_pubkey: mgmtPub, now: issuedAt,
  });
}
const pinnedFor = (c) => ({
  crow_id: c.payload.crow_id, root_pubkey: c.payload.root_pubkey, mgmt_pubkey: c.payload.mgmt_pubkey,
  primary_url: c.payload.primary_url, primary_instance_id: c.payload.primary_instance_id, target_sha: null,
});

/** A paired SAT_HOME (pinned.json then cert.json, as pairing writes them). */
function pairedHome({ issuedAt } = {}) {
  const home = tmp("satauth-home-");
  const key = ensureSatelliteKey(home);
  const mgmt = P.generateKeypair();
  const c = cert(key, mgmt.pubHex, { issuedAt });
  writePinned(home, pinnedFor(c));
  writeCert(home, c);
  return { home, key, mgmt, cert: c };
}

/** Start (or restart) the agent on `home`; the clock is the real one plus `clock.offset`. */
async function boot(home, clock = { offset: 0 }, opts = {}) {
  const lines = [];
  const warns = [];
  const a = await startAgent({
    env: { CROW_HOME: home, CROW_SATELLITE_PORT: "0" }, now: () => Date.now() + clock.offset, out: (l) => lines.push(l),
    authLog: (l) => warns.push(l), sha: "a".repeat(40), ...opts,
  });
  agents.push(a);
  return { a, lines, warns, clock };
}

/** Serve's hop: crow's https://<host>/path → the agent, with Serve's headers. */
const serveFetch = (port) => async (url, init = {}) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...init.headers, ...serveHeaders(null, "100.64.20.5") } });
};

const row = (a) => ({ id: a.satelliteId, tailnet_host: HOST, satellite_pubkey: a.key.ed25519_pub });
const sfetch = (a, mgmt, opts) => satelliteFetch(row(a), {
  caller: "owner-local", fetchImpl: serveFetch(a.port), mgmtKey: { ed25519_priv: mgmt.privHex }, ...opts,
});

/**
 * A raw signed call for tampering. `sign` overrides what is signed; `send` what goes on the wire.
 * Returns {status, json, sigOk} (sigOk: the response signature verifies over the request nonce).
 */
async function raw(a, mgmt, { method = "GET", path = "/satellite/v1/status", body = "", caller = "owner-local", ts, nonce, headers: h0, send = {}, serve = true } = {}) {
  const headers = h0 || P.signRequest(mgmt.privHex, { method, pathQuery: path, body, satelliteId: a.satelliteId, caller, ts, nonce });
  const sendBody = send.body ?? body;
  const r = await fetch(`http://127.0.0.1:${a.port}${send.path ?? path}`, {
    method, body: method === "GET" ? undefined : sendBody,
    headers: { ...(sendBody ? { "content-type": "application/json" } : {}), ...headers, ...(send.headers || {}), ...(serve ? serveHeaders(null, "100.64.20.5") : {}) },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch {}
  const sig = r.headers.get("x-crow-sat-resp-sig");
  const sigOk = !!sig && P.verifyResponse(a.key.ed25519_pub, { requestNonce: headers["X-Crow-Sat-Nonce"], status: r.status, bodySha256: P.sha256Hex(buf) }, sig);
  return { status: r.status, json, sigOk, headers, type: r.headers.get("content-type") };
}

const auditRows = (a) => a.db.prepare("SELECT ts, route, caller, result FROM audit ORDER BY id").all();

// ── the happy path, crow client ↔ agent ─────────────────────────────────────

test("crow's satelliteFetch: signed GET status verifies (response signature) and carries the status fields", async () => {
  const s = pairedHome();
  const { a } = await boot(s.home);
  const r = await sfetch(a, s.mgmt, { path: "/satellite/v1/status" });
  assert.equal(r.status, 200);
  const j = r.json;
  assert.equal(j.satellite_id, a.satelliteId);
  assert.equal(j.agent_protocol, P.AGENT_PROTOCOL);
  assert.equal(j.sha, "a".repeat(40));
  assert.deepEqual(j.cert, { serial: s.cert.payload.serial, expires_at: s.cert.payload.expires_at });
  assert.deepEqual(Object.keys(j.mem).sort(), ["MemAvailable", "MemTotal", "SwapFree", "SwapTotal"]);
  assert.ok(Number.isFinite(j.mem.MemTotal) && j.mem.MemTotal > 0);
  assert.ok(j.psi_memory_some_avg10 === null || Number.isFinite(j.psi_memory_some_avg10));
  assert.ok(Number.isFinite(j.disk_free_bytes) && j.disk_free_bytes > 0);
  assert.ok(Number.isFinite(j.uptime_s) && j.uptime_s >= 0);
  assert.deepEqual(j.installed, []);
  assert.ok(Buffer.byteLength(JSON.stringify(j)) <= 64 * 1024);
  const last = auditRows(a).at(-1);
  assert.deepEqual({ route: last.route, caller: last.caller, result: last.result }, { route: "status", caller: "owner-local", result: "ok" });
  assert.ok(!Number.isNaN(Date.parse(last.ts)));
});

test("not through Serve: a signed call is an empty 404", async () => {
  const s = pairedHome();
  const { a } = await boot(s.home);
  const r = await raw(a, s.mgmt, { serve: false });
  assert.equal(r.status, 404);
  assert.equal(r.json, null);
});

test("wrong mgmt key: 401 bad_signature as a signed answer; no audit row (counted and logged instead)", async () => {
  const s = pairedHome();
  const { a, warns } = await boot(s.home);
  const r = await sfetch(a, P.generateKeypair(), { path: "/satellite/v1/status" });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: "bad_signature" });
  assert.equal(auditRows(a).length, 0, "an unauthenticated refusal never reaches satellite.db");
  assert.ok(warns.some((l) => /refused unauthenticated requests: bad_signature=1/.test(l)), warns.join("\n"));
  // Within the minute, further refusals are only counted.
  for (let i = 0; i < 3; i++) await raw(a, P.generateKeypair());
  await raw(a, s.mgmt, { ts: "1" }); // clock_skew
  assert.equal(warns.length, 1);
  assert.equal(a.refusals.pending(), 4);
  assert.equal(auditRows(a).length, 0);
  // A verified call is audited.
  assert.equal((await raw(a, s.mgmt)).status, 200);
  assert.equal(auditRows(a).length, 1);
});

test("refusal counter: one summary line per minute", () => {
  let t = 0;
  const logs = [];
  const c = createRefusalCounter({ now: () => t, log: (l) => logs.push(l) });
  c.note("bad_signature");
  assert.equal(logs.length, 1);
  c.note("bad_signature"); c.note("not_paired");
  t = 59999;
  c.note("bad_signature");
  assert.equal(logs.length, 1);
  t = 60000;
  c.note("clock_skew");
  assert.equal(logs.length, 2);
  assert.match(logs[1], /bad_signature=2, not_paired=1, clock_skew=1/);
  assert.equal(c.pending(), 0);
  assert.equal(c.flush(), false);
});

test("a bad-signature request does not burn its nonce: a valid request with the same nonce then succeeds", async () => {
  const s = pairedHome();
  const { a } = await boot(s.home);
  const nonce = "ab".repeat(16);
  const bad = await raw(a, P.generateKeypair(), { nonce });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, "bad_signature");
  const good = await raw(a, s.mgmt, { nonce });
  assert.equal(good.status, 200);
  assert.equal((await raw(a, s.mgmt, { nonce })).json.error, "replay");
});

test("ts window: ±59 s accepted, ±61 s refused with clock_skew (agent clock injected)", async () => {
  const s = pairedHome();
  const clock = { offset: 0 };
  const { a } = await boot(s.home, clock);
  clock.offset = 7 * 60000; // the agent's clock runs 7 minutes ahead of ours
  const at = (d) => String(Date.now() + clock.offset + d);
  for (const d of [59000, -59000]) assert.equal((await raw(a, s.mgmt, { ts: at(d) })).status, 200, `ts ${d}`);
  for (const d of [61000, -61000]) {
    const r = await raw(a, s.mgmt, { ts: at(d) });
    assert.equal(r.status, 401, `ts ${d}`);
    assert.equal(r.json.error, "clock_skew");
    assert.ok(r.sigOk);
  }
});

test("replay: the same nonce twice is refused; after a restart (LRU gone) the nonces table still refuses it", async () => {
  const s = pairedHome();
  let { a } = await boot(s.home);
  const first = await raw(a, s.mgmt);
  assert.equal(first.status, 200);
  assert.ok(first.sigOk);
  const again = await raw(a, s.mgmt, { headers: first.headers });
  assert.equal(again.status, 401);
  assert.equal(again.json.error, "replay");
  // A different nonce with the same ts is fine.
  assert.equal((await raw(a, s.mgmt, { ts: first.headers["X-Crow-Sat-Ts"] })).status, 200);
  await a.close();
  ({ a } = await boot(s.home));
  const afterRestart = await raw(a, s.mgmt, { headers: first.headers });
  assert.equal(afterRestart.status, 401);
  assert.equal(afterRestart.json.error, "replay");
});

test("nonce guard: LRU eviction by size falls back to the nonces table", () => {
  const db = openSatelliteDb(tmp("satauth-nonce-"));
  let t = 1_000_000;
  const g = createNonceGuard({ db, now: () => t, max: 1 });
  const n1 = "1".repeat(32), n2 = "2".repeat(32);
  assert.equal(g.check(n1), true);
  assert.equal(g.check(n2), true); // evicts n1 from memory
  assert.equal(g.lruSize(), 1);
  assert.equal(g.check(n1), false, "the table remembers n1");
  t += 11 * 60000; // past the LRU's 10 minutes
  assert.equal(g.check(n2), false, "and n2 once the LRU entry ages out");
  db.close();
});

test("body tamper: signed bytes ≠ received bytes is bad_signature (raw bytes, not re-serialised JSON)", async () => {
  const s = pairedHome();
  const { a } = await boot(s.home);
  const body = JSON.stringify({ cert: s.cert });
  const spaced = JSON.stringify({ cert: s.cert }, null, 1); // same JSON value, different bytes
  const r = await raw(a, s.mgmt, { method: "POST", path: "/satellite/v1/cert", body, send: { body: spaced } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "bad_signature");
  const r2 = await raw(a, s.mgmt, { method: "POST", path: "/satellite/v1/unpair", body: "{}", send: { body: '{"x":1}' } });
  assert.equal(r2.json.error, "bad_signature");
  assert.equal(a.isPaired(), true);
});

test("caller tamper and path tamper: bad_signature", async () => {
  const s = pairedHome();
  const { a } = await boot(s.home);
  const c = await raw(a, s.mgmt, { send: { headers: { "X-Crow-Sat-Caller": "bot:evil" } } });
  assert.equal(c.status, 401);
  assert.equal(c.json.error, "bad_signature");
  const p = await raw(a, s.mgmt, { send: { path: "/satellite/v1/status?x=1" } });
  assert.equal(p.json.error, "bad_signature");
});

test("unpaired agent: a signed call is 403 not_paired", async () => {
  const home = tmp("satauth-unpaired-");
  const { a } = await boot(home);
  const r = await raw(a, P.generateKeypair());
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "not_paired");
  assert.ok(r.sigOk);
});

// ── grace and lapse (§14) ───────────────────────────────────────────────────

test("expired cert in the 30-day grace: status refused (cert_expired); cert renewal accepted, then status works", async () => {
  const s = pairedHome({ issuedAt: Date.now() - 95 * DAY }); // expired 5 days ago
  const { a } = await boot(s.home);
  assert.equal(a.isPaired(), true);
  const st = await sfetch(a, s.mgmt, { path: "/satellite/v1/status" });
  assert.equal(st.status, 403);
  assert.equal(st.json.error, "cert_expired");
  const fresh = cert(a.key, s.mgmt.pubHex);
  const r = await sfetch(a, s.mgmt, { method: "POST", path: "/satellite/v1/cert", body: { cert: fresh } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, serial: fresh.payload.serial, expires_at: fresh.payload.expires_at, rotated: false });
  assert.equal((await sfetch(a, s.mgmt, { path: "/satellite/v1/status" })).status, 200);
});

test("expired cert in the grace: unpair is accepted", async () => {
  const s = pairedHome({ issuedAt: Date.now() - 95 * DAY });
  const { a } = await boot(s.home);
  const r = await sfetch(a, s.mgmt, { method: "POST", path: "/satellite/v1/unpair", body: { reason: "test" } });
  assert.equal(r.status, 200);
  assert.equal(a.isPaired(), false);
});

test("lapsed after the grace: status, cert and unpair are all refused with cert_expired", async () => {
  const s = pairedHome({ issuedAt: Date.now() - 121 * DAY }); // expired 31 days ago
  const { a } = await boot(s.home);
  assert.equal(a.isPaired(), false);
  for (const [method, path, body] of [["GET", "/satellite/v1/status"], ["POST", "/satellite/v1/cert", { cert: cert(a.key, s.mgmt.pubHex) }], ["POST", "/satellite/v1/unpair", {}]]) {
    const r = await sfetch(a, s.mgmt, { method, path, body });
    assert.equal(r.status, 403, path);
    assert.equal(r.json.error, "cert_expired", path);
  }
  assert.ok(existsSync(join(s.home, "cert.json")), "a lapsed cert is left for --repair");
});

// ── renewal and rotation (§3.2) ─────────────────────────────────────────────

test("renewal: newer cert accepted (serial recorded); older issued_at, a reused serial, another crow or satellite refused", async () => {
  const s = pairedHome({ issuedAt: Date.now() - 20 * DAY });
  const { a } = await boot(s.home);
  const post = (c) => sfetch(a, s.mgmt, { method: "POST", path: "/satellite/v1/cert", body: { cert: c } });

  const older = cert(a.key, s.mgmt.pubHex, { issuedAt: Date.now() - 30 * DAY });
  assert.deepEqual((await post(older)).json, { error: "not_newer" });
  const otherCrow = cert(a.key, s.mgmt.pubHex, { who: fakeIdentity() });
  assert.deepEqual((await post(otherCrow)).json, { error: "wrong_crow" });
  const otherSat = ensureSatelliteKey(tmp("satauth-other-"));
  assert.deepEqual((await post(cert(otherSat, s.mgmt.pubHex))).json, { error: "wrong_satellite" });
  const forged = { ...cert(a.key, s.mgmt.pubHex), sig: "0".repeat(128) };
  assert.deepEqual((await post(forged)).json, { error: "bad_signature" });
  assert.deepEqual((await sfetch(a, s.mgmt, { method: "POST", path: "/satellite/v1/cert", body: { nope: 1 } })).json, { error: "bad_request" });

  const fresh = cert(a.key, s.mgmt.pubHex);
  const ok = await post(fresh);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.rotated, false);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, "cert.json"), "utf8")), fresh);
  assert.ok(a.db.prepare("SELECT 1 FROM cert_serials WHERE serial = ?").get(fresh.payload.serial));
  // The same serial again, even re-signed later, is refused.
  const reuse = issueCert({ identity, instanceId: "inst-primary", primaryUrl: PRIMARY_URL, satellite_id: a.key.satellite_id, satellite_pubkey: a.key.ed25519_pub, mgmt_pubkey: s.mgmt.pubHex, now: Date.now() + 1000 });
  const P2 = { ...reuse.payload, serial: fresh.payload.serial };
  const { signCert } = P;
  const reused = signCert(identity.ed25519Priv.toString("hex"), P2);
  assert.deepEqual((await post(reused)).json, { error: "serial_reused" });
  assert.ok(!existsSync(stagedCertPath(s.home)), "no staged cert left behind");
});

test("rotation: a cert with a new mgmt key, signed request-wise by the CURRENT key; then the old key is refused", async () => {
  const s = pairedHome({ issuedAt: Date.now() - 20 * DAY });
  const { a } = await boot(s.home);
  const next = P.generateKeypair();
  const rotated = cert(a.key, next.pubHex);

  // Signed by the new key before the cert is stored: refused.
  const early = await sfetch(a, next, { method: "POST", path: "/satellite/v1/cert", body: { cert: rotated } });
  assert.equal(early.status, 401);
  assert.equal(early.json.error, "bad_signature");

  const r = await sfetch(a, s.mgmt, { method: "POST", path: "/satellite/v1/cert", body: { cert: rotated } });
  assert.equal(r.status, 200);
  assert.equal(r.json.rotated, true);
  const pinned = JSON.parse(readFileSync(join(s.home, "pinned.json"), "utf8"));
  assert.equal(pinned.mgmt_pubkey, next.pubHex);
  assert.equal(pinned.crow_id, identity.crowId);

  const old = await sfetch(a, s.mgmt, { path: "/satellite/v1/status" });
  assert.equal(old.status, 401);
  assert.equal(old.json.error, "bad_signature");
  assert.equal((await sfetch(a, next, { path: "/satellite/v1/status" })).status, 200);
  // And after a restart, too.
  await a.close();
  const { a: b } = await boot(s.home);
  assert.equal((await sfetch(b, s.mgmt, { path: "/satellite/v1/status" })).status, 401);
  assert.equal((await sfetch(b, next, { path: "/satellite/v1/status" })).status, 200);
});

test("crash window of a rotation: pinned.json written, cert.json not yet — the staged cert rolls forward at boot", async () => {
  const s = pairedHome({ issuedAt: Date.now() - 20 * DAY });
  const next = P.generateKeypair();
  const key = ensureSatelliteKey(s.home);
  const rotated = cert(key, next.pubHex);
  // What the cert route had done when the process died: staged cert, new pin, old cert.json.
  writeFileSync(stagedCertPath(s.home), JSON.stringify(rotated), { mode: 0o600 });
  writePinned(s.home, pinnedFor(rotated));
  const { a } = await boot(s.home);
  assert.equal(a.isPaired(), true);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, "cert.json"), "utf8")), rotated);
  assert.ok(!existsSync(stagedCertPath(s.home)));
  assert.ok(a.db.prepare("SELECT 1 FROM cert_serials WHERE serial = ?").get(rotated.payload.serial));
  assert.equal((await sfetch(a, s.mgmt, { path: "/satellite/v1/status" })).status, 401);
  assert.equal((await sfetch(a, next, { path: "/satellite/v1/status" })).status, 200);
});

test("crash window before the pin: a staged cert whose pin was never written is discarded; the old pairing stays", async () => {
  const s = pairedHome({ issuedAt: Date.now() - 20 * DAY });
  const key = ensureSatelliteKey(s.home);
  writeFileSync(stagedCertPath(s.home), JSON.stringify(cert(key, P.generateKeypair().pubHex)), { mode: 0o600 });
  const { a } = await boot(s.home);
  assert.equal(a.isPaired(), true);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, "cert.json"), "utf8")), s.cert);
  assert.ok(!existsSync(stagedCertPath(s.home)));
  assert.equal((await sfetch(a, s.mgmt, { path: "/satellite/v1/status" })).status, 200);
});

test("a failed commit: cert.json still old → old pin restored, staged removed; cert.json already new → new pin and staged kept", () => {
  for (const failAfterCert of [false, true]) {
    const s = pairedHome({ issuedAt: Date.now() - 20 * DAY });
    const db = openSatelliteDb(s.home);
    const state = { cert: readCert(s.home), pinned: readPinned(s.home) };
    const next = P.generateKeypair();
    const rotated = cert(s.key, next.pubHex);
    const io = {
      writeStagedCert: (h, c) => writeFileSync(stagedCertPath(h), JSON.stringify(c), { mode: 0o600 }),
      writePinned,
      writeCert: (h, c) => { if (failAfterCert) writeCert(h, c); throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
    };
    assert.throws(() => applyNewCert({ db, key: s.key, satHome: s.home, state, now: Date.now, io }, rotated), /disk full/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cert_serials WHERE serial = ?").get(rotated.payload.serial).n, 0, "serial rolled back");
    if (!failAfterCert) {
      assert.deepEqual(readCert(s.home), s.cert);
      assert.equal(readPinned(s.home).mgmt_pubkey, s.mgmt.pubHex, "old pin restored");
      assert.ok(!existsSync(stagedCertPath(s.home)));
    } else {
      assert.deepEqual(readCert(s.home), rotated);
      assert.equal(readPinned(s.home).mgmt_pubkey, next.pubHex, "new pin kept: it matches cert.json");
      assert.ok(existsSync(stagedCertPath(s.home)), "staged left for boot");
      assert.equal(recoverStagedCert({ db, key: s.key, satHome: s.home }), "discarded", "cert.json already holds it");
      assert.ok(!existsSync(stagedCertPath(s.home)));
      assert.deepEqual(readCert(s.home), rotated);
    }
    db.close();
  }
});

// ── unpair (§3.3) ───────────────────────────────────────────────────────────

test("unpair: cert + pin gone, vault/bundles/installed.json kept, back to unpaired mode with a fresh code", async () => {
  const s = pairedHome();
  mkdirSync(join(s.home, "vault", "x"), { recursive: true });
  writeFileSync(join(s.home, "vault", "x", "obj"), "keep");
  writeFileSync(join(s.home, "installed.json"), JSON.stringify([{ id: "gitea", version: "1.0.0" }]));
  const { a, lines } = await boot(s.home);
  const st = await sfetch(a, s.mgmt, { path: "/satellite/v1/status" });
  assert.deepEqual(st.json.installed, [{ id: "gitea", version: "1.0.0" }]);
  const before = a.db.prepare("SELECT COUNT(*) AS n FROM pair_codes WHERE used_at IS NULL AND voided_at IS NULL").get().n;
  assert.equal(before, 0);

  const r = await sfetch(a, s.mgmt, { method: "POST", path: "/satellite/v1/unpair", body: { reason: "owner" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.ok(!existsSync(join(s.home, "cert.json")));
  assert.ok(!existsSync(join(s.home, "pinned.json")));
  assert.equal(readFileSync(join(s.home, "vault", "x", "obj"), "utf8"), "keep");
  assert.ok(existsSync(join(s.home, "installed.json")));
  assert.ok(existsSync(join(s.home, "secrets", "satellite-key.json")));
  assert.equal(a.isPaired(), false);
  assert.ok(lines.some((l) => /^Pairing code:\s+[0-9A-Z]{4}(-[0-9A-Z]{4}){5}/.test(l)), lines.join("\n"));
  assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM pair_codes WHERE used_at IS NULL AND voided_at IS NULL").get().n, 1);
  assert.equal(auditRows(a).at(-1).route, "unpair");

  assert.equal((await sfetch(a, s.mgmt, { path: "/satellite/v1/status" })).json.error, "not_paired");
  const h = await fetch(`http://127.0.0.1:${a.port}/satellite/v1/pair/hello`, {
    method: "POST", headers: { "content-type": "application/json", ...serveHeaders(null, "100.64.20.5") }, body: JSON.stringify({ nonce_c: "c".repeat(32) }),
  });
  assert.equal(h.status, 200, "pairing routes are back on");
});

test("full loop: crow pairs with its real client, signed status over satelliteFetch, crow's unpair reaches the agent", async () => {
  const home = tmp("satauth-loop-");
  const { a } = await boot(home);
  const { code } = a.issuePairCode();
  const dir = tmp("satauth-crowdb-");
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(SATELLITE_DDL);
  const svc = createPairingService({
    fetchImpl: serveFetch(a.port),
    whoisImpl: async () => ({ node: "satellite", tags: ["tag:vps"] }),
    identityFn: () => identity,
    instanceIdFn: () => "inst-primary",
    primaryUrlFn: async () => PRIMARY_URL,
    targetShaFn: () => "c".repeat(40),
  });
  const start = await svc.startPairing({ host: HOST });
  const done = await svc.completePairing({ db, pairing_id: start.pairing_id, code, name: "vps" });
  const satRow = await S.getSatellite(db, done.satellite_id);
  const st = await satelliteFetch(satRow, { path: "/satellite/v1/status", caller: "owner-remote", fetchImpl: serveFetch(a.port) });
  assert.equal(st.status, 200);
  assert.equal(st.json.satellite_id, a.satelliteId);
  assert.equal(auditRows(a).at(-1).caller, "owner-remote");
  const un = await svc.unpairSatellite({ db, id: done.satellite_id, reason: "test" });
  assert.equal(un.reached, true);
  assert.equal(a.isPaired(), false);
});

// ── sendSigned ──────────────────────────────────────────────────────────────

test("sendSigned: application/json, signature over the exact bytes sent; no nonce → unsigned", () => {
  const kp = P.generateKeypair();
  const sendSigned = createSendSigned(kp.privHex);
  const mk = (nonce) => {
    const res = { locals: nonce ? { satRespNonce: nonce } : {}, headers: {}, statusCode: 0, body: null };
    res.status = (s) => { res.statusCode = s; return res; };
    res.set = (h) => { Object.assign(res.headers, h); return res; };
    res.send = (b) => { res.body = b; return res; };
    return res;
  };
  const n = "f".repeat(32);
  const res = mk(n);
  sendSigned(res, 201, { a: "é" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.ok(Buffer.isBuffer(res.body));
  assert.ok(P.verifyResponse(kp.pubHex, { requestNonce: n, status: 201, bodySha256: P.sha256Hex(res.body) }, res.headers["X-Crow-Sat-Resp-Sig"]));
  const bare = mk(null);
  sendSigned(bare, 400, { error: "x" });
  assert.equal(bare.headers["X-Crow-Sat-Resp-Sig"], undefined);
});

// ── status readers ──────────────────────────────────────────────────────────

test("status readers: meminfo kB → bytes, PSI some avg10, fixed cap", () => {
  const mi = "MemTotal:        1000 kB\nMemFree: 1 kB\nMemAvailable:     500 kB\nSwapTotal:  0 kB\nSwapFree: 0 kB\n";
  assert.deepEqual(parseMeminfo(mi), { MemTotal: 1024000, MemAvailable: 512000, SwapTotal: 0, SwapFree: 0 });
  assert.deepEqual(parseMeminfo(""), { MemTotal: null, MemAvailable: null, SwapTotal: null, SwapFree: null });
  assert.equal(parsePsiSomeAvg10("some avg10=12.50 avg60=0.04 avg300=0.05 total=9\nfull avg10=1.00 avg60=0 avg300=0 total=1\n"), 12.5);
  assert.equal(parsePsiSomeAvg10(null), null);
  assert.equal(STATUS_MAX_BYTES, 64 * 1024);
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: `bundle-${i}`, version: "1.0.0" }));
  const st = collectStatus({
    satelliteId: "sat_aaaaaaaaaaaaaaaaaaaa", sha: null, cert: null, installed: many,
    readText: () => null, statfs: () => { throw new Error("nope"); }, uptime: () => 5,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(st)) <= STATUS_MAX_BYTES);
  assert.equal(st.installed_truncated, true);
  assert.equal(st.disk_free_bytes, null);
  assert.equal(st.cert, null);
});

// ── scheduler ───────────────────────────────────────────────────────────────

test("scheduler: hourly GC of nonces and pair_nonces (> 24 h) and audit (> 90 d); daily cert log; timers unref'd", () => {
  const home = tmp("satauth-sched-");
  const db = openSatelliteDb(home);
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  let t = t0;
  db.prepare("INSERT INTO nonces (nonce, seen_at) VALUES (?, ?), (?, ?)").run("o".repeat(32), t0 - NONCE_KEEP_MS - 1, "n".repeat(32), t0 - 1000);
  db.prepare("INSERT INTO pair_nonces (nonce_s, nonce_c, issued_at, source) VALUES (?, 'c', ?, 's'), (?, 'c', ?, 's')").run("o", t0 - NONCE_KEEP_MS - 1, "n", t0 - 1000);
  const iso = (ms) => new Date(ms).toISOString();
  db.prepare("INSERT INTO audit (ts, route, caller, result) VALUES (?, 'status', null, 'ok'), (?, 'status', null, 'ok')").run(iso(t0 - AUDIT_KEEP_MS - 1), iso(t0 - DAY));
  const logs = [];
  const expires = t0 + 10 * DAY + 3600000;
  const timers = [];
  const sched = createScheduler({
    db, now: () => t, log: (l) => logs.push(l),
    getCert: () => ({ payload: { expires_at: iso(expires) } }),
    setIntervalImpl: (fn, ms) => { const h = { fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } }; timers.push(h); return h; },
    clearIntervalImpl: (h) => { h.cleared = true; },
  });
  sched.runHourly();
  assert.deepEqual(db.prepare("SELECT nonce FROM nonces").all().map((r) => r.nonce), ["n".repeat(32)]);
  assert.deepEqual(db.prepare("SELECT nonce_s FROM pair_nonces").all().map((r) => r.nonce_s), ["n"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit").get().n, 1);

  sched.runDaily();
  assert.ok(logs.some((l) => /cert expires in 10 days/.test(l)), logs.join("\n"));
  t = expires + DAY;
  sched.runDaily();
  assert.ok(logs.some((l) => /cert expired.*grace/.test(l)), logs.join("\n"));
  const quiet = createScheduler({ db, now: () => t, log: (l) => logs.push(l), getCert: () => null, setIntervalImpl: () => ({ unref() {} }) });
  const n = logs.length;
  quiet.runDaily();
  assert.ok(logs.slice(n).some((l) => /not paired/.test(l)));

  sched.start();
  assert.deepEqual(timers.map((h) => h.ms).sort((x, y) => x - y), [3600000, DAY]);
  assert.ok(timers.every((h) => h.unrefd));
  sched.stop();
  assert.ok(timers.every((h) => h.cleared));
  db.close();
});

test("the running agent starts its scheduler unref'd and stops it on close", async () => {
  const s = pairedHome();
  const { a } = await boot(s.home);
  assert.ok(a.scheduler, "agent exposes its scheduler");
  assert.equal(a.scheduler.running(), true);
  await a.close();
  assert.equal(a.scheduler.running(), false);
});
