/**
 * Roles phase 2, Task 20: voice applies the strict local check (the owner's ruling (Q2),
 * N4). resolveVoiceKeys reports, per side, whether the key is not proven
 * local (isStrictCloud over every hop, with this box's "This is local"
 * marks), raw constants and env keys included; a key the old host-column
 * check called local logs one disagreement. The voice bot's loader uses the
 * same check for its own key and the router's fast side when it has none.
 * Every DB is a fresh scratch init-db; no model server is reached.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { createClient } from "@libsql/client";
import { resolveVoiceKeys } from "../servers/shared/voice-keys.js";
import llmRouterRouter, { resolveVoiceKeys as routerResolveVoiceKeys, VOICE_ROUTE_KEYS, COMPANION_TURN_MODEL } from "../servers/gateway/routes/llm-router.js";
import { setBinding, invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import { markLocal } from "../servers/shared/provider-local-marks.js";
import { createVoiceBotLoader, fastVoiceKeyFor } from "../servers/gateway/voice/crow-voice.js";
import { CROW_VOICE_BOT_ID } from "../servers/shared/voice-bot.js";

const ROOT = join(import.meta.dirname, "..");
const FAST_KEY = VOICE_ROUTE_KEYS.fast;
const ESC_KEY = VOICE_ROUTE_KEYS.escalate;
const FAST_PROVIDER = FAST_KEY.slice(0, FAST_KEY.indexOf("/"));
const FAST_MODEL = FAST_KEY.slice(FAST_KEY.indexOf("/") + 1);
const ESC_PROVIDER = ESC_KEY.slice(0, ESC_KEY.indexOf("/"));
const ESC_MODEL = ESC_KEY.slice(ESC_KEY.indexOf("/") + 1);
const NO_ENV = {};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "voice-cloud-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: ROOT });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  invalidateRoleContext();
  return { db, cleanup() { invalidateRoleContext(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function provider(db, id, baseUrl, models, { host = null } = {}) {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, host, models) VALUES (?, ?, ?, ?)",
    args: [id, baseUrl, host, JSON.stringify(models.map((m) => ({ id: m })))],
  });
  invalidateRoleContext();
}

/** The raw constants on loopback: proven local. */
async function localDefaults(db) {
  await provider(db, FAST_PROVIDER, "http://127.0.0.1:8011/v1", [FAST_MODEL], { host: "local" });
  await provider(db, ESC_PROVIDER, "http://127.0.0.1:8003/v1", [ESC_MODEL], { host: "local" });
}

async function seedVoiceBot(db, def) {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?, 'Crow', ?, 1, NULL)",
    args: [CROW_VOICE_BOT_ID, JSON.stringify(def)],
  });
}

function captureWarns() {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  return { warns, restore() { console.warn = orig; } };
}

const loader = () => createVoiceBotLoader({ resolveVoiceKeysFn: (db) => resolveVoiceKeys(db, { env: NO_ENV }) });

test("llm-router re-exports resolveVoiceKeys from the light module", () => {
  assert.equal(routerResolveVoiceKeys, resolveVoiceKeys);
});

test("bot without a fast key follows a chosen cloud voice role", async () => {
  const { db, cleanup } = fresh();
  const w = captureWarns();
  try {
    await localDefaults(db);
    await provider(db, "cloud-a", "https://203.0.113.9/v1", ["c1"]);
    await seedVoiceBot(db, { kind: "voice" });
    // Voice unbound: the router's fast side is the raw constant on loopback.
    assert.equal((await loader()(db)).cloud, false);
    assert.deepEqual(await setBinding(db, "voice", { model: "cloud-a/c1" }, { actor: "test" }), { ok: true });
    const k = await resolveVoiceKeys(db, { env: NO_ENV });
    assert.equal(k.fast, "cloud-a/c1");
    assert.equal(k.fastCloud, true);
    assert.equal(k.escalateCloud, false);
    assert.equal((await loader()(db)).cloud, true, "no fast_voice_model: the chosen voice role decides");
  } finally { w.restore(); cleanup(); }
});

test("strict on raw keys: a DNS-named row is not proven local until marked", async () => {
  const { db, cleanup } = fresh();
  const w = captureWarns();
  try {
    await provider(db, FAST_PROVIDER, "http://box.example.internal:8011/v1", [FAST_MODEL], { host: "local" });
    await provider(db, ESC_PROVIDER, "http://127.0.0.1:8003/v1", [ESC_MODEL], { host: "local" });
    const k = await resolveVoiceKeys(db, { env: NO_ENV });
    assert.equal(k.fast, FAST_KEY);
    assert.equal(k.fastRole, null);
    assert.equal(k.fastCloud, true);
    assert.equal(k.escalateCloud, false);
    await resolveVoiceKeys(db, { env: NO_ENV }); // a second resolve does not log again
    const hits = w.warns.filter((x) => x.includes(`voice ${FAST_KEY}`) && x.includes("not proven local"));
    assert.equal(hits.length, 1, JSON.stringify(w.warns));
    assert.deepEqual(await markLocal(db, FAST_PROVIDER, { actor: "test" }), { ok: true });
    assert.equal((await resolveVoiceKeys(db, { env: NO_ENV })).fastCloud, false, "marked: proven local");
  } finally { w.restore(); cleanup(); }
});

test("env key checked too", async () => {
  const { db, cleanup } = fresh();
  const w = captureWarns();
  try {
    await localDefaults(db);
    await provider(db, "cloud-a", "https://203.0.113.9/v1", ["c1"], { host: "cloud" });
    const k = await resolveVoiceKeys(db, { env: { COMPANION_FAST_MODEL: "cloud-a/c1" } });
    assert.equal(k.fast, "cloud-a/c1");
    assert.equal(k.fastCloud, true);
    assert.equal(k.escalateCloud, false);
  } finally { w.restore(); cleanup(); }
});

