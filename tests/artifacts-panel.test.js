// Crow Artifacts — the panel page (plan Task 2.7): en/es string parity, the
// page handler's CSP header + Turbo meta, and the LIVE check of Review Focus
// 5 — arriving through a Turbo visit from another panel must full-reload into
// this page's own CSP so the frame loads on the http://localhost:<port>
// fallback origin. Plus phone width (412×730): no horizontal page scroll and
// the rail below the frame (the #452 rules).
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
import artifactsPanel, { ARTIFACTS_STRINGS } from "../bundles/artifacts/panel/artifacts.js";
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

// ─── static: the client's XSS invariant (review R1) ─────────────────────

test("panel-client places every authored text via textContent — pinned at the source (review R1)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bundles/artifacts/panel/static/panel-client.js", import.meta.url), "utf8");
  // The mutation that survived: el()'s text branch flipped to innerHTML.
  // No sink, anywhere, and the text branch must be a textContent assignment.
  assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|outerHTML\s*=/, "no HTML sink in the panel client");
  assert.match(src, /if \(k === "text"\) n\.textContent = attrs\[k\]/, "el()'s text branch assigns textContent");
});

// ─── static: the page handler ───────────────────────────────────────────────

function fakeRes() {
  return {
    headers: {},
    html: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    send(s) { this.html = s; },
  };
}
const layoutSpy = () => {
  let captured = null;
  const layout = (opts) => { captured = opts; return `<!doctype html><html><head>${opts.head || ""}</head><body>${opts.content}</body></html>`; };
  return { layout, get captured() { return captured; } };
};

test("the handler sends the core viewerCsp for the configured origin and the Turbo reload meta in head", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const savedInfo = runtime.artifactOriginInfo();
  runtime._setInfoForTest({ baseUrl: "https://artifacts.example.ts.net", port: 0, configured: true });
  try {
    const res = fakeRes();
    const spy = layoutSpy();
    await artifactsPanel.handler({ query: {} }, res, { layout: spy.layout, lang: "en" });
    assert.equal(res.headers["content-security-policy"], policy.viewerCsp("https://artifacts.example.ts.net"));
    assert.match(res.headers["content-security-policy"], /frame-src https:\/\/artifacts\.example\.ts\.net\/v\//);
    assert.equal(spy.captured.head, '<meta name="turbo-visit-control" content="reload">');
    assert.match(spy.captured.content, /id="crow-artifacts"/);
    assert.match(spy.captured.content, /data-strings="\{&quot;title&quot;:&quot;Artifacts&quot;/, "strings are HTML-escaped into the attribute");
    // es renders the es strings
    const resEs = fakeRes();
    await artifactsPanel.handler({ query: {} }, resEs, { layout: layoutSpy().layout, lang: "es" });
    assert.match(resEs.html, /Artefactos/);
  } finally { runtime._setInfoForTest(savedInfo); }
});

test("the handler frames nothing without a running origin, and never trusts ?id", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const savedInfo = runtime.artifactOriginInfo();
  runtime._setInfoForTest(null);   // no origin info
  try {
    const res = fakeRes();
    await artifactsPanel.handler({ query: {} }, res, { layout: layoutSpy().layout, lang: "en" });
    assert.match(res.headers["content-security-policy"], /frame-src 'none'/, "fail closed: nothing can be framed");

    const spy = layoutSpy();
    const res2 = fakeRes();
    await artifactsPanel.handler({ query: { id: '"><script>alert(1)</script>' } }, res2, { layout: spy.layout, lang: "en" });
    assert.match(spy.captured.content, /data-artifact=""/, "a non-art id is dropped");
    assert.doesNotMatch(res2.html, /<script>alert/, "and never re-emitted");
    const spy3 = layoutSpy();
    await artifactsPanel.handler({ query: { id: "art_abc12345" } }, fakeRes(), { layout: spy3.layout, lang: "en" });
    assert.match(spy3.captured.content, /data-artifact="art_abc12345"/);
  } finally { runtime._setInfoForTest(savedInfo); }
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
    res.end(layout({ title: "Other", content: `<a id="go" href="/dashboard/artifacts?id=${encodeURIComponent(pageIds.page)}">open artifacts</a>` }));
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
    assert.ok(await waitFor(() => t.evalIn(`!!window.Turbo && document.readyState === "complete"`), 10000), "the other panel loaded with Turbo");
    await t.evalIn(`window.__fromOther = 1`);
    servedGets = [];
    await t.evalIn(`document.getElementById("go").click()`);
    // Arrival: the artifacts page is the document, and it got there by FULL
    // reload (turbo-visit-control) — a body swap would keep window.__fromOther
    // AND the other page's frame-src, which cannot frame http://localhost.
    assert.ok(await waitFor(async () => (await t.evalIn(`location.pathname`)) === "/dashboard/artifacts", 10000), "navigated");
    assert.equal(await t.evalIn(`window.__fromOther`), undefined, "full reload, not a Turbo body swap");
    assert.equal(await t.evalIn(`!!document.querySelector('meta[name="turbo-visit-control"][content="reload"]')`), true, "the meta lives in the live document's head");
    // The sealed frame mounted AND the origin actually served its content
    // (index.html of the page version) over the loopback fallback.
    const mounted = await waitFor(() => t.evalIn(`!!document.querySelector('iframe.crow-artifact-frame')`), 15000);
    assert.ok(mounted, `frame mounted (page errors: ${JSON.stringify(t.errors)})`);
    assert.ok(await waitFor(() => servedGets.length >= 1, 10000), `the origin served the frame's content (${servedGets.length} gets)`);
    assert.equal(await t.evalIn(`!!document.querySelector('.ca-danger')`), false, "no tripwire/canary banner: the narrowed CSP was in force");
  } finally { await t.close(); }
});

