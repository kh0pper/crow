// Satellite agent pairing, satellite side (SAT-3, spec §4.1 step 6, §4.2 steps 1, 3, 4, rate
// limits). The agent runs in-process on a real loopback socket with an injected clock; crow's
// real pairing client (servers/gateway/satellites/pairing.js) drives it through a fetchImpl that
// plays Tailscale Serve (the peer-uid seam from tests/fixtures/serve-peer.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const CROW_HOME = mkdtempSync(join(tmpdir(), "satagent-crow-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satagent-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
actAsServe();

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const P = await import("../servers/shared/satellite-protocol.js");
const S = await import("../servers/gateway/satellites/store.js");
const { createPairingService } = await import("../servers/gateway/satellites/pairing.js");
const { fakeIdentity } = await import("./helpers/fake-satellite.js");
const { startAgent } = await import("../servers/satellite/agent.js");
const { openSatelliteDb, SAT_SCHEMA_VERSION } = await import("../servers/satellite/db.js");
const { issuePairCode } = await import("../servers/satellite/pairing.js");

const dirs = [CROW_HOME, process.env.CROW_DATA_DIR];
const agents = [];
after(async () => {
  for (const a of agents) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const HOST = "satellite.example.ts.net";
const identity = fakeIdentity();

/** A fresh agent with its own SAT_HOME and a clock the test moves. */
async function agent() {
  const home = mkdtempSync(join(tmpdir(), "satagent-home-"));
  dirs.push(home);
  const clock = { t: Date.now() }; // crow signs certs on the real clock
  const lines = [];
  const a = await startAgent({ env: { CROW_HOME: home, CROW_SATELLITE_PORT: "0" }, now: () => clock.t, out: (l) => lines.push(l) });
  agents.push(a);
  return { a, home, clock, lines };
}

/** Serve's hop: crow's https://<host>/path → the agent, with Serve's headers for `client`. */
const serveFetch = (port, client = "100.64.20.5", spy) => async (url, init = {}) => {
  const u = new URL(url);
  if (spy) spy.push({ path: u.pathname, body: init.body });
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...init.headers, ...serveHeaders(null, client) } });
};

async function crowDb() {
  const dir = mkdtempSync(join(tmpdir(), "satagent-db-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(SATELLITE_DDL);
  return db;
}

function crow(port, spy) {
  return createPairingService({
    fetchImpl: serveFetch(port, "100.64.20.5", spy),
    whoisImpl: async () => ({ node: "satellite", tags: ["tag:vps"] }),
    identityFn: () => identity,
    instanceIdFn: () => "inst-primary",
    primaryUrlFn: async () => "https://crow.example.ts.net:8444",
    targetShaFn: () => "c".repeat(40),
  });
}

async function post(port, path, body, client = "100.64.20.5", headers = serveHeaders(null, client)) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, type: r.headers.get("content-type") };
}

const nc = () => randomBytes(16).toString("hex");
const refusedWith = (detail) => (e) => e.code === "pairing_refused" && e.detail === detail;

// ── pairMacKey (the value the satellite stores) agrees with pairMac ─────────

test("pairMacWithKey(pairMacKey(code)) === pairMac(code)", () => {
  const { normalized } = P.generatePairCode();
  const args = { nonceC: nc(), nonceS: nc(), certSha256: "d".repeat(64), satelliteId: P.satelliteIdFromPub(P.generateKeypair().pubHex) };
  assert.equal(P.pairMacWithKey(P.pairMacKey(normalized), args), P.pairMac(normalized, args));
  assert.throws(() => P.pairMacKey("not-a-code"), TypeError);
  assert.throws(() => P.pairMacWithKey("zz", args), TypeError);
});

// ── db ──────────────────────────────────────────────────────────────────────