test("stored cloud flag wins (N4): a host 'cloud' row on a private address is cloud", async () => {
  const { db, cleanup } = fresh();
  const w = captureWarns();
  try {
    await provider(db, FAST_PROVIDER, "http://100.64.20.5:8030/v1", [FAST_MODEL], { host: "cloud" });
    await provider(db, ESC_PROVIDER, "http://127.0.0.1:8003/v1", [ESC_MODEL], { host: "local" });
    const k = await resolveVoiceKeys(db, { env: NO_ENV });
    assert.equal(k.fastCloud, true);
    assert.equal(w.warns.filter((x) => x.includes("not proven local")).length, 0, "the old check agreed: no disagreement");
  } finally { w.restore(); cleanup(); }
});

test("a def's own raw key is checked the same strict way", async () => {
  const { db, cleanup } = fresh();
  const w = captureWarns();
  try {
    await localDefaults(db);
    await provider(db, "boxy", "http://boxy.example.internal:8011/v1", ["m1"], { host: "local" });
    await seedVoiceBot(db, { kind: "voice", fast_voice_model: "boxy/m1" });
    assert.equal((await loader()(db)).cloud, true, "a DNS name is not proven local");
    assert.deepEqual(await markLocal(db, "boxy", { actor: "test" }), { ok: true });
    assert.equal((await loader()(db)).cloud, false, "marked");
  } finally { w.restore(); cleanup(); }
});

test("a def key the turn dials as written is judged as written: a bare role: or a key with no '/' is not proven local", async () => {
  const { db, cleanup } = fresh();
  const w = captureWarns();
  try {
    await localDefaults(db);
    await seedVoiceBot(db, { kind: "voice" });
    assert.equal((await loader()(db)).cloud, false, "control: the router's fast key is on loopback");
    for (const bad of ["role:", "noslash"]) {
      await db.execute("DELETE FROM pi_bot_defs");
      await seedVoiceBot(db, { kind: "voice", fast_voice_model: bad });
      const got = await fastVoiceKeyFor(db, { kind: "voice", fast_voice_model: bad }, { resolveVoiceKeysFn: (d) => resolveVoiceKeys(d, { env: NO_ENV }) });
      assert.deepEqual(got, { key: bad, cloud: true }, bad);
      assert.equal((await loader()(db)).cloud, true, bad);
    }
  } finally { w.restore(); cleanup(); }
});

test("light module: voice-keys.js loads neither express nor the orchestrator", () => {
  const target = pathToFileURL(join(ROOT, "servers/shared/voice-keys.js")).href;
  const script = `
    import { registerHooks } from "node:module";
    const seen = [];
    registerHooks({ resolve(s, c, n) { const r = n(s, c); seen.push(r.url); return r; } });
    await import(${JSON.stringify(target)});
    process.stdout.write(JSON.stringify(seen));
  `;
  const seen = JSON.parse(String(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] })));
  assert.ok(seen.includes(target), "the hook recorded the import graph");
  assert.equal(seen.filter((u) => u.includes("/node_modules/express/") || u === "express").length, 0, "no express");
  assert.equal(seen.filter((u) => u.endsWith("servers/gateway/gpu-orchestrator.js")).length, 0, "no orchestrator");
  assert.equal(seen.filter((u) => u.endsWith("servers/gateway/routes/llm-router.js")).length, 0, "no router");
});

// ---- the route log ---------------------------------------------------------------

let up, upUrl, srv, appUrl, routerDb, routerCleanup;
let routerFastKey = "cloud-a/c1";

before(async () => {
  up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  ({ db: routerDb, cleanup: routerCleanup } = fresh());
  await provider(routerDb, "cloud-a", "https://203.0.113.9/v1", ["c1"], { host: "cloud" });
  await provider(routerDb, "local-v", "http://127.0.0.1:8011/v1", ["v1"], { host: "local" });
  await provider(routerDb, ESC_PROVIDER, "http://127.0.0.1:8003/v1", [ESC_MODEL], { host: "local" });
  const router = llmRouterRouter({
    acquireFn: async () => true,
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers: {} }),
    remoteAddressFn: () => "127.0.0.1",
    doorAuthFn: async () => false,
    recordUsageFn: async () => {},
    resolveVoiceKeysFn: () => resolveVoiceKeys(routerDb, { env: { COMPANION_FAST_MODEL: routerFastKey } }),
  });
  const app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); up?.close(); routerCleanup?.(); });

async function routedLine(fastKey) {
  routerFastKey = fastKey;
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  let r;
  try {
    r = await fetch(`${appUrl}/llm/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: COMPANION_TURN_MODEL, messages: [{ role: "user", content: "What is the capital of Portugal?" }] }),
    });
    await r.text();
  } finally { console.log = orig; }
  assert.equal(r.status, 200);
  const route = lines.filter((l) => l.includes("[llm-router] route=fast"));
  assert.equal(route.length, 1, JSON.stringify(lines));
  return route[0];
}

test("log: a routed chat turn logs cloud=<bool>", async () => {
  const cloudLine = await routedLine("cloud-a/c1");
  assert.match(cloudLine, /-> cloud-a\/c1 .* cloud=true /);
  // Local control: an env fast key on loopback logs cloud=false.
  const localLine = await routedLine("local-v/v1");
  assert.match(localLine, /-> local-v\/v1 .* cloud=false /);
});
