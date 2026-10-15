/**
 * Models plan 3a, Task 6 (+ Rev 2 M2/Lows): the Model Catalog's registered
 * models section, and one start path for every panel Start (curated cards and
 * the runtime strip included) through the job-store route.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";

import { renderRegisteredSection, registeredClientJS } from "../servers/gateway/dashboard/panels/model-catalog-registered.js";
import modelCatalogPanel, {
  renderRuntimeStrip, renderCuratedTab, modelCatalogClientJS, providerIdsByCatalogId, _setRegisteredSnapshotForTest,
} from "../servers/gateway/dashboard/panels/model-catalog.js";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { withLivePage } from "./fixtures/live-page.mjs";

const LONG_ARGV = ["/opt/llama.cpp/build/bin/llama-server", "--model", "/mnt/models/blobs/a-very-long-model-file-name-that-goes-on-and-on-Q4_K_M-00001-of-00003.gguf", "--port", "18102", "--ctx-size", "32768", "--parallel", "4", "--flash-attn", "on", "--jinja"];

function row(over = {}) {
  return {
    provider: "crow-chat", model: "small-chat", quant: "Q4_K_M", mutexGroup: "g1", wouldEvict: [], argv: null, owner: "me", managed: "native",
    status: "stopped", catalogId: "small-chat", inCatalog: true, launch: null, alwaysResident: false, defaultMember: false,
    servingClass: "resident", startable: true, own: true, ...over,
  };
}

function snapshot(rows, over = {}) {
  return { rows, groups: ["g1"], roles: ["crow-embed"], orchestrationDisabled: false, llamaServerBin: null, ...over };
}

const FIXTURE_ROWS = [
  row({ provider: "crow-chat", status: "resident", argv: LONG_ARGV, startable: true }),
  row({ provider: "crow-idle", status: "stopped", launch: { ctx: 8192 } }),
  row({ provider: "big-window", catalogId: "big-window", model: "big-window", status: "stopped", servingClass: "windowed", startable: false }),
  row({ provider: "wedgy", catalogId: "wedgy", model: "wedgy", status: "stopped", servingClass: "wedge-risk", startable: false }),
  row({ provider: "peer-gemma", status: "foreign", owner: "peer", startable: false, own: false }),
  row({ provider: "ext-27b", status: "external_up", managed: "external", owner: null, startable: false, own: false, mutexGroup: null }),
];

const actionsOf = (html, provider) => {
  const tr = html.split(`data-provider-row="${provider}"`)[1].split("</tr>")[0];
  return [...tr.matchAll(/data-reg-action="([a-z]+)"/g)].map((m) => m[1]).sort();
};

// ─── Static render ──────────────────────────────────────────────────────────

test("each row offers only its allowed actions", () => {
  const html = renderRegisteredSection(snapshot(FIXTURE_ROWS), "en");
  assert.deepEqual(actionsOf(html, "crow-chat"), ["edit", "remove", "stop"]);
  assert.deepEqual(actionsOf(html, "crow-idle"), ["edit", "remove", "start"]);
  assert.deepEqual(actionsOf(html, "big-window"), ["edit", "remove"], "windowed: no Start");
  assert.deepEqual(actionsOf(html, "wedgy"), ["edit", "remove"], "wedge-risk: no Start");
  assert.deepEqual(actionsOf(html, "peer-gemma"), [], "foreign rows are read-only");
  assert.deepEqual(actionsOf(html, "ext-27b"), [], "external rows are read-only");
  const win = html.split('data-provider-row="big-window"')[1].split("</tr>")[0];
  assert.match(win, /Operator window/);
  const wedge = html.split('data-provider-row="wedgy"')[1].split("</tr>")[0];
  assert.match(wedge, /Wedge risk/);
});

test("statuses carry en and es labels; the argv column labels the gap for a stopped row", () => {
  const en = renderRegisteredSection(snapshot(FIXTURE_ROWS), "en");
  assert.match(en, /data-provider-row="crow-chat"[\s\S]*?Running/);
  assert.match(en, /data-provider-row="peer-gemma"[\s\S]*?Another instance/);
  assert.match(en, /data-provider-row="ext-27b"[\s\S]*?External engine \(up\)/);
  const idle = en.split('data-provider-row="crow-idle"')[1].split("</tr>")[0];
  assert.match(idle, /Not running — launch overrides/);
  assert.match(idle, /&quot;ctx&quot;:8192/);
  const chat = en.split('data-provider-row="crow-chat"')[1].split("</tr>")[0];
  assert.match(chat, /<code class="mcat-reg__argv">\/opt\/llama\.cpp/);
  const es = renderRegisteredSection(snapshot(FIXTURE_ROWS), "es");
  assert.match(es, /Modelos registrados/);
  assert.match(es, /En ejecución/);
  assert.match(es, /Otra instancia/);
});

test("orchestration off: a notice, and no Start or Stop anywhere (section, curated cards, runtime strip)", () => {
  const off = renderRegisteredSection(snapshot(FIXTURE_ROWS.map((r) => ({ ...r, startable: false })), { orchestrationDisabled: true }), "en");
  assert.match(off, /Model orchestration is disabled on this host/);
  assert.doesNotMatch(off, /data-reg-action="(start|stop)"/);

  const model = {
    id: "small-chat", family: "f", lab: "L", license: "mit", gated: false, task: "chat", context_len: 4096, tags: ["small"], notes: null,
    default_quant: "Q4", first_run_default: false, registered: true, registeredQuant: "Q4", running: true, serving_class: null,
    quants: [{ quant: "Q4", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" }],
  };
  const data = {
    runtime: { name: "llama.cpp", release: "b1" }, probe: null, estimatedRamMb: 0, estimatedVramMb: 0, hfTokenConfigured: false, orchestrationDisabled: true,
    models: [model, { ...model, id: "other", running: false }],
    runtimeModels: [
      { modelId: "small-chat", quant: "Q4", source: "curated", servingClass: null, state: "running", live: true, port: 1, restartCount: 0, lastError: null, pid: 2 },
      { modelId: "other", quant: "Q4", source: "curated", servingClass: null, state: "stopped", live: false, port: null, restartCount: 0, lastError: null, pid: null },
    ],
  };
  const cards = renderCuratedTab(data, "en");
  const strip = renderRuntimeStrip(data, "en");
  assert.doesNotMatch(cards, /data-action="(start|stop)"/);
  assert.doesNotMatch(strip, /data-action="(start|stop)"/);
  assert.match(cards, /data-action="remove" data-model-id="small-chat"/, "Remove stays");
});

test("curated-card and strip Start/Stop name the provider that serves the catalog model", () => {
  const map = providerIdsByCatalogId([
    row({ provider: "crow-chat", catalogId: "small-chat" }),
    row({ provider: "peer-copy", catalogId: "small-chat", own: false, status: "foreign" }),
    row({ provider: "solo", catalogId: "solo" }),
  ]);
  assert.equal(map.get("small-chat"), "crow-chat");
  assert.equal(map.get("solo"), "solo");
  const model = {
    id: "small-chat", providerId: "crow-chat", family: "f", lab: "L", license: "mit", gated: false, task: "chat", context_len: 4096, tags: ["small"], notes: null,
    default_quant: "Q4", first_run_default: false, registered: true, registeredQuant: "Q4", running: false, serving_class: null,
    quants: [{ quant: "Q4", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" }],
  };
  const cards = renderCuratedTab({ models: [model], hfTokenConfigured: false }, "en");
  assert.match(cards, /data-action="start" data-model-id="small-chat" data-provider-id="crow-chat"/);
});

test("an empty registry says so; the env llama-server override is shown read-only", () => {
  const html = renderRegisteredSection(snapshot([], { llamaServerBin: "/opt/custom/llama-server" }), "en");
  assert.match(html, /No models registered yet/);
  assert.match(html, /CROW_LLAMA_SERVER_BIN/);
  assert.match(html, /\/opt\/custom\/llama-server/);
  assert.doesNotMatch(html, /<input[^>]*llama-server/, "read-only, no field");
});

test("client script: no backticks, no innerHTML assignment, sends X-Crow-Csrf", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/dashboard/panels/model-catalog-registered.js"), "utf8");
  const body = src.slice(src.indexOf("export function registeredClientJS"));
  const script = body.slice(body.indexOf("<script>"), body.lastIndexOf("</script>"));
  assert.ok(script.length > 200);
  assert.equal(script.includes("`"), false);
  const out = registeredClientJS("en");
  assert.doesNotMatch(out, /\.innerHTML\s*=/);
  assert.match(out, /X-Crow-Csrf/);
});

// ─── Client behaviour (linkedom + vm) ───────────────────────────────────────

function boot(rows, fetchImpl, { withCatalogClient = false, catalogData = null } = {}) {
  const regHtml = registeredClientJS("en");
  const regJs = regHtml.slice(regHtml.indexOf("<script>") + 8, regHtml.lastIndexOf("</script>"));
  const catHtml = modelCatalogClientJS("en");
  const overlay = catHtml.slice(0, catHtml.indexOf("<script>"));
  const catJs = catHtml.slice(catHtml.indexOf("<script>") + 8, catHtml.lastIndexOf("</script>"));
  const extra = catalogData ? renderRuntimeStrip(catalogData, "en") + renderCuratedTab(catalogData, "en") : "";
  const { window, document } = parseHTML(`<html><body>${renderRegisteredSection(snapshot(rows), "en")}${extra}${overlay}</body></html>`);
  const calls = [];
  const timers = [];
  let reloaded = 0;
  const location = { href: "https://crow.test/dashboard/model-catalog", reload() { reloaded += 1; } };
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "crow_session=s; crow_csrf=tok123" });
  const ctx = vm.createContext({
    window, document, location, console,
    fetch: (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || "GET", headers: (init && init.headers) || {} });
      return Promise.resolve(fetchImpl(String(url), init));
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {}, setInterval: () => 0,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  ctx.window.CrowModelDialog = undefined;
  if (withCatalogClient) vm.runInContext(catJs, ctx);
  vm.runInContext(regJs, ctx);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const flush = () => timers.splice(0).forEach((fn) => fn());
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  return { window, document, calls, settle, flush, click, reloaded: () => reloaded };
}

const json = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });

test("BEHAVIOR: Start POSTs with the CSRF header, then polls the job URL; resident reloads", async () => {
  let polls = 0;
  const b = boot(FIXTURE_ROWS, (url) => {
    if (url === "/api/models/providers/crow-idle/start") return json(202, { job_id: "j1" });
    if (url === "/api/models/jobs/j1") { polls += 1; return json(200, { id: "j1", state: polls < 2 ? "starting" : "resident" }); }
    return json(200, {});
  });
  b.click(b.document.querySelector('[data-provider-row="crow-idle"] [data-reg-action="start"]'));
  await b.settle();
  const start = b.calls.find((c) => c.url.endsWith("/start"));
  assert.equal(start.method, "POST");
  assert.equal(start.headers["X-Crow-Csrf"], "tok123");
  b.flush(); await b.settle();
  b.flush(); await b.settle();
  assert.ok(b.calls.filter((c) => c.url === "/api/models/jobs/j1").length >= 2, "polled the job");
  assert.equal(b.reloaded(), 1);
});

test("BEHAVIOR: a failed job renders its error and each stderr cause line as text", async () => {
  const b = boot(FIXTURE_ROWS, (url) => {
    if (url.endsWith("/start")) return json(202, { job_id: "j2" });
    if (url === "/api/models/jobs/j2") return json(200, { id: "j2", state: "failed", error: "failed to bind", cause: ["llama_model_load: <b>error</b>", "out of memory"] });
    return json(200, {});
  });
  b.click(b.document.querySelector('[data-provider-row="crow-idle"] [data-reg-action="start"]'));
  await b.settle(); b.flush(); await b.settle();
  const msg = b.document.querySelector('[data-provider-msg="crow-idle"]');
  assert.match(msg.textContent, /failed to bind/);
  const pre = msg.querySelector("pre");
  assert.ok(pre, "cause lines in a <pre>");
  assert.equal(pre.textContent, "llama_model_load: <b>error</b>\nout of memory");
  assert.equal(pre.querySelector("b"), null, "never parsed as markup");
  assert.equal(b.reloaded(), 0);
});

test("BEHAVIOR: a reservation-blocked job names the owner and expiry", async () => {
  const b = boot(FIXTURE_ROWS, (url) => {
    if (url.endsWith("/start")) return json(202, { job_id: "j3" });
    if (url === "/api/models/jobs/j3") return json(200, { id: "j3", state: "blocked_by_reservation", reservation: { owner: "bench", expires_at: "2026-10-16T09:00:00Z" } });
    return json(200, {});
  });
  b.click(b.document.querySelector('[data-provider-row="crow-idle"] [data-reg-action="start"]'));
  await b.settle(); b.flush(); await b.settle();
  const msg = b.document.querySelector('[data-provider-msg="crow-idle"]').textContent;
  assert.match(msg, /bench/);
  assert.match(msg, /2026-10-16T09:00:00Z/);
});

test("BEHAVIOR: Unregister is two DELETEs around a confirm that shows the bindings count", async () => {
  const b = boot(FIXTURE_ROWS, (url, init) => {
    if (url === "/api/models/providers/crow-idle" && init.method === "DELETE") return json(200, { requiresConfirm: true, bindings: { profiles: [{ id: "p" }], bots: [{ bot_id: "b" }] } });
    if (url === "/api/models/providers/crow-idle?confirm=true") return json(200, { deleted: true });
    return json(200, {});
  });
  b.click(b.document.querySelector('[data-provider-row="crow-idle"] [data-reg-action="remove"]'));
  await b.settle();
  const content = b.document.getElementById("mcat-modal-content");
  assert.match(content.textContent, /2/);
  assert.equal(b.calls.filter((c) => c.method === "DELETE").length, 1, "nothing removed before the confirm");
  b.click(content.querySelector('[data-reg-confirm="remove"]'));
  await b.settle();
  const deletes = b.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
  assert.deepEqual(deletes, ["/api/models/providers/crow-idle", "/api/models/providers/crow-idle?confirm=true"]);
  assert.equal(b.calls.find((c) => c.url.endsWith("confirm=true")).headers["X-Crow-Csrf"], "tok123");
});

test("BEHAVIOR: Edit hands the row to the dialog in edit mode", async () => {
  const b = boot(FIXTURE_ROWS, () => json(200, {}));
  let opened = null;
  b.window.CrowModelDialog = { open: (o) => { opened = o; } };
  b.click(b.document.querySelector('[data-provider-row="crow-idle"] [data-reg-action="edit"]'));
  assert.equal(opened.mode, "edit");
  assert.equal(opened.row.provider, "crow-idle");
  assert.deepEqual(JSON.parse(JSON.stringify(opened.row.launch)), { ctx: 8192 }, "cross-realm object, compared by value");
});

test("BEHAVIOR: a curated card's Start goes through the job-store route under its provider id", async () => {
  const model = {
    id: "small-chat", providerId: "crow-chat", family: "f", lab: "L", license: "mit", gated: false, task: "chat", context_len: 4096, tags: ["small"], notes: null,
    default_quant: "Q4", first_run_default: false, registered: true, registeredQuant: "Q4", running: false, serving_class: null,
    quants: [{ quant: "Q4", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" }],
  };
  const data = { runtime: { name: "llama.cpp", release: "b1" }, probe: null, estimatedRamMb: 0, estimatedVramMb: 0, hfTokenConfigured: false, models: [model], runtimeModels: [] };
  const b = boot([], (url) => {
    if (url === "/api/models/providers/crow-chat/start") return json(202, { job_id: "j9" });
    if (url === "/api/models/jobs/j9") return json(200, { id: "j9", state: "resident" });
    return json(200, {});
  }, { withCatalogClient: true, catalogData: data });
  b.click(b.document.querySelector('.mcat-card [data-action="start"]'));
  await b.settle(); b.flush(); await b.settle();
  assert.ok(b.calls.some((c) => c.url === "/api/models/providers/crow-chat/start" && c.method === "POST"));
  assert.ok(!b.calls.some((c) => c.url === "/api/models/small-chat/start"), "the legacy direct-acquire route is never used");
  assert.equal(b.reloaded(), 1);
});

// ─── Live layout (real panel handler, fixture rows) ─────────────────────────

let chrome = null, server = null, base = "";
before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  _setRegisteredSnapshotForTest(() => snapshot(FIXTURE_ROWS));
  server = http.createServer(async (req, res) => {
    const lang = "en";
    const layout = (o) => renderLayout({ ...o, activePanel: "model-catalog", panels: [], lang });
    const html = await modelCatalogPanel.handler(req, res, { db: null, layout, lang });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  base = `http://${chrome.pageHost}:${server.address().port}`;
});
after(async () => {
  _setRegisteredSnapshotForTest(null);
  if (server) server.close();
  if (chrome) await chrome.close();
});

for (const [w, h] of [[412, 915], [1280, 900]]) {
  test(`live ${w}x${h}: a long argv never widens the page and every action button is on screen`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await withLivePage(chrome, base + "/dashboard/model-catalog", { width: w, height: h, readyExpr: "!!document.querySelector('#mcat-registered [data-provider-row]')" }, async (evalIn) =>
      JSON.parse(await evalIn(`JSON.stringify((function(){
        var vw = window.innerWidth;
        var btns = [].slice.call(document.querySelectorAll('#mcat-registered [data-reg-action]'));
        var outside = btns.filter(function(b){ var r = b.getBoundingClientRect(); return r.left < 0 || r.right > vw + 0.5 || r.width === 0; })
          .map(function(b){ return b.getAttribute('data-reg-action') + '@' + b.closest('tr').getAttribute('data-provider-row'); });
        return { sw: document.documentElement.scrollWidth, vw: vw, buttons: btns.length, outside: outside };
      })())`)));
    assert.ok(m.sw <= m.vw, `scrollWidth ${m.sw} > innerWidth ${m.vw}`);
    assert.ok(m.buttons >= 8);
    assert.deepEqual(m.outside, []);
  });
}
