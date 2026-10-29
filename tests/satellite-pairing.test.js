// Satellite pairing, crow side (SAT-1): mgmt keys, cert issuing, crow-initiated pairing, the
// signed satellite client and unpair. The satellite is the in-test fake (tests/helpers).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "satpair-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satpair-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const P = await import("../servers/shared/satellite-protocol.js");
const S = await import("../servers/gateway/satellites/store.js");
const K = await import("../servers/gateway/satellites/mgmt-keys.js");
const C = await import("../servers/gateway/satellites/certs.js");
const { createPairingService } = await import("../servers/gateway/satellites/pairing.js");
const { satelliteFetch } = await import("../servers/gateway/satellites/client.js");
const { createFakeSatellite, fakeIdentity, FAKE_HOST } = await import("./helpers/fake-satellite.js");

const dirs = [HOME, process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function freshDb(withTables = true) {
  const dir = mkdtempSync(join(tmpdir(), "satpair-db-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  if (withTables) await db.executeMultiple(SATELLITE_DDL);
  return db;
}

const CODE = P.generatePairCode().code;
const identity = fakeIdentity();
const SHA = "a".repeat(40);

function service(fake, extra = {}) {
  return createPairingService({
    fetchImpl: fake.fetchImpl,
    whoisImpl: async () => ({ node: "satellite", tags: ["tag:vps"] }),
    identityFn: () => identity,
    instanceIdFn: () => "inst-primary",
    primaryUrlFn: async () => "https://crow.example.ts.net:8444",
    targetShaFn: () => SHA,
    ...extra,
  });
}

const keyPath = (id) => join(HOME, "secrets", "satellites", `${id}.mgmt.json`);

// ── mgmt keys ───────────────────────────────────────────────────────────────

test("mgmt key: create 0600 in a 0700 dir, load, refuse overwrite, shred", () => {
  const id = P.satelliteIdFromPub(P.generateKeypair().pubHex);
  const k = K.createMgmtKey(id);
  assert.equal(k.satellite_id, id);
  assert.equal(k.version, 1);
  assert.match(k.ed25519_pub, /^[0-9a-f]{64}$/);
  const st = statSync(keyPath(id));
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(statSync(join(HOME, "secrets", "satellites")).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(keyPath(id), "utf8"))).sort(),
    ["created_at", "ed25519_priv", "ed25519_pub", "satellite_id", "version"]);
  assert.deepEqual(K.loadMgmtKey(id), k);
  assert.throws(() => K.createMgmtKey(id), /exists/);
  const k2 = K.createMgmtKey(id, { replace: true });
  assert.notEqual(k2.ed25519_pub, k.ed25519_pub);
  K.shredMgmtKey(id);
  assert.equal(existsSync(keyPath(id)), false);
  assert.equal(K.loadMgmtKey(id), null);
  K.shredMgmtKey(id); // idempotent
  assert.throws(() => K.createMgmtKey("../evil"), /satellite id/);
  assert.throws(() => K.loadMgmtKey("sat_../../x"), /satellite id/);
});

// ── certs ───────────────────────────────────────────────────────────────────

test("issueCert signs with the root key; revocation verifies under the root pubkey", () => {
  const sat = P.generateKeypair();
  const mg = P.generateKeypair();
  const id = P.satelliteIdFromPub(sat.pubHex);
  const now = Date.parse("2026-10-29T00:00:00.000Z");
  const cert = C.issueCert({ identity, instanceId: "inst-primary", primaryUrl: "https://crow.example.ts.net:8444",
    satellite_id: id, satellite_pubkey: sat.pubHex, mgmt_pubkey: mg.pubHex, now });
  assert.equal(P.verifyCertSignature(cert), true);
  assert.equal(cert.payload.crow_id, identity.crowId);
  assert.equal(cert.payload.root_pubkey, identity.ed25519Pubkey);
  assert.equal(cert.payload.primary_instance_id, "inst-primary");
  assert.equal(cert.payload.expires_at, new Date(now + P.CERT_TTL_MS).toISOString());
  assert.deepEqual(cert.payload.scopes, ["manage", "tools", "vault"]);
  assert.throws(() => C.issueCert({ identity, instanceId: "i", primaryUrl: "https://x", satellite_id: id,
    satellite_pubkey: mg.pubHex, mgmt_pubkey: mg.pubHex, now }), /satellite/);
  const rec = C.revokeSatelliteRecord({ identity, serial: cert.payload.serial, satellite_id: id, reason: "owner", now });
  assert.equal(rec.serial, cert.payload.serial);
  assert.equal(P.verifyRevocation({ payload: JSON.parse(rec.payload_json), sig: rec.sig }, identity.ed25519Pubkey), true);
});

// ── pairing ─────────────────────────────────────────────────────────────────

test("happy path: hello, confirm, complete; row active; the code never crosses the wire", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  const start = await svc.startPairing({ host: FAKE_HOST });
  assert.equal(start.satellite_id, fake.satId);
  assert.equal(start.fingerprint, P.formatFingerprint(fake.satId));
  assert.deepEqual(start.whois, { node: "satellite", tags: ["tag:vps"] });
  assert.match(start.pairing_id, /^[0-9a-f]{32}$/);
  // Nothing signed yet, no key yet.
  assert.equal(existsSync(keyPath(fake.satId)), false);
  assert.equal(fake.state.requests.length, 1);
  const hello = fake.state.requests[0];
  assert.equal(hello.url, `https://${FAKE_HOST}/satellite/v1/pair/hello`);
  assert.deepEqual(Object.keys(JSON.parse(hello.body)), ["nonce_c"]);

  const done = await svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE.toLowerCase(), name: "Office server" });
  assert.equal(done.satellite_id, fake.satId);
  const row = await S.getSatellite(db, fake.satId);
  assert.equal(row.status, "active");
  assert.equal(row.name, "Office server");
  assert.equal(row.tailnet_host, FAKE_HOST);
  assert.equal(row.satellite_pubkey, fake.pubHex);
  assert.equal(row.primary_url, "https://crow.example.ts.net:8444");
  const key = K.loadMgmtKey(fake.satId);
  assert.equal(row.mgmt_pubkey, key.ed25519_pub);
  const cert = JSON.parse(row.cert_json);
  assert.equal(cert.payload.mgmt_pubkey, key.ed25519_pub);
  assert.equal(row.cert_serial, cert.payload.serial);

  const complete = JSON.parse(fake.state.requests[1].body);
  assert.deepEqual(Object.keys(complete).sort(),
    ["cert", "crow_id", "mac", "nonce_s", "primary_instance_id", "primary_url", "protocol", "root_pubkey", "target_sha"]);
  assert.equal(complete.target_sha, SHA);
  assert.equal(complete.protocol, P.AGENT_PROTOCOL);
  const norm = P.normalizePairCode(CODE);
  for (const r of fake.state.requests) {
    const wire = r.url + JSON.stringify(r.headers) + r.body;
    for (const form of [norm, CODE, norm.toLowerCase(), CODE.toLowerCase()]) assert.equal(wire.includes(form), false);
  }
  // Pending is single use.
  await assert.rejects(svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "x" }), { code: "unknown_pairing" });
});

