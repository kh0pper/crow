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
import artifactsPanel, { ARTIFACTS_STRINGS } from "../bundles/artifacts/panel/artifacts.js";
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

test("VIEWER_STRINGS: the full-tab bar's title (QW4 B2)", () => {
  assert.equal(VIEWER_STRINGS.en.library_title, "Artifacts");
  assert.equal(VIEWER_STRINGS.es.library_title, "Artefactos");
});

test("QW4 B1: the Library's Details and drawer actions (Approve, Open chat, Unlink) carry the dashboard button classes", () => {
  const src = readFileSync(join(ROOT, "bundles/artifacts/panel/static/panel-client.js"), "utf8");
  for (const c of ["ca-details", "ca-approve", "ca-openchat", "ca-unlink"]) {
    assert.ok(src.includes(`class: "btn btn-secondary btn-sm ${c}"`), `${c} is a .btn.btn-secondary.btn-sm`);
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

test("the Library frames nothing and sends no CSP of its own (a Turbo visit would carry it into the next panel); an old ?id= deep link redirects to the viewer page", async () => {
  const res = fakeRes();
  const spy = layoutSpy();
  await artifactsPanel.handler({ query: {} }, res, { layout: spy.layout, lang: "en" });
  assert.equal(res.headers["content-security-policy"], undefined, "the gateway-wide policy applies");
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
  // A fake Perch engine for the send sheet (never the real one in a test).
  await s.db.executeMultiple(`CREATE TABLE IF NOT EXISTS bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_thread_id TEXT, narrowed_tools TEXT);`);
  s.engine = { sent: [], spawned: [], async list() { return []; }, async message(id) { this.sent.push(id); }, async spawn(o) { this.spawned.push(o); return { sessionId: "perchlive-5ee0ff01", threadId: "perchlive-5ee0ff01" }; } };
  app.use(artifactsRouter(dashAuth, {
    db: s.db, blobs: s.blobs, runtime, policy, csrf: csrfMiddleware, renderDeps: { markdownBlocks },
    notify: async () => {}, engine: s.engine, loadBotDef: async () => ({ tools: { crow_mcp: ["artifacts"] } }), createBoardCard: null,
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
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolveP, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolveP(m.result || {}); };
    ws.on("message", on);
    ws.send(JSON.stringify(sessionId ? { id: mine, method, params, sessionId } : { id: mine, method, params }));
  });
  // Cross-site artifact frames are out-of-process: tests reach into them
  // through auto-attached CDP sessions (flatten mode).
  const attached = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.method === "Target.attachedToTarget") attached.push(m.params); });
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
  return { send, evalIn, errors, attached, nav: (url) => send("Page.navigate", { url }), close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
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
    // D28: the section list opens on demand from the menu (never auto-opened by Comment).
    await t.evalIn(`(() => { document.querySelector('.cv-more').setAttribute('open', ''); document.querySelector('.cv-pick-section').click(); })()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`document.querySelector('.cv-side').classList.contains('cv-open') && !document.querySelector('.cv-sections').hidden`)) === true), "the sheet opened on the sections");
    const btnH = await t.evalIn(`document.querySelector('.cv-sections button').getBoundingClientRect().height`);
    assert.ok(btnH >= 44, `section buttons are tappable (${btnH}px)`);
    const before = servedGets.length;
    await t.evalIn(`document.querySelectorAll('.cv-sections button')[1].click()`);
    assert.ok(await waitFor(() => servedGets.length > before, 10000), "the section jump loaded the fresh frame's content");
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-compose textarea')`)) === true), "and opened the compose box");
  } finally { await t.close(); }
});