test("satellite.db: every table, schema version in meta, reopen is idempotent", async () => {
  const home = mkdtempSync(join(tmpdir(), "satagent-dbonly-"));
  dirs.push(home);
  const db = openSatelliteDb(home);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
  assert.deepEqual(tables, ["audit", "cert_serials", "crow_keychain", "jobs", "meta", "nonces", "pair_codes", "pair_nonces", "pair_tries", "tool_cache"]);
  assert.equal(SAT_SCHEMA_VERSION, 1);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='sat_schema_version'").get().value, "1");
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.deepEqual(cols("pair_codes"), ["code_hash", "created_at", "expires_at", "used_at", "wrong_tries", "voided_at"]);
  assert.deepEqual(cols("pair_nonces"), ["nonce_s", "nonce_c", "issued_at", "used_at", "source"]);
  assert.deepEqual(cols("nonces"), ["nonce", "seen_at"]);
  db.close();
  const again = openSatelliteDb(home);
  assert.equal(again.prepare("SELECT COUNT(*) AS n FROM meta").get().n, 1);
  again.close();
});

// ── happy path ──────────────────────────────────────────────────────────────

test("happy path: crow's client pairs; cert + pinned written; code and nonce used; then 409", async () => {
  const { a, home, lines } = await agent();
  const { code } = a.issuePairCode();
  const db = await crowDb();
  const svc = crow(a.port);
  const start = await svc.startPairing({ host: HOST });
  assert.equal(start.satellite_id, a.satelliteId);
  const done = await svc.completePairing({ db, pairing_id: start.pairing_id, code, name: "vps" });
  const row = await S.getSatellite(db, done.satellite_id);
  assert.equal(row.status, "active");

  const cert = JSON.parse(readFileSync(join(home, "cert.json"), "utf8"));
  assert.deepEqual(cert, JSON.parse(row.cert_json));
  const pinned = JSON.parse(readFileSync(join(home, "pinned.json"), "utf8"));
  assert.deepEqual(Object.keys(pinned).sort(), ["crow_id", "mgmt_pubkey", "primary_instance_id", "primary_url", "root_pubkey", "target_sha"]);
  assert.equal(pinned.mgmt_pubkey, row.mgmt_pubkey);
  assert.ok(lines.includes(`Paired with ${identity.crowId}`), lines.join("\n"));

  const sdb = a.db;
  const pc = sdb.prepare("SELECT * FROM pair_codes").all();
  assert.equal(pc.length, 1);
  assert.ok(pc[0].used_at);
  assert.notEqual(pc[0].code_hash, P.normalizePairCode(code));
  assert.equal(sdb.prepare("SELECT COUNT(*) AS n FROM pair_nonces WHERE used_at IS NOT NULL").get().n, 1);
  assert.equal(sdb.prepare("SELECT serial FROM cert_serials").get().serial, cert.payload.serial);
  assert.equal(a.isPaired(), true);

  const h = await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() });
  assert.equal(h.status, 409);
  assert.equal(h.json.error, "already_paired");
  const c = await post(a.port, "/satellite/v1/pair/complete", {});
  assert.equal(c.status, 409);
  await assert.rejects(svc.startPairing({ host: HOST }), refusedWith("already_paired"));
});

// ── wrong MACs ──────────────────────────────────────────────────────────────

/** A raw attacker's attempt from `client`: its own hello, then a complete with a random MAC. */
async function wrongTry(port, client) {
  const h = await post(port, "/satellite/v1/pair/hello", { nonce_c: nc() }, client);
  assert.equal(h.status, 200, h.text);
  const payload = { crow_id: "crow:attacker00", root_pubkey: "e".repeat(64), primary_instance_id: "i", primary_url: "https://x.example.ts.net" };
  return post(port, "/satellite/v1/pair/complete", {
    cert: { payload, sig: "" }, ...payload, target_sha: null, protocol: P.AGENT_PROTOCOL, nonce_s: h.json.nonce_s,
    mac: randomBytes(32).toString("hex"),
  }, client);
}

test("one source: capped after 5 wrong MACs (too_many_tries), the code survives for the owner", async () => {
  const { a } = await agent();
  const { code } = a.issuePairCode();
  const db = await crowDb();
  // crow itself (100.64.20.5) types the wrong code 5 times.
  for (let i = 0; i < 5; i++) {
    const svc = crow(a.port);
    const s = await svc.startPairing({ host: HOST });
    await assert.rejects(svc.completePairing({ db, pairing_id: s.pairing_id, code: P.generatePairCode().code, name: "vps" }), refusedWith("bad_mac"));
  }
  let svc = crow(a.port);
  let s = await svc.startPairing({ host: HOST });
  await assert.rejects(svc.completePairing({ db, pairing_id: s.pairing_id, code, name: "vps" }), refusedWith("too_many_tries"));
  const row = a.db.prepare("SELECT wrong_tries, voided_at FROM pair_codes").get();
  assert.equal(row.wrong_tries, 5);
  assert.equal(row.voided_at, null, "one source cannot void the code");
  assert.equal(a.isPaired(), false);
  // A fresh code resets the per-source count.
  const fresh = a.issuePairCode().code;
  svc = crow(a.port);
  s = await svc.startPairing({ host: HOST });
  await svc.completePairing({ db, pairing_id: s.pairing_id, code: fresh, name: "vps" });
  assert.equal(a.isPaired(), true);
});

