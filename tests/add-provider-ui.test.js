/**
 * Add a provider on the Models page (roles phase 2b, Task 12): the sheet's
 * HTML, its client JS (run against a tiny fake DOM with a stubbed fetch), and
 * the page wiring. Assertions read substrings, counts and single nodes, never
 * a whole document.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROVIDER_PRESETS } from "../servers/shared/provider-presets.js";
import { addProviderSheetHtml, addProviderClientJS } from "../servers/gateway/dashboard/shared/add-provider-ui.js";
import { createDbClient } from "../servers/db.js";
import { invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import { clearProviderTaskCache } from "../servers/shared/provider-task.js";
import modelsSection from "../servers/gateway/dashboard/settings/sections/models.js";

const count = (s, needle) => s.split(needle).length - 1;
/** Pinned before the recommendations' review date, so whole-page renders never drift. */
const PINNED = new Date("2026-11-01T00:00:00Z");

// --- the sheet's HTML ----------------------------------------------------------

test("one option per preset, in order", () => {
  const html = addProviderSheetHtml({ lang: "en" });
  const select = html.slice(html.indexOf('data-ap="preset"'), html.indexOf("</select>", html.indexOf('data-ap="preset"')));
  assert.equal(count(select, "<option "), PROVIDER_PRESETS.length);
  let at = -1;
  for (const p of PROVIDER_PRESETS) {
    const i = select.indexOf(`value="${p.id}"`);
    assert.ok(i > at, `${p.id} in order`);
    at = i;
  }
  assert.ok(select.includes(">OpenRouter<"));
  assert.ok(select.includes(">Other (OpenAI-compatible)<"));
  assert.ok(addProviderSheetHtml({ lang: "es" }).includes(">Otro (compatible con OpenAI)<"));
});

test("the key field is a password field that is never filled", () => {
  const html = addProviderSheetHtml({ lang: "en" });
  const tag = html.slice(html.lastIndexOf("<input", html.indexOf('data-ap="key"')), html.indexOf(">", html.indexOf('data-ap="key"')) + 1);
  assert.ok(tag.includes('type="password"'), tag);
  assert.ok(tag.includes('autocomplete="off"'), tag);
  assert.equal(/\svalue=/.test(tag), false, "no value attribute");
  assert.equal(count(html, 'type="password"'), 1, "one key field");
});

test("the base URL only shows for Other, the plan choice only for Z.AI", () => {
  const html = addProviderSheetHtml({ lang: "en" });
  const urlRow = html.slice(html.lastIndexOf("<", html.indexOf('data-ap="urlRow"')), html.indexOf(">", html.indexOf('data-ap="urlRow"')));
  assert.ok(urlRow.includes(" hidden"), urlRow);
  const variantRow = html.slice(html.lastIndexOf("<", html.indexOf('data-ap="variantRow"')), html.indexOf(">", html.indexOf('data-ap="variantRow"')));
  assert.ok(variantRow.includes(" hidden"), variantRow);
  assert.ok(html.includes('value="payg"') && html.includes('value="coding"'));
  assert.ok(html.includes("Z.AI (GLM Coding Plan)"));
});

test("the sheet says plainly that only ticked models are tested, and the probe costs a little", () => {
  const html = addProviderSheetHtml({ lang: "en" });
  assert.ok(html.includes("Only the models you ticked are tested."));
  assert.ok(html.includes("Test the picks (a few cents)"));
  assert.ok(html.includes("Recommendations last reviewed "));
});

test("the client source: no backtick, no innerHTML, the routes it needs", () => {
  for (const lang of ["en", "es"]) {
    const src = addProviderClientJS({ lang });
    assert.equal(src.includes("`"), false, "no backtick (" + lang + ")");
    assert.equal(src.includes("innerHTML"), false, "textContent only");
    for (const s of ["/api/providers/test", "/probe", "/plan", "/recommended/preview", "X-Crow-Csrf", "previewHash"]) {
      assert.ok(src.includes(s), "contains " + s);
    }
  }
});

// --- a tiny DOM --------------------------------------------------------------------

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.className = "";
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.type = "";
    this.value = "";
    this.open = false;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this, currentTarget: this, preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const walk = (n, out = []) => { out.push(n); for (const c of n.children) walk(c, out); return out; };
