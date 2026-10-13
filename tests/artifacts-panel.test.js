// Crow Artifacts — the Library and the viewer page (plan PR-2 Tasks 2.1/2.5):
// en/es string parity, the Library's no-frame CSP and its ?id redirect, the
// viewer page's CSP + Turbo meta, and the LIVE check of Review Focus 5 —
// arriving through a Turbo visit from another panel must full-reload into the
// viewer page's own CSP so the frame loads on the http://localhost:<port>
// fallback origin. Plus phone width (412×730): no horizontal page scroll, the
// threads sheet docked at the bottom, tappable controls (the #452 rules).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { csrfMiddleware } from "../servers/gateway/dashboard/shared/csrf.js";
import * as runtime from "../servers/gateway/artifact-origin/runtime.js";
import * as policy from "../servers/gateway/artifact-origin/policy.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import * as store from "../bundles/artifacts/server/store.js";
import artifactsRouter from "../bundles/artifacts/panel/routes.js";
import artifactsPanel, { ARTIFACTS_STRINGS, LIBRARY_CSP } from "../bundles/artifacts/panel/artifacts.js";
import { VIEWER_STRINGS, viewerHeaders, viewerParams, renderViewerPage, ARTIFACT_ID_RE } from "../bundles/artifacts/panel/viewer-page.js";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = { kind: "session" };

// ─── static: string parity (same rule as tests/workspace-panel.test.js) ────

test("ARTIFACTS_STRINGS: en and es have the same keys; every es value is non-empty and differs from en", () => {
  const { en, es } = ARTIFACTS_STRINGS;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  for (const k of Object.keys(en)) {
    assert.ok(typeof es[k] === "string" && es[k].trim().length > 0, `es.${k} non-empty`);
    assert.notEqual(es[k], en[k], `es.${k} is translated`);
  }
});

test("ARTIFACTS_STRINGS: {placeholder} sets match between en and es", () => {
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const k of Object.keys(ARTIFACTS_STRINGS.en)) {
    assert.equal(ph(ARTIFACTS_STRINGS.es[k]), ph(ARTIFACTS_STRINGS.en[k]), k);
  }
  assert.ok(ARTIFACTS_STRINGS.en.fallback_remote && ARTIFACTS_STRINGS.es.fallback_remote, "O11 string exists in both languages");
});

// ─── static: the clients' XSS invariant (review R1) ─────────────────────

for (const file of ["panel-client.js", "viewer-client.js"]) {
  test(`${file} places every authored text via textContent — pinned at the source (review R1)`, async () => {
    const src = readFileSync(new URL(`../bundles/artifacts/panel/static/${file}`, import.meta.url), "utf8");
    // The mutation that survived: el()'s text branch flipped to innerHTML.
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|outerHTML\s*=/, "no HTML sink");
    assert.match(src, /if \(k === "text"\) n\.textContent = attrs\[k\]/, "el()'s text branch assigns textContent");
  });
}