test("bad hello signature and satellite_id/pubkey mismatch are refused; nothing pending", async () => {
  for (const [tamper, code] of [[{ helloSig: true }, "bad_hello_sig"], [{ helloPubkey: true }, "id_mismatch"]]) {
    const fake = createFakeSatellite({ code: CODE, tamper });
    const svc = service(fake);
    await assert.rejects(svc.startPairing({ host: FAKE_HOST }), { code });
    assert.equal(svc.pendingCount(), 0);
  }
});

test("wrong code: no row, mgmt key shredded", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  const start = await svc.startPairing({ host: FAKE_HOST });
  const wrong = P.generatePairCode().code;
  await assert.rejects(svc.completePairing({ db, pairing_id: start.pairing_id, code: wrong, name: "x" }),
    { code: "pairing_refused", detail: "bad_mac" });
  assert.equal(await S.getSatellite(db, fake.satId), null);
  assert.equal(existsSync(keyPath(fake.satId)), false);
  assert.equal(fake.state.wrong, 1);
});

test("a malformed code is refused before any network; the pairing stays pending", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  const start = await svc.startPairing({ host: FAKE_HOST });
  await assert.rejects(svc.completePairing({ db, pairing_id: start.pairing_id, code: "not-a-code", name: "x" }), { code: "bad_code" });
  assert.equal(fake.state.requests.length, 1);
  assert.equal(svc.pendingCount(), 1);
  await svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "x" });
});