const findAll = (root, pred) => walk(root).filter(pred);
const byAttr = (root, name, value) => findAll(root, (n) => n.hasAttribute(name) && (value === undefined || n.getAttribute(name) === value));

const NAMES = ["close", "preset", "variantRow", "variant", "urlRow", "url", "key", "test", "testLine", "modelsBox", "filter",
  "truncated", "list", "typeName", "addName", "save", "saveLine", "picksBox", "stale", "picks", "probe", "recBox", "recList",
  "skipList", "warn", "apply", "result", "error", "done"];

const json = (status, data) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
  json: async () => data,
});
const plain = (status, text) => ({
  ok: false, status,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? "text/plain; charset=utf-8" : null) },
  json: async () => { throw new SyntaxError("Unexpected token"); },
  text: async () => text,
});

function harness(routes, { open = false } = {}) {
  const dialog = new El("dialog");
  dialog.setAttribute("id", "models-add");
  if (open) dialog.setAttribute("data-open", "1");
  const parts = {};
  for (const n of NAMES) { parts[n] = new El("div"); parts[n].setAttribute("data-ap", n); }
  parts.preset.value = "openrouter";
  parts.variant.value = "payg";
  parts.modelsBox.hidden = true;
  parts.picksBox.hidden = true;
  parts.urlRow.hidden = true;
  parts.variantRow.hidden = true;
  dialog.querySelector = (sel) => {
    const m = /^\[data-ap="([^"]+)"\]$/.exec(sel);
    return m && parts[m[1]] ? parts[m[1]] : null;
  };
  const opener = new El("button");
  opener.setAttribute("data-models-add", "");
  const doc = {
    cookie: "crow_lang=en; crow_csrf=tok%2D1",
    createElement: (t) => new El(t),
    getElementById: (id) => (id === "models-add" ? dialog : null),
    querySelectorAll: (sel) => (sel === "[data-models-add]" ? [opener] : []),
    addEventListener() {},
  };
  const calls = [];
  const visits = [];
  const fetchStub = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes.find((x) => x.match(url, init));
    if (!r) throw new Error("no stub for " + url);
    return r.reply(url, init);
  };
  const win = { Turbo: { visit: (href, o) => visits.push({ href, o }) } };
  const loc = { href: "https://crow.example.ts.net/dashboard/settings?section=models", reload() { visits.push({ reload: true }); } };
  new Function("document", "fetch", "window", "location", addProviderClientJS({ lang: "en" }))(doc, fetchStub, win, loc);
  return { dialog, parts, opener, calls, visits };
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const isTest = (u) => u === "/api/providers/test";
const TEST_OK = (models, recommended = []) => json(200, { ok: true, code: "ok", status: 200, models, host: "openrouter.ai", recommended });

async function tested(h, key = "fixture-pasted-key-777") {
  h.opener.fire("click");
  await flush();
  h.parts.key.value = key;
  h.parts.test.fire("click");
  await flush();
}
const modelBoxes = (h) => byAttr(h.parts.list, "data-ap-model");

test("Test posts the form, then lists the models as checkboxes: recommended pre-ticked and starred, ids as text", async () => {
  const h = harness([{ match: isTest, reply: () => TEST_OK(["<img src=x onerror=1>", "anthropic/claude-haiku-5.5"], ["anthropic/claude-haiku-5.5"]) }]);
  await tested(h);
  assert.equal(h.dialog.open, true);
  const c = h.calls[0];
  assert.equal(c.url, "/api/providers/test");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers["X-Crow-Csrf"], "tok-1");
  assert.equal(c.body.presetId, "openrouter");
  assert.equal(c.body.apiKey, "fixture-pasted-key-777");
  assert.equal(h.parts.testLine.textContent, "That key works. 2 models available.");
  assert.equal(h.parts.modelsBox.hidden, false);
  const boxes = modelBoxes(h);
  assert.equal(boxes.length, 2);
  const haiku = boxes.find((b) => b.getAttribute("data-ap-model") === "anthropic/claude-haiku-5.5");
  assert.equal(haiku.checked, true);
  assert.equal(boxes.find((b) => b !== haiku).checked, false);
  assert.equal(findAll(h.parts.list, (n) => n.className === "mc-star").length, 1);
  // The odd id is plain text in a span, never markup.
  assert.ok(findAll(h.parts.list, (n) => n._text === "<img src=x onerror=1>").length === 1);
  assert.equal(h.parts.filter.hidden, true, "no filter for a short list");
  assert.equal(h.parts.save.disabled, false);
});