test("live: the full-tab viewer has a way out (Library, Crow's Nest) that the hub pane does not; the owner edits a comment in place and it locks while a round holds it", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const { addThread } = await import("../bundles/artifacts/server/comments.js");
  const doc = await store.createArtifact(s.db, s.blobs, { title: "Edit doc", type: "document", source: { markdown: "# One\n\nwords" }, actor: OWNER }, { markdownBlocks });
  const th = await addThread(s.db, { artifactId: doc.id, versionN: 1, anchor: { kind: "whole" }, text: "old words", author: { kind: "owner" } });
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  const viewUrl = `/dashboard/artifacts/view/${encodeURIComponent(doc.id)}`;
  try {
    await t.nav(base + viewUrl);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-cacts')`)) === true, 15000), `comment actions drawn (page errors: ${JSON.stringify(t.errors)})`);
    assert.equal(await t.evalIn(`JSON.stringify([...document.querySelectorAll('.cv-nav a')].map((a) => a.getAttribute('href')))`), JSON.stringify(["/dashboard/artifacts", "/dashboard/nest"]));
    // Edit → Save: the text changes in place and says "edited".
    await t.evalIn(`document.querySelector('.cv-cacts .cv-link').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-editbox textarea')`)) === true), "the edit box opened");
    await t.evalIn(`(() => { const ta = document.querySelector('.cv-editbox textarea'); ta.value = 'new words'; document.querySelector('.cv-editbox .cv-primary').click(); })()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!document.querySelector('.cv-editbox') && document.querySelector('.cv-c.cv-owner').textContent.includes('new words') && !!document.querySelector('.cv-edited')`)) === true), "saved and marked edited");
    const row = (await s.db.execute({ sql: "SELECT text FROM artifact_comments WHERE thread_id=?", args: [th.threadId] })).rows[0];
    assert.equal(row.text, "new words");
    // A round holds the thread: no Edit/Delete after the next load.
    await s.db.execute({ sql: "INSERT INTO artifact_rounds (artifact_id,kind,base_version,thread_ids_json,untrusted_input,bot_id,status,deadline) VALUES (?,'ask',1,?,0,'bobby','working',?)", args: [doc.id, JSON.stringify([th.threadId]), Date.now() + 60000] });
    await t.nav(base + viewUrl);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-c.cv-owner') && !document.querySelector('.cv-cacts')`)) === true, 15000), "locked while the round holds it");
    // Inside a frame (the hub pane): no nav — the pane has its own close.
    await t.nav(`${base}/dashboard/other`);
    assert.ok(await waitFor(async () => (await t.evalIn(`document.readyState === "complete"`)) === true, 10000));
    await t.evalIn(`(() => { const f = document.createElement('iframe'); f.id = 'pane'; f.src = ${JSON.stringify(viewUrl)}; document.body.appendChild(f); })()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`(() => { const d = document.getElementById('pane').contentDocument; return !!(d && d.querySelector('.cv-head')); })()`)) === true, 15000), "the framed viewer rendered");
    assert.equal(await t.evalIn(`!!document.getElementById('pane').contentDocument.querySelector('.cv-nav')`), false);
  } finally { await t.close(); }
});

test("live QW4 B2/B3: the full-tab viewer's way out is a slim full-bleed bar (title, Library, Crow's Nest) at phone and desktop widths; a disabled Send reads as disabled, not as a dim accent button", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const doc = await store.createArtifact(s.db, s.blobs, { title: "Bar doc", type: "document", source: { markdown: "# Bar\n\nwords" }, actor: OWNER }, { markdownBlocks });
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  try {
    for (const [width, height, mobile] of [[412, 915, true], [1280, 900, false]]) {
      await t.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await t.nav(`${base}/dashboard/artifacts/view/${encodeURIComponent(doc.id)}`);
      assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-nav') && !!document.querySelector('.cv-send')`)) === true, 15000), `viewer drawn @${width} (page errors: ${JSON.stringify(t.errors)})`);
      const m = JSON.parse(await t.evalIn(`(() => {
        const nav = document.querySelector('.cv-nav'), r = nav.getBoundingClientRect(), cs = getComputedStyle(nav);
        const title = nav.querySelector('.cv-nav-title');
        const links = [...nav.querySelectorAll('a')].map((a) => { const b = a.getBoundingClientRect(); return { href: a.getAttribute('href'), left: b.left, right: b.right, h: b.height, w: b.width }; });
        const send = document.querySelector('.cv-send'), ss = getComputedStyle(send);
        const probe = document.createElement('button'); probe.className = 'cv-primary'; document.getElementById('crow-artifact-viewer').appendChild(probe);
        const accent = getComputedStyle(probe).backgroundColor; probe.remove();
        return JSON.stringify({ innerWidth, scrollWidth: document.documentElement.scrollWidth, left: r.left, top: r.top, width: r.width, height: r.height,
          borderBottom: cs.borderBottomWidth, title: title ? title.textContent : null, titleIsLink: !!(title && title.closest('a')),
          links, sendDisabled: send.disabled, sendBg: ss.backgroundColor, sendOpacity: ss.opacity, sendCursor: ss.cursor, accent });
      })()`));
      const at = `@${width}: ${JSON.stringify(m)}`;
      assert.ok(m.scrollWidth <= m.innerWidth, `no horizontal page scroll ${at}`);
      assert.ok(Math.abs(m.left) <= 1 && Math.abs(m.top) <= 1 && Math.abs(m.width - m.innerWidth) <= 1, `the bar is full-bleed at the top ${at}`);
      assert.ok(m.height >= 44 && m.height <= 64, `a slim bar, one row ${at}`);
      assert.equal(m.borderBottom, "1px", `a 1px bottom line ${at}`);
      assert.equal(m.title, "Artifacts", `the bar carries the title ${at}`);
      assert.equal(m.titleIsLink, false, "the title is not a link");
      assert.deepEqual(m.links.map((l) => l.href), ["/dashboard/artifacts", "/dashboard/nest"], "still exactly the two ways out");
      for (const l of m.links) assert.ok(l.h >= 44 && l.w >= 44, `tappable ${at}`);
      assert.ok(m.links[1].right >= m.innerWidth - 24, `Crow's Nest sits at the right edge ${at}`);
      assert.equal(m.sendDisabled, true, "no comments yet: Send is disabled");
      assert.notEqual(m.sendBg, m.accent, `a disabled Send is not accent-filled ${at}`);
      assert.equal(m.sendOpacity, "1", `and not a faded accent either ${at}`);
      assert.equal(m.sendCursor, "not-allowed", at);
    }
  } finally { await t.close(); }
});

