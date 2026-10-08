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
  assert.equal(d.kiosk_settings.vad_hangover_ms, 300, "clamped to 300..900");
  assert.equal((await store.updateDeviceProfiles(db, "kiosk-a", { kiosk_settings: { vad_hangover_ms: "500" } })).kiosk_settings.vad_hangover_ms, 500);
  assert.equal((await store.updateDeviceProfiles(db, "kiosk-a", { kiosk_settings: { vad_hangover_ms: 5000 } })).kiosk_settings.vad_hangover_ms, 900, "clamped to 300..900");
  await store.pairDevice(db, { id: "g1", name: "G" });
  assert.equal((await store.updateDeviceProfiles(db, "g1", { device_kind: "kiosk" })).device_kind, "glasses");
});

test("smoke 2026-10-04 levers: hangover defaults to 450 ms (range 300-900); stt_model is default|tiny.en, anything else keeps the prior", async () => {
  assert.equal(store.KIOSK_DEFAULTS.vad_hangover_ms, 450);
  assert.deepEqual(store.KIOSK_VAD_HANGOVER_RANGE, { min: 300, max: 900 });
  assert.equal(store.KIOSK_DEFAULTS.stt_model, "default");
  const db = await freshDb();
  await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  assert.equal((await store.updateDeviceProfiles(db, "kiosk-a", { kiosk_settings: { stt_model: "tiny.en" } })).kiosk_settings.stt_model, "tiny.en");
  assert.equal((await store.updateDeviceProfiles(db, "kiosk-a", { kiosk_settings: { stt_model: "large-v3" } })).kiosk_settings.stt_model, "tiny.en", "unknown model keeps the prior");
  assert.equal((await store.updateDeviceProfiles(db, "kiosk-a", { kiosk_settings: { stt_model: "default" } })).kiosk_settings.stt_model, "default");
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

test("kiosk theme: auto by default; only auto/light/dark are accepted, anything else keeps the prior value", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "kiosk-t", name: "K", device_kind: "kiosk" });
  assert.equal(store.KIOSK_DEFAULTS.theme, "auto");
  assert.deepEqual([...store.KIOSK_THEME_CHOICES], ["auto", "light", "dark"]);
  const set = async (theme) => (await store.updateDeviceProfiles(db, "kiosk-t", { kiosk_settings: { theme } })).kiosk_settings.theme;
  assert.equal(await set("dark"), "dark");
  for (const bad of ["Dark", "night", "", null, 1, true, "auto "]) assert.equal(await set(bad), "dark", `rejected: ${JSON.stringify(bad)}`);
  assert.equal(await set("light"), "light");
  assert.equal(await set("auto"), "auto");
  assert.equal(store.normalizeKioskSettings({ theme: "sepia" }, null).theme, "auto", "a bad value on a fresh record falls back to the default");
});

test("kiosk_settings.profile: one of pi3/phone/tablet/desktop, with who set it; NEVER a stored default; anything else keeps the prior value", () => {
  assert.equal("profile" in store.KIOSK_DEFAULTS, false, "no default is materialised");
  assert.deepEqual(store.KIOSK_PROFILE_CHOICES, ["pi3", "phone", "tablet", "desktop"]);
  assert.deepEqual(store.normalizeKioskSettings({ profile: "phone" }, null), { ...store.KIOSK_DEFAULTS, profile: "phone", profile_source: "operator" });
  assert.equal(store.normalizeKioskSettings({ profile: "pi3", profile_source: "guessed" }, null).profile_source, "guessed");
  assert.equal(store.normalizeKioskSettings({ profile: "tv" }, { profile: "tablet", profile_source: "operator" }).profile, "tablet");
  assert.equal("profile" in store.normalizeKioskSettings({}, null), false);
  const cleared = store.normalizeKioskSettings({ profile: "" }, { profile: "phone", profile_source: "guessed" });
  assert.deepEqual(["profile" in cleared, "profile_source" in cleared], [false, false], "the panel's Not set clears it");
});

test("an already-paired 0.1.8 display keeps NO profile through an unrelated save (nothing decides its type for it)", () => {
  const v018 = { follow_up: true, follow_up_s: 6, memory_integration: true, animation: true, sleep_start: "22:30", sleep_end: "06:30", lang: "en", vad_hangover_ms: 450, stt_model: "default", theme: "auto" };
  const saved = store.normalizeKioskSettings({ follow_up: false, memory_integration: true }, v018);
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(v018).sort());
  assert.equal(saved.follow_up, false);
});

test("kiosk_settings: max_volume is 10..100 in steps of ten; pause_media_on_listen is a boolean; both are optional (never filled in by a default)", async () => {
  assert.deepEqual([store.KIOSK_DEFAULTS.max_volume, store.KIOSK_DEFAULTS.pause_media_on_listen], [undefined, undefined]);
  assert.deepEqual(Object.keys(store.normalizeKioskSettings({ follow_up: true }, null)).filter((k) => store.KIOSK_MEDIA_KEYS.includes(k)), [], "an unrelated save materialises neither");
  const n = (input, prior) => store.normalizeKioskSettings(input, prior);
  assert.equal(n({ max_volume: 64 }).max_volume, 60);
  assert.equal(n({ max_volume: 5 }).max_volume, 10);
  assert.equal(n({ max_volume: 900 }).max_volume, 100);
  assert.equal(n({ max_volume: "70" }).max_volume, 70);
  assert.equal(n({ max_volume: "loud" }, { max_volume: 40 }).max_volume, 40, "not a number keeps the prior");
  assert.equal(n({ pause_media_on_listen: "on" }).pause_media_on_listen, true);
  assert.equal(n({ pause_media_on_listen: false }, { pause_media_on_listen: true }).pause_media_on_listen, false);
  assert.equal(n({}, { max_volume: 30, pause_media_on_listen: true }).max_volume, 30, "an untouched save keeps both");
});

test("r8b: every save of max_volume on this build marks it as on the −50…0 dB scale ('db5'); rev 8's 'db10' mark is kept until the cap is moved or saved; a mark is never set from input on its own", () => {
  const n = (input, prior) => store.normalizeKioskSettings(input, prior);
  assert.equal(n({ max_volume: 70 }).max_volume_scale, "db5");
  assert.equal(n({ max_volume: 70 }, { max_volume: 50, max_volume_scale: "db10" }).max_volume_scale, "db5", "a save puts it on this build's scale");
  assert.equal(n({ follow_up: true }, { max_volume: 50 }).max_volume_scale, undefined, "an old stored cap stays unmarked until it is migrated or saved again");
  assert.equal(n({ follow_up: true }, { max_volume: 80, max_volume_scale: "db10" }).max_volume_scale, "db10", "kept for the migration");
  assert.equal(n({ follow_up: true }, { max_volume: 80, max_volume_scale: "db5" }).max_volume_scale, "db5", "kept");
  assert.equal(n({ max_volume_scale: "db5" }).max_volume_scale, undefined, "never set on its own from input");
  assert.equal(n({ follow_up: true }, { max_volume: 80, max_volume_scale: "loud" }).max_volume_scale, undefined, "an unknown mark is dropped");
});