test("a rejected key says so in plain words and nothing can be saved", async () => {
  const h = harness([{ match: isTest, reply: () => json(200, { ok: false, code: "key_rejected", status: 401, models: null, host: "openrouter.ai" }) }]);
  await tested(h);
  assert.equal(h.parts.testLine.textContent, "OpenRouter did not accept that key. Check that you copied all of it.");
  assert.equal(h.parts.modelsBox.hidden, true);
  assert.equal(h.parts.save.disabled, true);
});

test("an error status and an unreachable host fill their placeholders", async () => {
  let reply = json(200, { ok: false, code: "provider_error", status: 503, models: null, host: "openrouter.ai" });
  const h = harness([{ match: isTest, reply: () => reply }]);
  await tested(h);
  assert.equal(h.parts.testLine.textContent, "OpenRouter answered with an error (503). Try again later.");
  reply = json(200, { ok: false, code: "unreachable", models: null, host: "api.example.com" });
  h.parts.test.fire("click");
  await flush();
  assert.equal(h.parts.testLine.textContent, "Crow could not reach api.example.com. Check the address and your connection.");
});

test("a CSRF refusal (plain text 403) shows the generic line, never the server text", async () => {
  const h = harness([{ match: isTest, reply: () => plain(403, "Forbidden: bad csrf <script>") }]);
  await tested(h);
  assert.equal(h.parts.testLine.textContent, "That didn't work. Try again, or reload the page.");
});

test("past 20 models a filter box shows and narrows the list", async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `vendor/model-${i}`);
  const h = harness([{ match: isTest, reply: () => TEST_OK(ids) }]);
  await tested(h);
  assert.equal(h.parts.filter.hidden, false);
  h.parts.filter.value = "model-2";
  h.parts.filter.fire("input");
  const shown = modelBoxes(h).filter((b) => !b.row.hidden).map((b) => b.getAttribute("data-ap-model"));
  assert.deepEqual(shown.sort(), ["vendor/model-2", "vendor/model-20", "vendor/model-21", "vendor/model-22", "vendor/model-23", "vendor/model-24"]);
});

test("a typed model name joins the list ticked", async () => {
  const h = harness([{ match: isTest, reply: () => TEST_OK(["a/b"]) }]);
  await tested(h);
  h.parts.typeName.value = "  my/custom-model ";
  h.parts.addName.fire("click");
  const typed = modelBoxes(h).find((b) => b.getAttribute("data-ap-model") === "my/custom-model");
  assert.ok(typed);
  assert.equal(typed.checked, true);
  assert.equal(h.parts.typeName.value, "");
});

const PLAN = {
  providerId: "openrouter", providerLabel: "OpenRouter", stale: false, reviewed: "2026-10-28",
  picks: [
    { roleId: "quick", modelId: "anthropic/claude-haiku-5.5", key: "openrouter/anthropic/claude-haiku-5.5", kind: "chat", label: "claude-haiku", providerLabel: "OpenRouter", probed: true, check: { ok: true, code: "ok", at: "2026-10-30T10:00:00.000Z" } },
    { roleId: "deep", modelId: "anthropic/claude-opus-5.5", key: "openrouter/anthropic/claude-opus-5.5", kind: "chat", label: "claude-opus", providerLabel: "OpenRouter", probed: true, check: { ok: false, code: "no_tool_call", at: "2026-10-30T10:00:00.000Z" } },
    { roleId: "embed", modelId: "qwen/qwen3-embedding-8b", key: "openrouter/qwen/qwen3-embedding-8b", kind: "embed", label: "qwen3-embedding-8b", providerLabel: "OpenRouter", probed: true, check: null },
    { roleId: "rerank", modelId: "cohere/rerank-4-fast", key: "openrouter/cohere/rerank-4-fast", kind: "rerank", label: "rerank-4-fast", providerLabel: "OpenRouter", probed: false, check: null },
  ],
  apply: [{ roleId: "expert", key: "openrouter/anthropic/claude-opus-5.5", preview: { previewHash: "h-x" } }],
  optIn: [{ roleId: "quick", key: "openrouter/anthropic/claude-haiku-5.5", current: { key: "local-chat/m1", label: "m1" }, why: "runs_today" },
    { roleId: "embed", key: "openrouter/qwen/qwen3-embedding-8b", current: null, why: "cloud" }],
  skipped: [{ roleId: "deep", why: "failed_check" }, { roleId: "vision", why: "not_listed" }],
};
const COMBINED = (over = {}) => ({
  consumers: { unattended: [{ kind: "bot", id: "b1", label: "Night bot" }], bots: [], subagents: [], jobs: [], otherCrows: [] },
  cloud: { host: "openrouter.ai", model: "openrouter/anthropic/claude-opus-5.5", now: true },
  clouds: [{ host: "openrouter.ai", model: "openrouter/anthropic/claude-opus-5.5", now: true }],
  refused: [], reembed: false, needs: { ackUnattended: true, ackCloud: true }, items: [], previewHash: "combined-1", ...over,
});