test("live: the send sheet — the opening chat is preselected and is where the round goes; with no linked chat only 'New chat with <bot>' remains; no board without a board", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const { addThread } = await import("../bundles/artifacts/server/comments.js");
  const CHAT = "perchlive-5ee0aa01";
  await s.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id, narrowed_tools) VALUES ('bobby',?,NULL)", args: [CHAT] });
  const doc = await store.createArtifact(s.db, s.blobs, { title: "Sheet doc", type: "document", source: { markdown: "# One\n\nwords" }, actor: { kind: "bot", id: "bobby", thread: CHAT, gateway: "perch" } }, { markdownBlocks });
  const th = await addThread(s.db, { artifactId: doc.id, versionN: 1, anchor: { kind: "whole" }, text: "make it blue", author: { kind: "owner" } });
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  const sheet = `JSON.stringify([...document.querySelectorAll('dialog .cv-where-opt')].map((l) => [l.textContent.trim(), l.querySelector('input').checked, l.querySelector('input').disabled]))`;
  try {
    await t.nav(`${base}/dashboard/artifacts/view/${encodeURIComponent(doc.id)}?thread=${CHAT}`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-send') && !document.querySelector('.cv-send').disabled`)) === true, 15000), `Send enabled (page errors: ${JSON.stringify(t.errors)})`);
    await t.evalIn(`document.querySelector('.cv-send').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`document.querySelectorAll('dialog .cv-where-opt').length`)) === 2), "the where-step rendered");
    assert.deepEqual(JSON.parse(await t.evalIn(sheet)), [["This chat", true, false], ["New chat with bobby", false, false]], "this chat preselected; no board option without a board");
    await t.evalIn(`document.querySelector('dialog .cv-primary').click()`);
    assert.ok(await waitFor(async () => (await s.db.execute({ sql: "SELECT target_thread FROM artifact_rounds WHERE artifact_id=?", args: [doc.id] })).rows[0]?.target_thread === CHAT), "the round targets the opening chat");
    assert.deepEqual(s.engine.sent, [CHAT]);
    // No linked chat: only a new chat remains (and it is what Send does).
    await s.db.execute({ sql: "UPDATE artifact_rounds SET status='done' WHERE artifact_id=?", args: [doc.id] });
    await s.db.execute({ sql: "UPDATE artifact_threads SET sent_round_id=NULL WHERE id=?", args: [th.threadId] });
    await s.db.execute({ sql: "UPDATE artifact_links SET unlinked_at=datetime('now') WHERE artifact_id=?", args: [doc.id] });
    await t.nav(`${base}/dashboard/artifacts/view/${encodeURIComponent(doc.id)}`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-send') && !document.querySelector('.cv-send').disabled`)) === true, 15000));
    await t.evalIn(`document.querySelector('.cv-send').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`document.querySelectorAll('dialog .cv-where-opt').length`)) === 1));
    assert.deepEqual(JSON.parse(await t.evalIn(sheet)), [["New chat with bobby", true, false]]);
    await t.evalIn(`document.querySelector('dialog .cv-primary').click()`);
    assert.ok(await waitFor(() => s.engine.spawned.length === 1), "a new chat with the bot");
    assert.equal(await t.evalIn(`!!document.querySelector('.cv-banner.cv-info')`), false, "no D4 banner anywhere");
  } finally { await t.close(); }
});

test("live: '⋯ → Let a bot work on this' lists only bots with the Artifacts tools and a tick grants (a second tick revokes)", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  await s.db.executeMultiple(`CREATE TABLE IF NOT EXISTS pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER NOT NULL DEFAULT 1);`);
  for (const [id, name, tools] of [["bobby", "Bobby", ["artifacts"]], ["eve", "Eve", ["artifacts"]], ["mailer", "Mailer", ["gmail/send"]]]) {
    await s.db.execute({ sql: "INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)", args: [id, name, JSON.stringify({ tools: { crow_mcp: tools } })] });
  }
  const doc = await store.createArtifact(s.db, s.blobs, { title: "Grant doc", type: "document", source: { markdown: "# g" }, actor: { kind: "bot", id: "bobby", thread: "perchlive-5ee0bb01", gateway: "perch" } }, { markdownBlocks });
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  const grants = async () => (await s.db.execute({ sql: "SELECT bot_id FROM artifact_bot_access WHERE artifact_id=?", args: [doc.id] })).rows.map((r) => r.bot_id);
  try {
    await t.nav(`${base}/dashboard/artifacts/view/${encodeURIComponent(doc.id)}`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-grant')`)) === true, 15000), `menu item drawn (page errors: ${JSON.stringify(t.errors)})`);
    await t.evalIn(`document.querySelector('.cv-grant').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('dialog.cv-grants[open] input')`)) === true), "the grant dialog opened");
    assert.equal(await t.evalIn(`JSON.stringify([...document.querySelectorAll('dialog.cv-grants label')].map((l) => l.textContent.trim()))`), JSON.stringify(["Eve"]), "only OTHER bots with the tools");
    await t.evalIn(`document.querySelector('dialog.cv-grants input').click()`);
    assert.ok(await waitFor(async () => JSON.stringify(await grants()) === JSON.stringify(["eve"])), "a tick grants");
    assert.ok(await waitFor(async () => (await t.evalIn(`!document.querySelector('dialog.cv-grants input').disabled`)) === true));
    await t.evalIn(`document.querySelector('dialog.cv-grants input').click()`);
    assert.ok(await waitFor(async () => (await grants()).length === 0), "a second tick revokes");
  } finally { await t.close(); }
});

