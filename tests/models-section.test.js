/**
 * The Models page, simple view (roles Phase 2, PR 2a): every role, what fills
 * it, where it runs and its status, server-rendered. Assertions read
 * substrings and counts, never whole documents.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDbClient } from "../servers/db.js";
import { invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import { clearProviderTaskCache } from "../servers/shared/provider-task.js";
import { buildRoleRows } from "../servers/gateway/dashboard/settings/sections/models/rows.js";
import modelsSection, { modelsPreview, noNetworkLookup } from "../servers/gateway/dashboard/settings/sections/models.js";
import { getClassifierStatus } from "../servers/gateway/dashboard/panels/bot-builder/classifier-status.js";
import { shellAvatarSheet } from "../servers/gateway/dashboard/shell/chrome.js";

let dir, db;
const origWarn = console.warn;
const OWN = new Set();
const SECRET = "test-key-never-echo-0123456789";

const ins = (id, url, models, disabled = 0) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled) VALUES (?,?,?,?,?,?)",
    args: [id, url, SECRET, "local", JSON.stringify(models), disabled],
  });
const raw = (key, value) =>
  db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?,?)", args: [key, value] });
const bind = (id, value) => raw(`model_role.${id}`, JSON.stringify(value));

const noClassifier = async () => ({ state: "missing" });
const rowsFor = (opts = {}) =>
  buildRoleRows(db, { env: {}, ownAddrs: OWN, localInstanceId: () => "i-self", classifierStatusFn: noClassifier, ...opts });
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
const count = (s, needle) => s.split(needle).length - 1;
/** The rendered rows only: the change sheet's client script carries the copy too. */
const pageOf = (html) => html.slice(0, html.indexOf('<dialog id="models-change"'));