function fullRoutes(extra = []) {
  return [
    ...extra,
    { match: isTest, reply: () => TEST_OK(["anthropic/claude-haiku-5.5", "anthropic/claude-opus-5.5"], ["anthropic/claude-haiku-5.5"]) },
    { match: (u, i) => u === "/api/providers" && i.method === "POST", reply: () => json(200, { ok: true, providerId: "openrouter" }) },
    { match: (u) => u === "/api/providers/openrouter/plan", reply: () => json(200, PLAN) },
    { match: (u) => u === "/api/providers/openrouter/probe", reply: () => json(200, { quick: { modelId: "anthropic/claude-haiku-5.5", ok: true, code: "ok" } }) },
    { match: (u) => u === "/api/providers/openrouter/recommended/preview", reply: () => json(200, COMBINED()) },
    { match: (u) => u === "/api/providers/openrouter/recommended", reply: () => json(200, { ok: true, applied: [{ roleId: "expert", key: "x" }], refused: [], stillEmpty: ["vision", "critic"] }) },
  ];
}
async function saved(h) {
  await tested(h);
  h.parts.save.fire("click");
  await flush();
}

test("Save sends the ticked models, forgets the key, then shows each pick with its provider and check", async () => {
  const h = harness(fullRoutes());
  await saved(h);
  const post = h.calls.find((c) => c.url === "/api/providers");
  assert.deepEqual(post.body.modelIds, ["anthropic/claude-haiku-5.5"]);
  assert.equal(post.body.apiKey, "fixture-pasted-key-777");
  assert.equal(h.parts.key.value, "", "the key leaves the page once saved");
  assert.equal(h.parts.picksBox.hidden, false);
  const rows = byAttr(h.parts.picks, "data-ap-pick");
  assert.equal(rows.length, 4);
  const text = (role) => rows.find((r) => r.getAttribute("data-ap-pick") === role).textContent;
  assert.ok(text("quick").includes("claude-haiku") && text("quick").includes("OpenRouter"), text("quick"));
  assert.ok(text("quick").includes("Passed") && text("quick").includes("Checked 2026-10-30"), text("quick"));
  assert.ok(text("deep").includes("Not offered: failed check") && text("deep").includes("Checked 2026-10-30"), text("deep"));
  assert.ok(text("embed").includes("Not tested yet"), text("embed"));
  assert.ok(text("rerank").includes("Not tested yet") && text("rerank").includes("Search ranking can't be tested here."), text("rerank"));
  assert.ok(!JSON.stringify(h.calls.filter((c) => c.url !== "/api/providers" && c.url !== "/api/providers/test").map((c) => c.body)).includes("fixture-pasted-key-777"),
    "only the test and the save carry the key");
});

test("a refused save shows its plain line", async () => {
  const h = harness(fullRoutes([{ match: (u, i) => u === "/api/providers" && i.method === "POST", reply: () => json(400, { ok: false, code: "save_failed" }) }]));
  await saved(h);
  assert.equal(h.parts.saveLine.textContent, "Crow couldn't save this provider. Try again.");
  assert.equal(h.parts.picksBox.hidden, true);
});

test("Test the picks is the only probe trigger, then the plan is read again", async () => {
  const h = harness(fullRoutes());
  await saved(h);
  assert.equal(h.calls.filter((c) => c.url.endsWith("/probe")).length, 0, "nothing probes on save");
  const plans = h.calls.filter((c) => c.url.endsWith("/plan")).length;
  h.parts.probe.fire("click");
  await flush();
  const probe = h.calls.filter((c) => c.url === "/api/providers/openrouter/probe");
  assert.equal(probe.length, 1);
  assert.equal(probe[0].init.method, "POST");
  assert.equal(h.calls.filter((c) => c.url.endsWith("/plan")).length, plans + 1);
});