test("done signature failure: no row, key shredded", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE, tamper: { doneSig: true } });
  const svc = service(fake);
  const start = await svc.startPairing({ host: FAKE_HOST });
  await assert.rejects(svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "x" }), { code: "bad_done_sig" });
  assert.equal(await S.getSatellite(db, fake.satId), null);
  assert.equal(existsSync(keyPath(fake.satId)), false);
});

test("not migrated: complete refuses before any network, no key made", async () => {
  const db = await freshDb(false);
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  const start = await svc.startPairing({ host: FAKE_HOST });
  await assert.rejects(svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "x" }), { code: "not_migrated" });
  assert.equal(fake.state.requests.length, 1);
  assert.equal(existsSync(keyPath(fake.satId)), false);
});

test("whois failure does not block pairing; it is unknown and needs an explicit confirm", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake, { whoisImpl: async () => { throw new Error("no tailscale"); } });
  const start = await svc.startPairing({ host: FAKE_HOST });
  assert.deepEqual(start.whois, { unknown: true });
  assert.equal(start.warning, "whois_unavailable");
  await assert.rejects(svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "x" }), { code: "whois_required", status: 409 });
  assert.equal(fake.state.requests.length, 1);
  assert.equal(svc.pendingCount(), 1);
  const ok = await svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "x", confirm_without_whois: true });
  assert.equal(ok.satellite_id, fake.satId);
  const known = await service(createFakeSatellite({ code: CODE })).startPairing({ host: FAKE_HOST });
  assert.equal("warning" in known, false);
});

test("two parallel completes for one pending id: exactly one row, its key matches", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  const start = await svc.startPairing({ host: FAKE_HOST });
  const rs = await Promise.allSettled([
    svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "a" }),
    svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "b" }),
  ]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(rs.find((r) => r.status === "rejected").reason.code, "unknown_pairing");
  assert.equal((await S.listSatellites(db)).length, 1);
  const row = await S.getSatellite(db, fake.satId);
  assert.equal(K.loadMgmtKey(fake.satId).ed25519_pub, row.mgmt_pubkey);
  assert.equal(fake.state.requests.filter((r) => r.url.endsWith("/pair/complete")).length, 1);
});

test("parallel completes for two pending ids of one satellite: one proceeds, key not clobbered", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  const a = await svc.startPairing({ host: FAKE_HOST });
  const b = await svc.startPairing({ host: FAKE_HOST });
  const rs = await Promise.allSettled([
    svc.completePairing({ db, pairing_id: a.pairing_id, code: CODE, name: "a" }),
    svc.completePairing({ db, pairing_id: b.pairing_id, code: CODE, name: "b" }),
  ]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(rs.find((r) => r.status === "rejected").reason.code, "pairing_in_progress");
  const row = await S.getSatellite(db, fake.satId);
  assert.equal(K.loadMgmtKey(fake.satId).ed25519_pub, row.mgmt_pubkey);
});

test("a key left on disk by a crashed attempt is replaced, not a blocker", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  const orphan = K.createMgmtKey(fake.satId);
  await svc.completePairing({ db, ...(await svc.startPairing({ host: FAKE_HOST })), code: CODE, name: "x" });
  const row = await S.getSatellite(db, fake.satId);
  assert.notEqual(row.mgmt_pubkey, orphan.ed25519_pub);
  assert.equal(K.loadMgmtKey(fake.satId).ed25519_pub, row.mgmt_pubkey);
});

test("parseWhois: tagged node → node + tags; untagged → node + login", async () => {
  const { parseWhois } = await import("../servers/gateway/satellites/pairing.js");
  assert.deepEqual(parseWhois({ Node: { Name: "satellite.example.ts.net.", Tags: ["tag:vps"] }, UserProfile: { LoginName: "tagged-devices" } }),
    { node: "satellite.example.ts.net", tags: ["tag:vps"] });
  assert.deepEqual(parseWhois({ Node: { Name: "box.example.ts.net." }, UserProfile: { LoginName: "alex@example.com" } }),
    { node: "box.example.ts.net", login: "alex@example.com" });
  assert.equal(parseWhois(null), null);
});