before(async () => {
  console.warn = () => {};
  dir = mkdtempSync(join(tmpdir(), "models-section-"));
  db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT, host TEXT, bundle_id TEXT,
      description TEXT, models TEXT NOT NULL DEFAULT '[]', disabled INTEGER DEFAULT 0, lamport_ts INTEGER DEFAULT 0,
      instance_id TEXT, provider_type TEXT, gpu_policy TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (key, instance_id));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT, status TEXT, trusted INTEGER DEFAULT 0);
  `);
});
after(() => { console.warn = origWarn; rmSync(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  await db.executeMultiple("DELETE FROM providers; DELETE FROM dashboard_settings; DELETE FROM dashboard_settings_overrides; DELETE FROM pi_bot_defs;");
  await ins("local-chat", "http://127.0.0.1:8003/v1", [{ id: "m1" }]);
  await ins("local-voice", "http://127.0.0.1:8011/v1", [{ id: "m2" }]);
  await ins("gone", "http://127.0.0.1:8099/v1", [{ id: "x" }], 1);
  await bind("voice", { model: "local-voice/m2", seeded: true });
  await bind("everyday", { model: "local-chat/m1" });
  await bind("quick", { model: "gone/x", fallback: [] });
  await raw("tts_profiles", JSON.stringify([
    { id: "k1", name: "Kokoro here", provider: "kokoro", baseUrl: "http://127.0.0.1:8880", apiKey: SECRET, defaultVoice: "af_bella", isDefault: true },
  ]));
  await raw("stt_profiles", JSON.stringify([
    { id: "s9", name: "Hosted ears", provider: "deepgram", apiKey: SECRET, isDefault: false },
  ]));
  invalidateRoleContext();
  clearProviderTaskCache();
});

test("statuses", async () => {
  const rows = await rowsFor();
  const r = byId(rows);
  assert.equal(r.voice.status.code, "default");
  assert.equal(r.voice.seeded, true);
  assert.equal(r.everyday.status.code, "ready");
  assert.equal(r.everyday.chosen, true);
  assert.equal(r.everyday.model.where, "here");
  assert.equal(r.everyday.model.key, "local-chat/m1");
  assert.equal(r.quick.status.code, "not_available");
  assert.equal(r.image.status.code, "not_set_up");
  assert.equal(r.image.model, null);
  assert.equal(r.video.status.code, "not_set_up");
  assert.equal(r.rerank.hidden, true);
  assert.equal(r.expert.status.code, "not_set");
  // Groups and order.
  assert.deepEqual(rows.map((x) => x.id), [
    "coordinator", "quick", "deep", "everyday", "expert", "critic",
    "voice", "stt", "tts", "vision", "embed", "rerank", "safety", "image", "video",
  ]);
  assert.equal(r.voice.group, "speech");
  assert.equal(r.safety.group, "safety");
  assert.equal(r.image.kind, "media");
});

test("fallback status", async () => {
  await bind("quick", { model: "gone/x" }); // default fallback: everyday
  invalidateRoleContext();
  const q = byId(await rowsFor()).quick;
  assert.equal(q.status.code, "fallback");
  assert.equal(q.status.role, "everyday");
  assert.equal(q.model.key, "local-chat/m1");
});

test("env wins", async () => {
  const v = byId(await rowsFor({ env: { COMPANION_FAST_MODEL: "local-chat/m1" } })).voice;
  assert.equal(v.status.code, "env");
  assert.deepEqual(v.pin, { source: "env", name: "COMPANION_FAST_MODEL", value: "local-chat/m1" });
  assert.equal(v.model.key, "local-chat/m1");
});

test("setting pin shows pinned; embed unset shows the consumer's pick", async () => {
  await ins("local-emb", "http://127.0.0.1:8020/v1", [{ id: "e1", task: "embedding" }]);
  invalidateRoleContext();
  let e = byId(await rowsFor()).embed;
  assert.equal(e.status.code, "default");
  assert.equal(e.model.key, "local-emb/e1");
  await raw("embed_provider", "local-emb");
  e = byId(await rowsFor()).embed;
  assert.equal(e.status.code, "pinned");
  assert.deepEqual(e.pin, { source: "setting", name: "embed_provider", value: "local-emb" });
});

test("speech details", async () => {
  const r = byId(await rowsFor());
  assert.equal(r.tts.kind, "speech");
  assert.equal(r.tts.model.label, "Kokoro here");
  assert.equal(r.tts.model.where, "here");
  assert.equal(r.tts.status.code, "ready");
  assert.ok(r.tts.detailsHref.endsWith("subtab=tts"));
  assert.equal(r.stt.status.code, "ready", "the first profile is the default when none is marked");
  assert.equal(r.stt.model.where, "cloud");
  assert.ok(r.stt.detailsHref.endsWith("subtab=stt"));
  assert.ok(!JSON.stringify([r.stt, r.tts]).includes(SECRET), "no profile apiKey in a row");
});

test("speech: an azure profile with no endpoint and the voice bot's own profile", async () => {
  await raw("stt_profiles", JSON.stringify([{ id: "az", name: "Azure", provider: "azure", isDefault: true }]));
  await raw("tts_profiles", JSON.stringify([
    { id: "k1", name: "Kokoro here", provider: "kokoro", baseUrl: "http://127.0.0.1:8880", isDefault: true },
    { id: "k2", name: "Other voice", provider: "kokoro", isDefault: false },
  ]));
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES ('crow.voice', 'Crow', ?)",
    args: [JSON.stringify({ kind: "voice", voice: { tts_profile_id: "k2" } })],
  });
  const r = byId(await rowsFor());
  assert.equal(r.stt.model.where, "cloud");
  assert.deepEqual(r.tts.voiceBot, { profileId: "k2", name: "Other voice" });
  const html = await modelsSection.render({ req: { query: {} }, db, lang: "en" });
  assert.ok(html.includes("The Crow voice bot uses Other voice instead"));
});

test("render", async () => {
  const rows = await rowsFor();
  const html = pageOf(await modelsSection.render({ req: { query: {} }, db, lang: "en" }));
  const visible = rows.filter((r) => !r.hidden).length;
  assert.equal(count(html, 'data-role="'), visible, "one Change button per visible row");
  assert.equal(count(html, 'data-role="rerank"'), 0, "search ranking hidden");
  assert.equal(count(html, "Not set up yet"), 2);
  assert.ok(html.includes('href="/dashboard/settings?section=llm"'), "Advanced link");
  assert.ok(html.includes("Advanced"));
  assert.ok(html.includes("Add a provider"));
  assert.ok(html.includes("Show search ranking"));
  assert.ok(html.includes("Crow&#39;s default") || html.includes("Crow's default") || html.includes("Crow&#x27;s default"));
  assert.ok(html.includes("This box"));
  assert.ok(!html.includes(SECRET), "no provider api_key or speech profile apiKey value");
  assert.ok(!(await modelsSection.render({ req: { query: {} }, db, lang: "en" })).includes(SECRET), "nor in the sheet's script");
  const shown = await modelsSection.render({ req: { query: { show: "rerank" } }, db, lang: "en" });
  assert.equal(count(shown, 'data-role="rerank"'), 1);
  assert.ok(!shown.includes("Show search ranking"));
});

test("fallback renders with the role's name", async () => {
  await bind("quick", { model: "gone/x" });
  invalidateRoleContext();
  const html = await modelsSection.render({ req: { query: {} }, db, lang: "en" });
  assert.ok(html.includes("Using Builder instead"));
});

test("preview counts filled roles", async () => {
  const p = await modelsSection.getPreview({ settings: {}, db, lang: "en" });
  assert.match(p, /^\d+ of 15 roles ready$/);
  assert.match(await modelsSection.getPreview({ settings: {}, db, lang: "es" }), /^\d+ de 15 roles listos$/);
});

test("/dashboard/models unchanged", () => {
  const src = readFileSync(join(import.meta.dirname, "../servers/gateway/dashboard/index.js"), "utf8");
  assert.match(src, /router\.get\("\/dashboard\/models", \(req, res\) => res\.redirect\("\/dashboard\/model-catalog"\)\)/);
  const sheet = shellAvatarSheet({ lang: "en" });
  assert.ok(sheet.includes('href="/dashboard/settings?section=models"'));
  assert.ok(sheet.includes(">Models<"));
  assert.ok(shellAvatarSheet({ lang: "es" }).includes(">Modelos<"));
});

test("es", async () => {
  const html = pageOf(await modelsSection.render({ req: { query: {} }, db, lang: "es" }));
  assert.ok(html.includes("Aún no configurado"));
  assert.ok(html.includes("Añadir un proveedor"));
});

// --- Fix round 1 -------------------------------------------------------------

const insCls = () => ins("local-cls", "http://127.0.0.1:8031/v1", [{ id: "qwen3.5-4b" }]);
const insCloud = () => ins("cloud-a", "https://8.8.8.8/v1", [{ id: "c1" }]);
const realClassifier = { classifierStatusFn: getClassifierStatus };

test("safety bound to a cloud model shows the classifier's automatic pick, not the cloud model", async () => {
  await insCls();
  await insCloud();
  await bind("safety", { model: "cloud-a/c1" });
  invalidateRoleContext();
  const s = byId(await rowsFor(realClassifier)).safety;
  assert.equal(s.chosen, true);
  assert.equal(s.status.code, "default");
  assert.equal(s.model.key, "local-cls/qwen3.5-4b");
  assert.equal(s.refused, true);
  assert.notEqual(s.model.where, "cloud");
  const html = await modelsSection.render({ req: { query: {} }, db, lang: "en" });
  assert.ok(html.includes("Classifier refuses models that aren"), "the refusal is said on the row");
  const safetyCard = html.slice(html.indexOf('data-row-id="safety"'), html.indexOf('data-row-id="image"'));
  assert.ok(!safetyCard.includes(">c1<"), "the refused cloud model is not shown");
  assert.ok(safetyCard.includes(">qwen3.5-4b<"), "the automatic pick is shown");
});

test("safety bound to a local model the classifier takes is ready with it", async () => {
  await insCls();
  await bind("safety", { model: "local-cls/qwen3.5-4b" });
  invalidateRoleContext();
  const s = byId(await rowsFor(realClassifier)).safety;
  assert.equal(s.status.code, "ready");
  assert.equal(s.model.key, "local-cls/qwen3.5-4b");
  assert.equal(s.refused, undefined);
});

test("unset safety shows Crow's default with the classifier's pick", async () => {
  await insCls();
  invalidateRoleContext();
  const s = byId(await rowsFor(realClassifier)).safety;
  assert.equal(s.chosen, false);
  assert.equal(s.status.code, "default");
  assert.equal(s.model.key, "local-cls/qwen3.5-4b");
  assert.equal(s.model.where, "here");
});

test("unset rerank shows Crow's default and stays hidden; bound rerank is visible", async () => {
  await ins("local-rr", "http://127.0.0.1:8032/v1", [{ id: "r1", task: "rerank" }]);
  invalidateRoleContext();
  let r = byId(await rowsFor()).rerank;
  assert.equal(r.status.code, "default");
  assert.equal(r.model.key, "local-rr/r1");
  assert.equal(r.hidden, true);
  await bind("rerank", { model: "local-rr/r1" });
  invalidateRoleContext();
  r = byId(await rowsFor()).rerank;
  assert.equal(r.status.code, "ready");
  assert.equal(r.hidden, false);
  const html = await modelsSection.render({ req: { query: {} }, db, lang: "en" });
  assert.equal(count(html, 'data-role="rerank"'), 1);
  assert.ok(!html.includes("Show search ranking"));
});

test("the menu preview never waits on DNS for the classifier", async () => {
  let given = null;
  const stub = async (_db, opts) => {
    given = opts;
    await opts.lookup("classifier.example"); // a real resolver here could stall the whole menu
    return { state: "missing" };
  };
  const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error("preview waited")), 500));
  const p = await Promise.race([modelsPreview(db, "en", { classifierStatusFn: stub }), deadline]);
  assert.match(p, /^\d+ of 15 roles ready$/);
  assert.equal(given.lookup, noNetworkLookup);
  assert.equal(given.probe, false);
});