test("a second source spamming wrong MACs does not stop the owner's source pairing", async () => {
  const { a } = await agent();
  const { code } = a.issuePairCode();
  for (let i = 0; i < 5; i++) assert.equal((await wrongTry(a.port, "100.64.20.66")).json.error, "bad_mac");
  assert.equal((await wrongTry(a.port, "100.64.20.66")).json.error, "too_many_tries");
  const svc = crow(a.port);
  const s = await svc.startPairing({ host: HOST });
  await svc.completePairing({ db: await crowDb(), pairing_id: s.pairing_id, code, name: "vps" });
  assert.equal(a.isPaired(), true);
});

test("a nonce_s is redeemable only by the source it was issued to (and is left untouched)", async () => {
  const { a } = await agent();
  a.issuePairCode();
  const h = await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, "100.64.20.5");
  const payload = { crow_id: "crow:x", root_pubkey: "e".repeat(64), primary_instance_id: "i", primary_url: "https://x.example.ts.net" };
  const body = { cert: { payload, sig: "" }, ...payload, protocol: P.AGENT_PROTOCOL, nonce_s: h.json.nonce_s, mac: "a".repeat(64) };
  const stolen = await post(a.port, "/satellite/v1/pair/complete", body, "100.64.20.66");
  assert.equal(stolen.status, 403);
  assert.equal(stolen.json.error, "wrong_source");
  const row = a.db.prepare("SELECT used_at FROM pair_nonces WHERE nonce_s = ?").get(h.json.nonce_s);
  assert.equal(row.used_at, null);
  assert.equal(a.db.prepare("SELECT wrong_tries FROM pair_codes").get().wrong_tries, 0);
});

test("the code is voided by wrong MACs from 3 distinct sources", async () => {
  const { a } = await agent();
  const { code } = a.issuePairCode();
  assert.equal((await wrongTry(a.port, "100.64.20.61")).json.error, "bad_mac");
  assert.equal((await wrongTry(a.port, "100.64.20.62")).json.error, "bad_mac");
  assert.equal(a.db.prepare("SELECT voided_at FROM pair_codes").get().voided_at, null);
  assert.equal((await wrongTry(a.port, "100.64.20.63")).json.error, "bad_mac");
  assert.ok(a.db.prepare("SELECT voided_at FROM pair_codes").get().voided_at);
  const svc = crow(a.port);
  const s = await svc.startPairing({ host: HOST });
  await assert.rejects(svc.completePairing({ db: await crowDb(), pairing_id: s.pairing_id, code, name: "vps" }), refusedWith("no_live_code"));
});

test("the code is voided at 25 wrong MACs in all (global threshold)", async () => {
  const { a } = await agent();
  a.issuePairCode();
  // Two sources can reach at most 10; the 25 cap is checked directly against the stored total.
  a.db.prepare("UPDATE pair_codes SET wrong_tries = 24").run();
  assert.equal((await wrongTry(a.port, "100.64.20.61")).json.error, "bad_mac");
  const row = a.db.prepare("SELECT wrong_tries, voided_at FROM pair_codes").get();
  assert.equal(row.wrong_tries, 25);
  assert.ok(row.voided_at);
});

test("/pair/complete: 10/min per source; another source unaffected; the window slides", async () => {
  const { a, clock } = await agent();
  for (let i = 0; i < 10; i++) assert.equal((await post(a.port, "/satellite/v1/pair/complete", {}, "100.64.20.70")).status, 400, `complete ${i}`);
  const r = await post(a.port, "/satellite/v1/pair/complete", {}, "100.64.20.70");
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "rate_limited");
  assert.equal((await post(a.port, "/satellite/v1/pair/complete", {}, "100.64.20.71")).status, 400);
  clock.t += 60001;
  assert.equal((await post(a.port, "/satellite/v1/pair/complete", {}, "100.64.20.70")).status, 400);
});

