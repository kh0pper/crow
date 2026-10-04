import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureKioskSttProfile, pickKioskTtsProfile, KIOSK_STT_PROFILE_ID, KIOSK_STT_MODEL } from "../bundles/kiosk/server/profiles.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("faster-whisper: pinned to the running digest's tag, never unloads, preloads the kiosk model, capped, loopback only", () => {
  const y = read("bundles/faster-whisper-server/docker-compose.yml");
  assert.match(y, /^\s*image: fedirz\/faster-whisper-server:0\.5\.0-cpu\s*$/m);
  assert.match(y, /WHISPER__TTL: "-1"/);
  assert.match(y, /PRELOAD_MODELS: '\["Systran\/faster-distil-whisper-small\.en", "Systran\/faster-whisper-tiny\.en"\]'/, "kiosk model + the tiny.en lever");
  assert.match(y, /^\s*mem_limit: 8g\s*$/m);
  assert.match(y, /"127\.0\.0\.1:8004:8000"/);
  assert.doesNotMatch(y, /:latest/);
});

test("kokoro: pinned v0.9.0, 4g cap, loopback only", () => {
  const y = read("bundles/kokoro-tts/docker-compose.yml");
  assert.match(y, /^\s*image: ghcr\.io\/remsky\/kokoro-fastapi-cpu:v0\.9\.0\s*$/m);
  assert.match(y, /^\s*mem_limit: 4g\s*$/m);
  assert.match(y, /"127\.0\.0\.1:8880:8880"/);
  assert.doesNotMatch(y, /:latest/);
});

function settings(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, readSetting: async (db, k) => m.get(k) ?? null, writeSetting: async (db, k, v) => { m.set(k, v); } };
}

test("ensureKioskSttProfile: adds a distil-small.en English profile on the existing faster-whisper baseUrl, once", async () => {
  const s = settings({ stt_profiles: JSON.stringify([{ id: "fw", provider: "fasterwhisper", baseUrl: "http://localhost:8004/v1", defaultModel: "Systran/faster-whisper-large-v3", isDefault: true }]) });
  const p = await ensureKioskSttProfile({}, s);
  assert.equal(p.id, KIOSK_STT_PROFILE_ID);
  assert.equal(p.defaultModel, KIOSK_STT_MODEL);
  assert.equal(p.language, "en");
  assert.equal(p.baseUrl, "http://localhost:8004/v1");
  assert.equal(p.isDefault, false, "never steals the default");
  await ensureKioskSttProfile({}, s);
  assert.equal(JSON.parse(s.m.get("stt_profiles")).length, 2, "idempotent");
});

test("pickKioskTtsProfile prefers the local Kokoro profile; null when absent", async () => {
  const s = settings({ tts_profiles: JSON.stringify([{ id: "edge", provider: "edge" }, { id: "k", provider: "kokoro", baseUrl: "http://localhost:8880/v1" }]) });
  assert.equal((await pickKioskTtsProfile({}, s)).id, "k");
  assert.equal(await pickKioskTtsProfile({}, settings()), null);
});

test("smoke 2026-10-04 lever 2: kioskSttModel maps tiny.en for faster-whisper only; default keeps the profile model", async () => {
  const { kioskSttModel, KIOSK_STT_MODEL_IDS } = await import("../bundles/kiosk/server/profiles.js");
  assert.equal(kioskSttModel({ provider: "fasterwhisper" }, { stt_model: "tiny.en" }), "Systran/faster-whisper-tiny.en");
  assert.equal(kioskSttModel({ provider: "fasterwhisper" }, { stt_model: "default" }), null);
  assert.equal(kioskSttModel({ provider: "fasterwhisper" }, undefined), null);
  assert.equal(kioskSttModel({ provider: "groq" }, { stt_model: "tiny.en" }), null);
  assert.equal(kioskSttModel(null, { stt_model: "tiny.en" }), null);
  const y = read("bundles/faster-whisper-server/docker-compose.yml");
  for (const id of Object.values(KIOSK_STT_MODEL_IDS)) assert.ok(y.includes(id), `${id} is preloaded`);
});