test("D26: no owner-facing Ask-now anywhere — the Library and the viewer page never start an ask round", () => {
  for (const file of ["panel-client.js", "viewer-client.js"]) {
    const src = readFileSync(new URL(`../bundles/artifacts/panel/static/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /ask_now|kind:\s*"ask"|"ask"\)/, `${file}: no ask control`);
  }
  for (const L of ["en", "es"]) {
    assert.equal(ARTIFACTS_STRINGS[L].ask_now, undefined);
    assert.equal(VIEWER_STRINGS[L].ask_now, undefined);
  }
});

test("VIEWER_STRINGS: en/es parity, translated, same placeholders", () => {
  const { en, es } = VIEWER_STRINGS;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  const ph = (x) => [...String(x).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const same = new Set(["bot"]);   // a loanword in both languages
  for (const k of Object.keys(en)) {
    assert.ok(es[k] && es[k].trim(), `es.${k} non-empty`);
    if (!same.has(k)) assert.notEqual(es[k], en[k], `es.${k} is translated`);
    assert.equal(ph(es[k]), ph(en[k]), k);
  }
});

// ─── static: the Library handler and the viewer page ──────────────────────

function fakeRes() {
  return {
    headers: {}, html: null, redirected: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    send(x) { this.html = x; },
    redirect(code, url) { this.redirected = [code, url]; },
  };
}
const layoutSpy = () => {
  let captured = null;
  const layout = (opts) => { captured = opts; return `<!doctype html><html><head>${opts.head || ""}</head><body>${opts.content}</body></html>`; };
  return { layout, get captured() { return captured; } };
};

test("the Library frames nothing (frame-src 'none'); an old ?id= deep link redirects to the viewer page", async () => {
  const res = fakeRes();
  const spy = layoutSpy();
  await artifactsPanel.handler({ query: {} }, res, { layout: spy.layout, lang: "en" });
  assert.equal(res.headers["content-security-policy"], LIBRARY_CSP);
  assert.match(LIBRARY_CSP, /frame-src 'none'/);
  assert.doesNotMatch(spy.captured.content, /viewer\.js/, "the Library loads no viewer");
  assert.match(spy.captured.content, /data-strings="\{&quot;title&quot;:&quot;Artifacts&quot;/, "strings are HTML-escaped into the attribute");
  const resEs = fakeRes();
  await artifactsPanel.handler({ query: {} }, resEs, { layout: layoutSpy().layout, lang: "es" });
  assert.match(resEs.html, /Artefactos/);
  const r = fakeRes();
  await artifactsPanel.handler({ query: { id: "art_abc12345" } }, r, { layout: layoutSpy().layout, lang: "en" });
  assert.deepEqual(r.redirected, [302, "/dashboard/artifacts/view/art_abc12345"]);
  const bad = fakeRes();
  await artifactsPanel.handler({ query: { id: '"><script>alert(1)</script>' } }, bad, { layout: layoutSpy().layout, lang: "en" });
  assert.equal(bad.redirected, null, "a non-art id never redirects");
  assert.doesNotMatch(bad.html, /<script>alert/, "and is never re-emitted");
});

test("viewer page: the core viewerCsp (frame-ancestors 'self'), no-store, validated query, escaped attributes", () => {
  const h = viewerHeaders(policy.viewerCsp, "https://artifacts.example.ts.net");
  assert.equal(h["content-security-policy"], policy.viewerCsp("https://artifacts.example.ts.net"));
  assert.match(h["content-security-policy"], /frame-src https:\/\/artifacts\.example\.ts\.net\/v\/; frame-ancestors 'self'/);
  assert.equal(h["cache-control"], "no-store");
  assert.match(viewerHeaders(policy.viewerCsp, null)["content-security-policy"], /frame-src 'none'/, "fail closed without an origin");
  assert.deepEqual(viewerParams({ v: "3", thread: "perchlive-0123abcd" }), { v: 3, thread: "perchlive-0123abcd" });
  assert.deepEqual(viewerParams({ v: "0", thread: "a b" }), { v: null, thread: null });
  assert.deepEqual(viewerParams({ v: ["2"], thread: ["x"] }), { v: null, thread: null }, "arrays are not values");
  assert.deepEqual(viewerParams({ v: "1e3", thread: '"><x' }), { v: null, thread: null });
  const html = renderViewerPage({ lang: "es", id: "art_abc12345", v: 2, thread: "perchlive-0123abcd" });
  assert.match(html, /<meta name="turbo-visit-control" content="reload">/);
  assert.match(html, /data-artifact="art_abc12345" data-version="2" data-thread="perchlive-0123abcd"/);
  assert.match(html, /<html lang="es">/);
  assert.match(html, /&quot;comment&quot;:&quot;Comentar&quot;/);
  assert.match(html, /<script src="\/artifacts\/static\/viewer\.js"><\/script>\s*<script src="\/artifacts\/static\/viewer-client\.js"><\/script>/);
  assert.ok(ARTIFACT_ID_RE.test("art_abc12345") && !ARTIFACT_ID_RE.test("art_<x>"));
});

// ─── live: Turbo visit + loopback fallback + phone width ───────────────────

let chrome = null, server = null, port = 0, s = null;
let servedGets = [];
const pageIds = {};

async function freePort() {
  const srv = express();
  const http = await import("node:http");
  const h = http.createServer(srv);
  await new Promise((r) => h.listen(0, "127.0.0.1", r));
  const p = h.address().port;
  await new Promise((r) => h.close(r));
  return p;
}

before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;

  s = { dir: mkdtempSync(join(tmpdir(), "artifacts-panel-")) };
  s.db = createDbClient(join(s.dir, "crow.db"));
  await initArtifactsTables(s.db);
  const local = createLocalBlobStore(join(s.dir, "blobs"));
  s.blobs = { ...local, get: (k) => { servedGets.push(k); return local.get(k); } };
  s.page = await store.createArtifact(s.db, local, { title: "Page", type: "page", source: { html: '<!doctype html><p id="x">hello</p>' }, actor: OWNER }, {});
  s.doc = await store.createArtifact(s.db, local, { title: "Doc", type: "document", source: { markdown: "# Section one\n\nfirst words\n\n# Section two\n\nsecond words" }, actor: OWNER }, { markdownBlocks });
  pageIds.page = s.page.id; pageIds.doc = s.doc.id;

  // The REAL fallback origin: loopback, baseUrl http://localhost:<port>.
  runtime._resetForTest();
  const originPort = await freePort();
  await runtime.startArtifactOriginFromEnv({ CROW_ARTIFACT_ORIGIN_PORT: String(originPort) });

  const dashAuth = (_req, _res, next) => next();
  const app = express();
  app.use((_req, res, next) => {
    res.append("set-cookie", "crow_session=good; Path=/");
    res.append("set-cookie", "crow_csrf=tok; Path=/");
    next();
  });
  app.use(artifactsRouter(dashAuth, {
    db: s.db, blobs: s.blobs, runtime, policy, csrf: csrfMiddleware, renderDeps: { markdownBlocks },
    notify: async () => {},
  }));
  app.get("/vendor/turbo-8.0.5.umd.js", (_req, res) => {
    res.setHeader("content-type", "application/javascript");
    res.end(readFileSync(join(ROOT, "servers/gateway/public/vendor/turbo-8.0.5.umd.js")));
  });
  const layout = (opts) => renderLayout({ ...opts, activePanel: "artifacts", panels: [artifactsPanel], lang: "en" });
  // Another panel, under the GLOBAL policy shape (frame-src 'self' https:) —
  // the Turbo body-swap hazard the reload meta must defeat.
  app.get("/dashboard/other", (_req, res) => {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' https:; img-src 'self' data:");
    res.setHeader("content-type", "text/html");
    res.end(layout({ title: "Other", content: `<a id="go" href="/dashboard/artifacts/view/${encodeURIComponent(pageIds.page)}">open artifact</a>` }));
  });
  app.get("/dashboard/artifacts", (req, res) => artifactsPanel.handler(req, res, { layout, lang: "en" }));

  server = await new Promise((r) => { const h = app.listen(0, chrome.bindHost, () => r(h)); });
  port = server.address().port;
});

after(async () => {
  if (server) server.closeAllConnections?.();
  if (server) await new Promise((r) => server.close(r));
  runtime._resetForTest();
  if (s) { try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); }
  if (chrome) await chrome.close();
});

async function tab() {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolveP, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolveP(m.result || {}); };
    ws.on("message", on);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expr) => {
    const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) return { threw: out.exceptionDetails.exception?.className || out.exceptionDetails.text };
    return out.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").slice(0, 300));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console: " + JSON.stringify(m.params.args.map((a) => a.value ?? a.description)).slice(0, 300));
  });
  return { send, evalIn, errors, nav: (url) => send("Page.navigate", { url }), close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(150); }
  return null;
}

test("live: a Turbo visit from another panel full-reloads into this page's CSP, and the frame loads on the http://localhost fallback origin", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  try {
    await t.nav(`${base}/dashboard/other`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!window.Turbo && document.readyState === "complete"`)) === true, 10000), "the other panel loaded with Turbo");
    await t.evalIn(`window.__fromOther = 1`);
    servedGets = [];
    await t.evalIn(`document.getElementById("go").click()`);
    // Arrival: the artifacts page is the document, and it got there by FULL
    // reload (turbo-visit-control) — a body swap would keep window.__fromOther
    // AND the other page's frame-src, which cannot frame http://localhost.
    assert.ok(await waitFor(async () => (await t.evalIn(`location.pathname`)) === "/dashboard/artifacts/view/" + pageIds.page, 10000), "navigated");
    assert.equal(await t.evalIn(`window.__fromOther`), undefined, "full reload, not a Turbo body swap");
    assert.equal(await t.evalIn(`!!document.querySelector('meta[name="turbo-visit-control"][content="reload"]')`), true, "the meta lives in the live document's head");
    // The sealed frame mounted AND the origin actually served its content
    // (index.html of the page version) over the loopback fallback.
    const mounted = await waitFor(async () => (await t.evalIn(`!!document.querySelector('iframe.crow-artifact-frame')`)) === true, 15000);
    assert.ok(mounted, `frame mounted (page errors: ${JSON.stringify(t.errors)})`);
    assert.ok(await waitFor(() => servedGets.length >= 1, 10000), `the origin served the frame's content (${servedGets.length} gets)`);
    assert.equal(await t.evalIn(`!!document.querySelector('.cv-danger, .cv-flagged')`), false, "no tripwire/canary banner: the narrowed CSP was in force");
  } finally { await t.close(); }
});

