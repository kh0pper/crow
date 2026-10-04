import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import * as store from "../servers/shared/device-store.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function freshDb() {
  const raw = createClient({ url: "file::memory:" });
  await raw.execute("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  let writes = 0;
  return {
    get writes() { return writes; },
    async execute(q) { if (/^\s*INSERT/i.test(q.sql)) writes++; return raw.execute(q); },
    close() { raw.close(); },
  };
}

test("kiosk pairing stores a domain-separated hash and a default kiosk_settings", async () => {
  const db = await freshDb();
  const { device, token } = await store.pairDevice(db, { id: "kiosk-a", name: "Kitchen", device_kind: "kiosk" });
  assert.equal(device.device_kind, "kiosk");
  assert.deepEqual(device.kiosk_settings, store.KIOSK_DEFAULTS);
  const raw = await store.findDevice(db, "kiosk-a");
  const sha = (x) => createHash("sha256").update(x).digest("hex");
  assert.equal(raw.kiosk_token_hash, sha("crow-kiosk-v1:" + token));
  assert.match(raw.token_hash, /^[0-9a-f]{64}$/, "a sentinel in token_hash, so old readers see a well-formed record");
  assert.notEqual(raw.token_hash, sha(token));
  assert.notEqual(raw.token_hash, sha("crow-kiosk-v1:" + token));
  assert.equal(token.length, 64);
  assert.ok(!("kiosk_token_hash" in device) && !("token_hash" in device), "pair result is redacted");
  assert.ok((await store.listDevices(db)).every((d) => !("kiosk_token_hash" in d) && !("token_hash" in d)));
});

/** main's meta-glasses verifyToken, verbatim in substance: sha256(caller string) vs token_hash. */
async function oldGlassesVerify(db, id, token) {
  const r = (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: ["meta_glasses_devices"] })).rows[0];
  const d = JSON.parse(r?.value || "[]").find((x) => x.id === id);
  if (!d) return null;
  const a = Buffer.from(d.token_hash, "hex"), b = Buffer.from(createHash("sha256").update(String(token)).digest("hex"), "hex");
  return a.length === b.length && a.equals(b) ? d : null;
}

test("an INSTALLED old glasses store refuses a kiosk token, plain or domain-prefixed (review C2)", async () => {
  const db = await freshDb();
  const { token } = await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  assert.equal(await oldGlassesVerify(db, "kiosk-a", token), null);
  assert.equal(await oldGlassesVerify(db, "kiosk-a", "crow-kiosk-v1:" + token), null);
  const g = await store.pairDevice(db, { id: "g1", name: "G" });
  assert.ok(await oldGlassesVerify(db, "g1", g.token), "glasses still verify through the old path");
});

test("Bot Builder's unbind-others never strands a kiosk display (review M7)", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  await store.pairDevice(db, { id: "g1", name: "G" });
  await store.pairDevice(db, { id: "g2", name: "G2" });
  for (const id of ["kiosk-a", "g1", "g2"]) await store.updateDeviceProfiles(db, id, { bound_bot_id: "house" });
  assert.deepEqual(await store.unbindBotFromOtherDevices(db, "house", "g2"), { unbound: 1 });
  const by = Object.fromEntries((await store.listDevices(db)).map((d) => [d.id, d.bound_bot_id]));
  assert.deepEqual(by, { "kiosk-a": "house", g1: null, g2: "house" });
});

