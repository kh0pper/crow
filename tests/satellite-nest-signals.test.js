// The satellite Nest signal (SAT-5, spec §14): a card when any satellite is paired, plus one
// strip issue per problem (unreachable, cert under 14 days, tools changed) with ack: null. They
// are severity "info" on purpose: the poller and the renewer already send the one notification
// each problem gets, so the health monitor (warn-only pushes) must not push them again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "satnest-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satnest-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
after(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(process.env.CROW_DATA_DIR, { recursive: true, force: true }); });

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const store = await import("../servers/gateway/satellites/store.js");
const { satellitesSignal } = await import("../servers/gateway/satellites/nest-signals.js");

const DAY = 86400000;
const NOW = Date.parse("2026-11-01T10:00:00Z");
const row = (id, extra = {}) => ({
  id, name: `box-${id.slice(-2)}`, tailnet_host: "satellite.example.ts.net", satellite_pubkey: "a".repeat(64), mgmt_pubkey: "b".repeat(64),
  cert_json: "{}", cert_serial: id, cert_expires_at: new Date(NOW + 80 * DAY).toISOString(), primary_url: "https://crow.example.ts.net:8444",
  agent_protocol: 1, status: "active", created_at: "2026-10-01T00:00:00Z", ...extra,
});

async function db0(withTables = true) {
  const dir = mkdtempSync(join(tmpdir(), "satnest-db-"));
  const db = createDbClient(join(dir, "crow.db"));
  if (withTables) await db.executeMultiple(SATELLITE_DDL);
  return db;
}

test("no satellites (or not migrated): no card at all", async () => {
  assert.equal(await satellitesSignal(await db0(), "en", () => NOW), null);
  assert.equal(await satellitesSignal(await db0(false), "en", () => NOW), null);
});

test("all fine: one ok card", async () => {
  const db = await db0();
  await store.insertSatellite(db, row("sat_aaaaaaaaaaaaaaaaaaa1"));
  const s = await satellitesSignal(db, "en", () => NOW);
  const list = Array.isArray(s) ? s : [s];
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "satellites");
  assert.equal(list[0].state, "ok");
});

test("problems: unreachable, cert expiring, tools changed → info issues with ack null; revoked rows ignored", async () => {
  const db = await db0();
  await store.insertSatellite(db, row("sat_aaaaaaaaaaaaaaaaaaa1", { status: "unreachable", unreachable_since: "2026-11-01T09:00:00Z" }));
  await store.insertSatellite(db, row("sat_aaaaaaaaaaaaaaaaaaa2", { cert_expires_at: new Date(NOW + 5 * DAY).toISOString() }));
  await store.insertSatellite(db, row("sat_aaaaaaaaaaaaaaaaaaa3", {
    last_status_json: JSON.stringify({ v: 1, status: { tools: { demo: { version: "1", sha256: "f".repeat(64) } } } }),
  }));
  await store.putToolPin(db, { satellite_id: "sat_aaaaaaaaaaaaaaaaaaa3", bundle: "demo", version: "1", tools_sha256: "e".repeat(64), tools_json: "[]", approved_at: "x" });
  await store.insertSatellite(db, row("sat_aaaaaaaaaaaaaaaaaaa4", { status: "revoked" }));
  const s = await satellitesSignal(db, "en", () => NOW);
  const card = s.find((x) => x.id === "satellites");
  assert.equal(card.cardOnly, true);
  assert.equal(card.state, "info");
  const issues = s.filter((x) => x.issueOnly);
  assert.deepEqual(issues.map((i) => i.id).sort(), [
    "satellites:sat_aaaaaaaaaaaaaaaaaaa1:unreachable",
    "satellites:sat_aaaaaaaaaaaaaaaaaaa2:cert",
    "satellites:sat_aaaaaaaaaaaaaaaaaaa3:tools:demo",
  ]);
  for (const i of issues) {
    assert.equal(i.severity, "info");
    assert.equal(i.ack, null);
    assert.equal(i.actionHref, "/dashboard/extensions?view=servers");
    assert.ok(i.issueLabel && !i.issueLabel.startsWith("signals."), `translated: ${i.issueLabel}`);
  }
});
