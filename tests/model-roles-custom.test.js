/**
 * Custom roles (roles Phase 2, PR 2d Task 18): your own roles, with a "may use
 * big models" switch. Ids, writes, the previewed edit, the in-use delete
 * refusal, and the route order on the roles API router.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import express from "express";
import { createDbClient } from "../servers/db.js";
import { parseBindingRows, resolveRoleKey } from "../servers/shared/model-roles.js";
import {
  customRoleIdFor, saveCustomRole, deleteCustomRole, invalidateRoleContext, readCustomRoleDefs, addBindingsChangeListener,
} from "../servers/shared/model-roles-store.js";
import { previewCustomRoleEdit } from "../servers/shared/role-change.js";
import { customRoleConsumers } from "../servers/shared/role-consumers.js";
import { clearProviderTaskCache } from "../servers/shared/provider-task.js";
import rolesApiRouter from "../servers/gateway/routes/roles-api.js";
import { buildRoleRows } from "../servers/gateway/dashboard/settings/sections/models/rows.js";
import { renderModelsPage } from "../servers/gateway/dashboard/settings/sections/models.js";
import { customRolesClientJS } from "../servers/gateway/dashboard/settings/sections/models/client.js";

let dir, db;
const origWarn = console.warn;
const OWN = new Set();
const SECRET = "fixture-secret-never-echo-0123456789";

const ins = (id, url, models, gpuPolicy = null) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled, gpu_policy) VALUES (?,?,?,?,?,0,?)",
    args: [id, url, SECRET, "local", JSON.stringify(models), gpuPolicy ? JSON.stringify(gpuPolicy) : null],
  });
const raw = (key, value) =>
  db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?,?)", args: [key, value] });
const settingOf = async (key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value ?? null;
const consumersFn = (d, id) => customRoleConsumers(d, id, { env: {} });

const dbFactory = () => new Proxy(db, { get: (t, k) => (k === "close" ? () => {} : Reflect.get(t, k)) });
const passGate = (req, _res, next) => next();

function startApp(opts = {}) {
  const app = express();
  app.use(express.json());
  app.use(rolesApiRouter({ dbFactory, sessionGate: passGate, env: {}, ownAddrs: OWN, localInstanceId: () => "i-self", ...opts }));
  return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}

function call(server, method, path, { body, headers = {} } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server.address().port, path, method,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const withServer = async (fn, opts) => {
  const s = await startApp(opts);
  try { return await fn(s); } finally { s.close(); }
};

before(async () => {
  console.warn = () => {};
  dir = mkdtempSync(join(tmpdir(), "roles-custom-"));
  db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT, host TEXT, bundle_id TEXT,
      description TEXT, models TEXT NOT NULL DEFAULT '[]', disabled INTEGER DEFAULT 0, lamport_ts INTEGER DEFAULT 0,
      instance_id TEXT, provider_type TEXT, gpu_policy TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (key, instance_id));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL DEFAULT '* * * * *');
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, tasks_db_uri TEXT);
    CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT, status TEXT, trusted INTEGER DEFAULT 0);
  `);
});
after(() => { console.warn = origWarn; rmSync(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  await db.executeMultiple("DELETE FROM providers; DELETE FROM dashboard_settings; DELETE FROM dashboard_settings_overrides; DELETE FROM pi_bot_defs;");
  await ins("local-chat", "http://127.0.0.1:8003/v1", [{ id: "m1" }]);
  // A windowed catalog model (registry/model-catalog.json): runs only in a model window.
  await ins("big", "http://127.0.0.1:8090/v1", [{ id: "b1" }], { catalogId: "glm-5.3-flash" });
  invalidateRoleContext();
  clearProviderTaskCache();
});

const coder = async (allowHeavy = true) => {
  await raw("model_role_def.c-coder", JSON.stringify({ label: "Coder", job: "Writes code", capability: "chat", ...(allowHeavy ? { allowHeavy: true } : {}) }));
  await raw("model_role.c-coder", JSON.stringify({ model: "big/b1" }));
  invalidateRoleContext();
};

// --- the flag -----------------------------------------------------------------

test("big models flag", () => {
  const providers = [{ id: "big", baseUrl: "http://10.0.0.5:8000/v1", host: "local", disabled: false, models: [{ id: "b1" }], gpuPolicy: { catalogId: "big-cat" } }];
  const models = { providers: { big: { models: [{ id: "b1" }] } } };
  const catalog = [{ id: "big-cat", serving: { class: "windowed" } }];
  const rows = (def) => [
    { key: "model_role_def.c-coder", value: JSON.stringify(def) },
    { key: "model_role.c-coder", value: JSON.stringify({ model: "big/b1" }) },
  ];
  const run = (def) => {
    const { bindings, customDefs } = parseBindingRows(rows(def));
    return resolveRoleKey("role:c-coder", { bindings, customDefs, providers, models, catalog });
  };
  assert.equal(run({ label: "Coder", capability: "chat", allowHeavy: true }).key, "big/b1");
  const off = run({ label: "Coder", capability: "chat" });
  assert.equal(off.key, null);
  assert.equal(off.reason, "not_configured");
  // Only a boolean true survives the parser.
  const { customDefs } = parseBindingRows(rows({ label: "Coder", capability: "chat", allowHeavy: "yes" }));
  assert.equal("allowHeavy" in customDefs["c-coder"], false);
  assert.equal(run({ label: "Coder", capability: "chat", allowHeavy: "yes" }).key, null);
  assert.equal(parseBindingRows(rows({ label: "Coder", capability: "chat", allowHeavy: true })).customDefs["c-coder"].allowHeavy, true);
});

// --- ids and writes -------------------------------------------------------------

test("ids", async () => {
  assert.equal(customRoleIdFor("Coder", ["c-coder"]), "c-coder-2");
  assert.equal(customRoleIdFor("Coder", ["c-coder", "c-coder-2"]), "c-coder-3");
  assert.equal(customRoleIdFor("!!!", []), "c-role");
  assert.equal(customRoleIdFor("Código rápido", []), "c-codigo-rapido");
  assert.equal(customRoleIdFor("EVERYDAY", []), "c-everyday", "never a core id");
  assert.equal(customRoleIdFor("role:safety", []), "c-role-safety", "no role: syntax survives");
  const long = customRoleIdFor("a".repeat(40), ["c-" + "a".repeat(32)]);
  assert.match(long, /^c-[a-z0-9-]{1,32}$/, "a suffix still fits the id rule");
  assert.notEqual(long, "c-" + "a".repeat(32));

  assert.deepEqual(await saveCustomRole(db, { label: "x".repeat(41), capability: "chat" }), { ok: false, reason: "invalid_label" });
  assert.deepEqual(await saveCustomRole(db, { label: "   ", capability: "chat" }), { ok: false, reason: "invalid_label" });
  assert.deepEqual(await saveCustomRole(db, { label: "Ears", capability: "transcription" }), { ok: false, reason: "invalid_capability" });
  assert.deepEqual(await saveCustomRole(db, { label: "Guard", capability: "safety" }), { ok: false, reason: "invalid_capability" });
  // Editing names an existing custom role; a core id, an odd case or a role: ref is unknown.
  for (const id of ["everyday", "C-Coder", "role:c-coder", "c-nope", "custom"]) {
    assert.deepEqual(await saveCustomRole(db, { id, label: "Coder", capability: "chat" }), { ok: false, reason: "unknown_role" }, id);
  }

  let fired = 0;
  const off = addBindingsChangeListener(() => { fired++; });
  try {
    const r = await saveCustomRole(db, { label: "  Coder  ", job: "Writes code", capability: "chat", allowHeavy: true }, { actor: "dashboard:owner" });
    assert.deepEqual(r, { ok: true, id: "c-coder" });
    assert.deepEqual(JSON.parse(await settingOf("model_role_def.c-coder")), { label: "Coder", job: "Writes code", capability: "chat", allowHeavy: true });
    const r2 = await saveCustomRole(db, { label: "Coder", capability: "vision", allowHeavy: "yes" });
    assert.deepEqual(r2, { ok: true, id: "c-coder-2" });
    assert.deepEqual(JSON.parse(await settingOf("model_role_def.c-coder-2")), { label: "Coder", job: "", capability: "vision" });
    assert.equal(fired, 2);
  } finally { off(); }
  const defs = await readCustomRoleDefs(db);
  assert.deepEqual(Object.keys(defs).sort(), ["c-coder", "c-coder-2"]);
});

test("a stale binding row is never inherited by a new role's id", async () => {
  await raw("model_role.c-coder", JSON.stringify({ model: "big/b1" }));
  const r = await saveCustomRole(db, { label: "Coder", capability: "chat" });
  assert.equal(r.id, "c-coder-2");
});

// --- the previewed edit ------------------------------------------------------------

test("edit previewed", async () => {
  await coder(true);
  const pv = await previewCustomRoleEdit(db, "c-coder", { label: "Coder", capability: "chat", allowHeavy: false }, { env: {}, ownAddrs: OWN });
  assert.equal(pv.current.key, "big/b1");
  assert.equal(pv.next.key, null);
  assert.equal(typeof pv.previewHash, "string");
  const same = await previewCustomRoleEdit(db, "c-coder", { label: "Coder", capability: "chat", allowHeavy: true }, { env: {}, ownAddrs: OWN });
  assert.notEqual(same.previewHash, pv.previewHash, "the hash covers the definition");

  await withServer(async (s) => {
    const body = { id: "c-coder", label: "Coder", job: "Writes code", capability: "chat", allowHeavy: false };
    const no = await call(s, "POST", "/api/roles/custom", { body });
    assert.equal(no.status, 409);
    assert.equal(no.json.reason, "needs_preview");
    assert.equal(no.json.preview.next.key, null);
    assert.equal(JSON.parse(await settingOf("model_role_def.c-coder")).allowHeavy, true, "nothing written");

    const p = await call(s, "POST", "/api/roles/custom/c-coder/preview", { body });
    assert.equal(p.status, 200);
    assert.equal(p.json.next.key, null);
    const bad = await call(s, "POST", "/api/roles/custom", { body: { ...body, previewHash: "nope" } });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.reason, "preview_changed");
    const ok = await call(s, "POST", "/api/roles/custom", { body: { ...body, previewHash: p.json.previewHash } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, id: "c-coder" });
    assert.equal("allowHeavy" in JSON.parse(await settingOf("model_role_def.c-coder")), false);

    // A label-only edit needs no preview.
    const rename = await call(s, "POST", "/api/roles/custom", { body: { ...body, label: "Code writer" } });
    assert.equal(rename.status, 200);
    assert.equal(JSON.parse(await settingOf("model_role_def.c-coder")).label, "Code writer");
    assert.equal(rename.text.includes(SECRET), false);
  });
});

// --- delete -----------------------------------------------------------------------

test("delete refused while in use", async () => {
  await coder(false);
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)",
    args: ["b1", "Night bot", JSON.stringify({ models: { default: "role:c-coder" } })],
  });
  let r = await deleteCustomRole(db, "c-coder", { consumersFn });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "in_use");
  assert.ok(r.consumers.some((c) => c.id === "b1"), "lists the bot");

  await db.execute("DELETE FROM pi_bot_defs");
  await raw("model_role.everyday", JSON.stringify({ model: "local-chat/m1", fallback: ["c-coder"] }));
  invalidateRoleContext();
  r = await deleteCustomRole(db, "c-coder", { consumersFn });
  assert.equal(r.reason, "in_use");
  assert.deepEqual(r.consumers.map((c) => c.id), ["everyday"]);
  assert.equal(r.consumers[0].labelKey, "settings.roles.everyday");

  await raw("model_role.everyday", JSON.stringify({ model: "role:c-coder" }));
  invalidateRoleContext();
  assert.equal((await deleteCustomRole(db, "c-coder", { consumersFn })).reason, "in_use", "a role: binding counts too");

  await raw("model_role.everyday", JSON.stringify({ model: "local-chat/m1" }));
  invalidateRoleContext();
  let fired = 0;
  const off = addBindingsChangeListener(() => { fired++; });
  try {
    assert.deepEqual(await deleteCustomRole(db, "c-coder", { consumersFn }), { ok: true });
  } finally { off(); }
  assert.equal(await settingOf("model_role_def.c-coder"), null);
  assert.equal(await settingOf("model_role.c-coder"), null);
  assert.equal(fired, 1);
  assert.equal((await deleteCustomRole(db, "c-coder", { consumersFn })).reason, "unknown_role");
});

test("core undeletable", async () => {
  assert.deepEqual(await deleteCustomRole(db, "everyday"), { ok: false, reason: "core_role" });
  assert.equal((await deleteCustomRole(db, "EVERYDAY", { consumersFn })).reason, "core_role", "case-insensitive");
  assert.equal((await deleteCustomRole(db, "role:c-x", { consumersFn })).reason, "unknown_role");
});

// --- routes -----------------------------------------------------------------------

test("route order", async () => {
  await withServer(async (s) => {
    const r = await call(s, "POST", "/api/roles/custom", { body: { label: "Coder", job: "Writes code", capability: "chat", allowHeavy: true } });
    assert.equal(r.status, 200, "not answered by /api/roles/:id");
    assert.deepEqual(r.json, { ok: true, id: "c-coder" });
    const bad = await call(s, "POST", "/api/roles/custom", { body: { label: "", capability: "chat" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.reason, "invalid_label");
    // The new role is a known role for the existing routes.
    const picks = await call(s, "GET", "/api/roles/c-coder/picks");
    assert.equal(picks.status, 200);

    await db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)",
      args: ["b1", "Night bot", JSON.stringify({ models: { default: "role:c-coder" } })],
    });
    const del = await call(s, "DELETE", "/api/roles/custom/c-coder");
    assert.equal(del.status, 409);
    assert.equal(del.json.reason, "in_use");
    assert.ok(del.json.consumers.some((c) => c.id === "b1" && c.label === "Night bot"));
    const core = await call(s, "DELETE", "/api/roles/custom/everyday");
    assert.equal(core.status, 400);
    assert.equal(core.json.reason, "core_role");
    const missing = await call(s, "DELETE", "/api/roles/custom/c-nope");
    assert.equal(missing.status, 404);

    await db.execute("DELETE FROM pi_bot_defs");
    const gone = await call(s, "DELETE", "/api/roles/custom/c-coder");
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.json, { ok: true });
    // `custom` is still no role of its own.
    assert.equal((await call(s, "GET", "/api/roles/custom/picks")).status, 404);
  });
});

test("custom routes are CSRF gated and session gated", async () => {
  await withServer(async (s) => {
    const cookie = "crow_session=s1; crow_csrf=tok123";
    for (const [method, path] of [["POST", "/api/roles/custom"], ["POST", "/api/roles/custom/c-coder/preview"], ["DELETE", "/api/roles/custom/c-coder"]]) {
      const r = await call(s, method, path, { body: { label: "Coder", capability: "chat" }, headers: { cookie } });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  });
  const deny = (_req, res) => res.status(401).json({ code: "UNAUTHENTICATED" });
  await withServer(async (s) => {
    for (const [method, path] of [["POST", "/api/roles/custom"], ["POST", "/api/roles/custom/c-coder/preview"], ["DELETE", "/api/roles/custom/c-coder"]]) {
      assert.equal((await call(s, method, path, { body: {} })).status, 401, `${method} ${path}`);
    }
  }, { sessionGate: deny });
});

// --- the Models page -------------------------------------------------------------

const PINNED = new Date("2026-11-01T00:00:00Z");
const noClassifier = async () => ({ state: "missing" });
const rowsFor = () => buildRoleRows(db, { env: {}, ownAddrs: OWN, localInstanceId: () => "i-self", classifierStatusFn: noClassifier });

test("custom rows: own name and job, the big-models line, Edit only on custom rows", async () => {
  await coder(true);
  await raw("model_role_def.c-eyes", JSON.stringify({ label: "Eyes <b>", job: "", capability: "vision" }));
  invalidateRoleContext();
  const rows = await rowsFor();
  const custom = rows.filter((r) => r.group === "custom");
  assert.deepEqual(custom.map((r) => r.id), ["c-coder", "c-eyes"], "sorted by name");
  const c = custom[0];
  assert.equal(c.label, "Coder");
  assert.equal(c.job, "Writes code");
  assert.equal(c.allowHeavy, true);
  assert.equal(c.status.code, "ready");
  assert.equal(c.model.key, "big/b1");
  for (const lang of ["en", "es"]) {
    const html = renderModelsPage(rows, { lang, now: PINNED });
    const page = html.slice(0, html.indexOf('<dialog id="models-change"'));
    assert.equal(page.split("data-custom-edit=").length - 1, 2, "one Edit per custom row");
    assert.equal(page.split("data-custom-add").length - 1, 1, "one Add a role");
    assert.ok(page.includes(lang === "en" ? "May use big models (they only run in a model window)" : "Puede usar modelos grandes (solo funcionan en una ventana de modelo)"));
    assert.equal(page.split("mr-big").length - 1, 1, "only the role that may use big models says so");
    assert.ok(page.includes("Eyes &lt;b&gt;") && !page.includes("Eyes <b>"), "the name is escaped");
    assert.ok(page.includes('data-role="c-coder"'), "a custom role has the Change button");
    assert.equal(html.split('id="models-custom"').length - 1, 1);
  }
  // Core rows carry no edit or delete control.
  const coreHtml = renderModelsPage(rows.filter((r) => !r.custom), { lang: "en", now: PINNED });
  const core = coreHtml.slice(0, coreHtml.indexOf('<dialog id="models-change"'));
  assert.equal(core.includes("data-custom-edit="), false);
  assert.equal(core.includes("data-custom-delete"), false, "no delete control on the page's rows");
  assert.ok(core.includes("data-custom-add"), "Your roles is shown so a first role can be added");
});

test("a fallback to a custom role names it by its own label", async () => {
  await coder(false);
  await raw("model_role.c-coder", JSON.stringify({ model: "local-chat/m1" }));
  await raw("model_role.quick", JSON.stringify({ model: "gone/x", fallback: ["c-coder"] }));
  invalidateRoleContext();
  const rows = await rowsFor();
  const quick = rows.find((r) => r.id === "quick");
  assert.equal(quick.status.code, "fallback");
  assert.equal(quick.status.roleLabel, "Coder");
  assert.ok(renderModelsPage(rows, { lang: "en", now: PINNED }).includes("Using Coder instead"));
});

// --- the custom-role sheet (client) ------------------------------------------------

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {};
    this._text = ""; this.className = ""; this.disabled = false; this.checked = false; this.hidden = false;
    this.type = ""; this.value = ""; this.open = false;
  }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  fire(t) { for (const fn of this.listeners[t] || []) fn({ type: t, target: this }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const walk = (n, out = []) => { out.push(n); for (const c of n.children) walk(c, out); return out; };
const one = (root, attr) => walk(root).find((n) => n.hasAttribute(attr));
const jsonRes = (status, data) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => "application/json" }, json: async () => data });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function sheet(replies, lang = "en") {
  const dialog = new El("dialog");
  const add = new El("button"); add.setAttribute("data-custom-add", "");
  const edit = new El("button");
  for (const [k, v] of Object.entries({ "data-custom-edit": "c-coder", "data-custom-label": "Coder", "data-custom-job": "Writes code", "data-custom-capability": "chat", "data-custom-heavy": "true" })) edit.setAttribute(k, v);
  const doc = {
    cookie: "crow_csrf=tok%2D1", createElement: (t) => new El(t),
    getElementById: (id) => (id === "models-custom" ? dialog : null),
    querySelectorAll: (sel) => (sel === "[data-custom-add], [data-custom-edit]" ? [add, edit] : []),
    addEventListener() {},
  };
  const calls = [], visits = [];
  const fetchStub = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return replies.shift()(url, init);
  };
  new Function("document", "fetch", "window", "location", customRolesClientJS({ lang }))(doc, fetchStub, { Turbo: { visit: (h) => visits.push(h) } }, { href: "/x", reload() {} });
  return { dialog, add, edit, calls, visits };
}

test("the sheet source: no backtick, textContent only, both languages", () => {
  for (const lang of ["en", "es"]) {
    const src = customRolesClientJS({ lang });
    assert.equal(src.includes("`"), false);
    assert.equal(src.includes("innerHTML"), false);
    assert.ok(src.includes("/api/roles/custom") && src.includes("X-Crow-Csrf"));
  }
  assert.ok(customRolesClientJS({ lang: "es" }).includes("Puede usar modelos grandes"));
});

test("Add a role posts the form; an edit that moves the role shows the preview, then saves with its hash", async () => {
  const h = sheet([
    () => jsonRes(200, { ok: true, id: "c-reader" }),
    () => jsonRes(409, { ok: false, reason: "needs_preview", preview: { next: { key: null }, consumers: { unattended: [{ kind: "bot", id: "b1", label: "Night bot" }] }, needs: { ackUnattended: true, ackCloud: false }, previewHash: "h1" } }),
    () => jsonRes(200, { ok: true, id: "c-coder" }),
  ]);
  h.add.fire("click");
  assert.equal(h.dialog.open, true);
  assert.equal(one(h.dialog, "data-custom-delete").hidden, true, "a new role has no Delete");
  one(h.dialog, "data-custom-name").value = "Reader";
  one(h.dialog, "data-custom-save").fire("click");
  await flush();
  assert.equal(h.calls[0].url, "/api/roles/custom");
  assert.equal(h.calls[0].headers["X-Crow-Csrf"], "tok-1");
  assert.deepEqual(h.calls[0].body, { label: "Reader", job: "", capability: "chat", allowHeavy: false });
  assert.equal(h.visits.length, 1);

  h.edit.fire("click");
  assert.equal(one(h.dialog, "data-custom-heavy").checked, true);
  assert.equal(one(h.dialog, "data-custom-delete").hidden, false);
  one(h.dialog, "data-custom-heavy").checked = false;
  one(h.dialog, "data-custom-save").fire("click");
  await flush();
  assert.equal(h.calls[1].body.id, "c-coder");
  assert.equal(h.calls[1].body.allowHeavy, false);
  assert.equal("previewHash" in h.calls[1].body, false);
  const warn = one(h.dialog, "data-custom-warn");
  assert.ok(warn.textContent.includes("After this change it has no model it can use."));
  assert.ok(warn.textContent.includes("Night bot"));
  const save = one(h.dialog, "data-custom-save");
  assert.equal(save.disabled, true, "waits for the unattended ack");
  const ack = one(h.dialog, "data-custom-ack");
  ack.checked = true; ack.fire("change");
  assert.equal(save.disabled, false);
  save.fire("click");
  await flush();
  assert.equal(h.calls[2].body.previewHash, "h1");
  assert.equal(h.calls[2].body.ackUnattended, true);
  assert.equal(h.visits.length, 2);
});

test("Delete asks once more, then lists what still uses the role", async () => {
  const h = sheet([() => jsonRes(409, { ok: false, reason: "in_use", consumers: [{ kind: "bot", id: "b1", label: "Night bot" }, { kind: "role", id: "everyday", labelKey: "settings.roles.everyday" }] })]);
  h.edit.fire("click");
  const del = one(h.dialog, "data-custom-delete");
  del.fire("click");
  assert.equal(h.calls.length, 0, "the first tap only asks");
  assert.ok(one(h.dialog, "data-custom-warn").textContent.includes("Delete Coder?"));
  del.fire("click");
  await flush();
  assert.equal(h.calls[0].method, "DELETE");
  assert.equal(h.calls[0].url, "/api/roles/custom/c-coder");
  assert.equal(h.calls[0].headers["X-Crow-Csrf"], "tok-1");
  assert.equal(one(h.dialog, "data-custom-error").textContent, "This role is in use, so it can't be deleted. Used by: Night bot, Builder");
  assert.equal(h.visits.length, 0);
});