test("pairing is Serve-only: a Serve shape from a non-Serve uid, or a public-proxy shape, gets 404", async () => {
  const { a } = await agent();
  a.issuePairCode();
  // Public Caddy in front: XFF names a public client (the socket uid is caddy's, not tailscaled's).
  const caddy = await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, null,
    { "x-forwarded-for": "198.51.100.7", "x-forwarded-host": "satellite.example.com", "x-forwarded-proto": "https", "x-real-ip": "198.51.100.7" });
  assert.equal(caddy.status, 404);
  assert.equal(caddy.text, "");
  // A perfect Serve shape from a socket whose uid is not a Serve uid.
  const prev = process.env.CROW_SERVE_PEER_UIDS;
  process.env.CROW_SERVE_PEER_UIDS = "65534";
  try {
    for (const p of ["/satellite/v1/pair/hello", "/satellite/v1/pair/complete"]) {
      const r = await post(a.port, p, { nonce_c: nc() });
      assert.equal(r.status, 404, p);
      assert.equal(r.text, "", p);
    }
  } finally {
    process.env.CROW_SERVE_PEER_UIDS = prev;
  }
  assert.equal((await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() })).status, 200);
});

test("cert.json without a matching pinned.json is not paired", async () => {
  const { a } = await agent();
  const { code } = a.issuePairCode();
  const svc = crow(a.port);
  const s = await svc.startPairing({ host: HOST });
  await svc.completePairing({ db: await crowDb(), pairing_id: s.pairing_id, code, name: "vps" });
  const { certIsLive } = await import("../servers/satellite/pairing.js");
  const cert = JSON.parse(readFileSync(join(a.home, "cert.json"), "utf8"));
  const pinned = JSON.parse(readFileSync(join(a.home, "pinned.json"), "utf8"));
  assert.equal(certIsLive(cert, pinned, a.key.ed25519_pub, clockNow()), true);
  assert.equal(certIsLive(cert, null, a.key.ed25519_pub, clockNow()), false);
  for (const k of ["crow_id", "root_pubkey", "mgmt_pubkey"]) {
    assert.equal(certIsLive(cert, { ...pinned, [k]: "other" }, a.key.ed25519_pub, clockNow()), false, k);
  }
});
const clockNow = () => Date.now();

test("an expired code (15 min) is refused", async () => {
  const { a, clock } = await agent();
  const { code } = a.issuePairCode();
  clock.t += P.PAIR_CODE_TTL_MS + 1;
  const svc = crow(a.port);
  const s = await svc.startPairing({ host: HOST });
  await assert.rejects(svc.completePairing({ db: await crowDb(), pairing_id: s.pairing_id, code, name: "vps" }), refusedWith("no_live_code"));
});

// ── nonces ──────────────────────────────────────────────────────────────────

test("a nonce_s older than 5 min is refused", async () => {
  const { a, clock } = await agent();
  const { code } = a.issuePairCode();
  const svc = crow(a.port);
  const s = await svc.startPairing({ host: HOST });
  clock.t += P.PAIR_NONCE_TTL_MS + 1;
  await assert.rejects(svc.completePairing({ db: await crowDb(), pairing_id: s.pairing_id, code, name: "vps" }), refusedWith("nonce_expired"));
  assert.equal(a.isPaired(), false);
});

test("a nonce_s is single use (replayed complete → nonce_used); an unknown one → bad_nonce", async () => {
  const { a } = await agent();
  const { code } = a.issuePairCode();
  const spy = [];
  const svc = crow(a.port, spy);
  const s = await svc.startPairing({ host: HOST });
  // A wrong code makes crow send one complete; the agent spends the nonce on it.
  await assert.rejects(svc.completePairing({ db: await crowDb(), pairing_id: s.pairing_id, code: P.generatePairCode().code, name: "vps" }), refusedWith("bad_mac"));
  const sent = spy.find((r) => r.path === "/satellite/v1/pair/complete").body;
  const replay = await post(a.port, "/satellite/v1/pair/complete", sent);
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error, "nonce_used");
  const unknown = await post(a.port, "/satellite/v1/pair/complete", { ...JSON.parse(sent), nonce_s: nc() });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, "bad_nonce");
  // The code itself is still live: a fresh hello pairs with it.
  const svc2 = crow(a.port);
  const s3 = await svc2.startPairing({ host: HOST });
  await svc2.completePairing({ db: await crowDb(), pairing_id: s3.pairing_id, code, name: "vps" });
  assert.equal(a.isPaired(), true);
});