test("recommended: pre-ticked only for empty roles, opt-ins unticked with what runs today, one warning, acks, then still-empty roles", async () => {
  const h = harness(fullRoutes());
  await saved(h);
  assert.equal(h.parts.recBox.hidden, false);
  const boxes = byAttr(h.parts.recList, "data-ap-rec");
  const box = (r) => boxes.find((b) => b.getAttribute("data-ap-rec") === r);
  assert.equal(box("expert").checked, true);
  assert.equal(box("quick").checked, false);
  assert.equal(box("embed").checked, false);
  assert.ok(h.parts.recList.textContent.includes("Already running: m1"));
  assert.ok(h.parts.recList.textContent.includes("so it stays off unless you tick it"));
  assert.ok(h.parts.skipList.textContent.includes("The recommended model failed its check."));
  assert.ok(h.parts.skipList.textContent.includes("The recommended model isn't one you saved."));
  // One combined warning for the ticked roles.
  const pv = h.calls.filter((c) => c.url.endsWith("/recommended/preview"));
  assert.equal(pv.length, 1);
  assert.deepEqual(pv[0].body.roles, ["expert"]);
  assert.ok(h.parts.warn.textContent.includes("Night bot"));
  assert.ok(h.parts.warn.textContent.includes("will go to openrouter.ai"));
  assert.equal(h.parts.apply.disabled, true, "the unattended ack is needed first");
  const ack = byAttr(h.parts.warn, "data-ap-ack", "unattended")[0];
  ack.checked = true;
  ack.fire("change");
  assert.equal(h.parts.apply.disabled, false);
  h.parts.apply.fire("click");
  await flush();
  const ap = h.calls.find((c) => c.url === "/api/providers/openrouter/recommended");
  assert.deepEqual(ap.body, { roles: ["expert"], previewHash: "combined-1", ackUnattended: true, ackCloud: true });
  assert.equal(h.parts.result.textContent, "Still empty: Vision, Reviewer. Add another provider for them.");
});

test("ticking an opt-in previews again with both roles", async () => {
  const h = harness(fullRoutes());
  await saved(h);
  const quick = byAttr(h.parts.recList, "data-ap-rec", "quick")[0];
  quick.checked = true;
  quick.fire("change");
  await flush();
  const pv = h.calls.filter((c) => c.url.endsWith("/recommended/preview"));
  assert.deepEqual(pv.at(-1).body.roles.sort(), ["expert", "quick"]);
});

test("a stale apply re-reads the warning and says something changed", async () => {
  const h = harness(fullRoutes([{ match: (u) => u === "/api/providers/openrouter/recommended", reply: () => json(409, { ok: false, applied: [], refused: [{ roleId: "expert", reason: "preview_changed" }], stillEmpty: [] }) }]));
  await saved(h);
  const ack = byAttr(h.parts.warn, "data-ap-ack", "unattended")[0];
  ack.checked = true;
  ack.fire("change");
  const before = h.calls.filter((c) => c.url.endsWith("/recommended/preview")).length;
  h.parts.apply.fire("click");
  await flush();
  assert.equal(h.calls.filter((c) => c.url.endsWith("/recommended/preview")).length, before + 1);
  assert.ok(h.parts.warn.textContent.includes("Something changed since you looked."));
});

test("?add=1 opens the sheet on load; closing after a save reloads the page", async () => {
  const h = harness(fullRoutes(), { open: true });
  await flush();
  assert.equal(h.dialog.open, true);
  h.parts.key.value = "fixture-pasted-key-777";
  h.parts.test.fire("click");
  await flush();
  h.parts.save.fire("click");
  await flush();
  h.parts.done.fire("click");
  assert.equal(h.dialog.open, false);
  assert.equal(h.visits.length, 1);
});

