/**
 * Model roles Phase 1, Task 7: the Phone keys accept `role:<id>`, the local
 * slot fails closed when its role lands on a cloud (or unproven) upstream, and
 * the model DELETE confirm lists the role bindings it would break. Every DB
 * here is a fresh scratch init-db; no live data, no call is placed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createClient } from "@libsql/client";
import { initPhoneTables } from "../bundles/phone/server/init-tables.js";
import { setBinding, invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import { providerBindings } from "../servers/gateway/models/manager.js";
import { freshLibsql, seedSession, authHeaders, withServer } from "./fixtures/models-routes-harness.mjs";

const ROOT = join(import.meta.dirname, "..");
const s = {};
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_APP_ROOT: process.env.CROW_APP_ROOT, PHONE_RUNNER_SECRET: process.env.PHONE_RUNNER_SECRET };
const savedWarn = console.warn;

const PROVIDERS = [
  ["local-voice", "http://127.0.0.1:8011/v1", "local", "m2"],
  ["local-chat", "http://127.0.0.1:8002/v1", "local", "m1"],
  ["cloud-a", "https://api.example.com/v1", "cloud", "m9"],
  // host 'local' on purpose: the role path never trusts the host column.
  ["local-box", "http://box.crow.example.ts.net:8011/v1", "local", "m3"],
];

before(async () => {
  s.home = mkdtempSync(join(tmpdir(), "phone-roles-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: s.home }, stdio: "pipe", cwd: ROOT,
  });
  process.env.CROW_HOME = s.home;
  process.env.CROW_APP_ROOT = ROOT;
  s.secret = "e".repeat(48); process.env.PHONE_RUNNER_SECRET = s.secret;
  s.warns = [];
  console.warn = (...a) => { s.warns.push(a.join(" ")); };
  s.db = createClient({ url: "file:" + join(s.home, "crow.db") });
  for (const [id, url, host, m] of PROVIDERS) {
    await s.db.execute({ sql: "INSERT INTO providers (id, base_url, host, models) VALUES (?, ?, ?, ?)", args: [id, url, host, JSON.stringify([{ id: m }])] });
  }
  await initPhoneTables(s.db);
  invalidateRoleContext();
  assert.deepEqual(await setBinding(s.db, "voice", { model: "local-voice/m2" }), { ok: true });
  assert.deepEqual(await setBinding(s.db, "expert", { model: "cloud-a/m9" }), { ok: true });
  assert.deepEqual(await setBinding(s.db, "quick", { model: "local-box/m3" }), { ok: true });

  const mod = await import("../bundles/phone/panel/routes.js");
  s.resolveModelSpec = mod.resolveModelSpec;
  const auth = (req, res, next) => { const sess = req.headers["x-test-session"]; if (!sess) return res.status(401).end(); req.dashboardSession = sess; next(); };
  s.ready = new Promise((r) => { s.onDispatcher = r; });
  const router = mod.default(auth, {
    db: s.db, csrf: (req, res, next) => next(),
    runner: { farend: async () => ({ ok: true }), stop: async () => ({ ok: true }), events: async () => ({ events: [], done: false, active: false }) },
    authority: { isLocalDashboardSession: async (_db, sess) => sess === "local", stepUpOk: async (code) => code === "123456", totpRequired: async () => false },
    notifyCard: async () => ({ delivered: false }),
    createDispatcher: () => ({ tick: async () => {} }),
    onDispatcher: (d) => s.onDispatcher(d),
  });
  const app = express(); app.use(router);
  s.http = app.listen(0); await new Promise((r) => s.http.once("listening", r));
  s.base = `http://127.0.0.1:${s.http.address().port}`;
  s.disp = await Promise.race([s.ready, new Promise((r) => setTimeout(() => r(null), 5000).unref())]);
});

after(async () => {
  if (s.http) await new Promise((r) => s.http.close(r)); try { s.db.close(); } catch {}
  invalidateRoleContext();
  rmSync(s.home, { recursive: true, force: true });
  console.warn = savedWarn;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const post = (body) => fetch(s.base + "/api/phone/settings", { method: "POST", headers: { "Content-Type": "application/json", "x-test-session": "local" }, body: JSON.stringify({ totp: "123456", ...body }) });
const setting = async (k) => (await s.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [k] })).rows[0]?.value;

test("save role ref", async () => {
  const r = await post({ localModel: "role:voice" });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(await setting("phone_local_model"), "role:voice");
});

test("local slot refuses cloud role", async () => {
  const before = await setting("phone_local_model");
  const r = await post({ localModel: "role:expert" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "invalid_model", message: "The local model cannot use a cloud provider." });
  assert.equal(await setting("phone_local_model"), before, "nothing stored");
});

test("local slot refuses an unknown-host role", async () => {
  const r = await post({ localModel: "role:quick" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).message, "The local model cannot use a cloud provider.");
  // The same role is fine for the cloud slot: only the local slot is fenced.
  assert.equal((await post({ cloudModel: "role:quick" })).status, 200);
  assert.equal((await post({ cloudModel: "" })).status, 200);
});

test("unknown role refused", async () => {
  const r = await post({ cloudModel: "role:c-gone" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "invalid_model", message: 'Role "c-gone" is not set up on this Crow.' });
  assert.equal(await setting("phone_cloud_model"), "");
});

test("local role rebound to cloud fails closed at refresh", async () => {
  assert.equal((await post({ localModel: "role:voice" })).status, 200);
  await s.disp.refresh();
  const live = s.disp.settings().model({ allow_cloud: false });
  assert.deepEqual(live, { base_url: "http://127.0.0.1:8011/v1", api_key: "none", model: "m2", label: "local-voice/m2" }, "positive control: the row lookup of the resolved key");

  assert.deepEqual(await setBinding(s.db, "voice", { model: "cloud-a/m9" }), { ok: true });
  s.warns.length = 0;
  await s.disp.refresh();
  await s.disp.refresh();
  assert.deepEqual(await s.resolveModelSpec(s.db, "role:voice", { local: true }), { error: "local_now_cloud" });
  assert.equal(s.disp.settings().model({ allow_cloud: false }), null);
  assert.equal(s.warns.filter((w) => w.includes("local_now_cloud") || w.includes("cloud provider")).length, 1, "logged once: " + JSON.stringify(s.warns));
  // The cloud slot is not fenced: the same role still resolves there.
  assert.equal((await s.resolveModelSpec(s.db, "role:voice")).base_url, "https://api.example.com/v1");
  assert.deepEqual(await setBinding(s.db, "voice", { model: "local-voice/m2" }), { ok: true });
  await s.disp.refresh();
  assert.equal(s.disp.settings().model({ allow_cloud: false }).model, "m2", "recovers once the role is local again");
});

test("local slot judges the live row it dials, not a stale context", async () => {
  invalidateRoleContext();
  // Warm the memoized role context while local-voice is local.
  assert.equal((await s.resolveModelSpec(s.db, "role:voice", { local: true })).base_url, "http://127.0.0.1:8011/v1");
  // The row moves to a cloud URL with no change event: the context (memoized up to 1 s) still says local.
  await s.db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = 'local-voice'", args: ["https://api.example.com/v1"] });
  try {
    assert.deepEqual(await s.resolveModelSpec(s.db, "role:voice", { local: true }), { error: "local_now_cloud" });
    // The cloud slot is not fenced and dials the live row.
    assert.equal((await s.resolveModelSpec(s.db, "role:voice")).base_url, "https://api.example.com/v1");
  } finally {
    await s.db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = 'local-voice'", args: ["http://127.0.0.1:8011/v1"] });
    invalidateRoleContext();
  }
});

test("raw keys unchanged", async () => {
  assert.deepEqual(await s.resolveModelSpec(s.db, "local-voice/m2"),
    { base_url: "http://127.0.0.1:8011/v1", api_key: "none", model: "m2", label: "local-voice/m2" });
  // A raw cloud key in the local slot is still refused by the host column, as today.
  assert.equal((await post({ localModel: "cloud-a/m9" })).status, 400);
  // A raw key is never cloud-checked by URL: an unproven host with host='local' passes, as today.
  assert.equal((await post({ localModel: "local-box/m3" })).status, 200);
  assert.equal(await s.resolveModelSpec(s.db, "nope/m"), null);
  assert.equal(await s.resolveModelSpec(s.db, ""), null);
});

test("delete confirm lists roles", async () => {
  const h = freshLibsql("phone-roles-models-");
  try {
    await h.db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
      args: ["model_role.everyday", JSON.stringify({ model: "local-chat/m1", seeded: true, at: "2026-10-28T00:00:00.000Z" })] });
    await h.db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
      args: ["model_role.deep", JSON.stringify({ model: "local-chatty/m1", at: "2026-10-28T00:00:00.000Z" })] });
    const b = await providerBindings(h.db, "local-chat");
    assert.deepEqual(b.roles, [{ roleId: "everyday", model: "local-chat/m1", seeded: true }]);

    const token = await seedSession(h.db);
    await withServer({
      dir: h.dir,
      loadCatalogFn: () => ({ models: [] }),
      loadStateFn: () => ({ registry: { "local-chat": { file: "x.gguf" } } }),
      listProvidersAllFn: async () => [{ id: "local-chat", disabled: 0, gpuPolicy: { runtime: "native", catalogId: "local-chat", owner: "me" } }],
      ownInstanceIdFn: () => "me",
    }, async (base) => {
      const r = await fetch(`${base}/api/models/local-chat`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.requiresConfirm, true);
      assert.deepEqual(body.bindings.roles, [{ roleId: "everyday", model: "local-chat/m1", seeded: true }]);
    });
  } finally { await h.cleanup(); }
});

test("manifest bumped", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "bundles", "phone", "manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.2.6");
});