test("malformed bodies are refused with JSON errors, never a crash", async () => {
  const { a } = await agent();
  a.issuePairCode();
  for (const body of [{}, { nonce_c: "XYZ" }, { nonce_c: "a".repeat(31) }, { nonce_c: 5 }]) {
    const r = await post(a.port, "/satellite/v1/pair/hello", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, "bad_request");
  }
  const bad = await post(a.port, "/satellite/v1/pair/hello", "{not json");
  assert.equal(bad.status, 400);
  assert.match(bad.type, /application\/json/);
  for (const body of [{}, { nonce_s: nc(), mac: "a".repeat(64) }, { nonce_s: nc(), mac: "a".repeat(64), cert: "x" },
    { nonce_s: nc(), mac: "zz", cert: { payload: {}, sig: "" } }]) {
    const r = await post(a.port, "/satellite/v1/pair/complete", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, /^[a-z_]+$/);
  }
});

// ── network class ───────────────────────────────────────────────────────────

test("non-Serve peers: pairing routes are 404 with an empty body; /health answers", async () => {
  const { a } = await agent();
  const plain = await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, null, {});
  assert.equal(plain.status, 404);
  assert.equal(plain.text, "");
  // A Serve shape naming a non-overlay address is not Serve.
  const forged = await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, null, { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": HOST });
  assert.equal(forged.status, 404);
  assert.equal(forged.text, "");
  const h = await fetch(`http://127.0.0.1:${a.port}/health`);
  assert.equal(h.status, 200);
  // Unknown routes from Serve are 404 too.
  const other = await post(a.port, "/satellite/v1/status", {});
  assert.equal(other.status, 404);
});

// ── hello rate limits ───────────────────────────────────────────────────────

test("hello: 10/min per source; another source is unaffected; the window slides", async () => {
  const { a, clock } = await agent();
  for (let i = 0; i < 10; i++) assert.equal((await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, "100.64.20.7")).status, 200, `hello ${i}`);
  const r = await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, "100.64.20.7");
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "rate_limited");
  assert.equal((await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, "100.64.20.8")).status, 200);
  clock.t += 60001;
  assert.equal((await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, "100.64.20.7")).status, 200);
});

test("hello: 30/min globally across sources", async () => {
  const { a, clock } = await agent();
  for (let i = 0; i < 30; i++) {
    const src = `100.64.20.${10 + Math.floor(i / 10)}`;
    assert.equal((await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, src)).status, 200, `hello ${i}`);
  }
  const r = await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, "100.64.20.40");
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "rate_limited");
  clock.t += 60001;
  assert.equal((await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, "100.64.20.40")).status, 200);
});

test("a refused hello (rate limited) records no nonce", async () => {
  const { a } = await agent();
  for (let i = 0; i < 11; i++) await post(a.port, "/satellite/v1/pair/hello", { nonce_c: nc() }, "100.64.20.9");
  assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM pair_nonces").get().n, 10);
});

// ── code lifecycle via the exported helper (what cli.js pair-code uses) ─────

test("issuePairCode voids earlier live codes and stores only a one-way value", async () => {
  const home = mkdtempSync(join(tmpdir(), "satagent-codes-"));
  dirs.push(home);
  const db = openSatelliteDb(home);
  const t = Date.parse("2026-10-29T12:00:00.000Z");
  const one = issuePairCode(db, { now: t });
  const two = issuePairCode(db, { now: t + 1000 });
  assert.notEqual(one.code, two.code);
  const rows = db.prepare("SELECT * FROM pair_codes ORDER BY created_at").all();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].voided_at);
  assert.equal(rows[1].voided_at, null);
  assert.equal(rows[1].expires_at, t + 1000 + P.PAIR_CODE_TTL_MS);
  assert.equal(rows[1].code_hash, P.pairMacKey(P.normalizePairCode(two.code)));
  db.close();
});