test("live @412x730: no horizontal page scroll, the threads sheet docks at the bottom, controls are tappable, a section jump loads a fresh frame", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  try {
    await t.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 730, deviceScaleFactor: 2, mobile: true });
    // The old deep link redirects to the viewer page.
    await t.nav(`${base}/dashboard/artifacts?id=${encodeURIComponent(pageIds.doc)}`);
    const ready = await waitFor(async () => (await t.evalIn(`location.pathname.startsWith('/dashboard/artifacts/view/') && !!document.querySelector('iframe.crow-artifact-frame') && document.querySelectorAll('.cv-sections button').length >= 2`)) === true, 15000);
    assert.ok(ready, `frame + sections rendered (page errors: ${JSON.stringify(t.errors)})`);
    await waitFor(() => servedGets.length >= 1, 10000);
    const m = await t.evalIn(`(() => {
      const de = document.documentElement;
      const side = document.querySelector('.cv-side').getBoundingClientRect();
      const c = document.querySelector('.cv-comment').getBoundingClientRect();
      return JSON.stringify({ innerWidth, innerHeight, scrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
        sideBottom: side.bottom, sideH: side.height, commentH: c.height, commentW: c.width });
    })()`);
    const g = JSON.parse(m);
    assert.ok(g.scrollWidth <= g.innerWidth && g.bodyScrollWidth <= g.innerWidth, `no horizontal page scroll: ${m}`);
    assert.ok(Math.abs(g.sideBottom - g.innerHeight) <= 2 && g.sideH <= 80, `collapsed sheet docked at the bottom: ${m}`);
    assert.ok(g.commentH >= 44 && g.commentW >= 44, `the Comment toggle is tappable: ${m}`);
    // Comment on a document opens the sections list in the sheet.
    await t.evalIn(`document.querySelector('.cv-comment').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`document.querySelector('.cv-side').classList.contains('cv-open') && !document.querySelector('.cv-sections').hidden`)) === true), "the sheet opened on the sections");
    const btnH = await t.evalIn(`document.querySelector('.cv-sections button').getBoundingClientRect().height`);
    assert.ok(btnH >= 44, `section buttons are tappable (${btnH}px)`);
    const before = servedGets.length;
    await t.evalIn(`document.querySelectorAll('.cv-sections button')[1].click()`);
    assert.ok(await waitFor(() => servedGets.length > before, 10000), "the section jump loaded the fresh frame's content");
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-compose textarea')`)) === true), "and opened the compose box");
  } finally { await t.close(); }
});