test("a kiosk token verifies ONLY when the caller asks for a kiosk", async () => {
  const db = await freshDb();
  const { token } = await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  assert.equal(await store.verifyToken(db, "kiosk-a", token), null, "no kind → refused");
  assert.equal(await store.verifyToken(db, "kiosk-a", token, { kind: "glasses" }), null);
  assert.equal((await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk" })).id, "kiosk-a");
  assert.equal(await store.verifyToken(db, "kiosk-a", "0".repeat(64), { kind: "kiosk" }), null);
});

test("a glasses token is unaffected (plain sha256) and refused when kiosk is requested", async () => {
  const db = await freshDb();
  const { token } = await store.pairDevice(db, { id: "g1", name: "Ray-Bans" });
  assert.equal((await store.verifyToken(db, "g1", token)).id, "g1");
  assert.equal(await store.verifyToken(db, "g1", token, { kind: "kiosk" }), null);
});

test("last_seen is written at most once per 5 minutes", async () => {
  const db = await freshDb();
  const { token } = await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  const base = db.writes;
  const t0 = Date.parse("2026-10-03T12:00:00Z");
  await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk", now: t0 });
  await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk", now: t0 + 60_000 });
  await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk", now: t0 + 299_999 });
  assert.equal(db.writes - base, 1);
  await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk", now: t0 + 300_000 });
  assert.equal(db.writes - base, 2);
  assert.equal((await store.findDevice(db, "kiosk-a")).last_seen, new Date(t0 + 300_000).toISOString());
});

test("re-pairing keeps the bot binding and the kiosk settings", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  await store.updateDeviceProfiles(db, "kiosk-a", { bound_bot_id: "household", kiosk_settings: { follow_up: true } });
  const { device } = await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  assert.equal(device.bound_bot_id, "household");
  assert.equal(device.kiosk_settings.follow_up, true);
});

test("kiosk_settings are validated and merged; device_kind cannot be flipped to or from kiosk by patch", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  const d = await store.updateDeviceProfiles(db, "kiosk-a", {
    device_kind: "glasses",
    kiosk_settings: { follow_up_s: 99, sleep_start: "25:00", lang: "fr", memory_integration: "true", junk: 1, vad_hangover_ms: 50 },
  });
  assert.equal(d.device_kind, "kiosk");
  assert.equal(d.kiosk_settings.follow_up_s, 20, "clamped to 2..20");
  assert.equal(d.kiosk_settings.sleep_start, "22:30", "bad HH:MM keeps prior");
  assert.equal(d.kiosk_settings.lang, "en");
  assert.equal(d.kiosk_settings.memory_integration, true, "form string 'true' coerces");
  assert.equal("junk" in d.kiosk_settings, false);
  assert.equal(d.kiosk_settings.vad_hangover_ms, 300, "clamped to 300..1200");
  assert.equal((await store.updateDeviceProfiles(db, "kiosk-a", { kiosk_settings: { vad_hangover_ms: "450" } })).kiosk_settings.vad_hangover_ms, 450);
  await store.pairDevice(db, { id: "g1", name: "G" });
  assert.equal((await store.updateDeviceProfiles(db, "g1", { device_kind: "kiosk" })).device_kind, "glasses");
});

test("companion devices keep their existing semantics (no migration in K1, ruling R1)", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "crow-kiosk", name: "Kiosk", device_kind: "companion" });
  assert.equal((await store.findDevice(db, "crow-kiosk")).device_kind, "companion");
});

test("the meta-glasses shim re-exports the core store, from the repo AND from an installed copy", async () => {
  const shim = await import("../bundles/meta-glasses/server/device-store.js");
  assert.equal(shim.verifyToken, store.verifyToken);
  const home = mkdtempSync(join(tmpdir(), "shim-"));
  const dir = join(home, ".crow", "bundles", "meta-glasses", "server");
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "bundles/meta-glasses/server/device-store.js"), join(dir, "device-store.js"));
  const prev = process.env.CROW_APP_ROOT;
  process.env.CROW_APP_ROOT = ROOT;
  try {
    const installed = await import(pathToFileURL(join(dir, "device-store.js")).href);
    assert.equal(typeof installed.pairDevice, "function");
    assert.equal(typeof installed.tokenHash, "function");
  } finally { if (prev === undefined) delete process.env.CROW_APP_ROOT; else process.env.CROW_APP_ROOT = prev; }
});
