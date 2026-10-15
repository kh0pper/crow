/**
 * Models plan 3a, Task 4 (Rev 2: no "retired" chip): model bundles
 * (`inference: true`) leave Browse; one "Local models" card in the AI group
 * links to the Model Catalog. Installed model bundles keep their row, actions
 * and detail modal until plan 4 migrates them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { extensionStyles } from "../servers/gateway/dashboard/panels/extensions/css.js";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";
import { localModelsCounts } from "../servers/gateway/dashboard/panels/extensions/local-models-card.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { withLivePage } from "./fixtures/live-page.mjs";

const AI = (id, extra = {}) => ({ id, name: id, description: `${id} desc`, type: "bundle", category: "ai", version: "1.0.0", author: "Crow", tags: [], ...extra });
const AVAILABLE = [
  AI("ollama"),
  AI("localai"),
  AI("vllm-cuda-embed", { inference: true, featured: true }),
  AI("llamacpp-vulkan-embed", { inference: true }),
  AI("vllm-rocm-vision", { inference: true }),
  { id: "jellyfin", name: "Jellyfin", description: "Media", type: "bundle", category: "media", version: "1.0.0", author: "Crow", tags: [] },
];

function render(overrides = {}) {
  return buildExtensionsHTML({
    installed: {}, available: AVAILABLE, collections: [], registrySource: "local", communityStores: [], bundleStatus: {},
    localModels: { registered: 3, resident: 1 }, lang: "en", ...overrides,
  });
}
const browse = (html) => html.split('id="ext-view-browse"')[1].split('id="ext-view-installed"')[0];
const registryJson = (s) => JSON.parse(s.match(/<script id="addon-registry" type="application\/json">([\s\S]*?)<\/script>/)[1]);

test("Browse carries no inference bundle but keeps the other AI add-ons", () => {
  const b = browse(render().viewsHtml);
  for (const id of ["vllm-cuda-embed", "llamacpp-vulkan-embed", "vllm-rocm-vision"]) {
    assert.ok(!b.includes(`data-addon-id="${id}"`), `${id} left Browse`);
  }
  assert.ok(b.includes('data-addon-id="ollama"'));
  assert.ok(b.includes('data-addon-id="localai"'));
  assert.ok(!/id="ext-featured"/.test(b), "the only featured add-on was a model bundle");
});

test("the Local models card: icon box with the models glyph, counts, a link to the Model Catalog, first in the AI grid", () => {
  const b = browse(render().viewsHtml);
  const ai = b.split('class="ext-group-section" data-group="ai"')[1].split("</section>")[0];
  const firstCard = ai.match(/<div class="ext-card addon-card[^"]*" data-addon-id="([^"]+)"/)[1];
  assert.equal(firstCard, "local-models");
  const card = ai.split('data-addon-id="local-models"')[1].split('<div class="ext-card addon-card')[0];
  assert.match(card, /class="ext-card__icon"[^>]*><svg/);
  assert.match(card, /href="\/dashboard\/model-catalog"/);
  assert.match(card, /Open Model Catalog/);
  assert.match(card, /3 registered · 1 running/);
  assert.match(b, /data-addon-id="local-models"[^>]*data-addon-group="ai"/);
  assert.match(b, /data-addon-id="local-models"[^>]*data-addon-name="local models"/, "search finds it by name");
});

test("AI chip and section counts are the non-inference AI add-ons + 1", () => {
  const b = browse(render().viewsHtml);
  assert.match(b, /class="ext-group-chip" data-group="ai">[^<]*<span class="ext-group-chip__count">3<\/span>/);
  assert.match(b, /data-group="ai">\s*<h3 class="ext-section-title">[^<]*<span class="ext-section-count">3<\/span>/);
});

test("Show all (N) counts the Local models card too, in en and es", () => {
  const many = Array.from({ length: 8 }, (_, i) => AI(`ai-${i}`));
  for (const lang of ["en", "es"]) {
    const b = browse(render({ available: many, lang }).viewsHtml);
    const label = lang === "en" ? "Show all" : "Ver todo";
    assert.ok(b.includes(`data-group="ai">${label} (9)</button>`), `${lang}: Show all (9)`);
  }
});

test("with no AI add-ons left at all, the AI group still exists for the card", () => {
  const b = browse(render({ available: [AVAILABLE[2], AVAILABLE[5]] }).viewsHtml);
  assert.match(b, /data-group="ai"/);
  assert.match(b, /data-addon-id="local-models"/);
});

test("Spanish strings on the card", () => {
  const b = browse(render({ lang: "es" }).viewsHtml);
  assert.match(b, /Modelos locales/);
  assert.match(b, /Abrir el Catálogo de modelos/);
  assert.match(b, /3 registrados · 1 en ejecución/);
});

test("the addon registry JSON keeps installed inference bundles and drops the rest", () => {
  const { addonRegistryScript } = render({ installed: { "vllm-rocm-vision": { version: "1.0.0" } } });
  const map = registryJson(addonRegistryScript);
  assert.ok(map["vllm-rocm-vision"], "installed: keeps its detail modal");
  assert.ok(!map["vllm-cuda-embed"]);
  assert.ok(!map["llamacpp-vulkan-embed"]);
  assert.ok(map.ollama);
  assert.ok(!map["local-models"], "the card never opens a detail modal");
});

test("an installed model bundle stays under Installed with its actions", () => {
  const { viewsHtml } = render({
    installed: { "vllm-rocm-vision": { version: "1.0.0" } },
    bundleStatus: { "vllm-rocm-vision": { running: true } },
  });
  const inst = viewsHtml.split('id="ext-view-installed"')[1];
  const row = inst.split('data-addon-id="vllm-rocm-vision"')[1].split('class="ext-installed__item"')[0];
  assert.match(row, /data-action="stop"/);
  assert.match(row, /bundle-uninstall/);
});

test("no retired chip: an installed id missing from the registry keeps every action", () => {
  const { viewsHtml } = render({
    installed: { "capstone-tracker": { version: "0.3.0" } },
    bundleStatus: { "capstone-tracker": { running: false } },
  });
  const inst = viewsHtml.split('id="ext-view-installed"')[1];
  const row = inst.split('data-addon-id="capstone-tracker"')[1].split('class="ext-installed__item"')[0];
  assert.match(row, /data-action="start"/);
  assert.match(row, /bundle-uninstall/);
  assert.ok(!/retired/i.test(row));
});

test("without localModels (pure callers) nothing changes but the inference filter", () => {
  const b = browse(buildExtensionsHTML({ installed: {}, available: AVAILABLE, collections: [], registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en" }).viewsHtml);
  assert.ok(!b.includes('data-addon-id="local-models"'));
  assert.match(b, /class="ext-group-chip" data-group="ai">[^<]*<span class="ext-group-chip__count">2<\/span>/);
});

test("localModelsCounts counts own and peer rows from the listing, never foreign ones", () => {
  const rows = [
    { provider: "a", status: "resident" }, { provider: "b", status: "stopped" }, { provider: "c", status: "external_up" },
    { provider: "d", status: "external_down" }, { provider: "e", status: "foreign" }, { provider: "f", status: "loading" },
  ];
  assert.deepEqual(localModelsCounts(() => rows), { registered: 5, resident: 2 });
  assert.deepEqual(localModelsCounts(() => { throw new Error("db down"); }), { registered: 0, resident: 0 });
});

// ─── Live layout ────────────────────────────────────────────────────────────

let chrome = null, server = null, base = "";
before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  server = http.createServer((req, res) => {
    const { viewsHtml } = render({ available: [...AVAILABLE, AI("a-very-long-named-ai-addon-that-wraps-around-on-a-phone")] });
    const content = extensionStyles() + viewsHtml + "<style>.ext-card{animation:none!important}</style>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLayout({ title: "Extensions", content, activePanel: "extensions", panels: [], lang: "en" }));
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  base = `http://${chrome.pageHost}:${server.address().port}`;
});
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

for (const [w, h] of [[412, 915], [1280, 900]]) {
  test(`live ${w}x${h}: no sideways scroll; the Local models icon box matches its neighbour`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await withLivePage(chrome, base + "/dashboard/extensions", { width: w, height: h, readyExpr: "!!document.querySelector('[data-addon-id=\"local-models\"]')" }, async (evalIn) =>
      JSON.parse(await evalIn(`JSON.stringify((function(){
        var grid = document.querySelector('.ext-group-section[data-group="ai"] .ext-grid');
        var icons = [].slice.call(grid.querySelectorAll('.ext-card__icon'));
        var a = icons[0].getBoundingClientRect(), b = icons[1].getBoundingClientRect();
        var link = document.querySelector('[data-addon-id="local-models"] a[href="/dashboard/model-catalog"]').getBoundingClientRect();
        return { hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          a: [Math.round(a.width), Math.round(a.height)], b: [Math.round(b.width), Math.round(b.height)],
          linkInside: link.left >= 0 && link.right <= document.documentElement.clientWidth };
      })())`)));
    assert.equal(m.hScroll, false);
    assert.deepEqual(m.a, m.b, "same icon box size as the neighbouring card");
    assert.ok(m.a[0] > 0);
    assert.equal(m.linkInside, true);
  });
}
