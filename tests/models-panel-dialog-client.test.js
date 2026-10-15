/**
 * Models plan 3a, Task 7: the register / adopt / edit / hf-adopt dialog
 * (window.CrowModelDialog), driven for real in linkedom + node:vm and laid out
 * in a headless Chrome at phone and desktop sizes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";

import { dialogClientJS } from "../servers/gateway/dashboard/panels/model-catalog-dialog.js";
import modelCatalogPanel, { renderCuratedTab, modelCatalogClientJS, _setRegisteredSnapshotForTest } from "../servers/gateway/dashboard/panels/model-catalog.js";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { withLivePage } from "./fixtures/live-page.mjs";

function cardModel(over = {}) {
  return {
    id: "vision-4b", family: "f", lab: "L", license: "mit", gated: false, task: "vision", context_len: 32768, tags: ["small"], notes: null,
    default_quant: "Q4_K_M", first_run_default: false, registered: false, registeredQuant: null, running: false, serving_class: null,
    launch: { ctx: 32768, ngl: 999 }, companions: ["mmproj", "mtp"],
    quants: [{ quant: "Q4_K_M", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" }, { quant: "Q8_0", size_mb: 900, min_ram_mb: 900, min_vram_mb: 0, fitBadge: "fits" }],
    ...over,
  };
}

const REGISTERED = { rows: [], groups: ["crow-strix-vram", "g2"], roles: ["crow-chat", "crow-embed"], orchestrationDisabled: false };

function boot(models, fetchImpl) {
  const catHtml = modelCatalogClientJS("en");
  const overlay = catHtml.slice(0, catHtml.indexOf("<script>"));
  const catJs = catHtml.slice(catHtml.indexOf("<script>") + 8, catHtml.lastIndexOf("</script>"));
  const dlgHtml = dialogClientJS("en");
  const dlgJs = dlgHtml.slice(dlgHtml.indexOf("<script>") + 8, dlgHtml.lastIndexOf("</script>"));
  const { window, document } = parseHTML(`<html><body>${renderCuratedTab({ models, hfTokenConfigured: false }, "en")}${overlay}</body></html>`);
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "crow_session=s; crow_csrf=tok123" });
  const calls = [];
  let reloaded = 0;
  const stored = {};
  const ctx = vm.createContext({
    window, document, console,
    location: { href: "https://crow.test/dashboard/model-catalog", reload() { reloaded += 1; } },
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: (init && init.method) || "GET", headers: (init && init.headers) || {}, body });
      return Promise.resolve(fetchImpl(String(url), init));
    },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    sessionStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } },
  });
  vm.runInContext(catJs, ctx);
  vm.runInContext(dlgJs, ctx);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const $ = (s) => document.querySelector(s);
  const posts = () => calls.filter((c) => c.method === "POST");
  return { window, document, calls, posts, settle, click, $, reloaded: () => reloaded, stored };
}

const json = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });
const okRegistered = (url) => (url === "/api/models/registered" ? json(200, REGISTERED) : null);

test("static: Adopt sits next to Download on an unregistered card; Register as… next to Start on a registered one", () => {
  const html = renderCuratedTab({ models: [cardModel(), cardModel({ id: "reg-1", registered: true, registeredQuant: "Q8_0" })], hfTokenConfigured: false }, "en");
  const unreg = html.split('class="mcat-card__actions" data-model-id="vision-4b"')[1].split("</div>")[0];
  assert.match(unreg, /data-action="download"/);
  assert.match(unreg, /data-action="adopt"/);
  const reg = html.split('class="mcat-card__actions" data-model-id="reg-1"')[1].split("</div>")[0];
  assert.match(reg, /data-action="start"/);
  assert.match(reg, /data-action="register-as"/);
  assert.match(html, /data-launch="\{&quot;ctx&quot;:32768,&quot;ngl&quot;:999\}"/);
  assert.match(html, /data-companions="\[&quot;mmproj&quot;,&quot;mtp&quot;\]"/);
  assert.match(html, /data-quants="\[&quot;Q4_K_M&quot;,&quot;Q8_0&quot;\]"/);
  const off = renderCuratedTab({ models: [cardModel(), cardModel({ id: "reg-1", registered: true })], hfTokenConfigured: false, orchestrationDisabled: true }, "en");
  assert.doesNotMatch(off, /data-action="(adopt|register-as)"/, "an orchestration-off host cannot register (409), so it is not offered");
});

test("static: the dialog script has no backticks and never assigns innerHTML; the HF Adopt button is built with createElement", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/dashboard/panels/model-catalog-dialog.js"), "utf8");
  const body = src.slice(src.indexOf("export function dialogClientJS"));
  assert.equal(body.slice(body.indexOf("<script>"), body.lastIndexOf("</script>")).includes("`"), false);
  assert.doesNotMatch(dialogClientJS("en"), /\.innerHTML\s*=/);
  const cat = modelCatalogClientJS("en");
  assert.match(cat, /setAttribute\("data-hf-repo"/);
  assert.match(cat, /setAttribute\("data-hf-file"/);
});

test("BEHAVIOR: the adopt payload carries the path, the launch JSON and only the filled companion paths", async () => {
  const b = boot([cardModel()], (url) => okRegistered(url) || (url === "/api/models/adopt" ? json(200, { provider: { id: "vision-4b" }, verified: true, running: false }) : json(200, {})));
  b.click(b.$('.mcat-card [data-action="adopt"]'));
  await b.settle();
  assert.equal(b.$("#mcat-modal-overlay").style.display, "flex");
  assert.equal(b.$("#mcat-dlg-launch").value, '{"ctx":32768,"ngl":999}', "pre-filled from the card's data-launch");
  b.$("#mcat-dlg-path").value = "/srv/models/vision-4b-Q4_K_M.gguf";
  b.$('[data-companion-kind="mmproj"]').value = "/srv/models/mmproj-F16.gguf";
  b.$("#mcat-dlg-launch").value = '{"ctx": 8192}';
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  const post = b.posts().find((c) => c.url === "/api/models/adopt");
  assert.ok(post, "POSTed to /adopt");
  assert.equal(post.headers["X-Crow-Csrf"], "tok123");
  assert.equal(post.body.catalogId, "vision-4b");
  assert.equal(post.body.quant, "Q4_K_M");
  assert.equal(post.body.path, "/srv/models/vision-4b-Q4_K_M.gguf");
  assert.deepEqual(post.body.launch, { ctx: 8192 });
  assert.deepEqual(post.body.companionPaths, { mmproj: "/srv/models/mmproj-F16.gguf" }, "the empty mtp path is not sent");
  assert.equal(post.body.allowUnverified, false);
  assert.equal(b.reloaded(), 1);
});

test("BEHAVIOR: a 400 keeps the dialog open and shows the code, the message and each errors[] entry", async () => {
  const b = boot([cardModel({ registered: true, registeredQuant: "Q4_K_M" })], (url) => okRegistered(url)
    || (url === "/api/models/register" ? json(400, { code: "INVALID_LAUNCH", error: "invalid launch override", errors: ["launch: ctx must be an integer >= 1024", "launch: unknown key \"nope\""] }) : json(200, {})));
  b.click(b.$('.mcat-card [data-action="register-as"]'));
  await b.settle();
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  assert.equal(b.$("#mcat-modal-overlay").style.display, "flex", "still open");
  const err = b.$("#mcat-dlg-error").textContent;
  assert.match(err, /INVALID_LAUNCH/);
  assert.match(err, /ctx must be an integer/);
  assert.match(err, /unknown key "nope"/);
  assert.equal(b.reloaded(), 0);
});

test("BEHAVIOR: bad launch JSON sends nothing", async () => {
  const b = boot([cardModel({ registered: true, registeredQuant: "Q4_K_M" })], (url) => okRegistered(url) || json(200, {}));
  b.click(b.$('.mcat-card [data-action="register-as"]'));
  await b.settle();
  b.$("#mcat-dlg-launch").value = "{ctx: 4096";
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  assert.equal(b.posts().length, 0);
  assert.match(b.$("#mcat-dlg-error").textContent, /not valid JSON/);
});

test("BEHAVIOR: edit locks the provider id, pre-fills the row and re-registers under it; a running model leaves a restart note", async () => {
  const b = boot([], (url) => okRegistered(url) || (url === "/api/models/register" ? json(200, { provider: { id: "crow-chat" }, running: true }) : json(200, {})));
  b.window.CrowModelDialog.open({ mode: "edit", row: { provider: "crow-chat", catalogId: "small-chat", quant: "Q4_K_M", mutexGroup: "g2", launch: { ctx: 4096 }, alwaysResident: true, defaultMember: false, status: "resident" } });
  await b.settle();
  const id = b.$("#mcat-dlg-provider");
  assert.equal(id.value, "crow-chat");
  assert.equal(id.disabled, true, "locked in edit");
  assert.equal(b.$("#mcat-dlg-group").value, "g2");
  assert.equal(b.$("#mcat-dlg-resident").checked, true);
  assert.equal(b.$("#mcat-dlg-path"), null, "no path field in edit");
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  const post = b.posts().find((c) => c.url === "/api/models/register");
  assert.equal(post.body.providerId, "crow-chat");
  assert.equal(post.body.catalogId, "small-chat");
  assert.equal(post.body.quant, "Q4_K_M");
  assert.equal(post.body.mutexGroup, "g2");
  assert.equal(post.body.alwaysResident, true);
  assert.deepEqual(post.body.launch, { ctx: 4096 });
  assert.deepEqual(JSON.parse(b.stored["mcat-edited"]), ["crow-chat"]);
});

test("BEHAVIOR: group 'none' sends null; 'automatic' leaves the group out; an emptied launch sends no override", async () => {
  const b = boot([cardModel({ registered: true, registeredQuant: "Q4_K_M" })], (url) => okRegistered(url) || json(200, { provider: { id: "x" }, running: false }));
  b.click(b.$('.mcat-card [data-action="register-as"]'));
  await b.settle();
  const group = b.$("#mcat-dlg-group");
  assert.deepEqual([...group.options].map((o) => o.value), ["", "__none__", "crow-strix-vram", "g2"]);
  assert.ok(b.$('#mcat-dlg-roles option[value="crow-chat"]'), "suggested roles in a datalist");
  b.$("#mcat-dlg-launch").value = "";
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  const first = b.posts().at(-1).body;
  assert.equal("mutexGroup" in first, false);
  assert.equal("launch" in first, false);
  // linkedom: setting selected=false on a later option clears an earlier
  // true, so clear all first, then pick one.
  for (const o of group.options) o.selected = false;
  [...group.options].find((o) => o.value === "__none__").selected = true;
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  assert.equal(b.posts().at(-1).body.mutexGroup, null);
});

// ─── Live layout ────────────────────────────────────────────────────────────

let chrome = null, server = null, base = "";
before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  _setRegisteredSnapshotForTest(() => REGISTERED);
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/api/models/registered")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(REGISTERED));
    }
    if (req.url.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
    const layout = (o) => renderLayout({ ...o, activePanel: "model-catalog", panels: [], lang: "en" });
    const html = await modelCatalogPanel.handler(req, res, { db: null, layout, lang: "en" });
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
  test(`live ${w}x${h}: the open adopt dialog fits the viewport, scrolls inside, and Save is reachable`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await withLivePage(chrome, base + "/dashboard/model-catalog", { width: w, height: h, readyExpr: "!!window.CrowModelDialog && !!document.querySelector('.mcat-card [data-action=\"adopt\"]')" }, async (evalIn) => {
      await evalIn(`(function(){
        var cards = [].slice.call(document.querySelectorAll('.mcat-card'));
        var withCompanions = cards.filter(function(c){ try { return JSON.parse(c.getAttribute('data-companions') || '[]').length > 0; } catch (e) { return false; } })[0];
        var card = withCompanions || cards[0];
        card.querySelector('[data-action="adopt"]').click();
        return 1;
      })()`);
      await evalIn("new Promise(function(r){ setTimeout(r, 300); })");
      return JSON.parse(await evalIn(`JSON.stringify((function(){
        var box = document.getElementById('mcat-modal-content');
        var r = box.getBoundingClientRect();
        var save = document.getElementById('mcat-dlg-save');
        save.scrollIntoView({ block: 'nearest' });
        var s = save.getBoundingClientRect();
        return {
          open: getComputedStyle(document.getElementById('mcat-modal-overlay')).display,
          box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
          vw: window.innerWidth, vh: window.innerHeight,
          scrollsInside: getComputedStyle(box).overflowY,
          save: { top: s.top, bottom: s.bottom, left: s.left, right: s.right },
          hScroll: document.documentElement.scrollWidth > window.innerWidth,
        };
      })())`));
    });
    assert.equal(m.open, "flex");
    assert.ok(m.box.top >= 0 && m.box.bottom <= m.vh + 0.5, `dialog vertical ${m.box.top}..${m.box.bottom} vs ${m.vh}`);
    assert.ok(m.box.left >= 0 && m.box.right <= m.vw + 0.5, `dialog horizontal ${m.box.left}..${m.box.right} vs ${m.vw}`);
    assert.equal(m.scrollsInside, "auto");
    assert.ok(m.save.top >= m.box.top - 0.5 && m.save.bottom <= m.box.bottom + 0.5, "Save visible inside the dialog after scrolling");
    assert.ok(m.save.left >= 0 && m.save.right <= m.vw + 0.5);
    assert.equal(m.hScroll, false);
  });
}

// ─── Review fixes (2026-10-15) ──────────────────────────────────────────────

test("review 3: adopt warns that hashing a large file takes minutes, and a second Save while one is pending sends nothing", async () => {
  const b = boot([cardModel()], (url) => okRegistered(url) || (url === "/api/models/adopt" ? new Promise(() => {}) : json(200, {})));
  b.click(b.$('.mcat-card [data-action="adopt"]'));
  await b.settle();
  assert.match(b.$("#mcat-modal-content").textContent, /several minutes/);
  b.$("#mcat-dlg-path").value = "/srv/models/big.gguf";
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  assert.equal(b.posts().filter((c) => c.url === "/api/models/adopt").length, 1);
  assert.equal(b.$("#mcat-dlg-save").disabled, true);
});

test("review 6: hf-adopt offers no size-only option and never sends allowUnverified", async () => {
  const b = boot([], (url) => okRegistered(url) || json(200, { provider: { id: "x" } }));
  b.window.CrowModelDialog.open({ mode: "hf-adopt", hfRepo: "org/Repo-GGUF", hfFile: "Repo-Q4_K_M.gguf" });
  await b.settle();
  assert.equal(b.$("#mcat-dlg-unverified"), null);
  b.$("#mcat-dlg-path").value = "/srv/models/Repo-Q4_K_M.gguf";
  b.click(b.$("#mcat-dlg-save"));
  await b.settle();
  const post = b.posts().find((c) => c.url === "/api/models/hf-adopt");
  assert.deepEqual(JSON.parse(JSON.stringify(post.body)), { hfRepo: "org/Repo-GGUF", file: "Repo-Q4_K_M.gguf", path: "/srv/models/Repo-Q4_K_M.gguf" });
});