test("live: the Library — badges from the store, search narrows the list, the drawer has five tabs with honest stubs, and Unlink drops a chat", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const CHAT = "perchlive-5ee0cc01", CHAT2 = "perchlive-5ee0cc02";
  const lib = await store.createArtifact(s.db, s.blobs, { title: "Zebra library entry", type: "document", source: { markdown: "# z" }, actor: { kind: "bot", id: "bobby", thread: CHAT, gateway: "perch" } }, { markdownBlocks });
  await s.db.execute({ sql: "INSERT INTO artifact_links (artifact_id,bot_id,thread_id,linked_by) VALUES (?,?,?,'owner-yes')", args: [lib.id, "bobby", CHAT2] });
  const yak = await store.createArtifact(s.db, s.blobs, { title: "Yak single entry", type: "document", source: { markdown: "# y" }, actor: { kind: "bot", id: "bobby", thread: "perchlive-5ee0cc03", gateway: "perch" } }, { markdownBlocks });
  const { addThread } = await import("../bundles/artifacts/server/comments.js");
  await addThread(s.db, { artifactId: yak.id, versionN: 1, anchor: { kind: "whole" }, text: "from a contact", author: { kind: "contact", id: "c-yak" } });
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  const item = `[...document.querySelectorAll('#crow-artifacts .ca-item')].find((li) => li.textContent.includes('Zebra library entry'))`;
  try {
    await t.nav(`${base}/dashboard/artifacts`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!(${item})`)) === true, 15000), `the list rendered (page errors: ${JSON.stringify(t.errors)})`);
    assert.match(await t.evalIn(`(${item}).querySelector('.ca-badges').textContent`), /Document.*v1.*2 linked chats/);
    // S7.1: one is singular (both badges), in the list the store serves.
    const one = `[...document.querySelectorAll('#crow-artifacts .ca-item')].find((li) => li.textContent.includes('Yak single entry'))`;
    assert.ok(await waitFor(async () => (await t.evalIn(`!!(${one})`)) === true, 5000), "the single-link entry rendered");
    const oneBadges = await t.evalIn(`(${one}).querySelector('.ca-badges').textContent`);
    assert.match(oneBadges, /1 linked chat(?!s)/, oneBadges);
    assert.match(oneBadges, /1 contact comment(?!s)/, oneBadges);
    // Search narrows.
    await t.evalIn(`(() => { const q = document.querySelector('#crow-artifacts .ca-search'); q.value = 'zebra'; q.dispatchEvent(new Event('input')); })()`);
    assert.equal(await t.evalIn(`document.querySelectorAll('#crow-artifacts .ca-item').length`), 1);
    // The drawer.
    // QW4 B1: Details is a dashboard secondary button (the page renders in
    // layout(), so .btn applies), compared against a probe of the same classes.
    const btnLook = `(() => { const pick = (e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.borderTopColor, c.borderRadius, c.fontSize, c.cursor].join("|"); };
      const d = (${item}).querySelector('.ca-details'); const p = document.createElement('button'); p.className = 'btn btn-secondary btn-sm'; d.parentNode.appendChild(p);
      const plain = document.createElement('button'); d.parentNode.appendChild(plain);
      const out = JSON.stringify({ cls: d.className, d: pick(d), probe: pick(p), plain: pick(plain), h: d.getBoundingClientRect().height }); p.remove(); plain.remove(); return out; })()`;
    const look = JSON.parse(await t.evalIn(btnLook));
    assert.match(look.cls, /\bbtn\b.*\bbtn-secondary\b.*\bbtn-sm\b/, JSON.stringify(look));
    assert.equal(look.d, look.probe, `Details looks like a .btn.btn-secondary: ${JSON.stringify(look)}`);
    assert.notEqual(look.d, look.plain, `and not like a bare button: ${JSON.stringify(look)}`);
    assert.ok(look.h >= 44, `still a 44px target: ${JSON.stringify(look)}`);
    await t.evalIn(`(${item}).querySelector('.ca-details').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`(${item}).querySelectorAll('.ca-tab').length`)) === 5), "five tabs");
    // S7.2: the tabs are dashboard buttons; exactly one is selected, and it looks selected.
    const tabs = JSON.parse(await t.evalIn(`JSON.stringify([...(${item}).querySelectorAll('.ca-tab')].map((e) => ({ btn: ["btn", "btn-secondary", "btn-sm"].every((c) => e.classList.contains(c)), sel: e.getAttribute('aria-selected'), color: getComputedStyle(e).color, border: getComputedStyle(e).borderTopColor })))`));
    assert.ok(tabs.every((x) => x.btn), `every tab is a .btn.btn-secondary.btn-sm: ${JSON.stringify(tabs)}`);
    assert.equal(tabs.filter((x) => x.sel === "true").length, 1, "exactly one tab is selected");
    const selTab = tabs.find((x) => x.sel === "true"), other = tabs.find((x) => x.sel !== "true");
    assert.notEqual(selTab.border, other.border, `the selected tab is marked (teal border): ${JSON.stringify(tabs)}`);
    assert.ok(await waitFor(async () => (await t.evalIn(`(${item}).querySelector('.ca-tabpanel').textContent.includes('v1')`)) === true), "Versions lists v1");
    await t.evalIn(`(${item}).querySelector('.ca-tab[data-tab=projects]').click()`);
    assert.equal(await t.evalIn(`(${item}).querySelector('.ca-soon').textContent`), "Adding artifacts to projects is coming soon.");
    await t.evalIn(`(${item}).querySelector('.ca-tab[data-tab=links]').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`(${item}).querySelectorAll('.ca-unlink').length`)) === 2), "two linked chats");
    assert.equal(await t.evalIn(`(${item}).querySelector('.ca-openchat').getAttribute('href').startsWith('/dashboard/perch#perchlive-')`), true);
    assert.deepEqual(JSON.parse(await t.evalIn(`JSON.stringify([...(${item}).querySelectorAll('.ca-unlink, .ca-openchat')].map((e) => ["btn", "btn-secondary", "btn-sm"].every((c) => e.classList.contains(c))))`)), [true, true, true, true], "Open chat and Unlink are dashboard buttons too");
    await t.evalIn(`(${item}).querySelector('.ca-unlink').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`(${item}).querySelectorAll('.ca-unlink').length`)) === 1), "one left after Unlink");
    assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_links WHERE artifact_id=? AND unlinked_at IS NULL", args: [lib.id] })).rows[0].n, 1);
    await t.evalIn(`(${item}).querySelector('.ca-tab[data-tab=audit]').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`(${item}).querySelector('.ca-audit') && (${item}).querySelector('.ca-audit').textContent.includes('link-unlinked')`)) === true), "the audit tab shows the unlink");
    // Phone width: no horizontal page scroll with the drawer open.
    await t.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await sleep(200);
    assert.ok(await t.evalIn(`document.documentElement.scrollWidth <= innerWidth`), "no horizontal scroll at 390px");
  } finally { await t.close(); }
});

test("live, review M2: opened from a chat that can no longer take it, the sheet preselects NOTHING and says why — it never quietly sends elsewhere", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const { addThread } = await import("../bundles/artifacts/server/comments.js");
  const A = "perchlive-5ee0dd01", B = "perchlive-5ee0dd02";
  for (const t of [A, B]) await s.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id, narrowed_tools) VALUES ('bobby',?,NULL)", args: [t] });
  const doc = await store.createArtifact(s.db, s.blobs, { title: "M2 doc", type: "document", source: { markdown: "# m" }, actor: { kind: "bot", id: "bobby", thread: A, gateway: "perch" } }, { markdownBlocks });
  await s.db.execute({ sql: "INSERT INTO artifact_links (artifact_id,bot_id,thread_id,linked_by) VALUES (?,?,?,'owner-yes')", args: [doc.id, "bobby", B] });
  await s.db.execute({ sql: "UPDATE artifact_links SET unlinked_at=datetime('now') WHERE artifact_id=? AND thread_id=?", args: [doc.id, A] });
  await addThread(s.db, { artifactId: doc.id, versionN: 1, anchor: { kind: "whole" }, text: "m2", author: { kind: "owner" } });
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  const sentBefore = s.engine.sent.length;
  try {
    await t.nav(`${base}/dashboard/artifacts/view/${encodeURIComponent(doc.id)}?thread=${A}`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-send') && !document.querySelector('.cv-send').disabled`)) === true, 15000));
    await t.evalIn(`document.querySelector('.cv-send').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`document.querySelectorAll('dialog .cv-where-opt').length`)) >= 2));
    assert.equal(await t.evalIn(`document.querySelectorAll('dialog .cv-where-opt input:checked').length`), 0, "nothing preselected");
    assert.match(await t.evalIn(`document.querySelector('dialog .cv-where .cv-err').textContent`), /isn't linked/);
    await t.evalIn(`document.querySelector('dialog .cv-primary').click()`);
    await sleep(400);
    assert.equal(s.engine.sent.length, sentBefore, "Send with no choice sends nothing");
    assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_rounds WHERE artifact_id=?", args: [doc.id] })).rows[0].n, 0);
  } finally { await t.close(); }
});

test("live D28: on a document, Comment opens no sheet and no list; selecting words proposes, the trusted button composes, and the comment anchors to that block + quote", async (ctx) => {
  if (!chrome || !server) return ctx.skip("no headless Chrome");
  const doc = await store.createArtifact(s.db, s.blobs, { title: "Highlight doc", type: "document", source: { markdown: "# Heading\n\nThe quick **brown** fox jumps.\n\nA second paragraph here." }, actor: OWNER }, { markdownBlocks });
  const t = await tab();
  const base = `http://${chrome.pageHost}:${port}`;
  try {
    await t.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await t.nav(`${base}/dashboard/artifacts/view/${encodeURIComponent(doc.id)}`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('iframe.crow-artifact-frame')`)) === true, 15000), `frame (errors ${JSON.stringify(t.errors)})`);
    assert.equal(await t.evalIn(`document.querySelector('iframe.crow-artifact-frame').getAttribute('sandbox')`), "allow-scripts", "a document frame speaks (helper-only)");
    await t.evalIn(`document.querySelector('.cv-comment').click()`);
    await sleep(300);
    assert.equal(await t.evalIn(`document.querySelector('.cv-side').classList.contains('cv-open')`), false, "no sheet over the document");
    assert.equal(await t.evalIn(`document.querySelector('.cv-sections').hidden`), true, "no section list");
    assert.match(await t.evalIn(`document.querySelector('.cv-status').textContent`), /Select the words/);
    // Select words INSIDE the cross-site frame, as a user would.
    // Out-of-process frame → its auto-attached session; in-process → an
    // isolated world in that frame (same DOM, so the helper sees the selection).
    const oop = await waitFor(() => t.attached.find((a) => a.targetInfo.type === "iframe"), 2000);
    let evalFrame;
    if (oop) {
      await t.send("Runtime.enable", {}, oop.sessionId);
      evalFrame = (expression) => t.send("Runtime.evaluate", { expression, returnByValue: true }, oop.sessionId);
    } else {
      const tree = await t.send("Page.getFrameTree");
      const child = (tree.frameTree.childFrames || []).find((c) => /\/v\//.test(c.frame.url));
      assert.ok(child, "found the artifact frame");
      const { executionContextId } = await t.send("Page.createIsolatedWorld", { frameId: child.frame.id, worldName: "test-select" });
      evalFrame = (expression) => t.send("Runtime.evaluate", { expression, returnByValue: true, contextId: executionContextId });
    }
    const sel = await evalFrame(`(() => { const p = document.querySelector('#b2'); const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n; const nodes = []; while ((n = w.nextNode())) nodes.push(n); const a = nodes.find((x) => x.data.includes("quick")), b = nodes.find((x) => x.data.includes("jumps")); const r = document.createRange(); r.setStart(a, a.data.indexOf("quick")); r.setEnd(b, b.data.indexOf("jumps") + 5); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
    assert.equal(sel.result && sel.result.value, "quick brown fox jumps", JSON.stringify(sel).slice(0, 400));
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-selbar:not([hidden]) button')`)) === true, 5000), "the trusted 'Comment on …' button appeared");
    assert.match(await t.evalIn(`document.querySelector('.cv-selbar button').textContent`), /quick brown fox jumps/);
    assert.equal(await t.evalIn(`!!document.querySelector('.cv-compose')`), false, "nothing composes until the owner taps");
    await t.evalIn(`document.querySelector('.cv-selbar button').click()`);
    assert.ok(await waitFor(async () => (await t.evalIn(`!!document.querySelector('.cv-compose textarea')`)) === true), "compose opened on the tap");
    assert.equal(await t.evalIn(`!!document.querySelector('.cv-compose .cv-quote')`), false, "no redundant 'exact words' box when the quote came from the selection");
    await t.evalIn(`(() => { document.querySelector('.cv-compose textarea').value = 'make it slower'; document.querySelector('.cv-compose .cv-primary').click(); })()`);
    const row = await waitFor(async () => (await s.db.execute({ sql: "SELECT anchor_json FROM artifact_threads WHERE artifact_id=?", args: [doc.id] })).rows[0], 5000);
    assert.deepEqual(JSON.parse(row.anchor_json), { kind: "block", id: "b2", text: "The quick **brown** fox jumps.", quote: "quick brown fox jumps" });
    assert.equal((await s.db.execute({ sql: "SELECT flagged_reason FROM artifact_versions WHERE artifact_id=? AND n=1", args: [doc.id] })).rows[0].flagged_reason, null, "the speaking document frame never tripped");
  } finally { await t.close(); }
});