test("bad host, unreachable, pending cap", async () => {
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  for (const host of ["", "https://x", "a/b", "x:443", "-bad.example", "a b", "localhost", "127.0.0.1", "::1",
    "169.254.169.254", "10.0.0.5", "8.8.8.8", "100.128.0.1", "100.63.255.255", "example.com", "ts.net",
    "x.ts.net.example.com", "satellite.example.ts.net:443", "a..ts.net"]) {
    await assert.rejects(svc.startPairing({ host }), { code: "bad_host" });
  }
  assert.equal(fake.state.requests.length, 0);
  const { normalizeHost } = await import("../servers/gateway/satellites/pairing.js");
  assert.equal(normalizeHost("Satellite.Example.TS.NET."), "satellite.example.ts.net");
  assert.equal(normalizeHost("100.64.20.5"), "100.64.20.5");
  assert.equal(normalizeHost("100.127.255.254"), "100.127.255.254");
  const down = service(createFakeSatellite({ code: CODE, tamper: { unreachable: true } }));
  await assert.rejects(down.startPairing({ host: FAKE_HOST }), { code: "unreachable" });
  for (let i = 0; i < 8; i++) await svc.startPairing({ host: FAKE_HOST });
  await assert.rejects(svc.startPairing({ host: FAKE_HOST }), { code: "too_many_pending" });
});

test("pending pairings expire after 10 minutes", async () => {
  let t = Date.parse("2026-10-29T00:00:00Z");
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake, { now: () => t });
  const start = await svc.startPairing({ host: FAKE_HOST });
  t += 10 * 60000 + 1;
  await assert.rejects(svc.completePairing({ db, pairing_id: start.pairing_id, code: CODE, name: "x" }), { code: "unknown_pairing" });
});

test("an already paired satellite is refused before any key is made", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  await svc.completePairing({ db, ...(await svc.startPairing({ host: FAKE_HOST })), code: CODE, name: "x" });
  const before = K.loadMgmtKey(fake.satId);
  const again = await svc.startPairing({ host: FAKE_HOST });
  await assert.rejects(svc.completePairing({ db, pairing_id: again.pairing_id, code: CODE, name: "x" }), { code: "already_paired" });
  assert.deepEqual(K.loadMgmtKey(fake.satId), before);
});

// ── client + unpair ─────────────────────────────────────────────────────────

async function pairedFixture(tamper) {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const svc = service(fake);
  await svc.completePairing({ db, ...(await svc.startPairing({ host: FAKE_HOST })), code: CODE, name: "x" });
  return { db, fake, svc, row: await S.getSatellite(db, fake.satId) };
}

test("satelliteFetch: signs, verifies the response signature, returns json", async () => {
  const { fake, row } = await pairedFixture();
  const r = await satelliteFetch(row, { method: "GET", path: "/satellite/v1/status", caller: "owner-local", fetchImpl: fake.fetchImpl });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, caller: "owner-local" });
  const req = fake.state.requests.at(-1);
  assert.equal(req.headers.Accept, "application/json");
});

test("satelliteFetch: bad response sig, event-stream, non-JSON, oversize, unreachable", async () => {
  const { fake, row } = await pairedFixture();
  const call = (opts = {}) => satelliteFetch(row, { method: "GET", path: "/satellite/v1/status", caller: "owner-local", fetchImpl: fake.fetchImpl, ...opts });
  const set = (t) => { for (const k of ["respSig", "contentType", "bigBody", "unreachable"]) delete fakeTamper[k]; Object.assign(fakeTamper, t); };
  const fakeTamper = {};
  const wrapped = async (url, init) => {
    if (fakeTamper.unreachable) throw new TypeError("fetch failed");
    const res = await fake.fetchImpl(url, init);
    if (!fakeTamper.respSig && !fakeTamper.contentType && !fakeTamper.bigBody) return res;
    const text = fakeTamper.bigBody ? "x".repeat(fakeTamper.bigBody) : await res.text();
    const h = new Headers(res.headers);
    if (fakeTamper.respSig) h.set("x-crow-sat-resp-sig", "00".repeat(64));
    if (fakeTamper.contentType) h.set("content-type", fakeTamper.contentType);
    return new Response(text, { status: res.status, headers: h });
  };
  set({ respSig: true });
  await assert.rejects(call({ fetchImpl: wrapped }), { code: "bad_response_sig" });
  set({ contentType: "text/event-stream" });
  await assert.rejects(call({ fetchImpl: wrapped }), { code: "protocol" });
  set({ contentType: "text/html" });
  await assert.rejects(call({ fetchImpl: wrapped }), { code: "protocol" });
  set({ bigBody: 70000 });
  await assert.rejects(call({ fetchImpl: wrapped }), { code: "protocol" });
  set({ unreachable: true });
  await assert.rejects(call({ fetchImpl: wrapped }), { code: "unreachable" });
  set({});
  await assert.rejects(call({ caller: "nobody" }), { code: "protocol" });
});

