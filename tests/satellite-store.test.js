// Satellite store (SAT-1): round trips, missing-table behaviour, status CHECK. Scratch DBs only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satstore-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const S = await import("../servers/gateway/satellites/store.js");

const dirs = [process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function fresh(withTables = true) {
  const dir = mkdtempSync(join(tmpdir(), "satstore-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  return { db, ready: withTables ? db.executeMultiple(SATELLITE_DDL) : Promise.resolve() };
}
const row = (o = {}) => ({
  id: "sat-1", name: "Office", tailnet_host: "satellite.example.ts.net", satellite_pubkey: "pk",
  mgmt_pubkey: "mk", cert_json: "{}", cert_serial: "s1", cert_expires_at: "2027-01-01T00:00:00Z",
  primary_url: "https://crow.example.ts.net", agent_protocol: 1, ...o,
});

test("satellite round trip, list, status patch, revoke", async () => {
  const { db, ready } = fresh(); await ready;
  assert.deepEqual(await S.listSatellites(db), []);
  assert.equal(await S.getSatellite(db, "sat-1"), null);
  await S.insertSatellite(db, row());
  const g = await S.getSatellite(db, "sat-1");
  assert.equal(g.name, "Office");
  assert.equal(g.status, "active");
  assert.equal(g.agent_protocol, 1);
  assert.equal((await S.listSatellites(db)).length, 1);
  await S.updateSatelliteStatus(db, "sat-1", { status: "unreachable", unreachable_since: "2026-10-29T00:00:00Z", last_status_json: "{\"a\":1}" });
  const u = await S.getSatellite(db, "sat-1");
  assert.equal(u.status, "unreachable");
  assert.equal(u.last_status_json, "{\"a\":1}");
  assert.equal(u.name, "Office");
  await S.markRevoked(db, "sat-1", "2026-10-29T01:00:00Z");
  const r = await S.getSatellite(db, "sat-1");
  assert.equal(r.status, "revoked");
  assert.equal(r.revoked_at, "2026-10-29T01:00:00Z");
});

test("status CHECK rejects an unknown value; patch rejects unknown columns", async () => {
  const { db, ready } = fresh(); await ready;
  await S.insertSatellite(db, row());
  await assert.rejects(() => S.updateSatelliteStatus(db, "sat-1", { status: "bogus" }));
  await assert.rejects(() => S.updateSatelliteStatus(db, "sat-1", { "name; DROP": 1 }));
  await assert.rejects(() => S.insertSatellite(db, row({ id: "sat-2", status: "weird" })));
});

test("revocation records", async () => {
  const { db, ready } = fresh(); await ready;
  await S.recordRevocation(db, { serial: "s1", satellite_id: "sat-1", revoked_at: "t", reason: "lost", payload_json: "{}", sig: "sig" });
  // idempotent on the serial
  await S.recordRevocation(db, { serial: "s1", satellite_id: "sat-1", revoked_at: "t", reason: "lost", payload_json: "{}", sig: "sig" });
  const n = await db.execute("SELECT COUNT(*) AS n FROM satellite_revocations");
  assert.equal(Number(n.rows[0].n), 1);
});

test("tool pins: put (upsert), get, delete one bundle, delete all", async () => {
  const { db, ready } = fresh(); await ready;
  assert.equal(await S.getToolPin(db, "sat-1", "b"), null);
  await S.putToolPin(db, { satellite_id: "sat-1", bundle: "b", version: "1", tools_sha256: "h1", tools_json: "[]", approved_at: "t" });
  await S.putToolPin(db, { satellite_id: "sat-1", bundle: "b", version: "2", tools_sha256: "h2", tools_json: "[1]", read_marks_json: "[\"x\"]", approved_at: "t2" });
  await S.putToolPin(db, { satellite_id: "sat-1", bundle: "c", tools_sha256: "h3", tools_json: "[]", approved_at: "t" });
  const p = await S.getToolPin(db, "sat-1", "b");
  assert.equal(p.version, "2");
  assert.equal(p.tools_sha256, "h2");
  assert.equal(p.read_marks_json, "[\"x\"]");
  assert.equal((await S.getToolPin(db, "sat-1", "c")).read_marks_json, "[]");
  await S.deleteToolPins(db, "sat-1", "b");
  assert.equal(await S.getToolPin(db, "sat-1", "b"), null);
  assert.ok(await S.getToolPin(db, "sat-1", "c"));
  await S.deleteToolPins(db, "sat-1");
  assert.equal(await S.getToolPin(db, "sat-1", "c"), null);
});

test("bot opt-in defaults off, toggles, CHECK-safe", async () => {
  const { db, ready } = fresh(); await ready;
  assert.equal(await S.getBotOptin(db, "bot1"), false);
  await S.setBotOptin(db, "bot1", true);
  assert.equal(await S.getBotOptin(db, "bot1"), true);
  await S.setBotOptin(db, "bot1", false);
  assert.equal(await S.getBotOptin(db, "bot1"), false);
});

test("missing tables: readers are empty/null/false, writers throw not_migrated", async () => {
  const { db } = fresh(false);
  assert.deepEqual(await S.listSatellites(db), []);
  assert.equal(await S.getSatellite(db, "x"), null);
  assert.equal(await S.getToolPin(db, "x", "b"), null);
  assert.equal(await S.getBotOptin(db, "b"), false);
  const writers = [
    () => S.insertSatellite(db, row()),
    () => S.updateSatelliteStatus(db, "x", { status: "active" }),
    () => S.markRevoked(db, "x", "t"),
    () => S.recordRevocation(db, { serial: "s", satellite_id: "x", revoked_at: "t", payload_json: "{}", sig: "s" }),
    () => S.putToolPin(db, { satellite_id: "x", bundle: "b", tools_sha256: "h", tools_json: "[]", approved_at: "t" }),
    () => S.deleteToolPins(db, "x"),
    () => S.setBotOptin(db, "b", true),
  ];
  for (const w of writers) {
    await assert.rejects(w, (e) => e.code === "not_migrated");
  }
  assert.equal(S.isNotMigrated(new Error("SQLITE_ERROR: no such table: satellites")), true);
  assert.equal(S.isNotMigrated(new Error("boom")), false);
  assert.equal(S.isNotMigrated(null), false);
});