test("Other shows the address field and sends it; Z.AI sends the plan", async () => {
  const h = harness(fullRoutes());
  h.opener.fire("click");
  await flush();
  h.parts.preset.value = "other";
  h.parts.preset.fire("change");
  assert.equal(h.parts.urlRow.hidden, false);
  assert.equal(h.parts.variantRow.hidden, true);
  h.parts.url.value = "http://203.0.113.5:8080/v1";
  h.parts.test.fire("click");
  await flush();
  assert.equal(h.calls.at(-1).body.baseUrl, "http://203.0.113.5:8080/v1");
  h.parts.preset.value = "zai";
  h.parts.preset.fire("change");
  assert.equal(h.parts.urlRow.hidden, true);
  assert.equal(h.parts.variantRow.hidden, false);
  h.parts.variant.value = "coding";
  h.parts.test.fire("click");
  await flush();
  assert.equal(h.calls.at(-1).body.variantId, "coding");
  assert.equal(h.calls.at(-1).body.baseUrl, undefined);
});

// --- the Models page ------------------------------------------------------------

let dir, db;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "add-provider-ui-"));
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
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, description, models) VALUES (?,?,?,?,?,?)",
    args: ["openrouter", "https://openrouter.ai/api/v1", "fixture-secret-123", "cloud", "OpenRouter", JSON.stringify([{ id: "anthropic/claude-haiku-5.5" }])],
  });
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?,?)", args: ["model_role.quick", JSON.stringify({ model: "openrouter/anthropic/claude-haiku-5.5" })] });
  invalidateRoleContext();
  clearProviderTaskCache();
});
after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

test("sheet html never contains a stored key", async () => {
  const html = await modelsSection.render({ req: { query: {} }, db, lang: "en", now: PINNED });
  assert.ok(html.includes('id="models-add"'), "the sheet is on the page");
  assert.ok(html.includes("data-models-add"), "the button opens it");
  assert.ok(html.includes("claude-haiku"), "the provider's model is rendered");
  assert.equal(html.includes("fixture-secret-123"), false);
});

test("?add=1 marks the sheet to open; without it the sheet stays shut", async () => {
  const shut = await modelsSection.render({ req: { query: {} }, db, lang: "en", now: PINNED });
  assert.equal(shut.includes('data-open="1"'), false);
  const open = await modelsSection.render({ req: { query: { add: "1" } }, db, lang: "en", now: PINNED });
  assert.equal(count(open, 'data-open="1"'), 1);
});

test("the Models page says so when the recommendations are past their review date", async () => {
  const { renderModelsPage } = await import("../servers/gateway/dashboard/settings/sections/models.js");
  const fresh = renderModelsPage([], { lang: "en", now: new Date("2026-11-01T00:00:00Z") });
  assert.equal(fresh.includes("mr-recs-stale"), false);
  const stale = renderModelsPage([], { lang: "en", now: new Date("2027-02-01T00:00:00Z") });
  assert.equal(count(stale, "mr-recs-stale"), 1);
  assert.ok(stale.includes("Recommendations last reviewed 2026-10-28"));
  assert.ok(stale.includes("due for review"));
  assert.ok(renderModelsPage([], { lang: "es", now: new Date("2027-02-01T00:00:00Z") }).includes("necesitan revisión"));
});

test("Escape (the dialog's own close) clears the key and reloads after a save", async () => {
  const h = harness(fullRoutes());
  await tested(h);
  h.dialog.open = false;
  h.dialog.fire("close");
  assert.equal(h.parts.key.value, "", "the key leaves the field");
  assert.equal(h.visits.length, 0, "nothing saved, no reload");
  await saved(h);
  h.parts.key.value = "typed-again";
  h.dialog.open = false;
  h.dialog.fire("close");
  assert.equal(h.parts.key.value, "");
  assert.equal(h.visits.length, 1, "a save reloads the page");
  h.dialog.fire("close");
  assert.equal(h.visits.length, 1, "once");
});

test("after an apply the plan is read again, and the result line stays", async () => {
  const h = harness(fullRoutes());
  await saved(h);
  const ack = byAttr(h.parts.warn, "data-ap-ack", "unattended")[0];
  ack.checked = true;
  ack.fire("change");
  const plans = h.calls.filter((c) => c.url.endsWith("/plan")).length;
  h.parts.apply.fire("click");
  await flush();
  assert.equal(h.calls.filter((c) => c.url.endsWith("/plan")).length, plans + 1);
  assert.equal(h.parts.result.textContent, "Still empty: Vision, Reviewer. Add another provider for them.");
});

test("render passes its clock to the stale line", async () => {
  const html = await modelsSection.render({ req: { query: {} }, db, lang: "en", now: new Date("2027-02-01T00:00:00Z") });
  assert.equal(count(html, "mr-recs-stale"), 1);
});