test("unpair: signed call, row revoked, signed revocation, key shredded, pins gone", async () => {
  const { db, fake, svc, row } = await pairedFixture();
  await S.putToolPin(db, { satellite_id: row.id, bundle: "b", tools_sha256: "h", tools_json: "[]", approved_at: "t" });
  const r = await svc.unpairSatellite({ db, id: row.id, reason: "owner" });
  assert.equal(r.reached, true);
  assert.deepEqual(fake.state.unpaired, { reason: "owner" });
  const after = await S.getSatellite(db, row.id);
  assert.equal(after.status, "revoked");
  assert.ok(after.revoked_at);
  assert.equal(existsSync(keyPath(row.id)), false);
  assert.equal(await S.getToolPin(db, row.id, "b"), null);
  const rev = (await db.execute("SELECT * FROM satellite_revocations")).rows[0];
  assert.equal(rev.serial, row.cert_serial);
  assert.equal(P.verifyRevocation({ payload: JSON.parse(rev.payload_json), sig: rev.sig }, identity.ed25519Pubkey), true);
  await assert.rejects(svc.unpairSatellite({ db, id: row.id }), { code: "already_revoked" });
  await assert.rejects(svc.unpairSatellite({ db, id: P.satelliteIdFromPub(P.generateKeypair().pubHex) }), { code: "not_found" });
});

test("unpair of an unreachable satellite still does crow's side", async () => {
  const { db, row } = await pairedFixture();
  const svc = service({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  const r = await svc.unpairSatellite({ db, id: row.id, reason: "lost" });
  assert.equal(r.reached, false);
  assert.equal((await S.getSatellite(db, row.id)).status, "revoked");
  assert.equal(existsSync(keyPath(row.id)), false);
});

test("unpair then re-pair replaces the revoked row in place; revocation records are kept", async () => {
  const { db, fake, svc, row } = await pairedFixture();
  await svc.unpairSatellite({ db, id: row.id, reason: "owner" });
  const again = await svc.completePairing({ db, ...(await svc.startPairing({ host: FAKE_HOST })), code: CODE, name: "Back" });
  assert.equal(again.repaired, true);
  const r2 = await S.getSatellite(db, row.id);
  assert.equal(r2.status, "active");
  assert.equal(r2.revoked_at, null);
  assert.equal(r2.name, "Back");
  assert.notEqual(r2.mgmt_pubkey, row.mgmt_pubkey);
  assert.notEqual(r2.cert_serial, row.cert_serial);
  assert.equal(K.loadMgmtKey(row.id).ed25519_pub, r2.mgmt_pubkey);
  assert.equal((await S.listSatellites(db)).length, 1);
  const revs = (await db.execute("SELECT serial FROM satellite_revocations")).rows.map((x) => x.serial);
  assert.deepEqual(revs, [row.cert_serial]);
  // The new pairing manages the satellite.
  const st = await satelliteFetch(r2, { method: "GET", path: "/satellite/v1/status", caller: "owner-local", fetchImpl: fake.fetchImpl });
  assert.equal(st.status, 200);
});

test("unpair: a failing revocation write still shreds the key and deletes pins", async () => {
  const { db, svc, row } = await pairedFixture();
  await S.putToolPin(db, { satellite_id: row.id, bundle: "b", tools_sha256: "h", tools_json: "[]", approved_at: "t" });
  const broken = new Proxy(db, { get: (t, k) => (k === "execute"
    ? async (arg) => {
      if (String(arg?.sql ?? arg).includes("satellite_revocations")) throw new Error("disk full");
      return t.execute(arg);
    }
    : Reflect.get(t, k)) });
  await assert.rejects(svc.unpairSatellite({ db: broken, id: row.id }), /disk full/);
  assert.equal(existsSync(keyPath(row.id)), false);
  assert.equal(await S.getToolPin(db, row.id, "b"), null);
});

test("unpair of an already revoked satellite still shreds a key left on disk", async () => {
  const { db, svc, row } = await pairedFixture();
  await svc.unpairSatellite({ db, id: row.id });
  K.createMgmtKey(row.id);
  await assert.rejects(svc.unpairSatellite({ db, id: row.id }), { code: "already_revoked" });
  assert.equal(existsSync(keyPath(row.id)), false);
});
