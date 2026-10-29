// Daily cert renewal and mgmt-key rotation, crow side (SAT-5, spec §3.2, §14; Task 6 note):
// renew when < 76 days remain, notify when < 14 days remain; a rotation keeps the OLD mgmt key
// until the satellite answers 200 to POST cert, and on an ambiguous failure probes the old key,
// then the new one, before deciding.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "satrenew-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satrenew-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
const dirs = [HOME, process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const store = await import("../servers/gateway/satellites/store.js");
const K = await import("../servers/gateway/satellites/mgmt-keys.js");
const { createCertRenewer, RENEW_INTERVAL_MS, EXPIRY_WARN_DAYS } = await import("../servers/gateway/satellites/renewal.js");
const { createMgmtFake, makeSatelliteRow } = await import("./helpers/fake-satellite-mgmt.js");

const DAY = 86400000;

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "satrenew-db-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(SATELLITE_DDL);
  return db;
}

async function setup({ ageDays = 0, routes } = {}) {
  const db = await freshDb();
  const fake = createMgmtFake({ routes });
  const t = Date.now();
  const made = await makeSatelliteRow(db, fake, { certNow: t - ageDays * DAY });
  const notes = [];
  const renewer = createCertRenewer({
    dbFactory: () => db, closeDb: false, fetchImpl: fake.fetchImpl, identityFn: () => made.identity,
    notify: async (_db, n) => { notes.push(n); return 1; },
  });
  return { db, fake, made, renewer, notes };
}

test("constants: daily, warn under 14 days", () => {
  assert.equal(RENEW_INTERVAL_MS, DAY);
  assert.equal(EXPIRY_WARN_DAYS, 14);
});

test("a fresh cert (90 days left) is not renewed; one with < 76 days is, same mgmt key, row updated", async () => {
  const a = await setup({ ageDays: 1 });
  await a.renewer.tick();
  assert.equal(a.fake.state.certs.length, 0);

  const b = await setup({ ageDays: 15 });
  await b.renewer.tick();
  assert.equal(b.fake.state.certs.length, 1);
  const sent = b.fake.state.certs[0];
  assert.equal(sent.payload.mgmt_pubkey, b.made.mgmtKey.ed25519_pub, "a renewal keeps the mgmt key");
  assert.notEqual(sent.payload.serial, b.made.cert.payload.serial);
  const row = await store.getSatellite(b.db, b.fake.satId);
  assert.equal(row.cert_serial, sent.payload.serial);
  assert.equal(row.cert_expires_at, sent.payload.expires_at);
  assert.deepEqual(JSON.parse(row.cert_json), sent);
  assert.equal(b.notes.length, 0);
});

test("< 14 days left and the renewal fails: one notification that day", async () => {
  const a = await setup({ ageDays: 80, routes: { "POST /satellite/v1/cert": () => ({ status: 400, json: { error: "bad_cert" } }) } });
  await a.renewer.tick();
  await a.renewer.tick();
  assert.equal(a.notes.length, 1);
  assert.match(a.notes[0].title, /certificate expires in (9|10) days/);
  const row = await store.getSatellite(a.db, a.fake.satId);
  assert.equal(row.cert_serial, a.made.cert.payload.serial, "a refused renewal changes nothing");
});

test("rotation: signed with the OLD key, the new key replaces it only after the 200", async () => {
  const a = await setup();
  const oldPub = a.made.mgmtKey.ed25519_pub;
  let sawStaged = null;
  a.fake.table["POST /satellite/v1/cert"] = ({ body }) => {
    sawStaged = K.loadMgmtKey(a.fake.satId)?.ed25519_pub; // the live key file while the call is in flight
    a.fake.state.certs.push(body.cert);
    a.fake.state.mgmtPub = body.cert.payload.mgmt_pubkey;
    return { status: 200, json: { ok: true, rotated: true } };
  };
  const sat = await store.getSatellite(a.db, a.fake.satId);
  const r = await a.renewer.rotateKey(a.db, sat);
  assert.equal(r.rotated, true);
  assert.equal(sawStaged, oldPub, "the old key stays the live key until the satellite says 200");
  const newPub = a.fake.state.certs[0].payload.mgmt_pubkey;
  assert.notEqual(newPub, oldPub);
  assert.equal(K.loadMgmtKey(a.fake.satId).ed25519_pub, newPub);
  assert.equal(K.loadStagedMgmtKey(a.fake.satId), null);
  const row = await store.getSatellite(a.db, a.fake.satId);
  assert.equal(row.mgmt_pubkey, newPub);
  // And the new key works.
  await a.renewer.tick();
  const st = await a.renewer.probe(row);
  assert.equal(st, "ok");
});

test("rotation, ambiguous: satellite took it but the answer was lost → old key refused, new key works → promoted", async () => {
  const a = await setup();
  a.fake.table["POST /satellite/v1/cert"] = ({ body }) => { a.fake.state.mgmtPub = body.cert.payload.mgmt_pubkey; return { drop: true }; };
  const r = await a.renewer.rotateKey(a.db, await store.getSatellite(a.db, a.fake.satId));
  assert.equal(r.rotated, true);
  assert.equal(r.recovered, true);
  assert.equal(K.loadMgmtKey(a.fake.satId).ed25519_pub, a.fake.state.mgmtPub);
  assert.equal((await store.getSatellite(a.db, a.fake.satId)).mgmt_pubkey, a.fake.state.mgmtPub);
});

test("rotation, ambiguous: satellite never got it → old key still works → staged key discarded", async () => {
  const a = await setup();
  const oldPub = a.made.mgmtKey.ed25519_pub;
  a.fake.table["POST /satellite/v1/cert"] = () => ({ drop: true });
  const r = await a.renewer.rotateKey(a.db, await store.getSatellite(a.db, a.fake.satId));
  assert.equal(r.rotated, false);
  assert.equal(K.loadMgmtKey(a.fake.satId).ed25519_pub, oldPub);
  assert.equal(K.loadStagedMgmtKey(a.fake.satId), null);
  assert.ok(!existsSync(K.mgmtKeyPath(a.fake.satId).replace(/\.mgmt\.json$/, ".mgmt.next.json")));
  assert.equal((await store.getSatellite(a.db, a.fake.satId)).mgmt_pubkey, oldPub);
});

test("rotation, unreachable for both probes: the staged key is kept for a later retry, old key stays live", async () => {
  const a = await setup();
  const oldPub = a.made.mgmtKey.ed25519_pub;
  a.fake.table["POST /satellite/v1/cert"] = () => { a.fake.state.unreachable = true; return { drop: true }; };
  const r = await a.renewer.rotateKey(a.db, await store.getSatellite(a.db, a.fake.satId));
  assert.equal(r.rotated, false);
  assert.equal(r.code, "ambiguous");
  assert.equal(K.loadMgmtKey(a.fake.satId).ed25519_pub, oldPub);
  assert.ok(K.loadStagedMgmtKey(a.fake.satId), "kept: the satellite may hold the new pin");
  // Next time, the probe finds out which key the satellite has.
  a.fake.state.unreachable = false;
  const again = await a.renewer.resolveStaged(a.db, await store.getSatellite(a.db, a.fake.satId));
  assert.equal(again, "discarded");
});