test("live @412x730: no horizontal page scroll, the rail sits below the frame, buttons are tappable", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  try {
    await t.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 730, deviceScaleFactor: 2, mobile: true });
    await t.nav(`${base}/dashboard/artifacts?id=${encodeURIComponent(pageIds.doc)}`);
    const ready = await waitFor(() => t.evalIn(`!!document.querySelector('iframe.crow-artifact-frame') && document.querySelectorAll('.ca-rail .ca-blocks button').length >= 2`), 15000);
    assert.ok(ready, `frame + section rail rendered (page errors: ${JSON.stringify(t.errors)})`);
    await waitFor(() => servedGets.length >= 1, 10000);
    const m = await t.evalIn(`(() => {
      const de = document.documentElement;
      const frame = document.querySelector('.ca-frame').getBoundingClientRect();
      const rail = document.querySelector('.ca-rail').getBoundingClientRect();
      const btn = document.querySelector('.ca-rail .ca-blocks button').getBoundingClientRect();
      return JSON.stringify({ innerWidth, scrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
        frameBottom: frame.bottom, railTop: rail.top, btnH: btn.height, railBelow: rail.top >= frame.bottom - 2 });
    })()`);
    const g = JSON.parse(m);
    assert.ok(g.scrollWidth <= g.innerWidth && g.bodyScrollWidth <= g.innerWidth, `no horizontal page scroll: ${m}`);
    assert.equal(g.railBelow, true, `the rail is below the frame at phone width: ${m}`);
    assert.ok(g.btnH >= 40, `section buttons are tappable (${g.btnH}px)`);
    // A section jump mounts a fresh frame at the block (viewing is allowed
    // pre-comments; the compose box arrives with step 3).
    const before = servedGets.length;
    await t.evalIn(`document.querySelectorAll('.ca-rail .ca-blocks button')[1].click()`);
    assert.ok(await waitFor(() => servedGets.length > before, 10000), "the section jump loaded the fresh frame's content");
  } finally { await t.close(); }
});
